/**
 * TASK-209 / PLAN-267 regression guard for the Android R8 build configuration.
 *
 * Enabling R8 is a NATIVE change that no other gate in this repo can observe:
 * tsc, ESLint and the Jest suite never touch the Android build, and a Codex
 * review reads static code rather than running Gradle. This test is therefore
 * the only automated coverage the change has.
 *
 * It deliberately asserts the RAW CONFIG, not the effective Gradle output — it
 * proves the intent is declared, not that `expo prebuild` emitted the gradle
 * properties or that R8 honoured them. Runtime proof comes from the batched
 * pre-release device verification (TASK-273).
 *
 * What it protects against is a future edit silently dropping a keep rule or
 * flipping a flag off. Every rule below exists because something resolves a
 * class, field or annotation REFLECTIVELY at runtime, so R8 cannot see the
 * reference and would otherwise strip or rename it. Read PLAN-267 DR-2 before
 * deleting any of them.
 */

// app.config.js is a root-level ESM module (`export default`). Jest's
// transformIgnorePatterns scopes only node_modules, so it is babel-transformed
// normally and the default export resolves. require() keeps tsc from needing a
// declaration file for the root config module.
const appConfig = require('../../../app.config.js').default as {
  expo: { plugins: unknown[] };
};

/** The options object of the `expo-build-properties` entry in expo.plugins. */
function getBuildPropertiesAndroid(): Record<string, unknown> {
  const entry = appConfig.expo.plugins.find(
    (plugin): plugin is [string, { android?: Record<string, unknown> }] =>
      Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
  );
  if (!entry) {
    throw new Error(
      'expo-build-properties plugin entry not found in app.config.js'
    );
  }
  const android = entry[1]?.android;
  if (!android) {
    throw new Error('expo-build-properties entry has no android block');
  }
  return android;
}

describe('Android R8 build configuration (TASK-209)', () => {
  it('enables minification and resource shrinking for release builds', () => {
    const android = getBuildPropertiesAndroid();

    // android/app/build.gradle reads these exact gradle property names via
    // findProperty. They must be set HERE rather than in android/gradle.properties:
    // /android is gitignored and untracked, so EAS regenerates it from the
    // prebuild template and would never see a local edit.
    expect(android.enableMinifyInReleaseBuilds).toBe(true);
    expect(android.enableShrinkResourcesInReleaseBuilds).toBe(true);
  });

  it('never sets shrinkResources without minify', () => {
    const android = getBuildPropertiesAndroid();

    // expo-build-properties throws at config time if shrink is enabled without
    // minify. Assert the invariant directly so the failure is a readable test
    // rather than a prebuild crash.
    if (android.enableShrinkResourcesInReleaseBuilds === true) {
      expect(android.enableMinifyInReleaseBuilds).toBe(true);
    }
  });

  it('keeps every reflectively-resolved class, member and annotation', () => {
    const rules = getBuildPropertiesAndroid().extraProguardRules;
    expect(typeof rules).toBe('string');
    const proguard = rules as string;

    // React Native 0.81.5 ships exactly ONE consumer proguard file
    // (ReactAndroid/proguard-rules.pro). reactnative.pro and fbjni.pro exist in
    // the RN tree but are referenced by NO gradle script, so the rules below are
    // absent from the build unless this app supplies them.
    const requiredRules = [
      // Carried over from the deleted plugins/withExpoModulesProguard.js.
      '-keep class expo.modules.** { *; }',
      '-keep class expo.modules.kotlin.** { *; }',
      '-keep interface expo.modules.kotlin.** { *; }',

      // fbjni hybrid pattern: HybridData is resolved by FIELD NAME from C++.
      // Renaming it breaks JNI init for react-native-nitro-modules, which
      // carries unannotated mHybridData fields.
      'com.facebook.jni.HybridData *;',
      '<init>(com.facebook.jni.HybridData);',

      // ViewManagerPropertyUpdater does Class.forName("<cls>$$PropsSetter").
      // @react-native-community/slider is a SimpleViewManager, not a
      // NativeModule, so RN's blanket NativeModule rule does not cover it.
      '-keep class **$$PropsSetter { *; }',

      // gesture-handler and async-storage do
      // Class.forName("<cls>$$ReactModuleInfoProvider") and fall back to reading
      // @ReactModule reflectively — a stripped annotation is a STARTUP CRASH.
      '-keep class **$$ReactModuleInfoProvider { *; }',
      '-keep @interface com.facebook.react.module.annotations.ReactModule',

      // Nitro: C++ resolves these by literal JNI descriptor. If stripped, the
      // scrypt KAT gate in src/services/secure/scryptKdf.ts silently falls back
      // to @noble — correct but far slower, and it logs nothing.
      '-keep class com.margelo.nitro.** { *; }',

      // react-native-image-colors is an Expo Module() in its own package, so
      // the expo.modules.** rule does not reach it.
      '-keep class com.reactnativeimagecolors.** { *; }',
    ];

    for (const rule of requiredRules) {
      expect(proguard).toContain(rule);
    }
  });

  it('retains the annotation attributes reflective lookups depend on', () => {
    const proguard = getBuildPropertiesAndroid().extraProguardRules as string;

    // Without these, the @ReactModule annotation is stripped from the class file
    // and the async-storage / gesture-handler fallback path NPEs at launch.
    for (const attribute of [
      '*Annotation*',
      'Signature',
      'InnerClasses',
      'EnclosingMethod',
    ]) {
      expect(proguard).toContain(attribute);
    }
  });

  it('does not globally disable shrinking, optimization or obfuscation', () => {
    const proguard = getBuildPropertiesAndroid().extraProguardRules as string;

    // The blanket `-keep ... { *; }` rules above are scoped to three namespaces.
    // A catch-all or a -dont* directive would silently forfeit the entire point
    // of enabling R8 while leaving the config looking correct.
    for (const forbidden of [
      '-dontshrink',
      '-dontoptimize',
      '-dontobfuscate',
      '-keep class ** {',
    ]) {
      expect(proguard).not.toContain(forbidden);
    }
  });
});
