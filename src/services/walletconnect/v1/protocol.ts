/**
 * WalletConnect v1 Protocol Message Handler
 * Handles JSON-RPC message formatting and parsing
 */

import {
  WalletConnectV1Request,
  WalletConnectV1Response,
  WalletConnectV1SessionRequest,
  WalletConnectV1SessionUpdate,
  WalletConnectV1EncryptedPayload,
  WalletConnectV1PeerMeta,
  AlgoSignTxnRequest,
} from './types';
import { encryptMessage, decryptMessage } from './crypto';

/**
 * Parse encrypted payload from socket message
 */
export function parseEncryptedPayload(
  payloadString: string
): WalletConnectV1EncryptedPayload | null {
  try {
    const payload = JSON.parse(payloadString);

    if (!payload.data || !payload.hmac || !payload.iv) {
      console.error('WC v1 Protocol: Invalid encrypted payload structure');
      return null;
    }

    return {
      data: payload.data,
      hmac: payload.hmac,
      iv: payload.iv,
    };
  } catch (error) {
    console.error('WC v1 Protocol: Failed to parse encrypted payload', error);
    return null;
  }
}

/**
 * Decrypt and parse JSON-RPC request
 */
export async function decryptRequest(
  encryptedPayload: WalletConnectV1EncryptedPayload,
  key: string
): Promise<WalletConnectV1Request | null> {
  try {
    const decrypted = await decryptMessage(encryptedPayload, key);
    const request = JSON.parse(decrypted) as WalletConnectV1Request;

    if (!request.id || !request.jsonrpc || !request.method) {
      // Check if this is a response (has 'result' or 'error' instead of 'method')
      const isResponse = 'result' in request || 'error' in request;
      if (isResponse) {
        // Silently ignore responses - we don't currently process them
        return null;
      }

      console.error('WC v1 Protocol: Invalid JSON-RPC request structure', {
        decryptedMessage: decrypted.substring(0, 200), // First 200 chars
        hasId: !!request.id,
        hasJsonrpc: !!request.jsonrpc,
        hasMethod: !!request.method,
        actualFields: Object.keys(request),
      });
      return null;
    }

    return request;
  } catch (error) {
    console.error('WC v1 Protocol: Failed to decrypt request', {
      error: error instanceof Error ? error.message : String(error),
      payloadDataLength: encryptedPayload.data.length,
      payloadHmacLength: encryptedPayload.hmac.length,
      payloadIvLength: encryptedPayload.iv.length,
    });
    return null;
  }
}

/**
 * Encrypt and format JSON-RPC response
 */
export async function encryptResponse(
  response: WalletConnectV1Response,
  key: string
): Promise<string> {
  try {
    const responseJson = JSON.stringify(response);
    const encrypted = await encryptMessage(responseJson, key);
    return JSON.stringify(encrypted);
  } catch (error) {
    console.error('WC v1 Protocol: Failed to encrypt response', error);
    throw error;
  }
}

/**
 * Check if request is a session request
 */
export function isSessionRequest(
  request: WalletConnectV1Request
): request is WalletConnectV1SessionRequest {
  return request.method === 'wc_sessionRequest';
}

/**
 * Check if request is an algo_signTxn request (ARC-25)
 */
export function isAlgoSignTxnRequest(
  request: WalletConnectV1Request
): request is AlgoSignTxnRequest {
  return request.method === 'algo_signTxn';
}

/**
 * Create session approval response
 */
export function createSessionApprovalResponse(
  requestId: number,
  approved: boolean,
  chainId: number,
  accounts: string[],
  peerMeta: WalletConnectV1PeerMeta,
  peerId: string
): WalletConnectV1Response {
  if (!approved) {
    return {
      id: requestId,
      jsonrpc: '2.0',
      error: {
        code: 5001,
        message: 'User rejected session',
      },
    };
  }

  return {
    id: requestId,
    jsonrpc: '2.0',
    result: {
      approved: true,
      chainId,
      networkId: chainId, // Use chainId as networkId for compatibility
      accounts,
      rpcUrl: '', // Empty string for Algorand (not used)
      peerId,
      peerMeta,
    },
  };
}

/**
 * Create session update message
 */
export function createSessionUpdateMessage(
  update: WalletConnectV1SessionUpdate
): WalletConnectV1Request {
  return {
    id: Date.now(),
    jsonrpc: '2.0',
    method: 'wc_sessionUpdate',
    params: [update],
  };
}

/**
 * Create transaction signing response
 */
export function createSignTxnResponse(
  requestId: number,
  signedTxns: string[]
): WalletConnectV1Response {
  return {
    id: requestId,
    jsonrpc: '2.0',
    result: signedTxns,
  };
}

/**
 * Create error response
 */
export function createErrorResponse(
  requestId: number,
  code: number,
  message: string
): WalletConnectV1Response {
  return {
    id: requestId,
    jsonrpc: '2.0',
    error: {
      code,
      message,
    },
  };
}

/**
 * Error codes for WalletConnect v1
 */
export const WC_ERROR_CODES = {
  USER_REJECTED: 5001,
  UNAUTHORIZED_METHOD: 5002,
  INVALID_PARAMS: 5003,
  INTERNAL_ERROR: 5004,
  UNSUPPORTED_CHAIN: 5005,
} as const;

/**
 * Parse session request details
 */
export function parseSessionRequest(
  request: WalletConnectV1SessionRequest
): {
  peerId: string;
  peerMeta: WalletConnectV1PeerMeta;
  chainId: number | undefined;
} {
  const params = request.params[0];
  return {
    peerId: params.peerId,
    peerMeta: params.peerMeta,
    chainId: params.chainId,
  };
}

/**
 * Validate transaction signing request
 */
export function validateAlgoSignTxnRequest(
  request: AlgoSignTxnRequest
): boolean {
  if (!Array.isArray(request.params) || request.params.length === 0) {
    return false;
  }

  const transactions = request.params[0];
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return false;
  }

  // Validate each transaction has required fields
  for (const txn of transactions) {
    if (!txn.txn || typeof txn.txn !== 'string') {
      return false;
    }
  }

  return true;
}

/**
 * Extract transaction details from algo_signTxn request
 */
export function extractTransactionsFromRequest(request: AlgoSignTxnRequest) {
  return request.params[0];
}
