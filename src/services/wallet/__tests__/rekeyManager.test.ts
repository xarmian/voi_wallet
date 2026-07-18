// Unit tests for TASK-155: RekeyManager signing-authority resolution and rekey
// detection.
//
// SCOPE: RekeyManager decides *who is allowed to sign* for a (possibly rekeyed)
// account — the standard / Ledger / remote-signer authority branches — and
// detects which accounts are currently rekeyed. These are pure metadata /
// address-matching decisions; the manager itself performs no signing.
//
// SECURITY / DR-3 (non-negotiable): every Algorand address used here is REAL,
// deterministically derived through algosdk from a throwaway fixture seed
// (`makeAccount` in src/__tests__/fixtures/algorand.ts). There is NO fabricated
// address, private key, or signature anywhere, and no key/mnemonic is ever
// logged. `publicKey` fields carry the real Ed25519 public key hex. Authority
// resolution keys off the base32 address, so using real addresses is exactly
// what production compares.
//
// The heavy/native leaves are module-mocked (the Ledger transport pulls in
// untranspilable native ESM; the network + secure-storage modules touch native
// storage), mirroring the DR-1 pattern in importFromPrivateKey.test.ts. Only the
// leaves are mocked — the code under test (rekeyManager.ts) and algosdk are the
// real implementations.

import { Buffer } from 'buffer';

import { makeAccount, TestAccount } from '@/__tests__/fixtures/algorand';
import {
  AccountType,
  AccountMetadata,
  LedgerAccountError,
  LedgerAccountMetadata,
  RekeyedAccountMetadata,
  RemoteSignerAccountMetadata,
  StandardAccountMetadata,
  WatchAccountMetadata,
  Wallet,
} from '@/types/wallet';
import type { RekeyInfo } from '@/services/network';

// --- Module mocks (leaves only) --------------------------------------------

// Controllable Ledger transport. The real one imports native BLE/HID ESM that
// cannot load under jest, so we substitute a thin object whose two readers the
// manager consults for device connectivity.
const mockGetConnectedDevice = jest.fn();
const mockGetDevices = jest.fn();
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {
    getConnectedDevice: () => mockGetConnectedDevice(),
    getDevices: () => mockGetDevices(),
  },
}));

// Controllable network rekey lookup (real one hits algod).
const mockGetMultipleAccountRekeyInfo = jest.fn();
jest.mock('@/services/network', () => ({
  __esModule: true,
  default: {
    getMultipleAccountRekeyInfo: (addresses: string[]) =>
      mockGetMultipleAccountRekeyInfo(addresses),
  },
}));

// NOTE: updateAccountWithRekeyInfo's rekeyed→standard/watch auto-conversion
// probes AccountSecureStorage via a runtime `await import(...)`. That dynamic
// import resolves OUTSIDE jest's module registry, so neither a jest.mock factory
// nor a jest.spyOn on a static import of AccountSecureStorage reaches it
// (verified: both record zero calls). The "key present → STANDARD" half is thus
// structurally uncoverable at unit scope — injecting a recoverable key would
// need a full SecureStore + encryption + PIN integration harness. The "key
// absent → WATCH" half IS deterministic (the real AccountSecureStorage genuinely
// has no key for a fixture id, so getPrivateKey rejects) and is covered below
// against the real module, not a stand-in.

// Import AFTER the mocks are registered so the manager binds to them.
import { RekeyManager } from '../rekeyManager';

// --- Fixtures & builders ----------------------------------------------------

const manager = RekeyManager.getInstance();

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

// Real, deterministic Algorand accounts (distinct labels → distinct keypairs).
const REKEYED = makeAccount('rekey-manager:rekeyed-account');
const STD_AUTH = makeAccount('rekey-manager:standard-authority');
const LEDGER_AUTH = makeAccount('rekey-manager:ledger-authority');
const REMOTE_AUTH = makeAccount('rekey-manager:remote-authority');
const WATCH_AUTH = makeAccount('rekey-manager:watch-authority');
const UNRELATED = makeAccount('rekey-manager:unrelated');
// Same-type wrong-address decoy: proves resolution keys off authAddress, not
// "first account of the matching type".
const DECOY = makeAccount('rekey-manager:decoy');

const LEDGER_DEVICE_ID = 'ledger-device-abc';
const DECOY_DEVICE_ID = 'decoy-device-zzz';

function baseMeta(acct: TestAccount, id: string) {
  return {
    id,
    address: acct.addr,
    publicKey: hex(acct.pk),
    isHidden: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    lastUsed: '2024-01-01T00:00:00.000Z',
  };
}

function standardAccount(
  acct: TestAccount,
  id: string
): StandardAccountMetadata {
  return {
    ...baseMeta(acct, id),
    type: AccountType.STANDARD,
    // Never store real key material in a fixture; the authority decision only
    // ever inspects the address + type, not the mnemonic.
    mnemonic: '',
    hasBackup: false,
  };
}

function watchAccount(acct: TestAccount, id: string): WatchAccountMetadata {
  return { ...baseMeta(acct, id), type: AccountType.WATCH };
}

function ledgerAccount(
  acct: TestAccount,
  id: string,
  deviceId = LEDGER_DEVICE_ID
): LedgerAccountMetadata {
  return {
    ...baseMeta(acct, id),
    type: AccountType.LEDGER,
    deviceId,
    derivationIndex: 0,
    derivationPath: "44'/283'/0'/0/0",
    deviceName: 'Test Ledger Nano',
  };
}

function remoteSignerAccount(
  acct: TestAccount,
  id: string
): RemoteSignerAccountMetadata {
  return {
    ...baseMeta(acct, id),
    type: AccountType.REMOTE_SIGNER,
    signerDeviceId: 'signer-device-xyz',
    signerDeviceName: 'Cold Storage Phone',
    pairedAt: '2024-01-01T00:00:00.000Z',
  };
}

function rekeyedAccount(
  acct: TestAccount,
  id: string,
  authAddress: string,
  canSign: boolean
): RekeyedAccountMetadata {
  return {
    ...baseMeta(acct, id),
    type: AccountType.REKEYED,
    authAddress,
    canSign,
  };
}

function makeWallet(accounts: AccountMetadata[]): Wallet {
  return {
    id: 'wallet-1',
    version: '1',
    createdAt: '2024-01-01T00:00:00.000Z',
    accounts,
    activeAccountId: accounts[0]?.id ?? '',
    settings: {
      theme: 'system',
      currency: 'USD',
      hideSmallBalances: false,
      requireBiometric: false,
      autoLock: 5,
      notifications: {
        transactionAlerts: true,
        priceAlerts: false,
        securityAlerts: true,
        pushNotifications: false,
      },
    },
  };
}

// A device as reported by the transport. `connected` mirrors what real
// discovery reports: true for the actively-connected device (getConnectedDevice),
// false for a known-but-idle device that only shows up in the discovery list
// (getDevices).
function device(
  id = LEDGER_DEVICE_ID,
  type: 'ble' | 'usb' = 'ble',
  connected = true
) {
  return {
    id,
    name: 'Test Ledger Nano',
    type,
    connected,
    lastSeen: '2024-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  // clearMocks resets calls but not implementations; pin safe defaults so a
  // return value set in one test never leaks into the next.
  mockGetConnectedDevice.mockReset();
  mockGetDevices.mockReset();
  mockGetConnectedDevice.mockReturnValue(null);
  mockGetDevices.mockReturnValue([]);
  mockGetMultipleAccountRekeyInfo.mockReset();
});

// ---------------------------------------------------------------------------
// checkSigningAuthority — every authority branch
// ---------------------------------------------------------------------------

describe('checkSigningAuthority — authority branches', () => {
  it('STANDARD authority: resolves to the in-wallet key holder and can sign', async () => {
    const wallet = makeWallet([standardAccount(STD_AUTH, 'std-1')]);

    const result = await manager.checkSigningAuthority(
      REKEYED.addr,
      STD_AUTH.addr,
      wallet
    );

    expect(result).toEqual({
      accountAddress: REKEYED.addr,
      canSign: true,
      signingAccountId: 'std-1',
      signingAddress: STD_AUTH.addr,
    });
    // Must NOT be misreported as ledger / remote signer.
    expect(result.isLedger).toBeUndefined();
    expect(result.isRemoteSigner).toBeUndefined();
  });

  it('LEDGER authority, device connected: can sign with connected transport metadata', async () => {
    // A decoy Ledger (different address + device) sits BEFORE the real holder to
    // prove resolution keys off authAddress, not "first Ledger in the wallet".
    const wallet = makeWallet([
      ledgerAccount(DECOY, 'led-decoy', DECOY_DEVICE_ID),
      ledgerAccount(LEDGER_AUTH, 'led-1'),
    ]);
    mockGetConnectedDevice.mockReturnValue(device(LEDGER_DEVICE_ID, 'ble'));

    const result = await manager.checkSigningAuthority(
      REKEYED.addr,
      LEDGER_AUTH.addr,
      wallet
    );

    expect(result.canSign).toBe(true);
    expect(result.isLedger).toBe(true);
    expect(result.signingAccountId).toBe('led-1'); // NOT the decoy
    expect(result.signingAddress).toBe(LEDGER_AUTH.addr);
    expect(result.deviceConnected).toBe(true);
    expect(result.deviceAvailable).toBe(true);
    expect(result.signingDeviceId).toBe(LEDGER_DEVICE_ID);
    expect(result.transportType).toBe('ble');
  });

  it('LEDGER authority, device merely available (not connected): can sign, flagged not-connected', async () => {
    const wallet = makeWallet([ledgerAccount(LEDGER_AUTH, 'led-1')]);
    // A different device is the "connected" one; ours only shows up in the
    // available-devices list.
    mockGetConnectedDevice.mockReturnValue(device('some-other-device'));
    mockGetDevices.mockReturnValue([device(LEDGER_DEVICE_ID, 'usb', false)]);

    const result = await manager.checkSigningAuthority(
      REKEYED.addr,
      LEDGER_AUTH.addr,
      wallet
    );

    expect(result.canSign).toBe(true);
    expect(result.isLedger).toBe(true);
    expect(result.deviceConnected).toBe(false);
    expect(result.deviceAvailable).toBe(true);
    expect(result.transportType).toBe('usb');
  });

  it('LEDGER authority, device neither connected nor available: cannot sign', async () => {
    const wallet = makeWallet([ledgerAccount(LEDGER_AUTH, 'led-1')]);
    mockGetConnectedDevice.mockReturnValue(null);
    mockGetDevices.mockReturnValue([]);

    const result = await manager.checkSigningAuthority(
      REKEYED.addr,
      LEDGER_AUTH.addr,
      wallet
    );

    expect(result.canSign).toBe(false);
    expect(result.isLedger).toBe(true);
    expect(result.deviceConnected).toBe(false);
    expect(result.deviceAvailable).toBe(false);
  });

  it('REMOTE_SIGNER authority: can sign via QR flow with signer device metadata', async () => {
    const remote = remoteSignerAccount(REMOTE_AUTH, 'remote-1');
    // Decoy remote signer (different address) placed first; must be skipped.
    const wallet = makeWallet([
      remoteSignerAccount(DECOY, 'remote-decoy'),
      remote,
    ]);

    const result = await manager.checkSigningAuthority(
      REKEYED.addr,
      REMOTE_AUTH.addr,
      wallet
    );

    expect(result.canSign).toBe(true);
    expect(result.isRemoteSigner).toBe(true);
    expect(result.signingAccountId).toBe('remote-1');
    expect(result.signingAddress).toBe(REMOTE_AUTH.addr);
    expect(result.signingDeviceId).toBe(remote.signerDeviceId);
    expect(result.signingDeviceName).toBe(remote.signerDeviceName);
    expect(result.isLedger).toBeUndefined();
  });

  it('no matching authority in wallet: cannot sign', async () => {
    const wallet = makeWallet([standardAccount(UNRELATED, 'other-1')]);

    const result = await manager.checkSigningAuthority(
      REKEYED.addr,
      STD_AUTH.addr,
      wallet
    );

    expect(result).toEqual({ accountAddress: REKEYED.addr, canSign: false });
  });

  it('authority address present but WRONG type (watch-only): cannot sign', async () => {
    // A watch account at the auth address must NOT confer signing authority —
    // guards against matching on address alone.
    const wallet = makeWallet([watchAccount(WATCH_AUTH, 'watch-1')]);

    const result = await manager.checkSigningAuthority(
      REKEYED.addr,
      WATCH_AUTH.addr,
      wallet
    );

    expect(result.canSign).toBe(false);
    expect(result.signingAccountId).toBeUndefined();
  });

  it('picks the right holder when several account types coexist in the wallet', async () => {
    const wallet = makeWallet([
      watchAccount(UNRELATED, 'watch-1'),
      ledgerAccount(LEDGER_AUTH, 'led-1'),
      standardAccount(STD_AUTH, 'std-1'),
      remoteSignerAccount(REMOTE_AUTH, 'remote-1'),
    ]);

    const std = await manager.checkSigningAuthority(
      REKEYED.addr,
      STD_AUTH.addr,
      wallet
    );
    expect(std.signingAccountId).toBe('std-1');
    expect(std.isLedger).toBeUndefined();

    const remote = await manager.checkSigningAuthority(
      REKEYED.addr,
      REMOTE_AUTH.addr,
      wallet
    );
    expect(remote.isRemoteSigner).toBe(true);
    expect(remote.signingAccountId).toBe('remote-1');
  });

  it('re-throws a LedgerAccountError raised while probing the device', async () => {
    const wallet = makeWallet([ledgerAccount(LEDGER_AUTH, 'led-1')]);
    mockGetConnectedDevice.mockImplementation(() => {
      throw new LedgerAccountError(
        'device probe failed',
        'LEDGER_ACCOUNT_ERROR'
      );
    });

    await expect(
      manager.checkSigningAuthority(REKEYED.addr, LEDGER_AUTH.addr, wallet)
    ).rejects.toBeInstanceOf(LedgerAccountError);
  });

  it('swallows a non-Ledger error and reports cannot-sign', async () => {
    const wallet = makeWallet([ledgerAccount(LEDGER_AUTH, 'led-1')]);
    mockGetConnectedDevice.mockImplementation(() => {
      throw new Error('unexpected transport failure');
    });

    const result = await manager.checkSigningAuthority(
      REKEYED.addr,
      LEDGER_AUTH.addr,
      wallet
    );

    expect(result).toEqual({ accountAddress: REKEYED.addr, canSign: false });
  });
});

// ---------------------------------------------------------------------------
// detectRekeyedAccounts — rekeyed vs non-rekeyed detection
// ---------------------------------------------------------------------------

describe('detectRekeyedAccounts — detection', () => {
  it('flags only the rekeyed accounts and resolves each authority', async () => {
    const rekeyedStd = standardAccount(REKEYED, 'rk-1'); // rekeyed to STD_AUTH
    const notRekeyed = standardAccount(UNRELATED, 'plain-1');
    const stdAuth = standardAccount(STD_AUTH, 'std-1');
    const wallet = makeWallet([rekeyedStd, notRekeyed, stdAuth]);

    mockGetMultipleAccountRekeyInfo.mockResolvedValue({
      [REKEYED.addr]: { isRekeyed: true, authAddress: STD_AUTH.addr },
      [UNRELATED.addr]: { isRekeyed: false },
      [STD_AUTH.addr]: { isRekeyed: false },
    } as Record<string, RekeyInfo>);

    const result = await manager.detectRekeyedAccounts(wallet);

    expect(result.rekeyedAccounts).toEqual([REKEYED.addr]);
    expect(Object.keys(result.signingAuthorities)).toEqual([REKEYED.addr]);
    expect(result.signingAuthorities[REKEYED.addr].canSign).toBe(true);
    expect(result.signingAuthorities[REKEYED.addr].signingAccountId).toBe(
      'std-1'
    );
    // The plain account must not be reported as rekeyed.
    expect(result.signingAuthorities[UNRELATED.addr]).toBeUndefined();
  });

  it('resolves a LEDGER-delegated rekeyed account end-to-end through detection', async () => {
    // Guards against a detection-path regression that resolves every authority
    // as standard-only: the delegated authority here is a Ledger device.
    const rekeyedStd = standardAccount(REKEYED, 'rk-1');
    const led = ledgerAccount(LEDGER_AUTH, 'led-1');
    // Decoy Ledger (different address + device) precedes the real holder.
    const decoyLed = ledgerAccount(DECOY, 'led-decoy', DECOY_DEVICE_ID);
    const wallet = makeWallet([rekeyedStd, decoyLed, led]);
    mockGetConnectedDevice.mockReturnValue(device(LEDGER_DEVICE_ID));
    mockGetMultipleAccountRekeyInfo.mockResolvedValue({
      [REKEYED.addr]: { isRekeyed: true, authAddress: LEDGER_AUTH.addr },
      [DECOY.addr]: { isRekeyed: false },
      [LEDGER_AUTH.addr]: { isRekeyed: false },
    } as Record<string, RekeyInfo>);

    const result = await manager.detectRekeyedAccounts(wallet);

    expect(result.rekeyedAccounts).toEqual([REKEYED.addr]);
    const auth = result.signingAuthorities[REKEYED.addr];
    expect(auth.isLedger).toBe(true);
    expect(auth.canSign).toBe(true);
    expect(auth.signingAccountId).toBe('led-1'); // NOT the decoy
    expect(auth.signingAddress).toBe(LEDGER_AUTH.addr);
    expect(auth.isRemoteSigner).toBeUndefined();
  });

  it('resolves a REMOTE_SIGNER-delegated rekeyed account end-to-end through detection', async () => {
    const rekeyedStd = standardAccount(REKEYED, 'rk-1');
    const remote = remoteSignerAccount(REMOTE_AUTH, 'remote-1');
    // Decoy remote signer (different address) precedes the real holder.
    const decoyRemote = remoteSignerAccount(DECOY, 'remote-decoy');
    const wallet = makeWallet([rekeyedStd, decoyRemote, remote]);
    mockGetMultipleAccountRekeyInfo.mockResolvedValue({
      [REKEYED.addr]: { isRekeyed: true, authAddress: REMOTE_AUTH.addr },
      [DECOY.addr]: { isRekeyed: false },
      [REMOTE_AUTH.addr]: { isRekeyed: false },
    } as Record<string, RekeyInfo>);

    const result = await manager.detectRekeyedAccounts(wallet);

    expect(result.rekeyedAccounts).toEqual([REKEYED.addr]);
    const auth = result.signingAuthorities[REKEYED.addr];
    expect(auth.isRemoteSigner).toBe(true);
    expect(auth.canSign).toBe(true);
    expect(auth.signingAccountId).toBe('remote-1'); // NOT the decoy
    expect(auth.signingAddress).toBe(REMOTE_AUTH.addr);
    expect(auth.isLedger).toBeUndefined();
  });

  it('detects a rekey on a WATCH-only account delegated to an in-wallet authority', async () => {
    // Scanning must not skip watch-only accounts: a watch account can be
    // rekeyed on-chain to an authority we DO control, making it signable.
    const watched = watchAccount(REKEYED, 'watch-1');
    const stdAuth = standardAccount(STD_AUTH, 'std-1');
    const wallet = makeWallet([watched, stdAuth]);
    mockGetMultipleAccountRekeyInfo.mockResolvedValue({
      [REKEYED.addr]: { isRekeyed: true, authAddress: STD_AUTH.addr },
      [STD_AUTH.addr]: { isRekeyed: false },
    } as Record<string, RekeyInfo>);

    const result = await manager.detectRekeyedAccounts(wallet);

    expect(result.rekeyedAccounts).toEqual([REKEYED.addr]);
    expect(result.signingAuthorities[REKEYED.addr].canSign).toBe(true);
    expect(result.signingAuthorities[REKEYED.addr].signingAccountId).toBe(
      'std-1'
    );
  });

  it('reports a rekeyed account whose authority is absent as rekeyed-but-unsignable', async () => {
    const rekeyedStd = standardAccount(REKEYED, 'rk-1');
    const wallet = makeWallet([rekeyedStd]); // no authority account present

    mockGetMultipleAccountRekeyInfo.mockResolvedValue({
      [REKEYED.addr]: { isRekeyed: true, authAddress: STD_AUTH.addr },
    } as Record<string, RekeyInfo>);

    const result = await manager.detectRekeyedAccounts(wallet);

    expect(result.rekeyedAccounts).toEqual([REKEYED.addr]);
    expect(result.signingAuthorities[REKEYED.addr].canSign).toBe(false);
  });

  it('ignores a rekeyed=true record that carries no authAddress', async () => {
    const wallet = makeWallet([standardAccount(REKEYED, 'rk-1')]);
    mockGetMultipleAccountRekeyInfo.mockResolvedValue({
      [REKEYED.addr]: { isRekeyed: true }, // authAddress missing
    } as Record<string, RekeyInfo>);

    const result = await manager.detectRekeyedAccounts(wallet);

    expect(result.rekeyedAccounts).toEqual([]);
    expect(result.signingAuthorities).toEqual({});
  });

  it('returns empty results when no account is rekeyed', async () => {
    const wallet = makeWallet([
      standardAccount(REKEYED, 'a-1'),
      standardAccount(UNRELATED, 'b-1'),
    ]);
    mockGetMultipleAccountRekeyInfo.mockResolvedValue({
      [REKEYED.addr]: { isRekeyed: false },
      [UNRELATED.addr]: { isRekeyed: false },
    } as Record<string, RekeyInfo>);

    const result = await manager.detectRekeyedAccounts(wallet);

    expect(result.rekeyedAccounts).toEqual([]);
    expect(result.signingAuthorities).toEqual({});
  });

  it('queries the network with exactly the wallet account addresses', async () => {
    const wallet = makeWallet([
      standardAccount(REKEYED, 'a-1'),
      standardAccount(UNRELATED, 'b-1'),
    ]);
    mockGetMultipleAccountRekeyInfo.mockResolvedValue({
      [REKEYED.addr]: { isRekeyed: false },
      [UNRELATED.addr]: { isRekeyed: false },
    } as Record<string, RekeyInfo>);

    await manager.detectRekeyedAccounts(wallet);

    expect(mockGetMultipleAccountRekeyInfo).toHaveBeenCalledWith([
      REKEYED.addr,
      UNRELATED.addr,
    ]);
  });

  it('propagates a wrapped error when the network lookup fails', async () => {
    const wallet = makeWallet([standardAccount(REKEYED, 'a-1')]);
    mockGetMultipleAccountRekeyInfo.mockRejectedValue(new Error('algod down'));

    await expect(manager.detectRekeyedAccounts(wallet)).rejects.toThrow(
      'Failed to detect rekeyed accounts: algod down'
    );
  });
});

// ---------------------------------------------------------------------------
// findSigningAccount
// ---------------------------------------------------------------------------

describe('findSigningAccount', () => {
  it('returns the STANDARD holder for a signable rekeyed account', () => {
    const std = standardAccount(STD_AUTH, 'std-1');
    const wallet = makeWallet([std]);
    const rekeyed = rekeyedAccount(REKEYED, 'rk-1', STD_AUTH.addr, true);

    expect(manager.findSigningAccount(rekeyed, wallet)).toBe(std);
  });

  it('returns the LEDGER holder when no standard key matches', () => {
    const led = ledgerAccount(LEDGER_AUTH, 'led-1');
    // Decoy Ledger (different address) first — must be skipped by address match.
    const decoyLed = ledgerAccount(DECOY, 'led-decoy', DECOY_DEVICE_ID);
    const wallet = makeWallet([decoyLed, led]);
    const rekeyed = rekeyedAccount(REKEYED, 'rk-1', LEDGER_AUTH.addr, true);

    expect(manager.findSigningAccount(rekeyed, wallet)).toBe(led); // NOT decoy
  });

  it('returns null when the rekeyed account cannot sign', () => {
    const std = standardAccount(STD_AUTH, 'std-1');
    const wallet = makeWallet([std]);
    const rekeyed = rekeyedAccount(REKEYED, 'rk-1', STD_AUTH.addr, false);

    expect(manager.findSigningAccount(rekeyed, wallet)).toBeNull();
  });

  it('returns null when no holder for the auth address exists', () => {
    const wallet = makeWallet([standardAccount(UNRELATED, 'x-1')]);
    const rekeyed = rekeyedAccount(REKEYED, 'rk-1', STD_AUTH.addr, true);

    expect(manager.findSigningAccount(rekeyed, wallet)).toBeNull();
  });

  it('does NOT resolve a REMOTE_SIGNER authority (by design — routes via the QR flow)', () => {
    // findSigningAccount is typed to return only StandardAccountMetadata |
    // LedgerAccountMetadata | null: it resolves a concrete *local* signer.
    // A rekeyed account delegated to a remote signer is still signable
    // (canAccountSign → true, getSigningAddress → the auth address) but is
    // driven through the air-gapped QR flow, not this resolver, so it returns
    // null even though the remote-signer authority is present in the wallet.
    // Characterises the contract so a future change to it is caught.
    const remote = remoteSignerAccount(REMOTE_AUTH, 'remote-1');
    const wallet = makeWallet([remote]);
    const rekeyed = rekeyedAccount(REKEYED, 'rk-1', REMOTE_AUTH.addr, true);

    expect(manager.findSigningAccount(rekeyed, wallet)).toBeNull();
    // The account is nonetheless signable via the QR path.
    expect(manager.canAccountSign(rekeyed, wallet)).toBe(true);
    expect(manager.getSigningAddress(rekeyed)).toBe(REMOTE_AUTH.addr);
  });
});

// ---------------------------------------------------------------------------
// canAccountSign — per account type
// ---------------------------------------------------------------------------

describe('canAccountSign', () => {
  const wallet = makeWallet([standardAccount(UNRELATED, 'anchor')]);

  it('STANDARD → true', () => {
    expect(manager.canAccountSign(standardAccount(STD_AUTH, 's'), wallet)).toBe(
      true
    );
  });

  it('WATCH → false', () => {
    expect(manager.canAccountSign(watchAccount(WATCH_AUTH, 'w'), wallet)).toBe(
      false
    );
  });

  it('REMOTE_SIGNER → true (QR flow)', () => {
    expect(
      manager.canAccountSign(remoteSignerAccount(REMOTE_AUTH, 'r'), wallet)
    ).toBe(true);
  });

  it('REKEYED honours the persisted canSign flag', () => {
    expect(
      manager.canAccountSign(
        rekeyedAccount(REKEYED, 'rk', STD_AUTH.addr, true),
        wallet
      )
    ).toBe(true);
    expect(
      manager.canAccountSign(
        rekeyedAccount(REKEYED, 'rk', STD_AUTH.addr, false),
        wallet
      )
    ).toBe(false);
  });

  it('LEDGER → true only while its device is connected', () => {
    const led = ledgerAccount(LEDGER_AUTH, 'led-1');

    mockGetConnectedDevice.mockReturnValue(device(LEDGER_DEVICE_ID));
    expect(manager.canAccountSign(led, wallet)).toBe(true);

    mockGetConnectedDevice.mockReturnValue(null);
    expect(manager.canAccountSign(led, wallet)).toBe(false);

    // A different device connected must NOT count.
    mockGetConnectedDevice.mockReturnValue(device('other-device'));
    expect(manager.canAccountSign(led, wallet)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSigningAddress — per account type
// ---------------------------------------------------------------------------

describe('getSigningAddress', () => {
  it('STANDARD → own address', () => {
    const a = standardAccount(STD_AUTH, 's');
    expect(manager.getSigningAddress(a)).toBe(STD_AUTH.addr);
  });

  it('LEDGER → own address', () => {
    const a = ledgerAccount(LEDGER_AUTH, 'l');
    expect(manager.getSigningAddress(a)).toBe(LEDGER_AUTH.addr);
  });

  it('REMOTE_SIGNER → own address', () => {
    const a = remoteSignerAccount(REMOTE_AUTH, 'r');
    expect(manager.getSigningAddress(a)).toBe(REMOTE_AUTH.addr);
  });

  it('REKEYED signable → the AUTH address, not the account address', () => {
    const a = rekeyedAccount(REKEYED, 'rk', STD_AUTH.addr, true);
    expect(manager.getSigningAddress(a)).toBe(STD_AUTH.addr);
    expect(manager.getSigningAddress(a)).not.toBe(REKEYED.addr);
  });

  it('REKEYED not signable → null', () => {
    const a = rekeyedAccount(REKEYED, 'rk', STD_AUTH.addr, false);
    expect(manager.getSigningAddress(a)).toBeNull();
  });

  it('WATCH → null', () => {
    const a = watchAccount(WATCH_AUTH, 'w');
    expect(manager.getSigningAddress(a)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rekeyToLedger
// ---------------------------------------------------------------------------

describe('rekeyToLedger', () => {
  it('produces REKEYED metadata pointing at the ledger authority (connected → can sign)', async () => {
    const source = standardAccount(REKEYED, 'src-1');
    const led = ledgerAccount(LEDGER_AUTH, 'led-1');
    const wallet = makeWallet([source, led]);
    mockGetConnectedDevice.mockReturnValue(device(LEDGER_DEVICE_ID));

    const result = await manager.rekeyToLedger(source, led, wallet);

    expect(result.type).toBe(AccountType.REKEYED);
    expect(result.authAddress).toBe(LEDGER_AUTH.addr);
    expect(result.address).toBe(REKEYED.addr);
    expect(result.canSign).toBe(true);
    expect(result.originalOwner).toBe(true); // source was STANDARD
    expect(result.rekeyedFrom).toBe(REKEYED.addr);
  });

  it('marks canSign=false when the ledger device is offline', async () => {
    const source = standardAccount(REKEYED, 'src-1');
    const led = ledgerAccount(LEDGER_AUTH, 'led-1');
    const wallet = makeWallet([source, led]);
    mockGetConnectedDevice.mockReturnValue(null);
    mockGetDevices.mockReturnValue([]);

    const result = await manager.rekeyToLedger(source, led, wallet);

    expect(result.canSign).toBe(false);
  });

  it('preserves the original rekeyedFrom when the source is already rekeyed', async () => {
    const source: RekeyedAccountMetadata = {
      ...rekeyedAccount(REKEYED, 'src-1', UNRELATED.addr, false),
      rekeyedFrom: UNRELATED.addr,
    };
    const led = ledgerAccount(LEDGER_AUTH, 'led-1');
    const wallet = makeWallet([source, led]);
    mockGetConnectedDevice.mockReturnValue(device(LEDGER_DEVICE_ID));

    const result = await manager.rekeyToLedger(source, led, wallet);

    expect(result.rekeyedFrom).toBe(UNRELATED.addr);
    expect(result.originalOwner).toBe(false); // source not STANDARD
  });

  it('rejects rekeying a Ledger account to another Ledger', async () => {
    const source = ledgerAccount(REKEYED, 'src-led');
    const led = ledgerAccount(LEDGER_AUTH, 'led-1');
    const wallet = makeWallet([source, led]);

    await expect(manager.rekeyToLedger(source, led, wallet)).rejects.toThrow(
      LedgerAccountError
    );
  });

  it('rejects when the ledger authority is not in the wallet', async () => {
    const source = standardAccount(REKEYED, 'src-1');
    const led = ledgerAccount(LEDGER_AUTH, 'led-1');
    const wallet = makeWallet([source]); // ledger absent

    await expect(manager.rekeyToLedger(source, led, wallet)).rejects.toThrow(
      LedgerAccountError
    );
  });
});

// ---------------------------------------------------------------------------
// rekeyToAirgap
// ---------------------------------------------------------------------------

describe('rekeyToAirgap', () => {
  it('produces REKEYED metadata pointing at the airgap signer (always signable)', async () => {
    const source = standardAccount(REKEYED, 'src-1');
    const airgap = remoteSignerAccount(REMOTE_AUTH, 'air-1');
    const wallet = makeWallet([source, airgap]);

    const result = await manager.rekeyToAirgap(source, airgap, wallet);

    expect(result.type).toBe(AccountType.REKEYED);
    expect(result.authAddress).toBe(REMOTE_AUTH.addr);
    expect(result.canSign).toBe(true);
    expect(result.originalOwner).toBe(true);
    expect(result.rekeyedFrom).toBe(REKEYED.addr);
  });

  it('rejects rekeying a remote-signer account to another remote signer', async () => {
    const source = remoteSignerAccount(REKEYED, 'src-remote');
    const airgap = remoteSignerAccount(REMOTE_AUTH, 'air-1');
    const wallet = makeWallet([source, airgap]);

    await expect(manager.rekeyToAirgap(source, airgap, wallet)).rejects.toThrow(
      'Cannot rekey a remote signer account to another remote signer'
    );
  });

  it('rejects when the airgap signer is not in the wallet', async () => {
    const source = standardAccount(REKEYED, 'src-1');
    const airgap = remoteSignerAccount(REMOTE_AUTH, 'air-1');
    const wallet = makeWallet([source]); // airgap absent

    await expect(manager.rekeyToAirgap(source, airgap, wallet)).rejects.toThrow(
      'Airgap signer account not found in wallet'
    );
  });
});

// ---------------------------------------------------------------------------
// updateAccountWithRekeyInfo — detection → metadata transitions
// ---------------------------------------------------------------------------

describe('updateAccountWithRekeyInfo', () => {
  it('converts a STANDARD account into REKEYED and stamps canSign from the authority', async () => {
    const source = standardAccount(REKEYED, 'src-1');
    const stdAuth = standardAccount(STD_AUTH, 'std-1');
    const wallet = makeWallet([source, stdAuth]);

    const result = await manager.updateAccountWithRekeyInfo(
      source,
      {
        isRekeyed: true,
        authAddress: STD_AUTH.addr,
        rekeyedAt: 1_700_000_000_000,
      },
      wallet
    );

    expect(result.type).toBe(AccountType.REKEYED);
    const rk = result as RekeyedAccountMetadata;
    expect(rk.authAddress).toBe(STD_AUTH.addr);
    expect(rk.canSign).toBe(true);
    expect(rk.originalOwner).toBe(true);
    expect(rk.rekeyedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('refreshes an existing REKEYED account to a NEW authority and re-resolves canSign', async () => {
    // The account was previously rekeyed to a stale authority (UNRELATED) it
    // could sign for; the network now reports a DIFFERENT authority (STD_AUTH).
    // The refresh must adopt the new auth address, not leave the stale one, and
    // re-resolve canSign against the new authority's presence in the wallet.
    const source = rekeyedAccount(REKEYED, 'src-1', UNRELATED.addr, true);
    const stdAuth = standardAccount(STD_AUTH, 'std-1');
    const wallet = makeWallet([source, stdAuth]);

    const result = await manager.updateAccountWithRekeyInfo(
      source,
      { isRekeyed: true, authAddress: STD_AUTH.addr },
      wallet
    );

    expect(result.type).toBe(AccountType.REKEYED);
    const rk = result as RekeyedAccountMetadata;
    expect(rk.authAddress).toBe(STD_AUTH.addr); // adopted new authority
    expect(rk.authAddress).not.toBe(UNRELATED.addr); // stale one dropped
    expect(rk.canSign).toBe(true); // new authority is in-wallet
  });

  it('re-resolves an existing REKEYED account to canSign=false when the authority is gone', async () => {
    const source = rekeyedAccount(REKEYED, 'src-1', STD_AUTH.addr, true);
    const wallet = makeWallet([source]); // authority no longer present

    const result = await manager.updateAccountWithRekeyInfo(
      source,
      { isRekeyed: true, authAddress: STD_AUTH.addr },
      wallet
    );

    expect(result.type).toBe(AccountType.REKEYED);
    expect((result as RekeyedAccountMetadata).canSign).toBe(false);
  });

  it('leaves a non-rekeyed STANDARD account untouched', async () => {
    const source = standardAccount(REKEYED, 'src-1');
    const wallet = makeWallet([source]);

    const result = await manager.updateAccountWithRekeyInfo(
      source,
      { isRekeyed: false },
      wallet
    );

    expect(result).toBe(source);
  });

  it('demotes a REKEYED account to WATCH when the network shows no rekey and no key is stored', async () => {
    // The rekey has been undone on-chain. With no private key recoverable for
    // this account (real AccountSecureStorage has none for a fixture id), the
    // account must fall back to watch-only — never silently keep a signable
    // authority it no longer has.
    const source = rekeyedAccount(REKEYED, 'src-1', STD_AUTH.addr, false);
    const wallet = makeWallet([source]);

    const result = await manager.updateAccountWithRekeyInfo(
      source,
      { isRekeyed: false },
      wallet
    );

    expect(result.type).toBe(AccountType.WATCH);
  });
});
