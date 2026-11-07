// FR-374 / PLAN-375 DR-18: keep dev-only modules (src/dev/*) out of release
// bundles.
//
// The crypto self-test in src/dev/ runs only under
// `__DEV__ && process.env.EXPO_PUBLIC_CRYPTO_SELFTEST === '1'`, but a false
// guard alone doesn't keep the module out of the bundle. So when Metro bundles
// with dev=false, any request that resolves to a file under <projectRoot>/src/dev/
// becomes Metro's empty module. Every other request (and every request in a dev
// bundle) is returned unchanged from the upstream resolver.
//
// Matching happens on the RESOLVED path, so every import spelling ('@/dev/x',
// './src/dev/x', '../dev/x') is covered. Symlinks are handled on both sides:
// the project root is matched as given and as its realpath, and a resolved file
// that doesn't match as reported is matched again by its realpath (release
// bundles only, so dev resolution never pays for the extra lookup). Upstream is any resolveRequest the
// config already had; otherwise it's context.resolveRequest (Metro's default,
// which Expo CLI wraps with its own resolvers).
//
// Plain CJS shared by metro.config.js and its jest test
// (src/config/__tests__/metroDevOnlyResolver.test.ts).
const fs = require('fs');
const path = require('path');

function createDevOnlyResolver(projectRoot, upstreamResolveRequest) {
  const devDirs = [
    ...new Set(
      [path.resolve(projectRoot), fs.realpathSync(projectRoot)].map(
        (root) => path.join(root, 'src', 'dev') + path.sep
      )
    ),
  ];

  const inDevDir = (filePath) =>
    devDirs.some((dir) => filePath.startsWith(dir));

  function isDevOnlyFile(filePath) {
    const reported = path.resolve(filePath);
    if (inDevDir(reported)) return true;
    let real;
    try {
      real = fs.realpathSync(reported);
    } catch {
      // Not on disk (e.g. a virtual module), so it can't be under src/dev/.
      return false;
    }
    return real !== reported && inDevDir(real);
  }

  return function devOnlyResolveRequest(context, moduleName, platform) {
    const upstream = upstreamResolveRequest || context.resolveRequest;
    const resolution = upstream(context, moduleName, platform);
    if (
      !context.dev &&
      resolution &&
      resolution.type === 'sourceFile' &&
      isDevOnlyFile(resolution.filePath)
    ) {
      return { type: 'empty' };
    }
    return resolution;
  };
}

module.exports = { createDevOnlyResolver };
