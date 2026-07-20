import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCrypto } from '@/platform';
import {
  AppMode,
  SignerDeviceConfig,
  SignerDeviceInfo,
  RemoteSignerRequest,
  SigningProgress,
  REMOTE_SIGNER_CONSTANTS,
} from '../types/remoteSigner';

// Storage keys
const STORAGE_KEYS = {
  APP_MODE: '@voi_remote_signer_mode',
  SIGNER_CONFIG: '@voi_signer_config',
  PAIRED_SIGNERS: '@voi_paired_signers',
  PROCESSED_REQUESTS: '@voi_processed_requests',
} as const;

// Module-level promise for early mode detection (before store hydration)
let appModePromise: Promise<AppMode> | null = null;

// Coalescer for the remote-signer store initialize(): a single shared in-flight
// promise so overlapping initialize() calls dedupe into ONE hydration pass. With
// F-03 the store is kicked off early from AppNavigator's mount effect AND from
// the MainTabNavigator / HomeScreen / RemoteSignerSettings mount effects; without
// this guard those concurrent calls would each run a full read+set pass. Reset on
// settle (see the finally below), so a later explicit initialize() still
// re-hydrates. Module-level (not a store field) so it survives the store's own
// state resets.
let remoteSignerInitializationPromise: Promise<void> | null = null;

// Bounded retry for the replay-guard persistence so a transient native write
// failure (e.g. momentary disk pressure) does not silently drop a processed id.
const PROCESSED_PERSIST_MAX_ATTEMPTS = 3;

// Serialized persistence chain for the processed-request-id set. ALL durable
// writes of PROCESSED_REQUESTS go through this single chain so they can never
// interleave — an out-of-order landing can no longer let an older/smaller set
// clobber a newer one (replay after restart). Each queued task writes the
// LATEST full set (read at execution time, so a delayed write still persists
// every id) and NEVER rejects the chain: it swallows a final, retry-exhausted
// failure so a single bad write cannot stall every later persist.
let processedPersistChain: Promise<void> = Promise.resolve();

async function writeProcessedIds(ids: string[]): Promise<void> {
  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= PROCESSED_PERSIST_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await AsyncStorage.setItem(
        STORAGE_KEYS.PROCESSED_REQUESTS,
        JSON.stringify(ids)
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  // Retry-exhausted: the in-memory guard still blocks in-session replays, but
  // cross-restart durability is lost for this id (accepted residual — a full
  // guarantee would require awaiting the write before releasing the signature).
  console.warn(
    '[RemoteSignerStore] Failed to persist processed requests after retries:',
    lastError
  );
}

function enqueueProcessedPersist(getIds: () => Set<string>): void {
  processedPersistChain = processedPersistChain
    // Recover before chaining so a prior failure can never block later writes.
    .catch(() => {})
    .then(() => writeProcessedIds(Array.from(getIds())));
}

/**
 * TEST-ONLY: DRAIN the module-level persistence chain (await any queued/in-flight
 * write to completion) and reset it to a settled promise, so a pending write from
 * a previous test cannot still run — and mutate storage — during the next one.
 * Awaiting is required: merely reassigning the module variable would leave an
 * already-queued task running against its live getIds() callback. Not part of the
 * runtime API. (All tests release any deferred write before ending, so this never
 * hangs.)
 */
export async function __drainProcessedPersistChainForTests(): Promise<void> {
  const pending = processedPersistChain;
  processedPersistChain = Promise.resolve();
  await pending.catch(() => {});
}

/**
 * Get app mode early, before store hydration completes.
 * Used by AppNavigator to determine which services to initialize.
 * This avoids a race condition where services start before the store is ready.
 */
export async function getAppModeEarly(): Promise<AppMode> {
  if (appModePromise) return appModePromise;

  appModePromise = AsyncStorage.getItem(STORAGE_KEYS.APP_MODE)
    .then((value) => (value === 'signer' ? 'signer' : 'wallet') as AppMode)
    .catch(() => 'wallet' as AppMode);

  return appModePromise;
}

/**
 * Generate a unique device ID for this signer device.
 *
 * Uses a CSPRNG (`getCrypto().randomUUID()`) rather than `Math.random`, which
 * is not cryptographically secure and could produce predictable/colliding ids
 * (threat T2). The `dev` id is additionally authenticated inside each v2
 * pairing signature. Existing persisted ids are NOT regenerated (that would
 * break existing pairings) — this only runs when a fresh signer config is
 * created (`initializeSignerConfig`).
 */
function generateDeviceId(): string {
  return `voi-signer-${getCrypto().randomUUID()}`;
}

/**
 * Remote Signer Store State
 */
interface RemoteSignerState {
  // ============ Mode State ============
  /** Current app mode (wallet or signer) */
  appMode: AppMode;
  /** Whether the store has been initialized */
  isInitialized: boolean;

  // ============ Signer Mode State ============
  /** Configuration for this device when in signer mode */
  signerConfig: SignerDeviceConfig | null;
  /** Current pending signing request */
  pendingRequest: RemoteSignerRequest | null;
  /** Signing progress state */
  signingProgress: SigningProgress;
  /** Tracker for processed request IDs (replay prevention) */
  processedRequestIds: Set<string>;

  // ============ Wallet Mode State ============
  /** Map of paired signer devices (deviceId -> info) */
  pairedSigners: Map<string, SignerDeviceInfo>;

  // ============ Actions ============
  /** Initialize the store from persisted storage */
  initialize: () => Promise<void>;

  /** Switch app mode (wallet <-> signer) */
  setAppMode: (mode: AppMode) => Promise<void>;

  // Signer mode actions
  /** Initialize signer device configuration */
  initializeSignerConfig: (deviceName: string) => Promise<void>;
  /** Update signer device name */
  updateSignerDeviceName: (name: string) => Promise<void>;
  /** Set a pending signing request */
  setPendingRequest: (request: RemoteSignerRequest | null) => void;
  /** Update signing progress */
  setSigningProgress: (progress: Partial<SigningProgress>) => void;
  /** Mark a request as processed (for replay prevention) */
  markRequestProcessed: (requestId: string) => void;
  /** Check if a request has been processed */
  isRequestProcessed: (requestId: string) => boolean;
  /** Check if a request is valid (not expired, not duplicate) */
  validateRequest: (request: RemoteSignerRequest) => {
    valid: boolean;
    error?: string;
  };
  /** Clean up old processed request IDs */
  cleanupProcessedRequests: () => void;

  // Wallet mode actions
  /** Add a paired signer device */
  addPairedSigner: (info: SignerDeviceInfo) => Promise<void>;
  /** Remove a paired signer device */
  removePairedSigner: (deviceId: string) => Promise<void>;
  /** Update last activity for a signer */
  updateSignerActivity: (deviceId: string) => Promise<void>;
  /** Get signer info by device ID */
  getSignerInfo: (deviceId: string) => SignerDeviceInfo | undefined;
}

/**
 * Create initial signing progress state
 */
const createInitialSigningProgress = (): SigningProgress => ({
  currentIndex: 0,
  totalTransactions: 0,
  status: 'idle',
});

/**
 * Remote Signer Store
 *
 * Manages state for both signer mode (air-gapped device) and wallet mode (online device).
 */
export const useRemoteSignerStore = create<RemoteSignerState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    appMode: 'wallet',
    isInitialized: false,
    signerConfig: null,
    pendingRequest: null,
    signingProgress: createInitialSigningProgress(),
    processedRequestIds: new Set(),
    pairedSigners: new Map(),

    // ============ Initialization ============
    initialize: async () => {
      // Coalesce concurrent initialize() calls into a single hydration pass (see
      // the remoteSignerInitializationPromise comment above). Share the in-flight
      // promise instead of starting a second full read+set pass.
      if (remoteSignerInitializationPromise) {
        return remoteSignerInitializationPromise;
      }

      let resolveInitialization: () => void = () => {};
      remoteSignerInitializationPromise = new Promise<void>((resolve) => {
        resolveInitialization = resolve;
      });

      try {
        // Batch the independent cold-boot reads (F-03). APP_MODE reuses the
        // promise getAppModeEarly() already cached at startup — AppNavigator
        // awaits it before this store can mount — instead of re-reading the same
        // key. The remaining three keys are mutually independent, so they load
        // concurrently rather than in a 4-deep serial await chain.
        const [appMode, storedConfig, storedSigners, storedProcessed] =
          await Promise.all([
            getAppModeEarly(),
            AsyncStorage.getItem(STORAGE_KEYS.SIGNER_CONFIG),
            AsyncStorage.getItem(STORAGE_KEYS.PAIRED_SIGNERS),
            AsyncStorage.getItem(STORAGE_KEYS.PROCESSED_REQUESTS),
          ]);

        // Parse signer config (if exists)
        const signerConfig: SignerDeviceConfig | null = storedConfig
          ? JSON.parse(storedConfig)
          : null;

        // Parse paired signers
        const pairedSigners = new Map<string, SignerDeviceInfo>(
          storedSigners ? JSON.parse(storedSigners) : []
        );

        // Load processed requests (for replay prevention in signer mode). UNION
        // with any ids already in memory rather than replacing: a
        // markRequestProcessed that lands during this async hydration must not
        // be dropped (which would let that id replay). Reading the in-memory set
        // AFTER the awaits above (unchanged from the serial version) is what
        // captures a mark that landed while we were loading. Union keeps both the
        // persisted history and any just-marked id.
        const inMemoryIds = get().processedRequestIds;
        const processedRequestIds = new Set<string>([
          ...inMemoryIds,
          ...(storedProcessed ? (JSON.parse(storedProcessed) as string[]) : []),
        ]);

        set({
          appMode,
          signerConfig,
          pairedSigners,
          processedRequestIds,
          isInitialized: true,
        });

        // If any id was already in memory during this async hydration (a
        // markRequestProcessed that landed mid-load), its queued write may have
        // persisted only a partial set and clobbered the loaded ids on disk.
        // Re-persist the merged union so the DURABLE copy matches memory —
        // otherwise the union heals memory but a later restart could still
        // accept a replay of a clobbered id. Serialized after that write, and a
        // no-op in the common fresh-start case (nothing in memory yet).
        if (inMemoryIds.size > 0) {
          enqueueProcessedPersist(() => get().processedRequestIds);
        }

        // Clean up old processed requests
        get().cleanupProcessedRequests();
      } catch (error) {
        console.error('[RemoteSignerStore] Failed to initialize:', error);
        set({ isInitialized: true });
      } finally {
        // Reset the coalescer on settle so a later explicit initialize()
        // re-hydrates, and resolve the shared promise for any coalesced caller.
        remoteSignerInitializationPromise = null;
        resolveInitialization();
      }
    },

    // ============ Mode Switching ============
    setAppMode: async (mode: AppMode) => {
      try {
        await AsyncStorage.setItem(STORAGE_KEYS.APP_MODE, mode);
        set({ appMode: mode });
        console.log(`[RemoteSignerStore] App mode set to: ${mode}`);
      } catch (error) {
        console.error('[RemoteSignerStore] Failed to set app mode:', error);
        throw error;
      }
    },

    // ============ Signer Mode Actions ============
    initializeSignerConfig: async (deviceName: string) => {
      try {
        const config: SignerDeviceConfig = {
          deviceId: generateDeviceId(),
          deviceName,
          requirePinPerTxn: false,
        };

        await AsyncStorage.setItem(
          STORAGE_KEYS.SIGNER_CONFIG,
          JSON.stringify(config)
        );
        set({ signerConfig: config });
        console.log(
          '[RemoteSignerStore] Signer config initialized:',
          config.deviceId
        );
      } catch (error) {
        console.error(
          '[RemoteSignerStore] Failed to initialize signer config:',
          error
        );
        throw error;
      }
    },

    updateSignerDeviceName: async (name: string) => {
      const { signerConfig } = get();
      if (!signerConfig) {
        throw new Error('Signer config not initialized');
      }

      const updated = { ...signerConfig, deviceName: name };
      await AsyncStorage.setItem(
        STORAGE_KEYS.SIGNER_CONFIG,
        JSON.stringify(updated)
      );
      set({ signerConfig: updated });
    },

    setPendingRequest: (request: RemoteSignerRequest | null) => {
      set({
        pendingRequest: request,
        signingProgress: request
          ? {
              currentIndex: 0,
              totalTransactions: request.txns.length,
              status: 'reviewing',
            }
          : createInitialSigningProgress(),
      });
    },

    setSigningProgress: (progress: Partial<SigningProgress>) => {
      const { signingProgress } = get();
      const merged: SigningProgress = { ...signingProgress, ...progress };
      // Per the SigningProgress contract, `error` is only meaningful while
      // status is 'error'. Drop any stale message once the state leaves 'error'
      // (e.g. error -> signing on recovery), unless this same update set a new
      // error explicitly.
      if (merged.status !== 'error') {
        delete merged.error;
      }
      set({ signingProgress: merged });
    },

    markRequestProcessed: (requestId: string) => {
      const { processedRequestIds } = get();
      const updated = new Set(processedRequestIds);
      updated.add(requestId);
      set({ processedRequestIds: updated });

      // Durability goes through the serialized, retrying persistence chain. The
      // in-memory guard above is already effective for in-session replays; this
      // makes the cross-restart guard robust against out-of-order writes and
      // transient failures. The task reads the LATEST set at write time (not the
      // `updated` snapshot) so a delayed write still persists every id.
      enqueueProcessedPersist(() => get().processedRequestIds);
    },

    isRequestProcessed: (requestId: string) => {
      const { processedRequestIds } = get();
      return processedRequestIds.has(requestId);
    },

    validateRequest: (request: RemoteSignerRequest) => {
      const { isRequestProcessed } = get();

      // Check protocol version
      if (request.v !== REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION) {
        return {
          valid: false,
          error: `Unsupported protocol version: ${request.v}`,
        };
      }

      // Check request type
      if (request.t !== 'req') {
        return {
          valid: false,
          error: 'Invalid payload type - expected signing request',
        };
      }

      // Check timestamp (5 minute expiry)
      const age = Date.now() - request.ts;
      if (age > REMOTE_SIGNER_CONSTANTS.MAX_REQUEST_AGE_MS) {
        return {
          valid: false,
          error: 'Request has expired (older than 5 minutes)',
        };
      }

      // Check for future timestamp (allow 30 seconds of clock skew)
      if (age < -30000) {
        return {
          valid: false,
          error: 'Request timestamp is in the future',
        };
      }

      // Check for duplicate (replay prevention)
      if (isRequestProcessed(request.id)) {
        return {
          valid: false,
          error: 'Request has already been processed',
        };
      }

      // Check for transactions
      if (!request.txns || request.txns.length === 0) {
        return {
          valid: false,
          error: 'No transactions in request',
        };
      }

      return { valid: true };
    },

    cleanupProcessedRequests: () => {
      // This would typically be called periodically
      // For now, we just keep all processed IDs
      // A more sophisticated implementation would track timestamps
      // and remove entries older than CLEANUP_AGE_MS
      console.log(
        '[RemoteSignerStore] Cleanup processed requests (not implemented yet)'
      );
    },

    // ============ Wallet Mode Actions ============
    addPairedSigner: async (info: SignerDeviceInfo) => {
      const { pairedSigners } = get();
      const updated = new Map(pairedSigners);
      updated.set(info.deviceId, info);

      await AsyncStorage.setItem(
        STORAGE_KEYS.PAIRED_SIGNERS,
        JSON.stringify(Array.from(updated.entries()))
      );
      set({ pairedSigners: updated });
      console.log('[RemoteSignerStore] Added paired signer:', info.deviceId);
    },

    removePairedSigner: async (deviceId: string) => {
      const { pairedSigners } = get();
      const updated = new Map(pairedSigners);
      updated.delete(deviceId);

      await AsyncStorage.setItem(
        STORAGE_KEYS.PAIRED_SIGNERS,
        JSON.stringify(Array.from(updated.entries()))
      );
      set({ pairedSigners: updated });
      console.log('[RemoteSignerStore] Removed paired signer:', deviceId);
    },

    updateSignerActivity: async (deviceId: string) => {
      const { pairedSigners } = get();
      const signer = pairedSigners.get(deviceId);
      if (!signer) return;

      const updated = new Map(pairedSigners);
      updated.set(deviceId, { ...signer, lastActivity: Date.now() });

      await AsyncStorage.setItem(
        STORAGE_KEYS.PAIRED_SIGNERS,
        JSON.stringify(Array.from(updated.entries()))
      );
      set({ pairedSigners: updated });
    },

    getSignerInfo: (deviceId: string) => {
      const { pairedSigners } = get();
      return pairedSigners.get(deviceId);
    },
  }))
);

// ============ Selector Hooks ============

/**
 * Get current app mode
 */
export const useAppMode = () => useRemoteSignerStore((state) => state.appMode);

/**
 * Check if in signer mode
 */
export const useIsSignerMode = () =>
  useRemoteSignerStore((state) => state.appMode === 'signer');

/**
 * Get signer device configuration
 */
export const useSignerConfig = () =>
  useRemoteSignerStore((state) => state.signerConfig);

/**
 * Get current pending request (signer mode)
 */
export const usePendingRequest = () =>
  useRemoteSignerStore((state) => state.pendingRequest);

/**
 * Get signing progress (signer mode)
 */
export const useSigningProgress = () =>
  useRemoteSignerStore((state) => state.signingProgress);

/**
 * Get paired signers map
 */
export const usePairedSigners = () =>
  useRemoteSignerStore((state) => state.pairedSigners);

/**
 * Get paired signers as array
 * Uses useShallow to prevent infinite re-renders from creating new arrays
 */
export const usePairedSignersArray = () =>
  useRemoteSignerStore(
    useShallow((state) => Array.from(state.pairedSigners.values()))
  );

/**
 * Check if store is initialized
 */
export const useRemoteSignerInitialized = () =>
  useRemoteSignerStore((state) => state.isInitialized);
