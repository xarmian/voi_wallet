import React, { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import AccountSelector from '../account/AccountSelector';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { SafeBlurView } from './SafeBlurView';
import { springConfigs, timingConfigs } from '@/utils/animations';

interface UniversalHeaderProps {
  title: string;
  subtitle?: string;
  onAccountSelectorPress: () => void;
  showAccountSelector?: boolean;
  showBackButton?: boolean;
  onBackPress?: () => void;
  rightAction?: React.ReactNode;
  /** Make header floating with glass effect */
  floating?: boolean;
  /** Show bottom border */
  showBorder?: boolean;
  /** Large title style */
  largeTitle?: boolean;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function UniversalHeader({
  title,
  subtitle,
  onAccountSelectorPress,
  showAccountSelector = true,
  showBackButton = false,
  onBackPress,
  rightAction,
  floating = false,
  showBorder = false,
  largeTitle = false,
}: UniversalHeaderProps) {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const { theme } = useTheme();
  const hasNFTBackground = !!theme.backgroundImageUrl;
  const isDark = theme.mode === 'dark';

  // Back button animation
  const backButtonScale = useSharedValue(1);

  const handleBackPressIn = useCallback(() => {
    backButtonScale.value = withSpring(0.9, springConfigs.snappy);
  }, [backButtonScale]);

  const handleBackPressOut = useCallback(() => {
    backButtonScale.value = withSpring(1, springConfigs.snappy);
  }, [backButtonScale]);

  const animatedBackButtonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: backButtonScale.value }],
  }));

  // Glass background colors
  const glassBackgroundColor = useMemo(() => {
    if (floating || hasNFTBackground) {
      return isDark
        ? 'rgba(20, 20, 25, 0.75)'
        : 'rgba(255, 255, 255, 0.8)';
    }
    return 'transparent';
  }, [floating, hasNFTBackground, isDark]);

  // Highlight gradient for glass effect
  const highlightColors = useMemo((): [string, string] => {
    return isDark
      ? ['rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0)']
      : ['rgba(255, 255, 255, 0.5)', 'rgba(255, 255, 255, 0)'];
  }, [isDark]);

  const headerContent = (
    <>
      {/* Back button with glass pill */}
      {showBackButton && (
        <AnimatedPressable
          style={[styles.backButton, animatedBackButtonStyle]}
          onPress={onBackPress}
          onPressIn={handleBackPressIn}
          onPressOut={handleBackPressOut}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <View
            style={[
              styles.backButtonInner,
              {
                backgroundColor: theme.colors.glassBackground,
                borderColor: theme.colors.glassBorder,
              },
            ]}
          >
            <Ionicons
              name="chevron-back"
              size={22}
              color={themeColors.text}
            />
          </View>
        </AnimatedPressable>
      )}

      {/* Title section */}
      <View style={styles.titleContainer}>
        <Text
          style={[
            largeTitle ? styles.largeTitle : styles.title,
            { color: themeColors.text },
          ]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {subtitle && (
          <Text
            style={[styles.subtitle, { color: themeColors.textMuted }]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        )}
      </View>

      {/* Right side: account selector and/or right action */}
      <View style={styles.rightSideContainer}>
        {/* Account selector with glass styling */}
        {showAccountSelector && (
          <View style={styles.accountSelectorContainer}>
            <AccountSelector
              onPress={onAccountSelectorPress}
              compact={true}
              showBalance={false}
            />
          </View>
        )}

        {/* Right action area */}
        {rightAction && (
          <View style={styles.rightActionContainer}>
            {rightAction}
          </View>
        )}
      </View>
    </>
  );

  // Floating glass header or NFT background header
  if (hasNFTBackground || floating) {
    const blurTint = isDark ? 'dark' : 'light';
    return (
      <SafeBlurView
        intensity={theme.glass.medium.blur}
        tint={blurTint}
        style={[
          styles.header,
          floating && styles.floatingHeader,
          {
            borderBottomColor: showBorder ? theme.colors.glassBorder : 'transparent',
            borderBottomWidth: showBorder ? 1 : 0,
          },
        ]}
      >
        {/* Glass overlay */}
        <View
          style={[
            styles.glassOverlay,
            { backgroundColor: glassBackgroundColor },
          ]}
          pointerEvents="none"
        />

        {/* Top highlight gradient for glass depth */}
        <LinearGradient
          colors={highlightColors}
          style={styles.highlightGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          pointerEvents="none"
        />

        {/* Header content */}
        <View style={styles.headerContent}>
          {headerContent}
        </View>
      </SafeBlurView>
    );
  }

  // Standard header (no glass effect)
  return (
    <View
      style={[
        styles.header,
        {
          backgroundColor: theme.colors.background,
          borderBottomColor: showBorder ? theme.colors.border : 'transparent',
          borderBottomWidth: showBorder ? 1 : 0,
        },
      ]}
    >
      {headerContent}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      position: 'relative',
      overflow: 'hidden',
    },
    floatingHeader: {
      marginHorizontal: theme.spacing.md,
      marginTop: theme.spacing.sm,
      borderRadius: theme.borderRadius.xl,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
    },
    glassOverlay: {
      ...StyleSheet.absoluteFillObject,
    },
    highlightGradient: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 32,
    },
    headerContent: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      flex: 1,
      position: 'relative',
      zIndex: 1,
    },
    backButton: {
      marginRight: theme.spacing.sm,
    },
    backButtonInner: {
      width: 36,
      height: 36,
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    titleContainer: {
      flex: 1,
      paddingRight: theme.spacing.sm,
    },
    title: {
      fontSize: theme.typography.heading2.fontSize,
      fontWeight: theme.typography.heading2.fontWeight,
      letterSpacing: theme.typography.heading2.letterSpacing,
    },
    largeTitle: {
      fontSize: theme.typography.heading1.fontSize,
      fontWeight: theme.typography.heading1.fontWeight,
      letterSpacing: theme.typography.heading1.letterSpacing,
    },
    subtitle: {
      fontSize: theme.typography.caption.fontSize,
      fontWeight: theme.typography.caption.fontWeight,
      marginTop: 2,
    },
    rightSideContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    accountSelectorContainer: {
      maxWidth: 200,
      minWidth: 120,
    },
    rightActionContainer: {
      flexDirection: 'row',
      alignItems: 'center',
    },
  });
