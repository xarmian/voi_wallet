/**
 * Unit tests for the remote-signer signing router.
 *
 * The router (`src/services/remoteSigner/signingRouter.ts`) is the policy layer
 * that classifies accounts by {@link AccountType} and decides HOW a set of
 * transactions must be signed: locally, via Ledger, via the air-gapped remote
 * signer (QR), or not at all (watch / no signable account). It also owns the
 * base64→`algosdk.Transaction` decode step it delegates to
 * `RemoteSignerService.createSigningRequest`, and the fail-closed rejection
 * (`validateNotRemoteSigner`) that stops a remote-signer account from ever
 * flowing into the local signing path.
 *
 * DR-3: every account here carries a REAL Algorand address derived from a
 * deterministic Ed25519 seed (tweetnacl) — never a fabricated string masquerading
 * as an address. Transactions used for the decode-delegation tests are REAL
 * algosdk transactions, encoded with the real msgpack codec, so the decode is
 * exercised end-to-end. No private keys or mnemonics are logged.
 *
 * Only the heavy `RemoteSignerService.createSigningRequest` collaborator (which
 * reaches the network/service graph and is covered by its own suite) is spied on
 * — the router's job is to hand it correctly-decoded inputs, not to re-test it.
 */

// The router's module graph (→ RemoteSignerService → keyManager → wallet →
// ledger/transport) statically imports the @ledgerhq native BLE/HID transport
// leaves, which pull untranspiled ESM (uuid) that jest cannot load. The router
// never touches Ledger, so stub the leaf transports out (hoisted above imports).
jest.mock('@ledgerhq/react-native-hw-transport-ble', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('@ledgerhq/react-native-hid', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('@ledgerhq/hw-transport', () => ({
  __esModule: true,
  default: class {},
}));
// Ledger device storage (still statically imported) reaches AsyncStorage, whose
// native module is absent under jest. Stub the async key/value surface.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiGet: jest.fn(async () => []),
    multiSet: jest.fn(async () => {}),
  },
}));

import algosdk from 'algosdk';
import nacl from 'tweetnacl';

import {
  checkRemoteSigningRequired,
  filterRemoteSignerAccounts,
  determineSigningMethod,
  validateNotRemoteSigner,
  createRemoteSigningRequest,
  createRemoteSigningRequestFromBase64,
  RemoteSignerRequiredError,
} from '../signingRouter';
import { RemoteSignerService } from '../index';
import {
  AccountMetadata,
  AccountType,
  RemoteSignerAccountMetadata,
} from '@/types/wallet';

// ---------------------------------------------------------------------------
// Fixtures — REAL addresses from deterministic seeds (DR-3)
// ---------------------------------------------------------------------------

/** Deterministic, reproducible Algorand address from a fixed 32-byte seed. */
function seededAddress(seedByte: number): { addr: string; pkHex: string } {
  const seed = new Uint8Array(32).fill(seedByte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    addr: algosdk.encodeAddress(kp.publicKey),
    pkHex: Buffer.from(kp.publicKey).toString('hex'),
  };
}

let seedCounter = 1;

function baseFields(): {
  id: string;
  address: string;
  publicKey: string;
  isHidden: boolean;
  createdAt: string;
  lastUsed: string;
} {
  const { addr, pkHex } = seededAddress(seedCounter++);
  return {
    id: `acct-${addr.slice(0, 8)}`,
    address: addr,
    publicKey: pkHex,
    isHidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsed: '2024-01-01T00:00:00.000Z',
  };
}

function makeStandard(): AccountMetadata {
  return {
    ...baseFields(),
    type: AccountType.STANDARD,
    mnemonic: '', // never real key material; unused by the router
    hasBackup: true,
  };
}

function makeWatch(): AccountMetadata {
  return {
    ...baseFields(),
    type: AccountType.WATCH,
  };
}

function makeLedger(): AccountMetadata {
  return {
    ...baseFields(),
    type: AccountType.LEDGER,
    deviceId: 'ledger-device-abc',
    derivationIndex: 0,
    derivationPath: "44'/283'/0'/0/0",
  };
}

function makeRekeyed(): AccountMetadata {
  const auth = seededAddress(seedCounter++);
  return {
    ...baseFields(),
    type: AccountType.REKEYED,
    authAddress: auth.addr,
    canSign: false,
  };
}

function makeRemoteSigner(
  signerDeviceId = 'voi-signer-11111111'
): RemoteSignerAccountMetadata {
  return {
    ...baseFields(),
    type: AccountType.REMOTE_SIGNER,
    signerDeviceId,
    pairedAt: '2024-01-01T00:00:00.000Z',
  };
}

/** A REAL, msgpack-encodable unsigned payment transaction. */
function makeRealTxn(seedByte: number, amount = 0): algosdk.Transaction {
  const { addr } = seededAddress(seedByte);
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: addr,
    receiver: addr,
    amount,
    suggestedParams: {
      fee: 1000,
      firstValid: 1,
      lastValid: 1001,
      genesisID: 'voi-test-v1',
      genesisHash: new Uint8Array(32).fill(7),
      flatFee: true,
      minFee: 1000,
    } as algosdk.SuggestedParams,
  });
}

// ===========================================================================
// 1. Account classification — checkRemoteSigningRequired
// ===========================================================================

describe('checkRemoteSigningRequired — per-account classification', () => {
  it('classifies a REMOTE_SIGNER account as needing remote signing and echoes it', () => {
    const acct = makeRemoteSigner();
    const result = checkRemoteSigningRequired(acct);

    expect(result.needsRemoteSigning).toBe(true);
    expect(result.remoteSignerAccount).toBe(acct);
    expect(result.error).toBeUndefined();
  });

  it('classifies a WATCH account as unsignable (needsRemoteSigning false + error)', () => {
    const result = checkRemoteSigningRequired(makeWatch());

    expect(result.needsRemoteSigning).toBe(false);
    expect(result.remoteSignerAccount).toBeUndefined();
    expect(result.error).toBe('Watch accounts cannot sign transactions');
  });

  it('classifies a STANDARD account as local-signable (no remote, no error)', () => {
    const result = checkRemoteSigningRequired(makeStandard());

    expect(result.needsRemoteSigning).toBe(false);
    expect(result.remoteSignerAccount).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('classifies a LEDGER account as not-remote (no remote, no error)', () => {
    const result = checkRemoteSigningRequired(makeLedger());

    expect(result.needsRemoteSigning).toBe(false);
    expect(result.remoteSignerAccount).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('classifies a REKEYED account as not-remote (falls through, no error)', () => {
    const result = checkRemoteSigningRequired(makeRekeyed());

    expect(result.needsRemoteSigning).toBe(false);
    expect(result.remoteSignerAccount).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});

// ===========================================================================
// 2. filterRemoteSignerAccounts
// ===========================================================================

describe('filterRemoteSignerAccounts', () => {
  it('returns only the REMOTE_SIGNER accounts, preserving order', () => {
    const rs1 = makeRemoteSigner('dev-1');
    const rs2 = makeRemoteSigner('dev-2');
    const mixed: AccountMetadata[] = [
      makeStandard(),
      rs1,
      makeLedger(),
      rs2,
      makeWatch(),
    ];

    expect(filterRemoteSignerAccounts(mixed)).toEqual([rs1, rs2]);
  });

  it('returns an empty array when there are no remote signer accounts', () => {
    expect(
      filterRemoteSignerAccounts([makeStandard(), makeLedger(), makeWatch()])
    ).toEqual([]);
  });

  it('returns an empty array for an empty input', () => {
    expect(filterRemoteSignerAccounts([])).toEqual([]);
  });
});

// ===========================================================================
// 3. Signing-method precedence — determineSigningMethod
//    Precedence (highest → lowest): watch(cannot_sign) > remote_signer >
//    ledger > local(standard) > cannot_sign(none signable)
// ===========================================================================

describe('determineSigningMethod — precedence & classification', () => {
  it('maps a single STANDARD account to local signing', () => {
    const acct = makeStandard();
    const result = determineSigningMethod([acct]);

    expect(result.method).toBe('local');
    expect(result.accounts).toEqual([acct]);
    expect(result.error).toBeUndefined();
  });

  it('maps a single LEDGER account to ledger signing', () => {
    const acct = makeLedger();
    const result = determineSigningMethod([acct]);

    expect(result.method).toBe('ledger');
    expect(result.accounts).toEqual([acct]);
  });

  it('maps a single REMOTE_SIGNER account to remote_signer with its device id', () => {
    const acct = makeRemoteSigner('device-solo');
    const result = determineSigningMethod([acct]);

    expect(result.method).toBe('remote_signer');
    expect(result.accounts).toEqual([acct]);
    expect(result.signerDeviceIds).toEqual(['device-solo']);
  });

  it('maps a single WATCH account to cannot_sign with an error', () => {
    const result = determineSigningMethod([makeWatch()]);

    expect(result.method).toBe('cannot_sign');
    expect(result.error).toBe('Watch accounts cannot sign transactions');
  });

  it('WATCH takes top precedence: watch + remote_signer + ledger + standard → cannot_sign', () => {
    const result = determineSigningMethod([
      makeStandard(),
      makeLedger(),
      makeRemoteSigner(),
      makeWatch(),
    ]);

    expect(result.method).toBe('cannot_sign');
    expect(result.error).toBe('Watch accounts cannot sign transactions');
  });

  it('REMOTE_SIGNER outranks ledger + standard when no watch is present', () => {
    const rs = makeRemoteSigner('device-mix');
    const result = determineSigningMethod([makeStandard(), makeLedger(), rs]);

    expect(result.method).toBe('remote_signer');
    // Documented, intentional behaviour: remote-signer wins and ONLY the
    // remote-signer accounts are surfaced — the ledger/standard accounts are
    // dropped from `accounts`. Asserted explicitly (not hidden) so that if a
    // future atomic-group flow needs per-account signing of a mixed group, this
    // narrowing is visible and this test must be revisited.
    expect(result.accounts).toEqual([rs]);
    expect(result.signerDeviceIds).toEqual(['device-mix']);
  });

  it('LEDGER outranks standard when no watch/remote present', () => {
    const ledger = makeLedger();
    const result = determineSigningMethod([makeStandard(), ledger]);

    expect(result.method).toBe('ledger');
    expect(result.accounts).toEqual([ledger]);
  });

  it('de-duplicates remote-signer device ids across multiple accounts', () => {
    const a = makeRemoteSigner('shared-device');
    const b = makeRemoteSigner('shared-device');
    const c = makeRemoteSigner('other-device');
    const result = determineSigningMethod([a, b, c]);

    expect(result.method).toBe('remote_signer');
    expect(result.accounts).toEqual([a, b, c]);
    expect(result.signerDeviceIds).toHaveLength(2);
    expect(new Set(result.signerDeviceIds)).toEqual(
      new Set(['shared-device', 'other-device'])
    );
  });

  it('returns cannot_sign with a distinct "no signable account" error for empty input', () => {
    const result = determineSigningMethod([]);

    expect(result.method).toBe('cannot_sign');
    expect(result.error).toBe('No accounts available that can sign');
  });

  it('returns the "no signable account" branch for REKEYED-only input (unclassified)', () => {
    // REKEYED is not matched by any branch → falls through to the terminal
    // cannot_sign, and is distinct from the watch error.
    const result = determineSigningMethod([makeRekeyed()]);

    expect(result.method).toBe('cannot_sign');
    expect(result.error).toBe('No accounts available that can sign');
  });
});

// ===========================================================================
// 4. Base64 decode delegation — createRemoteSigningRequest*
// ===========================================================================

describe('createRemoteSigningRequestFromBase64 — decode delegation', () => {
  let spy: jest.SpyInstance;

  beforeEach(() => {
    // Intercept the heavy collaborator; the router's contract is that it hands
    // over correctly-decoded algosdk.Transaction objects.
    spy = jest
      .spyOn(RemoteSignerService, 'createSigningRequest')
      .mockResolvedValue({
        v: 1,
        t: 'req',
        id: 'test-id',
        ts: 0,
        net: 'voi-test-v1',
        gh: '',
        txns: [],
      });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('decodes each base64 msgpack txn back into an equivalent algosdk.Transaction', async () => {
    const original = makeRealTxn(21, 12345);
    const b64 = Buffer.from(
      algosdk.encodeUnsignedTransaction(original)
    ).toString('base64');

    await createRemoteSigningRequestFromBase64([b64], [seededAddress(21).addr]);

    expect(spy).toHaveBeenCalledTimes(1);
    const passedTxns = spy.mock.calls[0][0] as algosdk.Transaction[];
    expect(passedTxns).toHaveLength(1);
    // Round-trip fidelity: decoded txn must be byte-identical to the original.
    const decoded = passedTxns[0];
    expect(decoded).toBeInstanceOf(algosdk.Transaction);
    expect(decoded.txID()).toBe(original.txID());
    expect(
      Buffer.from(algosdk.encodeUnsignedTransaction(decoded)).toString('base64')
    ).toBe(b64);
  });

  it('preserves order and count when decoding a group of base64 txns', async () => {
    const t0 = makeRealTxn(30, 1);
    const t1 = makeRealTxn(31, 2);
    const t2 = makeRealTxn(32, 3);
    const b64s = [t0, t1, t2].map((t) =>
      Buffer.from(algosdk.encodeUnsignedTransaction(t)).toString('base64')
    );
    const signers = [
      seededAddress(30).addr,
      seededAddress(31).addr,
      seededAddress(32).addr,
    ];

    await createRemoteSigningRequestFromBase64(b64s, signers);

    const passedTxns = spy.mock.calls[0][0] as algosdk.Transaction[];
    expect(passedTxns.map((t) => t.txID())).toEqual([
      t0.txID(),
      t1.txID(),
      t2.txID(),
    ]);
    // Signer addresses are forwarded 1:1 alongside the decoded group.
    expect(spy.mock.calls[0][1]).toEqual(signers);
  });

  it('forwards signer addresses and options through to the service unchanged', async () => {
    const txn = makeRealTxn(40);
    const b64 = Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString(
      'base64'
    );
    const signers = [seededAddress(99).addr];
    const options = {
      authAddresses: [seededAddress(98).addr],
      dappName: 'TestDApp',
      description: 'a test signing request',
    };

    await createRemoteSigningRequestFromBase64([b64], signers, options);

    expect(spy).toHaveBeenCalledWith(expect.any(Array), signers, options);
  });

  it('surfaces a decode failure for malformed base64 rather than silently continuing', async () => {
    await expect(
      createRemoteSigningRequestFromBase64(['!!!not-a-txn!!!'], [''])
    ).rejects.toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('createRemoteSigningRequest — direct delegation', () => {
  it('delegates already-decoded transactions straight to the service', async () => {
    const spy = jest
      .spyOn(RemoteSignerService, 'createSigningRequest')
      .mockResolvedValue({
        v: 1,
        t: 'req',
        id: 'x',
        ts: 0,
        net: 'n',
        gh: '',
        txns: [],
      });
    const txn = makeRealTxn(55);
    const signers = [seededAddress(56).addr];

    await createRemoteSigningRequest([txn], signers);

    expect(spy).toHaveBeenCalledWith([txn], signers, undefined);
    spy.mockRestore();
  });
});

// ===========================================================================
// 5. Remote-signer rejection — validateNotRemoteSigner
// ===========================================================================

describe('validateNotRemoteSigner — fail-closed rejection of remote signers', () => {
  it('throws RemoteSignerRequiredError for a REMOTE_SIGNER account', () => {
    const acct = makeRemoteSigner('signer-device-xyz');

    expect(() => validateNotRemoteSigner(acct)).toThrow(
      RemoteSignerRequiredError
    );
  });

  it('populates the error with the account address and signer device id', () => {
    const acct = makeRemoteSigner('signer-device-xyz');

    try {
      validateNotRemoteSigner(acct);
      throw new Error('expected validateNotRemoteSigner to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteSignerRequiredError);
      const rsErr = err as RemoteSignerRequiredError;
      expect(rsErr.name).toBe('RemoteSignerRequiredError');
      expect(rsErr.accountAddress).toBe(acct.address);
      expect(rsErr.signerDeviceId).toBe('signer-device-xyz');
      // Guides the caller toward the correct (QR) flow.
      expect(rsErr.message).toContain(acct.address);
      expect(rsErr.message.toLowerCase()).toContain('qr');
    }
  });

  it('does NOT throw for a STANDARD account (local signing allowed)', () => {
    expect(() => validateNotRemoteSigner(makeStandard())).not.toThrow();
  });

  it('does NOT throw for a LEDGER account', () => {
    expect(() => validateNotRemoteSigner(makeLedger())).not.toThrow();
  });

  it('does NOT throw for a WATCH account (rejection here is remote-signer specific)', () => {
    expect(() => validateNotRemoteSigner(makeWatch())).not.toThrow();
  });
});
