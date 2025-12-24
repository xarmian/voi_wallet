/**
 * Experimental Features Screen
 *
 * Allows users to enable or disable experimental features that are still in development.
 * All features default to OFF and persist across app restarts.
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import { NFTBackground } from '@/components/common/NFTBackground';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useExperimentalStore } from '@/store/experimentalStore';

interface SettingToggleProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}

function SettingToggle({
  icon,
  label,
  description,
  value,
  onValueChange,
}: SettingToggleProps) {
  const { theme } = useTheme();
  const themeColors = useThemeColors();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.glassBorder,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: theme.borderRadius.sm,
          backgroundColor: `${theme.colors.primary}15`,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: theme.spacing.md,
        }}
      >
        <Ionicons name={icon} size={18} color={theme.colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontSize: theme.typography.body.fontSize,
            fontWeight: '600',
            color: themeColors.text,
          }}
        >
          {label}
        </Text>
        {description && (
          <Text
            style={{
              fontSize: theme.typography.caption.fontSize,
              color: themeColors.textMuted,
              marginTop: 2,
            }}
          >
            {description}
          </Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{
          false: theme.colors.glassBorder,
          true: theme.colors.primary,
        }}
        thumbColor={value ? '#FFFFFF' : '#F4F3F4'}
        ios_backgroundColor={theme.colors.glassBorder}
      />
    </View>
  );
}

function SectionHeader({ title, icon }: { title: string; icon: keyof typeof Ionicons.glyphMap }) {
  const { theme } = useTheme();
  const themeColors = useThemeColors();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        backgroundColor: theme.colors.glassBackground,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.glassBorder,
      }}
    >
      <Ionicons
        name={icon}
        size={16}
        color={theme.colors.primary}
        style={{ marginRight: theme.spacing.sm }}
      />
      <Text
        style={{
          fontSize: theme.typography.caption.fontSize,
          fontWeight: '600',
          color: themeColors.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {title}
      </Text>
    </View>
  );
}

export default function ExperimentalFeaturesScreen() {
  const navigation = useNavigation();
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const styles = useThemedStyles(createStyles);

  const swapEnabled = useExperimentalStore((state) => state.swapEnabled);
  const messagingEnabled = useExperimentalStore((state) => state.messagingEnabled);
  const setSwapEnabled = useExperimentalStore((state) => state.setSwapEnabled);
  const setMessagingEnabled = useExperimentalStore((state) => state.setMessagingEnabled);

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Experimental Features"
          showBackButton
          onBackPress={() => navigation.goBack()}
        />
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Warning Banner */}
          <GlassCard variant="light" style={styles.warningCard}>
            <View style={styles.warningContent}>
              <Ionicons
                name="warning-outline"
                size={24}
                color={theme.colors.warning}
                style={{ marginRight: theme.spacing.sm }}
              />
              <Text style={[styles.warningText, { color: themeColors.text }]}>
                These features are still in development and may not work as expected.
                Enable at your own discretion.
              </Text>
            </View>
          </GlassCard>

          {/* Experimental Features */}
          <GlassCard variant="medium" style={styles.section} padding="none">
            <SectionHeader title="Features" icon="flask-outline" />
            <SettingToggle
              icon="swap-horizontal"
              label="DEX Swapping"
              description="Swap tokens directly within the wallet using decentralized exchanges"
              value={swapEnabled}
              onValueChange={setSwapEnabled}
            />
            <SettingToggle
              icon="chatbubbles"
              label="Encrypted Messaging"
              description="Send and receive end-to-end encrypted messages with other wallet users"
              value={messagingEnabled}
              onValueChange={setMessagingEnabled}
            />
          </GlassCard>

          {/* Info Card */}
          <GlassCard variant="light" style={styles.infoCard}>
            <View style={styles.infoContent}>
              <Ionicons
                name="information-circle-outline"
                size={24}
                color={theme.colors.primary}
                style={{ marginRight: theme.spacing.sm }}
              />
              <Text style={[styles.infoText, { color: themeColors.textMuted }]}>
                Experimental features will graduate to full features once they are stable and
                thoroughly tested. Feedback is welcome!
              </Text>
            </View>
          </GlassCard>
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
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.xxl,
    },
    section: {
      marginBottom: theme.spacing.md,
      borderRadius: theme.borderRadius.xl,
      overflow: 'hidden',
    },
    warningCard: {
      marginBottom: theme.spacing.md,
      borderWidth: 1,
      borderColor: `${theme.colors.warning}40`,
      backgroundColor: `${theme.colors.warning}10`,
    },
    warningContent: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    warningText: {
      flex: 1,
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: 20,
    },
    infoCard: {
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.xl,
    },
    infoContent: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    infoText: {
      flex: 1,
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: 18,
    },
  });
