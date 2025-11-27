/**
 * Slippage Settings Modal
 * Allows users to configure slippage tolerance for swaps
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  TouchableWithoutFeedback,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Theme } from '../../constants/themes';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';

const SLIPPAGE_STORAGE_KEY = '@voi_wallet_slippage_tolerance';
const PRESET_SLIPPAGES = [0.5, 1, 2, 3];
const DEFAULT_SLIPPAGE = 1.0;

interface SlippageSettingsModalProps {
  visible: boolean;
  currentSlippage: number;
  onClose: () => void;
  onSave: (slippage: number) => void;
}

export const SlippageSettingsModal: React.FC<SlippageSettingsModalProps> = ({
  visible,
  currentSlippage,
  onClose,
  onSave,
}) => {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();

  const [selectedSlippage, setSelectedSlippage] = useState<number>(currentSlippage);
  const [customSlippage, setCustomSlippage] = useState<string>('');
  const [isCustom, setIsCustom] = useState<boolean>(false);
  const [slideAnim] = useState(new Animated.Value(0));

  useEffect(() => {
    if (visible) {
      setSelectedSlippage(currentSlippage);
      const isPreset = PRESET_SLIPPAGES.includes(currentSlippage);
      setIsCustom(!isPreset);
      if (!isPreset) {
        setCustomSlippage(currentSlippage.toString());
      }

      Animated.spring(slideAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, currentSlippage]);

  const handlePresetSelect = (slippage: number) => {
    setSelectedSlippage(slippage);
    setIsCustom(false);
    setCustomSlippage('');
  };

  const handleCustomSlippageChange = (text: string) => {
    // Allow only numbers and decimal point
    const cleaned = text.replace(/[^0-9.]/g, '');

    // Prevent multiple decimal points
    const parts = cleaned.split('.');
    const formatted = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : cleaned;

    setCustomSlippage(formatted);
    setIsCustom(true);

    const value = parseFloat(formatted);
    if (!isNaN(value) && value > 0 && value <= 50) {
      setSelectedSlippage(value);
    }
  };

  const handleSave = async () => {
    try {
      await AsyncStorage.setItem(SLIPPAGE_STORAGE_KEY, selectedSlippage.toString());
      onSave(selectedSlippage);
      onClose();
    } catch (error) {
      console.error('Error saving slippage preference:', error);
      onSave(selectedSlippage);
      onClose();
    }
  };

  const getWarningMessage = (): string | null => {
    if (selectedSlippage < 0.1) {
      return 'Your transaction may fail due to low slippage tolerance';
    }
    if (selectedSlippage > 5) {
      return 'High slippage tolerance may result in unfavorable rates';
    }
    return null;
  };

  const translateY = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [600, 0],
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <Animated.View
              style={[
                styles.modalContainer,
                { transform: [{ translateY }] },
              ]}
            >
              {/* Header */}
              <View style={styles.header}>
                <Text style={styles.title}>Slippage Tolerance</Text>
                <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                  <Ionicons name="close" size={24} color={themeColors.text} />
                </TouchableOpacity>
              </View>

              {/* Info */}
              <Text style={styles.description}>
                Slippage is the difference between the expected price and the executed price.
              </Text>

              {/* Preset Options */}
              <View style={styles.presetsContainer}>
                {PRESET_SLIPPAGES.map(slippage => (
                  <TouchableOpacity
                    key={slippage}
                    style={[
                      styles.presetButton,
                      !isCustom && selectedSlippage === slippage && styles.presetButtonActive,
                    ]}
                    onPress={() => handlePresetSelect(slippage)}
                  >
                    <Text
                      style={[
                        styles.presetText,
                        !isCustom && selectedSlippage === slippage && styles.presetTextActive,
                      ]}
                    >
                      {slippage}%
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Custom Input */}
              <View style={styles.customContainer}>
                <Text style={styles.customLabel}>Custom</Text>
                <View style={[styles.customInputContainer, isCustom && styles.customInputActive]}>
                  <TextInput
                    style={styles.customInput}
                    value={customSlippage}
                    onChangeText={handleCustomSlippageChange}
                    placeholder="0.0"
                    placeholderTextColor={themeColors.textMuted}
                    keyboardType="decimal-pad"
                    maxLength={5}
                  />
                  <Text style={styles.percentSign}>%</Text>
                </View>
              </View>

              {/* Warning Message */}
              {getWarningMessage() && (
                <View style={styles.warningContainer}>
                  <Ionicons name="warning" size={16} color={themeColors.warning} />
                  <Text style={styles.warningText}>{getWarningMessage()}</Text>
                </View>
              )}

              {/* Save Button */}
              <TouchableOpacity
                style={[
                  styles.saveButton,
                  (selectedSlippage <= 0 || selectedSlippage > 50) && styles.saveButtonDisabled,
                ]}
                onPress={handleSave}
                disabled={selectedSlippage <= 0 || selectedSlippage > 50}
              >
                <Text style={styles.saveButtonText}>Save Settings</Text>
              </TouchableOpacity>
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

export const getStoredSlippage = async (): Promise<number> => {
  try {
    const stored = await AsyncStorage.getItem(SLIPPAGE_STORAGE_KEY);
    if (stored) {
      const value = parseFloat(stored);
      if (!isNaN(value) && value > 0 && value <= 50) {
        return value;
      }
    }
  } catch (error) {
    console.error('Error loading slippage preference:', error);
  }
  return DEFAULT_SLIPPAGE;
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    modalContainer: {
      backgroundColor: theme.colors.card,
      borderTopLeftRadius: theme.borderRadius.xl,
      borderTopRightRadius: theme.borderRadius.xl,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
      maxHeight: '80%',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    title: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
    },
    closeButton: {
      padding: theme.spacing.xs,
    },
    description: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.lg,
      lineHeight: 20,
    },
    presetsContainer: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.lg,
    },
    presetButton: {
      flex: 1,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.surface,
      borderWidth: 2,
      borderColor: 'transparent',
      alignItems: 'center',
    },
    presetButtonActive: {
      backgroundColor: `${theme.colors.primary}20`,
      borderColor: theme.colors.primary,
    },
    presetText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    presetTextActive: {
      color: theme.colors.primary,
    },
    customContainer: {
      marginBottom: theme.spacing.lg,
    },
    customLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    customInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing.md,
      borderWidth: 2,
      borderColor: 'transparent',
    },
    customInputActive: {
      backgroundColor: `${theme.colors.primary}20`,
      borderColor: theme.colors.primary,
    },
    customInput: {
      flex: 1,
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      paddingVertical: theme.spacing.md,
    },
    percentSign: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      marginLeft: theme.spacing.xs,
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: `${theme.colors.warning}20`,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    warningText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.warning,
      lineHeight: 18,
    },
    saveButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
    },
    saveButtonDisabled: {
      backgroundColor: theme.colors.textMuted,
      opacity: 0.5,
    },
    saveButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: 'white',
    },
  });
