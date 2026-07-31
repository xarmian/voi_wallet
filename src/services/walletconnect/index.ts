import { SignClientTypes } from '@walletconnect/types';
import { getSdkError, buildApprovedNamespaces } from '@walletconnect/utils';
import { EventEmitter } from 'events';
import algosdk from 'algosdk';
import { Platform } from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { detectPlatform } from '@/platform/detection';
import { WalletConnectClient } from './client';
import { MultiAccountWalletService } from '@/services/wallet';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { AccountMetadata, AccountType } from '@/types/wallet';
import {
  WalletConnectSession,
  SessionProposal,
  WalletTransaction,
  WalletConnectRequestEvent,
} from './types';
import {
  getSignableAccounts,
  formatAccountAddress,
  validateAlgorandTransaction,
  sanitizeMetadata,
  isSessionExpired,
  detectRequestedChains,
  areAllRequiredChainsSupported,
  normalizeV1Metadata,
  parseAccountAddress,
} from './utils';
import {
  DEFAULT_NAMESPACES,
  VOI_CHAIN_DATA,
  ALGORAND_MAINNET_CHAIN_DATA,
} from './config';
import { useExperimentalStore } from '@/store/experimentalStore';
import {
  isRestorableV1Session,
  type WalletConnectV1LegacyPersistedSession,
} from '@/services/walletconnect/v1/types';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import {
  WC_V1_SESSION_STORAGE_KEY,
  resolveV1Chain,
} from '@/services/walletconnect/v1/config';
import { redactSensitiveForLog, redactError } from '@/utils/logRedaction';
import {
  readSessionKey,
  writeSessionKey,
  isValidV1SessionKey,
} from '@/services/walletconnect/v1/sessionKeyStore';
import {
  deleteV1Session,
  deleteV1Sessions,
  topicFromStorageKey,
} from '@/services/walletconnect/v1/sessionCleanup';

export class WalletConnectService extends EventEmitter {
  private static instance: WalletConnectService;
  private client: WalletConnectClient;
  private activeSessions: Map<string, WalletConnectSession> = new Map();
  private initialized = false;

  static getInstance(): WalletConnectService {
    if (!WalletConnectService.instance) {
      WalletConnectService.instance = new WalletConnectService();
    }
    return WalletConnectService.instance;
  }

  constructor() {
    super();
    this.client = WalletConnectClient.getInstance();
    this.setupEventHandlers();
  }

  async initialize(): Promise<void> {
    // Prevent double initialization
    if (this.initialized) {
      console.log('WalletConnect service already initialized, skipping');
      return;
    }

    try {
      await this.client.initialize();
      await this.loadExistingSessions();
      await this.loadV1Sessions();

      // Set up event handlers directly after initialization
      this.setupEventHandlersDirectly();

      this.initialized = true;
      console.log('WalletConnect service initialized successfully');
    } catch (error) {
      console.error(
        'Failed to initialize WalletConnect service:',
        redactError(error)
      );
      throw error;
    }
  }

  /**
   * Drop a v1 session that cannot be restored (PLAN-260, DR-4/DR-14).
   *
   * Reached when the session key is unreadable (Android keystore desync), does
   * not match the stored topic, is malformed, or is simply absent. A v1 bridge
   * transport key is cheap to re-establish and there is nothing to recover, so
   * the session is discarded and the user re-pairs by scanning the QR again.
   *
   * Also purges the QUEUED transaction requests of every topic it deletes.
   * Startup dequeues and navigates queued requests unconditionally, so a
   * request left behind here would land on a screen with no live session,
   * error, and be lost — it has already been removed from the queue by then.
   */
  private async dropV1Session(
    activeStorageKey: string,
    topic: string,
    sessions: { key: string }[]
  ): Promise<void> {
    try {
      const keysToRemove = sessions.map(({ key }) => key);
      if (!keysToRemove.includes(activeStorageKey)) {
        keysToRemove.push(activeStorageKey);
      }
      if (!keysToRemove.includes(`${WC_V1_SESSION_STORAGE_KEY}:${topic}`)) {
        keysToRemove.push(`${WC_V1_SESSION_STORAGE_KEY}:${topic}`);
      }

      // dropSlot is UNCONDITIONAL here: this removes EVERY v1 row, so no
      // session survives whose key could be destroyed, and a conditional delete
      // would strand the slot whenever it was bound to a stale row.
      const dropped = await deleteV1Sessions(keysToRemove, { dropSlot: true });
      if (dropped > 0) {
        console.warn(
          'Dropped queued v1 requests for an unrestorable session:',
          dropped
        );
      }
    } catch (error) {
      console.error(
        'Failed to drop unrestorable v1 session:',
        redactError(error)
      );
    }
  }

  private async loadV1Sessions(): Promise<void> {
    try {
      // Skip v1 session restoration in extension mode - WebSocket connections can be problematic
      // and old sessions shouldn't persist across extension reloads
      const isExtension =
        Platform.OS === 'web' && detectPlatform() === 'extension';
      if (isExtension) {
        console.log('Skipping v1 session restoration in extension mode');
        // Clean up any stale v1 sessions in extension mode
        const allKeys = await AsyncStorage.getAllKeys();
        const v1SessionKeys = allKeys.filter((key) =>
          key.startsWith(WC_V1_SESSION_STORAGE_KEY)
        );
        if (v1SessionKeys.length > 0) {
          await deleteV1Sessions(v1SessionKeys, { dropSlot: true });
          console.log('Cleared stale v1 sessions in extension mode');
        } else {
          await deleteV1Sessions([], { dropSlot: true });
        }
        return;
      }

      const v1Client = WalletConnectV1Client.getInstance();

      // Get all keys that start with v1 session prefix
      const allKeys = await AsyncStorage.getAllKeys();
      const v1SessionKeys = allKeys.filter((key) =>
        key.startsWith(WC_V1_SESSION_STORAGE_KEY)
      );

      if (v1SessionKeys.length === 0) {
        return;
      }

      const sessions = (
        await Promise.all(
          v1SessionKeys.map(async (key) => {
            const raw = await AsyncStorage.getItem(key);
            if (!raw) {
              return null;
            }

            try {
              const parsed: unknown = JSON.parse(raw);

              // Must be a non-null OBJECT. `JSON.parse('null')` and a bare
              // string/array all parse fine, then throw on the first property
              // access downstream — and that throw happens inside the filter
              // below, which would abort ALL v1 restoration over one corrupt
              // row. Treat a wrong shape exactly like unparseable: delete it.
              if (
                typeof parsed !== 'object' ||
                parsed === null ||
                Array.isArray(parsed)
              ) {
                throw new Error('v1 session entry is not an object');
              }

              // Must also carry the metadata a reconnect actually needs. A
              // shape-valid but INCOMPLETE row (say `{connected:true,
              // updatedAt:<now>}`) would otherwise win the freshest-wins
              // selection below, have no key, and take dropV1Session's
              // delete-everything path down on top of a perfectly good session.
              // Reject it here so it is deleted alone and never competes.
              const candidate = parsed as WalletConnectV1LegacyPersistedSession;
              if (!isRestorableV1Session(candidate)) {
                throw new Error('v1 session entry is missing required fields');
              }

              return { key, session: candidate };
            } catch (error) {
              // A row we cannot parse can never restore a session, but it CAN
              // still contain a valid inline key from before PLAN-260 — and
              // being skipped, it would escape both the migration and the
              // stale-row prune, leaving that key in AsyncStorage forever.
              // Delete it outright: there is nothing recoverable to lose.
              console.warn(
                'Deleting unusable v1 session entry',
                redactSensitiveForLog(key),
                redactError(error)
              );
              // Central cleanup: metadata AND queued requests. This path
              // bypasses dropV1Session entirely — and when EVERY row is
              // invalid, dropV1Session never runs at all.
              await deleteV1Session(topicFromStorageKey(key));
              return null;
            }
          })
        )
      ).filter(Boolean) as {
        key: string;
        session: WalletConnectV1LegacyPersistedSession;
      }[];

      if (sessions.length === 0) {
        return;
      }

      let candidates = sessions.filter(({ session }) => session.connected);
      if (candidates.length === 0) {
        candidates = sessions;
      }

      const sortedCandidates = candidates.sort((a, b) => {
        const aTime = a.session.updatedAt ?? 0;
        const bTime = b.session.updatedAt ?? 0;

        if (aTime === bTime) {
          return v1SessionKeys.indexOf(a.key) - v1SessionKeys.indexOf(b.key);
        }

        return bTime - aTime;
      });

      const latestEntry = sortedCandidates[0];

      if (!latestEntry) {
        return;
      }

      const { session } = latestEntry;

      // Extract topic from storage key
      const topic = latestEntry.key.replace(
        `${WC_V1_SESSION_STORAGE_KEY}:`,
        ''
      );

      // Resolve the session key for the SELECTED session only (DR-7). This is a
      // selected-session transaction, not a generic migrate-and-delete: the
      // AsyncStorage row must SURVIVE minus its key, because it carries the
      // routing metadata reconnection needs.
      let sessionKey: string | null = null;
      try {
        sessionKey = await readSessionKey(topic);
      } catch {
        // Android keystore desync (platform/mobile/secureStorage.ts): the guard
        // throws when a recorded item is present but unreadable. A bridge
        // transport key is cheap to re-establish and there is nothing to
        // recover, so drop the session and force a re-pair rather than letting
        // this escape into app startup (DR-4).
        console.error('Dropping v1 session: session key unreadable');
        await this.dropV1Session(latestEntry.key, topic, sessions);
        return;
      }

      // Two DIFFERENT questions, deliberately not conflated:
      //   hasInlineKey — is there a `key` property on the row that must be
      //     drained? True even for a malformed value: a corrupt or truncated
      //     key is still key-shaped material sitting in AsyncStorage, and
      //     leaving it there because it failed validation would be absurd.
      //   seedableKey  — is that value good enough to seed secure storage and
      //     restore the session with?
      const hasInlineKey =
        session.key !== undefined && session.key !== null && session.key !== '';
      const seedableKey = isValidV1SessionKey(session.key) ? session.key : null;

      // Whether the SECURE slot is confirmed to hold this topic's key. The
      // inline key may only be stripped when this is true — see below.
      let secureKeyConfirmed = sessionKey !== null;

      if (!sessionKey && seedableKey) {
        // Legacy row still carrying the key inline: copy it into secure storage.
        try {
          await writeSessionKey(topic, seedableKey);
          sessionKey = seedableKey;
          secureKeyConfirmed = true;
        } catch {
          // ACCEPTED RESIDUAL. Could not write secure storage at all, so the
          // inline key is the only copy and REMAINS AT REST in AsyncStorage
          // until a later boot succeeds. Deliberate: the row is intact and
          // carries a usable key, so the session is fully recoverable, and
          // dropping it would destroy a working session because secure storage
          // hiccupped. This is the pre-migration status quo, not a new leak.
          console.error('Failed to write v1 session key to secure storage');
          sessionKey = seedableKey;
        }
      }

      if (!sessionKey) {
        // No secure key and no usable legacy key: unusable (a topic mismatch, a
        // malformed envelope, or a row that was left keyless). Restore nothing
        // and surface no error — the user re-pairs.
        await this.dropV1Session(latestEntry.key, topic, sessions);
        return;
      }

      // Strip the inline key whenever the row still carries one AND the secure
      // copy is confirmed present. Both halves of that condition are load-bearing.
      //
      // Not "did we just migrate?": if a previous boot wrote the secure slot and
      // died before rewriting the row, this boot's `readSessionKey` SUCCEEDS and
      // the migration branch above is skipped — a strip conditional on migrating
      // would leave the key in AsyncStorage forever, defeating the entire point.
      //
      // But not unconditional either: if the secure write FAILED just above, the
      // inline key is the only copy left. Stripping it would leave the next boot
      // with keyless metadata and no secure key, and the session — which was
      // perfectly recoverable — would be dropped. Destroying a working session
      // to tidy up storage is the worse failure.
      //
      // Keyed on hasInlineKey, not seedableKey: a MALFORMED inline key must be
      // drained too. It cannot seed secure storage, but it is still key-shaped
      // material at rest, and skipping it because it failed validation would
      // leave it in AsyncStorage forever.
      if (hasInlineKey && secureKeyConfirmed) {
        try {
          const { key: _dropped, ...keyless } = session;
          await AsyncStorage.setItem(latestEntry.key, JSON.stringify(keyless));
        } catch {
          // ACCEPTED RESIDUAL: the key remains at rest in AsyncStorage until a
          // later boot succeeds in rewriting the row. There is no better move —
          // the secure copy is already written and the session is usable, and
          // the only way to remove the key right now would be to delete the row
          // outright, which would destroy the routing metadata and the session
          // with it. Retrying beats trading a working session for tidy storage.
          // Deliberately NOT rolled back: the prior slot may belong to a
          // different topic, so restoring it would break THIS session too.
          console.error('Failed to strip inline v1 session key from storage');
        }
      }

      // Prune the OTHER rows only after the selected session is safely
      // migrated, so a failure above cannot destroy a row we might still want.
      const staleKeys = sessions
        .map(({ key }) => key)
        .filter((key) => key !== latestEntry.key);

      if (staleKeys.length > 0) {
        // Central cleanup so the pruned rows' queued requests go too. dropSlot
        // is FALSE: the selected session survives and its key must not be
        // touched — deleteV1Sessions only reaps queues and metadata here.
        await deleteV1Sessions(staleKeys, { dropSlot: false });
      }

      await v1Client.connect({
        topic,
        version: '1',
        bridge: session.bridge,
        key: sessionKey,
      });

      // Set up call_request listener on DeepLinkService
      // This ensures navigation works the same way as during initial URI connection
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- breaks a REAL require cycle: @/services/deeplink imports this module, so a static import here would form a load-time circular dependency. (Contrast :463, whose "avoid circular dependencies" note is stale — WalletConnectV1Client is already statically imported at line 36.)
      const DeepLinkService = require('@/services/deeplink').DeepLinkService;
      const deepLinkService = DeepLinkService.getInstance();

      v1Client.on('call_request', (callRequest) => {
        // Transform v1 call_request format to match v2 format
        const sessionData = v1Client.getSessionData();
        const transformedRequest = {
          id: callRequest.id,
          topic: sessionData?.handshakeTopic || topic,
          params: {
            request: {
              method: callRequest.method,
              params: [callRequest.params],
            },
            chainId: sessionData?.chainId || 416001,
          },
        };

        // Emit through both WalletConnectService (for potential listeners)
        // AND directly navigate using DeepLinkService
        this.emit('session_request', transformedRequest);

        // Navigate to transaction request screen directly
        deepLinkService['navigateToRoute']({
          screen: 'WalletConnectTransactionRequest',
          params: {
            requestEvent: transformedRequest,
            version: 1,
          },
        });
      });
    } catch (error) {
      console.error('Failed to load v1 sessions:', redactError(error));
      // Don't throw - v1 session restoration failure shouldn't block app startup
    }
  }

  private setupEventHandlers(): void {
    // These will be set up once the client is initialized
    this.on('client_ready', () => {
      this.setupEventHandlersDirectly();
    });
  }

  private setupEventHandlersDirectly(): void {
    const provider = this.client.getProvider();
    const signClient = provider.client;

    signClient.on('session_proposal', this.onSessionProposal.bind(this));
    signClient.on('session_request', this.onSessionRequest.bind(this));
    signClient.on('session_update', this.onSessionUpdate.bind(this));
    signClient.on('session_delete', this.onSessionDelete.bind(this));
    signClient.on('session_expire', this.onSessionExpire.bind(this));
  }

  async pair(uri: string): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      await signClient.pair({ uri });
    } catch (error) {
      throw new Error(
        `Pairing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async approveSession(
    proposal: SessionProposal,
    selectedAccounts?: AccountMetadata[]
  ): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      // Use selected accounts if provided, otherwise fall back to all signable accounts
      const accounts =
        selectedAccounts && selectedAccounts.length > 0
          ? selectedAccounts
          : await this.getSignableAccounts();

      if (accounts.length === 0) {
        throw new Error('No signable accounts available');
      }

      // Config-gated chain policy (HT-249). Read the experimental flag from the
      // store directly — this is non-React service code, so use getState().
      // Default is OFF, which gives typical users the strict per-chain policy.
      const allowUnsupportedNetworks =
        useExperimentalStore.getState().allowUnsupportedNetworks;

      // Decide which chains to include in the approved namespaces.
      const defaultChains = [
        VOI_CHAIN_DATA.chainId,
        ALGORAND_MAINNET_CHAIN_DATA.chainId,
      ];
      let chainsToInclude: string[];

      if (allowUnsupportedNetworks) {
        // Developer / permissive mode: union ALL requested chains (required +
        // optional), including ones we don't recognize (e.g. a local devnet).
        const allRequestedChains = new Set<string>();

        if (proposal.requiredNamespaces?.algorand?.chains) {
          proposal.requiredNamespaces.algorand.chains.forEach((chain: string) =>
            allRequestedChains.add(chain)
          );
        }

        if (proposal.optionalNamespaces?.algorand?.chains) {
          proposal.optionalNamespaces.algorand.chains.forEach((chain: string) =>
            allRequestedChains.add(chain)
          );
        }

        chainsToInclude =
          allRequestedChains.size > 0
            ? Array.from(allRequestedChains)
            : defaultChains;
      } else {
        // Default / strict mode: a proposal that REQUIRES any chain this wallet
        // does not support is rejected outright — approving it would publish the
        // wallet's addresses as signable on an unrecognized chain. Note this is
        // the "ALL required supported" predicate, not "at least one".
        if (!areAllRequiredChainsSupported(proposal)) {
          // Send the dApp a protocol-level rejection, then surface the failure
          // to the caller (SessionProposalScreen shows the thrown message).
          try {
            await signClient.reject({
              id: proposal.id,
              reason: getSdkError('UNSUPPORTED_CHAINS'),
            });
          } catch (rejectError) {
            console.error(
              'Failed to reject unsupported-chain proposal:',
              redactError(rejectError)
            );
          }
          this.emit('session_rejected', proposal);
          throw new Error(
            'This dApp requires a network this wallet does not support. ' +
              'To connect on an unrecognized network (e.g. a local devnet), ' +
              'enable "Allow unsupported networks" in Experimental Features.'
          );
        }

        // Required chains are all supported: approve only the SUPPORTED chains,
        // dropping any unsupported OPTIONAL chains rather than approving them.
        const supportedRequestedChains = detectRequestedChains(proposal);
        chainsToInclude =
          supportedRequestedChains.length > 0
            ? supportedRequestedChains
            : defaultChains;
      }

      // Format accounts for the chains we are approving.
      const formattedAccounts: string[] = [];
      for (const chainId of chainsToInclude) {
        for (const account of accounts) {
          formattedAccounts.push(
            formatAccountAddress(chainId, account.address)
          );
        }
      }

      // Build supported namespaces from the chains selected above (all requested
      // chains when the flag is ON, supported-only when OFF).
      const supportedNamespaces = {
        algorand: {
          chains: chainsToInclude,
          methods: DEFAULT_NAMESPACES.algorand.methods,
          events: DEFAULT_NAMESPACES.algorand.events,
          accounts: formattedAccounts,
        },
      };

      // Redacted (TASK-33): log chain ids + counts, not full account addresses.
      console.log('[WalletConnect] Proposal namespaces:', {
        requiredChains: proposal.requiredNamespaces?.algorand?.chains ?? [],
        optionalChains: proposal.optionalNamespaces?.algorand?.chains ?? [],
        requiredMethods:
          proposal.requiredNamespaces?.algorand?.methods?.length ?? 0,
        optionalMethods:
          proposal.optionalNamespaces?.algorand?.methods?.length ?? 0,
      });
      console.log('[WalletConnect] Our supported namespaces:', {
        chains: supportedNamespaces.algorand.chains,
        methods: supportedNamespaces.algorand.methods.length,
        accounts: supportedNamespaces.algorand.accounts.length,
      });

      // Use WalletConnect's buildApprovedNamespaces utility
      // This handles all the complex validation logic for us
      const approvedNamespaces = buildApprovedNamespaces({
        proposal: proposal as any, // Type conversion needed for SDK types
        supportedNamespaces,
      });

      console.log('[WalletConnect] Approved namespaces built:', {
        chains: approvedNamespaces.algorand?.chains ?? [],
        accounts: approvedNamespaces.algorand?.accounts?.length ?? 0,
        methods: approvedNamespaces.algorand?.methods?.length ?? 0,
      });

      const session = await signClient.approve({
        id: proposal.id,
        namespaces: approvedNamespaces,
      });

      // Get the complete session data from the client after approval
      // The approve() response might not have all the data populated
      const completeSession = signClient.session.get(session.topic);

      // Store normalized session with the proposer metadata from the original proposal
      const sessionWithMetadata = {
        ...completeSession,
        peerMetadata: proposal.proposer.metadata,
      } as WalletConnectSession;

      this.sanitizeAndCacheSession(sessionWithMetadata);

      this.emit('session_approved', sessionWithMetadata);
      this.emit('sessions_changed');
    } catch (error) {
      console.error('Failed to approve session:', redactError(error));
      throw new Error(
        `Session approval failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async rejectSession(proposal: SessionProposal): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;
      await signClient.reject({
        id: proposal.id,
        reason: getSdkError('USER_REJECTED'),
      });

      this.emit('session_rejected', proposal);
    } catch (error) {
      console.error('Failed to reject session:', redactError(error));
      throw new Error(
        `Session rejection failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async disconnectSession(topic: string): Promise<void> {
    try {
      // Check if this is a v1 session
      const v1Client = WalletConnectV1Client.getInstance();
      const v1SessionData = v1Client.getSessionData();

      if (v1SessionData && v1SessionData.handshakeTopic === topic) {
        // Disconnect v1 session
        await v1Client.disconnect();
        this.emit('session_disconnected', topic);
        this.emit('sessions_changed');
        return;
      }

      // Otherwise, disconnect v2 session
      const provider = this.client.getProvider();
      // UniversalProvider.disconnect() takes no arguments in this SDK version;
      // the topic/reason were already ignored at runtime. Disconnecting closes
      // the provider's active session, and we still remove `topic` from our
      // local bookkeeping below.
      await provider.disconnect();

      this.activeSessions.delete(topic);
      this.emit('session_disconnected', topic);
      this.emit('sessions_changed');
    } catch (error) {
      console.error('Failed to disconnect session:', redactError(error));
      throw new Error(
        `Session disconnect failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  getActiveSessions(): WalletConnectSession[] {
    const v2Sessions = Array.from(this.activeSessions.values());
    const v1Sessions = this.getV1Sessions();
    return [...v2Sessions, ...v1Sessions];
  }

  private getV1Sessions(): WalletConnectSession[] {
    try {
      const v1Client = WalletConnectV1Client.getInstance();
      const v1SessionData = v1Client.getSessionData();

      if (!v1SessionData || !v1SessionData.connected) {
        return [];
      }

      // v1 peer/client metadata permits a null description, but the display
      // session type requires a string; `normalizeV1Metadata` coerces null ->
      // '' at the boundary (and returns the fallback when metadata is absent).
      // This null-safety gap was previously masked by the removed
      // `require('@/services/walletconnect/v1')` resolving to `any`.
      // Convert v1 session format to v2 session format for display
      const v1Session: WalletConnectSession = {
        topic: v1SessionData.handshakeTopic,
        peerMetadata: normalizeV1Metadata(v1SessionData.peerMeta, {
          name: 'Unknown dApp',
          description: '',
          url: '',
          icons: [],
        }),
        namespaces: {
          algorand: {
            accounts: v1SessionData.accounts.map(
              (addr: string) => `algorand:${v1SessionData.chainId}:${addr}`
            ),
            methods: ['algo_signTxn'],
            events: [],
            chains: [`algorand:${v1SessionData.chainId}`],
          },
        },
        expiry: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days from now
        acknowledged: true,
        controller: v1SessionData.clientId,
        self: {
          publicKey: v1SessionData.clientId,
          metadata: normalizeV1Metadata(v1SessionData.clientMeta, {
            name: 'Voi Wallet',
            description: 'Mobile wallet for Voi Network',
            url: 'https://getvoi.app',
            icons: [
              'https://getvoi.app/android-chrome-192x192.png',
              'https://getvoi.app/android-chrome-512x512.png',
            ],
          }),
        },
        peer: {
          publicKey: v1SessionData.peerId,
          metadata: normalizeV1Metadata(v1SessionData.peerMeta, {
            name: 'Unknown dApp',
            description: '',
            url: '',
            icons: [],
          }),
        },
      };

      return [v1Session];
    } catch (error) {
      console.error('Failed to get v1 sessions:', redactError(error));
      return [];
    }
  }

  getSession(topic: string): WalletConnectSession | undefined {
    return this.activeSessions.get(topic);
  }

  /**
   * DR-5 / DR-14 — the CAIP-10 accounts a LIVE session approved for one
   * specific chain, used to bind signing to the session that asked.
   *
   * Authorization is chain-scoped, not topic-wide: a session can approve
   * address A on Voi but not on Algorand, so the full
   * `algorand:<chain>:<address>` strings are returned and callers must compare
   * whole strings rather than reducing to a bare address set.
   *
   * Returns an EMPTY array when the session is absent, expired, disconnected,
   * topic-mismatched, or simply approved nothing on `chainId`. Callers must
   * treat empty as a rejection — the wallet's local accounts are never
   * substituted for the session's.
   */
  getApprovedAccountsForChain(topic: string, chainId: string): string[] {
    if (!topic || !chainId) {
      return [];
    }

    try {
      // v1 first: it keeps a single session whose accounts were retained at
      // approval time. Its numeric chain id must resolve to the SAME CAIP-2
      // chain the caller is asking about (DR-11), otherwise it authorizes
      // nothing here.
      const v1SessionData =
        WalletConnectV1Client.getInstance().getSessionData();
      if (
        v1SessionData &&
        v1SessionData.connected &&
        v1SessionData.handshakeTopic === topic
      ) {
        const resolved = resolveV1Chain(v1SessionData.chainId);
        if (!resolved || resolved.chainId !== chainId) {
          return [];
        }
        return v1SessionData.accounts.map((address) =>
          formatAccountAddress(chainId, address)
        );
      }

      const session = this.activeSessions.get(topic);
      if (!session || isSessionExpired(session)) {
        return [];
      }

      const accounts = session.namespaces?.algorand?.accounts ?? [];
      return accounts.filter((caipAccount) => {
        const parsed = parseAccountAddress(caipAccount);
        return parsed?.chainId === chainId;
      });
    } catch (error) {
      console.error(
        'Failed to resolve session-approved accounts:',
        redactError(error)
      );
      return [];
    }
  }

  async getSignableAccounts(): Promise<AccountMetadata[]> {
    const allAccounts = await MultiAccountWalletService.getAllAccounts();
    return getSignableAccounts(allAccounts);
  }

  async signTransactions(
    transactions: WalletTransaction[],
    accountAddress: string,
    pin: string
  ): Promise<string[]> {
    try {
      const signedTxns: string[] = [];

      for (const wtxn of transactions) {
        if (!validateAlgorandTransaction(wtxn)) {
          throw new Error('Invalid transaction format');
        }

        // Decode the transaction
        const txnBytes = Buffer.from(wtxn.txn, 'base64');
        const txn = algosdk.decodeUnsignedTransaction(txnBytes);

        // Determine the signer
        let signerAddress = accountAddress;
        if (wtxn.signers && wtxn.signers.length > 0 && wtxn.signers[0]) {
          signerAddress = wtxn.signers[0];
        }

        // Handle auth address for rekeyed accounts
        if (wtxn.authAddr) {
          // Verify we can sign for this auth address
          const signerAccount = await this.findAccountByAddress(wtxn.authAddr);
          if (!signerAccount || signerAccount.type !== AccountType.STANDARD) {
            throw new Error(`Cannot sign with auth address: ${wtxn.authAddr}`);
          }
          signerAddress = wtxn.authAddr;
        }

        // Sign the transaction
        const signedTxnBlob = await SecureKeyManager.signTransaction(
          txn,
          signerAddress,
          pin
        );
        signedTxns.push(Buffer.from(signedTxnBlob).toString('base64'));
      }

      return signedTxns;
    } catch (error) {
      // Redact any full address (e.g. the rekey auth-address) from the log; the
      // re-thrown error below preserves the full message for the caller/UX.
      console.error('Failed to sign transactions:', redactError(error));
      throw new Error(
        `Transaction signing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async respondToRequest(
    topic: string,
    id: number,
    result: any
  ): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      await signClient.respond({
        topic,
        response: {
          id,
          jsonrpc: '2.0',
          result,
        },
      });
    } catch (error) {
      console.error('Failed to respond to request:', redactError(error));
      throw new Error(
        `Request response failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  async rejectRequest(topic: string, id: number, error: any): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      await signClient.respond({
        topic,
        response: {
          id,
          jsonrpc: '2.0',
          error: {
            code: error.code || 5001,
            message: error.message || 'User rejected the request',
          },
        },
      });
    } catch (err) {
      console.error('Failed to reject request:', redactError(err));
      throw new Error(
        `Request rejection failed: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }
  }

  private async findAccountByAddress(
    address: string
  ): Promise<AccountMetadata | null> {
    const accounts = await MultiAccountWalletService.getAllAccounts();
    return accounts.find((acc) => acc.address === address) || null;
  }

  private async loadExistingSessions(): Promise<void> {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;

      // Use the client's session manager to get all sessions
      const sessions = signClient.session.getAll();

      for (const session of sessions) {
        if (!isSessionExpired(session as unknown as WalletConnectSession)) {
          this.sanitizeAndCacheSession(
            session as unknown as WalletConnectSession
          );
        } else {
          // Clean up expired session
          await this.disconnectSession(session.topic).catch(() => {
            // Ignore errors when cleaning up expired sessions
          });
        }
      }
    } catch (error) {
      console.error('Failed to load existing sessions:', redactError(error));
    }
  }

  private onSessionProposal(
    event: SignClientTypes.EventArguments['session_proposal']
  ): void {
    const proposal: SessionProposal = {
      id: event.id,
      pairingTopic: event.params.pairingTopic,
      proposer: {
        publicKey: event.params.proposer.publicKey,
        metadata: sanitizeMetadata(event.params.proposer.metadata),
      },
      requiredNamespaces: event.params.requiredNamespaces,
      optionalNamespaces: event.params.optionalNamespaces,
      sessionProperties: event.params.sessionProperties,
      expiryTimestamp: event.params.expiryTimestamp,
    };

    this.emit('session_proposal', proposal);
  }

  private onSessionRequest(
    event: SignClientTypes.EventArguments['session_request']
  ): void {
    const requestEvent: WalletConnectRequestEvent = {
      id: event.id,
      topic: event.topic,
      params: {
        request: event.params.request,
        chainId: event.params.chainId,
      },
    };

    this.emit('session_request', requestEvent);
  }

  private onSessionDelete(
    event: SignClientTypes.EventArguments['session_delete']
  ): void {
    this.activeSessions.delete(event.topic);
    this.emit('session_deleted', event);
    this.emit('sessions_changed');
  }

  private onSessionExpire(
    event: SignClientTypes.EventArguments['session_expire']
  ): void {
    this.activeSessions.delete(event.topic);
    this.emit('session_expired', event);
    this.emit('sessions_changed');
  }

  private onSessionUpdate(
    event: SignClientTypes.EventArguments['session_update']
  ): void {
    try {
      const provider = this.client.getProvider();
      const signClient = provider.client;
      const updated = signClient.session.get(event.topic);
      if (updated) {
        this.sanitizeAndCacheSession(
          updated as unknown as WalletConnectSession
        );
        this.emit('session_updated', updated);
        this.emit('sessions_changed');
      }
    } catch (e) {
      console.warn('Failed to handle session_update:', redactError(e));
    }
  }

  private sanitizeAndCacheSession(session: WalletConnectSession): void {
    // Try multiple ways to get peer metadata, prioritizing already set peerMetadata
    const peer =
      session.peerMetadata ||
      (session as any).peer?.metadata ||
      (session as any).peerMetadata ||
      {};

    const normalized = {
      ...session,
      peerMetadata: sanitizeMetadata(peer),
    } as WalletConnectSession;
    this.activeSessions.set(session.topic, normalized);
  }
}

export * from './types';
export * from './config';
export * from './utils';
