module.exports = function (api) {
  api.cache(true);
  return {
    // babel-preset-expo auto-adds react-native-worklets/plugin when the package
    // is installed (see babel-preset-expo index.js), and — with
    // experiments.reactCompiler enabled — inserts babel-plugin-react-compiler
    // BEFORE it. Do NOT also add the worklets plugin manually here: a top-level
    // plugin runs before the preset (so before the compiler), which is the wrong
    // order for the React Compiler + Reanimated worklets.
    presets: ['babel-preset-expo'],
  };
};