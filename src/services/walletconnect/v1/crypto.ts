/**
 * Encryption/Decryption utilities for WalletConnect v1
 * Uses AES-256-CBC with HMAC-SHA256 for message security
 */

import * as Crypto from 'expo-crypto';
import { WalletConnectV1EncryptedPayload } from './types';

/**
 * Convert hex string to Uint8Array
 */
function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert string to Uint8Array (UTF-8)
 */
function stringToUint8Array(str: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

/**
 * Convert Uint8Array to string (UTF-8)
 */
function uint8ArrayToString(bytes: Uint8Array): string {
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

/**
 * Convert base64 to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert Uint8Array to base64
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binaryString = '';
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  return btoa(binaryString);
}

/**
 * Generate random IV (Initialization Vector) for AES
 */
async function generateIV(): Promise<Uint8Array> {
  // Generate 16 random bytes for AES-256-CBC IV
  const randomBytes = await Crypto.getRandomBytesAsync(16);
  return new Uint8Array(randomBytes);
}

/**
 * Compute HMAC-SHA256 using crypto-js
 * WalletConnect v1 uses proper HMAC, not simple hash(key + data)
 */
function computeHMAC(
  key: Uint8Array,
  data: Uint8Array
): Uint8Array {
  const CryptoJS = require('crypto-js');

  // Convert Uint8Arrays to hex strings first, then to WordArrays
  // This ensures proper byte representation
  const keyHex = uint8ArrayToHex(key);
  const dataHex = uint8ArrayToHex(data);

  const keyWordArray = CryptoJS.enc.Hex.parse(keyHex);
  const dataWordArray = CryptoJS.enc.Hex.parse(dataHex);

  // Compute HMAC-SHA256
  const hmac = CryptoJS.HmacSHA256(dataWordArray, keyWordArray);

  // Convert to hex string then to Uint8Array
  const hmacHex = hmac.toString(CryptoJS.enc.Hex);
  return hexToUint8Array(hmacHex);
}

/**
 * AES-256-CBC Encryption using crypto-js
 */
async function aesEncrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const CryptoJS = require('crypto-js');

  // Convert to WordArray format using hex encoding (consistent with decrypt)
  const keyHex = uint8ArrayToHex(key);
  const ivHex = uint8ArrayToHex(iv);
  const dataHex = uint8ArrayToHex(data);

  const keyWordArray = CryptoJS.enc.Hex.parse(keyHex);
  const ivWordArray = CryptoJS.enc.Hex.parse(ivHex);
  const dataWordArray = CryptoJS.enc.Hex.parse(dataHex);

  // Encrypt with AES-256-CBC
  const encrypted = CryptoJS.AES.encrypt(dataWordArray, keyWordArray, {
    iv: ivWordArray,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  // Convert ciphertext WordArray to Uint8Array
  const cipherBytes = encrypted.ciphertext.words;
  const sigBytes = encrypted.ciphertext.sigBytes;
  const result = new Uint8Array(sigBytes);

  for (let i = 0; i < sigBytes; i++) {
    result[i] = (cipherBytes[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }

  return result;
}

/**
 * AES-256-CBC Decryption using crypto-js
 */
async function aesDecrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array> {
  const CryptoJS = require('crypto-js');

  // Convert to WordArray format using hex encoding (same as HMAC)
  const keyHex = uint8ArrayToHex(key);
  const ivHex = uint8ArrayToHex(iv);
  const cipherHex = uint8ArrayToHex(ciphertext);

  const keyWordArray = CryptoJS.enc.Hex.parse(keyHex);
  const ivWordArray = CryptoJS.enc.Hex.parse(ivHex);
  const cipherWordArray = CryptoJS.enc.Hex.parse(cipherHex);

  // Create CipherParams object
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: cipherWordArray,
  });

  // Decrypt
  const decrypted = CryptoJS.AES.decrypt(cipherParams, keyWordArray, {
    iv: ivWordArray,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  // Convert decrypted WordArray to Uint8Array
  const words = decrypted.words;
  const sigBytes = decrypted.sigBytes;
  const result = new Uint8Array(sigBytes);

  for (let i = 0; i < sigBytes; i++) {
    result[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }

  return result;
}

/**
 * Encrypt data for WalletConnect v1 protocol
 */
export async function encryptMessage(
  data: string,
  key: string
): Promise<WalletConnectV1EncryptedPayload> {
  try {
    // Convert key from hex to bytes
    const keyBytes = hexToUint8Array(key);

    // Generate random IV
    const iv = await generateIV();

    // Convert data to bytes
    const dataBytes = stringToUint8Array(data);

    // Encrypt data with AES-256-CBC
    const encrypted = await aesEncrypt(dataBytes, keyBytes, iv);

    // Compute HMAC of (encrypted bytes + IV bytes) - Option 1: Raw bytes
    // This is what incoming messages use and what the dApp expects
    const hmacInput = new Uint8Array([...encrypted, ...iv]);
    const hmac = computeHMAC(keyBytes, hmacInput);

    // Convert encrypted data and IV to hex for transport
    const encryptedHex = uint8ArrayToHex(encrypted);
    const ivHex = uint8ArrayToHex(iv);

    // Return encrypted payload (data as hex, not base64!)
    return {
      data: encryptedHex,
      hmac: uint8ArrayToHex(hmac),
      iv: ivHex,
    };
  } catch (error) {
    console.error('WC v1 Crypto: Encryption failed', error);
    throw new Error(
      `Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Decrypt data from WalletConnect v1 protocol
 */
export async function decryptMessage(
  payload: WalletConnectV1EncryptedPayload,
  key: string
): Promise<string> {
  try {
    // Convert key from hex to bytes
    const keyBytes = hexToUint8Array(key);

    // WalletConnect v1 uses hex encoding for data, not base64
    const encrypted = hexToUint8Array(payload.data);

    // Convert IV from hex to bytes
    const iv = hexToUint8Array(payload.iv);

    // Verify HMAC
    // WalletConnect v1 protocol: HMAC is computed over raw bytes (encrypted + IV)
    const hmacInput = new Uint8Array([...encrypted, ...iv]);
    const expectedHmac = computeHMAC(keyBytes, hmacInput);
    const receivedHmac = hexToUint8Array(payload.hmac);

    // Constant-time comparison to prevent timing attacks
    let hmacMatch = true;
    if (expectedHmac.length !== receivedHmac.length) {
      hmacMatch = false;
    } else {
      for (let i = 0; i < expectedHmac.length; i++) {
        if (expectedHmac[i] !== receivedHmac[i]) {
          hmacMatch = false;
        }
      }
    }

    if (!hmacMatch) {
      throw new Error('HMAC verification failed - message may be tampered');
    }

    // Decrypt data with AES-256-CBC
    const decrypted = await aesDecrypt(encrypted, keyBytes, iv);

    // Convert bytes back to string
    return uint8ArrayToString(decrypted);
  } catch (error) {
    console.error('WC v1 Crypto: Decryption failed', error);
    throw new Error(
      `Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Generate a random client ID for WalletConnect v1
 */
export async function generateClientId(): Promise<string> {
  const randomBytes = await Crypto.getRandomBytesAsync(32);
  return uint8ArrayToHex(new Uint8Array(randomBytes));
}
