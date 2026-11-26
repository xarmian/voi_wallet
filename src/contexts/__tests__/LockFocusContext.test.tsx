import React, { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, render } from '@testing-library/react-native';
import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from '@react-navigation/native';
import {
  RootLockFocusProvider,
  useLockFocus,
  type LockFocusSource,
} from '../LockFocusContext';

let source: LockFocusSource;
let listeners: Set<(state: AppStateStatus) => void>;
const remove = jest.fn();
function Probe({ onSource }: { onSource?: (value: LockFocusSource) => void }) {
  const focus = useLockFocus();
  useEffect(() => {
    source = focus;
    onSource?.(focus);
  });
  return null;
}
async function change(state: AppStateStatus) {
  await act(async () => {
    AppState.currentState = state;
    [...listeners].forEach((listener) => listener(state));
  });
}
async function mount() {
  return render(
    <RootLockFocusProvider>
      <Probe />
    </RootLockFocusProvider>
  );
}
beforeEach(() => {
  listeners = new Set();
  remove.mockClear();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      listeners.add(listener);
      return {
        remove: () => {
          remove();
          listeners.delete(listener);
        },
      };
    });
});
afterEach(() => jest.restoreAllMocks());

it('DEFECT mount is focused without retroactive listener delivery', async () => {
  await mount();
  const listener = jest.fn();
  source.addListener('focus', listener);
  expect(source.isFocused()).toBe(true);
  expect(listener).not.toHaveBeenCalled();
});
it('DEFECT background blurs once and active after background focuses once', async () => {
  await mount();
  const blur = jest.fn();
  const focus = jest.fn();
  source.addListener('blur', blur);
  source.addListener('focus', focus);
  await change('background');
  await change('background');
  expect(source.isFocused()).toBe(false);
  expect(blur).toHaveBeenCalledTimes(1);
  await change('inactive');
  expect(source.isFocused()).toBe(false);
  expect(focus).not.toHaveBeenCalled();
  await change('active');
  await change('active');
  expect(source.isFocused()).toBe(true);
  expect(focus).toHaveBeenCalledTimes(1);
});
it('REGRESSION active to inactive and back preserves focus and fires nothing', async () => {
  await mount();
  const listener = jest.fn();
  source.addListener('focus', listener);
  source.addListener('blur', listener);
  await change('inactive');
  expect(source.isFocused()).toBe(true);
  await change('active');
  expect(listener).not.toHaveBeenCalled();
});
it.each(['background', 'inactive'] as const)(
  'DEFECT mounting %s has the required initial focus',
  async (state) => {
    AppState.currentState = state;
    await mount();
    expect(source.isFocused()).toBe(state !== 'background');
    const focus = jest.fn();
    source.addListener('focus', focus);
    await change('inactive');
    expect(source.isFocused()).toBe(state !== 'background');
    await change('active');
    expect(source.isFocused()).toBe(true);
    expect(focus).toHaveBeenCalledTimes(state === 'background' ? 1 : 0);
  }
);
it('DEFECT unmount removes subscription, drops listeners and leaves retained source unfocused', async () => {
  const view = await mount();
  const listener = jest.fn();
  source.addListener('focus', listener);
  source.addListener('blur', listener);
  const retained = [...listeners][0];
  await view.unmount();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
  expect(source.isFocused()).toBe(false);
  retained('background');
  retained('active');
  expect(source.isFocused()).toBe(false);
  expect(listener).not.toHaveBeenCalled();
});
it('DEFECT listeners see updated focus, unsubscribe works and delivery copies the set', async () => {
  await mount();
  const values: boolean[] = [];
  const second = jest.fn();
  let unsubscribe = () => {};
  source.addListener('blur', () => {
    values.push(source.isFocused());
    unsubscribe();
  });
  unsubscribe = source.addListener('blur', second);
  source.addListener('focus', () => values.push(source.isFocused()));
  await change('background');
  expect(second).toHaveBeenCalledTimes(1);
  await change('active');
  await change('background');
  expect(second).toHaveBeenCalledTimes(1);
  expect(values).toEqual([false, true, false]);
});
it('REGRESSION default adapter forwards navigation and remains stable across renders', async () => {
  const unsubscribe = jest.fn();
  const navigation = {
    isFocused: jest.fn(() => true),
    addListener: jest.fn(() => unsubscribe),
  };
  const tree = () => (
    <NavigationContext.Provider
      value={navigation as unknown as NavigationProp<ParamListBase>}
    >
      <Probe />
    </NavigationContext.Provider>
  );
  const view = await render(tree());
  const original = source;
  expect(source.isFocused()).toBe(true);
  expect(navigation.isFocused).toHaveBeenCalledTimes(1);
  const listener = jest.fn();
  expect(source.addListener('focus', listener)).toBe(unsubscribe);
  expect(source.addListener('blur', listener)).toBe(unsubscribe);
  expect(navigation.addListener.mock.calls).toEqual([
    ['focus', listener],
    ['blur', listener],
  ]);
  await view.rerender(tree());
  expect(source).toBe(original);
});
it('DEFECT root source takes precedence and stays stable across renders', async () => {
  const tree = () => (
    <NavigationContext.Provider
      value={
        { isFocused: () => false } as unknown as NavigationProp<ParamListBase>
      }
    >
      <RootLockFocusProvider>
        <Probe />
      </RootLockFocusProvider>
    </NavigationContext.Provider>
  );
  const view = await render(tree());
  const original = source;
  expect(source.isFocused()).toBe(true);
  await view.rerender(tree());
  expect(source).toBe(original);
  expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
});
it('DEFECT missing provider and navigation throws the precise error', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await expect(render(<Probe />)).rejects.toThrow(
    'useLockFocus requires a navigator or a RootLockFocusProvider'
  );
});
