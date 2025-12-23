/**
 * Remote Signer Settings Screen
 *
 * This screen allows users to:
 * - Switch between wallet and signer modes
 * - Configure signer device settings
 * - Access export/import features
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  TextInput,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import {
  useRemoteSignerStore,
  useAppMode,
  useSignerConfig,
  useRemoteSignerInitialized,
  usePairedSignersArray,
} from '@/store/remoteSignerStore';
import { useAccounts, useWalletStore } from '@/store/walletStore';
import { AppMode } from '@/types/remoteSigner';
import { AccountType, StandardAccountMetadata, AccountMetadata } from '@/types/wallet';
import * as Updates from 'expo-updates';
import AccountListModal from '@/components/account/AccountListModal';
import { TransferToAirgapFlow } from '@/components/remoteSigner/TransferToAirgapFlow';

// Cross-platform alert helper
const showAlert = (
  title: string,
  message: string,
  buttons?: Array<{ text: string; onPress?: () => void; style?: string }>
) => {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const confirmed = window.confirm(`${title}\n\n${message}`);
      if (confirmed) {
        const confirmButton = buttons.find((b) => b.style !== 'cancel') || buttons[0];
        confirmButton?.onPress?.();
      } else {
        const cancelButton = buttons.find((b) => b.style === 'cancel');
        cancelButton?.onPress?.();
      }
    } else {
      window.alert(`${title}\n\n${message}`);
      buttons?.[0]?.onPress?.();
    }
  } else {
    const { Alert } = require('react-native');
    Alert.alert(title, message, buttons);
  }
};

export default function RemoteSignerSettingsScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation<any>();

  const isInitialized = useRemoteSignerInitialized();
  const appMode = useAppMode();
  const signerConfig = useSignerConfig();
  const pairedSigners = usePairedSignersArray();
  const accounts = useAccounts();
  const refresh = useWalletStore((state) => state.refresh);

  // Filter to only STANDARD accounts (which can be transferred to airgap)
  const standardAccounts = accounts.filter(
    (acc): acc is StandardAccountMetadata => acc.type === AccountType.STANDARD
  );

  const initialize = useRemoteSignerStore((state) => state.initialize);
  const setAppMode = useRemoteSignerStore((state) => state.setAppMode);
  const initializeSignerConfig = useRemoteSignerStore(
    (state) => state.initializeSignerConfig
  );
  const updateSignerDeviceName = useRemoteSignerStore(
    (state) => state.updateSignerDeviceName
  );

  const [isModeSwitching, setIsModeSwitching] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [setupDeviceName, setSetupDeviceName] = useState('');

  // Transfer to Airgap state
  const [showAccountSelector, setShowAccountSelector] = useState(false);
  const [selectedAccountForTransfer, setSelectedAccountForTransfer] = useState<StandardAccountMetadata | null>(null);
  const [showTransferFlow, setShowTransferFlow] = useState(false);

  useEffect(() => {
    if (!isInitialized) {
      initialize();
    }
  }, [isInitialized, initialize]);

  useEffect(() => {
    if (signerConfig?.deviceName) {
      setDeviceName(signerConfig.deviceName);
    }
  }, [signerConfig]);

  const handleModeSwitch = async (newMode: AppMode) => {
    if (newMode === appMode) return;

    if (newMode === 'signer' && !signerConfig) {
      // First time switching to signer mode - show setup modal
      setSetupDeviceName('');
      setShowSetupModal(true);
      return;
    }

    // Show restart confirmation dialog
    showAlert(
      'Restart Required',
      newMode === 'signer'
        ? 'Switching to Signer Mode will restart the app. Network services will be disabled for enhanced security.'
        : 'Switching to Wallet Mode will restart the app. Network services will be enabled for full functionality.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restart',
          onPress: async () => {
            setIsModeSwitching(true);
            try {
              await setAppMode(newMode);
              if (__DEV__) {
                showAlert(
                  'Development Mode',
                  'Please manually restart the app for changes to take effect.'
                );
                setIsModeSwitching(false);
              } else {
                await Updates.reloadAsync();
              }
            } catch (error) {
              showAlert('Error', 'Failed to switch mode. Please try again.');
              setIsModeSwitching(false);
            }
          },
        },
      ]
    );
  };

  const handleSetupSignerMode = async () => {
    if (!setupDeviceName.trim()) {
      showAlert('Error', 'Please enter a device name');
      return;
    }

    setIsModeSwitching(true);
    try {
      await initializeSignerConfig(setupDeviceName.trim());
      await setAppMode('signer');
      setShowSetupModal(false);
      // Restart the app to disable network services
      if (__DEV__) {
        showAlert(
          'Signer Mode Activated',
          'Please manually restart the app to complete setup. Network services will be disabled for enhanced security.'
        );
        setIsModeSwitching(false);
      } else {
        await Updates.reloadAsync();
      }
    } catch (error) {
      showAlert('Error', 'Failed to set up signer mode. Please try again.');
      setIsModeSwitching(false);
    }
  };

  const handleUpdateDeviceName = async () => {
    if (!deviceName.trim()) {
      showAlert('Error', 'Please enter a device name');
      return;
    }

    try {
      await updateSignerDeviceName(deviceName.trim());
      setIsEditingName(false);
      showAlert('Success', 'Device name updated');
    } catch (error) {
      showAlert('Error', 'Failed to update device name');
    }
  };

  if (!isInitialized) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Air-gapped Signing</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Info Card */}
        <View style={styles.infoCard}>
          <Ionicons
            name="shield-checkmark-outline"
            size={24}
            color={theme.colors.primary}
            style={styles.infoIcon}
          />
          <View style={styles.infoContent}>
            <Text style={styles.infoTitle}>Air-Gapped Security</Text>
            <Text style={styles.infoDescription}>
              Use two devices for enhanced security. Keep your signing device
              offline (airplane mode) and use QR codes to sign transactions.
            </Text>
          </View>
        </View>

        {/* Mode Selection */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Current Mode</Text>

          <TouchableOpacity
            style={[
              styles.modeOption,
              appMode === 'wallet' && styles.modeOptionSelected,
            ]}
            onPress={() => handleModeSwitch('wallet')}
            disabled={isModeSwitching}
          >
            <View style={styles.modeIconContainer}>
              <Ionicons
                name="wallet-outline"
                size={28}
                color={appMode === 'wallet' ? theme.colors.primary : theme.colors.textSecondary}
              />
            </View>
            <View style={styles.modeContent}>
              <Text
                style={[
                  styles.modeTitle,
                  appMode === 'wallet' && styles.modeTitleSelected,
                ]}
              >
                Wallet Mode
              </Text>
              <Text style={styles.modeDescription}>
                Full wallet functionality. Use air-gapped signer accounts for enhanced
                security.
              </Text>
            </View>
            {appMode === 'wallet' && (
              <Ionicons
                name="checkmark-circle"
                size={24}
                color={theme.colors.primary}
              />
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.modeOption,
              appMode === 'signer' && styles.modeOptionSelected,
            ]}
            onPress={() => handleModeSwitch('signer')}
            disabled={isModeSwitching}
          >
            <View style={styles.modeIconContainer}>
              <Ionicons
                name="key-outline"
                size={28}
                color={appMode === 'signer' ? theme.colors.primary : theme.colors.textSecondary}
              />
            </View>
            <View style={styles.modeContent}>
              <Text
                style={[
                  styles.modeTitle,
                  appMode === 'signer' && styles.modeTitleSelected,
                ]}
              >
                Signer Mode
              </Text>
              <Text style={styles.modeDescription}>
                Air-gapped signing only. Keep this device offline and sign via QR
                codes.
              </Text>
            </View>
            {appMode === 'signer' && (
              <Ionicons
                name="checkmark-circle"
                size={24}
                color={theme.colors.primary}
              />
            )}
          </TouchableOpacity>
        </View>

        {/* Signer Device Configuration (only in signer mode or if configured) */}
        {(appMode === 'signer' || signerConfig) && signerConfig && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Signer Device</Text>

            {isEditingName ? (
              <View style={styles.editNameContainer}>
                <TextInput
                  style={styles.nameInput}
                  value={deviceName}
                  onChangeText={setDeviceName}
                  placeholder="Enter device name"
                  placeholderTextColor={theme.colors.placeholder}
                  autoFocus
                />
                <View style={styles.editNameButtons}>
                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => {
                      setDeviceName(signerConfig?.deviceName || '');
                      setIsEditingName(false);
                    }}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.saveButton}
                    onPress={handleUpdateDeviceName}
                  >
                    <Text style={styles.saveButtonText}>Save</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={styles.deviceInfoCard}>
                <View style={styles.deviceInfoRow}>
                  <Text style={styles.deviceLabel}>Device Name</Text>
                  <TouchableOpacity
                    style={styles.editButton}
                    onPress={() => setIsEditingName(true)}
                  >
                    <Text style={styles.deviceValue}>{signerConfig.deviceName}</Text>
                    <Ionicons
                      name="pencil-outline"
                      size={16}
                      color={theme.colors.primary}
                    />
                  </TouchableOpacity>
                </View>
                <View style={styles.deviceInfoRow}>
                  <Text style={styles.deviceLabel}>Device ID</Text>
                  <Text style={styles.deviceId}>{signerConfig.deviceId}</Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Actions</Text>

          {appMode === 'signer' && (
            <>
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => navigation.navigate('SignRequestScanner')}
              >
                <View style={styles.actionIcon}>
                  <Ionicons
                    name="scan-outline"
                    size={24}
                    color={theme.colors.primary}
                  />
                </View>
                <View style={styles.actionContent}>
                  <Text style={styles.actionTitle}>Scan Signing Request</Text>
                  <Text style={styles.actionDescription}>
                    Scan a transaction QR code from your wallet device to sign
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={20}
                  color={theme.colors.textSecondary}
                />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => navigation.navigate('ExportAccounts')}
              >
                <View style={styles.actionIcon}>
                  <Ionicons
                    name="qr-code-outline"
                    size={24}
                    color={theme.colors.primary}
                  />
                </View>
                <View style={styles.actionContent}>
                  <Text style={styles.actionTitle}>Export Accounts</Text>
                  <Text style={styles.actionDescription}>
                    Generate QR code to pair accounts with wallet device
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={20}
                  color={theme.colors.textSecondary}
                />
              </TouchableOpacity>
            </>
          )}

          {appMode === 'wallet' && (
            <>
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => navigation.navigate('ImportRemoteSigner')}
              >
                <View style={styles.actionIcon}>
                  <Ionicons
                    name="scan-outline"
                    size={24}
                    color={theme.colors.primary}
                  />
                </View>
                <View style={styles.actionContent}>
                  <Text style={styles.actionTitle}>Import from Signer</Text>
                  <Text style={styles.actionDescription}>
                    Scan QR code from signer device to import accounts
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={20}
                  color={theme.colors.textSecondary}
                />
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.actionItem,
                  standardAccounts.length === 0 && { opacity: 0.5 },
                ]}
                onPress={() => {
                  if (standardAccounts.length === 0) {
                    showAlert(
                      'No Accounts Available',
                      'You need at least one standard account to transfer to an airgap device.'
                    );
                    return;
                  }
                  if (standardAccounts.length === 1) {
                    // Only one account, select it directly
                    setSelectedAccountForTransfer(standardAccounts[0]);
                    setShowTransferFlow(true);
                  } else {
                    // Multiple accounts, show selector
                    setShowAccountSelector(true);
                  }
                }}
                disabled={standardAccounts.length === 0}
              >
                <View style={styles.actionIcon}>
                  <Ionicons
                    name="arrow-forward-circle-outline"
                    size={24}
                    color={theme.colors.primary}
                  />
                </View>
                <View style={styles.actionContent}>
                  <Text style={styles.actionTitle}>Transfer to Airgap Device</Text>
                  <Text style={styles.actionDescription}>
                    Move an existing account to your signer device
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={20}
                  color={theme.colors.textSecondary}
                />
              </TouchableOpacity>

              {pairedSigners.length > 0 && (
                <View style={styles.pairedSignersSection}>
                  <Text style={styles.subsectionTitle}>
                    Paired Signer Devices ({pairedSigners.length})
                  </Text>
                  {pairedSigners.map((signer) => (
                    <View key={signer.deviceId} style={styles.pairedSignerItem}>
                      <Ionicons
                        name="phone-portrait-outline"
                        size={20}
                        color={theme.colors.textSecondary}
                      />
                      <View style={styles.pairedSignerInfo}>
                        <Text style={styles.pairedSignerName}>
                          {signer.deviceName || 'Unknown Device'}
                        </Text>
                        <Text style={styles.pairedSignerAccounts}>
                          {signer.addresses.length} account
                          {signer.addresses.length !== 1 ? 's' : ''}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </>
          )}
        </View>
      </ScrollView>

      {/* Setup Signer Mode Modal */}
      <Modal
        visible={showSetupModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowSetupModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Ionicons
                name="key-outline"
                size={32}
                color={theme.colors.primary}
              />
              <Text style={styles.modalTitle}>Set Up Signer Mode</Text>
              <Text style={styles.modalDescription}>
                Enter a name for this signer device. This name will be shown when
                pairing with other devices.
              </Text>
            </View>

            <TextInput
              style={styles.modalInput}
              value={setupDeviceName}
              onChangeText={setSetupDeviceName}
              placeholder="e.g., My Secure Phone"
              placeholderTextColor={theme.colors.placeholder}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleSetupSignerMode}
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => setShowSetupModal(false)}
                disabled={isModeSwitching}
              >
                <Text style={styles.modalCancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalConfirmButton,
                  (!setupDeviceName.trim() || isModeSwitching) &&
                    styles.modalConfirmButtonDisabled,
                ]}
                onPress={handleSetupSignerMode}
                disabled={!setupDeviceName.trim() || isModeSwitching}
              >
                {isModeSwitching ? (
                  <ActivityIndicator size="small" color={theme.colors.buttonText} />
                ) : (
                  <Text style={styles.modalConfirmButtonText}>Set Up</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Account Selector for Transfer */}
      <AccountListModal
        isVisible={showAccountSelector}
        onClose={() => setShowAccountSelector(false)}
        onAddAccount={() => {}}
        onAccountSelect={(accountId: string) => {
          const account = standardAccounts.find((acc) => acc.id === accountId);
          if (account) {
            setSelectedAccountForTransfer(account);
            setShowAccountSelector(false);
            setShowTransferFlow(true);
          }
        }}
        filterSignable
      />

      {/* Transfer to Airgap Flow */}
      {showTransferFlow && selectedAccountForTransfer && (
        <TransferToAirgapFlow
          account={selectedAccountForTransfer}
          onSuccess={() => {
            setShowTransferFlow(false);
            setSelectedAccountForTransfer(null);
            // Refresh wallet to reflect the change
            refresh();
            showAlert(
              'Transfer Complete',
              'The account has been transferred to your airgap device and will now sign transactions via QR codes.'
            );
          }}
          onCancel={() => {
            setShowTransferFlow(false);
            setSelectedAccountForTransfer(null);
          }}
        />
      )}
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    backButton: {
      padding: theme.spacing.xs,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholder: {
      width: 32,
    },
    content: {
      flex: 1,
    },
    scrollContent: {
      padding: theme.spacing.lg,
    },
    infoCard: {
      flexDirection: 'row',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    infoIcon: {
      marginRight: theme.spacing.md,
      marginTop: 2,
    },
    infoContent: {
      flex: 1,
    },
    infoTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 4,
    },
    infoDescription: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      lineHeight: 20,
    },
    section: {
      marginBottom: theme.spacing.lg,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    modeOption: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.sm,
      borderWidth: 2,
      borderColor: theme.colors.border,
    },
    modeOptionSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: `${theme.colors.primary}15`,
    },
    modeIconContainer: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.md,
    },
    modeContent: {
      flex: 1,
    },
    modeTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    modeTitleSelected: {
      color: theme.colors.primary,
    },
    modeDescription: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
    deviceInfoCard: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    deviceInfoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
    },
    deviceLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    deviceValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
      marginRight: theme.spacing.xs,
    },
    deviceId: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    editButton: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    editNameContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    nameInput: {
      backgroundColor: theme.colors.inputBackground,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      borderRadius: theme.borderRadius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      fontSize: 16,
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    editNameButtons: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: theme.spacing.sm,
    },
    cancelButton: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    cancelButtonText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    saveButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
    },
    saveButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    actionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    actionIcon: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: `${theme.colors.primary}15`,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.md,
    },
    actionContent: {
      flex: 1,
    },
    actionTitle: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 2,
    },
    actionDescription: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    pairedSignersSection: {
      marginTop: theme.spacing.md,
    },
    subsectionTitle: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.sm,
    },
    pairedSignerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    pairedSignerInfo: {
      flex: 1,
      marginLeft: theme.spacing.sm,
    },
    pairedSignerName: {
      fontSize: 14,
      color: theme.colors.text,
    },
    pairedSignerAccounts: {
      fontSize: 12,
      color: theme.colors.textSecondary,
    },
    // Modal styles
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.lg,
    },
    modalContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.xl,
      width: '100%',
      maxWidth: 400,
    },
    modalHeader: {
      alignItems: 'center',
      marginBottom: theme.spacing.lg,
    },
    modalTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.sm,
    },
    modalDescription: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    modalInput: {
      backgroundColor: theme.colors.inputBackground,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      borderRadius: theme.borderRadius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      fontSize: 16,
      color: theme.colors.text,
      marginBottom: theme.spacing.lg,
    },
    modalButtons: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    modalCancelButton: {
      flex: 1,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    modalCancelButtonText: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
    },
    modalConfirmButton: {
      flex: 1,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      alignItems: 'center',
      backgroundColor: theme.colors.primary,
    },
    modalConfirmButtonDisabled: {
      opacity: 0.5,
    },
    modalConfirmButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });
