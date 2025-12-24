/**
 * Platform detection utilities
 * Determines whether we're running in mobile app, Chrome extension, or web browser
 */

import type { PlatformType, PlatformCapabilities } from './types';

/**
 * Detect the current platform
 */
export function detectPlatform(): PlatformType {
  // Check for Chrome extension environment
  if (
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    chrome.runtime.id
  ) {
    return 'extension';
  }

  // Check for React Native environment
  if (
    typeof navigator !== 'undefined' &&
    navigator.product === 'ReactNative'
  ) {
    return 'mobile';
  }

  // Check for Expo/React Native via global flag
  // @ts-ignore - __DEV__ is a React Native global
  if (typeof __DEV__ !== 'undefined') {
    // Additional check for React Native specific APIs
    try {
      // @ts-ignore
      const { Platform } = require('react-native');
      if (Platform && (Platform.OS === 'ios' || Platform.OS === 'android')) {
        return 'mobile';
      }
    } catch {
      // Not React Native
    }
  }

  // Default to web (could be extension popup without chrome.runtime access)
  return 'web';
}

/**
 * Check if running in Chrome extension context
 */
export function isExtension(): boolean {
  return detectPlatform() === 'extension';
}

/**
 * Check if running in mobile app context
 */
export function isMobile(): boolean {
  return detectPlatform() === 'mobile';
}

/**
 * Check if running in web browser context
 */
export function isWeb(): boolean {
  return detectPlatform() === 'web';
}

/**
 * Get platform capabilities
 */
export async function getPlatformCapabilities(): Promise<PlatformCapabilities> {
  const platform = detectPlatform();

  const capabilities: PlatformCapabilities = {
    platform,
    hasBiometrics: false,
    hasWebAuthn: false,
    hasSecureStorage: false,
    hasCamera: false,
  };

  if (platform === 'mobile') {
    // Mobile has biometrics and secure storage
    capabilities.hasBiometrics = true;
    capabilities.hasSecureStorage = true;
    capabilities.hasCamera = true;
  } else if (platform === 'extension' || platform === 'web') {
    // Check for WebAuthn support
    capabilities.hasWebAuthn =
      typeof window !== 'undefined' &&
      typeof window.PublicKeyCredential !== 'undefined';

    // Extension has chrome.storage for secure-ish storage
    capabilities.hasSecureStorage = platform === 'extension';

    // Check for camera API (MediaDevices)
    capabilities.hasCamera =
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices !== 'undefined' &&
      typeof navigator.mediaDevices.getUserMedia === 'function';
  }

  return capabilities;
}

// Cache the detected platform for performance
let cachedPlatform: PlatformType | null = null;

/**
 * Get cached platform type (avoids repeated detection)
 */
export function getCachedPlatform(): PlatformType {
  if (cachedPlatform === null) {
    cachedPlatform = detectPlatform();
  }
  return cachedPlatform;
}

/**
 * Reset cached platform (for testing)
 */
export function resetPlatformCache(): void {
  cachedPlatform = null;
}
