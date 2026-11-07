import { redactError } from '@/utils/logRedaction';
import { HandledOutcome, HandledRef, HandledStore } from './handledStore';
import {
  DeadlineSource,
  isPastDeadline,
  resolveDeadline,
} from './requestTiming';

export type RequestRef = HandledRef;
export type ExitReason =
  | 'declined'
  | 'abandoned'
  | 'background'
  | 'unsupported-method'
  | 'unsupported-accounts'
  | 'load-failed'
  | 'sign-failed'
  | 'expired'
  | 'timing-unknown'
  | 'busy'
  | 'lapsed'
  | 'setup-incomplete'
  | 'session-ended';

export interface AnswerError {
  code: number;
  message: string;
}

export const EXIT_ANSWERS: Record<
  Exclude<ExitReason, 'session-ended'>,
  AnswerError
> = {
  declined: { code: 5000, message: 'User rejected.' },
  abandoned: { code: 5000, message: 'User rejected.' },
  background: { code: 5000, message: 'User rejected.' },
  'unsupported-method': { code: 5101, message: 'Unsupported methods.' },
  'unsupported-accounts': { code: 5103, message: 'Unsupported accounts.' },
  'load-failed': { code: -32001, message: 'Request could not be reviewed.' },
  'sign-failed': { code: -32001, message: 'Signing failed.' },
  expired: { code: -32000, message: 'Request expired.' },
  'timing-unknown': {
    code: -32000,
    message: 'Cannot establish request time. Please retry.',
  },
  busy: {
    code: -32000,
    message: 'Wallet busy: too many pending requests. Please retry.',
  },
  lapsed: {
    code: -32000,
    message: 'Request ended.',
  },
  'setup-incomplete': {
    code: -32001,
    message: 'Wallet setup incomplete.',
  },
};

const OUTCOMES: Record<ExitReason, HandledOutcome> = {
  declined: 'rejected',
  abandoned: 'abandoned',
  background: 'abandoned',
  'unsupported-method': 'unsupported',
  'unsupported-accounts': 'unsupported',
  'load-failed': 'failed',
  'sign-failed': 'failed',
  expired: 'expired',
  'timing-unknown': 'failed',
  busy: 'failed',
  lapsed: 'expired',
  'setup-incomplete': 'failed',
  'session-ended': 'session-ended',
};

export interface CoordinatorTransport {
  rejectRequestV2(
    topic: string,
    id: number | string,
    error: AnswerError
  ): Promise<void>;
  rejectRequestV1(id: number | string, message: string): Promise<void>;
  rejectProposalV2(
    proposalId: number | string,
    pairingTopic: string,
    error: AnswerError
  ): Promise<void>;
  rejectProposalV1(): Promise<void>;
}

export type Admission =
  | {
      action: 'show';
      ref: RequestRef;
      firstSeenMs: number;
      deadlineMs: number;
      source: DeadlineSource;
    }
  | { action: 'suppressed'; reason: 'duplicate' | 'handled' }
  | { action: 'refused'; reason: Exclude<ExitReason, 'session-ended'> }
  | { action: 'expired' }
  | { action: 'unavailable' };

export type ClosedListener = (info: { reason: ExitReason }) => void;

/**
 * Asked once per new request or proposal, before anything is stored or shown.
 * A reason refuses it: the dApp is answered and nothing opens. Null admits it.
 */
export type EntryGuard = (
  ref: RequestRef
) => Promise<Exclude<ExitReason, 'session-ended'> | null>;

interface OpenRequest {
  ref: RequestRef;
  firstSeenMs: number;
  deadlineMs: number;
  source: DeadlineSource;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Set<ClosedListener>;
}

const keyOf = (ref: RequestRef): string =>
  JSON.stringify([ref.version, ref.kind, ref.topic, String(ref.id)]);

const notInstalled = async (): Promise<void> => {
  throw new Error('WalletConnect transport not installed');
};
const DEFAULT_TRANSPORT: CoordinatorTransport = {
  rejectRequestV2: notInstalled,
  rejectRequestV1: notInstalled,
  rejectProposalV2: notInstalled,
  rejectProposalV1: notInstalled,
};

// Transport and listener errors can embed bare topics/ids that redactError
// cannot recognise. Log a fixed diagnostic through the shared redactor instead.
const warn = (message: string): void => {
  console.warn('[RequestCoordinator]', redactError(new Error(message)));
};

export class RequestCoordinator {
  private static instance: RequestCoordinator | undefined;
  private readonly store: HandledStore;
  private transport: CoordinatorTransport;
  private entryGuard: EntryGuard | undefined;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private open = new Map<string, OpenRequest>();
  private closed = new Set<string>();
  private admitting = new Map<string, RequestRef>();
  private deciding = new Map<string, Promise<boolean>>();
  private answered = new Set<string>();
  private released = new Map<string, OpenRequest>();
  private unpublished = new Map<
    string,
    { ref: RequestRef; error: AnswerError }
  >();
  private retrying = new Map<string, Promise<boolean>>();

  constructor(
    deps: {
      store?: HandledStore;
      transport?: CoordinatorTransport;
      now?: () => number;
      setTimer?: typeof setTimeout;
      clearTimer?: typeof clearTimeout;
    } = {}
  ) {
    this.store = deps.store ?? HandledStore.getInstance();
    this.transport = deps.transport ?? DEFAULT_TRANSPORT;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  static getInstance(): RequestCoordinator {
    if (!this.instance) this.instance = new RequestCoordinator();
    return this.instance;
  }

  setTransport(transport: CoordinatorTransport): void {
    this.transport = transport;
  }

  setEntryGuard(guard: EntryGuard | undefined): void {
    this.entryGuard = guard;
  }

  async admit(ref: RequestRef, expiryTimestamp?: unknown): Promise<Admission> {
    const key = keyOf(ref);
    if (this.closed.has(key)) {
      await this.retryUnpublished(ref);
      return { action: 'suppressed', reason: 'handled' };
    }
    if (this.open.has(key) || this.admitting.has(key)) {
      return { action: 'suppressed', reason: 'duplicate' };
    }
    this.admitting.set(key, { ...ref });
    try {
      // Before a first-seen record is written or a deadline armed, so a refused
      // arrival leaves nothing open and nothing to expire. With no guard
      // installed this adds no await, so admission timing is unchanged.
      const refusal = this.entryGuard ? await this.refusalFor(ref) : null;
      if (refusal) {
        await this.settle(ref, refusal);
        return { action: 'refused', reason: refusal };
      }
      await this.store.load();
      if (this.store.isHandled(ref)) {
        this.closed.add(key);
        if (!this.answered.has(key)) {
          this.answered.add(key);
          await this.answer(ref, {
            code: -32000,
            message: 'Request already handled.',
          });
        }
        return { action: 'suppressed', reason: 'handled' };
      }
      const firstSeenMs = await this.store.noteSeen(ref);
      // A settle/decide may have closed this ref while storage was awaited.
      if (this.closed.has(key))
        return { action: 'suppressed', reason: 'handled' };
      const released = this.released.get(key);
      const { deadlineMs, source } =
        released ??
        resolveDeadline({
          expiryTimestamp,
          firstSeenMs,
        });
      this.clearEntry(released);
      this.released.delete(key);
      if (isPastDeadline(deadlineMs, this.now())) {
        await this.settle(ref, 'expired');
        return { action: 'expired' };
      }
      const entry: OpenRequest = {
        ref: { ...ref },
        firstSeenMs,
        deadlineMs,
        source,
        listeners: new Set(),
      };
      this.open.set(key, entry);
      this.armTimer(entry);
      return { action: 'show', ref, firstSeenMs, deadlineMs, source };
    } catch {
      await this.sendError(ref, 'timing-unknown');
      return { action: 'unavailable' };
    } finally {
      this.admitting.delete(key);
    }
  }

  private async refusalFor(
    ref: RequestRef
  ): Promise<Exclude<ExitReason, 'session-ended'> | null> {
    if (!this.entryGuard) return null;
    try {
      return await this.entryGuard(ref);
    } catch {
      // Guard errors can embed topics the redactor cannot recognise, so only a
      // fixed message is logged. An unreadable guard admits the request.
      warn('Entry guard could not be read');
      return null;
    }
  }

  release(ref: RequestRef): void {
    const key = keyOf(ref);
    const entry = this.open.get(key);
    if (!entry) return;
    this.open.delete(key);
    entry.listeners.clear();
    this.released.set(key, entry);
  }

  isOpen(ref: RequestRef): boolean {
    return this.open.has(keyOf(ref));
  }

  hasOpenV1Proposal(): boolean {
    return [
      ...[...this.open.values(), ...this.released.values()].map(
        (entry) => entry.ref
      ),
      ...this.admitting.values(),
    ].some((ref) => ref.version === 1 && ref.kind === 'proposal');
  }

  describe(ref: RequestRef): {
    firstSeenMs: number;
    deadlineMs: number;
    source: DeadlineSource;
  } | null {
    const entry = this.open.get(keyOf(ref));
    if (!entry) return null;
    return {
      firstSeenMs: entry.firstSeenMs,
      deadlineMs: entry.deadlineMs,
      source: entry.source,
    };
  }

  isLive(ref: RequestRef): boolean {
    const entry = this.open.get(keyOf(ref));
    return entry !== undefined && !isPastDeadline(entry.deadlineMs, this.now());
  }

  async ensureOpen(
    ref: RequestRef,
    expiryTimestamp?: unknown
  ): Promise<'open' | 'expired' | 'handled' | 'unavailable'> {
    const entry = this.open.get(keyOf(ref));
    if (entry) {
      if (!isPastDeadline(entry.deadlineMs, this.now())) return 'open';
      await this.settle(ref, 'expired');
      return 'expired';
    }
    const admission = await this.admit(ref, expiryTimestamp);
    if (admission.action === 'show') return 'open';
    if (admission.action === 'suppressed')
      return admission.reason === 'duplicate' ? 'open' : 'handled';
    if (admission.action === 'refused') return 'handled';
    return admission.action;
  }

  async settle(
    ref: RequestRef,
    reason: ExitReason
  ): Promise<'settled' | 'already-settled'> {
    const key = keyOf(ref);
    const decision = this.deciding.get(key);
    if (decision) {
      try {
        await decision;
      } catch {
        // A failed decision write leaves settlement available.
      }
    }
    if (this.closed.has(key)) return 'already-settled';
    this.close(ref, reason);
    let recorded = true;
    try {
      recorded = await this.store.markHandled(ref, OUTCOMES[reason]);
    } catch {
      // Still answer when durability is unavailable.
      warn('Request decision could not be recorded');
    }
    if (recorded && reason !== 'session-ended') {
      await this.sendError(ref, reason);
    }
    return 'settled';
  }

  async decide(
    ref: RequestRef,
    outcome: 'approved' | 'failed'
  ): Promise<boolean> {
    const key = keyOf(ref);
    const entry = this.open.get(key);
    if (!entry || this.closed.has(key) || this.deciding.has(key)) return false;
    if (isPastDeadline(entry.deadlineMs, this.now())) {
      await this.settle(ref, 'expired');
      return false;
    }
    const decision = (async () => {
      // A failed write leaves the request open, so the caller can retry.
      const recorded = await this.store.markHandled(ref, outcome);
      this.closed.add(key);
      this.open.delete(key);
      this.clearEntry(entry);
      entry.listeners.clear();
      return recorded;
    })();
    this.deciding.set(key, decision);
    try {
      return await decision;
    } finally {
      this.deciding.delete(key);
    }
  }

  async sendError(
    ref: RequestRef,
    reason: Exclude<ExitReason, 'session-ended'>
  ): Promise<void> {
    const key = keyOf(ref);
    if (this.answered.has(key)) return;
    this.answered.add(key);
    this.close(ref, reason);
    await this.answer(ref, EXIT_ANSWERS[reason]);
  }

  private close(ref: RequestRef, reason: ExitReason): void {
    const key = keyOf(ref);
    this.closed.add(key);
    const entry = this.open.get(key) ?? this.released.get(key);
    this.open.delete(key);
    this.released.delete(key);
    this.clearEntry(entry);
    for (const listener of entry?.listeners ?? []) {
      try {
        listener({ reason });
      } catch {
        warn('Request close listener failed');
      }
    }
    entry?.listeners.clear();
  }

  async retryUnpublished(ref: RequestRef): Promise<boolean> {
    const key = keyOf(ref);
    const pending = this.retrying.get(key);
    if (pending) return pending;
    const unpublished = this.unpublished.get(key);
    if (!unpublished) return false;
    const retry = this.answer(unpublished.ref, unpublished.error);
    this.retrying.set(key, retry);
    try {
      return await retry;
    } finally {
      this.retrying.delete(key);
    }
  }

  private async answer(ref: RequestRef, error: AnswerError): Promise<boolean> {
    const key = keyOf(ref);
    try {
      if (ref.kind === 'request') {
        if (ref.version === 2) {
          await this.transport.rejectRequestV2(ref.topic, ref.id, error);
        } else {
          await this.transport.rejectRequestV1(ref.id, error.message);
        }
      } else if (ref.version === 2) {
        await this.transport.rejectProposalV2(ref.id, ref.topic, error);
      } else {
        await this.transport.rejectProposalV1();
      }
      this.unpublished.delete(key);
      return true;
    } catch {
      this.unpublished.set(key, { ref: { ...ref }, error });
      warn('WalletConnect answer could not be published');
      return false;
    }
  }

  subscribe(ref: RequestRef, listener: ClosedListener): () => void {
    const entry = this.open.get(keyOf(ref));
    entry?.listeners.add(listener);
    return () => entry?.listeners.delete(listener);
  }

  async onSessionEnded(topic: string): Promise<void> {
    await Promise.all(
      [...this.open.values(), ...this.released.values()]
        .filter((entry) => entry.ref.topic === topic)
        .map((entry) => this.settle(entry.ref, 'session-ended'))
    );
  }

  private armTimer(entry: OpenRequest): void {
    const delay = Math.max(0, entry.deadlineMs - this.now());
    entry.timer = this.setTimer(
      () => {
        const key = keyOf(entry.ref);
        if (this.open.get(key) !== entry && this.released.get(key) !== entry)
          return;
        // Recheck both clamped waits and wall-clock changes before expiring.
        if (!isPastDeadline(entry.deadlineMs, this.now())) {
          this.armTimer(entry);
          return;
        }
        void this.settle(entry.ref, 'expired').catch(() => {
          warn('Request expiry could not be recorded');
        });
      },
      Math.min(delay, 2_147_483_000)
    );
    if (typeof entry.timer === 'object' && entry.timer !== null) {
      entry.timer.unref?.();
    }
  }

  private clearEntry(entry: OpenRequest | undefined): void {
    if (entry?.timer !== undefined) this.clearTimer(entry.timer);
  }

  __resetForTests(): void {
    for (const entry of [...this.open.values(), ...this.released.values()]) {
      this.clearEntry(entry);
      entry.listeners.clear();
    }
    this.open.clear();
    this.closed.clear();
    this.admitting.clear();
    this.deciding.clear();
    this.answered.clear();
    this.released.clear();
    this.unpublished.clear();
    this.retrying.clear();
  }
}
