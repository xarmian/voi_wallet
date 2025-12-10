/**
 * Import Remote Signer Screen (Wallet Mode)
 *
 * This screen allows users in wallet mode to scan a QR code from a signer
 * device to import accounts as REMOTE_SIGNER accounts.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, Camera } from 'expo-camera';
import jsQR from 'jsqr';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useWalletStore } from '@/store/walletStore';
import { useRemoteSignerStore } from '@/store/remoteSignerStore';
import { RemoteSignerService } from '@/services/remoteSigner';
import { AccountType, ImportRemoteSignerAccountRequest } from '@/types/wallet';
import {
  RemoteSignerPairing,
  isRemoteSignerPairing,
  SignerDeviceInfo,
} from '@/types/remoteSigner';
import { formatAddress } from '@/utils/address';
import { getFromClipboard } from '@/utils/clipboard';

const { width } = Dimensions.get('window');

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

type ScreenState = 'scanning' | 'preview' | 'importing';

export default function ImportRemoteSignerScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation();

  const addRemoteSignerAccount = useWalletStore(
    (state) => state.addRemoteSignerAccount
  );
  const addPairedSigner = useRemoteSignerStore((state) => state.addPairedSigner);

  const [screenState, setScreenState] = useState<ScreenState>('scanning');
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [pairing, setPairing] = useState<RemoteSignerPairing | null>(null);
  const [selectedAccountAddresses, setSelectedAccountAddresses] = useState<Set<string>>(
    new Set()
  );
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      requestCameraPermission();
    } else {
      setHasPermission(true);
    }
  }, []);

  const requestCameraPermission = async () => {
    try {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    } catch (error) {
      console.error('Camera permission error:', error);
      setHasPermission(false);
    }
  };

  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanned) return;
      setScanned(true);
      processQRData(data);
    },
    [scanned]
  );

  const processQRData = (data: string) => {
    try {
      const payload = RemoteSignerService.decodePayload(data);

      if (!isRemoteSignerPairing(payload)) {
        showAlert('Invalid QR Code', 'This QR code is not a remote signer pairing code.');
        setScanned(false);
        return;
      }

      // Validate pairing data
      if (!payload.accts || payload.accts.length === 0) {
        showAlert('Invalid Pairing', 'No accounts found in the pairing data.');
        setScanned(false);
        return;
      }

      setPairing(payload);
      setSelectedAccountAddresses(new Set(payload.accts.map((a) => a.addr)));
      setScreenState('preview');
    } catch (error) {
      console.error('Failed to parse QR data:', error);
      showAlert(
        'Invalid QR Code',
        'Could not read the QR code. Make sure you are scanning a remote signer pairing QR code.'
      );
      setScanned(false);
    }
  };

  const handlePasteFromClipboard = async () => {
    try {
      const text = await getFromClipboard();
      if (text) {
        processQRData(text.trim());
      }
    } catch (error) {
      showAlert('Error', 'Failed to read from clipboard');
    }
  };

  // Web file input handler
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
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
            processQRData(code.data);
          } else {
            showAlert('No QR Code Found', 'Could not find a QR code in the selected image.');
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

  const handleImport = async () => {
    if (!pairing || selectedAccountAddresses.size === 0) return;

    setIsImporting(true);
    setScreenState('importing');

    try {
      // Import selected accounts
      const selectedAccounts = pairing.accts.filter((a) =>
        selectedAccountAddresses.has(a.addr)
      );

      for (const account of selectedAccounts) {
        const request: ImportRemoteSignerAccountRequest = {
          type: AccountType.REMOTE_SIGNER,
          address: account.addr,
          publicKey: account.pk,
          signerDeviceId: pairing.dev,
          signerDeviceName: pairing.name,
          label: account.label,
        };

        await addRemoteSignerAccount(request);
      }

      // Add/update paired signer info
      const signerInfo: SignerDeviceInfo = {
        deviceId: pairing.dev,
        deviceName: pairing.name,
        pairedAt: Date.now(),
        addresses: selectedAccounts.map((a) => a.addr),
      };
      await addPairedSigner(signerInfo);

      showAlert(
        'Success',
        `Successfully imported ${selectedAccounts.length} account${selectedAccounts.length > 1 ? 's' : ''} from the remote signer.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (error) {
      console.error('Failed to import accounts:', error);
      const message = error instanceof Error ? error.message : 'Failed to import accounts';
      showAlert('Error', message);
      setScreenState('preview');
    } finally {
      setIsImporting(false);
    }
  };

  const handleRescan = () => {
    setScanned(false);
    setPairing(null);
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
            <Text style={styles.webTitle}>Import Remote Signer</Text>
            <Text style={styles.webDescription}>
              Upload an image of the QR code from your signer device, or paste the
              pairing data from clipboard.
            </Text>

            <TouchableOpacity
              style={styles.webButton}
              onPress={() => fileInputRef.current?.click()}
            >
              <Ionicons name="image-outline" size={20} color={theme.colors.buttonText} />
              <Text style={styles.webButtonText}>Upload QR Image</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.webButton, styles.webButtonSecondary]}
              onPress={handlePasteFromClipboard}
            >
              <Ionicons name="clipboard-outline" size={20} color={theme.colors.primary} />
              <Text style={[styles.webButtonText, styles.webButtonTextSecondary]}>
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

    if (hasPermission === null) {
      return (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.statusText}>Requesting camera permission...</Text>
        </View>
      );
    }

    if (hasPermission === false) {
      return (
        <View style={styles.centerContainer}>
          <Ionicons name="camera-off-outline" size={48} color={theme.colors.error} />
          <Text style={styles.statusText}>Camera permission denied</Text>
          <Text style={styles.statusSubtext}>
            Please enable camera access in your device settings to scan QR codes.
          </Text>
          <TouchableOpacity style={styles.retryButton} onPress={requestCameraPermission}>
            <Text style={styles.retryButtonText}>Request Permission</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.cameraContainer}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        />
        <View style={styles.overlay}>
          <View style={styles.scanArea}>
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />
          </View>
        </View>
        <View style={styles.scanInstructions}>
          <Text style={styles.scanText}>
            Scan the QR code displayed on your signer device
          </Text>
        </View>
      </View>
    );
  };

  // Render preview state
  const renderPreview = () => {
    if (!pairing) return null;

    return (
      <ScrollView style={styles.previewContainer} contentContainerStyle={styles.previewContent}>
        {/* Signer Device Info */}
        <View style={styles.deviceCard}>
          <View style={styles.deviceIconContainer}>
            <Ionicons name="phone-portrait-outline" size={32} color={theme.colors.primary} />
          </View>
          <View style={styles.deviceInfo}>
            <Text style={styles.deviceName}>{pairing.name || 'Unknown Signer'}</Text>
            <Text style={styles.deviceId}>Device ID: {pairing.dev}</Text>
          </View>
        </View>

        {/* Account Selection */}
        <View style={styles.accountsSection}>
          <View style={styles.accountsHeader}>
            <Text style={styles.sectionTitle}>
              Select Accounts to Import ({selectedAccountAddresses.size}/{pairing.accts.length})
            </Text>
          </View>

          {pairing.accts.map((account) => (
            <TouchableOpacity
              key={account.addr}
              style={[
                styles.accountItem,
                selectedAccountAddresses.has(account.addr) && styles.accountItemSelected,
              ]}
              onPress={() => toggleAccountSelection(account.addr)}
            >
              <View style={styles.accountCheckbox}>
                {selectedAccountAddresses.has(account.addr) ? (
                  <Ionicons name="checkbox" size={24} color={theme.colors.primary} />
                ) : (
                  <Ionicons
                    name="square-outline"
                    size={24}
                    color={theme.colors.textSecondary}
                  />
                )}
              </View>
              <View style={styles.accountDetails}>
                {account.label && (
                  <Text style={styles.accountLabel}>{account.label}</Text>
                )}
                <Text style={styles.accountAddress}>{formatAddress(account.addr)}</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* Actions */}
        <View style={styles.previewActions}>
          <TouchableOpacity
            style={[
              styles.importButton,
              selectedAccountAddresses.size === 0 && styles.buttonDisabled,
            ]}
            onPress={handleImport}
            disabled={selectedAccountAddresses.size === 0}
          >
            <Ionicons name="download-outline" size={20} color={theme.colors.buttonText} />
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
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Import Remote Signer</Text>
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
    statusSubtext: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.sm,
      textAlign: 'center',
    },
    retryButton: {
      marginTop: theme.spacing.lg,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.lg,
    },
    retryButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    // Camera styles
    cameraContainer: {
      flex: 1,
    },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    scanArea: {
      width: width * 0.7,
      height: width * 0.7,
      position: 'relative',
    },
    corner: {
      position: 'absolute',
      width: 30,
      height: 30,
      borderColor: theme.colors.primary,
    },
    topLeft: {
      top: 0,
      left: 0,
      borderTopWidth: 3,
      borderLeftWidth: 3,
    },
    topRight: {
      top: 0,
      right: 0,
      borderTopWidth: 3,
      borderRightWidth: 3,
    },
    bottomLeft: {
      bottom: 0,
      left: 0,
      borderBottomWidth: 3,
      borderLeftWidth: 3,
    },
    bottomRight: {
      bottom: 0,
      right: 0,
      borderBottomWidth: 3,
      borderRightWidth: 3,
    },
    scanInstructions: {
      position: 'absolute',
      bottom: 100,
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    scanText: {
      fontSize: 16,
      color: 'white',
      textAlign: 'center',
      backgroundColor: 'rgba(0,0,0,0.6)',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.borderRadius.lg,
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
    deviceName: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    deviceId: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 4,
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
    accountLabel: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 2,
    },
    accountAddress: {
      fontSize: 14,
      color: theme.colors.textSecondary,
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
