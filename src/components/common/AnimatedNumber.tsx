/**
 * AnimatedNumber - Smooth number transition component
 *
 * Displays numbers with smooth transition animations when values change.
 * Supports currency formatting, decimal precision, and optional glow effects.
 */

import React, { useMemo, useEffect, useCallback } from 'react';
import { View, StyleSheet, TextStyle, StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  useDerivedValue,
  useAnimatedProps,
  runOnJS,
} from 'react-native-reanimated';
import { useTheme } from '@/contexts/ThemeContext';
import { timingConfigs } from '@/utils/animations';

interface AnimatedNumberProps {
  /** The number value to display */
  value: number;
  /** Number of decimal places */
  decimals?: number;
  /** Currency symbol prefix */
  prefix?: string;
  /** Currency symbol suffix */
  suffix?: string;
  /** Text style */
  style?: StyleProp<TextStyle>;
  /** Container style */
  containerStyle?: StyleProp<ViewStyle>;
  /** Enable glow effect on value change */
  glowOnChange?: boolean;
  /** Duration of animation in ms */
  duration?: number;
  /** Show shimmer loading state */
  loading?: boolean;
  /** Format as compact (e.g., 1.2K, 1.5M) */
  compact?: boolean;
  /** Test ID */
  testID?: string;
}

// Create animated text component
const AnimatedText = Animated.Text;

export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  decimals = 2,
  prefix = '',
  suffix = '',
  style,
  containerStyle,
  glowOnChange = false,
  duration = 400,
  loading = false,
  compact = false,
  testID,
}) => {
  const { theme } = useTheme();

  // Animation values
  const animatedValue = useSharedValue(value);
  const glowOpacity = useSharedValue(0);
  const previousValue = useSharedValue(value);

  // Format number with commas and decimals
  const formatNumber = useCallback((num: number): string => {
    if (compact) {
      if (Math.abs(num) >= 1e9) {
        return (num / 1e9).toFixed(1) + 'B';
      }
      if (Math.abs(num) >= 1e6) {
        return (num / 1e6).toFixed(1) + 'M';
      }
      if (Math.abs(num) >= 1e3) {
        return (num / 1e3).toFixed(1) + 'K';
      }
    }

    // Add thousand separators
    const parts = num.toFixed(decimals).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }, [decimals, compact]);

  // Update animation when value changes
  useEffect(() => {
    // Trigger glow effect on value change
    if (glowOnChange && previousValue.value !== value) {
      glowOpacity.value = withTiming(1, { duration: 100 });
      glowOpacity.value = withTiming(0, { duration: duration });
    }

    previousValue.value = value;
    animatedValue.value = withTiming(value, { duration });
  }, [value, animatedValue, glowOpacity, glowOnChange, duration, previousValue]);

  // Derived formatted value
  const [displayText, setDisplayText] = React.useState(() =>
    `${prefix}${formatNumber(value)}${suffix}`
  );

  // Update display text based on animated value
  useDerivedValue(() => {
    const formatted = formatNumber(animatedValue.value);
    runOnJS(setDisplayText)(`${prefix}${formatted}${suffix}`);
    return formatted;
  });

  // Glow style
  const animatedGlowStyle = useAnimatedStyle(() => ({
    textShadowColor: theme.colors.primary,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: glowOpacity.value * 12,
  }));

  // Shimmer loading state
  const shimmerOpacity = useSharedValue(0.3);

  useEffect(() => {
    if (loading) {
      // Create shimmer effect
      const interval = setInterval(() => {
        shimmerOpacity.value = withTiming(
          shimmerOpacity.value === 0.3 ? 0.7 : 0.3,
          { duration: 800 }
        );
      }, 800);
      return () => clearInterval(interval);
    } else {
      shimmerOpacity.value = 1;
    }
  }, [loading, shimmerOpacity]);

  const animatedShimmerStyle = useAnimatedStyle(() => ({
    opacity: loading ? shimmerOpacity.value : 1,
  }));

  // Combined text styles
  const textStyles = useMemo(() => [
    styles.text,
    {
      color: theme.colors.text,
    },
    style,
  ], [theme.colors.text, style]);

  if (loading) {
    return (
      <View style={[styles.container, containerStyle]} testID={testID}>
        <Animated.View style={[styles.shimmerContainer, animatedShimmerStyle]}>
          <View
            style={[
              styles.shimmerBar,
              {
                backgroundColor: theme.colors.glassBackground,
                borderRadius: theme.borderRadius.sm,
              },
            ]}
          />
        </Animated.View>
      </View>
    );
  }

  return (
    <View style={[styles.container, containerStyle]} testID={testID}>
      <AnimatedText
        style={[textStyles, glowOnChange && animatedGlowStyle]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {displayText}
      </AnimatedText>
    </View>
  );
};

/**
 * AnimatedBalance - Specialized component for displaying wallet balances
 * with currency formatting and appropriate styling
 */
interface AnimatedBalanceProps {
  /** Balance value */
  value: number;
  /** Currency symbol (e.g., '$', 'VOI') */
  currency?: string;
  /** Show currency before or after value */
  currencyPosition?: 'prefix' | 'suffix';
  /** Use large display style */
  large?: boolean;
  /** Text style override */
  style?: StyleProp<TextStyle>;
  /** Show change glow */
  glowOnChange?: boolean;
  /** Loading state */
  loading?: boolean;
  /** Test ID */
  testID?: string;
}

export const AnimatedBalance: React.FC<AnimatedBalanceProps> = ({
  value,
  currency = '$',
  currencyPosition = 'prefix',
  large = false,
  style,
  glowOnChange = true,
  loading = false,
  testID,
}) => {
  const { theme } = useTheme();

  const balanceStyle = useMemo((): TextStyle => ({
    fontSize: large ? theme.typography.display.fontSize : theme.typography.heading1.fontSize,
    fontWeight: theme.typography.display.fontWeight,
    letterSpacing: theme.typography.display.letterSpacing,
    color: theme.colors.text,
  }), [large, theme]);

  return (
    <AnimatedNumber
      value={value}
      decimals={2}
      prefix={currencyPosition === 'prefix' ? currency : ''}
      suffix={currencyPosition === 'suffix' ? ` ${currency}` : ''}
      style={[balanceStyle, style]}
      glowOnChange={glowOnChange}
      loading={loading}
      testID={testID}
    />
  );
};

/**
 * AnimatedPercentage - Component for displaying percentage values
 * with appropriate formatting and color coding
 */
interface AnimatedPercentageProps {
  /** Percentage value (e.g., 5.5 for 5.5%) */
  value: number;
  /** Show + sign for positive values */
  showSign?: boolean;
  /** Color code based on positive/negative */
  colorCoded?: boolean;
  /** Text style override */
  style?: StyleProp<TextStyle>;
  /** Test ID */
  testID?: string;
}

export const AnimatedPercentage: React.FC<AnimatedPercentageProps> = ({
  value,
  showSign = true,
  colorCoded = true,
  style,
  testID,
}) => {
  const { theme } = useTheme();

  const percentageStyle = useMemo((): TextStyle => {
    let color = theme.colors.text;
    if (colorCoded) {
      if (value > 0) color = theme.colors.success;
      else if (value < 0) color = theme.colors.error;
    }
    return {
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: '600',
      color,
    };
  }, [value, colorCoded, theme]);

  const prefix = showSign && value > 0 ? '+' : '';

  return (
    <AnimatedNumber
      value={value}
      decimals={2}
      prefix={prefix}
      suffix="%"
      style={[percentageStyle, style]}
      duration={300}
      testID={testID}
    />
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  text: {
    fontVariant: ['tabular-nums'],
  },
  shimmerContainer: {
    width: '100%',
  },
  shimmerBar: {
    height: 24,
    width: '60%',
  },
});

export default AnimatedNumber;
