/**
 * WalletConnect v1 Types
 * Based on WalletConnect v1 protocol and ARC-25 specification
 */

export interface WalletConnectV1SessionConfig {
  topic: string;
  version: string;
  bridge: string;
  key: string;
}

export interface WalletConnectV1PeerMeta {
  name: string;
  description: string | null;
  url: string;
  icons: string[];
}

export interface WalletConnectV1SessionData {
  connected: boolean;
  accounts: string[];
  chainId: number;
  bridge: string;
  key: string;
  clientId: string;
  clientMeta: WalletConnectV1PeerMeta | null;
  peerId: string;
  peerMeta: WalletConnectV1PeerMeta | null;
  handshakeId: number;
  handshakeTopic: string;
}

export interface WalletConnectV1SessionRequest {
  id: number;
  jsonrpc: '2.0';
  method: 'wc_sessionRequest';
  params: [
    {
      peerId: string;
      peerMeta: WalletConnectV1PeerMeta;
      chainId?: number;
    },
  ];
}

export interface WalletConnectV1SessionUpdate {
  approved: boolean;
  chainId: number;
  accounts: string[];
}

/**
 * WalletConnect v1 JSON-RPC Request
 */
export interface WalletConnectV1Request {
  id: number;
  jsonrpc: '2.0';
  method: string;
  params: any[];
}

/**
 * WalletConnect v1 JSON-RPC Response
 */
export interface WalletConnectV1Response {
  id: number;
  jsonrpc: '2.0';
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * ARC-25: algo_signTxn method parameters
 * WalletTransaction format for Algorand
 */
export interface WalletConnectV1Transaction {
  /**
   * Base64 encoded unsigned transaction
   */
  txn: string;

  /**
   * Optional message for the user
   */
  message?: string;

  /**
   * Optional list of addresses that must sign (multisig)
   */
  signers?: string[];

  /**
   * Optional auth address for rekeyed accounts
   */
  authAddr?: string;

  /**
   * Optional MSIG structure
   */
  msig?: {
    version: number;
    threshold: number;
    addrs: string[];
  };
}

/**
 * ARC-25: algo_signTxn request
 */
export interface AlgoSignTxnRequest extends WalletConnectV1Request {
  method: 'algo_signTxn';
  params: [WalletConnectV1Transaction[]];
}

/**
 * Encrypted message format for WalletConnect v1
 */
export interface WalletConnectV1EncryptedPayload {
  data: string;
  hmac: string;
  iv: string;
}

/**
 * WebSocket message types
 */
export enum WalletConnectV1MessageType {
  PUB = 'pub',
  SUB = 'sub',
  ACK = 'ack',
}

export interface WalletConnectV1SocketMessage {
  topic: string;
  type: WalletConnectV1MessageType;
  payload: string;
  silent?: boolean;
}

/**
 * Session storage structure
 */
export interface WalletConnectV1StoredSession {
  connected: boolean;
  accounts: string[];
  chainId: number;
  bridge: string;
  key: string;
  clientId: string;
  clientMeta: WalletConnectV1PeerMeta | null;
  peerId: string;
  peerMeta: WalletConnectV1PeerMeta | null;
  handshakeId: number;
  handshakeTopic: string;
  updatedAt?: number;
}

/**
 * Event types emitted by WalletConnect v1 client
 */
export enum WalletConnectV1Event {
  CONNECT = 'connect',
  DISCONNECT = 'disconnect',
  SESSION_REQUEST = 'session_request',
  SESSION_UPDATE = 'session_update',
  CALL_REQUEST = 'call_request',
  ERROR = 'error',
}

export interface WalletConnectV1EventPayload {
  event: WalletConnectV1Event;
  params: any;
}
