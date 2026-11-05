// TASK-504: an incomplete backup takes envelope v3, is named
// -incomplete.voibackup, never reads as complete, and a new app refuses a file
// where the envelope and the encrypted payload disagree. Real encryption; the
// collectors, restorers and file system are faked.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  return {
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
    },
  };
});

const mockFiles = new Map<string, string>();
jest.mock('expo-file-system', () => {
  class Directory {
    get exists() {
      return true;
    }
    async create() {}
  }
  class File {
    uri: string;
    constructor(a: unknown, b?: string) {
      this.uri = typeof a === 'string' ? a : `file:///mock/${b}`;
    }
    async write(content: string) {
      mockFiles.set(this.uri, content);
    }
    async text() {
      return mockFiles.get(this.uri) ?? '';
    }
  }
  return { Directory, File, Paths: { cache: 'file:///mock/cache' } };
});
jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => {},
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

const mockCollect = jest.fn();
jest.mock('../collectors', () => ({
  collectAccounts: (...a: unknown[]) => mockCollect(...a),
  collectSettings: jest.fn(async () => ({})),
  collectFriends: jest.fn(async () => []),
  collectExperimental: jest.fn(async () => ({})),
}));
const mockRestore = jest.fn();
const mockRemovePin = jest.fn();
const mockCalls: string[] = [];
jest.mock('../restorers', () => ({
  performFullRestore: (...a: unknown[]) => {
    mockCalls.push('restore');
    return mockRestore(...a);
  },
  removeOldPinForRestore: (...a: unknown[]) => {
    mockCalls.push('removePin');
    return mockRemovePin(...a);
  },
  planRestore: () => ({
    total: 2,
    addable: 2,
    addableWithKey: 1,
    notAdded: [],
  }),
  validateRetainedKeys: jest.fn(),
}));

import { BackupService, assertEnvelopeMatchesPayload } from '../index';
import {
  encryptBackup,
  decryptBackup,
  validateEncryptedBackupFile,
} from '../encryption';
import type { EncryptedBackupFile, VoiBackupFile } from '../types';

const PASSWORD = 'correct horse battery staple backup!';
const CAP = { __brand: 'FreshAuthCapability' } as never;
const LEFT_OUT = [
  { address: 'ADDR1', label: 'Imported Account', reason: 'key-unreadable' },
];

beforeEach(() => {
  mockFiles.clear();
  mockCollect.mockReset();
  mockRestore.mockReset();
  mockRemovePin.mockReset();
  mockCalls.length = 0;
});

function payload(extra: object = {}): VoiBackupFile {
  return {
    version: 1,
    createdAt: 'now',
    appVersion: '9.9.9',
    accounts: [],
    settings: {},
    friends: [],
    experimental: {},
    ...extra,
  } as unknown as VoiBackupFile;
}

describe('TASK-504: envelope v3 marks an incomplete backup', () => {
  it('an incomplete backup is v3 and a complete one stays v2', async () => {
    const incomplete = await encryptBackup('{}', PASSWORD, {
      incomplete: true,
    });
    const complete = await encryptBackup('{}', PASSWORD);
    expect(incomplete.version).toBe(3);
    expect(complete.version).toBe(2);
    expect(Object.keys(incomplete).sort()).toEqual(
      Object.keys(complete).sort()
    );
  });

  it('v3 decrypts with the password and validates', async () => {
    const env = await encryptBackup('{"a":1}', PASSWORD, { incomplete: true });
    expect(
      validateEncryptedBackupFile(JSON.parse(JSON.stringify(env)))
    ).toEqual(env);
    expect(await decryptBackup(env, PASSWORD)).toBe('{"a":1}');
  });

  it('the version is authenticated: editing 3 to 2, or 2 to 3, fails the integrity check', async () => {
    const v3 = await encryptBackup('{}', PASSWORD, { incomplete: true });
    const v2 = await encryptBackup('{}', PASSWORD);
    await expect(
      decryptBackup({ ...v3, version: 2 } as EncryptedBackupFile, PASSWORD)
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
    await expect(
      decryptBackup({ ...v2, version: 3 } as EncryptedBackupFile, PASSWORD)
    ).rejects.toMatchObject({ code: 'INTEGRITY_CHECK_FAILED' });
  });

  it('v3 takes the v2 KDF caps before any scrypt work', async () => {
    const v3 = await encryptBackup('{}', PASSWORD, { incomplete: true });
    expect(() =>
      validateEncryptedBackupFile({
        ...v3,
        kdfParams: { ...(v3 as { kdfParams: object }).kdfParams, N: 2 ** 30 },
      })
    ).toThrow();
  });

  it('no address, label or count sits outside the encryption', async () => {
    const env = await encryptBackup(
      JSON.stringify(payload({ incomplete: { leftOut: LEFT_OUT } })),
      PASSWORD,
      { incomplete: true }
    );
    const text = JSON.stringify(env);
    expect(text).not.toContain('ADDR1');
    expect(text).not.toContain('Imported Account');
    expect(Object.keys(env).sort()).toEqual(
      [
        'ciphertext',
        'format',
        'hmac',
        'iv',
        'kdf',
        'kdfParams',
        'salt',
        'version',
      ].sort()
    );
  });
});

describe('TASK-504: envelope and payload must agree', () => {
  it.each([
    ['v3 envelope, payload without the list', 3, undefined],
    ['v2 envelope, payload with a list', 2, { leftOut: LEFT_OUT }],
    ['v3 envelope, empty list', 3, { leftOut: [] }],
    ['v2 envelope, empty list', 2, { leftOut: [] }],
  ])('refuses: %s', (_name, version, incomplete) => {
    expect(() =>
      assertEnvelopeMatchesPayload(
        { version } as EncryptedBackupFile,
        payload(incomplete ? { incomplete } : {})
      )
    ).toThrow(/damaged|altered|Invalid backup structure/);
  });

  it('accepts a complete file and an incomplete one', () => {
    expect(() =>
      assertEnvelopeMatchesPayload(
        { version: 2 } as EncryptedBackupFile,
        payload()
      )
    ).not.toThrow();
    expect(() =>
      assertEnvelopeMatchesPayload(
        { version: 3 } as EncryptedBackupFile,
        payload({ incomplete: { leftOut: LEFT_OUT } })
      )
    ).not.toThrow();
  });
});

describe('TASK-504: createBackup and restoreBackup', () => {
  it('an incomplete backup: -incomplete name, v3 file, no success wording, the list inside, nothing outside', async () => {
    mockCollect.mockResolvedValue({
      accounts: [],
      leftOut: LEFT_OUT,
      total: 2,
    });
    const messages: string[] = [];
    BackupService.setProgressCallback((p) => messages.push(p.message));

    const result = await BackupService.createBackup(PASSWORD, CAP);

    expect(result.filename).toMatch(
      /^voi-wallet-\d{4}-\d{2}-\d{2}-incomplete\.voibackup$/
    );
    expect(result.filename).not.toContain('ADDR1');
    expect(result.incomplete).toEqual({ leftOut: LEFT_OUT });
    expect(result.totalAccountCount).toBe(2);
    expect(messages).not.toContain('Backup complete!');
    const file = JSON.parse(result.fileContent);
    expect(file.version).toBe(3);
    const inner = JSON.parse(await decryptBackup(file, PASSWORD));
    expect(inner.incomplete).toEqual({ leftOut: LEFT_OUT });
  });

  it('a complete backup: unchanged name, v2 envelope, no incomplete list', async () => {
    mockCollect.mockResolvedValue({ accounts: [], leftOut: [], total: 0 });
    const messages: string[] = [];
    BackupService.setProgressCallback((p) => messages.push(p.message));

    const result = await BackupService.createBackup(PASSWORD, CAP);

    expect(result.filename).toMatch(
      /^voi-wallet-\d{4}-\d{2}-\d{2}\.voibackup$/
    );
    expect(result.incomplete).toBeUndefined();
    expect(messages).toContain('Backup complete!');
    const file = JSON.parse(result.fileContent);
    expect(file.version).toBe(2);
    const inner = JSON.parse(await decryptBackup(file, PASSWORD));
    expect(inner).not.toHaveProperty('incomplete');
  });

  it('a locked vault stops the backup: no file is written', async () => {
    const { BackupError } = jest.requireActual('../types');
    mockCollect.mockRejectedValue(
      new BackupError('Unlock the wallet', 'AUTHENTICATION_REQUIRED')
    );
    await expect(
      BackupService.createBackup(PASSWORD, CAP)
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
    expect(mockFiles.size).toBe(0);
  });

  it('restoring an incomplete file hands its left-out list to the result', async () => {
    mockCollect.mockResolvedValue({
      accounts: [],
      leftOut: LEFT_OUT,
      total: 2,
    });
    const made = await BackupService.createBackup(PASSWORD, CAP);
    mockRestore.mockResolvedValue({ records: [], settingsRestored: false });

    const result = await BackupService.restoreBackup(made.fileUri, PASSWORD);

    expect(result.leftOut).toEqual(LEFT_OUT);
  });

  it('a file whose envelope says incomplete but whose payload is complete is refused before any restore', async () => {
    const forged = await encryptBackup(JSON.stringify(payload()), PASSWORD, {
      incomplete: true,
    });
    mockFiles.set('file:///forged', JSON.stringify(forged));

    await expect(
      BackupService.restoreBackup('file:///forged', PASSWORD)
    ).rejects.toMatchObject({ code: 'INVALID_FILE_FORMAT' });
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('a file whose payload lists left-out accounts under a v2 envelope is refused before any restore', async () => {
    const forged = await encryptBackup(
      JSON.stringify(payload({ incomplete: { leftOut: LEFT_OUT } })),
      PASSWORD
    );
    mockFiles.set('file:///forged2', JSON.stringify(forged));

    await expect(
      BackupService.restoreBackup('file:///forged2', PASSWORD)
    ).rejects.toMatchObject({ code: 'INVALID_FILE_FORMAT' });
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('validateBackupFile reports the left-out list of an incomplete file', async () => {
    mockCollect.mockResolvedValue({
      accounts: [],
      leftOut: LEFT_OUT,
      total: 2,
    });
    const made = await BackupService.createBackup(PASSWORD, CAP);
    const info = await BackupService.validateBackupFile(made.fileUri, PASSWORD);
    expect(info.incomplete).toEqual({ leftOut: LEFT_OUT });
  });
});

describe('TASK-504: the forgotten-PIN option and the restore plan', () => {
  async function madeFile() {
    mockCollect.mockResolvedValue({ accounts: [], leftOut: [], total: 0 });
    return BackupService.createBackup(PASSWORD, CAP);
  }

  it('removeOldPin runs step B first, then the restore', async () => {
    const made = await madeFile();
    mockRestore.mockResolvedValue({ records: [], settingsRestored: true });

    await BackupService.restoreBackup(made.fileUri, PASSWORD, {
      removeOldPin: true,
    });

    expect(mockCalls).toEqual(['removePin', 'restore']);
  });

  it('without the option, no PIN is touched', async () => {
    const made = await madeFile();
    mockRestore.mockResolvedValue({ records: [], settingsRestored: true });
    await BackupService.restoreBackup(made.fileUri, PASSWORD);
    expect(mockCalls).toEqual(['restore']);
  });

  it('a refused step B stops before any restore', async () => {
    const made = await madeFile();
    mockRemovePin.mockRejectedValue(new Error('refused'));
    await expect(
      BackupService.restoreBackup(made.fileUri, PASSWORD, {
        removeOldPin: true,
      })
    ).rejects.toThrow('refused');
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('entering the PIN and removing it together is refused before anything runs', async () => {
    const made = await madeFile();
    await expect(
      BackupService.restoreBackup(made.fileUri, PASSWORD, {
        removeOldPin: true,
        oldPinSession: { epoch: 1 },
      })
    ).rejects.toMatchObject({ code: 'RESTORE_FAILED' });
    expect(mockCalls).toEqual([]);
  });

  it('validateBackupFile reports what a restore would add', async () => {
    const made = await madeFile();
    const info = await BackupService.validateBackupFile(made.fileUri, PASSWORD);
    expect(info.restorePlan).toEqual({
      total: 2,
      addable: 2,
      addableWithKey: 1,
      notAdded: [],
    });
  });
});
