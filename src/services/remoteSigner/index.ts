/**
 * Remote Signer Service
 *
 * Core service for QR-based air-gapped transaction signing.
 * Handles encoding/decoding of payloads and transaction operations.
 */

import algosdk from 'algosdk';
import { getCrypto } from '@/platform';
import { NetworkService } from '../network';
import { SecureKeyManager } from '../secure/keyManager';
import {
  RemoteSignerRequest,
  RemoteSignerResponse,
  RemoteSignerPairing,
  RemoteSignerPayload,
  SignableTransaction,
  SignedTransaction,
  DecodedTransactionInfo,
  TransactionDisplayType,
  RemoteSignerErrorCode,
  isRemoteSignerRequest,
  isRemoteSignerResponse,
  isRemoteSignerPairing,
  REMOTE_SIGNER_CONSTANTS,
} from '../../types/remoteSigner';

/**
 * Remote Signer Service - singleton instance
 */
class RemoteSignerServiceClass {
  private static instance: RemoteSignerServiceClass | null = null;

  public static getInstance(): RemoteSignerServiceClass {
    if (!RemoteSignerServiceClass.instance) {
      RemoteSignerServiceClass.instance = new RemoteSignerServiceClass();
    }
    return RemoteSignerServiceClass.instance;
  }

  // ============ Payload Encoding/Decoding ============

  /**
   * Encode a payload to JSON string for QR code
   */
  encodePayload(payload: RemoteSignerPayload): string {
    return JSON.stringify(payload);
  }

  /**
   * Decode a JSON string from QR code to payload
   */
  decodePayload(data: string): RemoteSignerPayload {
    try {
      const parsed = JSON.parse(data);

      // Validate it has the required fields
      if (!parsed.v || !parsed.t) {
        throw new Error('Invalid payload: missing version or type');
      }

      return parsed as RemoteSignerPayload;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Invalid QR code: not valid JSON');
      }
      throw error;
    }
  }

  /**
   * Get the size of an encoded payload in bytes
   */
  getPayloadSize(payload: RemoteSignerPayload): number {
    return new TextEncoder().encode(this.encodePayload(payload)).length;
  }

  /**
   * Check if payload needs animated QR (too large for single QR)
   */
  needsAnimatedQR(payload: RemoteSignerPayload): boolean {
    return this.getPayloadSize(payload) > REMOTE_SIGNER_CONSTANTS.SINGLE_QR_MAX_BYTES;
  }

  // ============ Request Creation ============

  /**
   * Create a signing request from unsigned transactions
   */
  async createSigningRequest(
    unsignedTxns: algosdk.Transaction[],
    signerAddresses: string[],
    options?: {
      authAddresses?: (string | undefined)[];
      dappName?: string;
      description?: string;
    }
  ): Promise<RemoteSignerRequest> {
    const networkService = NetworkService.getInstance();
    const networkId = networkService.getCurrentNetworkId();
    const genesisHash = unsignedTxns[0]?.genesisHash
      ? Buffer.from(unsignedTxns[0].genesisHash).toString('base64')
      : '';

    const txns: SignableTransaction[] = unsignedTxns.map((txn, index) => {
      const txnAny = txn as any;
      const senderField = txnAny.from || txnAny.sender;
      const senderAddress = senderField?.publicKey
        ? algosdk.encodeAddress(senderField.publicKey)
        : String(senderField || '');
      return {
        i: index,
        b: Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64'),
        s: signerAddresses[index] || senderAddress,
        a: options?.authAddresses?.[index],
      };
    });

    const request: RemoteSignerRequest = {
      v: REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION,
      t: 'req',
      id: getCrypto().randomUUID(),
      ts: Date.now(),
      net: networkId,
      gh: genesisHash,
      txns,
    };

    // Add metadata if provided
    if (options?.dappName || options?.description) {
      request.meta = {
        app: options.dappName,
        desc: options.description,
      };
    }

    return request;
  }

  /**
   * Create a signing request from a single unsigned transaction
   */
  async createSingleTxnRequest(
    unsignedTxn: algosdk.Transaction,
    signerAddress: string,
    authAddress?: string
  ): Promise<RemoteSignerRequest> {
    return this.createSigningRequest(
      [unsignedTxn],
      [signerAddress],
      authAddress ? { authAddresses: [authAddress] } : undefined
    );
  }

  // ============ Response Creation ============

  /**
   * Create a success response with signed transactions
   */
  createSuccessResponse(
    requestId: string,
    signedTxns: Uint8Array[]
  ): RemoteSignerResponse {
    const sigs: SignedTransaction[] = signedTxns.map((txn, index) => ({
      i: index,
      b: Buffer.from(txn).toString('base64'),
    }));

    return {
      v: REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION,
      t: 'res',
      id: requestId,
      ts: Date.now(),
      ok: true,
      sigs,
    };
  }

  /**
   * Create an error response
   */
  createErrorResponse(
    requestId: string,
    code: RemoteSignerErrorCode,
    message: string
  ): RemoteSignerResponse {
    return {
      v: REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION,
      t: 'res',
      id: requestId,
      ts: Date.now(),
      ok: false,
      err: { c: code, m: message },
    };
  }

  // ============ Pairing ============

  /**
   * Create a pairing payload to export accounts from signer
   */
  createPairingPayload(
    deviceId: string,
    deviceName: string | undefined,
    accounts: Array<{ address: string; publicKey: string; label?: string }>
  ): RemoteSignerPairing {
    return {
      v: REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION,
      t: 'pair',
      dev: deviceId,
      name: deviceName,
      accts: accounts.map((acc) => ({
        addr: acc.address,
        pk: acc.publicKey,
        label: acc.label,
      })),
      ts: Date.now(),
    };
  }

  // ============ Transaction Decoding ============

  /**
   * Decode a base64 unsigned transaction to human-readable format
   */
  decodeTransaction(base64Txn: string): DecodedTransactionInfo {
    const txnBytes = Buffer.from(base64Txn, 'base64');
    const txn = algosdk.decodeUnsignedTransaction(txnBytes) as any;

    // Determine transaction type
    let type: TransactionDisplayType = 'unknown';
    switch (txn.type) {
      case 'pay':
        type = 'payment';
        break;
      case 'axfer':
        type = 'asset_transfer';
        break;
      case 'appl':
        type = 'app_call';
        break;
      case 'acfg':
        type = 'asset_config';
        break;
      case 'afrz':
        type = 'asset_freeze';
        break;
      case 'keyreg':
        type = 'key_registration';
        break;
      case 'stpf':
        type = 'state_proof';
        break;
    }

    // Decode note field
    let note: string | undefined;
    if (txn.note && txn.note.length > 0) {
      try {
        note = new TextDecoder().decode(txn.note);
      } catch {
        note = Buffer.from(txn.note).toString('hex');
      }
    }

    // Handle both algosdk v2 and v3 field names
    const senderField = txn.from || txn.sender;
    const receiverField = txn.to || txn.receiver;
    const rekeyField = txn.reKeyTo || txn.rekeyTo;
    const closeField = txn.closeRemainderTo;
    const firstRound = txn.firstRound ?? txn.firstValid;
    const lastRound = txn.lastRound ?? txn.lastValid;
    const assetIndex = txn.assetIndex ?? txn.xaid;
    const appIndex = txn.appIndex ?? txn.apid;

    return {
      type,
      sender: senderField?.publicKey
        ? algosdk.encodeAddress(senderField.publicKey)
        : String(senderField || ''),
      receiver: receiverField?.publicKey
        ? algosdk.encodeAddress(receiverField.publicKey)
        : receiverField ? String(receiverField) : undefined,
      amount: txn.amount !== undefined ? BigInt(txn.amount) : undefined,
      fee: BigInt(txn.fee || 0),
      assetId: assetIndex,
      appId: appIndex,
      note,
      firstValid: BigInt(firstRound || 0),
      lastValid: BigInt(lastRound || 0),
      genesisId: txn.genesisID || txn.gen,
      genesisHash: txn.genesisHash
        ? Buffer.from(txn.genesisHash).toString('base64')
        : '',
      rekeyTo: rekeyField?.publicKey
        ? algosdk.encodeAddress(rekeyField.publicKey)
        : rekeyField ? String(rekeyField) : undefined,
      closeRemainderTo: closeField?.publicKey
        ? algosdk.encodeAddress(closeField.publicKey)
        : closeField ? String(closeField) : undefined,
      raw: txn,
    };
  }

  /**
   * Decode all transactions in a request
   */
  decodeRequestTransactions(request: RemoteSignerRequest): DecodedTransactionInfo[] {
    return request.txns.map((txn) => this.decodeTransaction(txn.b));
  }

  // ============ Signing (Signer Mode) ============

  /**
   * Sign all transactions in a request
   * This is called on the signer device
   */
  async signRequest(
    request: RemoteSignerRequest,
    pin: string,
    onProgress?: (index: number, total: number) => void
  ): Promise<RemoteSignerResponse> {
    try {
      const signedTxns: Uint8Array[] = [];
      const total = request.txns.length;

      for (let i = 0; i < total; i++) {
        const txnData = request.txns[i];
        onProgress?.(i + 1, total);

        // Decode the unsigned transaction
        const txnBytes = Buffer.from(txnData.b, 'base64');
        const txn = algosdk.decodeUnsignedTransaction(txnBytes);

        // Sign with the appropriate address
        const signerAddress = txnData.a || txnData.s; // Use auth address if provided
        const signedTxnBlob = await SecureKeyManager.signTransaction(
          txn,
          signerAddress,
          pin
        );

        signedTxns.push(signedTxnBlob);
      }

      return this.createSuccessResponse(request.id, signedTxns);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Signing failed';
      return this.createErrorResponse(request.id, 'FAILED', message);
    }
  }

  // ============ Response Processing (Wallet Mode) ============

  /**
   * Extract signed transactions from a response
   */
  extractSignedTransactions(response: RemoteSignerResponse): Uint8Array[] {
    if (!response.ok || !response.sigs) {
      throw new Error(response.err?.m || 'Response does not contain signatures');
    }

    return response.sigs
      .sort((a, b) => a.i - b.i)
      .map((sig) => Buffer.from(sig.b, 'base64'));
  }

  /**
   * Validate that a response matches a request
   */
  validateResponse(
    response: RemoteSignerResponse,
    request: RemoteSignerRequest
  ): { valid: boolean; error?: string } {
    // Check request ID matches
    if (response.id !== request.id) {
      return { valid: false, error: 'Response ID does not match request' };
    }

    // Check protocol version
    if (response.v !== REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION) {
      return { valid: false, error: 'Protocol version mismatch' };
    }

    // If error response, it's technically valid (just not successful)
    if (!response.ok) {
      return { valid: true };
    }

    // Check signature count matches transaction count
    if (!response.sigs || response.sigs.length !== request.txns.length) {
      return { valid: false, error: 'Signature count does not match transaction count' };
    }

    return { valid: true };
  }

  // ============ Type Guards (re-exported for convenience) ============

  isRequest = isRemoteSignerRequest;
  isResponse = isRemoteSignerResponse;
  isPairing = isRemoteSignerPairing;
}

// Export singleton instance
export const RemoteSignerService = RemoteSignerServiceClass.getInstance();

// Export class for testing
export { RemoteSignerServiceClass };

// Export animated QR service
export { AnimatedQRService } from './animatedQR';
export type {
  AnimatedQRConfig,
  AnimatedQREncodeResult,
  AnimatedQRDecodeState,
} from './animatedQR';
