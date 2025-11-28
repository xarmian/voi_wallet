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
  SharedValue,
  WithSpringConfig,
  WithTimingConfig,
} from 'react-native-reanimated';

// Spring configurations for different interaction types
export const springConfigs = {
  // Snappy response for button presses
  snappy: {
    damping: 20,
    stiffness: 400,
    mass: 0.8,
  } as WithSpringConfig,
  // Smooth movement for cards and modals
  smooth: {
    damping: 25,
    stiffness: 200,
    mass: 1,
  } as WithSpringConfig,
  // Bouncy for playful interactions
  bouncy: {
    damping: 12,
    stiffness: 180,
    mass: 0.8,
  } as WithSpringConfig,
  // Gentle for subtle movements
  gentle: {
    damping: 30,
    stiffness: 150,
    mass: 1.2,
  } as WithSpringConfig,
};

// Timing configurations
export const timingConfigs = {
  instant: {
    duration: 100,
    easing: Easing.ease,
  } as WithTimingConfig,
  fast: {
    duration: 150,
    easing: Easing.out(Easing.ease),
  } as WithTimingConfig,
  normal: {
    duration: 250,
    easing: Easing.inOut(Easing.ease),
  } as WithTimingConfig,
  slow: {
    duration: 400,
    easing: Easing.inOut(Easing.cubic),
  } as WithTimingConfig,
  // For shimmer effects
  shimmer: {
    duration: 1500,
    easing: Easing.linear,
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

  const startPulse = useCallback(() => {
    glowOpacity.value = withRepeat(
      withSequence(
        withTiming(maxOpacity, { duration: duration / 2, easing: Easing.inOut(Easing.ease) }),
        withTiming(minOpacity, { duration: duration / 2, easing: Easing.inOut(Easing.ease) })
      ),
      -1, // Repeat infinitely
      false // Don't reverse
    );
  }, [glowOpacity, minOpacity, maxOpacity, duration]);

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
    opacity.value = withTiming(1, { ...timingConfigs.normal, duration: timingConfigs.normal.duration + delay });
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

  const setValue = useCallback((newValue: number) => {
    animatedValue.value = withTiming(newValue, config);
  }, [animatedValue, config]);

  const setValueInstant = useCallback((newValue: number) => {
    animatedValue.value = newValue;
  }, [animatedValue]);

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

  const startShimmer = useCallback(() => {
    shimmerPosition.value = withRepeat(
      withTiming(1, { duration, easing: Easing.linear }),
      -1,
      false
    );
  }, [shimmerPosition, duration]);

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
 * Hook for staggered list entrance animations
 * Returns a function that creates delayed entrance for each item
 */
export function useStaggeredEntrance(
  itemCount: number,
  baseDelay: number = 50
) {
  const opacities = Array.from({ length: itemCount }, () => useSharedValue(0));
  const translations = Array.from({ length: itemCount }, () => useSharedValue(20));

  const animateIn = useCallback(() => {
    opacities.forEach((opacity, index) => {
      const delay = index * baseDelay;
      opacity.value = withTiming(1, {
        ...timingConfigs.normal,
        duration: timingConfigs.normal.duration + delay
      });
    });
    translations.forEach((translation, index) => {
      const delay = index * baseDelay;
      setTimeout(() => {
        translation.value = withSpring(0, springConfigs.smooth);
      }, delay);
    });
  }, [opacities, translations, baseDelay]);

  const reset = useCallback(() => {
    opacities.forEach(opacity => {
      opacity.value = 0;
    });
    translations.forEach(translation => {
      translation.value = 20;
    });
  }, [opacities, translations]);

  const getItemStyle = useCallback((index: number) => {
    const opacity = opacities[index];
    const translateY = translations[index];

    return useAnimatedStyle(() => ({
      opacity: opacity?.value ?? 1,
      transform: [{ translateY: translateY?.value ?? 0 }],
    }));
  }, [opacities, translations]);

  return {
    animateIn,
    reset,
    getItemStyle,
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
 * Utility to create a delayed animation
 */
export function withDelay<T>(
  delay: number,
  animation: T
): T {
  // Note: react-native-reanimated has its own withDelay, but this wrapper
  // provides consistent typing
  const { withDelay: reanimatedWithDelay } = require('react-native-reanimated');
  return reanimatedWithDelay(delay, animation);
}

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
        opacity.value = withTiming(1, { duration, easing: Easing.out(Easing.ease) });
      }, delay);
    } else {
      opacity.value = withTiming(1, { duration, easing: Easing.out(Easing.ease) });
    }
  }, [opacity, delay, duration]);

  const fadeOut = useCallback(() => {
    opacity.value = withTiming(0, { duration: duration / 2, easing: Easing.in(Easing.ease) });
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
  const translateX = useSharedValue(direction === 'left' ? -distance : direction === 'right' ? distance : 0);
  const translateY = useSharedValue(direction === 'up' ? distance : direction === 'down' ? -distance : 0);
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
    translateX.value = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
    translateY.value = direction === 'up' ? distance : direction === 'down' ? -distance : 0;
    opacity.value = 0;
  }, [translateX, translateY, opacity, direction, distance]);

  return { animatedStyle, slideIn, reset };
}

/**
 * Staggered children entrance - for lists
 * Returns a function to get delay for each index
 */
export function getStaggerDelay(index: number, baseDelay: number = 50, maxDelay: number = 500): number {
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
    rotateY.value = withTiming(isFlipped.value ? 180 : 0, { duration, easing: Easing.inOut(Easing.ease) });
  }, [rotateY, isFlipped, duration]);

  return { frontAnimatedStyle, backAnimatedStyle, flip, isFlipped };
}
