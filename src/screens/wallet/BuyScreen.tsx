import React, {
  useMemo,
  useRef,
  useState,
  useCallback,
  useEffect,
} from 'react';
import { View, Text, StyleSheet, Alert, Linking, Platform, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ThemedWebView, { ThemedWebViewRef } from '@/components/common/ThemedWebView';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useWalletStore, useActiveAccount } from '@/store/walletStore';
import type {
  MainTabParamList,
  RootStackParamList,
} from '@/navigation/AppNavigator';
import UniversalHeader from '@/components/common/UniversalHeader';
import AccountListModal from '@/components/account/AccountListModal';
import { useTheme } from '@/contexts/ThemeContext';

type BuyScreenNavigationProp = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Buy'>,
  StackNavigationProp<RootStackParamList>
>;

type BuyScreenRouteProp = RouteProp<MainTabParamList, 'Buy'>;

export default function BuyScreen() {
  const navigation = useNavigation<BuyScreenNavigationProp>();
  const route = useRoute<BuyScreenRouteProp>();
  const wallet = useWalletStore((state) => state.wallet);
  const activeAccount = useActiveAccount();
  const webViewRef = useRef<ThemedWebViewRef>(null);
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);
  const [shouldReload, setShouldReload] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const { theme } = useTheme();

  const iBuyVoiUrl = useMemo(() => {
    if (!activeAccount) {
      return null;
    }

    const baseUrl = 'https://ibuyvoi.com/widget';
    const params = new URLSearchParams({
      destination: activeAccount.address,
      theme: theme.mode,
      mode: 'redirect',
      minimum: '2',
    });

    return `${baseUrl}?${params.toString()}`;
  }, [activeAccount, theme.mode]);

  // Minimal navigation handler - only block clearly problematic URLs
  const handleShouldStartLoadWithRequest = useCallback((request: any) => {
    const { url } = request;

    // Block invalid URLs and about:blank
    if (!url || url === 'about:blank' || url.startsWith('about:')) {
      console.log('[BuyScreen] Blocking invalid URL:', url);
      return false;
    }

    // Allow all legitimate navigation - including third-party domains (Coinbase, payment processors)
    // The WebView will handle these naturally, including iframes and popups
    return true;
  }, []);

  // Handle pull-to-refresh
  const handleRefresh = useCallback(() => {
    console.log('[BuyScreen] Pull-to-refresh triggered');
    setRefreshing(true);

    if (webViewRef.current && iBuyVoiUrl) {
      // Reset loading state to show "Loading iBuyVoi..." on next load
      webViewRef.current.resetLoadingState();
      // Reload the WebView to the main iBuyVoi URL
      webViewRef.current.injectJavaScript(`window.location.href = '${iBuyVoiUrl}';`);
    }

    // Reset refreshing state after a short delay
    setTimeout(() => setRefreshing(false), 1000);
  }, [iBuyVoiUrl]);

  const handleAccountSelectorPress = useCallback(() => {
    setIsAccountModalVisible(true);
  }, []);

  const handleAccountModalClose = useCallback(() => {
    setIsAccountModalVisible(false);
  }, []);

  const handleAccountSelect = useCallback((accountId: string) => {
    // Account switching is handled by AccountListItem automatically
    // When the active account changes, the URL will update and we reload the WebView
    setIsAccountModalVisible(false);
    setShouldReload(true);
  }, []);

  const handleAddAccount = useCallback(() => {
    setIsAccountModalVisible(false);
    // Navigate to add account screen if needed
  }, []);

  // Handle reload when tab is pressed while already on Buy page
  useEffect(() => {
    if (route.params?.reload && webViewRef.current && iBuyVoiUrl) {
      console.log('[BuyScreen] Tab reload triggered');
      webViewRef.current.resetLoadingState();
      webViewRef.current.injectJavaScript(`window.location.href = '${iBuyVoiUrl}';`);
    }
  }, [route.params?.reload, iBuyVoiUrl]);

  // Handle reload when active account changes after account selection
  useEffect(() => {
    if (shouldReload && activeAccount && webViewRef.current && iBuyVoiUrl) {
      console.log('[BuyScreen] Account switch reload triggered');
      webViewRef.current.resetLoadingState();
      webViewRef.current.injectJavaScript(`window.location.href = '${iBuyVoiUrl}';`);
      setShouldReload(false);
    }
  }, [activeAccount, shouldReload, iBuyVoiUrl]);

  // Render different content based on state
  const renderContent = () => {
    if (!wallet || !activeAccount) {
      return (
        <>
          <UniversalHeader
            title="Buy VOI"
            onAccountSelectorPress={handleAccountSelectorPress}
            showAccountSelector={false}
          />
          <View
            style={[
              styles.errorContainer,
              { backgroundColor: theme.colors.background },
            ]}
          >
            <Ionicons
              name="wallet-outline"
              size={60}
              color={theme.colors.textSecondary}
            />
            <Text style={[styles.errorTitle, { color: theme.colors.text }]}>
              No Wallet Found
            </Text>
            <Text
              style={[
                styles.errorMessage,
                { color: theme.colors.textSecondary },
              ]}
            >
              Please create or import a wallet to buy VOI tokens.
            </Text>
          </View>
        </>
      );
    }

    if (!iBuyVoiUrl) {
      return (
        <>
          <UniversalHeader
            title="Buy VOI"
            onAccountSelectorPress={handleAccountSelectorPress}
          />
          <View
            style={[
              styles.errorContainer,
              { backgroundColor: theme.colors.background },
            ]}
          >
            <Ionicons
              name="alert-circle-outline"
              size={60}
              color={theme.colors.error}
            />
            <Text style={[styles.errorTitle, { color: theme.colors.text }]}>
              Unable to Load
            </Text>
            <Text
              style={[
                styles.errorMessage,
                { color: theme.colors.textSecondary },
              ]}
            >
              There was an error loading the purchase interface.
            </Text>
          </View>
        </>
      );
    }

    return (
      <>
        <UniversalHeader
          title="Buy VOI"
          onAccountSelectorPress={handleAccountSelectorPress}
        />
        <ThemedWebView
          ref={webViewRef}
          source={{ uri: iBuyVoiUrl }}
          style={styles.webview}
          loadingIcon="cash-outline"
          loadingText="Loading iBuyVoi..."
          showLoadingOnlyOnce={true}
          onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
          setSupportMultipleWindows={true}
          onLoadError={(errorDescription) => {
            console.error('[BuyScreen] iBuyVoi loading error:', errorDescription);
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
              colors={[theme.colors.primary]}
            />
          }
        />
      </>
    );
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={['top']}
    >
      {renderContent()}

      <AccountListModal
        isVisible={isAccountModalVisible}
        onClose={handleAccountModalClose}
        onAddAccount={handleAddAccount}
        onAccountSelect={handleAccountSelect}
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
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 10,
  },
  errorMessage: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 22,
  },
});
