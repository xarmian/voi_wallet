// TASK-504 (product e7912207 item 2, dev lead ef933e70 / 89d3f459): the
// without-key flag lives inside the encrypted payload and must agree with the
// incomplete list both ways. A flagged record that carries a phrase is refused.
// The other-key-on-device entry is the one list entry with no flagged record:
// its account's own key is in the file.

jest.mock('@/platform', () => ({ crypto: {} }));
jest.mock('expo-file-system', () => ({
  Directory: class {},
  File: class {},
  Paths: { cache: 'file:///mock/cache' },
}));
jest.mock('expo-sharing', () => ({}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));
jest.mock('../collectors', () => ({}));
jest.mock('../restorers', () => ({}));

import { AccountType } from '@/types/wallet';
import { assertEnvelopeMatchesPayload, assertFlagsMatchList } from '..';
import type {
  EncryptedBackupFile,
  BackupAccountData,
  BackupLeftOutAccount,
  VoiBackupFile,
} from '../types';

const A1 = 'A'.repeat(58);
const A2 = 'B'.repeat(58);
const PHRASE = 'word '.repeat(25).trim();

function rec(
  over: Partial<BackupAccountData> & { id: string; address: string }
): BackupAccountData {
  return {
    type: AccountType.STANDARD,
    label: over.id,
    publicKey: '00',
    createdAt: '2026-11-05T00:00:00.000Z',
    isHidden: false,
    ...over,
  } as BackupAccountData;
}

function file(
  accounts: BackupAccountData[],
  leftOut?: BackupLeftOutAccount[]
): VoiBackupFile {
  return {
    version: 1,
    createdAt: '2026-11-05T00:00:00.000Z',
    appVersion: 'test',
    accounts,
    settings: {},
    friends: [],
    experimental: {},
    ...(leftOut ? { incomplete: { leftOut } } : {}),
  } as unknown as VoiBackupFile;
}

const entry = (
  address: string,
  reason: BackupLeftOutAccount['reason'] = 'key-unreadable'
): BackupLeftOutAccount => ({ address, label: address.slice(0, 3), reason });

const REFUSED = {
  code: 'INVALID_FILE_FORMAT',
  // Product's text, verbatim (TASK-504 ruling): true for a damaged file, an
  // altered one, and one from a different version of the app.
  message:
    'This backup file was not used. It may be damaged, altered or from a different version of the app. If you still have the wallet it came from, make a new backup there.',
};

describe('TASK-504: the without-key flag and the incomplete list agree', () => {
  it('a complete file with no flag and no list is accepted', () => {
    expect(() =>
      assertFlagsMatchList(
        file([rec({ id: 'a', address: A1, mnemonic: PHRASE })])
      )
    ).not.toThrow();
  });

  it('a flagged record with exactly one matching list entry is accepted', () => {
    expect(() =>
      assertFlagsMatchList(
        file([rec({ id: 'a', address: A1, withoutKey: true })], [entry(A1)])
      )
    ).not.toThrow();
  });

  it('a flagged record that carries a phrase is refused', () => {
    expect(() =>
      assertFlagsMatchList(
        file(
          [rec({ id: 'a', address: A1, withoutKey: true, mnemonic: PHRASE })],
          [entry(A1)]
        )
      )
    ).toThrow(expect.objectContaining(REFUSED));
  });

  it('a flagged record with no list entry is refused (and with no list at all)', () => {
    expect(() =>
      assertFlagsMatchList(
        file([rec({ id: 'a', address: A1, withoutKey: true })], [entry(A2)])
      )
    ).toThrow(expect.objectContaining(REFUSED));
    expect(() =>
      assertFlagsMatchList(
        file([rec({ id: 'a', address: A1, withoutKey: true })])
      )
    ).toThrow(expect.objectContaining(REFUSED));
  });

  it('a list entry (other than other-key-on-device) with no flagged record is refused', () => {
    expect(() =>
      assertFlagsMatchList(
        file([rec({ id: 'a', address: A1, mnemonic: PHRASE })], [entry(A1)])
      )
    ).toThrow(expect.objectContaining(REFUSED));
  });

  it('two flagged records at one address need two entries; one entry is refused', () => {
    const two = [
      rec({ id: 'a', address: A1, withoutKey: true }),
      rec({ id: 'b', address: A1, withoutKey: true }),
    ];
    expect(() =>
      assertFlagsMatchList(file(two, [entry(A1), entry(A1)]))
    ).not.toThrow();
    expect(() => assertFlagsMatchList(file(two, [entry(A1)]))).toThrow(
      expect.objectContaining(REFUSED)
    );
  });

  it('an other-key-on-device entry needs no flagged record, but needs a keyed record at its address', () => {
    expect(() =>
      assertFlagsMatchList(
        file(
          [rec({ id: 'a', address: A1, mnemonic: PHRASE })],
          [entry(A1, 'other-key-on-device')]
        )
      )
    ).not.toThrow();
    // No record at the address carries a key: the reason would be false.
    expect(() =>
      assertFlagsMatchList(
        file(
          [rec({ id: 'a', address: A1, withoutKey: true })],
          [entry(A1, 'other-key-on-device'), entry(A1)]
        )
      )
    ).toThrow(expect.objectContaining(REFUSED));
    expect(() =>
      assertFlagsMatchList(file([], [entry(A1, 'other-key-on-device')]))
    ).toThrow(expect.objectContaining(REFUSED));
  });

  it('the flag is only for standard and rekeyed records, and only the value true', () => {
    for (const type of [
      AccountType.WATCH,
      AccountType.LEDGER,
      AccountType.REMOTE_SIGNER,
    ]) {
      expect(() =>
        assertFlagsMatchList(
          file(
            [rec({ id: 'a', address: A1, type, withoutKey: true })],
            [entry(A1)]
          )
        )
      ).toThrow(expect.objectContaining(REFUSED));
    }
    for (const bad of [false, 'true', 1, null]) {
      expect(() =>
        assertFlagsMatchList(
          file([
            rec({
              id: 'a',
              address: A1,
              mnemonic: PHRASE,
              withoutKey: bad as unknown as boolean,
            }),
          ])
        )
      ).toThrow(expect.objectContaining(REFUSED));
    }
  });

  it('an unknown reason in the list is refused', () => {
    expect(() =>
      assertFlagsMatchList(
        file(
          [rec({ id: 'a', address: A1, withoutKey: true })],
          [entry(A1, 'made-up' as never)]
        )
      )
    ).toThrow(expect.objectContaining(REFUSED));
  });

  it('is part of the import check: a v2 envelope around a flagged record is refused before anything is read', () => {
    const flagged = file(
      [rec({ id: 'a', address: A1, withoutKey: true })],
      [entry(A1)]
    );
    expect(() =>
      assertEnvelopeMatchesPayload(
        { version: 3 } as unknown as EncryptedBackupFile,
        flagged
      )
    ).not.toThrow();
    expect(() =>
      assertEnvelopeMatchesPayload(
        { version: 2 } as unknown as EncryptedBackupFile,
        flagged
      )
    ).toThrow();
    // v3 envelope and a matching list, but a flagged record carrying a phrase.
    const withPhrase = file(
      [rec({ id: 'a', address: A1, withoutKey: true, mnemonic: PHRASE })],
      [entry(A1)]
    );
    expect(() =>
      assertEnvelopeMatchesPayload(
        { version: 3 } as unknown as EncryptedBackupFile,
        withPhrase
      )
    ).toThrow(expect.objectContaining(REFUSED));
  });
});
