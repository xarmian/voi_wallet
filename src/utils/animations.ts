/**
 * Shared animation configurations and hooks for liquid-glass UI
 * Uses react-native-reanimated for performant UI-thread animations
 */

import { useCallback } from 'react';
import {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withSequence,
  withRepeat,
  interpolate,
  Easing,
  ReduceMotion,
  SharedValue,
  WithSpringConfig,
  WithTimingConfig,
} from 'react-native-reanimated';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/**
 * Reduce Motion policy for the shared configs (PLAN-12 DR-13, item 2).
 *
 * `ReduceMotion.System` makes Reanimated consult the OS accessibility setting
 * and skip the animation (jumping straight to the target value) when it is on.
 * It is Reanimated's default, but every shared config states it explicitly so
 * that the policy is visible at the choke point rather than implied — and so a
 * future config never silently opts out by omission.
 *
 * NOTE: this only covers animations that *flow through* these configs. Direct
 * `withRepeat` loops with inline durations bypass them entirely and must gate
 * themselves on `useReducedMotion()` — see DR-13 item 3.
 */
const REDUCE_MOTION_POLICY = ReduceMotion.System;

// Spring configurations for different interaction types
export const springConfigs = {
  // Snappy response for button presses
  snappy: {
    damping: 20,
    stiffness: 400,
    mass: 0.8,
    reduceMotion: REDUCE_MOTION_POLICY,
  } as WithSpringConfig,
  // Smooth movement for cards and modals
  smooth: {
    damping: 25,
    stiffness: 200,
    mass: 1,
    reduceMotion: REDUCE_MOTION_POLICY,
  } as WithSpringConfig,
  // Bouncy for playful interactions
  bouncy: {
    damping: 12,
    stiffness: 180,
    mass: 0.8,
    reduceMotion: REDUCE_MOTION_POLICY,
  } as WithSpringConfig,
  // Gentle for subtle movements
  gentle: {
    damping: 30,
    stiffness: 150,
    mass: 1.2,
    reduceMotion: REDUCE_MOTION_POLICY,
  } as WithSpringConfig,
};

// Timing configurations
export const timingConfigs = {
  instant: {
    duration: 100,
    easing: Easing.ease,
    reduceMotion: REDUCE_MOTION_POLICY,
  } as WithTimingConfig,
  fast: {
    duration: 150,
    easing: Easing.out(Easing.ease),
    reduceMotion: REDUCE_MOTION_POLICY,
  } as WithTimingConfig,
  normal: {
    duration: 250,
    easing: Easing.inOut(Easing.ease),
    reduceMotion: REDUCE_MOTION_POLICY,
  } as WithTimingConfig,
  slow: {
    duration: 400,
    easing: Easing.inOut(Easing.cubic),
    reduceMotion: REDUCE_MOTION_POLICY,
  } as WithTimingConfig,
  // For shimmer effects
  shimmer: {
    duration: 1500,
    easing: Easing.linear,
    reduceMotion: REDUCE_MOTION_POLICY,
  } as WithTimingConfig,
};

/**
 * Hook for press animation (scale down on press)
 * Returns animated style and press handlers
 */
export function usePressAnimation(
  scaleAmount: number = 0.98,
  config: WithSpringConfig = springConfigs.snappy
) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const onPressIn = useCallback(() => {
    'worklet';
    scale.value = withSpring(scaleAmount, config);
    opacity.value = withTiming(0.9, timingConfigs.instant);
  }, [scale, opacity, scaleAmount, config]);

  const onPressOut = useCallback(() => {
    'worklet';
    scale.value = withSpring(1, config);
    opacity.value = withTiming(1, timingConfigs.fast);
  }, [scale, opacity, config]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return {
    animatedStyle,
    onPressIn,
    onPressOut,
    scale,
    opacity,
  };
}

/**
 * Hook for glow pulse animation (for buttons, active elements)
 * Creates a subtle pulsing glow effect
 */
export function useGlowPulse(
  minOpacity: number = 0.3,
  maxOpacity: number = 0.6,
  duration: number = 2000
) {
  const glowOpacity = useSharedValue(minOpacity);
  const reducedMotion = useReducedMotion();

  const startPulse = useCallback(() => {
    // DR-13: an infinite pulse must not start at all under Reduce Motion —
    // park the value at its resting opacity instead.
    if (reducedMotion) {
      glowOpacity.value = minOpacity;
      return;
    }
    glowOpacity.value = withRepeat(
      withSequence(
        withTiming(maxOpacity, {
          duration: duration / 2,
          easing: Easing.inOut(Easing.ease),
          reduceMotion: REDUCE_MOTION_POLICY,
        }),
        withTiming(minOpacity, {
          duration: duration / 2,
          easing: Easing.inOut(Easing.ease),
          reduceMotion: REDUCE_MOTION_POLICY,
        })
      ),
      -1, // Repeat infinitely
      false, // Don't reverse
      undefined,
      REDUCE_MOTION_POLICY
    );
  }, [glowOpacity, minOpacity, maxOpacity, duration, reducedMotion]);

  const stopPulse = useCallback(() => {
    glowOpacity.value = withTiming(minOpacity, timingConfigs.normal);
  }, [glowOpacity, minOpacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  return {
    animatedStyle,
    startPulse,
    stopPulse,
    glowOpacity,
  };
}

/**
 * Hook for entrance animation (fade + slide in)
 */
export function useEntranceAnimation(
  delay: number = 0,
  translateY: number = 20
) {
  const opacity = useSharedValue(0);
  const translateYValue = useSharedValue(translateY);

  const enter = useCallback(() => {
    opacity.value = withTiming(1, {
      ...timingConfigs.normal,
      duration: (timingConfigs.normal.duration ?? 0) + delay,
    });
    translateYValue.value = withSpring(0, springConfigs.smooth);
  }, [opacity, translateYValue, delay]);

  const reset = useCallback(() => {
    opacity.value = 0;
    translateYValue.value = translateY;
  }, [opacity, translateYValue, translateY]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateYValue.value }],
  }));

  return {
    animatedStyle,
    enter,
    reset,
    opacity,
    translateYValue,
  };
}

/**
 * Hook for number transition animation
 * Smoothly animates between number values
 */
export function useNumberTransition(
  initialValue: number = 0,
  config: WithTimingConfig = timingConfigs.normal
) {
  const animatedValue = useSharedValue(initialValue);

  const setValue = useCallback(
    (newValue: number) => {
      animatedValue.value = withTiming(newValue, config);
    },
    [animatedValue, config]
  );

  const setValueInstant = useCallback(
    (newValue: number) => {
      animatedValue.value = newValue;
    },
    [animatedValue]
  );

  return {
    animatedValue,
    setValue,
    setValueInstant,
  };
}

/**
 * Hook for shimmer loading effect
 * Creates a horizontal shimmer animation
 */
export function useShimmer(duration: number = 1500) {
  const shimmerPosition = useSharedValue(-1);
  const reducedMotion = useReducedMotion();

  const startShimmer = useCallback(() => {
    // DR-13: skip the infinite sweep entirely under Reduce Motion.
    if (reducedMotion) {
      shimmerPosition.value = -1;
      return;
    }
    shimmerPosition.value = withRepeat(
      withTiming(1, {
        duration,
        easing: Easing.linear,
        reduceMotion: REDUCE_MOTION_POLICY,
      }),
      -1,
      false,
      undefined,
      REDUCE_MOTION_POLICY
    );
  }, [shimmerPosition, duration, reducedMotion]);

  const stopShimmer = useCallback(() => {
    shimmerPosition.value = -1;
  }, [shimmerPosition]);

  // Returns a value from -1 to 1 for interpolation
  return {
    shimmerPosition,
    startShimmer,
    stopShimmer,
  };
}

/**
 * Interpolation helpers for common animation patterns
 */
export const interpolations = {
  // Scale interpolation for press states
  pressScale: (progress: SharedValue<number>) => {
    'worklet';
    return interpolate(progress.value, [0, 1], [1, 0.98]);
  },

  // Opacity interpolation for fade effects
  fadeIn: (progress: SharedValue<number>) => {
    'worklet';
    return interpolate(progress.value, [0, 1], [0, 1]);
  },

  // Translation for slide effects
  slideUp: (progress: SharedValue<number>, distance: number = 20) => {
    'worklet';
    return interpolate(progress.value, [0, 1], [distance, 0]);
  },
};

/**
 * Simple fade in hook - auto-triggers on mount
 */
export function useFadeIn(delay: number = 0, duration: number = 300) {
  const opacity = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const fadeIn = useCallback(() => {
    if (delay > 0) {
      setTimeout(() => {
        opacity.value = withTiming(1, {
          duration,
          easing: Easing.out(Easing.ease),
        });
      }, delay);
    } else {
      opacity.value = withTiming(1, {
        duration,
        easing: Easing.out(Easing.ease),
      });
    }
  }, [opacity, delay, duration]);

  const fadeOut = useCallback(() => {
    opacity.value = withTiming(0, {
      duration: duration / 2,
      easing: Easing.in(Easing.ease),
    });
  }, [opacity, duration]);

  return { animatedStyle, fadeIn, fadeOut, opacity };
}

/**
 * Scale in hook - grows from small to full size
 */
export function useScaleIn(
  delay: number = 0,
  initialScale: number = 0.9,
  config: WithSpringConfig = springConfigs.smooth
) {
  const scale = useSharedValue(initialScale);
  const opacity = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const scaleIn = useCallback(() => {
    const animate = () => {
      scale.value = withSpring(1, config);
      opacity.value = withTiming(1, timingConfigs.normal);
    };

    if (delay > 0) {
      setTimeout(animate, delay);
    } else {
      animate();
    }
  }, [scale, opacity, delay, config]);

  const reset = useCallback(() => {
    scale.value = initialScale;
    opacity.value = 0;
  }, [scale, opacity, initialScale]);

  return { animatedStyle, scaleIn, reset, scale, opacity };
}

/**
 * Slide in from direction hook
 */
export function useSlideIn(
  direction: 'up' | 'down' | 'left' | 'right' = 'up',
  delay: number = 0,
  distance: number = 30
) {
  const translateX = useSharedValue(
    direction === 'left' ? -distance : direction === 'right' ? distance : 0
  );
  const translateY = useSharedValue(
    direction === 'up' ? distance : direction === 'down' ? -distance : 0
  );
  const opacity = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
    opacity: opacity.value,
  }));

  const slideIn = useCallback(() => {
    const animate = () => {
      translateX.value = withSpring(0, springConfigs.smooth);
      translateY.value = withSpring(0, springConfigs.smooth);
      opacity.value = withTiming(1, timingConfigs.normal);
    };

    if (delay > 0) {
      setTimeout(animate, delay);
    } else {
      animate();
    }
  }, [translateX, translateY, opacity, delay]);

  const reset = useCallback(() => {
    translateX.value =
      direction === 'left' ? -distance : direction === 'right' ? distance : 0;
    translateY.value =
      direction === 'up' ? distance : direction === 'down' ? -distance : 0;
    opacity.value = 0;
  }, [translateX, translateY, opacity, direction, distance]);

  return { animatedStyle, slideIn, reset };
}

/**
 * Staggered children entrance - for lists
 * Returns a function to get delay for each index
 */
export function getStaggerDelay(
  index: number,
  baseDelay: number = 50,
  maxDelay: number = 500
): number {
  return Math.min(index * baseDelay, maxDelay);
}

/**
 * Card flip animation hook
 */
export function useCardFlip(duration: number = 300) {
  const rotateY = useSharedValue(0);
  const isFlipped = useSharedValue(false);

  const frontAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotateY: `${rotateY.value}deg` }],
    backfaceVisibility: 'hidden' as const,
  }));

  const backAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotateY: `${rotateY.value + 180}deg` }],
    backfaceVisibility: 'hidden' as const,
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
  }));

  const flip = useCallback(() => {
    isFlipped.value = !isFlipped.value;
    rotateY.value = withTiming(isFlipped.value ? 180 : 0, {
      duration,
      easing: Easing.inOut(Easing.ease),
    });
  }, [rotateY, isFlipped, duration]);

  return { frontAnimatedStyle, backAnimatedStyle, flip, isFlipped };
}
