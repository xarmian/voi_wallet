/**
 * Mobile Biometrics Adapter
 * Uses expo-local-authentication for FaceID/TouchID/Fingerprint
 */

import * as LocalAuthentication from 'expo-local-authentication';
import type {
  BiometricAdapter,
  AuthCapability,
  AuthResult,
  AuthenticationType,
} from '../types';

// Map expo auth types to our platform-agnostic types
function mapAuthType(
  expoType: LocalAuthentication.AuthenticationType
): AuthenticationType {
  switch (expoType) {
    case LocalAuthentication.AuthenticationType.FINGERPRINT:
      return 'fingerprint';
    case LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION:
      return 'facial';
    case LocalAuthentication.AuthenticationType.IRIS:
      return 'iris';
    default:
      return 'none';
  }
}

export class MobileBiometricAdapter implements BiometricAdapter {
  async isAvailable(): Promise<boolean> {
    return await LocalAuthentication.hasHardwareAsync();
  }

  async isEnrolled(): Promise<boolean> {
    return await LocalAuthentication.isEnrolledAsync();
  }

  async getCapability(): Promise<AuthCapability> {
    const available = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    const expoTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();

    return {
      available,
      enrolled,
      types: expoTypes.map(mapAuthType),
    };
  }

  async authenticate(options: {
    promptMessage: string;
    fallbackLabel?: string;
    cancelLabel?: string;
  }): Promise<AuthResult> {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: options.promptMessage,
        fallbackLabel: options.fallbackLabel || 'Use PIN',
        cancelLabel: options.cancelLabel || 'Cancel',
        disableDeviceFallback: false,
      });

      if (result.success) {
        return { success: true };
      }

      return {
        success: false,
        error: result.error || 'Authentication failed',
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getAuthType(): Promise<AuthenticationType> {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    if (types.length === 0) {
      return 'none';
    }
    // Return the primary auth type (first in list)
    return mapAuthType(types[0]);
  }

  // Not applicable for mobile - WebAuthn only
  async registerCredential(): Promise<null> {
    return null;
  }
}

// Singleton instance
export const mobileBiometrics = new MobileBiometricAdapter();
