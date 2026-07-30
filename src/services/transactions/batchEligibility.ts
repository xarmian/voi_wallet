/**
 * Shared ARC-0001 batch-entry eligibility.
 *
 * TASK-259 widens eligibility from "the single reviewed account" (DR-13) to the
 * dApp's real `signers` across every session-approved account the wallet can
 * sign for. That widening is only safe because the review screen now NAMES every
 * account that will sign, and the two must never be able to disagree.
 *
 * They cannot disagree because this module is the ONE implementation both sides
 * run: `UniversalTransactionSigningScreen` calls it to build the signer list it
 * displays, and `UnifiedTransactionSigner` calls it again — with the very list
 * the screen displayed — immediately before a key is touched. Re-running it at
 * sign time can only ever REMOVE entries (the live session is re-resolved and
 * the approved set can only shrink), so an entry can be shown and then declined,
 * but never signed without being shown.
 *
 * Kept in its own module, free of the SecureKeyManager / algosdk-signing import
 * graph, so the review screen can share it without pulling in the signer.
 */

import type { NetworkId } from '@/types/network';
import type { WalletTransaction } from '@/services/walletconnect/types';

/**
 * DR-5 / DR-7 / DR-14 — the WalletConnect session an incoming dApp batch is
 * bound to.
 *
 * Resolved once at the request boundary (`TransactionRequestScreen`) and
 * threaded through navigation to the signer, which re-checks EVERY entry
 * against it before a key is touched. Authorization is chain-scoped (DR-14): a
 * session may approve address A on Voi but not on Algorand, so membership is
 * tested on the full CAIP-10 string, never on the bare address.
 */
export interface WalletConnectSessionBinding {
  /** Session topic the request arrived on. */
  topic: string;
  /** CAIP-2 chain the request is scoped to, e.g. `algorand:<32-char gh>`. */
  chainId: string;
  /**
   * NetworkId resolved from `chainId` at the boundary. Threaded into
   * `SecureKeyManager.signTransaction` so rekey authority is resolved against
   * the TRANSACTION's network rather than the app's active one.
   */
  networkId: NetworkId;
  /**
   * Full CAIP-10 accounts (`algorand:<chain>:<address>`) the live session
   * approved FOR `chainId`. Never substituted with local accounts: an absent,
   * disconnected, topic-mismatched or empty set is a rejection.
   */
  approvedAccounts: string[];
}

/**
 * Why an entry will NOT be signed. Every value has user-facing copy in
 * {@link describeDeclineReason} — a declined entry is always shown as declined,
 * with its reason, never silently dropped.
 */
export type BatchDeclineReason =
  /** Entry carries `msig`; this wallet only produces single-key signatures. */
  | 'multisig-unsupported'
  /** The session does not approve this sender on THIS chain (DR-5 / DR-14). */
  | 'not-session-approved'
  /** `signers: []` — the dApp explicitly asked us not to sign (DR-2). */
  | 'dapp-excluded'
  /** A non-empty `signers` list that does not designate this entry (DR-2). */
  | 'not-designated'
  /**
   * The sender is not among the accounts the user reviewed as signers. The
   * review screen resolves the specific cause (not our account / no signing key
   * / incompatible signing method) and displays that instead of this generic
   * reason; the signer only needs the fact.
   */
  | 'not-a-reviewed-signer';

export type BatchEntryEligibility =
  | { eligible: true }
  | { eligible: false; reason: BatchDeclineReason };

const ELIGIBLE: BatchEntryEligibility = { eligible: true };

/**
 * Decide whether a WalletConnect batch entry may be signed by this wallet.
 *
 * The signing KEY is never chosen here — `SecureKeyManager` derives it from the
 * DECODED sender and resolves on-chain rekey authority itself. This gates
 * ELIGIBILITY only, and request metadata (`authAddr` / `signers`) never selects
 * a key (TASK-163).
 *
 * Evaluated in order, all must pass (DR-2 / DR-5 / DR-13 / DR-14):
 *  0. an `msig` entry is asking for a partial multisig signature this wallet has
 *     no path to produce, so the honest ARC-0001 answer is `null`.
 *  1. the sender is authorized by the SESSION for THIS chain. Membership is
 *     tested on the full CAIP-10 string, so a Voi-only approval for A cannot
 *     authorize an Algorand transaction from A.
 *  2. `signers: []` is an explicit do-not-sign instruction — never signed.
 *  3. a non-empty `signers` must designate this entry as ours. ARC-0001 encodes
 *     a REKEYED sender as `signers: [authAddr]`, so the entry's own advisory
 *     `authAddr` also satisfies the designation. That stays advisory: the key
 *     still comes from the sender via on-chain rekey resolution.
 *  4. the sender must be one of the accounts NAMED in the review screen's
 *     signer list. TASK-259 replaces DR-13's "the one reviewed account" with
 *     "every account the list showed", which is what makes the widening honest.
 */
export function evaluateBatchEntryEligibility(input: {
  /** Address decoded from the transaction bytes — never from request metadata. */
  txnSender: string;
  wtxn: WalletTransaction;
  /** `null` for an in-app batch the wallet built itself. */
  binding: WalletConnectSessionBinding | null;
  /** Accounts the review screen named as signers for this request. */
  reviewedSigners: readonly string[];
}): BatchEntryEligibility {
  const { txnSender, wtxn, binding, reviewedSigners } = input;

  // 0. No multisig signing path exists — SecureKeyManager only ever produces a
  //    single-key signature. Returning one for an `msig` entry would hand the
  //    dApp bytes that can never validate on chain.
  if (wtxn.msig) {
    return { eligible: false, reason: 'multisig-unsupported' };
  }

  // 1. Session authorization, chain-scoped (DR-5 / DR-14).
  if (binding) {
    const caipAccount = `${binding.chainId}:${txnSender}`;
    if (!binding.approvedAccounts.includes(caipAccount)) {
      return { eligible: false, reason: 'not-session-approved' };
    }
  }

  // 2/3. ARC-0001 `signers` semantics (DR-2).
  if (Array.isArray(wtxn.signers)) {
    if (wtxn.signers.length === 0) {
      return { eligible: false, reason: 'dapp-excluded' };
    }
    const designatesSender =
      wtxn.signers.includes(txnSender) ||
      (!!wtxn.authAddr && wtxn.signers.includes(wtxn.authAddr));
    if (!designatesSender) {
      return { eligible: false, reason: 'not-designated' };
    }
  }

  // 4. Only an account the user actually saw named as a signer.
  if (!reviewedSigners.includes(txnSender)) {
    return { eligible: false, reason: 'not-a-reviewed-signer' };
  }

  return ELIGIBLE;
}

/**
 * User-facing copy for a decline. Used by the review screen so a declined entry
 * reads as declined WITH a reason rather than disappearing from the list.
 */
export function describeDeclineReason(reason: BatchDeclineReason): string {
  switch (reason) {
    case 'multisig-unsupported':
      return 'Declined — multisig entries are not supported by this wallet';
    case 'not-session-approved':
      return 'Declined — this account is not approved by the dApp session on this network';
    case 'dapp-excluded':
      return 'Declined — the dApp asked another wallet to sign this one';
    case 'not-designated':
      return 'Declined — the dApp did not designate this account as a signer';
    case 'not-a-reviewed-signer':
      return 'Declined — this wallet is not signing for this account';
  }
}
