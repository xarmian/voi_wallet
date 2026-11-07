import { redactError } from '@/utils/logRedaction';
import { RequestCoordinator } from './requestCoordinator';
import { describeApproved, describeClose } from './resultCopy';
import type { ExitReason, RequestRef } from './requestCoordinator';

export interface QueueDapp {
  name?: string;
  url?: string;
  icon?: string;
}

export interface QueueItem {
  ref: RequestRef;
  kind: 'request' | 'proposal';
  payload: unknown;
  dapp?: QueueDapp;
  network?: string;
  firstSeenMs: number;
  sentAtMs?: number | null;
  arrivalSeq: number;
}

export interface QueueResult {
  ref: RequestRef;
  title: string;
  message?: string;
}

export interface QueueSnapshot {
  readonly head: QueueItem | null;
  readonly result: QueueResult | null;
  readonly waiting: readonly QueueItem[];
  readonly revision: number;
}

export interface QueueCoordinator {
  isOpen(ref: RequestRef): boolean;
  subscribe(
    ref: RequestRef,
    listener: (info: { reason: ExitReason }) => void
  ): () => void;
}

const keyOf = (ref: RequestRef): string =>
  JSON.stringify([ref.version, ref.kind, ref.topic, String(ref.id)]);

export class RequestQueue {
  private static instance: RequestQueue | undefined;
  private readonly coordinator: QueueCoordinator;
  private readonly describeClose: (
    reason: ExitReason,
    kind: 'request' | 'proposal'
  ) => {
    title: string;
    message?: string;
  };
  private readonly describeApproved: (kind: 'request' | 'proposal') => {
    title: string;
    message?: string;
  };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers = new Map<string, () => void>();
  private nextArrivalSeq = 1;
  private snapshot: QueueSnapshot = Object.freeze({
    head: null,
    result: null,
    waiting: Object.freeze([]),
    revision: 0,
  });

  constructor(
    deps: {
      coordinator?: QueueCoordinator;
      describeClose?: (
        reason: ExitReason,
        kind: 'request' | 'proposal'
      ) => {
        title: string;
        message?: string;
      };
      describeApproved?: (kind: 'request' | 'proposal') => {
        title: string;
        message?: string;
      };
    } = {}
  ) {
    this.coordinator = deps.coordinator ?? RequestCoordinator.getInstance();
    this.describeClose = deps.describeClose ?? describeClose;
    this.describeApproved = deps.describeApproved ?? describeApproved;
  }

  static getInstance(): RequestQueue {
    if (!this.instance) this.instance = new RequestQueue();
    return this.instance;
  }

  push(
    item: Omit<QueueItem, 'arrivalSeq' | 'kind'>
  ): 'head' | 'queued' | 'duplicate' | 'not-open' {
    if (!this.coordinator.isOpen(item.ref)) return 'not-open';
    const key = keyOf(item.ref);
    if (this.unsubscribers.has(key)) return 'duplicate';

    // Copy queue metadata so callers cannot mutate a published snapshot. The
    // SDK payload stays opaque and is neither inspected nor frozen here.
    const queued: QueueItem = Object.freeze({
      ...item,
      ref: Object.freeze({ ...item.ref }),
      kind: item.ref.kind,
      dapp: item.dapp ? Object.freeze({ ...item.dapp }) : undefined,
      arrivalSeq: this.nextArrivalSeq++,
    });
    this.unsubscribers.set(
      key,
      this.coordinator.subscribe(queued.ref, ({ reason }) => {
        this.onClose(queued.ref, reason);
      })
    );
    // Admission and placement run in the same stack: another push can only
    // observe this item after its place in the mixed FIFO has been reserved.
    if (!this.snapshot.head && !this.snapshot.result) {
      this.update({ ...this.snapshot, head: queued });
      return 'head';
    }
    this.update({
      ...this.snapshot,
      waiting: [...this.snapshot.waiting, queued],
    });
    return 'queued';
  }

  finish(
    ref: RequestRef,
    result: { title: string; message?: string }
  ): boolean {
    const head = this.snapshot.head;
    if (!head || keyOf(head.ref) !== keyOf(ref)) return false;
    this.unsubscribeRef(head.ref);
    this.update({
      ...this.snapshot,
      head: null,
      result: Object.freeze({
        ref: head.ref,
        title: result.title,
        message: result.message,
      }),
    });
    return true;
  }

  amendResult(
    ref: RequestRef,
    result: { title: string; message?: string }
  ): boolean {
    const current = this.snapshot.result;
    if (!current || keyOf(current.ref) !== keyOf(ref)) return false;
    this.update({
      ...this.snapshot,
      result: Object.freeze({
        ref: current.ref,
        title: result.title,
        message: result.message,
      }),
    });
    return true;
  }

  closeHead(ref: RequestRef, reason: ExitReason): boolean {
    return this.finish(ref, this.describeClose(reason, ref.kind));
  }

  /** Finish the head after the person approved it. */
  finishApproved(ref: RequestRef): boolean {
    return this.finish(ref, this.describeApproved(ref.kind));
  }

  advance(): boolean {
    if (!this.snapshot.result || this.snapshot.waiting.length === 0)
      return false;
    this.update({
      head: this.snapshot.waiting[0],
      result: null,
      waiting: this.snapshot.waiting.slice(1),
    });
    return true;
  }

  dismissResult(): boolean {
    if (!this.snapshot.result || this.snapshot.waiting.length !== 0)
      return false;
    this.update({ ...this.snapshot, result: null });
    return true;
  }

  getSnapshot(): QueueSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onClose(ref: RequestRef, reason: ExitReason): void {
    const key = keyOf(ref);
    if (this.snapshot.head && keyOf(this.snapshot.head.ref) === key) {
      this.finish(ref, this.describeClose(reason, ref.kind));
      return;
    }
    const waiting = this.snapshot.waiting.filter(
      (item) => keyOf(item.ref) !== key
    );
    if (waiting.length === this.snapshot.waiting.length) return;
    this.unsubscribeRef(ref);
    this.update({ ...this.snapshot, waiting });
  }

  private unsubscribeRef(ref: RequestRef): void {
    const key = keyOf(ref);
    const unsubscribe = this.unsubscribers.get(key);
    this.unsubscribers.delete(key);
    unsubscribe?.();
  }

  private update(next: Omit<QueueSnapshot, 'revision'>): void {
    this.snapshot = Object.freeze({
      ...next,
      waiting: Object.freeze([...next.waiting]),
      revision: this.snapshot.revision + 1,
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Arbitrary listener errors may contain bare identities or payloads
        // that the redactor cannot recognize. Only log a fixed diagnostic.
        console.warn(
          '[RequestQueue]',
          redactError(new Error('Request queue listener failed'))
        );
      }
    }
  }

  __resetForTests(): void {
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.nextArrivalSeq = 1;
    if (
      this.snapshot.head ||
      this.snapshot.result ||
      this.snapshot.waiting.length
    ) {
      this.update({ head: null, result: null, waiting: [] });
    }
  }
}
