import { biometrics, crypto } from '../platform';
import type { AuthCapability, AuthenticationType } from '../platform/types';

// Re-export types for backwards compatibility
export type BiometricCapability = AuthCapability;

export class SecurityUtils {
  static async getBiometricCapability(): Promise<BiometricCapability> {
    return await biometrics.getCapability();
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

      const result = await biometrics.authenticate({
        promptMessage: 'Authenticate to access your wallet',
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
      });

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get the type of authentication available (biometric, webauthn, or none)
   */
  static async getAuthType(): Promise<AuthenticationType> {
    return await biometrics.getAuthType();
  }

  /**
   * Register a WebAuthn credential (extension only)
   * Returns null on mobile or if registration fails
   */
  static async registerWebAuthnCredential(options: {
    userId: string;
    userName: string;
  }): Promise<{ credentialId: string } | null> {
    return await biometrics.registerCredential(options);
  }

  static validatePinFormat(pin: string): boolean {
    return /^\d{6}$/.test(pin);
  }

  static isJailbroken(): boolean {
    // Accurate jailbreak/root detection requires native code; the previous
    // implementation attempted to access Node.js modules that do not exist in
    // React Native, which crashed Metro bundles. We now return a conservative
    // default and leave room for a future async/native implementation.
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        '[SecurityUtils] Jailbreak detection not available in this build; returning false.'
      );
    }
    return false;
  }

  static generateSessionId(): string {
    try {
      return `session_${crypto.randomUUID()}`;
    } catch {
      // Fallback when randomUUID is unavailable
      return `session_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .substring(2, 10)}`;
    }
  }
}
