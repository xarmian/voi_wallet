const { withAppBuildGradle, withProjectBuildGradle, withGradleProperties } = require('@expo/config-plugins');

/**
 * Expo config plugin to fix JVM target compatibility between Java and Kotlin
 * Forces all subprojects (including react-native-image-colors) to use JVM target 17
 */
const withAndroidJvmTarget = (config) => {
  // Set global Kotlin JVM target via gradle.properties
  config = withGradleProperties(config, (config) => {
    config.modResults = config.modResults.filter(
      (item) => !item.key || !item.key.includes('kotlin.jvm.target')
    );

    config.modResults.push({
      type: 'property',
      key: 'kotlin.jvm.target',
      value: '17',
    });

    return config;
  });

  // Modify root build.gradle to force all subprojects to use JVM target 17
  config = withProjectBuildGradle(config, (config) => {
    if (config.modResults.language === 'groovy') {
      const contents = config.modResults.contents;
      
      // Check if we already added our configuration
      if (contents.includes('KotlinCompile') && contents.includes('jvmTarget = "17"')) {
        return config;
      }

      // Find where to insert - after allprojects block or at the end
      let insertPosition = contents.length;
      
      // Try to find allprojects block and insert after it
      const allprojectsMatch = contents.match(/allprojects\s*\{[^}]*\}/s);
      if (allprojectsMatch) {
        insertPosition = allprojectsMatch.index + allprojectsMatch[0].length;
      } else {
        // If no allprojects, find the end of buildscript or end of file
        const buildscriptMatch = contents.match(/buildscript\s*\{[^}]*\}/s);
        if (buildscriptMatch) {
          insertPosition = buildscriptMatch.index + buildscriptMatch[0].length;
        }
      }

      // Insert subprojects configuration that forces JVM target 17
      const configToInsert = `

// Force all subprojects to use JVM target 17 for Kotlin compilation
subprojects {
    afterEvaluate { project ->
        // Configure Kotlin compilation tasks
        project.tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompile).configureEach {
            kotlinOptions {
                jvmTarget = "17"
            }
        }
        
        // Also set compileOptions for Android projects
        if (project.hasProperty("android")) {
            project.android {
                compileOptions {
                    sourceCompatibility JavaVersion.VERSION_17
                    targetCompatibility JavaVersion.VERSION_17
                }
            }
        }
    }
}`;

      config.modResults.contents = 
        contents.slice(0, insertPosition) + 
        configToInsert + 
        contents.slice(insertPosition);
    }
    return config;
  });

  // Also modify the app-level build.gradle to ensure it's set there too
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language === 'groovy') {
      if (!config.modResults.contents.includes('kotlinOptions')) {
        config.modResults.contents = config.modResults.contents.replace(
          /(compileOptions\s*\{[^}]*)(})/s,
          (match, compileOptions, closingBrace) => {
            if (match.includes('kotlinOptions')) {
              return match;
            }
            return (
              compileOptions +
              closingBrace +
              '\n    kotlinOptions {\n        jvmTarget = "17"\n    }'
            );
          }
        );

        if (!config.modResults.contents.includes('compileOptions')) {
          config.modResults.contents = config.modResults.contents.replace(
            /(android\s*\{)/,
            `$1\n    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_17\n        targetCompatibility JavaVersion.VERSION_17\n    }\n    kotlinOptions {\n        jvmTarget = "17"\n    }`
          );
        }
      } else {
        config.modResults.contents = config.modResults.contents.replace(
          /kotlinOptions\s*\{[^}]*jvmTarget\s*=\s*["']?(\d+)["']?[^}]*\}/g,
          'kotlinOptions {\n        jvmTarget = "17"\n    }'
        );
      }
    }
    return config;
  });
};

module.exports = withAndroidJvmTarget;
