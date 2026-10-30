/**
 * DR-18 (FR-374): the Metro resolver that keeps src/dev/* out of release
 * bundles. Release (dev=false) requests that resolve under src/dev/ become an
 * empty module; everything else is passed through from the upstream resolver
 * untouched. The real-bundle proof is the release export + marker grep in the
 * TASK-385 report; this pins the resolver's contract.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const { createDevOnlyResolver } = require('../../../metro.devOnlyResolver') as {
  createDevOnlyResolver: (
    projectRoot: string,
    upstream?: ResolveFn | null
  ) => ResolveFn;
};

type Resolution = { type: string; filePath?: string } | null;
type Context = { dev: boolean; resolveRequest: ResolveFn };
type ResolveFn = (
  context: Context,
  moduleName: string,
  platform: string | null
) => Resolution;

// Must exist: the resolver also matches the project root's realpath.
const ROOT = resolve(__dirname, '../../..');

function contextResolvingTo(filePath: string, dev: boolean) {
  const resolveRequest = jest.fn<Resolution, [Context, string, string | null]>(
    () => ({ type: 'sourceFile', filePath })
  );
  return { context: { dev, resolveRequest }, resolveRequest };
}

describe('Metro dev-only resolver (DR-18)', () => {
  it('maps a src/dev module to an empty module in a release bundle', () => {
    const { context } = contextResolvingTo(
      join(ROOT, 'src/dev/cryptoSelfTest.ts'),
      false
    );
    const resolver = createDevOnlyResolver(ROOT);
    expect(resolver(context, '@/dev/cryptoSelfTest', 'ios')).toEqual({
      type: 'empty',
    });
  });

  it('keeps the src/dev module in a dev bundle', () => {
    const filePath = join(ROOT, 'src/dev/cryptoSelfTest.ts');
    const { context } = contextResolvingTo(filePath, true);
    const resolver = createDevOnlyResolver(ROOT);
    expect(resolver(context, './src/dev/cryptoSelfTest', 'android')).toEqual({
      type: 'sourceFile',
      filePath,
    });
  });

  it.each([
    join(ROOT, 'src/utils/polyfills.ts'),
    join(ROOT, 'src/devtools/x.ts'), // a sibling whose name only starts with "dev"
    join(ROOT, 'node_modules/foo/src/dev/index.js'),
  ])('passes %s through unchanged in a release bundle', (filePath) => {
    const { context, resolveRequest } = contextResolvingTo(filePath, false);
    const resolver = createDevOnlyResolver(ROOT);
    const result = resolver(context, 'whatever', 'ios');
    expect(result).toEqual({ type: 'sourceFile', filePath });
    expect(resolveRequest).toHaveBeenCalledWith(context, 'whatever', 'ios');
  });

  it('passes non-file resolutions (assets, empty) through unchanged', () => {
    const asset = {
      type: 'assetFiles',
      filePaths: [join(ROOT, 'src/dev/a.png')],
    };
    const resolveRequest = jest.fn(() => asset);
    const resolver = createDevOnlyResolver(ROOT);
    expect(
      resolver({ dev: false, resolveRequest } as never, './a.png', 'ios')
    ).toBe(asset);
  });

  it('chains to an existing custom resolver instead of context.resolveRequest', () => {
    const custom = jest.fn(() => ({
      type: 'sourceFile',
      filePath: join(ROOT, 'src/a.ts'),
    }));
    const { context, resolveRequest } = contextResolvingTo('/unused', false);
    const resolver = createDevOnlyResolver(ROOT, custom);
    resolver(context, './a', 'web');
    expect(custom).toHaveBeenCalledWith(context, './a', 'web');
    expect(resolveRequest).not.toHaveBeenCalled();
  });

  it('matches src/dev through either a symlinked or the real project root', () => {
    const base = mkdtempSync(join(tmpdir(), 'devonly-'));
    try {
      const realRoot = join(base, 'real');
      const linkRoot = join(base, 'link');
      mkdirSync(join(realRoot, 'src', 'dev'), { recursive: true });
      // The reported file must exist for the realpath fallback to see it.
      writeFileSync(join(realRoot, 'src', 'dev', 'cryptoSelfTest.ts'), '');
      symlinkSync(realRoot, linkRoot);
      const real = realpathSync(realRoot);
      for (const [configRoot, reportedRoot] of [
        [linkRoot, real],
        [real, linkRoot],
        [real, real],
        [linkRoot, linkRoot],
      ]) {
        const { context } = contextResolvingTo(
          join(reportedRoot, 'src/dev/cryptoSelfTest.ts'),
          false
        );
        expect(
          createDevOnlyResolver(configRoot)(context, '@/dev/x', 'ios')
        ).toEqual({ type: 'empty' });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('propagates upstream resolution errors', () => {
    const resolver = createDevOnlyResolver(ROOT);
    const failing = () => {
      throw new Error('Unable to resolve');
    };
    expect(() =>
      resolver({ dev: false, resolveRequest: failing }, './missing', 'ios')
    ).toThrow('Unable to resolve');
  });

  it('is wired into metro.config.js, chaining any prior resolveRequest', () => {
    const configSource = readFileSync(
      resolve(__dirname, '../../../metro.config.js'),
      'utf8'
    );
    expect(configSource).toMatch(
      /config\.resolver\.resolveRequest = createDevOnlyResolver\(\s*__dirname,\s*config\.resolver\.resolveRequest\s*\);/
    );
  });
});
