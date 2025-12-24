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
import { View, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { detectPlatform } from '@/platform/detection';
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
import SwapScreen from '@/screens/wallet/SwapScreen';
import TransactionConfirmationScreen from '@/screens/wallet/TransactionConfirmationScreen';
import TransactionResultScreen from '@/screens/wallet/TransactionResultScreen';
import UniversalTransactionSigningScreen from '@/screens/wallet/UniversalTransactionSigningScreen';
import ReceiveScreen from '@/screens/wallet/ReceiveScreen';
import ClaimableTokensScreen from '@/screens/wallet/ClaimableTokensScreen';
import ClaimTokenScreen from '@/screens/wallet/ClaimTokenScreen';
import ClaimAllConfirmationScreen from '@/screens/wallet/ClaimAllConfirmationScreen';
import DiscoverScreen from '@/screens/wallet/DiscoverScreen';
import NFTScreen from '@/screens/wallet/NFTScreen';
import NFTDetailScreen from '@/screens/wallet/NFTDetailScreen';
import CollectionDetailScreen from '@/screens/wallet/CollectionDetailScreen';
import SettingsScreen from '@/screens/settings/SettingsScreen';
import ShowRecoveryPhraseScreen from '@/screens/settings/ShowRecoveryPhraseScreen';
import ChangePinScreen from '@/screens/settings/ChangePinScreen';
import SecuritySettingsScreen from '@/screens/settings/SecuritySettingsScreen';
import AboutScreen from '@/screens/settings/AboutScreen';
import NotificationSettingsScreen from '@/screens/settings/NotificationSettingsScreen';
import ExperimentalFeaturesScreen from '@/screens/settings/ExperimentalFeaturesScreen';
import BackupWalletScreen from '@/screens/settings/BackupWalletScreen';
import RestoreWalletScreen from '@/screens/settings/RestoreWalletScreen';
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
// Remote Signer screens
import {
  AirgapHomeScreen,
  ExportAccountsScreen,
  ImportRemoteSignerScreen,
  RemoteSignerSettingsScreen,
  SignRequestScannerScreen,
  TransactionReviewScreen,
  SignatureDisplayScreen,
  SignRequestDisplayScreen,
  SignatureScannerScreen,
  ImportFromOnlineWalletScreen,
} from '@/screens/remoteSigner';
// ARC-0090 transaction screens
import KeyregConfirmScreen from '@/screens/transaction/KeyregConfirmScreen';
import AppCallConfirmScreen from '@/screens/transaction/AppCallConfirmScreen';
import AppInfoModal from '@/screens/app/AppInfoModal';
import { useAppMode, getAppModeEarly, useRemoteSignerStore } from '@/store/remoteSignerStore';
import { RemoteSignerRequest } from '@/types/remoteSigner';
import SecuritySetupScreen from '@/screens/onboarding/SecuritySetupScreen';
import AuthGuard from '@/components/AuthGuard';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { MultiAccountWalletService } from '@/services/wallet';
import { WalletConnectService } from '@/services/walletconnect';
import { DeepLinkService } from '@/services/deeplink';
import { extensionDeepLinkHandler } from '@/services/deeplink/extensionHandler';
import { ledgerTransportService } from '@/services/ledger/transport';
import { isWalletConnectUri } from '@/services/walletconnect/utils';
import { useNetworkStore } from '@/store/networkStore';
import { notificationService } from '@/services/notifications';
import { realtimeService } from '@/services/realtime';
import { NetworkId } from '@/types/network';
import { TransactionInfo, WalletAccount } from '@/types/wallet';
import { ScannedAccount } from '@/utils/accountQRParser';
import { NFTToken } from '@/types/nft';
import { SerializableClaimableItem } from '@/types/claimable';
import { NFTBackground } from '@/components/common/NFTBackground';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';
import { FABRadialMenu } from '@/components/navigation/FABRadialMenu';
import { useUpdates } from 'expo-updates';
import { useUpdateStore } from '@/store/updateStore';

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
  UniversalTransactionSigning: {
    transactions: string[];
    account: WalletAccount;
    /** @deprecated Use callbackId instead to avoid serialization warnings */
    onSuccess?: (result: any) => Promise<void>;
    /** @deprecated Use callbackId instead to avoid serialization warnings */
    onReject?: () => Promise<void>;
    /** ID to retrieve callbacks from registry (preferred over onSuccess/onReject) */
    callbackId?: string;
    title?: string;
    networkId?: NetworkId;
    chainId?: string;
  };
  QRScanner: undefined;
  QRAccountImport: undefined;
  AccountImportPreview: { accounts: ScannedAccount[]; source: 'qr' };
  LedgerAccountImport:
    | { deviceId?: string; isOnboarding?: boolean }
    | undefined;
  // Remote Signer signing flow screens
  SignRequestDisplay: {
    request: RemoteSignerRequest;
    onComplete?: (signedTxns: Uint8Array[]) => void;
  };
  SignatureScanner: {
    requestId: string;
  };
  SignRequestScanner: undefined;
  RemoteSignerTransactionReview: {
    request: RemoteSignerRequest;
  };
  SignatureDisplay: {
    request: RemoteSignerRequest;
  };
  RestoreWallet: { isOnboarding?: boolean };
  // ARC-0090 deep link screens
  KeyregConfirm: {
    address: string;
    votekey?: string;
    selkey?: string;
    sprfkey?: string;
    votefst?: number;
    votelst?: number;
    votekd?: number;
    fee?: number;
    note?: string;
    isOnline: boolean;
    networkId?: NetworkId;
  };
  AppCallConfirm: {
    senderAddress: string;
    appId: number;
    foreignApps?: number[];
    method?: string;
    args?: string[];
    boxes?: string[];
    foreignAssets?: number[];
    foreignAccounts?: string[];
    fee?: number;
    note?: string;
    networkId?: NetworkId;
  };
  AppInfoModal: {
    appId: number;
    networkId?: NetworkId;
    queryParams?: {
      box?: string;
      global?: string;
      local?: string;
      algorandaddress?: string;
      tealcode?: boolean;
    };
  };
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
    // Payment request parameters from ARC-0090 URIs
    recipient?: string;
    amount?: string;
    note?: string;
    label?: string;
    asset?: string;
    fee?: string; // Transaction fee in microunits
    isXnote?: boolean; // Whether the note is non-modifiable
  };
  Swap: {
    assetName?: string;
    assetId?: number;
    accountId: string;
    networkId?: NetworkId;
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
  UniversalTransactionSigning: {
    transactions: string[]; // Base64 encoded transactions
    account: WalletAccount;
    onSuccess?: (result: any) => Promise<void>;
    onReject?: () => Promise<void>;
    title?: string;
    networkId?: NetworkId;
    chainId?: string;
    outputTokenId?: number;
    outputTokenSymbol?: string;
    swapProvider?: 'deflex' | 'snowball';
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
  ClaimableTokens: { pendingRefresh?: boolean; claimedItemIds?: string[] } | undefined;
  ClaimToken: {
    claimableItem: SerializableClaimableItem;
  };
  ClaimAllConfirmation: {
    items: SerializableClaimableItem[];
    recipient?: string;
  };
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
  NotificationSettings: undefined;
  ExperimentalFeatures: undefined;
  BackupWallet: undefined;
  RestoreWallet: { isOnboarding?: boolean };
  WebView: {
    url: string;
    title: string;
  };
  // Remote Signer settings & account management
  RemoteSignerSettings: undefined;
  ExportAccounts: undefined;
  ImportRemoteSigner: undefined;
};

export type FriendsStackParamList = {
  FriendsList: undefined;
  FriendProfile: { envoiName: string };
  AddFriend: { initialQuery?: string } | undefined;
  MyProfile: undefined;
  MessagesInbox: undefined;
  NewMessage: undefined;
  Chat: { friendAddress: string; friendEnvoiName?: string; userAddress?: string };
};

// Airgap mode stack - minimal screens for offline signing device
// Note: Some screens are shared with RootStackParamList and have their own type expectations
export type AirgapStackParamList = {
  AirgapHome: undefined;
  ExportAccounts: undefined;
  SignRequestScanner: undefined;
  RemoteSignerTransactionReview: { request: RemoteSignerRequest };
  SignatureDisplay: { request: RemoteSignerRequest };
  ImportFromOnlineWallet: undefined;
  // Account management screens (accessible in airgap mode)
  // These use RootStackParamList types internally
  CreateAccount: undefined;
  MnemonicImport: { isOnboarding?: boolean };
  QRAccountImport: undefined;
  AccountImportPreview: { accounts: ScannedAccount[]; source: 'qr' };
  LedgerAccountImport: { deviceId?: string; isOnboarding?: boolean } | undefined;
};

// Import TransactionHistoryScreen directly to avoid async-require issues in EAS builds
import TransactionHistoryScreen from '@/screens/wallet/TransactionHistoryScreen';
import AccountInfoScreen from '@/screens/wallet/AccountInfoScreen';
import AccountSearchScreen from '@/screens/wallet/AccountSearchScreen';
import FriendsScreen from '@/screens/social/FriendsScreen';
import AddFriendScreen from '@/screens/social/AddFriendScreen';
import FriendProfileScreen from '@/screens/social/FriendProfileScreen';
import MyProfileScreen from '@/screens/social/MyProfileScreen';
import MessagesInboxScreen from '@/screens/social/MessagesInboxScreen';
import NewMessageScreen from '@/screens/social/NewMessageScreen';
import ChatScreen from '@/screens/social/ChatScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const WalletStack = createNativeStackNavigator<WalletStackParamList>();
const NFTStack = createNativeStackNavigator<NFTStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();
const FriendsStack = createNativeStackNavigator<FriendsStackParamList>();
const AirgapStack = createNativeStackNavigator<AirgapStackParamList>();
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
        <WalletStack.Screen name="Swap" component={SwapScreen} />
        <WalletStack.Screen
          name="TransactionConfirmation"
          component={TransactionConfirmationScreen}
        />
        <WalletStack.Screen
          name="UniversalTransactionSigning"
          component={UniversalTransactionSigningScreen}
        />
        <WalletStack.Screen
          name="TransactionResult"
          component={TransactionResultScreen}
        />
        <WalletStack.Screen name="Receive" component={ReceiveScreen} />
        <WalletStack.Screen name="ClaimableTokens" component={ClaimableTokensScreen} />
        <WalletStack.Screen name="ClaimToken" component={ClaimTokenScreen} />
        <WalletStack.Screen name="ClaimAllConfirmation" component={ClaimAllConfirmationScreen} />
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
        <NFTStack.Screen name="CollectionDetail" component={CollectionDetailScreen} />
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
        <SettingsStack.Screen
          name="NotificationSettings"
          component={NotificationSettingsScreen}
        />
        <SettingsStack.Screen
          name="ExperimentalFeatures"
          component={ExperimentalFeaturesScreen}
        />
        <SettingsStack.Screen name="BackupWallet" component={BackupWalletScreen} />
        <SettingsStack.Screen name="RestoreWallet" component={RestoreWalletScreen} />
        <SettingsStack.Screen name="WebView" component={WebViewScreen} />
        {/* Remote Signer settings & account management */}
        <SettingsStack.Screen
          name="RemoteSignerSettings"
          component={RemoteSignerSettingsScreen}
        />
        <SettingsStack.Screen
          name="ExportAccounts"
          component={ExportAccountsScreen}
        />
        <SettingsStack.Screen
          name="ImportRemoteSigner"
          component={ImportRemoteSignerScreen}
        />
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
        <FriendsStack.Screen name="MessagesInbox" component={MessagesInboxScreen} />
        <FriendsStack.Screen name="NewMessage" component={NewMessageScreen} />
        <FriendsStack.Screen name="Chat" component={ChatScreen} />
      </FriendsStack.Navigator>
    </NFTBackground>
  );
}

// Airgap mode stack navigator - minimal screens for offline signing device
function AirgapStackNavigator() {
  return (
    <NFTBackground>
      <AirgapStack.Navigator
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          gestureEnabled: true,
          gestureDirection: 'horizontal',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      >
        <AirgapStack.Screen name="AirgapHome" component={AirgapHomeScreen} />
        <AirgapStack.Screen name="ExportAccounts" component={ExportAccountsScreen} />
        <AirgapStack.Screen name="SignRequestScanner" component={SignRequestScannerScreen} />
        <AirgapStack.Screen name="ImportFromOnlineWallet" component={ImportFromOnlineWalletScreen} />
        <AirgapStack.Screen
          name="RemoteSignerTransactionReview"
          component={TransactionReviewScreen}
        />
        <AirgapStack.Screen name="SignatureDisplay" component={SignatureDisplayScreen} />
        {/* Account management screens */}
        <AirgapStack.Screen name="CreateAccount" component={CreateAccountScreen} />
        <AirgapStack.Screen name="MnemonicImport" component={MnemonicImportScreen} />
        <AirgapStack.Screen name="QRAccountImport" component={QRAccountImportScreen} />
        <AirgapStack.Screen
          name="AccountImportPreview"
          component={AccountImportPreviewScreen}
        />
        <AirgapStack.Screen
          name="LedgerAccountImport"
          component={LedgerAccountImportScreen}
        />
      </AirgapStack.Navigator>
    </NFTBackground>
  );
}

function MainTabNavigator() {
  const { updateActivity } = useAuth();
  const { theme, nftBackgroundEnabled } = useTheme();
  const styles = useThemedStyles(createStyles);
  const appMode = useAppMode();
  const isInitialized = useRemoteSignerStore((state) => state.isInitialized);
  const initStartedRef = useRef(false);

  // Initialize remote signer store on mount to get the correct app mode
  useEffect(() => {
    if (!isInitialized && !initStartedRef.current) {
      initStartedRef.current = true;
      useRemoteSignerStore.getState().initialize();
    }
  }, [isInitialized]);

  // Wait for remote signer store to initialize before rendering
  // This prevents briefly showing the wrong navigator and triggering unnecessary network calls
  if (!isInitialized) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background }} />
    );
  }

  const isSignerMode = appMode === 'signer';

  // Extract theme values to stable variables to avoid context issues in callbacks
  const primaryColor = theme.colors.primary;
  const tabIconActive = theme.colors.tabIconActive;
  const tabIconInactive = theme.colors.tabIconInactive;
  // Use solid background when no NFT background, semi-transparent when NFT is enabled
  const hasNFTBackground = !!theme.backgroundImageUrl && nftBackgroundEnabled;
  const tabBackground = hasNFTBackground
    ? theme.colors.tabBackground
    : theme.colors.background;
  const borderColor = hasNFTBackground ? theme.colors.border : 'transparent';

  // In signer/airgap mode, show simplified 2-tab layout (Home + Settings)
  // No Friends, Discover, NFTs tabs - no FAB menu
  if (isSignerMode) {
    return (
      <AuthGuard>
        <View style={{ flex: 1 }}>
          <Tab.Navigator
            screenOptions={({ route }) => ({
              tabBarIcon: ({ focused, color, size }) => {
                let iconName: keyof typeof Ionicons.glyphMap;

                if (route.name === 'Home') {
                  iconName = focused ? 'shield-checkmark' : 'shield-checkmark-outline';
                } else if (route.name === 'Settings') {
                  iconName = focused ? 'settings' : 'settings-outline';
                } else {
                  iconName = 'help-outline';
                }

                return <Ionicons name={iconName} size={size} color={color} />;
              },
              tabBarButton: (props) => {
                const handlePress = (e: any) => {
                  if (e?.preventDefault) {
                    e.preventDefault();
                  }
                  if (props.onPress) {
                    props.onPress(e);
                  }
                };
                return <TouchableOpacity {...props} onPress={handlePress} />;
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
              component={AirgapStackNavigator}
              options={{
                tabBarLabel: 'Signer',
              }}
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
          {/* No FAB menu in signer mode */}
        </View>
      </AuthGuard>
    );
  }

  // Normal wallet mode - full tab layout
  return (
    <AuthGuard>
      <View style={{ flex: 1 }}>
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
                // Hidden - FABRadialMenu handles this
                iconName = 'compass-outline';
              } else if (route.name === 'Settings') {
                iconName = focused ? 'settings' : 'settings-outline';
              } else {
                iconName = 'help-outline';
              }

              return <Ionicons name={iconName} size={size} color={color} />;
            },
            tabBarButton: (props) => {
              // Wrap all tab buttons in TouchableOpacity to prevent default web anchor behavior
              // which can cause full page navigation in Chrome extensions
              const handlePress = (e: any) => {
                // Prevent default browser navigation
                if (e?.preventDefault) {
                  e.preventDefault();
                }
                // Call the original onPress
                if (props.onPress) {
                  props.onPress(e);
                }
              };

              if (route.name === 'Discover') {
                // Invisible placeholder to reserve space for FABRadialMenu
                return (
                  <View style={styles.centerButtonPlaceholder} />
                );
              }
              return <TouchableOpacity {...props} onPress={handlePress} />;
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

        {/* FAB Radial Menu - rendered as overlay above tab bar */}
        <FABRadialMenu />
      </View>
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
        name="UniversalTransactionSigning"
        component={UniversalTransactionSigningScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="QRScanner"
        component={QRScannerScreen}
        options={{
          presentation: 'modal',
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
          presentation: 'modal',
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
      {/* Remote Signer signing flow screens */}
      <Stack.Screen
        name="SignRequestDisplay"
        component={SignRequestDisplayScreen}
        options={{
          headerShown: false,
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
          gestureDirection: 'vertical',
        }}
      />
      <Stack.Screen
        name="RestoreWallet"
        component={RestoreWalletScreen}
        options={{
          headerShown: false,
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
          gestureDirection: 'vertical',
        }}
      />
      <Stack.Screen
        name="SignatureScanner"
        component={SignatureScannerScreen}
        options={{
          headerShown: false,
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
          gestureDirection: 'vertical',
        }}
      />
      <Stack.Screen
        name="SignRequestScanner"
        component={SignRequestScannerScreen}
        options={{
          headerShown: false,
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
          gestureDirection: 'vertical',
        }}
      />
      <Stack.Screen
        name="RemoteSignerTransactionReview"
        component={TransactionReviewScreen}
        options={{
          headerShown: false,
        }}
      />
      <Stack.Screen
        name="SignatureDisplay"
        component={SignatureDisplayScreen}
        options={{
          headerShown: false,
        }}
      />
      {/* ARC-0090 deep link screens */}
      <Stack.Screen
        name="KeyregConfirm"
        component={KeyregConfirmScreen}
        options={{
          headerShown: false,
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
          gestureDirection: 'vertical',
        }}
      />
      <Stack.Screen
        name="AppCallConfirm"
        component={AppCallConfirmScreen}
        options={{
          headerShown: false,
          presentation: 'modal',
          animation: 'slide_from_bottom',
          gestureEnabled: true,
          gestureDirection: 'vertical',
        }}
      />
      <Stack.Screen
        name="AppInfoModal"
        component={AppInfoModal}
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
  const initializationRef = useRef<boolean>(false);
  const { initializeNetwork } = useNetworkStore();

  // Disable URL-based linking for Chrome extensions to prevent "file couldn't be accessed" errors
  const isExtension = Platform.OS === 'web' && detectPlatform() === 'extension';

  // For extensions, don't use any linking config - this completely disables URL-based navigation
  // which prevents full page reloads when switching tabs
  const linkingConfig = undefined;

  useEffect(() => {
    // Prevent double initialization (can happen with StrictMode or fast remounts)
    if (initializationRef.current) {
      return;
    }
    initializationRef.current = true;

    const initializeServices = async () => {
      try {
        // Get app mode BEFORE initializing network services
        // This avoids a race condition with store hydration
        const appMode = await getAppModeEarly();
        const isSignerMode = appMode === 'signer';

        // Initialize Network store (needed in both modes for basic config)
        await initializeNetwork();

        // Variables for cleanup - only defined if services are initialized
        let wcService: WalletConnectService | null = null;
        let onProposal: ((proposal: any) => void) | null = null;
        let onRequest: ((requestEvent: any) => Promise<void>) | null = null;

        // Skip internet-dependent services in signer mode (air-gapped device)
        if (!isSignerMode) {
          // Initialize WalletConnect service
          wcService = WalletConnectService.getInstance();
          await wcService.initialize();

          // Listen for WalletConnect session proposals and navigate to approval screen
          onProposal = (proposal: any) => {
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

          onRequest = async (requestEvent: any) => {
            try {
              if (navigationRef.current?.isReady?.()) {
                // Get current route name
                const currentRoute = navigationRef.current.getCurrentRoute();

                // Check if we're already on the TransactionRequestScreen
                if (currentRoute?.name === 'WalletConnectTransactionRequest') {
                  // Enqueue the request instead of navigating immediately
                  console.log('[AppNavigator] Currently on transaction screen, enqueueing request');
                  await TransactionRequestQueue.enqueue({
                    id: requestEvent.id,
                    topic: requestEvent.topic,
                    params: requestEvent.params,
                  });
                } else {
                  // Navigate immediately if not on transaction screen
                  navigationRef.current.navigate(
                    'WalletConnectTransactionRequest',
                    { requestEvent }
                  );
                }
              }
            } catch (err) {
              console.error(
                'Failed to handle WalletConnect transaction request:',
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

          // Initialize extension-specific deep link handling (for WalletConnect URIs from getvoi.app)
          if (Platform.OS === 'web' && detectPlatform() === 'extension') {
            extensionDeepLinkHandler.initialize(async (uri: string) => {
              console.log('[AppNavigator] Extension received WC URI:', uri);
              if (isWalletConnectUri(uri)) {
                await deepLinkService.testDeepLink(uri);
              }
            });
          }

          console.log('WalletConnect and DeepLink services initialized');

          // Initialize push notification service
          try {
            await notificationService.initialize();
            console.log('Notification service initialized');

            // Check if user has a wallet and auto-subscribe all accounts to notifications
            const wallet = await MultiAccountWalletService.getCurrentWallet();
            if (wallet && wallet.accounts.length > 0) {
              // Register push token if permissions granted
              const token = await notificationService.registerPushToken();
              if (token) {
                // Subscribe ALL accounts to notifications (not just active one)
                // Watch accounts will have message notifications disabled by default
                await notificationService.subscribeAllAccounts(wallet.accounts);

                // TODO: Re-enable realtime subscription when needed
                // Currently disabled to reduce server load - using polling instead
                // const allAddresses = wallet.accounts.map(a => a.address);
                // await realtimeService.subscribeToAddresses(allAddresses);
              }
            }
          } catch (error) {
            console.warn('Failed to initialize notification services:', error);
            // Don't block app startup for notification initialization failures
          }

          // Reset stale processing state from previous session (prevents deadlock after crash)
          await TransactionRequestQueue.setProcessing(false);

          // Process any pending transaction requests from the queue
          try {
            const hasQueuedRequests = !(await TransactionRequestQueue.isEmpty());
            if (hasQueuedRequests) {
              console.log('[AppNavigator] Processing queued transaction requests on startup');
              const nextRequest = await TransactionRequestQueue.peek();
              if (nextRequest && navigationRef.current) {
                // Dequeue and navigate to the first request
                await TransactionRequestQueue.dequeue();
                navigationRef.current.navigate('WalletConnectTransactionRequest', {
                  requestEvent: nextRequest,
                  version: nextRequest.version,
                });
              }
            }
          } catch (error) {
            console.error('[AppNavigator] Failed to process queued requests:', error);
          }
        } else {
          console.log('[AppNavigator] Signer mode: skipping network services (WalletConnect, DeepLink, Notifications)');
        }

        // Initialize Ledger transport service (useful in BOTH modes for hardware wallet signing)
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

        return () => {
          try {
            if (wcService && onProposal) {
              wcService.off?.('session_proposal', onProposal);
            }
            if (wcService && onRequest) {
              wcService.off?.('session_request', onRequest);
            }
            if (!isSignerMode) {
              extensionDeepLinkHandler.cleanup();
              notificationService.cleanup();
            }
            // realtimeService.cleanup(); // Disabled - realtime subscription not active
          } catch {}
        };
      } catch (error) {
        console.error('Failed to initialize services:', error);
      }
    };

    initializeServices();
  }, []);

  // Load dismissed update ID from storage on mount
  useEffect(() => {
    if (!__DEV__) {
      useUpdateStore.getState().loadDismissedUpdateId();
    }
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <BottomSheetModalProvider>
          <NavigationContainer
            ref={navigationRef}
            linking={linkingConfig}
            documentTitle={{ enabled: false }}
          >
            <NavigationActivityWrapper />
          </NavigationContainer>
        </BottomSheetModalProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    centerButtonPlaceholder: {
      width: 60,
      height: 60,
      // Invisible placeholder to reserve space for FABRadialMenu
    },
  });
