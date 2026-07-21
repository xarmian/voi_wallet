// Import crypto polyfills for algosdk compatibility
import 'react-native-get-random-values';
import { Buffer } from 'buffer';

// Set up global Buffer for algosdk
global.Buffer = Buffer;

// Import WalletConnect polyfills
import './src/utils/polyfills';

// Keep the branded native splash up through the whole cold-boot init cascade
// (F-48, TASK-182). preventAutoHideAsync() MUST run at module scope, before the
// first RN frame renders. It is placed AFTER the crypto polyfills above on
// purpose: it uses no crypto, so their global setup (get-random-values, Buffer,
// WC polyfills) still runs first. hideSplashScreen() (readiness owner in
// AppStack) tears the splash down once the first real content frame is ready;
// the watchdog is a last-resort safety net so a hang can never trap the user.
import * as SplashScreen from 'expo-splash-screen';
import { armSplashWatchdog } from './src/utils/splashController';

// Best-effort: rejects on platforms without the native module (web); the app
// must still boot, so swallow. armSplashWatchdog guarantees an eventual hide.
SplashScreen.preventAutoHideAsync().catch(() => {});
armSplashWatchdog();

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
