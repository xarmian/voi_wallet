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
 * at boot after the strict lock-determining reads succeed. Presence-based — needs
 * no unlock.
 *
 * Two phases with different failure semantics:
 *  - Phase 1 (reads/probes) is STRICT and all-or-nothing: any failure THROWS
 *    (rejects) before any mutation, so the pass deletes nothing on a bad read.
 *  - Phase 2 (mutations) is BEST-EFFORT: it never throws; the resolved summary
 *    reports the repairs that ACTUALLY completed, so a later-step failure cannot
 *    discard a verdict-affecting prune the caller must react to. Remaining repairs
 *    are retried next boot.
 */
export async function reconcileCrossStoreHalfState(): Promise<ReconcileResult> {
  // ── Phase 1: STRICT reads. Any throw here aborts the whole pass (delete
  // nothing). getStandardAccountIdsStrict / readAccountListStrict / the journal
  // read all propagate a storage failure; a corrupt wallet blob propagates too.
  // readAccountListStrict (not getAllAccountIds) is READ-ONLY — getAllAccountIds
  // migrates a legacy list (write + delete), which would mutate the store during
  // this abort-safe read phase (Codex P2).
  const blobStandardIds =
    await MultiAccountWalletService.getStandardAccountIdsStrict();
  const accountListIds = await AccountSecureStorage.readAccountListStrict();
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

  // Probe EVERY candidate's secret presence before touching anything. Run the
  // probes CONCURRENTLY (Promise.all) so Phase 1 wall-clock is one probe deep, not
  // the sum over N candidates — otherwise a multi-account device can be starved by
  // the caller's boot timeout and never actually repair. Fail-closed is preserved:
  // Promise.all rejects on the FIRST probe throw/timeout, so the whole pass aborts
  // before any mutation — we never delete on a partially-read picture.
  const candidateList = [...candidates];
  const presence = await Promise.all(
    candidateList.map((id) =>
      AccountSecureStorage.probeSecretPresenceStrict(id)
    )
  );
  const secretPresent = new Map<string, boolean>(
    candidateList.map((id, i) => [id, presence[i]])
  );

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

  // Phase 2 is BEST-EFFORT and reports what it ACTUALLY completed. Fail-closed is
  // a Phase-1 property (never delete on a bad read); once Phase 1 passed cleanly,
  // a Phase-2 mutation FAILURE is a storage error, not a safety issue. Crucially,
  // a later-step failure must NOT discard the outcome: if a phantom prune already
  // emptied the wallet and then an orphan delete throws, the caller still needs to
  // see phantomAccountsPruned so it can refresh the (now stale) lock verdict (Codex
  // P2). So track completed work and return it even if a step throws.
  const phantomsPruned: string[] = [];
  const orphansDeleted: string[] = [];
  const journalDropped: string[] = [];
  try {
    // Prune phantoms FIRST — the only mutation that can change the boot lock
    // verdict (emptying the wallet ⇒ canonical clearAllWallets) — so the
    // verdict-affecting change is committed as early as possible.
    if (phantomIds.length > 0) {
      await MultiAccountWalletService.pruneStandardAccounts(phantomIds);
      phantomsPruned.push(...phantomIds);
    }
    // Deletes: each acquires the key-mutation mutex, serialized against any secret
    // write. deleteAccount removes secret + secure metadata + account-list entry.
    for (const id of orphanSecretIds) {
      await AccountSecureStorage.deleteAccount(id);
      orphansDeleted.push(id);
    }
    // Drop journal entries for the orphans we just deleted AND the stale entries.
    const journalIdsToDrop = [...orphansDeleted, ...staleJournalIds];
    if (journalIdsToDrop.length > 0) {
      await AccountSecureStorage.dropPendingCreateEntries(journalIdsToDrop);
      journalDropped.push(...journalIdsToDrop);
    }
  } catch (error) {
    // A Phase-2 repair failed after Phase 1 passed cleanly. Keep the partial
    // outcome (below) so the caller can still refresh the verdict; the remaining
    // repairs are retried on the next boot. ids/status only — no secret material.
    console.warn('[bootReconcile] Phase 2 repair partially failed:', error);
  }

  if (
    orphansDeleted.length > 0 ||
    phantomsPruned.length > 0 ||
    journalDropped.length > 0
  ) {
    // ids/status only — no key/mnemonic/secret material.
    console.log(
      `[bootReconcile] repaired cross-store half-state: ` +
        `${orphansDeleted.length} orphan secret(s), ` +
        `${phantomsPruned.length} phantom account(s), ` +
        `${journalDropped.length} journal entr(ies) dropped`
    );
  }

  return {
    ran: true,
    orphanSecretsDeleted: orphansDeleted,
    phantomAccountsPruned: phantomsPruned,
    staleJournalDropped: staleJournalIds.filter((id) =>
      journalDropped.includes(id)
    ),
  };
}

/** The aborted-pass result, exported for the caller's logging/telemetry. */
export const RECONCILE_ABORTED = EMPTY_RESULT;
