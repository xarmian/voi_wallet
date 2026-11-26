import type { RequestQueue } from '@/services/walletconnect/requestQueue';
import type { ReviewBinding } from '@/services/walletconnect/reviewBinding';
import { headKey, type HeadSession } from './headSession';

const bindings = new WeakMap<HeadSession, ReviewBinding>();
const refuse = (): never => {
  throw new Error('WalletConnect host cannot navigate');
};

export function createHostBinding(
  session: HeadSession,
  { queue }: { queue: RequestQueue }
): ReviewBinding {
  const existing = bindings.get(session);
  if (existing) return existing;
  const isHead = () => {
    const head = queue.getSnapshot().head;
    return !!head && headKey(head.ref) === session.key;
  };
  const finish = (approved: boolean) => {
    if (!isHead()) {
      // The person left while the approval was still in flight and it then
      // went through: correct the card the early exit wrote.
      return approved ? queue.amendApproved(session.item.ref) : false;
    }
    session.closeInQueue(queue, approved);
    session.end();
    return true;
  };
  const binding: ReviewBinding = {
    nav: {
      goBack: () => finish(false),
      // Only the connect review's success path pops to Main.
      popOrReplace: () => finish(true),
      replace: () => false,
      canGoBack: isHead,
      navigate: refuse,
    },
    navigation: { canGoBack: refuse, goBack: refuse, navigate: refuse },
    onLeave: session.onLeave,
  };
  bindings.set(session, binding);
  return binding;
}
