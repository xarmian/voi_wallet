import 'react-native-url-polyfill/auto';

const globalScope = globalThis as Record<string, any>;

const ensureGlobal = (key: string, value: unknown) => {
  if (typeof globalScope[key] === 'undefined') {
    globalScope[key] = value;
  }
};

const { decode: atobPolyfill, encode: btoaPolyfill } = require('base-64');
ensureGlobal('atob', atobPolyfill);
ensureGlobal('btoa', btoaPolyfill);

// Use React Native's built-in fetch implementation. Overriding it can break
// libraries (e.g., algosdk) that rely on RN's networking/Blob behavior.
// If you need a custom fetch, wrap calls locally rather than polyfilling globals.

const { TextEncoder, TextDecoder } = require('text-encoding');
ensureGlobal('TextEncoder', TextEncoder);
ensureGlobal('TextDecoder', TextDecoder);

const { ReadableStream } = require('web-streams-polyfill/dist/ponyfill.js');
ensureGlobal('ReadableStream', ReadableStream);

// Polyfill crypto.getRandomValues if not available
const getRandomValues = require('react-native-get-random-values').default;
if (typeof globalScope.crypto === 'undefined') {
  ensureGlobal('crypto', {
    getRandomValues,
  });
} else if (typeof globalScope.crypto.getRandomValues === 'undefined') {
  globalScope.crypto.getRandomValues = getRandomValues;
}
