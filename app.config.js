const IS_DEV = process.env.APP_VARIANT === 'development';
const WALLETCONNECT_PROJECT_ID =
  process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID ||
  process.env.WALLETCONNECT_PROJECT_ID ||
  '';
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

const withAndroidJvmTarget = require('./plugins/withAndroidJvmTarget');

// R8 keep rules for Android release builds (TASK-209 / PLAN-267).
//
// These live here rather than in a custom config plugin because
// expo-build-properties purges and rewrites its own tagged block on every
// prebuild, whereas a plugin that appends behind a string-marker check goes
// stale silently once the rules are edited.
//
// WHY EACH BLOCK EXISTS — do not trim without reading PLAN-267 DR-2. React
// Native 0.81.5 ships exactly ONE consumer proguard file
// (ReactAndroid/proguard-rules.pro, wired at ReactAndroid/build.gradle.kts:504).
// Two further rule files exist in the RN tree — reactnative.pro and fbjni.pro —
// but are referenced by NO gradle script, so their rules are absent from the
// build and this app must supply them itself.
const ANDROID_PROGUARD_RULES = `
# --- Expo Modules ---
# Carried over verbatim from the deleted plugins/withExpoModulesProguard.js so
# that removal is provably lossless. The two kotlin lines are redundant under
# expo.modules.** (proguard's "class" matches interfaces too); kept for parity.
-keep class expo.modules.** { *; }
-keep class expo.modules.kotlin.** { *; }
-keep interface expo.modules.kotlin.** { *; }

# --- fbjni hybrid pattern ---
# Mirrors the unreferenced react-native/.../hermes/reactexecutor/fbjni.pro.
# HybridData is resolved by FIELD NAME from C++; renaming it breaks JNI init.
# react-native-nitro-modules carries unannotated mHybridData fields
# (ArrayBuffer.kt:29, AnyValue.kt:25, NitroModules.kt:20).
-keepclassmembers class * {
    com.facebook.jni.HybridData *;
    <init>(com.facebook.jni.HybridData);
}
-keepclasseswithmembers class * {
    com.facebook.jni.HybridData *;
}

# --- RN annotation-processor generated classes ---
# Mirrors the unreferenced react-native/.../react/bridge/reactnative.pro:15-18.
# ViewManagerPropertyUpdater.kt:130 does Class.forName("<cls>$$PropsSetter") —
# @react-native-community/slider is a SimpleViewManager, NOT a NativeModule, so
# proguard-rules.pro:44 does not cover it. react-native-gesture-handler
# (RNGestureHandlerPackage.kt:57) and @react-native-async-storage
# (AsyncStoragePackage.java:48) do Class.forName("<cls>$$ReactModuleInfoProvider")
# and fall back to reading @ReactModule reflectively — so a stripped annotation
# is a STARTUP CRASH, not a degradation. "{ *; }" is stronger than RN's bare
# -keep because both sites call newInstance(), needing the default constructor.
-keepnames class * extends com.facebook.react.uimanager.ViewManager
-keepnames class * extends com.facebook.react.uimanager.ReactShadowNode
-keep class **$$PropsSetter { *; }
-keep class **$$ReactModuleInfoProvider { *; }
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-keep @interface com.facebook.react.module.annotations.ReactModule

# --- Nitro (react-native-quick-crypto) ---
# C++ resolves these by literal JNI descriptor (JAnyMap.hpp:23, JPromise.hpp:20,
# JHybridObject.hpp:24). No shipped consumer rule covers them. If stripped, the
# scrypt KAT parity gate in src/services/secure/scryptKdf.ts falls back to
# @noble — correct but far slower, and it logs nothing. Silent perf regression.
-keep class com.margelo.nitro.** { *; }

# --- Expo Module outside the expo.modules.* namespace ---
# react-native-image-colors is an Expo Module() in its own package, so the
# expo.modules.** rule above does not reach it.
-keep class com.reactnativeimagecolors.** { *; }

# --- react-native-screens (TASK-312) ---
# Back-navigation flashed a frame of the screen just departed. Bisected on
# device: Test A (minify OFF + shrinkResources OFF) removed the flash, proving
# R8 rather than release-build semantics; Test B (minify ON + shrinkResources
# OFF) reproduced it, isolating CODE shrinking as the cause and exonerating
# resource shrinking.
#
# react-native-screens ships NO consumer proguard rules of its own (no *.pro in
# the package, no consumerProguardFiles in its build.gradle), so nothing keeps
# its classes under R8 — the whole native stack/fragment machinery that drives
# the pop transition is subject to shrinking and renaming. RN's own rules do not
# reach it: proguard-rules.pro covers NativeModules, and the ViewManager rule
# above is -keepnames, which prevents renaming but still ALLOWS shrinking.
-keep class com.swmansion.rnscreens.** { *; }

# --- Enum values()/valueOf() ---
# The standard rule, absent from RN's shipped file. Kotlin/Java enums whose
# constants are resolved from a string via valueOf() break silently when R8
# strips the synthetic accessors. No direct Enum.valueOf was found in
# com.swmansion.rnscreens (its stack/presentation/animation enums are matched
# structurally), so this is defence-in-depth for transitive dependencies rather
# than a proven fix — it is cheap, and its absence is a real gap either way.
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
`;

export default {
  "expo": {
    "name": IS_DEV ? "Voi Wallet (Dev)" : "Voi Wallet",
    "slug": "voi-wallet",
    "version": "0.1.11",
    "orientation": "portrait",
    "icon": "./assets/voi_wallet_logo.png",
    "userInterfaceStyle": "automatic",
    "newArchEnabled": true,
    "experiments": {
      "reactCompiler": true
    },
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
      "buildNumber": "23",
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
      "versionCode": 23,
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
            // R8 code shrinking + resource shrinking, release builds only
            // (TASK-209 / PLAN-267). Debug and dev-client builds are
            // unaffected: android/app/build.gradle applies both under the
            // `release` buildType only.
            //
            // These MUST go through expo-build-properties, not
            // android/gradle.properties — /android is gitignored and untracked,
            // so EAS regenerates it from the prebuild template and would never
            // see a local edit.
            //
            // Resource shrinking needs no hand-written keep.xml: the Expo
            // bundler writes an exhaustive one. build.gradle sets
            // bundleCommand = "export:embed", BundleHermesCTask passes
            // --assets-dest <build/generated/res/react/VARIANT>, and @expo/cli
            // persistMetroAssets.js createKeepFileAsync emits <res>/raw/keep.xml
            // listing every Metro asset by its generated identifier.
            // Both restored to `true` after the TASK-312 bisect. Test A (both
            // OFF) removed the back-nav flash, proving R8 rather than
            // release-build semantics; Test B (minify ON, shrinkResources OFF)
            // reproduced it, isolating CODE shrinking and exonerating resource
            // shrinking. The fix is therefore a keep rule, not a flag — see the
            // react-native-screens block in ANDROID_PROGUARD_RULES above — so
            // both wins from TASK-209 are kept rather than traded away.
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            extraProguardRules: ANDROID_PROGUARD_RULES,
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
      // Native scrypt KDF (HT-138 fix). react-native-quick-crypto ships an Expo
      // config plugin; it autolinks via Nitro. If `expo prebuild` errors on this
      // line, remove it — the Nitro module still autolinks without the plugin.
      "react-native-quick-crypto",
      withAndroidJvmTarget,
    ]
  }
};
