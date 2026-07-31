// Regression test for PLAN-260 / TASK-262.
//
// Both WalletConnect error paths used to pass the raw pairing URI as a
// `WalletConnectError` route param. A v1 URI carries `key=<hex>` — the symmetric
// session key this plan moves into secure storage — and a v2 URI carries
// `symKey`. Route params live in React Navigation state, which is serialized and
// inspectable, so this parked the exact secret elsewhere while we were busy
// securing its storage. Same class as TASK-224 (mnemonics through route params).
//
// Nothing ever read the param: WalletConnectErrorScreen uses `error` only.

import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '..', '..', '..', '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

describe('WalletConnect error route carries no pairing URI', () => {
  it('the deeplink service does not pass `uri` into route params', () => {
    const source = read('src/services/deeplink/index.ts');

    const blocks = source
      .split('WalletConnectError')
      .slice(1)
      .map((chunk) => chunk.slice(0, 400));

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/\buri:\s*url\b/);
    }
  });

  it('the route type no longer declares a uri param', () => {
    const nav = read('src/navigation/AppNavigator.tsx');
    const decl = nav
      .split('\n')
      .find((line) => line.includes('WalletConnectError: {'));

    expect(decl).toBeDefined();
    expect(decl).not.toContain('uri');
  });

  it('the error screen only ever consumed `error`', () => {
    const screen = read(
      'src/screens/walletconnect/WalletConnectErrorScreen.tsx'
    );
    expect(screen).not.toContain('params?.uri');
    expect(screen).not.toContain('params.uri');
    expect(screen).toContain('route.params?.error');
  });
});
