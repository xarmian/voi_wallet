/**
 * jsQR loader — default / native variant (TASK-210).
 *
 * This file is the BARE variant of a `jsqrLoader.ts` + `jsqrLoader.web.ts`
 * platform split. Metro (`metro.config.js:14`, `resolver.platforms =
 * ['native','web','default']`) prefers `jsqrLoader.web.ts` when bundling for
 * web and falls back to this file for `ios`/`android`, so `jsqr` never enters
 * the native module graph. `tsc` — which sets no `moduleSuffixes` — resolves
 * `import … from './jsqrLoader'` to THIS file, which is why the pair is
 * bare + `.web` rather than `.native` + `.web` (the latter would resolve to
 * neither and break `npm run typecheck`).
 *
 * INVARIANT: this file must contain no reference to `jsqr` — not even a
 * type-only import. A type import is erased at runtime and would cost no
 * bytes, but it would defeat the repo-wide source invariant that only
 * `jsqrLoader.web.ts` names the package. The QR types below are therefore
 * declared locally and structurally mirror `jsqr`'s own `dist/index.d.ts`;
 * `jsqrLoader.web.ts` is checked against them, so a drift in either direction
 * is a compile error.
 *
 * NATIVE FALLBACK: `jsQR` is `null` here. Native QR scanning does not use
 * jsqr at all — it goes through `expo-camera`'s `onBarcodeScanned`. Every
 * consumer of this module sits inside a `Platform.OS === 'web'` guard, so the
 * `null` is unreachable at runtime on native. It is deliberately NOT a
 * throwing stub: a throw would turn a mis-guarded path into a crash, whereas
 * consumers call it optionally (`jsQR?.(…)`) and treat "no result" exactly as
 * they already treat "no QR code found".
 */

/** A corner or finder-pattern coordinate in the decoded image. */
export interface JsQrPoint {
  x: number;
  y: number;
}

/** Decoder options. Mirrors jsqr's `Options`. */
export interface JsQrOptions {
  inversionAttempts?:
    | 'dontInvert'
    | 'onlyInvert'
    | 'attemptBoth'
    | 'invertFirst';
}

/** A successfully decoded QR code. Mirrors jsqr's `QRCode`. */
export interface JsQrCode {
  binaryData: number[];
  data: string;
  version: number;
  location: {
    topRightCorner: JsQrPoint;
    topLeftCorner: JsQrPoint;
    bottomRightCorner: JsQrPoint;
    bottomLeftCorner: JsQrPoint;
    topRightFinderPattern: JsQrPoint;
    topLeftFinderPattern: JsQrPoint;
    bottomLeftFinderPattern: JsQrPoint;
    bottomRightAlignmentPattern?: JsQrPoint;
  };
}

/**
 * The single shared type both variants are checked against. It matches the
 * default-import calling convention the three call sites already used
 * (`esModuleInterop` + `allowSyntheticDefaultImports`) against the jsqr
 * package's own `dist/index.d.ts`.
 */
export type JsQrDecoder = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  providedOptions?: JsQrOptions
) => JsQrCode | null;

/**
 * The QR decoder, or `null` where jsqr is not bundled (ios/android).
 * Call it optionally — `jsQR?.(data, width, height)` — and treat an
 * `undefined` result as "no QR code found".
 */
export const jsQR: JsQrDecoder | null = null;
