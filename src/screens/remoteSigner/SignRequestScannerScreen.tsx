/**
 * Sign Request Scanner Screen (Signer Mode)
 *
 * This screen allows the signer device to scan a QR code containing
 * a transaction signing request from the wallet device.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Camera } from 'expo-camera';
import jsQR from 'jsqr';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useRemoteSignerStore, useSignerConfig } from '@/store/remoteSignerStore';
import { useWalletStore } from '@/store/walletStore';
import { RemoteSignerService } from '@/services/remoteSigner';
import { isRemoteSignerRequest } from '@/types/remoteSigner';
import { getFromClipboard } from '@/utils/clipboard';
import { AccountType, AccountMetadata } from '@/types/wallet';
import { AnimatedQRScanner } from '@/components/remoteSigner';

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

export default function SignRequestScannerScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation<any>();

  const signerConfig = useSignerConfig();
  const accounts = useWalletStore((state) => state.wallet?.accounts ?? []);
  const validateRequest = useRemoteSignerStore((state) => state.validateRequest);
  const setPendingRequest = useRemoteSignerStore((state) => state.setPendingRequest);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Get addresses we can sign for (STANDARD accounts only)
  const signableAddresses = new Set(
    accounts
      .filter((acc: AccountMetadata) => acc.type === AccountType.STANDARD)
      .map((acc: AccountMetadata) => acc.address)
  );

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

  const processQRData = useCallback(
    (data: string) => {
      if (isProcessing) return;
      setIsProcessing(true);

      try {
        // Decode the payload
        const payload = RemoteSignerService.decodePayload(data);

        // Verify it's a signing request
        if (!isRemoteSignerRequest(payload)) {
          showAlert(
            'Invalid QR Code',
            'This QR code is not a transaction signing request.'
          );
          setScanned(false);
          setIsProcessing(false);
          return;
        }

        // Validate the request (timestamp, duplicate check, etc.)
        const validation = validateRequest(payload);
        if (!validation.valid) {
          showAlert('Invalid Request', validation.error || 'Request validation failed');
          setScanned(false);
          setIsProcessing(false);
          return;
        }

        // Check if we have the keys for all signers
        const missingSigners: string[] = [];
        for (const txn of payload.txns) {
          const signerAddr = txn.a || txn.s; // Use auth address if provided
          if (!signableAddresses.has(signerAddr)) {
            missingSigners.push(signerAddr);
          }
        }

        if (missingSigners.length > 0) {
          showAlert(
            'Missing Keys',
            `This device does not have the signing keys for:\n${missingSigners.slice(0, 3).join('\n')}${missingSigners.length > 3 ? `\n...and ${missingSigners.length - 3} more` : ''}`
          );
          setScanned(false);
          setIsProcessing(false);
          return;
        }

        // All validations passed - set as pending and navigate to review
        setPendingRequest(payload);
        navigation.navigate('RemoteSignerTransactionReview', { request: payload });
      } catch (error) {
        console.error('Failed to process QR data:', error);
        showAlert(
          'Invalid QR Code',
          'Could not read the QR code. Make sure you are scanning a transaction signing request.'
        );
        setScanned(false);
      } finally {
        setIsProcessing(false);
      }
    },
    [isProcessing, validateRequest, signableAddresses, setPendingRequest, navigation]
  );

  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanned || isProcessing) return;
      setScanned(true);
      processQRData(data);
    },
    [scanned, isProcessing, processQRData]
  );

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

  // Render web UI
  const renderWebUI = () => (
    <View style={styles.webContainer}>
      <View style={styles.webContent}>
        <Ionicons name="scan-outline" size={64} color={theme.colors.primary} />
        <Text style={styles.webTitle}>Scan Signing Request</Text>
        <Text style={styles.webDescription}>
          Upload an image of the QR code from your wallet device, or paste the
          request data from clipboard.
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

  // Handle scan from AnimatedQRScanner (supports both static and animated QR)
  const handleAnimatedScan = useCallback(
    (data: string) => {
      if (isProcessing) return;
      setScanned(true);
      processQRData(data);
    },
    [isProcessing, processQRData]
  );

  const handleScanError = useCallback(
    (error: string) => {
      showAlert('Scan Error', error);
    },
    []
  );

  // Render camera UI using AnimatedQRScanner
  const renderCameraUI = () => {
    return (
      <View style={styles.cameraContainer}>
        <AnimatedQRScanner
          onScan={handleAnimatedScan}
          onError={handleScanError}
          instructionsText="Scan the transaction QR code from your wallet device"
          showProgress={true}
        />
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Scan Request</Text>
        <View style={styles.placeholder} />
      </View>

      {/* Content */}
      {Platform.OS === 'web' ? renderWebUI() : renderCameraUI()}

      {/* Processing indicator */}
      {isProcessing && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.processingText}>Processing request...</Text>
        </View>
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
      bottom: 150,
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
    rescanButton: {
      position: 'absolute',
      bottom: 80,
      left: theme.spacing.xl,
      right: theme.spacing.xl,
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
    },
    rescanButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
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
    processingOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.7)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    processingText: {
      fontSize: 16,
      color: 'white',
      marginTop: theme.spacing.md,
    },
  });
