import { AccountSecureStorage } from './AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';

export const ORPHAN_PIN_UNVERIFIABLE_MESSAGE =
  "We couldn't verify your wallet's security state. Please restart the app.";

// TASK-413 DR-1: drain failed-import orphans, then strictly verify no keys remain.
export async function clearOrphanPin(): Promise<void> {
  try {
    if (
      (await MultiAccountWalletService.hasKeyBearingAccountStrict()) !== false
    ) {
      throw new Error(ORPHAN_PIN_UNVERIFIABLE_MESSAGE);
    }
    // TASK-413: snapshot the index before reconcile too. TASK-415 keeps a
    // failed secret delete indexed, so post alone suffices; pre ∪ post is a
    // second layer should any delete path ever unindex before it verifies.
    const before = await readCandidateIdsStrict();
    const result = await reconcileCrossStoreHalfState();
    if (result?.ran !== true) {
      throw new Error(ORPHAN_PIN_UNVERIFIABLE_MESSAGE);
    }
    const after = await readCandidateIdsStrict();

    // TASK-413: steps 3→4 are not under the key mutex. SecuritySetup's
    // synchronous submit guard is safe here: it guards the only creation path
    // live on this screen. These strict probes are authoritative; deletePin's
    // under-mutex guard is only a second layer (its reader swallows failures).
    for (const id of new Set([...before, ...after])) {
      if (
        (await AccountSecureStorage.probeSecretPresenceStrict(id)) !== false
      ) {
        throw new Error(ORPHAN_PIN_UNVERIFIABLE_MESSAGE);
      }
    }
    const deleted = await AccountSecureStorage.deletePin();
    if (deleted !== undefined) {
      throw new Error(ORPHAN_PIN_UNVERIFIABLE_MESSAGE);
    }
  } catch {
    throw new Error(ORPHAN_PIN_UNVERIFIABLE_MESSAGE);
  }

  // TASK-413 DR-1: try both cleanup operations even if either one fails.
  try {
    await AccountSecureStorage.clearBiometricSecret();
  } catch {
    console.warn(
      'Failed to clear biometric convenience during orphan PIN cleanup'
    );
  }
  try {
    await AccountSecureStorage.setBiometricEnabled(false);
  } catch {
    console.warn('Failed to disable biometrics during orphan PIN cleanup');
  }
}

// Strict account-list ∪ journal ids; any read failure or malformed shape throws.
async function readCandidateIdsStrict(): Promise<string[]> {
  const accountIds = await AccountSecureStorage.readAccountListStrict();
  const journal = await AccountSecureStorage.readPendingCreatesStrict();
  if (
    !Array.isArray(accountIds) ||
    !accountIds.every((id) => typeof id === 'string' && id !== '') ||
    journal === null ||
    typeof journal !== 'object' ||
    Array.isArray(journal) ||
    Object.keys(journal).some((id) => id === '') ||
    !Object.values(journal).every((token) => typeof token === 'string')
  ) {
    throw new Error(ORPHAN_PIN_UNVERIFIABLE_MESSAGE);
  }
  return [...accountIds, ...Object.keys(journal)];
}
