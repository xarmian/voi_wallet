// TASK-469: a backup that is being created when Delete Everything starts must
// not leave its file behind. The wipe deletes the backup files in the app
// cache; a backup still collecting or encrypting at that point would otherwise
// recreate the directory and write the previous wallet's keys after it.
//
// SECURITY NOTE: no real secret material. The collectors are mocked, and the
// encryption step returns a fixed stand-in envelope.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  return {
    crypto: {
      getRandomBytes: async (byteCount: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(byteCount)),
    },
  };
});

// An in-memory file system: the directory and the files written into it.
jest.mock('expo-file-system', () => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const hooks: { onWrite: (() => void) | null } = { onWrite: null };
  const pathOf = (parts: unknown[]) =>
    parts
      .map((part) =>
        typeof part === 'string' ? part : (part as { uri: string }).uri
      )
      .join('/');
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = pathOf(parts);
    }
    get exists() {
      return dirs.has(this.uri);
    }
    async create() {
      dirs.add(this.uri);
    }
  }
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = pathOf(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    async write(content: string) {
      files.set(this.uri, content);
      hooks.onWrite?.();
    }
    delete() {
      if (!files.has(this.uri)) throw new Error('no such file');
      files.delete(this.uri);
    }
  }
  return {
    Directory,
    File,
    Paths: { cache: 'file:///cache' },
    __files: files,
    __dirs: dirs,
    __hooks: hooks,
  };
});
jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => {},
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));
jest.mock('../collectors', () => ({
  collectAccounts: jest.fn(async () => ({
    accounts: [],
    leftOut: [],
    total: 0,
  })),
  collectSettings: jest.fn(async () => ({})),
  collectFriends: jest.fn(async () => []),
  collectExperimental: jest.fn(async () => ({
    swapEnabled: false,
    messagingEnabled: false,
  })),
}));
jest.mock('../restorers', () => ({ performFullRestore: jest.fn() }));
jest.mock('../encryption', () => ({
  ...jest.requireActual('../encryption'),
  encryptBackup: jest.fn(async () => ({ version: 2, stand: 'in' })),
}));

import * as fileSystem from 'expo-file-system';
import { BackupService } from '../index';
import { encryptBackup } from '../encryption';
import {
  closeWipeWindow,
  openWipeWindow,
  runWipeResets,
} from '@/services/wipe/gate';
import type { FreshAuthCapability } from '@/services/secure/freshAuth';

const fs = fileSystem as unknown as {
  __files: Map<string, string>;
  __dirs: Set<string>;
  __hooks: { onWrite: (() => void) | null };
};
const capability = { __brand: 'FreshAuthCapability' } as FreshAuthCapability;
const PASSWORD = 'correct horse battery staple';

/** What the wipe does first: open its window and move the epoch. */
function startWipe() {
  openWipeWindow();
  runWipeResets();
}

beforeEach(() => {
  fs.__files.clear();
  fs.__dirs.clear();
  fs.__hooks.onWrite = null;
});
afterEach(() => closeWipeWindow());

describe('TASK-469: a backup that a wipe overlaps', () => {
  it('without a wipe the file is written and the result points at it', async () => {
    const result = await BackupService.createBackup(PASSWORD, capability);
    expect(fs.__files.has(result.fileUri)).toBe(true);
  });

  it('a wipe that starts during encryption writes no file and the call rejects', async () => {
    jest.mocked(encryptBackup).mockImplementationOnce(async () => {
      startWipe();
      return { version: 2, stand: 'in' } as never;
    });
    await expect(
      BackupService.createBackup(PASSWORD, capability)
    ).rejects.toMatchObject({ name: 'BackupError' });
    expect(fs.__files.size).toBe(0);
    // The backups directory the wipe deleted is not created again.
    expect(fs.__dirs.size).toBe(0);
  });

  it('a wipe that starts during the write deletes the file and the call rejects', async () => {
    fs.__hooks.onWrite = startWipe;
    await expect(
      BackupService.createBackup(PASSWORD, capability)
    ).rejects.toMatchObject({ name: 'BackupError' });
    expect(fs.__files.size).toBe(0);
  });

  it('a backup that starts while a wipe is running writes no file', async () => {
    openWipeWindow();
    await expect(
      BackupService.createBackup(PASSWORD, capability)
    ).rejects.toMatchObject({ name: 'BackupError' });
    expect(fs.__files.size).toBe(0);
  });
});
