// Import crypto polyfills for algosdk compatibility
import 'react-native-get-random-values';
import { Buffer } from 'buffer';

// Set up global Buffer for algosdk
global.Buffer = Buffer;

// Import WalletConnect polyfills
import './src/utils/polyfills';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
