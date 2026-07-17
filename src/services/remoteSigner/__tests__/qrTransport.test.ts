/**
 * Unit tests for the pairing QR transport helpers.
 *
 * These pin down the two routing decisions that keep the static raw-JSON
 * fast-path compatible with older importers while still supporting BC-UR
 * multipart for large payloads:
 *   - the static-vs-animated size threshold (export side), and
 *   - the UR-vs-raw-JSON frame detection (import side).
 */

import {
  encodedByteLength,
  shouldUseAnimatedQR,
  isUrEncodedFrame,
} from '../qrTransport';
import { REMOTE_SIGNER_CONSTANTS } from '@/types/remoteSigner';

const MAX = REMOTE_SIGNER_CONSTANTS.SINGLE_QR_MAX_BYTES;

describe('encodedByteLength', () => {
  it('counts ASCII as one byte each', () => {
    expect(encodedByteLength('abc')).toBe(3);
    expect(encodedByteLength('')).toBe(0);
  });

  it('counts multibyte UTF-8 by BYTES, not string length', () => {
    // 'é' is 2 UTF-8 bytes; '😀' is 4.
    expect(encodedByteLength('é')).toBe(2);
    expect(encodedByteLength('😀')).toBe(4);
    expect('😀'.length).toBe(2); // string length disagrees with byte length
  });
});

describe('shouldUseAnimatedQR', () => {
  it('uses the static fast-path for a small payload', () => {
    expect(shouldUseAnimatedQR('{"v":2,"t":"pair"}')).toBe(false);
  });

  it('treats exactly SINGLE_QR_MAX_BYTES as static (boundary is inclusive)', () => {
    const atLimit = 'a'.repeat(MAX);
    expect(encodedByteLength(atLimit)).toBe(MAX);
    expect(shouldUseAnimatedQR(atLimit)).toBe(false);
  });

  it('switches to animated one byte over the limit', () => {
    const overLimit = 'a'.repeat(MAX + 1);
    expect(shouldUseAnimatedQR(overLimit)).toBe(true);
  });

  it('measures the threshold in UTF-8 bytes (multibyte pushes over)', () => {
    // (MAX - 1) ASCII + one 2-byte char = MAX + 1 bytes → animated.
    const payload = 'a'.repeat(MAX - 1) + 'é';
    expect(encodedByteLength(payload)).toBe(MAX + 1);
    expect(shouldUseAnimatedQR(payload)).toBe(true);
  });
});

describe('isUrEncodedFrame', () => {
  it('detects a lower-case ur: prefix', () => {
    expect(isUrEncodedFrame('ur:bytes/1-3/lpadaxcstring')).toBe(true);
  });

  it('detects an upper-case UR: prefix (QR text is often upper-cased)', () => {
    expect(isUrEncodedFrame('UR:BYTES/1-3/LPADAXCSTRING')).toBe(true);
  });

  it('detects a single-part UR frame', () => {
    expect(isUrEncodedFrame('ur:bytes/lpadaxcstring')).toBe(true);
  });

  it('treats raw JSON as NOT a UR frame (routes to JSON.parse)', () => {
    expect(isUrEncodedFrame('{"v":2,"t":"pair","dev":"x"}')).toBe(false);
  });

  it('does not match an address or arbitrary text', () => {
    expect(isUrEncodedFrame('')).toBe(false);
    expect(isUrEncodedFrame('OURADDRESS...')).toBe(false);
    expect(isUrEncodedFrame('nurse')).toBe(false);
  });
});
