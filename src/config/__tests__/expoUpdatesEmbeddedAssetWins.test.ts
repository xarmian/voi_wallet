/**
 * TASK-503 guard for plugins/withExpoUpdatesEmbeddedAssetWins.js.
 *
 * Bug: after an in-place update from a build whose node_modules layout
 * differed, expo-updates' DB row for the Ionicons font still carries the old
 * resource name (raw/node_modules_expo_node_modules_expo_vectoricons_...), and
 * DatabaseLauncher.kt lets it overwrite the correct embedded one. Every icon is
 * then blank. The plugin patches DatabaseLauncher.kt so the embedded entry for
 * a key wins, in memory only.
 *
 * Like androidR8Config.test.ts this reads source text: no unit test can run the
 * Kotlin. It proves (a) the patch applies to the REAL pinned expo-updates file,
 * (b) it is idempotent, (c) it fails loudly on a changed file or version
 * instead of doing nothing, (d) it is registered. Runtime proof is the built
 * APK with a planted stale row (see TASK-503).
 *
 * The patch writes into a temp COPY of the package, never into node_modules,
 * which worktrees share.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// require() keeps tsc from needing declaration files for the root-level CJS
// config plugin and app.config.js.
const plugin =
  require('../../../plugins/withExpoUpdatesEmbeddedAssetWins.js') as {
    (config: unknown): unknown;
    patchSource: (source: string) => string;
    patchExpoUpdates: (packageDir: string) => string;
    EXPECTED_VERSION: string;
  };
const appConfig = require('../../../app.config.js').default as {
  expo: { plugins: unknown[] };
};

const LAUNCHER_REL =
  'android/src/main/java/expo/modules/updates/launcher/DatabaseLauncher.kt';
const MARKER = 'TASK-503: embedded android_res asset wins';

const realPackageDir = path.dirname(
  require.resolve('expo-updates/package.json')
);

/** A throwaway copy of the parts of expo-updates the plugin touches. */
function copyPackage(mutate?: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-updates-'));
  fs.copyFileSync(
    path.join(realPackageDir, 'package.json'),
    path.join(dir, 'package.json')
  );
  const target = path.join(dir, LAUNCHER_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(realPackageDir, LAUNCHER_REL), target);
  mutate?.(dir);
  return dir;
}

describe('withExpoUpdatesEmbeddedAssetWins', () => {
  const original = fs.readFileSync(
    path.join(realPackageDir, LAUNCHER_REL),
    'utf8'
  );

  it('is written for the expo-updates version the app pins', () => {
    const { version } = JSON.parse(
      fs.readFileSync(path.join(realPackageDir, 'package.json'), 'utf8')
    );
    expect(version).toBe(plugin.EXPECTED_VERSION);
  });

  it('starts from a DatabaseLauncher.kt that still has the bug', () => {
    // If upstream fixes this, this fails first and the plugin can go.
    expect(original).not.toContain(MARKER);
    expect(original).toMatch(/\} else \{\n\s+this\[asset\] = filename\n\s+\}/);
  });

  it('makes a stored android_res path lose to an embedded entry for the same key', () => {
    const patched = plugin.patchSource(original);
    // The set of keys the embedded manifest already mapped is taken BEFORE the
    // DB rows are merged in...
    const keysAt = patched.indexOf('val embeddedFiles');
    const loopAt = patched.indexOf('for (asset in assetEntities)');
    expect(keysAt).toBeGreaterThan(-1);
    expect(keysAt).toBeLessThan(loopAt);
    // ...and a DB row whose key is in it is skipped, not mapped.
    const skip = patched.indexOf('embeddedFiles.containsKey(it)');
    const plain = patched.indexOf('this[asset] = filename');
    expect(skip).toBeGreaterThan(loopAt);
    expect(skip).toBeLessThan(plain);
    // A key the embedded manifest does NOT have still maps to its stored path.
    expect(patched).toMatch(/\} else \{\n\s+this\[asset\] = filename\n\s+\}/);
  });

  it('logs only when the stored path really differs from the embedded one', () => {
    const patched = plugin.patchSource(original);
    // Compared as parsed resources, so a density folder alone (drawable-mdpi
    // vs drawable-xxxhdpi, same name) is not reported as stale.
    expect(patched).toMatch(
      /sameResource = runCatching[\s\S]*parseAndroidResponseAssetFromPath\(embeddedFile\)[\s\S]*parseAndroidResponseAssetFromPath\(filename\)[\s\S]*if \(!sameResource\) \{\n\s+logger\.warn\(/
    );
  });

  it('leaves an over-the-air asset on its original branch', () => {
    // A downloaded asset has a plain file path, not file:///android_res/. It
    // takes the first branch (ensureAssetExists), which must stay byte for byte
    // as upstream wrote it, ahead of the new branch.
    const patched = plugin.patchSource(original);
    const firstBranch =
      'if (!AndroidResourceAssetUtils.isAndroidResourceAsset(filename)) {\n' +
      '          val job = scope.async {\n' +
      '            val assetFile = ensureAssetExists(asset, database, embeddedUpdate, extraHeaders)\n' +
      '            Pair(asset, assetFile)\n' +
      '          }\n' +
      '          downloadJobs.add(job)\n' +
      '        } else if (asset.key?.let { embeddedFiles.containsKey(it) } == true) {';
    expect(original).toContain(firstBranch.split(' else if')[0]);
    expect(patched).toContain(firstBranch);
    // And the new branch only ever sees android_res paths, because it is
    // reached only when the first branch's condition was false.
  });

  it('does not write the DB or change anything else', () => {
    const patched = plugin.patchSource(original);
    const removed = original
      .split('\n')
      .filter((line) => !patched.split('\n').includes(line));
    expect(removed).toEqual([]);
    // The original already writes the DB elsewhere (ensureAssetExists); the
    // patch must add no write of its own.
    const writes = (s: string) =>
      (s.match(/assetDao\(\)\.\w*[uU]pdate\w*/g) ?? []).length;
    expect(writes(patched)).toBe(writes(original));
  });

  it('is idempotent', () => {
    const once = plugin.patchSource(original);
    expect(plugin.patchSource(once)).toBe(once);
    expect(once.split(MARKER)).toHaveLength(2);
  });

  it('patches a copy of the real package on disk, twice, without stacking', () => {
    const dir = copyPackage();
    const first = plugin.patchExpoUpdates(dir);
    const second = plugin.patchExpoUpdates(dir);
    expect(first).toContain(MARKER);
    expect(second).toBe(first);
    expect(fs.readFileSync(path.join(dir, LAUNCHER_REL), 'utf8')).toBe(first);
  });

  it('fails loudly when the file no longer has the expected shape', () => {
    expect(() => plugin.patchSource('class DatabaseLauncher {}')).toThrow(
      /expo-updates changed/
    );
    // One anchor present, one missing, is still a failure and writes nothing.
    const half = original.replace(
      'val downloadJobs = mutableListOf',
      'val jobs = mutableListOf'
    );
    expect(() => plugin.patchSource(half)).toThrow(/keys anchor once.*found 0/);
    const dir = copyPackage((d) =>
      fs.writeFileSync(path.join(d, LAUNCHER_REL), half)
    );
    expect(() => plugin.patchExpoUpdates(dir)).toThrow();
    expect(fs.readFileSync(path.join(dir, LAUNCHER_REL), 'utf8')).toBe(half);
  });

  it('fails loudly on a different expo-updates version, before touching the file', () => {
    const dir = copyPackage((d) =>
      fs.writeFileSync(
        path.join(d, 'package.json'),
        JSON.stringify({ name: 'expo-updates', version: '99.0.0' })
      )
    );
    const before = fs.readFileSync(path.join(dir, LAUNCHER_REL), 'utf8');
    expect(() => plugin.patchExpoUpdates(dir)).toThrow(
      /written for expo-updates/
    );
    expect(fs.readFileSync(path.join(dir, LAUNCHER_REL), 'utf8')).toBe(before);
  });

  it('is registered in app.config.js', () => {
    expect(appConfig.expo.plugins).toContain(plugin);
  });
});
