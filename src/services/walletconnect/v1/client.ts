/**
 * WalletConnect v1 Client
 * Main client class for WalletConnect v1 protocol support
 */

import { EventEmitter } from 'events';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  WalletConnectV1SessionConfig,
  WalletConnectV1SessionData,
  WalletConnectV1SessionRequest,
  WalletConnectV1Request,
  WalletConnectV1Event,
  AlgoSignTxnRequest,
  WalletConnectV1PeerMeta,
  WalletConnectV1StoredSession,
} from './types';
import { WalletConnectV1WebSocket } from './websocket';
import { generateClientId } from './crypto';
import {
  parseEncryptedPayload,
  decryptRequest,
  encryptResponse,
  isSessionRequest,
  isAlgoSignTxnRequest,
  createSessionApprovalResponse,
  createSessionUpdateMessage,
  createSignTxnResponse,
  createErrorResponse,
  parseSessionRequest,
  validateAlgoSignTxnRequest,
  extractTransactionsFromRequest,
  WC_ERROR_CODES,
} from './protocol';
import {
  DEFAULT_PEER_META,
  DEFAULT_CHAIN_ID,
  WC_V1_SESSION_STORAGE_KEY,
} from './config';

export class WalletConnectV1Client extends EventEmitter {
  private static instance: WalletConnectV1Client | null = null;
  private config: WalletConnectV1SessionConfig | null = null;
  private socket: WalletConnectV1WebSocket | null = null;
  private sessionData: WalletConnectV1SessionData | null = null;
  private clientId: string | null = null;
  private handshakeId: number = 0;
  private handshakeTopic: string | null = null;

  static getInstance(): WalletConnectV1Client {
    if (!WalletConnectV1Client.instance) {
      WalletConnectV1Client.instance = new WalletConnectV1Client();
    }
    return WalletConnectV1Client.instance;
  }

  /**
   * Initialize client with URI
   */
  async connect(config: WalletConnectV1SessionConfig): Promise<void> {
    try {
      if (this.sessionData?.connected) {
        console.warn('WC v1 Client: Replacing active session with new connection request', {
          existingSession: this.sessionData.peerId,
          newTopic: config.topic,
        });
        // Disconnect the old session's WebSocket
        if (this.socket) {
          this.socket.destroy();
          this.socket = null;
        }
        // Clear old session data but keep storage (user might want to reconnect)
        this.sessionData = null;
        this.clientId = null;
        this.handshakeId = 0;
        this.handshakeTopic = null;
      }

      this.config = config;

      // Generate client ID if not already set
      if (!this.clientId) {
        this.clientId = await generateClientId();
      }

      // Create WebSocket connection
      this.socket = new WalletConnectV1WebSocket(config.bridge);

      // Set up WebSocket event handlers
      this.socket.onStatusChange((connected) => {
        if (connected) {
          this.emit(WalletConnectV1Event.CONNECT);
        } else {
          this.emit(WalletConnectV1Event.DISCONNECT);
        }
      });

      this.socket.onError((error) => {
        console.error('WC v1 Client: WebSocket error', error);
        // Only emit error if we don't have an active session
        // Reconnection errors during active sessions are handled internally
        if (!this.sessionData?.connected) {
          this.emit(WalletConnectV1Event.ERROR, error);
        }
      });

      // Try to restore session data from storage FIRST
      const storedSession = await this.loadSession(config.topic);
      if (storedSession && storedSession.connected) {
        // Restore session data BEFORE setting up socket
        // MUST use the stored clientId - DorkFi has this and publishes to it
        this.sessionData = storedSession;
        this.clientId = storedSession.clientId;
        this.handshakeId = storedSession.handshakeId;
        this.handshakeTopic = storedSession.handshakeTopic;
      }

      // Set up message handler for session topic (with topic tracking)
      this.socket.onTopicMessageWithMeta(config.topic, (payload, topic) => {
        this.handleMessage(payload, topic);
      });

      // If we restored a session, also set up handler for clientId topic
      if (this.clientId) {
        this.socket.onTopicMessageWithMeta(this.clientId, (payload, topic) => {
          this.handleMessage(payload, topic);
        });
      }

      // Connect to bridge
      await this.socket.connect();

      // If restoring a session, ONLY subscribe to clientId (handshake topic is dead after approval)
      // If fresh connection, subscribe to handshake topic to receive session_request
      if (this.clientId && storedSession) {
        await this.socket.subscribeToTopic(this.clientId);

        // Send session_update to DorkFi to notify them we're back online
        try {
          await this.updateSession(storedSession.accounts, storedSession.chainId);
        } catch (error) {
          console.error('WC v1 Client: Failed to send session update', error);
        }
      } else {
        // Fresh connection: subscribe to handshake topic
        await this.socket.subscribeToTopic(config.topic);
      }
    } catch (error) {
      console.error('WC v1 Client: Connection failed', error);
      this.emit(WalletConnectV1Event.ERROR, error);
      throw error;
    }
  }

  /**
   * Approve session with accounts
   * Note: chainId parameter is optional - if not provided, uses the chainId from session request
   */
  async approveSession(
    accounts: string[],
    chainId?: number
  ): Promise<void> {
    if (!this.config || !this.socket || !this.clientId) {
      throw new Error('Client not connected');
    }

    if (!this.sessionData) {
      throw new Error('No pending session request');
    }

    try {
      // Use the chain ID from the session request (dApp's requested chainId)
      // This ensures we respond with the same chainId the dApp sent us
      const responseChainId = chainId ?? this.sessionData.chainId;

      // Create approval response
      const response = createSessionApprovalResponse(
        this.handshakeId,
        true,
        responseChainId,
        accounts,
        DEFAULT_PEER_META,
        this.clientId
      );

      // Encrypt and send response
      const encryptedResponse = await encryptResponse(response, this.config.key);

      // Subscribe to OUR clientId topic - this is where dApp will send algo_signTxn requests!
      // The dApp sends requests to this.peerId (which is OUR clientId from their perspective)
      this.socket.onTopicMessageWithMeta(this.clientId, (payload, topic) => {
        this.handleMessage(payload, topic);
      });
      await this.socket.subscribeToTopic(this.clientId);

      // WalletConnect v1 protocol: responses go to peerId topic ONLY
      // Per WalletConnect client source: _sendResponse uses this.peerId as topic
      // The dApp subscribes to its clientId (peerId) and listens there for responses
      const peerIdTopic = this.sessionData.peerId;

      // Publish to peerId topic (where dApp is subscribed and listening)
      this.socket.publishToTopic(peerIdTopic, encryptedResponse);

      // Update session data
      this.sessionData = {
        ...this.sessionData,
        connected: true,
        accounts,
        chainId: responseChainId,
        clientId: this.clientId,
        clientMeta: DEFAULT_PEER_META,
      };

      // Store session
      await this.storeSession();
    } catch (error) {
      console.error('WC v1 Client: Failed to approve session', error);
      throw error;
    }
  }

  /**
   * Reject session
   */
  async rejectSession(): Promise<void> {
    if (!this.config || !this.socket || !this.clientId) {
      throw new Error('Client not connected');
    }

    try {
      // Create rejection response
      const response = createSessionApprovalResponse(
        this.handshakeId,
        false,
        0,
        [],
        DEFAULT_PEER_META,
        this.clientId
      );

      // Encrypt and send response
      const encryptedResponse = await encryptResponse(response, this.config.key);
      this.socket.publishToTopic(this.config.topic, encryptedResponse);

      // Disconnect
      await this.disconnect();
    } catch (error) {
      console.error('WC v1 Client: Failed to reject session', error);
      throw error;
    }
  }

  /**
   * Update session with new accounts
   */
  async updateSession(
    accounts: string[],
    chainId?: number
  ): Promise<void> {
    if (!this.config || !this.socket || !this.sessionData) {
      throw new Error('No active session');
    }

    try {
      const updateMessage = createSessionUpdateMessage({
        approved: true,
        chainId: chainId || this.sessionData.chainId,
        accounts,
      });

      // Encrypt and send update to peerId topic
      const encryptedUpdate = await encryptResponse(updateMessage, this.config.key);
      const updateTopic = this.sessionData.peerId || this.config.topic;

      this.socket.publishToTopic(updateTopic, encryptedUpdate);

      // Update local session data
      this.sessionData.accounts = accounts;
      if (chainId) {
        this.sessionData.chainId = chainId;
      }

      // Store updated session
      await this.storeSession();
    } catch (error) {
      console.error('WC v1 Client: Failed to update session', error);
      throw error;
    }
  }

  /**
   * Approve transaction signing request
   */
  async approveRequest(requestId: number, signedTxns: string[]): Promise<void> {
    if (!this.config || !this.socket || !this.sessionData) {
      throw new Error('Client not connected');
    }

    try {
      const response = createSignTxnResponse(requestId, signedTxns);

      // Encrypt and send response to peerId topic
      const encryptedResponse = await encryptResponse(response, this.config.key);
      const responseTopic = this.sessionData.peerId || this.config.topic;
      this.socket.publishToTopic(responseTopic, encryptedResponse);
    } catch (error) {
      console.error('WC v1 Client: Failed to approve request', error);
      throw error;
    }
  }

  /**
   * Reject transaction signing request
   */
  async rejectRequest(requestId: number, reason?: string): Promise<void> {
    if (!this.config || !this.socket) {
      throw new Error('Client not connected');
    }

    try {
      const response = createErrorResponse(
        requestId,
        WC_ERROR_CODES.USER_REJECTED,
        reason || 'User rejected the request'
      );

      // Encrypt and send response to appropriate topic
      const encryptedResponse = await encryptResponse(response, this.config.key);
      // Use peerId topic if we have session data, otherwise use handshake topic
      const responseTopic = this.sessionData?.peerId || this.config.topic;
      this.socket.publishToTopic(responseTopic, encryptedResponse);
    } catch (error) {
      console.error('WC v1 Client: Failed to reject request', error);
      throw error;
    }
  }

  /**
   * Disconnect and kill session
   */
  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    // Clear session from storage
    if (this.config) {
      await this.clearSession();
    }

    this.config = null;
    this.sessionData = null;
    this.emit(WalletConnectV1Event.DISCONNECT);
  }

  /**
   * Get current session data
   */
  getSessionData(): WalletConnectV1SessionData | null {
    return this.sessionData;
  }

  /**
   * Check if session is connected
   */
  isConnected(): boolean {
    return this.sessionData?.connected === true && this.socket?.isConnected() === true;
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(payloadString: string, receivedOnTopic?: string): Promise<void> {
    try {
      if (!this.config) {
        console.error('WC v1 Client: No config available');
        return;
      }

      // Parse encrypted payload
      const encryptedPayload = parseEncryptedPayload(payloadString);
      if (!encryptedPayload) {
        console.error('WC v1 Client: Failed to parse encrypted payload');
        return;
      }

      // Decrypt request
      const request = await decryptRequest(encryptedPayload, this.config.key);
      if (!request) {
        // Silently ignore - could be a response message or invalid data
        return;
      }

      // Handle different request types
      if (isSessionRequest(request)) {
        // Store the topic we received this on - we'll respond on the same topic
        if (receivedOnTopic) {
          this.handshakeTopic = receivedOnTopic;
        }
        await this.handleSessionRequest(request);
      } else if (isAlgoSignTxnRequest(request)) {
        await this.handleSignTxnRequest(request);
      } else {
        console.warn('WC v1 Client: Unsupported method', request.method);
        // Send error response for unsupported methods
        await this.rejectRequest(
          request.id,
          `Unsupported method: ${request.method}`
        );
      }
    } catch (error) {
      console.error('WC v1 Client: Failed to handle message', error);
      this.emit(WalletConnectV1Event.ERROR, error);
    }
  }

  /**
   * Handle session request
   */
  private async handleSessionRequest(
    request: WalletConnectV1SessionRequest
  ): Promise<void> {
    const { peerId, peerMeta, chainId } = parseSessionRequest(request);

    // Store the requested chain ID to respond with the same one
    const requestedChainId = chainId || DEFAULT_CHAIN_ID;

    this.handshakeId = request.id;
    this.sessionData = {
      connected: false,
      accounts: [],
      chainId: requestedChainId,
      bridge: this.config!.bridge,
      key: this.config!.key,
      clientId: this.clientId!,
      clientMeta: DEFAULT_PEER_META,
      peerId,
      peerMeta,
      handshakeId: request.id,
      handshakeTopic: this.config!.topic,
    };

    // Emit session_request event for UI to handle
    this.emit(WalletConnectV1Event.SESSION_REQUEST, {
      id: request.id,
      peerMeta,
      chainId: requestedChainId,
    });
  }

  /**
   * Handle algo_signTxn request (ARC-25)
   */
  private async handleSignTxnRequest(
    request: AlgoSignTxnRequest
  ): Promise<void> {
    if (!validateAlgoSignTxnRequest(request)) {
      console.error('WC v1 Client: Invalid algo_signTxn request');
      await this.rejectRequest(request.id, 'Invalid request format');
      return;
    }

    const transactions = extractTransactionsFromRequest(request);

    // Emit call_request event for UI to handle
    this.emit(WalletConnectV1Event.CALL_REQUEST, {
      id: request.id,
      method: request.method,
      params: transactions,
    });
  }

  /**
   * Store session in AsyncStorage
   */
  private async storeSession(): Promise<void> {
    if (!this.sessionData || !this.config) {
      return;
    }

    try {
      const storedSession: WalletConnectV1StoredSession = {
        connected: this.sessionData.connected,
        accounts: this.sessionData.accounts,
        chainId: this.sessionData.chainId,
        bridge: this.sessionData.bridge,
        key: this.sessionData.key,
        clientId: this.sessionData.clientId,
        clientMeta: this.sessionData.clientMeta,
        peerId: this.sessionData.peerId,
        peerMeta: this.sessionData.peerMeta,
        handshakeId: this.sessionData.handshakeId,
        handshakeTopic: this.sessionData.handshakeTopic,
        updatedAt: Date.now(),
      };

      const key = `${WC_V1_SESSION_STORAGE_KEY}:${this.config.topic}`;
      await AsyncStorage.setItem(key, JSON.stringify(storedSession));
      await this.removeStaleSessions(key);
    } catch (error) {
      console.error('WC v1 Client: Failed to store session', error);
    }
  }

  /**
   * Clear session from AsyncStorage
   */
  private async clearSession(): Promise<void> {
    if (!this.config) {
      return;
    }

    try {
      const key = `${WC_V1_SESSION_STORAGE_KEY}:${this.config.topic}`;
      await AsyncStorage.removeItem(key);
    } catch (error) {
      console.error('WC v1 Client: Failed to clear session', error);
    }
  }

  /**
   * Load stored session
   */
  async loadSession(topic: string): Promise<WalletConnectV1SessionData | null> {
    try {
      const key = `${WC_V1_SESSION_STORAGE_KEY}:${topic}`;
      const stored = await AsyncStorage.getItem(key);

      if (!stored) {
        return null;
      }

      const sessionData = JSON.parse(stored) as WalletConnectV1StoredSession;
      return sessionData;
    } catch (error) {
      console.error('WC v1 Client: Failed to load session', error);
      return null;
    }
  }

  /**
   * Remove stale v1 sessions from storage to ensure we only track the active one
   */
  private async removeStaleSessions(activeKey: string): Promise<void> {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const staleKeys = allKeys.filter(
        (key) =>
          key.startsWith(WC_V1_SESSION_STORAGE_KEY) && key !== activeKey
      );

      if (staleKeys.length > 0) {
        await AsyncStorage.multiRemove(staleKeys);
      }
    } catch (error) {
      console.error('WC v1 Client: Failed to remove stale sessions', error);
    }
  }
}
