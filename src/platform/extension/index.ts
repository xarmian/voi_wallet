/**
 * Extension Platform Adapters
 * Re-exports all Chrome extension-specific implementations
 */

export { ExtensionCryptoAdapter, extensionCrypto } from './crypto';
export { ExtensionSecureStorageAdapter, extensionSecureStorage } from './secureStorage';
export { ExtensionStorageAdapter, extensionStorage } from './storage';
export { ExtensionBiometricAdapter, extensionBiometrics } from './biometrics';
export { ExtensionDeviceIdAdapter, extensionDeviceId } from './deviceId';
export { ExtensionClipboardAdapter, extensionClipboard } from './clipboard';
export { ExtensionAlertAdapter, extensionAlert } from './alert';
