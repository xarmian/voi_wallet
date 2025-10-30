import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  NavigationContainer,
  StackActions,
  useFocusEffect,
} from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { useNavigation } from '@react-navigation/native';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

import HomeScreen from '@/screens/wallet/HomeScreen';
import AssetDetailScreen from '@/screens/wallet/AssetDetailScreen';
import MultiNetworkAssetScreen from '@/screens/wallet/MultiNetworkAssetScreen';
import TransactionDetailScreen from '@/screens/wallet/TransactionDetailScreen';
import WebViewScreen from '@/screens/wallet/WebViewScreen';
import SendScreen from '@/screens/wallet/SendScreen';
import TransactionConfirmationScreen from '@/screens/wallet/TransactionConfirmationScreen';
import TransactionResultScreen from '@/screens/wallet/TransactionResultScreen';
import ReceiveScreen from '@/screens/wallet/ReceiveScreen';
import DiscoverScreen from '@/screens/wallet/DiscoverScreen';
import NFTScreen from '@/screens/wallet/NFTScreen';
import NFTDetailScreen from '@/screens/wallet/NFTDetailScreen';
import SettingsScreen from '@/screens/settings/SettingsScreen';
import ShowRecoveryPhraseScreen from '@/screens/settings/ShowRecoveryPhraseScreen';
import ChangePinScreen from '@/screens/settings/ChangePinScreen';
import SecuritySettingsScreen from '@/screens/settings/SecuritySettingsScreen';
import AboutScreen from '@/screens/settings/AboutScreen';
import AddWatchAccountScreen from '@/screens/account/AddWatchAccountScreen';
import CreateAccountScreen from '@/screens/account/CreateAccountScreen';
import MnemonicImportScreen from '@/screens/account/MnemonicImportScreen';
import RekeyAccountScreen from '@/screens/wallet/RekeyAccountScreen';
import OnboardingScreen from '@/screens/onboarding/OnboardingScreen';
import SessionProposalScreen from '@/screens/walletconnect/SessionProposalScreen';
import SessionsScreen from '@/screens/walletconnect/SessionsScreen';
import TransactionRequestScreen from '@/screens/walletconnect/TransactionRequestScreen';
import QRScannerScreen from '@/screens/walletconnect/QRScannerScreen';
import WalletConnectPairingScreen from '@/screens/walletconnect/WalletConnectPairingScreen';
import WalletConnectErrorScreen from '@/screens/walletconnect/WalletConnectErrorScreen';
import QRAccountImportScreen from '@/screens/account/QRAccountImportScreen';
import AccountImportPreviewScreen from '@/screens/account/AccountImportPreviewScreen';
import LedgerAccountImportScreen from '@/screens/account/LedgerAccountImportScreen';
import CreateWalletScreen from '@/screens/onboarding/CreateWalletScreen';
import SecuritySetupScreen from '@/screens/onboarding/SecuritySetupScreen';
import AuthGuard from '@/components/AuthGuard';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { MultiAccountWalletService } from '@/services/wallet';
import { WalletConnectService } from '@/services/walletconnect';
import { DeepLinkService } from '@/services/deeplink';
import { ledgerTransportService } from '@/services/ledger/transport';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkId } from '@/types/network';
import { TransactionInfo, WalletAccount } from '@/types/wallet';
import { ScannedAccount } from '@/utils/accountQRParser';
import { NFTToken } from '@/types/nft';
import { NFTBackground } from '@/components/common/NFTBackground';

export type RootStackParamList = {
  Main: undefined;
  Onboarding: undefined;
  CreateWallet: undefined;
  SecuritySetup: {
    mnemonic?: string;
    accounts?: ScannedAccount[];
    source?: 'create' | 'qr' | 'watch' | 'mnemonic' | 'ledger';
    accountLabel?: string;
  };
  MnemonicImport: { isOnboarding?: boolean };
  AddWatchAccount: { isOnboarding?: boolean };
  WalletConnectSessionProposal: { proposal: any };
  WalletConnectSessions: undefined;
  WalletConnectTransactionRequest: { requestEvent: any };
  WalletConnectPairing: { uri: string };
  WalletConnectError: { error: string; uri?: string };
  QRScanner: undefined;
  QRAccountImport: undefined;
  AccountImportPreview: { accounts: ScannedAccount[]; source: 'qr' };
  LedgerAccountImport:
    | { deviceId?: string; isOnboarding?: boolean }
    | undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Friends: undefined;
  NFTs: undefined;
  Discover: { reload?: number } | undefined;
  Settings: undefined;
};

export type WalletStackParamList = {
  HomeMain: undefined;
  AssetDetail: {
    assetName: string;
    assetId: number;
    accountId: string;
    mappingId?: string;
    networkId?: string;
  };
  MultiNetworkAsset: {
    assetName: string;
    assetId: number;
    accountId: string;
    mappingId?: string;
  };
  TransactionDetail: {
    transaction: TransactionInfo;
    assetName: string;
    assetId: number;
    accountAddress: string;
  };
  TransactionHistory: undefined;
  WebView: {
    url: string;
    title: string;
  };
  Send: {
    assetName?: string;
    assetId?: number;
    accountId?: string;
    networkId?: NetworkId;
    // Payment request parameters from Algorand URIs
    recipient?: string;
    amount?: string;
    note?: string;
    label?: string;
    asset?: string;
  };
  TransactionConfirmation: {
    recipient: string;
    recipientName?: string;
    amount: string;
    assetSymbol: string;
    assetId?: number;
    assetDecimals?: number;
    note?: string;
    estimatedFee: number;
    fromAccount: WalletAccount;
    networkId?: NetworkId;
  };
  TransactionResult: {
    transactionId?: string;
    recipient: string;
    recipientName?: string;
    amount: string;
    assetSymbol: string;
    assetId?: number;
    fee?: number;
    isSuccess: boolean;
    errorMessage?: string;
    networkId?: NetworkId;
  };
  Receive: {
    assetName?: string;
    assetId?: number;
    accountId?: string;
  };
  AccountInfo: { address?: string } | undefined;
  AccountSearch: undefined;
};

export type NFTStackParamList = {
  NFTMain: undefined;
  NFTDetail: {
    nft: NFTToken;
  };
  Send: {
    assetName?: string;
    assetId?: number;
    accountId?: string;
    networkId?: NetworkId;
    nftToken?: NFTToken;
    // Payment request parameters from Algorand URIs
    recipient?: string;
    amount?: string;
    note?: string;
    label?: string;
    asset?: string;
  };
  TransactionConfirmation: {
    recipient: string;
    recipientName?: string;
    amount: string;
    assetSymbol: string;
    assetId?: number;
    assetType?: 'voi' | 'asa' | 'arc200' | 'arc72';
    contractId?: number;
    tokenId?: string;
    assetDecimals?: number;
    note?: string;
    estimatedFee: number;
    fromAccount: WalletAccount;
    nftToken?: NFTToken;
    networkId?: NetworkId;
  };
  TransactionResult: {
    transactionId?: string;
    recipient: string;
    recipientName?: string;
    amount: string;
    assetSymbol: string;
    assetId?: number;
    assetType?: 'voi' | 'asa' | 'arc200' | 'arc72';
    contractId?: number;
    tokenId?: string;
    assetDecimals?: number;
    note?: string;
    estimatedFee: number;
    success: boolean;
    error?: string;
    networkId?: NetworkId;
  };
};

export type SettingsStackParamList = {
  SettingsMain: undefined;
  SecuritySettings: undefined;
  ShowRecoveryPhrase: {
    accountAddress: string;
  };
  ChangePin: undefined;
  WalletConnectSessions: undefined;
  AddWatchAccount: undefined;
  CreateAccount: undefined;
  MnemonicImport: undefined;
  RekeyAccount: {
    accountId: string;
  };
  AboutScreen: undefined;
  WebView: {
    url: string;
    title: string;
  };
};

export type FriendsStackParamList = {
  FriendsList: undefined;
  FriendProfile: { envoiName: string };
  AddFriend: { initialQuery?: string } | undefined;
  MyProfile: undefined;
};

// Import TransactionHistoryScreen directly to avoid async-require issues in EAS builds
import TransactionHistoryScreen from '@/screens/wallet/TransactionHistoryScreen';
import AccountInfoScreen from '@/screens/wallet/AccountInfoScreen';
import AccountSearchScreen from '@/screens/wallet/AccountSearchScreen';
import FriendsScreen from '@/screens/social/FriendsScreen';
import AddFriendScreen from '@/screens/social/AddFriendScreen';
import FriendProfileScreen from '@/screens/social/FriendProfileScreen';
import MyProfileScreen from '@/screens/social/MyProfileScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const WalletStack = createNativeStackNavigator<WalletStackParamList>();
const NFTStack = createNativeStackNavigator<NFTStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();
const FriendsStack = createNativeStackNavigator<FriendsStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

function WalletStackNavigator() {
  return (
    <NFTBackground>
      <WalletStack.Navigator
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right', // Native iOS-style animation
          gestureEnabled: true,
          gestureDirection: 'horizontal',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      >
        <WalletStack.Screen name="HomeMain" component={HomeScreen} />
        <WalletStack.Screen name="AssetDetail" component={AssetDetailScreen} />
        <WalletStack.Screen name="MultiNetworkAsset" component={MultiNetworkAssetScreen} />
        <WalletStack.Screen
          name="TransactionDetail"
          component={TransactionDetailScreen}
        />
        <WalletStack.Screen
          name="TransactionHistory"
          component={TransactionHistoryScreen}
        />
        <WalletStack.Screen name="WebView" component={WebViewScreen} />
        <WalletStack.Screen name="Send" component={SendScreen} />
        <WalletStack.Screen
          name="TransactionConfirmation"
          component={TransactionConfirmationScreen}
        />
        <WalletStack.Screen
          name="TransactionResult"
          component={TransactionResultScreen}
        />
        <WalletStack.Screen name="Receive" component={ReceiveScreen} />
        <WalletStack.Screen name="AccountInfo" component={AccountInfoScreen} />
        <WalletStack.Screen name="AccountSearch" component={AccountSearchScreen} />
      </WalletStack.Navigator>
    </NFTBackground>
  );
}

function NFTStackNavigator() {
  return (
    <NFTBackground>
      <NFTStack.Navigator
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          gestureEnabled: true,
          gestureDirection: 'horizontal',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      >
        <NFTStack.Screen name="NFTMain" component={NFTScreen} />
        <NFTStack.Screen name="NFTDetail" component={NFTDetailScreen} />
        <NFTStack.Screen name="Send" component={SendScreen} />
        <NFTStack.Screen
          name="TransactionConfirmation"
          component={TransactionConfirmationScreen}
        />
        <NFTStack.Screen
          name="TransactionResult"
          component={TransactionResultScreen}
        />
      </NFTStack.Navigator>
    </NFTBackground>
  );
}

function SettingsStackNavigator() {
  return (
    <NFTBackground>
      <SettingsStack.Navigator
        initialRouteName="SettingsMain"
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          gestureEnabled: true,
          gestureDirection: 'horizontal',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      >
        <SettingsStack.Screen name="SettingsMain" component={SettingsScreen} />
        <SettingsStack.Screen
          name="SecuritySettings"
          component={SecuritySettingsScreen}
        />
        <SettingsStack.Screen
          name="ShowRecoveryPhrase"
          component={ShowRecoveryPhraseScreen}
        />
        <SettingsStack.Screen name="ChangePin" component={ChangePinScreen} />
        <SettingsStack.Screen
          name="WalletConnectSessions"
          component={SessionsScreen}
        />
        <SettingsStack.Screen
          name="AddWatchAccount"
          component={AddWatchAccountScreen}
        />
        <SettingsStack.Screen
          name="CreateAccount"
          component={CreateAccountScreen}
        />
        <SettingsStack.Screen
          name="MnemonicImport"
          component={MnemonicImportScreen}
        />
        <SettingsStack.Screen
          name="RekeyAccount"
          component={RekeyAccountScreen}
        />
        <SettingsStack.Screen name="AboutScreen" component={AboutScreen} />
        <SettingsStack.Screen name="WebView" component={WebViewScreen} />
      </SettingsStack.Navigator>
    </NFTBackground>
  );
}

function FriendsStackNavigator() {
  return (
    <NFTBackground>
      <FriendsStack.Navigator
        initialRouteName="FriendsList"
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          gestureEnabled: true,
          gestureDirection: 'horizontal',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      >
        <FriendsStack.Screen name="FriendsList" component={FriendsScreen} />
        <FriendsStack.Screen name="AddFriend" component={AddFriendScreen} />
        <FriendsStack.Screen name="FriendProfile" component={FriendProfileScreen} />
        <FriendsStack.Screen name="MyProfile" component={MyProfileScreen} />
      </FriendsStack.Navigator>
    </NFTBackground>
  );
}

function MainTabNavigator() {
  const { updateActivity } = useAuth();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  // Extract theme values to stable variables to avoid context issues in callbacks
  const primaryColor = theme.colors.primary;
  const tabIconActive = theme.colors.tabIconActive;
  const tabIconInactive = theme.colors.tabIconInactive;
  const tabBackground = theme.colors.tabBackground;
  const borderColor = theme.colors.border;

  return (
    <AuthGuard>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          tabBarIcon: ({ focused, color, size }) => {
            let iconName: keyof typeof Ionicons.glyphMap;

            if (route.name === 'Home') {
              iconName = focused ? 'wallet' : 'wallet-outline';
            } else if (route.name === 'Friends') {
              iconName = focused ? 'people' : 'people-outline';
            } else if (route.name === 'NFTs') {
              iconName = focused ? 'images' : 'images-outline';
            } else if (route.name === 'Discover') {
              iconName = focused ? 'compass' : 'compass-outline';
            } else if (route.name === 'Settings') {
              iconName = focused ? 'settings' : 'settings-outline';
            } else {
              iconName = 'help-outline';
            }

            return <Ionicons name={iconName} size={size} color={color} />;
          },
          tabBarButton: (props) => {
            if (route.name === 'Discover') {
              return (
                <View style={styles.centerButtonContainer}>
                  <TouchableOpacity
                    {...props}
                    style={[
                      styles.centerButton,
                      props.accessibilityState?.selected &&
                        styles.centerButtonActive,
                    ]}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={
                        props.accessibilityState?.selected
                          ? 'compass'
                          : 'compass-outline'
                      }
                      size={28}
                      color={
                        props.accessibilityState?.selected
                          ? primaryColor
                          : 'white'
                      }
                    />
                  </TouchableOpacity>
                </View>
              );
            }
            return <TouchableOpacity {...props} />;
          },
          tabBarActiveTintColor: tabIconActive,
          tabBarInactiveTintColor: tabIconInactive,
          tabBarStyle: {
            backgroundColor: tabBackground,
            borderTopColor: borderColor,
          },
          headerShown: false,
        })}
      >
        <Tab.Screen
          name="Home"
          component={WalletStackNavigator}
          listeners={{
            tabPress: () => updateActivity(),
          }}
        />
        <Tab.Screen
          name="Friends"
          component={FriendsStackNavigator}
          options={{
            tabBarLabel: 'Friends',
          }}
          listeners={{
            tabPress: () => updateActivity(),
          }}
        />
        <Tab.Screen
          name="Discover"
          component={DiscoverScreen}
          options={{
            tabBarLabel: '',
          }}
          listeners={({ navigation, route }) => ({
            tabPress: (e) => {
              updateActivity();

              // If already on Discover tab, trigger a reload
              if (navigation.isFocused() && route.name === 'Discover') {
                e.preventDefault();
                // Trigger a reload by navigating to the same screen with a timestamp
                navigation.navigate('Discover', { reload: Date.now() });
              }
            },
          })}
        />
        <Tab.Screen
          name="NFTs"
          component={NFTStackNavigator}
          listeners={{
            tabPress: () => updateActivity(),
          }}
        />
        <Tab.Screen
          name="Settings"
          component={SettingsStackNavigator}
          listeners={({ navigation, route }) => ({
            tabPress: () => {
              updateActivity();

              const state = navigation.getState();
              const settingsRoute = state.routes.find(
                (r) => r.key === route.key
              );
              const stackState = settingsRoute?.state as
                | {
                    key: string;
                    type: string;
                    index: number;
                  }
                | undefined;

              if (stackState?.type === 'stack' && stackState.index > 0) {
                navigation.dispatch({
                  ...StackActions.popToTop(),
                  target: stackState.key,
                });
              }

              navigation.navigate('Settings', {
                screen: 'SettingsMain',
              });
            },
          })}
        />
      </Tab.Navigator>
    </AuthGuard>
  );
}

function AppStack() {
  const [initialRoute, setInitialRoute] = useState<string>('Onboarding');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    checkInitialRoute();
  }, []);

  const checkInitialRoute = async () => {
    try {
      const wallet = await MultiAccountWalletService.getCurrentWallet();

      if (wallet && wallet.accounts.length > 0) {
        setInitialRoute('Main');
      } else {
        setInitialRoute('Onboarding');
      }
    } catch (error) {
      console.error('Failed to check initial route:', error);
      setInitialRoute('Onboarding');
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return null; // Or a loading screen
  }

  return (
    <Stack.Navigator
      initialRouteName={initialRoute}
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        gestureEnabled: true,
        gestureDirection: 'horizontal',
      }}
    >
      <Stack.Screen name="Onboarding" component={OnboardingScreen} />
      <Stack.Screen name="CreateWallet" component={CreateWalletScreen} />
      <Stack.Screen name="SecuritySetup" component={SecuritySetupScreen} />
      <Stack.Screen name="MnemonicImport" component={MnemonicImportScreen} />
      <Stack.Screen name="AddWatchAccount" component={AddWatchAccountScreen} />
      <Stack.Screen name="Main" component={MainTabNavigator} />
      <Stack.Screen
        name="WalletConnectSessionProposal"
        component={SessionProposalScreen}
      />
      <Stack.Screen name="WalletConnectSessions" component={SessionsScreen} />
      <Stack.Screen
        name="WalletConnectTransactionRequest"
        component={TransactionRequestScreen}
      />
      <Stack.Screen name="WalletConnectPairing" component={WalletConnectPairingScreen} />
      <Stack.Screen name="WalletConnectError" component={WalletConnectErrorScreen} />
      <Stack.Screen
        name="QRScanner"
        component={QRScannerScreen}
        options={{
          presentation: 'fullScreenModal',
          headerShown: false,
          animation: 'slide_from_bottom',
          gestureEnabled: true,
          gestureDirection: 'vertical',
        }}
      />
      <Stack.Screen
        name="QRAccountImport"
        component={QRAccountImportScreen}
        options={{
          presentation: 'fullScreenModal',
          headerShown: false,
          animation: 'slide_from_bottom',
          gestureEnabled: true,
          gestureDirection: 'vertical',
        }}
      />
      <Stack.Screen
        name="AccountImportPreview"
        component={AccountImportPreviewScreen}
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="LedgerAccountImport"
        component={LedgerAccountImportScreen}
        options={{
          headerShown: false,
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
          gestureDirection: 'vertical',
        }}
      />
    </Stack.Navigator>
  );
}

function NavigationActivityWrapper() {
  return <AppStack />;
}

export default function AppNavigator() {
  const navigationRef = useRef<any>(null);
  const { initializeNetwork } = useNetworkStore();

  useEffect(() => {
    const initializeServices = async () => {
      try {
        // Initialize Network store
        await initializeNetwork();

        // Initialize WalletConnect service
        const wcService = WalletConnectService.getInstance();
        await wcService.initialize();

        // Listen for WalletConnect session proposals and navigate to approval screen
        const onProposal = (proposal: any) => {
          try {
            if (navigationRef.current?.isReady?.()) {
              // Close any open QR scanner first when possible
              if (navigationRef.current.canGoBack?.()) {
                navigationRef.current.goBack();
              }
              // Then navigate to session proposal
              navigationRef.current.navigate('WalletConnectSessionProposal', {
                proposal,
              });
            }
          } catch (err) {
            console.error(
              'Failed to navigate to WalletConnectSessionProposal:',
              err
            );
          }
        };
        wcService.on('session_proposal', onProposal);

        const onRequest = (requestEvent: any) => {
          try {
            if (navigationRef.current?.isReady?.()) {
              navigationRef.current.navigate(
                'WalletConnectTransactionRequest',
                { requestEvent }
              );
            }
          } catch (err) {
            console.error(
              'Failed to navigate to WalletConnectTransactionRequest:',
              err
            );
          }
        };
        wcService.on('session_request', onRequest);

        // Initialize DeepLink service
        const deepLinkService = DeepLinkService.getInstance();
        if (navigationRef.current) {
          deepLinkService.setNavigationRef(navigationRef.current);
        }
        await deepLinkService.initialize();

        // Initialize Ledger transport service to load persisted devices
        try {
          await ledgerTransportService.initialize({
            enableBle: true,
            enableUsb: true,
          });
          console.log('Ledger transport service initialized');
        } catch (error) {
          console.warn('Failed to initialize Ledger transport service:', error);
          // Don't block app startup for Ledger initialization failures
        }

        console.log('WalletConnect, DeepLink, and Ledger services initialized');

        return () => {
          try {
            wcService.off?.('session_proposal', onProposal);
            wcService.off?.('session_request', onRequest);
          } catch {}
        };
      } catch (error) {
        console.error('Failed to initialize services:', error);
      }
    };

    initializeServices();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <BottomSheetModalProvider>
          <NavigationContainer ref={navigationRef}>
            <NavigationActivityWrapper />
          </NavigationContainer>
        </BottomSheetModalProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    centerButtonContainer: {
      position: 'absolute',
      top: -8,
      left: 0,
      right: 0,
      justifyContent: 'center',
      alignItems: 'center',
      pointerEvents: 'box-none',
    },
    centerButton: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: theme.colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
      pointerEvents: 'auto',
      ...theme.shadows.md,
    },
    centerButtonActive: {
      backgroundColor: theme.colors.primaryDark,
    },
  });
