/**
 * jsQR loader — web variant (TASK-210).
 *
 * Metro resolves this file in place of `jsqrLoader.ts` when bundling for web
 * (`metro.config.js:14`), which is the only target that ships `jsqr`. The
 * package stays in `package.json`: the browser-extension build
 * (`build-extension` → `npx expo export -p web`) genuinely decodes QR codes
 * from `ImageData` off a `<canvas>`, which `expo-camera` cannot do.
 *
 * The default import below is the exact calling convention the three former
 * direct importers used. jsqr is CJS (`main: ./dist/jsQR.js`, no `module`
 * field) and both its `module.exports` and its `.default` property are
 * functions, so the wrong pick would be silent —
 * `src/utils/__tests__/jsqrLoader.test.ts` pins the behaviour against a
 * committed QR fixture rather than trusting it.
 *
 * The `JsQrDecoder` import below is intentionally `import type`: it is erased
 * before bundling, so this does NOT become a runtime self-import even though
 * Metro resolves `./jsqrLoader` to this very file on web. Sharing the type
 * from the bare variant is what makes `tsc` check both call shapes against a
 * single declaration.
 */
import jsQRImpl from 'jsqr';

import type { JsQrDecoder } from './jsqrLoader';

export type {
  JsQrCode,
  JsQrDecoder,
  JsQrOptions,
  JsQrPoint,
} from './jsqrLoader';

/** The QR decoder. Never `null` on web — see `jsqrLoader.ts` for the contract. */
export const jsQR: JsQrDecoder | null = jsQRImpl;
