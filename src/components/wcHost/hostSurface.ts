import type { RequestQueue } from '@/services/walletconnect/requestQueue';
import type { HeadSession, SignRequestSurface } from './headSession';

export function createHostSurface(
  session: HeadSession,
  queue: RequestQueue
): SignRequestSurface {
  return {
    advancesToNext: false,
    presentReview: (params) => session.presentReview(params),
    presentError: (message) => {
      if (!queue.finish(session.item.ref, { title: message }))
        queue.amendResult(session.item.ref, { title: message });
      session.end();
    },
    adoptNavigation: () => {},
    takeNext: async (approved) => {
      session.closeInQueue(queue, approved === true);
      session.end();
      return { request: null, remaining: queue.getSnapshot().waiting.length };
    },
    queueSize: async () => queue.getSnapshot().waiting.length,
    leave: () => {},
  };
}
