import algosdk from 'algosdk';
import VoiNetworkService, { NetworkService } from '@/services/network';
import { NetworkId } from '@/types/network';
import {
  WalletAccount,
  LedgerSigningInfo,
  LedgerDeviceNotConnectedError,
  LedgerUserRejectedError,
  AccountType,
} from '@/types/wallet';
import {
  toBigIntSafeNumber,
  compareBigIntSafe,
  addBigIntSafe,
  subtractBigIntSafe,
} from '@/utils/bigint';
import { SECURITY_CONFIG, SECURITY_MESSAGES } from '@/config/security';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { TransactionTracker } from '@/services/security/transactionTracker';
import { Arc200TransactionService } from './arc200';
import { Arc72TransactionService } from './arc72';
import {
  toLedgerFriendlyError,
  buildUserFacingLedgerMessage,
} from '@/services/ledger/errors';
import { ledgerTransportService } from '@/services/ledger/transport';
import { ledgerAlgorandService } from '@/services/ledger/algorand';
import { useWalletStore } from '@/store/walletStore';

export interface TransactionParams {
  from: string;
  to: string;
  amount: number;
  assetId?: number;
  assetType?: 'voi' | 'asa' | 'arc200' | 'arc72';
  contractId?: number;
  tokenId?: string;
  note?: string;
  networkId?: NetworkId; // Network to execute the transaction on
}

export interface UnsignedTransaction {
  txn: algosdk.Transaction;
  txnBytes: Uint8Array;
}

export interface UnsignedTransactionGroup {
  transactions: algosdk.Transaction[];
  txnBytes: Uint8Array[];
  needsMbrPayment?: boolean;
}

export interface SignProgressCallbacks {
  onLedgerPrompt?: (ctx: { index: number; total: number }) => void;
  onLedgerSigned?: (ctx: { index: number; total: number }) => void;
  onLedgerRejected?: (ctx: { index: number; total: number; error: Error }) => void;
  onNetworkSubmit?: () => void;
  onNetworkConfirmed?: (txId: string) => void;
}

export class TransactionService {
  private static readonly CACHE_TTL_MS = 5 * 60_000; // Extend TTL to 5 minutes for Ledger flows
  private static readonly MAX_CACHE_ENTRIES = 100;
  private static transactionCache = new Map<
    string,
    {
      timestamp: number;
      txn: UnsignedTransaction | UnsignedTransactionGroup;
    }
  >();

  private static getTransactionCacheKey(params: TransactionParams): string {
    const normalized = {
      from: params.from,
      to: params.to,
      amount: params.amount,
      assetId: params.assetId ?? null,
      assetType: params.assetType ?? null,
      contractId: params.contractId ?? null,
      tokenId: params.tokenId ?? null,
      note: params.note ?? null,
    };
    return JSON.stringify(normalized);
  }

  private static getRekeyCacheKey(params: {
    fromAddress: string;
    rekeyToAddress?: string;
    note?: string;
    reverse?: boolean;
  }): string {
    const base = params.reverse ? 'rekey:reverse' : 'rekey';
    return `${base}:${params.fromAddress}:${params.rekeyToAddress ?? ''}:${
      params.note ?? ''
    }`;
  }

  private static getCachedTransaction(
    cacheKey: string
  ): UnsignedTransaction | UnsignedTransactionGroup | null {
    const cached = TransactionService.transactionCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (Date.now() - cached.timestamp > TransactionService.CACHE_TTL_MS) {
      TransactionService.transactionCache.delete(cacheKey);
      return null;
    }
    return cached.txn;
  }

  private static cacheTransaction(
    cacheKey: string,
    txn: UnsignedTransaction | UnsignedTransactionGroup
  ) {
    // Prune expired entries first
    TransactionService.pruneExpiredEntries();
    // Evict LRU/oldest entries if over limit
    if (TransactionService.transactionCache.size >= TransactionService.MAX_CACHE_ENTRIES) {
      TransactionService.evictOldestEntries(
        TransactionService.transactionCache.size - TransactionService.MAX_CACHE_ENTRIES + 1
      );
    }
    TransactionService.transactionCache.set(cacheKey, {
      timestamp: Date.now(),
      txn,
    });
  }

  private static clearCachedTransaction(cacheKey: string) {
    TransactionService.transactionCache.delete(cacheKey);
  }

  private static pruneExpiredEntries(): void {
    const now = Date.now();
    for (const [key, value] of TransactionService.transactionCache.entries()) {
      if (now - value.timestamp > TransactionService.CACHE_TTL_MS) {
        TransactionService.transactionCache.delete(key);
      }
    }
  }

  private static evictOldestEntries(count: number): void {
    if (count <= 0) return;
    // Create an array of [key, timestamp] and sort by timestamp ascending
    const entries = Array.from(TransactionService.transactionCache.entries()).map(
      ([key, value]) => ({ key, timestamp: value.timestamp })
    );
    entries.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < Math.min(count, entries.length); i += 1) {
      TransactionService.transactionCache.delete(entries[i].key);
    }
  }

  private static cacheAndReturn<T extends UnsignedTransaction | UnsignedTransactionGroup>(
    cacheKey: string,
    txn: T
  ): T {
    TransactionService.cacheTransaction(cacheKey, txn);
    return txn;
  }

  /**
   * Expose the cached unsigned transaction for recovery flows.
   */
  static getCachedUnsignedTransaction(
    params: TransactionParams
  ): UnsignedTransaction | UnsignedTransactionGroup | null {
    const cacheKey = TransactionService.getTransactionCacheKey(params);
    const cached = TransactionService.getCachedTransaction(cacheKey);
    return cached;
  }

  private static async ensureLedgerSigningReadiness(
    account: Pick<WalletAccount, 'address'>,
    networkId?: NetworkId
  ): Promise<LedgerSigningInfo | null> {
    try {
      const signingInfo = await SecureKeyManager.getSigningInfo(account.address, networkId);
      if (!signingInfo) {
        return null;
      }

      let ledgerInfo: LedgerSigningInfo | null = null;

      if (signingInfo.signingAccountId) {
        ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(
          signingInfo.signingAccountId,
          { lookupByAddress: false }
        ).catch(() => null);
      }

      if (!ledgerInfo && signingInfo.signingAddress) {
        ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(
          signingInfo.signingAddress
        ).catch(() => null);
      }

      if (!ledgerInfo) {
        ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(
          account.address
        ).catch(() => null);
      }

      // If we have Ledger signing info, return it regardless of current connection state.
      // Connection will be established on-demand during signing.
      return ledgerInfo ?? null;
    } catch (error) {
      if (error instanceof LedgerDeviceNotConnectedError) {
        throw error;
      }
      return null;
    }
  }
  static async buildTransaction(
    params: TransactionParams
  ): Promise<UnsignedTransaction | UnsignedTransactionGroup> {
    const cacheKey = TransactionService.getTransactionCacheKey(params);
    const cached = TransactionService.getCachedTransaction(cacheKey);
    if (cached) {
      return cached;
    }

    const assetType = TransactionService.determineAssetType(params);

    switch (assetType) {
      case 'voi':
        return TransactionService.cacheAndReturn(
          cacheKey,
          await TransactionService.buildVoiTransaction(params)
        );
      case 'asa':
        return TransactionService.cacheAndReturn(
          cacheKey,
          await TransactionService.buildAsaTransaction(params)
        );
      case 'arc200':
        return TransactionService.cacheAndReturn(
          cacheKey,
          await TransactionService.buildArc200Transaction(params)
        );
      case 'arc72':
        return TransactionService.cacheAndReturn(
          cacheKey,
          await TransactionService.buildArc72Transaction(params)
        );
      default:
        throw new Error('Unknown asset type');
    }
  }

  static determineAssetType(
    params: TransactionParams
  ): 'voi' | 'asa' | 'arc200' | 'arc72' {
    if (params.assetType) {
      return params.assetType;
    }

    // Legacy support: determine from assetId, contractId, and tokenId
    if (params.contractId && params.tokenId) {
      return 'arc72';
    }

    if (params.contractId) {
      return 'arc200';
    }

    if (params.assetId && params.assetId > 0) {
      return 'asa';
    }

    return 'voi';
  }

  static async buildVoiTransaction(
    params: TransactionParams
  ): Promise<UnsignedTransaction> {
    try {
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId)
        : VoiNetworkService;
      const suggestedParams = await networkService.getSuggestedParams();

      if (!algosdk.isValidAddress(params.from)) {
        throw new Error('Invalid sender address');
      }

      if (!algosdk.isValidAddress(params.to)) {
        throw new Error('Invalid recipient address');
      }

      if (params.amount < 0) {
        throw new Error('Amount cannot be negative');
      }

      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: params.from,
        receiver: params.to,
        amount: params.amount,
        note: params.note
          ? new Uint8Array(Buffer.from(params.note))
          : undefined,
        suggestedParams,
      });

      const txnBytes = algosdk.encodeUnsignedTransaction(txn);

      const result: UnsignedTransaction = {
        txn,
        txnBytes,
      };
      return result;
    } catch (error) {
      console.error('Failed to build VOI transaction:', error);
      throw new Error(
        `VOI transaction build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async buildAsaTransaction(
    params: TransactionParams
  ): Promise<UnsignedTransaction> {
    try {
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId)
        : VoiNetworkService;
      const suggestedParams = await networkService.getSuggestedParams();

      if (!algosdk.isValidAddress(params.from)) {
        throw new Error('Invalid sender address');
      }

      if (!algosdk.isValidAddress(params.to)) {
        throw new Error('Invalid recipient address');
      }

      if (params.amount <= 0) {
        throw new Error('Amount must be greater than 0');
      }

      if (!params.assetId) {
        throw new Error('Asset ID is required for ASA transactions');
      }

      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: params.from,
        receiver: params.to,
        amount: params.amount,
        assetIndex: params.assetId,
        note: params.note
          ? new Uint8Array(Buffer.from(params.note))
          : undefined,
        suggestedParams,
      });

      const txnBytes = algosdk.encodeUnsignedTransaction(txn);

      const result: UnsignedTransaction = {
        txn,
        txnBytes,
      };
      return result;
    } catch (error) {
      console.error('Failed to build ASA transaction:', error);
      throw new Error(
        `ASA transaction build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async buildArc200Transaction(
    params: TransactionParams
  ): Promise<UnsignedTransactionGroup> {
    try {
      if (!params.contractId) {
        throw new Error('Contract ID is required for ARC-200 transactions');
      }

      const arc200Params = {
        from: params.from,
        to: params.to,
        amount: params.amount,
        contractId: params.contractId,
        note: params.note,
        networkId: params.networkId,
      };

      const result =
        await Arc200TransactionService.buildArc200TransferGroup(arc200Params);

      return {
        transactions: result.transactions,
        txnBytes: result.txnBytes,
        needsMbrPayment: result.needsMbrPayment,
      };
    } catch (error) {
      console.error('Failed to build ARC-200 transaction:', error);
      throw new Error(
        `ARC-200 transaction build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async buildArc72Transaction(
    params: TransactionParams
  ): Promise<UnsignedTransactionGroup> {
    try {
      if (!params.contractId) {
        throw new Error('Contract ID is required for ARC-72 transactions');
      }

      if (!params.tokenId) {
        throw new Error('Token ID is required for ARC-72 transactions');
      }

      const arc72Params = {
        from: params.from,
        to: params.to,
        tokenId: params.tokenId,
        contractId: params.contractId,
        note: params.note,
        networkId: params.networkId,
      };

      const result =
        await Arc72TransactionService.buildArc72TransferGroup(arc72Params);

      return {
        transactions: result.transactions,
        txnBytes: result.txnBytes,
        needsMbrPayment: result.needsMbrPayment,
      };
    } catch (error) {
      console.error('Failed to build ARC-72 transaction:', error);
      throw new Error(
        `ARC-72 transaction build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Legacy method for backward compatibility
  static async buildPaymentTransaction(
    params: TransactionParams
  ): Promise<UnsignedTransaction> {
    const result = await TransactionService.buildTransaction(params);

    if ('transactions' in result) {
      throw new Error(
        'Legacy buildPaymentTransaction cannot handle transaction groups. Use buildTransaction instead.'
      );
    }

    return result;
  }

  static async signTransaction(
    unsignedTxn: UnsignedTransaction | UnsignedTransactionGroup,
    account: Pick<WalletAccount, 'address'>,
    pin?: string,
    callbacks?: SignProgressCallbacks,
    networkId?: NetworkId
  ): Promise<Uint8Array | Uint8Array[]> {
    try {
      // Determine if this is a Ledger signing flow by probing readiness
      const ledgerInfo = await TransactionService.ensureLedgerSigningReadiness(
        account,
        networkId
      ).catch(() => null);

      if ('transactions' in unsignedTxn) {
        // Handle transaction group
        const signedTxns: Uint8Array[] = [];
        const total = unsignedTxn.transactions.length;
        for (let i = 0; i < total; i += 1) {
          const txn = unsignedTxn.transactions[i];
          if (ledgerInfo) {
            callbacks?.onLedgerPrompt?.({ index: i + 1, total });
          }
          const signedTxn = await SecureKeyManager.signTransaction(
            txn,
            account.address,
            pin,
            networkId
          ).catch((err) => {
            if (ledgerInfo) {
              const error = err instanceof Error ? err : new Error(String(err));
              callbacks?.onLedgerRejected?.({ index: i + 1, total, error });
            }
            throw err;
          });
          signedTxns.push(signedTxn);
          if (ledgerInfo) {
            callbacks?.onLedgerSigned?.({ index: i + 1, total });
          }
        }
        return signedTxns;
      } else {
        // Handle single transaction
        if (ledgerInfo) {
          callbacks?.onLedgerPrompt?.({ index: 1, total: 1 });
        }
        const result = await SecureKeyManager.signTransaction(
          unsignedTxn.txn,
          account.address,
          pin,
          networkId
        ).catch((err) => {
          if (ledgerInfo) {
            const error = err instanceof Error ? err : new Error(String(err));
            callbacks?.onLedgerRejected?.({ index: 1, total: 1, error });
          }
          throw err;
        });
        if (ledgerInfo) {
          callbacks?.onLedgerSigned?.({ index: 1, total: 1 });
        }
        return result;
      }
    } catch (error) {
      console.error('TransactionService: Failed to sign transaction:', error);

      // Propagate known domain errors unchanged
      if (error instanceof LedgerDeviceNotConnectedError) {
        throw error;
      }
      throw new Error(
        `Transaction signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Attempt to sign the transaction, and if a recoverable Ledger error occurs,
   * try to reconnect and verify the app, then retry once.
   */
  private static async signTransactionWithRecovery(
    unsignedTxn: UnsignedTransaction | UnsignedTransactionGroup,
    account: Pick<WalletAccount, 'address'>,
    pin?: string,
    maxRetries: number = 2,
    callbacks?: SignProgressCallbacks,
    networkId?: NetworkId
  ): Promise<Uint8Array | Uint8Array[]> {
    let attempt = 0;
    let lastError: unknown;
    const baseDelayMs = 400;

    while (attempt <= maxRetries) {
      try {
        if (attempt > 0) {
          // On retries, ensure connection/app are ready
          const signingInfo = await SecureKeyManager.getSigningInfo(
            account.address,
            networkId
          ).catch((e) => {
            console.warn('Recovery: failed to read signing info:', e);
            return null;
          });

          const targetIdentifier =
            signingInfo?.signingAccountId || account.address;
          const ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(
            targetIdentifier,
            { lookupByAddress: !signingInfo?.signingAccountId }
          ).catch((e) => {
            console.warn('Recovery: failed to get Ledger signing info:', e);
            return null;
          });

          if (ledgerInfo?.deviceId) {
            const connected = ledgerTransportService.getConnectedDevice();
            if (!connected || connected.id !== ledgerInfo.deviceId) {
              await ledgerTransportService
                .connect(ledgerInfo.deviceId)
                .catch((connectError) => {
                  console.warn(
                    'Recovery: Failed to reconnect to Ledger device:',
                    connectError
                  );
                });
            }
            try {
              await ledgerAlgorandService.verifyApp({ requireAppOpen: true });
            } catch (verifyError) {
              console.warn(
                'Recovery: Failed to verify Algorand app on Ledger:',
                verifyError
              );

              // If wrong app is open (BOLOS/other), only stop retrying if this is the last attempt
              // This allows the user time to open the Algorand app
              if (verifyError instanceof Error && verifyError.message.toLowerCase().includes('app is open instead')) {
                if (attempt >= maxRetries) {
                  throw verifyError; // Stop retrying only on final attempt
                }
                // Otherwise continue to retry, giving user time to open the app
              }
            }
          }

          // Small backoff before retrying sign
          const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
          await TransactionService.delay(delayMs);
        }

        return await TransactionService.signTransaction(
          unsignedTxn,
          account,
          pin,
          callbacks,
          networkId
        );
      } catch (err) {
        lastError = err;
        const friendly = toLedgerFriendlyError(err, { attemptCount: attempt });
        console.log('Ledger signing recovery friendly error', {
          attempt,
          code: friendly.code,
          retryable: friendly.retryable,
          message: friendly.message,
          originalName: friendly.original?.name,
          originalCode: (friendly.original as any)?.code,
        });
        if (friendly.code === 'LEDGER_USER_REJECTED') {
          const originalMessage = friendly.original?.message;
          const rejectionError = new LedgerUserRejectedError(
            'Transaction cancelled by user'
          );
          if (originalMessage && rejectionError.message !== originalMessage) {
            rejectionError.stack = friendly.original?.stack ?? rejectionError.stack;
          }
          throw rejectionError;
        }
        if (!friendly.retryable) {
          throw (
            friendly.original ??
            new Error(buildUserFacingLedgerMessage(friendly))
          );
        }
        if (attempt >= maxRetries) {
          throw new Error(buildUserFacingLedgerMessage(friendly));
        }
        attempt += 1;
        continue;
      }
    }

    // Should not reach here
    throw lastError instanceof Error
      ? lastError
      : new Error('Unknown signing failure');
  }

  static async sendTransaction(
    params: TransactionParams,
    account: WalletAccount,
    pin?: string,
    callbacks?: SignProgressCallbacks
  ): Promise<string> {
    try {
      const cacheKey = TransactionService.getTransactionCacheKey(params);

      // Build the transaction
      const unsignedTxn = await TransactionService.buildTransaction(params);

      // Sign the transaction with recovery-aware handling
      const signedTxnBlob = await TransactionService.signTransactionWithRecovery(
        unsignedTxn,
        account,
        pin,
        2,
        callbacks,
        params.networkId
      );

      // Submit to network with basic retry
      callbacks?.onNetworkSubmit?.();
      const txId = await TransactionService.submitWithRetries(signedTxnBlob, params.networkId);
      callbacks?.onNetworkConfirmed?.(txId);

      // Record successful transaction for replay protection
      await TransactionTracker.recordTransaction(
        txId,
        params.from,
        params.to,
        params.amount
      );

      // Trigger balance refresh for affected accounts after successful transaction
      TransactionService.notifyTransactionSuccess(params.from, params.to);

      TransactionService.clearCachedTransaction(cacheKey);

      return txId;
    } catch (error) {
      const userRejected = TransactionService.isLedgerUserRejected(error);
      console.error('Failed to send transaction:', error);
      if (!userRejected) {
        try {
          TransactionService.notifyTransactionFailure(
            params.from,
            params.to,
            error instanceof Error ? error.message : String(error)
          );
        } catch {}
      }
      if (userRejected) {
        throw (
          error instanceof LedgerUserRejectedError
            ? error
            : new LedgerUserRejectedError('Transaction cancelled by user')
        );
      }
      throw new Error(
        `Transaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async validateTransaction(
    params: TransactionParams,
    account: WalletAccount
  ): Promise<string[]> {
    const errors: string[] = [];

    // Security validation (rate limits, replay protection, patterns)
    const securityErrors = await TransactionTracker.validateNewTransaction(
      params.from,
      params.to,
      params.amount
    );
    errors.push(...securityErrors);

    // Basic validation
    if (!algosdk.isValidAddress(params.from)) {
      errors.push('Invalid sender address');
    }

    if (!algosdk.isValidAddress(params.to)) {
      errors.push('Invalid recipient address');
    }

    // Skip amount validation for ARC-72 NFT transfers and allow 0-amount VOI transactions
    if (params.assetType !== 'arc72' && params.assetType !== 'voi' && params.amount <= 0) {
      errors.push('Amount must be greater than 0');
    }

    if (params.amount < 0) {
      errors.push('Amount cannot be negative');
    }

    // Dust attack protection
    if (params.assetId) {
      if (params.amount < SECURITY_CONFIG.MIN_ASSET_TRANSACTION) {
        errors.push(
          `Minimum asset transaction amount is ${SECURITY_CONFIG.MIN_ASSET_TRANSACTION} units`
        );
      }
    } else if (params.assetType !== 'arc72') {
      if (params.amount < SECURITY_CONFIG.MIN_VOI_TRANSACTION) {
        errors.push(SECURITY_MESSAGES.DUST_ATTACK);
      }
    }

    // Maximum transaction amount check
    /*if (params.amount > SECURITY_CONFIG.MAX_TRANSACTION_VALUE) {
      errors.push(SECURITY_MESSAGES.AMOUNT_TOO_LARGE);
    }*/

    /*if (params.from === params.to) {
      errors.push('Cannot send to yourself');
    }*/

    // Check account balance
    try {
      // Use the network specified in params, or default to Voi mainnet
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId)
        : VoiNetworkService;

      const accountBalance = await networkService.getAccountBalance(
        params.from
      );
      const estimatedFee = await networkService.estimateTransactionFee();

      // Check account balance based on asset type
      const assetType = TransactionService.determineAssetType(params);

      if (assetType === 'arc200') {
        // ARC-200 validation
        if (!params.contractId) {
          errors.push('Contract ID is required for ARC-200 transfers');
        } else {
          const arc200Asset = accountBalance.assets.find(
            (a) =>
              a.assetType === 'arc200' && a.contractId === params.contractId
          );
          if (!arc200Asset) {
            errors.push('ARC-200 token not found in account');
          } else if (compareBigIntSafe(arc200Asset.amount, params.amount) < 0) {
            errors.push('Insufficient ARC-200 token balance');
          }
        }

        // Check if account has enough VOI for fees (and potentially MBR)
        try {
          const costEstimate =
            await Arc200TransactionService.estimateArc200TransferCost({
              from: params.from,
              to: params.to,
              amount: params.amount,
              contractId: params.contractId || 0,
            });

          if (
            compareBigIntSafe(accountBalance.amount, costEstimate.total) < 0
          ) {
            errors.push(
              'Insufficient VOI balance for ARC-200 transfer fees and MBR'
            );
          }
        } catch (error) {
          errors.push('Failed to estimate ARC-200 transfer cost');
        }
      } else if (assetType === 'arc72') {
        // ARC-72 validation
        if (!params.contractId) {
          errors.push('Contract ID is required for ARC-72 transfers');
        }
        if (!params.tokenId) {
          errors.push('Token ID is required for ARC-72 transfers');
        }

        // For ARC-72, we need to verify the user owns this specific NFT
        // This would typically involve checking with MimirAPI or similar
        // For now, we'll do a basic contractId check
        if (params.contractId && params.tokenId) {
          // TODO: Add specific NFT ownership validation here
          // This could involve calling MimirAPI to verify ownership
        }

        // Check if account has enough VOI for fees (and potentially MBR)
        try {
          if (params.contractId && params.tokenId) {
            const costEstimate =
              await Arc72TransactionService.estimateArc72TransferCost({
                from: params.from,
                to: params.to,
                tokenId: params.tokenId,
                contractId: params.contractId,
              });

            if (
              compareBigIntSafe(accountBalance.amount, costEstimate.total) < 0
            ) {
              errors.push(
                'Insufficient VOI balance for ARC-72 transfer fees and MBR'
              );
            }
          }
        } catch (error) {
          errors.push('Failed to estimate ARC-72 transfer cost');
        }
      } else if (assetType === 'asa') {
        // ASA validation
        const asset = accountBalance.assets.find(
          (a) => a.assetType === 'asa' && a.assetId === params.assetId
        );
        if (!asset) {
          errors.push('ASA not found in account');
        } else if (compareBigIntSafe(asset.amount, params.amount) < 0) {
          errors.push('Insufficient ASA balance');
        }

        // Check if recipient has opted in to receive this ASA
        if (params.assetId) {
          try {
            const recipientBalance = await networkService.getAccountBalance(params.to);
            const recipientHasAsset = recipientBalance.assets.some(
              (a) => a.assetType === 'asa' && a.assetId === params.assetId
            );

            if (!recipientHasAsset) {
              // Get asset info for better error message
              try {
                const assetInfo = await networkService.getAlgodClient().getAssetByID(params.assetId).do();
                const assetName = assetInfo.params.name || assetInfo.params['unit-name'] || `Asset ${params.assetId}`;
                errors.push(
                  `Recipient must opt-in to receive ${assetName} (Asset ID: ${params.assetId}). ` +
                  `The recipient needs to add this asset to their account before they can receive it.`
                );
              } catch {
                errors.push(
                  `Recipient must opt-in to receive Asset ID ${params.assetId}. ` +
                  `The recipient needs to add this asset to their account before they can receive it.`
                );
              }
            }
          } catch (error) {
            console.warn('Failed to check recipient ASA opt-in status:', error);
            // Don't fail validation if we can't check - the network will reject it anyway
          }
        }

        // Check if account has enough VOI for fees
        if (compareBigIntSafe(accountBalance.amount, estimatedFee) < 0) {
          errors.push('Insufficient VOI balance for transaction fee');
        }
      } else {
        // VOI payment validation
        const totalRequired = params.amount + estimatedFee;
        if (compareBigIntSafe(accountBalance.amount, totalRequired) < 0) {
          errors.push('Insufficient VOI balance');
        }

        // Check minimum balance requirement
        const remainingBalance = subtractBigIntSafe(
          accountBalance.amount,
          totalRequired
        );
        if (
          compareBigIntSafe(remainingBalance, accountBalance.minBalance) < 0
        ) {
          errors.push('Transaction would violate minimum balance requirement');
        }
      }
    } catch (error) {
      console.error('Failed to validate transaction:', error);
      errors.push('Failed to validate account balance');
    }

    await TransactionService.appendSigningValidation(errors, account, params.networkId);

    return errors;
  }

  static async estimateTransactionCost(params: TransactionParams): Promise<{
    fee: number;
    total: number;
  }> {
    try {
      const assetType = TransactionService.determineAssetType(params);

      // Handle ARC-72 NFT transfers
      if (assetType === 'arc72') {
        if (!params.contractId || !params.tokenId) {
          throw new Error('Contract ID and Token ID are required for ARC-72 cost estimation');
        }

        const arc72Estimate = await Arc72TransactionService.estimateArc72TransferCost({
          from: params.from,
          to: params.to,
          tokenId: params.tokenId,
          contractId: params.contractId,
          networkId: params.networkId,
        });

        return {
          fee: arc72Estimate.total, // Return total (including MBR) as the fee, matching ARC200 pattern
          total: arc72Estimate.total,
        };
      }

      // Handle ARC-200 transfers
      if (assetType === 'arc200') {
        if (!params.contractId) {
          throw new Error('Contract ID is required for ARC-200 cost estimation');
        }

        const arc200Estimate = await Arc200TransactionService.estimateArc200TransferCost({
          from: params.from,
          to: params.to,
          amount: params.amount,
          contractId: params.contractId,
          networkId: params.networkId,
        });

        return {
          fee: arc200Estimate.fee, // This now includes MBR if needed
          total: arc200Estimate.total,
        };
      }

      // Handle VOI and ASA transfers
      // Use the network specified in params, or default to Voi mainnet
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId)
        : VoiNetworkService;

      const fee = await networkService.estimateTransactionFee();
      const total = params.assetId ? fee : params.amount + fee;

      return {
        fee,
        total,
      };
    } catch (error) {
      console.error('Failed to estimate transaction cost:', error);
      throw new Error(
        `Cost estimation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private static async appendSigningValidation(
    errors: string[],
    account: WalletAccount,
    networkId?: NetworkId
  ): Promise<void> {
    try {
      // Check if this is a remote signer account - these are always valid
      // (signing will be handled via QR code flow)
      if (account.type === AccountType.REMOTE_SIGNER) {
        return;
      }

      const info = await SecureKeyManager.getSigningInfo(account.address, networkId);

      // If we can sign, no error
      if (info.canSign) return;

      // If we cannot sign yet, check whether a Ledger signer exists for this account
      // (either the account itself is a Ledger account, or it is rekeyed to a Ledger account
      // present in the wallet). If a Ledger signer exists, do not block here —
      // the confirmation flow will handle device connection and signing.
      const candidateIds: string[] = [];
      const candidateAddresses: string[] = [];

      if (info.signingAccountId) candidateIds.push(info.signingAccountId);
      if (info.signingAddress) candidateAddresses.push(info.signingAddress);
      candidateAddresses.push(account.address);

      let hasLedgerSigner = false;

      // Try resolving by account ID first (authoritative if present)
      for (const id of candidateIds) {
        try {
          const ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(id, {
            lookupByAddress: false,
          });
          if (ledgerInfo) {
            hasLedgerSigner = true;
            break;
          }
        } catch {}
      }

      // Fallback: attempt resolution by address
      if (!hasLedgerSigner) {
        for (const addr of candidateAddresses) {
          try {
            const ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(addr, {
              lookupByAddress: true,
            });
            if (ledgerInfo) {
              hasLedgerSigner = true;
              break;
            }
          } catch {}
        }
      }

      if (!hasLedgerSigner) {
        errors.push(
          'You do not have the necessary signing authority for this account.'
        );
      }
    } catch {}
  }

  /**
   * Build a rekey transaction to change the authorizing address for an account
   * @param fromAddress - The account to be rekeyed
   * @param rekeyToAddress - The new authorizing address (must be in wallet)
   * @param note - Optional note for the transaction
   */
  static async buildRekeyTransaction(params: {
    fromAddress: string;
    rekeyToAddress: string;
    note?: string;
    networkId?: NetworkId;
  }): Promise<UnsignedTransaction> {
    const cacheKey = TransactionService.getRekeyCacheKey({
      fromAddress: params.fromAddress,
      rekeyToAddress: params.rekeyToAddress,
      note: params.note,
    });
    const cached = TransactionService.getCachedTransaction(cacheKey);
    if (cached && 'txn' in cached) {
      return cached as UnsignedTransaction;
    }

    try {
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId)
        : VoiNetworkService;
      const suggestedParams = await networkService.getSuggestedParams();

      if (!algosdk.isValidAddress(params.fromAddress)) {
        throw new Error('Invalid source address');
      }

      if (!algosdk.isValidAddress(params.rekeyToAddress)) {
        throw new Error('Invalid rekey target address');
      }

      if (params.fromAddress === params.rekeyToAddress) {
        throw new Error('Cannot rekey an account to itself');
      }

      // Create a payment transaction with amount 0 and rekey-to field
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: params.fromAddress,
        receiver: params.fromAddress, // Send to self
        amount: 0, // Zero amount
        note: params.note
          ? new Uint8Array(Buffer.from(params.note))
          : undefined,
        suggestedParams,
        rekeyTo: params.rekeyToAddress, // This is the key field for rekeying
      });

      const txnBytes = algosdk.encodeUnsignedTransaction(txn);

      const result: UnsignedTransaction = {
        txn,
        txnBytes,
      };
      TransactionService.cacheTransaction(cacheKey, result);
      return result;
    } catch (error) {
      console.error('Failed to build rekey transaction:', error);
      throw new Error(
        `Rekey transaction build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Build a transaction to reverse a rekey (return authority to original address)
   * @param fromAddress - The rekeyed account
   * @param note - Optional note for the transaction
   */
  static async buildRekeyReverseTransaction(params: {
    fromAddress: string;
    note?: string;
    networkId?: NetworkId;
  }): Promise<UnsignedTransaction> {
    const cacheKey = TransactionService.getRekeyCacheKey({
      fromAddress: params.fromAddress,
      note: params.note,
      reverse: true,
    });
    const cached = TransactionService.getCachedTransaction(cacheKey);
    if (cached && 'txn' in cached) {
      return cached as UnsignedTransaction;
    }

    try {
      const networkService = params.networkId
        ? NetworkService.getInstance(params.networkId)
        : VoiNetworkService;
      const suggestedParams = await networkService.getSuggestedParams();

      if (!algosdk.isValidAddress(params.fromAddress)) {
        throw new Error('Invalid source address');
      }

      // For reverse rekey, we create a payment transaction that rekeys the account back to itself
      // This is valid for rekeyed accounts and effectively removes the rekey
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: params.fromAddress,
        receiver: params.fromAddress, // Send to self
        amount: 0, // Zero amount
        note: params.note
          ? new Uint8Array(Buffer.from(params.note))
          : undefined,
        suggestedParams,
        rekeyTo: params.fromAddress, // Rekey back to the original address (this reverses the rekey)
      });

      const txnBytes = algosdk.encodeUnsignedTransaction(txn);

      const result: UnsignedTransaction = {
        txn,
        txnBytes,
      };
      TransactionService.cacheTransaction(cacheKey, result);
      return result;
    } catch (error) {
      console.error('Failed to build rekey reverse transaction:', error);
      throw new Error(
        `Rekey reverse transaction build failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Validate a rekey transaction before building
   * @param fromAddress - The account to be rekeyed
   * @param rekeyToAddress - The target address for rekeying
   * @param wallet - The current wallet to check if target address is available
   * @param networkId - Optional network ID to validate on specific network
   */
  static async validateRekeyTransaction(
    fromAddress: string,
    rekeyToAddress: string,
    wallet: any,
    networkId?: NetworkId
  ): Promise<string[]> {
    const errors: string[] = [];

    try {
      // Basic address validation
      if (!algosdk.isValidAddress(fromAddress)) {
        errors.push('Invalid source address');
      }

      if (!algosdk.isValidAddress(rekeyToAddress)) {
        errors.push('Invalid target address');
      }

      // Get network service and check rekey status
      const networkService = networkId
        ? NetworkService.getInstance(networkId)
        : VoiNetworkService;
      const accountBalance = await networkService.getAccountBalance(fromAddress);
      const isCurrentlyRekeyed = accountBalance.rekeyInfo?.isRekeyed;

      // Allow rekeying to self only if currently rekeyed (for reverse rekey)
      if (fromAddress === rekeyToAddress && !isCurrentlyRekeyed) {
        errors.push('Cannot rekey an account to itself');
      }

      // For reverse rekey (to self), we don't need to check target account in wallet
      // since the target IS the source account
      if (fromAddress !== rekeyToAddress) {
        // Check if target address is in the wallet
        const targetAccount = wallet.accounts.find(
          (acc: any) =>
            acc.address === rekeyToAddress &&
            (acc.type === AccountType.STANDARD ||
              acc.type === AccountType.LEDGER ||
              acc.type === 'standard' ||
              acc.type === 'ledger')
        );

        if (!targetAccount) {
          errors.push('Target address must be a standard or Ledger account in your wallet');
        }

        if (targetAccount && (targetAccount.type === AccountType.LEDGER || targetAccount.type === 'ledger')) {
          try {
            const ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(
              targetAccount.id ?? targetAccount.address,
              { lookupByAddress: !targetAccount.id }
            );

            if (!ledgerInfo || !ledgerInfo.isDeviceAvailable) {
              errors.push('Ledger device for the target account is not available. Connect it before rekeying.');
            }
          } catch (error) {
            errors.push('Unable to verify Ledger device availability for the target account.');
          }
        }
      }

      // Check if source account exists and is not already rekeyed to the same address
      const sourceAccount = wallet.accounts.find(
        (acc: any) => acc.address === fromAddress
      );
      if (!sourceAccount) {
        errors.push('Source account not found in wallet');
      } else if (
        sourceAccount.type === 'rekeyed' &&
        sourceAccount.authAddress === rekeyToAddress &&
        fromAddress !== rekeyToAddress // Allow reverse rekey to self
      ) {
        errors.push('Account is already rekeyed to this address');
      }

      // Get estimated fee for balance check
      const estimatedFee = await networkService.estimateTransactionFee();

      // If the source account is rekeyed on this network, verify we have the auth signer
      if (accountBalance.rekeyInfo?.isRekeyed && accountBalance.rekeyInfo?.authAddress) {
        const authAddress = accountBalance.rekeyInfo.authAddress;
        const authSigner = wallet.accounts.find(
          (acc: any) =>
            acc.address === authAddress &&
            (acc.type === AccountType.STANDARD ||
              acc.type === AccountType.LEDGER ||
              acc.type === 'standard' ||
              acc.type === 'ledger')
        );

        if (!authSigner) {
          errors.push(
            `Account is rekeyed to ${authAddress.slice(0, 8)}... You need this controlling account in your wallet to perform any rekey operations.`
          );
        } else if (authSigner.type === AccountType.LEDGER || authSigner.type === 'ledger') {
          // Verify Ledger device is available for the auth signer
          try {
            const ledgerInfo = await SecureKeyManager.getLedgerSigningInfo(
              authSigner.id ?? authSigner.address,
              { lookupByAddress: !authSigner.id }
            );

            if (!ledgerInfo || !ledgerInfo.isDeviceAvailable) {
              errors.push('Ledger device for the controlling account is not available. Connect it before rekeying.');
            }
          } catch (error) {
            errors.push('Unable to verify Ledger device availability for the controlling account.');
          }
        }
      }

      if (compareBigIntSafe(accountBalance.amount, estimatedFee) < 0) {
        errors.push('Insufficient balance to pay transaction fee');
      }

      // Check minimum balance requirement
      const remainingBalance = subtractBigIntSafe(
        accountBalance.amount,
        estimatedFee
      );
      if (compareBigIntSafe(remainingBalance, accountBalance.minBalance) < 0) {
        errors.push('Transaction would violate minimum balance requirement');
      }
    } catch (error) {
      console.error('Failed to validate rekey transaction:', error);
      errors.push('Failed to validate transaction requirements');
    }

    return errors;
  }

  /**
   * Send a rekey transaction
   * @param params - Rekey transaction parameters
   * @param account - The account initiating the rekey
   * @param pin - User's PIN for signing
   * @param callbacks - Progress callbacks for Ledger signing
   */
  static async sendRekeyTransaction(
    params: {
      fromAddress: string;
      rekeyToAddress: string;
      note?: string;
      networkId?: NetworkId;
    },
    account: Pick<WalletAccount, 'address'>,
    pin?: string,
    callbacks?: SignProgressCallbacks
  ): Promise<string> {
    try {
      const cacheKey = TransactionService.getRekeyCacheKey({
        fromAddress: params.fromAddress,
        rekeyToAddress: params.rekeyToAddress,
        note: params.note,
      });

      // Build the rekey transaction
      const unsignedTxn =
        await TransactionService.buildRekeyTransaction(params);

      // Sign the transaction with recovery-aware handling
      const signedTxnBlob = await TransactionService.signTransactionWithRecovery(
        unsignedTxn,
        account,
        pin,
        2,
        callbacks,
        params.networkId
      );

      // Submit to network with basic retry
      callbacks?.onNetworkSubmit?.();
      const txId = await TransactionService.submitWithRetries(signedTxnBlob, params.networkId);
      callbacks?.onNetworkConfirmed?.(txId);

      // Record successful transaction
      await TransactionTracker.recordTransaction(
        txId,
        params.fromAddress,
        params.fromAddress, // Rekey transactions are to self
        0 // Zero amount
      );

      // Trigger balance refresh
      TransactionService.notifyTransactionSuccess(
        params.fromAddress,
        params.fromAddress
      );

      TransactionService.clearCachedTransaction(cacheKey);

      return txId;
    } catch (error) {
      const userRejected = TransactionService.isLedgerUserRejected(error);
      console.error('Failed to send rekey transaction:', error);
      if (!userRejected) {
        try {
          TransactionService.notifyTransactionFailure(
            params.fromAddress,
            params.fromAddress,
            error instanceof Error ? error.message : String(error)
          );
        } catch {}
      }
      if (userRejected) {
        throw (
          error instanceof LedgerUserRejectedError
            ? error
            : new LedgerUserRejectedError('Transaction cancelled by user')
        );
      }
      throw new Error(
        `Rekey transaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Notify that a transaction succeeded - can be used to trigger balance refresh
   * This uses a simple event-based approach to avoid circular dependencies
   */
  private static notifyTransactionSuccess(
    fromAddress: string,
    toAddress: string
  ) {
    // Use a timeout to ensure transaction has propagated before refreshing
    setTimeout(() => {
      // Emit a custom event that the wallet store can listen to
      if (typeof document !== 'undefined') {
        const event = new CustomEvent('transactionSuccess', {
          detail: { fromAddress, toAddress },
        });
        document.dispatchEvent(event);
        return;
      }

      const store = useWalletStore.getState();
      const wallet = store.wallet;
      if (!wallet) {
        return;
      }

      const accountsToRefresh = wallet.accounts.filter(
        (account) =>
          account.address === fromAddress || account.address === toAddress
      );

      accountsToRefresh.forEach((account) => {
        void store
          .loadAccountBalance(account.id, true) // Force refresh after transaction success
          .catch((error) =>
            console.warn(
              'Failed to refresh balance after transaction success:',
              error
            )
          );
      });
    }, 2000); // 2 second delay to allow transaction to propagate
  }

  /**
   * Notify that a transaction failed - can be used to drive UI fallbacks.
   */
  private static notifyTransactionFailure(
    fromAddress: string,
    toAddress: string,
    errorMessage: string
  ) {
    if (typeof document !== 'undefined') {
      const event = new CustomEvent('transactionFailed', {
        detail: { fromAddress, toAddress, errorMessage },
      });
      document.dispatchEvent(event);
    }
  }

  /**
   * Send a reverse rekey transaction (removes rekey and returns authority to original account)
   * @param params - Reverse rekey transaction parameters
   * @param account - The account initiating the reverse rekey
   * @param pin - User's PIN for signing
   * @param callbacks - Progress callbacks for Ledger signing
   */
  static async sendRekeyReverseTransaction(
    params: {
      fromAddress: string;
      note?: string;
      networkId?: NetworkId;
    },
    account: Pick<WalletAccount, 'address'>,
    pin?: string,
    callbacks?: SignProgressCallbacks
  ): Promise<string> {
    try {
      const cacheKey = TransactionService.getRekeyCacheKey({
        fromAddress: params.fromAddress,
        note: params.note,
        reverse: true,
      });

      // Build the reverse rekey transaction
      const unsignedTxn =
        await TransactionService.buildRekeyReverseTransaction(params);

      // Sign the transaction with recovery-aware handling
      const signedTxnBlob = await TransactionService.signTransactionWithRecovery(
        unsignedTxn,
        account,
        pin,
        2,
        callbacks,
        params.networkId
      );

      // Submit to network with basic retry
      callbacks?.onNetworkSubmit?.();
      const txId = await TransactionService.submitWithRetries(signedTxnBlob, params.networkId);
      callbacks?.onNetworkConfirmed?.(txId);

      // Record successful transaction
      await TransactionTracker.recordTransaction(
        txId,
        params.fromAddress,
        params.fromAddress, // Reverse rekey transactions are to self
        0 // Zero amount
      );

      // Trigger balance refresh
      TransactionService.notifyTransactionSuccess(
        params.fromAddress,
        params.fromAddress
      );

      TransactionService.clearCachedTransaction(cacheKey);

      return txId;
    } catch (error) {
      const userRejected = TransactionService.isLedgerUserRejected(error);
      console.error('Failed to send reverse rekey transaction:', error);
      if (!userRejected) {
        try {
          TransactionService.notifyTransactionFailure(
            params.fromAddress,
            params.fromAddress,
            error instanceof Error ? error.message : String(error)
          );
        } catch {}
      }
      if (userRejected) {
        throw (
          error instanceof LedgerUserRejectedError
            ? error
            : new LedgerUserRejectedError('Transaction cancelled by user')
        );
      }
      throw new Error(
        `Reverse rekey transaction failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private static isLedgerUserRejected(error: unknown): boolean {
    if (!error) return false;
    if (error instanceof LedgerUserRejectedError) {
      return true;
    }
    if (error instanceof Error) {
      const lower = (error.message || '').toLowerCase();
      return (
        lower.includes('ledger device rejected') ||
        lower.includes('action rejected') ||
        lower.includes('transaction cancelled by user') ||
        lower.includes('user rejected') ||
        lower.includes('user denied')
      );
    }
    return false;
  }

  private static async submitWithRetries(
    signedTxnBlob: Uint8Array | Uint8Array[],
    networkId?: NetworkId,
    maxAttempts: number = 3
  ): Promise<string> {
    let attempt = 0;
    let lastError: unknown;
    const baseDelayMs = 500;
    const networkService = networkId
      ? NetworkService.getInstance(networkId)
      : VoiNetworkService;

    while (attempt < maxAttempts) {
      try {
        return await networkService.submitTransaction(signedTxnBlob);
      } catch (error) {
        lastError = error;
        attempt += 1;
        if (attempt >= maxAttempts) break;
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        await TransactionService.delay(delayMs);
      }
    }
    throw new Error(
      `Network submission failed after ${maxAttempts} attempts: ${
        (lastError as Error)?.message ?? 'Unknown error'
      }`
    );
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
