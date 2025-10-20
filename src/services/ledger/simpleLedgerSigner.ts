import algosdk, { Transaction } from 'algosdk';
import { ledgerAlgorandService } from './algorand';
import { simpleLedgerManager } from './simpleLedgerManager';
import { LedgerDeviceNotConnectedError, LedgerAccountError } from '@/types/wallet';

export interface SimpleLedgerSigningRequest {
  transaction: Transaction | Uint8Array;
  derivationIndex: number;
  signerAddress?: string;
}

export interface SimpleLedgerSigningResult {
  txID: string;
  signature: Uint8Array;
  signedTransaction: Uint8Array;
}

export interface SimpleLedgerSigningCallbacks {
  onDeviceConnecting?: () => void;
  onDeviceReady?: () => void;
  onSigningStarted?: () => void;
  onSigningCompleted?: () => void;
  onProgress?: (current: number, total: number, message?: string) => void;
  onError?: (error: Error) => void;
}

/**
 * Simplified Ledger Signer
 * Provides a clean, simple interface for Ledger signing operations
 * Handles device connection, verification, and signing automatically
 */
export class SimpleLedgerSigner {
  private static instance: SimpleLedgerSigner;

  static getInstance(): SimpleLedgerSigner {
    if (!SimpleLedgerSigner.instance) {
      SimpleLedgerSigner.instance = new SimpleLedgerSigner();
    }
    return SimpleLedgerSigner.instance;
  }

  private constructor() {}

  /**
   * Sign a single transaction with automatic device management
   */
  async signTransaction(
    request: SimpleLedgerSigningRequest,
    callbacks?: SimpleLedgerSigningCallbacks
  ): Promise<SimpleLedgerSigningResult> {
    try {
      // Ensure device is connected and ready
      const transport = await this.ensureDeviceReady(callbacks);

      callbacks?.onSigningStarted?.();
      simpleLedgerManager.setSigningInProgress(true);

      try {
        // Use the existing algorand service for actual signing
        const result = await ledgerAlgorandService.signTransaction(request);

        callbacks?.onSigningCompleted?.();
        return result;

      } finally {
        simpleLedgerManager.setSigningInProgress(false);
      }

    } catch (error) {
      simpleLedgerManager.setSigningInProgress(false);
      const normalizedError = this.normalizeError(error);
      callbacks?.onError?.(normalizedError);
      throw normalizedError;
    }
  }

  /**
   * Sign multiple transactions in sequence with progress tracking
   */
  async signTransactions(
    requests: SimpleLedgerSigningRequest[],
    callbacks?: SimpleLedgerSigningCallbacks
  ): Promise<SimpleLedgerSigningResult[]> {
    if (requests.length === 0) {
      throw new Error('No transactions to sign');
    }

    try {
      // Ensure device is connected and ready
      await this.ensureDeviceReady(callbacks);

      callbacks?.onSigningStarted?.();
      simpleLedgerManager.setSigningInProgress(true);

      const results: SimpleLedgerSigningResult[] = [];

      try {
        for (let i = 0; i < requests.length; i++) {
          const request = requests[i];

          callbacks?.onProgress?.(i + 1, requests.length, `Signing transaction ${i + 1} of ${requests.length}`);

          const result = await ledgerAlgorandService.signTransaction(request);
          results.push(result);
        }

        callbacks?.onSigningCompleted?.();
        return results;

      } finally {
        simpleLedgerManager.setSigningInProgress(false);
      }

    } catch (error) {
      simpleLedgerManager.setSigningInProgress(false);
      const normalizedError = this.normalizeError(error);
      callbacks?.onError?.(normalizedError);
      throw normalizedError;
    }
  }

  /**
   * Get account addresses from Ledger device
   */
  async getAccounts(
    startIndex: number = 0,
    count: number = 5,
    displayFirst: boolean = false
  ): Promise<Array<{ address: string; publicKey: string; derivationIndex: number }>> {
    try {
      // Ensure device is connected and ready
      await this.ensureDeviceReady();

      // Use existing algorand service for account derivation
      const accounts = await ledgerAlgorandService.deriveAccounts(startIndex, count, { displayFirst });

      return accounts.map(account => ({
        address: account.address,
        publicKey: account.publicKey,
        derivationIndex: account.derivationIndex,
      }));

    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  /**
   * Verify an address on the device display
   */
  async verifyAddress(
    derivationIndex: number,
    expectedAddress?: string
  ): Promise<{ address: string; matches?: boolean }> {
    try {
      // Ensure device is connected and ready
      await this.ensureDeviceReady();

      const result = await ledgerAlgorandService.verifyAddressOnDevice(derivationIndex, expectedAddress);

      return {
        address: result.address,
        matches: result.matches,
      };

    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  /**
   * Check if a device is connected and ready for signing
   */
  async isDeviceReady(): Promise<boolean> {
    try {
      const transport = simpleLedgerManager.getTransport();
      if (!transport) return false;

      return await simpleLedgerManager.verifyDeviceReady();
    } catch (error) {
      return false;
    }
  }

  /**
   * Get current device information
   */
  getDeviceInfo() {
    const state = simpleLedgerManager.getState();
    return {
      connected: state.state === 'ready' || state.state === 'signing',
      device: state.device,
      error: state.error,
    };
  }

  /**
   * Disconnect from the current device
   */
  async disconnect(): Promise<void> {
    await simpleLedgerManager.disconnect();
  }

  /**
   * Ensure device is connected and ready for operations
   */
  private async ensureDeviceReady(callbacks?: SimpleLedgerSigningCallbacks): Promise<any> {
    const currentState = simpleLedgerManager.getState();

    // If already ready, return transport
    if (currentState.state === 'ready') {
      const transport = simpleLedgerManager.getTransport();
      if (transport) {
        callbacks?.onDeviceReady?.();
        return transport;
      }
    }

    // Need to connect
    callbacks?.onDeviceConnecting?.();

    try {
      const transport = await simpleLedgerManager.connect();

      // Verify device is ready (unlocked, right app)
      const isReady = await simpleLedgerManager.verifyDeviceReady();
      if (!isReady) {
        throw new Error('Device is not ready for signing');
      }

      callbacks?.onDeviceReady?.();
      return transport;

    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  /**
   * Normalize various error types to consistent Error objects
   */
  private normalizeError(error: unknown): Error {
    if (error instanceof LedgerDeviceNotConnectedError || error instanceof LedgerAccountError) {
      return error;
    }

    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      // Detect common error patterns and provide better messages
      if (message.includes('6985') || message.includes('conditions of use not satisfied')) {
        return new LedgerAccountError('Transaction was rejected on the Ledger device');
      }

      if (message.includes('6982') || message.includes('security status not satisfied')) {
        return new LedgerAccountError('Please unlock your Ledger device');
      }

      if (message.includes('6e00') || message.includes('app not found')) {
        return new LedgerAccountError('Please open the Algorand app on your Ledger device');
      }

      if (message.includes('timeout') || message.includes('disconnected')) {
        return new LedgerDeviceNotConnectedError('Connection to Ledger device was lost');
      }

      return new LedgerAccountError(error.message);
    }

    return new LedgerAccountError('Unknown Ledger error occurred');
  }

  /**
   * Create a signing request from a transaction
   */
  static createSigningRequest(
    transaction: Transaction | Uint8Array,
    derivationIndex: number,
    signerAddress?: string
  ): SimpleLedgerSigningRequest {
    return {
      transaction,
      derivationIndex,
      signerAddress,
    };
  }
}

export const simpleLedgerSigner = SimpleLedgerSigner.getInstance();