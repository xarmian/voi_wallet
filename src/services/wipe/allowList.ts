/**
 * TASK-469: what survives Delete Everything. Everything else in general storage
 * is removed (wipe by default).
 *
 * Rule for ALLOWED: a pure UI or network preference, or a public cache, keyed
 * by nothing identifying (no address, account, contact, message or token the
 * wallet owned). Each entry carries its reason. The guard test
 * (allowListPopulation.test.ts) fails on any storage key in src that is neither
 * kept here nor documented as wiped.
 *
 * Dependency-free so the guard test can read it without native storage.
 */

import { redactAddress } from '@/utils/logRedaction';

/** Exact general-storage keys kept, with the reason each one is kept. */
export const ALLOWED_KEYS: Readonly<Record<string, string>> = {
  '@voi_wallet_theme_mode': 'UI preference: light, dark or system',
  '@voi_wallet_nft_theme_enabled':
    'UI preference: a toggle; without a picked NFT the default theme shows',
  '@voi_wallet_nft_theme_palette_index': 'UI preference: palette choice',
  '@voi_wallet_nft_theme_background_enabled': 'UI preference: a toggle',
  '@voi_wallet_nft_theme_overlay_intensity': 'UI preference: a number',
  '@voi_wallet_nft_theme_mode': 'UI preference: light or dark',
  voi_selected_network: 'network preference',
  '@wallet-asset-sort-by': 'UI preference: asset list sort',
  '@wallet-asset-sort-order': 'UI preference: asset list sort',
  '@wallet-asset-filter-balance-threshold': 'UI preference: asset filter',
  '@wallet-asset-filter-value-threshold': 'UI preference: asset filter',
  '@wallet-asset-native-tokens-first': 'UI preference: asset list order',
  '@wallet-asset-network-filter': 'UI preference: asset network filter',
  '@voi_wallet_slippage_tolerance': 'swap preference: a number',
  'experimental-features': 'feature toggles, keyed by nothing',
  voi_rate_limits:
    'one record of send counts and reset times, keyed by nothing; a wipe must not reset the send limits',
  voi_device_installation_id:
    'the installation id (extension keeps it in general storage); kept so key derivation stays stable',
  __voi_encryption_key__:
    'extension only: the key its secure storage encrypts with is cached in memory, so removing it would make the next secure write unreadable after a restart',
};

/** General-storage key prefixes kept, with the reason. */
export const ALLOWED_PREFIXES: Readonly<Record<string, string>> = {
  '@voi_wallet_token_mappings':
    'public token-mapping cache (and its timestamp and version)',
  '@update/': 'app update dismissal and validation cache, keyed by update id',
};

/**
 * Kept because the wipe itself depends on them. Not user data.
 */
export const EXEMPT_KEYS: Readonly<Record<string, string>> = {
  voi_wipe_intent:
    'the wipe request; removed last, only when the wipe is complete',
  voi_secure_wiped:
    'tombstone: stops a wiped secret from being migrated back from a legacy copy',
  voi_wallet_wiped:
    'tombstone: stops the legacy wallet blob from being migrated back',
  voi_unknown_secure_writes:
    'journal of secure writes whose outcome is unknown; the secure wipe rewrites it',
  voi_wipe_secure_leftovers:
    'names (never values) of secure items a wipe could not delete, so the retry deletes them; removed only when the wipe is complete',
};

/** Secure-storage keys a wipe keeps. */
export const SECURE_KEEP: readonly string[] = ['voi_device_installation_id'];

/**
 * Secure-storage keys outside AccountSecureStorage.clearAll that the wipe
 * deletes by name (secure storage cannot be listed).
 */
export const SECURE_LEFTOVER_KEYS: Readonly<Record<string, string>> = {
  voi_wc_v1_session_key: 'the WalletConnect v1 session key',
  voi_transaction_cache: 'old secure copy of the transaction history cache',
  voi_rate_limits: 'old secure copy of the send limits record',
};

/**
 * Mobile secure storage records, in general storage, which secure keys hold a
 * value (key names only). A marker left for a key the wipe does not keep names
 * a secure item to delete.
 */
export const PRESENCE_SENTINEL_PREFIX = '__voi_ss_present__';

/** Extension secure storage keeps its encrypted items in general storage. */
export const EXTENSION_SECURE_PREFIX = '__secure__';

const allowedPrefixes = Object.keys(ALLOWED_PREFIXES);

const isKeptSecureName = (key: string, prefix: string) =>
  key.startsWith(prefix) && SECURE_KEEP.includes(key.slice(prefix.length));

/** True for a general-storage key the wipe leaves in place. */
export function isKeptKey(key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(ALLOWED_KEYS, key) ||
    Object.prototype.hasOwnProperty.call(EXEMPT_KEYS, key) ||
    allowedPrefixes.some((prefix) => key.startsWith(prefix)) ||
    isKeptSecureName(key, PRESENCE_SENTINEL_PREFIX) ||
    isKeptSecureName(key, EXTENSION_SECURE_PREFIX)
  );
}

/**
 * Prefixes followed by an address, a topic or another identifier. An unresolved
 * key reported by the wipe keeps the prefix; the rest is redacted.
 */
const IDENTIFYING_PREFIXES = [
  '@messages/hidden/',
  '@messages/committedid/',
  '@messages/',
  '@claimable/hidden/',
  '@voiwallet:wc_v1_sessions:',
];

/** A storage key name safe to report: identifiers after a known prefix are redacted. */
export function redactKeyName(key: string): string {
  const prefix = IDENTIFYING_PREFIXES.find((p) => key.startsWith(p));
  if (prefix) return `${prefix}${redactAddress(key.slice(prefix.length))}`;
  // Any full address elsewhere in an unknown key.
  return key.replace(/[A-Z2-7]{58}/g, (address) => redactAddress(address));
}
