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

import * as crypto from 'crypto';
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
const UPSTREAM_SHA256 =
  'ffa2225c312d8dc31ec46da291f743e7178ac9edc8037d36da6128795c30e1ef';
const PATCHED_SHA256 =
  'e64d09259db5ae3c90141756cda311cd37c2121e65b74e125bfcdc110055f0d2';

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

  it('makes a stored embedded-resource path lose to an embedded entry for the same key', () => {
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
    // A downloaded asset has a plain file path, not an embedded resource path. It
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
    // And the new branch only ever sees embedded resource paths (android_res or
    // android_asset), because it is reached only when the first branch's
    // condition (isAndroidResourceAsset) was false.
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

  it('produces exactly the Kotlin that was reviewed and built', () => {
    // Golden hashes of upstream's file and of the patched result. A change to
    // either the plugin's output or upstream's file must be a reviewed change
    // (it is native code that runs on every cold start). The patched hash is
    // the output of the build proven on the emulator (TASK-503).
    const sha = (s: string) =>
      crypto.createHash('sha256').update(s).digest('hex');
    expect(sha(original)).toBe(UPSTREAM_SHA256);
    expect(sha(plugin.patchSource(original))).toBe(PATCHED_SHA256);
  });

  it('refuses a file that has the marker but not both current edits', () => {
    const patched = plugin.patchSource(original);
    // Fixtures are cut from the REAL patched output, not invented.
    //
    // (1) Only the first (keys) edit survived: the real patched file with the
    // second (row) edit cut back out to upstream's text.
    const rowStart = patched.indexOf('        } else if (asset.key?.let');
    const rowEnd = patched.indexOf(
      '        } else {\n          this[asset] = filename',
      rowStart
    );
    expect(rowStart).toBeGreaterThan(-1);
    expect(rowEnd).toBeGreaterThan(rowStart);
    const firstEditOnly = patched.slice(0, rowStart) + patched.slice(rowEnd);
    expect(firstEditOnly).toContain(MARKER);
    expect(firstEditOnly).toContain('val embeddedFiles = ');
    expect(() => plugin.patchSource(firstEditOnly)).toThrow(
      /partial or older patch/
    );
    // (2) The keys edit damaged but the row edit intact: the marker is still
    // there (it sits in the keys edit's comment), so only a check of the keys
    // half itself can refuse this.
    const keysDamaged = patched.replace(
      'val embeddedFiles = entries.mapNotNull',
      'val embeddedFilez = entries.mapNotNull'
    );
    expect(keysDamaged).toContain(MARKER);
    expect(keysDamaged).toContain('embeddedFiles.containsKey(it)');
    expect(() => plugin.patchSource(keysDamaged)).toThrow(
      /partial or older patch/
    );
    // (3) The row edit damaged, keys edit intact.
    const rowDamaged = patched.replace(
      'embeddedFiles.containsKey(it)',
      'embeddedFiles.isEmpty()'
    );
    expect(() => plugin.patchSource(rowDamaged)).toThrow(
      /partial or older patch/
    );
    // The way out is named in the message.
    expect(() => plugin.patchSource(keysDamaged)).toThrow(/npm ci/);
    // The complete patch is still accepted unchanged.
    expect(plugin.patchSource(patched)).toBe(patched);
  });

  it('leaves no temp file beside the patched source', () => {
    const dir = copyPackage();
    const target = path.join(dir, LAUNCHER_REL);
    const before = fs.readFileSync(target, 'utf8');
    plugin.patchExpoUpdates(dir);
    // The copy really was patched (a no-op would also leave no temp file)...
    const after = fs.readFileSync(target, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain(MARKER);
    // ...and nothing but the target is left beside it.
    expect(fs.readdirSync(path.dirname(target))).toEqual([
      'DatabaseLauncher.kt',
    ]);
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
