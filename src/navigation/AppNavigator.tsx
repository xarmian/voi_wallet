import React, { useEffect, useRef, Suspense } from 'react';
import {
  NavigationContainer,
  StackActions,
  NavigatorScreenParams,
} from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  View,
  TouchableOpacity,
  TouchableOpacityProps,
  StyleSheet,
} from 'react-native';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
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
import UniversalTransactionSigningScreen from '@/screens/wallet/UniversalTransactionSigningScreen';
import ReceiveScreen from '@/screens/wallet/ReceiveScreen';
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
import SecureStorageUnavailableScreen from '@/screens/auth/SecureStorageUnavailableScreen';
import QRAccountImportScreen from '@/screens/account/QRAccountImportScreen';
import AccountImportPreviewScreen from '@/screens/account/AccountImportPreviewScreen';
import CreateWalletScreen from '@/screens/onboarding/CreateWalletScreen';
// ARC-0090 transaction screens
import KeyregConfirmScreen from '@/screens/transaction/KeyregConfirmScreen';
import AppCallConfirmScreen from '@/screens/transaction/AppCallConfirmScreen';
import AppInfoModal from '@/screens/app/AppInfoModal';
import { useAppMode, useRemoteSignerStore } from '@/store/remoteSignerStore';
import { useWalletStore } from '@/store/walletStore';
import {
  hideSplashScreen,
  isColdBootContentReady,
} from '@/utils/splashController';
import { RemoteSignerRequest } from '@/types/remoteSigner';
import SecuritySetupScreen from '@/screens/onboarding/SecuritySetupScreen';
import AuthGuard from '@/components/AuthGuard';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkId } from '@/types/network';
import { TransactionInfo, WalletAccount } from '@/types/wallet';
import { ScannedAccount } from '@/utils/accountQRParser';
import { NFTToken, ARC72Collection } from '@/types/nft';
import { SerializableClaimableItem } from '@/types/claimable';
import { NFTBackground } from '@/components/common/NFTBackground';
import { FABRadialMenu } from '@/components/navigation/FABRadialMenu';
import { useUpdateStore } from '@/store/updateStore';
import { initializeServices } from './serviceBootstrap';

// Import TransactionHistoryScreen directly to avoid async-require issues in EAS builds
import TransactionHistoryScreen from '@/screens/wallet/TransactionHistoryScreen';
import AccountInfoScreen from '@/screens/wallet/AccountInfoScreen';
import AccountSearchScreen from '@/screens/wallet/AccountSearchScreen';
import VerifyBackupScreen from '@/screens/wallet/VerifyBackupScreen';
import FriendsScreen from '@/screens/social/FriendsScreen';
import AddFriendScreen from '@/screens/social/AddFriendScreen';
import FriendProfileScreen from '@/screens/social/FriendProfileScreen';
import MyProfileScreen from '@/screens/social/MyProfileScreen';
import MessagesInboxScreen from '@/screens/social/MessagesInboxScreen';
import NewMessageScreen from '@/screens/social/NewMessageScreen';
import ChatScreen from '@/screens/social/ChatScreen';

// ---------------------------------------------------------------------------
// Code-split rarely-used screen clusters (F-01, TASK-176)
//
// These clusters pull in the heaviest / least-used slices of the module graph
// (WalletConnect ↔ @walletconnect, Swap ↔ @txnlab/deflex, remote-signer,
// Ledger import, claim flows). Loading them with React.lazy defers their module
// factories to first navigation instead of evaluating them at cold boot, which
// is the module-graph cost F-01 targets. HomeScreen + core navigation stay
// eager. NOTE: this defers the SCREEN modules only; the ledger transport service
// (imported at module scope below) and the realtime singleton (pulled via
// walletStore) are deferred by separate tasks (TASK-180 / realtime scoping).
//
// Each lazy screen needs its own Suspense boundary: native-stack does not
// provide one, and a suspended component without a boundary throws. The split
// module resolves from the already-loaded production bundle within ~a frame, so
// a neutral transparent fallback avoids a visible flash without theme coupling.
function LazyScreenFallback() {
  return <View style={{ flex: 1 }} />;
}

// Return type is intentionally inferred as a function component: annotating it as
// React.ComponentType<P> would union in ComponentClass<P>, which fails React
// Navigation's ScreenComponentType variance check for screens that take a
// required `navigation` prop without `route`.
function lazyScreen<P extends object>(
  factory: () => Promise<{ default: React.ComponentType<P> }>
) {
  const LazyComponent = React.lazy(factory);
  return function SuspendedScreen(props: P) {
    return (
      <Suspense fallback={<LazyScreenFallback />}>
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}

// Swap (→ services/swap → @txnlab/deflex)
const SwapScreen = lazyScreen(() => import('@/screens/wallet/SwapScreen'));

// Claim flows
const ClaimableTokensScreen = lazyScreen(
  () => import('@/screens/wallet/ClaimableTokensScreen')
);
const ClaimTokenScreen = lazyScreen(
  () => import('@/screens/wallet/ClaimTokenScreen')
);
const ClaimAllConfirmationScreen = lazyScreen(
  () => import('@/screens/wallet/ClaimAllConfirmationScreen')
);

// WalletConnect screens (→ @walletconnect/*)
const SessionProposalScreen = lazyScreen(
  () => import('@/screens/walletconnect/SessionProposalScreen')
);
const SessionsScreen = lazyScreen(
  () => import('@/screens/walletconnect/SessionsScreen')
);
const TransactionRequestScreen = lazyScreen(
  () => import('@/screens/walletconnect/TransactionRequestScreen')
);
const QRScannerScreen = lazyScreen(
  () => import('@/screens/walletconnect/QRScannerScreen')
);
const WalletConnectPairingScreen = lazyScreen(
  () => import('@/screens/walletconnect/WalletConnectPairingScreen')
);
const WalletConnectErrorScreen = lazyScreen(
  () => import('@/screens/walletconnect/WalletConnectErrorScreen')
);

// Ledger import screen (screen module only; transport service import is TASK-180)
const LedgerAccountImportScreen = lazyScreen(
  () => import('@/screens/account/LedgerAccountImportScreen')
);

// Remote Signer screens
const AirgapHomeScreen = lazyScreen(
  () => import('@/screens/remoteSigner/AirgapHomeScreen')
);
const ExportAccountsScreen = lazyScreen(
  () => import('@/screens/remoteSigner/ExportAccountsScreen')
);
const ImportRemoteSignerScreen = lazyScreen(
  () => import('@/screens/remoteSigner/ImportRemoteSignerScreen')
);
const RemoteSignerSettingsScreen = lazyScreen(
  () => import('@/screens/remoteSigner/RemoteSignerSettingsScreen')
);
const SignRequestScannerScreen = lazyScreen(
  () => import('@/screens/remoteSigner/SignRequestScannerScreen')
);
const TransactionReviewScreen = lazyScreen(
  () => import('@/screens/remoteSigner/TransactionReviewScreen')
);
const SignatureDisplayScreen = lazyScreen(
  () => import('@/screens/remoteSigner/SignatureDisplayScreen')
);
const ImportFromOnlineWalletScreen = lazyScreen(
  () => import('@/screens/remoteSigner/ImportFromOnlineWalletScreen')
);

export type RootStackParamList = {
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  Onboarding: undefined;
  CreateWallet: undefined;
  SecuritySetup: {
    mnemonic?: string;
    accounts?: ScannedAccount[];
    // 'restore' = post-restore PIN setup (no import branch runs; setupPin only).
    // RestoreWalletScreen already navigates with it via CommonActions.reset, and
    // TASK-213's cold-boot resume routes here with it as the initial param.
    source?: 'create' | 'qr' | 'watch' | 'mnemonic' | 'ledger' | 'restore';
    accountLabel?: string;
    /**
     * TASK-45 / DR-11 carrier #1 — whether the user completed the
     * recovery-phrase verification quiz on CreateWalletScreen. Consumed by
     * SecuritySetupScreen at import time. A BOOLEAN, not key material: it does
     * not widen the DR-9 mnemonic-in-nav-state exposure. Absent/false persists
     * the account as un-backed-up (the safe default).
     */
    backupVerified?: boolean;
  };
  MnemonicImport: { isOnboarding?: boolean } | undefined;
  AddWatchAccount: { isOnboarding?: boolean };
  WalletConnectSessionProposal: {
    proposal: any;
    version?: number;
    sessionRequest?: any;
  };
  WalletConnectSessions: undefined;
  WalletConnectTransactionRequest: { requestEvent: any; version?: number };
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
  SignRequestScanner: undefined;
  RemoteSignerTransactionReview: {
    request: RemoteSignerRequest;
  };
  SignatureDisplay: {
    request: RemoteSignerRequest;
  };
  RestoreWallet: { isOnboarding?: boolean } | undefined;
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
  // In normal mode Home mounts the WalletStack; in signer/airgap mode it
  // mounts the AirgapStack (see MainTabNavigator). Accept both param shapes
  // (plus undefined so `navigate('Main', { screen: 'Home' })` stays valid).
  Home:
    | NavigatorScreenParams<WalletStackParamList>
    | NavigatorScreenParams<AirgapStackParamList>
    | undefined;
  Friends: NavigatorScreenParams<FriendsStackParamList> | undefined;
  NFTs: NavigatorScreenParams<NFTStackParamList> | undefined;
  Discover: { reload?: number } | undefined;
  Settings: NavigatorScreenParams<SettingsStackParamList> | undefined;
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
  Send:
    | {
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
      }
    | undefined;
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
    /** ID to retrieve callbacks from registry (avoids serialization warnings) */
    callbackId?: string;
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
    confirmed?: boolean;
    errorMessage?: string;
    networkId?: NetworkId;
  };
  Receive:
    | {
        assetName?: string;
        assetId?: number;
        accountId?: string;
      }
    | undefined;
  AccountInfo: { address?: string } | undefined;
  AccountSearch: undefined;
  ClaimableTokens:
    | { pendingRefresh?: boolean; claimedItemIds?: string[] }
    | undefined;
  ClaimToken: {
    claimableItem: SerializableClaimableItem;
  };
  ClaimAllConfirmation: {
    items: SerializableClaimableItem[];
    recipient?: string;
  };
  /**
   * TASK-45 — confirm an existing account's recovery phrase, clearing the Home
   * un-backed-up warning. Carries the ADDRESS only; the screen loads the phrase
   * itself through the PIN/biometric-gated SecureKeyManager, so no key material
   * enters navigation state (DR-9).
   */
  VerifyBackup: { accountAddress?: string } | undefined;
};

export type NFTStackParamList = {
  NFTMain: undefined;
  CollectionDetail: {
    collection: ARC72Collection;
  };
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
    confirmed?: boolean;
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
  MnemonicImport: { isOnboarding?: boolean } | undefined;
  RekeyAccount: {
    accountId: string;
  };
  AboutScreen: undefined;
  NotificationSettings: undefined;
  ExperimentalFeatures: undefined;
  BackupWallet: undefined;
  RestoreWallet: { isOnboarding?: boolean } | undefined;
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
  Chat: {
    friendAddress: string;
    friendEnvoiName?: string;
    userAddress?: string;
  };
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
  MnemonicImport: { isOnboarding?: boolean } | undefined;
  QRAccountImport: undefined;
  AccountImportPreview: { accounts: ScannedAccount[]; source: 'qr' };
  LedgerAccountImport:
    | { deviceId?: string; isOnboarding?: boolean }
    | undefined;
};

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
        <WalletStack.Screen
          name="MultiNetworkAsset"
          component={MultiNetworkAssetScreen}
        />
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
        <WalletStack.Screen
          name="ClaimableTokens"
          component={ClaimableTokensScreen}
        />
        <WalletStack.Screen name="ClaimToken" component={ClaimTokenScreen} />
        <WalletStack.Screen
          name="ClaimAllConfirmation"
          component={ClaimAllConfirmationScreen}
        />
        <WalletStack.Screen name="AccountInfo" component={AccountInfoScreen} />
        <WalletStack.Screen
          name="AccountSearch"
          component={AccountSearchScreen}
        />
        <WalletStack.Screen
          name="VerifyBackup"
          component={VerifyBackupScreen}
        />
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
        <NFTStack.Screen
          name="CollectionDetail"
          component={CollectionDetailScreen}
        />
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
        <SettingsStack.Screen
          name="BackupWallet"
          component={BackupWalletScreen}
        />
        <SettingsStack.Screen
          name="RestoreWallet"
          component={RestoreWalletScreen}
        />
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
        <FriendsStack.Screen
          name="FriendProfile"
          component={FriendProfileScreen}
        />
        <FriendsStack.Screen name="MyProfile" component={MyProfileScreen} />
        <FriendsStack.Screen
          name="MessagesInbox"
          component={MessagesInboxScreen}
        />
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
        <AirgapStack.Screen
          name="ExportAccounts"
          component={ExportAccountsScreen}
        />
        <AirgapStack.Screen
          name="SignRequestScanner"
          component={SignRequestScannerScreen}
        />
        <AirgapStack.Screen
          name="ImportFromOnlineWallet"
          component={ImportFromOnlineWalletScreen}
        />
        <AirgapStack.Screen
          name="RemoteSignerTransactionReview"
          component={TransactionReviewScreen}
        />
        <AirgapStack.Screen
          name="SignatureDisplay"
          component={SignatureDisplayScreen}
        />
        {/* Account management screens */}
        <AirgapStack.Screen
          name="CreateAccount"
          component={CreateAccountScreen}
        />
        <AirgapStack.Screen
          name="MnemonicImport"
          component={MnemonicImportScreen}
        />
        <AirgapStack.Screen
          name="QRAccountImport"
          component={QRAccountImportScreen}
        />
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
                  iconName = focused
                    ? 'shield-checkmark'
                    : 'shield-checkmark-outline';
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
                return (
                  <TouchableOpacity
                    {...(props as TouchableOpacityProps)}
                    onPress={handlePress}
                  />
                );
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
                return <View style={styles.centerButtonPlaceholder} />;
              }
              return (
                <TouchableOpacity
                  {...(props as TouchableOpacityProps)}
                  onPress={handlePress}
                />
              );
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
  // Subscribe to the init-cascade gates this component (the splash readiness
  // owner) must cover, so it re-renders as each resolves:
  //   - remote-signer gate (MainTabNavigator's `isInitialized`) — gate 2,
  //   - app mode (decided by that same gate) — selects signer vs wallet Home,
  //   - wallet-store hydration (`isInitialized`) — gate 3, cached balances in
  //     state so the normal-wallet Home renders real content, not its
  //     "Loading wallet..." placeholder.
  const isSignerInitialized = useRemoteSignerStore(
    (state) => state.isInitialized
  );
  const appMode = useAppMode();
  const isWalletInitialized = useWalletStore((state) => state.isInitialized);
  // TASK-213: derive the initial route from the SINGLE authoritative auth verdict
  // (AuthContext.checkInitialAuthState) instead of a second, error-SWALLOWING
  // wallet read. That verdict distinguishes a storage read FAILURE (→ recovery,
  // below) from genuine absence (→ Onboarding) and presence (→ Main) with bounded
  // retry, so the route can NEVER diverge from the fail-closed lock state — e.g.
  // a stale Onboarding route can no longer expose the UN-guarded setup flow after
  // a recovery Retry or a transient blip (AuthGuard only wraps `Main`). hasWallet
  // is meaningful only once authChecked is true, which gates the render below.
  const { authState, recheckAuthState } = useAuth();
  // TASK-213 (restore-before-PIN): when the boot verdict is "resume PIN setup"
  // (a restore persisted key-bearing accounts but was cold-killed before the PIN),
  // the initial route is SecuritySetup(source:'restore') — NOT Main and NOT the
  // recovery screen. This must take precedence over the hasWallet→Main derivation
  // (a restored wallet HAS accounts, so hasWallet is true here). SecuritySetup is
  // an unguarded route; Main is only ever reached from it AFTER setupPin succeeds
  // (which sets a PIN and clears the breadcrumb), so this never exposes the wallet.
  const initialRoute: keyof RootStackParamList = authState.pinSetupResume
    ? 'SecuritySetup'
    : authState.hasWallet
      ? 'Main'
      : 'Onboarding';

  // Single readiness owner for the native splash (F-48, TASK-182). Hide it only
  // once the FIRST real content frame can render — covering ALL gates of the init
  // cascade (auth verdict + remote-signer + wallet-store hydration). See
  // isColdBootContentReady() for the exact gate/scoping rules; in short, on the
  // common existing-wallet cold start it also waits for the wallet store's cached
  // balances so the splash never lifts onto Home's "Loading wallet..." placeholder.
  //
  // This effect runs AFTER commit, so the content it gates on is already painted
  // when the splash lifts — no blank flash. Every gate is guaranteed to resolve
  // (or throw) so this cannot silently stall: checkInitialAuthState() always
  // reaches a terminal setAuthState that sets authChecked (locked, unlocked-setup,
  // recovery, and the defensive catch alike); remoteSignerStore.initialize()
  // always sets isInitialized (even on its caught-error path); and
  // walletStore.initialize() — kicked off early in initializeServices() AND again
  // by Home's mount effect — always sets isInitialized (success and caught-error
  // paths alike). The error boundary and the index.ts watchdog cover the
  // render-throw and hard-hang cases as belt-and-suspenders.
  //
  // The recovery screen is real, ready-to-paint content — lift the splash for it
  // regardless of the route's normal gates (e.g. a Main route whose signer/wallet
  // stores haven't hydrated must not keep the splash over the recovery screen).
  const contentReady =
    authState.securityUnavailable ||
    isColdBootContentReady({
      routeResolved: authState.authChecked,
      isMainRoute: initialRoute === 'Main',
      signerInitialized: isSignerInitialized,
      isSignerMode: appMode === 'signer',
      walletInitialized: isWalletInitialized,
    });
  useEffect(() => {
    if (contentReady) {
      void hideSplashScreen();
    }
  }, [contentReady]);

  // Fail-closed recovery (TASK-213): secure storage was found unreadable at boot.
  // Render ONLY the recovery screen — over every route, including the unguarded
  // onboarding flow — so the app grants ZERO wallet access until it recovers.
  if (authState.securityUnavailable) {
    return <SecureStorageUnavailableScreen onRetry={recheckAuthState} />;
  }

  // Wait for the auth-init verdict before mounting ANY route: the navigator's
  // Onboarding branch is UN-guarded, so it must not mount until authChecked has
  // resolved whether this is genuine absence (→ Onboarding) or a failure
  // (→ recovery, above). initialRouteName is honored only at this first mount, so
  // gating here guarantees the mounted route matches the settled auth verdict.
  if (!authState.authChecked) {
    return null; // Native splash stays up until the first content frame.
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
      <Stack.Screen
        name="CreateWallet"
        component={CreateWalletScreen}
        // U-10 / TASK-45: this screen holds the ONLY copy of a freshly generated
        // recovery phrase. It inherits gestureEnabled: true from screenOptions,
        // and on native-stack a swipe-back cannot be reliably cancelled from a
        // beforeRemove listener once it has begun — so the gesture is disabled
        // outright and the screen's beforeRemove listener guards the remaining
        // pop paths (header back, Android hardware back).
        options={{ gestureEnabled: false }}
      />
      <Stack.Screen
        name="SecuritySetup"
        component={SecuritySetupScreen}
        // TASK-213: when SecuritySetup is the INITIAL route (the restore-before-PIN
        // resume), it is mounted without navigation params, so seed source:'restore'
        // here. Harmless otherwise — an explicit navigate() (create/import/ledger)
        // provides its own params, which override these initial defaults.
        initialParams={
          authState.pinSetupResume ? { source: 'restore' } : undefined
        }
      />
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
      <Stack.Screen
        name="WalletConnectPairing"
        component={WalletConnectPairingScreen}
      />
      <Stack.Screen
        name="WalletConnectError"
        component={WalletConnectErrorScreen}
      />
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
  // Holds the teardown produced by the async initializeServices() below. The
  // effect boots services asynchronously, so its own synchronous return can't
  // capture the closure directly (awaiting it would wrap it in a Promise and
  // discard it). initializeServices assigns the teardown here; the effect's
  // synchronous cleanup invokes it on unmount. See TASK-243.
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  // Tracks whether the mount effect has torn down. It is reset at the START of
  // every effect run (including StrictMode's second pass, where the guard below
  // skips re-init) so a boot that finishes while the component is LIVE is never
  // mistaken for one that finished after unmount. See TASK-243.
  const disposedRef = useRef<boolean>(false);
  const { initializeNetwork } = useNetworkStore();

  // For extensions, don't use any linking config - this completely disables URL-based navigation
  // which prevents full page reloads when switching tabs
  const linkingConfig = undefined;

  useEffect(() => {
    disposedRef.current = false;

    // Synchronous teardown. initializeServices assigns the real teardown to
    // cleanupRef once its async boot reaches the WalletConnect/notification
    // wiring; on unmount we invoke whatever is there (undefined if boot hasn't
    // gotten that far yet — in which case the boot tears itself down via
    // isDisposed). This restores the WalletConnect handler unregister and
    // extensionDeepLinkHandler/notificationService cleanup on unmount.
    const runCleanup = () => {
      disposedRef.current = true;
      // Reading cleanupRef.current at cleanup time is INTENTIONAL and the whole
      // point (TASK-243): the async boot assigns the teardown AFTER this effect
      // body returns, so we must read the latest value on unmount. Copying
      // .current into a variable in the effect body would capture undefined
      // (boot hasn't completed) and defeat the teardown.
      cleanupRef.current?.();
    };

    // Prevent double initialization (can happen with StrictMode or fast
    // remounts). Even when the guard skips re-init we STILL return the teardown
    // wiring, so under StrictMode the live (second) effect tears services down
    // on the real unmount instead of leaving the discarded first pass to do it.
    if (initializationRef.current) {
      return runCleanup;
    }
    initializationRef.current = true;

    initializeServices({
      navigationRef,
      initializeNetwork,
      cleanupRef,
      isDisposed: () => disposedRef.current,
    });

    return runCleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- whole-app service boot; runs once (guarded by initializationRef) and initializeNetwork is read at the mount commit. Re-running on its identity would re-boot services.
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
