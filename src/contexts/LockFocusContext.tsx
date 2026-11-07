import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
} from 'react';
import { AppState } from 'react-native';
import { NavigationContext } from '@react-navigation/native';

export interface LockFocusSource {
  isFocused(): boolean;
  addListener(event: 'focus' | 'blur', listener: () => void): () => void;
}

const LockFocusContext = createContext<LockFocusSource | null>(null);

export function useLockFocus(): LockFocusSource {
  const root = useContext(LockFocusContext);
  const navigation = useContext(NavigationContext);
  const adapter = useMemo<LockFocusSource | null>(
    () =>
      navigation
        ? {
            isFocused: () => navigation.isFocused(),
            addListener: (event, listener) =>
              navigation.addListener(event, listener),
          }
        : null,
    [navigation]
  );
  const source = root ?? adapter;
  if (!source) {
    throw new Error(
      'useLockFocus requires a navigator or a RootLockFocusProvider'
    );
  }
  return source;
}

function createRootFocusState() {
  let mounted = true;
  let focused = AppState.currentState !== 'background';
  const listeners = {
    focus: new Set<() => void>(),
    blur: new Set<() => void>(),
  };
  const source: LockFocusSource = {
    isFocused: () => mounted && focused,
    addListener: (event, listener) => {
      if (mounted) listeners[event].add(listener);
      return () => {
        listeners[event].delete(listener);
      };
    },
  };
  return {
    source,
    mount: () => {
      mounted = true;
      focused = AppState.currentState !== 'background';
    },
    change: (next: string) => {
      if (!mounted) return;
      const nextFocused =
        next === 'background' ? false : next === 'active' ? true : focused;
      if (focused === nextFocused) return;
      focused = nextFocused;
      [...listeners[focused ? 'focus' : 'blur']].forEach((listener) =>
        listener()
      );
    },
    unmount: () => {
      mounted = false;
      focused = false;
      listeners.focus.clear();
      listeners.blur.clear();
    },
  };
}

export function RootLockFocusProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const state = useMemo(() => createRootFocusState(), []);
  useLayoutEffect(() => {
    state.mount();
    const subscription = AppState.addEventListener('change', state.change);
    return () => {
      subscription.remove();
      state.unmount();
    };
  }, [state]);
  return (
    <LockFocusContext.Provider value={state.source}>
      {children}
    </LockFocusContext.Provider>
  );
}
