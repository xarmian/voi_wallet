import {
  scopedNavigation,
  type ScopedNavigation,
} from '@/services/navigation/scopedNavigation';

type RouterNavigation = Parameters<typeof scopedNavigation>[0] & {
  goBack(): void;
  addListener(event: 'beforeRemove', listener: () => void): () => void;
};

/**
 * Everything a WalletConnect review body needs from the thing that presents it.
 * A route screen builds one from its router; a surface that is not a route
 * builds its own. The bodies themselves take no route or navigation props.
 *
 * Not everything they render is router-free: the signing review mounts
 * UnifiedTransactionAuthModal, whose AnimatedQRScanner calls useFocusEffect and
 * so needs a navigation context. A surface without a router must provide one
 * (or that path must stop using it) before it presents TransactionReview.
 */
export interface ReviewBinding {
  /** Navigation scoped to the presenting surface (see scopedNavigation). */
  nav: ScopedNavigation;
  /**
   * The unscoped fallback used only when a review has no caller callback
   * (in-app reviews). WalletConnect reviews always have one.
   */
  navigation: {
    canGoBack(): boolean;
    goBack(): void;
    navigate: (...args: any[]) => void;
  };
  /** Called when the presenting surface is removed, however it was left. */
  onLeave(listener: () => void): () => void;
}

export function routeReviewBinding(
  navigation: RouterNavigation,
  routeKey: string
): ReviewBinding {
  return {
    nav: scopedNavigation(navigation, routeKey),
    navigation,
    onLeave: (listener) => navigation.addListener('beforeRemove', listener),
  };
}
