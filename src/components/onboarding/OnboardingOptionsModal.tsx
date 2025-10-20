import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';

interface OnboardingOptionsModalProps {
  isVisible: boolean;
  onClose: () => void;
  onCreateAccount: () => void;
  onImportAccount: () => void;
  onImportQRAccount: () => void;
  onAddWatchAccount: () => void;
}

export default function OnboardingOptionsModal({
  isVisible,
  onClose,
  onCreateAccount,
  onImportAccount,
  onImportQRAccount,
  onAddWatchAccount,
}: OnboardingOptionsModalProps) {
  const { theme } = useTheme();

  const accountOptions = [
    {
      id: 'create',
      title: 'Create New Account',
      subtitle: 'Generate a new account and backup its recovery phrase',
      icon: 'add-circle-outline' as const,
      onPress: () => {
        onClose();
        onCreateAccount();
      },
    },
    {
      id: 'import',
      title: 'Import Account',
      subtitle: 'Import existing account with seed phrase or private key',
      icon: 'download-outline' as const,
      onPress: () => {
        onClose();
        onImportAccount();
      },
    },
    {
      id: 'importQR',
      title: 'Import via QR Code',
      subtitle: 'Scan QR codes to import multiple accounts',
      icon: 'qr-code-outline' as const,
      onPress: () => {
        onClose();
        onImportQRAccount();
      },
    },
    {
      id: 'watch',
      title: 'Add Watch Account',
      subtitle: 'Monitor an account without private key access',
      icon: 'eye-outline' as const,
      onPress: () => {
        onClose();
        onAddWatchAccount();
      },
    },
  ];

  return (
    <Modal
      visible={isVisible}
      transparent={true}
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableOpacity
          style={styles.backdropTouch}
          activeOpacity={1}
          onPress={onClose}
        />
        <View
          style={[
            styles.modalContainer,
            { backgroundColor: theme.colors.card },
          ]}
        >
          {/* Header */}
          <View
            style={[styles.header, { borderBottomColor: theme.colors.border }]}
          >
            <Text style={[styles.title, { color: theme.colors.text }]}>
              Get Started
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Ionicons
                name="close"
                size={24}
                color={theme.colors.textSecondary}
              />
            </TouchableOpacity>
          </View>

          {/* Subtitle */}
          <View
            style={[
              styles.subtitleContainer,
              {
                backgroundColor: theme.colors.background,
                borderBottomColor: theme.colors.border,
              },
            ]}
          >
            <Text
              style={[styles.subtitle, { color: theme.colors.textSecondary }]}
            >
              Choose how you'd like to set up your Voi Wallet
            </Text>
          </View>

          {/* Account Options */}
          <ScrollView style={styles.optionsContainer}>
            {accountOptions.map((option) => (
              <TouchableOpacity
                key={option.id}
                style={[
                  styles.optionItem,
                  { borderBottomColor: theme.colors.border },
                ]}
                onPress={option.onPress}
                activeOpacity={0.7}
              >
                <View
                  style={[
                    styles.optionIcon,
                    { backgroundColor: theme.colors.primaryLight },
                  ]}
                >
                  <Ionicons
                    name={option.icon}
                    size={24}
                    color={theme.colors.primary}
                  />
                </View>
                <View style={styles.optionContent}>
                  <Text
                    style={[styles.optionTitle, { color: theme.colors.text }]}
                  >
                    {option.title}
                  </Text>
                  <Text
                    style={[
                      styles.optionSubtitle,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    {option.subtitle}
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={20}
                  color={theme.colors.textSecondary}
                />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const { height } = Dimensions.get('window');

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  backdropTouch: {
    flex: 1,
  },
  modalContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: height * 0.7,
    minHeight: height * 0.5,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  closeButton: {
    padding: 4,
  },
  subtitleContainer: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  optionsContainer: {
    paddingVertical: 8,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  optionContent: {
    flex: 1,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  optionSubtitle: {
    fontSize: 14,
    lineHeight: 20,
  },
});
