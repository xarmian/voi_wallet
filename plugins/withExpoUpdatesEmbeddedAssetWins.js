const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

// Make an embedded Android resource asset win over a stale expo-updates DB row.
//
// TASK-503. expo-updates keeps every asset in its SQLite DB, keyed by the file's
// hash, and for an embedded asset stores the resource name it had when the row
// was written (`file:///android_res/raw/<name>.ttf`). The name comes from the
// asset's path in node_modules, so it changes when the package moves: on SDK 54
// @expo/vector-icons is nested under expo/node_modules, on SDK 58 it is hoisted,
// and the Ionicons font goes from raw/node_modules_expo_node_modules_expo_
// vectoricons_... to raw/node_modules_expo_vectoricons_.... An in-place update
// finds the old row by key, never refreshes its relative_path, and
// DatabaseLauncher.kt then lets that old name overwrite the correct one that
// embeddedAssetFileMap() just built from the new APK's manifest. expo-asset asks
// for a raw resource the APK doesn't have, `ExpoAsset.downloadAsync` rejects,
// and every icon stays an empty <Text /> (no tofu, no log in a release build).
//
// The fix is in memory only: when the embedded manifest already maps a key, the
// DB row's embedded resource path (android_res or android_asset: both name
// something inside this APK, and both are what the launcher's own
// isAndroidResourceAsset check accepts) for that key is ignored. The DB is not
// written. A downloaded (over-the-air) asset has a plain file path and keeps its
// original branch.
//
// This edits node_modules, so it must fail loudly rather than do nothing:
//  - it throws unless expo-updates is exactly the version this was written for
//    (re-read DatabaseLauncher.kt on a bump; drop this plugin if upstream fixed it);
//  - it throws unless both anchor snippets are found exactly once.
// It is idempotent (a marker) so repeated prebuilds don't stack edits.

const EXPECTED_VERSION = '58.0.17';
const MARKER = 'TASK-503: embedded android_res asset wins';

const KEYS_ANCHOR =
  '      val downloadJobs = mutableListOf<Deferred<Pair<AssetEntity, File?>>>()\n';
const KEYS_REPLACEMENT = `      // ${MARKER} (withExpoUpdatesEmbeddedAssetWins)
      val embeddedFiles = entries.mapNotNull { e -> e.key.key?.let { k -> k to e.value } }.toMap()
${KEYS_ANCHOR}`;

const ROW_ANCHOR = `        } else {
          this[asset] = filename
        }
`;
const ROW_REPLACEMENT = `        } else if (asset.key?.let { embeddedFiles.containsKey(it) } == true) {
          // The embedded manifest already maps this key to a resource in THIS
          // APK. The row's stored name may come from an older build; it is only
          // worth a log line when it actually differs.
          val embeddedFile = embeddedFiles[asset.key] ?: filename
          // A density folder (drawable-mdpi vs drawable-xxxhdpi) is not a
          // different resource: Android resolves both by name.
          val sameResource = runCatching {
            AndroidResourceAssetUtils.parseAndroidResponseAssetFromPath(embeddedFile) ==
              AndroidResourceAssetUtils.parseAndroidResponseAssetFromPath(filename)
          }.getOrDefault(false)
          if (!sameResource) {
            logger.warn("embeddedAssetFileMap: \${asset.key} is stored as \${filename} but this build embeds it as \${embeddedFile}; using the embedded resource")
          }
        } else {
          this[asset] = filename
        }
`;

function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function patchSource(source) {
  if (source.includes(MARKER)) {
    // The marker sits in the first edit only. Accept the file as already
    // patched only if BOTH edits are present byte for byte; a half-written file
    // or one patched by an older version of this plugin must stop the build.
    if (
      !source.includes(KEYS_REPLACEMENT) ||
      !source.includes(ROW_REPLACEMENT)
    ) {
      throw new Error(
        'withExpoUpdatesEmbeddedAssetWins: DatabaseLauncher.kt carries the marker but not both current edits (partial or older patch). Reinstall expo-updates and rebuild (TASK-503).'
      );
    }
    return source;
  }
  for (const [name, anchor] of [
    ['keys', KEYS_ANCHOR],
    ['row', ROW_ANCHOR],
  ]) {
    const n = countOf(source, anchor);
    if (n !== 1) {
      throw new Error(
        `withExpoUpdatesEmbeddedAssetWins: expected the ${name} anchor once in DatabaseLauncher.kt, found ${n}. expo-updates changed; re-read it (TASK-503).`
      );
    }
  }
  return source
    .replace(KEYS_ANCHOR, () => KEYS_REPLACEMENT)
    .replace(ROW_ANCHOR, () => ROW_REPLACEMENT);
}

function patchExpoUpdates(packageDir) {
  const { version } = JSON.parse(
    fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')
  );
  if (version !== EXPECTED_VERSION) {
    throw new Error(
      `withExpoUpdatesEmbeddedAssetWins: written for expo-updates ${EXPECTED_VERSION}, found ${version}. Re-check DatabaseLauncher.kt and update or remove this plugin (TASK-503).`
    );
  }
  const file = path.join(
    packageDir,
    'android/src/main/java/expo/modules/updates/launcher/DatabaseLauncher.kt'
  );
  const before = fs.readFileSync(file, 'utf8');
  const after = patchSource(before);
  if (after !== before) {
    // Write beside the target and rename, so an interrupted write can never
    // leave a half-patched DatabaseLauncher.kt behind.
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, after);
    fs.renameSync(tmp, file);
  }
  return after;
}

const withExpoUpdatesEmbeddedAssetWins = (config) =>
  withDangerousMod(config, [
    'android',
    (config) => {
      const packageDir = path.dirname(
        require.resolve('expo-updates/package.json', {
          paths: [config.modRequest.projectRoot],
        })
      );
      patchExpoUpdates(packageDir);
      return config;
    },
  ]);

module.exports = withExpoUpdatesEmbeddedAssetWins;
module.exports.patchSource = patchSource;
module.exports.patchExpoUpdates = patchExpoUpdates;
module.exports.EXPECTED_VERSION = EXPECTED_VERSION;
