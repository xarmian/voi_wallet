/**
 * Verifies babel.config.js (TASK-33) strips console.log in production while
 * preserving console.error / console.warn, and leaves everything intact in
 * development. This exercises the real repo babel.config.js via @babel/core so
 * the env-gated `babel-plugin-transform-remove-console` wiring is under test.
 */
import * as path from 'path';

// @babel/core is available transitively via babel-preset-expo. Use require so
// the test still resolves it if the ESM import shape ever changes.
const babel = require('@babel/core');

const CONFIG_FILE = path.resolve(__dirname, '..', '..', 'babel.config.js');
const SNIPPET = `console.log('x'); console.error('y'); console.warn('z');`;

function transformWithEnv(code: string, env: string): string {
  const prevBabelEnv = process.env.BABEL_ENV;
  // babel.config.js reads process.env.BABEL_ENV directly to decide isProd, so
  // it must be set for the transform (envName alone is not enough here).
  process.env.BABEL_ENV = env;
  try {
    const result = babel.transformSync(code, {
      configFile: CONFIG_FILE,
      babelrc: false,
      envName: env,
      filename: path.resolve(__dirname, 'console-strip-probe.ts'),
    });
    if (!result || result.code == null) {
      throw new Error('babel transform produced no output');
    }
    return result.code;
  } finally {
    if (prevBabelEnv === undefined) {
      delete process.env.BABEL_ENV;
    } else {
      process.env.BABEL_ENV = prevBabelEnv;
    }
  }
}

describe('babel.config.js console stripping', () => {
  it('removes console.log but keeps console.error/console.warn in production', () => {
    const out = transformWithEnv(SNIPPET, 'production');
    expect(out).not.toMatch(/console\s*\.\s*log/);
    expect(out).toMatch(/console\s*\.\s*error/);
    expect(out).toMatch(/console\s*\.\s*warn/);
  });

  it('keeps all console.* calls in development', () => {
    const out = transformWithEnv(SNIPPET, 'development');
    expect(out).toMatch(/console\s*\.\s*log/);
    expect(out).toMatch(/console\s*\.\s*error/);
    expect(out).toMatch(/console\s*\.\s*warn/);
  });
});
