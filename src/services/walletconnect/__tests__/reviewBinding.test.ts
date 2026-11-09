import type {
  NavigationAction,
  NavigationState,
} from '@react-navigation/native';
import { routeReviewBinding } from '../reviewBinding';

function fakeRouter(routes: { key: string }[] = [{ key: 'R' }]) {
  const dispatched: NavigationAction[] = [];
  const listeners = new Set<() => void>();
  const navigation = {
    getState: () => ({ key: 'stack', routes }) as unknown as NavigationState,
    dispatch: jest.fn((thunk: (state: NavigationState) => NavigationAction) =>
      dispatched.push(thunk({ key: 'stack', routes } as NavigationState))
    ),
    canGoBack: jest.fn(() => true),
    goBack: jest.fn(),
    navigate: jest.fn(),
    addListener: jest.fn((_event: 'beforeRemove', listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return { navigation, dispatched, listeners };
}

it('C2a nav is the route-scoped navigation of the presenting route', () => {
  const { navigation, dispatched } = fakeRouter([{ key: 'R' }]);
  const binding = routeReviewBinding(navigation, 'R');
  expect(binding.nav.goBack()).toBe(true);
  expect(dispatched).toEqual([
    { type: 'POP', payload: { count: 1 }, target: 'stack' },
  ]);
  expect(navigation.goBack).not.toHaveBeenCalled();
});

it('C2a nav reports a presenting route that is already gone', () => {
  const { navigation, dispatched } = fakeRouter([]);
  const binding = routeReviewBinding(navigation, 'R');
  expect(binding.nav.goBack()).toBe(false);
  expect(dispatched).toEqual([]);
});

it('C2a navigation is the router itself, unscoped', () => {
  const { navigation } = fakeRouter();
  const binding = routeReviewBinding(navigation, 'R');
  expect(binding.navigation).toBe(navigation);
});

it('C2a onLeave listens for beforeRemove and unsubscribes', () => {
  const { navigation, listeners } = fakeRouter();
  const binding = routeReviewBinding(navigation, 'R');
  const listener = jest.fn();
  const unsubscribe = binding.onLeave(listener);
  expect(navigation.addListener).toHaveBeenCalledWith('beforeRemove', listener);
  expect(listeners.size).toBe(1);
  [...listeners].forEach((fn) => fn());
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  expect(listeners.size).toBe(0);
});
