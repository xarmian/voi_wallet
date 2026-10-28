/**
 * TASK-425 U2: own-key custody. A STANDARD record is its key; a REKEYED one
 * needs positive secret-store evidence, and a probe error is kept distinct from
 * absence. Airgap transfer additionally needs chain evidence that the key still
 * controls the account.
 */
import { AccountMetadata, AccountType } from '@/types/wallet';

const mockProbe = jest.fn<Promise<boolean>, [string]>();
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    probeSecretPresenceStrict: (id: string) => mockProbe(id),
  },
}));

const mockRekeyInfo = jest.fn<
  Promise<{ isRekeyed: boolean }>,
  [string, string]
>();
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (networkId: string) => ({
      getAccountRekeyInfo: (address: string) =>
        mockRekeyInfo(networkId, address),
    }),
  },
}));

import {
  canTransferOwnKey,
  filterAirgapSignableAccounts,
  filterOwnKeyAccounts,
  findOwnKeySigner,
  holdsOwnKey,
  probeOwnKey,
} from '../ownKeyCustody';

const acc = (id: string, type: AccountType) =>
  ({ id, type, address: `ADDR_${id}` }) as unknown as AccountMetadata;

beforeEach(() => {
  mockProbe.mockReset();
  mockRekeyInfo.mockReset();
  mockRekeyInfo.mockResolvedValue({ isRekeyed: false });
});

describe('probeOwnKey / holdsOwnKey', () => {
  it('a STANDARD record holds its key without a probe', async () => {
    await expect(probeOwnKey(acc('a', AccountType.STANDARD))).resolves.toBe(
      'present'
    );
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('a REKEYED record follows the secret probe', async () => {
    mockProbe.mockResolvedValueOnce(true);
    await expect(holdsOwnKey(acc('a', AccountType.REKEYED))).resolves.toBe(
      true
    );
    mockProbe.mockResolvedValueOnce(false);
    await expect(probeOwnKey(acc('a', AccountType.REKEYED))).resolves.toBe(
      'absent'
    );
    expect(mockProbe).toHaveBeenCalledWith('a');
  });

  it('a probe error is unresolved, and fails closed', async () => {
    mockProbe.mockRejectedValue(new Error('keychain timeout'));
    await expect(probeOwnKey(acc('a', AccountType.REKEYED))).resolves.toBe(
      'unresolved'
    );
    await expect(holdsOwnKey(acc('a', AccountType.REKEYED))).resolves.toBe(
      false
    );
  });

  it.each([AccountType.WATCH, AccountType.LEDGER, AccountType.REMOTE_SIGNER])(
    '%s never holds its own key and is not probed',
    async (type) => {
      mockProbe.mockResolvedValue(true);
      await expect(holdsOwnKey(acc('a', type))).resolves.toBe(false);
      expect(mockProbe).not.toHaveBeenCalled();
    }
  );
});

describe('filterOwnKeyAccounts / filterAirgapSignableAccounts', () => {
  const accounts = [
    acc('watch', AccountType.WATCH),
    acc('rekeyed-key', AccountType.REKEYED),
    acc('standard', AccountType.STANDARD),
    acc('rekeyed-nokey', AccountType.REKEYED),
    acc('ledger', AccountType.LEDGER),
  ];

  it('keeps exactly the key-holding accounts, in input order', async () => {
    mockProbe.mockImplementation(async (id) => id !== 'rekeyed-nokey');
    const held = await filterOwnKeyAccounts(accounts);
    expect(held.map((a) => a.id)).toEqual(['rekeyed-key', 'standard']);
  });

  it('an airgap signer also lists its Ledger accounts', async () => {
    mockProbe.mockImplementation(async (id) => id !== 'rekeyed-nokey');
    const signable = await filterAirgapSignableAccounts(accounts);
    expect(signable.map((a) => a.id)).toEqual([
      'rekeyed-key',
      'standard',
      'ledger',
    ]);
  });
});

describe('canTransferOwnKey', () => {
  it('a STANDARD account transfers without a chain read', async () => {
    await expect(
      canTransferOwnKey(acc('s', AccountType.STANDARD))
    ).resolves.toBe(true);
    expect(mockRekeyInfo).not.toHaveBeenCalled();
  });

  it('a REKEYED account with its key transfers once no network is rekeyed', async () => {
    mockProbe.mockResolvedValue(true);
    await expect(
      canTransferOwnKey(acc('r', AccountType.REKEYED))
    ).resolves.toBe(true);
    expect(mockRekeyInfo.mock.calls.map(([n]) => n).sort()).toEqual([
      'algorand-mainnet',
      'voi-mainnet',
    ]);
  });

  it.each(['voi-mainnet', 'algorand-mainnet'])(
    'a REKEYED account still rekeyed on %s does not transfer',
    async (rekeyedOn) => {
      mockProbe.mockResolvedValue(true);
      mockRekeyInfo.mockImplementation(async (networkId) => ({
        isRekeyed: networkId === rekeyedOn,
      }));
      await expect(
        canTransferOwnKey(acc('r', AccountType.REKEYED))
      ).resolves.toBe(false);
    }
  );

  it('a chain-read error fails closed', async () => {
    mockProbe.mockResolvedValue(true);
    mockRekeyInfo.mockRejectedValue(new Error('network down'));
    await expect(
      canTransferOwnKey(acc('r', AccountType.REKEYED))
    ).resolves.toBe(false);
  });

  it('a REKEYED account without its key does not transfer', async () => {
    mockProbe.mockResolvedValue(false);
    await expect(
      canTransferOwnKey(acc('r', AccountType.REKEYED))
    ).resolves.toBe(false);
    expect(mockRekeyInfo).not.toHaveBeenCalled();
  });
});

describe('findOwnKeySigner (TASK-425 U3)', () => {
  it('returns a STANDARD record at the address without probing', async () => {
    const accounts = [acc('a', AccountType.STANDARD)];
    await expect(findOwnKeySigner('ADDR_a', accounts)).resolves.toBe(
      accounts[0]
    );
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('returns a REKEYED record only once its key is probed present', async () => {
    const accounts = [acc('r', AccountType.REKEYED)];
    mockProbe.mockResolvedValueOnce(true);
    await expect(findOwnKeySigner('ADDR_r', accounts)).resolves.toBe(
      accounts[0]
    );
    mockProbe.mockResolvedValueOnce(false);
    await expect(findOwnKeySigner('ADDR_r', accounts)).resolves.toBeUndefined();
    mockProbe.mockRejectedValueOnce(new Error('keychain busy'));
    await expect(findOwnKeySigner('ADDR_r', accounts)).resolves.toBeUndefined();
  });

  it.each([AccountType.WATCH, AccountType.LEDGER, AccountType.REMOTE_SIGNER])(
    'never returns a %s record',
    async (type) => {
      await expect(
        findOwnKeySigner('ADDR_x', [acc('x', type)])
      ).resolves.toBeUndefined();
    }
  );

  it('matches the address case-insensitively and ignores other addresses', async () => {
    const accounts = [
      acc('other', AccountType.STANDARD),
      acc('a', AccountType.STANDARD),
    ];
    await expect(findOwnKeySigner('addr_a', accounts)).resolves.toBe(
      accounts[1]
    );
  });
});
