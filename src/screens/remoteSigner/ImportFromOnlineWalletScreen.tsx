/**
 * ImportFromOnlineWalletScreen
 *
 * Screen for the airgap device to import an account from an online wallet.
 * This is the receiving end of the "Transfer to Airgap" flow.
 *
 * Flow:
 * 1. Show disclaimer about keeping device offline
 * 2. Scan ARC-300 QR code containing private key
 * 3. Import account as STANDARD
 * 4. Build and sign verification transaction
 * 5. Display signed response QR for online wallet to scan
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { AnimatedQRScanner } from '@/components/remoteSigner/AnimatedQRScanner';
import { AnimatedQRCode } from '@/components/remoteSigner/AnimatedQRCode';
import { parseArc0300AccountImportUri, normalizeBase64ToHex } from '@/utils/arc0300';
import { MultiAccountWalletService } from '@/services/wallet';
import { RemoteSignerService } from '@/services/remoteSigner';
import { useCurrentNetwork } from '@/store/networkStore';
import { useWalletStore } from '@/store/walletStore';
import { StandardAccountMetadata, AccountType } from '@/types/wallet';

type ImportState =
  | 'disclaimer'
  | 'scanning'
  | 'importing'
  | 'signing'
  | 'displaying_confirmation'
  | 'complete'
  | 'error';

export default function ImportFromOnlineWalletScreen() {
  const navigation = useNavigation<any>();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const networkId = useCurrentNetwork();
  const refresh = useWalletStore((state) => state.refresh);

  const [state, setState] = useState<ImportState>('disclaimer');
  const [error, setError] = useState<string | null>(null);
  const [importedAccount, setImportedAccount] = useState<StandardAccountMetadata | null>(null);
  const [confirmationQrData, setConfirmationQrData] = useState<string | null>(null);
  const [doneCountdown, setDoneCountdown] = useState(5);

  // Countdown timer for the Done button
  useEffect(() => {
    if (state === 'displaying_confirmation' && doneCountdown > 0) {
      const timer = setTimeout(() => {
        setDoneCountdown((prev) => prev - 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [state, doneCountdown]);

  // Reset countdown when entering displaying_confirmation state
  useEffect(() => {
    if (state === 'displaying_confirmation') {
      setDoneCountdown(5);
    }
  }, [state]);

  const handleAcceptDisclaimer = useCallback(() => {
    setState('scanning');
  }, []);

  const handleScannedData = useCallback(
    async (data: string) => {
      setState('importing');

      try {
        // Parse the ARC-300 URI
        const parsed = parseArc0300AccountImportUri(data);

        if (!parsed) {
          throw new Error('Invalid QR code format. Expected an ARC-300 account import URI.');
        }

        if (parsed.kind !== 'standard') {
          throw new Error('This QR code does not contain a private key.');
        }

        if (parsed.entries.length === 0 || !parsed.entries[0].privateKeyBase64) {
          throw new Error('No private key found in QR code.');
        }

        const entry = parsed.entries[0];

        // Validate private key exists
        if (!entry.privateKeyBase64) {
          throw new Error('No private key found in QR code.');
        }

        // Convert base64 private key to bytes
        // The private key is URL-safe base64, need to convert back
        const base64Standard = entry.privateKeyBase64
          .replace(/-/g, '+')
          .replace(/_/g, '/');
        // Add padding if needed
        const paddedBase64 = base64Standard + '='.repeat((4 - base64Standard.length % 4) % 4);
        const privateKeyBytes = new Uint8Array(Buffer.from(paddedBase64, 'base64'));

        // Derive the address from the private key
        const publicKeyBytes = privateKeyBytes.slice(32);
        const address = algosdk.encodeAddress(publicKeyBytes);

        // Check if account already exists by getting all accounts and filtering
        const allAccounts = await MultiAccountWalletService.getAllAccounts();
        const existingAccount = allAccounts.find(
          (acc) => acc.address.toLowerCase() === address.toLowerCase()
        );
        let account: StandardAccountMetadata;

        if (existingAccount) {
          // Account already exists - use it instead of re-importing
          account = existingAccount as StandardAccountMetadata;
        } else {
          // Convert base64 private key to hex for import
          const privateKeyHex = normalizeBase64ToHex(entry.privateKeyBase64);

          // Import the account
          account = await MultiAccountWalletService.importStandardAccount({
            type: AccountType.STANDARD,
            privateKey: privateKeyHex,
            label: entry.name || undefined,
          });

          // Refresh wallet state to show the new account
          await refresh();
        }

        setImportedAccount(account);
        setState('signing');

        // Build a simple verification transaction
        // We're in airgap mode so use default/hardcoded params
        // Using Voi mainnet genesis hash as default
        const genesisHashBase64 = 'IXnoWtviVVJW5LGivNFc0Dq14V3kqaXuK2u5OQrdVZo=';
        const genesisHashBytes = new Uint8Array(Buffer.from(genesisHashBase64, 'base64'));
        const genesisId = 'voi-mainnet';

        // Create a minimal verification transaction (zero-amount self-payment)
        const suggestedParams: algosdk.SuggestedParams = {
          fee: 1000,
          minFee: 1000,
          flatFee: true,
          firstValid: 1,
          lastValid: 1000,
          genesisHash: genesisHashBytes,
          genesisID: genesisId,
        };

        const verificationTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: address,
          receiver: address,
          amount: 0,
          suggestedParams,
          note: new Uint8Array(Buffer.from('Airgap signer verification - DO NOT SUBMIT')),
        });

        // Sign the transaction directly with the private key we have
        const signedTxn = verificationTxn.signTxn(privateKeyBytes);

        // Create remote signer response
        const requestId = `verify-${Date.now()}`;
        const response = RemoteSignerService.createSuccessResponse(
          requestId,
          [signedTxn]
        );

        // Encode for QR display
        const payload = RemoteSignerService.encodePayload(response);
        setConfirmationQrData(payload);
        setState('displaying_confirmation');

        // Zero out the private key from memory
        privateKeyBytes.fill(0);

      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to import account';
        setError(message);
        setState('error');
      }
    },
    [networkId]
  );

  const handleScanError = useCallback((errorMessage: string) => {
    setError(errorMessage);
    setState('error');
  }, []);

  const handleRetry = useCallback(() => {
    setError(null);
    setImportedAccount(null);
    setConfirmationQrData(null);
    setState('disclaimer');
  }, []);

  const handleComplete = useCallback(async () => {
    setState('complete');
    // Refresh wallet to show the new account
    await refresh();
    // Navigate back after a short delay
    setTimeout(() => {
      navigation.goBack();
    }, 1500);
  }, [navigation, refresh]);

  const handleGoBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const renderContent = () => {
    switch (state) {
      case 'disclaimer':
        return (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.disclaimerContent}>
              <View style={styles.iconContainer}>
                <Ionicons name="airplane" size={48} color={theme.colors.warning} />
              </View>

              <Text style={styles.title}>Import from Online Wallet</Text>

              <View style={styles.warningBox}>
                <Ionicons name="shield-checkmark" size={24} color={theme.colors.warning} />
                <Text style={styles.warningText}>
                  For maximum security, ensure this device is in airplane mode with Wi-Fi and Bluetooth disabled before proceeding.
                </Text>
              </View>

              <View style={styles.infoSection}>
                <Text style={styles.infoTitle}>What will happen:</Text>
                <View style={styles.infoPoints}>
                  <View style={styles.infoPoint}>
                    <Ionicons name="scan-outline" size={20} color={theme.colors.textSecondary} />
                    <Text style={styles.infoPointText}>
                      Scan the QR code from your online wallet
                    </Text>
                  </View>
                  <View style={styles.infoPoint}>
                    <Ionicons name="key-outline" size={20} color={theme.colors.textSecondary} />
                    <Text style={styles.infoPointText}>
                      Import the account with full signing capability
                    </Text>
                  </View>
                  <View style={styles.infoPoint}>
                    <Ionicons name="qr-code-outline" size={20} color={theme.colors.textSecondary} />
                    <Text style={styles.infoPointText}>
                      Display a confirmation QR for the online wallet
                    </Text>
                  </View>
                </View>
              </View>

              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleAcceptDisclaimer}
              >
                <Ionicons name="scan" size={20} color={theme.colors.buttonText} />
                <Text style={styles.primaryButtonText}>Start Scanning</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.cancelButton}
                onPress={handleGoBack}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        );

      case 'scanning':
        return (
          <View style={styles.scannerContainer}>
            <AnimatedQRScanner
              onScan={handleScannedData}
              onError={handleScanError}
              instructionsText="Scan the private key QR code from your online wallet"
              showProgress
            />
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => setState('disclaimer')}
            >
              <Ionicons name="arrow-back" size={20} color={theme.colors.text} />
              <Text style={styles.backButtonText}>Back</Text>
            </TouchableOpacity>
          </View>
        );

      case 'importing':
        return (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.statusText}>Importing account...</Text>
          </View>
        );

      case 'signing':
        return (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.statusText}>Signing verification transaction...</Text>
          </View>
        );

      case 'displaying_confirmation':
        return (
          <View style={styles.confirmationContent}>
            <View style={styles.successBanner}>
              <Ionicons name="checkmark-circle" size={24} color={theme.colors.success} />
              <Text style={styles.successBannerText}>
                Account imported successfully!
              </Text>
            </View>

            {importedAccount && (
              <View style={styles.accountCard}>
                <Text style={styles.accountLabel}>Imported Account</Text>
                <Text style={styles.accountName}>
                  {importedAccount.label || 'Unnamed Account'}
                </Text>
                <Text style={styles.accountAddress}>
                  {importedAccount.address.slice(0, 8)}...{importedAccount.address.slice(-8)}
                </Text>
              </View>
            )}

            <Text style={styles.instructionText}>
              Show this QR code to your online wallet to complete the transfer:
            </Text>

            {confirmationQrData && (
              <View style={styles.qrWrapper}>
                <AnimatedQRCode
                  data={confirmationQrData}
                  size={200}
                  showFrameCounter
                  showControls
                />
              </View>
            )}

            <View style={styles.warningBanner}>
              <Ionicons name="warning" size={20} color={theme.colors.warning} />
              <Text style={styles.warningBannerText}>
                Do not tap Done until you have scanned this QR code with your online wallet
              </Text>
            </View>

            <TouchableOpacity
              style={[
                styles.primaryButton,
                doneCountdown > 0 && styles.primaryButtonDisabled,
              ]}
              onPress={handleComplete}
              disabled={doneCountdown > 0}
            >
              <Ionicons
                name="checkmark"
                size={20}
                color={doneCountdown > 0 ? theme.colors.textMuted : theme.colors.buttonText}
              />
              <Text style={[
                styles.primaryButtonText,
                doneCountdown > 0 && { color: theme.colors.textMuted },
              ]}>
                {doneCountdown > 0 ? `Done (${doneCountdown}s)` : 'Done'}
              </Text>
            </TouchableOpacity>
          </View>
        );

      case 'complete':
        return (
          <View style={styles.centeredContent}>
            <View style={styles.successIcon}>
              <Ionicons name="checkmark-circle" size={64} color={theme.colors.success} />
            </View>
            <Text style={styles.successTitle}>Import Complete</Text>
            <Text style={styles.successSubtitle}>
              This account is now available for signing.
            </Text>
          </View>
        );

      case 'error':
        return (
          <View style={styles.centeredContent}>
            <View style={styles.errorIcon}>
              <Ionicons name="close-circle" size={64} color={theme.colors.error} />
            </View>
            <Text style={styles.errorTitle}>Import Failed</Text>
            <Text style={styles.errorMessage}>{error || 'An unknown error occurred'}</Text>

            <View style={styles.errorActions}>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={handleRetry}
              >
                <Ionicons name="refresh" size={20} color={theme.colors.buttonText} />
                <Text style={styles.retryButtonText}>Try Again</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.cancelButton}
                onPress={handleGoBack}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        );

      default:
        return null;
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.headerBackButton}
          onPress={handleGoBack}
          disabled={['importing', 'signing'].includes(state)}
        >
          <Ionicons
            name="arrow-back"
            size={24}
            color={['importing', 'signing'].includes(state) ? theme.colors.textMuted : theme.colors.text}
          />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Import from Wallet</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Content */}
      <View style={styles.content}>{renderContent()}</View>
    </SafeAreaView>
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
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    headerBackButton: {
      padding: 8,
    },
    headerTitle: {
      flex: 1,
      textAlign: 'center',
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text,
    },
    headerSpacer: {
      width: 40,
    },
    content: {
      flex: 1,
    },
    scrollContent: {
      padding: 24,
    },
    centeredContent: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
      gap: 16,
    },
    statusText: {
      fontSize: 16,
      color: theme.colors.text,
      textAlign: 'center',
    },

    // Disclaimer styles
    disclaimerContent: {
      alignItems: 'center',
      gap: 20,
    },
    iconContainer: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: `${theme.colors.warning}20`,
      justifyContent: 'center',
      alignItems: 'center',
    },
    title: {
      fontSize: 24,
      fontWeight: '700',
      color: theme.colors.text,
      textAlign: 'center',
    },
    warningBox: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      padding: 16,
      borderRadius: 12,
      backgroundColor: `${theme.colors.warning}15`,
      borderWidth: 1,
      borderColor: theme.colors.warning,
      gap: 12,
    },
    warningText: {
      flex: 1,
      fontSize: 14,
      lineHeight: 20,
      color: theme.colors.warning,
      fontWeight: '500',
    },
    infoSection: {
      alignSelf: 'stretch',
      gap: 12,
    },
    infoTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    infoPoints: {
      gap: 12,
    },
    infoPoint: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    infoPointText: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.textSecondary,
      lineHeight: 20,
    },

    // Scanner styles
    scannerContainer: {
      flex: 1,
    },
    backButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 12,
      margin: 16,
      borderRadius: 8,
      backgroundColor: theme.colors.card,
      gap: 8,
    },
    backButtonText: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
    },

    // Confirmation styles
    confirmationContent: {
      flex: 1,
      alignItems: 'center',
      padding: 24,
      gap: 16,
    },
    successBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      borderRadius: 8,
      backgroundColor: `${theme.colors.success}15`,
      gap: 8,
      alignSelf: 'stretch',
    },
    successBannerText: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.success,
    },
    accountCard: {
      padding: 16,
      borderRadius: 12,
      backgroundColor: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
      alignItems: 'center',
      alignSelf: 'stretch',
    },
    accountLabel: {
      fontSize: 12,
      fontWeight: '500',
      color: theme.colors.textSecondary,
      marginBottom: 4,
    },
    accountName: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 4,
    },
    accountAddress: {
      fontSize: 13,
      fontFamily: 'monospace',
      color: theme.colors.textMuted,
    },
    instructionText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    qrWrapper: {
      padding: 16,
      backgroundColor: 'white',
      borderRadius: 16,
    },

    // Button styles
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 16,
      paddingHorizontal: 24,
      borderRadius: 12,
      backgroundColor: theme.colors.primary,
      gap: 8,
      alignSelf: 'stretch',
    },
    primaryButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    primaryButtonDisabled: {
      backgroundColor: theme.colors.border,
    },
    warningBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      borderRadius: 8,
      backgroundColor: `${theme.colors.warning}15`,
      gap: 8,
      alignSelf: 'stretch',
    },
    warningBannerText: {
      flex: 1,
      fontSize: 13,
      fontWeight: '500',
      color: theme.colors.warning,
    },
    cancelButton: {
      paddingVertical: 14,
      paddingHorizontal: 32,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      alignSelf: 'stretch',
      alignItems: 'center',
    },
    cancelButtonText: {
      fontSize: 15,
      fontWeight: '500',
      color: theme.colors.textSecondary,
    },

    // Success styles
    successIcon: {
      padding: 16,
      borderRadius: 50,
      backgroundColor: `${theme.colors.success}15`,
    },
    successTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: theme.colors.success,
    },
    successSubtitle: {
      fontSize: 15,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },

    // Error styles
    errorIcon: {
      padding: 16,
      borderRadius: 50,
      backgroundColor: `${theme.colors.error}15`,
    },
    errorTitle: {
      fontSize: 22,
      fontWeight: '700',
      color: theme.colors.error,
    },
    errorMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      paddingHorizontal: 20,
    },
    errorActions: {
      gap: 12,
      marginTop: 16,
      alignSelf: 'stretch',
    },
    retryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 14,
      paddingHorizontal: 32,
      borderRadius: 12,
      backgroundColor: theme.colors.primary,
      gap: 8,
    },
    retryButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });
