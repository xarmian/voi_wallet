import React, { forwardRef } from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { BlurView } from 'expo-blur';

type SafeBlurViewProps = {
  /** Blur intensity (0-100) */
  intensity?: number;
  /** Blur tint ('light' | 'dark' | 'default') */
  tint?: 'light' | 'dark' | 'default';
  /** Children content */
  children?: React.ReactNode;
  /** Style prop */
  style?: ViewProps['style'];
} & Omit<ViewProps, 'style'>;

/**
 * SafeBlurView - Cross-platform blur view component
 *
 * Wraps expo-blur BlurView with consistent API across platforms.
 * On Android, uses experimentalBlurMethod='dimezisBlurView' to enable
 * native blur rendering.
 *
 * NOTE: Do not use inside FlatList/VirtualizedList components on Android
 * as it can cause crashes due to view recycling issues.
 */
export const SafeBlurView = forwardRef<View, SafeBlurViewProps>(
  (
    {
      intensity = 10,
      tint = 'light',
      children,
      style,
      ...viewProps
    },
    ref
  ) => {
    return (
      <BlurView
        ref={ref}
        intensity={intensity}
        tint={tint}
        experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
        style={style}
        {...viewProps}
      >
        {children}
      </BlurView>
    );
  }
);

SafeBlurView.displayName = 'SafeBlurView';

/**
 * Check if blur view is available
 * Always returns true as expo-blur is a dependency
 */
export const isBlurViewAvailable = (): boolean => {
  return true;
};
