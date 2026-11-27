/**
 * TASK-478 test helpers. Import only from a test file that has mocked
 * '@/platform' with createTask478Platform.
 */
import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { MultiAccountWalletService } from '@/services/wallet';
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';
import { AccountType } from '@/types/wallet';
import {
  registerFreshAuthPrompter,
  withFreshAuth,
  type FreshAuthCapability,
  type FreshAuthReason,
} from '@/services/secure/freshAuth';
import type { Task478PlatformState } from './task478Platform';

export const PIN = '123456';
/** The canary key. Its text must never reach a log, an error or storage. */
export const CANARY_MNEMONIC =
  'arena mountain vacuum tennis diesel insect erupt jungle end glad pink ticket dice drink time lobster still visa goose either embrace palace bronze above banana';
export const CANARY_ADDRESS =
  '6MJBANZKNJEMSSKGAFE26BTOIMY2PEKLNMKK2RWWGH6G6I7FDNQLOKXOZY';

export const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __state: Task478PlatformState;
  __reset: () => void;
};

export const SECRET = (id: string) => `voi_account_secret_${id}`;
export const LEGACY = (id: string) => `voi_account_${id}`;
export const REGISTRY_KEY = 'voi_reconcile_quarantined_ids';
export const SCAN_KEY = 'voi_reconcile_quarantine_scan';
export const SEEN_KEY = 'voi_reconcile_quarantine_notice_seen';

export type Orphan = { id: string; address: string; sk: Uint8Array };

export function keyFromMnemonic(mnemonic: string): Orphan['sk'] {
  return algosdk.mnemonicToSecretKey(mnemonic).sk;
}

export function newKey(mnemonic?: string): { address: string; sk: Uint8Array } {
  const account = mnemonic
    ? algosdk.mnemonicToSecretKey(mnemonic)
    : algosdk.generateAccount();
  return { address: account.addr.toString(), sk: account.sk };
}

function standardMeta(id: string, address: string, label: string) {
  return {
    id,
    address,
    publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
      'hex'
    ),
    type: AccountType.STANDARD,
    label,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    importedAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    mnemonic: '',
    hasBackup: false,
    backupVerified: false,
  } as never;
}

/** A key written by an interrupted create: the secret, its secure metadata and
 *  its account-list entry exist, the wallet blob never got the account. */
export async function writeUnboundKey(
  id: string,
  mnemonic?: string,
  label = `Lost ${id}`
): Promise<Orphan> {
  const { address, sk } = newKey(mnemonic);
  await AccountSecureStorage.storeAccountForCreation(
    standardMeta(id, address, label),
    sk.slice(),
    AccountSecureStorage.getResetGeneration()
  );
  return { id, address, sk };
}

export async function addWatch(address?: string, label = 'Watch') {
  return MultiAccountWalletService.addWatchAccount({
    type: AccountType.WATCH,
    address: address ?? algosdk.generateAccount().addr.toString(),
    label,
  });
}

/** One boot: the vault starts locked, the caches are empty, reconcile runs. */
export async function boot() {
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  return reconcileCrossStoreHalfState();
}

export function unlock() {
  SessionKeyVault.set(PIN, 'pin');
}

/**
 * The standard device: a PIN, a wallet holding only a WATCH account, and two
 * quarantined orphans: `v2` (rewrapped under the PIN before it was orphaned) and
 * `formatA` (a device-key envelope). The vault is left unlocked.
 */
export async function pinDeviceWithTwoOrphans(opts?: {
  formatAMnemonic?: string;
}) {
  await addWatch();
  await AccountSecureStorage.setupPin(PIN, 'pin');
  unlock();
  const v2 = await writeUnboundKey('orphan-v2');
  await AccountSecureStorage.migrateAccountToV2(v2.id, PIN, 'pin');
  const formatA = await writeUnboundKey('orphan-a', opts?.formatAMnemonic);
  const result = await boot();
  unlock();
  return { v2, formatA, result };
}

export const DECRYPTORS = [
  'decryptPrivateKey',
  'decryptPrivateKeyWithPin',
  'tryDecryptV2Blobs',
  'unwrapKeyForRewrap',
] as const;

/** Spies on the four functions that turn a stored payload into key bytes. */
export function spyDecryptors() {
  const target = AccountSecureStorage as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  const spies = Object.fromEntries(
    DECRYPTORS.map((name) => [name, jest.spyOn(target, name)])
  ) as Record<(typeof DECRYPTORS)[number], jest.SpyInstance>;
  return {
    spies,
    total: () =>
      DECRYPTORS.reduce((sum, name) => sum + spies[name].mock.calls.length, 0),
  };
}

/** Installs a prompter that answers `answer` (or throws), and returns its calls. */
export function installPrompter(answer: boolean | Error) {
  const calls: FreshAuthReason[] = [];
  const unregister = registerFreshAuthPrompter(async (reason) => {
    calls.push(reason);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { calls, unregister };
}

export function authed<T>(
  reason: FreshAuthReason,
  fn: (cap: FreshAuthCapability) => Promise<T>
): Promise<T> {
  return withFreshAuth(reason, fn);
}

export function readScanMap(): Record<string, unknown> | undefined {
  const raw = mockPlatform.__kv.get(SCAN_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

export function readRegistry(): string[] {
  const raw = mockPlatform.__kv.get(REGISTRY_KEY);
  return raw === undefined ? [] : JSON.parse(raw);
}

export async function slotState(id: string, address: string) {
  return (await AccountSecureStorage.inspectSecretSlot(id, address)).state;
}

export function resetAll() {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
}
