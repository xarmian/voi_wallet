import algosdk from 'algosdk';
import {
  AuthAccountDiscoveryRequest,
  AuthAccountDiscoveryResult,
  AuthAccountDiscoveryError,
  NetworkAuthAccount
} from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { NetworkService } from '@/services/network';
import { getNetworkConfig, getNetworkDisplayName, AVAILABLE_NETWORKS } from '@/services/network/config';
import { MultiAccountWalletService } from '@/services/wallet';

export class AuthAccountDiscoveryService {
  private static instance: AuthAccountDiscoveryService;

  private constructor() {}

  static getInstance(): AuthAccountDiscoveryService {
    if (!AuthAccountDiscoveryService.instance) {
      AuthAccountDiscoveryService.instance = new AuthAccountDiscoveryService();
    }
    return AuthAccountDiscoveryService.instance;
  }

  /**
   * Discover accounts on all supported networks where the given Ledger addresses
   * are being used as auth accounts (rekeyed accounts)
   */
  async discoverAuthAccounts(
    request: AuthAccountDiscoveryRequest
  ): Promise<AuthAccountDiscoveryResult> {
    const { ledgerAddresses, networks = AVAILABLE_NETWORKS, includeExisting = true } = request;

    if (!ledgerAddresses.length) {
      throw new Error('At least one Ledger address is required');
    }

    const networkService = NetworkService.getInstance();
    const originalNetworkId = networkService.getCurrentNetworkId();

    // Validate all addresses
    for (const address of ledgerAddresses) {
      if (!algosdk.isValidAddress(address)) {
        throw new Error(`Invalid Algorand address: ${address}`);
      }
    }

    const authAccounts: NetworkAuthAccount[] = [];
    const errors: AuthAccountDiscoveryError[] = [];

    try {
      // Search each network in parallel
      const networkPromises = networks.map(async (networkId) => {
        try {
          const networkAccounts = await this.searchNetworkForAuthAccounts(
            networkId,
            ledgerAddresses,
            includeExisting
          );
          return networkAccounts;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          // Log error for each Ledger address on this network
          ledgerAddresses.forEach(address => {
            errors.push({
              networkId,
              ledgerAddress: address,
              error: errorMessage,
              code: 'NETWORK_SEARCH_FAILED'
            });
          });

          return [];
        }
      });

      const networkResults = await Promise.all(networkPromises);

      // Flatten all results
      networkResults.forEach(accounts => {
        authAccounts.push(...accounts);
      });

      // Separate by network for convenience
      const voiAccounts = authAccounts.filter(acc => acc.networkId === NetworkId.VOI_MAINNET);
      const algorandAccounts = authAccounts.filter(acc => acc.networkId === NetworkId.ALGORAND_MAINNET);

      return {
        authAccounts,
        ledgerAddresses,
        searchedNetworks: networks,
        totalFound: authAccounts.length,
        voiAccounts,
        algorandAccounts,
        errors: errors.length > 0 ? errors : undefined
      };
    } finally {
      const currentNetworkId = networkService.getCurrentNetworkId();
      if (currentNetworkId !== originalNetworkId) {
        try {
          await networkService.switchNetwork(originalNetworkId);
        } catch (restoreError) {
          console.warn('[AuthDiscovery] Failed to restore original network after discovery', restoreError);
        }
      }
    }
  }

  /**
   * Search a specific network for accounts where the given Ledger addresses
   * are used as auth accounts
   */
  private async searchNetworkForAuthAccounts(
    networkId: NetworkId,
    ledgerAddresses: string[],
    includeExisting: boolean
  ): Promise<NetworkAuthAccount[]> {
    const networkService = NetworkService.getInstance(networkId);
    const indexerClient = networkService.getIndexerClient();
    const networkConfig = getNetworkConfig(networkId);
    const networkName = getNetworkDisplayName(networkId);

    const allAuthAccounts: NetworkAuthAccount[] = [];

    // Search for each Ledger address in parallel
    const searchPromises = ledgerAddresses.map(async (authAddress) => {
      try {
        const accounts = await this.searchIndexerForAuthAccounts(
          indexerClient,
          authAddress,
          networkId,
          networkName
        );

        // Filter existing accounts if needed
        if (!includeExisting) {
          const filtered = [];
          for (const account of accounts) {
            const existingAccount = await MultiAccountWalletService.findAccountByAddress(account.address);
            if (!existingAccount) {
              filtered.push(account);
            }
          }
          return filtered;
        }

        // Check if accounts exist in wallet and mark them
        for (const account of accounts) {
          const existingAccount = await MultiAccountWalletService.findAccountByAddress(account.address);
          if (existingAccount) {
            account.existsInWallet = true;
            account.accountId = existingAccount.id;
          }
        }

        return accounts;
      } catch (error) {
        console.warn(`Failed to search for auth accounts with address ${authAddress} on ${networkName}:`, error);
        return [];
      }
    });

    const searchResults = await Promise.all(searchPromises);

    // Flatten results
    searchResults.forEach(accounts => {
      allAuthAccounts.push(...accounts);
    });

    return allAuthAccounts;
  }

  /**
   * Query the indexer for accounts with a specific auth-addr
   */
  private async searchIndexerForAuthAccounts(
    indexerClient: algosdk.Indexer,
    authAddress: string,
    networkId: NetworkId,
    networkName: string
  ): Promise<NetworkAuthAccount[]> {
    const authAccounts: NetworkAuthAccount[] = [];
    let nextToken: string | undefined;
    const limit = 100; // Process in batches

    do {
      try {
        // Build the indexer query URL manually since algosdk doesn't expose auth-addr parameter
        const config = getNetworkConfig(networkId);
        const params = new URLSearchParams({
          'auth-addr': authAddress,
          limit: limit.toString(),
        });

        if (nextToken) {
          params.set('next', nextToken);
        }

        const url = `${config.indexerUrl}/v2/accounts?${params.toString()}`;

        // Create timeout controller for React Native compatibility
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

        const response = await fetch(url, {
          headers: {
            'X-API-Key': config.token || '',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          if (response.status === 429) {
            throw new Error('Rate limit exceeded. Please try again in a moment.');
          } else if (response.status >= 500) {
            throw new Error('Network service temporarily unavailable. Please try again.');
          } else if (response.status === 404) {
            throw new Error('Indexer endpoint not found.');
          } else {
            throw new Error(`Network error ${response.status}: ${response.statusText}`);
          }
        }

        const data = await response.json();

        if (data.accounts && Array.isArray(data.accounts)) {
          for (const accountData of data.accounts) {
            try {
              const authAccount = await this.parseIndexerAccount(
                accountData,
                authAddress,
                networkId,
                networkName
              );
              if (authAccount) {
                authAccounts.push(authAccount);
              }
            } catch (parseError) {
              console.warn('Failed to parse indexer account data:', parseError);
              // Continue processing other accounts
            }
          }
        }

        nextToken = data['next-token'];
      } catch (error) {
        console.error(`Failed to query indexer for auth accounts: ${error}`);
        break; // Stop pagination on error
      }
    } while (nextToken);

    return authAccounts;
  }

  /**
   * Parse account data from indexer response
   */
  private async parseIndexerAccount(
    accountData: any,
    authAddress: string,
    networkId: NetworkId,
    networkName: string
  ): Promise<NetworkAuthAccount | null> {
    try {
      const address = accountData.address;
      if (!address || !algosdk.isValidAddress(address)) {
        return null;
      }

      // Get additional account details
      const balance = accountData.amount || 0;
      const minBalance = accountData['min-balance'] || 0;
      const assets = accountData.assets || [];
      const assetCount = assets.length;

      // Try to get first transaction timestamp for account creation date
      let firstSeen: number | undefined;
      try {
        const networkService = NetworkService.getInstance(networkId);
        const firstTx = await networkService.getFirstTransaction(address);
        if (firstTx && firstTx.timestamp) {
          firstSeen = firstTx.timestamp;
        }
      } catch (error) {
        // Non-critical, continue without first seen date
        console.warn(`Could not get first transaction for ${address}:`, error);
      }

      // Get last activity from account data if available
      let lastActivity: number | undefined;
      if (accountData['last-round']) {
        // This would need to be converted to timestamp, but let's keep it simple for now
        lastActivity = Date.now(); // Placeholder
      }

      return {
        address,
        authAddress,
        networkId,
        networkName,
        balance,
        minBalance,
        assetCount,
        firstSeen,
        lastActivity,
        existsInWallet: false, // Will be updated by caller
        accountId: undefined, // Will be updated by caller
      };
    } catch (error) {
      console.error('Failed to parse indexer account:', error);
      return null;
    }
  }

  /**
   * Get a specific network service instance
   */
  private getNetworkService(networkId: NetworkId): NetworkService {
    return NetworkService.getInstance(networkId);
  }
}

export default AuthAccountDiscoveryService.getInstance();
