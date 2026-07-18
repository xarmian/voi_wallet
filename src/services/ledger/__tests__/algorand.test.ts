/**
 * TASK-157 — P0 tests for the Ledger Algorand service.
 *
 * Scope (per acceptance criteria): BIP32 derivation-path correctness, Ledger
 * app/version checks (the get-app-and-version APDU), transaction-signing REQUEST
 * SHAPE (derivation path + encoded-txn payload handed to the device), and the
 * `normalizeLedgerError` mapping from raw @ledgerhq errors to the wallet's typed
 * Ledger errors.
 *
 * DR-3 / CLAUDE.md (key & signing surface) — non-negotiable:
 *   - This is TEST-ONLY. The Ledger source is never modified.
 *   - Every key and every signature is REAL crypto. Test accounts come from the
 *     shared algosdk-derived fixtures (src/__tests__/fixtures/algorand.ts); no key
 *     is fabricated and no key/mnemonic is ever logged.
 *   - The ONLY things mocked are the Ledger transport leaves:
 *       • `@ledgerhq/hw-app-algorand` (the app object whose getAddress/sign issue
 *         APDUs to hardware), and
 *       • `./transport` (the BLE/HID transport singleton).
 *     We assert on the SHAPE of what the service asks the device to do (paths,
 *     encoded payloads, the raw app-info APDU) and on how it normalizes device
 *     errors — never on real hardware. Device-only real BLE/USB paths are OUT
 *     (HT-98).
 *   - Where a test needs a "device-signed" blob, the mocked device returns a REAL
 *     Ed25519 signature (tweetnacl over the transaction's real `bytesToSign()`),
 *     so the resulting signed transaction is decoded and cryptographically
 *     verified against the fixture's public key — exactly what a genuine Ledger
 *     would have produced.
 */

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import nacl from 'tweetnacl';
import {
  TransportError,
  TransportStatusError,
  StatusCodes,
  UserRefusedOnDevice,
  LockedDeviceError,
} from '@ledgerhq/errors';

import { makeAccount, SUGGESTED_PARAMS } from '@/__tests__/fixtures/algorand';
import {
  LedgerAccountError,
  LedgerAppNotOpenError,
  LedgerDeviceNotConnectedError,
  LedgerUserRejectedError,
} from '@/types/wallet';

// --- Ledger transport leaves (the ONLY mocked surface) ---------------------

// The Algorand "app" object: getAddress/sign are the on-device APDU calls.
const mockGetAddress = jest.fn();
const mockSign = jest.fn();
const mockAppConstructor = jest.fn();

jest.mock('@ledgerhq/hw-app-algorand', () => ({
  __esModule: true,
  default: class MockAlgorandApp {
    transport: unknown;
    constructor(transport: unknown) {
      this.transport = transport;
      mockAppConstructor(transport);
    }
    getAddress = (...args: unknown[]) => mockGetAddress(...args);
    sign = (...args: unknown[]) => mockSign(...args);
  },
}));

// The BLE/HID transport singleton. Mocking the module also keeps the native
// react-native-hid / ble-plx imports out of the jest module graph.
const mockGetTransport = jest.fn();

jest.mock('../transport', () => ({
  __esModule: true,
  ledgerTransportService: {
    getTransport: (...args: unknown[]) => mockGetTransport(...args),
  },
}));

// signingState is intentionally NOT mocked — the real module-level flag drives
// the verifyApp race-guard the service relies on during signing.
import { setLedgerSigningInProgress } from '../signingState';
// Imported after the mocks above are registered so its transport/app deps resolve
// to the mocks.
import { ledgerAlgorandService, LedgerAlgorandService } from '../algorand';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APDU_GET_APP_AND_VERSION = [0xb0, 0x01, 0x00, 0x00] as const;

/**
 * Build a raw get-app-and-version APDU response the way the real Algorand app
 * replies, so `getAppAndVersion`'s hand-rolled parser is exercised end-to-end:
 *   [format][nameLen][name...][verLen][version...][flagsHi][flagsLo][0x90 0x00]
 */
function buildAppInfoResponse(
  name: string,
  version: string,
  flags = 258 /* 0x0102 */
): Buffer {
  const nameBytes = Buffer.from(name, 'ascii');
  const versionBytes = Buffer.from(version, 'ascii');
  return Buffer.concat([
    Buffer.from([0x01, nameBytes.length]),
    nameBytes,
    Buffer.from([versionBytes.length]),
    versionBytes,
    Buffer.from([(flags >> 8) & 0xff, flags & 0xff]),
    Buffer.from([0x90, 0x00]), // trailing status word (stripped by the parser)
  ]);
}

/** Wire up a connected transport whose app-info APDU reports the Algorand app. */
function connectAlgorandApp(version = '2.1.14') {
  const send = jest
    .fn()
    .mockResolvedValue(buildAppInfoResponse('Algorand', version));
  mockGetTransport.mockReturnValue({ send });
  return send;
}

const paymentTxnFor = (sender: string) =>
  algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount: 0,
    suggestedParams: SUGGESTED_PARAMS,
  });

beforeEach(() => {
  // clearMocks:true (jest.config) resets call history; also reset the real
  // signing flag so verifyApp's race-guard starts from a known state.
  setLedgerSigningInProgress(false);
  mockGetTransport.mockReset();
  // Silence the service's verbose diagnostic logging (it never logs key material,
  // but the noise obscures test output).
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setLedgerSigningInProgress(false);
  jest.restoreAllMocks();
});

// ===========================================================================
// 1. BIP32 derivation-path correctness
// ===========================================================================

describe('getDerivationPath (BIP32)', () => {
  it('uses the Algorand coin type (283’) and hardens only the account index', () => {
    // m / 44' / 283' / <index>' / 0 / 0  — account varies, change/address static.
    expect(ledgerAlgorandService.getDerivationPath(0)).toBe(
      "m/44'/283'/0'/0/0"
    );
    expect(ledgerAlgorandService.getDerivationPath(1)).toBe(
      "m/44'/283'/1'/0/0"
    );
    expect(ledgerAlgorandService.getDerivationPath(5)).toBe(
      "m/44'/283'/5'/0/0"
    );
    expect(ledgerAlgorandService.getDerivationPath(2147483647)).toBe(
      "m/44'/283'/2147483647'/0/0"
    );
  });

  it('rejects a negative index', () => {
    expect(() => ledgerAlgorandService.getDerivationPath(-1)).toThrow(
      LedgerAccountError
    );
    try {
      ledgerAlgorandService.getDerivationPath(-1);
    } catch (e) {
      expect((e as LedgerAccountError).code).toBe(
        'LEDGER_INVALID_DERIVATION_INDEX'
      );
    }
  });

  it('rejects a non-integer index', () => {
    expect(() => ledgerAlgorandService.getDerivationPath(1.5)).toThrow(
      /non-negative integer/
    );
  });

  it('rejects an index above the Int32 hardened maximum', () => {
    expect(() => ledgerAlgorandService.getDerivationPath(2147483648)).toThrow(
      /exceeds maximum/
    );
  });
});

// ===========================================================================
// 2. Address derivation — path handed to the device is correct
// ===========================================================================

describe('deriveAccount', () => {
  it('asks the device for the correctly derived path and returns its result', async () => {
    const account = makeAccount('ledger-derive');
    connectAlgorandApp();
    mockGetAddress.mockResolvedValue({
      address: account.addr,
      publicKey: Buffer.from(account.pk).toString('hex'),
    });

    const result = await ledgerAlgorandService.deriveAccount(3);

    // The device is asked for exactly the BIP32 path for index 3, no display.
    expect(mockGetAddress).toHaveBeenCalledWith("m/44'/283'/3'/0/0", false);
    expect(result).toEqual({
      address: account.addr,
      publicKey: Buffer.from(account.pk).toString('hex'),
      derivationPath: "m/44'/283'/3'/0/0",
      derivationIndex: 3,
    });
  });

  it('passes the display flag through when verifying an address on-device', async () => {
    const account = makeAccount('ledger-derive');
    connectAlgorandApp();
    mockGetAddress.mockResolvedValue({
      address: account.addr,
      publicKey: Buffer.from(account.pk).toString('hex'),
    });

    const res = await ledgerAlgorandService.verifyAddressOnDevice(
      2,
      account.addr
    );

    expect(mockGetAddress).toHaveBeenCalledWith("m/44'/283'/2'/0/0", true);
    expect(res.matches).toBe(true);
  });

  it('flags a mismatch when the on-device address differs from expected', async () => {
    const account = makeAccount('ledger-derive');
    const other = makeAccount('ledger-other');
    connectAlgorandApp();
    mockGetAddress.mockResolvedValue({
      address: account.addr,
      publicKey: Buffer.from(account.pk).toString('hex'),
    });

    const res = await ledgerAlgorandService.verifyAddressOnDevice(
      0,
      other.addr
    );
    expect(res.matches).toBe(false);
  });

  it('throws when no transport is connected', async () => {
    mockGetTransport.mockReturnValue(null);
    await expect(ledgerAlgorandService.deriveAccount(0)).rejects.toBeInstanceOf(
      LedgerDeviceNotConnectedError
    );
  });

  it('derives a contiguous range of accounts, displaying only the first', async () => {
    const account = makeAccount('ledger-derive');
    connectAlgorandApp();
    mockGetAddress.mockResolvedValue({
      address: account.addr,
      publicKey: Buffer.from(account.pk).toString('hex'),
    });

    const results = await ledgerAlgorandService.deriveAccounts(4, 3, {
      displayFirst: true,
    });

    expect(results.map((r) => r.derivationPath)).toEqual([
      "m/44'/283'/4'/0/0",
      "m/44'/283'/5'/0/0",
      "m/44'/283'/6'/0/0",
    ]);
    expect(mockGetAddress).toHaveBeenNthCalledWith(
      1,
      "m/44'/283'/4'/0/0",
      true
    );
    expect(mockGetAddress).toHaveBeenNthCalledWith(
      2,
      "m/44'/283'/5'/0/0",
      false
    );
    expect(mockGetAddress).toHaveBeenNthCalledWith(
      3,
      "m/44'/283'/6'/0/0",
      false
    );
  });

  it('rejects an invalid range up front (count must be positive)', async () => {
    connectAlgorandApp();
    await expect(ledgerAlgorandService.deriveAccounts(0, 0)).rejects.toThrow(
      /count must be a positive integer/
    );
  });
});

// ===========================================================================
// 3. App / version checks (get-app-and-version APDU)
// ===========================================================================

describe('verifyApp', () => {
  it('issues the get-app-and-version APDU and parses name/version/flags', async () => {
    const send = connectAlgorandApp('2.1.14');

    const info = await ledgerAlgorandService.verifyApp();

    expect(send).toHaveBeenCalledWith(...APDU_GET_APP_AND_VERSION);
    expect(info).toEqual({ name: 'Algorand', version: '2.1.14', flags: 258 });
  });

  it('throws LedgerAppNotOpenError when a non-Algorand app is open', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(buildAppInfoResponse('Bitcoin', '2.0.0'));
    mockGetTransport.mockReturnValue({ send });

    await expect(
      ledgerAlgorandService.verifyApp({ requireAppOpen: true })
    ).rejects.toBeInstanceOf(LedgerAppNotOpenError);
    // Wrong-app is non-retryable: the device is polled exactly once.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not throw on a below-minimum version (warns and continues)', async () => {
    connectAlgorandApp('0.9.0');
    const info = await ledgerAlgorandService.verifyApp({ minVersion: '1.0.0' });
    expect(info.version).toBe('0.9.0');
  });

  it('short-circuits with cached info while a signing operation is in progress', async () => {
    const send = connectAlgorandApp();
    setLedgerSigningInProgress(true);

    const info = await ledgerAlgorandService.verifyApp();

    // The race-guard must NOT touch the transport mid-signing.
    expect(send).not.toHaveBeenCalled();
    expect(info.name).toBe('Algorand');
  });

  it('throws LedgerDeviceNotConnectedError when no transport is active', async () => {
    mockGetTransport.mockReturnValue(null);
    await expect(ledgerAlgorandService.verifyApp()).rejects.toBeInstanceOf(
      LedgerDeviceNotConnectedError
    );
  });

  it('maps a locked device (0x5515) to a LEDGER_DEVICE_LOCKED error', async () => {
    jest.useFakeTimers();
    try {
      const send = jest.fn().mockRejectedValue(new LockedDeviceError('locked'));
      mockGetTransport.mockReturnValue({ send });

      const promise = ledgerAlgorandService.verifyApp();
      const assertion = expect(promise).rejects.toMatchObject({
        code: 'LEDGER_DEVICE_LOCKED',
      });
      // Flush the retry backoff timers without waiting in real time.
      await jest.runAllTimersAsync();
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });
});

// ===========================================================================
// 4. Transaction signing — request shape + REAL signature verification
// ===========================================================================

describe('signTransaction', () => {
  it('sends the derivation path + hex-encoded unsigned txn, and returns a REAL verifiable signature', async () => {
    const account = makeAccount('ledger-sign');
    connectAlgorandApp();
    const txn = paymentTxnFor(account.addr);
    const expectedHex = Buffer.from(
      algosdk.encodeUnsignedTransaction(txn)
    ).toString('hex');

    // The mocked device returns a genuine Ed25519 signature over the real
    // bytesToSign, produced with the fixture's own key. NOTE: on-device BIP32 key
    // derivation for the requested path is device-only (HT-98); the fixture key
    // stands in for whatever key the device holds. This test therefore verifies
    // request SHAPING (path + payload) and that the service faithfully ASSEMBLES
    // and returns the device's real signature — NOT that path 7 derives this key.
    const realSig = nacl.sign.detached(txn.bytesToSign(), account.sk);
    mockSign.mockResolvedValue({ signature: Buffer.from(realSig) });

    const result = await ledgerAlgorandService.signTransaction({
      transaction: txn,
      derivationIndex: 7,
    });

    // Request SHAPE: exact path + exact encoded payload handed to the device.
    expect(mockSign).toHaveBeenCalledWith("m/44'/283'/7'/0/0", expectedHex);

    // The returned signature is the EXACT bytes the device produced (not merely a
    // valid one) — faithful passthrough, no substitution — and txID matches.
    expect(result.signature).toHaveLength(64);
    expect(Buffer.from(result.signature).equals(Buffer.from(realSig))).toBe(
      true
    );
    expect(result.txID).toBe(txn.txID());

    // The assembled signed transaction decodes; its embedded sig is byte-identical
    // to the device signature and verifies against the signer's PUBLIC key —
    // proving no fabrication or substitution anywhere in the pipeline.
    const decoded = algosdk.decodeSignedTransaction(result.signedTransaction);
    expect(Buffer.from(decoded.sig!).equals(Buffer.from(realSig))).toBe(true);
    expect(
      nacl.sign.detached.verify(
        decoded.txn.bytesToSign(),
        decoded.sig!,
        account.pk
      )
    ).toBe(true);
    expect(decoded.txn.txID()).toBe(txn.txID());
  });

  it('accepts encoded-txn-bytes input and signs the decoded transaction', async () => {
    const account = makeAccount('ledger-sign');
    connectAlgorandApp();
    const txn = paymentTxnFor(account.addr);
    const encoded = algosdk.encodeUnsignedTransaction(txn);

    const realSig = nacl.sign.detached(txn.bytesToSign(), account.sk);
    mockSign.mockResolvedValue({ signature: Buffer.from(realSig) });

    const result = await ledgerAlgorandService.signTransaction({
      transaction: encoded,
      derivationIndex: 0,
    });

    const decoded = algosdk.decodeSignedTransaction(result.signedTransaction);
    expect(
      nacl.sign.detached.verify(
        decoded.txn.bytesToSign(),
        decoded.sig!,
        account.pk
      )
    ).toBe(true);
  });

  it('attaches sgnr for a rekeyed signer (auth address != sender)', async () => {
    const sender = makeAccount('ledger-sender');
    const authSigner = makeAccount('ledger-auth');
    connectAlgorandApp();
    const txn = paymentTxnFor(sender.addr);

    // The device signs with the AUTH key (real signature).
    const realSig = nacl.sign.detached(txn.bytesToSign(), authSigner.sk);
    mockSign.mockResolvedValue({ signature: Buffer.from(realSig) });

    const result = await ledgerAlgorandService.signTransaction({
      transaction: txn,
      derivationIndex: 1,
      signerAddress: authSigner.addr,
    });

    const decoded = algosdk.decodeSignedTransaction(result.signedTransaction);
    expect(decoded.sgnr?.toString()).toBe(authSigner.addr);
    expect(
      nacl.sign.detached.verify(
        decoded.txn.bytesToSign(),
        decoded.sig!,
        authSigner.pk
      )
    ).toBe(true);
  });

  it('strips a trailing status word (0x9000) appended to a 66-byte signature', async () => {
    const account = makeAccount('ledger-sign');
    connectAlgorandApp();
    const txn = paymentTxnFor(account.addr);

    const realSig = nacl.sign.detached(txn.bytesToSign(), account.sk);
    // Some transports append the APDU status word to the raw signature.
    mockSign.mockResolvedValue({
      signature: Buffer.concat([
        Buffer.from(realSig),
        Buffer.from([0x90, 0x00]),
      ]),
    });

    const result = await ledgerAlgorandService.signTransaction({
      transaction: txn,
      derivationIndex: 0,
    });

    // Exactly the 64 signature bytes survive — the status word is dropped, not
    // the last two signature bytes.
    expect(result.signature).toHaveLength(64);
    expect(Buffer.from(result.signature).equals(Buffer.from(realSig))).toBe(
      true
    );
    const decoded = algosdk.decodeSignedTransaction(result.signedTransaction);
    expect(
      nacl.sign.detached.verify(
        decoded.txn.bytesToSign(),
        decoded.sig!,
        account.pk
      )
    ).toBe(true);
  });

  it('treats a very short signature as a user rejection', async () => {
    const account = makeAccount('ledger-sign');
    connectAlgorandApp();
    mockSign.mockResolvedValue({ signature: Buffer.from([0x69, 0x85]) });

    await expect(
      ledgerAlgorandService.signTransaction({
        transaction: paymentTxnFor(account.addr),
        derivationIndex: 0,
      })
    ).rejects.toMatchObject({ code: 'LEDGER_USER_REJECTED' });
  });

  it('rejects a wrong-length (non-64) signature', async () => {
    const account = makeAccount('ledger-sign');
    connectAlgorandApp();
    mockSign.mockResolvedValue({ signature: Buffer.alloc(40, 1) });

    await expect(
      ledgerAlgorandService.signTransaction({
        transaction: paymentTxnFor(account.addr),
        derivationIndex: 0,
      })
    ).rejects.toMatchObject({ code: 'LEDGER_INVALID_SIGNATURE_LENGTH' });
  });

  it('rejects an empty signature from the device', async () => {
    const account = makeAccount('ledger-sign');
    connectAlgorandApp();
    mockSign.mockResolvedValue({ signature: null });

    await expect(
      ledgerAlgorandService.signTransaction({
        transaction: paymentTxnFor(account.addr),
        derivationIndex: 0,
      })
    ).rejects.toMatchObject({ code: 'LEDGER_EMPTY_SIGNATURE' });
  });

  it('clears the in-progress signing flag even when signing fails', async () => {
    const account = makeAccount('ledger-sign');
    connectAlgorandApp();
    mockSign.mockRejectedValue(new UserRefusedOnDevice());

    await expect(
      ledgerAlgorandService.signTransaction({
        transaction: paymentTxnFor(account.addr),
        derivationIndex: 0,
      })
    ).rejects.toBeInstanceOf(LedgerUserRejectedError);

    // Flag must be released so subsequent verifyApp calls aren't short-circuited.
    expect(LedgerAlgorandService.isCurrentlySigningTransaction()).toBe(false);
  });
});

// ===========================================================================
// 5. Error normalization mapping (raw @ledgerhq errors -> typed wallet errors)
//
// Routed through deriveAccount so app.getAddress rejections hit normalizeLedgerError
// directly (no retry loop), keeping each mapping assertion isolated and fast.
// ===========================================================================

describe('normalizeLedgerError mapping', () => {
  const deriveWith = async (thrown: unknown) => {
    connectAlgorandApp();
    mockGetAddress.mockRejectedValue(thrown);
    return ledgerAlgorandService.deriveAccount(0);
  };

  it('maps UserRefusedOnDevice -> LedgerUserRejectedError', async () => {
    await expect(deriveWith(new UserRefusedOnDevice())).rejects.toBeInstanceOf(
      LedgerUserRejectedError
    );
  });

  it.each([
    [
      'APP_NOT_FOUND_OR_INVALID_CONTEXT',
      StatusCodes.APP_NOT_FOUND_OR_INVALID_CONTEXT,
    ],
    ['CLA_NOT_SUPPORTED', StatusCodes.CLA_NOT_SUPPORTED],
    ['INS_NOT_SUPPORTED', StatusCodes.INS_NOT_SUPPORTED],
  ])(
    'maps TransportStatusError(%s) -> LedgerAppNotOpenError',
    async (_label, status) => {
      await expect(
        deriveWith(new TransportStatusError(status))
      ).rejects.toBeInstanceOf(LedgerAppNotOpenError);
    }
  );

  it('maps TransportStatusError(CONDITIONS_OF_USE_NOT_SATISFIED) -> LedgerUserRejectedError', async () => {
    await expect(
      deriveWith(
        new TransportStatusError(StatusCodes.CONDITIONS_OF_USE_NOT_SATISFIED)
      )
    ).rejects.toBeInstanceOf(LedgerUserRejectedError);
  });

  it('maps an unrecognized TransportStatusError to LEDGER_STATUS_<code>', async () => {
    // 0x6d00 (INS_NOT_SUPPORTED) is already mapped; use an arbitrary other code.
    const status = 0x6a80; // INCORRECT_DATA / not specially handled
    await expect(
      deriveWith(new TransportStatusError(status))
    ).rejects.toMatchObject({
      code: `LEDGER_STATUS_${status}`,
    });
  });

  it('maps SECURITY_STATUS_NOT_SATISFIED (0x6982) to LEDGER_STATUS_<code>', async () => {
    // Documents CURRENT behavior: unlike the app-info APDU path (which maps this
    // to LEDGER_DEVICE_LOCKED), normalizeLedgerError has no dedicated branch for
    // 0x6982, so a locked-device status surfaced via getAddress/sign degrades to
    // the generic LEDGER_STATUS_<code>. Asymmetry is intentional to pin, not fix.
    const status = StatusCodes.SECURITY_STATUS_NOT_SATISFIED; // 0x6982
    await expect(
      deriveWith(new TransportStatusError(status))
    ).rejects.toMatchObject({
      code: `LEDGER_STATUS_${status}`,
    });
  });

  it('degrades a locked device (0x5515) to LEDGER_STATUS_21781 on the derive/sign path', async () => {
    // Documents CURRENT behavior + the ASYMMETRY Codex flagged: LockedDeviceError
    // is a TransportStatusError carrying statusCode 0x5515 (=21781). The app-info
    // APDU path (getAppAndVersion) special-cases this to LEDGER_DEVICE_LOCKED, but
    // normalizeLedgerError (used by getAddress/sign) has no 0x5515 branch, so it
    // falls through to the generic LEDGER_STATUS_<code>. Pinned, not "fixed"
    // (test-only task — see report).
    await expect(
      deriveWith(new LockedDeviceError('Ledger device is locked'))
    ).rejects.toMatchObject({
      code: 'LEDGER_STATUS_21781', // 0x5515
    });
  });

  it('maps a generic TransportError to its error id', async () => {
    await expect(
      deriveWith(new TransportError('cable unplugged', 'CABLE_ERROR'))
    ).rejects.toMatchObject({ code: 'CABLE_ERROR' });
  });

  it('wraps a plain Error as a LedgerAccountError, preserving the message', async () => {
    await expect(deriveWith(new Error('kaboom'))).rejects.toMatchObject({
      code: 'LEDGER_ACCOUNT_ERROR',
      message: 'kaboom',
    });
  });

  it('passes an already-typed LedgerAccountError through unchanged', async () => {
    const original = new LedgerAccountError('precise', 'LEDGER_CUSTOM');
    await expect(deriveWith(original)).rejects.toBe(original);
  });

  it('wraps a non-Error throwable as an unknown Ledger error', async () => {
    await expect(deriveWith('just a string')).rejects.toMatchObject({
      code: 'LEDGER_ACCOUNT_ERROR',
      message: 'Unknown Ledger error',
    });
  });
});
