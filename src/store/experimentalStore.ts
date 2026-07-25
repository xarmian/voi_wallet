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
  // Developer flag: allow WalletConnect to connect/sign on networks this wallet
  // does not recognize (e.g. a local devnet). Default OFF so typical users get
  // the strict per-chain approval policy. TASK-240 (session approval) and
  // TASK-251 (signing-time genesis binding, PLAN-10) both read THIS flag.
  allowUnsupportedNetworks: boolean;

  // Actions
  setSwapEnabled: (enabled: boolean) => void;
  setMessagingEnabled: (enabled: boolean) => void;
  setAllowUnsupportedNetworks: (enabled: boolean) => void;
}

export const useExperimentalStore = create<ExperimentalState>()(
  persist(
    (set) => ({
      // All experimental features default to OFF
      swapEnabled: false,
      messagingEnabled: false,
      allowUnsupportedNetworks: false,

      setSwapEnabled: (enabled: boolean) => set({ swapEnabled: enabled }),
      setMessagingEnabled: (enabled: boolean) =>
        set({ messagingEnabled: enabled }),
      setAllowUnsupportedNetworks: (enabled: boolean) =>
        set({ allowUnsupportedNetworks: enabled }),
    }),
    {
      name: 'experimental-features',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);

// Convenience hooks for individual features
export const useIsSwapEnabled = () =>
  useExperimentalStore((state) => state.swapEnabled);
export const useIsMessagingEnabled = () =>
  useExperimentalStore((state) => state.messagingEnabled);
export const useAllowUnsupportedNetworks = () =>
  useExperimentalStore((state) => state.allowUnsupportedNetworks);
