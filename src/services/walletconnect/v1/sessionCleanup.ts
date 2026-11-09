/**
 * The ONE way to delete WalletConnect v1 session state (PLAN-260).
 *
 * WHY THIS MODULE EXISTS: a v1 session is spread across two stores — routing
 * metadata in AsyncStorage and the symmetric key in secure storage. Deleting one
 * without the other leaves a specific, known failure:
 *
 *   - metadata without the key -> an orphan in a store that cannot be
 *     enumerated, lingering until some future pairing happens to overwrite it.
 *
 * Review of this work found the same omission at four separate deletion sites in
 * a row, each fixed individually. That is a design smell, not four bugs: the
 * cleanup was scattered, so every new deletion path started out wrong by
 * default. Routing every deletion through here makes the complete cleanup the
 * path of least resistance instead of something each call site must remember.
 *
 * Any new code that removes a v1 session MUST go through this module.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { WC_V1_SESSION_STORAGE_KEY } from './config';
import {
  deleteSessionKeyForTopic,
  deleteSessionKeySlot,
} from './sessionKeyStore';

/** Recover the topic from an AsyncStorage row key. */
export function topicFromStorageKey(storageKey: string): string {
  return storageKey.replace(`${WC_V1_SESSION_STORAGE_KEY}:`, '');
}

/**
 * Delete one v1 session completely: its metadata row and — only if the secure
 * slot is actually bound to it — its key.
 *
 * The key deletion is TOPIC-CONDITIONAL because a session being deleted here may
 * not be the one the single slot belongs to. `connect()` retains the previous
 * session's storage while `config` already points at the new topic, so an
 * unconditional delete would destroy a RETAINED session's key.
 */
export async function deleteV1Session(topic: string): Promise<void> {
  await AsyncStorage.removeItem(`${WC_V1_SESSION_STORAGE_KEY}:${topic}`).catch(
    () => {}
  );
  await deleteSessionKeyForTopic(topic).catch(() => {});
}

/**
 * Delete MANY v1 sessions at once, for wipes that intentionally discard every
 * session (boot-restore give-up, the extension-mode startup purge, stale-row
 * pruning).
 *
 * Here the slot delete is UNCONDITIONAL when `dropSlot` is set: no session
 * survives, so there is no key worth protecting, and a topic-conditional delete
 * would strand the slot whenever it happened to be bound to one of the other
 * rows being removed.
 */
export async function deleteV1Sessions(
  storageKeys: string[],
  options: { dropSlot: boolean }
): Promise<void> {
  if (storageKeys.length === 0 && !options.dropSlot) {
    return;
  }

  if (storageKeys.length > 0) {
    await AsyncStorage.multiRemove(storageKeys).catch(() => {});
  }

  if (options.dropSlot) {
    await deleteSessionKeySlot().catch(() => {});
  }
}
