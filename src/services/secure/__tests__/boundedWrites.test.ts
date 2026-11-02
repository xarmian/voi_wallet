import { createHash } from 'crypto';
import {
  boundedSet,
  boundedDelete,
  assertKeyResolved,
  WriteFailedError,
  WriteOutcomeUnknownError,
  WriteUnresolvedError,
  UNKNOWN_WRITE_MESSAGES,
  type UnknownWriteEntry,
  classifyUnknownWrite,
  hasDowngradedMarkers,
} from '../boundedWrites';

const VALUE = 'private-test-value';
function fixture() {
  const values = new Map<string, string>();
  const entries = new Map<string, UnknownWriteEntry>();
  let set: (key: string, value: string) => Promise<void> = async (
    key,
    value
  ) => {
    values.set(key, value);
  };
  let remove: (key: string) => Promise<void> = async (key) => {
    values.delete(key);
  };
  const adapter = {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => set(key, value)),
    deleteItem: jest.fn((key: string) => remove(key)),
  };
  const journal = {
    add: jest.fn(async (entry: UnknownWriteEntry) => {
      entries.set(entry.key, entry);
    }),
    get: jest.fn(async (key: string) => entries.get(key)),
    remove: jest.fn(async (key: string) => {
      entries.delete(key);
    }),
    removeIf: jest.fn(async (key: string, expected: UnknownWriteEntry) => {
      const current = entries.get(key);
      if (
        current &&
        current.op === expected.op &&
        current.at === expected.at &&
        current.attempt === expected.attempt &&
        current.sessionId === expected.sessionId
      )
        entries.delete(key);
    }),
  };
  return {
    values,
    entries,
    adapter,
    journal,
    setWrite: (fn: typeof set) => {
      set = fn;
    },
    setDelete: (fn: typeof remove) => {
      remove = fn;
    },
  };
}
const tick = async () => {
  await jest.advanceTimersByTimeAsync(10);
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('successful set has no journal entry', async () => {
  const f = fixture();
  await boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'presence',
    timeoutMs: 10,
  });
  expect(f.entries.size).toBe(0);
});

test('rejected set is a known failure', async () => {
  const f = fixture();
  f.setWrite(async () => {
    throw new Error('rejected');
  });
  await expect(
    boundedSet(f.adapter, 'k', VALUE, {
      journal: f.journal,
      verifier: 'presence',
      timeoutMs: 10,
    })
  ).rejects.toBeInstanceOf(WriteFailedError);
  expect(f.entries.size).toBe(0);
});

test('timed-out set with matching read-back is written', async () => {
  const f = fixture();
  f.setWrite((key, value) => {
    setTimeout(() => f.values.set(key, value), 10);
    return new Promise(() => {});
  });
  const result = boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'presence',
    timeoutMs: 10,
  });
  await tick();
  await expect(result).resolves.toBeUndefined();
  expect(f.entries.size).toBe(0);
});

test('unknown set is journaled without the value or its digest', async () => {
  const f = fixture();
  f.setWrite(() => new Promise(() => {}));
  const result = boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'a'.repeat(32),
    sessionId: 'session',
    timeoutMs: 10,
  });
  const assertion = expect(result).rejects.toMatchObject({ journaled: true });
  await tick();
  await assertion;
  expect(f.entries.get('k')).toMatchObject({
    key: 'k',
    op: 'set',
    verifier: 'nonce',
    attempt: 'a'.repeat(32),
    sessionId: 'session',
  });
  const persisted = JSON.stringify([...f.entries.values()]);
  expect(persisted).not.toContain(VALUE);
  expect(persisted).not.toContain(
    createHash('sha256').update(VALUE).digest('hex')
  );
  expect(persisted).not.toContain(Buffer.from(VALUE).toString('base64'));
});

test('delete still present is failed, absent is unknown', async () => {
  const f = fixture();
  f.values.set('k', VALUE);
  f.setDelete(() => new Promise(() => {}));
  let result = boundedDelete(f.adapter, 'k', {
    journal: f.journal,
    verifier: 'presence',
    timeoutMs: 10,
  });
  const assertion = expect(result).rejects.toBeInstanceOf(WriteFailedError);
  await tick();
  await assertion;
  f.values.delete('k');
  result = boundedDelete(f.adapter, 'k', {
    journal: f.journal,
    verifier: 'presence',
    timeoutMs: 10,
  });
  const secondAssertion = expect(result).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await secondAssertion;
  expect(f.entries.get('k')?.op).toBe('delete');
});

test('failed or hung journal add is unknown and unjournaled', async () => {
  for (const failure of ['reject', 'hang']) {
    const f = fixture();
    f.setWrite(() => new Promise(() => {}));
    f.journal.add.mockImplementation(() =>
      failure === 'reject'
        ? Promise.reject(new Error('fail'))
        : new Promise(() => {})
    );
    const result = boundedSet(f.adapter, `failed-${failure}`, VALUE, {
      journal: f.journal,
      verifier: 'presence',
      timeoutMs: 10,
    });
    const assertion = expect(result).rejects.toMatchObject({
      journaled: false,
    });
    await tick();
    if (failure === 'hang') await tick();
    await assertion;
    await expect(
      boundedDelete(f.adapter, `failed-${failure}`, {
        journal: f.journal,
        verifier: 'presence',
        timeoutMs: 10,
      })
    ).resolves.toBeUndefined();
    await expect(
      boundedSet(f.adapter, `failed-${failure}`, VALUE, {
        journal: f.journal,
        verifier: 'presence',
        timeoutMs: 10,
      })
    ).rejects.toBeInstanceOf(WriteUnresolvedError);
    f.setWrite(async (key, value) => {
      f.values.set(key, value);
    });
    await expect(
      boundedSet(f.adapter, 'another-key', VALUE, {
        journal: f.journal,
        verifier: 'presence',
        timeoutMs: 10,
      })
    ).resolves.toBeUndefined();
  }
});

test('same-session nonce blocks a later write until the old attempt is observed', async () => {
  const f = fixture();
  const old = JSON.stringify({ writeNonce: 'a'.repeat(32), data: VALUE });
  const next = JSON.stringify({ writeNonce: 'b'.repeat(32), data: VALUE });
  let land!: () => void;
  f.setWrite(
    (key, value) =>
      new Promise<void>((resolve) => {
        land = () => {
          f.values.set(key, value);
          resolve();
        };
      })
  );
  const first = boundedSet(f.adapter, 'k', old, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'a'.repeat(32),
    sessionId: 's',
    timeoutMs: 10,
  });
  const firstAssertion = expect(first).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await firstAssertion;
  f.values.set('k', next); // equal payload content but stale nonce is not proof
  await expect(
    assertKeyResolved(f.journal, f.adapter, 'k', {
      sessionId: 's',
      timeoutMs: 10,
    })
  ).rejects.toBeInstanceOf(WriteUnresolvedError);
  await expect(
    boundedSet(f.adapter, 'k', next, {
      journal: f.journal,
      verifier: 'nonce',
      attempt: 'b'.repeat(32),
      sessionId: 's',
      timeoutMs: 10,
    })
  ).rejects.toBeInstanceOf(WriteUnresolvedError);
  land();
  await Promise.resolve();
  f.setWrite(async (key, value) => {
    f.values.set(key, value);
  });
  await boundedSet(f.adapter, 'k', next, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'b'.repeat(32),
    sessionId: 's',
    timeoutMs: 10,
  });
  expect(f.values.get('k')).toBe(next);
  expect(f.entries.size).toBe(0);
});

test.each([null, VALUE])(
  'earlier-session entry resolves by presence: %s',
  async (value) => {
    const f = fixture();
    if (value) f.values.set('k', value);
    f.entries.set('k', {
      key: 'k',
      op: 'set',
      verifier: 'presence',
      attempt: '',
      sessionId: 'old',
      at: 1,
    });
    await assertKeyResolved(f.journal, f.adapter, 'k', {
      sessionId: 'new',
      timeoutMs: 10,
    });
    expect(f.entries.size).toBe(0);
  }
);

test.each([
  [JSON.stringify({ writeNonce: 'a' }), 'written'],
  [JSON.stringify({ writeNonce: 'b' }), 'not-written'],
  [JSON.stringify({ legacy: true }), 'not-written'],
  [null, 'not-written'],
  ['{bad', 'not-written'],
])('classifies nonce payload %s as %s', (raw, expected) => {
  const entry: UnknownWriteEntry = {
    key: 'k',
    op: 'set',
    verifier: 'nonce',
    attempt: 'a',
    sessionId: 'old',
    at: 1,
  };
  expect(classifyUnknownWrite(entry, raw)).toBe(expected);
  expect(classifyUnknownWrite({ ...entry, verifier: 'presence' }, raw)).toBe(
    'not-written'
  );
});

test('delete bypasses unresolved and unreadable journals', async () => {
  const f = fixture();
  f.values.set('k', VALUE);
  f.journal.get.mockRejectedValue(new Error('corrupt'));
  await expect(
    boundedDelete(f.adapter, 'k', {
      journal: f.journal,
      verifier: 'presence',
      timeoutMs: 10,
    })
  ).resolves.toBeUndefined();
  expect(f.values.has('k')).toBe(false);
});

test('a timed-out set that lands after delete is deleted again', async () => {
  const f = fixture();
  let land!: () => void;
  f.setWrite(
    (key, value) =>
      new Promise<void>((resolve) => {
        land = () => {
          f.values.set(key, value);
          resolve();
        };
      })
  );
  const first = boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'a',
    sessionId: 's',
    timeoutMs: 10,
  });
  const assertion = expect(first).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await assertion;
  await boundedDelete(f.adapter, 'k', {
    journal: f.journal,
    verifier: 'presence',
    sessionId: 's',
    timeoutMs: 10,
  });
  land();
  await flush();
  expect(f.values.has('k')).toBe(false);
  expect(f.entries.has('k')).toBe(false);
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const hangUnknown = async (f: ReturnType<typeof fixture>) => {
  let land!: () => void;
  f.setWrite(
    (key, value) =>
      new Promise<void>((resolve) => {
        land = () => {
          f.values.set(key, value);
          resolve();
        };
      })
  );
  const first = boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'a',
    sessionId: 's',
    timeoutMs: 10,
  });
  const assertion = expect(first).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await assertion;
  return () => land();
};

test('a retry cannot race the tombstone cleanup delete (it would erase the newer value)', async () => {
  const f = fixture();
  const land = await hangUnknown(f);
  await boundedDelete(f.adapter, 'k', {
    journal: f.journal,
    verifier: 'presence',
    sessionId: 's',
    timeoutMs: 10,
  });
  let releaseCleanup!: () => void;
  f.setDelete(
    (key) =>
      new Promise<void>((resolve) => {
        releaseCleanup = () => {
          f.values.delete(key);
          resolve();
        };
      })
  );
  land(); // the hung set lands; the cleanup delete starts and is held open
  await flush();
  f.setWrite(async (key, value) => {
    f.values.set(key, value);
  });
  await expect(
    boundedSet(f.adapter, 'k', 'newer', {
      journal: f.journal,
      verifier: 'presence',
      sessionId: 's',
      timeoutMs: 10,
    })
  ).rejects.toBeInstanceOf(WriteUnresolvedError);
  releaseCleanup();
  await flush();
  expect(f.values.has('k')).toBe(false);
  await boundedSet(f.adapter, 'k', 'newer', {
    journal: f.journal,
    verifier: 'presence',
    sessionId: 's',
    timeoutMs: 10,
  });
  expect(f.values.get('k')).toBe('newer');
});

test('a settled pending record clears itself without a later set', async () => {
  const f = fixture();
  const land = await hangUnknown(f);
  expect(f.entries.has('k')).toBe(true);
  land();
  await flush();
  expect(f.entries.has('k')).toBe(false);
});

const hangDelete = (f: ReturnType<typeof fixture>) => {
  let finish!: () => void;
  f.setDelete(
    (key) =>
      new Promise<void>((resolve) => {
        finish = () => {
          f.values.delete(key);
          resolve();
        };
      })
  );
  return () => finish();
};

test('a delete that timed out (key still present) is tracked: a later set is refused until it settles, so a late delete cannot erase the newer value', async () => {
  const f = fixture();
  f.values.set('k', 'old');
  const land = hangDelete(f);
  const del = boundedDelete(f.adapter, 'k', {
    journal: f.journal,
    verifier: 'presence',
    sessionId: 's',
    timeoutMs: 10,
  });
  const assertion = expect(del).rejects.toBeInstanceOf(WriteFailedError);
  await tick();
  await assertion;
  f.setWrite(async (key, value) => {
    f.values.set(key, value);
  });
  await expect(
    boundedSet(f.adapter, 'k', 'newer', {
      journal: f.journal,
      verifier: 'presence',
      sessionId: 's',
      timeoutMs: 10,
    })
  ).rejects.toBeInstanceOf(WriteUnresolvedError);
  land(); // the late delete lands while the set was refused
  await flush();
  await boundedSet(f.adapter, 'k', 'newer', {
    journal: f.journal,
    verifier: 'presence',
    sessionId: 's',
    timeoutMs: 10,
  });
  expect(f.values.get('k')).toBe('newer');
});

test('a delete whose read-back is absent journals UNKNOWN, refuses sets until its promise settles, then clears itself', async () => {
  const f = fixture();
  f.values.set('k', 'old');
  let finish!: () => void;
  f.setDelete(
    (key) =>
      new Promise<void>((resolve) => {
        f.values.delete(key); // the key is already gone when the read-back runs
        finish = () => resolve();
      })
  );
  const del = boundedDelete(f.adapter, 'k', {
    journal: f.journal,
    verifier: 'presence',
    sessionId: 's',
    timeoutMs: 10,
  });
  const assertion = expect(del).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await assertion;
  expect(f.entries.has('k')).toBe(true);
  await expect(
    boundedSet(f.adapter, 'k', 'v', {
      journal: f.journal,
      verifier: 'presence',
      sessionId: 's',
      timeoutMs: 10,
    })
  ).rejects.toBeInstanceOf(WriteUnresolvedError);
  finish();
  await flush();
  expect(f.entries.has('k')).toBe(false);
  await expect(
    boundedSet(f.adapter, 'k', 'v', {
      journal: f.journal,
      verifier: 'presence',
      sessionId: 's',
      timeoutMs: 10,
    })
  ).resolves.toBeUndefined();
});

test('a late settle clears only its OWN journal entry, never a newer entry for the same key', async () => {
  const f = fixture();
  let rejectSet!: (error: Error) => void;
  f.setWrite(
    () =>
      new Promise<void>((_, reject) => {
        rejectSet = reject;
      })
  );
  const first = boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'a',
    sessionId: 's',
    timeoutMs: 10,
  });
  const firstAssertion = expect(first).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await firstAssertion;
  expect(f.entries.get('k')?.op).toBe('set');
  f.setDelete(() => new Promise<void>(() => {})); // a delete that never settles
  const del = boundedDelete(f.adapter, 'k', {
    journal: f.journal,
    verifier: 'presence',
    sessionId: 's',
    timeoutMs: 10,
  });
  const delAssertion = expect(del).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await delAssertion;
  expect(f.entries.get('k')?.op).toBe('delete'); // the newer entry replaced it
  rejectSet(new Error('late rejection')); // the OLD set settles
  await flush();
  expect(f.entries.get('k')?.op).toBe('delete'); // still there
});

test('a timed-out set that later rejects permits the next set', async () => {
  const f = fixture();
  let rejectOld!: (error: Error) => void;
  f.setWrite(
    () =>
      new Promise<void>((_, reject) => {
        rejectOld = reject;
      })
  );
  const first = boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'a',
    sessionId: 's',
    timeoutMs: 10,
  });
  const assertion = expect(first).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await assertion;
  rejectOld(new Error('late rejection'));
  await Promise.resolve();
  f.setWrite(async (key, value) => {
    f.values.set(key, value);
  });
  await boundedSet(f.adapter, 'k', 'third', {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'b',
    sessionId: 's',
    timeoutMs: 10,
  });
  expect(f.values.get('k')).toBe('third');
  expect(f.entries.size).toBe(0);
});

test('a tombstone re-delete timeout journals a delete UNKNOWN entry', async () => {
  const f = fixture();
  let land!: () => void;
  f.setWrite(
    (key, value) =>
      new Promise<void>((resolve) => {
        land = () => {
          f.values.set(key, value);
          resolve();
        };
      })
  );
  const first = boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'a',
    sessionId: 's',
    timeoutMs: 10,
  });
  const assertion = expect(first).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await assertion;
  let deletes = 0;
  f.setDelete(async (key) => {
    if (++deletes === 1) f.values.delete(key);
    else await new Promise<void>(() => {});
  });
  await boundedDelete(f.adapter, 'k', {
    journal: f.journal,
    verifier: 'presence',
    sessionId: 's',
    timeoutMs: 10,
  });
  land();
  await tick();
  await jest.advanceTimersByTimeAsync(5001);
  expect(f.adapter.deleteItem).toHaveBeenCalledTimes(2);
  expect(f.entries.get('k')?.op).toBe('delete');
});

test('native session id failure does not cache a JS fallback', async () => {
  const nativeState = globalThis as typeof globalThis & {
    __voiProcessSessionId: unknown;
  };
  jest.resetModules();
  const fresh =
    require('../boundedWrites') as typeof import('../boundedWrites');
  nativeState.__voiProcessSessionId = '';
  await expect(fresh.isCurrentSessionId('x')).rejects.toThrow();
  nativeState.__voiProcessSessionId = 'test-process-id';
  await expect(fresh.isCurrentSessionId('test-process-id')).resolves.toBe(true);
});

test('session identity comes from native process memory', async () => {
  const nativeState = globalThis as typeof globalThis & {
    __voiProcessSessionId: string;
  };
  nativeState.__voiProcessSessionId = 'test-process-id';
  jest.resetModules();
  const fresh =
    require('../boundedWrites') as typeof import('../boundedWrites');
  await expect(fresh.isCurrentSessionId('test-process-id')).resolves.toBe(true);
  await expect(fresh.isCurrentSessionId('other-process')).resolves.toBe(false);
  const f = fixture();
  f.setWrite(() => new Promise(() => {}));
  const write = fresh.boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'attempt',
    timeoutMs: 10,
  });
  const assertion = expect(write).rejects.toBeInstanceOf(
    fresh.WriteOutcomeUnknownError
  );
  await tick();
  await assertion;
  expect(f.entries.get('k')?.sessionId).toBe('test-process-id');
});

test.each([
  ['legacy payload', JSON.stringify({ legacy: true }), false],
  ['different nonce', JSON.stringify({ writeNonce: 'other-attempt' }), false],
  ['unparsable payload', '{bad', false],
  ['matching nonce', JSON.stringify({ writeNonce: 'old-attempt' }), true],
  ['absent key', null, false],
])(
  'inherited same-process entry over %s only clears on nonce',
  async (_, raw, clears) => {
    const f = fixture();
    if (raw !== null) f.values.set('k', raw);
    f.entries.set('k', {
      key: 'k',
      op: 'set',
      verifier: 'nonce',
      attempt: 'old-attempt',
      sessionId: 'test-process-id',
      at: 1,
    });
    jest.resetModules(); // The pending WeakMap is gone, while native memory remains.
    const reloaded =
      require('../boundedWrites') as typeof import('../boundedWrites');
    const write = reloaded.boundedSet(f.adapter, 'k', VALUE, {
      journal: f.journal,
      verifier: 'nonce',
      attempt: 'new-attempt',
      timeoutMs: 10,
    });
    if (clears) {
      await expect(write).resolves.toBeUndefined();
      expect(f.entries.size).toBe(0);
    } else {
      await expect(write).rejects.toBeInstanceOf(reloaded.WriteUnresolvedError);
      expect(f.entries.has('k')).toBe(true);
      expect(f.adapter.setItem).not.toHaveBeenCalled();
      f.values.set('k', JSON.stringify({ writeNonce: 'old-attempt' }));
      await expect(
        reloaded.boundedSet(f.adapter, 'k', VALUE, {
          journal: f.journal,
          verifier: 'nonce',
          attempt: 'new-attempt',
          timeoutMs: 10,
        })
      ).resolves.toBeUndefined();
      expect(f.entries.size).toBe(0);
    }
  }
);

test.each([
  ['legacy payload', JSON.stringify({ legacy: true })],
  ['different nonce', JSON.stringify({ writeNonce: 'other-attempt' })],
  ['unparsable payload', '{bad'],
  ['matching nonce', JSON.stringify({ writeNonce: 'old-attempt' })],
  ['absent key', null],
])('cold-start entry over %s is dropped by the boot rule', async (_, raw) => {
  const f = fixture();
  if (raw !== null) f.values.set('k', raw);
  f.entries.set('k', {
    key: 'k',
    op: 'set',
    verifier: 'nonce',
    attempt: 'old-attempt',
    sessionId: 'old-process-id',
    at: 1,
  });
  jest.resetModules();
  const coldStart =
    require('../boundedWrites') as typeof import('../boundedWrites');
  await expect(
    coldStart.boundedSet(f.adapter, 'k', VALUE, {
      journal: f.journal,
      verifier: 'nonce',
      attempt: 'new-attempt',
      timeoutMs: 10,
    })
  ).resolves.toBeUndefined();
  expect(f.entries.size).toBe(0);
});

test('UNKNOWN errors expose the exact create and restore messages', () => {
  expect(new WriteOutcomeUnknownError(true, 'create').userMessage).toEqual(
    UNKNOWN_WRITE_MESSAGES.create
  );
  expect(new WriteOutcomeUnknownError(true, 'restore').userMessage).toEqual(
    UNKNOWN_WRITE_MESSAGES.restore
  );
  expect(new WriteOutcomeUnknownError(false, 'other').userMessage).toEqual(
    UNKNOWN_WRITE_MESSAGES.create
  );
});

const inherited = (
  f: ReturnType<typeof fixture>,
  key: string,
  over: Partial<UnknownWriteEntry> = {}
) =>
  f.entries.set(key, {
    key,
    op: 'set',
    verifier: 'presence',
    attempt: '',
    sessionId: 's',
    at: 1,
    ...over,
  });
const setOpts = (f: ReturnType<typeof fixture>) => ({
  journal: f.journal,
  verifier: 'presence' as const,
  sessionId: 's',
  timeoutMs: 10,
});

test('A: a delete never erases an inherited same-process SET entry; it becomes a delete entry and later sets stay refused', async () => {
  const f = fixture();
  f.values.set('voi_account_secret_x', 'old');
  inherited(f, 'voi_account_secret_x', { verifier: 'nonce', attempt: 'n' });
  await boundedDelete(f.adapter, 'voi_account_secret_x', setOpts(f));
  expect(f.entries.get('voi_account_secret_x')?.op).toBe('delete');
  await expect(
    boundedSet(f.adapter, 'voi_account_secret_x', 'v', setOpts(f))
  ).rejects.toBeInstanceOf(WriteUnresolvedError);
});

test('A: a delete still clears an earlier-process entry and an own-session delete entry as before', async () => {
  const f = fixture();
  f.values.set('k', 'old');
  inherited(f, 'k', { sessionId: 'earlier-process' });
  await boundedDelete(f.adapter, 'k', setOpts(f));
  expect(f.entries.has('k')).toBe(false);
});

test('B: one successful read-back DOWNGRADES an inherited presence entry on a bookkeeping key (the set proceeds, a marker is recorded)', async () => {
  const f = fixture();
  expect(hasDowngradedMarkers()).toBe(false);
  inherited(f, 'voi_account_list');
  await expect(
    boundedSet(f.adapter, 'voi_account_list', '[]', setOpts(f))
  ).resolves.toBeUndefined();
  expect(f.entries.has('voi_account_list')).toBe(false);
  expect(hasDowngradedMarkers()).toBe(true);
});

test.each([
  ['voi_wallet_pin', { verifier: 'presence' }],
  ['voi_wallet_salt', { verifier: 'presence' }],
  ['voi_account_secret_x', { verifier: 'presence' }],
  ['voi_account_list', { op: 'delete' }],
] as const)(
  'B: %s with %j stays fail-closed (not downgraded)',
  async (key, over) => {
    const f = fixture();
    inherited(f, key, over as Partial<UnknownWriteEntry>);
    await expect(
      boundedSet(f.adapter, key, 'v', setOpts(f))
    ).rejects.toBeInstanceOf(WriteUnresolvedError);
    expect(f.entries.has(key)).toBe(true);
  }
);

test('B: a failed read-back keeps the bookkeeping set refused', async () => {
  const f = fixture();
  inherited(f, 'voi_pending_account_creates');
  f.adapter.getItem.mockRejectedValueOnce(new Error('keychain locked'));
  await expect(
    boundedSet(f.adapter, 'voi_pending_account_creates', '{}', setOpts(f))
  ).rejects.toBeInstanceOf(WriteUnresolvedError);
});

test('A: a second successful delete keeps an existing same-process delete entry (sets stay refused)', async () => {
  const f = fixture();
  f.values.set('voi_account_secret_x', 'v');
  inherited(f, 'voi_account_secret_x', { op: 'delete' });
  await boundedDelete(f.adapter, 'voi_account_secret_x', setOpts(f));
  expect(f.entries.get('voi_account_secret_x')?.op).toBe('delete');
  await expect(
    boundedSet(f.adapter, 'voi_account_secret_x', 'v', setOpts(f))
  ).rejects.toBeInstanceOf(WriteUnresolvedError);
});

test('A: a transient journal read failure during a delete never rewrites the journal', async () => {
  const f = fixture();
  f.values.set('k', 'v');
  inherited(f, 'other', { op: 'set' });
  f.journal.get.mockRejectedValueOnce(new Error('timed out'));
  await expect(
    boundedDelete(f.adapter, 'k', setOpts(f))
  ).resolves.toBeUndefined();
  expect(f.journal.remove).not.toHaveBeenCalled();
  expect(f.entries.has('other')).toBe(true);
});

test('A: a second successful delete keeps a same-process delete entry whose FIRST delete is still pending', async () => {
  const f = fixture();
  f.values.set('voi_account_secret_x', 'v');
  f.setDelete((key) => {
    f.values.delete(key); // gone already; the call itself never settles
    return new Promise<void>(() => {});
  });
  const first = boundedDelete(f.adapter, 'voi_account_secret_x', setOpts(f));
  const assertion = expect(first).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await assertion;
  expect(f.entries.get('voi_account_secret_x')?.op).toBe('delete');
  f.setDelete(async (key) => {
    f.values.delete(key);
  });
  await boundedDelete(f.adapter, 'voi_account_secret_x', setOpts(f));
  expect(f.entries.get('voi_account_secret_x')?.op).toBe('delete');
});

test('A: an older pending delete settling late never erases a NEWER same-process delete entry (same millisecond, empty attempt)', async () => {
  const f = fixture();
  f.values.set('voi_account_secret_x', 'v');
  let settleOld!: () => void;
  f.setDelete(
    (key) =>
      new Promise<void>((resolve) => {
        f.values.delete(key);
        settleOld = resolve;
      })
  );
  const first = boundedDelete(f.adapter, 'voi_account_secret_x', setOpts(f));
  const assertion = expect(first).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await assertion;
  const older = f.entries.get('voi_account_secret_x')!;
  // A newer delete entry for the same key that collides on every field a weak
  // ownership check could compare (op, at) and carries an empty attempt.
  f.entries.set('voi_account_secret_x', { ...older, attempt: '' });
  settleOld();
  await flush();
  expect(f.entries.has('voi_account_secret_x')).toBe(true);
  expect(older.attempt).not.toBe('');
});

test('a settled operation clears its entry through the ATOMIC conditional remove, never get-then-remove', async () => {
  const f = fixture();
  let land!: () => void;
  f.setWrite(
    (key, value) =>
      new Promise<void>((resolve) => {
        land = () => {
          f.values.set(key, value);
          resolve();
        };
      })
  );
  const first = boundedSet(f.adapter, 'k', VALUE, {
    journal: f.journal,
    verifier: 'nonce',
    attempt: 'a',
    sessionId: 's',
    timeoutMs: 10,
  });
  const assertion = expect(first).rejects.toBeInstanceOf(
    WriteOutcomeUnknownError
  );
  await tick();
  await assertion;
  f.journal.get.mockClear();
  f.journal.remove.mockClear();
  land();
  await flush();
  expect(f.journal.removeIf).toHaveBeenCalled();
  expect(f.journal.remove).not.toHaveBeenCalled();
  expect(f.entries.has('k')).toBe(false);
});

test('delete attempt tokens are unique per module instance (a JS reload practically never repeats a token)', () => {
  let first = '';
  let reloaded = '';
  // Two fresh module instances, each making its FIRST call: a bare counter would
  // yield the same token twice.
  jest.isolateModules(() => {
    first = require('../boundedWrites').newDeleteAttempt();
  });
  jest.isolateModules(() => {
    reloaded = require('../boundedWrites').newDeleteAttempt();
  });
  expect(reloaded).not.toBe(first);
  expect(first).toMatch(/^d[a-z0-9]+-\d+$/);
});

// Every journal removal after an OBSERVED entry is conditional on that entry:
// a newer entry journaled between the observation and the removal survives.
const raceNewer = (f: ReturnType<typeof fixture>, key: string) =>
  f.journal.get.mockImplementationOnce(async (k: string) => {
    const observed = f.entries.get(k);
    if (observed)
      f.entries.set(k, { ...observed, at: 999999, attempt: 'newer-attempt' });
    return observed;
  });

test('guard: a newer entry journaled between the guard observing an earlier-process entry and clearing it survives', async () => {
  const f = fixture();
  inherited(f, 'voi_account_secret_x', {
    sessionId: 'earlier-process',
    verifier: 'nonce',
    attempt: 'old',
  });
  raceNewer(f, 'voi_account_secret_x');
  await boundedSet(f.adapter, 'voi_account_secret_x', 'v', setOpts(f));
  expect(f.entries.get('voi_account_secret_x')?.attempt).toBe('newer-attempt');
});

test('delete: a newer entry journaled between a delete observing an earlier-process entry and clearing it survives', async () => {
  const f = fixture();
  f.values.set('k', 'v');
  inherited(f, 'k', { sessionId: 'earlier-process' });
  raceNewer(f, 'k');
  await boundedDelete(f.adapter, 'k', setOpts(f));
  expect(f.entries.get('k')?.attempt).toBe('newer-attempt');
});
