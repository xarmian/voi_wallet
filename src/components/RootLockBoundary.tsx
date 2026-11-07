import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { useAuth } from '@/contexts/AuthContext';
import { RootLockFocusProvider } from '@/contexts/LockFocusContext';
import LockScreen from '@/screens/auth/LockScreen';
import {
  SECURITY_SETUP_ROUTE,
  shouldCover,
} from '@/navigation/lockCoverCondition';
import { setCovered } from '@/utils/lockCover';

interface NavigationRefLike {
  isReady(): boolean;
  getCurrentRoute(): { name: string } | undefined;
  addListener(event: 'state', listener: () => void): () => void;
  resetRoot(state: {
    index: number;
    routes: { name: string; params?: object }[];
  }): void;
}
export default function RootLockBoundary({
  navigationRef,
  children,
}: {
  navigationRef: { current: NavigationRefLike | null };
  children: React.ReactNode;
}): React.JSX.Element {
  const { authState } = useAuth();
  const [focusedRoute, setFocusedRoute] = useState<string | null>(null);
  const subscribed = useRef<NavigationRefLike | null>(null);
  const unsubscribe = useRef<(() => void) | undefined>(undefined);

  // Ref assignment does not trigger a render. Retry on each render until the
  // container exists, then retain one listener for that navigation instance.
  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    const readRoute = () => {
      const next = navigation?.isReady()
        ? (navigation.getCurrentRoute()?.name ?? null)
        : null;
      setFocusedRoute((previous) => (previous === next ? previous : next));
    };
    readRoute();
    if (subscribed.current === navigation) return;
    unsubscribe.current?.();
    subscribed.current = navigation;
    unsubscribe.current = navigation?.addListener('state', readRoute);
  });
  useEffect(
    () => () => {
      unsubscribe.current?.();
      subscribed.current = null;
      unsubscribe.current = undefined;
    },
    []
  );

  const covered = shouldCover(authState, focusedRoute);
  // With no PIN there is nothing to unlock, so a lock screen would offer a PIN
  // pad that can never succeed. Whatever the route, a cover without a PIN never
  // mounts one; in PIN-setup-resume (S2) the person is sent back to finishing
  // PIN setup, the only route the cover exempts there.
  const noPin = covered && !authState.hasPin;
  const resumeSetup = noPin && authState.pinSetupResume;
  useEffect(() => {
    if (!resumeSetup) return;
    navigationRef.current?.resetRoot({
      index: 0,
      routes: [{ name: SECURITY_SETUP_ROUTE, params: { source: 'restore' } }],
    });
  }, [resumeSetup, navigationRef]);
  useLayoutEffect(() => {
    setCovered(covered);
    return () => setCovered(false);
  }, [covered]);

  useEffect(() => {
    if (!covered) return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => true
    );
    return () => subscription.remove();
  }, [covered]);

  return (
    <View style={styles.container}>
      <View
        style={[styles.content, covered && styles.hidden]}
        pointerEvents={covered ? 'none' : undefined}
        accessibilityElementsHidden={covered}
        importantForAccessibility={covered ? 'no-hide-descendants' : undefined}
      >
        {children}
      </View>
      {covered && (
        <View style={styles.lockOverlay}>
          {!noPin && (
            <RootLockFocusProvider>
              <LockScreen />
            </RootLockFocusProvider>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1 },
  hidden: { opacity: 0 },
  lockOverlay: { ...StyleSheet.absoluteFill, zIndex: 1000 },
});
