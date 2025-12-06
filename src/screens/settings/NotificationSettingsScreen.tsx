/**
 * Notification Settings Screen
 *
 * Allows users to configure push notification preferences for their wallet accounts.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import { NFTBackground } from '@/components/common/NFTBackground';
import UniversalHeader from '@/components/common/UniversalHeader';
import AccountListModal from '@/components/account/AccountListModal';
import { useActiveAccount, useAccounts } from '@/store/walletStore';
import { AccountMetadata, AccountType } from '@/types/wallet';
import {
  notificationService,
  NotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '@/services/notifications';
import { isSupabaseConfigured } from '@/services/supabase';

interface SettingToggleProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}

function SettingToggle({
  icon,
  label,
  description,
  value,
  onValueChange,
  disabled = false,
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
        opacity: disabled ? 0.5 : 1,
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
        disabled={disabled}
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

interface SliderSettingProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  value: number;
  onValueChange: (value: number) => void;
  minimumValue: number;
  maximumValue: number;
  step?: number;
  formatValue: (value: number) => string;
  disabled?: boolean;
}

function SliderSetting({
  icon,
  label,
  description,
  value,
  onValueChange,
  minimumValue,
  maximumValue,
  step = 1,
  formatValue,
  disabled = false,
}: SliderSettingProps) {
  const { theme } = useTheme();
  const themeColors = useThemeColors();

  return (
    <View
      style={{
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.glassBorder,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: theme.spacing.sm }}>
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
        <Text
          style={{
            fontSize: theme.typography.body.fontSize,
            color: themeColors.textMuted,
            minWidth: 60,
            textAlign: 'right',
          }}
        >
          {formatValue(value)}
        </Text>
      </View>
      <Slider
        style={{ width: '100%', height: 40 }}
        minimumValue={minimumValue}
        maximumValue={maximumValue}
        step={step}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        minimumTrackTintColor={theme.colors.primary}
        maximumTrackTintColor={theme.colors.glassBorder}
        thumbTintColor={theme.colors.primary}
      />
    </View>
  );
}

interface NumberInputSettingProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  value: number;
  onValueChange: (value: number) => void;
  suffix?: string;
  disabled?: boolean;
}

function NumberInputSetting({
  icon,
  label,
  description,
  value,
  onValueChange,
  suffix = '',
  disabled = false,
}: NumberInputSettingProps) {
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const [localValue, setLocalValue] = useState(value.toString());

  // Update local value when prop changes
  useEffect(() => {
    setLocalValue(value.toString());
  }, [value]);

  const handleChangeText = (text: string) => {
    // Only allow numbers
    const numericText = text.replace(/[^0-9]/g, '');
    setLocalValue(numericText);
  };

  const handleEndEditing = () => {
    const numValue = parseInt(localValue, 10) || 0;
    setLocalValue(numValue.toString());
    if (numValue !== value) {
      onValueChange(numValue);
    }
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.glassBorder,
        opacity: disabled ? 0.5 : 1,
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
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <TextInput
          style={{
            minWidth: 60,
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.xs,
            borderRadius: theme.borderRadius.sm,
            backgroundColor: theme.colors.glassBackground,
            borderWidth: 1,
            borderColor: theme.colors.glassBorder,
            color: themeColors.text,
            fontSize: theme.typography.body.fontSize,
            textAlign: 'right',
          }}
          value={localValue}
          onChangeText={handleChangeText}
          onEndEditing={handleEndEditing}
          onBlur={handleEndEditing}
          keyboardType="numeric"
          editable={!disabled}
          selectTextOnFocus
        />
        {suffix && (
          <Text
            style={{
              marginLeft: theme.spacing.xs,
              fontSize: theme.typography.body.fontSize,
              color: themeColors.textMuted,
            }}
          >
            {suffix}
          </Text>
        )}
      </View>
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

export default function NotificationSettingsScreen() {
  const navigation = useNavigation();
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const activeAccount = useActiveAccount();
  const accounts = useAccounts();

  // Track which account's preferences we're viewing/editing
  // This is separate from the global active account - we don't change the active account here
  const [selectedAccount, setSelectedAccount] = useState<AccountMetadata | null>(null);
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences>(
    DEFAULT_NOTIFICATION_PREFERENCES
  );

  // Check if Supabase is configured
  const isConfigured = isSupabaseConfigured();

  // Check if selected account is watch-only
  const isWatchAccount = selectedAccount?.type === AccountType.WATCH;

  // Initialize selected account to active account
  useEffect(() => {
    if (!selectedAccount && activeAccount) {
      setSelectedAccount(activeAccount);
    }
  }, [activeAccount, selectedAccount]);

  // Reload preferences when selected account changes
  useEffect(() => {
    if (selectedAccount) {
      loadPreferences();
    }
  }, [selectedAccount?.address]);

  const loadPreferences = async () => {
    if (!selectedAccount || !isConfigured) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      // Check if notifications are enabled
      const enabled = await notificationService.areNotificationsEnabled();
      setNotificationsEnabled(enabled);

      // Load preferences from server for selected account
      const prefs = await notificationService.getPreferences(selectedAccount.address);
      if (prefs) {
        setPreferences(prefs);
      } else {
        // Account not yet subscribed - use defaults
        setPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
      }
    } catch (error) {
      console.error('Failed to load notification preferences:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleEnableNotifications = async () => {
    if (!selectedAccount) return;

    setIsSaving(true);
    try {
      // Initialize notification service
      await notificationService.initialize();

      // Request permissions and register token
      const token = await notificationService.registerPushToken();

      if (token) {
        // Subscribe the selected account
        await notificationService.subscribeAccount(selectedAccount.address, preferences);
        setNotificationsEnabled(true);
        Alert.alert('Success', 'Push notifications have been enabled for this account');
      } else {
        Alert.alert(
          'Permission Required',
          'Please enable notifications in your device settings to receive push notifications.'
        );
      }
    } catch (error) {
      console.error('Failed to enable notifications:', error);
      Alert.alert('Error', 'Failed to enable notifications. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisableNotifications = async () => {
    if (!selectedAccount) return;

    Alert.alert(
      'Disable Notifications',
      'Are you sure you want to disable push notifications for this account?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disable',
          style: 'destructive',
          onPress: async () => {
            setIsSaving(true);
            try {
              await notificationService.unsubscribeAccount(selectedAccount.address);
              setNotificationsEnabled(false);
            } catch (error) {
              console.error('Failed to disable notifications:', error);
              Alert.alert('Error', 'Failed to disable notifications.');
            } finally {
              setIsSaving(false);
            }
          },
        },
      ]
    );
  };

  const updatePreference = useCallback(
    async (key: keyof NotificationPreferences, value: boolean | number) => {
      if (!selectedAccount || !notificationsEnabled) return;

      const newPreferences = { ...preferences, [key]: value };
      setPreferences(newPreferences);

      // Save to server (debounced for sliders)
      try {
        await notificationService.updatePreferences(selectedAccount.address, { [key]: value });
      } catch (error) {
        console.error('Failed to update preference:', error);
        // Revert on error
        setPreferences(preferences);
      }
    },
    [selectedAccount, notificationsEnabled, preferences]
  );

  // Handler for account selection from the modal
  const handleAccountSelect = useCallback((accountId: string) => {
    const account = accounts.find(a => a.id === accountId);
    if (account) {
      setSelectedAccount(account);
    }
  }, [accounts]);

  if (!isConfigured) {
    return (
      <NFTBackground>
        <SafeAreaView style={styles.container} edges={['top']}>
          <UniversalHeader
            title="Notifications"
            showBackButton
            onBackPress={() => navigation.goBack()}
            onAccountSelectorPress={() => setIsAccountModalVisible(true)}
          />
          <View style={styles.centerContent}>
            <Ionicons name="notifications-off-outline" size={64} color={themeColors.textMuted} />
            <Text style={styles.unavailableTitle}>Notifications Unavailable</Text>
            <Text style={styles.unavailableText}>
              Push notifications are not configured for this app. Please contact support if you
              believe this is an error.
            </Text>
          </View>
        </SafeAreaView>
      </NFTBackground>
    );
  }

  if (isLoading) {
    return (
      <NFTBackground>
        <SafeAreaView style={styles.container} edges={['top']}>
          <UniversalHeader
            title="Notifications"
            showBackButton
            onBackPress={() => navigation.goBack()}
            onAccountSelectorPress={() => setIsAccountModalVisible(true)}
          />
          <View style={styles.centerContent}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.loadingText}>Loading preferences...</Text>
          </View>
        </SafeAreaView>
      </NFTBackground>
    );
  }

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Notifications"
          showBackButton
          onBackPress={() => navigation.goBack()}
          onAccountSelectorPress={() => setIsAccountModalVisible(true)}
        />
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {/* Master Toggle */}
          <GlassCard variant="medium" style={styles.section} padding="none">
            <SectionHeader title="Push Notifications" icon="notifications-outline" />
            <SettingToggle
              icon="notifications"
              label="Enable Push Notifications"
              description="Receive notifications for wallet activity"
              value={notificationsEnabled}
              onValueChange={(value) => {
                if (value) {
                  handleEnableNotifications();
                } else {
                  handleDisableNotifications();
                }
              }}
              disabled={isSaving}
            />
          </GlassCard>

          {/* Message Notifications */}
          <GlassCard variant="medium" style={styles.section} padding="none">
            <SectionHeader title="Messages" icon="chatbubble-outline" />
            {/* Show warning for watch-only accounts */}
            {isWatchAccount && (
              <View style={styles.watchWarning}>
                <Ionicons
                  name="information-circle"
                  size={16}
                  color={theme.colors.warning}
                  style={{ marginRight: theme.spacing.xs }}
                />
                <Text style={styles.watchWarningText}>
                  Watch-only accounts cannot decrypt messages
                </Text>
              </View>
            )}
            <SettingToggle
              icon="mail-outline"
              label="New Messages"
              description="Get notified when you receive encrypted messages"
              value={preferences.messages}
              onValueChange={(value) => updatePreference('messages', value)}
              disabled={!notificationsEnabled || isWatchAccount}
            />
          </GlassCard>

          {/* Transaction Notifications */}
          <GlassCard variant="medium" style={styles.section} padding="none">
            <SectionHeader title="Transactions" icon="swap-horizontal-outline" />
            <SettingToggle
              icon="arrow-down-outline"
              label="Incoming VOI"
              description="Get notified for incoming VOI payments"
              value={preferences.voiPayments}
              onValueChange={(value) => updatePreference('voiPayments', value)}
              disabled={!notificationsEnabled}
            />
            <NumberInputSetting
              icon="filter-outline"
              label="Minimum VOI Amount"
              description="Only notify for amounts above this threshold"
              value={preferences.minVoiAmount / 1_000_000}
              onValueChange={(value) => updatePreference('minVoiAmount', Math.round(value * 1_000_000))}
              suffix="VOI"
              disabled={!notificationsEnabled || !preferences.voiPayments}
            />
            <SettingToggle
              icon="cube-outline"
              label="ARC-200 Tokens"
              description="Get notified for incoming token transfers"
              value={preferences.arc200Transfers}
              onValueChange={(value) => updatePreference('arc200Transfers', value)}
              disabled={!notificationsEnabled}
            />
            <SettingToggle
              icon="image-outline"
              label="NFT Transfers"
              description="Get notified when you receive NFTs"
              value={preferences.arc72Transfers}
              onValueChange={(value) => updatePreference('arc72Transfers', value)}
              disabled={!notificationsEnabled}
            />
            <SettingToggle
              icon="arrow-up-outline"
              label="Outgoing Confirmations"
              description="Get notified when your sent transactions confirm"
              value={preferences.outgoingConfirmations}
              onValueChange={(value) => updatePreference('outgoingConfirmations', value)}
              disabled={!notificationsEnabled}
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
                Push notifications are sent via secure servers. Message content is never shared -
                only notification that a message was received.
              </Text>
            </View>
          </GlassCard>
        </ScrollView>

        {/* Account Selection Modal */}
        <AccountListModal
          isVisible={isAccountModalVisible}
          onClose={() => setIsAccountModalVisible(false)}
          onAddAccount={() => {
            // Just close the modal - we don't navigate to add account from here
            setIsAccountModalVisible(false);
          }}
          onAccountSelect={handleAccountSelect}
        />
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
    centerContent: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.xl,
    },
    section: {
      marginBottom: theme.spacing.md,
      borderRadius: theme.borderRadius.xl,
      overflow: 'hidden',
    },
    loadingText: {
      marginTop: theme.spacing.md,
      fontSize: theme.typography.body.fontSize,
      color: theme.colors.textMuted,
    },
    unavailableTitle: {
      marginTop: theme.spacing.lg,
      fontSize: theme.typography.h3.fontSize,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    unavailableText: {
      marginTop: theme.spacing.sm,
      fontSize: theme.typography.body.fontSize,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
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
      color: theme.colors.textMuted,
      lineHeight: 18,
    },
    watchWarning: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: `${theme.colors.warning}15`,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.glassBorder,
    },
    watchWarningText: {
      flex: 1,
      fontSize: theme.typography.caption.fontSize,
      color: theme.colors.warning,
    },
  });
