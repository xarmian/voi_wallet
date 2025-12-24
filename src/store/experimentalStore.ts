/**
 * Experimental Features Store
 *
 * Manages the state of experimental features that users can opt into.
 * Features default to OFF and are persisted across app restarts.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface ExperimentalState {
  // Feature flags
  swapEnabled: boolean;
  messagingEnabled: boolean;

  // Actions
  setSwapEnabled: (enabled: boolean) => void;
  setMessagingEnabled: (enabled: boolean) => void;
}

export const useExperimentalStore = create<ExperimentalState>()(
  persist(
    (set) => ({
      // All experimental features default to OFF
      swapEnabled: false,
      messagingEnabled: false,

      setSwapEnabled: (enabled: boolean) => set({ swapEnabled: enabled }),
      setMessagingEnabled: (enabled: boolean) => set({ messagingEnabled: enabled }),
    }),
    {
      name: 'experimental-features',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);

// Convenience hooks for individual features
export const useIsSwapEnabled = () => useExperimentalStore((state) => state.swapEnabled);
export const useIsMessagingEnabled = () => useExperimentalStore((state) => state.messagingEnabled);
