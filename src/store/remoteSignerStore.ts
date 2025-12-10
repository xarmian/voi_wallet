import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  AppMode,
  SignerDeviceConfig,
  SignerDeviceInfo,
  RemoteSignerRequest,
  RemoteSignerResponse,
  SigningProgress,
  ProcessedRequestTracker,
  REMOTE_SIGNER_CONSTANTS,
} from '../types/remoteSigner';

// Storage keys
const STORAGE_KEYS = {
  APP_MODE: '@voi_remote_signer_mode',
  SIGNER_CONFIG: '@voi_signer_config',
  PAIRED_SIGNERS: '@voi_paired_signers',
  PROCESSED_REQUESTS: '@voi_processed_requests',
} as const;

/**
 * Generate a unique device ID for this signer device
 */
function generateDeviceId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).substring(2, 10);
  return `voi-signer-${timestamp}-${randomPart}`;
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
  /** Pending signature requests waiting for response */
  pendingSignatureRequests: Map<string, {
    request: RemoteSignerRequest;
    createdAt: number;
    onComplete?: (response: RemoteSignerResponse) => void;
  }>;

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
  validateRequest: (request: RemoteSignerRequest) => { valid: boolean; error?: string };
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
  /** Create a pending signature request */
  createPendingSignatureRequest: (
    request: RemoteSignerRequest,
    onComplete?: (response: RemoteSignerResponse) => void
  ) => void;
  /** Complete a pending signature request */
  completePendingSignatureRequest: (requestId: string, response: RemoteSignerResponse) => void;
  /** Cancel a pending signature request */
  cancelPendingSignatureRequest: (requestId: string) => void;
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
    pendingSignatureRequests: new Map(),

    // ============ Initialization ============
    initialize: async () => {
      try {
        // Load app mode
        const storedMode = await AsyncStorage.getItem(STORAGE_KEYS.APP_MODE);
        const appMode: AppMode = storedMode === 'signer' ? 'signer' : 'wallet';

        // Load signer config (if exists)
        const storedConfig = await AsyncStorage.getItem(STORAGE_KEYS.SIGNER_CONFIG);
        const signerConfig: SignerDeviceConfig | null = storedConfig
          ? JSON.parse(storedConfig)
          : null;

        // Load paired signers
        const storedSigners = await AsyncStorage.getItem(STORAGE_KEYS.PAIRED_SIGNERS);
        const pairedSigners = new Map<string, SignerDeviceInfo>(
          storedSigners ? JSON.parse(storedSigners) : []
        );

        // Load processed requests (for replay prevention in signer mode)
        const storedProcessed = await AsyncStorage.getItem(STORAGE_KEYS.PROCESSED_REQUESTS);
        const processedRequestIds = new Set<string>(
          storedProcessed ? JSON.parse(storedProcessed) : []
        );

        set({
          appMode,
          signerConfig,
          pairedSigners,
          processedRequestIds,
          isInitialized: true,
        });

        // Clean up old processed requests
        get().cleanupProcessedRequests();
      } catch (error) {
        console.error('[RemoteSignerStore] Failed to initialize:', error);
        set({ isInitialized: true });
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

        await AsyncStorage.setItem(STORAGE_KEYS.SIGNER_CONFIG, JSON.stringify(config));
        set({ signerConfig: config });
        console.log('[RemoteSignerStore] Signer config initialized:', config.deviceId);
      } catch (error) {
        console.error('[RemoteSignerStore] Failed to initialize signer config:', error);
        throw error;
      }
    },

    updateSignerDeviceName: async (name: string) => {
      const { signerConfig } = get();
      if (!signerConfig) {
        throw new Error('Signer config not initialized');
      }

      const updated = { ...signerConfig, deviceName: name };
      await AsyncStorage.setItem(STORAGE_KEYS.SIGNER_CONFIG, JSON.stringify(updated));
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
      set({
        signingProgress: { ...signingProgress, ...progress },
      });
    },

    markRequestProcessed: (requestId: string) => {
      const { processedRequestIds } = get();
      const updated = new Set(processedRequestIds);
      updated.add(requestId);
      set({ processedRequestIds: updated });

      // Persist asynchronously
      AsyncStorage.setItem(
        STORAGE_KEYS.PROCESSED_REQUESTS,
        JSON.stringify(Array.from(updated))
      ).catch((err) =>
        console.warn('[RemoteSignerStore] Failed to persist processed requests:', err)
      );
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
      console.log('[RemoteSignerStore] Cleanup processed requests (not implemented yet)');
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

    createPendingSignatureRequest: (request, onComplete) => {
      const { pendingSignatureRequests } = get();
      const updated = new Map(pendingSignatureRequests);
      updated.set(request.id, {
        request,
        createdAt: Date.now(),
        onComplete,
      });
      set({ pendingSignatureRequests: updated });
    },

    completePendingSignatureRequest: (requestId: string, response: RemoteSignerResponse) => {
      const { pendingSignatureRequests, updateSignerActivity, pairedSigners } = get();
      const pending = pendingSignatureRequests.get(requestId);

      if (pending) {
        // Call the completion callback if provided
        pending.onComplete?.(response);

        // Update signer activity based on the transaction signer addresses
        // Find which signer device handled this request
        const entries = Array.from(pairedSigners.entries());
        for (const [deviceId, signerInfo] of entries) {
          const signerAddresses = new Set(signerInfo.addresses);
          const requestAddresses = pending.request.txns.map((t) => t.s);
          const hasMatch = requestAddresses.some((addr) => signerAddresses.has(addr));

          if (hasMatch) {
            updateSignerActivity(deviceId);
            break;
          }
        }

        // Remove from pending
        const updated = new Map(pendingSignatureRequests);
        updated.delete(requestId);
        set({ pendingSignatureRequests: updated });
      }
    },

    cancelPendingSignatureRequest: (requestId: string) => {
      const { pendingSignatureRequests } = get();
      const updated = new Map(pendingSignatureRequests);
      updated.delete(requestId);
      set({ pendingSignatureRequests: updated });
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
