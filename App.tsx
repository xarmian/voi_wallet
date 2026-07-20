import React, { useEffect, useMemo } from 'react';
import { View, Platform, StatusBar } from 'react-native';
import Toast from 'react-native-toast-message';
import AppNavigator from './src/navigation/AppNavigator';
import { testCryptoPolyfills } from './src/utils/cryptoTest';
import ErrorBoundary from './src/components/ErrorBoundary';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import { debugLogger } from './src/services/debug/logger';
import { createToastConfig } from './src/config/toastConfig';

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
      <StatusBar
        barStyle={statusBarStyle}
        backgroundColor={Platform.OS === 'android' ? backgroundColor : undefined}
        animated
        translucent={false}
      />
      <AppNavigator />
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
