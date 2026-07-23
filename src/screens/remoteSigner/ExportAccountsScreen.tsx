/**
 * Export Accounts Screen (Signer Mode)
 *
 * This screen allows users in signer mode to export their accounts
 * via QR code so they can be imported as REMOTE_SIGNER accounts
 * in the wallet app on another device.
 */

import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useSecureScreen } from '@/hooks/useSecureScreen';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useWalletStore } from '@/store/walletStore';
import { useSignerConfig } from '@/store/remoteSignerStore';
import {
  RemoteSignerService,
  shouldUseAnimatedQR,
} from '@/services/remoteSigner';
import { AnimatedQRCode } from '@/components/remoteSigner';
import SignerAuthModal from '@/components/remoteSigner/SignerAuthModal';
import {
  AccountType,
  AccountMetadata,
  AuthenticationRequiredError,
} from '@/types/wallet';
import { formatAddress } from '@/utils/address';

/**
 * A frozen, signed pairing session ready to render as a QR.
 *
 * `key` binds the exact (device, selected address SET) the payload was signed
 * for. Any change to the account selection produces a different `key`, which
 * invalidates this session: each per-account signature binds the whole set + the
 * single frozen `ts`, so a changed selection can NEVER reuse these signatures —
 * the session must be regenerated and re-signed as a whole (DR-9, whole-session
 * cache — NOT per-address).
 */
interface PairingSession {
  /** `${deviceId}::${sortedSelectedAddrs.join(',')}` — the cache/invalidation key. */
  key: string;
  /** Encoded (raw-JSON) pairing payload for the QR. */
  encoded: string;
  /** Whether the payload exceeds one static frame and needs BC-UR animation. */
  useAnimated: boolean;
}

export default function ExportAccountsScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation();

  // Block OS screenshots / screen recordings while an account-pairing QR is on
  // screen (no-op on web/extension).
  useSecureScreen();

  const accounts = useWalletStore((state) => state.wallet?.accounts ?? []);
  const signerConfig = useSignerConfig();

  // Get signable accounts (STANDARD type only - we have their private keys)
  const signableAccounts = useMemo(() => {
    return accounts.filter(
      (acc: AccountMetadata) => acc.type === AccountType.STANDARD
    );
  }, [accounts]);

  // Track selected accounts
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    () => new Set(signableAccounts.map((a: AccountMetadata) => a.id))
  );

  // The frozen, signed pairing session (whole-session cache — see PairingSession).
  const [session, setSession] = useState<PairingSession | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);

  const selectedAccounts = useMemo(
    () =>
      signableAccounts.filter((acc: AccountMetadata) =>
        selectedAccountIds.has(acc.id)
      ),
    [signableAccounts, selectedAccountIds]
  );

  // Canonical cache key for the current selection: device id + the sorted
  // address SET. Recomputes on any selection change; when it diverges from the
  // frozen session's key the displayed QR is stale and must be regenerated
  // (re-signed as a whole — each signature binds the full set + ts).
  const selectedKey = useMemo(() => {
    if (!signerConfig || selectedAccounts.length === 0) return null;
    const sortedAddrs = selectedAccounts
      .map((acc: AccountMetadata) => acc.address)
      .sort();
    return `${signerConfig.deviceId}::${sortedAddrs.join(',')}`;
  }, [signerConfig, selectedAccounts]);

  // The displayed QR is only valid while the frozen session matches the current
  // selection. A selection change invalidates it (cache miss) → user regenerates.
  const isSessionValid = session !== null && session.key === selectedKey;

  const toggleAccount = (accountId: string) => {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedAccountIds(
      new Set(signableAccounts.map((a: AccountMetadata) => a.id))
    );
  };

  const selectNone = () => {
    setSelectedAccountIds(new Set());
  };

  // Freeze + sign the current selection into a session (all accounts signed
  // after a SINGLE unlock; the 60s key cache means one PIN entry covers them).
  const generateSession = async (pin?: string) => {
    if (
      !signerConfig ||
      selectedAccounts.length === 0 ||
      selectedKey === null
    ) {
      return;
    }

    setIsGenerating(true);
    try {
      const accountsForPairing = selectedAccounts.map(
        (acc: AccountMetadata) => ({
          address: acc.address,
          publicKey: acc.publicKey,
          label: acc.label,
        })
      );

      const pairing = await RemoteSignerService.createSignedPairingPayload(
        signerConfig.deviceId,
        signerConfig.deviceName,
        accountsForPairing,
        pin
      );
      const encoded = RemoteSignerService.encodePayload(pairing);

      setSession({
        key: selectedKey,
        encoded,
        useAnimated: shouldUseAnimatedQR(encoded),
      });
    } catch (error) {
      const messageText =
        error instanceof AuthenticationRequiredError
          ? 'Authentication failed. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Failed to generate the pairing QR code.';
      showAlert('Could Not Generate QR', messageText);
    } finally {
      setIsGenerating(false);
    }
  };

  // Explicit "Generate pairing QR" action — gate behind unlock/PIN.
  const handleGeneratePress = () => {
    if (selectedAccounts.length === 0 || isGenerating) return;
    setShowAuthModal(true);
  };

  const handleAuthSuccess = (pin?: string) => {
    setShowAuthModal(false);
    void generateSession(pin);
  };

  const handleAuthCancel = () => {
    setShowAuthModal(false);
  };

  // Cross-platform alert helper
  const showAlert = (title: string, message: string) => {
    if (Platform.OS === 'web') {
      window.alert(`${title}\n\n${message}`);
    } else {
      const { Alert } = require('react-native');
      Alert.alert(title, message);
    }
  };

  if (!signerConfig) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Export Accounts</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.emptyState}>
          <Ionicons
            name="warning-outline"
            size={48}
            color={theme.colors.warning}
          />
          <Text style={styles.emptyText}>
            Signer mode not configured. Please set up signer mode first.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (signableAccounts.length === 0) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Export Accounts</Text>
          <View style={styles.placeholder} />
        </View>
        <View style={styles.emptyState}>
          <Ionicons
            name="wallet-outline"
            size={48}
            color={theme.colors.textSecondary}
          />
          <Text style={styles.emptyText}>
            No signable accounts found. Create or import an account first.
          </Text>
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
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Export Accounts</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Info Card */}
        <View style={styles.infoCard}>
          <Ionicons
            name="qr-code-outline"
            size={24}
            color={theme.colors.primary}
            style={styles.infoIcon}
          />
          <View style={styles.infoContent}>
            <Text style={styles.infoTitle}>Export to Wallet</Text>
            <Text style={styles.infoDescription}>
              Scan this QR code with your online wallet device to import these
              accounts as air-gapped signer accounts. You&apos;ll be able to
              approve transactions from this device.
            </Text>
          </View>
        </View>

        {/* Device Info */}
        <View style={styles.deviceInfo}>
          <Text style={styles.deviceLabel}>Signer Device</Text>
          <Text style={styles.deviceName}>{signerConfig.deviceName}</Text>
          <Text style={styles.deviceId}>ID: {signerConfig.deviceId}</Text>
        </View>

        {/* Account Selection */}
        <View style={styles.accountSection}>
          <View style={styles.accountHeader}>
            <Text style={styles.sectionTitle}>
              Select Accounts ({selectedAccountIds.size}/
              {signableAccounts.length})
            </Text>
            <View style={styles.selectButtons}>
              <TouchableOpacity
                onPress={selectAll}
                style={styles.selectButton}
                accessibilityRole="button"
                accessibilityLabel="Select all accounts"
              >
                <Text style={styles.selectButtonText}>All</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={selectNone}
                style={styles.selectButton}
                accessibilityRole="button"
                accessibilityLabel="Deselect all accounts"
              >
                <Text style={styles.selectButtonText}>None</Text>
              </TouchableOpacity>
            </View>
          </View>

          {signableAccounts.map((account: AccountMetadata) => (
            <TouchableOpacity
              key={account.id}
              style={[
                styles.accountItem,
                selectedAccountIds.has(account.id) &&
                  styles.accountItemSelected,
              ]}
              onPress={() => toggleAccount(account.id)}
              accessible
              accessibilityRole="checkbox"
              accessibilityLabel={`${account.label || formatAddress(account.address)}, ${formatAddress(account.address)}`}
              accessibilityState={{
                checked: selectedAccountIds.has(account.id),
              }}
            >
              <View style={styles.accountCheckbox}>
                {selectedAccountIds.has(account.id) ? (
                  <Ionicons
                    name="checkbox"
                    size={24}
                    color={theme.colors.primary}
                  />
                ) : (
                  <Ionicons
                    name="square-outline"
                    size={24}
                    color={theme.colors.textSecondary}
                  />
                )}
              </View>
              <View style={styles.accountInfo}>
                <Text style={styles.accountName}>
                  {account.label || formatAddress(account.address)}
                </Text>
                <Text style={styles.accountAddress}>
                  {formatAddress(account.address)}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* Generate action — explicit, PIN-gated, async. Shown until a valid
            (matching-selection) signed session exists. */}
        {selectedAccountIds.size > 0 && !isSessionValid && (
          <TouchableOpacity
            style={[
              styles.generateButton,
              isGenerating && styles.generateButtonDisabled,
            ]}
            onPress={handleGeneratePress}
            disabled={isGenerating}
            accessibilityRole="button"
            accessibilityLabel={
              isGenerating ? 'Generating pairing QR' : 'Generate pairing QR'
            }
            accessibilityState={{ disabled: isGenerating, busy: isGenerating }}
          >
            {isGenerating ? (
              <ActivityIndicator size="small" color={theme.colors.buttonText} />
            ) : (
              <Ionicons
                name="qr-code-outline"
                size={20}
                color={theme.colors.buttonText}
              />
            )}
            <Text style={styles.generateButtonText}>
              {isGenerating ? 'Generating…' : 'Generate Pairing QR'}
            </Text>
          </TouchableOpacity>
        )}

        {selectedAccountIds.size > 0 && !isSessionValid && !isGenerating && (
          <Text style={styles.generateHint}>
            You&apos;ll be asked to authenticate. Each account is
            cryptographically signed so the wallet can verify this device
            controls it.
          </Text>
        )}

        {/* QR Code Display — only while the frozen session matches the current
            selection. Static payloads render RAW JSON via the plain QRCode; only
            multi-frame payloads use the BC-UR animated transport. */}
        {isSessionValid && session && (
          <View style={styles.qrSection}>
            <Text style={styles.sectionTitle}>Scan with Wallet Device</Text>
            <View style={styles.qrContainer}>
              {session.useAnimated ? (
                <AnimatedQRCode
                  data={session.encoded}
                  size={220}
                  showControls
                  showFrameCounter
                />
              ) : (
                <QRCode
                  value={session.encoded}
                  size={220}
                  backgroundColor="white"
                  color="#000000"
                />
              )}
            </View>
            <Text style={styles.qrHint}>
              Open the Voi Wallet app on your online device and scan this QR
              code to import these accounts.
            </Text>
          </View>
        )}

        {selectedAccountIds.size === 0 && (
          <View style={styles.noSelectionHint}>
            <Ionicons
              name="information-circle-outline"
              size={20}
              color={theme.colors.textSecondary}
            />
            <Text style={styles.noSelectionText}>
              Select at least one account to generate the QR code
            </Text>
          </View>
        )}
      </ScrollView>

      <SignerAuthModal
        visible={showAuthModal}
        onSuccess={handleAuthSuccess}
        onCancel={handleAuthCancel}
        transactionCount={selectedAccounts.length}
        message={
          selectedAccounts.length === 1
            ? 'Sign pairing for 1 account'
            : `Sign pairing for ${selectedAccounts.length} accounts`
        }
        biometricPromptMessage="Authenticate to sign this pairing"
      />
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface,
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
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.xl,
    },
    emptyText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.md,
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
    deviceInfo: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    deviceLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 4,
    },
    deviceName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    deviceId: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 4,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    accountSection: {
      marginBottom: theme.spacing.lg,
    },
    accountHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    selectButtons: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    selectButton: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    selectButtonText: {
      fontSize: 14,
      color: theme.colors.primary,
    },
    accountItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    accountItemSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: `${theme.colors.primary}15`,
    },
    accountCheckbox: {
      marginRight: theme.spacing.md,
    },
    accountInfo: {
      flex: 1,
    },
    accountName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
    },
    accountAddress: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      marginTop: 2,
    },
    generateButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginTop: theme.spacing.sm,
    },
    generateButtonDisabled: {
      opacity: 0.6,
    },
    generateButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    generateHint: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      lineHeight: 18,
    },
    qrSection: {
      alignItems: 'center',
      marginTop: theme.spacing.md,
    },
    qrContainer: {
      backgroundColor: 'white',
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.md,
    },
    qrHint: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      paddingHorizontal: theme.spacing.lg,
      lineHeight: 20,
    },
    noSelectionHint: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    noSelectionText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
  });
