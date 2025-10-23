import { SignClientTypes, SessionTypes } from '@walletconnect/types';
import { getSdkError, buildApprovedNamespaces } from '@walletconnect/utils';
import { EventEmitter } from 'events';
import algosdk from 'algosdk';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { WalletConnectClient } from './client';
import { MultiAccountWalletService } from '@/services/wallet';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { AccountMetadata, AccountType } from '@/types/wallet';
import {
  WalletConnectSession,
  SessionProposal,
  WalletTransaction,
  WalletConnectEventListener,
  WalletConnectRequestEvent,
} from './types';
import {
  getSignableAccounts,
  formatAccountAddress,
  validateAlgorandTransaction,
  sanitizeMetadata,
  isSessionExpired,
  detectRequestedChains,
  areRequiredChainsSupported,
} from './utils';
import {
  DEFAULT_NAMESPACES,
  VOI_CHAIN_DATA,
  ALGORAND_MAINNET_CHAIN_DATA,
} from './config';
import type { WalletConnectV1StoredSession } from '@/services/walletconnect/v1/types';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import { WC_V1_SESSION_STORAGE_KEY } from '@/services/walletconnect/v1/config';

export class WalletConnectService extends EventEmitter {
  private static instance: WalletConnectService;
  private client: WalletConnectClient;
  private activeSessions: Map<string, WalletConnectSession> = new Map();

  static getInstance(): WalletConnectService {
    if (!WalletConnectService.instance) {
      WalletConnectService.instance = new WalletConnectService();
    }
    return WalletConnectService.instance;
  }

  constructor() {
    super();
    this.client = WalletConnectClient.getInstance();
    this.setupEventHandlers();
  }

  async initialize(): Promise<void> {
    try {
      await this.client.initialize();
      await this.loadExistingSessions();
      await this.loadV1Sessions();

      // Set up event handlers directly after initialization
      this.setupEventHandlersDirectly();

      console.log('WalletConnect service initialized successfully');
    } catch (error) {
      console.error('Failed to initialize WalletConnect service:', error);
      throw error;
    }
  }

  private async loadV1Sessions(): Promise<void> {
    try {
      const v1Client = WalletConnectV1Client.getInstance();

      // Get all keys that start with v1 session prefix
      const allKeys = await AsyncStorage.getAllKeys();
      const v1SessionKeys = allKeys.filter((key) =>
        key.startsWith(WC_V1_SESSION_STORAGE_KEY)
      );

      if (v1SessionKeys.length === 0) {
        return;
      }

      const sessions = (
        await Promise.all(
          v1SessionKeys.map(async (key) => {
            const raw = await AsyncStorage.getItem(key);
            if (!raw) {
              return null;
            }

            try {
              const parsed = JSON.parse(raw) as WalletConnectV1StoredSession;
              return { key, session: parsed };
            } catch (error) {
              console.warn('Skipping malformed v1 session entry', key, error);
              return null;
            }
          })
        )
      ).filter(Boolean) as Array<{ key: string; session: WalletConnectV1StoredSession }>;

      if (sessions.length === 0) {
        return;
      }

      let candidates = sessions.filter(({ session }) => session.connected);
      if (candidates.length === 0) {
        candidates = sessions;
      }

      const sortedCandidates = candidates.sort((a, b) => {
        const aTime = a.session.updatedAt ?? 0;
        const bTime = b.session.updatedAt ?? 0;

        if (aTime === bTime) {
          return v1SessionKeys.indexOf(a.key) - v1SessionKeys.indexOf(b.key);
        }

        return bTime - aTime;
      });

      const latestEntry = sortedCandidates[0];

      if (!latestEntry) {
        return;
      }

      // Remove stale entries (including unconnected ones) to avoid restoring incorrect sessions later
      const staleKeys = sessions
        .map(({ key }) => key)
        .filter((key) => key !== latestEntry.key);

      if (staleKeys.length > 0) {
        await AsyncStorage.multiRemove(staleKeys);
      }

      const { session } = latestEntry;


      // Extract topic from storage key
      const topic = latestEntry.key.replace(`${WC_V1_SESSION_STORAGE_KEY}:`, '');

      await v1Client.connect({
        topic,
        version: '1',
        bridge: session.bridge,
        key: session.key,
      });

      // Set up call_request listener on DeepLinkService
      // This ensures navigation works the same way as during initial URI connection
      const DeepLinkService = require('@/services/deeplink').DeepLinkService;
      const deepLinkService = DeepLinkService.getInstance();

      v1Client.on('call_request', (callRequest) => {
        // Transform v1 call_request format to match v2 format
        const sessionData = v1Client.getSessionData();
        const transformedRequest = {
          id: callRequest.id,
          topic: sessionData?.handshakeTopic || topic,
          params: {
            request: {
              method: callRequest.method,
              params: [callRequest.params],
            },
            chainId: sessionData?.chainId || 416001,
          },
        };

        // Emit through both WalletConnectService (for potential listeners)
        // AND directly navigate using DeepLinkService
        this.emit('session_request', transformedRequest);

        // Navigate to transaction request screen directly
        deepLinkService['navigateToRoute']({
          screen: 'WalletConnectTransactionRequest',
          params: {
            requestEvent: transformedRequest,
            version: 1,
          },
        });
      });

    } catch (error) {
      console.error('Failed to load v1 sessions:', error);
      // Don't throw - v1 session restoration failure shouldn't block app startup
    }
  }

  private setupEventHandlers(): void {
    // These will be set up once the client is initialized
    this.on('client_ready', () => {
      this.setupEventHandlersDirectly();
    });
  }

  private setupEventHandlersDirectly(): void {
    const provider = this.client.getProvider();
    const signClient = provider.client;

    signClient.on('session_proposal', this.onSessionProposal.bind(this));
    signClient.on('session_request', this.onSessionRequest.bind(this));
    signClient.on('session_update', this.onSessionUpdate.bind(this));
    signClient.on('session_delete', this.onSessionDelete.bind(this));
    signClient.on('session_expire', this.onSessionExpire.bind(this));
  }

  async pair(uri: string): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      await signClient.pair({ uri });
    } catch (error) {
      throw new Error(
        `Pairing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async approveSession(
    proposal: SessionProposal,
    selectedAccounts?: AccountMetadata[]
  ): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      // Use selected accounts if provided, otherwise fall back to all signable accounts
      const accounts =
        selectedAccounts && selectedAccounts.length > 0
          ? selectedAccounts
          : await this.getSignableAccounts();

      if (accounts.length === 0) {
        throw new Error('No signable accounts available');
      }

      // Get ALL requested chains from the proposal (not just supported ones)
      // We need to include all of them to satisfy WalletConnect validation
      const allRequestedChains = new Set<string>();

      if (proposal.requiredNamespaces?.algorand?.chains) {
        proposal.requiredNamespaces.algorand.chains.forEach((chain: string) =>
          allRequestedChains.add(chain)
        );
      }

      if (proposal.optionalNamespaces?.algorand?.chains) {
        proposal.optionalNamespaces.algorand.chains.forEach((chain: string) =>
          allRequestedChains.add(chain)
        );
      }

      // If no chains specified, use our defaults
      const chainsToInclude = allRequestedChains.size > 0
        ? Array.from(allRequestedChains)
        : [VOI_CHAIN_DATA.chainId, ALGORAND_MAINNET_CHAIN_DATA.chainId];

      // Format accounts for ALL requested chains (even ones we don't recognize)
      // The dApp will only actually use the chains it needs
      const formattedAccounts: string[] = [];
      for (const chainId of chainsToInclude) {
        for (const account of accounts) {
          formattedAccounts.push(
            formatAccountAddress(chainId, account.address)
          );
        }
      }

      // Build supported namespaces - include ALL requested chains
      // This satisfies WalletConnect validation while letting us handle only what we recognize
      const supportedNamespaces = {
        algorand: {
          chains: chainsToInclude,
          methods: DEFAULT_NAMESPACES.algorand.methods,
          events: DEFAULT_NAMESPACES.algorand.events,
          accounts: formattedAccounts,
        },
      };

      console.log('[WalletConnect] Proposal namespaces:', {
        required: proposal.requiredNamespaces,
        optional: proposal.optionalNamespaces,
      });
      console.log('[WalletConnect] Our supported namespaces:', supportedNamespaces);

      // Use WalletConnect's buildApprovedNamespaces utility
      // This handles all the complex validation logic for us
      const approvedNamespaces = buildApprovedNamespaces({
        proposal: proposal as any, // Type conversion needed for SDK types
        supportedNamespaces,
      });

      console.log('[WalletConnect] Approved namespaces built:', approvedNamespaces);

      const session = await signClient.approve({
        id: proposal.id,
        namespaces: approvedNamespaces,
      });

      // Get the complete session data from the client after approval
      // The approve() response might not have all the data populated
      const completeSession = signClient.session.get(session.topic);

      // Store normalized session with the proposer metadata from the original proposal
      const sessionWithMetadata = {
        ...completeSession,
        peerMetadata: proposal.proposer.metadata,
      } as WalletConnectSession;

      this.sanitizeAndCacheSession(sessionWithMetadata);

      this.emit('session_approved', sessionWithMetadata);
      this.emit('sessions_changed');
    } catch (error) {
      console.error('Failed to approve session:', error);
      throw new Error(
        `Session approval failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async rejectSession(proposal: SessionProposal): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;
      await signClient.reject({
        id: proposal.id,
        reason: getSdkError('USER_REJECTED'),
      });

      this.emit('session_rejected', proposal);
    } catch (error) {
      console.error('Failed to reject session:', error);
      throw new Error(
        `Session rejection failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async disconnectSession(topic: string): Promise<void> {
    try {
      // Check if this is a v1 session
      const v1Client = WalletConnectV1Client.getInstance();
      const v1SessionData = v1Client.getSessionData();

      if (v1SessionData && v1SessionData.handshakeTopic === topic) {
        // Disconnect v1 session
        await v1Client.disconnect();
        this.emit('session_disconnected', topic);
        this.emit('sessions_changed');
        return;
      }

      // Otherwise, disconnect v2 session
      const provider = this.client.getProvider();
      await provider.disconnect({
        topic,
        reason: getSdkError('USER_DISCONNECTED'),
      });

      this.activeSessions.delete(topic);
      this.emit('session_disconnected', topic);
      this.emit('sessions_changed');
    } catch (error) {
      console.error('Failed to disconnect session:', error);
      throw new Error(
        `Session disconnect failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  getActiveSessions(): WalletConnectSession[] {
    const v2Sessions = Array.from(this.activeSessions.values());
    const v1Sessions = this.getV1Sessions();
    return [...v2Sessions, ...v1Sessions];
  }

  private getV1Sessions(): WalletConnectSession[] {
    try {
      // Dynamically import v1 client to avoid circular dependencies
      const { WalletConnectV1Client } = require('@/services/walletconnect/v1');
      const v1Client = WalletConnectV1Client.getInstance();
      const v1SessionData = v1Client.getSessionData();

      if (!v1SessionData || !v1SessionData.connected) {
        return [];
      }

      // Convert v1 session format to v2 session format for display
      const v1Session: WalletConnectSession = {
        topic: v1SessionData.handshakeTopic,
        peerMetadata: v1SessionData.peerMeta || {
          name: 'Unknown dApp',
          description: '',
          url: '',
          icons: [],
        },
        namespaces: {
          algorand: {
            accounts: v1SessionData.accounts.map(addr => `algorand:${v1SessionData.chainId}:${addr}`),
            methods: ['algo_signTxn'],
            events: [],
            chains: [`algorand:${v1SessionData.chainId}`],
          },
        },
        expiry: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 days from now
        acknowledged: true,
        controller: v1SessionData.clientId,
        self: {
          publicKey: v1SessionData.clientId,
          metadata: v1SessionData.clientMeta || {
            name: 'Voi Wallet',
            description: 'Mobile wallet for Voi Network',
            url: 'https://voiapp.com',
            icons: [],
          },
        },
        peer: {
          publicKey: v1SessionData.peerId,
          metadata: v1SessionData.peerMeta || {
            name: 'Unknown dApp',
            description: '',
            url: '',
            icons: [],
          },
        },
      };

      return [v1Session];
    } catch (error) {
      console.error('Failed to get v1 sessions:', error);
      return [];
    }
  }

  getSession(topic: string): WalletConnectSession | undefined {
    return this.activeSessions.get(topic);
  }

  async getSignableAccounts(): Promise<AccountMetadata[]> {
    const allAccounts = await MultiAccountWalletService.getAllAccounts();
    return getSignableAccounts(allAccounts);
  }

  async signTransactions(
    transactions: WalletTransaction[],
    accountAddress: string,
    pin: string
  ): Promise<string[]> {
    try {
      const signedTxns: string[] = [];

      for (const wtxn of transactions) {
        if (!validateAlgorandTransaction(wtxn)) {
          throw new Error('Invalid transaction format');
        }

        // Decode the transaction
        const txnBytes = Buffer.from(wtxn.txn, 'base64');
        const txn = algosdk.decodeUnsignedTransaction(txnBytes);

        // Determine the signer
        let signerAddress = accountAddress;
        if (wtxn.signers && wtxn.signers.length > 0 && wtxn.signers[0]) {
          signerAddress = wtxn.signers[0];
        }

        // Handle auth address for rekeyed accounts
        if (wtxn.authAddr) {
          // Verify we can sign for this auth address
          const signerAccount = await this.findAccountByAddress(wtxn.authAddr);
          if (!signerAccount || signerAccount.type !== AccountType.STANDARD) {
            throw new Error(`Cannot sign with auth address: ${wtxn.authAddr}`);
          }
          signerAddress = wtxn.authAddr;
        }

        // Sign the transaction
        const signedTxnBlob = await SecureKeyManager.signTransaction(
          txn,
          signerAddress,
          pin
        );
        signedTxns.push(Buffer.from(signedTxnBlob).toString('base64'));
      }

      return signedTxns;
    } catch (error) {
      console.error('Failed to sign transactions:', error);
      throw new Error(
        `Transaction signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async respondToRequest(
    topic: string,
    id: number,
    result: any
  ): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      await signClient.respond({
        topic,
        response: {
          id,
          jsonrpc: '2.0',
          result,
        },
      });
    } catch (error) {
      console.error('Failed to respond to request:', error);
      throw new Error(
        `Request response failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async rejectRequest(topic: string, id: number, error: any): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      await signClient.respond({
        topic,
        response: {
          id,
          jsonrpc: '2.0',
          error: {
            code: error.code || 5001,
            message: error.message || 'User rejected the request',
          },
        },
      });
    } catch (err) {
      console.error('Failed to reject request:', err);
      throw new Error(
        `Request rejection failed: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }
  }

  private async findAccountByAddress(
    address: string
  ): Promise<AccountMetadata | null> {
    const accounts = await MultiAccountWalletService.getAllAccounts();
    return accounts.find((acc) => acc.address === address) || null;
  }

  private async loadExistingSessions(): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      // Use the client's session manager to get all sessions
      const sessions = signClient.session.getAll();

      for (const session of sessions) {
        if (!isSessionExpired(session as WalletConnectSession)) {
          this.sanitizeAndCacheSession(session as WalletConnectSession);
        } else {
          // Clean up expired session
          await this.disconnectSession(session.topic).catch(() => {
            // Ignore errors when cleaning up expired sessions
          });
        }
      }
    } catch (error) {
      console.error('Failed to load existing sessions:', error);
    }
  }

  private onSessionProposal(
    event: SignClientTypes.EventArguments['session_proposal']
  ): void {
    const proposal: SessionProposal = {
      id: event.id,
      pairingTopic: event.params.pairingTopic,
      proposer: {
        publicKey: event.params.proposer.publicKey,
        metadata: sanitizeMetadata(event.params.proposer.metadata),
      },
      requiredNamespaces: event.params.requiredNamespaces,
      optionalNamespaces: event.params.optionalNamespaces,
      sessionProperties: event.params.sessionProperties,
      expiryTimestamp: event.params.expiryTimestamp,
    };

    this.emit('session_proposal', proposal);
  }

  private onSessionRequest(
    event: SignClientTypes.EventArguments['session_request']
  ): void {
    const requestEvent: WalletConnectRequestEvent = {
      id: event.id,
      topic: event.topic,
      params: {
        request: event.params.request,
        chainId: event.params.chainId,
      },
    };

    this.emit('session_request', requestEvent);
  }

  private onSessionDelete(
    event: SignClientTypes.EventArguments['session_delete']
  ): void {
    this.activeSessions.delete(event.topic);
    this.emit('session_deleted', event);
    this.emit('sessions_changed');
  }

  private onSessionExpire(
    event: SignClientTypes.EventArguments['session_expire']
  ): void {
    this.activeSessions.delete(event.topic);
    this.emit('session_expired', event);
    this.emit('sessions_changed');
  }

  private onSessionUpdate(
    event: SignClientTypes.EventArguments['session_update']
  ): void {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;
      const updated = signClient.session.get(event.topic);
      if (updated) {
        this.sanitizeAndCacheSession(
          updated as unknown as WalletConnectSession
        );
        this.emit('session_updated', updated);
        this.emit('sessions_changed');
      }
    } catch (e) {
      console.warn('Failed to handle session_update:', e);
    }
  }

  private sanitizeAndCacheSession(session: WalletConnectSession): void {
    // Try multiple ways to get peer metadata, prioritizing already set peerMetadata
    const peer =
      session.peerMetadata ||
      (session as any).peer?.metadata ||
      (session as any).peerMetadata ||
      {};

    const normalized = {
      ...session,
      peerMetadata: sanitizeMetadata(peer),
    } as WalletConnectSession;
    this.activeSessions.set(session.topic, normalized);
  }
}

export * from './types';
export * from './config';
export * from './utils';
