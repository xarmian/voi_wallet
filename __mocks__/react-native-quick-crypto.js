// Jest mock for react-native-quick-crypto.
//
// The real package is a native Nitro module: it cannot load in the node/jest
// runtime (no JSI/native binding) and jest does not transform it. Returning an
// empty object makes scryptKdf's loadNativeScrypt() find no native `scrypt`, so
// the shim uses its @noble fallback — exactly the intended non-native behavior.
// This keeps jest identical whether or not the package is installed (CI `npm ci`
// installs it; local dev may not). Device builds use the real native scrypt.
module.exports = {};
