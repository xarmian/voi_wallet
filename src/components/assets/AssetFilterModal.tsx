import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { AssetSortBy, AssetSortOrder } from '@/utils/assetFilterStorage';

export interface AssetFilterSettings {
  sortBy: AssetSortBy;
  sortOrder: AssetSortOrder;
  balanceThreshold: number | null;
  valueThreshold: number | null;
  nativeTokensFirst: boolean;
}

interface AssetFilterModalProps {
  visible: boolean;
  currentSettings: AssetFilterSettings;
  onClose: () => void;
  onApply: (settings: AssetFilterSettings) => void;
  onReset: () => void;
}

export default function AssetFilterModal({
  visible,
  currentSettings,
  onClose,
  onApply,
  onReset,
}: AssetFilterModalProps) {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();

  const [sortBy, setSortBy] = useState<AssetSortBy>(currentSettings.sortBy);
  const [sortOrder, setSortOrder] = useState<AssetSortOrder>(
    currentSettings.sortOrder
  );
  const [balanceThresholdText, setBalanceThresholdText] = useState<string>(
    currentSettings.balanceThreshold?.toString() || ''
  );
  const [valueThresholdText, setValueThresholdText] = useState<string>(
    currentSettings.valueThreshold?.toString() || ''
  );
  const [nativeTokensFirst, setNativeTokensFirst] = useState<boolean>(
    currentSettings.nativeTokensFirst
  );

  // Sync state with currentSettings when modal opens
  useEffect(() => {
    if (visible) {
      setSortBy(currentSettings.sortBy);
      setSortOrder(currentSettings.sortOrder);
      setBalanceThresholdText(
        currentSettings.balanceThreshold?.toString() || ''
      );
      setValueThresholdText(currentSettings.valueThreshold?.toString() || '');
      setNativeTokensFirst(currentSettings.nativeTokensFirst);
    }
  }, [visible, currentSettings]);

  const handleApply = () => {
    const balanceThreshold = balanceThresholdText.trim()
      ? parseFloat(balanceThresholdText)
      : null;
    const valueThreshold = valueThresholdText.trim()
      ? parseFloat(valueThresholdText)
      : null;

    const settings: AssetFilterSettings = {
      sortBy,
      sortOrder,
      balanceThreshold:
        balanceThreshold !== null && !isNaN(balanceThreshold)
          ? balanceThreshold
          : null,
      valueThreshold:
        valueThreshold !== null && !isNaN(valueThreshold)
          ? valueThreshold
          : null,
      nativeTokensFirst,
    };

    onApply(settings);
    onClose();
  };

  const handleReset = () => {
    onReset();
    onClose();
  };

  const renderSortByOption = (
    value: AssetSortBy,
    label: string,
    icon: string
  ) => (
    <TouchableOpacity
      key={value}
      style={[styles.optionButton, sortBy === value && styles.optionButtonActive]}
      onPress={() => setSortBy(value)}
    >
      <View style={styles.optionContent}>
        <Ionicons
          name={icon as any}
          size={20}
          color={sortBy === value ? styles.optionTextActive.color : styles.optionText.color}
        />
        <Text
          style={[
            styles.optionText,
            sortBy === value && styles.optionTextActive,
          ]}
        >
          {label}
        </Text>
      </View>
      {sortBy === value && (
        <Ionicons name="checkmark-circle" size={20} color={styles.checkmark.color} />
      )}
    </TouchableOpacity>
  );

  const renderSortOrderOption = (value: AssetSortOrder, label: string) => (
    <TouchableOpacity
      key={value}
      style={[
        styles.orderButton,
        sortOrder === value && styles.orderButtonActive,
      ]}
      onPress={() => setSortOrder(value)}
    >
      <Text
        style={[
          styles.orderText,
          sortOrder === value && styles.orderTextActive,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container} edges={['top']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={24} color={styles.headerText.color} />
          </TouchableOpacity>
          <Text style={styles.headerText}>Filter & Sort Assets</Text>
          <View style={styles.closeButton} />
        </View>

        <KeyboardAvoidingView 
          style={styles.keyboardAvoidingView}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        >
          <ScrollView 
            style={styles.content}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Sort By Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Sort By</Text>
              {renderSortByOption('name', 'Name', 'text-outline')}
              {renderSortByOption('balance', 'Balance', 'albums-outline')}
              {renderSortByOption('value', 'Value (USD)', 'cash-outline')}
            </View>

            {/* Sort Order Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Sort Order</Text>
              <View style={styles.orderContainer}>
                {renderSortOrderOption('asc', 'Ascending')}
                {renderSortOrderOption('desc', 'Descending')}
              </View>
            </View>

            {/* Native Tokens First Toggle */}
            <View style={styles.section}>
              <View style={styles.toggleRow}>
                <View style={styles.toggleInfo}>
                  <Text style={styles.sectionTitle}>Native Tokens First</Text>
                  <Text style={styles.toggleDescription}>
                    Always show VOI and ALGO at the top of the list
                  </Text>
                </View>
                <Switch
                  value={nativeTokensFirst}
                  onValueChange={setNativeTokensFirst}
                  trackColor={{
                    false: themeColors.border,
                    true: themeColors.primary,
                  }}
                  thumbColor={themeColors.buttonText}
                />
              </View>
            </View>

            {/* Filter Thresholds Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Filter Thresholds</Text>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>
                  Hide balances below (token amount):
                </Text>
                <TextInput
                  style={styles.input}
                  value={balanceThresholdText}
                  onChangeText={setBalanceThresholdText}
                  placeholder="e.g., 0.01"
                  placeholderTextColor={styles.placeholder.color}
                  keyboardType="decimal-pad"
                />
                <Text style={styles.inputHint}>
                  Assets with balance below this amount will be hidden
                </Text>
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>
                  Hide value below (USD):
                </Text>
                <TextInput
                  style={styles.input}
                  value={valueThresholdText}
                  onChangeText={setValueThresholdText}
                  placeholder="e.g., 1.00"
                  placeholderTextColor={styles.placeholder.color}
                  keyboardType="decimal-pad"
                />
                <Text style={styles.inputHint}>
                  Assets with USD value below this amount will be hidden
                </Text>
              </View>
            </View>
          </ScrollView>

          {/* Footer Buttons */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.resetButton}
              onPress={handleReset}
            >
              <Text style={styles.resetButtonText}>Reset to Defaults</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.applyButton}
              onPress={handleApply}
            >
              <Text style={styles.applyButtonText}>Apply</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    closeButton: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerText: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    keyboardAvoidingView: {
      flex: 1,
    },
    content: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: theme.spacing.md,
      paddingBottom: theme.spacing.md,
      flexGrow: 1,
    },
    section: {
      marginTop: theme.spacing.lg,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    optionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.card,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      marginBottom: theme.spacing.xs,
      borderWidth: 2,
      borderColor: 'transparent',
    },
    optionButtonActive: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.surface,
    },
    optionContent: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    optionText: {
      fontSize: 15,
      color: theme.colors.text,
    },
    optionTextActive: {
      fontSize: 15,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    checkmark: {
      color: theme.colors.primary,
    },
    orderContainer: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    orderButton: {
      flex: 1,
      backgroundColor: theme.colors.card,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      borderWidth: 2,
      borderColor: 'transparent',
    },
    orderButtonActive: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.surface,
    },
    orderText: {
      fontSize: 15,
      color: theme.colors.text,
    },
    orderTextActive: {
      fontSize: 15,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    inputGroup: {
      marginBottom: theme.spacing.md,
    },
    inputLabel: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    input: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      fontSize: 15,
      color: theme.colors.text,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    placeholder: {
      color: theme.colors.textMuted,
    },
    inputHint: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: theme.spacing.xs,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.card,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
    },
    toggleInfo: {
      flex: 1,
      marginRight: theme.spacing.md,
    },
    toggleDescription: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: theme.spacing.xs,
    },
    footer: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    resetButton: {
      flex: 1,
      backgroundColor: theme.colors.card,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    resetButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
    },
    applyButton: {
      flex: 1,
      backgroundColor: theme.colors.primary,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    applyButtonText: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });
