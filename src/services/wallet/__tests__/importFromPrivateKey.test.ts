// Unit tests for TASK-124: MultiAccountWalletService.importFromPrivateKey and
// the shared validateAndParseSecretKey helper it delegates to.
//
// SECURITY NOTE: no static/committed secret material is used. Every key here is
// generated fresh in-process by algosdk (ephemeral, throwaway). The test's whole
// point is the crypto invariant that an Algorand secret key is seed(32) ||
// publicKey(32) and that a key whose appended public key no longer matches the
// seed MUST be rejected rather than silently imported at the wrong address.
//
// We exercise the public importFromPrivateKey (used by the QR-preview path via
// accountQRParser), which shares validateAndParseSecretKey with the real import
// path (parsePrivateKey), so both stay in sync.

// Mock the heavy/native side of the wallet dependency graph. importFromPrivateKey
// only uses algosdk, so these mocks keep the import lightweight without touching
// the code under test. (The Ledger transport pulls in untranspilable native ESM.)
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({
  ledgerAlgorandService: {},
}));
jest.mock('@/services/network', () => ({
  NetworkService: {},
}));
jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {},
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { MultiAccountWalletService } from '../index';

function skToHex(sk: Uint8Array): string {
  return Buffer.from(sk).toString('hex');
}

describe('MultiAccountWalletService.importFromPrivateKey (TASK-124)', () => {
  it('accepts a freshly generated, well-formed key and returns its address', () => {
    const account = algosdk.generateAccount();
    const hex = skToHex(account.sk);

    const result = MultiAccountWalletService.importFromPrivateKey(hex);

    expect(result.address).toBe(account.addr.toString());
    expect(Buffer.from(result.publicKey).toString('hex')).toBe(
      skToHex(account.sk.slice(32))
    );
  });

  it('accepts a valid key with a 0x prefix and surrounding whitespace', () => {
    const account = algosdk.generateAccount();
    const hex = `  0x${skToHex(account.sk)}  `;

    const result = MultiAccountWalletService.importFromPrivateKey(hex);

    expect(result.address).toBe(account.addr.toString());
  });

  it('round-trips a mnemonic-exported key unchanged (Pera/algosdk compatibility)', () => {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
    const reDerived = algosdk.mnemonicToSecretKey(mnemonic);

    const result = MultiAccountWalletService.importFromPrivateKey(
      skToHex(reDerived.sk)
    );

    expect(result.address).toBe(account.addr.toString());
  });

  it('rejects a key whose appended public key was byte-flipped (pubkey/seed mismatch)', () => {
    const account = algosdk.generateAccount();
    const corrupted = Uint8Array.from(account.sk);
    // Flip a bit in the appended public-key half (last 32 bytes) so it no longer
    // matches the seed. The seed (first 32 bytes) is untouched.
    corrupted[40] ^= 0xff;

    expect(() =>
      MultiAccountWalletService.importFromPrivateKey(skToHex(corrupted))
    ).toThrow('public key does not match the seed');
  });

  it('rejects a non-hex key', () => {
    expect(() =>
      MultiAccountWalletService.importFromPrivateKey('z'.repeat(128))
    ).toThrow('must be hexadecimal');
  });

  it('rejects a key of the wrong length', () => {
    const account = algosdk.generateAccount();
    const shortHex = skToHex(account.sk).slice(0, 126);

    expect(() =>
      MultiAccountWalletService.importFromPrivateKey(shortHex)
    ).toThrow('128 hex characters');
  });

  it('rejects an empty key', () => {
    expect(() => MultiAccountWalletService.importFromPrivateKey('')).toThrow(
      'non-empty string'
    );
  });
});
