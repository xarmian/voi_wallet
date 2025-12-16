import algosdk from 'algosdk';
import {
  TransactionService,
  TransactionParams,
  UnsignedTransaction,
  UnsignedTransactionGroup,
} from '@/services/transactions';
import { WalletConnectService, WalletTransaction } from '@/services/walletconnect';
import {
  WalletAccount,
  AccountType,
  LedgerAccountError,
  LedgerDeviceNotConnectedError,
  LedgerAppNotOpenError,
  LedgerUserRejectedError,
} from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { SecureKeyManager } from '@/services/secure/keyManager';

/**
 * Error thrown when attempting to sign with a remote signer account directly
 */
export class RemoteSignerRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteSignerRequiredError';
  }
}

/**
 * Unified callback interface for ALL signing operations
 */
export interface UnifiedSigningCallbacks {
  // Authentication phase
  onAuthStart?: () => void;
  onAuthSuccess?: () => void;
  onAuthError?: (error: Error) => void;

  // Signing phase
  onSigningStart?: () => void;
  onLedgerPrompt?: (ctx: { index: number; total: number }) => void;
  onLedgerSigned?: (ctx: { index: number; total: number }) => void;
  onLedgerRejected?: (ctx: { index: number; total: number; error: Error }) => void;

  // Network phase
  onNetworkSubmit?: () => void;
  onNetworkConfirmed?: (txId: string) => void;
  onNetworkError?: (error: Error) => void;

  // Completion
  onComplete?: (result: UnifiedSigningResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Standard result interface for all signing operations
 */
export interface UnifiedSigningResult {
  success: boolean;
  transactionId?: string;
  transactionIds?: string[];
  error?: Error;
  signedTransactions?: Uint8Array | Uint8Array[] | string[];
}

/**
 * Transaction types supported by the unified signer
 */
export type UnifiedTransactionType =
  | 'voi_transfer'
  | 'asa_transfer'
  | 'arc200_transfer'
  | 'arc72_transfer'
  | 'rekey'
  | 'rekey_reverse'
  | 'batch_transaction'
  | 'walletconnect_batch' // Deprecated: use batch_transaction instead
  | 'keyreg' // Key registration (go online/offline for consensus)
  | 'appl'; // Application call (smart contract interaction)

/**
 * Unified transaction request interface
 */
export interface UnifiedTransactionRequest {
  type: UnifiedTransactionType;
  account: WalletAccount;
  pin?: string;

  // For standard transfers (VOI/ASA/ARC200)
  transferParams?: TransactionParams;

  // For rekey operations
  rekeyParams?: {
    fromAddress: string;
    rekeyToAddress?: string; // undefined for reverse rekey
    note?: string;
    networkId?: NetworkId;
  };

  // For WalletConnect batch signing
  walletConnectParams?: {
    transactions: WalletTransaction[];
    accountAddress: string;
    // Optional: Pre-decoded transactions to avoid double-parsing
    decodedTransactions?: algosdk.Transaction[];
  };

  // For key registration (go online/offline)
  keyregParams?: {
    address: string;
    voteKey?: Uint8Array;
    selectionKey?: Uint8Array;
    stateProofKey?: Uint8Array;
    voteFirst?: number;
    voteLast?: number;
    voteKeyDilution?: number;
    nonParticipation?: boolean; // true for going offline
    fee?: number;
    note?: string;
    networkId?: NetworkId;
  };

  // For application calls
  applParams?: {
    senderAddress: string;
    appId: number;
    appArgs?: Uint8Array[];
    foreignApps?: number[];
    foreignAssets?: number[];
    accounts?: string[];
    boxes?: Array<{ appIndex: number; name: Uint8Array }>;
    fee?: number;
    note?: string;
    networkId?: NetworkId;
  };

  // Network ID for the transaction (optional, defaults to current network)
  networkId?: NetworkId;
}

/**
 * Unified Transaction Signer - Single service for ALL transaction signing
 */
export class UnifiedTransactionSigner {
  private static instance: UnifiedTransactionSigner | null = null;

  public static getInstance(): UnifiedTransactionSigner {
    if (!UnifiedTransactionSigner.instance) {
      UnifiedTransactionSigner.instance = new UnifiedTransactionSigner();
    }
    return UnifiedTransactionSigner.instance;
  }

  /**
   * Main entry point - sign any type of transaction with unified flow
   */
  async signTransaction(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    try {
      callbacks?.onAuthStart?.();

      // Validate request
      this.validateRequest(request);

      callbacks?.onAuthSuccess?.();
      callbacks?.onSigningStart?.();

      // Route to appropriate signing method based on type
      let result: UnifiedSigningResult;

      switch (request.type) {
        case 'voi_transfer':
        case 'asa_transfer':
        case 'arc200_transfer':
        case 'arc72_transfer':
          result = await this.signStandardTransfer(request, callbacks);
          break;

        case 'rekey':
        case 'rekey_reverse':
          result = await this.signRekeyTransaction(request, callbacks);
          break;

        case 'batch_transaction':
        case 'walletconnect_batch':
          result = await this.signWalletConnectBatch(request, callbacks);
          break;

        case 'keyreg':
          result = await this.signKeyregTransaction(request, callbacks);
          break;

        case 'appl':
          result = await this.signApplTransaction(request, callbacks);
          break;

        default:
          throw new Error(`Unsupported transaction type: ${request.type}`);
      }

      callbacks?.onComplete?.(result);
      return result;

    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      const failResult: UnifiedSigningResult = { success: false, error: errorObj };

      callbacks?.onError?.(errorObj);
      callbacks?.onComplete?.(failResult);

      return failResult;
    }
  }

  /**
   * Sign standard transfers (VOI, ASA, ARC200)
   */
  private async signStandardTransfer(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.transferParams) {
      throw new Error('Transfer parameters required for standard transfers');
    }

    try {
      // Use existing TransactionService with unified callbacks
      const txId = await TransactionService.sendTransaction(
        request.transferParams,
        request.account,
        request.pin,
        {
          onLedgerPrompt: callbacks?.onLedgerPrompt,
          onLedgerSigned: callbacks?.onLedgerSigned,
          onLedgerRejected: callbacks?.onLedgerRejected,
          onNetworkSubmit: callbacks?.onNetworkSubmit,
          onNetworkConfirmed: callbacks?.onNetworkConfirmed,
        }
      );

      return {
        success: true,
        transactionId: txId,
      };

    } catch (error) {
      throw error;
    }
  }

  /**
   * Sign rekey transactions (rekey or reverse rekey) using unified signing flow
   */
  private async signRekeyTransaction(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.rekeyParams) {
      throw new Error('Rekey parameters required for rekey transactions');
    }

    try {
      let txId: string;

      if (request.type === 'rekey_reverse') {
        // Reverse rekey - return authority to original account
        txId = await TransactionService.sendRekeyReverseTransaction(
          {
            fromAddress: request.rekeyParams.fromAddress,
            note: request.rekeyParams.note,
            networkId: request.rekeyParams.networkId || request.networkId,
          },
          { address: request.account.address },
          request.pin,
          {
            onLedgerPrompt: callbacks?.onLedgerPrompt,
            onLedgerSigned: callbacks?.onLedgerSigned,
            onLedgerRejected: callbacks?.onLedgerRejected,
            onNetworkSubmit: callbacks?.onNetworkSubmit,
            onNetworkConfirmed: callbacks?.onNetworkConfirmed,
          }
        );
      } else {
        // Standard rekey to another account
        if (!request.rekeyParams.rekeyToAddress) {
          throw new Error('Target rekey address required for rekey operation');
        }

        txId = await TransactionService.sendRekeyTransaction(
          {
            fromAddress: request.rekeyParams.fromAddress,
            rekeyToAddress: request.rekeyParams.rekeyToAddress,
            note: request.rekeyParams.note,
            networkId: request.rekeyParams.networkId || request.networkId,
          },
          { address: request.account.address },
          request.pin,
          {
            onLedgerPrompt: callbacks?.onLedgerPrompt,
            onLedgerSigned: callbacks?.onLedgerSigned,
            onLedgerRejected: callbacks?.onLedgerRejected,
            onNetworkSubmit: callbacks?.onNetworkSubmit,
            onNetworkConfirmed: callbacks?.onNetworkConfirmed,
          }
        );
      }

      return {
        success: true,
        transactionId: txId,
      };

    } catch (error) {
      throw error;
    }
  }

  /**
   * Sign WalletConnect batch transactions
   */
  private async signWalletConnectBatch(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.walletConnectParams) {
      throw new Error('WalletConnect parameters required for batch signing');
    }

    try {
      // Use WalletConnect service but with unified progress tracking
      const wcService = WalletConnectService.getInstance();
      const total = request.walletConnectParams.transactions.length;

      // Track signing progress for each transaction
      const signedTxns: string[] = [];

      // Use pre-decoded transactions if available to avoid double-parsing
      const useDecodedCache =
        request.walletConnectParams.decodedTransactions &&
        request.walletConnectParams.decodedTransactions.length === request.walletConnectParams.transactions.length;

      // Detect if this is a Ledger account - Ledger requires sequential signing due to hardware constraints
      const isLedgerAccount = request.account.type === AccountType.LEDGER;

      // For Ledger accounts: sign sequentially (hardware constraint)
      // For standard accounts: sign in parallel for better performance
      if (isLedgerAccount) {
        // Sequential signing for Ledger
        for (let i = 0; i < request.walletConnectParams.transactions.length; i++) {
          callbacks?.onLedgerPrompt?.({ index: i + 1, total });

          // Sign individual transaction
          const wtxn = request.walletConnectParams.transactions[i];

          try {
            const txnBytes = Buffer.from(wtxn.txn, 'base64');

            // Try to decode as unsigned transaction
            // If it fails, the transaction is already signed (e.g., logic sig) - pass through
            let txn: algosdk.Transaction;
            try {
              if (useDecodedCache && request.walletConnectParams.decodedTransactions?.[i]) {
                txn = request.walletConnectParams.decodedTransactions[i];
              } else {
                txn = algosdk.decodeUnsignedTransaction(txnBytes);
              }
            } catch (decodeError) {
              // Transaction is already signed (logic sig, etc.) - pass through as-is
              signedTxns.push(wtxn.txn);
              callbacks?.onLedgerSigned?.({ index: i + 1, total });
              continue;
            }

            // Verify we have a valid transaction with sender info
            if (!txn || !txn.sender || !txn.sender.publicKey) {
              // Invalid or already-signed transaction - pass through
              signedTxns.push(wtxn.txn);
              callbacks?.onLedgerSigned?.({ index: i + 1, total });
              continue;
            }

            // Get the transaction sender address
            const txnSender = algosdk.encodeAddress(txn.sender.publicKey);

            // Determine signer address
            let signerAddress = request.walletConnectParams!.accountAddress;
            if (wtxn.signers && wtxn.signers.length > 0 && wtxn.signers[0]) {
              signerAddress = wtxn.signers[0];
            }
            if (wtxn.authAddr) {
              signerAddress = wtxn.authAddr;
            }

            // Skip signing if the transaction sender doesn't match our account
            if (txnSender !== signerAddress) {
              signedTxns.push(wtxn.txn);
              callbacks?.onLedgerSigned?.({ index: i + 1, total });
              continue;
            }

            const signedTxnBlob = await SecureKeyManager.signTransaction(
              txn,
              signerAddress,
              request.pin // optional; controller supplies for software keys, undefined for Ledger
            );

            signedTxns.push(Buffer.from(signedTxnBlob).toString('base64'));
            callbacks?.onLedgerSigned?.({ index: i + 1, total });

          } catch (error) {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            const sanitizedError = this.sanitizeBLEError(error);
            callbacks?.onLedgerRejected?.({ index: i + 1, total, error: sanitizedError });
            throw sanitizedError;
          }
        }
      } else {
        // Parallel signing for standard accounts (much faster!)
        callbacks?.onLedgerPrompt?.({ index: 1, total });

        const signingPromises = request.walletConnectParams!.transactions.map(async (wtxn, i) => {
          try {
            const txnBytes = Buffer.from(wtxn.txn, 'base64');

            // Try to decode as unsigned transaction
            // If it fails, the transaction is already signed (e.g., logic sig) - pass through
            let txn: algosdk.Transaction;
            try {
              if (useDecodedCache && request.walletConnectParams!.decodedTransactions?.[i]) {
                txn = request.walletConnectParams!.decodedTransactions[i];
              } else {
                txn = algosdk.decodeUnsignedTransaction(txnBytes);
              }
            } catch (decodeError) {
              // Transaction is already signed (logic sig, etc.) - pass through as-is
              return wtxn.txn;
            }

            // Verify we have a valid transaction with sender info
            if (!txn || !txn.sender || !txn.sender.publicKey) {
              // Invalid or already-signed transaction - pass through
              return wtxn.txn;
            }

            // Get the transaction sender address
            const txnSender = algosdk.encodeAddress(txn.sender.publicKey);

            // Determine signer address
            let signerAddress = request.walletConnectParams!.accountAddress;
            if (wtxn.signers && wtxn.signers.length > 0 && wtxn.signers[0]) {
              signerAddress = wtxn.signers[0];
            }
            if (wtxn.authAddr) {
              signerAddress = wtxn.authAddr;
            }

            // Skip signing if the transaction sender doesn't match our account
            // This handles cases where the transaction is for a different signer
            if (txnSender !== signerAddress) {
              return wtxn.txn;
            }

            const signedTxnBlob = await SecureKeyManager.signTransaction(
              txn,
              signerAddress,
              request.pin
            );

            return Buffer.from(signedTxnBlob).toString('base64');
          } catch (error) {
            const errorObj = error instanceof Error ? error : new Error(String(error));
            const sanitizedError = this.sanitizeBLEError(error);
            callbacks?.onLedgerRejected?.({ index: i + 1, total, error: sanitizedError });
            throw sanitizedError;
          }
        });

        // Sign all transactions in parallel
        const results = await Promise.all(signingPromises);

        signedTxns.push(...results);

        // Report completion after all parallel signing is done
        callbacks?.onLedgerSigned?.({ index: total, total });
      }

      // Clear private key cache for security (cache is inside AccountSecureStorage)
      // Note: Cache auto-expires after 60s, but we clear immediately for security
      const { AccountSecureStorage } = await import('@/services/secure/AccountSecureStorage');
      AccountSecureStorage.clearPrivateKeyCache();

      // All transactions signed successfully
      callbacks?.onNetworkSubmit?.();

      return {
        success: true,
        signedTransactions: signedTxns,
      };

    } catch (error) {
      // Clear private key cache on error too for security
      const { AccountSecureStorage } = await import('@/services/secure/AccountSecureStorage');
      AccountSecureStorage.clearPrivateKeyCache();
      throw error;
    }
  }

  /**
   * Validate the unified transaction request
   */
  private validateRequest(request: UnifiedTransactionRequest): void {
    if (!request.account) {
      throw new Error('Account is required');
    }

    if (!request.type) {
      throw new Error('Transaction type is required');
    }

    // Check for REMOTE_SIGNER accounts - these cannot be signed directly
    if (request.account.type === AccountType.REMOTE_SIGNER) {
      throw new RemoteSignerRequiredError(
        'This account uses remote signing via QR codes. ' +
        'Please use the remote signer flow instead of direct signing.'
      );
    }

    // Check for WATCH accounts - these cannot sign at all
    if (request.account.type === AccountType.WATCH) {
      throw new Error('Watch accounts cannot sign transactions');
    }

    // Type-specific validation
    switch (request.type) {
      case 'voi_transfer':
      case 'asa_transfer':
      case 'arc200_transfer':
      case 'arc72_transfer':
        if (!request.transferParams) {
          throw new Error('Transfer parameters required for transfer transactions');
        }
        break;

      case 'rekey':
      case 'rekey_reverse':
        if (!request.rekeyParams) {
          throw new Error('Rekey parameters required for rekey transactions');
        }
        if (request.type === 'rekey' && !request.rekeyParams.rekeyToAddress) {
          throw new Error('Target rekey address required for standard rekey');
        }
        break;

      case 'batch_transaction':
      case 'walletconnect_batch':
        if (!request.walletConnectParams) {
          throw new Error('Batch parameters required for batch signing');
        }
        break;

      case 'keyreg':
        if (!request.keyregParams) {
          throw new Error('Keyreg parameters required for key registration transactions');
        }
        break;

      case 'appl':
        if (!request.applParams) {
          throw new Error('Application parameters required for app call transactions');
        }
        if (!request.applParams.appId) {
          throw new Error('Application ID required for app call transactions');
        }
        break;
    }
  }

  /**
   * Estimate transaction cost for any transaction type
   */
  async estimateTransactionCost(request: UnifiedTransactionRequest): Promise<{
    fee: number;
    total: number;
  }> {
    switch (request.type) {
      case 'voi_transfer':
      case 'asa_transfer':
      case 'arc200_transfer':
      case 'arc72_transfer':
        if (!request.transferParams) {
          throw new Error('Transfer parameters required');
        }
        return await TransactionService.estimateTransactionCost(request.transferParams);

      case 'rekey':
      case 'rekey_reverse':
        // Rekey transactions have minimal cost (just network fee)
        const fee = 1000; // Standard Algorand fee in microAlgos
        return { fee, total: fee };

      case 'batch_transaction':
      case 'walletconnect_batch':
        if (!request.walletConnectParams) {
          throw new Error('Batch parameters required');
        }
        // Estimate based on number of transactions
        const transactionCount = request.walletConnectParams.transactions.length;
        const batchFee = 1000 * transactionCount; // Base fee per transaction
        return { fee: batchFee, total: batchFee };

      default:
        throw new Error(`Cost estimation not supported for transaction type: ${request.type}`);
    }
  }

  /**
   * Validate transaction before signing (without PIN)
   */
  async validateTransaction(request: UnifiedTransactionRequest): Promise<string[]> {
    const errors: string[] = [];

    try {
      this.validateRequest(request);

      // Type-specific validation
      switch (request.type) {
        case 'voi_transfer':
        case 'asa_transfer':
        case 'arc200_transfer':
        case 'arc72_transfer':
          if (request.transferParams) {
            const validationErrors = await TransactionService.validateTransaction(
              request.transferParams,
              request.account
            );
            errors.push(...validationErrors);
          }
          break;

        case 'rekey':
          if (request.rekeyParams && request.rekeyParams.rekeyToAddress) {
            // We would need to pass wallet instance for full validation
            // For now, just basic validation
            if (request.rekeyParams.fromAddress === request.rekeyParams.rekeyToAddress) {
              errors.push('Cannot rekey an account to itself');
            }
          }
          break;

        case 'rekey_reverse':
          // Basic validation for reverse rekey
          break;

        case 'batch_transaction':
        case 'walletconnect_batch':
          if (request.walletConnectParams) {
            if (request.walletConnectParams.transactions.length === 0) {
              errors.push('No transactions to sign');
            }
          }
          break;
      }

    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    return errors;
  }

  /**
   * Sign key registration transaction (go online/offline)
   */
  private async signKeyregTransaction(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.keyregParams) {
      throw new Error('Keyreg parameters required');
    }

    try {
      const networkId = request.keyregParams.networkId || request.networkId;
      const { NetworkService } = await import('@/services/network');
      const networkService = NetworkService.getInstance(networkId);
      const suggestedParams = await networkService.getSuggestedParams();

      // Override fee if specified
      if (request.keyregParams.fee) {
        suggestedParams.fee = request.keyregParams.fee;
        suggestedParams.flatFee = true;
      }

      // Build keyreg transaction
      let txn: algosdk.Transaction;

      if (request.keyregParams.nonParticipation) {
        // Go offline (non-participation)
        txn = algosdk.makeKeyRegistrationTxnWithSuggestedParamsFromObject({
          sender: request.keyregParams.address,
          suggestedParams,
          nonParticipation: true,
          note: request.keyregParams.note
            ? new Uint8Array(Buffer.from(request.keyregParams.note))
            : undefined,
        });
      } else {
        // Go online with participation keys
        txn = algosdk.makeKeyRegistrationTxnWithSuggestedParamsFromObject({
          sender: request.keyregParams.address,
          voteKey: request.keyregParams.voteKey,
          selectionKey: request.keyregParams.selectionKey,
          stateProofKey: request.keyregParams.stateProofKey,
          voteFirst: request.keyregParams.voteFirst,
          voteLast: request.keyregParams.voteLast,
          voteKeyDilution: request.keyregParams.voteKeyDilution,
          suggestedParams,
          note: request.keyregParams.note
            ? new Uint8Array(Buffer.from(request.keyregParams.note))
            : undefined,
        });
      }

      callbacks?.onLedgerPrompt?.({ index: 1, total: 1 });

      // Sign the transaction
      const signedTxnBlob = await SecureKeyManager.signTransaction(
        txn,
        request.keyregParams.address,
        request.pin
      );

      callbacks?.onLedgerSigned?.({ index: 1, total: 1 });
      callbacks?.onNetworkSubmit?.();

      // Submit to network
      const txId = await networkService.sendRawTransaction(signedTxnBlob);

      // Wait for confirmation
      await networkService.waitForConfirmation(txId);

      callbacks?.onNetworkConfirmed?.(txId);

      return {
        success: true,
        transactionId: txId,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Sign application call transaction
   */
  private async signApplTransaction(
    request: UnifiedTransactionRequest,
    callbacks?: UnifiedSigningCallbacks
  ): Promise<UnifiedSigningResult> {
    if (!request.applParams) {
      throw new Error('Application parameters required');
    }

    try {
      const networkId = request.applParams.networkId || request.networkId;
      const { NetworkService } = await import('@/services/network');
      const networkService = NetworkService.getInstance(networkId);
      const suggestedParams = await networkService.getSuggestedParams();

      // Override fee if specified
      if (request.applParams.fee) {
        suggestedParams.fee = request.applParams.fee;
        suggestedParams.flatFee = true;
      }

      // Build application call transaction
      const txn = algosdk.makeApplicationNoOpTxnFromObject({
        sender: request.applParams.senderAddress,
        appIndex: request.applParams.appId,
        appArgs: request.applParams.appArgs,
        foreignApps: request.applParams.foreignApps,
        foreignAssets: request.applParams.foreignAssets,
        accounts: request.applParams.accounts,
        boxes: request.applParams.boxes,
        suggestedParams,
        note: request.applParams.note
          ? new Uint8Array(Buffer.from(request.applParams.note))
          : undefined,
      });

      callbacks?.onLedgerPrompt?.({ index: 1, total: 1 });

      // Sign the transaction
      const signedTxnBlob = await SecureKeyManager.signTransaction(
        txn,
        request.applParams.senderAddress,
        request.pin
      );

      callbacks?.onLedgerSigned?.({ index: 1, total: 1 });
      callbacks?.onNetworkSubmit?.();

      // Submit to network
      const txId = await networkService.sendRawTransaction(signedTxnBlob);

      // Wait for confirmation
      await networkService.waitForConfirmation(txId);

      callbacks?.onNetworkConfirmed?.(txId);

      return {
        success: true,
        transactionId: txId,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Sanitize BLE/Ledger related errors to stable, user-friendly Error objects
   */
  private sanitizeBLEError(error: unknown): Error {
    if (!error) {
      return new Error('Unknown signing error occurred');
    }

    if (typeof error === 'string') {
      return new Error(error || 'Signing failed');
    }

    if (error instanceof LedgerDeviceNotConnectedError) {
      return new LedgerDeviceNotConnectedError(
        'Ledger device not connected. Please connect your device and try again.'
      );
    }

    if (error instanceof LedgerAppNotOpenError) {
      return new LedgerAppNotOpenError('Please open the Algorand app on your Ledger device.');
    }

    if (error instanceof LedgerUserRejectedError) {
      return error;
    }

    if (error instanceof LedgerAccountError) {
      return error;
    }

    if (error instanceof Error) {
      const message = error.message || 'Signing failed';
      const lower = message.toLowerCase();

      if (lower.includes('timeout')) {
        return new Error(
          'Connection timeout. Please ensure your Ledger device is unlocked and the Algorand app is open.'
        );
      }
      if (lower.includes('ble')) {
        return new Error(
          'Bluetooth connection failed. Please ensure your Ledger device is connected and unlocked.'
        );
      }
      if (lower.includes('not connected') || lower.includes('not found')) {
        return new LedgerDeviceNotConnectedError(
          'Ledger device not connected. Please connect your device and try again.'
        );
      }

      return new Error(message);
    }

    try {
      return new Error(JSON.stringify(error));
    } catch {
      return new Error('Signing failed');
    }
  }
}

// Export singleton instance
export const unifiedSigner = UnifiedTransactionSigner.getInstance();
