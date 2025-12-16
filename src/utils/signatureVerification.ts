/**
 * Signature Verification Utilities
 *
 * Provides local cryptographic verification of signed Algorand transactions
 * without requiring network submission. Used for airgap signer verification.
 */

import algosdk from 'algosdk';
import nacl from 'tweetnacl';

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

export interface TransactionComponents {
  txnBytes: Uint8Array;
  signature: Uint8Array;
  signerPublicKey: Uint8Array;
  signerAddress: string;
}

/**
 * Verify a signed transaction was signed by the expected address.
 * Does NOT submit to network - purely local cryptographic verification.
 *
 * @param signedTxnBase64 - Base64-encoded signed transaction blob
 * @param expectedSignerAddress - The Algorand address that should have signed
 * @returns Verification result with valid flag and optional error message
 */
export function verifySignedTransaction(
  signedTxnBase64: string,
  expectedSignerAddress: string
): VerificationResult {
  try {
    // Decode the signed transaction
    const signedTxnBytes = Buffer.from(signedTxnBase64, 'base64');
    const signedTxn = algosdk.decodeSignedTransaction(signedTxnBytes);

    // Extract signature - must have a sig (not msig or lsig)
    if (!signedTxn.sig) {
      return {
        valid: false,
        error: 'Transaction does not contain a standard signature',
      };
    }

    // Get the transaction object
    const txn = signedTxn.txn;

    // Handle both algosdk v2 and v3 field names
    const txnAny = txn as any;

    // SECURITY: Verify the transaction does NOT contain a rekey field
    // This prevents a malicious airgap device from returning a transaction
    // that would rekey the account to an attacker's address
    const rekeyField = txnAny.reKeyTo || txnAny.rekeyTo;
    if (rekeyField) {
      return {
        valid: false,
        error: 'Security error: Verification transaction must not contain a rekey field',
      };
    }

    // For verification transactions, we expect a self-payment where
    // sender = receiver = expectedSignerAddress
    // This proves the airgap device controls the expected address
    const senderField = txnAny.from || txnAny.sender || txnAny.snd;
    const senderAddress = senderField?.publicKey
      ? algosdk.encodeAddress(senderField.publicKey)
      : String(senderField || '');

    // Verify the transaction sender matches the expected signer
    // For our verification flow, we create a self-payment so sender should be the signer
    if (senderAddress.toUpperCase() !== expectedSignerAddress.toUpperCase()) {
      return {
        valid: false,
        error: `Transaction sender ${senderAddress} does not match expected signer ${expectedSignerAddress}`,
      };
    }

    // Get the bytes that were signed (TX prefix + encoded transaction)
    const txnBytesToSign = txn.bytesToSign();

    // Decode the expected signer's public key from address
    const expectedPublicKey = algosdk.decodeAddress(expectedSignerAddress).publicKey;

    // Verify the Ed25519 signature
    const isValid = nacl.sign.detached.verify(
      txnBytesToSign,
      signedTxn.sig,
      expectedPublicKey
    );

    if (!isValid) {
      return {
        valid: false,
        error: 'Signature verification failed - signature does not match the expected signer',
      };
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      valid: false,
      error: `Failed to verify signature: ${message}`,
    };
  }
}

/**
 * Extract components from a signed transaction for manual verification.
 *
 * @param signedTxnBytes - Raw bytes of the signed transaction
 * @returns Transaction components or null if extraction fails
 */
export function extractTransactionComponents(
  signedTxnBytes: Uint8Array
): TransactionComponents | null {
  try {
    const signedTxn = algosdk.decodeSignedTransaction(signedTxnBytes);

    if (!signedTxn.sig) {
      return null;
    }

    const txn = signedTxn.txn;
    const txnBytesToSign = txn.bytesToSign();

    // Get signer public key from sender address
    // Handle both algosdk v2 and v3 field names
    const txnAny = txn as any;
    const senderField = txnAny.from || txnAny.sender || txnAny.snd;
    const signerPublicKey = senderField?.publicKey;
    if (!signerPublicKey) {
      return null;
    }

    const signerAddress = algosdk.encodeAddress(signerPublicKey);

    return {
      txnBytes: txnBytesToSign,
      signature: signedTxn.sig,
      signerPublicKey,
      signerAddress,
    };
  } catch {
    return null;
  }
}

/**
 * Verify an Ed25519 signature directly.
 * Useful when you already have the components separated.
 *
 * @param message - The message bytes that were signed
 * @param signature - The 64-byte Ed25519 signature
 * @param publicKey - The 32-byte Ed25519 public key
 * @returns true if signature is valid
 */
export function verifyEd25519Signature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

/**
 * Verify a signed transaction from raw bytes.
 *
 * @param signedTxnBytes - Raw bytes of the signed transaction
 * @param expectedSignerAddress - The Algorand address that should have signed
 * @returns Verification result
 */
export function verifySignedTransactionBytes(
  signedTxnBytes: Uint8Array,
  expectedSignerAddress: string
): VerificationResult {
  const base64 = Buffer.from(signedTxnBytes).toString('base64');
  return verifySignedTransaction(base64, expectedSignerAddress);
}
