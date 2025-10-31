const { withDangerousMod, AndroidConfig } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Config plugin to add ProGuard rules for Expo Modules
 * This ensures expo-blur and other Expo Modules aren't stripped in release builds
 */
module.exports = function withExpoModulesProguard(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const proguardRulesPath = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'proguard-rules.pro'
      );

      const proguardRules = `
# Expo Modules
-keep class expo.modules.** { *; }
-keep class expo.modules.kotlin.** { *; }
-keep interface expo.modules.kotlin.** { *; }
`;

      let existingRules = '';
      if (fs.existsSync(proguardRulesPath)) {
        existingRules = fs.readFileSync(proguardRulesPath, 'utf-8');
      }

      // Only add rules if they don't already exist
      if (!existingRules.includes('# Expo Modules')) {
        fs.writeFileSync(proguardRulesPath, existingRules + proguardRules, 'utf-8');
      }

      return config;
    },
  ]);
};
