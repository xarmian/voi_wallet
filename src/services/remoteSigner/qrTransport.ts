/**
 * Pairing QR transport helpers (pure, dependency-light).
 *
 * The pairing flow has two transport shapes on the wire:
 *
 *   - RAW JSON in a single STATIC frame — the legacy fast-path. Emitted by the
 *     signer via the plain `react-native-qrcode-svg` `QRCode` and read by the
 *     importer with a direct `JSON.parse`. Used whenever the encoded payload
 *     fits one static frame. This preserves compatibility with older importers
 *     that cannot decode BC-UR.
 *
 *   - BC-UR MULTIPART (animated) — used ONLY when the payload is too large for a
 *     single static frame (multi-account pairings). Wrapping a single frame in
 *     BC-UR would produce a `UR:BYTES` envelope that an older importer's raw
 *     `JSON.parse` cannot read, so we deliberately do NOT UR-wrap small payloads.
 *
 * These helpers isolate the two decisions that drive that routing so they can be
 * unit-tested without a camera / React surface:
 *   1. {@link shouldUseAnimatedQR} — the payload-size / static-vs-animated
 *      threshold on the EXPORT side.
 *   2. {@link isUrEncodedFrame} — the UR-vs-raw-JSON detection on the IMPORT
 *      side (a scanned frame beginning `ur:`/`UR:` must be routed to UR
 *      reassembly; anything else is treated as raw JSON).
 */

import { REMOTE_SIGNER_CONSTANTS } from '@/types/remoteSigner';

/** UTF-8 byte length of an encoded payload string (matches QR capacity units). */
export function encodedByteLength(encoded: string): number {
  return new TextEncoder().encode(encoded).length;
}

/**
 * Decide whether an encoded pairing payload must be transmitted as an animated
 * (BC-UR multipart) QR instead of a single static raw-JSON frame.
 *
 * Returns `false` (static fast-path) when the payload fits one static frame
 * (`≤ SINGLE_QR_MAX_BYTES`) and `true` (animated BC-UR) when it is larger. The
 * comparison is on UTF-8 BYTES, not string length, so multibyte device
 * names/labels are measured correctly.
 */
export function shouldUseAnimatedQR(encoded: string): boolean {
  return (
    encodedByteLength(encoded) > REMOTE_SIGNER_CONSTANTS.SINGLE_QR_MAX_BYTES
  );
}

/**
 * Detect a BC-UR-encoded scanned frame (a `ur:`/`UR:` prefix, case-insensitive).
 *
 * When `true`, the importer must hand the frame to the BC-UR reassembly path
 * (single- or multi-part). When `false`, the frame is raw JSON and goes to the
 * legacy `JSON.parse` fast-path. Mirrors `AnimatedQRService.isURFrame` so the
 * two agree on what counts as a UR frame.
 */
export function isUrEncodedFrame(data: string): boolean {
  return typeof data === 'string' && data.toLowerCase().startsWith('ur:');
}
