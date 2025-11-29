/**
 * Platform abstraction layer types
 * Shared interfaces for cross-platform compatibility (mobile + Chrome extension)
 */

// Platform detection
export type PlatformType = 'mobile' | 'extension' | 'web';

// Secure Storage Adapter Interface
export interface SecureStorageAdapter {
  /**
   * Store a value securely (encrypted on extension, hardware-backed on mobile)
   */
  setItem(key: string, value: string): Promise<void>;

  /**
   * Retrieve a securely stored value
   */
  getItem(key: string): Promise<string | null>;

  /**
   * Delete a securely stored value
   */
  deleteItem(key: string): Promise<void>;

  /**
   * Get item with biometric/WebAuthn authentication
   */
  getItemWithAuth?(
    key: string,
    options: { prompt: string }
  ): Promise<string | null>;
}

// General Storage Adapter Interface (AsyncStorage replacement)
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiGet?(keys: string[]): Promise<[string, string | null][]>;
  multiRemove?(keys: string[]): Promise<void>;
  getAllKeys?(): Promise<string[]>;
}

// Crypto Adapter Interface
export interface CryptoAdapter {
  /**
   * Generate random bytes
   */
  getRandomBytes(byteCount: number): Promise<Uint8Array>;

  /**
   * Generate random bytes synchronously (if available)
   */
  getRandomBytesSync?(byteCount: number): Uint8Array;

  /**
   * Generate a random UUID
   */
  randomUUID(): string;

  /**
   * Hash a string with SHA-256
   */
  sha256(input: string): Promise<string>;
}

// Biometric/WebAuthn Authentication Types
export type AuthenticationType = 'fingerprint' | 'facial' | 'iris' | 'webauthn' | 'none';

export interface AuthCapability {
  available: boolean;
  enrolled: boolean;
  types: AuthenticationType[];
}

export interface AuthResult {
  success: boolean;
  error?: string;
}

// Biometric/WebAuthn Adapter Interface
export interface BiometricAdapter {
  /**
   * Check if authentication hardware/capability is available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Check if user has enrolled biometrics/credentials
   */
  isEnrolled(): Promise<boolean>;

  /**
   * Get full capability information
   */
  getCapability(): Promise<AuthCapability>;

  /**
   * Authenticate the user
   */
  authenticate(options: {
    promptMessage: string;
    fallbackLabel?: string;
    cancelLabel?: string;
  }): Promise<AuthResult>;

  /**
   * Get the type of authentication available
   */
  getAuthType(): Promise<AuthenticationType>;

  /**
   * Register a new credential (WebAuthn only)
   */
  registerCredential?(options: {
    userId: string;
    userName: string;
  }): Promise<{ credentialId: string } | null>;
}

// Clipboard Adapter Interface
export interface ClipboardAdapter {
  /**
   * Copy text to clipboard
   */
  setString(text: string): Promise<void>;

  /**
   * Get text from clipboard
   */
  getString(): Promise<string>;
}

// Device ID Adapter Interface
export interface DeviceIdAdapter {
  /**
   * Get a stable device/installation identifier
   * On mobile: iOS vendor ID or Android ID
   * On extension: Generated and persisted installation ID
   */
  getDeviceId(): Promise<string>;
}

// Alert/Notification Adapter (for clipboard feedback, etc.)
export interface AlertAdapter {
  /**
   * Show an alert dialog
   */
  alert(title: string, message?: string): void;
}

// Platform capabilities check
export interface PlatformCapabilities {
  hasBiometrics: boolean;
  hasWebAuthn: boolean;
  hasSecureStorage: boolean;
  hasCamera: boolean;
  platform: PlatformType;
}
