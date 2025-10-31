import React, { forwardRef } from 'react';
import { UIManager, View, type ViewProps } from 'react-native';
import type { BlurViewProps } from 'expo-blur';

type SafeBlurViewProps = BlurViewProps & ViewProps;

type BlurViewComponent = React.ComponentType<BlurViewProps>;

let cachedBlurComponent: BlurViewComponent | null | undefined;
let nativeAvailability: boolean | undefined;
let hasLoggedUnavailable = false;

const isNativeViewManagerAvailable = (): boolean => {
  if (nativeAvailability !== undefined) {
    return nativeAvailability;
  }

  let available = false;

  try {
    // getViewManagerConfig throws if the view manager doesn't exist under Fabric.
    const config =
      typeof UIManager.getViewManagerConfig === 'function'
        ? UIManager.getViewManagerConfig('ExpoBlurView')
        : null;
    available = !!config;
  } catch {
    available = false;
  }

  if (!available) {
    try {
      const { NativeModulesProxy } = require('expo-modules-core');
      if (NativeModulesProxy?.ExpoBlurView) {
        available = true;
      }
    } catch {
      available = false;
    }
  }

  if (!available && typeof globalThis.__turboModuleProxy === 'function') {
    try {
      const module = globalThis.__turboModuleProxy('ExpoBlurView');
      available = module != null;
    } catch {
      available = false;
    }
  }

  if (available) {
    nativeAvailability = true;
  }
  return available;
};

const resolveBlurComponent = (): BlurViewComponent | null => {
  if (cachedBlurComponent !== undefined) {
    return cachedBlurComponent;
  }

  try {
    const module = require('expo-blur');
    const component = module?.BlurView ?? module?.default;
    if (component) {
      if (isNativeViewManagerAvailable()) {
        cachedBlurComponent = component;
      } else {
        cachedBlurComponent = null;
        if (!hasLoggedUnavailable) {
          hasLoggedUnavailable = true;
          console.warn(
            '[SafeBlurView] ExpoBlur native view manager is missing; rendering without blur.'
          );
        }
      }
    } else {
      cachedBlurComponent = null;
    }
  } catch (error) {
    cachedBlurComponent = null;
    if (!hasLoggedUnavailable) {
      hasLoggedUnavailable = true;
      const message =
        '[SafeBlurView] expo-blur is unavailable; falling back to a non-blurred view.';
      if (__DEV__) {
        console.warn(message, error);
      } else {
        console.warn(message);
      }
    }
  }

  return cachedBlurComponent;
};

export const isBlurViewAvailable = (): boolean => {
  return resolveBlurComponent() != null;
};

export const SafeBlurView = forwardRef<View, SafeBlurViewProps>(
  (
    {
      intensity,
      tint,
      blurReductionFactor,
      experimentalBlurMethod,
      children,
      style,
      ...viewProps
    },
    ref
  ) => {
    const BlurComponent = resolveBlurComponent();

    if (BlurComponent) {
      return (
        <BlurComponent
          intensity={intensity}
          tint={tint}
          blurReductionFactor={blurReductionFactor}
          experimentalBlurMethod={experimentalBlurMethod}
          style={style}
          {...viewProps}
          ref={ref as never}
        >
          {children}
        </BlurComponent>
      );
    }

    return (
      <View ref={ref} style={style} {...viewProps}>
        {children}
      </View>
    );
  }
);

SafeBlurView.displayName = 'SafeBlurView';
