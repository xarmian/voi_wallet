// Integration tests for v1 session persistence across the AsyncStorage /
// SecureStore split (PLAN-260, TASK-258).
//
// Covers the four original acceptance criteria plus the failure modes the
// Codex consensus loop surfaced:
//   - no key material left in AsyncStorage after migration (AC1),
//   - an EXISTING session still reconnects after upgrade (AC2) — migration, not
//     just fresh pairings,
//   - no key reaches logs on any path (AC3),
//   - the migrate-then-rewrite sequence (AC4),
//   - fault injection PER STORAGE OPERATION, not just crash-ordering (DR-5a),
//   - "A stored -> pair/reject B -> A still restores" (DR-3a),
//   - keyless metadata + empty slot restores nothing, quietly (DR-4/DR-15).

const mockSecure = new Map<string, string>();
const mockKv = new Map<string, string>();
let mockSecureGetThrows: Error | null = null;
let mockAsyncSetThrows: Error | null = null;
let mockSecureSetThrows: Error | null = null;

jest.mock('@/platform', () => ({
  secureStorage: {
    setItem: async (k: string, v: string) => {
      if (mockSecureSetThrows) throw mockSecureSetThrows;
      mockSecure.set(k, v);
    },
    getItem: async (k: string) => {
      if (mockSecureGetThrows) throw mockSecureGetThrows;
      return mockSecure.has(k) ? mockSecure.get(k)! : null;
    },
    deleteItem: async (k: string) => {
      mockSecure.delete(k);
    },
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: async (k: string, v: string) => {
      if (mockAsyncSetThrows) throw mockAsyncSetThrows;
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

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isValidV1SessionKey,
  readSessionKey,
  readSessionKeySlotRaw,
  writeSessionKey,
  restoreSessionKeySlot,
  deleteSessionKeyForTopic,
  deleteSessionKeySlot,
} from '../sessionKeyStore';
import { WC_V1_SESSION_STORAGE_KEY, WC_V1_SESSION_KEY_SLOT } from '../config';
import {
  isRestorableV1Session,
  type WalletConnectV1LegacyPersistedSession,
} from '../types';

// Throwaway vectors.
const KEY_A = 'a1b2c3d4'.repeat(8);
const KEY_B = 'b1c2d3e4'.repeat(8);
const TOPIC_A = 'topic-a';
const TOPIC_B = 'topic-b';

const rowKey = (topic: string) => `${WC_V1_SESSION_STORAGE_KEY}:${topic}`;

const legacyRow = (
  topic: string,
  key: string,
  updatedAt = 1000
): WalletConnectV1LegacyPersistedSession => ({
  connected: true,
  accounts: ['ACCOUNT'],
  chainId: 416001,
  bridge: 'https://bridge.example',
  key,
  clientId: `client-${topic}`,
  clientMeta: null,
  peerId: `peer-${topic}`,
  peerMeta: null,
  handshakeId: 1,
  handshakeTopic: topic,
  updatedAt,
});

beforeEach(() => {
  mockSecure.clear();
  mockKv.clear();
  mockSecureGetThrows = null;
  mockAsyncSetThrows = null;
  mockSecureSetThrows = null;
  jest.restoreAllMocks();
});

/**
 * The migration step exactly as boot restore performs it (DR-7): write the
 * mockSecure copy first, then rewrite the SAME row without `key`. The rewrite is
 * the delete — the row must survive, because it carries routing metadata.
 */
async function migrateSelectedRow(topic: string): Promise<void> {
  const raw = await AsyncStorage.getItem(rowKey(topic));
  const row = JSON.parse(raw!) as WalletConnectV1LegacyPersistedSession;
  await writeSessionKey(topic, row.key!);
  const { key: _dropped, ...keyless } = row;
  await AsyncStorage.setItem(rowKey(topic), JSON.stringify(keyless));
}

describe('AC1/AC4 — migrate-then-rewrite leaves no key in AsyncStorage', () => {
  it('removes the inline key while KEEPING the routing metadata', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));

    await migrateSelectedRow(TOPIC_A);

    const after = JSON.parse(mockKv.get(rowKey(TOPIC_A))!);
    expect(after.key).toBeUndefined();
    // Routing metadata survives — this is what makes reconnection possible.
    expect(after.bridge).toBe('https://bridge.example');
    expect(after.handshakeTopic).toBe(TOPIC_A);
    expect(after.accounts).toEqual(['ACCOUNT']);
  });

  it('leaves NO key material anywhere in AsyncStorage', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await migrateSelectedRow(TOPIC_A);

    const everything = [...mockKv.values()].join('\n');
    expect(everything).not.toContain(KEY_A);
  });

  it('puts the key in the secure slot, bound to its topic', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await migrateSelectedRow(TOPIC_A);

    expect(await readSessionKey(TOPIC_A)).toBe(KEY_A);
    expect([...mockSecure.keys()]).toEqual([WC_V1_SESSION_KEY_SLOT]);
  });
});

describe('AC2 — an existing session still reconnects after upgrade', () => {
  it('yields the same key and bridge a reconnect needs', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await migrateSelectedRow(TOPIC_A);

    // What boot restore reassembles for v1Client.connect():
    const row = JSON.parse(mockKv.get(rowKey(TOPIC_A))!);
    const key = await readSessionKey(TOPIC_A);

    expect(key).toBe(KEY_A);
    expect(row.bridge).toBe('https://bridge.example');
  });

  it('is idempotent — a second boot does not re-migrate or lose the key', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await migrateSelectedRow(TOPIC_A);

    // Second boot: the row is already keyless, the secure slot answers.
    const row = JSON.parse(
      mockKv.get(rowKey(TOPIC_A))!
    ) as WalletConnectV1LegacyPersistedSession;
    expect(row.key).toBeUndefined();
    expect(await readSessionKey(TOPIC_A)).toBe(KEY_A);
  });
});

describe('multiple legacy rows — freshest wins, others are dropped', () => {
  it('migrates only the selected row and discards the rest with their keys', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A, 500)));
    mockKv.set(
      rowKey(TOPIC_B),
      JSON.stringify(legacyRow(TOPIC_B, KEY_B, 9000))
    );

    // B is fresher, so it is the selected session.
    await migrateSelectedRow(TOPIC_B);
    await AsyncStorage.multiRemove([rowKey(TOPIC_A)]);

    expect(await readSessionKey(TOPIC_B)).toBe(KEY_B);
    const everything = [...mockKv.values()].join('\n');
    expect(everything).not.toContain(KEY_A);
    expect(everything).not.toContain(KEY_B);
  });
});

describe('DR-5a — fault injection per storage operation', () => {
  it('rolls back the secure write when the metadata write fails', async () => {
    // Session A is fully persisted.
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await migrateSelectedRow(TOPIC_A);

    // Exactly what storeSession does: capture the prior slot, write, and on a
    // metadata failure hand the captured value to the real rollback helper.
    const priorSlot = await readSessionKeySlotRaw();

    await writeSessionKey(TOPIC_B, KEY_B);
    mockAsyncSetThrows = new Error('disk full');
    await expect(AsyncStorage.setItem(rowKey(TOPIC_B), '{}')).rejects.toThrow();
    mockAsyncSetThrows = null;

    await restoreSessionKeySlot(priorSlot);

    // A is intact and restorable — the whole point of the rollback.
    expect(await readSessionKey(TOPIC_A)).toBe(KEY_A);
    expect(await readSessionKey(TOPIC_B)).toBeNull();
  });

  it('a failed migration leaves the legacy row intact so it can retry', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));

    await writeSessionKey(TOPIC_A, KEY_A);
    mockAsyncSetThrows = new Error('write failed');
    await expect(migrateSelectedRow(TOPIC_A)).rejects.toThrow();
    mockAsyncSetThrows = null;

    // The row still has its inline key, so the next boot can migrate again.
    const row = JSON.parse(
      mockKv.get(rowKey(TOPIC_A))!
    ) as WalletConnectV1LegacyPersistedSession;
    expect(row.key).toBe(KEY_A);
  });
});

describe('DR-3a — pair-then-reject must not destroy the retained session', () => {
  it('REGRESSION: A stored, B paired then rejected, A still restores', async () => {
    // A is the live persisted session.
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await migrateSelectedRow(TOPIC_A);

    // B is being paired. connect() retains A's storage; config now points at B.
    // B is rejected -> clearSession() runs with B's topic.
    await AsyncStorage.removeItem(rowKey(TOPIC_B));
    await deleteSessionKeyForTopic(TOPIC_B);

    // A survives, key and metadata both.
    expect(await readSessionKey(TOPIC_A)).toBe(KEY_A);
    expect(mockKv.has(rowKey(TOPIC_A))).toBe(true);
  });
});

describe('DR-4/DR-15 — unrestorable states fail closed and quietly', () => {
  it('keyless metadata with an empty slot yields no key and no error', async () => {
    const { key: _dropped, ...keyless } = legacyRow(TOPIC_A, KEY_A);
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(keyless));

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const key = await readSessionKey(TOPIC_A);

    expect(key).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('a keystore desync surfaces as a throw the caller can catch', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await migrateSelectedRow(TOPIC_A);

    mockSecureGetThrows = new Error('keystore desync');
    await expect(readSessionKey(TOPIC_A)).rejects.toThrow('keystore desync');
  });

  it('a slot bound to another topic reads as no-key', async () => {
    await writeSessionKey(TOPIC_B, KEY_B);
    expect(await readSessionKey(TOPIC_A)).toBeNull();
  });
});

describe('AC3 — no key reaches logs on any path', () => {
  it('logs nothing containing the key across migrate, read and drop', async () => {
    const calls: string[] = [];
    const push = (...args: unknown[]) =>
      calls.push(
        args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
      );
    jest.spyOn(console, 'error').mockImplementation(push);
    jest.spyOn(console, 'warn').mockImplementation(push);
    jest.spyOn(console, 'log').mockImplementation(push);

    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await migrateSelectedRow(TOPIC_A);
    await readSessionKey(TOPIC_A);
    await deleteSessionKeyForTopic(TOPIC_A);

    // Malformed slot, which is the path that DOES log.
    mockSecure.set(WC_V1_SESSION_KEY_SLOT, `garbage ${KEY_A} key=${KEY_A}`);
    await readSessionKey(TOPIC_A);

    const logged = calls.join('\n');
    expect(logged).not.toContain(KEY_A);
  });
});

/**
 * Mirrors the restore path's strip rule: the inline key is removed whenever
 * the row still carries one, NOT only when a migration just happened.
 */
async function restoreStripRule(topic: string): Promise<string | null> {
  const raw = await AsyncStorage.getItem(rowKey(topic));
  const row = JSON.parse(raw!) as WalletConnectV1LegacyPersistedSession;

  let sessionKey = await readSessionKey(topic);
  const hasInlineKey =
    row.key !== undefined && row.key !== null && row.key !== '';
  const seedableKey = isValidV1SessionKey(row.key) ? row.key : null;
  let secureKeyConfirmed = sessionKey !== null;

  if (!sessionKey && seedableKey) {
    try {
      await writeSessionKey(topic, seedableKey);
      secureKeyConfirmed = true;
    } catch {
      // Secure write failed; the inline key is the only copy left.
    }
    sessionKey = seedableKey;
  }
  if (!sessionKey) return null;

  if (hasInlineKey && secureKeyConfirmed) {
    const { key: _dropped, ...keyless } = row;
    await AsyncStorage.setItem(rowKey(topic), JSON.stringify(keyless));
  }
  return sessionKey;
}

describe('crash windows in migration (Codex review of TASK-258)', () => {
  it('strips the inline key even when the secure slot ALREADY has it', async () => {
    // The crash window: a previous boot wrote the secure slot, then died before
    // rewriting the row. readSessionKey now succeeds, so a strip conditional on
    // "did we just migrate?" would leave the key in AsyncStorage forever.
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await writeSessionKey(TOPIC_A, KEY_A);

    const key = await restoreStripRule(TOPIC_A);

    expect(key).toBe(KEY_A);
    expect([...mockKv.values()].join('\n')).not.toContain(KEY_A);
    const row = JSON.parse(mockKv.get(rowKey(TOPIC_A))!);
    expect(row.key).toBeUndefined();
    // Routing metadata still intact.
    expect(row.bridge).toBe('https://bridge.example');
  });

  it('REGRESSION: a failed secure write must NOT strip the only remaining key', async () => {
    // Codex round 2. The round-1 fix fell back to the inline key on a secure
    // write failure but still stripped the row — leaving the NEXT boot with
    // keyless metadata and no secure key, dropping a recoverable session.
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));

    mockSecureSetThrows = new Error('keystore unavailable');
    const key = await restoreStripRule(TOPIC_A);
    mockSecureSetThrows = null;

    // The session still restores this boot...
    expect(key).toBe(KEY_A);
    // ...and the inline key SURVIVES, so the next boot can retry the migration
    // instead of finding an unusable keyless row.
    const row = JSON.parse(
      mockKv.get(rowKey(TOPIC_A))!
    ) as WalletConnectV1LegacyPersistedSession;
    expect(row.key).toBe(KEY_A);

    // And once secure storage recovers, the migration completes.
    const key2 = await restoreStripRule(TOPIC_A);
    expect(key2).toBe(KEY_A);
    expect([...mockKv.values()].join('\n')).not.toContain(KEY_A);
  });

  it('a failed row rewrite leaves the session working and retries next boot', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));

    await writeSessionKey(TOPIC_A, KEY_A);
    mockAsyncSetThrows = new Error('write failed');
    await expect(restoreStripRule(TOPIC_A)).rejects.toThrow();
    mockAsyncSetThrows = null;

    // Secure copy is present, row still has its key: session works either way.
    expect(await readSessionKey(TOPIC_A)).toBe(KEY_A);

    // Next boot completes the strip.
    const key = await restoreStripRule(TOPIC_A);
    expect(key).toBe(KEY_A);
    expect([...mockKv.values()].join('\n')).not.toContain(KEY_A);
  });
});

describe('dropping an unrestorable session cleans up ALL of it', () => {
  /**
   * Mirrors dropV1Session: every v1 row goes, so the slot delete is
   * UNCONDITIONAL (nothing survives that could need its key) and queues are
   * purged for every removed topic, not just the selected one.
   */
  async function dropAll(topics: string[]): Promise<void> {
    await AsyncStorage.multiRemove(topics.map(rowKey));
    await deleteSessionKeySlot();
  }

  it('REGRESSION: does not orphan a slot bound to a STALE row', async () => {
    // Codex round 3. The selected-but-unrestorable row is A, while the slot
    // happens to hold B's key. A topic-conditional delete keyed on A would have
    // wiped both rows and left B's key stranded in a store with no enumeration.
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    mockKv.set(rowKey(TOPIC_B), JSON.stringify(legacyRow(TOPIC_B, KEY_B)));
    await writeSessionKey(TOPIC_B, KEY_B);

    await dropAll([TOPIC_A, TOPIC_B]);

    expect(mockSecure.size).toBe(0);
    expect(mockKv.size).toBe(0);
    expect(await readSessionKey(TOPIC_B)).toBeNull();
  });

  it('leaves no key material anywhere afterwards', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    await writeSessionKey(TOPIC_A, KEY_A);

    await dropAll([TOPIC_A]);

    const everything = [...mockKv.values(), ...mockSecure.values()].join('\n');
    expect(everything).not.toContain(KEY_A);
  });
});

describe('a MALFORMED inline key is drained too', () => {
  it('REGRESSION: strips an invalid inline key when the secure copy is valid', async () => {
    // Codex round 4. `inlineKey` used to conflate "is there a key to drain?"
    // with "is it good enough to seed SecureStore?", so a corrupt or truncated
    // key would sit in AsyncStorage forever once the secure slot was populated.
    const malformed = 'not-a-valid-key';
    const row = { ...legacyRow(TOPIC_A, KEY_A), key: malformed };
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(row));
    await writeSessionKey(TOPIC_A, KEY_A);

    const key = await restoreStripRule(TOPIC_A);

    // Restores from the valid SECURE copy...
    expect(key).toBe(KEY_A);
    // ...and the malformed inline value is gone.
    const after = JSON.parse(mockKv.get(rowKey(TOPIC_A))!);
    expect(after.key).toBeUndefined();
    expect([...mockKv.values()].join('\n')).not.toContain(malformed);
  });

  it('does not seed the secure slot from a malformed key', async () => {
    const row = { ...legacyRow(TOPIC_A, KEY_A), key: 'zzzz' };
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(row));

    // No secure copy and no seedable key: unrestorable.
    expect(await restoreStripRule(TOPIC_A)).toBeNull();
    expect(mockSecure.size).toBe(0);
  });
});

describe('every path that reads a legacy row also drains it', () => {
  // Codex round 5. loadSession() is reachable independently of boot restore —
  // a v1 deep link connects through it, and boot restore may never run if
  // WalletConnect initialization failed earlier — so leaving the drain solely
  // to the restore path let a legacy key sit in AsyncStorage indefinitely.

  it('an unparseable row is DELETED, not skipped', async () => {
    // A truncated row can still contain a valid inline key. Skipped rows escape
    // both the migration and the stale-row prune, so the key would survive
    // forever. Nothing recoverable is lost by deleting it.
    const truncated = `{"bridge":"https://b.example","key":"${KEY_A}"`;
    mockKv.set(rowKey(TOPIC_A), truncated);

    // What the restore path now does on a JSON.parse failure:
    try {
      JSON.parse(mockKv.get(rowKey(TOPIC_A))!);
    } catch {
      await AsyncStorage.removeItem(rowKey(TOPIC_A));
    }

    expect(mockKv.has(rowKey(TOPIC_A))).toBe(false);
    expect([...mockKv.values()].join('\n')).not.toContain(KEY_A);
  });

  it('draining is idempotent across repeated reads', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));

    await restoreStripRule(TOPIC_A);
    await restoreStripRule(TOPIC_A);
    const key = await restoreStripRule(TOPIC_A);

    expect(key).toBe(KEY_A);
    expect([...mockKv.values()].join('\n')).not.toContain(KEY_A);
  });
});

describe('unusable rows are deleted, not retained (Codex round 7)', () => {
  /**
   * loadSession's rule for a parsable row with no usable key: delete it, the
   * same as the restore path's dropV1Session. Covers valid JSON of the WRONG
   * SHAPE, which slips past the parse guard while still possibly holding
   * key-shaped text.
   */
  async function loadOrDelete(topic: string): Promise<string | null> {
    const stored = await AsyncStorage.getItem(rowKey(topic));
    if (!stored) return null;

    let row: WalletConnectV1LegacyPersistedSession;
    try {
      row = JSON.parse(stored) as WalletConnectV1LegacyPersistedSession;
    } catch {
      await AsyncStorage.removeItem(rowKey(topic));
      return null;
    }

    const sessionKey =
      (await readSessionKey(topic)) ??
      (isValidV1SessionKey(row?.key) ? row.key! : null);

    if (!sessionKey) {
      await AsyncStorage.removeItem(rowKey(topic));
      return null;
    }
    return sessionKey;
  }

  it('deletes a parsable row that has no usable key anywhere', async () => {
    const { key: _d, ...keyless } = legacyRow(TOPIC_A, KEY_A);
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(keyless));

    expect(await loadOrDelete(TOPIC_A)).toBeNull();
    expect(mockKv.has(rowKey(TOPIC_A))).toBe(false);
  });

  it('deletes valid JSON of the WRONG SHAPE that still holds key-shaped text', async () => {
    // Parses fine, so the parse guard does not catch it — but it is unusable
    // and would otherwise sit there with the key text inside.
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(`stray ${KEY_A}`));

    expect(await loadOrDelete(TOPIC_A)).toBeNull();
    expect(mockKv.has(rowKey(TOPIC_A))).toBe(false);
    expect([...mockKv.values()].join('\n')).not.toContain(KEY_A);
  });

  it('keeps a row that IS usable', async () => {
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    expect(await loadOrDelete(TOPIC_A)).toBe(KEY_A);
    expect(mockKv.has(rowKey(TOPIC_A))).toBe(true);
  });
});

describe('wrong-shape rows cannot abort restoration (Codex round 8)', () => {
  /** The restore path's per-row guard: non-null object, or the row is dropped. */
  function parseRowOrNull(raw: string): object | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      if (Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  it.each([
    ['JSON null', 'null'],
    ['a bare string', '"just-a-string"'],
    ['a number', '42'],
    ['unparseable', '{"truncated"'],
  ])('rejects %s without throwing', (_label, raw) => {
    expect(parseRowOrNull(raw)).toBeNull();
  });

  it('REGRESSION: one null row does not abort restoration of a VALID row', async () => {
    // Previously `session.connected` on a null row threw inside the filter,
    // taking down v1 restoration entirely — one corrupt row denied service to
    // every good one.
    mockKv.set(rowKey('corrupt'), 'null');
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A)));

    const rows = [...mockKv.entries()].map(([k, v]) => ({
      key: k,
      session: parseRowOrNull(v),
    }));
    const usable = rows.filter((r) => r.session !== null);

    // The valid row survives selection.
    expect(usable).toHaveLength(1);
    expect(usable[0].key).toBe(rowKey(TOPIC_A));
    // And filtering on a real field no longer throws.
    expect(() =>
      usable.filter((r) => (r.session as { connected?: boolean }).connected)
    ).not.toThrow();
  });

  it('an array row is rejected too', () => {
    expect(parseRowOrNull('[1,2,3]')).toBeNull();
  });
});

describe('incomplete rows must not win selection (Codex round 9)', () => {
  /** Restore's per-row admission rule: object shape AND a usable bridge. */
  function admitRow(raw: string): WalletConnectV1LegacyPersistedSession | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return null;
      }
      const candidate = parsed as WalletConnectV1LegacyPersistedSession;
      if (
        typeof candidate.bridge !== 'string' ||
        candidate.bridge.length === 0
      ) {
        return null;
      }
      return candidate;
    } catch {
      return null;
    }
  }

  it('REGRESSION: a fresh-but-incomplete row does not displace a valid session', async () => {
    // The corrupt row has the newest updatedAt, so freshest-wins would have
    // selected it. Having no key, it would then route into dropV1Session —
    // which deletes EVERY v1 row and the secure slot, destroying the good
    // session as collateral.
    mockKv.set(
      rowKey('corrupt'),
      JSON.stringify({ connected: true, updatedAt: 999999 })
    );
    mockKv.set(rowKey(TOPIC_A), JSON.stringify(legacyRow(TOPIC_A, KEY_A, 100)));

    const admitted = [...mockKv.entries()]
      .map(([k, v]) => ({ key: k, session: admitRow(v) }))
      .filter((r) => r.session !== null);

    // Only the real session is a candidate at all.
    expect(admitted).toHaveLength(1);
    expect(admitted[0].key).toBe(rowKey(TOPIC_A));
    expect(admitted[0].session!.bridge).toBe('https://bridge.example');
  });

  it.each([
    ['no bridge', JSON.stringify({ connected: true })],
    ['empty bridge', JSON.stringify({ bridge: '' })],
    ['non-string bridge', JSON.stringify({ bridge: 42 })],
  ])('rejects a row with %s', (_label, raw) => {
    expect(admitRow(raw)).toBeNull();
  });

  it('admits a complete row', () => {
    const ok = admitRow(JSON.stringify(legacyRow(TOPIC_A, KEY_A)));
    expect(ok).not.toBeNull();
  });
});

describe('isRestorableV1Session — full reconnect contract (Codex round 12)', () => {
  it('accepts a complete row', () => {
    expect(isRestorableV1Session(legacyRow(TOPIC_A, KEY_A))).toBe(true);
  });

  it('REGRESSION: rejects a row that passes a SHALLOW check but cannot reconnect', () => {
    // bridge + handshakeTopic + accounts + chainId only. This used to be
    // admitted, win freshest-wins selection, and restore with an undefined
    // clientId onto a dead handshake topic — a session that looks live but is
    // unusable, which is worse than deleting it and re-pairing.
    expect(
      isRestorableV1Session({
        bridge: 'https://b.example',
        handshakeTopic: TOPIC_A,
        accounts: [],
        chainId: 416001,
      } as unknown as WalletConnectV1LegacyPersistedSession)
    ).toBe(false);
  });

  it.each([
    'connected',
    'accounts',
    'chainId',
    'bridge',
    'clientId',
    'peerId',
    'handshakeId',
    'handshakeTopic',
  ])('rejects a row missing %s', (field) => {
    const row = { ...legacyRow(TOPIC_A, KEY_A) } as Record<string, unknown>;
    delete row[field];
    expect(
      isRestorableV1Session(
        row as unknown as WalletConnectV1LegacyPersistedSession
      )
    ).toBe(false);
  });

  it('rejects empty-string bridge, clientId, peerId and handshakeTopic', () => {
    for (const field of ['bridge', 'clientId', 'peerId', 'handshakeTopic']) {
      const row = { ...legacyRow(TOPIC_A, KEY_A), [field]: '' };
      expect(
        isRestorableV1Session(row as WalletConnectV1LegacyPersistedSession)
      ).toBe(false);
    }
  });

  it('rejects null and undefined', () => {
    expect(isRestorableV1Session(null)).toBe(false);
    expect(isRestorableV1Session(undefined)).toBe(false);
  });

  it('does NOT require `key` — it no longer lives on the row', () => {
    const { key: _d, ...keyless } = legacyRow(TOPIC_A, KEY_A);
    expect(
      isRestorableV1Session(keyless as WalletConnectV1LegacyPersistedSession)
    ).toBe(true);
  });
});
