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
      boundedSet(f.adapter, 'another-key', VALUE, {
        journal: f.journal,
        verifier: 'presence',
        timeoutMs: 10,
      })
    ).rejects.toBeInstanceOf(WriteUnresolvedError);
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
