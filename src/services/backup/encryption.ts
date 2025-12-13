/**
 * Backup Encryption Module
 *
 * Password-based encryption for wallet backups using PBKDF2 + AES-256-CTR + HMAC.
 * Follows the same security patterns as AccountSecureStorage.
 */

import CryptoJS from 'crypto-js';
import 'crypto-js/hmac-sha256';
import 'crypto-js/sha256';
import 'crypto-js/aes';
import 'crypto-js/mode-ctr';
import 'crypto-js/pad-nopadding';
import 'crypto-js/enc-hex';
import 'crypto-js/enc-base64';
import 'crypto-js/pbkdf2';
import { Buffer } from 'buffer';
import { crypto as platformCrypto } from '@/platform';
import { EncryptedBackupFile, BackupError } from './types';

// Encryption parameters - higher iterations for backup since we have more time
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits for AES
const KEY_LENGTH = 32; // 256 bits for AES-256

/**
 * PBKDF2 key derivation using CryptoJS with SHA256
 */
function deriveKey(password: string, saltHex: string): string {
  const saltWA = CryptoJS.enc.Hex.parse(saltHex);
  const derived = CryptoJS.PBKDF2(password, saltWA, {
    keySize: KEY_LENGTH / 4, // CryptoJS keySize is in 32-bit words
    iterations: PBKDF2_ITERATIONS,
    hasher: (CryptoJS.algo as any).SHA256,
  });
  return derived.toString(CryptoJS.enc.Hex);
}

/**
 * Generate cryptographically secure random bytes as hex string
 */
async function generateRandomHex(byteLength: number): Promise<string> {
  const randomBytes = await platformCrypto.getRandomBytes(byteLength);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/**
 * Encrypt backup data with a user-provided password
 *
 * @param data - JSON string of backup data to encrypt
 * @param password - User's chosen password
 * @returns Encrypted backup file structure
 */
export async function encryptBackup(
  data: string,
  password: string
): Promise<EncryptedBackupFile> {
  let keyMaterial: string | null = null;

  try {
    // Generate random salt and IV
    const salt = await generateRandomHex(SALT_LENGTH);
    const iv = await generateRandomHex(IV_LENGTH);

    // Derive encryption key from password
    keyMaterial = deriveKey(password, salt);

    // Prepare key and IV as WordArrays for CryptoJS
    const keyWordArray = CryptoJS.enc.Hex.parse(keyMaterial);
    const ivWordArray = CryptoJS.enc.Hex.parse(iv);

    // Encrypt with AES-256-CTR
    const encrypted = CryptoJS.AES.encrypt(data, keyWordArray, {
      iv: ivWordArray,
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    });

    // Get ciphertext as base64
    const ciphertext = encrypted.toString(); // Already base64

    // Generate HMAC for authentication
    // Use a derived HMAC key (key + 'hmac_salt' hashed)
    const hmacKey = CryptoJS.SHA256(keyMaterial + 'backup_hmac_salt').toString();
    const hmac = CryptoJS.HmacSHA256(ciphertext, hmacKey).toString();

    return {
      format: 'voibackup',
      version: 1,
      salt,
      iv,
      ciphertext,
      hmac,
    };
  } catch (error) {
    throw new BackupError(
      `Encryption failed: ${error instanceof Error ? error.message : String(error)}`,
      'ENCRYPTION_FAILED'
    );
  } finally {
    // Clear sensitive key material from memory
    if (keyMaterial) {
      keyMaterial = '0'.repeat(keyMaterial.length);
    }
  }
}

/**
 * Decrypt backup data with a user-provided password
 *
 * @param encrypted - Encrypted backup file structure
 * @param password - User's password
 * @returns Decrypted JSON string of backup data
 */
export async function decryptBackup(
  encrypted: EncryptedBackupFile,
  password: string
): Promise<string> {
  let keyMaterial: string | null = null;

  try {
    // Validate format
    if (encrypted.format !== 'voibackup') {
      throw new BackupError('Invalid backup file format', 'INVALID_FILE_FORMAT');
    }

    if (encrypted.version !== 1) {
      throw new BackupError(
        `Unsupported backup version: ${encrypted.version}`,
        'VERSION_MISMATCH'
      );
    }

    // Derive encryption key from password
    keyMaterial = deriveKey(password, encrypted.salt);

    // Verify HMAC first (authenticate before decrypt)
    const hmacKey = CryptoJS.SHA256(keyMaterial + 'backup_hmac_salt').toString();
    const computedHmac = CryptoJS.HmacSHA256(encrypted.ciphertext, hmacKey).toString();

    if (computedHmac !== encrypted.hmac) {
      throw new BackupError(
        'Integrity check failed - wrong password or corrupted file',
        'INTEGRITY_CHECK_FAILED'
      );
    }

    // Prepare key and IV as WordArrays
    const keyWordArray = CryptoJS.enc.Hex.parse(keyMaterial);
    const ivWordArray = CryptoJS.enc.Hex.parse(encrypted.iv);

    // Decrypt
    const decrypted = CryptoJS.AES.decrypt(encrypted.ciphertext, keyWordArray, {
      iv: ivWordArray,
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    });

    // Convert to UTF-8 string
    const plaintext = decrypted.toString(CryptoJS.enc.Utf8);

    if (!plaintext || plaintext.length === 0) {
      throw new BackupError('Decryption failed - invalid result', 'DECRYPTION_FAILED');
    }

    return plaintext;
  } catch (error) {
    if (error instanceof BackupError) {
      throw error;
    }
    throw new BackupError(
      `Decryption failed: ${error instanceof Error ? error.message : String(error)}`,
      'DECRYPTION_FAILED'
    );
  } finally {
    // Clear sensitive key material from memory
    if (keyMaterial) {
      keyMaterial = '0'.repeat(keyMaterial.length);
    }
  }
}

/**
 * Validate password strength
 *
 * @param password - Password to validate
 * @returns Object with isValid boolean and feedback messages
 */
export function validatePasswordStrength(password: string): {
  isValid: boolean;
  score: number; // 0-4
  feedback: string[];
} {
  const feedback: string[] = [];
  let score = 0;

  // Minimum length
  if (password.length < 8) {
    feedback.push('Password must be at least 8 characters');
  } else {
    score++;
    if (password.length >= 12) {
      score++;
    }
  }

  // Has lowercase
  if (!/[a-z]/.test(password)) {
    feedback.push('Add lowercase letters');
  } else {
    score += 0.5;
  }

  // Has uppercase
  if (!/[A-Z]/.test(password)) {
    feedback.push('Add uppercase letters');
  } else {
    score += 0.5;
  }

  // Has numbers
  if (!/\d/.test(password)) {
    feedback.push('Add numbers');
  } else {
    score += 0.5;
  }

  // Has special characters
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    feedback.push('Add special characters');
  } else {
    score += 0.5;
  }

  // Cap score at 4
  score = Math.min(Math.floor(score), 4);

  return {
    isValid: password.length >= 8,
    score,
    feedback,
  };
}

/**
 * Get password strength label
 */
export function getPasswordStrengthLabel(score: number): string {
  switch (score) {
    case 0:
      return 'Very Weak';
    case 1:
      return 'Weak';
    case 2:
      return 'Fair';
    case 3:
      return 'Good';
    case 4:
      return 'Strong';
    default:
      return 'Unknown';
  }
}

/**
 * Get password strength color
 */
export function getPasswordStrengthColor(score: number): string {
  switch (score) {
    case 0:
      return '#EF4444'; // Red
    case 1:
      return '#F97316'; // Orange
    case 2:
      return '#EAB308'; // Yellow
    case 3:
      return '#22C55E'; // Green
    case 4:
      return '#10B981'; // Emerald
    default:
      return '#6B7280'; // Gray
  }
}
