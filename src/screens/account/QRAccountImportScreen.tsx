import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { RootStackParamList } from '@/navigation/AppNavigator';
import {
  AccountQRParser,
  ParsedQRResult,
  clearAllAccountSecrets,
} from '@/utils/accountQRParser';
import { useAccounts } from '@/store/walletStore';
import { useTheme } from '@/contexts/ThemeContext';

type QRAccountImportScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'QRAccountImport'
>;
type QRAccountImportScreenRouteProp = RouteProp<
  RootStackParamList,
  'QRAccountImport'
>;

interface Props {
  navigation: QRAccountImportScreenNavigationProp;
  route: QRAccountImportScreenRouteProp;
}

export default function QRAccountImportScreen({ navigation }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const { theme } = useTheme();

  const existingAccounts = useAccounts();

  useEffect(() => {
    if (!permission) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  useEffect(() => {
    return () => {
      clearAllAccountSecrets();
    };
  }, []);

  const handleClose = () => {
    navigation.goBack();
  };

  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (scanned || processing) return;

    setScanned(true);
    setProcessing(true);

    try {
      clearAllAccountSecrets();

      // Parse the QR content
      const result: ParsedQRResult = await AccountQRParser.parseQRContent(
        data,
        existingAccounts
      );

      if (!result.isAccountData) {
        // Check if it's a different type of QR that should be handled elsewhere
        if (AccountQRParser.isPaymentQR(data)) {
          Alert.alert(
            'Payment QR Code',
            'This appears to be a payment QR code. Use the main QR scanner for payments.',
            [{ text: 'OK', onPress: () => navigation.goBack() }]
          );
          return;
        }

        if (AccountQRParser.isWalletConnectQR(data)) {
          Alert.alert(
            'WalletConnect QR Code',
            'This appears to be a WalletConnect QR code. Use the main QR scanner for dApp connections.',
            [{ text: 'OK', onPress: () => navigation.goBack() }]
          );
          return;
        }

        Alert.alert(
          'Invalid QR Code',
          result.errorMessage ||
            'This QR code does not contain valid account data.',
          [
            {
              text: 'Try Again',
              onPress: () => {
                setScanned(false);
                setProcessing(false);
              },
            },
            { text: 'Cancel', onPress: () => navigation.goBack() },
          ]
        );
        return;
      }

      if (result.accounts.length === 0) {
        Alert.alert(
          'No Valid Accounts',
          'No valid accounts were found in the QR code.',
          [
            {
              text: 'Try Again',
              onPress: () => {
                setScanned(false);
                setProcessing(false);
              },
            },
            { text: 'Cancel', onPress: () => navigation.goBack() },
          ]
        );
        return;
      }

      // Navigate to preview screen with the parsed accounts
      navigation.navigate('AccountImportPreview', {
        accounts: result.accounts,
        source: 'qr',
      });
    } catch (error) {
      console.error('QR Account Import error:', error);
      Alert.alert(
        'Scan Error',
        'Failed to process the QR code. Please try again.',
        [
          {
            text: 'Try Again',
            onPress: () => {
              setScanned(false);
              setProcessing(false);
            },
          },
          { text: 'Cancel', onPress: () => navigation.goBack() },
        ]
      );
    } finally {
      setProcessing(false);
    }
  };

  const toggleCameraFacing = () => {
    setFacing((current) => (current === 'back' ? 'front' : 'back'));
  };

  if (!permission) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        edges={['top', 'bottom']}
      >
        <View
          style={[
            styles.permissionContainer,
            { backgroundColor: theme.colors.background },
          ]}
        >
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text
            style={[
              styles.permissionText,
              { color: theme.colors.textSecondary },
            ]}
          >
            Requesting camera permission...
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        edges={['top', 'bottom']}
      >
        <View
          style={[
            styles.permissionContainer,
            { backgroundColor: theme.colors.background },
          ]}
        >
          <Ionicons
            name="camera-outline"
            size={64}
            color={theme.colors.textSecondary}
          />
          <Text style={[styles.permissionTitle, { color: theme.colors.text }]}>
            Camera Permission Required
          </Text>
          <Text
            style={[
              styles.permissionMessage,
              { color: theme.colors.textSecondary },
            ]}
          >
            We need access to your camera to scan QR codes containing account
            information.
          </Text>
          <TouchableOpacity
            style={[
              styles.permissionButton,
              { backgroundColor: theme.colors.primary },
            ]}
            onPress={requestPermission}
          >
            <Text
              style={[
                styles.permissionButtonText,
                { color: theme.colors.background },
              ]}
            >
              Grant Permission
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelButton} onPress={handleClose}>
            <Text
              style={[
                styles.cancelButtonText,
                { color: theme.colors.textSecondary },
              ]}
            >
              Cancel
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: '#000000' }]}
      edges={['top', 'bottom']}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.headerButton} onPress={handleClose}>
          <Ionicons name="close" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.background }]}>
          Import Accounts
        </Text>
        <TouchableOpacity
          style={styles.headerButton}
          onPress={toggleCameraFacing}
        >
          <Ionicons name="camera-reverse" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {/* Camera View */}
      <View style={styles.cameraContainer}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing={facing}
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
          barcodeScannerSettings={{
            barcodeTypes: ['qr'],
          }}
        />
        {/* Overlay - rendered outside CameraView for iOS barcode detection compatibility */}
        <View style={[StyleSheet.absoluteFillObject, styles.overlay]}>
          {/* Top overlay */}
          <View style={styles.overlayTop} />

          {/* Middle section with scanning area */}
          <View style={styles.overlayMiddle}>
            <View style={styles.overlaySide} />
            <View style={styles.scanningArea}>
              <View style={[styles.corner, styles.cornerTopLeft]} />
              <View style={[styles.corner, styles.cornerTopRight]} />
              <View style={[styles.corner, styles.cornerBottomLeft]} />
              <View style={[styles.corner, styles.cornerBottomRight]} />

              {processing && (
                <View style={styles.processingOverlay}>
                  <ActivityIndicator
                    size="large"
                    color={theme.colors.background}
                  />
                  <Text
                    style={[
                      styles.processingText,
                      { color: theme.colors.background },
                    ]}
                  >
                    Processing...
                  </Text>
                </View>
              )}
            </View>
            <View style={styles.overlaySide} />
          </View>

          {/* Bottom overlay */}
          <View style={styles.overlayBottom} />
        </View>
      </View>

      {/* Instructions */}
      <View
        style={[
          styles.instructionsContainer,
          { backgroundColor: theme.colors.card },
        ]}
      >
        <Ionicons
          name="qr-code-outline"
          size={32}
          color={theme.colors.primary}
        />
        <Text style={[styles.instructionsTitle, { color: theme.colors.text }]}>
          Scan Account QR Code
        </Text>
        <Text
          style={[
            styles.instructionsText,
            { color: theme.colors.textSecondary },
          ]}
        >
          Position the QR code within the frame. Supported formats:
        </Text>
        <View style={styles.formatList}>
          <Text
            style={[styles.formatItem, { color: theme.colors.textSecondary }]}
          >
            • ARC-0300 account import URIs
          </Text>
          <Text
            style={[styles.formatItem, { color: theme.colors.textSecondary }]}
          >
            • 25-word mnemonic phrase
          </Text>
          <Text
            style={[styles.formatItem, { color: theme.colors.textSecondary }]}
          >
            • Private key (hex)
          </Text>
          <Text
            style={[styles.formatItem, { color: theme.colors.textSecondary }]}
          >
            • Address list (watch only)
          </Text>
          <Text
            style={[styles.formatItem, { color: theme.colors.textSecondary }]}
          >
            • Multiple accounts (JSON)
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  permissionText: {
    fontSize: 16,
    marginTop: 16,
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
    textAlign: 'center',
  },
  permissionMessage: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  permissionButton: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  permissionButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    paddingHorizontal: 32,
    paddingVertical: 12,
  },
  cancelButtonText: {
    fontSize: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  cameraContainer: {
    flex: 1,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    flex: 1,
  },
  overlayTop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  overlayMiddle: {
    flexDirection: 'row',
  },
  overlaySide: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  scanningArea: {
    width: 250,
    height: 250,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  corner: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderColor: '#FFFFFF',
    borderWidth: 3,
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderRightWidth: 0,
    borderTopWidth: 0,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderLeftWidth: 0,
    borderTopWidth: 0,
  },
  processingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingText: {
    fontSize: 16,
    marginTop: 12,
    fontWeight: '600',
  },
  overlayBottom: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  instructionsContainer: {
    paddingHorizontal: 20,
    paddingVertical: 24,
    alignItems: 'center',
  },
  instructionsTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 8,
  },
  instructionsText: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  formatList: {
    alignSelf: 'stretch',
  },
  formatItem: {
    fontSize: 13,
    marginBottom: 4,
    textAlign: 'center',
  },
});
