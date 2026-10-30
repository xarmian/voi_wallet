// Unit tests for TASK-155: RekeyManager's explicit rekey-to-Ledger and
// rekey-to-airgap metadata. Signing-authority resolution and balance-load rekey
// detection were removed in TASK-425 U5; signing authority is read from chain
// state per network (keyManager.getSigningInfo / rekeyState).
//
// SCOPE: pure metadata / address-matching decisions; the manager itself
// performs no signing.
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
// untranspilable native ESM), mirroring the DR-1 pattern in
// importFromPrivateKey.test.ts. Only the leaves are mocked — the code under test (rekeyManager.ts) and algosdk are the
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
const UNRELATED = makeAccount('rekey-manager:unrelated');

const LEDGER_DEVICE_ID = 'ledger-device-abc';

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
    backupVerified: false,
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

// TASK-419: `originalOwner` is the durable signal that the account still holds
// its original key (hasKeyBearingAccountStrict counts it without a secure read),
// so it must survive repeated rekeys.
describe('originalOwner through repeated rekeys (TASK-419)', () => {
  const ledger = ledgerAccount(LEDGER_AUTH, 'led-1');
  const airgap = remoteSignerAccount(REMOTE_AUTH, 'rs-1');

  it('STANDARD → Ledger → airgap keeps originalOwner true', async () => {
    const source = standardAccount(REKEYED, 'acct-1');
    const wallet = makeWallet([source, ledger, airgap]);
    const toLedger = await manager.rekeyToLedger(source, ledger, wallet);
    expect(toLedger.originalOwner).toBe(true);
    const toAirgap = await manager.rekeyToAirgap(
      toLedger,
      airgap,
      makeWallet([toLedger, ledger, airgap])
    );
    expect(toAirgap.originalOwner).toBe(true);
  });

  it('STANDARD → airgap → Ledger keeps originalOwner true', async () => {
    const source = standardAccount(REKEYED, 'acct-1');
    const wallet = makeWallet([source, ledger, airgap]);
    const toAirgap = await manager.rekeyToAirgap(source, airgap, wallet);
    const toLedger = await manager.rekeyToLedger(
      toAirgap,
      ledger,
      makeWallet([toAirgap, ledger, airgap])
    );
    expect(toLedger.originalOwner).toBe(true);
  });

  it('a keyless REKEYED source stays originalOwner false', async () => {
    const source = rekeyedAccount(REKEYED, 'acct-1', LEDGER_AUTH.addr, true);
    const toAirgap = await manager.rekeyToAirgap(
      source,
      airgap,
      makeWallet([source, ledger, airgap])
    );
    expect(toAirgap.originalOwner).toBe(false);
  });

  it('a WATCH source stays originalOwner false', async () => {
    const source = watchAccount(REKEYED, 'acct-1');
    const toLedger = await manager.rekeyToLedger(
      source,
      ledger,
      makeWallet([source, ledger, airgap])
    );
    expect(toLedger.originalOwner).toBe(false);
  });
});

// TASK-421 U4b: backup history belongs to the converted account, never its auth.
describe('per-account backup history through conversions', () => {
  const backupCreatedAt = '2025-04-03T02:01:00.000Z';
  const histories = [
    { hasBackup: true, backupVerified: true, backupCreatedAt },
    { hasBackup: true, backupVerified: false, backupCreatedAt },
    { hasBackup: false, backupVerified: false },
    {}, // Legacy records must not gain verification or a timestamp.
  ];
  afterEach(() => jest.restoreAllMocks());

  it.each(histories)(
    'keeps %j through Ledger and airgap rekeys in both orders',
    async (history) => {
      const source: StandardAccountMetadata = {
        ...standardAccount(REKEYED, 'src-1'),
        ...history,
      };
      const ledger = ledgerAccount(LEDGER_AUTH, 'led-1');
      const airgap = remoteSignerAccount(REMOTE_AUTH, 'air-1');
      const toLedger = (account: AccountMetadata) =>
        manager.rekeyToLedger(
          account,
          ledger,
          makeWallet([account, ledger, airgap])
        );
      const toAirgap = (account: AccountMetadata) =>
        manager.rekeyToAirgap(
          account,
          airgap,
          makeWallet([account, ledger, airgap])
        );
      const ledgerFirst = await toLedger(source);
      const airgapFirst = await toAirgap(source);
      for (const result of [
        ledgerFirst,
        airgapFirst,
        await toAirgap(ledgerFirst),
        await toLedger(airgapFirst),
      ]) {
        expect(result).toMatchObject({
          hasBackup: source.hasBackup,
          backupVerified: source.backupVerified,
          backupCreatedAt: source.backupCreatedAt,
        });
      }
    }
  );

  it('gives WATCH sources no flags across both REKEYED constructors', async () => {
    const source = watchAccount(REKEYED, 'watch-1');
    const auth = {
      ...standardAccount(STD_AUTH, 'auth-1'),
      hasBackup: true,
      backupVerified: true,
      backupCreatedAt,
    };
    const ledger = ledgerAccount(LEDGER_AUTH, 'led-1');
    const airgap = remoteSignerAccount(REMOTE_AUTH, 'air-1');
    const wallet = makeWallet([source, auth, ledger, airgap]);
    for (const result of [
      await manager.rekeyToLedger(source, ledger, wallet),
      await manager.rekeyToAirgap(source, airgap, wallet),
    ]) {
      expect(result.type).toBe(AccountType.REKEYED);
      for (const field of ['hasBackup', 'backupVerified', 'backupCreatedAt']) {
        expect(result).not.toHaveProperty(field);
      }
    }
  });
});
