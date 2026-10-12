import React, { useEffect, useMemo } from 'react';
import { View, StatusBar } from 'react-native';
import Toast from 'react-native-toast-message';
import AppNavigator from './src/navigation/AppNavigator';
import { testCryptoPolyfills } from './src/utils/cryptoTest';
import ErrorBoundary from './src/components/ErrorBoundary';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import { debugLogger } from './src/services/debug/logger';
import { createToastConfig } from './src/config/toastConfig';
import OfflineBanner from './src/components/common/OfflineBanner';

function AppContent() {
  const { theme, themeMode, isDark } = useTheme();

  // Toasts read their config when shown; rebuild it on theme change so they
  // render with the active (light/dark/NFT) palette instead of hardcoded white.
  const toastConfig = useMemo(() => createToastConfig(theme), [theme]);

  useEffect(() => {
    // Initialize debug logger first
    debugLogger.addDebugEntry('App startup initiated');

    // Verify crypto polyfills on startup. Cheap typeof checks run in every
    // build; the heavier algosdk keygen probe is gated to __DEV__ inside
    // testCryptoPolyfills() so it never runs on the release cold-boot path.
    const isWorking = testCryptoPolyfills();
    if (!isWorking) {
      console.warn('Crypto polyfills are not working correctly. Wallet functionality may be impaired.');
    } else {
      debugLogger.addDebugEntry('Crypto polyfills initialized successfully');
    }
  }, []);

  // DR-18 (FR-374): dev-only Hermes crypto parity self-test. It runs only in a
  // __DEV__ build started with EXPO_PUBLIC_CRYPTO_SELFTEST=1, and logs one
  // PASS/FAIL line per vector. Release bundles don't contain the module at all:
  // metro.devOnlyResolver.js maps src/dev/* to an empty module when dev=false.
  useEffect(() => {
    if (__DEV__ && process.env.EXPO_PUBLIC_CRYPTO_SELFTEST === '1') {
      import('./src/dev/cryptoSelfTest')
        .then((m) => m.runCryptoSelfTest())
        .catch(() => console.warn('[crypto self-test] FAIL load'));
    }
  }, []);

  // Debug logging
  useEffect(() => {
    if (theme && theme.colors) {
      console.log('Theme changed:', {
        mode: theme.mode,
        themeMode,
        isDark,
        statusBar: theme.colors.statusBar
      });
    }
  }, [theme?.mode, themeMode, isDark, theme?.colors?.statusBar]);

  // Use safe defaults if theme is not available
  const backgroundColor = theme?.colors?.background || '#FFFFFF';
  const statusBarStyle = theme?.colors?.statusBar || 'dark-content';

  return (
    <View style={{ flex: 1, backgroundColor }}>
      {/* RN 0.88 drops StatusBar backgroundColor/translucent: Android 16
          edge-to-edge is mandatory, so the status bar is always transparent
          and the root View's background shows through it. */}
      <StatusBar barStyle={statusBarStyle} animated />
      <AppNavigator />
      {/* Above the navigator so it survives every navigation (including the
          pre-auth screens) and below the Toast so transient toasts still win
          the top of the stack. Consumes connectivity only — no auth state,
          which is why it can live outside AuthProvider. */}
      <OfflineBanner />
      <Toast config={toastConfig} />
    </View>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AppContent />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
