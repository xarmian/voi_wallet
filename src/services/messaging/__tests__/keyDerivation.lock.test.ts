// Unit test for the messaging cache-write lock guard (DOC-137 §6.5 / Codex
// P1-E race fix). A messaging keypair derived while the app is LOCKED must NOT
// be written to the ~30 min cache, and its freshly derived secret must be
// zeroed — this closes the race where a derivation that started before a lock
// resolves after it and repopulates the cache (poll AND direct thread-fetch
// paths both funnel through the single cache-write site).
//
// SECURITY NOTE: a throwaway tweetnacl keypair stands in for the wallet secret
// key; no real key material is used.

import nacl from 'tweetnacl';
import {
  deriveMessagingKeyPairFromSecret,
  getCachedKeyPair,
  clearAllCachedKeys,
} from '../keyDerivation';
import { AppLockSignal } from '@/services/secure/appLockState';

const ADDRESS = 'TESTADDRESS0000000000000000000000000000000000000000000';

// A valid 64-byte Ed25519 secret key (throwaway).
const ed25519SecretKey = nacl.sign.keyPair().secretKey;

beforeEach(() => {
  clearAllCachedKeys();
  AppLockSignal.setUnlocked(true); // default to unlocked between tests
});

afterEach(() => {
  clearAllCachedKeys();
  AppLockSignal.setUnlocked(true);
});

describe('messaging key cache-write lock guard', () => {
  it('caches the derived keypair when the app is UNLOCKED', () => {
    AppLockSignal.setUnlocked(true);

    const keyPair = deriveMessagingKeyPairFromSecret(ed25519SecretKey, ADDRESS);

    expect(keyPair.secretKey.some((b) => b !== 0)).toBe(true);
    expect(getCachedKeyPair(ADDRESS)).not.toBeNull();
  });

  it('does NOT cache (and zeroes the secret) when the app is LOCKED', () => {
    AppLockSignal.setUnlocked(false);

    const keyPair = deriveMessagingKeyPairFromSecret(ed25519SecretKey, ADDRESS);

    // Cache stays empty — a locked device cannot hold a live messaging key.
    expect(getCachedKeyPair(ADDRESS)).toBeNull();
    // The freshly derived secret was scrubbed rather than returned live.
    expect(Array.from(keyPair.secretKey).every((b) => b === 0)).toBe(true);
  });
});
