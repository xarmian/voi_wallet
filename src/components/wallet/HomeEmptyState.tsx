import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassCard } from '@/components/common/GlassCard';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface Props {
  walletLoadFailed: boolean;
  onGetStarted: () => void;
  onTryAgain: () => void;
}

export default function HomeEmptyState({
  walletLoadFailed,
  onGetStarted,
  onTryAgain,
}: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.emptyStateContainer}>
      <GlassCard
        variant="medium"
        style={styles.emptyStateCard}
        borderRadius={theme.borderRadius.xl}
        padding="lg"
      >
        <View style={styles.emptyStateIconContainer}>
          <Ionicons
            name="wallet-outline"
            size={64}
            color={theme.colors.primary}
          />
        </View>
        <Text style={styles.emptyStateTitle}>
          {walletLoadFailed
            ? "We couldn't load your accounts. Nothing was changed."
            : 'Welcome to Voi Wallet'}
        </Text>
        {!walletLoadFailed && (
          <Text style={styles.emptyStateSubtitle}>
            Set up an account to access all wallet features including sending,
            receiving, and managing your assets.
          </Text>
        )}
        <Pressable
          style={[
            styles.emptyStateButton,
            { backgroundColor: theme.colors.primary },
          ]}
          onPress={walletLoadFailed ? onTryAgain : onGetStarted}
        >
          <Text style={styles.emptyStateButtonText}>
            {walletLoadFailed ? 'Try again' : 'Get Started'}
          </Text>
        </Pressable>
      </GlassCard>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    emptyStateContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: theme.spacing.xxl,
    },
    emptyStateCard: {
      alignItems: 'center',
      width: '100%',
    },
    emptyStateIconContainer: {
      width: 120,
      height: 120,
      borderRadius: 60,
      backgroundColor: `${theme.colors.primary}15`,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: theme.spacing.lg,
    },
    emptyStateTitle: {
      fontSize: theme.typography.heading2.fontSize,
      fontWeight: '700',
      color: theme.colors.text,
      textAlign: 'center',
      marginBottom: theme.spacing.sm,
    },
    emptyStateSubtitle: {
      fontSize: theme.typography.body.fontSize,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
      marginBottom: theme.spacing.xl,
      paddingHorizontal: theme.spacing.md,
    },
    emptyStateButton: {
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.xxl,
      borderRadius: theme.borderRadius.lg,
    },
    emptyStateButtonText: {
      fontSize: theme.typography.body.fontSize,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });
