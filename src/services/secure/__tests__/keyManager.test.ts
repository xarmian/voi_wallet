// TASK-156 — P0 unit tests for SecureKeyManager (src/services/secure/keyManager.ts).
//
// Scope: wallet lookup, rekey-aware signing, key cleanup after use, and error
// paths. These are the highest-risk key/signing surfaces in the wallet.
//
// SECURITY / DR-3 (non-negotiable): every key and signature exercised here is
// REAL crypto. Accounts come from the shared algosdk-derived fixtures
// (`makeAccount`), signatures are produced by the real `algosdk.signTransaction`
// inside the code under test, and verified independently with tweetnacl over
// `Transaction.bytesToSign()`. There is NO fabricated/mocked private key or
// signature anywhere. The ONLY things mocked are the boundaries the task allows:
//   - the secure-store layer (`AccountSecureStorage`) — it hands back a REAL
//     fixture secret key (a copy, so the manager's `fill(0)` cannot corrupt the
//     canonical fixture bytes) exactly as the real store would return real bytes;
//   - the Ledger leaf transports (`@/services/ledger/*`), which pull in native
//     BLE/HID modules that can't load under jest;
//   - the wallet registry + network rekey lookup, which are I/O the manager
//     merely reads from.
//
// No key/mnemonic material is ever written to logs by these tests, and one test
// actively asserts the manager itself does not leak key material to the console.

// ---------------------------------------------------------------------------
// Mock control surface (declared before jest.mock factories reference them).
// ---------------------------------------------------------------------------

const mockGetCurrentWallet = jest.fn();
const mockUpdateLedgerAccountDevice = jest.fn(
  async (..._args: unknown[]) => {}
);
const mockSecureGetPrivateKey = jest.fn();
const mockGetAccountRekeyInfo = jest.fn();
const mockFindSigningAccount = jest.fn();

const mockLedgerSignTransaction = jest.fn();
const mockLedgerVerifyApp = jest.fn(async (..._args: unknown[]) => {});
const mockGetConnectedDevice = jest.fn((): { id: string } | null => null);
const mockGetDevices = jest.fn((): unknown[] => []);

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: () => mockGetCurrentWallet(),
    updateLedgerAccountDevice: (...args: unknown[]) =>
      mockUpdateLedgerAccountDevice(...args),
  },
}));

jest.mock('../AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getPrivateKey: (...args: unknown[]) => mockSecureGetPrivateKey(...args),
    clearAll: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getAccountRekeyInfo: (...args: unknown[]) =>
        mockGetAccountRekeyInfo(...args),
    }),
  },
}));

jest.mock('@/services/wallet/rekeyManager', () => ({
  __esModule: true,
  default: {
    findSigningAccount: (...args: unknown[]) => mockFindSigningAccount(...args),
  },
}));

jest.mock('@/services/ledger/algorand', () => ({
  ledgerAlgorandService: {
    signTransaction: (...args: unknown[]) => mockLedgerSignTransaction(...args),
    verifyApp: (...args: unknown[]) => mockLedgerVerifyApp(...args),
  },
}));

jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {
    getConnectedDevice: () => mockGetConnectedDevice(),
    getDevices: () => mockGetDevices(),
    initialize: jest.fn(async () => {}),
    waitForDevice: jest.fn(async () => undefined),
    connect: jest.fn(async () => {}),
  },
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import nacl from 'tweetnacl';

import { AccountType, AuthenticationRequiredError } from '@/types/wallet';
import { SecureKeyManager } from '../keyManager';
import {
  makeAccount,
  paymentTxn,
  type TestAccount,
} from '@/__tests__/fixtures/algorand';

// ---------------------------------------------------------------------------
// Fixtures — real, deterministic, algosdk-derived accounts.
// ---------------------------------------------------------------------------

const OWNER = makeAccount('keymanager:owner'); // standard, signs for itself
const AUTH = makeAccount('keymanager:auth-signer'); // holds the rekey signing key
const REKEYED = makeAccount('keymanager:rekeyed'); // rekeyed away to AUTH
const OTHER = makeAccount('keymanager:other'); // unrelated, never in wallet
const LEDGER = makeAccount('keymanager:ledger'); // hardware-controlled

/** Registry mapping account id -> the REAL fixture secret key (64-byte sk). */
const keyRegistry = new Map<string, Uint8Array>();
/** Every key buffer handed out by the (mocked) secure store, for cleanup asserts. */
let handedOutKeys: Uint8Array[] = [];

function standardAccount(acct: TestAccount, id: string) {
  keyRegistry.set(id, acct.sk);
  return {
    id,
    address: acct.addr,
    publicKey: Buffer.from(acct.pk).toString('hex'),
    type: AccountType.STANDARD,
    mnemonic: acct.mnemonic,
    hasBackup: true,
    isHidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsed: '2024-01-01T00:00:00.000Z',
  };
}

function watchAccount(acct: TestAccount, id: string) {
  return {
    id,
    address: acct.addr,
    publicKey: Buffer.from(acct.pk).toString('hex'),
    type: AccountType.WATCH,
    isHidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsed: '2024-01-01T00:00:00.000Z',
  };
}

function ledgerAccount(acct: TestAccount, id: string) {
  return {
    id,
    address: acct.addr,
    publicKey: Buffer.from(acct.pk).toString('hex'),
    type: AccountType.LEDGER,
    deviceId: `device-${id}`,
    derivationIndex: 0,
    derivationPath: "44'/283'/0'/0/0",
    deviceName: 'Test Ledger',
    isHidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsed: '2024-01-01T00:00:00.000Z',
  };
}

function setWallet(accounts: unknown[]) {
  mockGetCurrentWallet.mockResolvedValue({
    id: 'wallet-1',
    version: '2.0',
    createdAt: '2024-01-01T00:00:00.000Z',
    accounts,
  });
}

/**
 * Verify (independently, via tweetnacl over the real bytesToSign) that a signed
 * blob carries a valid Ed25519 signature for `expectedSignerPk` and, when
 * `notSignerPk` is given, does NOT verify against that other key. Confirms the
 * manager signed with the intended (rekey-resolved) key.
 */
function assertSignedBy(
  blob: Uint8Array,
  expectedSignerPk: Uint8Array,
  notSignerPk?: Uint8Array
) {
  const decoded = algosdk.decodeSignedTransaction(blob);
  expect(decoded.sig).toBeDefined();
  const message = decoded.txn.bytesToSign();
  expect(
    nacl.sign.detached.verify(message, decoded.sig!, expectedSignerPk)
  ).toBe(true);
  if (notSignerPk) {
    expect(nacl.sign.detached.verify(message, decoded.sig!, notSignerPk)).toBe(
      false
    );
  }
}

beforeEach(() => {
  keyRegistry.clear();
  handedOutKeys = [];

  mockGetCurrentWallet.mockReset();
  mockGetCurrentWallet.mockResolvedValue(null);

  mockSecureGetPrivateKey.mockReset();
  mockSecureGetPrivateKey.mockImplementation(async (id: string) => {
    const sk = keyRegistry.get(id);
    if (!sk) {
      throw new Error(`No key stored for account ${id}`);
    }
    // Hand out a COPY of the real key so the manager's fill(0) cleanup cannot
    // corrupt the canonical fixture bytes; capture it to assert it was zeroed.
    const copy = Uint8Array.from(sk);
    handedOutKeys.push(copy);
    return copy;
  });

  mockGetAccountRekeyInfo.mockReset();
  mockGetAccountRekeyInfo.mockResolvedValue({ isRekeyed: false });

  mockFindSigningAccount.mockReset();
  mockUpdateLedgerAccountDevice.mockClear();
  mockLedgerSignTransaction.mockReset();
  mockLedgerVerifyApp.mockClear();
  mockGetConnectedDevice.mockReset();
  mockGetConnectedDevice.mockReturnValue(null);
  mockGetDevices.mockReset();
  mockGetDevices.mockReturnValue([]);
});

afterEach(() => {
  // Key hygiene: zero every copy the (mocked) secure store handed out, even the
  // ones the manager under test did not itself wipe (e.g. bare getPrivateKey,
  // whose caller owns cleanup). The canonical fixture keys in `keyRegistry` are
  // deliberately NOT zeroed here — they are the shared module-global originals
  // and are throwaway, deterministic, label-derived test keys (never real user
  // material). Zeroing the handed-out copies keeps live key bytes from lingering
  // across tests without corrupting the fixtures.
  for (const key of handedOutKeys) {
    key.fill(0);
  }
});

// ===========================================================================
// getPrivateKey — wallet lookup + error paths
// ===========================================================================

describe('SecureKeyManager.getPrivateKey (wallet lookup)', () => {
  it('returns the real secret key for a matching address', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);

    const key = await SecureKeyManager.getPrivateKey({
      address: OWNER.addr,
      purpose: 'transaction',
    });

    // Byte-for-byte the real algosdk secret key (seed(32)||pubkey(32)).
    expect(Buffer.from(key).toString('hex')).toBe(
      Buffer.from(OWNER.sk).toString('hex')
    );
    // Looked the key up by the account's id, not its address.
    expect(mockSecureGetPrivateKey).toHaveBeenCalledWith(
      'acc-owner',
      undefined
    );
  });

  it('forwards the PIN to the secure store', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);

    await SecureKeyManager.getPrivateKey(
      { address: OWNER.addr, purpose: 'export' },
      '123456'
    );

    expect(mockSecureGetPrivateKey).toHaveBeenCalledWith('acc-owner', '123456');
  });

  it('throws when no wallet exists', async () => {
    mockGetCurrentWallet.mockResolvedValue(null);

    await expect(
      SecureKeyManager.getPrivateKey({
        address: OWNER.addr,
        purpose: 'transaction',
      })
    ).rejects.toThrow('No wallet found');
  });

  it('throws when the address is not in the wallet', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);

    await expect(
      SecureKeyManager.getPrivateKey({
        address: OTHER.addr,
        purpose: 'transaction',
      })
    ).rejects.toThrow('Account not found');
    expect(mockSecureGetPrivateKey).not.toHaveBeenCalled();
  });

  it('preserves AuthenticationRequiredError as-is (not wrapped)', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);
    mockSecureGetPrivateKey.mockRejectedValueOnce(
      new AuthenticationRequiredError('PIN required')
    );

    await expect(
      SecureKeyManager.getPrivateKey({
        address: OWNER.addr,
        purpose: 'transaction',
      })
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it('wraps non-auth store failures with a descriptive message', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);
    mockSecureGetPrivateKey.mockRejectedValueOnce(new Error('keystore boom'));

    await expect(
      SecureKeyManager.getPrivateKey({
        address: OWNER.addr,
        purpose: 'transaction',
      })
    ).rejects.toThrow('Failed to retrieve private key: keystore boom');
  });
});

// ===========================================================================
// signTransaction — real signing, rekey-aware resolution
// ===========================================================================

describe('SecureKeyManager.signTransaction (real algosdk signing)', () => {
  it('signs a non-rekeyed standard account with its own key (verifies)', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);
    const txn = paymentTxn(OWNER.addr);

    const blob = await SecureKeyManager.signTransaction(txn, OWNER.addr);

    // Real signature, verified independently against the owner's public key.
    assertSignedBy(blob, OWNER.pk, OTHER.pk);
    // Signed with the owner's own key material.
    expect(mockSecureGetPrivateKey).toHaveBeenCalledWith(
      'acc-owner',
      undefined
    );
  });

  it('rekey-aware: signs with the AUTH account key, not the sender key', async () => {
    // REKEYED (a watch-only entry we no longer hold the key for) is rekeyed on
    // this network to AUTH, whose standard key we DO hold.
    setWallet([
      watchAccount(REKEYED, 'acc-rekeyed'),
      standardAccount(AUTH, 'acc-auth'),
    ]);
    mockGetAccountRekeyInfo.mockResolvedValue({
      isRekeyed: true,
      authAddress: AUTH.addr,
    });
    const txn = paymentTxn(REKEYED.addr);

    const blob = await SecureKeyManager.signTransaction(txn, REKEYED.addr);

    // The signature MUST verify against AUTH's key and MUST NOT verify against
    // the sender's (REKEYED) key — proving rekey resolution picked the right key.
    assertSignedBy(blob, AUTH.pk, REKEYED.pk);
    // The auth account's id (not the sender's) was used for key retrieval.
    expect(mockSecureGetPrivateKey).toHaveBeenCalledWith('acc-auth', undefined);
    expect(mockSecureGetPrivateKey).not.toHaveBeenCalledWith(
      'acc-rekeyed',
      undefined
    );
    // Rekey status was resolved for the SENDER address (not the auth address)
    // and with skipTimestamp=true — querying the wrong account here would let a
    // multi-network rekey regression slip through.
    expect(mockGetAccountRekeyInfo).toHaveBeenCalledWith(REKEYED.addr, true);
    // The auth key copy the manager signed with was zeroed on the way out.
    expect(handedOutKeys).toHaveLength(1);
    expect(Array.from(handedOutKeys[0])).toEqual(
      Array.from(new Uint8Array(64))
    );
  });

  it('forwards the PIN to the secure store when signing', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);
    const txn = paymentTxn(OWNER.addr);

    const blob = await SecureKeyManager.signTransaction(
      txn,
      OWNER.addr,
      '654321'
    );

    // A dropped PIN would still produce a valid signature here, so assert the
    // PIN actually reached the secure store rather than only checking the blob.
    assertSignedBy(blob, OWNER.pk);
    expect(mockSecureGetPrivateKey).toHaveBeenCalledWith('acc-owner', '654321');
  });

  it('fails closed when rekeyed with no resolvable auth address', async () => {
    // isRekeyed with a missing authAddress must NOT silently fall back to
    // signing with the sender's (absent) key — it must fail without producing
    // any signature or touching key material.
    setWallet([watchAccount(REKEYED, 'acc-rekeyed')]);
    mockGetAccountRekeyInfo.mockResolvedValue({ isRekeyed: true });
    const txn = paymentTxn(REKEYED.addr);

    await expect(
      SecureKeyManager.signTransaction(txn, REKEYED.addr)
    ).rejects.toThrow();
    // No AUTH key was ever fetched.
    expect(handedOutKeys).toHaveLength(0);
  });

  it('throws when rekeyed but the signing key is not in the wallet', async () => {
    // Rekeyed to OTHER, which is not present among our accounts.
    setWallet([watchAccount(REKEYED, 'acc-rekeyed')]);
    mockGetAccountRekeyInfo.mockResolvedValue({
      isRekeyed: true,
      authAddress: OTHER.addr,
    });
    const txn = paymentTxn(REKEYED.addr);

    await expect(
      SecureKeyManager.signTransaction(txn, REKEYED.addr)
    ).rejects.toThrow('signing key not available');
    expect(mockSecureGetPrivateKey).not.toHaveBeenCalled();
  });

  it('refuses to sign for a non-rekeyed watch-only account', async () => {
    setWallet([watchAccount(REKEYED, 'acc-watch')]);
    mockGetAccountRekeyInfo.mockResolvedValue({ isRekeyed: false });
    const txn = paymentTxn(REKEYED.addr);

    await expect(
      SecureKeyManager.signTransaction(txn, REKEYED.addr)
    ).rejects.toThrow('Cannot sign transactions for watch-only accounts');
    expect(mockSecureGetPrivateKey).not.toHaveBeenCalled();
  });

  it('throws when the sender address is not in the wallet', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);
    const txn = paymentTxn(OTHER.addr);

    await expect(
      SecureKeyManager.signTransaction(txn, OTHER.addr)
    ).rejects.toThrow('Account not found');
  });

  it('throws when no wallet exists', async () => {
    mockGetCurrentWallet.mockResolvedValue(null);
    const txn = paymentTxn(OWNER.addr);

    await expect(
      SecureKeyManager.signTransaction(txn, OWNER.addr)
    ).rejects.toThrow('No wallet found');
  });
});

// ===========================================================================
// Ledger signing paths (leaf transport mocked; no fabricated keys involved)
// ===========================================================================

describe('SecureKeyManager.signTransaction (Ledger paths)', () => {
  it('routes a direct Ledger account to the Ledger service', async () => {
    setWallet([ledgerAccount(LEDGER, 'acc-ledger')]);
    mockGetConnectedDevice.mockReturnValue({ id: 'device-acc-ledger' });
    const ledgerBlob = new Uint8Array([1, 2, 3, 4]);
    mockLedgerSignTransaction.mockResolvedValue({
      signedTransaction: ledgerBlob,
    });
    const txn = paymentTxn(LEDGER.addr);

    const result = await SecureKeyManager.signTransaction(txn, LEDGER.addr);

    expect(result).toBe(ledgerBlob);
    expect(mockLedgerSignTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        signerAddress: LEDGER.addr,
        derivationIndex: 0,
      })
    );
    // Ledger signing never touches the software secure store.
    expect(mockSecureGetPrivateKey).not.toHaveBeenCalled();
  });

  it('normalizes an unexpected Ledger failure to a LedgerAccountError', async () => {
    setWallet([ledgerAccount(LEDGER, 'acc-ledger')]);
    mockGetConnectedDevice.mockReturnValue({ id: 'device-acc-ledger' });
    mockLedgerSignTransaction.mockRejectedValue(new Error('usb glitch'));
    const txn = paymentTxn(LEDGER.addr);

    await expect(
      SecureKeyManager.signTransaction(txn, LEDGER.addr)
    ).rejects.toMatchObject({ name: 'LedgerAccountError' });
  });

  it('rekey-aware: routes to Ledger when the auth account is Ledger-controlled', async () => {
    setWallet([
      watchAccount(REKEYED, 'acc-rekeyed'),
      ledgerAccount(LEDGER, 'acc-ledger'),
    ]);
    mockGetAccountRekeyInfo.mockResolvedValue({
      isRekeyed: true,
      authAddress: LEDGER.addr,
    });
    mockGetConnectedDevice.mockReturnValue({ id: 'device-acc-ledger' });
    const ledgerBlob = new Uint8Array([9, 9, 9]);
    mockLedgerSignTransaction.mockResolvedValue({
      signedTransaction: ledgerBlob,
    });
    const txn = paymentTxn(REKEYED.addr);

    const result = await SecureKeyManager.signTransaction(txn, REKEYED.addr);

    expect(result).toBe(ledgerBlob);
    // Signs with the Ledger auth address, never the software store.
    expect(mockLedgerSignTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ signerAddress: LEDGER.addr })
    );
    expect(mockSecureGetPrivateKey).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Key cleanup — the manager must zero handed-out key material after use
// ===========================================================================

describe('SecureKeyManager key cleanup', () => {
  it('zeroes the private key after a successful signature', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);
    const txn = paymentTxn(OWNER.addr);

    await SecureKeyManager.signTransaction(txn, OWNER.addr);

    expect(handedOutKeys).toHaveLength(1);
    // The exact buffer the manager signed with is fully zeroed.
    expect(Array.from(handedOutKeys[0])).toEqual(
      Array.from(new Uint8Array(64))
    );
  });

  it('zeroes the private key even when signing throws (finally cleanup)', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);
    // A null transaction makes the real algosdk.signTransaction throw AFTER the
    // key has been fetched — the finally block must still wipe it.
    await expect(
      SecureKeyManager.signTransaction(null, OWNER.addr)
    ).rejects.toBeDefined();

    expect(handedOutKeys).toHaveLength(1);
    expect(Array.from(handedOutKeys[0])).toEqual(
      Array.from(new Uint8Array(64))
    );
  });

  it('does not leak key or mnemonic material to the console', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);

    const spies = [
      jest.spyOn(console, 'log').mockImplementation(() => {}),
      jest.spyOn(console, 'warn').mockImplementation(() => {}),
      jest.spyOn(console, 'error').mockImplementation(() => {}),
      jest.spyOn(console, 'info').mockImplementation(() => {}),
      jest.spyOn(console, 'debug').mockImplementation(() => {}),
    ];

    try {
      const txn = paymentTxn(OWNER.addr);
      await SecureKeyManager.signTransaction(txn, OWNER.addr);
      await SecureKeyManager.getMnemonic(OWNER.addr);
      // Also exercise an error path — failure logging is a classic leak site.
      await expect(
        SecureKeyManager.signTransaction(null, OWNER.addr)
      ).rejects.toBeDefined();

      // Every plausible serialization of the secret an accidental log could take:
      // hex, base64, decimal-byte arrays (how a Uint8Array/Buffer stringifies),
      // and the full mnemonic. (Individual mnemonic words are intentionally NOT
      // checked — short BIP39 words collide as substrings of ordinary log text.)
      const forbidden = [
        OWNER.mnemonic,
        Buffer.from(OWNER.sk).toString('hex'),
        Buffer.from(OWNER.sk.slice(0, 32)).toString('hex'), // seed half
        Buffer.from(OWNER.sk).toString('base64'),
        Array.from(OWNER.sk).join(','), // Uint8Array/Buffer decimal serialization
      ];
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .flat()
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`;
          if (arg instanceof Uint8Array) return Array.from(arg).join(',');
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join('\n');

      for (const secret of forbidden) {
        // Guard against a degenerate empty needle matching everything.
        expect(secret.length).toBeGreaterThan(0);
        expect(logged.includes(secret)).toBe(false);
      }
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ===========================================================================
// getMnemonic — recovery-phrase retrieval + key cleanup
// ===========================================================================

describe('SecureKeyManager.getMnemonic', () => {
  it('returns the stored mnemonic without touching the secure store', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);

    const mnemonic = await SecureKeyManager.getMnemonic(OWNER.addr);

    expect(mnemonic).toBe(OWNER.mnemonic);
    // Round-trips to the real fixture address (Algorand/Pera compatibility).
    expect(algosdk.mnemonicToSecretKey(mnemonic).addr.toString()).toBe(
      OWNER.addr
    );
    expect(mockSecureGetPrivateKey).not.toHaveBeenCalled();
  });

  it('derives the mnemonic from the stored key and zeroes it when none is cached', async () => {
    const acct = standardAccount(OWNER, 'acc-owner');
    // Simulate a standard account whose plaintext mnemonic is not retained.
    (acct as { mnemonic: string }).mnemonic = '';
    setWallet([acct]);

    const mnemonic = await SecureKeyManager.getMnemonic(OWNER.addr);

    // Real derivation from the real key.
    expect(mnemonic).toBe(OWNER.mnemonic);
    expect(mockSecureGetPrivateKey).toHaveBeenCalledWith('acc-owner');
    // The key buffer used for derivation was wiped afterward.
    expect(handedOutKeys).toHaveLength(1);
    expect(Array.from(handedOutKeys[0])).toEqual(
      Array.from(new Uint8Array(64))
    );
  });

  it('rejects for account types without a recovery phrase', async () => {
    setWallet([ledgerAccount(LEDGER, 'acc-ledger')]);

    await expect(SecureKeyManager.getMnemonic(LEDGER.addr)).rejects.toThrow(
      'does not have a recovery phrase'
    );
  });

  it('wraps a missing account in a descriptive error', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);

    await expect(SecureKeyManager.getMnemonic(OTHER.addr)).rejects.toThrow(
      'Failed to retrieve recovery phrase: Account not found'
    );
  });
});

// ===========================================================================
// getSigningInfo — non-signing rekey resolution surface
// ===========================================================================

describe('SecureKeyManager.getSigningInfo', () => {
  it('reports a standard account as directly signable', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);

    const info = await SecureKeyManager.getSigningInfo(OWNER.addr);

    expect(info).toMatchObject({
      canSign: true,
      signingAddress: OWNER.addr,
      signingAccountId: 'acc-owner',
      isRekeyed: false,
    });
  });

  it('resolves a REKEYED account via RekeyManager.findSigningAccount', async () => {
    const rekeyed = {
      id: 'acc-rekeyed',
      address: REKEYED.addr,
      publicKey: Buffer.from(REKEYED.pk).toString('hex'),
      type: AccountType.REKEYED,
      authAddress: AUTH.addr,
      canSign: true,
      isHidden: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T00:00:00.000Z',
    };
    setWallet([rekeyed, standardAccount(AUTH, 'acc-auth')]);
    mockFindSigningAccount.mockReturnValue({ id: 'acc-auth' });

    const info = await SecureKeyManager.getSigningInfo(REKEYED.addr);

    expect(info).toMatchObject({
      canSign: true,
      signingAddress: AUTH.addr,
      signingAccountId: 'acc-auth',
      isRekeyed: true,
      authAddress: AUTH.addr,
    });
  });

  it('reports a watch account with no rekey as not signable', async () => {
    setWallet([watchAccount(REKEYED, 'acc-watch')]);
    mockGetAccountRekeyInfo.mockResolvedValue({ isRekeyed: false });

    const info = await SecureKeyManager.getSigningInfo(REKEYED.addr);

    expect(info).toMatchObject({ canSign: false, isRekeyed: false });
  });

  it('returns a safe non-signable result when no wallet exists', async () => {
    mockGetCurrentWallet.mockResolvedValue(null);

    const info = await SecureKeyManager.getSigningInfo(OWNER.addr);

    expect(info).toMatchObject({
      canSign: false,
      signingAddress: OWNER.addr,
      isRekeyed: false,
    });
  });
});

// ===========================================================================
// hasEncryptedMnemonic — wallet presence probe
// ===========================================================================

describe('SecureKeyManager.hasEncryptedMnemonic', () => {
  it('is true when the wallet has at least one account', async () => {
    setWallet([standardAccount(OWNER, 'acc-owner')]);
    await expect(SecureKeyManager.hasEncryptedMnemonic()).resolves.toBe(true);
  });

  it('is false when there is no wallet', async () => {
    mockGetCurrentWallet.mockResolvedValue(null);
    await expect(SecureKeyManager.hasEncryptedMnemonic()).resolves.toBe(false);
  });

  it('is false when the wallet has no accounts', async () => {
    setWallet([]);
    await expect(SecureKeyManager.hasEncryptedMnemonic()).resolves.toBe(false);
  });
});
