import React, {
  useState,
  useRef,
  useImperativeHandle,
  forwardRef,
  useMemo,
  useCallback,
} from 'react';
import { View, Text, StyleSheet, Platform, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Conditionally import WebView - it doesn't work on web
let WebView: any = null;
let WebViewProps: any = {};
if (Platform.OS !== 'web') {
  const webviewModule = require('react-native-webview');
  WebView = webviewModule.WebView;
  WebViewProps = webviewModule.WebViewProps;
}

// Cross-platform alert helper
const showAlert = (title: string, message: string) => {
  if (Platform.OS === 'web') {
    window.alert(`${title}\n\n${message}`);
  } else {
    const { Alert } = require('react-native');
    Alert.alert(title, message, [{ text: 'OK' }]);
  }
};

export interface ThemedWebViewRef {
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  injectJavaScript: (script: string) => void;
  resetLoadingState: () => void; // Reset to show loading on next navigation
}

interface ThemedWebViewProps {
  source?: { uri: string } | { html: string };
  style?: any;
  loadingIcon?: keyof typeof Ionicons.glyphMap;
  loadingText?: string;
  onLoadError?: (errorDescription: string) => void;
  showDefaultErrorAlert?: boolean;
  showLoadingOnlyOnce?: boolean; // Only show loading on initial load, not on subsequent navigations
  onLoadStart?: (event: any) => void;
  onLoadEnd?: (event: any) => void;
  onError?: (event: any) => void;
  onShouldStartLoadWithRequest?: (request: any) => boolean;
  contentInset?: { top?: number; left?: number; right?: number; bottom?: number };
  contentInsetAdjustmentBehavior?: string;
  // Additional props passed to native WebView
  [key: string]: any;
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
  const webViewRef = useRef<any>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
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
    reload: () => {
      if (Platform.OS === 'web') {
        if (iframeRef.current) {
          iframeRef.current.src = iframeRef.current.src;
        }
      } else {
        webViewRef.current?.reload();
      }
    },
    goBack: () => {
      if (Platform.OS === 'web') {
        try {
          iframeRef.current?.contentWindow?.history.back();
        } catch (e) {
          // Cross-origin restrictions may prevent this
        }
      } else {
        webViewRef.current?.goBack();
      }
    },
    goForward: () => {
      if (Platform.OS === 'web') {
        try {
          iframeRef.current?.contentWindow?.history.forward();
        } catch (e) {
          // Cross-origin restrictions may prevent this
        }
      } else {
        webViewRef.current?.goForward();
      }
    },
    injectJavaScript: (script: string) => {
      if (Platform.OS === 'web') {
        try {
          iframeRef.current?.contentWindow?.eval(script);
        } catch (e) {
          // Cross-origin restrictions may prevent this
          console.warn('Cannot inject JavaScript into iframe due to cross-origin restrictions');
        }
      } else {
        webViewRef.current?.injectJavaScript(script);
      }
    },
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
    const errorDescription = nativeEvent?.description || 'Unknown error';
    onLoadError?.(errorDescription);

    // Show default error alert if enabled
    if (showDefaultErrorAlert) {
      showAlert('Loading Error', `Unable to load page: ${errorDescription}`);
    }

    // Call original onError handler
    onError?.(syntheticEvent);
  };

  // Handle iframe load for web
  const handleIframeLoad = useCallback(() => {
    setIsLoading(false);
    setHasLoadedOnce(true);
    onLoadEnd?.({});
  }, [onLoadEnd]);

  const handleIframeError = useCallback(() => {
    setIsLoading(false);
    onLoadError?.('Failed to load page');
    if (showDefaultErrorAlert) {
      showAlert('Loading Error', 'Unable to load page');
    }
    onError?.({ nativeEvent: { description: 'Failed to load page' } });
  }, [onLoadError, showDefaultErrorAlert, onError]);

  // Get the URL from source
  const url = useMemo(() => {
    if (source && typeof source === 'object' && 'uri' in source) {
      return source.uri;
    }
    return null;
  }, [source]);

  // Render loading state
  const renderLoading = () => (
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
  );

  // Web: Use iframe
  if (Platform.OS === 'web') {
    return (
      <View style={[styles.webview, style]}>
        {isLoading && renderLoading()}
        {url && (
          <iframe
            ref={iframeRef as any}
            src={url}
            style={{
              flex: 1,
              width: '100%',
              height: '100%',
              border: 'none',
              display: isLoading ? 'none' : 'block',
            }}
            onLoad={handleIframeLoad}
            onError={handleIframeError}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        )}
      </View>
    );
  }

  // Native: Use WebView
  return (
    <>
      {isLoading && renderLoading()}
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
