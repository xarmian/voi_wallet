import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * TASK-210 — the jsqr platform-split loader.
 *
 * Both variants are imported by EXPLICIT path. Letting Jest's platform
 * resolution pick one and then inferring which arrived would make every
 * assertion below depend on resolver behaviour rather than on the code, and
 * the whole point of the split is that the two files differ. `jsqrLoader.web`
 * names the `.web` variant unambiguously; `jsqrLoader` names the bare file,
 * because `jest-expo`'s haste config (`defaultPlatform: 'ios'`,
 * `platforms: ['android','ios','native']`) has no `web` entry, so no `.web`
 * suffix can ever satisfy a bare specifier here.
 *
 * The byte-level bundle checks in the task prove jsqr is *gone from native*.
 * They cannot prove the web loader still *works*: jsqr is CJS, and both its
 * `module.exports` and its `.default` property are functions, so a wrong
 * interop pick is silent and every byte check would still pass. Hence the
 * behavioural assertion against a committed fixture.
 */
/*
 * The two imports below name two DIFFERENT files. `import/no-duplicates` says
 * otherwise because eslint-plugin-import's resolver maps the bare
 * `../jsqrLoader` onto `jsqrLoader.web.ts`, so it believes both lines resolve
 * to one module. It is the only one of the four resolvers involved that does:
 * Metro (native), `tsc` and Jest all resolve the bare specifier to
 * `jsqrLoader.ts`, and the native-fallback assertions below fail loudly if
 * Jest ever stops doing so — which is exactly why they are here. eslint
 * executes no code, so its misresolution is cosmetic; the repo already
 * disables `import/no-unresolved` for the same resolver's shortcomings
 * (`eslint.config.js:17-21`).
 */
/* eslint-disable import/no-duplicates */
import { jsQR as nativeJsQR } from '../jsqrLoader';
import { jsQR as webJsQR } from '../jsqrLoader.web';
/* eslint-enable import/no-duplicates */

import { EXPECTED_PAYLOAD, qrFixtureImageData } from './fixtures/qrFixture';

describe('jsqrLoader (web variant)', () => {
  it('exports a callable decoder, not a namespace object', () => {
    expect(typeof webJsQR).toBe('function');
  });

  it('decodes the pinned QR fixture', () => {
    const { data, width, height } = qrFixtureImageData();

    // Non-null assertion is safe and deliberate: the assertion above already
    // established this variant exports a function. Calling it unguarded is
    // the point — it pins the default-import calling convention the three
    // former direct importers used.
    const code = webJsQR!(data, width, height);

    expect(code).not.toBeNull();
    expect(code?.data).toBe(EXPECTED_PAYLOAD);
  });

  it('returns null for an image with no QR code', () => {
    const { width, height } = qrFixtureImageData();
    const blank = new Uint8ClampedArray(width * height * 4).fill(255);

    expect(webJsQR!(blank, width, height)).toBeNull();
  });
});

describe('jsqrLoader (bare / native variant)', () => {
  it('exposes the documented null fallback instead of jsqr', () => {
    expect(nativeJsQR).toBeNull();
  });

  it('is safe to call optionally, yielding undefined rather than throwing', () => {
    const { data, width, height } = qrFixtureImageData();

    // This mirrors exactly what the three call sites do. On native the call
    // is unreachable (all three sit inside `Platform.OS === 'web'` guards),
    // but if a guard ever regressed this must degrade to "no QR found", not
    // crash the screen.
    expect(nativeJsQR?.(data, width, height)).toBeUndefined();
  });

  it('contains no reference to jsqr in its source', () => {
    // The bare variant is what Metro bundles for ios/android. A stray import
    // — even a type-only one that costs no bytes — would break the repo-wide
    // source invariant this task establishes, so assert on the file itself.
    const source = readFileSync(join(__dirname, '..', 'jsqrLoader.ts'), 'utf8');

    expect(source).not.toMatch(/['"]jsqr['"]/i);
  });
});
