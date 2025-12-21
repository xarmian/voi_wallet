const IS_DEV = process.env.APP_VARIANT === 'development';
const WALLETCONNECT_PROJECT_ID =
  process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  process.env.WALLETCONNECT_PROJECT_ID ||
  '';
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

const withAndroidJvmTarget = require('./plugins/withAndroidJvmTarget');
const withExpoModulesProguard = require('./plugins/withExpoModulesProguard');

export default {
  "expo": {
    "name": IS_DEV ? "Voi Wallet (Dev)" : "Voi Wallet",
    "slug": "voi-wallet",
    "version": "0.1.10",
    "orientation": "portrait",
    "icon": "./assets/voi_wallet_logo.png",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "scheme": "voi",
    "platforms": ["ios", "android"],
    "updates": {
      "enabled": true,
      "fallbackToCacheTimeout": 0,
      "checkAutomatically": "ON_ERROR_RECOVERY",
      "url": "https://u.expo.dev/48f3eead-a427-4651-9b06-6b952fc8b84d"
    },
    "runtimeVersion": {
      "policy": "appVersion"
    },
    "splash": {
      "image": "./assets/voi_wallet_logo.png",
      "resizeMode": "contain",
      "backgroundColor": "#FFFFFF",
      "dark": {
        "image": "./assets/voi_wallet_logo.png",
        "backgroundColor": "#000000"
      }
    },
    "assetBundlePatterns": [
      "**/*"
    ],
    "ios": {
      "supportsTablet": true,
      "jsEngine": "hermes",
      "bundleIdentifier": IS_DEV ? "com.voinetwork.wallet.dev" : "com.voinetwork.wallet",
      "buildNumber": "21",
      "icon": "./assets/voi_wallet_logo.png",
      "splash": {
        "image": "./assets/voi_wallet_logo.png",
        "resizeMode": "contain",
        "backgroundColor": "#FFFFFF",
        "dark": {
          "image": "./assets/voi_wallet_logo.png",
          "backgroundColor": "#000000"
        }
      },
      "associatedDomains": ["applinks:www.getvoi.app"],
      "infoPlist": {
        "CFBundleURLTypes": [
          {
            "CFBundleURLName": "WalletConnect",
            "CFBundleURLSchemes": ["wc", "voi"]
          }
        ],
        "ITSAppUsesNonExemptEncryption": false,
        "NSCameraUsageDescription": "This app uses the camera to scan QR codes for wallet connections and transactions.",
        "NSFaceIDUsageDescription": "This app uses Face ID for secure wallet authentication.",
        "NSBluetoothAlwaysUsageDescription": "This app uses Bluetooth to connect to Ledger devices.",
        "UIBackgroundModes": ["remote-notification"]
      }
    },
    "android": {
      "adaptiveIcon": {
        "foregroundImage": "./assets/voi_wallet_logo.png",
        "backgroundColor": "#FFFFFF"
      },
      "jsEngine": "hermes",
      "edgeToEdgeEnabled": true,
      "predictiveBackGestureEnabled": false,
      "package": IS_DEV ? "com.voinetwork.wallet.dev" : "com.voinetwork.wallet",
      "googleServicesFile": IS_DEV ? "./google-services-dev.json" : "./google-services.json",
      "versionCode": 21,
      "permissions": [
        "CAMERA",
        "USE_BIOMETRIC",
        "USE_FINGERPRINT"
      ],
      "intentFilters": [
        {
          "action": "VIEW",
          "category": ["DEFAULT", "BROWSABLE"],
          "data": [
            { "scheme": "wc" },
            { "scheme": "voi" }
          ]
        },
        {
          "action": "VIEW",
          "autoVerify": true,
          "category": ["DEFAULT", "BROWSABLE"],
          "data": [
            {
              "scheme": "https",
              "host": "www.getvoi.app",
              "pathPrefix": "/wc"
            }
          ]
        }
      ]
    },
    "web": {
      "favicon": "./assets/voi_wallet_logo.png"
    },
    "extra": {
      "walletConnectProjectId": WALLETCONNECT_PROJECT_ID || undefined,
      "supabaseUrl": SUPABASE_URL || undefined,
      "supabaseAnonKey": SUPABASE_ANON_KEY || undefined,
      "eas": {
        "projectId": "48f3eead-a427-4651-9b06-6b952fc8b84d"
      }
    },
    "plugins": [
      [
        "expo-build-properties",
        {
          android: {
            kotlinVersion: "2.1.20",
            compileSdkVersion: 35,
            targetSdkVersion: 35,
            buildToolsVersion: "35.0.0",
            minSdkVersion: 24,
          },
        },
      ],
      [
        "expo-notifications",
        {
          "icon": "./assets/voi_wallet_logo_crop.png",
          "color": "#8B5CF6"
        }
      ],
      "expo-secure-store",
      withAndroidJvmTarget,
      withExpoModulesProguard,
    ]
  }
};
