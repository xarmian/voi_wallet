/**
 * TASK-469: the wipe purge writes private fields of the WalletConnect SDK
 * through casts (purgeClient in ../index.ts):
 *  - core Subscriber `cached`: the topics re-subscribed on the next relay
 *    connect;
 *  - sign-client Engine `sessionRequestQueue` ({ state, queue }) and
 *    `emittedSessionRequests` (a LimitedSet over a private `set`).
 * An SDK upgrade that renamed or moved them would make those writes silent
 * no-ops. This test reads the TypeScript sources of the installed packages
 * (from their source maps) and checks, in the files that own them, that each
 * field is still declared and still does what the purge relies on.
 */
import { readFileSync } from 'fs';
import path from 'path';

// The packages' exports hide package.json and the maps from require.resolve,
// so locate them from the repository root.
const ROOT = path.join(__dirname, '../../../..');
const packageDir = (name: string) => path.join(ROOT, 'node_modules', name);

/** The source of `file` (relative to the package's src/) in its dist map. */
function sdkSource(name: string, file: string): string {
  const map = JSON.parse(
    readFileSync(path.join(packageDir(name), 'dist/index.cjs.map'), 'utf8')
  ) as { sources: string[]; sourcesContent: (string | null)[] };
  const matches = map.sources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => source.endsWith(`/src/${file}`));
  if (matches.length !== 1)
    throw new Error(`${name}: ${matches.length} sources named src/${file}`);
  const content = map.sourcesContent[matches[0].index];
  if (!content) throw new Error(`${name}: no source content for ${file}`);
  return content;
}

/**
 * The text of one class member: from its declaration to the next member
 * declared at the same indentation.
 */
function member(source: string, declaration: RegExp): string {
  const start = source.search(declaration);
  if (start < 0) throw new Error(`no member matching ${declaration}`);
  const rest = source.slice(start + 1);
  const next = rest.search(
    /\n {2}(?:public|private|protected|get |set |static |async )/
  );
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The names the purge writes, kept in one place: a renamed field is one edit
// here away from showing up as a failure.
const CACHED = 'cached';
const REQUEST_QUEUE = 'sessionRequestQueue';
const EMITTED = 'emittedSessionRequests';
const LIMITED_SET_FIELD = 'set';

const CORE = '@walletconnect/core';
const SIGN = '@walletconnect/sign-client';

describe('installed WalletConnect SDK, the fields the wipe purge writes', () => {
  it('core, sign-client and utils are the versions package.json pins', () => {
    const pins = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8')
    ).dependencies as Record<string, string>;
    for (const name of [CORE, SIGN, '@walletconnect/utils']) {
      const installed = JSON.parse(
        readFileSync(path.join(packageDir(name), 'package.json'), 'utf8')
      ).version;
      expect(`${name}@${installed}`).toBe(`${name}@${pins[name]}`);
    }
  });

  describe('core Subscriber (src/controllers/subscriber.ts)', () => {
    const source = sdkSource(CORE, 'controllers/subscriber.ts');
    const field = escape(CACHED);

    it(`keeps the topics it drops on disconnect in \`${CACHED}\``, () => {
      expect(source).toMatch(
        new RegExp(`\\n {2}private ${field}: [^=\\n]+= \\[\\];`)
      );
      // A disconnect moves the live subscriptions into it.
      const onDisable = member(source, /\n {2}private onDisable\(\)/);
      expect(onDisable).toMatch(new RegExp(`this\\.${field} = this\\.values`));
      expect(onDisable).toContain('this.subscriptions.clear()');
    });

    it(`re-subscribes from \`${CACHED}\` when the relay connects again`, () => {
      // The relayer's reconnect calls subscriber.start() ...
      const relayer = sdkSource(CORE, 'controllers/relayer.ts');
      expect(relayer).toMatch(/this\.subscriber\s*\.start\(\)/);
      // ... start() -> onConnect() -> restart() -> onRestart() ...
      expect(member(source, /\n {2}public start\b/)).toContain(
        'this.onConnect()'
      );
      expect(member(source, /\n {2}private async onConnect\(\)/)).toMatch(
        /await this\.restart\(\);\s*this\.reset\(\);/
      );
      expect(member(source, /\n {2}private restart\b/)).toContain(
        'this.onRestart()'
      );
      // ... which subscribes every cached topic, and only then is it emptied.
      const onRestart = member(source, /\n {2}private async onRestart\(\)/);
      expect(onRestart).toMatch(
        new RegExp(`const subs = \\[\\.\\.\\.this\\.${field}\\]`)
      );
      expect(onRestart).toContain('this.batchSubscribe(batch)');
      expect(member(source, /\n {2}private reset\(\)/)).toMatch(
        new RegExp(`this\\.${field} = \\[\\]`)
      );
    });

    it('keeps subscriptions still being made in the public `pending` map', () => {
      expect(source).toMatch(/\n {2}public pending = new Map</);
    });
  });

  describe('sign-client Engine (src/controllers/engine.ts)', () => {
    const source = sdkSource(SIGN, 'controllers/engine.ts');
    const queue = escape(REQUEST_QUEUE);
    const emitted = escape(EMITTED);

    it(`holds session requests in \`${REQUEST_QUEUE}\` with \`state\` and \`queue\``, () => {
      expect(source).toMatch(
        new RegExp(
          `\\n {2}private ${queue}: [^=]+= \\{\\s*state: ENGINE_QUEUE_STATES\\.idle,\\s*queue: \\[\\],\\s*\\};`
        )
      );
      // The purge writes the idle value as a literal.
      expect(sdkSource(SIGN, 'constants/engine.ts')).toMatch(/idle: "IDLE"/);
    });

    it(`emits the next request only while \`${REQUEST_QUEUE}\` is idle`, () => {
      const process = member(
        source,
        /\n {2}private processSessionRequestQueue\b/
      );
      expect(process).toMatch(
        new RegExp(
          `if \\(this\\.${queue}\\.state === ENGINE_QUEUE_STATES\\.active\\) \\{[^}]*return;`
        )
      );
      expect(process).toMatch(new RegExp(`this\\.${queue}\\.queue\\[0\\]`));
      const emit = member(source, /\n {2}private emitSessionRequest\b/);
      expect(emit).toMatch(
        new RegExp(`this\\.${queue}\\.state = ENGINE_QUEUE_STATES\\.active`)
      );
    });

    it(`skips ids already in \`${EMITTED}\`, a LimitedSet over \`${LIMITED_SET_FIELD}\``, () => {
      expect(source).toMatch(
        new RegExp(`\\n {2}private ${emitted} = new LimitedSet\\(`)
      );
      const emit = member(source, /\n {2}private emitSessionRequest\b/);
      expect(emit).toMatch(
        new RegExp(`this\\.${emitted}\\.has\\(request\\.id\\)`)
      );
      expect(emit).toMatch(
        new RegExp(`this\\.${emitted}\\.add\\(request\\.id\\)`)
      );

      const misc = sdkSource('@walletconnect/utils', 'misc.ts');
      const limitedSet = misc.slice(misc.indexOf('class LimitedSet'));
      const set = escape(LIMITED_SET_FIELD);
      expect(limitedSet).toMatch(new RegExp(`private ${set}: Set<T>;`));
      expect(limitedSet).toMatch(
        new RegExp(`return this\\.${set}\\.has\\(item\\)`)
      );
    });
  });

  describe('sign-client session-authenticate stores', () => {
    it('are core Stores on client.auth: requests, pairingTopics, authKeys', () => {
      expect(sdkSource(SIGN, 'client.ts')).toContain(
        'this.auth = new AuthStore('
      );
      const store = sdkSource(SIGN, 'controllers/authStore.ts');
      for (const name of ['authKeys', 'pairingTopics', 'requests'])
        expect(store).toMatch(
          new RegExp(`public ${name}: IAuth\\["${name}"\\];`)
        );
      for (const [file, cls] of [
        ['controllers/authKey.ts', 'AuthKey'],
        ['controllers/authPairingTopic.ts', 'AuthPairingTopic'],
        ['controllers/authRequest.ts', 'AuthRequest'],
      ])
        expect(sdkSource(SIGN, file)).toMatch(
          new RegExp(`export class ${cls} extends Store<`)
        );
    });
  });
});
