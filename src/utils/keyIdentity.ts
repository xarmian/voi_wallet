import algosdk from 'algosdk';

/**
 * TASK-421 (b) U2: the address a 64-byte Algorand secret key actually controls,
 * derived from its SEED (the first 32 bytes), which is also what the recovery
 * phrase encodes. Checking only the appended public half is not enough: a
 * buffer of A's seed followed by B's public key would pass for B and reveal A's
 * phrase. Returns null for a key of the wrong length. The re-derived key copy
 * is wiped before returning.
 */
export function seedDerivedAddress(secretKey: Uint8Array): string | null {
  if (secretKey.length !== 64) return null;
  const derived = algosdk.mnemonicToSecretKey(
    algosdk.secretKeyToMnemonic(secretKey)
  );
  try {
    return derived.addr.toString();
  } finally {
    derived.sk.fill(0);
  }
}

/** True only if the key's seed AND its appended public half are `address`'s. */
export function keyBelongsToAddress(
  secretKey: Uint8Array,
  address: string
): boolean {
  if (secretKey.length !== 64) return false;
  return (
    seedDerivedAddress(secretKey) === address &&
    algosdk.encodeAddress(secretKey.slice(32, 64)) === address
  );
}
