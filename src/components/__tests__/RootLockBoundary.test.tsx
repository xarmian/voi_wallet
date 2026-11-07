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
import { act, render } from '@testing-library/react-native';
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
        shouldCover(auth, route) ? 1 : 0
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
it('DEFECT S2 waits uncovered then tracks state events to Main and SecuritySetup', async () => {
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
  await nav.emit('Main');
  expect(view.getByTestId('lock')).toBeTruthy();
  await nav.emit('SecuritySetup');
  expect(view.queryByTestId('lock')).toBeNull();
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
  expect(view.getByTestId('lock')).toBeTruthy();
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
it('DEFECT S2 on a WalletConnect review route shows no lock screen and keeps the content reachable', async () => {
  auth = {
    ...unlocked,
    isLocked: true,
    isAuthenticated: false,
    hasPin: false,
    pinSetupResume: true,
  };
  const nav = navigation('WalletConnectSessionProposal');
  const view = await render(tree(nav));
  expect(view.queryByTestId('lock')).toBeNull();
  const props = content(view).props;
  expect(props.pointerEvents).toBeUndefined();
  expect(props.accessibilityElementsHidden).toBeFalsy();
  expect(handlers.size).toBe(0);
  // The same route with a PIN present is an ordinary locked wallet: covered.
  auth = { ...auth, hasPin: true };
  await view.rerender(tree(nav));
  expect(view.queryAllByTestId('lock')).toHaveLength(1);
  expect(content(view).props.pointerEvents).toBe('none');
});
