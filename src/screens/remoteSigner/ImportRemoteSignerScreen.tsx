/**
 * Import Remote Signer Screen (Wallet Mode)
 *
 * This screen allows users in wallet mode to scan a QR code from a signer
 * device to import accounts as REMOTE_SIGNER accounts.
 */

import React, { useState, useRef } from 'react';
import {
  Alert,
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
import jsQR from 'jsqr';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useWalletStore } from '@/store/walletStore';
import { useRemoteSignerStore } from '@/store/remoteSignerStore';
import {
  RemoteSignerService,
  AnimatedQRService,
  isUrEncodedFrame,
  mapVerifiedPairingToImportRequests,
} from '@/services/remoteSigner';
import type { VerifiedPairing } from '@/services/remoteSigner';
import { AnimatedQRScanner } from '@/components/remoteSigner';
import { SignerDeviceInfo } from '@/types/remoteSigner';
import { formatAddress } from '@/utils/address';
import { getFromClipboard } from '@/utils/clipboard';

/** Verification outcome that gates the preview UI. */
type VerifiedStatus = 'v2-verified' | 'v1-unsigned';

// Cross-platform alert helper
const showAlert = (
  title: string,
  message: string,
  buttons?: {
    text: string;
    onPress?: () => void;
    style?: 'default' | 'cancel' | 'destructive';
  }[]
) => {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const confirmed = window.confirm(`${title}\n\n${message}`);
      if (confirmed) {
        const confirmButton =
          buttons.find((b) => b.style !== 'cancel') || buttons[0];
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
    Alert.alert(title, message, buttons);
  }
};

type ScreenState = 'scanning' | 'preview' | 'importing';

export default function ImportRemoteSignerScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation();

  const addRemoteSignerAccount = useWalletStore(
    (state) => state.addRemoteSignerAccount
  );
  const addPairedSigner = useRemoteSignerStore(
    (state) => state.addPairedSigner
  );

  const [screenState, setScreenState] = useState<ScreenState>('scanning');
  // The TRUSTED, sanitized pairing from verifyPairing (pubkeys DERIVED from
  // addr; never the wire `pk`). `null` until a scan verifies.
  const [verified, setVerified] = useState<VerifiedPairing | null>(null);
  const [authStatus, setAuthStatus] = useState<VerifiedStatus | null>(null);
  // ACTIVE confirmation gate for an unauthenticated (v1) pairing (DR-7). Must be
  // explicitly toggled on before a v1 import is allowed; reset on every rescan.
  const [confirmedUnverified, setConfirmedUnverified] = useState(false);
  const [selectedAccountAddresses, setSelectedAccountAddresses] = useState<
    Set<string>
  >(new Set());
  const [isImporting, setIsImporting] = useState(false);
  // Bumped to force-remount the native scanner after a failed scan. A rejected
  // or malformed QR leaves AnimatedQRScanner in a 'completed' state that ignores
  // subsequent frames; remounting lets the user retry without leaving the screen.
  const [scannerKey, setScannerKey] = useState(0);
  const resetScanner = () => setScannerKey((k) => k + 1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * Verify a fully-decoded pairing JSON string (raw JSON from a static frame, or
   * the reassembled payload from a BC-UR multipart scan) and route on the result.
   */
  const verifyAndPreview = (json: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      showAlert(
        'Invalid QR Code',
        'Could not read the QR code. Make sure you are scanning an air-gapped signer pairing QR code.'
      );
      resetScanner();
      return;
    }

    const result = RemoteSignerService.verifyPairing(parsed);

    if (result.status === 'rejected') {
      showAlert(
        'Pairing Rejected',
        `This pairing could not be verified and was blocked.\n\nReason: ${result.reason}`
      );
      resetScanner();
      return;
    }

    setVerified(result.pairing);
    setAuthStatus(result.status);
    setConfirmedUnverified(false);
    setSelectedAccountAddresses(
      new Set(result.pairing.accounts.map((a) => a.addr))
    );
    setScreenState('preview');
  };

  /**
   * Handle a scanned frame from the native BC-UR-aware scanner. The scanner has
   * already reassembled multipart UR and passes the final decoded string here
   * (or a raw non-UR QR verbatim), so this only needs to verify.
   */
  const handleScannerResult = (data: string) => {
    verifyAndPreview(data);
  };

  const handleScannerError = (error: string) => {
    showAlert('Scan Error', error || 'Failed to read the QR code.');
    resetScanner();
  };

  /**
   * Route a single scanned string that has NOT been through the reassembly path
   * (web file/clipboard). A single static image can only carry a raw-JSON frame
   * or a single-part UR; a MULTIPART (animated) pairing needs a camera.
   */
  const handleSingleFrame = (data: string) => {
    if (isUrEncodedFrame(data)) {
      if (AnimatedQRService.isMultipartURFrame(data)) {
        showAlert(
          'Animated QR Not Supported Here',
          'This is a multi-frame (animated) pairing code. Import it using the camera scanner on a mobile device.'
        );
        return;
      }
      try {
        verifyAndPreview(AnimatedQRService.decodeSinglePartUR(data));
      } catch {
        showAlert(
          'Invalid QR Code',
          'Could not decode the pairing QR code from this image.'
        );
      }
      return;
    }
    // Raw-JSON static fast-path.
    verifyAndPreview(data);
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await getFromClipboard();
      if (text) {
        handleSingleFrame(text.trim());
      }
    } catch (error) {
      showAlert('Error', 'Failed to read from clipboard');
    }
  };

  // Web file input handler
  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const image = new Image();
      const reader = new FileReader();

      reader.onload = (e) => {
        image.onload = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;

          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          ctx.drawImage(image, 0, 0);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

          const code = jsQR(imageData.data, imageData.width, imageData.height);
          if (code?.data) {
            handleSingleFrame(code.data);
          } else {
            showAlert(
              'No QR Code Found',
              'Could not find a QR code in the selected image.'
            );
          }
        };
        image.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    } catch (error) {
      showAlert('Error', 'Failed to process the image file.');
    }
  };

  const toggleAccountSelection = (address: string) => {
    setSelectedAccountAddresses((prev) => {
      const next = new Set(prev);
      if (next.has(address)) {
        next.delete(address);
      } else {
        next.add(address);
      }
      return next;
    });
  };

  // A v1 (unauthenticated) pairing must be actively confirmed before import.
  const importBlockedForV1 =
    authStatus === 'v1-unsigned' && !confirmedUnverified;
  const canImport =
    selectedAccountAddresses.size > 0 && !importBlockedForV1 && !isImporting;

  const handleImport = async () => {
    if (!verified || !authStatus || !canImport) return;

    setIsImporting(true);
    setScreenState('importing');

    try {
      // Map the VERIFIED pairing → import requests: each request carries the
      // pubkey DERIVED from addr (never the wire `pk`) and the verified
      // authLevel ('v2-signed' | 'v1-unsigned').
      const requests = mapVerifiedPairingToImportRequests(
        verified,
        selectedAccountAddresses
      );

      for (const request of requests) {
        await addRemoteSignerAccount(request);
      }

      // Add/update paired signer info.
      const signerInfo: SignerDeviceInfo = {
        deviceId: verified.dev,
        deviceName: verified.name,
        pairedAt: Date.now(),
        addresses: requests.map((r) => r.address),
      };
      await addPairedSigner(signerInfo);

      showAlert(
        'Success',
        `Successfully imported ${requests.length} account${requests.length > 1 ? 's' : ''} from the air-gapped signer.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (error) {
      console.error('Failed to import accounts:', error);
      const message =
        error instanceof Error ? error.message : 'Failed to import accounts';
      showAlert('Error', message);
      setScreenState('preview');
    } finally {
      setIsImporting(false);
    }
  };

  const handleRescan = () => {
    setVerified(null);
    setAuthStatus(null);
    setConfirmedUnverified(false);
    setSelectedAccountAddresses(new Set());
    setScreenState('scanning');
  };

  // Render scanning state
  const renderScanning = () => {
    if (Platform.OS === 'web') {
      return (
        <View style={styles.webContainer}>
          <View style={styles.webContent}>
            <Ionicons
              name="qr-code-outline"
              size={64}
              color={theme.colors.primary}
            />
            <Text style={styles.webTitle}>Import Air-gapped Signer</Text>
            <Text style={styles.webDescription}>
              Upload an image of the QR code from your signer device, or paste
              the pairing data from clipboard.
            </Text>

            <TouchableOpacity
              style={styles.webButton}
              onPress={() => fileInputRef.current?.click()}
            >
              <Ionicons
                name="image-outline"
                size={20}
                color={theme.colors.buttonText}
              />
              <Text style={styles.webButtonText}>Upload QR Image</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.webButton, styles.webButtonSecondary]}
              onPress={handlePasteFromClipboard}
            >
              <Ionicons
                name="clipboard-outline"
                size={20}
                color={theme.colors.primary}
              />
              <Text
                style={[styles.webButtonText, styles.webButtonTextSecondary]}
              >
                Paste from Clipboard
              </Text>
            </TouchableOpacity>

            <input
              ref={fileInputRef as any}
              type="file"
              accept="image/*"
              onChange={handleFileSelect as any}
              style={{ display: 'none' }}
            />
            <canvas ref={canvasRef as any} style={{ display: 'none' }} />
          </View>
        </View>
      );
    }

    // Native: the BC-UR-aware scanner handles camera permission, raw-QR
    // pass-through, AND multi-frame (animated) UR reassembly. It calls onScan
    // with the final decoded payload string in every case.
    return (
      <View style={styles.cameraContainer}>
        <AnimatedQRScanner
          key={scannerKey}
          onScan={handleScannerResult}
          onError={handleScannerError}
          instructionsText="Scan the pairing QR code displayed on your signer device"
        />
      </View>
    );
  };

  // Render preview state
  const renderPreview = () => {
    if (!verified || !authStatus) return null;

    const isVerified = authStatus === 'v2-verified';

    return (
      <ScrollView
        style={styles.previewContainer}
        contentContainerStyle={styles.previewContent}
      >
        {/* Trust status banner — the cryptographic verdict of verifyPairing. */}
        {isVerified ? (
          <View style={styles.verifiedBanner}>
            <Ionicons
              name="shield-checkmark"
              size={24}
              color={theme.colors.success}
            />
            <View style={styles.bannerText}>
              <Text style={styles.verifiedTitle}>Verified pairing</Text>
              <Text style={styles.verifiedSubtitle}>
                The signer cryptographically proved it controls every account
                below.
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.warningBanner}>
            <Ionicons name="warning" size={24} color={theme.colors.warning} />
            <View style={styles.bannerText}>
              <Text style={styles.warningTitle}>Unauthenticated pairing</Text>
              <Text style={styles.warningSubtitle}>
                This pairing is NOT cryptographically signed. The signer did not
                prove it controls these accounts — only import it if you trust
                the source.
              </Text>
            </View>
          </View>
        )}

        {/* Signer Device Info — Device ID is the trust-bearing identity. */}
        <View style={styles.deviceCard}>
          <View style={styles.deviceIconContainer}>
            <Ionicons
              name="phone-portrait-outline"
              size={32}
              color={theme.colors.primary}
            />
          </View>
          <View style={styles.deviceInfo}>
            <Text style={styles.deviceIdLabel}>Signer Device ID</Text>
            <Text style={styles.deviceId}>{verified.dev}</Text>
            <View style={styles.unverifiedRow}>
              <Text style={styles.deviceNameUnverified} numberOfLines={1}>
                {verified.name || 'Unnamed device'}
              </Text>
              <View style={styles.unverifiedTag}>
                <Text style={styles.unverifiedTagText}>user-supplied</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Account Selection */}
        <View style={styles.accountsSection}>
          <View style={styles.accountsHeader}>
            <Text style={styles.sectionTitle}>
              Select Accounts to Import ({selectedAccountAddresses.size}/
              {verified.accounts.length})
            </Text>
          </View>

          {verified.accounts.map((account) => (
            <TouchableOpacity
              key={account.addr}
              style={[
                styles.accountItem,
                selectedAccountAddresses.has(account.addr) &&
                  styles.accountItemSelected,
              ]}
              onPress={() => toggleAccountSelection(account.addr)}
            >
              <View style={styles.accountCheckbox}>
                {selectedAccountAddresses.has(account.addr) ? (
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
              <View style={styles.accountDetails}>
                {/* Address is cryptographically bound (pubkey derived from it). */}
                <Text style={styles.accountAddress}>
                  {formatAddress(account.addr)}
                </Text>
                {account.label ? (
                  <View style={styles.unverifiedRow}>
                    <Text
                      style={styles.accountLabelUnverified}
                      numberOfLines={1}
                    >
                      {account.label}
                    </Text>
                    <View style={styles.unverifiedTag}>
                      <Text style={styles.unverifiedTagText}>unverified</Text>
                    </View>
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* Active confirmation gate for an unauthenticated (v1) pairing. */}
        {authStatus === 'v1-unsigned' && (
          <TouchableOpacity
            style={[
              styles.confirmCard,
              confirmedUnverified && styles.confirmCardChecked,
            ]}
            onPress={() => setConfirmedUnverified((prev) => !prev)}
            activeOpacity={0.8}
          >
            <Ionicons
              name={confirmedUnverified ? 'checkbox' : 'square-outline'}
              size={24}
              color={
                confirmedUnverified
                  ? theme.colors.warning
                  : theme.colors.textSecondary
              }
            />
            <Text style={styles.confirmText}>
              This pairing is unauthenticated — the signer did not
              cryptographically prove control of these accounts. I understand.
            </Text>
          </TouchableOpacity>
        )}

        {/* Actions */}
        <View style={styles.previewActions}>
          <TouchableOpacity
            style={[styles.importButton, !canImport && styles.buttonDisabled]}
            onPress={handleImport}
            disabled={!canImport}
          >
            <Ionicons
              name="download-outline"
              size={20}
              color={theme.colors.buttonText}
            />
            <Text style={styles.importButtonText}>
              Import {selectedAccountAddresses.size} Account
              {selectedAccountAddresses.size !== 1 ? 's' : ''}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.rescanButton} onPress={handleRescan}>
            <Text style={styles.rescanButtonText}>Scan Different QR Code</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  };

  // Render importing state
  const renderImporting = () => (
    <View style={styles.centerContainer}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
      <Text style={styles.statusText}>Importing accounts...</Text>
    </View>
  );

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
        <Text style={styles.title}>Import Air-gapped Signer</Text>
        <View style={styles.placeholder} />
      </View>

      {/* Content */}
      {screenState === 'scanning' && renderScanning()}
      {screenState === 'preview' && renderPreview()}
      {screenState === 'importing' && renderImporting()}
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
    centerContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.xl,
    },
    statusText: {
      fontSize: 16,
      color: theme.colors.text,
      marginTop: theme.spacing.md,
      textAlign: 'center',
    },
    // Camera styles — the BC-UR scanner fills this and renders its own overlay.
    cameraContainer: {
      flex: 1,
    },
    // Trust status banners
    verifiedBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      backgroundColor: `${theme.colors.success}15`,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: `${theme.colors.success}40`,
    },
    warningBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      backgroundColor: `${theme.colors.warning}15`,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: `${theme.colors.warning}40`,
    },
    bannerText: {
      flex: 1,
    },
    verifiedTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: theme.colors.success,
    },
    verifiedSubtitle: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      marginTop: 2,
      lineHeight: 18,
    },
    warningTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: theme.colors.warning,
    },
    warningSubtitle: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      marginTop: 2,
      lineHeight: 18,
    },
    // Unverified (user-supplied) markers
    unverifiedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      marginTop: 4,
    },
    unverifiedTag: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: theme.borderRadius.sm,
      backgroundColor: `${theme.colors.warning}20`,
    },
    unverifiedTagText: {
      fontSize: 10,
      fontWeight: '600',
      color: theme.colors.warning,
      textTransform: 'uppercase',
      letterSpacing: 0.3,
    },
    deviceIdLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 2,
    },
    deviceNameUnverified: {
      flexShrink: 1,
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    accountLabelUnverified: {
      flexShrink: 1,
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    // v1 active-confirmation gate
    confirmCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: `${theme.colors.warning}40`,
    },
    confirmCardChecked: {
      borderColor: theme.colors.warning,
      backgroundColor: `${theme.colors.warning}12`,
    },
    confirmText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.text,
      lineHeight: 19,
    },
    // Web styles
    webContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.xl,
    },
    webContent: {
      alignItems: 'center',
      maxWidth: 400,
    },
    webTitle: {
      fontSize: 24,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
    },
    webDescription: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginBottom: theme.spacing.xl,
      lineHeight: 24,
    },
    webButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.xl,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.md,
      width: '100%',
      gap: theme.spacing.sm,
    },
    webButtonSecondary: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    webButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    webButtonTextSecondary: {
      color: theme.colors.primary,
    },
    // Preview styles
    previewContainer: {
      flex: 1,
    },
    previewContent: {
      padding: theme.spacing.lg,
    },
    deviceCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    deviceIconContainer: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: `${theme.colors.primary}15`,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.md,
    },
    deviceInfo: {
      flex: 1,
    },
    deviceId: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.text,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    accountsSection: {
      marginBottom: theme.spacing.lg,
    },
    accountsHeader: {
      marginBottom: theme.spacing.md,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
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
    accountDetails: {
      flex: 1,
    },
    accountAddress: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    previewActions: {
      marginTop: theme.spacing.md,
    },
    importButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      gap: theme.spacing.sm,
    },
    buttonDisabled: {
      backgroundColor: theme.colors.textMuted,
    },
    importButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    rescanButton: {
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      marginTop: theme.spacing.sm,
    },
    rescanButtonText: {
      fontSize: 14,
      color: theme.colors.primary,
    },
  });
