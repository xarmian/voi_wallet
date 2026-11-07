import type {
  QueueCoordinator,
  QueueItem,
  RequestQueue,
} from '@/services/walletconnect/requestQueue';
import type {
  ExitReason,
  RequestRef,
} from '@/services/walletconnect/requestCoordinator';
import type { ReviewBinding } from '@/services/walletconnect/reviewBinding';
import {
  SignRequestController,
  type SigningReviewParams,
} from '@/services/walletconnect/signRequestController';
import { createHostBinding } from './hostBinding';
import { createHostSurface } from './hostSurface';

export const headKey = (ref: RequestRef): string =>
  JSON.stringify([ref.version, ref.kind, ref.topic, String(ref.id)]);

const sessions = new Map<string, HeadSession>();

export class HeadSession {
  readonly key: string;
  readonly binding: ReviewBinding;
  readonly controller?: SignRequestController;
  lastReason?: ExitReason;
  /** True once a review body has been drawn for this head. */
  drawn = false;

  markDrawn(): void {
    this.drawn = true;
  }
  private ended = false;
  private started = false;
  private params: SigningReviewParams | null = null;
  private readonly leaves = new Set<() => void>();
  private readonly listeners = new Set<() => void>();
  private unsubscribeQueue?: () => void;
  private unsubscribeCoordinator?: () => void;

  constructor(
    readonly item: QueueItem,
    deps: { queue: RequestQueue; coordinator: QueueCoordinator }
  ) {
    this.key = headKey(item.ref);
    this.binding = createHostBinding(this, deps);
    this.unsubscribeCoordinator = deps.coordinator.subscribe(
      item.ref,
      ({ reason }) => {
        this.lastReason = reason;
      }
    );
    this.unsubscribeQueue = deps.queue.subscribe(() => {
      const head = deps.queue.getSnapshot().head;
      // A coordinator close reaches this queue listener before the review's own
      // coordinator listener has marked its request decided. Ending in a
      // microtask lets that listener finish first, so onLeave cannot abandon a
      // request the coordinator has already closed.
      if (!head || headKey(head.ref) !== this.key)
        queueMicrotask(() => this.end());
    });
    if (item.kind === 'request') {
      this.controller = new SignRequestController({
        requestEvent: item.payload,
        version: item.ref.version,
        surface: createHostSurface(this, deps.queue),
      });
    }
  }

  start(): void {
    if (this.started || this.ended) return;
    this.started = true;
    void this.controller?.start();
  }

  /**
   * Finish this head in the queue with the right description. A coordinator
   * close tells the session its reason. Otherwise the caller says whether the
   * person's approval went through (the signed answer reached the dApp, or the
   * connection succeeded); any other exit reads abandoned.
   */
  closeInQueue(queue: RequestQueue, approved = false): boolean {
    const { ref } = this.item;
    if (this.lastReason) return queue.closeHead(ref, this.lastReason);
    return approved
      ? queue.finishApproved(ref)
      : queue.closeHead(ref, 'abandoned');
  }

  getReviewParams = (): SigningReviewParams | null => this.params;

  presentReview(params: SigningReviewParams): void {
    if (this.ended) return;
    this.params = params;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onLeave = (listener: () => void): (() => void) => {
    if (!this.ended) this.leaves.add(listener);
    return () => {
      this.leaves.delete(listener);
    };
  };

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.unsubscribeQueue?.();
    this.unsubscribeCoordinator?.();
    sessions.delete(this.key);
    const listeners = [...this.leaves];
    this.leaves.clear();
    this.listeners.clear();
    try {
      for (const listener of listeners) listener();
    } finally {
      this.controller?.dispose();
    }
  }
}

export function findHeadSession(item: QueueItem): HeadSession | undefined {
  return sessions.get(headKey(item.ref));
}

export function getHeadSession(
  item: QueueItem,
  deps: { queue: RequestQueue; coordinator: QueueCoordinator }
): HeadSession {
  const key = headKey(item.ref);
  let session = sessions.get(key);
  if (!session) {
    session = new HeadSession(item, deps);
    sessions.set(key, session);
  }
  return session;
}

export type { SignRequestSurface } from '@/services/walletconnect/signRequestController';
