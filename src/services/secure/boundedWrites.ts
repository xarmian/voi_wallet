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
const failedJournals = new WeakSet<UnknownJournal>();
let processSessionId: Promise<string> | undefined;
function currentSessionId(): Promise<string> {
  processSessionId ??= (async () => {
    const bytes = platformCrypto?.getRandomBytes
      ? await platformCrypto.getRandomBytes(16)
      : globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
      ''
    );
  })();
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
  if (failedJournals.has(journal))
    throw new WriteUnresolvedError('Write cannot be resolved this session');
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
    let matches = false;
    if (entry.op === 'set' && entry.verifier === 'nonce' && value != null) {
      try {
        matches = JSON.parse(value).writeNonce === entry.attempt;
      } catch {
        /* Unproven. */
      }
    }
    if (!matches)
      throw new WriteUnresolvedError('Unknown write may still land');
  }
  try {
    await deadline(journal.remove(key), ms);
  } catch {
    failedJournals.add(journal);
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
  await assertKeyResolved(opts.journal, adapter, key, opts);
  const sessionId = opts.sessionId ?? (await currentSessionId());
  let operation: Promise<void>;
  try {
    operation =
      op === 'set'
        ? adapter.setItem(key, value!)
        : adapter.deleteItem
          ? adapter.deleteItem(key)
          : adapter.removeItem!(key);
    await deadline(operation, ms);
    return;
  } catch (error) {
    if (!(error instanceof DeadlineError))
      throw new WriteFailedError('Write rejected');
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
  } catch {
    failedJournals.add(opts.journal);
  }
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
