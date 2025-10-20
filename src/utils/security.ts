import * as LocalAuthentication from 'expo-local-authentication';
import * as Crypto from 'expo-crypto';

export interface BiometricCapability {
  available: boolean;
  enrolled: boolean;
  types: LocalAuthentication.AuthenticationType[];
}

export class SecurityUtils {
  static async getBiometricCapability(): Promise<BiometricCapability> {
    const available = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();

    return {
      available,
      enrolled,
      types,
    };
  }

  static async authenticateWithBiometrics(): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const capability = await this.getBiometricCapability();

      if (!capability.available) {
        return {
          success: false,
          error: 'Biometric authentication not available',
        };
      }

      if (!capability.enrolled) {
        return {
          success: false,
          error: 'No biometric authentication enrolled',
        };
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to access your wallet',
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });

      if (result.success) {
        return { success: true };
      } else {
        return {
          success: false,
          error: result.error || 'Authentication failed',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  static validatePinFormat(pin: string): boolean {
    return /^\d{6}$/.test(pin);
  }

  static isJailbroken(): boolean {
    // Accurate jailbreak/root detection requires native code; the previous
    // implementation attempted to access Node.js modules that do not exist in
    // React Native, which crashed Metro bundles. We now return a conservative
    // default and leave room for a future async/native implementation.
    if (__DEV__) {
      console.warn(
        '[SecurityUtils] Jailbreak detection not available in this build; returning false.'
      );
    }
    return false;
  }

  static generateSessionId(): string {
    try {
      return `session_${Crypto.randomUUID()}`;
    } catch {
      const buffer = Crypto.getRandomBytes ? Crypto.getRandomBytes(16) : null;
      if (buffer) {
        return `session_${Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('')}`;
      }
      // Fallback when randomUUID/getRandomBytes are unavailable
      return `session_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .substring(2, 10)}`;
    }
  }
}
