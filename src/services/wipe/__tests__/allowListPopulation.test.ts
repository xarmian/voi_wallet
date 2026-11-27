/**
 * TASK-469: every storage key the app writes is classified for the wipe.
 *
 * Static scan of src (tests excluded) for storage key constants, literal keys
 * passed to the storage APIs, and zustand persist names. Each must be kept
 * (allow-list or the wipe's own bookkeeping), in the documented wiped set below,
 * or a secure-only key the wipe deletes by name. A new key that is none of these
 * fails here until someone decides whether it survives Delete Everything.
 *
 * Secure storage cannot be listed, so every key written to it must be deleted
 * by name: by AccountSecureStorage.clearAll (read from its source, so a key
 * dropped from clearAll fails here), as a secure leftover, or kept on purpose.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import {
  ALLOWED_KEYS,
  ALLOWED_PREFIXES,
  EXEMPT_KEYS,
  EXTENSION_SECURE_PREFIX,
  PRESENCE_SENTINEL_PREFIX,
  SECURE_KEEP,
  SECURE_LEFTOVER_KEYS,
  isKeptKey,
} from '../allowList';
import { LEGACY_WALLET_SECURE_KEY } from '../constants';

const SRC = path.join(__dirname, '../../..');

/**
 * Wiped by default (nothing to do at runtime: anything not kept is removed).
 * Listed so a reviewer sees each one was decided, not missed.
 */
const KNOWN_WIPED_KEYS = new Set([
  // Contacts.
  '@friends/list',
  // The NFT picked for the theme names a token the previous wallet owned.
  '@voi_wallet_nft_theme',
  '@voi_wallet_nft_theme_colors',
  // Remote signer pairing and mode.
  '@voi_remote_signer_mode',
  '@voi_signer_config',
  '@voi_paired_signers',
  '@voi_processed_requests',
  // Ledger devices.
  'voi_wallet_ledger_devices_v1',
  // WalletConnect.
  '@walletconnect_handled_v1',
  '@walletconnect_transaction_queue',
  '@walletconnect_queue_processing',
  '@voiwallet:wc_v1_sessions',
  // Balance and history caches.
  '@voi_wallet_balance_cache_v2',
  '@voi_wallet_multi_network_balance_cache',
  'voi_transaction_cache',
  // Notifications.
  '@voi_wallet/last_handled_notification',
  // PIN settings and setup markers.
  'voi_pin_timeout_minutes',
  'voi_custom_pin_timeout',
  'pin_setup_pending',
  'voi_reconcile_recovery_required',
  // Account bookkeeping (clearAll removes these too; the sweep is the backstop).
  'voi_account_list',
  'voi_wallet_pin',
  'voi_wallet_salt',
  'voi_biometric_enabled',
  'voi_pin_timeout_setting',
  'voi_pending_account_creates',
  'voi_reconcile_quarantined_ids',
  'voi_reconcile_quarantine_scan',
  'voi_reconcile_quarantine_notice_seen',
  'voi_reconcile_unexplained_removals',
  // The wallet blob.
  'voi_wallet_metadata',
  // Extension only.
  'voi_wallet_pending_wc_uri',
  'voi_webauthn_credential',
  'voi_webauthn_challenge',
]);
const KNOWN_WIPED_PREFIXES = [
  '@messages/',
  '@claimable/hidden/',
  'voi_account_',
  'wc@2:',
  EXTENSION_SECURE_PREFIX,
  PRESENCE_SENTINEL_PREFIX,
];

/** Constants whose names look like storage keys but are not, with why. */
const NOT_STORAGE_KEYS = new Set([
  'AT_REST_DEVICE_TWEAK_PREFIX', // a KDF domain tweak
  'PENDING_PLACEHOLDER_PREFIX', // a message id prefix
  'WC_GLOBAL_CORE_KEY', // a globalThis property
  'KDF_DOMAIN_DECRYPTION_KEY', // a KDF domain string
  'KEY_REGISTRATION_PREFIX', // an on-chain note prefix
  'MESSAGE_NOTE_PREFIX', // an on-chain note prefix
  'MESSAGE_NOTE_PREFIX_V1', // an on-chain note prefix
  'MESSAGING_CHALLENGE_PREFIX', // a signed challenge prefix
  'HMAC_KEY_TWEAK', // a KDF domain tweak
  'ADDED_WITHOUT_KEY_TEXT', // user-facing copy
  'KEY_UNREADABLE_TEXT', // user-facing copy
  'KEY_PROBLEM_TEXT', // user-facing copy
  'KEY_UNREADABLE_ADVICE', // user-facing copy
  'IPFS_SCHEME_PREFIX', // a URL scheme
  'SUPABASE_ANON_KEY', // an API key
]);

/** SDK constants imported by messagesRetention.ts (wc@2 storage prefixes). */
const EXTERNAL_CONSTANTS: Record<string, string> = {
  CORE_STORAGE_PREFIX: 'wc@2:core:',
  SIGN_CLIENT_STORAGE_PREFIX: 'wc@2:client:',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === '__mocks__') continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Found {
  value: string;
  where: string;
}

const files = sourceFiles(SRC).map((file) => ({
  file: path.relative(SRC, file),
  // Comments (block, and whole-line //) are not code: an example key in a doc
  // comment is not a write.
  text: readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, ''),
}));

const KEYISH_NAME = /(^|_)(KEY|PREFIX|SLOT)(_|$)/;
const CONSTANT_RE =
  /(?:const|readonly)\s+([A-Z][A-Z0-9_]*)\s*=\s*(['`])([^'`]*)\2/g;

// Pass 1: every keyish constant, by file and globally.
const constantsByFile = new Map<string, Map<string, string>>();
const globalConstants = new Map<string, string>();
for (const { file, text } of files) {
  const local = new Map<string, string>();
  for (const match of text.matchAll(CONSTANT_RE)) {
    local.set(match[1], match[3]);
    globalConstants.set(match[1], match[3]);
  }
  constantsByFile.set(file, local);
}

function resolve(file: string, raw: string): string {
  let value = raw;
  for (let i = 0; i < 5 && value.includes('${'); i++) {
    value = value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (whole, name) => {
      const local = constantsByFile.get(file)?.get(name);
      return (
        local ?? EXTERNAL_CONSTANTS[name] ?? globalConstants.get(name) ?? whole
      );
    });
  }
  // Anything still unresolved is a runtime part: keep the fixed head as a prefix.
  const cut = value.indexOf('${');
  return cut === -1 ? value : value.slice(0, cut);
}

// Pass 2: the key population.
const found: Found[] = [];
for (const { file, text } of files) {
  for (const match of text.matchAll(CONSTANT_RE)) {
    const name = match[1];
    if (!KEYISH_NAME.test(name) || NOT_STORAGE_KEYS.has(name)) continue;
    found.push({ value: resolve(file, match[3]), where: `${file} ${name}` });
  }
  for (const block of text.matchAll(/STORAGE_KEYS\s*=\s*\{([\s\S]*?)\}/g)) {
    for (const member of block[1].matchAll(/([A-Z][A-Z0-9_]*):\s*'([^']*)'/g))
      found.push({ value: member[2], where: `${file} ${member[1]}` });
  }
  for (const call of text.matchAll(
    /\.(?:setItem|getItem|removeItem)\(\s*'([^']+)'/g
  ))
    found.push({ value: call[1], where: `${file} literal` });
  if (/\bpersist\(/.test(text) && text.includes('zustand/middleware')) {
    for (const name of text.matchAll(/\bname:\s*'([^']+)'/g))
      found.push({ value: name[1], where: `${file} persist name` });
  }
}

// Secure coverage, read from clearAll's source.
const accountStorage = files.find(
  (f) => f.file === 'services/secure/AccountSecureStorage.ts'
)!;
const accountConstants = constantsByFile.get(accountStorage.file)!;
const clearAllBody = accountStorage.text.slice(
  accountStorage.text.indexOf('static async clearAll(): Promise<void> {')
);
const secureDeleteList =
  clearAllBody.match(/const secureDeletes = \[([\s\S]*?)\];/)?.[1] ?? '';
const clearedByName = [
  ...[...secureDeleteList.matchAll(/this\.([A-Z_]+)/g)].map((m) => m[1]),
  ...[...clearAllBody.matchAll(/boundedSecureDelete\(this\.([A-Z_]+)\)/g)].map(
    (m) => m[1]
  ),
].map((name) => accountConstants.get(name)!);
const SECURE_COVERED_KEYS = new Set([
  ...clearedByName,
  ...Object.keys(SECURE_LEFTOVER_KEYS),
  ...SECURE_KEEP,
  LEGACY_WALLET_SECURE_KEY,
]);
// clearAll deletes every listed and journaled account through deleteAccountLocked.
const SECURE_COVERED_PREFIXES = clearAllBody.includes(
  'this.deleteAccountLocked('
)
  ? [
      accountConstants.get('STORAGE_KEY_PREFIX')!,
      accountConstants.get('LEGACY_STORAGE_KEY_PREFIX')!,
    ]
  : [];

const isKnownWiped = (value: string) =>
  KNOWN_WIPED_KEYS.has(value) ||
  KNOWN_WIPED_PREFIXES.some((prefix) => value.startsWith(prefix));
const isSecureCovered = (value: string) =>
  SECURE_COVERED_KEYS.has(value) ||
  SECURE_COVERED_PREFIXES.some((prefix) => value.startsWith(prefix));

test('the scan sees the population (guards against a scan that silently finds nothing)', () => {
  const values = new Set(found.map((f) => f.value));
  for (const expected of [
    '@friends/list',
    '@messages/',
    'voi_wallet_pin',
    'experimental-features',
    '@wallet-asset-network-filter',
    'wc@2:core:',
    '@voi_wallet_multi_network_balance_cache',
  ])
    expect(values).toContain(expected);
});

test('every storage key is kept, documented as wiped, or a secure key deleted by name', () => {
  const unclassified = found
    .filter(
      ({ value }) =>
        !isKeptKey(value) && !isKnownWiped(value) && !isSecureCovered(value)
    )
    .map(({ value, where }) => `${where}: ${value}`);
  expect(unclassified).toEqual([]);
});

test('no key is both kept and documented as wiped', () => {
  const both = [...KNOWN_WIPED_KEYS].filter((key) => isKeptKey(key));
  expect(both).toEqual([]);
});

test('every allow-list, exempt and secure-leftover entry names a key the code uses', () => {
  const values = new Set(found.map((f) => f.value));
  const exact = [
    ...Object.keys(ALLOWED_KEYS),
    ...Object.keys(EXEMPT_KEYS),
    ...Object.keys(SECURE_LEFTOVER_KEYS),
    ...SECURE_KEEP,
  ].filter((key) => !values.has(key));
  const prefixes = Object.keys(ALLOWED_PREFIXES).filter(
    (prefix) => ![...values].some((value) => value.startsWith(prefix))
  );
  const stale = [...exact, ...prefixes];
  expect(stale).toEqual([]);
});

test('every key written to secure storage is deleted by name or kept on purpose', () => {
  // The adapters themselves take the key as a parameter.
  const ADAPTERS = new Set([
    'platform/index.ts',
    'platform/mobile/secureStorage.ts',
    'platform/extension/secureStorage.ts',
  ]);
  const uncovered: string[] = [];
  let sites = 0;
  for (const { file, text } of files) {
    if (ADAPTERS.has(file)) continue;
    for (const match of text.matchAll(
      /(?:secureStorage|mobileSecureStorage)\.(?:setItem|setItemWithAuth)\(\s*([^,]+),|boundedSecureSet\(\s*([^,]+),/g
    )) {
      const arg = (match[1] ?? match[2]).trim();
      if (/^key: string$/.test(arg)) continue; // the helper's own signature
      sites += 1;
      let value: string | undefined;
      const own = arg.match(/^this\.([A-Z][A-Z0-9_]*)$/);
      if (own) value = constantsByFile.get(file)?.get(own[1]);
      else if (/^this\.secretKey\(/.test(arg))
        value = accountConstants.get('STORAGE_KEY_PREFIX');
      else if (/^[A-Z][A-Z0-9_]*$/.test(arg))
        value = constantsByFile.get(file)?.get(arg) ?? globalConstants.get(arg);
      if (value === undefined || !isSecureCovered(value))
        uncovered.push(`${file}: ${arg} -> ${value ?? '(unresolved)'}`);
    }
  }
  expect(sites).toBeGreaterThan(5);
  expect(uncovered).toEqual([]);
});

test('clearAll still deletes the PIN, salt and biometric secret by name (drift check)', () => {
  expect(clearedByName).toEqual(
    expect.arrayContaining([
      'voi_wallet_pin',
      'voi_wallet_salt',
      'voi_biometric_secret',
      'voi_pin_throttle',
    ])
  );
  expect(SECURE_COVERED_PREFIXES).toEqual([
    'voi_account_secret_',
    'voi_account_',
  ]);
});

test('the presence-marker and extension secure prefixes match the adapters', () => {
  const mobile = files.find(
    (f) => f.file === 'platform/mobile/secureStorage.ts'
  )!.text;
  expect(mobile).toContain(
    `const PRESENCE_SENTINEL_PREFIX = '${PRESENCE_SENTINEL_PREFIX}';`
  );
  const extension = files.find(
    (f) => f.file === 'platform/extension/secureStorage.ts'
  )!.text;
  expect(extension).toContain(
    `const SECURE_PREFIX = '${EXTENSION_SECURE_PREFIX}';`
  );
});
