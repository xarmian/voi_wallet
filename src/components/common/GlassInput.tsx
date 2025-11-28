/**
 * GlassInput - Premium liquid-glass text input component
 *
 * A sophisticated text input with glass morphism effects, animated focus states,
 * and optional floating labels. Works seamlessly with NFT background theming.
 */

import React, { useMemo, useCallback, useState, useRef } from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  Pressable,
  TextInputProps,
  ViewStyle,
  TextStyle,
  StyleProp,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  interpolate,
  interpolateColor,
} from 'react-native-reanimated';
import { useTheme } from '@/contexts/ThemeContext';
import { SafeBlurView } from './SafeBlurView';
import { springConfigs, timingConfigs } from '@/utils/animations';

export type InputSize = 'sm' | 'md' | 'lg';

interface GlassInputProps extends Omit<TextInputProps, 'style'> {
  /** Input size */
  size?: InputSize;
  /** Label text */
  label?: string;
  /** Use floating label animation */
  floatingLabel?: boolean;
  /** Helper text shown below input */
  helperText?: string;
  /** Error state */
  error?: boolean;
  /** Error message */
  errorMessage?: string;
  /** Left icon */
  leftIcon?: keyof typeof Ionicons.glyphMap;
  /** Right icon */
  rightIcon?: keyof typeof Ionicons.glyphMap;
  /** Right icon press handler */
  onRightIconPress?: () => void;
  /** Container style */
  containerStyle?: StyleProp<ViewStyle>;
  /** Input style */
  inputStyle?: StyleProp<TextStyle>;
  /** Enable clear button */
  clearButton?: boolean;
  /** Test ID */
  testID?: string;
}

const AnimatedView = Animated.View;
const AnimatedText = Animated.Text;
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

export const GlassInput: React.FC<GlassInputProps> = ({
  size = 'md',
  label,
  floatingLabel = false,
  helperText,
  error = false,
  errorMessage,
  leftIcon,
  rightIcon,
  onRightIconPress,
  containerStyle,
  inputStyle,
  clearButton = false,
  value,
  onChangeText,
  onFocus,
  onBlur,
  placeholder,
  testID,
  ...textInputProps
}) => {
  const { theme } = useTheme();
  const hasNFTBackground = !!theme.backgroundImageUrl;
  const inputRef = useRef<TextInput>(null);

  // State
  const [isFocused, setIsFocused] = useState(false);

  // Animation values
  const focusProgress = useSharedValue(0);
  const labelProgress = useSharedValue(value ? 1 : 0);

  // Size configuration
  const sizeConfig = useMemo(() => {
    switch (size) {
      case 'sm':
        return {
          height: 40,
          fontSize: 14,
          labelFontSize: 12,
          iconSize: 18,
          borderRadius: theme.borderRadius.md,
          paddingHorizontal: theme.spacing.md,
        };
      case 'lg':
        return {
          height: 56,
          fontSize: 17,
          labelFontSize: 14,
          iconSize: 24,
          borderRadius: theme.borderRadius.xl,
          paddingHorizontal: theme.spacing.lg,
        };
      default: // md
        return {
          height: 48,
          fontSize: 16,
          labelFontSize: 13,
          iconSize: 20,
          borderRadius: theme.borderRadius.lg,
          paddingHorizontal: theme.spacing.md,
        };
    }
  }, [size, theme.spacing, theme.borderRadius]);

  // Handle focus
  const handleFocus = useCallback((e: any) => {
    setIsFocused(true);
    focusProgress.value = withSpring(1, springConfigs.snappy);
    if (floatingLabel) {
      labelProgress.value = withSpring(1, springConfigs.smooth);
    }
    onFocus?.(e);
  }, [focusProgress, labelProgress, floatingLabel, onFocus]);

  // Handle blur
  const handleBlur = useCallback((e: any) => {
    setIsFocused(false);
    focusProgress.value = withSpring(0, springConfigs.snappy);
    if (floatingLabel && !value) {
      labelProgress.value = withSpring(0, springConfigs.smooth);
    }
    onBlur?.(e);
  }, [focusProgress, labelProgress, floatingLabel, value, onBlur]);

  // Handle clear
  const handleClear = useCallback(() => {
    onChangeText?.('');
    inputRef.current?.focus();
  }, [onChangeText]);

  // Border color based on state
  const getBorderColor = useCallback(() => {
    if (error) return theme.colors.error;
    if (isFocused) return theme.colors.primary;
    return theme.colors.glassBorder;
  }, [error, isFocused, theme.colors]);

  // Animated container style
  const animatedContainerStyle = useAnimatedStyle(() => {
    const borderColor = interpolateColor(
      focusProgress.value,
      [0, 1],
      [theme.colors.glassBorder, error ? theme.colors.error : theme.colors.primary]
    );

    return {
      borderColor,
      borderWidth: interpolate(focusProgress.value, [0, 1], [1, 1.5]),
    };
  });

  // Animated floating label style
  const animatedLabelStyle = useAnimatedStyle(() => {
    const translateY = interpolate(
      labelProgress.value,
      [0, 1],
      [0, -(sizeConfig.height / 2 + sizeConfig.labelFontSize / 2 - 2)]
    );
    const scale = interpolate(labelProgress.value, [0, 1], [1, 0.85]);
    const opacity = interpolate(labelProgress.value, [0, 0.5, 1], [0.6, 0.8, 1]);

    return {
      transform: [{ translateY }, { scale }],
      opacity,
    };
  });

  // Animated glow style
  const animatedGlowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(focusProgress.value, [0, 1], [0, error ? 0.15 : 0.25]),
  }));

  // Container styles
  const containerStyles = useMemo((): ViewStyle[] => [
    styles.container,
    {
      height: sizeConfig.height,
      borderRadius: sizeConfig.borderRadius,
    },
    containerStyle as ViewStyle,
  ].filter(Boolean), [sizeConfig, containerStyle]);

  // Show clear button
  const showClear = clearButton && value && value.length > 0;

  return (
    <View style={styles.wrapper}>
      {/* Static label (non-floating) */}
      {label && !floatingLabel && (
        <AnimatedText
          style={[
            styles.staticLabel,
            {
              fontSize: sizeConfig.labelFontSize,
              color: error ? theme.colors.error : theme.colors.textSecondary,
              marginBottom: theme.spacing.xs,
            },
          ]}
        >
          {label}
        </AnimatedText>
      )}

      <Pressable onPress={() => inputRef.current?.focus()}>
        <AnimatedView style={[containerStyles, animatedContainerStyle]}>
          {/* Glow effect on focus */}
          <AnimatedView
            style={[
              styles.glowLayer,
              {
                backgroundColor: error ? theme.colors.glowError : theme.colors.glowPrimary,
                borderRadius: sizeConfig.borderRadius,
              },
              animatedGlowStyle,
            ]}
            pointerEvents="none"
          />

          {/* Glass background */}
          {hasNFTBackground ? (
            <SafeBlurView
              intensity={theme.glass.light.blur}
              tint={theme.mode === 'dark' ? 'dark' : 'light'}
              style={[StyleSheet.absoluteFill, { borderRadius: sizeConfig.borderRadius }]}
            />
          ) : null}

          {/* Background overlay */}
          <View
            style={[
              styles.background,
              {
                backgroundColor: hasNFTBackground
                  ? theme.mode === 'dark'
                    ? 'rgba(0, 0, 0, 0.35)'
                    : 'rgba(255, 255, 255, 0.4)'
                  : theme.colors.inputBackground,
                borderRadius: sizeConfig.borderRadius,
              },
            ]}
          />

          {/* Content row */}
          <View style={[styles.inputRow, { paddingHorizontal: sizeConfig.paddingHorizontal }]}>
            {/* Left icon */}
            {leftIcon && (
              <Ionicons
                name={leftIcon}
                size={sizeConfig.iconSize}
                color={error ? theme.colors.error : theme.colors.textMuted}
                style={styles.leftIcon}
              />
            )}

            {/* Floating label */}
            {label && floatingLabel && (
              <AnimatedText
                style={[
                  styles.floatingLabel,
                  {
                    fontSize: sizeConfig.fontSize,
                    color: error ? theme.colors.error : theme.colors.textMuted,
                    left: leftIcon ? sizeConfig.paddingHorizontal + sizeConfig.iconSize + 8 : sizeConfig.paddingHorizontal,
                  },
                  animatedLabelStyle,
                ]}
                pointerEvents="none"
              >
                {label}
              </AnimatedText>
            )}

            {/* Text input */}
            <TextInput
              ref={inputRef}
              value={value}
              onChangeText={onChangeText}
              onFocus={handleFocus}
              onBlur={handleBlur}
              placeholder={floatingLabel ? undefined : placeholder}
              placeholderTextColor={theme.colors.placeholder}
              style={[
                styles.input,
                {
                  fontSize: sizeConfig.fontSize,
                  color: theme.colors.text,
                  paddingLeft: leftIcon ? 8 : 0,
                  paddingRight: (rightIcon || showClear) ? 8 : 0,
                },
                inputStyle,
              ]}
              selectionColor={theme.colors.primary}
              testID={testID}
              {...textInputProps}
            />

            {/* Clear button */}
            {showClear && !rightIcon && (
              <Pressable onPress={handleClear} style={styles.iconButton} hitSlop={8}>
                <Ionicons
                  name="close-circle"
                  size={sizeConfig.iconSize}
                  color={theme.colors.textMuted}
                />
              </Pressable>
            )}

            {/* Right icon */}
            {rightIcon && (
              <Pressable
                onPress={onRightIconPress}
                style={styles.iconButton}
                hitSlop={8}
                disabled={!onRightIconPress}
              >
                <Ionicons
                  name={rightIcon}
                  size={sizeConfig.iconSize}
                  color={error ? theme.colors.error : theme.colors.textMuted}
                />
              </Pressable>
            )}
          </View>
        </AnimatedView>
      </Pressable>

      {/* Helper/Error text */}
      {(helperText || errorMessage) && (
        <AnimatedText
          style={[
            styles.helperText,
            {
              fontSize: sizeConfig.labelFontSize - 1,
              color: error ? theme.colors.error : theme.colors.textMuted,
              marginTop: theme.spacing.xs,
              marginLeft: theme.spacing.sm,
            },
          ]}
        >
          {error ? errorMessage : helperText}
        </AnimatedText>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
  },
  container: {
    overflow: 'hidden',
    position: 'relative',
  },
  background: {
    ...StyleSheet.absoluteFillObject,
  },
  glowLayer: {
    ...StyleSheet.absoluteFillObject,
    transform: [{ scale: 1.08 }],
  },
  inputRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 1,
  },
  input: {
    flex: 1,
    height: '100%',
    padding: 0,
    margin: 0,
    ...Platform.select({
      web: {
        outlineStyle: 'none',
      },
    }),
  },
  leftIcon: {
    marginRight: 0,
  },
  iconButton: {
    padding: 4,
  },
  staticLabel: {
    fontWeight: '500',
  },
  floatingLabel: {
    position: 'absolute',
    backgroundColor: 'transparent',
    fontWeight: '500',
  },
  helperText: {
    fontWeight: '400',
  },
});

export default GlassInput;
