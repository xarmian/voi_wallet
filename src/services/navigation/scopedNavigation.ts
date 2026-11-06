import {
  StackActions,
  type NavigationAction,
  type NavigationState,
} from '@react-navigation/native';
import type { CallbackNavigation } from './callbackRegistry';

type NavigationLike = Pick<CallbackNavigation, 'canGoBack' | 'navigate'> & {
  dispatch(action: (state: NavigationState) => NavigationAction): void;
};

/** Target the calling screen's stack so StackRouter honors its source route. */
export function scopedNavigation(
  navigation: NavigationLike
): CallbackNavigation {
  return {
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
    canGoBack: () => navigation.canGoBack(),
    navigate: (...args: Parameters<CallbackNavigation['navigate']>) =>
      navigation.navigate(...args),
  };
}
