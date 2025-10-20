/**
 * WebSocket Connection Manager for WalletConnect v1
 * Handles connection to the bridge server and message routing
 */

import {
  WalletConnectV1SocketMessage,
  WalletConnectV1MessageType,
} from './types';
import {
  WS_CONNECTION_TIMEOUT,
  WS_RECONNECT_DELAY,
  WS_MAX_RECONNECT_ATTEMPTS,
} from './config';

export type WebSocketMessageHandler = (payload: string) => void;
export type WebSocketErrorHandler = (error: Error) => void;
export type WebSocketStatusHandler = (connected: boolean) => void;

export class WalletConnectV1WebSocket {
  private socket: WebSocket | null = null;
  private bridgeUrl: string;
  private subscribedTopics: Set<string> = new Set();
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private isManuallyDisconnected = false;

  // Event handlers
  private messageHandlers: Map<string, WebSocketMessageHandler> = new Map();
  private errorHandler: WebSocketErrorHandler | null = null;
  private statusHandler: WebSocketStatusHandler | null = null;
  private hasEstablishedConnection = false;

  constructor(bridgeUrl: string) {
    // Convert HTTPS to WSS for WebSocket connection
    this.bridgeUrl = bridgeUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://');
  }

  /**
   * Connect to the bridge server
   */
  async connect(): Promise<void> {
    // Check if socket exists and is truly connected
    if (this.socket?.readyState === WebSocket.OPEN) {
      console.warn(
        'WC v1 WebSocket: Existing open socket detected, closing before reconnect'
      );
      this.socket.close();
      this.socket = null;
    }

    this.isManuallyDisconnected = false;

    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.bridgeUrl);
        this.hasEstablishedConnection = false;

        // Set connection timeout
        this.connectionTimeout = setTimeout(() => {
          if (this.socket?.readyState !== WebSocket.OPEN) {
            console.error('WC v1 WebSocket: Connection timeout');
            this.socket?.close();
            reject(new Error('WebSocket connection timeout'));
          }
        }, WS_CONNECTION_TIMEOUT);

        this.socket.onopen = () => {
          if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
          }
          this.reconnectAttempts = 0;
          this.statusHandler?.(true);
          this.hasEstablishedConnection = true;

          // Resubscribe to topics if reconnecting
          if (this.subscribedTopics.size > 0) {
            this.subscribedTopics.forEach((topic) => {
              this.subscribeToTopic(topic);
            });
          }

          resolve();
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.socket.onerror = (error) => {
          if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
          }
          const errorObj = new Error('WebSocket error');

          if (this.hasEstablishedConnection) {
            console.warn('WC v1 WebSocket: Error after established connection, awaiting close');
            return;
          }

          console.error('WC v1 WebSocket: Error establishing connection', error);
          this.errorHandler?.(errorObj);
          reject(errorObj);
        };

        this.socket.onclose = (event) => {
          this.statusHandler?.(false);

          if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
          }

          // Attempt reconnection if not manually disconnected
          // Code 1006 (abnormal closure) after session approval is normal - bridge closes handshake
          if (!this.isManuallyDisconnected && event.code !== 1000) {
            // Only reconnect for unexpected closures, not normal closures
            this.attemptReconnect();
          }
        };
      } catch (error) {
        console.error('WC v1 WebSocket: Failed to create socket', error);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the bridge server
   */
  disconnect(): void {
    this.isManuallyDisconnected = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.hasEstablishedConnection = false;
    this.statusHandler?.(false);
  }

  /**
   * Subscribe to a topic on the bridge
   */
  subscribeToTopic(topic: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        console.warn('WC v1 WebSocket: Cannot subscribe, not connected');
        console.warn('WC v1 WebSocket: Current state:', this.getReadyStateString());
        resolve();
        return;
      }

      this.subscribedTopics.add(topic);

      const message: WalletConnectV1SocketMessage = {
        topic,
        type: WalletConnectV1MessageType.SUB,
        payload: '',
        silent: false, // Try without silent flag - maybe bridge ignores silent subs
      };

      this.send(JSON.stringify(message));

      // Wait a brief moment for subscription to be processed
      setTimeout(() => {
        resolve();
      }, 100);
    });
  }

  /**
   * Publish a message to a topic
   */
  publishToTopic(topic: string, payload: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error('WC v1 WebSocket: Cannot publish, not connected');
      throw new Error('WebSocket not connected');
    }

    const message: WalletConnectV1SocketMessage = {
      topic,
      type: WalletConnectV1MessageType.PUB,
      payload,
      silent: true,
    };

    this.send(JSON.stringify(message));
  }

  /**
   * Register a message handler for a specific topic
   */
  onTopicMessage(topic: string, handler: WebSocketMessageHandler): void {
    this.messageHandlers.set(topic, handler);
  }

  /**
   * Register a message handler with topic info
   */
  onTopicMessageWithMeta(topic: string, handler: (payload: string, topic: string) => void): void {
    this.messageHandlers.set(topic, (payload) => handler(payload, topic));
  }

  /**
   * Register error handler
   */
  onError(handler: WebSocketErrorHandler): void {
    this.errorHandler = handler;
  }

  /**
   * Register connection status handler
   */
  onStatusChange(handler: WebSocketStatusHandler): void {
    this.statusHandler = handler;
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Get human-readable WebSocket state
   */
  private getReadyStateString(): string {
    if (!this.socket) return 'NO_SOCKET';
    switch (this.socket.readyState) {
      case WebSocket.CONNECTING: return 'CONNECTING';
      case WebSocket.OPEN: return 'OPEN';
      case WebSocket.CLOSING: return 'CLOSING';
      case WebSocket.CLOSED: return 'CLOSED';
      default: return 'UNKNOWN';
    }
  }

  /**
   * Get subscribed topics for debugging
   */
  getSubscribedTopics(): string[] {
    return Array.from(this.subscribedTopics);
  }

  /**
   * Get registered handlers for debugging
   */
  getRegisteredHandlers(): string[] {
    return Array.from(this.messageHandlers.keys());
  }

  /**
   * Send raw message through WebSocket
   */
  private send(message: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    this.socket.send(message);
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as WalletConnectV1SocketMessage;

      // Handle acknowledgments
      if (message.type === WalletConnectV1MessageType.ACK) {
        return;
      }

      // Route message to topic handler
      if (message.topic && message.payload) {
        const handler = this.messageHandlers.get(message.topic);
        if (handler) {
          handler(message.payload);
        } else {
          console.warn('WC v1 WebSocket: No handler for topic', message.topic);
        }
      }
    } catch (error) {
      console.error('WC v1 WebSocket: Failed to parse message', error);
      this.errorHandler?.(
        error instanceof Error ? error : new Error('Failed to parse message')
      );
    }
  }

  /**
   * Attempt to reconnect after connection loss
   */
  private attemptReconnect(): void {
    if (this.isManuallyDisconnected) {
      return;
    }

    if (this.reconnectAttempts >= WS_MAX_RECONNECT_ATTEMPTS) {
      console.error(
        'WC v1 WebSocket: Max reconnection attempts reached'
      );
      this.errorHandler?.(
        new Error('Failed to reconnect after maximum attempts')
      );
      return;
    }

    this.reconnectAttempts++;

    this.reconnectTimeout = setTimeout(() => {
      this.connect().catch((error) => {
        console.error('WC v1 WebSocket: Reconnection failed', error);
      });
    }, WS_RECONNECT_DELAY * this.reconnectAttempts);
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.disconnect();
    this.messageHandlers.clear();
    this.subscribedTopics.clear();
    this.errorHandler = null;
    this.statusHandler = null;
    this.hasEstablishedConnection = false;
  }
}
