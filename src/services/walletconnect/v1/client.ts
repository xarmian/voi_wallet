/**
 * WalletConnect v1 Client
 * Main client class for WalletConnect v1 protocol support
 */

import { MultiAccountWalletService } from '@/services/wallet';
import { resolveProposalEligibility } from '../utils';
import { EventEmitter } from 'events';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  WalletConnectV1SessionConfig,
  WalletConnectV1SessionData,
  WalletConnectV1SessionRequest,
  WalletConnectV1Event,
  AlgoSignTxnRequest,
  WalletConnectV1PersistedSession,
  WalletConnectV1LegacyPersistedSession,
  isRestorableV1Session,
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
  resolveV1Chain,
  DEFAULT_PEER_META,
  DEFAULT_CHAIN_ID,
  WC_V1_SESSION_STORAGE_KEY,
} from './config';
import { redactError } from '@/utils/logRedaction';
import { describePeerMethod } from './peerLabels';
import {
  readSessionKey,
  readSessionKeySlotRaw,
  writeSessionKey,
  restoreSessionKeySlot,
  deleteSessionKeyForTopic,
  deleteSessionKeySlot,
  isValidV1SessionKey,
} from './sessionKeyStore';
import { deleteV1Session, deleteV1Sessions } from './sessionCleanup';

export class WalletConnectV1Client extends EventEmitter {
  private static instance: WalletConnectV1Client | null = null;
  private config: WalletConnectV1SessionConfig | null = null;
  private socket: WalletConnectV1WebSocket | null = null;
  private sessionData: WalletConnectV1SessionData | null = null;
  private clientId: string | null = null;
  private handshakeId: number = 0;
  private handshakeTopic: string | null = null;
  private connecting: Promise<void> | null = null;
  // Answers (and disconnects) in progress. The coordinator stops counting a
  // request once it is decided, so this keeps the link guard closed until the
  // answer, and any disconnect it ends in, has finished.
  private answering = 0;

  static getInstance(): WalletConnectV1Client {
    if (!WalletConnectV1Client.instance) {
      WalletConnectV1Client.instance = new WalletConnectV1Client();
    }
    return WalletConnectV1Client.instance;
  }

  /**
   * Initialize client with URI
   */
  async connect(
    config: WalletConnectV1SessionConfig,
    options: { onlyIfIdle?: boolean } = {}
  ): Promise<boolean> {
    // This client is a singleton and holds one connection, so the two callers
    // (a pairing link, and boot session restore) never overlap. Restore passes
    // `onlyIfIdle` and is skipped, without waiting, when a connection already
    // exists or is being made: a link that is awaiting approval must not have
    // its session replaced under it. A link waits for a connection in flight
    // to settle and then replaces it, as a link always replaces a session.
    if (options.onlyIfIdle && (this.config !== null || this.connecting)) {
      return false;
    }
    while (this.connecting) {
      try {
        await this.connecting;
      } catch {
        // The connection in flight failed; its own caller reports that.
      }
    }
    const run = this.openConnection(config);
    this.connecting = run;
    try {
      await run;
    } finally {
      if (this.connecting === run) this.connecting = null;
    }
    return true;
  }

  private async openConnection(
    config: WalletConnectV1SessionConfig
  ): Promise<void> {
    try {
      if (this.socket || this.sessionData) {
        // `peerId` and `topic` are both peer/URI supplied — the topic arrives
        // straight from a scanned QR or deep link and is never validated — so
        // neither is echoed at all. The message alone carries the diagnostic.
        console.warn(
          'WC v1 Client: Replacing active session with new connection request'
        );
        // Always destroy the old socket, connected or still awaiting approval:
        // overwriting it would leave it open and delivering for a session this
        // client no longer owns.
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
        console.error('WC v1 Client: WebSocket error', redactError(error));
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
          await this.updateSession(
            storedSession.accounts,
            storedSession.chainId
          );
        } catch (error) {
          console.error(
            'WC v1 Client: Failed to send session update',
            redactError(error)
          );
        }
      } else {
        // Fresh connection: subscribe to handshake topic
        await this.socket.subscribeToTopic(config.topic);
      }
    } catch (error) {
      console.error('WC v1 Client: Connection failed');
      // A connection that failed holds nothing: leaving its config set would
      // keep the client reading as in use, and skip every later restore.
      if (this.config === config) {
        this.socket?.destroy();
        this.socket = null;
        this.config = null;
        this.sessionData = null;
      }
      this.emit(WalletConnectV1Event.ERROR, error);
      throw error;
    }
  }

  /**
   * Approve session with accounts
   * Note: chainId parameter is optional - if not provided, uses the chainId from session request
   */
  approveSession(accounts: string[], chainId?: number): Promise<void> {
    return this.whileAnswering(() =>
      this.answerApproveSession(accounts, chainId)
    );
  }

  private async answerApproveSession(
    accounts: string[],
    chainId?: number
  ): Promise<void> {
    if (!this.config || !this.socket || !this.clientId) {
      throw new Error('Client not connected');
    }

    if (!this.sessionData) {
      throw new Error('No pending session request');
    }
    // The proposal is closed in the coordinator before this runs, so a link may
    // connect while the probes and the subscribe below await. Everything the
    // answer needs is read once, here, and the session is confirmed unchanged
    // right before it is published.
    const config = this.config;
    const socket = this.socket;
    const clientId = this.clientId;
    const pending = this.sessionData;
    const handshakeId = this.handshakeId;

    try {
      const responseChainId = chainId ?? pending.chainId;
      const chain = resolveV1Chain(responseChainId);
      if (!chain) throw new Error('Unsupported v1 chain');
      const selected = (
        await MultiAccountWalletService.getAllAccounts()
      ).filter((account) => accounts.includes(account.address));
      const eligibility = await resolveProposalEligibility(selected, [
        chain.chainId,
      ]);
      if (eligibility.some((result) => result.errorChains.length))
        console.error('Signing authority probe failed for v1 proposal');
      accounts = eligibility
        .filter((result) => result.eligibleChains.length)
        .map(({ account }) => account.address);
      if (!accounts.length) throw new Error('No signable accounts available');
      // Use the chain ID from the session request (dApp's requested chainId)
      // This ensures we respond with the same chainId the dApp sent us
      // Create approval response
      const response = createSessionApprovalResponse(
        handshakeId,
        true,
        responseChainId,
        accounts,
        DEFAULT_PEER_META,
        clientId
      );

      // Encrypt and send response
      const encryptedResponse = await encryptResponse(response, config.key);

      // Subscribe to OUR clientId topic - this is where dApp will send algo_signTxn requests!
      // The dApp sends requests to this.peerId (which is OUR clientId from their perspective)
      socket.onTopicMessageWithMeta(clientId, (payload, topic) => {
        this.handleMessage(payload, topic);
      });
      await socket.subscribeToTopic(clientId);

      // A link replaced the session while this awaited: nothing is published,
      // and the replacing session's data is not overwritten.
      this.assertSessionUnchanged(config, socket);

      // WalletConnect v1 protocol: responses go to peerId topic ONLY
      // Per WalletConnect client source: _sendResponse uses this.peerId as topic
      // The dApp subscribes to its clientId (peerId) and listens there for responses
      const peerIdTopic = pending.peerId;

      // Publish to peerId topic (where dApp is subscribed and listening)
      socket.publishToTopic(peerIdTopic, encryptedResponse);

      // Update session data
      this.sessionData = {
        ...pending,
        connected: true,
        accounts,
        chainId: responseChainId,
        clientId: this.clientId,
        clientMeta: DEFAULT_PEER_META,
      };

      // Store session
      await this.storeSession();
    } catch (error) {
      console.error(
        'WC v1 Client: Failed to approve session',
        redactError(error)
      );
      throw error;
    }
  }

  /**
   * Reject session
   */
  rejectSession(): Promise<void> {
    return this.whileAnswering(() => this.answerRejectSession());
  }

  private async answerRejectSession(): Promise<void> {
    if (!this.config || !this.socket || !this.clientId) {
      throw new Error('Client not connected');
    }
    // Read once: the proposal is closed before this runs, and the encrypt
    // awaits, so a link may connect meanwhile. The disconnect below deletes the
    // current session, which must be the one that was rejected.
    const config = this.config;
    const socket = this.socket;

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
      const encryptedResponse = await encryptResponse(response, config.key);
      this.assertSessionUnchanged(config, socket);
      socket.publishToTopic(config.topic, encryptedResponse);

      // Disconnect
      await this.disconnect();
    } catch (error) {
      console.error(
        'WC v1 Client: Failed to reject session',
        redactError(error)
      );
      throw error;
    }
  }

  /**
   * Update session with new accounts
   */
  async updateSession(accounts: string[], chainId?: number): Promise<void> {
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
      const encryptedUpdate = await encryptResponse(
        updateMessage,
        this.config.key
      );
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
      console.error(
        'WC v1 Client: Failed to update session',
        redactError(error)
      );
      throw error;
    }
  }

  /** Whether an answer or a disconnect is still running. */
  isAnswering(): boolean {
    return this.answering > 0;
  }

  private async whileAnswering<T>(run: () => Promise<T>): Promise<T> {
    this.answering += 1;
    try {
      return await run();
    } finally {
      this.answering -= 1;
    }
  }

  /**
   * Throws when the connection captured before an await is no longer the
   * client's: a link replaced it, and publishing or disconnecting now would act
   * on the replacing session.
   */
  private assertSessionUnchanged(
    config: WalletConnectV1SessionConfig,
    socket: WalletConnectV1WebSocket
  ): void {
    if (this.config !== config || this.socket !== socket) {
      throw new Error('Session was replaced');
    }
  }

  /**
   * This client is a singleton: a new connection replaces its session, and an
   * answer is encrypted with the current key and sent to the current peer, so an
   * id alone cannot say which session a request came from. An answer that
   * names the topic its request arrived on is refused when that is no longer
   * the current session, rather than reaching a peer that never made the
   * request (and, for an approval, carrying signed transactions to it). The
   * topic is the one DeepLinkService stamps on a request: the session's
   * handshake topic, or the pairing topic before a session exists.
   */
  private assertRequestTopic(requestTopic?: string): void {
    if (requestTopic === undefined) return;
    const current = this.sessionData?.handshakeTopic || this.config?.topic;
    if (requestTopic !== current) {
      throw new Error('Request belongs to a replaced session');
    }
  }

  /**
   * Approve transaction signing request.
   *
   * DR-12: `signedTxns` is the ARC-0001 response array and admits `null` in the
   * slots the wallet declined to sign. Pass it straight through — filtering or
   * stringifying a null would break the dApp's positional reassembly of the
   * group (and reintroduce the `apaa` class of failure).
   */
  approveRequest(
    requestId: number,
    signedTxns: (string | null)[],
    requestTopic?: string
  ): Promise<void> {
    return this.whileAnswering(() =>
      this.answerApproveRequest(requestId, signedTxns, requestTopic)
    );
  }

  private async answerApproveRequest(
    requestId: number,
    signedTxns: (string | null)[],
    requestTopic?: string
  ): Promise<void> {
    if (!this.config || !this.socket || !this.sessionData) {
      throw new Error('Client not connected');
    }
    this.assertRequestTopic(requestTopic);
    // Key, peer and socket are read once, here, with the topic check: the
    // encrypt below awaits, and a link may replace the session meanwhile. The
    // answer is encrypted and published with the one session that was checked.
    const { key, topic: pairingTopic } = this.config;
    const socket = this.socket;
    const responseTopic = this.sessionData.peerId || pairingTopic;

    try {
      const response = createSignTxnResponse(requestId, signedTxns);

      // Encrypt and send response to peerId topic
      const encryptedResponse = await encryptResponse(response, key);
      socket.publishToTopic(responseTopic, encryptedResponse);
    } catch (error) {
      console.error(
        'WC v1 Client: Failed to approve request',
        redactError(error)
      );
      throw error;
    }
  }

  /**
   * Reject transaction signing request
   */
  rejectRequest(
    requestId: number,
    reason?: string,
    requestTopic?: string
  ): Promise<void> {
    return this.whileAnswering(() =>
      this.answerRejectRequest(requestId, reason, requestTopic)
    );
  }

  private async answerRejectRequest(
    requestId: number,
    reason?: string,
    requestTopic?: string
  ): Promise<void> {
    if (!this.config || !this.socket) {
      throw new Error('Client not connected');
    }
    this.assertRequestTopic(requestTopic);
    // Read once with the topic check, as in approveRequest.
    const { key, topic: pairingTopic } = this.config;
    const socket = this.socket;
    // Use peerId topic if we have session data, otherwise use handshake topic
    const responseTopic = this.sessionData?.peerId || pairingTopic;

    try {
      const response = createErrorResponse(
        requestId,
        WC_ERROR_CODES.USER_REJECTED,
        reason || 'User rejected the request'
      );

      // Encrypt and send response to appropriate topic
      const encryptedResponse = await encryptResponse(response, key);
      socket.publishToTopic(responseTopic, encryptedResponse);
    } catch (error) {
      console.error(
        'WC v1 Client: Failed to reject request',
        redactError(error)
      );
      throw error;
    }
  }

  /**
   * Disconnect and kill session
   */
  disconnect(): Promise<void> {
    return this.whileAnswering(() => this.disconnectNow());
  }

  private async disconnectNow(): Promise<void> {
    const config = this.config;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    // Clear session from storage
    if (config) {
      await this.clearSession();
    }

    // The storage delete awaits, and a link may have started a connection
    // meanwhile: its config and socket are not this disconnect's to clear.
    if (this.config === config) {
      this.config = null;
      this.sessionData = null;
    }
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
    return (
      this.sessionData?.connected === true &&
      this.socket?.isConnected() === true
    );
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(
    payloadString: string,
    receivedOnTopic?: string
  ): Promise<void> {
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
      const config = this.config;
      const socket = this.socket;
      const request = await decryptRequest(encryptedPayload, config.key);
      if (!request) {
        // Silently ignore - could be a response message or invalid data
        return;
      }
      // A link replaced the session while this decrypted: the message belongs
      // to a session this client no longer holds, so it is dropped rather than
      // handled (or answered) as the new session's.
      if (this.config !== config || this.socket !== socket) return;

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
        // `request.method` is arbitrary peer-controlled text. Pattern
        // redaction is NOT enough here: a peer can set `method` to the bare
        // session key, and bare hex is deliberately preserved by the redactor
        // (genesis hashes / txids). Truncation would not help either — a
        // truncated key is still leaked key material. So the value is only ever
        // echoed when it matches a KNOWN method name; anything else is reported
        // by length alone, which is all the diagnostics actually need.
        console.warn(
          'WC v1 Client: Unsupported method',
          describePeerMethod(request.method)
        );
        // Send error response for unsupported methods
        await this.rejectRequest(
          request.id,
          `Unsupported method: ${request.method}`
        );
      }
    } catch (error) {
      console.error(
        'WC v1 Client: Failed to handle message',
        redactError(error)
      );
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
   * Persist the session: routing metadata to AsyncStorage, the symmetric key to
   * secure storage (PLAN-260).
   *
   * ORDERING IS LOAD-BEARING (DR-5/DR-5a). The secure key is written FIRST and
   * the metadata SECOND, so the metadata row is the commit record — a crash
   * between the two leaves an orphaned key with no pointer, never a pointer to a
   * key that was never written.
   *
   * If the metadata write then FAILS, the secure write is ROLLED BACK to
   * whatever was there before. Without that rollback this split would be
   * strictly worse than the old single-blob write: storing session B while
   * session A is persisted would leave the slot holding B and A's metadata
   * intact, and A's topic check would then make A permanently unrestorable —
   * whereas the old code left A fully recoverable with its inline key.
   */
  private async storeSession(): Promise<void> {
    if (!this.sessionData || !this.config) {
      return;
    }

    // Capture identity BEFORE any await so a concurrent connect() cannot swap
    // `this.config` underneath us and make us write one session's key against
    // another session's topic (DR-12).
    const topic = this.config.topic;
    const sessionKey = this.sessionData.key;

    const persisted: WalletConnectV1PersistedSession = {
      connected: this.sessionData.connected,
      accounts: this.sessionData.accounts,
      chainId: this.sessionData.chainId,
      bridge: this.sessionData.bridge,
      clientId: this.sessionData.clientId,
      clientMeta: this.sessionData.clientMeta,
      peerId: this.sessionData.peerId,
      peerMeta: this.sessionData.peerMeta,
      handshakeId: this.sessionData.handshakeId,
      handshakeTopic: this.sessionData.handshakeTopic,
      updatedAt: Date.now(),
    };

    const storageKey = `${WC_V1_SESSION_STORAGE_KEY}:${topic}`;

    let priorSlot: string | null = null;
    let secureWritten = false;

    try {
      // Capture the prior slot for rollback. An unreadable slot (Android
      // keystore desync) is treated as "nothing to roll back to" — it was
      // already unusable.
      try {
        priorSlot = await readSessionKeySlotRaw();
      } catch {
        priorSlot = null;
      }

      await writeSessionKey(topic, sessionKey);
      secureWritten = true;

      await AsyncStorage.setItem(storageKey, JSON.stringify(persisted));
      await this.removeStaleSessions(storageKey, topic);
    } catch {
      console.error('WC v1 Client: Failed to store session');
      if (secureWritten) {
        try {
          await restoreSessionKeySlot(priorSlot);
        } catch {
          console.error('WC v1 Client: Failed to roll back session key');
        }
      }
    }
  }

  /**
   * Clear the session: metadata from AsyncStorage, key from secure storage.
   *
   * The secure delete is TOPIC-CONDITIONAL (DR-3a), and that is not a nicety.
   * `connect()` deliberately RETAINS the previous session's persisted storage
   * when replacing an active connection, but by then `this.config` already
   * points at the NEW topic. So pairing session B while session A is stored and
   * then rejecting B routes here with B's topic — an unconditional delete would
   * destroy A's key while A's metadata survived, leaving A unrestorable.
   *
   * Metadata is removed FIRST so it stays the commit record: the worst case is
   * an orphaned key with no pointer, which the constant slot self-heals on the
   * next pairing.
   */
  private async clearSession(): Promise<void> {
    if (!this.config) {
      return;
    }

    const topic = this.config.topic;

    try {
      await deleteV1Session(topic);
    } catch {
      console.error('WC v1 Client: Failed to clear session');
    }
  }

  /**
   * Load stored session
   */
  async loadSession(topic: string): Promise<WalletConnectV1SessionData | null> {
    try {
      const stored = await AsyncStorage.getItem(
        `${WC_V1_SESSION_STORAGE_KEY}:${topic}`
      );

      if (!stored) {
        return null;
      }

      const storageKey = `${WC_V1_SESSION_STORAGE_KEY}:${topic}`;

      let persisted: WalletConnectV1LegacyPersistedSession;
      try {
        const parsed: unknown = JSON.parse(stored);
        // Must be a non-null OBJECT: `JSON.parse('null')`, a bare string and an
        // array all parse cleanly and then throw on the first property access.
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error('v1 session entry is not an object');
        }
        const candidate = parsed as WalletConnectV1LegacyPersistedSession;
        // Same admission rule as boot restore — shared so the two paths cannot
        // drift apart (this one used to skip validation entirely).
        if (!isRestorableV1Session(candidate)) {
          throw new Error('v1 session entry is missing required fields');
        }
        persisted = candidate;
      } catch {
        // Unparseable rows can never restore a session but CAN still hold a
        // pre-PLAN-260 inline key, so retaining one would leave that key at
        // rest indefinitely. Delete it — nothing recoverable is lost. Mirrors
        // the restore path.
        console.warn('WC v1 Client: Deleting malformed session entry');
        await deleteV1Session(topic);
        return null;
      }

      // The key comes from secure storage. A legacy row may still carry it
      // inline (pre-PLAN-260); prefer the secure copy and fall back to the
      // legacy field so an un-migrated row still loads.
      //
      // This path MIGRATES AND DRAINS too, rather than leaving that to boot
      // restore. It is reachable independently — a v1 deep link connects
      // through here, and boot restore may never run if WalletConnect
      // initialization failed earlier — so relying on the restore path alone
      // would let a legacy key sit in AsyncStorage indefinitely.
      let sessionKey: string | null = null;
      try {
        sessionKey = await readSessionKey(topic);
      } catch {
        // Android keystore desync: the key is unrecoverable, so the session is
        // too. Fail closed to "no session" and let the user re-pair (DR-4), and
        // DELETE the row — otherwise a legacy inline key would stay at rest
        // forever on a path that can be reached without boot restore ever
        // running. Mirrors dropV1Session.
        console.error('WC v1 Client: Failed to load session key');
        await deleteV1Session(topic);
        return null;
      }

      const hasInlineKey =
        persisted.key !== undefined &&
        persisted.key !== null &&
        persisted.key !== '';
      const seedableKey = isValidV1SessionKey(persisted.key)
        ? persisted.key
        : null;
      let secureKeyConfirmed = sessionKey !== null;

      if (!sessionKey && seedableKey) {
        try {
          await writeSessionKey(topic, seedableKey);
          secureKeyConfirmed = true;
        } catch {
          // ACCEPTED RESIDUAL (same trade-off as the failed row-rewrite below):
          // secure storage is unavailable, so the inline key is the ONLY copy
          // left and it stays at rest in AsyncStorage until a later attempt
          // succeeds. The alternative is deleting the row, which would destroy
          // a perfectly working session because secure storage hiccupped —
          // strictly worse, and no better than the pre-migration status quo,
          // where the key lived there anyway.
          console.error('WC v1 Client: Failed to secure session key');
        }
        sessionKey = seedableKey;
      }

      if (!sessionKey) {
        // Parsable but unusable: no secure key and no seedable inline key. This
        // also catches valid JSON of the WRONG SHAPE (a bare string, an array),
        // which slips past the parse guard above while potentially still
        // containing key-shaped text. Restore drops such rows via
        // dropV1Session; do the same here so the two paths stay symmetric and
        // nothing is left at rest.
        console.warn('WC v1 Client: Deleting unusable session entry');
        await deleteV1Session(topic);
        return null;
      }

      // Same rule as boot restore: drain whenever the row still carries a key
      // AND the secure copy is confirmed — never strip the only copy.
      if (hasInlineKey && secureKeyConfirmed) {
        try {
          const { key: _dropped, ...keyless } = persisted;
          await AsyncStorage.setItem(storageKey, JSON.stringify(keyless));
        } catch {
          console.error('WC v1 Client: Failed to strip inline session key');
        }
      }

      return { ...persisted, key: sessionKey };
    } catch {
      console.error('WC v1 Client: Failed to load session');
      return null;
    }
  }

  /**
   * Remove stale v1 sessions from storage to ensure we only track the active one
   */
  private async removeStaleSessions(
    activeKey: string,
    activeTopic: string
  ): Promise<void> {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const staleKeys = allKeys.filter(
        (key) => key.startsWith(WC_V1_SESSION_STORAGE_KEY) && key !== activeKey
      );

      if (staleKeys.length > 0) {
        // Central cleanup so pruned rows go together with their keys.
        // dropSlot is FALSE — the ACTIVE session survives and owns the slot.
        await deleteV1Sessions(staleKeys, { dropSlot: false });
      }

      // The secure slot holds exactly one key. If it is bound to a topic we
      // just pruned — i.e. anything other than the surviving active topic — it
      // is now an orphan and must go too, or it would linger in a store that
      // cannot be enumerated. Topic-conditional, so the ACTIVE key is never the
      // one deleted.
      const slot = await readSessionKeySlotRaw().catch(() => null);
      if (slot) {
        try {
          const bound = JSON.parse(slot) as { topic?: unknown };
          if (typeof bound.topic === 'string' && bound.topic !== activeTopic) {
            await deleteSessionKeyForTopic(bound.topic);
          }
        } catch {
          // Unparseable slot is useless to anyone; drop it.
          await deleteSessionKeySlot();
        }
      }
    } catch {
      console.error('WC v1 Client: Failed to remove stale sessions');
    }
  }
}
