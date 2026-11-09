import React, {
  useEffect as mockUseEffect,
  useEffect,
  useLayoutEffect,
} from 'react';
import {
  AppState,
  BackHandler,
  StyleSheet,
  Text as MockText,
  Text,
} from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from '@react-navigation/native';
import RootLockBoundary from '../RootLockBoundary';
import { useAuth } from '@/contexts/AuthContext';
import {
  useLockFocus as mockUseLockFocus,
  type LockFocusSource,
} from '@/contexts/LockFocusContext';
import { shouldCover, type CoverInput } from '@/navigation/lockCoverCondition';
import { setCovered } from '@/utils/lockCover';

jest.mock('@/contexts/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('@/utils/lockCover', () => ({ setCovered: jest.fn() }));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
let mockMounted = 0;
let mockMaximum = 0;
let mockMounts = 0;
let mockChildMounts = 0;
let mockLog: string[] = [];
let mockFocus: LockFocusSource;
jest.mock('@/screens/auth/LockScreen', () => ({
  __esModule: true,
  default: function MockLockScreen() {
    mockFocus = mockUseLockFocus();
    mockUseEffect(() => {
      mockMounted++;
      mockMounts++;
      mockMaximum = Math.max(mockMaximum, mockMounted);
      mockLog.push('lock mount');
      return () => {
        mockMounted--;
      };
    }, []);
    return <MockText testID="lock">lock</MockText>;
  },
}));
const unlocked: CoverInput = {
  authChecked: true,
  isLocked: false,
  isAuthenticated: true,
  hasPin: true,
  pinSetupResume: false,
  securityUnavailable: false,
};
let auth: CoverInput;
let handlers: Set<Parameters<typeof BackHandler.addEventListener>[1]>;
let removeBack: jest.Mock;
function Child() {
  useEffect(() => {
    mockChildMounts++;
  }, []);
  useLayoutEffect(() => {
    mockLog.push('child layout');
  });
  return <Text testID="child">child</Text>;
}
function navigation(initial: string | null = 'Main') {
  let route = initial;
  let ready = initial !== null;
  const listeners = new Set<() => void>();
  const value = {
    isReady: () => ready,
    getCurrentRoute: () => (route === null ? undefined : { name: route }),
    addListener: jest.fn((_event: 'state', listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    resetRoot: jest.fn(
      (state: { routes: { name: string; params?: object }[] }) => {
        route = state.routes[0].name;
        ready = true;
        listeners.forEach((listener) => listener());
      }
    ),
  };
  return {
    ref: { current: value as typeof value | null },
    value,
    listeners,
    async emit(next: string | null) {
      route = next;
      ready = next !== null;
      await act(async () => {
        listeners.forEach((listener) => listener());
      });
    },
  };
}
function tree(nav: ReturnType<typeof navigation>) {
  return (
    <RootLockBoundary navigationRef={nav.ref}>
      <Child />
    </RootLockBoundary>
  );
}
function content(view: Awaited<ReturnType<typeof render>>) {
  const node = view.root?.children[0];
  if (!node || typeof node === 'string')
    throw new Error('Missing content View');
  return node;
}
beforeEach(() => {
  AppState.currentState = 'active';
  auth = { ...unlocked };
  jest
    .mocked(useAuth)
    .mockImplementation(
      () => ({ authState: auth }) as ReturnType<typeof useAuth>
    );
  mockMounted = 0;
  mockMaximum = 0;
  mockMounts = 0;
  mockChildMounts = 0;
  mockLog = [];
  jest.mocked(setCovered).mockImplementation((covered) => {
    mockLog.push(`covered ${covered}`);
  });
  handlers = new Set();
  removeBack = jest.fn();
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      handlers.add(handler);
      return {
        remove: () => {
          removeBack();
          handlers.delete(handler);
        },
      };
    });
});
afterEach(() => jest.restoreAllMocks());

it('DEFECT all 32 combinations on three routes agree with shouldCover and mount at most one lock', async () => {
  const nav = navigation(null);
  const view = await render(tree(nav));
  for (let bits = 0; bits < 32; bits++) {
    auth = {
      authChecked: true,
      isLocked: Boolean(bits & 1),
      isAuthenticated: Boolean(bits & 2),
      hasPin: Boolean(bits & 4),
      pinSetupResume: Boolean(bits & 8),
      securityUnavailable: Boolean(bits & 16),
    };
    for (const route of [null, 'SecuritySetup', 'Main']) {
      await nav.emit(route);
      await view.rerender(tree(nav));
      expect(view.queryAllByTestId('lock')).toHaveLength(
        shouldCover(auth, route) && auth.hasPin ? 1 : 0
      );
    }
  }
  expect(mockMaximum).toBe(1);
  await view.unmount();
  expect(mockMounted).toBe(0);
});
it('DEFECT children retain their instance and all four hiding props apply only while covered', async () => {
  const nav = navigation();
  const view = await render(tree(nav));
  const instance = view.getByTestId('child', { includeHiddenElements: true });
  for (const locked of [true, false, true, false]) {
    auth = { ...unlocked, isLocked: locked, isAuthenticated: !locked };
    await view.rerender(tree(nav));
    expect(view.getByTestId('child', { includeHiddenElements: true })).toBe(
      instance
    );
    expect(mockChildMounts).toBe(1);
    const props = content(view).props;
    expect(StyleSheet.flatten(props.style)?.opacity).toBe(
      locked ? 0 : undefined
    );
    expect(props.pointerEvents).toBe(locked ? 'none' : undefined);
    expect(Boolean(props.accessibilityElementsHidden)).toBe(locked);
    expect(props.importantForAccessibility).toBe(
      locked ? 'no-hide-descendants' : undefined
    );
  }
  expect(mockMounts).toBe(2);
});
it('DEFECT S2 waits uncovered, then a move away from SecuritySetup is sent back to it with no lock screen', async () => {
  auth = {
    ...unlocked,
    isLocked: true,
    isAuthenticated: false,
    hasPin: false,
    pinSetupResume: true,
  };
  const nav = navigation(null);
  const view = await render(tree(nav));
  expect(view.queryByTestId('lock')).toBeNull();
  expect(nav.value.resetRoot).not.toHaveBeenCalled();
  await nav.emit('Main');
  expect(view.queryByTestId('lock')).toBeNull();
  expect(nav.value.resetRoot).toHaveBeenCalledTimes(1);
  expect(nav.value.getCurrentRoute()?.name).toBe('SecuritySetup');
  await nav.emit('SecuritySetup');
  expect(view.queryByTestId('lock')).toBeNull();
  expect(mockMounts).toBe(0);
});
it('DEFECT a ref populated after mount is read and subscribed on the next render without a loop', async () => {
  auth = {
    ...unlocked,
    isLocked: true,
    isAuthenticated: false,
    hasPin: false,
    pinSetupResume: true,
  };
  const nav = navigation('Main');
  nav.ref.current = null;
  const view = await render(tree(nav));
  expect(view.queryByTestId('lock')).toBeNull();
  nav.ref.current = nav.value;
  await view.rerender(tree(nav));
  expect(view.queryByTestId('lock')).toBeNull();
  expect(nav.value.resetRoot).toHaveBeenCalledTimes(1);
  expect(nav.value.addListener).toHaveBeenCalledTimes(1);
  await nav.emit('SecuritySetup');
  expect(view.queryByTestId('lock')).toBeNull();
  await view.unmount();
  expect(nav.listeners.size).toBe(0);
});
it('DEFECT S0 and S1 never cover even while locked', async () => {
  const nav = navigation();
  auth = {
    ...unlocked,
    isLocked: true,
    isAuthenticated: false,
    securityUnavailable: true,
  };
  const view = await render(tree(nav));
  expect(view.queryByTestId('lock')).toBeNull();
  auth = { ...auth, securityUnavailable: false, authChecked: false };
  await view.rerender(tree(nav));
  expect(view.queryByTestId('lock')).toBeNull();
});
it('DEFECT publishes cover in the layout commit before lock mount, clears after unlock and on unmount', async () => {
  const nav = navigation();
  const observed: unknown[] = [];
  function LayoutObserver() {
    useLayoutEffect(() => {
      observed.push(jest.mocked(setCovered).mock.lastCall);
    });
    return null;
  }
  const observedTree = () => (
    <>
      {tree(nav)}
      <LayoutObserver />
    </>
  );
  const view = await render(observedTree());
  mockLog = [];
  jest.mocked(setCovered).mockClear();
  observed.length = 0;
  auth = { ...unlocked, isLocked: true, isAuthenticated: false };
  await view.rerender(observedTree());
  expect(view.getByTestId('lock')).toBeTruthy();
  expect(mockLog.indexOf('covered true')).toBeGreaterThanOrEqual(0);
  expect(mockLog.indexOf('covered true')).toBeLessThan(
    mockLog.indexOf('lock mount')
  );
  // This sibling's layout effect observes publication within the same commit,
  // before passive effects, without remounting the boundary.
  expect(observed).toEqual([[true]]);
  auth = { ...unlocked };
  await view.rerender(observedTree());
  expect(view.queryByTestId('lock')).toBeNull();
  expect(jest.mocked(setCovered).mock.lastCall).toEqual([false]);
  auth = { ...unlocked, isLocked: true };
  await view.rerender(observedTree());
  jest.mocked(setCovered).mockClear();
  await view.unmount();
  expect(setCovered).toHaveBeenCalledWith(false);
});
it('DEFECT covered hardware back is consumed and removed immediately on unlock and unmount', async () => {
  const nav = navigation();
  const view = await render(tree(nav));
  expect(handlers.size).toBe(0);
  auth = { ...unlocked, isLocked: true };
  await view.rerender(tree(nav));
  expect(BackHandler.addEventListener).toHaveBeenCalledWith(
    'hardwareBackPress',
    expect.any(Function)
  );
  expect(handlers.size).toBe(1);
  expect(
    [...handlers][0](
      {} as Parameters<Parameters<typeof BackHandler.addEventListener>[1]>[0]
    )
  ).toBe(true);
  auth = { ...unlocked };
  await view.rerender(tree(nav));
  expect(removeBack).toHaveBeenCalledTimes(1);
  expect(handlers.size).toBe(0);
  auth = { ...unlocked, isLocked: true };
  await view.rerender(tree(nav));
  await view.unmount();
  expect(removeBack).toHaveBeenCalledTimes(2);
  expect(handlers.size).toBe(0);
});
it('DEFECT each cover gets a fresh root focus source ahead of navigator focus', async () => {
  const nav = navigation();
  const nested = {
    isFocused: () => false,
    addListener: jest.fn(() => () => {}),
  };
  const withNavigation = () => (
    <NavigationContext.Provider
      value={nested as unknown as NavigationProp<ParamListBase>}
    >
      {tree(nav)}
    </NavigationContext.Provider>
  );
  auth = { ...unlocked, isLocked: true };
  const view = await render(withNavigation());
  const first = mockFocus;
  expect(first.isFocused()).toBe(true);
  auth = { ...unlocked };
  await view.rerender(withNavigation());
  expect(first.isFocused()).toBe(false);
  auth = { ...unlocked, isLocked: true };
  await view.rerender(withNavigation());
  expect(mockFocus).not.toBe(first);
  expect(mockFocus.isFocused()).toBe(true);
});
it('REGRESSION uncovered boundary has children and no overlay', async () => {
  const view = await render(tree(navigation()));
  expect(
    view.getByTestId('child', { includeHiddenElements: true })
  ).toBeTruthy();
  expect(view.queryByTestId('lock')).toBeNull();
  expect(view.root?.children).toHaveLength(1);
  expect(content(view).type).toBe('View');
});
// Invariant: whenever the cover shows and no PIN exists it never offers a PIN
// pad, whatever the route, and in S2 the way out is back to finishing PIN setup.
it.each([
  'UniversalTransactionSigning',
  'WalletConnectPairing',
  'WalletConnectError',
  'Main',
  'SomeRouteAddedLater',
])(
  'DEFECT S2 on %s: no PIN pad, sent back to SecuritySetup, content reachable',
  async (route) => {
    auth = {
      ...unlocked,
      isLocked: true,
      isAuthenticated: false,
      hasPin: false,
      pinSetupResume: true,
    };
    const nav = navigation(route);
    const view = await render(tree(nav));
    expect(view.queryByTestId('lock')).toBeNull();
    expect(mockMounts).toBe(0);
    expect(nav.value.resetRoot).toHaveBeenCalledTimes(1);
    expect(nav.value.resetRoot).toHaveBeenCalledWith({
      index: 0,
      routes: [{ name: 'SecuritySetup', params: { source: 'restore' } }],
    });
    expect(nav.value.getCurrentRoute()?.name).toBe('SecuritySetup');
    expect(content(view).props.pointerEvents).toBeUndefined();
    // The same route with a PIN present is an ordinary locked wallet: PIN pad.
    auth = { ...auth, hasPin: true };
    await nav.emit(route);
    await view.rerender(tree(nav));
    expect(view.queryAllByTestId('lock')).toHaveLength(1);
    expect(content(view).props.pointerEvents).toBe('none');
  }
);
it('DEFECT a covered state with no PIN outside S2 stays hidden with no PIN pad and no redirect', async () => {
  auth = {
    ...unlocked,
    isLocked: true,
    isAuthenticated: false,
    hasPin: false,
    pinSetupResume: false,
  };
  const nav = navigation('Main');
  const view = await render(tree(nav));
  expect(view.queryByTestId('lock')).toBeNull();
  expect(mockMounts).toBe(0);
  expect(nav.value.resetRoot).not.toHaveBeenCalled();
  expect(content(view).props.pointerEvents).toBe('none');
  expect(StyleSheet.flatten(content(view).props.style)?.opacity).toBe(0);
});
// The automatic reset can be refused or outrun, so the no-PIN cover in S2 always
// offers a visible control that runs the same reset.
it('DEFECT S2 with a reset that does nothing: the cover is never blank, its control runs the same reset', async () => {
  auth = {
    ...unlocked,
    isLocked: true,
    isAuthenticated: false,
    hasPin: false,
    pinSetupResume: true,
  };
  const nav = navigation('UniversalTransactionSigning');
  nav.value.resetRoot.mockImplementation(() => {});
  const view = await render(tree(nav));
  expect(view.queryByTestId('lock')).toBeNull();
  expect(nav.value.resetRoot).toHaveBeenCalledTimes(1);
  const control = view.getByRole('button', { name: 'Finish setup' });
  await fireEvent.press(control);
  expect(nav.value.resetRoot).toHaveBeenCalledTimes(2);
  expect(nav.value.resetRoot).toHaveBeenLastCalledWith({
    index: 0,
    routes: [{ name: 'SecuritySetup', params: { source: 'restore' } }],
  });
  expect(content(view).props.pointerEvents).toBe('none');
});
it('DEFECT the control is gone once the reset lands, and never shows with a PIN or outside S2', async () => {
  auth = {
    ...unlocked,
    isLocked: true,
    isAuthenticated: false,
    hasPin: false,
    pinSetupResume: true,
  };
  const nav = navigation('Main');
  const view = await render(tree(nav));
  expect(nav.value.getCurrentRoute()?.name).toBe('SecuritySetup');
  expect(view.queryByText('Finish setup')).toBeNull();
  auth = { ...unlocked, isLocked: true, isAuthenticated: false, hasPin: true };
  await nav.emit('Main');
  await view.rerender(tree(nav));
  expect(view.queryAllByTestId('lock')).toHaveLength(1);
  expect(view.queryByText('Finish setup')).toBeNull();
  auth = {
    ...unlocked,
    isLocked: true,
    isAuthenticated: false,
    hasPin: false,
    pinSetupResume: false,
  };
  await view.rerender(tree(nav));
  expect(view.queryByText('Finish setup')).toBeNull();
});
