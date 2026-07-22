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

  /**
   * Store a value behind a MANDATORY device-auth gate (biometric/passcode),
   * provisioning the access-control flag AT WRITE time (DOC-137 §2.5). This is
   * enclave-bound and OS-invalidated on biometric-enrollment change / lock
   * removal, so it MUST be used ONLY for the biometric-convenience item (§3) —
   * never for items that must survive enrollment changes (PIN hash, salt, key
   * envelope, metadata). Fixes the write-time-ACL bug where auth was requested
   * only on read of an item never provisioned auth-required.
   */
  setItemWithAuth?(
    key: string,
    value: string,
    options: { prompt: string }
  ): Promise<void>;
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
export type AuthenticationType =
  | 'fingerprint'
  | 'facial'
  | 'iris'
  | 'webauthn'
  | 'none';

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

// Connectivity Adapter Interface
/**
 * Normalized connectivity snapshot.
 *
 * The two platform sources report different things, so the shape is the
 * intersection of what both can honestly answer:
 *  - mobile (`@react-native-community/netinfo`) knows both whether an
 *    interface is up AND whether the internet is actually reachable;
 *  - extension/web (`navigator.onLine`) only knows whether an interface is up.
 */
export interface ConnectivityState {
  /** A network interface is up. Does NOT imply the internet is reachable. */
  isConnected: boolean;
  /**
   * Whether the internet is actually reachable, or `null` when the platform
   * cannot determine it. NetInfo reports `null` until its first reachability
   * probe settles; `navigator.onLine` can never answer this, so the
   * extension/web adapter always reports `null` rather than guessing.
   */
  isInternetReachable: boolean | null;
  /** Coarse transport label, e.g. 'wifi' | 'cellular' | 'none' | 'unknown'. */
  type: string;
}

export interface ConnectivityAdapter {
  /** Read the current connectivity snapshot. */
  getState(): Promise<ConnectivityState>;
  /**
   * Subscribe to connectivity changes. Returns an unsubscribe function.
   * Implementations must invoke the listener on every transition, and must
   * tolerate being unsubscribed more than once.
   */
  subscribe(listener: (state: ConnectivityState) => void): () => void;
}

// Platform capabilities check
export interface PlatformCapabilities {
  hasBiometrics: boolean;
  hasWebAuthn: boolean;
  hasSecureStorage: boolean;
  hasCamera: boolean;
  platform: PlatformType;
}
