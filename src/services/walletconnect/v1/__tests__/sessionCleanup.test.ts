// Tests for the centralized v1 session cleanup (PLAN-260, TASK-258).
//
// This module exists because review found the SAME omission — deleting session
// metadata without its key — at separate deletion sites in a row. Each was
// fixed individually until it became clear the problem was the scattering. These tests pin the complete-cleanup contract
// so a new deletion path cannot quietly reintroduce a partial one.

const mockKv = new Map<string, string>();
const mockSecure = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: async (k: string, v: string) => {
      mockKv.set(k, v);
    },
    getItem: async (k: string) => (mockKv.has(k) ? mockKv.get(k)! : null),
    removeItem: async (k: string) => {
      mockKv.delete(k);
    },
    getAllKeys: async () => [...mockKv.keys()],
    multiRemove: async (keys: string[]) => {
      keys.forEach((k) => mockKv.delete(k));
    },
  },
}));

jest.mock('@/platform', () => ({
  secureStorage: {
    setItem: async (k: string, v: string) => {
      mockSecure.set(k, v);
    },
    getItem: async (k: string) =>
      mockSecure.has(k) ? mockSecure.get(k)! : null,
    deleteItem: async (k: string) => {
      mockSecure.delete(k);
    },
  },
}));

import { deleteV1Session, deleteV1Sessions } from '../sessionCleanup';
import { writeSessionKey, readSessionKey } from '../sessionKeyStore';
import { WC_V1_SESSION_STORAGE_KEY, WC_V1_SESSION_KEY_SLOT } from '../config';

const KEY_A = 'a1b2c3d4'.repeat(8);
const KEY_B = 'b1c2d3e4'.repeat(8);
const TOPIC_A = 'topic-a';
const TOPIC_B = 'topic-b';
const rowKey = (t: string) => `${WC_V1_SESSION_STORAGE_KEY}:${t}`;

beforeEach(() => {
  mockKv.clear();
  mockSecure.clear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('deleteV1Session — one session, both stores', () => {
  it('removes metadata and key together', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify({ bridge: 'https://b' }));
    await writeSessionKey(TOPIC_A, KEY_A);

    await deleteV1Session(TOPIC_A);

    expect(mockKv.has(rowKey(TOPIC_A))).toBe(false);
    expect(await readSessionKey(TOPIC_A)).toBeNull();
  });

  it('is TOPIC-CONDITIONAL on the key — a retained session keeps its own', async () => {
    // The pair-then-reject shape: A is retained, B is being cleared.
    await writeSessionKey(TOPIC_A, KEY_A);
    mockKv.set(rowKey(TOPIC_A), JSON.stringify({ bridge: 'https://b' }));

    await deleteV1Session(TOPIC_B);

    expect(await readSessionKey(TOPIC_A)).toBe(KEY_A);
    expect(mockKv.has(rowKey(TOPIC_A))).toBe(true);
  });
});

describe('deleteV1Sessions — bulk wipes', () => {
  it('drops the slot unconditionally when asked, ', async () => {
    mockKv.set(rowKey(TOPIC_A), '{}');
    mockKv.set(rowKey(TOPIC_B), '{}');
    // Slot bound to B, but A is the "selected" one — the stranding case.
    await writeSessionKey(TOPIC_B, KEY_B);

    await deleteV1Sessions([rowKey(TOPIC_A), rowKey(TOPIC_B)], {
      dropSlot: true,
    });

    expect(
      [...mockKv.keys()].filter((k) => k.startsWith(WC_V1_SESSION_STORAGE_KEY))
    ).toEqual([]);
    expect(mockSecure.has(WC_V1_SESSION_KEY_SLOT)).toBe(false);
  });

  it('PRESERVES the slot when dropSlot is false (stale-row pruning)', async () => {
    // The surviving session owns the slot; pruning stale rows must not touch it.
    mockKv.set(rowKey(TOPIC_A), '{}');
    await writeSessionKey(TOPIC_B, KEY_B);

    await deleteV1Sessions([rowKey(TOPIC_A)], { dropSlot: false });

    expect(await readSessionKey(TOPIC_B)).toBe(KEY_B);
  });

  it('can drop the slot with no rows at all (extension wipe with empty storage)', async () => {
    await writeSessionKey(TOPIC_A, KEY_A);
    await deleteV1Sessions([], { dropSlot: true });
    expect(mockSecure.has(WC_V1_SESSION_KEY_SLOT)).toBe(false);
  });

  it('is a no-op with no rows and no slot drop', async () => {
    await writeSessionKey(TOPIC_A, KEY_A);
    await deleteV1Sessions([], { dropSlot: false });
    expect(await readSessionKey(TOPIC_A)).toBe(KEY_A);
  });
});
