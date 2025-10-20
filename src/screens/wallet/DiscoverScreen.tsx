import React, { useRef, useEffect } from 'react';
import { StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, RouteProp } from '@react-navigation/native';
import type { MainTabParamList } from '@/navigation/AppNavigator';
import { useTheme } from '@/contexts/ThemeContext';
import ThemedWebView, { ThemedWebViewRef } from '@/components/common/ThemedWebView';

const DISCOVER_BASE_URL = 'https://voirewards.com/discover';

type DiscoverScreenRouteProp = RouteProp<MainTabParamList, 'Discover'>;

export default function DiscoverScreen() {
  const route = useRoute<DiscoverScreenRouteProp>();
  const webViewRef = useRef<ThemedWebViewRef>(null);
  const { theme } = useTheme();

  const getDiscoverUrl = () => {
    const params = new URLSearchParams({
      theme: theme.mode,
      os: Platform.OS,
    });
    return `${DISCOVER_BASE_URL}?${params.toString()}`;
  };

  // Handle reload when tab is pressed while already on Discover page
  useEffect(() => {
    if (route.params?.reload && webViewRef.current) {
      // Navigate back to the original URL instead of just reloading
      webViewRef.current.injectJavaScript(
        `window.location.href = '${getDiscoverUrl()}';`
      );
    }
  }, [route.params?.reload, theme.mode]);

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={['top']}
    >
      <ThemedWebView
        ref={webViewRef}
        source={{ uri: getDiscoverUrl() }}
        style={styles.webview}
        loadingText="Loading Discover..."
        onLoadError={(errorDescription) => {
          console.error('Discover page loading error:', errorDescription);
        }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
});
