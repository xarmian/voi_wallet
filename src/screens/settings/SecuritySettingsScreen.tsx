import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  TextInput,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { SettingsStackParamList } from '@/navigation/AppNavigator';
import { useAuth } from '@/contexts/AuthContext';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { AppStorage } from '@/utils/storage';
import UniversalHeader from '@/components/common/UniversalHeader';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import * as LocalAuthentication from 'expo-local-authentication';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

type SecuritySettingsScreenNavigationProp =
  StackNavigationProp<SettingsStackParamList>;

interface TimeoutOption {
  label: string;
  value: number | 'never' | 'custom';
  description: string;
}

const TIMEOUT_OPTIONS: TimeoutOption[] = [
  {
    label: '1 minute',
    value: 1,
    description: 'Lock after 1 minute of inactivity',
  },
  {
    label: '2 minutes',
    value: 2,
    description: 'Lock after 2 minutes of inactivity',
  },
  {
    label: '5 minutes',
    value: 5,
    description: 'Lock after 5 minutes of inactivity',
  },
  {
    label: '10 minutes',
    value: 10,
    description: 'Lock after 10 minutes of inactivity',
  },
  { label: 'Never', value: 'never', description: 'Never lock automatically' },
  { label: 'Custom', value: 'custom', description: 'Set a custom timeout' },
];

export default function SecuritySettingsScreen() {
  const navigation = useNavigation<SecuritySettingsScreenNavigationProp>();
  const { authState, enableBiometrics, updateTimeoutSetting } = useAuth();
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const [currentTimeout, setCurrentTimeout] = useState<number | 'never'>(5);
  const [selectedOption, setSelectedOption] = useState<
    number | 'never' | 'custom'
  >(5);
  const [customTimeout, setCustomTimeout] = useState<string>('');
  const [isCustomInputVisible, setIsCustomInputVisible] = useState(false);
  const [isBiometricAvailable, setIsBiometricAvailable] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadCurrentSettings();
    checkBiometricAvailability();
  }, []);

  const loadCurrentSettings = async () => {
    try {
      const timeout = await AccountSecureStorage.getPinTimeout();
      setCurrentTimeout(timeout);

      // Determine which option is selected
      const predefinedOption = TIMEOUT_OPTIONS.find(
        (option) => option.value === timeout
      );
      if (predefinedOption) {
        setSelectedOption(predefinedOption.value);
        setIsCustomInputVisible(false);
      } else if (typeof timeout === 'number') {
        // Custom timeout
        setSelectedOption('custom');
        setCustomTimeout(timeout.toString());
        setIsCustomInputVisible(true);
      }
    } catch (error) {
      console.error('Failed to load current timeout setting:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const checkBiometricAvailability = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      setIsBiometricAvailable(hasHardware && isEnrolled);
    } catch (error) {
      console.warn('Failed to check biometric availability:', error);
      setIsBiometricAvailable(false);
    }
  };

  const handleTimeoutOptionPress = async (option: TimeoutOption) => {
    try {
      if (option.value === 'custom') {
        setSelectedOption('custom');
        setIsCustomInputVisible(true);
        return;
      }

      setSelectedOption(option.value);
      setIsCustomInputVisible(false);

      await AccountSecureStorage.setPinTimeout(option.value);
      setCurrentTimeout(option.value);

      // Store in AppStorage as well for redundancy
      await AppStorage.savePinTimeout(option.value);

      // Update the auth context
      await updateTimeoutSetting();

      Alert.alert(
        'Settings Updated',
        `PIN timeout has been set to ${option.label.toLowerCase()}`
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to update timeout setting';
      Alert.alert('Error', message);
    }
  };

  const handleCustomTimeoutSave = async () => {
    const minutes = parseInt(customTimeout.trim(), 10);

    if (isNaN(minutes) || minutes < 1 || minutes > 1440) {
      Alert.alert(
        'Invalid Timeout',
        'Please enter a valid number between 1 and 1440 minutes (24 hours).'
      );
      return;
    }

    try {
      await AccountSecureStorage.setPinTimeout(minutes);
      setCurrentTimeout(minutes);

      // Store in AppStorage as well
      await AppStorage.savePinTimeout(minutes);
      await AppStorage.saveCustomPinTimeout(minutes);

      // Update the auth context
      await updateTimeoutSetting();

      Alert.alert(
        'Settings Updated',
        `PIN timeout has been set to ${minutes} minute${minutes === 1 ? '' : 's'}`
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to update timeout setting';
      Alert.alert('Error', message);
    }
  };

  const handleBiometricToggle = async (enabled: boolean) => {
    if (!isBiometricAvailable) {
      Alert.alert(
        'Biometric Authentication Unavailable',
        'Biometric authentication is not available on this device or no biometric data is enrolled. Please set up biometric authentication in your device settings.'
      );
      return;
    }

    try {
      await enableBiometrics(enabled);

      const message = enabled
        ? 'Biometric authentication has been enabled'
        : 'Biometric authentication has been disabled';

      Alert.alert('Success', message);
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Failed to update biometric setting';
      Alert.alert('Error', errorMessage);
    }
  };

  const handleChangePin = () => {
    navigation.navigate('ChangePin');
  };

  const getCurrentTimeoutDescription = () => {
    if (currentTimeout === 'never') {
      return 'Auto-lock is disabled';
    }
    return `Locks after ${currentTimeout} minute${currentTimeout === 1 ? '' : 's'} of inactivity`;
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader title="Security" showBackButton showAccountSelector={false} onAccountSelectorPress={() => {}} onBackPress={() => navigation.goBack()} />
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader title="Security" showBackButton showAccountSelector={false} onAccountSelectorPress={() => {}} onBackPress={() => navigation.goBack()} />

      <KeyboardAwareScrollView contentContainerStyle={styles.content}>
        {/* PIN Settings Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>PIN Authentication</Text>

          <TouchableOpacity
            style={styles.settingItem}
            onPress={handleChangePin}
          >
            <Text style={styles.settingText}>Change PIN</Text>
            <Text style={styles.arrow}>→</Text>
          </TouchableOpacity>

          <View style={styles.switchSettingItem}>
            <Text
              style={[
                styles.settingText,
                !isBiometricAvailable && styles.disabledText,
              ]}
            >
              Biometric Authentication
            </Text>
            <Switch
              value={authState.biometricEnabled}
              onValueChange={handleBiometricToggle}
              disabled={!isBiometricAvailable}
              trackColor={{
                false: theme.colors.border,
                true: theme.colors.primary,
              }}
              thumbColor={theme.colors.buttonText}
            />
          </View>
        </View>

        {/* Auto-Lock Settings Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Auto-Lock Timeout</Text>
          <Text style={styles.sectionDescription}>
            {getCurrentTimeoutDescription()}
          </Text>

          {TIMEOUT_OPTIONS.map((option, index) => (
            <TouchableOpacity
              key={option.label}
              style={[
                styles.timeoutOption,
                index === TIMEOUT_OPTIONS.length - 1 && {
                  borderBottomWidth: 0,
                },
              ]}
              onPress={() => handleTimeoutOptionPress(option)}
            >
              <View style={styles.timeoutOptionContent}>
                <Text style={styles.timeoutOptionLabel}>{option.label}</Text>
                <Text style={styles.timeoutOptionDescription}>
                  {option.description}
                </Text>
              </View>
              <View style={styles.radioButton}>
                {selectedOption === option.value && (
                  <View style={styles.radioButtonSelected} />
                )}
              </View>
            </TouchableOpacity>
          ))}

          {isCustomInputVisible && (
            <View style={styles.customInputContainer}>
              <Text style={styles.customInputLabel}>
                Custom timeout (minutes):
              </Text>
              <View style={styles.customInputRow}>
                <TextInput
                  style={styles.customInput}
                  value={customTimeout}
                  onChangeText={setCustomTimeout}
                  placeholder="Enter minutes (1-1440)"
                  placeholderTextColor={themeColors.placeholder}
                  keyboardType="numeric"
                  maxLength={4}
                />
                <TouchableOpacity
                  style={styles.customInputButton}
                  onPress={handleCustomTimeoutSave}
                >
                  <Text style={styles.customInputButtonText}>Save</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.customInputHint}>
                Enter a value between 1 and 1440 minutes (24 hours)
              </Text>
            </View>
          )}
        </View>

        {/* Security Notice */}
        <View style={styles.noticeContainer}>
          <Text style={styles.noticeTitle}>Security Notice</Text>
          <Text style={styles.noticeText}>
            Auto-lock helps protect your wallet when you're not actively using
            the app. The timeout is based on user activity - navigation,
            scrolling, and tapping will reset the timer.
          </Text>
          {currentTimeout === 'never' && (
            <Text style={styles.warningText}>
              ⚠️ With auto-lock disabled, your wallet will remain unlocked until
              you manually lock it or close the app.
            </Text>
          )}
        </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      fontSize: 16,
      color: theme.colors.textMuted,
    },
    content: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    section: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.md,
      overflow: 'hidden',
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textMuted,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.surface,
    },
    sectionDescription: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 10,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    settingItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    settingText: {
      fontSize: 16,
      color: theme.colors.text,
    },
    arrow: {
      fontSize: 18,
      color: theme.colors.textMuted,
    },
    switchSettingItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    disabledText: {
      color: theme.colors.textMuted,
    },
    timeoutOption: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    timeoutOptionContent: {
      flex: 1,
    },
    timeoutOptionLabel: {
      fontSize: 16,
      color: theme.colors.text,
      fontWeight: '500',
    },
    timeoutOptionDescription: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    radioButton: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: theme.colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
    },
    radioButtonSelected: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: theme.colors.primary,
    },
    customInputContainer: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.surface,
    },
    customInputLabel: {
      fontSize: 16,
      color: theme.colors.text,
      marginBottom: 10,
      fontWeight: '500',
    },
    customInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    customInput: {
      flex: 1,
      height: 40,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.sm,
      paddingHorizontal: 12,
      backgroundColor: theme.colors.inputBackground,
      fontSize: 16,
    },
    customInputButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: 10,
      borderRadius: theme.borderRadius.sm,
    },
    customInputButtonText: {
      color: theme.colors.buttonText,
      fontSize: 16,
      fontWeight: '500',
    },
    customInputHint: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 8,
    },
    noticeContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: 15,
      padding: 20,
      marginTop: 10,
    },
    noticeTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: '#333',
      marginBottom: 10,
    },
    noticeText: {
      fontSize: 14,
      color: '#666',
      lineHeight: 20,
    },
    warningText: {
      fontSize: 14,
      color: '#FF9500',
      marginTop: 10,
      lineHeight: 20,
    },
  });
