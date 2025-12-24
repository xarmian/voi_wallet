/**
 * Animated QR Code Component
 *
 * Displays either a static QR code or an animated sequence of QR codes
 * for large payloads using the BC-UR protocol.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { AnimatedQRService, AnimatedQREncodeResult } from '@/services/remoteSigner/animatedQR';
import { REMOTE_SIGNER_CONSTANTS } from '@/types/remoteSigner';

interface AnimatedQRCodeProps {
  /** The data to encode in the QR code(s) */
  data: string;
  /** Size of the QR code in pixels */
  size?: number;
  /** Whether to show frame counter for animated QR */
  showFrameCounter?: boolean;
  /** Whether to show play/pause controls */
  showControls?: boolean;
  /** Callback when encoding is complete */
  onEncodingComplete?: (result: AnimatedQREncodeResult) => void;
  /** Custom background color for QR */
  backgroundColor?: string;
  /** Custom foreground color for QR */
  color?: string;
}

/**
 * AnimatedQRCode - Displays static or animated QR codes
 *
 * Automatically determines if animation is needed based on data size.
 * Uses fountain codes for reliable transmission over lossy channels.
 */
export function AnimatedQRCode({
  data,
  size = 220,
  showFrameCounter = true,
  showControls = true,
  onEncodingComplete,
  backgroundColor = 'white',
  color = '#000000',
}: AnimatedQRCodeProps) {
  const { theme } = useTheme();

  // Encoding state
  const [encodeResult, setEncodeResult] = useState<AnimatedQREncodeResult | null>(null);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Animation timer ref
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Encode the data when it changes
  useEffect(() => {
    try {
      const result = AnimatedQRService.encode(data);
      setEncodeResult(result);
      setCurrentFrameIndex(0);
      setError(null);
      onEncodingComplete?.(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to encode data';
      setError(errorMessage);
      console.error('AnimatedQRCode encoding error:', err);
    }
  }, [data, onEncodingComplete]);

  // Animation loop for animated QR
  useEffect(() => {
    if (!encodeResult?.isAnimated || !isPlaying) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const intervalMs = 1000 / encodeResult.fps;
    timerRef.current = setInterval(() => {
      setCurrentFrameIndex((prev) => (prev + 1) % encodeResult.frameCount);
    }, intervalMs);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [encodeResult, isPlaying]);

  const handlePlayPause = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  const handlePrevFrame = useCallback(() => {
    if (!encodeResult) return;
    setCurrentFrameIndex((prev) =>
      prev === 0 ? encodeResult.frameCount - 1 : prev - 1
    );
  }, [encodeResult]);

  const handleNextFrame = useCallback(() => {
    if (!encodeResult) return;
    setCurrentFrameIndex((prev) => (prev + 1) % encodeResult.frameCount);
  }, [encodeResult]);

  // Error state
  if (error) {
    return (
      <View style={[styles.container, { width: size, height: size }]}>
        <View style={[styles.errorContainer, { backgroundColor: theme.colors.card }]}>
          <Ionicons name="warning-outline" size={32} color={theme.colors.error} />
          <Text style={[styles.errorText, { color: theme.colors.error }]}>
            {error}
          </Text>
        </View>
      </View>
    );
  }

  // Loading state
  if (!encodeResult) {
    return (
      <View style={[styles.container, { width: size, height: size }]}>
        <View style={[styles.loadingContainer, { backgroundColor }]}>
          <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
            Encoding...
          </Text>
        </View>
      </View>
    );
  }

  const currentFrame = encodeResult.frames[currentFrameIndex];

  return (
    <View style={styles.wrapper}>
      {/* QR Code */}
      <View style={[styles.qrContainer, { backgroundColor, borderRadius: theme.borderRadius.xl }]}>
        <QRCode
          value={currentFrame}
          size={size}
          backgroundColor={backgroundColor}
          color={color}
        />
      </View>

      {/* Frame counter for animated QR */}
      {encodeResult.isAnimated && showFrameCounter && (
        <View style={[styles.frameCounter, { backgroundColor: theme.colors.card }]}>
          <Text style={[styles.frameCounterText, { color: theme.colors.text }]}>
            Frame {currentFrameIndex + 1} / {encodeResult.frameCount}
          </Text>
        </View>
      )}

      {/* Animated indicator */}
      {encodeResult.isAnimated && (
        <View style={[styles.animatedBadge, { backgroundColor: theme.colors.primary }]}>
          <Ionicons name="play-circle" size={14} color={theme.colors.buttonText} />
          <Text style={[styles.animatedBadgeText, { color: theme.colors.buttonText }]}>
            Animated QR
          </Text>
        </View>
      )}

      {/* Controls for animated QR */}
      {encodeResult.isAnimated && showControls && (
        <View style={styles.controls}>
          <TouchableOpacity
            style={[styles.controlButton, { backgroundColor: theme.colors.card }]}
            onPress={handlePrevFrame}
          >
            <Ionicons name="play-back" size={20} color={theme.colors.text} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.controlButton, styles.playButton, { backgroundColor: theme.colors.primary }]}
            onPress={handlePlayPause}
          >
            <Ionicons
              name={isPlaying ? 'pause' : 'play'}
              size={24}
              color={theme.colors.buttonText}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.controlButton, { backgroundColor: theme.colors.card }]}
            onPress={handleNextFrame}
          >
            <Ionicons name="play-forward" size={20} color={theme.colors.text} />
          </TouchableOpacity>
        </View>
      )}

      {/* Size info */}
      <Text style={[styles.sizeInfo, { color: theme.colors.textMuted }]}>
        {encodeResult.originalSize} bytes
        {encodeResult.isAnimated && ` • ${encodeResult.fps} fps`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  qrContainer: {
    padding: 16,
    marginBottom: 8,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 16,
  },
  loadingText: {
    fontSize: 14,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  errorText: {
    fontSize: 12,
    textAlign: 'center',
  },
  frameCounter: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 8,
  },
  frameCounterText: {
    fontSize: 12,
    fontWeight: '500',
  },
  animatedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
  },
  animatedBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  controlButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  sizeInfo: {
    fontSize: 11,
  },
});

export default AnimatedQRCode;
