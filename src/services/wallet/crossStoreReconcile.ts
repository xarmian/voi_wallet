// TASK-222 — boot reconcile: repair cross-store secret/metadata half-state.
//
// Component 3 of the cross-store reset-hardening design (DOC-221; follows the
// TASK-220 primitives — durable pending-creation journal, in-memory reset
// generation, wipe tombstone — and the TASK-213 strict-read family). A crash
// mid-`storeAccount` (secret written, wallet-metadata not yet) or a reset that
// tears down one store but dies before the other can leave a durable half-state
// the live guards cannot catch on their own: an orphaned secret (present in the
// secure store, no matching wallet-blob account) or a phantom account (a blob
// STANDARD account whose secret is gone). This runs ONCE at boot and repairs it.
//
// FAIL-CLOSED is the whole safety story. The repair is DESTRUCTIVE (it deletes
// secrets and prunes accounts), and it infers "delete" from ABSENCE — so a
// swallowed read failure reported as "absent" would mass-delete live accounts.
// Every read/probe here is STRICT (propagates on failure/timeout). The pass is
// two-phase: gather EVERY read + probe first; if ANY of them throws, ABORT the
// whole thing having deleted NOTHING. Only when the entire picture is known
// without error does the destructive phase run.
//
// Invariant repaired (DOC-221): for every STANDARD account, `wallet-blob entry
// ⟺ secure secret exists`. Only STANDARD accounts hold a secret; WATCH / LEDGER
// / REKEYED / REMOTE_SIGNER accounts hold none and are never touched here.
//
// Bounded + never blocks boot: each probe is time-bounded, and the AuthContext
// caller additionally wraps the whole call in a timeout + best-effort catch, so
// a reconcile failure degrades to "no repair this boot", never a stuck splash.
//
// Logging is ids/status ONLY — never a key, mnemonic, or secret payload.

import { AccountSecureStorage } from '@/services/secure';

import { MultiAccountWalletService } from './index';

export interface ReconcileResult {
  /** false when Phase 1 hit a read/probe failure and the pass was aborted. */
  ran: boolean;
  orphanSecretsDeleted: string[];
  phantomAccountsPruned: string[];
  staleJournalDropped: string[];
}

const EMPTY_RESULT: ReconcileResult = {
  ran: false,
  orphanSecretsDeleted: [],
  phantomAccountsPruned: [],
  staleJournalDropped: [],
};

/**
 * Repair cross-store secret/metadata half-state, fail-closed. Safe to call once
 * at boot after the strict lock-determining reads succeed. Returns a summary; on
 * any strict read/probe failure it returns `{ ran: false }` having mutated
 * nothing. Presence-based — needs no unlock.
 */
export async function reconcileCrossStoreHalfState(): Promise<ReconcileResult> {
  // ── Phase 1: STRICT reads. Any throw here aborts the whole pass (delete
  // nothing). getStandardAccountIdsStrict / getAllAccountIds / the journal read
  // all propagate a storage failure; a corrupt wallet blob propagates too.
  const blobStandardIds =
    await MultiAccountWalletService.getStandardAccountIdsStrict();
  const accountListIds = await AccountSecureStorage.getAllAccountIds();
  const journal = await AccountSecureStorage.readPendingCreatesStrict();
  const journalIds = Object.keys(journal);

  const blobStandardSet = new Set(blobStandardIds);

  // Candidate universe: every id that could be half-committed in EITHER store.
  // The journal closes the unindexed-secret gap — a secret written just before a
  // crash is journaled even before it reaches the account list.
  const candidates = new Set<string>([
    ...blobStandardIds,
    ...accountListIds,
    ...journalIds,
  ]);

  // Probe EVERY candidate's secret presence before touching anything. A single
  // probe throw/timeout aborts — we never delete on a partially-read picture.
  const secretPresent = new Map<string, boolean>();
  for (const id of candidates) {
    secretPresent.set(
      id,
      await AccountSecureStorage.probeSecretPresenceStrict(id)
    );
  }

  // ── Phase 2: classify + act. Reached ONLY when every read/probe above
  // succeeded, so an "absent" below is a true absence, never a swallowed error.
  const orphanSecretIds: string[] = [];
  const phantomIds: string[] = [];
  const staleJournalIds: string[] = [];

  for (const id of candidates) {
    const hasSecret = secretPresent.get(id) === true;
    const inBlob = blobStandardSet.has(id);
    const inJournal = journal[id] !== undefined;

    if (hasSecret && !inBlob) {
      // Orphan secret: a live secret with no wallet-blob account. Delete the
      // secret (+ its secure metadata/list entry) and drop any journal entry.
      orphanSecretIds.push(id);
    } else if (!hasSecret && inBlob) {
      // Phantom account: a blob STANDARD account whose secret is gone. Prune it
      // from the blob (the account is unusable — no key to sign with).
      phantomIds.push(id);
    } else if (!hasSecret && !inBlob && inJournal) {
      // Stale journal entry: a never-completed / already-cleaned creation left a
      // journal id with no secret and no account. Drop the bookkeeping.
      staleJournalIds.push(id);
    }
    // hasSecret && inBlob → consistent; !hasSecret && !inBlob && !inJournal →
    // (an account-list-only ghost) not a repair target of this design; left as-is.
  }

  // Deletes: each acquires the key-mutation mutex, serialized against any secret
  // write. deleteAccount removes secret + secure metadata + account-list entry.
  for (const id of orphanSecretIds) {
    await AccountSecureStorage.deleteAccount(id);
  }
  // Drop journal entries for the orphans we just deleted AND the stale entries.
  const journalIdsToDrop = [...orphanSecretIds, ...staleJournalIds];
  if (journalIdsToDrop.length > 0) {
    await AccountSecureStorage.dropPendingCreateEntries(journalIdsToDrop);
  }
  // Prune phantoms from the wallet blob (empty ⇒ canonical clearAllWallets).
  if (phantomIds.length > 0) {
    await MultiAccountWalletService.pruneStandardAccounts(phantomIds);
  }

  if (
    orphanSecretIds.length > 0 ||
    phantomIds.length > 0 ||
    staleJournalIds.length > 0
  ) {
    // ids/status only — no key/mnemonic/secret material.
    console.log(
      `[bootReconcile] repaired cross-store half-state: ` +
        `${orphanSecretIds.length} orphan secret(s), ` +
        `${phantomIds.length} phantom account(s), ` +
        `${staleJournalIds.length} stale journal entr(ies)`
    );
  }

  return {
    ran: true,
    orphanSecretsDeleted: orphanSecretIds,
    phantomAccountsPruned: phantomIds,
    staleJournalDropped: staleJournalIds,
  };
}

/** The aborted-pass result, exported for the caller's logging/telemetry. */
export const RECONCILE_ABORTED = EMPTY_RESULT;
