import { readFileSync } from 'fs';
import path from 'path';
import { LEGACY_WALLET_SECURE_KEY } from '../constants';

// The wipe deletes the legacy secure-store copy of the wallet blob by name. If
// the wallet service ever renames its key, the wipe would silently stop deleting
// the real one. Read from source: the service itself needs native modules.
test('LEGACY_WALLET_SECURE_KEY matches the wallet service WALLET_KEY', () => {
  const source = readFileSync(
    path.join(__dirname, '../../wallet/index.ts'),
    'utf8'
  );
  const match = source.match(/private static readonly WALLET_KEY = '([^']+)';/);
  expect(match?.[1]).toBe(LEGACY_WALLET_SECURE_KEY);
});
