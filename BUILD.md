# Set correct version of node
nvm use node

# Android SDK Paths
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH

# Expo Doctor
npx expo-doctor

# Build preview release for Android on Expo Cloud
eas build --platform android --profile preview

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

