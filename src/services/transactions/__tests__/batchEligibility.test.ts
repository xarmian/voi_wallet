/**
 * TASK-259 — the ONE eligibility rule shared by the review screen and the
 * signer.
 *
 * The widening from "the single reviewed account" (DR-13) to the dApp's real
 * ARC-0001 `signers` is only safe because both sides run this exact function:
 * the screen to decide what it DISPLAYS, the signer to decide what it SIGNS.
 * These tests pin the rule and its evaluation ORDER — the order is what makes
 * the displayed decline reason the true reason.
 *
 * Pure logic; no key, signature or network involved.
 */

import { makeAccount } from '@/__tests__/fixtures/algorand';
import { NetworkId } from '@/types/network';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';
import type { WalletTransaction } from '@/services/walletconnect/types';

import {
  evaluateBatchEntryEligibility,
  describeDeclineReason,
  type BatchDeclineReason,
  type WalletConnectSessionBinding,
} from '../batchEligibility';

const CHAIN = NETWORK_CONFIGURATIONS[NetworkId.VOI_MAINNET].chainId;

const A = makeAccount('elig-a').addr;
const B = makeAccount('elig-b').addr;
const C = makeAccount('elig-c').addr;

function bindingFor(addresses: string[]): WalletConnectSessionBinding {
  return {
    topic: 'topic-under-test',
    chainId: CHAIN,
    networkId: NetworkId.VOI_MAINNET,
    approvedAccounts: addresses.map((address) => `${CHAIN}:${address}`),
  };
}

function evaluate(
  txnSender: string,
  wtxn: WalletTransaction,
  binding: WalletConnectSessionBinding | null,
  reviewedSigners: string[]
) {
  return evaluateBatchEntryEligibility({
    txnSender,
    wtxn,
    binding,
    reviewedSigners,
  });
}

const bare: WalletTransaction = { txn: 'unused-by-this-rule' };

describe('evaluateBatchEntryEligibility', () => {
  it('signs a session-approved, undesignated entry for a named signer', () => {
    expect(evaluate(A, bare, bindingFor([A]), [A])).toEqual({ eligible: true });
  });

  it('widens beyond one account: a second named signer is eligible', () => {
    const binding = bindingFor([A, B]);
    expect(evaluate(A, bare, binding, [A, B]).eligible).toBe(true);
    expect(evaluate(B, bare, binding, [A, B]).eligible).toBe(true);
  });

  it('declines a sender the screen did not name, even when session-approved', () => {
    // The exact hole the widening could have opened: the dApp designates B and
    // the session approves it, but the signer list only showed A.
    expect(
      evaluate(B, { ...bare, signers: [B] }, bindingFor([A, B]), [A])
    ).toEqual({ eligible: false, reason: 'not-a-reviewed-signer' });
  });

  it('declines a sender the session does not approve on THIS chain (DR-14)', () => {
    expect(evaluate(C, bare, bindingFor([A, B]), [A, B, C])).toEqual({
      eligible: false,
      reason: 'not-session-approved',
    });
  });

  it('never signs `signers: []` (DR-2)', () => {
    expect(evaluate(A, { ...bare, signers: [] }, bindingFor([A]), [A])).toEqual(
      {
        eligible: false,
        reason: 'dapp-excluded',
      }
    );
  });

  it('declines a non-empty `signers` that designates neither sender nor authAddr', () => {
    expect(
      evaluate(A, { ...bare, signers: [C] }, bindingFor([A]), [A])
    ).toEqual({
      eligible: false,
      reason: 'not-designated',
    });
  });

  it('accepts designation via the entry advisory authAddr (rekeyed sender)', () => {
    // ARC-0001 encodes a rekeyed sender as `signers: [authAddr]`, so the sender
    // is legitimately absent from its own list.
    expect(
      evaluate(A, { ...bare, signers: [B], authAddr: B }, bindingFor([A]), [A])
    ).toEqual({ eligible: true });
  });

  it('never signs an `msig` entry, ahead of every other check', () => {
    // msig is evaluated FIRST: even a fully approved, designated, named entry
    // is declined, because a single-key signature could never validate.
    expect(
      evaluate(
        A,
        { ...bare, msig: { subsig: [{ pk: 'x' }], thr: 1, v: 1 } },
        bindingFor([A]),
        [A]
      )
    ).toEqual({ eligible: false, reason: 'multisig-unsupported' });
  });

  it('reports the session failure ahead of the signers failure', () => {
    // Ordering matters for the displayed reason: an unapproved account that is
    // ALSO excluded by the dApp must read as unapproved.
    expect(
      evaluate(C, { ...bare, signers: [] }, bindingFor([A]), [A, C])
    ).toEqual({
      eligible: false,
      reason: 'not-session-approved',
    });
  });

  it('skips the session check for an in-app batch (no binding)', () => {
    expect(evaluate(A, bare, null, [A]).eligible).toBe(true);
    // ...but the named-signer rule still applies with no session to lean on.
    expect(evaluate(B, bare, null, [A])).toEqual({
      eligible: false,
      reason: 'not-a-reviewed-signer',
    });
  });

  it('compares the FULL CAIP-10 string, not the bare address', () => {
    const otherChain =
      NETWORK_CONFIGURATIONS[NetworkId.ALGORAND_MAINNET].chainId;
    const binding: WalletConnectSessionBinding = {
      topic: 't',
      chainId: CHAIN,
      networkId: NetworkId.VOI_MAINNET,
      // Approved on the OTHER chain only.
      approvedAccounts: [`${otherChain}:${A}`],
    };
    expect(evaluate(A, bare, binding, [A])).toEqual({
      eligible: false,
      reason: 'not-session-approved',
    });
  });
});

describe('describeDeclineReason', () => {
  const reasons: BatchDeclineReason[] = [
    'multisig-unsupported',
    'not-session-approved',
    'dapp-excluded',
    'not-designated',
    'not-a-reviewed-signer',
  ];

  it('gives every decline reason user-facing copy (no silent drops)', () => {
    for (const reason of reasons) {
      const text = describeDeclineReason(reason);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text.toLowerCase()).toContain('declined');
    }
  });
});
