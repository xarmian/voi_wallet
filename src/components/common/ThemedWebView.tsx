import React, {
  useState,
  useRef,
  useImperativeHandle,
  forwardRef,
  useMemo,
} from 'react';
import { View, Text, StyleSheet, Alert, Platform, Linking } from 'react-native';
import { WebView, WebViewProps } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface ThemedWebViewRef {
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  injectJavaScript: (script: string) => void;
  resetLoadingState: () => void; // Reset to show loading on next navigation
}

interface ThemedWebViewProps extends Omit<WebViewProps, 'startInLoadingState' | 'renderLoading'> {
  loadingIcon?: keyof typeof Ionicons.glyphMap;
  loadingText?: string;
  onLoadError?: (errorDescription: string) => void;
  showDefaultErrorAlert?: boolean;
  showLoadingOnlyOnce?: boolean; // Only show loading on initial load, not on subsequent navigations
}

const ThemedWebView = forwardRef<ThemedWebViewRef, ThemedWebViewProps>(({
  loadingIcon = 'globe-outline',
  loadingText = 'Loading...',
  onLoadError,
  showDefaultErrorAlert = true,
  showLoadingOnlyOnce = false,
  onLoadStart,
  onLoadEnd,
  onError,
  style,
  contentInset,
  contentInsetAdjustmentBehavior,
  source,
  onShouldStartLoadWithRequest: customShouldStartLoadWithRequest,
  ...restWebViewProps
}, ref) => {
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const webViewRef = useRef<WebView>(null);
  const allowedOriginsRef = useRef<Set<string>>(new Set());
  const sourceUri = useMemo(() => {
    if (source && typeof source === 'object' && 'uri' in source) {
      return typeof source.uri === 'string' ? source.uri : null;
    }
    return null;
  }, [source]);
  const sourceUriRef = useRef<string | null>(null);
  sourceUriRef.current = sourceUri ?? null;
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  const recordAllowedOrigin = (url: string | null | undefined) => {
    if (!url) {
      return;
    }
    try {
      const origin = new URL(url).origin;
      if (origin) {
        allowedOriginsRef.current.add(origin);
      }
    } catch {
      // Ignore invalid URLs (e.g., mailto:, about:blank)
    }
  };

  // Track the origin of the provided source URI so that navigations to the
  // same host remain in the WebView (e.g., account changes on the buy tab).
  if (sourceUri) {
    recordAllowedOrigin(sourceUri);
  }

  const resolvedContentInset = useMemo(() => {
    if (Platform.OS !== 'ios') {
      return contentInset;
    }

    const bottomInset = Math.max(contentInset?.bottom ?? 0, insets.bottom);

    if (!bottomInset && contentInset === undefined) {
      return undefined;
    }

    return {
      top: contentInset?.top ?? 0,
      left: contentInset?.left ?? 0,
      right: contentInset?.right ?? 0,
      bottom: bottomInset,
    };
  }, [contentInset, insets.bottom]);

  const resolvedContentInsetAdjustmentBehavior =
    contentInsetAdjustmentBehavior ??
    (Platform.OS === 'ios' ? 'automatic' : undefined);

  // Expose WebView methods to parent components
  useImperativeHandle(ref, () => ({
    reload: () => webViewRef.current?.reload(),
    goBack: () => webViewRef.current?.goBack(),
    goForward: () => webViewRef.current?.goForward(),
    injectJavaScript: (script: string) => webViewRef.current?.injectJavaScript(script),
    resetLoadingState: () => {
      setHasLoadedOnce(false);
      setIsLoading(true);
    },
  }));

  const handleLoadStart = (event: any) => {
    // Store the initial URL on first load
    const eventUrl = event?.nativeEvent?.url;
    if (!initialUrl && eventUrl) {
      setInitialUrl(eventUrl);
    }
    recordAllowedOrigin(eventUrl);
    // Only show loading if we haven't loaded once yet, or if showLoadingOnlyOnce is false
    if (!showLoadingOnlyOnce || !hasLoadedOnce) {
      setIsLoading(true);
    }
    onLoadStart?.(event);
  };

  const handleShouldStartLoadWithRequest = (request: any) => {
    const customResult = customShouldStartLoadWithRequest
      ? customShouldStartLoadWithRequest(request)
      : undefined;

    if (customResult === false) {
      return false;
    }

    const { url } = request;
    if (!url) {
      return false;
    }

    // Allow the initial load or any navigation that matches the current source
    if (!initialUrl || url === initialUrl || url === sourceUriRef.current) {
      return true;
    }

    // Allow sub-frame/resource requests
    if (request.isMainFrame === false) {
      return true;
    }
    if (request.mainDocumentURL && request.mainDocumentURL !== url) {
      return true;
    }

    // Allow navigations that stay on a known origin
    let isAllowedOrigin = false;
    try {
      const origin = new URL(url).origin;
      isAllowedOrigin = allowedOriginsRef.current.has(origin);
    } catch {
      // Non-http(s) schemes (mailto:, tel:, etc.) fall back to external handling
    }

    if (isAllowedOrigin) {
      return true;
    }

    // If the custom handler explicitly allowed the navigation, honor it
    if (customResult === true) {
      return true;
    }

    // Open external links in system browser
    Linking.openURL(url).catch((error) => {
      console.warn('[ThemedWebView] Failed to open external URL:', error);
    });
    return false;
  };

  const handleLoadEnd = (event: any) => {
    setIsLoading(false);
    setHasLoadedOnce(true);
    onLoadEnd?.(event);
  };

  const handleError = (syntheticEvent: any) => {
    const { nativeEvent } = syntheticEvent;
    setIsLoading(false);

    // Call custom error handler if provided
    onLoadError?.(nativeEvent.description);

    // Show default error alert if enabled
    if (showDefaultErrorAlert) {
      Alert.alert(
        'Loading Error',
        `Unable to load page: ${nativeEvent.description}`,
        [{ text: 'OK' }]
      );
    }

    // Call original onError handler
    onError?.(syntheticEvent);
  };

  return (
    <>
      {isLoading && (
        <View
          style={[
            styles.loadingContainer,
            { backgroundColor: theme.colors.background },
          ]}
        >
          <Ionicons
            name={loadingIcon}
            size={50}
            color={theme.colors.textSecondary}
          />
          <Text
            style={[
              styles.loadingText,
              { color: theme.colors.textSecondary },
            ]}
          >
            {loadingText}
          </Text>
        </View>
      )}
      <WebView
        ref={webViewRef}
        {...restWebViewProps}
        source={source}
        style={[styles.webview, isLoading && styles.hiddenWebView, style]}
        contentInset={resolvedContentInset}
        contentInsetAdjustmentBehavior={resolvedContentInsetAdjustmentBehavior}
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
        onError={handleError}
        onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
      />
    </>
  );
});

ThemedWebView.displayName = 'ThemedWebView';

const styles = StyleSheet.create({
  webview: {
    flex: 1,
  },
  hiddenWebView: {
    opacity: 0,
    position: 'absolute',
    top: -1000,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 10,
    fontSize: 16,
  },
});

export default ThemedWebView;
