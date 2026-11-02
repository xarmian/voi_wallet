import { crypto as platformCrypto } from '../../platform';

export const UNKNOWN_WRITES_STORAGE_KEY = 'voi_unknown_secure_writes';
export const WRITE_TIMEOUT_MS = 5000;
export type Verifier = 'nonce' | 'presence';
export interface UnknownWriteEntry {
  key: string;
  op: 'set' | 'delete';
  verifier: Verifier;
  attempt: string;
  sessionId: string;
  at: number;
}
export const UNKNOWN_WRITE_MESSAGES = {
  restore: {
    title: "Couldn't confirm your wallet was saved",
    body: 'Your recovery phrase still restores this wallet, so keep it safe. Close and reopen the app, then restore again. If this keeps happening, restart your phone.',
  },
  create: {
    title: "Couldn't confirm your new wallet was saved",
    body: "Don't send funds to it yet. Close and reopen the app. If the wallet isn't in your list, create a new one and back up its new recovery phrase. If this keeps happening, restart your phone.",
  },
} as const;
export type WriteContext = 'create' | 'restore' | 'other';
export class WriteFailedError extends Error {}
export class WriteUnresolvedError extends Error {}
export class UnknownJournalCorruptError extends Error {}
export class WriteOutcomeUnknownError extends Error {
  constructor(
    public readonly journaled: boolean,
    public readonly context: WriteContext = 'other'
  ) {
    super('Write outcome unknown');
  }
  get userMessage() {
    return UNKNOWN_WRITE_MESSAGES[
      this.context === 'restore' ? 'restore' : 'create'
    ];
  }
}
export interface WriteAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem?(key: string): Promise<void>;
  removeItem?(key: string): Promise<void>;
}
export interface UnknownJournal {
  add(entry: UnknownWriteEntry): Promise<void>;
  get(key: string): Promise<UnknownWriteEntry | undefined>;
  remove(key: string): Promise<void>;
}
export interface WriteOptions {
  timeoutMs?: number;
  verifier: Verifier;
  journal: UnknownJournal;
  sessionId?: string;
  attempt?: string;
  context?: WriteContext;
}
interface PendingSet {
  settled: boolean;
  ok: boolean;
  tombstone: boolean;
}
const pendingSets = new WeakMap<WriteAdapter, Map<string, PendingSet>>();
// A delete that timed out can still land late and erase a newer value, so it is
// tracked like a set: later SETs of the key are refused until it settles.
const pendingDeletes = new WeakMap<WriteAdapter, Map<string, PendingSet>>();
function pendingDeleteFor(adapter: WriteAdapter) {
  let map = pendingDeletes.get(adapter);
  if (!map) {
    map = new Map();
    pendingDeletes.set(adapter, map);
  }
  return map;
}
function pendingFor(adapter: WriteAdapter) {
  let map = pendingSets.get(adapter);
  if (!map) {
    map = new Map();
    pendingSets.set(adapter, map);
  }
  return map;
}
export function classifyUnknownWrite(
  entry: UnknownWriteEntry,
  rawValue: string | null
): 'written' | 'not-written' {
  if (entry.op !== 'set' || entry.verifier !== 'nonce' || rawValue === null)
    return 'not-written';
  try {
    return JSON.parse(rawValue).writeNonce === entry.attempt
      ? 'written'
      : 'not-written';
  } catch {
    return 'not-written';
  }
}
let processSessionId: Promise<string> | undefined;
function currentSessionId(): Promise<string> {
  if (!processSessionId)
    processSessionId = (async () => {
      const bytes = platformCrypto?.getRandomBytes
        ? await platformCrypto.getRandomBytes(16)
        : globalThis.crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
    })().catch((error) => {
      processSessionId = undefined;
      throw error;
    });
  return processSessionId;
}
export async function isCurrentSessionId(id: string): Promise<boolean> {
  return id === (await currentSessionId());
}
class DeadlineError extends Error {}
function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
async function boundedRead(adapter: WriteAdapter, key: string, ms: number) {
  return deadline(adapter.getItem(key), ms);
}
export async function assertKeyResolved(
  journal: UnknownJournal,
  adapter: WriteAdapter,
  key: string,
  opts: { timeoutMs?: number; sessionId?: string } = {}
): Promise<void> {
  const ms = opts.timeoutMs ?? WRITE_TIMEOUT_MS;
  const pendingDelete = pendingDeleteFor(adapter).get(key);
  if (pendingDelete && !pendingDelete.settled)
    throw new WriteUnresolvedError('Delete may still land');
  if (pendingDelete) {
    try {
      await deadline(journal.remove(key), ms);
    } catch {
      throw new WriteUnresolvedError(
        'Unknown-write journal could not be cleared'
      );
    }
    pendingDeleteFor(adapter).delete(key);
  }
  const pending = pendingFor(adapter).get(key);
  if (pending && !pending.settled)
    throw new WriteUnresolvedError('Write may still land');
  if (pending) {
    try {
      await deadline(journal.remove(key), ms);
    } catch {
      throw new WriteUnresolvedError(
        'Unknown-write journal could not be cleared'
      );
    }
    pendingFor(adapter).delete(key);
    return;
  }
  let entry: UnknownWriteEntry | undefined;
  try {
    entry = await deadline(journal.get(key), ms);
  } catch {
    throw new WriteUnresolvedError('Unknown-write journal unavailable');
  }
  if (!entry) return;
  let value: string | null;
  try {
    value = await boundedRead(adapter, key, ms);
  } catch {
    throw new WriteUnresolvedError('Unknown write cannot be resolved');
  }
  const sessionId = opts.sessionId ?? (await currentSessionId());
  if (entry.sessionId === sessionId) {
    if (classifyUnknownWrite(entry, value) !== 'written')
      throw new WriteUnresolvedError('Unknown write may still land');
  } else classifyUnknownWrite(entry, value);
  try {
    await deadline(journal.remove(key), ms);
  } catch {
    throw new WriteUnresolvedError(
      'Unknown-write journal could not be cleared'
    );
  }
}
async function perform(
  adapter: WriteAdapter,
  key: string,
  value: string | undefined,
  op: 'set' | 'delete',
  opts: WriteOptions
): Promise<void> {
  const ms = opts.timeoutMs ?? WRITE_TIMEOUT_MS;
  if (op === 'set') await assertKeyResolved(opts.journal, adapter, key, opts);
  else {
    const pending = pendingFor(adapter).get(key);
    if (pending && !pending.settled) pending.tombstone = true;
  }
  let operation: Promise<void>;
  try {
    operation =
      op === 'set'
        ? adapter.setItem(key, value!)
        : adapter.deleteItem
          ? adapter.deleteItem(key)
          : adapter.removeItem!(key);
    await deadline(operation, ms);
    if (op === 'delete' && !pendingFor(adapter).get(key)?.tombstone)
      await deadline(opts.journal.remove(key), ms).catch(() => undefined);
    return;
  } catch (error) {
    if (!(error instanceof DeadlineError))
      throw new WriteFailedError('Write rejected');
  }
  const sessionId = opts.sessionId ?? (await currentSessionId());
  if (op === 'set') {
    const pending: PendingSet = { settled: false, ok: false, tombstone: false };
    pendingFor(adapter).set(key, pending);
    // `settled` means the key is safe to write again: the abandoned set has
    // settled AND any tombstone re-delete has finished (a retry must never race a
    // cleanup delete that could erase its newer value).
    const finish = async (landed: boolean) => {
      pending.ok = landed;
      if (landed && pending.tombstone) {
        try {
          await deadline(
            adapter.deleteItem
              ? adapter.deleteItem(key)
              : adapter.removeItem!(key),
            WRITE_TIMEOUT_MS
          );
        } catch {
          // The re-delete is unproven: the key stays guarded for this session and
          // a delete UNKNOWN entry covers the next boot.
          await opts.journal
            .add({
              key,
              op: 'delete',
              verifier: 'presence',
              attempt: '',
              sessionId,
              at: Date.now(),
            })
            .catch(() => undefined);
          return;
        }
      }
      pending.settled = true;
      // Best effort: clear the entry and the record so nothing lingers; if the
      // journal remove fails the record stays and the next set's guard retries it.
      try {
        await deadline(opts.journal.remove(key), WRITE_TIMEOUT_MS);
        if (pendingFor(adapter).get(key) === pending)
          pendingFor(adapter).delete(key);
      } catch {
        /* the guard drops the entry on the next set */
      }
    };
    operation!.then(
      () => void finish(true),
      () => void finish(false)
    );
  }
  if (op === 'delete') {
    const pendingDelete: PendingSet = {
      settled: false,
      ok: false,
      tombstone: false,
    };
    pendingDeleteFor(adapter).set(key, pendingDelete);
    const settleDelete = async (landed: boolean) => {
      pendingDelete.ok = landed;
      pendingDelete.settled = true;
      try {
        await deadline(opts.journal.remove(key), WRITE_TIMEOUT_MS);
        if (pendingDeleteFor(adapter).get(key) === pendingDelete)
          pendingDeleteFor(adapter).delete(key);
      } catch {
        /* the guard drops the entry on the next set */
      }
    };
    operation!.then(
      () => void settleDelete(true),
      () => void settleDelete(false)
    );
  }
  try {
    const found = await boundedRead(adapter, key, ms);
    if (op === 'set' && found === value) return;
    if (op === 'delete' && found !== null)
      throw new WriteFailedError('Delete did not remove the key');
  } catch (error) {
    if (error instanceof WriteFailedError) throw error;
  }
  const entry: UnknownWriteEntry = {
    key,
    op,
    verifier: opts.verifier,
    attempt: opts.attempt ?? '',
    sessionId,
    at: Date.now(),
  };
  let journaled = false;
  try {
    await deadline(opts.journal.add(entry), ms);
    journaled = true;
  } catch {}
  throw new WriteOutcomeUnknownError(journaled, opts.context);
}
export function boundedSet(
  adapter: WriteAdapter,
  key: string,
  value: string,
  opts: WriteOptions
) {
  return perform(adapter, key, value, 'set', opts);
}
export function boundedDelete(
  adapter: WriteAdapter,
  key: string,
  opts: WriteOptions
) {
  return perform(adapter, key, undefined, 'delete', opts);
}
