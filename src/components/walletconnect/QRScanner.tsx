import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { DeepLinkService } from '@/services/deeplink';
import { isWalletConnectUri, isVoiUri } from '@/services/walletconnect/utils';
import {
  isArc0090Uri,
  getArc0090UriType,
  isLegacyVoiUri,
} from '@/utils/arc0090Uri';
import {
  parseArc0300AccountImportUri,
  Arc0300AccountImportResult,
} from '@/utils/arc0300';
import algosdk from 'algosdk';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { getFromClipboard } from '@/utils/clipboard';
import jsQR from 'jsqr';
import { CameraView, Camera } from 'expo-camera';

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
        const confirmButton = buttons.find(b => b.style !== 'cancel') || buttons[0];
        confirmButton?.onPress?.();
      } else {
        const cancelButton = buttons.find(b => b.style === 'cancel');
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

interface Props {
  onClose: () => void;
  onSuccess?: (uri: string) => void;
}

const { width, height } = Dimensions.get('window');

export default function QRScanner({ onClose, onSuccess }: Props) {
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  useEffect(() => {
    // Only request camera permission on native platforms
    if (Platform.OS !== 'web') {
      requestCameraPermission();
    } else {
      // On web, we don't need camera permission - set to true to show web UI
      setHasPermission(true);
    }
  }, []);

  // Scan QR code from image data using jsQR
  const scanQRFromImageData = useCallback((imageData: ImageData): string | null => {
    try {
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      return code?.data || null;
    } catch (e) {
      console.error('jsQR error:', e);
      return null;
    }
  }, []);

  // Web: Handle screen capture
  const handleScreenCapture = async () => {
    if (Platform.OS !== 'web' || isProcessing || isCapturing) return;

    setIsCapturing(true);

    try {
      // Request screen capture
      const stream = await (navigator.mediaDevices as any).getDisplayMedia({
        video: { cursor: 'never' },
        audio: false,
      });

      // Create video element to capture frame
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();

      // Wait a moment for video to be ready
      await new Promise(resolve => setTimeout(resolve, 100));

      // Create canvas and draw video frame
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        throw new Error('Could not get canvas context');
      }

      ctx.drawImage(video, 0, 0);

      // Stop the stream
      stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());

      // Get image data and scan for QR code
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const qrData = scanQRFromImageData(imageData);

      if (qrData) {
        await handleBarCodeScanned({ type: 'qr', data: qrData });
      } else {
        showAlert(
          'No QR Code Found',
          'Could not find a QR code in the captured screen. Please make sure the QR code is visible and try again.',
          [{ text: 'OK' }]
        );
      }
    } catch (error: any) {
      // User cancelled or error occurred
      if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
        console.error('Screen capture error:', error);
        showAlert(
          'Capture Error',
          'Failed to capture screen. Please try again.',
          [{ text: 'OK' }]
        );
      }
    } finally {
      setIsCapturing(false);
    }
  };

  // Web: Handle file upload
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || isProcessing) return;

    setIsProcessing(true);

    try {
      const img = new Image();
      const reader = new FileReader();

      const qrData = await new Promise<string | null>((resolve, reject) => {
        reader.onload = (e) => {
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');

            if (!ctx) {
              reject(new Error('Could not get canvas context'));
              return;
            }

            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = scanQRFromImageData(imageData);
            resolve(data);
          };
          img.onerror = () => reject(new Error('Failed to load image'));
          img.src = e.target?.result as string;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }

      if (qrData) {
        await handleBarCodeScanned({ type: 'qr', data: qrData });
      } else {
        showAlert(
          'No QR Code Found',
          'Could not find a QR code in the uploaded image. Please try a different image.',
          [{ text: 'OK' }]
        );
        setIsProcessing(false);
      }
    } catch (error) {
      console.error('File upload error:', error);
      showAlert(
        'Upload Error',
        'Failed to process the uploaded image. Please try again.',
        [{ text: 'OK' }]
      );
      setIsProcessing(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Web: Trigger file input click
  const triggerFileUpload = () => {
    if (fileInputRef.current && !isProcessing) {
      fileInputRef.current.click();
    }
  };

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
      showAlert(
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
          { text: 'Cancel', style: 'cancel', onPress: onClose },
        ]
      );
      return;
    }

    try {
      const arcImportResult = parseArc0300AccountImportUri(rawValue);
      if (arcImportResult) {
        showAlert(
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
      } else if (isArc0090Uri(rawValue)) {
        // Handle ARC-0090 URIs (algorand://, voi://, perawallet://)
        // This includes payment, keyreg, appl, and query URIs
        await handleArc0090Uri(rawValue);
      } else if (isVoiUri(rawValue) && isLegacyVoiUri(rawValue)) {
        // Handle legacy voi://action?params format
        await handleLegacyVoiUri(rawValue);
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

      showAlert(
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
          { text: 'Cancel', style: 'cancel', onPress: onClose },
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

  /**
   * Handle ARC-0090 URIs (algorand://, voi://, perawallet://)
   * Routes to appropriate screens via DeepLinkService
   */
  const handleArc0090Uri = async (uri: string) => {
    try {
      const uriType = getArc0090UriType(uri);
      console.log('[QRScanner] handleArc0090Uri - uriType:', uriType, 'uri:', uri);

      const deepLinkService = DeepLinkService.getInstance();
      const handled = await deepLinkService.testDeepLink(uri);
      console.log('[QRScanner] handleArc0090Uri - handled:', handled);

      if (handled) {
        // NOTE: Don't call onSuccess() or onClose() here - the deep link handler
        // has already navigated to a new screen using StackActions.replace.
        // Calling onSuccess() would trigger handleSuccess in QRScannerScreen
        // which has a setTimeout that calls goBack(), dismissing the new screen.
        console.log('[QRScanner] handleArc0090Uri - navigation handled by deep link service');
      } else {
        console.log('[QRScanner] handleArc0090Uri - not handled, resetting scanner');
        // Reset scanner state so user can try again
        setScanned(false);
        setIsProcessing(false);
      }
    } catch (error) {
      console.error('[QRScanner] handleArc0090Uri - error:', error);
      throw new Error(
        `URI processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  };

  /**
   * Handle legacy voi://action?params format
   */
  const handleLegacyVoiUri = async (uri: string) => {
    try {
      const deepLinkService = DeepLinkService.getInstance();
      const handled = await deepLinkService.testDeepLink(uri);

      if (handled) {
        onSuccess?.(uri);
        onClose();
      } else {
        throw new Error('Failed to process Voi URI');
      }
    } catch (error) {
      throw new Error(
        `Voi URI processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`
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
      showAlert(
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
          { text: 'Cancel', style: 'cancel', onPress: onClose },
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
        showAlert(
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

      showAlert(
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
          { text: 'Cancel', style: 'cancel', onPress: onClose },
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

  // Web: Render web-specific scanner UI
  const renderWebScanner = () => (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Hidden file input for image upload */}
      {Platform.OS === 'web' && (
        <input
          ref={fileInputRef as any}
          type="file"
          accept="image/*"
          onChange={handleFileUpload as any}
          style={{ display: 'none' }}
        />
      )}

      <View style={styles.webHeader}>
        <TouchableOpacity style={styles.webCloseButton} onPress={onClose}>
          <Ionicons name="close" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.webTitle, { color: theme.colors.text }]}>Scan QR Code</Text>
        <View style={styles.placeholder} />
      </View>

      <View style={styles.webContent}>
        <View style={[styles.webIconContainer, { backgroundColor: theme.colors.surface }]}>
          <Ionicons name="qr-code" size={80} color={theme.colors.primary} />
        </View>

        <Text style={[styles.webDescription, { color: theme.colors.textSecondary }]}>
          Scan a QR code from your screen, upload an image, or paste a URI from clipboard
        </Text>

        {/* Screen Capture Button */}
        <TouchableOpacity
          style={[
            styles.webButton,
            { backgroundColor: theme.colors.primary },
            (isProcessing || isCapturing) && styles.webButtonDisabled,
          ]}
          onPress={handleScreenCapture}
          disabled={isProcessing || isCapturing}
        >
          {isCapturing ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Ionicons name="scan" size={24} color="#FFFFFF" />
          )}
          <Text style={styles.webButtonText}>
            {isCapturing ? 'Capturing...' : 'Scan Screen for QR Code'}
          </Text>
        </TouchableOpacity>

        {/* File Upload Button */}
        <TouchableOpacity
          style={[
            styles.webButton,
            styles.webButtonSecondary,
            { borderColor: theme.colors.primary },
            isProcessing && styles.webButtonDisabled,
          ]}
          onPress={triggerFileUpload}
          disabled={isProcessing}
        >
          <Ionicons name="image" size={24} color={theme.colors.primary} />
          <Text style={[styles.webButtonSecondaryText, { color: theme.colors.primary }]}>
            Upload QR Code Image
          </Text>
        </TouchableOpacity>

        {/* Paste from Clipboard Button */}
        <TouchableOpacity
          style={[
            styles.webButton,
            styles.webButtonSecondary,
            { borderColor: theme.colors.primary },
            isProcessing && styles.webButtonDisabled,
          ]}
          onPress={handlePasteUri}
          disabled={isProcessing}
        >
          <Ionicons name="clipboard" size={24} color={theme.colors.primary} />
          <Text style={[styles.webButtonSecondaryText, { color: theme.colors.primary }]}>
            Paste URI from Clipboard
          </Text>
        </TouchableOpacity>

        {isProcessing && (
          <View style={styles.webProcessingContainer}>
            <ActivityIndicator color={theme.colors.primary} size="large" />
            <Text style={[styles.webProcessingText, { color: theme.colors.textSecondary }]}>
              Processing...
            </Text>
          </View>
        )}

        <Text style={[styles.webSupportedFormats, { color: theme.colors.textMuted }]}>
          Supports WalletConnect, Voi/Algorand payment requests, and addresses
        </Text>
      </View>
    </View>
  );

  // Web platform - show web scanner UI
  if (Platform.OS === 'web') {
    return renderWebScanner();
  }

  // Native: Loading state
  if (hasPermission === null) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>
          Requesting camera permission...
        </Text>
      </View>
    );
  }

  // Native: No permission state
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

  // Native: Camera scanner
  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        onBarcodeScanned={
          scanned || isProcessing ? undefined : handleBarCodeScanned
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
    // Web-specific styles
    webHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    webCloseButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
    },
    webTitle: {
      fontSize: 18,
      fontWeight: '600',
    },
    webContent: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 24,
      paddingBottom: 40,
    },
    webIconContainer: {
      width: 140,
      height: 140,
      borderRadius: 70,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 24,
    },
    webDescription: {
      fontSize: 16,
      textAlign: 'center',
      marginBottom: 32,
      lineHeight: 24,
      paddingHorizontal: 16,
    },
    webButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 16,
      paddingHorizontal: 24,
      borderRadius: 12,
      marginBottom: 12,
      width: '100%',
      maxWidth: 320,
      gap: 12,
    },
    webButtonSecondary: {
      backgroundColor: 'transparent',
      borderWidth: 2,
    },
    webButtonDisabled: {
      opacity: 0.5,
    },
    webButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    webButtonSecondaryText: {
      fontSize: 16,
      fontWeight: '600',
    },
    webProcessingContainer: {
      alignItems: 'center',
      marginTop: 24,
    },
    webProcessingText: {
      fontSize: 14,
      marginTop: 12,
    },
    webSupportedFormats: {
      fontSize: 12,
      textAlign: 'center',
      marginTop: 24,
    },
  });
