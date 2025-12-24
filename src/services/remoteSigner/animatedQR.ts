/**
 * Animated QR Code Service
 *
 * Handles encoding and decoding of large payloads using the BC-UR protocol
 * (Blockchain Commons Uniform Resources) with fountain codes for reliable
 * transmission via animated QR codes.
 *
 * Based on: https://github.com/ngraveio/bc-ur
 */

import { UR, UREncoder, URDecoder } from '@ngraveio/bc-ur';
import { REMOTE_SIGNER_CONSTANTS } from '@/types/remoteSigner';

/**
 * Configuration for animated QR encoding
 */
export interface AnimatedQRConfig {
  /** Maximum bytes per QR frame (default: 800) */
  maxFragmentLength?: number;
  /** Frames per second for animation (default: 4) */
  fps?: number;
  /** Minimum number of frames to generate (default: calculated from data size) */
  minFragments?: number;
}

/**
 * Result of encoding data for animated QR
 */
export interface AnimatedQREncodeResult {
  /** Whether the data requires animated QR (multiple frames) */
  isAnimated: boolean;
  /** Total number of frames */
  frameCount: number;
  /** Array of UR-encoded strings, one per frame */
  frames: string[];
  /** Recommended FPS for display */
  fps: number;
  /** Original data size in bytes */
  originalSize: number;
}

/**
 * State of an ongoing animated QR decode operation
 */
export interface AnimatedQRDecodeState {
  /** Whether decoding is complete */
  isComplete: boolean;
  /** Whether decoding succeeded (only valid if isComplete) */
  isSuccess: boolean;
  /** Progress percentage (0-100) */
  progress: number;
  /** Estimated frames received */
  receivedCount: number;
  /** Estimated total frames needed */
  expectedCount: number;
  /** Decoded data (only available if isSuccess) */
  data?: string;
  /** Error message if decoding failed */
  error?: string;
}

/**
 * UR type identifier for our remote signer payloads
 */
const UR_TYPE = 'bytes';

/**
 * Animated QR Code Service
 *
 * Provides encoding and decoding of large payloads using fountain codes
 * for reliable transmission over animated QR codes.
 */
export class AnimatedQRService {
  /**
   * Encode a payload for animated QR display
   *
   * @param data - The string data to encode (typically JSON)
   * @param config - Optional configuration
   * @returns Encoding result with frames
   */
  static encode(data: string, config?: AnimatedQRConfig): AnimatedQREncodeResult {
    const maxFragmentLength =
      config?.maxFragmentLength ?? REMOTE_SIGNER_CONSTANTS.ANIMATED_QR_FRAME_BYTES;
    const fps = config?.fps ?? REMOTE_SIGNER_CONSTANTS.ANIMATED_QR_FPS;

    // Convert string to Uint8Array
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    const originalSize = dataBytes.length;

    // Check if we need animated QR
    if (originalSize <= REMOTE_SIGNER_CONSTANTS.SINGLE_QR_MAX_BYTES) {
      // Single QR is sufficient - return as single UR frame
      // Use UR.fromBuffer which properly CBOR-encodes the data
      const ur = UR.fromBuffer(Buffer.from(dataBytes));
      const singleEncoder = new UREncoder(ur, maxFragmentLength, 0, 1);
      return {
        isAnimated: false,
        frameCount: 1,
        frames: [singleEncoder.nextPart().toUpperCase()],
        fps,
        originalSize,
      };
    }

    // Create UR from data - use fromBuffer to properly CBOR-encode
    const ur = UR.fromBuffer(Buffer.from(dataBytes));

    // Create fountain encoder
    // UREncoder(ur, maxFragmentLength, firstSeqNum, minFragmentLength)
    // minFragmentLength must be > 0, use 10 as a reasonable minimum
    const urEncoder = new UREncoder(ur, maxFragmentLength, 0, 10);

    // Calculate how many frames we need
    // Fountain codes are rateless, but we want enough redundancy
    const baseFragments = Math.ceil(originalSize / maxFragmentLength);
    // Add 50% redundancy for reliability
    const targetFrames = Math.max(
      config?.minFragments ?? 0,
      Math.ceil(baseFragments * 1.5)
    );

    // Generate frames
    const frames: string[] = [];
    for (let i = 0; i < targetFrames; i++) {
      frames.push(urEncoder.nextPart().toUpperCase());
    }

    return {
      isAnimated: true,
      frameCount: frames.length,
      frames,
      fps,
      originalSize,
    };
  }

  /**
   * Create a new decoder instance for receiving animated QR frames
   *
   * @returns A decoder instance
   */
  static createDecoder(): URDecoder {
    return new URDecoder();
  }

  /**
   * Process a scanned QR frame and return current decode state
   *
   * @param decoder - The decoder instance
   * @param frame - The scanned QR code content
   * @returns Current decode state
   */
  static processFrame(decoder: URDecoder, frame: string): AnimatedQRDecodeState {
    try {
      // Receive the part (URDecoder handles duplicate detection)
      decoder.receivePart(frame.toLowerCase());

      // Check completion status
      const isComplete = decoder.isComplete();
      const isSuccess = isComplete && decoder.isSuccess();

      // Get progress info
      // getProgress() returns a fraction (0-1), convert to percentage
      const progressFraction = decoder.getProgress();
      const progress = Math.round(progressFraction * 100);
      const expectedCount = decoder.expectedPartCount() || 0;
      const receivedCount = Math.round(progressFraction * expectedCount);

      if (isComplete && isSuccess) {
        // Decode the result
        const ur = decoder.resultUR();
        const decodedBytes = ur.decodeCBOR();

        // Convert back to string
        const textDecoder = new TextDecoder();
        const data = textDecoder.decode(
          decodedBytes instanceof Uint8Array
            ? decodedBytes
            : new Uint8Array(decodedBytes)
        );

        return {
          isComplete: true,
          isSuccess: true,
          progress: 100,
          receivedCount: expectedCount,
          expectedCount,
          data,
        };
      }

      if (isComplete && !isSuccess) {
        return {
          isComplete: true,
          isSuccess: false,
          progress: progress,
          receivedCount,
          expectedCount,
          error: decoder.resultError() || 'Decoding failed',
        };
      }

      // Still in progress
      return {
        isComplete: false,
        isSuccess: false,
        progress,
        receivedCount,
        expectedCount,
      };
    } catch (error) {
      // Handle invalid frame format
      const errorMessage =
        error instanceof Error ? error.message : 'Invalid QR frame';

      // Don't mark as complete on invalid frame - just report error
      const progressFraction = decoder.getProgress();
      return {
        isComplete: false,
        isSuccess: false,
        progress: Math.round(progressFraction * 100),
        receivedCount: 0,
        expectedCount: decoder.expectedPartCount() || 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Check if a QR code content is a UR-encoded frame
   *
   * @param content - The QR code content
   * @returns True if this is a UR frame
   */
  static isURFrame(content: string): boolean {
    const lower = content.toLowerCase();
    return lower.startsWith('ur:');
  }

  /**
   * Check if a QR code content is a multipart UR frame
   *
   * @param content - The QR code content
   * @returns True if this is a multipart UR frame
   */
  static isMultipartURFrame(content: string): boolean {
    // Multipart UR format: ur:type/seq-total/data
    // e.g., ur:bytes/1-9/lpadascf...
    const lower = content.toLowerCase();
    if (!lower.startsWith('ur:')) return false;

    // Check for the sequence indicator (e.g., /1-9/)
    const parts = lower.split('/');
    if (parts.length < 3) return false;

    const seqPart = parts[1];
    return /^\d+-\d+$/.test(seqPart);
  }

  /**
   * Extract sequence info from a multipart UR frame
   *
   * @param content - The UR frame content
   * @returns Sequence info or null if not multipart
   */
  static getSequenceInfo(
    content: string
  ): { current: number; total: number } | null {
    if (!this.isMultipartURFrame(content)) return null;

    const parts = content.toLowerCase().split('/');
    const seqPart = parts[1];
    const [current, total] = seqPart.split('-').map(Number);

    return { current, total };
  }

  /**
   * Decode a single-part UR directly without using the fountain code decoder
   *
   * @param content - The UR frame content (e.g., "ur:bytes/...")
   * @returns The decoded string data
   */
  static decodeSinglePartUR(content: string): string {
    try {
      // Parse the UR format: ur:type/data
      const lower = content.toLowerCase();
      if (!lower.startsWith('ur:')) {
        throw new Error('Not a valid UR format');
      }

      // Use URDecoder to properly parse the UR string
      const decoder = new URDecoder();
      decoder.receivePart(lower);

      if (!decoder.isComplete() || !decoder.isSuccess()) {
        throw new Error('Failed to decode single-part UR');
      }

      const ur = decoder.resultUR();

      // decodeCBOR() returns the original raw bytes that were CBOR-encoded
      const decodedBytes = ur.decodeCBOR();

      // Convert back to string
      const textDecoder = new TextDecoder();
      const data = textDecoder.decode(
        decodedBytes instanceof Uint8Array ? decodedBytes : new Uint8Array(decodedBytes)
      );

      return data;
    } catch (error) {
      console.error('[AnimatedQRService] decodeSinglePartUR error:', error);
      throw new Error(
        `Failed to decode UR: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}

export default AnimatedQRService;
