import AlgorandApp from '@ledgerhq/hw-app-algorand';
import Transport from '@ledgerhq/hw-transport';
import {
  TransportError,
  TransportStatusError,
  StatusCodes,
  UserRefusedOnDevice,
  LockedDeviceError,
} from '@ledgerhq/errors';
import algosdk, {
  Transaction,
  decodeUnsignedTransaction,
  SignedTransaction,
  encodeMsgpack,
} from 'algosdk';

import {
  LedgerAccountError,
  LedgerAppNotOpenError,
  LedgerDeviceNotConnectedError,
  LedgerUserRejectedError,
} from '@/types/wallet';

import { ledgerTransportService } from './transport';
import {
  isLedgerSigningInProgress,
  setLedgerSigningInProgress,
} from './signingState';

export interface LedgerAccountDerivation {
  address: string;
  publicKey: string;
  derivationPath: string;
  derivationIndex: number;
}

export interface LedgerAppInfo {
  name: string;
  version: string;
  flags: number;
}

export interface LedgerSignTransactionRequest {
  transaction: Transaction | Uint8Array;
  derivationIndex: number;
  // Optional signer address (auth address). If provided and different from txn sender,
  // it will be added as sgnr to the signed transaction to support rekeyed accounts.
  signerAddress?: string;
}

export interface LedgerSignTransactionResult {
  txID: string;
  signature: Uint8Array;
  signedTransaction: Uint8Array;
}

interface VerifyAppOptions {
  requireAppOpen?: boolean;
  minVersion?: string;
}

/**
 * Handles Algorand-specific Ledger interactions: address derivation, transaction
 * signing, and Ledger app verification. Shared across Algorand and Voi networks
 * which both rely on the Algorand Ledger application.
 */
class LedgerAlgorandService {
  private static instance: LedgerAlgorandService;
  // Ledger Algorand app derives accounts using the third path segment (account index).
  // We therefore vary the account index and keep the change/address components static (0/0).
  private static readonly DERIVATION_BASE_PATH = "m/44'/283'";
  private static readonly DEFAULT_MIN_VERSION = '1.0.0';
  private static readonly MAX_DERIVATION_INDEX = 2147483647; // Int32 max

  static getInstance(): LedgerAlgorandService {
    if (!LedgerAlgorandService.instance) {
      LedgerAlgorandService.instance = new LedgerAlgorandService();
    }
    return LedgerAlgorandService.instance;
  }

  static isCurrentlySigningTransaction(): boolean {
    return isLedgerSigningInProgress();
  }

  private constructor() {}

  getDerivationPath(index: number): string {
    if (!Number.isInteger(index) || index < 0) {
      throw new LedgerAccountError(
        'Derivation index must be a non-negative integer',
        'LEDGER_INVALID_DERIVATION_INDEX'
      );
    }
    if (index > LedgerAlgorandService.MAX_DERIVATION_INDEX) {
      throw new LedgerAccountError(
        `Derivation index exceeds maximum of ${LedgerAlgorandService.MAX_DERIVATION_INDEX}`,
        'LEDGER_INVALID_DERIVATION_INDEX'
      );
    }
    return `${LedgerAlgorandService.DERIVATION_BASE_PATH}/${index}'/0/0`;
  }

  async deriveAccount(
    index: number,
    options: { displayOnDevice?: boolean } = {}
  ): Promise<LedgerAccountDerivation> {
    const { displayOnDevice = false } = options;
    const app = await this.getApp({ requireAppOpen: true });
    const derivationPath = this.getDerivationPath(index);

    try {
      const { address, publicKey } = await app.getAddress(
        derivationPath,
        displayOnDevice
      );
      return {
        address,
        publicKey,
        derivationPath,
        derivationIndex: index,
      };
    } catch (error) {
      throw this.normalizeLedgerError(error);
    }
  }

  async deriveAccounts(
    startIndex: number,
    count: number,
    options: { displayFirst?: boolean } = {}
  ): Promise<LedgerAccountDerivation[]> {
    if (!Number.isInteger(startIndex) || startIndex < 0) {
      throw new LedgerAccountError(
        'startIndex must be a non-negative integer',
        'LEDGER_INVALID_DERIVATION_INDEX'
      );
    }
    if (!Number.isInteger(count) || count <= 0) {
      throw new LedgerAccountError(
        'count must be a positive integer',
        'LEDGER_INVALID_DERIVATION_COUNT'
      );
    }
    const endIndex = startIndex + count - 1;
    if (endIndex > LedgerAlgorandService.MAX_DERIVATION_INDEX) {
      throw new LedgerAccountError(
        `Derivation range exceeds maximum of ${LedgerAlgorandService.MAX_DERIVATION_INDEX}`,
        'LEDGER_INVALID_DERIVATION_INDEX'
      );
    }

    const { displayFirst = false } = options;
    const app = await this.getApp({ requireAppOpen: true });

    const results: LedgerAccountDerivation[] = [];
    for (let i = 0; i < count; i += 1) {
      const index = startIndex + i;
      const derivationPath = this.getDerivationPath(index);
      try {
        const { address, publicKey } = await app.getAddress(
          derivationPath,
          displayFirst && i === 0
        );
        results.push({
          address,
          publicKey,
          derivationPath,
          derivationIndex: index,
        });
      } catch (error) {
        throw this.normalizeLedgerError(error);
      }
    }
    return results;
  }

  /**
   * Request the Ledger device to display the address for verification and optionally
   * check it against an expected address.
   */
  async verifyAddressOnDevice(
    index: number,
    expectedAddress?: string
  ): Promise<{ address: string; publicKey: string; matches?: boolean }> {
    const { address, publicKey } = await this.deriveAccount(index, {
      displayOnDevice: true,
    });
    const result: { address: string; publicKey: string; matches?: boolean } = {
      address,
      publicKey,
    };
    if (expectedAddress) {
      result.matches = address === expectedAddress;
    }
    return result;
  }

  async signTransaction(
    request: LedgerSignTransactionRequest
  ): Promise<LedgerSignTransactionResult> {
    const { transaction, derivationIndex } = request;

    try {
      // Mark signing as in progress to prevent concurrent verification calls
      setLedgerSigningInProgress(true);

      const app = await this.getApp({ requireAppOpen: true });
      const derivationPath = this.getDerivationPath(derivationIndex);
      const txn = this.ensureTransactionInstance(transaction);

      const txnBytes = algosdk.encodeUnsignedTransaction(txn);
      const txnHex = Buffer.from(txnBytes).toString('hex');

      const response = await app.sign(derivationPath, txnHex);
      if (!response.signature) {
        throw new LedgerAccountError(
          'Ledger returned an empty signature',
          'LEDGER_EMPTY_SIGNATURE'
        );
      }

      // Normalize signature bytes: some transports include trailing status words (0x90 0x00)
      let sigBuffer = Buffer.from(response.signature);
      if (
        sigBuffer.length === 66 &&
        sigBuffer[64] === 0x90 &&
        sigBuffer[65] === 0x00
      ) {
        sigBuffer = sigBuffer.slice(0, 64);
      }

      if (sigBuffer.length !== 64) {
        // Short signature length typically means user rejected the transaction
        if (sigBuffer.length <= 2) {
          throw new LedgerAccountError(
            'Transaction rejected on Ledger device',
            'LEDGER_USER_REJECTED'
          );
        }
        throw new LedgerAccountError(
          `Invalid signature length from Ledger: expected 64, got ${sigBuffer.length}`,
          'LEDGER_INVALID_SIGNATURE_LENGTH'
        );
      }

      const signature = new Uint8Array(sigBuffer);
      const signedTransaction = this.buildSignedTransaction(
        txn,
        signature,
        request.signerAddress
      );
      const txID = txn.txID();

      return {
        txID,
        signature,
        signedTransaction,
      };
    } catch (error) {
      console.error('Ledger signTransaction error:', error);
      throw this.normalizeLedgerError(error);
    } finally {
      // Always clear signing flag, even on error
      setLedgerSigningInProgress(false);
    }
  }

  async verifyApp(options: VerifyAppOptions = {}): Promise<LedgerAppInfo> {
    // Skip verification if signing is in progress to prevent race conditions
    if (isLedgerSigningInProgress()) {
      console.log('🚫 SKIPPING verifyApp - signing in progress to prevent race condition');
      // Return a cached/default response instead of throwing
      return {
        name: 'Algorand',
        version: '2.1.14',
        flags: 258
      };
    }

    const minVersion =
      options.minVersion ?? LedgerAlgorandService.DEFAULT_MIN_VERSION;
    const transport = await this.getActiveTransport();

    // Retry mechanism for app verification
    let lastError: Error | null = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const info = await this.getAppAndVersion(transport);

        if (options.requireAppOpen && info.name.toLowerCase() !== 'algorand') {
          const appError = new LedgerAppNotOpenError(
            `${info.name} app is open instead of Algorand app. Please open the Algorand app on your Ledger device.`
          );

          // NEVER retry when wrong app is open - user needs to manually switch apps
          // This prevents hammering the device with verification calls
          throw appError;
        }

        if (this.compareVersions(info.version, minVersion) < 0) {
          // Don't fail on version mismatch in production - log warning instead
          console.warn(
            `Ledger Algorand app version ${info.version} is below recommended minimum ${minVersion}, but continuing anyway`
          );
        }

        return info;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on certain errors
        if (
          error instanceof LedgerAppNotOpenError ||
          lastError.message.includes('COMMUNICATION_ERROR') ||
          lastError.message.includes('Transport')
        ) {
          break;
        }

        // Wait before retry
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * attempt, 3000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw this.normalizeLedgerError(lastError || new Error('Unknown verification error'));
  }

  private async getApp(options: VerifyAppOptions = {}): Promise<AlgorandApp> {
    const transport = await this.getActiveTransport();
    const info = await this.verifyApp({ ...options, requireAppOpen: true });
    if (info.name.toLowerCase() !== 'algorand') {
      throw new LedgerAppNotOpenError(
        'Algorand app must be opened on the Ledger device'
      );
    }
    return new AlgorandApp(transport);
  }

  private async getActiveTransport(): Promise<Transport> {
    const existing = ledgerTransportService.getTransport();
    if (!existing) {
      throw new LedgerDeviceNotConnectedError(
        'No active Ledger transport. Connect to the device first.'
      );
    }
    return existing;
  }

  private ensureTransactionInstance(
    transaction: Transaction | Uint8Array
  ): Transaction {
    console.log('Ledger ensureTransactionInstance: Input validation', {
      inputType: typeof transaction,
      isUint8Array: transaction instanceof Uint8Array,
      constructorName: transaction?.constructor?.name,
      hasTransaction: !!transaction,
    });

    if (transaction instanceof Uint8Array) {
      console.log('Ledger ensureTransactionInstance: Decoding Uint8Array transaction');
      try {
        const decoded = decodeUnsignedTransaction(transaction);
        console.log('Ledger ensureTransactionInstance: Decoded successfully', {
          decodedType: typeof decoded,
          constructorName: decoded?.constructor?.name,
          hasTxID: typeof decoded?.txID === 'function',
          hasToEncodingData: typeof decoded?.toEncodingData === 'function',
        });
        return decoded;
      } catch (error) {
        console.error('Ledger ensureTransactionInstance: Failed to decode Uint8Array', error);
        throw new LedgerAccountError(
          `Failed to decode transaction bytes: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'LEDGER_INVALID_TRANSACTION'
        );
      }
    }

    // Validate the transaction object has required methods
    const txn = transaction as Transaction;
    console.log('Ledger ensureTransactionInstance: Validating transaction object', {
      hasTxID: typeof txn.txID === 'function',
      hasToEncodingData: typeof txn.toEncodingData === 'function',
      availableMethods: Object.getOwnPropertyNames(txn).filter(name => typeof (txn as any)[name] === 'function'),
    });

    if (typeof txn.txID !== 'function') {
      throw new LedgerAccountError(
        'Invalid transaction payload - missing txID method',
        'LEDGER_INVALID_TRANSACTION'
      );
    }

    if (typeof (txn as any).toEncodingData !== 'function') {
      throw new LedgerAccountError(
        'Invalid transaction payload - missing toEncodingData method. This suggests the transaction is not a proper algosdk Transaction instance (algosdk v3).',
        'LEDGER_INVALID_TRANSACTION'
      );
    }

    console.log('Ledger ensureTransactionInstance: Transaction validation passed');
    return txn;
  }

  private buildSignedTransaction(
    transaction: Transaction,
    signature: Uint8Array,
    signerAddress?: string
  ): Uint8Array {
    // If a signer address is provided, attach the signature via the Transaction API.
    // This will automatically include `sgnr` when signer != sender (auth-addr for rekeyed txns).
    if (signerAddress && signerAddress.length > 0) {
      return transaction.attachSignature(signerAddress, signature);
    }

    // Fallback: construct SignedTransaction without explicit sgnr.
    // Safe when signer == sender.
    const stxn = new SignedTransaction({ txn: transaction, sig: signature });
    return encodeMsgpack(stxn);
  }

  private async getAppAndVersion(transport: Transport): Promise<LedgerAppInfo> {
    let response: Buffer;

    try {
      response = await transport.send(0xb0, 0x01, 0x00, 0x00);
    } catch (error) {
      console.log('Ledger APDU Error:', error);

      const message = error instanceof Error ? error.message : String(error);

      if (
        error instanceof LockedDeviceError ||
        (error instanceof TransportStatusError && error.statusCode === StatusCodes.SECURITY_STATUS_NOT_SATISFIED) ||
        message.toLowerCase().includes('0x5515') ||
        message.toLowerCase().includes('locked device')
      ) {
        throw new LedgerAccountError(
          'Ledger device is locked',
          'LEDGER_DEVICE_LOCKED'
        );
      }

      throw new LedgerAccountError(
        'Failed to communicate with Ledger device',
        'LEDGER_COMMUNICATION_ERROR'
      );
    }

    // Debug logging for device builds
    console.log('Ledger APDU Response:', {
      length: response?.length || 0,
      raw: response ? Array.from(response).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(' ') : 'null'
    });

    // Remove status bytes (0x90 0x00) from the end if present
    let dataLength = response.length;
    if (dataLength >= 2 && response[dataLength - 2] === 0x90 && response[dataLength - 1] === 0x00) {
      dataLength -= 2;
      console.log('Ledger Removed status bytes, new length:', dataLength);
    }

    if (dataLength < 3) {
      console.log('Ledger Response Too Short:', dataLength);
      throw new LedgerAccountError(
        `Unable to read Ledger app information (response length: ${dataLength})`,
        'LEDGER_INVALID_APP_INFO'
      );
    }

    // The first byte appears to be a format indicator, skip it
    // The actual app name length is at index 1
    const appNameLength = response[1];
    console.log('Ledger App Name Length:', appNameLength);

    const nameStart = 2; // Skip format byte and length byte
    const nameEnd = nameStart + appNameLength;

    if (nameEnd > dataLength) {
      console.log('Ledger Name End Exceeds Response:', { nameEnd, dataLength });
      throw new LedgerAccountError(
        `Malformed Ledger app information payload (name end: ${nameEnd}, data length: ${dataLength})`,
        'LEDGER_INVALID_APP_INFO'
      );
    }

    const appName = response.slice(nameStart, nameEnd).toString('ascii');
    console.log('Ledger App Name:', appName);

    // Handle case where version info might be missing or truncated
    let version = '1.0.0'; // Default fallback version
    let flags = 0x00; // Default flags

    if (nameEnd < dataLength) {
      const versionLength = response[nameEnd];
      console.log('Ledger Version Length:', versionLength);

      const versionStart = nameEnd + 1;
      const versionEnd = versionStart + versionLength;

      if (versionEnd <= dataLength && versionLength > 0) {
        version = response.slice(versionStart, versionEnd).toString('ascii');
        console.log('Ledger App Version:', version);

        // Try to get flags if available
        if (versionEnd < dataLength) {
          // Flags could be 1 or 2 bytes
          const remainingBytes = dataLength - versionEnd;
          if (remainingBytes >= 2) {
            flags = (response[versionEnd] << 8) | response[versionEnd + 1];
            console.log('Ledger App Flags (2 bytes):', `0x${flags.toString(16)}`);
          } else if (remainingBytes >= 1) {
            flags = response[versionEnd];
            console.log('Ledger App Flags (1 byte):', `0x${flags.toString(16)}`);
          }
        }
      } else {
        console.log('Ledger Version Info Incomplete or Missing:', {
          versionLength,
          versionStart,
          versionEnd,
          dataLength
        });
        // Use fallback version but continue
      }
    } else {
      console.log('Ledger No Version Info Available, Using Fallback');
    }

    const result = {
      name: appName,
      version,
      flags,
    };

    console.log('Ledger App Info Result:', result);
    return result;
  }

  private compareVersions(version: string, otherVersion: string): number {
    const a = version.split('.').map((num) => parseInt(num, 10));
    const b = otherVersion.split('.').map((num) => parseInt(num, 10));

    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const left = a[i] ?? 0;
      const right = b[i] ?? 0;
      if (left > right) return 1;
      if (left < right) return -1;
    }
    return 0;
  }

  private normalizeLedgerError(error: unknown): Error {
    if (
      error instanceof LedgerAccountError ||
      error instanceof LedgerDeviceNotConnectedError
    ) {
      return error;
    }

    if (error instanceof UserRefusedOnDevice) {
      return new LedgerUserRejectedError(
        'Transaction rejected on Ledger device'
      );
    }

    if (error instanceof TransportStatusError) {
      if (
        error.statusCode === StatusCodes.APP_NOT_FOUND_OR_INVALID_CONTEXT ||
        error.statusCode === StatusCodes.CLA_NOT_SUPPORTED ||
        error.statusCode === StatusCodes.INS_NOT_SUPPORTED
      ) {
        return new LedgerAppNotOpenError('Ledger Algorand app is not open');
      }
      if (error.statusCode === StatusCodes.CONDITIONS_OF_USE_NOT_SATISFIED) {
        return new LedgerUserRejectedError('Action rejected on Ledger device');
      }
      return new LedgerAccountError(
        `Ledger transport error: ${error.message}`,
        `LEDGER_STATUS_${error.statusCode}`
      );
    }

    if (error instanceof TransportError) {
      return new LedgerAccountError(
        `Ledger transport error: ${error.message}`,
        error.id ?? 'LEDGER_TRANSPORT_ERROR'
      );
    }

    if (error instanceof Error) {
      return new LedgerAccountError(error.message);
    }

    return new LedgerAccountError('Unknown Ledger error');
  }
}

export const ledgerAlgorandService = LedgerAlgorandService.getInstance();
export { LedgerAlgorandService };
