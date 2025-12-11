/**
 * Update Store
 *
 * Zustand store for managing OTA update state.
 * Handles update detection, installation, and dismissal tracking.
 *
 * Works with expo-updates useUpdates() hook - the hook provides update state,
 * this store manages UI state (dismissal, installing progress).
 *
 * Security: Updates are validated against a remote allowlist before being
 * offered to the user. This prevents unauthorized updates from being installed.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import Toast from 'react-native-toast-message';

const DISMISSED_UPDATE_KEY = '@update/dismissedUpdateId';
const VALID_UPDATES_URL = 'https://getvoi.app/valid_app_updates.json';
const VALIDATION_CACHE_KEY = '@update/validationCache';
const VALIDATION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface ValidUpdateEntry {
  id: string;           // Update UUID
  runtimeVersion?: string;
  createdAt?: string;
  description?: string; // Optional: human-readable description
}

interface ValidUpdatesResponse {
  validUpdates: ValidUpdateEntry[];
  // Optionally include a "revokedUpdates" list for updates that should be blocked
  revokedUpdates?: string[];
}

interface ValidationCache {
  data: ValidUpdatesResponse;
  timestamp: number;
}

/**
 * Fetch the list of valid update IDs from the remote server.
 * Includes caching to avoid excessive network requests.
 */
async function fetchValidUpdates(): Promise<ValidUpdatesResponse | null> {
  try {
    // Check cache first
    const cachedJson = await AsyncStorage.getItem(VALIDATION_CACHE_KEY);
    if (cachedJson) {
      const cached: ValidationCache = JSON.parse(cachedJson);
      if (Date.now() - cached.timestamp < VALIDATION_CACHE_TTL) {
        return cached.data;
      }
    }

    // Fetch from server
    const response = await fetch(VALID_UPDATES_URL, {
      headers: {
        'Cache-Control': 'no-cache',
      },
    });

    if (!response.ok) {
      console.warn(`Failed to fetch valid updates: ${response.status}`);
      return null;
    }

    const data: ValidUpdatesResponse = await response.json();

    // Cache the response
    const cache: ValidationCache = {
      data,
      timestamp: Date.now(),
    };
    await AsyncStorage.setItem(VALIDATION_CACHE_KEY, JSON.stringify(cache));

    return data;
  } catch (error) {
    console.warn('Failed to fetch valid updates list:', error);
    return null;
  }
}

/**
 * Validate an update against the remote allowlist.
 * Returns true if the update is valid, false if invalid, null if validation couldn't be performed.
 */
async function validateUpdate(updateId: string): Promise<boolean | null> {
  const validUpdates = await fetchValidUpdates();

  if (!validUpdates) {
    // If we can't fetch the validation list, we can't validate
    // You may want to change this behavior based on your security requirements:
    // - Return null to allow updates when offline (current behavior)
    // - Return false to block all updates when validation fails (more secure)
    return null;
  }

  // Check if update is in the revoked list
  if (validUpdates.revokedUpdates?.includes(updateId)) {
    console.warn(`Update ${updateId} has been revoked`);
    return false;
  }

  // Check if update is in the valid list
  const isValid = validUpdates.validUpdates.some(entry => entry.id === updateId);

  if (!isValid) {
    console.warn(`Update ${updateId} not found in valid updates list`);
  }

  return isValid;
}

interface UpdateState {
  // Update availability (set by component watching useUpdates hook)
  isUpdateAvailable: boolean;
  updateId: string | null;

  // UI state
  isInstalling: boolean;
  isChecking: boolean;
  isValidating: boolean;
  error: string | null;

  // Validation state
  validationStatus: 'pending' | 'valid' | 'invalid' | 'unknown';

  // Dismissal tracking (persisted)
  dismissedUpdateId: string | null;

  // Actions
  setUpdateAvailable: (updateId: string | null) => void;
  loadDismissedUpdateId: () => Promise<void>;
  checkForUpdate: () => Promise<boolean>;
  installAndRestart: () => Promise<void>;
  dismissUpdate: () => void;
  clearError: () => void;
  clearValidationCache: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    isUpdateAvailable: false,
    updateId: null,
    isInstalling: false,
    isChecking: false,
    isValidating: false,
    error: null,
    validationStatus: 'pending',
    dismissedUpdateId: null,

    /**
     * Called by component when useUpdates() hook indicates an update is pending.
     * Validates the update against the remote allowlist before showing.
     */
    setUpdateAvailable: async (updateId: string | null) => {
      const { dismissedUpdateId } = get();

      // If no update or this update was previously dismissed, don't show the banner
      if (!updateId || (dismissedUpdateId && dismissedUpdateId === updateId)) {
        set({ isUpdateAvailable: false, updateId: null, validationStatus: 'pending' });
        return;
      }

      // Start validation
      set({ isValidating: true, validationStatus: 'pending' });

      try {
        const isValid = await validateUpdate(updateId);

        if (isValid === false) {
          // Update is explicitly invalid or revoked
          console.warn(`Update ${updateId} failed validation - not showing to user`);
          set({
            isUpdateAvailable: false,
            updateId: null,
            isValidating: false,
            validationStatus: 'invalid',
            error: 'Update validation failed',
          });
          return;
        }

        if (isValid === null) {
          // Couldn't validate (network error, etc.)
          // Block the update until validation can be performed
          console.warn(`Could not validate update ${updateId} - blocking until validation succeeds`);
          set({
            isUpdateAvailable: false,
            updateId: null,
            isValidating: false,
            validationStatus: 'unknown',
            error: null,
          });
          return;
        }

        // Update is valid
        set({
          isUpdateAvailable: true,
          updateId,
          isValidating: false,
          validationStatus: 'valid',
          error: null,
        });
      } catch (error) {
        console.error('Update validation error:', error);
        // On error, block the update until validation can be performed
        set({
          isUpdateAvailable: false,
          updateId: null,
          isValidating: false,
          validationStatus: 'unknown',
          error: null,
        });
      }
    },

    /**
     * Load the dismissed update ID from storage on app start.
     */
    loadDismissedUpdateId: async () => {
      try {
        const storedDismissedId = await AsyncStorage.getItem(DISMISSED_UPDATE_KEY);
        if (storedDismissedId) {
          set({ dismissedUpdateId: storedDismissedId });
        }
      } catch (error) {
        console.log('Failed to load dismissed update ID:', error);
      }
    },

    /**
     * Manually check for updates (used in About screen)
     * Returns true if an update is available and validated
     */
    checkForUpdate: async () => {
      const { dismissedUpdateId } = get();
      set({ isChecking: true, error: null, validationStatus: 'pending' });

      try {
        const update = await Updates.checkForUpdateAsync();

        if (update.isAvailable) {
          // Fetch the update
          const fetchResult = await Updates.fetchUpdateAsync();

          if (fetchResult.isNew) {
            const updateId = fetchResult.manifest?.id;

            if (!updateId) {
              set({ isChecking: false });
              Toast.show({
                type: 'error',
                text1: 'Update error',
                text2: 'Update has no identifier',
              });
              return false;
            }

            // Validate the update
            set({ isValidating: true });
            const isValid = await validateUpdate(updateId);
            set({ isValidating: false });

            if (isValid === false) {
              // Update failed validation
              set({
                isChecking: false,
                validationStatus: 'invalid',
                error: 'Update failed security validation',
              });
              Toast.show({
                type: 'error',
                text1: 'Update rejected',
                text2: 'This update failed security validation',
              });
              return false;
            }

            // Clear dismissed ID if this is a new update
            if (dismissedUpdateId !== updateId) {
              await AsyncStorage.removeItem(DISMISSED_UPDATE_KEY);
              set({ dismissedUpdateId: null });
            }

            set({
              isUpdateAvailable: true,
              updateId,
              isChecking: false,
              validationStatus: isValid === true ? 'valid' : 'unknown',
            });

            Toast.show({
              type: 'success',
              text1: 'Update available',
              text2: 'Go to Home to install the update',
            });

            return true;
          }
        }

        set({ isChecking: false });
        Toast.show({
          type: 'info',
          text1: 'No updates available',
          text2: 'You are running the latest version',
        });

        return false;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to check for updates';
        console.error('Failed to check for updates:', error);

        set({
          error: message,
          isChecking: false,
          isValidating: false,
        });

        Toast.show({
          type: 'error',
          text1: 'Update check failed',
          text2: message,
        });

        return false;
      }
    },

    /**
     * Apply the downloaded update and restart the app
     */
    installAndRestart: async () => {
      set({ isInstalling: true, error: null });

      try {
        // Clear dismissed update since user is installing
        await AsyncStorage.removeItem(DISMISSED_UPDATE_KEY);
        set({ dismissedUpdateId: null });

        // Reload the app with the new update
        await Updates.reloadAsync();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to install update';
        console.error('Failed to install update:', error);

        set({
          error: message,
          isInstalling: false,
        });

        Toast.show({
          type: 'error',
          text1: 'Update failed',
          text2: message,
        });
      }
    },

    /**
     * Dismiss the update banner (user chose not to install now)
     */
    dismissUpdate: async () => {
      const { updateId } = get();

      if (updateId) {
        try {
          await AsyncStorage.setItem(DISMISSED_UPDATE_KEY, updateId);
          set({ dismissedUpdateId: updateId });
        } catch (error) {
          console.error('Failed to persist dismissed update ID:', error);
        }
      }

      set({ isUpdateAvailable: false });
    },

    /**
     * Clear the error state
     */
    clearError: () => {
      set({ error: null });
    },

    /**
     * Clear the validation cache (useful for testing or forcing re-validation)
     */
    clearValidationCache: async () => {
      try {
        await AsyncStorage.removeItem(VALIDATION_CACHE_KEY);
      } catch (error) {
        console.error('Failed to clear validation cache:', error);
      }
    },
  }))
);

// ============================================================================
// Hooks for reactive state access
// ============================================================================

/**
 * Hook to check if an update is available (reactive)
 */
export function useIsUpdateAvailable(): boolean {
  return useUpdateStore((state) => state.isUpdateAvailable);
}

/**
 * Hook to check if currently installing (reactive)
 */
export function useIsInstalling(): boolean {
  return useUpdateStore((state) => state.isInstalling);
}

/**
 * Hook to check if currently checking for updates (reactive)
 */
export function useIsChecking(): boolean {
  return useUpdateStore((state) => state.isChecking);
}

/**
 * Hook to get update error (reactive)
 */
export function useUpdateError(): string | null {
  return useUpdateStore((state) => state.error);
}

/**
 * Hook to check if currently validating (reactive)
 */
export function useIsValidating(): boolean {
  return useUpdateStore((state) => state.isValidating);
}

/**
 * Hook to get validation status (reactive)
 */
export function useValidationStatus(): 'pending' | 'valid' | 'invalid' | 'unknown' {
  return useUpdateStore((state) => state.validationStatus);
}
