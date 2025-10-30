import React, { useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Image,
  Switch,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Theme, ThemeMode } from '@/constants/themes';
import { EdgeInsets, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';

interface ThemeSwitcherProps {
  visible: boolean;
  onClose: () => void;
  currentTheme: ThemeMode;
  onThemeSelect: (theme: ThemeMode) => void;
  onNFTThemeSelect?: () => void;
  theme: Theme;
}

interface ThemeItemProps {
  themeValue: ThemeMode;
  label: string;
  isSelected: boolean;
  onSelect: (theme: ThemeMode) => void;
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
}

const THEME_OPTIONS: ReadonlyArray<{
  label: string;
  value: ThemeMode;
}> = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System Default', value: 'system' },
];

const ThemeItem: React.FC<ThemeItemProps> = ({
  themeValue,
  label,
  isSelected,
  onSelect,
  theme,
  styles,
}) => {
  return (
    <TouchableOpacity
      style={[styles.themeItem, isSelected && styles.selectedThemeItem]}
      onPress={() => onSelect(themeValue)}
    >
      <View style={styles.themeItemContent}>
        {/* Theme Icon */}
        <View style={styles.themeIcon}>
          <Ionicons
            name={
              themeValue === 'light'
                ? 'sunny'
                : themeValue === 'dark'
                ? 'moon'
                : 'phone-portrait'
            }
            size={20}
            color={theme.colors.text}
          />
        </View>

        {/* Theme Info */}
        <View style={styles.themeInfo}>
          <Text
            style={[
              styles.themeName,
              isSelected && styles.selectedThemeText,
            ]}
          >
            {label}
          </Text>
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

export default function ThemeSwitcher({
  visible,
  onClose,
  currentTheme,
  onThemeSelect,
  onNFTThemeSelect,
  theme,
}: ThemeSwitcherProps) {
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme, insets), [theme, insets]);
  const {
    nftThemeData,
    nftThemeEnabled,
    setNFTThemeEnabled,
    nftPalettes,
    selectedPaletteIndex,
    setSelectedPaletteIndex,
    nftBackgroundEnabled,
    setNFTBackgroundEnabled,
  } = useTheme();

  const handleNFTToggle = async (enabled: boolean) => {
    await setNFTThemeEnabled(enabled);
  };

  const handleNFTButtonPress = () => {
    if (onNFTThemeSelect) {
      onNFTThemeSelect();
    }
  };

  const handlePaletteSelect = async (index: number) => {
    try {
      await setSelectedPaletteIndex(index);
    } catch (error) {
      console.error('Failed to set palette:', error);
    }
  };

  const handleBackgroundToggle = async (value: boolean) => {
    try {
      await setNFTBackgroundEnabled(value);
    } catch (error) {
      console.error('Failed to toggle background:', error);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Theme</Text>

          <View style={styles.headerActions}>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <Ionicons name="close" size={24} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView 
          style={styles.scrollView}
          contentContainerStyle={styles.listContainer}
        >
          {/* Base Theme Options */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Base Theme</Text>
            {THEME_OPTIONS.map((option) => (
              <ThemeItem
                key={option.value}
                themeValue={option.value}
                label={option.label}
                isSelected={option.value === currentTheme}
                onSelect={onThemeSelect}
                theme={theme}
                styles={styles}
              />
            ))}
          </View>

          {/* NFT Theme Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>NFT Theme</Text>

            {/* NFT Toggle with integrated content */}
            <View style={styles.nftCard}>
              {/* Main toggle row */}
              <View style={styles.nftToggleContainer}>
                <View style={styles.nftToggleContent}>
                  {nftThemeData?.imageUrl && (
                    <Image
                      source={{ uri: nftThemeData.imageUrl }}
                      style={styles.nftPreview}
                      resizeMode="cover"
                    />
                  )}
                  <View style={styles.nftToggleInfo}>
                    <Text style={styles.nftToggleLabel}>
                      {nftThemeData?.nftName || 'Use NFT Theme'}
                    </Text>
                    {nftThemeData && (
                      <Text style={styles.nftToggleSubtext}>
                        {nftThemeData.contractId}:{nftThemeData.tokenId}
                      </Text>
                    )}
                  </View>
                </View>
                <Switch
                  value={nftThemeEnabled}
                  onValueChange={handleNFTToggle}
                  trackColor={{
                    false: theme.colors.border,
                    true: theme.colors.primary,
                  }}
                  thumbColor={theme.colors.card}
                />
              </View>

              {/* Expanded options when enabled */}
              {nftThemeEnabled && (
                <View style={styles.nftExpandedContent}>
                  {/* Change NFT Button */}
                  {onNFTThemeSelect && (
                    <TouchableOpacity
                      style={styles.changeNFTButton}
                      onPress={handleNFTButtonPress}
                    >
                      <Ionicons
                        name="images-outline"
                        size={18}
                        color={theme.colors.primary}
                      />
                      <Text style={styles.changeNFTButtonText}>
                        {nftThemeData ? 'Change NFT' : 'Select NFT'}
                      </Text>
                      <Ionicons
                        name="chevron-forward"
                        size={18}
                        color={theme.colors.textMuted}
                      />
                    </TouchableOpacity>
                  )}

                  {/* Theme Options - Only show if NFT is selected */}
                  {nftThemeData && nftPalettes.length > 0 && (
                    <>
                      {/* Divider */}
                      <View style={styles.divider} />

                      {/* Background Image Toggle */}
                      <View style={styles.optionRow}>
                        <View style={styles.optionLabel}>
                          <Ionicons name="image" size={18} color={theme.colors.textSecondary} />
                          <Text style={styles.optionText}>
                            Show Background Image
                          </Text>
                        </View>
                        <Switch
                          value={nftBackgroundEnabled}
                          onValueChange={handleBackgroundToggle}
                          trackColor={{
                            false: theme.colors.border,
                            true: theme.colors.primary,
                          }}
                          thumbColor={theme.colors.card}
                        />
                      </View>

                      {/* Color Palette Selector */}
                      <View style={styles.paletteContainer}>
                        <View style={styles.optionLabel}>
                          <Ionicons name="color-palette" size={18} color={theme.colors.textSecondary} />
                          <Text style={styles.optionText}>
                            Color Palette
                          </Text>
                        </View>
                        <View style={styles.paletteButtons}>
                          {nftPalettes.map((palette, index) => (
                            <TouchableOpacity
                              key={index}
                              style={[
                                styles.paletteButton,
                                selectedPaletteIndex === index && styles.selectedPaletteButton,
                              ]}
                              onPress={() => handlePaletteSelect(index)}
                            >
                              <Text
                                style={[
                                  styles.paletteButtonText,
                                  selectedPaletteIndex === index && styles.selectedPaletteButtonText,
                                ]}
                              >
                                {palette.name}
                              </Text>
                              {selectedPaletteIndex === index && (
                                <Ionicons
                                  name="checkmark-circle"
                                  size={14}
                                  color={theme.colors.primary}
                                />
                              )}
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>
                    </>
                  )}
                </View>
              )}
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
      paddingTop: insets.top,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 16,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    title: {
      fontSize: 24,
      fontWeight: '600',
      color: theme.colors.text,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    closeButton: {
      padding: 4,
    },
    scrollView: {
      flex: 1,
    },
    listContainer: {
      paddingTop: 16,
      paddingBottom: 16 + insets.bottom,
    },
    section: {
      marginBottom: 24,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginHorizontal: 16,
      marginBottom: 12,
    },
    themeItem: {
      backgroundColor: theme.colors.surface,
      marginHorizontal: 16,
      marginVertical: 4,
      borderRadius: 12,
      padding: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    selectedThemeItem: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.surface,
    },
    themeItemContent: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    themeIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.background,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    themeInfo: {
      flex: 1,
    },
    themeName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    selectedThemeText: {
      color: theme.colors.primary,
    },
    selectedIcon: {
      marginTop: 4,
    },
    nftCard: {
      backgroundColor: theme.colors.surface,
      marginHorizontal: 16,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      overflow: 'hidden',
    },
    nftToggleContainer: {
      padding: 16,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    nftToggleContent: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    nftPreview: {
      width: 40,
      height: 40,
      borderRadius: 20,
      marginRight: 12,
    },
    nftToggleInfo: {
      flex: 1,
    },
    nftToggleLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    nftToggleSubtext: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 2,
    },
    nftExpandedContent: {
      borderTopWidth: 1,
      borderTopColor: theme.colors.borderLight,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 16,
      gap: 12,
    },
    changeNFTButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 12,
      backgroundColor: theme.colors.background,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    changeNFTButtonText: {
      flex: 1,
      fontSize: 15,
      fontWeight: '500',
      color: theme.colors.primary,
      marginLeft: 8,
    },
    divider: {
      height: 1,
      backgroundColor: theme.colors.borderLight,
      marginVertical: 4,
    },
    optionRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 8,
    },
    optionLabel: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    optionText: {
      fontSize: 15,
      color: theme.colors.text,
    },
    paletteContainer: {
      gap: 8,
    },
    paletteButtons: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 4,
    },
    paletteButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingVertical: 10,
      paddingHorizontal: 12,
      backgroundColor: theme.colors.background,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    selectedPaletteButton: {
      borderColor: theme.colors.primary,
      borderWidth: 2,
      backgroundColor: theme.colors.surface,
    },
    paletteButtonText: {
      fontSize: 13,
      color: theme.colors.text,
    },
    selectedPaletteButtonText: {
      fontWeight: '600',
      color: theme.colors.primary,
    },
  });
