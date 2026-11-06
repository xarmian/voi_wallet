import {
  StackActions,
  type NavigationAction,
  type NavigationState,
} from '@react-navigation/native';
import type { CallbackNavigation } from './callbackRegistry';

type NavigationLike = Pick<CallbackNavigation, 'canGoBack' | 'navigate'> & {
  dispatch(action: (state: NavigationState) => NavigationAction): void;
};

export interface ScopedNavigation extends CallbackNavigation {
  popOrReplace(name: string, params?: object): void;
}

/** Target the calling screen's stack so StackRouter honors its source route. */
export function scopedNavigation(navigation: NavigationLike): ScopedNavigation {
  const scoped: ScopedNavigation = {
    goBack: () =>
      navigation.dispatch((state) => ({
        ...StackActions.pop(1),
        target: state.key,
      })),
    replace: (name: string, params?: object) =>
      navigation.dispatch((state) => ({
        ...StackActions.replace(name, params),
        target: state.key,
      })),
    popOrReplace: (name, params) => {
      if (navigation.canGoBack()) scoped.goBack();
      else scoped.replace(name, params);
    },
    canGoBack: () => navigation.canGoBack(),
    navigate: (...args: Parameters<CallbackNavigation['navigate']>) =>
      navigation.navigate(...args),
  };
  return scoped;
}
