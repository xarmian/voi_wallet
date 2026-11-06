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
 * A route screen builds one from its router; a host that is not a route builds
 * its own. The review bodies never see a route or a router.
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
