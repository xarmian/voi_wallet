// Layer-1 tests for the WalletConnect v2 relay message-store retention sweep
// (PLAN-324, TASK-326). Harness follows queueTopicPurge.test.ts: an in-memory
// AsyncStorage mock, no native modules, no WalletConnect Core.
//
// The suite is organised around the plan's contract: liveness (DR-3), bounding
// (DR-4), the access envelope (DR-6), the serialization codec (DR-9),
// prototype-safe reconstruction (DR-10) and the per-key failure table.

const mockStore = new Map<string, string>();
/** Keys whose getItem should reject with a generic (possibly transient) error. */
const mockFailingReads = new Set<string>();
/** Keys whose getItem should reject the way an oversized Android row does. */
const mockUnreadableRows = new Set<string>();
const CURSOR_WINDOW_ERROR =
  'Row too big to fit into CursorWindow requiredPos=0, totalRows=1';
/** Keys whose setItem or removeItem should reject (quota, disk, locked db). */
const mockFailingWrites = new Set<string>();

// Implementations are (re)installed in beforeEach: jest.restoreAllMocks() in
// afterEach calls mockRestore() on every jest.fn(), which strips the
// implementation along with the recorded calls.
const mockImplementations = {
  getItem: async (key: string): Promise<string | null> => {
    if (mockUnreadableRows.has(key)) throw new Error(CURSOR_WINDOW_ERROR);
    if (mockFailingReads.has(key)) throw new Error(`read failed: ${key}`);
    return mockStore.has(key) ? mockStore.get(key)! : null;
  },
  setItem: async (key: string, value: string) => {
    if (mockFailingWrites.has(key)) throw new Error(`write failed: ${key}`);
    mockStore.set(key, value);
  },
  removeItem: async (key: string) => {
    if (mockFailingWrites.has(key)) throw new Error(`delete failed: ${key}`);
    mockStore.delete(key);
  },
  getAllKeys: async () => [...mockStore.keys()],
  multiGet: async (keys: string[]) =>
    keys.map((key) => [key, mockStore.get(key) ?? null]),
  multiRemove: async (keys: string[]) => {
    keys.forEach((key) => mockStore.delete(key));
  },
  clear: async () => {
    mockStore.clear();
  },
};

const mockGetItem = jest.fn(mockImplementations.getItem);
const mockSetItem = jest.fn(mockImplementations.setItem);
const mockRemoveItem = jest.fn(mockImplementations.removeItem);
const mockGetAllKeys = jest.fn(mockImplementations.getAllKeys);
const mockMultiGet = jest.fn(mockImplementations.multiGet);
const mockMultiRemove = jest.fn(mockImplementations.multiRemove);
const mockClear = jest.fn(mockImplementations.clear);

// The factory runs while the module graph is being required — BEFORE the
// `const mock*` initialisers above have executed (Babel hoists imports over
// them). Every reference is therefore deferred into a wrapper.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => mockGetItem(key),
    setItem: (key: string, value: string) => mockSetItem(key, value),
    removeItem: (key: string) => mockRemoveItem(key),
    getAllKeys: () => mockGetAllKeys(),
    multiGet: (keys: string[]) => mockMultiGet(keys),
    multiRemove: (keys: string[]) => mockMultiRemove(keys),
    clear: () => mockClear(),
  },
}));

import { safeJsonParse, safeJsonStringify } from '@walletconnect/safe-json';

import {
  applyByteBudget,
  applyPerTopicCap,
  boundMainRecord,
  collectLiveTopics,
  dropDeadTopics,
  MAX_MESSAGES_PER_TOPIC,
  MAX_MESSAGE_STORE_BYTES,
  parseMessageRecord,
  parseTopicLifetimes,
  sweepWalletConnectMessageStore,
  toPlainRecord,
  utf8ByteLength,
  WC_MESSAGES_STORAGE_KEY,
  WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
  WC_PAIRING_STORAGE_KEY,
  WC_SESSION_STORAGE_KEY,
  WC_SUBSCRIPTION_STORAGE_KEY,
  type MessageRecord,
} from '../messagesRetention';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The key-bearing store. This module must never touch it. */
const KEYCHAIN_KEY = 'wc@2:core:0.3//keychain';
/** A stand-in for the app's own secret storage. Must never be touched either. */
const APP_MNEMONIC_KEY = 'voi_wallet_mnemonic';

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

const messageStores = [
  WC_MESSAGES_STORAGE_KEY,
  WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
];

const record = (
  entries: Record<string, Record<string, string>>
): MessageRecord =>
  new Map(
    Object.entries(entries).map(([topic, bucket]) => [
      topic,
      new Map(Object.entries(bucket)),
    ])
  );

const plain = (value: MessageRecord) => toPlainRecord(value);

/**
 * Serialized size of a record, measured INDEPENDENTLY of the module (Node's
 * Buffer, not the module's own counter) so budget assertions cannot agree with
 * a bug in the accounting they are checking.
 */
const bytesOf = (value: MessageRecord) =>
  Buffer.byteLength(safeJsonStringify(plain(value)), 'utf8');

const storedBytes = (key: string) =>
  Buffer.byteLength(mockStore.get(key) ?? '', 'utf8');

const readStored = (key: string) =>
  safeJsonParse(mockStore.get(key) ?? '') as Record<
    string,
    Record<string, string>
  >;

const seedMetadata = (options?: {
  sessions?: { topic: string; expiry?: number }[];
  pairings?: { topic: string; expiry?: number }[];
  subscriptions?: { topic: string }[];
}) => {
  mockStore.set(
    WC_SESSION_STORAGE_KEY,
    safeJsonStringify(options?.sessions ?? [])
  );
  mockStore.set(
    WC_PAIRING_STORAGE_KEY,
    safeJsonStringify(options?.pairings ?? [])
  );
  mockStore.set(
    WC_SUBSCRIPTION_STORAGE_KEY,
    safeJsonStringify(
      (options?.subscriptions ?? []).map((s, i) => ({
        id: `sub-${i}`,
        topic: s.topic,
        relay: { protocol: 'irn' },
      }))
    )
  );
};

const seedSecrets = () => {
  mockStore.set(KEYCHAIN_KEY, 'KEYCHAIN-DO-NOT-TOUCH');
  mockStore.set(APP_MNEMONIC_KEY, 'MNEMONIC-DO-NOT-TOUCH');
};

const seedMessages = (
  main: Record<string, Record<string, string>>,
  withoutAck?: Record<string, Record<string, string>>
) => {
  mockStore.set(WC_MESSAGES_STORAGE_KEY, safeJsonStringify(main));
  if (withoutAck) {
    mockStore.set(
      WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
      safeJsonStringify(withoutAck)
    );
  }
};

/** Every key handed to setItem/removeItem across the run. */
const writtenKeys = () => [
  ...mockSetItem.mock.calls.map((call) => call[0]),
  ...mockRemoveItem.mock.calls.map((call) => call[0]),
];

const readKeys = () => mockGetItem.mock.calls.map((call) => call[0]);

beforeEach(() => {
  mockStore.clear();
  mockFailingReads.clear();
  mockUnreadableRows.clear();
  mockFailingWrites.clear();
  mockGetItem.mockImplementation(mockImplementations.getItem);
  mockSetItem.mockImplementation(mockImplementations.setItem);
  mockRemoveItem.mockImplementation(mockImplementations.removeItem);
  mockGetAllKeys.mockImplementation(mockImplementations.getAllKeys);
  mockMultiGet.mockImplementation(mockImplementations.multiGet);
  mockMultiRemove.mockImplementation(mockImplementations.multiRemove);
  mockClear.mockImplementation(mockImplementations.clear);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('storage keys (DR-6: derived, not mirrored)', () => {
  it('resolves to the exact keys @walletconnect/core writes', () => {
    expect(WC_MESSAGES_STORAGE_KEY).toBe('wc@2:core:0.3//messages');
    expect(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY).toBe(
      'wc@2:core:0.3//messages_withoutClientAck'
    );
    expect(WC_SESSION_STORAGE_KEY).toBe('wc@2:client:0.3//session');
    expect(WC_PAIRING_STORAGE_KEY).toBe('wc@2:core:0.3//pairing');
    expect(WC_SUBSCRIPTION_STORAGE_KEY).toBe('wc@2:core:0.3//subscription');
  });

  it('derives none of them from the keychain store', () => {
    // Behavioural proof that the keychain is outside the envelope lives in the
    // "access envelope" suite (it is never read, written or enumerated). This
    // is the cheap structural check that no derived key aliases it.
    for (const key of [
      WC_MESSAGES_STORAGE_KEY,
      WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
      WC_SESSION_STORAGE_KEY,
      WC_PAIRING_STORAGE_KEY,
      WC_SUBSCRIPTION_STORAGE_KEY,
    ]) {
      expect(key).not.toBe(KEYCHAIN_KEY);
    }
  });
});

describe('liveness (DR-3)', () => {
  it('treats a topic as live when a session, pairing or subscription has it', () => {
    const live = collectLiveTopics({
      sessions: [{ topic: 'a', expiry: NOW_SEC + 100 }],
      pairings: [{ topic: 'b', expiry: NOW_SEC + 100 }],
      subscriptions: [{ topic: 'c', expiry: null }],
      nowMs: NOW_MS,
    });
    expect([...live].sort()).toEqual(['a', 'b', 'c']);
  });

  it('treats an expired session or pairing as dead at the EXACT boundary', () => {
    const atBoundary = collectLiveTopics({
      sessions: [{ topic: 'session', expiry: NOW_SEC }],
      pairings: [{ topic: 'pairing', expiry: NOW_SEC }],
      subscriptions: [],
      nowMs: NOW_MS,
    });
    expect(atBoundary.size).toBe(0);

    const oneMsBefore = collectLiveTopics({
      sessions: [{ topic: 'session', expiry: NOW_SEC }],
      pairings: [{ topic: 'pairing', expiry: NOW_SEC }],
      subscriptions: [],
      nowMs: NOW_MS - 1,
    });
    expect([...oneMsBefore].sort()).toEqual(['pairing', 'session']);
  });

  it('keeps a subscription topic live by PRESENCE — it carries no expiry', () => {
    const rows = parseTopicLifetimes(
      safeJsonStringify([{ id: '1', topic: 'sub', relay: { protocol: 'irn' } }])
    );
    expect(rows).toEqual([{ topic: 'sub', expiry: null }]);
    const live = collectLiveTopics({
      sessions: [],
      pairings: [],
      subscriptions: rows!,
      nowMs: NOW_MS,
    });
    expect(live.has('sub')).toBe(true);
  });

  it('never reads a MISSING expiry as expired', () => {
    const live = collectLiveTopics({
      sessions: [{ topic: 'no-expiry', expiry: null }],
      pairings: [],
      subscriptions: [],
      nowMs: NOW_MS,
    });
    expect(live.has('no-expiry')).toBe(true);
  });
});

describe('dead-topic drop on both keys', () => {
  it('drops dead topics and keeps live ones', async () => {
    seedSecrets();
    seedMetadata({ sessions: [{ topic: 'live', expiry: NOW_SEC + 3600 }] });
    seedMessages(
      { live: { h1: 'cipher-1' }, dead: { h2: 'cipher-2' } },
      { live: { h3: 'cipher-3' }, dead: { h4: 'cipher-4' } }
    );

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.completed).toBe(true);
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({
      live: { h1: 'cipher-1' },
    });
    expect(readStored(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY)).toEqual({
      live: { h3: 'cipher-3' },
    });
  });

  it('drops a topic whose only session expired', async () => {
    seedMetadata({ sessions: [{ topic: 'gone', expiry: NOW_SEC - 1 }] });
    seedMessages({ gone: { h1: 'c' } }, { gone: { h2: 'c' } });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({});
    expect(readStored(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY)).toEqual({});
  });

  it('keeps a topic that only a live PAIRING vouches for', async () => {
    seedMetadata({ pairings: [{ topic: 'paired', expiry: NOW_SEC + 60 }] });
    seedMessages({ paired: { h: 'c' }, dead: { h2: 'c2' } });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({ paired: { h: 'c' } });
  });

  it('applies the EXACT expiry boundary end to end, for sessions and pairings', async () => {
    // Matching the SDK's isExpired: dead once Date.now() >= expiry * 1000.
    seedMetadata({
      sessions: [
        { topic: 'session-at', expiry: NOW_SEC },
        { topic: 'session-after', expiry: NOW_SEC + 1 },
      ],
      pairings: [
        { topic: 'pairing-at', expiry: NOW_SEC },
        { topic: 'pairing-after', expiry: NOW_SEC + 1 },
      ],
    });
    seedMessages({
      'session-at': { h: 'c' },
      'session-after': { h: 'c' },
      'pairing-at': { h: 'c' },
      'pairing-after': { h: 'c' },
    });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(Object.keys(readStored(WC_MESSAGES_STORAGE_KEY)).sort()).toEqual([
      'pairing-after',
      'session-after',
    ]);

    // One millisecond earlier and all four are still live.
    seedMessages({
      'session-at': { h: 'c' },
      'session-after': { h: 'c' },
      'pairing-at': { h: 'c' },
      'pairing-after': { h: 'c' },
    });
    await sweepWalletConnectMessageStore({ nowMs: NOW_MS - 1 });
    expect(Object.keys(readStored(WC_MESSAGES_STORAGE_KEY))).toHaveLength(4);
  });

  it('treats ABSENT metadata as an empty live set (fresh install), not malformed', async () => {
    // No metadata keys seeded at all.
    seedMessages({ orphan: { h1: 'c' } });

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.completed).toBe(true);
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({});
  });

  it('never caps or budgets the sibling — live no-ack entries survive verbatim', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    const bucket: Record<string, string> = {};
    for (let i = 0; i < MAX_MESSAGES_PER_TOPIC * 4; i++) {
      bucket[`hash-${i}`] = `cipher-${i}`.padEnd(4096, 'x');
    }
    seedMessages({}, { live: bucket });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    const stored = readStored(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY);
    expect(Object.keys(stored.live)).toHaveLength(MAX_MESSAGES_PER_TOPIC * 4);
    expect(stored.live['hash-0']).toBe(bucket['hash-0']);
  });
});

describe('per-topic cap (DR-4)', () => {
  it('caps each topic independently at MAX_MESSAGES_PER_TOPIC', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 120; i++) big[`h${i}`] = `c${i}`;
    const capped = applyPerTopicCap(
      record({ a: big, b: { h0: 'c0' } }),
      MAX_MESSAGES_PER_TOPIC
    );

    expect(capped.get('a')!.size).toBe(MAX_MESSAGES_PER_TOPIC);
    expect(capped.get('b')!.size).toBe(1);
  });

  it('keeps the most recently arrived entries (tail of insertion order)', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 60; i++) big[`h${i}`] = `c${i}`;
    const capped = applyPerTopicCap(record({ a: big }), 3);
    expect([...capped.get('a')!.keys()]).toEqual(['h57', 'h58', 'h59']);
  });

  it('applies through the full sweep', async () => {
    seedMetadata({ subscriptions: [{ topic: 'busy' }] });
    const bucket: Record<string, string> = {};
    for (let i = 0; i < 200; i++) bucket[`h${i}`] = `c${i}`;
    seedMessages({ busy: bucket });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(Object.keys(readStored(WC_MESSAGES_STORAGE_KEY).busy)).toHaveLength(
      MAX_MESSAGES_PER_TOPIC
    );
  });
});

describe('byte accounting is exact', () => {
  // Measured against Node's Buffer, which knows nothing about this module.
  const strings: [string, string][] = [
    ['ascii', 'abc'],
    ['empty', ''],
    ['2-byte', 'çéñ'],
    ['3-byte', '€中'],
    ['4-byte astral', '🎉🧨'],
    ['mixed', 'naïve — 🎉 abc'],
    ['json escapes', JSON.stringify('a"b\\c\nd\te')],
    ['control chars', JSON.stringify('\u0000\u001f\b\f')],
    ['serialized record', safeJsonStringify({ '🎉': { '🔑': 'çé' } })],
  ];

  it.each(strings)(
    'utf8ByteLength agrees with Node Buffer (%s)',
    (_name, value) => {
      expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, 'utf8'));
    }
  );

  it('counts UTF-8 BYTES, not JS characters', () => {
    expect('é'.length).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect('🎉'.length).toBe(2);
    expect(utf8ByteLength('🎉')).toBe(4);
  });
});

describe('byte budget (DR-4)', () => {
  const filler = (n: number, size: number, prefix = 'h') => {
    const bucket: Record<string, string> = {};
    for (let i = 0; i < n; i++) bucket[`${prefix}${i}`] = 'x'.repeat(size);
    return bucket;
  };

  /**
   * A single-topic record whose SERIALIZED form is exactly `target` bytes, with
   * multibyte text in both the topic and the hash so a character-counting bug
   * cannot land on the same number.
   */
  const recordOfExactBytes = (target: number): MessageRecord => {
    const topic = 'tópic-🎉';
    const hash = 'hàsh-🔑';
    const build = (pad: number) =>
      record({ [topic]: { [hash]: 'x'.repeat(pad) } });
    const overhead = bytesOf(build(0));
    const pad = target - overhead;
    if (pad < 0) throw new Error('target smaller than the record overhead');
    const built = build(pad);
    if (bytesOf(built) !== target) throw new Error('size model broke');
    return built;
  };

  it('is a no-op at EXACTLY the budget and evicts one byte over', () => {
    const value = record({ t: filler(4, 100) });
    const exact = bytesOf(value);

    expect(applyByteBudget(value, exact)).toBe(value);

    const trimmed = applyByteBudget(value, exact - 1);
    expect(bytesOf(trimmed)).toBeLessThanOrEqual(exact - 1);
    expect(trimmed.get('t')!.size).toBe(3);
  });

  it('accounts for multibyte values at the boundary', () => {
    // 'é' is one JS char but two stored bytes; a char-counting budget would
    // wrongly conclude this record already fits.
    const value = record({ t: { h0: 'é'.repeat(50), h1: 'é'.repeat(50) } });
    const bytes = bytesOf(value);
    expect(bytes).toBeGreaterThan(JSON.stringify(plain(value)).length);

    expect(applyByteBudget(value, bytes)).toBe(value);
    expect(bytesOf(applyByteBudget(value, bytes - 1))).toBeLessThan(bytes);
  });

  it('evicts a single oversized message and REMOVES the emptied bucket', () => {
    const value = record({ t: { huge: 'x'.repeat(1000) } });
    const trimmed = applyByteBudget(value, 100);
    expect(trimmed.size).toBe(0);
    expect(bytesOf(trimmed)).toBe(2);
  });

  it('evicts the HOSTILE topic first and preserves the well-behaved one', () => {
    // The honest topic is inserted FIRST and is not the largest entry-wise, so
    // an implementation that evicts in insertion order — or that picks the
    // first topic — fails here.
    const wellBehaved = { 'good-0': 'a'.repeat(64), 'good-1': 'b'.repeat(96) };
    const hostile: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      hostile[`hostile-${i}`] = 'x'.repeat(1024 * (i + 1)); // deliberately uneven
    }
    const value = record({ honest: wellBehaved, attacker: hostile });

    const budget = bytesOf(record({ honest: wellBehaved })) + 64;
    const trimmed = applyByteBudget(value, budget);

    // The attacking topic is gone entirely (emptied bucket removed) ...
    expect([...trimmed.keys()]).toEqual(['honest']);
    // ... and the well-behaved topic kept every entry, in order.
    expect([...trimmed.get('honest')!.entries()]).toEqual(
      Object.entries(wellBehaved)
    );
    expect(bytesOf(trimmed)).toBeLessThanOrEqual(budget);
  });

  it('evicts the LARGEST entry of the largest topic first', () => {
    const value = record({
      t: {
        small: 'a'.repeat(10),
        huge: 'b'.repeat(4000),
        mid: 'c'.repeat(100),
      },
    });
    // Just enough pressure to force exactly one eviction.
    const trimmed = applyByteBudget(value, bytesOf(value) - 1);
    expect([...trimmed.get('t')!.keys()]).toEqual(['small', 'mid']);
  });

  it('stays exact at every budget from full size down to empty', () => {
    // The eviction loop tracks the serialized size by delta rather than
    // re-measuring; walking every budget catches an off-by-one in that
    // arithmetic in both directions (over budget, or over-evicting).
    const value = record({
      a: { a1: 'x'.repeat(7), a2: 'yy', a3: 'zzz' },
      'b🎉': { b1: 'x'.repeat(11), b2: 'q' },
      c: { c1: 'w'.repeat(3) },
    });
    const full = bytesOf(value);
    expect(applyByteBudget(value, full)).toBe(value);

    let previousEntries = Infinity;
    for (let budget = full; budget >= 2; budget--) {
      const trimmed = applyByteBudget(value, budget);
      expect(bytesOf(trimmed)).toBeLessThanOrEqual(budget);
      const entries = [...trimmed.values()].reduce((n, b) => n + b.size, 0);
      expect(entries).toBeLessThanOrEqual(previousEntries);
      previousEntries = entries;
    }
    expect(previousEntries).toBe(0);
  });

  it('handles thousands of one-entry topics without blowing up', () => {
    // The pathological shape for the eviction loop: every step removes a whole
    // topic, so the model list is rescanned as many times as there are topics.
    const many: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 2000; i++) many[`topic-${i}`] = { h: 'x'.repeat(200) };
    const value = record(many);

    const trimmed = applyByteBudget(value, 32 * 1024);

    expect(bytesOf(trimmed)).toBeLessThanOrEqual(32 * 1024);
    expect(trimmed.size).toBeGreaterThan(0);
  });

  it('removes an empty bucket rather than paying for its key text', () => {
    const value = record({ empty: {}, real: { h: 'c' } });
    const trimmed = applyByteBudget(value, MAX_MESSAGE_STORE_BYTES);
    expect([...trimmed.keys()]).toEqual(['real']);
    expect(bytesOf(trimmed)).toBeLessThanOrEqual(MAX_MESSAGE_STORE_BYTES);

    // Even under a budget that only "{}" can satisfy.
    expect(applyByteBudget(record({ empty: {} }), 2).size).toBe(0);
  });

  it('always terminates under budget, however small', () => {
    const value = record({ a: filler(30, 500, 'a'), b: filler(30, 500, 'b') });
    for (const budget of [0, 1, 2, 3, 500, 5000]) {
      const trimmed = applyByteBudget(value, budget);
      expect(bytesOf(trimmed)).toBeLessThanOrEqual(Math.max(budget, 2));
    }
  });

  it('leaves a record of EXACTLY the budget alone through the full sweep', async () => {
    const value = recordOfExactBytes(MAX_MESSAGE_STORE_BYTES);
    seedMetadata({
      subscriptions: [...value.keys()].map((topic) => ({ topic })),
    });
    seedMessages(plain(value));
    expect(storedBytes(WC_MESSAGES_STORAGE_KEY)).toBe(MAX_MESSAGE_STORE_BYTES);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.main).toBe('unchanged');
    expect(mockSetItem).not.toHaveBeenCalled();
    expect(storedBytes(WC_MESSAGES_STORAGE_KEY)).toBe(MAX_MESSAGE_STORE_BYTES);
  });

  it('trims a record ONE BYTE over the budget through the full sweep', async () => {
    const value = recordOfExactBytes(MAX_MESSAGE_STORE_BYTES + 1);
    seedMetadata({
      subscriptions: [...value.keys()].map((topic) => ({ topic })),
    });
    seedMessages(plain(value));
    expect(storedBytes(WC_MESSAGES_STORAGE_KEY)).toBe(
      MAX_MESSAGE_STORE_BYTES + 1
    );

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.main).toBe('rewritten');
    // The record held a single entry, so the only way under budget is to empty
    // the topic — the budget wins over one oversized message.
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({});
    expect(summary.mainBytesAfter).toBe(2);
    expect(storedBytes(WC_MESSAGES_STORAGE_KEY)).toBe(2);
  });

  it('bounds a multi-topic store through the full sweep and reports the size', async () => {
    seedMetadata({
      subscriptions: [{ topic: 'á' }, { topic: 'b🎉' }, { topic: 'c' }],
    });
    const main: Record<string, Record<string, string>> = {};
    for (const topic of ['á', 'b🎉', 'c']) {
      main[topic] = filler(MAX_MESSAGES_PER_TOPIC, 8192, `${topic}-`);
    }
    seedMessages(main);
    expect(storedBytes(WC_MESSAGES_STORAGE_KEY)).toBeGreaterThan(
      MAX_MESSAGE_STORE_BYTES
    );

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.main).toBe('rewritten');
    const after = storedBytes(WC_MESSAGES_STORAGE_KEY);
    expect(after).toBeLessThanOrEqual(MAX_MESSAGE_STORE_BYTES);
    // Close to the budget, not scorched earth.
    expect(after).toBeGreaterThan(MAX_MESSAGE_STORE_BYTES - 16 * 1024);
    expect(summary.mainBytesAfter).toBe(after);
  });
});

describe('safe-json codec fidelity (DR-9)', () => {
  it('round-trips surviving entries byte-identically', async () => {
    const tricky = {
      plain: 'hello',
      unicode: 'naïve — 🎉 \u0000 ',
      jsonish: '{"looks":"like json","n":123}',
      quoted: 'he said "hi" \\ then left\n',
      // Shaped like the real payload: a base64 relay ciphertext.
      base64: 'AGKQ0Zx1c2VyL3RleHQ+Pz09',
    };
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { ...tricky }, dead: { h: 'x' } });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    const raw = mockStore.get(WC_MESSAGES_STORAGE_KEY)!;
    const parsed = safeJsonParse(raw) as Record<string, Record<string, string>>;
    expect(Object.keys(parsed)).toEqual(['live']);
    for (const [hash, value] of Object.entries(tricky)) {
      expect(parsed.live[hash]).toBe(value);
    }
  });

  // The next two cases pin down where the SDK's OWN codec is lossy. Neither can
  // occur for a real relay message (ciphertexts are base64, so they always
  // contain non-digits), but both are worth freezing: the sweep must behave the
  // way the SDK does, and must fail closed rather than invent a value.

  it('leaves a record the codec cannot re-read untouched (fails closed)', async () => {
    // safeJsonParse rewrites any 17+-digit integer to a "...n" STRING before
    // JSON.parse — including digits that live inside a string literal, which
    // corrupts the document and makes the parse fail. The SDK cannot read such
    // a record either; the sweep must not "repair" it by writing a guess.
    //
    // This also DISCRIMINATES the reader: plain JSON.parse handles this
    // document fine, so a sweep built on JSON.parse would rewrite the key here
    // instead of leaving it alone.
    const poison = safeJsonStringify({
      live: { h: '{"n":12345678901234567890}' },
    });
    expect(typeof safeJsonParse(poison)).toBe('string');
    expect(() => JSON.parse(poison)).not.toThrow();

    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    mockStore.set(WC_MESSAGES_STORAGE_KEY, poison);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.main).toBe('malformed-skipped');
    expect(mockStore.get(WC_MESSAGES_STORAGE_KEY)).toBe(poison);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('repairs the shape the SDK leaves behind after it mis-restores a bad record', async () => {
    // MessageTracker.init feeds whatever it read into objToMap, so a record the
    // codec returned as a STRING becomes an index->char map that its next
    // persist writes back. That flat object is not an object-of-objects, so the
    // sweep collapses it — a malformed record is skipped once, not forever.
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    mockStore.set(
      WC_MESSAGES_STORAGE_KEY,
      safeJsonStringify({ '0': '{', '1': '"', '2': 'a' })
    );

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.main).toBe('rewritten');
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({});
  });

  it('drops a value the codec revives as a BigInt instead of inventing bytes', async () => {
    // safeJsonParse's reviver turns a value matching /^\d+n$/ — and an
    // UNQUOTED 17+-digit number — into a bigint, and the revival is not
    // invertible: "000n" and "0n" both become 0n, and a bare number is
    // indistinguishable from a quoted string afterwards. Reconstructing would
    // therefore write bytes the store never held, so such entries are dropped
    // with the other non-strings. Unreachable for real data: relay ciphertexts
    // are base64 and never all digits.
    expect(safeJsonParse('{"a":"000n","b":"0n"}')).toEqual({ a: 0n, b: 0n });

    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { bigintish: '000n', good: 'c' } });
    mockStore.set(
      WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
      '{"live":{"bare":12345678901234567890,"good":"c"}}'
    );

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({
      live: { good: 'c' },
    });
    expect(readStored(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY)).toEqual({
      live: { good: 'c' },
    });
  });

  it('writes through safeJsonStringify, not a bespoke encoder', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { h: 'é🎉' }, dead: { h: 'x' } });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(mockStore.get(WC_MESSAGES_STORAGE_KEY)).toBe(
      safeJsonStringify({ live: { h: 'é🎉' } })
    );
  });

  it('agrees with the nested keyvaluestorage RN adapter (best effort)', async () => {
    // The adapter the SDK actually writes through. It is a NESTED install (it
    // peer-depends on AsyncStorage v1), reachable only by file path — its
    // package `exports` map blocks the subpath specifier — so resolution is not
    // guaranteed and this case skips rather than fails if it moves.
    const path = require('path');
    const nestedRoot = path.join(
      process.cwd(),
      'node_modules/@walletconnect/core/node_modules'
    );
    const adapterPath = path.join(
      nestedRoot,
      '@walletconnect/keyvaluestorage/dist/react-native/index.js'
    );
    // The adapter binds its OWN nested AsyncStorage v1, not the root module the
    // suite mocks, so that copy has to be intercepted separately.
    const nestedAsyncStorage = path.join(
      nestedRoot,
      '@react-native-async-storage/async-storage'
    );

    // Skip ONLY when the nested install is genuinely absent. If the file IS
    // there, failing to drive it is a real failure — otherwise this case could
    // quietly stop testing anything and still report green.
    if (!require('fs').existsSync(adapterPath)) {
      console.info('keyvaluestorage RN adapter not installed — skipping');
      return;
    }

    const written = new Map<string, string>();
    jest.doMock(nestedAsyncStorage, () => ({
      __esModule: true,
      default: {
        setItem: async (key: string, value: string) => {
          written.set(key, value);
        },
        getItem: async (key: string) => written.get(key) ?? null,
      },
    }));
    const mod = require(adapterPath);
    const KeyValueStorage: new () => {
      setItem: (key: string, value: unknown) => Promise<void>;
    } = mod.KeyValueStorage ?? mod.default;
    expect(typeof KeyValueStorage).toBe('function');

    const value = { topic: { hash: 'ciphertext with é and 🎉' } };
    await new KeyValueStorage().setItem('probe', value);

    // The adapter's own serializer must be byte-identical to the direct
    // @walletconnect/safe-json dependency this module writes through.
    expect(written.get('probe')).toBe(safeJsonStringify(value));
  });
});

describe('failure table (per-key, fail closed)', () => {
  it.each([
    ['session', WC_SESSION_STORAGE_KEY],
    ['pairing', WC_PAIRING_STORAGE_KEY],
    ['subscription', WC_SUBSCRIPTION_STORAGE_KEY],
  ])('GLOBAL no-op when the %s metadata read rejects', async (_name, key) => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ dead: { h: 'c' } }, { dead: { h: 'c' } });
    mockFailingReads.add(key);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.completed).toBe(false);
    expect(summary.skippedReason).toBe('metadata-unreadable');
    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });

  it.each([
    ['session', WC_SESSION_STORAGE_KEY],
    ['pairing', WC_PAIRING_STORAGE_KEY],
    ['subscription', WC_SUBSCRIPTION_STORAGE_KEY],
  ])('GLOBAL no-op when the %s metadata is malformed', async (_name, key) => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ dead: { h: 'c' } });
    mockStore.set(key, 'not json at all {{{');

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.completed).toBe(false);
    expect(mockSetItem).not.toHaveBeenCalled();
    expect(mockRemoveItem).not.toHaveBeenCalled();
  });

  it('GLOBAL no-op when metadata is the WRONG SHAPE (object, not array)', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ dead: { h: 'c' } });
    mockStore.set(WC_SESSION_STORAGE_KEY, safeJsonStringify({ topic: 'x' }));

    expect(
      (await sweepWalletConnectMessageStore({ nowMs: NOW_MS })).completed
    ).toBe(false);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('SKIPS an unusable metadata ROW instead of switching retention off', async () => {
    // Pairing topics come straight out of a peer-supplied URI, so a hostile
    // dApp can plant `wc:@2?…` (empty topic) or `wc:42n@2?…` (revived as a
    // BigInt by the codec). Failing the whole blob over one such row would let
    // an attacker disable retention permanently, at will.
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { h: 'c' }, dead: { h2: 'c2' } });
    mockStore.set(
      WC_PAIRING_STORAGE_KEY,
      '[{"topic":"paired","expiry":99999999999},{"topic":""},{"topic":"42n"},{"expiry":1},"junk",null]'
    );

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.completed).toBe(true);
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({ live: { h: 'c' } });
  });

  it('survives a metadata blob whose TOPIC TEXT poisons the safe-json codec', async () => {
    // safe-json rewrites a 17+-digit run followed by `,`/`}`/`]` anywhere in the
    // document, string contents included — so a peer-supplied pairing topic can
    // make safeJsonParse fail on the whole blob. Metadata is read with plain
    // JSON.parse precisely so that cannot switch retention off.
    const poisonTopic = '12345678901234567}';
    const blob =
      `[{"topic":${JSON.stringify(poisonTopic)},"expiry":99999999999},` +
      `{"topic":"honest","expiry":99999999999}]`;
    expect(typeof safeJsonParse(blob)).toBe('string');

    seedMetadata();
    mockStore.set(WC_PAIRING_STORAGE_KEY, blob);
    seedMessages({ honest: { h: 'c' }, dead: { h2: 'c2' } });

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.completed).toBe(true);
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({ honest: { h: 'c' } });
  });

  it('keeps a topic whose text the codec would revive as a BigInt', async () => {
    // "42n" is a string key in the message record but safeJsonParse would turn
    // the metadata topic into 42n, which matches nothing — and the live topic
    // would be purged. JSON.parse spells it the same way both stores do.
    seedMetadata();
    mockStore.set(
      WC_SESSION_STORAGE_KEY,
      '[{"topic":"42n","expiry":99999999999}]'
    );
    seedMessages({ '42n': { h: 'c' }, dead: { h2: 'c2' } });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({ '42n': { h: 'c' } });
  });

  it('still keeps the good rows of a partly-unusable metadata blob live', async () => {
    seedMetadata();
    mockStore.set(
      WC_SESSION_STORAGE_KEY,
      '[{"topic":""},{"topic":"honest","expiry":99999999999}]'
    );
    seedMessages({ honest: { h: 'c' }, dead: { h2: 'c2' } });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({ honest: { h: 'c' } });
  });

  it.each([
    ['cursor read symptom', "Couldn't read row 0, col 0 from CursorWindow"],
    ['window allocation', 'Cursor window allocation of 2048 kb failed'],
    ['generic io', 'database is locked'],
    ['permission', 'Access denied'],
  ])(
    'does NOT delete on a rejection that only CO-OCCURS with an oversized row (%s)',
    async (_name, message) => {
      // These also fire under memory pressure or a cursor misuse, so treating
      // them as fatal would let a transient blip destroy de-duplication state.
      seedMetadata({ subscriptions: [{ topic: 'live' }] });
      seedMessages({ live: { h: 'c' } });
      mockGetItem.mockImplementation(async (key: string) => {
        if (key === WC_MESSAGES_STORAGE_KEY) throw new Error(message);
        return mockImplementations.getItem(key);
      });

      const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

      expect(summary.main).toBe('unreadable');
      expect(mockRemoveItem).not.toHaveBeenCalled();
    }
  );

  it('a GENERIC main read failure deletes nothing — it may be transient', async () => {
    // The delete is the only destructive action in the module. An unclassified
    // rejection leaves the record alone; the next cold start tries again.
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { h: 'c' }, dead: { h2: 'c2' } });
    mockFailingReads.add(WC_MESSAGES_STORAGE_KEY);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.main).toBe('unreadable');
    expect(mockRemoveItem).not.toHaveBeenCalled();
    // Not worth a confirmation read either — nothing destructive follows.
    expect(
      readKeys().filter((key) => key === WC_MESSAGES_STORAGE_KEY)
    ).toHaveLength(1);
  });

  it('an oversized-row error that clears on the confirmation read is swept normally', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { h: 'c' }, dead: { h2: 'c2' } });
    let attempts = 0;
    mockGetItem.mockImplementation(async (key: string) => {
      if (key === WC_MESSAGES_STORAGE_KEY && attempts++ === 0) {
        throw new Error(CURSOR_WINDOW_ERROR);
      }
      return mockImplementations.getItem(key);
    });

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(summary.main).toBe('rewritten');
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({ live: { h: 'c' } });
  });

  it('an UNREADABLE main row + valid metadata => removeItem the MAIN key only', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({}, { live: { h: 'c' }, dead: { h2: 'c2' } });
    mockUnreadableRows.add(WC_MESSAGES_STORAGE_KEY);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    // Rejected on both the first read and the confirmation read.
    expect(
      readKeys().filter((key) => key === WC_MESSAGES_STORAGE_KEY)
    ).toHaveLength(2);
    expect(summary.main).toBe('removed');
    expect(mockRemoveItem.mock.calls.map((c) => c[0])).toEqual([
      WC_MESSAGES_STORAGE_KEY,
    ]);
    // The sibling is processed independently in the same pass.
    expect(readStored(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY)).toEqual({
      live: { h: 'c' },
    });
  });

  it('a failing recovery DELETE is reported and does not stop the sibling', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({}, { live: { h: 'c' }, dead: { h2: 'c2' } });
    mockUnreadableRows.add(WC_MESSAGES_STORAGE_KEY);
    mockFailingWrites.add(WC_MESSAGES_STORAGE_KEY);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(mockRemoveItem).toHaveBeenCalledTimes(1);
    // A failed write means the store is NOT bounded — never report success.
    expect(summary.completed).toBe(false);
    expect(summary.main).toBe('write-failed');
    expect(summary.withoutAck).toBe('rewritten');
    expect(readStored(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY)).toEqual({
      live: { h: 'c' },
    });
  });

  it('sibling write failure does not stop or corrupt the main write', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages(
      { live: { h: 'c' }, dead: { h2: 'c2' } },
      { live: { h3: 'c3' }, dead: { h4: 'c4' } }
    );
    const siblingBefore = mockStore.get(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY);
    mockFailingWrites.add(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.completed).toBe(false);
    expect(summary.withoutAck).toBe('write-failed');
    expect(summary.main).toBe('rewritten');
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({ live: { h: 'c' } });
    expect(mockStore.get(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY)).toBe(
      siblingBefore
    );
  });

  it('unreadable main row AND a metadata read fails => NO removeItem', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({}, { live: { h: 'c' } });
    mockUnreadableRows.add(WC_MESSAGES_STORAGE_KEY);
    mockFailingReads.add(WC_PAIRING_STORAGE_KEY);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.completed).toBe(false);
    expect(mockRemoveItem).not.toHaveBeenCalled();
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('malformed MAIN => no write to main, sibling still processed', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    mockStore.set(WC_MESSAGES_STORAGE_KEY, '<<< not json >>>');
    mockStore.set(
      WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
      safeJsonStringify({ live: { h: 'c' }, dead: { h2: 'c2' } })
    );

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.main).toBe('malformed-skipped');
    expect(summary.withoutAck).toBe('rewritten');
    expect(mockStore.get(WC_MESSAGES_STORAGE_KEY)).toBe('<<< not json >>>');
    expect(writtenKeys()).toEqual([WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY]);
  });

  it('sibling read rejects => sibling untouched, main still processed', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { h: 'c' }, dead: { h2: 'c2' } });
    mockStore.set(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY, 'unreadable-blob');
    mockFailingReads.add(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.withoutAck).toBe('unreadable');
    expect(mockStore.get(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY)).toBe(
      'unreadable-blob'
    );
    expect(writtenKeys()).toEqual([WC_MESSAGES_STORAGE_KEY]);
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({ live: { h: 'c' } });
  });

  it('malformed SIBLING => sibling untouched, main still processed', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { h: 'c' }, dead: { h2: 'c2' } });
    mockStore.set(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY, '[1,2,3]');

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.withoutAck).toBe('malformed-skipped');
    expect(mockStore.get(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY)).toBe('[1,2,3]');
    expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({ live: { h: 'c' } });
  });

  it('main write failure does not stop the sibling write', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages(
      { live: { h: 'c' }, dead: { h2: 'c2' } },
      { live: { h3: 'c3' }, dead: { h4: 'c4' } }
    );
    mockFailingWrites.add(WC_MESSAGES_STORAGE_KEY);

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.main).toBe('write-failed');
    expect(summary.withoutAck).toBe('rewritten');
    expect(readStored(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY)).toEqual({
      live: { h3: 'c3' },
    });
  });

  it('absent message keys are a clean no-op', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary).toMatchObject({
      completed: true,
      main: 'absent',
      withoutAck: 'absent',
    });
    expect(writtenKeys()).toEqual([]);
  });

  it('skips the write when the record is already bounded and clean', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { h: 'c' } }, { live: { h2: 'c2' } });

    const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(summary.main).toBe('unchanged');
    expect(summary.withoutAck).toBe('unchanged');
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('never rejects, even when every read fails', async () => {
    [
      WC_SESSION_STORAGE_KEY,
      WC_PAIRING_STORAGE_KEY,
      WC_SUBSCRIPTION_STORAGE_KEY,
      WC_MESSAGES_STORAGE_KEY,
      WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
    ].forEach((key) => mockFailingReads.add(key));

    await expect(
      sweepWalletConnectMessageStore({ nowMs: NOW_MS })
    ).resolves.toMatchObject({ completed: false });
  });
});

describe('prototype-safe reconstruction (DR-10)', () => {
  const RESERVED = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty'];

  afterEach(() => {
    // Sentinel: nothing above may have reached Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it.each(RESERVED)(
    'drops a reserved TOPIC name (%s) without failing the record',
    async (reserved) => {
      seedMetadata({
        subscriptions: [{ topic: 'live' }, { topic: reserved }],
      });
      const hostile = `{"${reserved}":{"h":"{\\"polluted\\":true}"},"live":{"h2":"c2"}}`;
      mockStore.set(WC_MESSAGES_STORAGE_KEY, hostile);

      const summary = await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

      expect(summary.main).toBe('rewritten');
      const stored = readStored(WC_MESSAGES_STORAGE_KEY);
      expect(Object.keys(stored)).toEqual(['live']);
    }
  );

  it.each(RESERVED)(
    'drops a reserved HASH name (%s) without failing the topic',
    async (reserved) => {
      seedMetadata({ subscriptions: [{ topic: 'live' }] });
      mockStore.set(
        WC_MESSAGES_STORAGE_KEY,
        `{"live":{"${reserved}":{"polluted":true},"good":"c"}}`
      );

      await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

      expect(readStored(WC_MESSAGES_STORAGE_KEY)).toEqual({
        live: { good: 'c' },
      });
    }
  );

  it('does not pollute the prototype from a crafted __proto__ payload', () => {
    const parsed = parseMessageRecord(
      '{"__proto__":{"polluted":"yes"},"t":{"__proto__":"yes","h":"c"}}'
    );
    expect(parsed).not.toBeNull();
    expect([...parsed!.keys()]).toEqual(['t']);
    expect([...parsed!.get('t')!.keys()]).toEqual(['h']);
    expect(toPlainRecord(parsed!)).toEqual({ t: { h: 'c' } });
  });

  it('drops non-string message values and non-object buckets individually', () => {
    const parsed = parseMessageRecord(
      '{"a":{"h":"ok","bad":42,"worse":{"nested":1}},"b":"not-an-object","c":[1],"d":{}}'
    );
    expect(toPlainRecord(parsed!)).toEqual({ a: { h: 'ok' } });
  });

  it('reports a wrong-shaped record as malformed rather than empty', () => {
    expect(parseMessageRecord('[]')).toBeNull();
    expect(parseMessageRecord('"a string"')).toBeNull();
    expect(parseMessageRecord('null')).toBeNull();
    expect(parseMessageRecord('nonsense')).toBeNull();
    expect(parseMessageRecord('7')).toBeNull();
  });

  it('does not turn a topic named like a storage key into a storage key', async () => {
    const hostileTopics = [
      WC_SESSION_STORAGE_KEY,
      WC_PAIRING_STORAGE_KEY,
      WC_SUBSCRIPTION_STORAGE_KEY,
      KEYCHAIN_KEY,
      APP_MNEMONIC_KEY,
    ];
    seedSecrets();
    seedMetadata({ subscriptions: hostileTopics.map((topic) => ({ topic })) });
    const main: Record<string, Record<string, string>> = {};
    hostileTopics.forEach((topic, i) => {
      main[topic] = { [`h${i}`]: `c${i}` };
    });
    main.dead = { h: 'c' };
    seedMessages(main);

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    // Topics stayed nested DATA ...
    expect(Object.keys(readStored(WC_MESSAGES_STORAGE_KEY)).sort()).toEqual(
      [...hostileTopics].sort()
    );
    // ... and no write ever escaped the two-key allowlist.
    expect(writtenKeys()).toEqual([WC_MESSAGES_STORAGE_KEY]);
    expect(mockStore.get(KEYCHAIN_KEY)).toBe('KEYCHAIN-DO-NOT-TOUCH');
    expect(mockStore.get(APP_MNEMONIC_KEY)).toBe('MNEMONIC-DO-NOT-TOUCH');
  });
});

describe('access envelope (DR-6)', () => {
  const scenarios: [string, () => void][] = [
    [
      'happy path',
      () => {
        seedMetadata({ sessions: [{ topic: 'live', expiry: NOW_SEC + 60 }] });
        seedMessages(
          { live: { h: 'c' }, dead: { h2: 'c2' } },
          { dead: { h3: 'c3' } }
        );
      },
    ],
    [
      'metadata failure',
      () => {
        seedMetadata();
        seedMessages({ dead: { h: 'c' } });
        mockFailingReads.add(WC_SESSION_STORAGE_KEY);
      },
    ],
    [
      'main row unreadable (recovery delete)',
      () => {
        seedMetadata({ subscriptions: [{ topic: 'live' }] });
        seedMessages({}, { live: { h: 'c' } });
        mockUnreadableRows.add(WC_MESSAGES_STORAGE_KEY);
      },
    ],
    [
      'malformed everything',
      () => {
        seedMetadata({ subscriptions: [{ topic: 'live' }] });
        mockStore.set(WC_MESSAGES_STORAGE_KEY, 'garbage');
        mockStore.set(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY, 'garbage');
      },
    ],
    [
      'over budget',
      () => {
        seedMetadata({ subscriptions: [{ topic: 'live' }] });
        const bucket: Record<string, string> = {};
        for (let i = 0; i < 40; i++) bucket[`h${i}`] = 'x'.repeat(20000);
        seedMessages({ live: bucket });
      },
    ],
  ];

  it.each(scenarios)(
    'reads only the five allowlisted keys and writes only the two message keys (%s)',
    async (_name, seed) => {
      seedSecrets();
      seed();
      const keychainBefore = mockStore.get(KEYCHAIN_KEY);
      const mnemonicBefore = mockStore.get(APP_MNEMONIC_KEY);

      await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

      const allowedReads = [
        WC_SESSION_STORAGE_KEY,
        WC_PAIRING_STORAGE_KEY,
        WC_SUBSCRIPTION_STORAGE_KEY,
        WC_MESSAGES_STORAGE_KEY,
        WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
      ];
      // EVERY call, not the deduplicated set — an extra read of a
      // non-allowlisted key must fail here even if that key also appears once
      // legitimately elsewhere.
      for (const key of readKeys()) {
        expect(allowedReads).toContain(key);
      }
      expect([...new Set(readKeys())].sort()).toEqual([...allowedReads].sort());
      // Five keys, plus at most the one confirmation re-read of the main key.
      expect(readKeys().length).toBeGreaterThanOrEqual(5);
      expect(readKeys().length).toBeLessThanOrEqual(6);
      for (const key of writtenKeys()) {
        expect(messageStores).toContain(key);
      }

      // The store is never enumerated, and never batch-read or batch-deleted.
      expect(mockGetAllKeys).not.toHaveBeenCalled();
      expect(mockMultiGet).not.toHaveBeenCalled();
      expect(mockMultiRemove).not.toHaveBeenCalled();
      expect(mockClear).not.toHaveBeenCalled();

      // Key material is bit-for-bit untouched.
      expect(mockStore.get(KEYCHAIN_KEY)).toBe(keychainBefore);
      expect(mockStore.get(APP_MNEMONIC_KEY)).toBe(mnemonicBefore);
    }
  );

  it('reads each key with an individual getItem, never multiGet', async () => {
    seedMetadata({ subscriptions: [{ topic: 'live' }] });
    seedMessages({ live: { h: 'c' } });

    await sweepWalletConnectMessageStore({ nowMs: NOW_MS });

    expect(mockGetItem).toHaveBeenCalledTimes(5);
    expect(mockMultiGet).not.toHaveBeenCalled();
  });
});

describe('boundMainRecord composition', () => {
  it('applies dead-drop, then cap, then budget', () => {
    const live = new Set(['keep']);
    const bucket: Record<string, string> = {};
    for (let i = 0; i < 200; i++) bucket[`h${i}`] = 'x'.repeat(64);
    const bounded = boundMainRecord(
      record({ keep: bucket, drop: { h: 'c' } }),
      live
    );

    expect([...bounded.keys()]).toEqual(['keep']);
    expect(bounded.get('keep')!.size).toBe(MAX_MESSAGES_PER_TOPIC);
    expect(bytesOf(bounded)).toBeLessThanOrEqual(MAX_MESSAGE_STORE_BYTES);
  });

  it('dropDeadTopics keeps bucket identity for surviving topics', () => {
    const value = record({ a: { h: 'c' }, b: { h: 'c' } });
    const kept = dropDeadTopics(value, new Set(['a']));
    expect(kept.get('a')).toBe(value.get('a'));
    expect(kept.has('b')).toBe(false);
  });
});
