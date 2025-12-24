/**
 * Extension Biometrics Adapter (WebAuthn)
 * Uses Web Authentication API for hardware security key support
 */

import type {
  BiometricAdapter,
  AuthCapability,
  AuthResult,
  AuthenticationType,
} from '../types';
import { extensionStorage } from './storage';

const WEBAUTHN_CREDENTIAL_KEY = 'voi_webauthn_credential';
const WEBAUTHN_CHALLENGE_KEY = 'voi_webauthn_challenge';

// Relying Party configuration
const RP_ID = typeof window !== 'undefined' ? window.location.hostname : 'voiwallet.app';
const RP_NAME = 'Voi Wallet';

export class ExtensionBiometricAdapter implements BiometricAdapter {
  async isAvailable(): Promise<boolean> {
    // Check if WebAuthn is supported
    if (typeof window === 'undefined') return false;
    if (!window.PublicKeyCredential) return false;

    try {
      // Check if platform authenticator is available (e.g., Windows Hello, Touch ID)
      const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      return available;
    } catch {
      return false;
    }
  }

  async isEnrolled(): Promise<boolean> {
    // Check if user has registered a WebAuthn credential
    const credentialId = await extensionStorage.getItem(WEBAUTHN_CREDENTIAL_KEY);
    return credentialId !== null;
  }

  async getCapability(): Promise<AuthCapability> {
    const available = await this.isAvailable();
    const enrolled = await this.isEnrolled();

    return {
      available,
      enrolled,
      types: available ? ['webauthn'] : [],
    };
  }

  async authenticate(options: {
    promptMessage: string;
    fallbackLabel?: string;
    cancelLabel?: string;
  }): Promise<AuthResult> {
    try {
      const credentialIdB64 = await extensionStorage.getItem(WEBAUTHN_CREDENTIAL_KEY);
      if (!credentialIdB64) {
        return {
          success: false,
          error: 'No WebAuthn credential registered. Please set up security key first.',
        };
      }

      // Decode credential ID
      const credentialId = Uint8Array.from(atob(credentialIdB64), (c) =>
        c.charCodeAt(0)
      );

      // Generate challenge
      const challenge = crypto.getRandomValues(new Uint8Array(32));

      const publicKeyCredentialRequestOptions: PublicKeyCredentialRequestOptions = {
        challenge,
        rpId: RP_ID,
        allowCredentials: [
          {
            id: credentialId,
            type: 'public-key',
            transports: ['usb', 'nfc', 'internal'],
          },
        ],
        userVerification: 'required',
        timeout: 60000,
      };

      const assertion = await navigator.credentials.get({
        publicKey: publicKeyCredentialRequestOptions,
      });

      if (assertion) {
        return { success: true };
      }

      return {
        success: false,
        error: 'Authentication failed',
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          return {
            success: false,
            error: 'Authentication was cancelled',
          };
        }
        if (error.name === 'SecurityError') {
          return {
            success: false,
            error: 'Security error during authentication',
          };
        }
        return {
          success: false,
          error: error.message,
        };
      }
      return {
        success: false,
        error: 'Unknown authentication error',
      };
    }
  }

  async getAuthType(): Promise<AuthenticationType> {
    const available = await this.isAvailable();
    return available ? 'webauthn' : 'none';
  }

  /**
   * Register a new WebAuthn credential
   */
  async registerCredential(options: {
    userId: string;
    userName: string;
  }): Promise<{ credentialId: string } | null> {
    try {
      const available = await this.isAvailable();
      if (!available) {
        console.warn('WebAuthn not available');
        return null;
      }

      // Generate challenge
      const challenge = crypto.getRandomValues(new Uint8Array(32));

      // Convert userId to Uint8Array
      const encoder = new TextEncoder();
      const userIdBuffer = encoder.encode(options.userId);

      const publicKeyCredentialCreationOptions: PublicKeyCredentialCreationOptions = {
        challenge,
        rp: {
          name: RP_NAME,
          id: RP_ID,
        },
        user: {
          id: userIdBuffer,
          name: options.userName,
          displayName: options.userName,
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' }, // ES256
          { alg: -257, type: 'public-key' }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
        attestation: 'none',
      };

      const credential = (await navigator.credentials.create({
        publicKey: publicKeyCredentialCreationOptions,
      })) as PublicKeyCredential | null;

      if (!credential) {
        return null;
      }

      // Store credential ID for future authentication
      const credentialId = btoa(
        String.fromCharCode(...new Uint8Array(credential.rawId))
      );
      await extensionStorage.setItem(WEBAUTHN_CREDENTIAL_KEY, credentialId);

      return { credentialId };
    } catch (error) {
      console.error('WebAuthn registration failed:', error);
      return null;
    }
  }

  /**
   * Remove registered WebAuthn credential
   */
  async removeCredential(): Promise<void> {
    await extensionStorage.removeItem(WEBAUTHN_CREDENTIAL_KEY);
    await extensionStorage.removeItem(WEBAUTHN_CHALLENGE_KEY);
  }
}

// Singleton instance
export const extensionBiometrics = new ExtensionBiometricAdapter();
