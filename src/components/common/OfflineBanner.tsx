/**
 * OfflineBanner — app-wide passive offline indicator (TASK-40 / R-03).
 *
 * Before this, `@react-native-community/netinfo` was a declared dependency that
 * was never imported: when the device dropped connectivity the app showed stale
 * cached balances with no signal at all, and pull-to-refresh silently did
 * nothing. This is the single passive surface for that state.
 *
 * MOUNT POINT — mounted at the App root (`App.tsx`), above `NavigationContainer`,
 * so it survives every navigation and covers auth/onboarding screens too.
 * `AuthProvider` sits BELOW that point (`AppNavigator`), so a root-level banner
 * cannot read auth state — which is fine and deliberate here: connectivity is
 * orthogonal to whether the user is unlocked, and the banner consumes no wallet
 * or auth state whatsoever. (PLAN-12 records this caveat; the alternative —
 * moving the banner inside `AppNavigator` — would buy access to state this
 * component does not want and lose coverage of the pre-auth screens.)
 *
 * SAFE AREA — there is no `SafeAreaProvider` at the App root (each navigator
 * creates its own via React Navigation's `SafeAreaProviderCompat`), so
 * `useSafeAreaInsets()` is unavailable here. Rather than restructure the
 * provider tree app-wide for one bar, this reads the static
 * `initialWindowMetrics` captured at launch — the exact fallback
 * `SafeAreaProviderCompat` itself uses. The app is portrait-locked
 * (`app.config.js`), so these insets do not change at runtime.
 */

import React from 'react';
import { Platform, StatusBar, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { initialWindowMetrics } from 'react-native-safe-area-context';
import { useConnectivity } from '@/hooks/useConnectivity';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

/**
 * Static top inset. `initialWindowMetrics` is null on web and in tests; the
 * Android status bar height is the right fallback there because the app renders
 * with a non-translucent status bar.
 */
const TOP_INSET =
  initialWindowMetrics?.insets.top ??
  (Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0);

export default function OfflineBanner() {
  const { isOffline } = useConnectivity();
  const styles = useThemedStyles(createStyles);

  if (!isOffline) {
    return null;
  }

  return (
    <Animated.View
      entering={FadeInUp.duration(220)}
      exiting={FadeOutUp.duration(180)}
      style={[styles.container, { paddingTop: TOP_INSET + 8 }]}
      pointerEvents="none"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="offline-banner"
    >
      <View style={styles.row}>
        <Ionicons
          name="cloud-offline-outline"
          size={16}
          color={styles.icon.color}
        />
        <Text style={styles.text}>
          You&apos;re offline — balances may be out of date
        </Text>
      </View>
    </Animated.View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      paddingBottom: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: theme.colors.warning,
      zIndex: 1000,
      elevation: 8,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    // Fixed dark ink: this banner is filled with theme.colors.warning (amber in
    // every palette), where a theme text colour would lose contrast.
    icon: {
      color: '#1C1C1E',
    },
    text: {
      fontSize: 13,
      fontWeight: '600',
      color: '#1C1C1E',
      textAlign: 'center',
    },
  });
