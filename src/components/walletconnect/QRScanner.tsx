import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Dimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { CameraView, Camera } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { DeepLinkService } from '@/services/deeplink';
import { isWalletConnectUri, isVoiUri } from '@/services/walletconnect/utils';
import { isAlgorandPaymentUri, parseAlgorandUri } from '@/utils/algorandUri';
import {
  parseArc0300AccountImportUri,
  Arc0300AccountImportResult,
} from '@/utils/arc0300';
import algosdk from 'algosdk';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { getFromClipboard } from '@/utils/clipboard';

interface Props {
  onClose: () => void;
  onSuccess?: (uri: string) => void;
}

const { width, height } = Dimensions.get('window');

export default function QRScanner({ onClose, onSuccess }: Props) {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  useEffect(() => {
    requestCameraPermission();
  }, []);

  // Reset scanner state when component gains focus
  useFocusEffect(
    React.useCallback(() => {
      setScanned(false);
      setIsProcessing(false);
    }, [])
  );

  const requestCameraPermission = async () => {
    const { status } = await Camera.requestCameraPermissionsAsync();
    setHasPermission(status === 'granted');
  };

  const handleBarCodeScanned = async ({
    type,
    data,
  }: {
    type: string;
    data: string;
  }) => {
    if (scanned || isProcessing) {
      return;
    }

    setScanned(true);
    setIsProcessing(true);

    const rawValue = typeof data === 'string' ? data.trim() : '';
    if (!rawValue) {
      setScanned(false);
      setIsProcessing(false);
      Alert.alert(
        'QR Code Error',
        'QR code data is empty. Please try scanning again.',
        [
          {
            text: 'Try Again',
            onPress: () => {
              setScanned(false);
              setIsProcessing(false);
            },
          },
          { text: 'Cancel', onPress: onClose },
        ]
      );
      return;
    }

    try {
      const arcImportResult = parseArc0300AccountImportUri(rawValue);
      if (arcImportResult) {
        Alert.alert(
          'Account Import QR Code',
          'This is an account import QR code. Please use the Account Import feature from Settings → Import Account → QR Code to import accounts.',
          [
            {
              text: 'OK',
              onPress: () => {
                setScanned(false);
                setIsProcessing(false);
              },
            },
          ]
        );
        return;
      }

      if (isWalletConnectUri(rawValue)) {
        await handleWalletConnectUri(rawValue);
      } else if (isVoiUri(rawValue)) {
        await handleVoiUri(rawValue);
      } else if (isAlgorandPaymentUri(rawValue)) {
        await handleAlgorandPaymentUri(rawValue);
      } else {
        // Try to handle as a regular URL or address
        await handleGenericUri(rawValue);
      }
    } catch (error) {
      // Ensure we always show a user-friendly error message
      let errorMessage = 'Failed to process QR code. Please try again.';
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      
      Alert.alert(
        'QR Code Error',
        errorMessage,
        [
          {
            text: 'Try Again',
            onPress: () => {
              setScanned(false);
              setIsProcessing(false);
            },
          },
          { text: 'Cancel', onPress: onClose },
        ]
      );
    }
  };

  const handleWalletConnectUri = async (uri: string) => {
    try {
      const deepLinkService = DeepLinkService.getInstance();
      const handled = await deepLinkService.testDeepLink(uri);

      if (handled) {
        // For WalletConnect, we'll call onSuccess but the QRScannerScreen
        // won't auto-close, so errors can still be shown
        onSuccess?.(uri);
      } else {
        // If handled is false, it means an error screen was already shown
        // Don't throw an error here to avoid showing an additional alert
        // Reset scanner state so user can try again
        setScanned(false);
        setIsProcessing(false);
      }
    } catch (error) {
      // Only throw for unexpected errors (not user input errors)
      throw error;
    }
  };

  const handleVoiUri = async (uri: string) => {
    try {
      const deepLinkService = DeepLinkService.getInstance();
      const handled = await deepLinkService.testDeepLink(uri);

      if (handled) {
        onSuccess?.(uri);
        onClose();
        Alert.alert('Success', 'Processing Voi URI...');
      } else {
        throw new Error('Failed to process Voi URI');
      }
    } catch (error) {
      throw new Error(
        `Voi URI processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  };

  const handleAlgorandPaymentUri = async (uri: string) => {
    try {
      const parsed = parseAlgorandUri(uri);

      if (!parsed || !parsed.isValid) {
        throw new Error('Invalid Algorand payment URI format');
      }

      // Let the parent screen handle navigation directly
      onSuccess?.(uri);
    } catch (error) {
      throw new Error(
        `Algorand payment URI processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  };

  const resolveAlgorandAddress = (value: string): string | null => {
    const candidate = value.trim();
    if (!candidate) {
      return null;
    }

    try {
      if (algosdk.isValidAddress(candidate)) {
        return candidate;
      }
    } catch (error) {
      console.error('Address validation failed:', error);
    }

    const upperCandidate = candidate.toUpperCase();
    if (upperCandidate !== candidate) {
      try {
        if (algosdk.isValidAddress(upperCandidate)) {
          return upperCandidate;
        }
      } catch (error) {
        console.error('Uppercase address validation failed:', error);
      }
    }

    return null;
  };

  const handleGenericUri = async (data: string) => {
    const cleaned = data.trim();

    // Check if it looks like an address
    const resolvedAddress = resolveAlgorandAddress(cleaned);
    if (resolvedAddress) {
      await onSuccess?.(resolvedAddress);
      return;
    }

    // Check if it's a URL
    if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
      Alert.alert(
        'URL Detected',
        'This appears to be a web URL. This QR scanner is designed for WalletConnect and Voi URIs.',
        [
          {
            text: 'Try Again',
            onPress: () => {
              setScanned(false);
              setIsProcessing(false);
            },
          },
          { text: 'Cancel', onPress: onClose },
        ]
      );
      return;
    }

    // Unknown format
    throw new Error(
      'Unsupported QR code format. Please scan a WalletConnect or payment QR code.'
    );
  };

  const handlePasteUri = async () => {
    if (scanned || isProcessing) {
      return;
    }

    setScanned(true);
    setIsProcessing(true);

    try {
      const clipboardText = await getFromClipboard();
      const rawValue = clipboardText.trim();

      if (!rawValue) {
        Alert.alert(
          'Clipboard Empty',
          'No text found in clipboard. Please copy a WalletConnect URI, payment request, or address and try again.',
          [
            {
              text: 'OK',
              onPress: () => {
                setScanned(false);
                setIsProcessing(false);
              },
            },
          ]
        );
        return;
      }

      // Process the pasted URI through the same logic as scanned QR codes
      await handleBarCodeScanned({ type: 'qr', data: rawValue });
    } catch (error) {
      let errorMessage = 'Failed to process clipboard content. Please try again.';
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      Alert.alert(
        'Paste Error',
        errorMessage,
        [
          {
            text: 'Try Again',
            onPress: () => {
              setScanned(false);
              setIsProcessing(false);
            },
          },
          { text: 'Cancel', onPress: onClose },
        ]
      );
    }
  };

  const renderOverlay = () => (
    <View style={styles.overlay}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.closeButton} onPress={onClose}>
          <Ionicons name="close" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={styles.title}>Scan QR Code</Text>
        <View style={styles.placeholder} />
      </View>

      <View style={styles.scanArea}>
        <View style={styles.scanFrame}>
          <View style={[styles.corner, styles.topLeft]} />
          <View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} />
          <View style={[styles.corner, styles.bottomRight]} />
        </View>
      </View>

      <View style={styles.instructions}>
        <Text style={styles.instructionText}>
          Position the QR code within the frame to scan
        </Text>
        <Text style={styles.supportedFormats}>
          Supports WalletConnect and Voi/Algorand/Pera payment requests
        </Text>
      </View>

      <View style={styles.bottomSection}>
        <TouchableOpacity
          style={[
            styles.pasteButton,
            (scanned || isProcessing) && styles.pasteButtonDisabled,
          ]}
          onPress={handlePasteUri}
          disabled={scanned || isProcessing}
        >
          <Ionicons
            name="clipboard-outline"
            size={20}
            color={
              scanned || isProcessing ? theme.colors.textMuted : '#FFFFFF'
            }
          />
          <Text
            style={[
              styles.pasteButtonText,
              (scanned || isProcessing) && styles.pasteButtonTextDisabled,
            ]}
          >
            Paste URI from Clipboard
          </Text>
        </TouchableOpacity>
      </View>

      {scanned && (
        <View style={styles.processingContainer}>
          <Text style={styles.processingText}>
            {isProcessing ? 'Processing...' : 'Scanned! Tap to scan again'}
          </Text>
        </View>
      )}
    </View>
  );

  if (hasPermission === null) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>
          Requesting camera permission...
        </Text>
      </View>
    );
  }

  if (hasPermission === false) {
    return (
      <View style={styles.permissionContainer}>
        <Ionicons name="camera" size={64} color={theme.colors.textMuted} />
        <Text style={styles.permissionTitle}>Camera Permission Required</Text>
        <Text style={styles.permissionText}>
          Please enable camera access to scan QR codes
        </Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={requestCameraPermission}
        >
          <Text style={styles.permissionButtonText}>Enable Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        onBarcodeScanned={
          scanned && !isProcessing ? undefined : handleBarCodeScanned
        }
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
      />
      {renderOverlay()}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: 'black',
    },
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 60,
      paddingHorizontal: 20,
      paddingBottom: 20,
    },
    closeButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    placeholder: {
      width: 40,
    },
    scanArea: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    scanFrame: {
      width: 250,
      height: 250,
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
      borderTopWidth: 4,
      borderLeftWidth: 4,
      borderTopLeftRadius: 8,
    },
    topRight: {
      top: 0,
      right: 0,
      borderTopWidth: 4,
      borderRightWidth: 4,
      borderTopRightRadius: 8,
    },
    bottomLeft: {
      bottom: 0,
      left: 0,
      borderBottomWidth: 4,
      borderLeftWidth: 4,
      borderBottomLeftRadius: 8,
    },
    bottomRight: {
      bottom: 0,
      right: 0,
      borderBottomWidth: 4,
      borderRightWidth: 4,
      borderBottomRightRadius: 8,
    },
    instructions: {
      paddingHorizontal: 40,
      paddingBottom: 20,
      alignItems: 'center',
    },
    instructionText: {
      fontSize: 16,
      color: '#FFFFFF',
      textAlign: 'center',
      marginBottom: 8,
    },
    supportedFormats: {
      fontSize: 12,
      color: '#CCCCCC',
      textAlign: 'center',
    },
    bottomSection: {
      paddingHorizontal: 40,
      paddingBottom: 60,
      alignItems: 'center',
    },
    pasteButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255, 255, 255, 0.15)',
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: 'rgba(255, 255, 255, 0.3)',
      gap: 8,
    },
    pasteButtonDisabled: {
      backgroundColor: 'rgba(255, 255, 255, 0.05)',
      borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    pasteButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    pasteButtonTextDisabled: {
      color: theme.colors.textMuted,
    },
    processingContainer: {
      position: 'absolute',
      bottom: 100,
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    processingText: {
      fontSize: 14,
      color: theme.colors.primary,
      textAlign: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 16,
    },
    permissionContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme.colors.background,
      paddingHorizontal: 40,
    },
    permissionTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: 20,
      marginBottom: 12,
      textAlign: 'center',
    },
    permissionText: {
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 22,
      marginBottom: 30,
    },
    permissionButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: 32,
      paddingVertical: 12,
      borderRadius: 8,
      marginBottom: 16,
    },
    permissionButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    cancelButton: {
      paddingHorizontal: 32,
      paddingVertical: 12,
    },
    cancelButtonText: {
      fontSize: 16,
      color: theme.colors.primary,
    },
  });
