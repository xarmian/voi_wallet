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
  | 'walletconnect_batch';

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

        case 'walletconnect_batch':
          result = await this.signWalletConnectBatch(request, callbacks);
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

      for (let i = 0; i < request.walletConnectParams.transactions.length; i++) {
        callbacks?.onLedgerPrompt?.({ index: i + 1, total });

        // Sign individual transaction
        const wtxn = request.walletConnectParams.transactions[i];

        try {
          // Decode and sign transaction using SecureKeyManager directly
          const txnBytes = Buffer.from(wtxn.txn, 'base64');
          const txn = algosdk.decodeUnsignedTransaction(txnBytes);

          // Determine signer address
          let signerAddress = request.walletConnectParams.accountAddress;
          if (wtxn.signers && wtxn.signers.length > 0 && wtxn.signers[0]) {
            signerAddress = wtxn.signers[0];
          }
          if (wtxn.authAddr) {
            signerAddress = wtxn.authAddr;
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

      // All transactions signed successfully
      callbacks?.onNetworkSubmit?.();

      return {
        success: true,
        signedTransactions: signedTxns,
      };

    } catch (error) {
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

      case 'walletconnect_batch':
        if (!request.walletConnectParams) {
          throw new Error('WalletConnect parameters required for batch signing');
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

      case 'walletconnect_batch':
        if (!request.walletConnectParams) {
          throw new Error('WalletConnect parameters required');
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
