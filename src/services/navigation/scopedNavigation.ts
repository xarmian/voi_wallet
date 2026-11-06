import {
  StackActions,
  type NavigationAction,
  type NavigationState,
} from '@react-navigation/native';
import type { CallbackNavigation } from './callbackRegistry';

type NavigationLike = Pick<CallbackNavigation, 'canGoBack' | 'navigate'> & {
  getState(): NavigationState;
  dispatch(action: (state: NavigationState) => NavigationAction): void;
};

export interface ScopedNavigation extends CallbackNavigation {
  popOrReplace(name: string, params?: object): boolean;
}

/** Target the calling screen's stack so StackRouter honors its source route. */
export function scopedNavigation(
  navigation: NavigationLike,
  routeKey?: string
): ScopedNavigation {
  const isPresent = () =>
    routeKey === undefined ||
    navigation.getState().routes.some((route) => route.key === routeKey);
  const scoped: ScopedNavigation = {
    goBack: () => {
      if (!isPresent()) return false;
      navigation.dispatch((state) => ({
        ...StackActions.pop(1),
        target: state.key,
      }));
      return true;
    },
    replace: (name: string, params?: object) => {
      if (!isPresent()) return false;
      navigation.dispatch((state) => ({
        ...StackActions.replace(name, params),
        target: state.key,
      }));
      return true;
    },
    popOrReplace: (name, params) =>
      navigation.canGoBack() ? scoped.goBack() : scoped.replace(name, params),
    canGoBack: () => navigation.canGoBack(),
    navigate: (...args: Parameters<CallbackNavigation['navigate']>) =>
      navigation.navigate(...args),
  };
  return scoped;
}
