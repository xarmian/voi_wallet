import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { redactError } from '@/utils/logRedaction';

export type HandledKind = 'request' | 'proposal';
export type HandledOutcome =
  | 'approved'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'abandoned'
  | 'session-ended'
  | 'unsupported';

export interface HandledRef {
  version: 1 | 2;
  kind: HandledKind;
  topic: string;
  id: number | string;
}

interface Entry {
  h: string;
  s: number;
  d?: number;
  o?: HandledOutcome;
}

export const HANDLED_STORE_MAX_ENTRIES = 2000;
// Seen-only identities support the five minute wait; retain them for one hour.
export const SEEN_ONLY_TTL_MS = 60 * 60 * 1000;
const STORAGE_KEY = '@walletconnect_handled_v1';
const OUTCOMES: readonly HandledOutcome[] = [
  'approved',
  'rejected',
  'failed',
  'expired',
  'abandoned',
  'session-ended',
  'unsupported',
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const identityHash = (ref: HandledRef): string =>
  bytesToHex(
    sha256(
      utf8ToBytes(
        JSON.stringify([ref.version, ref.kind, ref.topic, String(ref.id)])
      )
    )
  );

export class HandledStore {
  private static instance: HandledStore | undefined;
  private readonly storage: Pick<
    typeof AsyncStorage,
    'getItem' | 'setItem' | 'removeItem'
  >;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private entries = new Map<string, Entry>();
  private loaded = false;
  private loading: Promise<void> | undefined;
  private mutex: Promise<void> = Promise.resolve();

  constructor(
    deps: {
      storage?: Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;
      now?: () => number;
      /** Test-only override to exercise eviction without thousands of writes. */
      maxEntries?: number;
    } = {}
  ) {
    this.storage = deps.storage ?? AsyncStorage;
    this.now = deps.now ?? Date.now;
    this.maxEntries = deps.maxEntries ?? HANDLED_STORE_MAX_ENTRIES;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('HandledStore maxEntries must be a positive integer');
    }
  }

  static getInstance(): HandledStore {
    if (!this.instance) this.instance = new HandledStore();
    return this.instance;
  }

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.loadStored().catch((error: unknown) => {
        this.loading = undefined;
        throw error;
      });
    }
    return this.loading;
  }

  private async loadStored(): Promise<void> {
    const raw = await this.storage.getItem(STORAGE_KEY);
    let entries: Entry[] = [];
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.e)) {
          throw new Error('Invalid handled store');
        }
        for (const value of parsed.e as unknown[]) {
          if (
            !isObject(value) ||
            typeof value.h !== 'string' ||
            typeof value.s !== 'number' ||
            !Number.isFinite(value.s)
          ) {
            throw new Error('Invalid handled entry');
          }
          if (
            (value.d !== undefined &&
              (typeof value.d !== 'number' || !Number.isFinite(value.d))) ||
            (value.o !== undefined &&
              !OUTCOMES.includes(value.o as HandledOutcome))
          ) {
            continue;
          }
          // Copy only the schema fields, never arbitrary stored properties.
          entries.push({
            h: value.h,
            s: value.s,
            ...(value.d !== undefined ? { d: value.d as number } : {}),
            ...(value.o !== undefined ? { o: value.o as HandledOutcome } : {}),
          });
        }
      } catch {
        entries = [];
        // Neither JSON parser diagnostics nor the stored bytes are safe to log.
        console.warn(
          '[HandledStore]',
          redactError(new Error('Invalid handled storage; clearing'))
        );
        await this.storage.removeItem(STORAGE_KEY);
      }
    }
    this.entries = new Map(entries.map((entry) => [entry.h, entry]));
    this.loaded = true;
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutex.then(operation);
    this.mutex = pending.then(
      () => {},
      () => {}
    );
    return pending;
  }

  private requireLoaded(): void {
    if (!this.loaded) throw new Error('HandledStore not loaded');
  }

  async noteSeen(ref: HandledRef): Promise<number> {
    await this.load();
    return this.withLock(async () => {
      const h = identityHash(ref);
      const existing = this.entries.get(h);
      if (existing) return existing.s;
      const s = this.now();
      await this.write({ h, s });
      return s;
    });
  }

  isHandled(ref: HandledRef): boolean {
    this.requireLoaded();
    return this.entries.get(identityHash(ref))?.d !== undefined;
  }

  async markHandled(
    ref: HandledRef,
    outcome: HandledOutcome
  ): Promise<boolean> {
    await this.load();
    return this.withLock(async () => {
      const h = identityHash(ref);
      const existing = this.entries.get(h);
      if (existing?.d !== undefined) return false;
      const d = this.now();
      await this.write({ h, s: existing?.s ?? d, d, o: outcome });
      return true;
    });
  }

  firstSeen(ref: HandledRef): number | null {
    this.requireLoaded();
    return this.entries.get(identityHash(ref))?.s ?? null;
  }

  private async write(entry: Entry): Promise<void> {
    const next = new Map(this.entries);
    next.set(entry.h, entry);
    if (next.size > this.maxEntries) {
      const now = this.now();
      for (const candidate of next.values()) {
        if (
          candidate.h !== entry.h &&
          candidate.d === undefined &&
          now - candidate.s > SEEN_ONLY_TTL_MS
        ) {
          next.delete(candidate.h);
        }
      }
      const oldest = [...next.values()]
        .filter((candidate) => candidate.h !== entry.h)
        .sort((a, b) => (a.d ?? a.s) - (b.d ?? b.s));
      for (const candidate of oldest) {
        if (next.size <= this.maxEntries) break;
        next.delete(candidate.h);
      }
    }
    await this.storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: 1, e: [...next.values()] })
    );
    // Publish only after durability: a rejection leaves entries and evictions intact.
    this.entries = next;
  }

  __resetForTests(): void {
    this.entries.clear();
    this.loaded = false;
    this.loading = undefined;
    this.mutex = Promise.resolve();
  }
}
