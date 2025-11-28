const IS_DEV = process.env.APP_VARIANT === 'development';
const WALLETCONNECT_PROJECT_ID =
  process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  process.env.WALLETCONNECT_PROJECT_ID ||
  '';

const withAndroidJvmTarget = require('./plugins/withAndroidJvmTarget');
const withExpoModulesProguard = require('./plugins/withExpoModulesProguard');

export default {
  "expo": {
    "name": IS_DEV ? "Voi Wallet (Dev)" : "Voi Wallet",
    "slug": "voi-wallet",
    "version": "0.1.7",
    "orientation": "portrait",
    "icon": "./assets/voi_wallet_logo.png",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "scheme": "voi",
    "platforms": ["ios", "android"],
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
      "buildNumber": "12",
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
        "NSBluetoothAlwaysUsageDescription": "This app uses Bluetooth to connect to Ledger devices."
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
      "versionCode": 12,
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
      "eas": {
        "projectId": "48f3eead-a427-4651-9b06-6b952fc8b84d"
      }
    },
    "plugins": [
      [
        "expo-build-properties",
        {
          android: {
            kotlinVersion: "2.0.0",
            compileSdkVersion: 35,
            targetSdkVersion: 35,
            buildToolsVersion: "35.0.0",
            minSdkVersion: 24,
          },
        },
      ],
      withAndroidJvmTarget,
      withExpoModulesProguard,
    ]
  }
};
