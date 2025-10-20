import React, { useState } from 'react';
import {
  UnifiedTransactionRequest,
  UnifiedSigningResult,
} from '@/services/transactions/unifiedSigner';
import { simpleLedgerSigner, SimpleLedgerSigningCallbacks } from '@/services/ledger/simpleLedgerSigner';
import { simpleLedgerManager, LedgerStateChange } from '@/services/ledger/simpleLedgerManager';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { LedgerSigningInfo } from '@/types/wallet';

export type SimpleLedgerAuthState =
  | 'idle'
  | 'connecting'
  | 'verifying'
  | 'ready'
  | 'signing'
  | 'completed'
  | 'error';

export interface SimpleLedgerAuthStateData {
  state: SimpleLedgerAuthState;
  deviceConnected: boolean;
  deviceName?: string;
  error?: {
    message: string;
    retryable: boolean;
    userAction?: string;
  };
  signingProgress?: {
    current: number;
    total: number;
    message?: string;
  };
  result?: UnifiedSigningResult;
}

/**
 * Simplified Ledger Authentication Controller
 * Replaces the complex TransactionAuthController with a much simpler implementation
 */
export class SimpleLedgerAuthController {
  private stateListeners: Array<(state: SimpleLedgerAuthStateData) => void> = [];
  private currentState: SimpleLedgerAuthStateData = { state: 'idle', deviceConnected: false };
  private currentRequest: UnifiedTransactionRequest | null = null;
  private ledgerSigningInfo: LedgerSigningInfo | null = null;

  constructor() {
    // Subscribe to ledger manager state changes
    simpleLedgerManager.onStateChange(this.handleLedgerStateChange.bind(this));
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (state: SimpleLedgerAuthStateData) => void): () => void {
    this.stateListeners.push(listener);
    // Send current state immediately
    listener(this.currentState);

    return () => {
      const index = this.stateListeners.indexOf(listener);
      if (index > -1) {
        this.stateListeners.splice(index, 1);
      }
    };
  }

  /**
   * Get current state
   */
  getState(): SimpleLedgerAuthStateData {
    return { ...this.currentState };
  }

  /**
   * Initialize signing flow for a Ledger transaction
   */
  async initializeSigningFlow(request: UnifiedTransactionRequest): Promise<void> {
    this.currentRequest = request;

    try {
      // Get Ledger signing info for the account
      this.ledgerSigningInfo = await SecureKeyManager.getLedgerSigningInfo(
        request.account.address
      );

      this.updateState({ state: 'connecting' });

      // Start connection process
      await this.startLedgerFlow();

    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Cancel current operation
   */
  cancel(): void {
    this.currentRequest = null;
    this.ledgerSigningInfo = null;
    this.updateState({
      state: 'idle',
      deviceConnected: false,
      error: undefined,
      signingProgress: undefined,
      result: undefined
    });
  }

  /**
   * Retry current operation
   */
  async retry(): Promise<void> {
    if (!this.currentRequest) return;

    this.updateState({
      state: 'connecting',
      error: undefined
    });

    try {
      await simpleLedgerManager.retry();
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Start the Ledger signing flow
   */
  private async startLedgerFlow(): Promise<void> {
    if (!this.currentRequest || !this.ledgerSigningInfo) {
      throw new Error('No request or signing info available');
    }

    const callbacks: SimpleLedgerSigningCallbacks = {
      onDeviceConnecting: () => {
        this.updateState({ state: 'connecting' });
      },
      onDeviceReady: () => {
        this.updateState({ state: 'ready' });
      },
      onSigningStarted: () => {
        this.updateState({ state: 'signing' });
      },
      onSigningCompleted: () => {
        this.updateState({ state: 'completed' });
      },
      onProgress: (current, total, message) => {
        this.updateState({
          signingProgress: { current, total, message }
        });
      },
      onError: (error) => {
        this.handleError(error);
      },
    };

    try {
      // Create signing requests based on transaction type
      const signingRequests = await this.createSigningRequests();

      let result: UnifiedSigningResult;

      if (signingRequests.length === 1) {
        // Single transaction
        const signResult = await simpleLedgerSigner.signTransaction(signingRequests[0], callbacks);
        result = {
          success: true,
          transactionId: signResult.txID,
          signedTransactions: signResult.signedTransaction,
        };
      } else {
        // Multiple transactions
        const signResults = await simpleLedgerSigner.signTransactions(signingRequests, callbacks);
        result = {
          success: true,
          transactionIds: signResults.map(r => r.txID),
          signedTransactions: signResults.map(r => r.signedTransaction),
        };
      }

      this.updateState({
        state: 'completed',
        result
      });

    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Create signing requests from the current transaction request
   */
  private async createSigningRequests() {
    if (!this.currentRequest || !this.ledgerSigningInfo) {
      throw new Error('No request or signing info available');
    }

    const requests = [];

    switch (this.currentRequest.type) {
      case 'voi_transfer':
      case 'asa_transfer':
      case 'arc200_transfer':
        if (this.currentRequest.transferParams) {
          // For transfers, we'll need to build the transaction first
          // This is a simplified version - in practice, you'd use the full transaction service
          const txn = await this.buildTransactionFromParams(this.currentRequest.transferParams);

          requests.push(simpleLedgerSigner.constructor.createSigningRequest(
            txn,
            this.ledgerSigningInfo.derivationIndex,
            this.ledgerSigningInfo.signerAddress
          ));
        }
        break;

      case 'rekey':
      case 'rekey_reverse':
        if (this.currentRequest.rekeyParams) {
          // Build rekey transaction
          const rekeyTxn = await this.buildRekeyTransaction(this.currentRequest.rekeyParams);

          requests.push(simpleLedgerSigner.constructor.createSigningRequest(
            rekeyTxn,
            this.ledgerSigningInfo.derivationIndex,
            this.ledgerSigningInfo.signerAddress
          ));
        }
        break;

      case 'walletconnect_batch':
        if (this.currentRequest.walletConnectParams) {
          // Handle WalletConnect batch transactions
          for (const wtxn of this.currentRequest.walletConnectParams.transactions) {
            const txnBytes = Buffer.from(wtxn.txn, 'base64');

            requests.push(simpleLedgerSigner.constructor.createSigningRequest(
              txnBytes,
              this.ledgerSigningInfo.derivationIndex,
              this.ledgerSigningInfo.signerAddress
            ));
          }
        }
        break;

      default:
        throw new Error(`Unsupported transaction type: ${this.currentRequest.type}`);
    }

    return requests;
  }

  /**
   * Handle Ledger manager state changes
   */
  private handleLedgerStateChange(stateChange: LedgerStateChange): void {
    const deviceConnected = stateChange.state === 'ready' || stateChange.state === 'signing';
    const deviceName = stateChange.device?.name;

    // Map ledger manager states to our simplified states
    switch (stateChange.state) {
      case 'discovering':
      case 'connecting':
        this.updateState({
          state: 'connecting',
          deviceConnected: false,
          deviceName
        });
        break;

      case 'ready':
        this.updateState({
          state: 'ready',
          deviceConnected: true,
          deviceName,
          error: undefined
        });
        break;

      case 'signing':
        this.updateState({
          state: 'signing',
          deviceConnected: true,
          deviceName
        });
        break;

      case 'error':
        this.updateState({
          state: 'error',
          deviceConnected: false,
          deviceName,
          error: stateChange.error ? {
            message: stateChange.error.message,
            retryable: stateChange.error.retryable,
            userAction: stateChange.error.userAction,
          } : undefined
        });
        break;

      case 'disconnected':
        this.updateState({
          state: 'idle',
          deviceConnected: false,
          deviceName: undefined
        });
        break;
    }
  }

  /**
   * Handle errors
   */
  private handleError(error: Error): void {
    this.updateState({
      state: 'error',
      error: {
        message: error.message,
        retryable: true, // Most Ledger errors are retryable
        userAction: this.getErrorUserAction(error.message),
      }
    });
  }

  /**
   * Get user action suggestion for error
   */
  private getErrorUserAction(errorMessage: string): string {
    const message = errorMessage.toLowerCase();

    if (message.includes('unlock')) {
      return 'Please unlock your Ledger device and try again';
    }
    if (message.includes('algorand app') || message.includes('app not found')) {
      return 'Please open the Algorand app on your Ledger device';
    }
    if (message.includes('rejected') || message.includes('denied')) {
      return 'Transaction was rejected. Please approve it on your Ledger device';
    }
    if (message.includes('connection') || message.includes('disconnected')) {
      return 'Please check your device connection and try again';
    }

    return 'Please try again or restart your Ledger device';
  }

  /**
   * Update state and notify listeners
   */
  private updateState(updates: Partial<SimpleLedgerAuthStateData>): void {
    this.currentState = {
      ...this.currentState,
      ...updates,
    };

    this.stateListeners.forEach(listener => {
      try {
        listener(this.currentState);
      } catch (error) {
        console.error('State listener error:', error);
      }
    });
  }

  /**
   * Build transaction from transfer parameters (simplified)
   */
  private async buildTransactionFromParams(params: any): Promise<any> {
    // This is a placeholder - in practice, you'd use the full TransactionService
    throw new Error('Transaction building not implemented in simplified controller');
  }

  /**
   * Build rekey transaction (simplified)
   */
  private async buildRekeyTransaction(params: any): Promise<any> {
    // This is a placeholder - in practice, you'd use the full TransactionService
    throw new Error('Rekey transaction building not implemented in simplified controller');
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.stateListeners.length = 0;
    this.currentRequest = null;
    this.ledgerSigningInfo = null;
  }
}

/**
 * Hook for React components to use the simplified Ledger auth controller
 */
export function useSimpleLedgerAuth() {
  const [controller] = useState(() => new SimpleLedgerAuthController());
  const [authState, setAuthState] = useState<SimpleLedgerAuthStateData>(controller.getState());

  // Subscribe to controller state changes
  React.useEffect(() => {
    const unsubscribe = controller.subscribe(setAuthState);
    return unsubscribe;
  }, [controller]);

  return {
    controller,
    authState,
  };
}