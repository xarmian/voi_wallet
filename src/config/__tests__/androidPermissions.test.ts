/**
 * TASK-553 regression guard for the Android permission set and release config.
 *
 * Google Play rejected a release upload because the merged manifest requested
 * READ_MEDIA_IMAGES (photo/video permissions need a Play declaration). That
 * permission, plus several other unused ones, comes from library manifests and
 * Expo defaults rather than from this app:
 * - READ_MEDIA_IMAGES / READ_EXTERNAL_STORAGE: expo-screen-capture's screenshot
 *   listener. The app only uses FLAG_SECURE, which needs no permission.
 * - READ/WRITE_EXTERNAL_STORAGE: expo-file-system and expo-image. Backups use
 *   the Storage Access Framework and the cache dir; restore uses the system
 *   document picker. None needs a storage permission.
 * - RECORD_AUDIO: the auto-applied expo-camera plugin. The camera is used for
 *   QR scanning only.
 * - SYSTEM_ALERT_WINDOW: Expo's default manifest template.
 *
 * Like androidR8Config.test.ts, this asserts the RAW CONFIG. `expo prebuild`
 * turns blockedPermissions into tools:node="remove" entries in the manifest.
 */

const appConfig = require('../../../app.config.js').default as {
  expo: {
    plugins: unknown[];
    ios: { buildNumber?: string };
    android: {
      versionCode?: number;
      permissions?: string[];
      blockedPermissions?: string[];
    };
  };
};

const easConfig = require('../../../eas.json') as {
  submit?: { production?: Record<string, unknown> };
};

const BLOCKED = [
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.RECORD_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
];

/** Strip the android.permission. prefix so short and full names compare. */
function shortName(permission: string): string {
  return permission.replace(/^android\.permission\./, '');
}

/** Recursively collect every object key under a value. */
function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, child]) => [key, ...collectKeys(child)]
    );
  }
  return [];
}

describe('Android permissions (TASK-553)', () => {
  it('blocks every permission Play rejects or the app does not use', () => {
    const blocked = appConfig.expo.android.blockedPermissions ?? [];
    for (const permission of BLOCKED) {
      expect(blocked).toContain(permission);
    }
  });

  it('keeps the permissions the app needs and requests none of the blocked ones', () => {
    const permissions = appConfig.expo.android.permissions ?? [];
    for (const required of ['CAMERA', 'USE_BIOMETRIC', 'USE_FINGERPRINT']) {
      expect(permissions).toContain(required);
    }
    const requested = permissions.map(shortName);
    for (const permission of BLOCKED) {
      expect(requested).not.toContain(shortName(permission));
    }
  });

  it('configures expo-camera explicitly without microphone access', () => {
    const entry = appConfig.expo.plugins.find(
      (plugin): plugin is [string, Record<string, unknown>] =>
        Array.isArray(plugin) && plugin[0] === 'expo-camera'
    );
    expect(entry).toBeDefined();
    const options = entry?.[1] ?? {};
    expect(options.recordAudioAndroid).toBe(false);
    expect(options.microphonePermission).toBe(false);
  });

  it('bumps the build number on both platforms', () => {
    expect(appConfig.expo.android.versionCode).toBe(25);
    expect(appConfig.expo.ios.buildNumber).toBe('25');
  });
});

describe('EAS submit config (TASK-553)', () => {
  it('targets the internal Play track and the App Store Connect app', () => {
    const production = easConfig.submit?.production as
      | {
          android?: { track?: string };
          ios?: { ascAppId?: string };
        }
      | undefined;
    expect(production?.android?.track).toBe('internal');
    expect(production?.ios?.ascAppId).toBe('6752960399');
  });

  it('does not reference a service account key file', () => {
    expect(collectKeys(easConfig.submit?.production)).not.toContain(
      'serviceAccountKeyPath'
    );
  });
});
