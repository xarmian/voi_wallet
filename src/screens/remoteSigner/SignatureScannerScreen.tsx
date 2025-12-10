/**
 * Signature Scanner Screen (Wallet Mode)
 *
 * This screen allows the wallet device to scan the signed transaction
 * QR code from the signer device.
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
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Camera } from 'expo-camera';
import jsQR from 'jsqr';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useRemoteSignerStore } from '@/store/remoteSignerStore';
import { RemoteSignerService } from '@/services/remoteSigner';
import { isRemoteSignerResponse, RemoteSignerResponse } from '@/types/remoteSigner';
import { getFromClipboard } from '@/utils/clipboard';
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

type RouteParams = {
  SignatureScanner: {
    requestId: string;
  };
};

export default function SignatureScannerScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation<any>();
  const route = useRoute<RouteProp<RouteParams, 'SignatureScanner'>>();

  const { requestId } = route.params;

  const completePendingSignatureRequest = useRemoteSignerStore(
    (state) => state.completePendingSignatureRequest
  );
  const cancelPendingSignatureRequest = useRemoteSignerStore(
    (state) => state.cancelPendingSignatureRequest
  );

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

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

  const processQRData = useCallback(
    (data: string) => {
      if (isProcessing) return;
      setIsProcessing(true);

      try {
        // Decode the payload
        const payload = RemoteSignerService.decodePayload(data);

        // Verify it's a signing response
        if (!isRemoteSignerResponse(payload)) {
          showAlert(
            'Invalid QR Code',
            'This QR code is not a signed transaction response.'
          );
          setScanned(false);
          setIsProcessing(false);
          return;
        }

        const response = payload as RemoteSignerResponse;

        // Verify the response matches our request
        if (response.id !== requestId) {
          showAlert(
            'Wrong Response',
            'This signed response does not match the pending request. Please scan the correct QR code from your signer device.'
          );
          setScanned(false);
          setIsProcessing(false);
          return;
        }

        // Check if signing was successful
        if (!response.ok) {
          const errorMessage = response.err?.m || 'Signing was rejected or failed';
          showAlert('Signing Failed', errorMessage, [
            { text: 'OK', onPress: () => navigation.goBack() },
          ]);
          cancelPendingSignatureRequest(requestId);
          return;
        }

        // Success - complete the pending request
        completePendingSignatureRequest(requestId, response);

        showAlert(
          'Transaction Signed',
          'The transaction has been signed successfully and will be submitted to the network.',
          [
            {
              text: 'OK',
              onPress: () => {
                // Navigate back to the transaction flow
                // The completion callback will handle submitting
                navigation.popToTop();
              },
            },
          ]
        );
      } catch (error) {
        console.error('Failed to process QR data:', error);
        showAlert(
          'Invalid QR Code',
          'Could not read the QR code. Make sure you are scanning the signed response from your signer device.'
        );
        setScanned(false);
      } finally {
        setIsProcessing(false);
      }
    },
    [requestId, isProcessing, completePendingSignatureRequest, cancelPendingSignatureRequest, navigation]
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

  const handleCancel = () => {
    cancelPendingSignatureRequest(requestId);
    navigation.goBack();
  };

  // Render web UI
  const renderWebUI = () => (
    <View style={styles.webContainer}>
      <View style={styles.webContent}>
        <Ionicons name="scan-outline" size={64} color={theme.colors.primary} />
        <Text style={styles.webTitle}>Scan Signed Response</Text>
        <Text style={styles.webDescription}>
          Upload an image of the QR code from your signer device, or paste the
          signed response data from clipboard.
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
          instructionsText="Scan the signed transaction QR code from your signer device"
          showProgress={true}
        />
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={handleCancel}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Scan Signed Response</Text>
        <View style={styles.placeholder} />
      </View>

      {/* Waiting indicator */}
      <View style={styles.waitingBanner}>
        <Ionicons name="time-outline" size={20} color={theme.colors.primary} />
        <Text style={styles.waitingText}>
          Waiting for signed response from signer device...
        </Text>
      </View>

      {/* Content */}
      {Platform.OS === 'web' ? renderWebUI() : renderCameraUI()}

      {/* Processing indicator */}
      {isProcessing && (
        <View style={styles.processingOverlay}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.processingText}>Processing response...</Text>
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
    waitingBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      backgroundColor: `${theme.colors.primary}15`,
      paddingVertical: theme.spacing.sm,
    },
    waitingText: {
      fontSize: 14,
      color: theme.colors.primary,
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
      borderColor: theme.colors.success,
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
      backgroundColor: theme.colors.success,
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
