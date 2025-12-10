/**
 * Animated QR Scanner Component
 *
 * A QR scanner that can handle both static and animated (multi-frame) QR codes
 * using the BC-UR protocol with fountain codes.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { URDecoder } from '@ngraveio/bc-ur';
import { useTheme } from '@/contexts/ThemeContext';
import {
  AnimatedQRService,
  AnimatedQRDecodeState,
} from '@/services/remoteSigner/animatedQR';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SCAN_AREA_SIZE = SCREEN_WIDTH * 0.75;

interface AnimatedQRScannerProps {
  /** Called when a complete payload is decoded (static or animated) */
  onScan: (data: string) => void;
  /** Called when scanning fails */
  onError?: (error: string) => void;
  /** Called when a frame is received (for progress updates) */
  onProgress?: (state: AnimatedQRDecodeState) => void;
  /** Custom overlay content */
  overlayContent?: React.ReactNode;
  /** Whether to show progress bar for animated QR */
  showProgress?: boolean;
  /** Instructions text */
  instructionsText?: string;
}

/**
 * AnimatedQRScanner - Scans both static and animated QR codes
 *
 * Automatically detects UR-encoded frames and accumulates them until
 * the complete payload is decoded using fountain codes.
 */
export function AnimatedQRScanner({
  onScan,
  onError,
  onProgress,
  overlayContent,
  showProgress = true,
  instructionsText = 'Position the QR code within the frame',
}: AnimatedQRScannerProps) {
  const { theme } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();

  // Decoder state
  const decoderRef = useRef<URDecoder | null>(null);
  const [decodeState, setDecodeState] = useState<AnimatedQRDecodeState>({
    isComplete: false,
    isSuccess: false,
    progress: 0,
    receivedCount: 0,
    expectedCount: 0,
  });
  const [isAnimatedMode, setIsAnimatedMode] = useState(false);
  const [lastScannedFrame, setLastScannedFrame] = useState<string>('');

  // Prevent duplicate scans
  const lastScanTimeRef = useRef<number>(0);
  const hasCompletedRef = useRef<boolean>(false);

  // Reset decoder
  const resetDecoder = useCallback(() => {
    decoderRef.current = AnimatedQRService.createDecoder();
    setDecodeState({
      isComplete: false,
      isSuccess: false,
      progress: 0,
      receivedCount: 0,
      expectedCount: 0,
    });
    setIsAnimatedMode(false);
    setLastScannedFrame('');
    hasCompletedRef.current = false;
  }, []);

  // Initialize decoder on mount
  useEffect(() => {
    resetDecoder();
  }, [resetDecoder]);

  // Handle barcode scan
  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      // Prevent rapid duplicate scans
      const now = Date.now();
      if (now - lastScanTimeRef.current < 100) return;
      lastScanTimeRef.current = now;

      // Prevent processing after completion
      if (hasCompletedRef.current) return;

      // Skip if same frame (for animated QR)
      if (data === lastScannedFrame) return;
      setLastScannedFrame(data);

      // Check if this is a UR-encoded frame
      if (AnimatedQRService.isURFrame(data)) {
        // Handle UR frame (potentially animated)
        const isMultipart = AnimatedQRService.isMultipartURFrame(data);

        if (isMultipart) {
          // Multi-part animated QR - use fountain code decoder
          if (!isAnimatedMode) {
            setIsAnimatedMode(true);
          }

          // Process the frame
          if (!decoderRef.current) {
            decoderRef.current = AnimatedQRService.createDecoder();
          }

          const state = AnimatedQRService.processFrame(decoderRef.current, data);

          // Log progress concisely
          const seqInfo = AnimatedQRService.getSequenceInfo(data);
          if (seqInfo) {
            console.log(`[AnimatedQRScanner] Frame ${seqInfo.current}/${seqInfo.total} → ${state.progress}% (${state.receivedCount}/${state.expectedCount} received)${state.error ? ` error: ${state.error}` : ''}`);
          }

          setDecodeState(state);
          onProgress?.(state);

          if (state.isComplete) {
            hasCompletedRef.current = true;
            if (state.isSuccess && state.data) {
              onScan(state.data);
            } else if (state.error) {
              onError?.(state.error);
            }
          }
        } else {
          // Single-part UR - decode directly
          try {
            const decoded = AnimatedQRService.decodeSinglePartUR(data);
            hasCompletedRef.current = true;
            onScan(decoded);
          } catch (error) {
            console.error('[AnimatedQRScanner] Single-part UR decode error:', error);
            onError?.(error instanceof Error ? error.message : 'Failed to decode QR');
          }
        }
      } else {
        // Regular QR code (not UR-encoded)
        // Pass through directly
        hasCompletedRef.current = true;
        onScan(data);
      }
    },
    [lastScannedFrame, isAnimatedMode, onScan, onError, onProgress]
  );

  // Handle permission
  if (!permission) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <Text style={[styles.statusText, { color: theme.colors.text }]}>
          Requesting camera permission...
        </Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.permissionContainer}>
          <Ionicons
            name="camera-outline"
            size={48}
            color={theme.colors.textSecondary}
          />
          <Text style={[styles.permissionTitle, { color: theme.colors.text }]}>
            Camera Permission Required
          </Text>
          <Text style={[styles.permissionText, { color: theme.colors.textSecondary }]}>
            We need camera access to scan QR codes
          </Text>
          <TouchableOpacity
            style={[styles.permissionButton, { backgroundColor: theme.colors.primary }]}
            onPress={requestPermission}
          >
            <Text style={[styles.permissionButtonText, { color: theme.colors.buttonText }]}>
              Grant Permission
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        barcodeScannerSettings={{
          barcodeTypes: ['qr'],
        }}
        onBarcodeScanned={handleBarCodeScanned}
      />

      {/* Overlay */}
      <View style={styles.overlay}>
        {/* Top section */}
        <View style={[styles.overlaySection, styles.overlayTop]}>
          {overlayContent}
        </View>

        {/* Middle section with scan frame */}
        <View style={styles.middleSection}>
          <View style={styles.overlaySection} />
          <View style={styles.scanArea}>
            {/* Corner markers */}
            <View style={[styles.corner, styles.topLeft, { borderColor: theme.colors.primary }]} />
            <View style={[styles.corner, styles.topRight, { borderColor: theme.colors.primary }]} />
            <View style={[styles.corner, styles.bottomLeft, { borderColor: theme.colors.primary }]} />
            <View style={[styles.corner, styles.bottomRight, { borderColor: theme.colors.primary }]} />
          </View>
          <View style={styles.overlaySection} />
        </View>

        {/* Bottom section */}
        <View style={[styles.overlaySection, styles.overlayBottom]}>
          {/* Instructions */}
          <Text style={[styles.instructions, { color: 'white' }]}>
            {instructionsText}
          </Text>

          {/* Animated QR indicator */}
          {isAnimatedMode && (
            <View style={[styles.animatedIndicator, { backgroundColor: theme.colors.primary }]}>
              <Ionicons name="play-circle" size={16} color={theme.colors.buttonText} />
              <Text style={[styles.animatedText, { color: theme.colors.buttonText }]}>
                Receiving animated QR...
              </Text>
            </View>
          )}

          {/* Progress bar for animated QR */}
          {isAnimatedMode && showProgress && (
            <View style={styles.progressContainer}>
              <View style={[styles.progressBar, { backgroundColor: 'rgba(255,255,255,0.3)' }]}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      backgroundColor: theme.colors.primary,
                      width: `${decodeState.progress}%`,
                    },
                  ]}
                />
              </View>
              <Text style={styles.progressText}>
                {Math.round(decodeState.progress)}% • {decodeState.receivedCount} frames
              </Text>
            </View>
          )}

          {/* Reset button for animated QR */}
          {isAnimatedMode && (
            <TouchableOpacity
              style={[styles.resetButton, { borderColor: 'rgba(255,255,255,0.5)' }]}
              onPress={resetDecoder}
            >
              <Ionicons name="refresh" size={16} color="white" />
              <Text style={styles.resetButtonText}>Reset Scanner</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  overlaySection: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  overlayTop: {
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 20,
  },
  overlayBottom: {
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingTop: 20,
    gap: 12,
  },
  middleSection: {
    flexDirection: 'row',
    height: SCAN_AREA_SIZE,
  },
  scanArea: {
    width: SCAN_AREA_SIZE,
    height: SCAN_AREA_SIZE,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderWidth: 3,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
  },
  topRight: {
    top: 0,
    right: 0,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderRightWidth: 0,
    borderTopWidth: 0,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderLeftWidth: 0,
    borderTopWidth: 0,
  },
  instructions: {
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  animatedIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  animatedText: {
    fontSize: 13,
    fontWeight: '600',
  },
  progressContainer: {
    width: SCAN_AREA_SIZE,
    alignItems: 'center',
    gap: 4,
  },
  progressBar: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  progressText: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.8)',
  },
  resetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  resetButtonText: {
    fontSize: 12,
    color: 'white',
  },
  statusText: {
    fontSize: 14,
    textAlign: 'center',
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    gap: 12,
  },
  permissionTitle: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  permissionText: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 8,
  },
  permissionButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  permissionButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});

export default AnimatedQRScanner;
