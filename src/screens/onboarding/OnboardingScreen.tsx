import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { StackNavigationProp } from '@react-navigation/stack';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { RootStackParamList } from '@/navigation/AppNavigator';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassCard } from '@/components/common/GlassCard';
import { springConfigs, getStaggerDelay } from '@/utils/animations';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Animated option card with staggered entrance
interface OptionCardWithAnimationProps {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
  index: number;
}

function OptionCardWithAnimation({ icon, title, subtitle, onPress, theme, styles, index }: OptionCardWithAnimationProps) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(20);

  const handlePressIn = useCallback(() => {
    scale.value = withSpring(0.97, springConfigs.snappy);
  }, [scale]);

  const handlePressOut = useCallback(() => {
    scale.value = withSpring(1, springConfigs.snappy);
  }, [scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }, { translateY: translateY.value }],
    opacity: opacity.value,
  }));

  // Trigger entrance animation on mount with staggered delay
  React.useEffect(() => {
    const delay = getStaggerDelay(index, 80, 400);
    setTimeout(() => {
      opacity.value = withTiming(1, { duration: 400, easing: Easing.out(Easing.ease) });
      translateY.value = withSpring(0, springConfigs.smooth);
    }, delay);
  }, [index, opacity, translateY]);

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
    >
      <GlassCard variant="medium">
        <View style={styles.optionButton}>
          <View style={[styles.optionIcon, { backgroundColor: `${theme.colors.primary}15` }]}>
            <Ionicons name={icon} size={24} color={theme.colors.primary} />
          </View>
          <View style={styles.optionContent}>
            <Text style={[styles.optionTitle, { color: theme.colors.text }]}>{title}</Text>
            <Text style={[styles.optionSubtitle, { color: theme.colors.textMuted }]}>{subtitle}</Text>
          </View>
          <View style={styles.optionChevron}>
            <Ionicons name="chevron-forward" size={20} color={theme.colors.textMuted} />
          </View>
        </View>
      </GlassCard>
    </AnimatedPressable>
  );
}

type OnboardingScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'Onboarding'
>;

interface Props {
  navigation: OnboardingScreenNavigationProp;
}

export default function OnboardingScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  // Header entrance animation
  const headerOpacity = useSharedValue(0);
  const headerTranslateY = useSharedValue(-20);

  const headerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: headerOpacity.value,
    transform: [{ translateY: headerTranslateY.value }],
  }));

  React.useEffect(() => {
    headerOpacity.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.ease) });
    headerTranslateY.value = withSpring(0, springConfigs.smooth);
  }, [headerOpacity, headerTranslateY]);

  const accountOptions = [
    {
      id: 'create',
      title: 'Create New Account',
      subtitle: 'Generate a new account and backup its recovery phrase',
      icon: 'add-circle-outline' as const,
      onPress: () => navigation.navigate('CreateWallet'),
    },
    {
      id: 'import',
      title: 'Import Account',
      subtitle: 'Import existing account with seed phrase',
      icon: 'download-outline' as const,
      onPress: () =>
        navigation.navigate('MnemonicImport', { isOnboarding: true }),
    },
    {
      id: 'ledger',
      title: 'Connect Ledger',
      subtitle: 'Import accounts secured with your Ledger hardware wallet',
      icon: 'hardware-chip-outline' as const,
      onPress: () =>
        navigation.navigate('LedgerAccountImport', { isOnboarding: true }),
    },
    {
      id: 'importQR',
      title: 'Import via QR Code',
      subtitle: 'Scan QR codes to import multiple accounts',
      icon: 'qr-code-outline' as const,
      onPress: () => navigation.navigate('QRAccountImport'),
    },
    {
      id: 'watch',
      title: 'Add Watch Account',
      subtitle: 'Monitor an account without private key access',
      icon: 'eye-outline' as const,
      onPress: () =>
        navigation.navigate('AddWatchAccount', { isOnboarding: true }),
    },
  ];

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={[styles.header, headerAnimatedStyle]}>
            <Text style={[styles.title, { color: theme.colors.text }]}>
              Welcome to Voi Wallet
            </Text>
            <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>
              Your secure gateway to the Voi Network. Choose how you want to get
              started.
            </Text>
          </Animated.View>

          <View style={styles.optionsContainer}>
            {accountOptions.map((option, index) => (
              <OptionCardWithAnimation
                key={option.id}
                icon={option.icon}
                title={option.title}
                subtitle={option.subtitle}
                onPress={option.onPress}
                theme={theme}
                styles={styles}
                index={index}
              />
            ))}
          </View>

          <View style={styles.bottomLinks}>
            <Pressable
              onPress={() => navigation.navigate('Main')}
              style={styles.skipButton}
            >
              <Text style={[styles.skipText, { color: theme.colors.textMuted }]}>
                Continue without account
              </Text>
            </Pressable>
            <Pressable
              onPress={() => navigation.navigate('RestoreWallet', { isOnboarding: true })}
              style={styles.restoreButton}
            >
              <Text style={[styles.restoreText, { color: theme.colors.primary }]}>
                or restore from backup
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    content: {
      flexGrow: 1,
      justifyContent: 'center',
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    header: {
      alignItems: 'center',
      marginBottom: theme.spacing.xxl,
    },
    title: {
      fontSize: theme.typography.display.fontSize,
      fontWeight: '700',
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
      letterSpacing: theme.typography.display.letterSpacing,
    },
    subtitle: {
      fontSize: theme.typography.body.fontSize,
      textAlign: 'center',
      lineHeight: 24,
    },
    optionsContainer: {
      gap: theme.spacing.md,
    },
    optionButton: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      borderRadius: theme.borderRadius.xl,
    },
    optionIcon: {
      width: 44,
      height: 44,
      borderRadius: theme.borderRadius.lg,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.md,
      marginTop: 2,
    },
    optionContent: {
      flex: 1,
      flexShrink: 1,
    },
    optionTitle: {
      fontSize: theme.typography.body.fontSize,
      fontWeight: '600',
      marginBottom: 4,
    },
    optionSubtitle: {
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: 18,
    },
    optionChevron: {
      flexShrink: 0,
      marginLeft: theme.spacing.sm,
      alignSelf: 'center',
    },
    bottomLinks: {
      alignItems: 'center',
      marginTop: theme.spacing.xl,
    },
    skipButton: {
      paddingVertical: theme.spacing.md,
    },
    skipText: {
      textAlign: 'center',
      fontSize: theme.typography.bodySmall.fontSize,
    },
    restoreButton: {
      paddingVertical: theme.spacing.sm,
    },
    restoreText: {
      textAlign: 'center',
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: '500',
    },
  });
