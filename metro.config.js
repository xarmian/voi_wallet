const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add polyfills for Node.js modules needed by algosdk and wallet tooling
config.resolver.alias = {
  ...(config.resolver.alias || {}),
  stream: 'readable-stream',
  buffer: 'buffer',
};

// Ensure these modules are resolved
config.resolver.platforms = ['native', 'web', 'default'];

module.exports = config;
