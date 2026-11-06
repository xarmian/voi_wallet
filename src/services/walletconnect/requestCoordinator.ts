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
    message: 'Approval ended before signing finished.',
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
  | { action: 'suppressed' }
  | { action: 'expired' }
  | { action: 'unavailable' };

export type ClosedListener = (info: { reason: ExitReason }) => void;

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
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private open = new Map<string, OpenRequest>();
  private closed = new Set<string>();
  private admitting = new Set<string>();
  private deciding = new Set<string>();

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

  async admit(ref: RequestRef, expiryTimestamp?: unknown): Promise<Admission> {
    const key = keyOf(ref);
    if (this.open.has(key) || this.admitting.has(key)) {
      return { action: 'suppressed' };
    }
    this.admitting.add(key);
    try {
      await this.store.load();
      if (this.store.isHandled(ref)) {
        await this.answer(ref, {
          code: -32000,
          message: 'Request already handled.',
        });
        return { action: 'suppressed' };
      }
      const firstSeenMs = await this.store.noteSeen(ref);
      // A settle/decide may have closed this ref while storage was awaited.
      if (this.closed.has(key)) return { action: 'suppressed' };
      const { deadlineMs, source } = resolveDeadline({
        expiryTimestamp,
        firstSeenMs,
      });
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

  isOpen(ref: RequestRef): boolean {
    return this.open.has(keyOf(ref));
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

  async settle(
    ref: RequestRef,
    reason: ExitReason
  ): Promise<'settled' | 'already-settled'> {
    const key = keyOf(ref);
    if (this.closed.has(key)) return 'already-settled';
    this.closed.add(key);
    const entry = this.open.get(key);
    this.open.delete(key);
    try {
      let recorded = true;
      try {
        recorded = await this.store.markHandled(ref, OUTCOMES[reason]);
      } catch {
        // The decision could not be made durable, but the dApp must still be
        // answered; a redelivery after a restart can show the request once more.
        warn('Request decision could not be recorded');
      }
      if (recorded && reason !== 'session-ended') {
        await this.sendError(ref, reason);
      }
      return 'settled';
    } finally {
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
  }

  async decide(
    ref: RequestRef,
    outcome: 'approved' | 'failed'
  ): Promise<boolean> {
    const key = keyOf(ref);
    if (this.closed.has(key) || this.deciding.has(key)) return false;
    this.deciding.add(key);
    try {
      // A failed write leaves the request open, so the caller can retry.
      const recorded = await this.store.markHandled(ref, outcome);
      this.closed.add(key);
      const entry = this.open.get(key);
      this.open.delete(key);
      this.clearEntry(entry);
      entry?.listeners.clear();
      return recorded;
    } finally {
      this.deciding.delete(key);
    }
  }

  async sendError(
    ref: RequestRef,
    reason: Exclude<ExitReason, 'session-ended'>
  ): Promise<void> {
    await this.answer(ref, EXIT_ANSWERS[reason]);
  }

  private async answer(ref: RequestRef, error: AnswerError): Promise<void> {
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
    } catch {
      warn('WalletConnect answer could not be published');
    }
  }

  subscribe(ref: RequestRef, listener: ClosedListener): () => void {
    const entry = this.open.get(keyOf(ref));
    entry?.listeners.add(listener);
    return () => entry?.listeners.delete(listener);
  }

  async onSessionEnded(topic: string): Promise<void> {
    await Promise.all(
      [...this.open.values()]
        .filter((entry) => entry.ref.topic === topic)
        .map((entry) => this.settle(entry.ref, 'session-ended'))
    );
  }

  private armTimer(entry: OpenRequest): void {
    const delay = Math.max(0, entry.deadlineMs - this.now());
    entry.timer = this.setTimer(
      () => {
        if (this.open.get(keyOf(entry.ref)) !== entry) return;
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
    for (const entry of this.open.values()) {
      this.clearEntry(entry);
      entry.listeners.clear();
    }
    this.open.clear();
    this.closed.clear();
    this.admitting.clear();
    this.deciding.clear();
  }
}
