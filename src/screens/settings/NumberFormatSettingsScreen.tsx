/**
 * Number Format Screen
 *
 * Pushed Settings screen for the number-format locale (TASK-435: was a
 * slide-up modal). Saving a choice returns to Settings; a failed save stays
 * here with an alert.
 */

import React, { useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Theme } from '@/constants/themes';
import {
  EdgeInsets,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { NFTBackground } from '@/components/common/NFTBackground';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useWalletStore, useWalletSettings } from '@/store/walletStore';

interface LocaleItemProps {
  localeValue: string | null;
  label: string;
  example: string;
  isSelected: boolean;
  onSelect: (locale: string | null) => void;
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
}

const LOCALE_OPTIONS: readonly {
  label: string;
  value: string | null;
  example: string;
}[] = [
  { label: 'System Default', value: null, example: '1,234.56' },
  { label: 'English (United States)', value: 'en-US', example: '1,234.56' },
  { label: 'English (United Kingdom)', value: 'en-GB', example: '1,234.56' },
  { label: 'French (France)', value: 'fr-FR', example: '1 234,56' },
  { label: 'German (Germany)', value: 'de-DE', example: '1.234,56' },
  { label: 'Spanish (Spain)', value: 'es-ES', example: '1.234,56' },
  { label: 'Japanese (Japan)', value: 'ja-JP', example: '1,234.56' },
];

const getLocaleIcon = (locale: string | null): string => {
  if (!locale) return 'phone-portrait';

  const country = locale.split('-')[1];
  switch (country) {
    case 'US':
      return 'flag';
    case 'GB':
      return 'flag';
    case 'FR':
      return 'flag';
    case 'DE':
      return 'flag';
    case 'ES':
      return 'flag';
    case 'JP':
      return 'flag';
    default:
      return 'globe';
  }
};

const LocaleItem: React.FC<LocaleItemProps> = ({
  localeValue,
  label,
  example,
  isSelected,
  onSelect,
  theme,
  styles,
}) => {
  return (
    <TouchableOpacity
      style={[styles.localeItem, isSelected && styles.selectedLocaleItem]}
      onPress={() => onSelect(localeValue)}
      disabled={isSelected}
    >
      <View style={styles.localeItemContent}>
        {/* Locale Icon */}
        <View style={styles.localeIcon}>
          <Ionicons
            name={getLocaleIcon(localeValue) as any}
            size={20}
            color={theme.colors.text}
          />
        </View>

        {/* Locale Info */}
        <View style={styles.localeInfo}>
          <Text
            style={[styles.localeName, isSelected && styles.selectedLocaleText]}
          >
            {label}
          </Text>
          <Text style={styles.localeExample}>{example}</Text>
        </View>

        {/* Selected Indicator */}
        {isSelected && (
          <Ionicons
            name="checkmark-circle"
            size={24}
            color={theme.colors.primary}
            style={styles.selectedIcon}
          />
        )}
      </View>
    </TouchableOpacity>
  );
};

export default function NumberFormatSettingsScreen() {
  const navigation = useNavigation();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme, insets), [theme, insets]);
  const updateWalletSettings = useWalletStore(
    (state) => state.updateWalletSettings
  );
  const walletSettings = useWalletSettings();
  const currentLocale = walletSettings?.numberLocale ?? null;
  // One save at a time: a second tap while the first is in flight is ignored.
  const savingRef = useRef(false);

  const handleLocaleSelect = async (value: string | null) => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await updateWalletSettings({ numberLocale: value ?? null });
      navigation.goBack();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to update number format setting.';
      Alert.alert('Error', message);
    } finally {
      savingRef.current = false;
    }
  };

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Number Format"
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
        />

        {/* Locale List */}
        <FlatList
          data={LOCALE_OPTIONS}
          keyExtractor={(item) => item.value ?? 'system'}
          renderItem={({ item }) => (
            <LocaleItem
              localeValue={item.value}
              label={item.label}
              example={item.example}
              isSelected={item.value === currentLocale}
              onSelect={handleLocaleSelect}
              theme={theme}
              styles={styles}
            />
          )}
          contentContainerStyle={styles.listContainer}
        />
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    listContainer: {
      paddingTop: 16,
      paddingBottom: 16 + insets.bottom,
    },
    localeItem: {
      backgroundColor: theme.colors.surface,
      marginHorizontal: 16,
      marginVertical: 4,
      borderRadius: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    selectedLocaleItem: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.surface,
    },
    localeItemContent: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    localeIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.background,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    localeInfo: {
      flex: 1,
    },
    localeName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    localeExample: {
      fontSize: 14,
      color: theme.colors.textMuted,
    },
    selectedLocaleText: {
      color: theme.colors.primary,
    },
    selectedIcon: {
      marginTop: 4,
    },
  });
