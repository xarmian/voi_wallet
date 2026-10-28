/**
 * TASK-425 U2: own-key custody is positive secret-store evidence on a record
 * type that can carry the key; a probe error fails closed.
 */
import { AccountMetadata, AccountType } from '@/types/wallet';

const mockProbe = jest.fn<Promise<boolean>, [string]>();
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    probeSecretPresenceStrict: (id: string) => mockProbe(id),
  },
}));

import { filterOwnKeyAccounts, holdsOwnKey } from '../ownKeyCustody';

const acc = (id: string, type: AccountType) =>
  ({ id, type, address: `ADDR_${id}` }) as unknown as AccountMetadata;

beforeEach(() => {
  mockProbe.mockReset();
});

describe('holdsOwnKey', () => {
  it.each([AccountType.STANDARD, AccountType.REKEYED])(
    '%s follows the secret probe',
    async (type) => {
      mockProbe.mockResolvedValueOnce(true);
      await expect(holdsOwnKey(acc('a', type))).resolves.toBe(true);
      mockProbe.mockResolvedValueOnce(false);
      await expect(holdsOwnKey(acc('a', type))).resolves.toBe(false);
      expect(mockProbe).toHaveBeenCalledWith('a');
    }
  );

  it('fails closed on a probe error', async () => {
    mockProbe.mockRejectedValueOnce(new Error('keychain timeout'));
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

describe('filterOwnKeyAccounts', () => {
  it('keeps exactly the key-holding accounts, in input order', async () => {
    mockProbe.mockImplementation(async (id) => id !== 'rekeyed-nokey');
    const accounts = [
      acc('watch', AccountType.WATCH),
      acc('rekeyed-key', AccountType.REKEYED),
      acc('standard', AccountType.STANDARD),
      acc('rekeyed-nokey', AccountType.REKEYED),
      acc('ledger', AccountType.LEDGER),
    ];
    const held = await filterOwnKeyAccounts(accounts);
    expect(held.map((a) => a.id)).toEqual(['rekeyed-key', 'standard']);
  });
});
