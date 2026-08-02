# Set correct version of node
nvm use node

# Android SDK Paths
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH

# Expo Doctor
npx expo-doctor

# Build preview release for Android on Expo Cloud
eas build --platform android --profile preview

# Build preview release for Android locally
npm run build:android:preview

# NOTE: the Android `preview` profile is a RELEASE build (:app:assembleRelease),
# so it is the artifact that exercises R8 minification + resource shrinking
# (enabled in app.config.js, TASK-209). A debug or dev-client build does NOT --
# both flags apply only under the `release` buildType. Any verification of
# minification, keep rules, or APK size must use preview or production.

# Regenerate the Android project from scratch (REQUIRED after changing config
# plugins -- expo-build-properties only purges its own tagged proguard block, so
# an incremental prebuild can leave stale rules behind from a removed plugin)
npx expo prebuild --clean -p android

# Prebuild for iOS
npx expo prebuild --platform ios

# Build production (TestFlight, store) release for iOS (locally)
eas build --platform ios --profile production --local

# Submit/upload production iOS release to App Store Connect
eas submit --platform ios --profile production

# Manage EAS Keys/credentials
eas credentials -p ios

# Push update to preview channel
eas update --channel preview --message "Test update"

