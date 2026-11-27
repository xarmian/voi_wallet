/**
 * TASK-469: the wipe purge empties `subscriber.cached`, a private field of
 * @walletconnect/core's Subscriber that holds the topics re-subscribed on the
 * next relay connect. The purge writes it through a cast, so an SDK upgrade
 * that renamed or removed it would make that write a silent no-op. This test
 * reads the installed SDK and fails if the field is no longer where the purge
 * expects it.
 */
import { readFileSync } from 'fs';
import path from 'path';

// The package's exports hide package.json from require.resolve, so locate it
// from the repository root.
const CORE_DIST = path.join(
  __dirname,
  '../../../../node_modules/@walletconnect/core/dist/index.cjs'
);

describe('installed @walletconnect/core Subscriber', () => {
  it('keeps reconnect topics in `cached`, the field the wipe purge empties', () => {
    const source = readFileSync(CORE_DIST, 'utf8');
    expect(source).toMatch(/this\.cached ?= ?this\.values/);
    expect(source).toMatch(/this\.cached ?= ?\[\]/);
  });
});
