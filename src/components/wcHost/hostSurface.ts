import type { RequestQueue } from '@/services/walletconnect/requestQueue';
import type { HeadSession, SignRequestSurface } from './headSession';

export function createHostSurface(
  session: HeadSession,
  queue: RequestQueue
): SignRequestSurface {
  return {
    presentReview: (params) => session.presentReview(params),
    presentError: (message) => {
      queue.finish(session.item.ref, { title: message });
      session.end();
    },
    adoptNavigation: () => {},
    takeNext: async () => {
      queue.closeHead(session.item.ref, session.lastReason ?? 'declined');
      session.end();
      return { request: null, remaining: queue.getSnapshot().waiting.length };
    },
    queueSize: async () => queue.getSnapshot().waiting.length,
    leave: () => {},
  };
}
