import React, { useEffect } from 'react';
import { View, Platform, StatusBar } from 'react-native';
import Toast from 'react-native-toast-message';
import AppNavigator from './src/navigation/AppNavigator';
import { testCryptoPolyfills } from './src/utils/cryptoTest';
import ErrorBoundary from './src/components/ErrorBoundary';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import { debugLogger } from './src/services/debug/logger';
import { toastConfig } from './src/config/toastConfig';

function AppContent() {
  const { theme, themeMode, isDark } = useTheme();

  useEffect(() => {
    // Initialize debug logger first
    debugLogger.addDebugEntry('App startup initiated');

    // Test crypto polyfills on app startup
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
