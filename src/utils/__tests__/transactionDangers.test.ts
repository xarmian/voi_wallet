/**
 * Unit tests for src/utils/transactionDangers.ts
 *
 * These tests build REAL algosdk v3 transactions (no mocks) and prove that
 * `detectTransactionDangers` surfaces the fund-loss fields a malicious
 * dApp/deeplink can hide behind an otherwise normal-looking transaction:
 *   - asset-drain      -> asset close-out (assetTransfer.closeRemainderTo)
 *   - account-close    -> payment close   (payment.closeRemainderTo)
 *   - rekey / takeover -> rekeyTo
 *
 * The primary target is asset-drain (S-01 / TASK-108): an asset-transfer that
 * closes out the entire asset holding to an attacker. algosdk v3 stores that
 * address under `assetTransfer.closeRemainderTo` (same field name as a payment
 * close), NOT a top-level `assetCloseTo`. If detectTransactionDangers read the
 * wrong location it would SILENTLY miss the drain, so we assert both:
 *   (a) the built/decoded algosdk Transaction really carries the address in
 *       `assetTransfer.closeRemainderTo` (proves the vector independently), and
 *   (b) detectTransactionDangers reports it as `assetCloseTo` / dangerous.
 *
 * We exercise the SAME code path production uses: build -> encode -> base64 ->
 * `algosdk.decodeUnsignedTransaction` -> detectTransactionDangers (see
 * TransactionRequestScreen.tsx). A negative control (a normal asset transfer
 * with no close-to) asserts we do not over-warn.
 */

import algosdk from 'algosdk';

import { detectTransactionDangers, hasAnyDanger } from '../transactionDangers';

// Deterministic-enough suggested params. genesisHash is 32 zero bytes; these
// transactions are never submitted so the network identity is irrelevant.
const SUGGESTED_PARAMS = {
  fee: 1000,
  firstValid: 1,
  lastValid: 1001,
  genesisID: 'voi-test-v1',
  genesisHash: new Uint8Array(32),
  flatFee: true,
  minFee: 1000,
} as algosdk.SuggestedParams;

// A fixed asset id for the transfers (arbitrary; never hits a network).
const ASSET_ID = 12345;

type Account = ReturnType<typeof algosdk.generateAccount>;
const addrOf = (acct: Account): string => acct.addr.toString();

function makeAssetTransfer(
  sender: string,
  overrides: Record<string, unknown> = {}
): algosdk.Transaction {
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount: 0,
    assetIndex: ASSET_ID,
    suggestedParams: SUGGESTED_PARAMS,
    ...overrides,
  } as Parameters<
    typeof algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject
  >[0]);
}

function makePayment(
  sender: string,
  overrides: Record<string, unknown> = {}
): algosdk.Transaction {
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount: 0,
    suggestedParams: SUGGESTED_PARAMS,
    ...overrides,
  } as Parameters<
    typeof algosdk.makePaymentTxnWithSuggestedParamsFromObject
  >[0]);
}

/**
 * Round-trip a built transaction through the exact production decode path:
 * encode -> base64 -> decodeUnsignedTransaction. Returns the decoded Transaction
 * that production feeds to detectTransactionDangers.
 */
function roundTrip(txn: algosdk.Transaction): algosdk.Transaction {
  const bytes = algosdk.encodeUnsignedTransaction(txn);
  const base64 = Buffer.from(bytes).toString('base64');
  return algosdk.decodeUnsignedTransaction(Buffer.from(base64, 'base64'));
}

describe('detectTransactionDangers - asset-drain (asset close-out)', () => {
  it('flags a real asset close-out transaction (decoded production path)', () => {
    const owner = addrOf(algosdk.generateAccount());
    const attacker = addrOf(algosdk.generateAccount());

    const txn = makeAssetTransfer(owner, {
      receiver: attacker,
      amount: 0,
      closeRemainderTo: attacker, // sweeps the ENTIRE asset holding to attacker
    });
    const decoded = roundTrip(txn);

    // (a) Independently prove the vector: algosdk v3 stores the asset close-out
    //     address under assetTransfer.closeRemainderTo (NOT top-level assetCloseTo).
    expect(decoded.type).toBe(algosdk.TransactionType.axfer);
    expect(decoded.assetTransfer?.closeRemainderTo).toBeDefined();
    expect(decoded.assetTransfer!.closeRemainderTo!.toString()).toBe(attacker);
    // There is no top-level assetCloseTo field on the algosdk v3 Transaction.
    expect(
      (decoded as unknown as { assetCloseTo?: unknown }).assetCloseTo
    ).toBeUndefined();

    // (b) detectTransactionDangers surfaces it as assetCloseTo and reports danger.
    const dangers = detectTransactionDangers(decoded);
    expect(dangers.assetCloseTo).toBe(attacker);
    expect(hasAnyDanger(dangers)).toBe(true);
  });

  it('flags a freshly built (non-decoded) asset close-out transaction too', () => {
    const owner = addrOf(algosdk.generateAccount());
    const attacker = addrOf(algosdk.generateAccount());

    const txn = makeAssetTransfer(owner, {
      receiver: attacker,
      closeRemainderTo: attacker,
    });

    const dangers = detectTransactionDangers(txn);
    expect(dangers.assetCloseTo).toBe(attacker);
    expect(hasAnyDanger(dangers)).toBe(true);
  });

  it('NEGATIVE CONTROL: a normal asset transfer (no close-to) is not flagged', () => {
    const owner = addrOf(algosdk.generateAccount());
    const receiver = addrOf(algosdk.generateAccount());

    const txn = makeAssetTransfer(owner, {
      receiver,
      amount: 1,
    });
    const decoded = roundTrip(txn);

    // Vector sanity: no close-out present.
    expect(decoded.assetTransfer?.closeRemainderTo).toBeUndefined();

    const dangers = detectTransactionDangers(decoded);
    expect(dangers.assetCloseTo).toBeUndefined();
    expect(hasAnyDanger(dangers)).toBe(false);
  });
});

describe('detectTransactionDangers - no regression to other dangers', () => {
  it('still flags a payment account-close (payment.closeRemainderTo)', () => {
    const owner = addrOf(algosdk.generateAccount());
    const attacker = addrOf(algosdk.generateAccount());

    const txn = makePayment(owner, {
      receiver: attacker,
      closeRemainderTo: attacker, // closes the account, sweeps native balance
    });
    const decoded = roundTrip(txn);

    expect(decoded.payment?.closeRemainderTo?.toString()).toBe(attacker);

    const dangers = detectTransactionDangers(decoded);
    expect(dangers.closeRemainderTo).toBe(attacker);
    expect(dangers.assetCloseTo).toBeUndefined();
    expect(hasAnyDanger(dangers)).toBe(true);
  });

  it('still flags a rekey (rekeyTo) on a payment transaction', () => {
    const owner = addrOf(algosdk.generateAccount());
    const attacker = addrOf(algosdk.generateAccount());

    const txn = makePayment(owner, { rekeyTo: attacker });
    const decoded = roundTrip(txn);

    expect(decoded.rekeyTo?.toString()).toBe(attacker);

    const dangers = detectTransactionDangers(decoded);
    expect(dangers.rekeyTo).toBe(attacker);
    expect(hasAnyDanger(dangers)).toBe(true);
  });

  it('detects a rekey combined with an asset close-out on one txn', () => {
    const owner = addrOf(algosdk.generateAccount());
    const attacker = addrOf(algosdk.generateAccount());

    const txn = makeAssetTransfer(owner, {
      receiver: attacker,
      closeRemainderTo: attacker,
      rekeyTo: attacker,
    });
    const decoded = roundTrip(txn);

    const dangers = detectTransactionDangers(decoded);
    expect(dangers.assetCloseTo).toBe(attacker);
    expect(dangers.rekeyTo).toBe(attacker);
    expect(hasAnyDanger(dangers)).toBe(true);
  });

  it('returns an empty result (not dangerous) for null/undefined input', () => {
    expect(detectTransactionDangers(null)).toEqual({});
    expect(detectTransactionDangers(undefined)).toEqual({});
    expect(hasAnyDanger(detectTransactionDangers(null))).toBe(false);
  });
});

// TASK-440 audit #1 and #2: every dangerous operation, including asset
// authority changes on an existing asset.
describe('describeTransactionDangers', () => {
  const { describeTransactionDangers } = require('../transactionDangers');
  const SENDER = algosdk.generateAccount().addr.toString();
  const A = algosdk.generateAccount().addr.toString();
  const B = algosdk.generateAccount().addr.toString();
  const roundTrip = (txn: algosdk.Transaction) =>
    algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(txn));
  const acfg = (fields: Record<string, string | undefined>) =>
    roundTrip(
      algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
        sender: SENDER,
        assetIndex: 42,
        suggestedParams: SUGGESTED_PARAMS as any,
        strictEmptyAddressChecking: false,
        ...fields,
      } as any)
    );

  it('names the sender and target of a rekey and a close in one txn', () => {
    const txn = roundTrip(
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: SENDER,
        receiver: SENDER,
        amount: 0,
        closeRemainderTo: A,
        rekeyTo: B,
        suggestedParams: SUGGESTED_PARAMS as any,
      })
    );
    expect(describeTransactionDangers(txn)).toEqual([
      { sender: SENDER, kind: 'rekey', target: B },
      { sender: SENDER, kind: 'closeAccount', target: A },
    ]);
  });

  it('lists each authority a reconfiguration hands over or removes', () => {
    expect(
      describeTransactionDangers(acfg({ manager: A, clawback: B }))
    ).toEqual([
      {
        sender: SENDER,
        kind: 'assetAuthority',
        assetId: 42n,
        role: 'manager',
        target: A,
      },
      {
        sender: SENDER,
        kind: 'assetAuthorityRemoved',
        assetId: 42n,
        role: 'reserve',
      },
      {
        sender: SENDER,
        kind: 'assetAuthorityRemoved',
        assetId: 42n,
        role: 'freeze',
      },
      {
        sender: SENDER,
        kind: 'assetAuthority',
        assetId: 42n,
        role: 'clawback',
        target: B,
      },
    ]);
  });

  it('flags a reconfiguration with no authorities as destroying the asset', () => {
    expect(describeTransactionDangers(acfg({}))).toEqual([
      { sender: SENDER, kind: 'assetDestroy', assetId: 42n },
    ]);
  });

  it('does not flag asset creation or an ordinary payment', () => {
    const create = roundTrip(
      algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
        sender: SENDER,
        total: 1,
        decimals: 0,
        defaultFrozen: false,
        manager: A,
        suggestedParams: SUGGESTED_PARAMS as any,
      })
    );
    const pay = roundTrip(
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: SENDER,
        receiver: A,
        amount: 1,
        suggestedParams: SUGGESTED_PARAMS as any,
      })
    );
    expect(describeTransactionDangers(create)).toEqual([]);
    expect(describeTransactionDangers(pay)).toEqual([]);
  });
});

// TASK-440 Luna r1 #1: a clawback (asset transfer with an asset sender) moves
// another account's holding using the sender's clawback authority. Negative
// control: at 50993c5 describeTransactionDangers returned [] for it.
describe('describeTransactionDangers - clawback', () => {
  const { describeTransactionDangers } = require('../transactionDangers');
  const AUTHORITY = algosdk.generateAccount().addr.toString();
  const VICTIM = algosdk.generateAccount().addr.toString();
  const TO = algosdk.generateAccount().addr.toString();

  it('lists a clawback with the account it takes from and the receiver', () => {
    const txn = algosdk.decodeUnsignedTransaction(
      algosdk.encodeUnsignedTransaction(
        makeAssetTransfer(AUTHORITY, {
          assetSender: VICTIM,
          receiver: TO,
          amount: 5,
        })
      )
    );
    expect(describeTransactionDangers(txn)).toEqual([
      {
        sender: AUTHORITY,
        kind: 'clawback',
        assetId: BigInt(ASSET_ID),
        from: VICTIM,
        target: TO,
      },
    ]);
  });

  it('does not flag an ordinary transfer as a clawback', () => {
    const txn = makeAssetTransfer(AUTHORITY, { receiver: TO, amount: 5 });
    expect(describeTransactionDangers(txn)).toEqual([]);
  });
});

// TASK-440 Luna r1 #3: only roles that differ from the asset's current holders
// are dangers; an unreadable asset keeps every role, marked unverified.
describe('resolveAssetAuthorityDangers', () => {
  const {
    describeTransactionDangers,
    resolveAssetAuthorityDangers,
  } = require('../transactionDangers');
  const SENDER = algosdk.generateAccount().addr.toString();
  const M = algosdk.generateAccount().addr.toString();
  const R = algosdk.generateAccount().addr.toString();
  const NEW = algosdk.generateAccount().addr.toString();
  const reconfig = (fields: Record<string, string | undefined>) =>
    describeTransactionDangers(
      algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
        sender: SENDER,
        assetIndex: 42,
        suggestedParams: SUGGESTED_PARAMS as any,
        strictEmptyAddressChecking: false,
        ...fields,
      } as any)
    );

  it('drops unchanged roles and keeps hand-overs and real removals', async () => {
    // Current: manager M, reserve R, no freeze, clawback R.
    // Txn: manager M (same), reserve NEW (hand-over), no freeze (same),
    // no clawback (removal).
    const lookup = jest.fn(async () => ({
      manager: M,
      reserve: R,
      clawback: R,
    }));
    const result = await resolveAssetAuthorityDangers(
      reconfig({ manager: M, reserve: NEW }),
      lookup
    );
    expect(lookup).toHaveBeenCalledWith(42n);
    expect(result).toEqual([
      {
        sender: SENDER,
        kind: 'assetAuthority',
        assetId: 42n,
        role: 'reserve',
        target: NEW,
      },
      {
        sender: SENDER,
        kind: 'assetAuthorityRemoved',
        assetId: 42n,
        role: 'clawback',
      },
    ]);
  });

  it('keeps every role, unverified, when the lookup returns null or throws', async () => {
    const items = reconfig({ manager: M });
    for (const lookup of [
      async () => null,
      async () => {
        throw new Error('offline');
      },
    ]) {
      const result = await resolveAssetAuthorityDangers(items, lookup);
      expect(result).toHaveLength(4);
      expect(result.every((i: any) => i.unverified === true)).toBe(true);
    }
  });

  // algosdk refuses to build a txn with a zero-address authority, so only the
  // holder side can carry one.
  it('treats a zero-address current holder as no holder', async () => {
    const result = await resolveAssetAuthorityDangers(
      reconfig({ manager: M }),
      async () => ({
        manager: M,
        reserve: algosdk.ALGORAND_ZERO_ADDRESS_STRING,
        freeze: '',
      })
    );
    expect(result).toEqual([]);
  });

  it('passes non-authority items and destroys through untouched', async () => {
    const destroy = reconfig({});
    const lookup = jest.fn(async () => null);
    expect(await resolveAssetAuthorityDangers(destroy, lookup)).toEqual(
      destroy
    );
    expect(lookup).not.toHaveBeenCalled();
  });
});
