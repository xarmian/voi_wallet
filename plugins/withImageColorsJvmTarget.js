const { withProjectBuildGradle } = require('expo/config-plugins');

// Align react-native-image-colors' Kotlin JVM target with its Java target (17).
//
// FR-374 / PLAN-375 DR-6. react-native-image-colors (2.6.0, latest) only sets
// its JVM target under AGP < 8 (its android/build.gradle:57), so under AGP 9 /
// Kotlin 2.2 its Kotlin compile defaults to the JDK's target (21) while Java
// compiles for 17, and `:react-native-image-colors:compileReleaseKotlin` fails
// with "Inconsistent JVM-target compatibility". This replaces the old
// plugins/withAndroidJvmTarget.js, whose `kotlinOptions {}` block is an error
// under Kotlin 2.2 and which forced the target on every subproject; this one
// uses the Kotlin 2.2 `compilerOptions` API and touches only that library.
// Remove it once react-native-image-colors sets a JVM target itself.

const MARKER = '// withImageColorsJvmTarget (FR-374 DR-6)';

const SNIPPET = `
${MARKER}
subprojects { sub ->
  if (sub.name == 'react-native-image-colors') {
    sub.tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompile).configureEach {
      compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
  }
}
`;

const withImageColorsJvmTarget = (config) =>
  withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error(
        'withImageColorsJvmTarget: expected a Groovy android/build.gradle'
      );
    }
    if (!config.modResults.contents.includes(MARKER)) {
      config.modResults.contents += SNIPPET;
    }
    return config;
  });

module.exports = withImageColorsJvmTarget;
