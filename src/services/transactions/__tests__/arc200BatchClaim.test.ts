/**
 * TASK-392 / GH #20: the claim-all group must hold no duplicate transactions.
 *
 * Before the fix, every claim in a batch got its own MBR payment. All MBR
 * payments for one contract share sender, receiver (the app escrow), amount
 * and note, so two claims on one contract produced two byte-identical
 * payments and algod rejected the whole group. Approval events were not
 * deduped either, so two events for one (contract, owner) became two claims.
 *
 * Real algosdk construction throughout; only the network boundaries
 * (suggested params, the simulate client, the recipient-balance lookup) are
 * mocked. No key or signature is involved: the builder returns unsigned bytes.
 */

import algosdk from 'algosdk';

import { makeAddress, SUGGESTED_PARAMS } from '@/__tests__/fixtures/algorand';
import { dedupeLatestApprovals } from '@/utils/arc200Approvals';

const mockGetSuggestedParams = jest.fn();
const mockGetAlgodClient = jest.fn();
const mockGetAllAccountAssets = jest.fn();

jest.mock('@/services/network', () => {
  const svc = {
    getSuggestedParams: (...args: unknown[]) => mockGetSuggestedParams(...args),
    getAlgodClient: (...args: unknown[]) => mockGetAlgodClient(...args),
  };
  return {
    __esModule: true,
    networkService: svc,
    NetworkService: { getInstance: () => svc },
  };
});

jest.mock('@/services/mimir', () => ({
  __esModule: true,
  default: {
    getAllAccountAssets: (...args: unknown[]) =>
      mockGetAllAccountAssets(...args),
  },
}));

import {
  Arc200ClaimParams,
  Arc200TransactionService,
} from '@/services/transactions/arc200';

const CLAIMER = makeAddress('arc200-batch:claimer');
const OWNER_1 = makeAddress('arc200-batch:owner-1');
const OWNER_2 = makeAddress('arc200-batch:owner-2');
const CONTRACT_A = 390001;
const CONTRACT_B = 47138068;
const ARC200_MBR_AMOUNT = 28500;

const transferFromSelector = Buffer.from(
  new algosdk.ABIMethod({
    name: 'arc200_transferFrom',
    args: [
      { type: 'address', name: 'from' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'value' },
    ],
    returns: { type: 'bool' },
  }).getSelector()
).toString('hex');

const addressType = algosdk.ABIType.from('address');
const uint256Type = algosdk.ABIType.from('uint256');

const decodeGroup = (txnBytes: Uint8Array[]) =>
  txnBytes.map((b) => algosdk.decodeUnsignedTransaction(b));

const isMbrPayment = (t: algosdk.Transaction) =>
  t.type === algosdk.TransactionType.pay;

const escrowOf = (contractId: number) =>
  algosdk.getApplicationAddress(contractId).toString();

/** The core GH #20 invariant: no two group members share bytes or txid. */
function expectNoDuplicates(txnBytes: Uint8Array[]) {
  const hex = txnBytes.map((b) => Buffer.from(b).toString('hex'));
  expect(new Set(hex).size).toBe(hex.length);
  const ids = decodeGroup(txnBytes).map((t) => t.txID());
  expect(new Set(ids).size).toBe(ids.length);
}

/** Exactly one MBR payment per contract in `contracts`, and none elsewhere. */
function expectOneMbrPerContract(txnBytes: Uint8Array[], contracts: number[]) {
  const payments = decodeGroup(txnBytes).filter(isMbrPayment);
  expect(payments).toHaveLength(contracts.length);
  for (const contractId of contracts) {
    const forContract = payments.filter(
      (p) => p.payment!.receiver.toString() === escrowOf(contractId)
    );
    expect(forContract).toHaveLength(1);
    expect(forContract[0].payment!.amount).toBe(BigInt(ARC200_MBR_AMOUNT));
    expect(forContract[0].sender.toString()).toBe(CLAIMER);
  }
}

function expectCanonicalGroup(txnBytes: Uint8Array[]) {
  const decoded = decodeGroup(txnBytes);
  const stored = decoded.map((t) => Buffer.from(t.group!).toString('hex'));
  decoded.forEach((t) => {
    t.group = undefined;
  });
  const canonical = Buffer.from(algosdk.computeGroupID(decoded)).toString(
    'hex'
  );
  for (const g of stored) expect(g).toBe(canonical);
}

/** Claim fields as decoded from an app call's args. */
function claimOf(t: algosdk.Transaction) {
  const args = t.applicationCall!.appArgs;
  return {
    contractId: Number(t.applicationCall!.appIndex),
    selector: Buffer.from(args[0]).toString('hex'),
    from: addressType.decode(args[1]),
    to: addressType.decode(args[2]),
    amount: uint256Type.decode(args[3]),
    sender: t.sender.toString(),
    fee: t.fee,
  };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockGetSuggestedParams.mockImplementation(async () => ({
    ...SUGGESTED_PARAMS,
  }));
  mockGetAlgodClient.mockReturnValue({
    simulateTransactions: () => ({
      do: async () => ({ txnGroups: [{}] }),
    }),
  });
  // Recipient holds none of the tokens: every contract needs an MBR payment.
  mockGetAllAccountAssets.mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('buildBatchClaimTransactionGroup (TASK-392, GH #20)', () => {
  it('GH #20 shape: two approval events for one contract become one claim and a duplicate-free group', async () => {
    // Two events with identical parameters (same contract, owner, amount),
    // as the issue describes; only the approval txid differs.
    const events = [
      {
        contractId: CONTRACT_A,
        owner: OWNER_1,
        spender: CLAIMER,
        round: 100,
        timestamp: 1000,
        amount: '5000',
        transactionId: 'APPROVAL_TX_1',
      },
      {
        contractId: CONTRACT_A,
        owner: OWNER_1,
        spender: CLAIMER,
        round: 100,
        timestamp: 1000,
        amount: '5000',
        transactionId: 'APPROVAL_TX_2',
      },
    ];
    const claims: Arc200ClaimParams[] = dedupeLatestApprovals(events)
      .filter((e) => e.amount !== '0')
      .map((e) => ({
        contractId: e.contractId,
        from: e.owner,
        to: CLAIMER,
        amount: BigInt(e.amount),
        sender: CLAIMER,
      }));

    const group =
      await Arc200TransactionService.buildBatchClaimTransactionGroup(claims);

    // Group-level invariants first, so a missing dedupe trips THESE.
    expectNoDuplicates(group.txnBytes);
    expectOneMbrPerContract(group.txnBytes, [CONTRACT_A]);
    expect(claims).toHaveLength(1);
    expect(group.txnBytes).toHaveLength(2);
    expect(group.needsMbrPayment).toBe(true);
  });

  it('two claims on one contract (plus one on another) get exactly one MBR payment per contract and no duplicates', async () => {
    const claims: Arc200ClaimParams[] = [
      {
        contractId: CONTRACT_A,
        from: OWNER_1,
        to: CLAIMER,
        amount: 5000n,
        sender: CLAIMER,
      },
      {
        contractId: CONTRACT_A,
        from: OWNER_2,
        to: CLAIMER,
        amount: 5000n,
        sender: CLAIMER,
      },
      {
        contractId: CONTRACT_B,
        from: OWNER_1,
        to: CLAIMER,
        amount: 7n,
        sender: CLAIMER,
      },
    ];

    const group =
      await Arc200TransactionService.buildBatchClaimTransactionGroup(
        claims,
        'voi-mainnet'
      );

    expectNoDuplicates(group.txnBytes);
    expectOneMbrPerContract(group.txnBytes, [CONTRACT_A, CONTRACT_B]);
    expectCanonicalGroup(group.txnBytes);
    expect(group.needsMbrPayment).toBe(true);

    // Layout: each contract's MBR payment sits immediately before that
    // contract's first claim, as in the single-claim [MBR, transferFrom] group.
    const decoded = decodeGroup(group.txnBytes);
    expect(decoded.map((t) => t.type)).toEqual([
      algosdk.TransactionType.pay,
      algosdk.TransactionType.appl,
      algosdk.TransactionType.appl,
      algosdk.TransactionType.pay,
      algosdk.TransactionType.appl,
    ]);
    expect(decoded[0].payment!.receiver.toString()).toBe(escrowOf(CONTRACT_A));
    expect(decoded[3].payment!.receiver.toString()).toBe(escrowOf(CONTRACT_B));

    // Every claim is still present, unchanged, in input order.
    const builtClaims = decoded
      .filter((t) => t.type === algosdk.TransactionType.appl)
      .map(claimOf);
    expect(builtClaims).toEqual(
      claims.map((c) => ({
        contractId: c.contractId,
        selector: transferFromSelector,
        from: c.from,
        to: c.to,
        amount: c.amount,
        sender: c.sender,
        fee: BigInt(SUGGESTED_PARAMS.fee),
      }))
    );

    // One recipient-balance lookup per contract, not per claim.
    expect(mockGetAllAccountAssets).toHaveBeenCalledTimes(2);
  });

  it('adds no MBR payment for a contract the recipient already holds', async () => {
    mockGetAllAccountAssets.mockResolvedValue([
      { assetType: 'arc200', contractId: CONTRACT_A, balance: '1' },
    ]);
    const claims: Arc200ClaimParams[] = [OWNER_1, OWNER_2].map((owner) => ({
      contractId: CONTRACT_A,
      from: owner,
      to: CLAIMER,
      amount: 5000n,
      sender: CLAIMER,
    }));

    const group =
      await Arc200TransactionService.buildBatchClaimTransactionGroup(claims);

    expectNoDuplicates(group.txnBytes);
    expectOneMbrPerContract(group.txnBytes, []);
    expect(group.txnBytes).toHaveLength(2);
    expect(group.needsMbrPayment).toBe(false);
  });
});
