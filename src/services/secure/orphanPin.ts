import { AccountSecureStorage } from './AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';

export const ORPHAN_PIN_UNVERIFIABLE_MESSAGE =
  "We couldn't verify your wallet's security state. Please restart the app.";

const STRICT_READ_TIMEOUT_MS = 1500;

// TASK-413: bound a strict READ so a wedged store can't leave the submit
// spinning with Back hidden; the abandoned read is harmless. Mutations
// (reconcile repairs, deletePin) are never bounded: an abandoned deletePin
// that lands late could race a retry that has already set a new PIN.
export const withStrictReadTimeout = <T>(promise: Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('orphan PIN strict read timed out')),
      STRICT_READ_TIMEOUT_MS
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

// TASK-417: onboarding entry points that skip SecuritySetup when a PIN exists
// must route there for an orphan PIN too, so its healer (clearOrphanPin) runs.
// Onboarding history can remain reachable for a real wallet. A PIN is orphaned
// only when there are no accounts at all, including watch/Ledger/remote accounts.
// Strict and bounded; a read failure rejects (callers fail closed).
export async function onboardingNeedsSecuritySetup(): Promise<boolean> {
  if (!(await withStrictReadTimeout(AccountSecureStorage.hasPinStrict()))) {
    return true;
  }
  return (
    (await withStrictReadTimeout(
      MultiAccountWalletService.hasWalletWithAccountsStrict()
    )) === false
  );
}

// TASK-413 DR-1: drain failed-import orphans, then strictly verify no keys remain.
export async function clearOrphanPin(): Promise<void> {
  try {
    if (
      (await withStrictReadTimeout(
        MultiAccountWalletService.hasKeyBearingAccountStrict()
      )) !== false
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
  const accountIds = await withStrictReadTimeout(
    AccountSecureStorage.readAccountListStrict()
  );
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
