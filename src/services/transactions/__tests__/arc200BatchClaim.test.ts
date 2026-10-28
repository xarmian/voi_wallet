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
const mockSimulate = jest.fn();
const mockRemote = jest.fn();
const mockAccounts = () => [CLAIMER, OTHER_SENDER, OWNER_2];
const mockSigningAddress = jest.fn();

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    getSigningInfo: async (sender: string) => ({
      signingAddress: mockSigningAddress(sender),
    }),
  },
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAllAccounts: async () => mockAccounts().map((address) => ({ address })),
  },
}));
jest.mock('@/services/remoteSigner/signingRouter', () => ({
  checkRemoteSigningRequired: (account: { address: string }) => ({
    needsRemoteSigning: mockRemote(account.address),
  }),
}));

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
const OTHER_SENDER = makeAddress('arc200-batch:other-sender');
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
function expectOneMbrPerContract(
  txnBytes: Uint8Array[],
  contracts: number[],
  sender = CLAIMER
) {
  const payments = decodeGroup(txnBytes).filter(isMbrPayment);
  expect(payments).toHaveLength(contracts.length);
  for (const contractId of contracts) {
    const forContract = payments.filter(
      (p) => p.payment!.receiver.toString() === escrowOf(contractId)
    );
    expect(forContract).toHaveLength(1);
    expect(forContract[0].payment!.amount).toBe(BigInt(ARC200_MBR_AMOUNT));
    expect(forContract[0].sender.toString()).toBe(sender);
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
    simulateTransactions: (request: unknown) => ({
      do: () => mockSimulate(request),
    }),
  });
  mockRemote.mockReturnValue(false);
  mockSigningAddress.mockImplementation((sender: string) => sender);
  mockSimulate.mockResolvedValue({
    txnGroups: [{ failureMessage: 'box minimum balance' }],
  });
  // Failed simulation: every contract needs an MBR payment.
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

    expect(mockGetAllAccountAssets).not.toHaveBeenCalled();
  });

  it('adds no MBR payment when simulation succeeds, even with zero balance', async () => {
    mockSimulate.mockResolvedValue({
      txnGroups: [{ txnResults: [{ txnResult: {} }] }],
    });
    mockGetAllAccountAssets.mockResolvedValue([
      { assetType: 'arc200', contractId: CONTRACT_A, balance: '0' },
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

// Captured by running `git show e0d0613:src/services/transactions/arc200.ts`
// as a temporary module with this suite's fixed params and empty simulation mocks.
// See the round 2 report and r2-original-bytes.json for capture details.
const ORIGINAL_BATCH_BASE64 = {
  allMbr: [
    'iqNhbXTNb1SjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCCeVhSgEWMTpqKtDTELsINulen7p6YdcbVVHhATITJ70aJsds0D6aRub3RlxBVNQlIgZm9yIEFSQy0yMDAgY2xhaW2jcmN2xCA/C89YVGJDOorffz3opSGZJuU6EebwBcrXB0dHkVaZTKNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWjcGF5',
    'iaRhcGFhlMQESpaPj8QgfTbaGYKEgFJEtOZrvmw6zb1RhHD5RXCfrE/56iLAzR3EIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NAxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATiKRhcGlkzgAF83GjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCCeVhSgEWMTpqKtDTELsINulen7p6YdcbVVHhATITJ70aJsds0D6aNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWkYXBwbA==',
    'iaRhcGFhlMQESpaPj8QgrEa7ykzAWlgeSYuBRkMzDJA1+LYsDh3rtcQFV2j7VfzEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NAxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATiKRhcGlkzgAF83GjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCCeVhSgEWMTpqKtDTELsINulen7p6YdcbVVHhATITJ70aJsds0D6aNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWkYXBwbA==',
    'iqNhbXTNb1SjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCCeVhSgEWMTpqKtDTELsINulen7p6YdcbVVHhATITJ70aJsds0D6aRub3RlxBVNQlIgZm9yIEFSQy0yMDAgY2xhaW2jcmN2xCCf7tVnsBDRwJzhj0VdRjdsjbmivTuaRrTAJ2gNxKiX86NzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWjcGF5',
    'iaRhcGFhlMQESpaPj8QgfTbaGYKEgFJEtOZrvmw6zb1RhHD5RXCfrE/56iLAzR3EIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NAxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB6RhcGlkzgLPRRSjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCCeVhSgEWMTpqKtDTELsINulen7p6YdcbVVHhATITJ70aJsds0D6aNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWkYXBwbA==',
  ],
  noMbr: [
    'iaRhcGFhlMQESpaPj8QgfTbaGYKEgFJEtOZrvmw6zb1RhHD5RXCfrE/56iLAzR3EIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NAxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATiKRhcGlkzgAF83GjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCDugjEjzUkdE6UUBQhqAnp5VBTRHcB8/ciYHwib5xVFL6Jsds0D6aNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWkYXBwbA==',
    'iaRhcGFhlMQESpaPj8QgrEa7ykzAWlgeSYuBRkMzDJA1+LYsDh3rtcQFV2j7VfzEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NAxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATiKRhcGlkzgAF83GjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCDugjEjzUkdE6UUBQhqAnp5VBTRHcB8/ciYHwib5xVFL6Jsds0D6aNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWkYXBwbA==',
    'iaRhcGFhlMQESpaPj8QgfTbaGYKEgFJEtOZrvmw6zb1RhHD5RXCfrE/56iLAzR3EIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NAxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB6RhcGlkzgLPRRSjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCDugjEjzUkdE6UUBQhqAnp5VBTRHcB8/ciYHwib5xVFL6Jsds0D6aNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWkYXBwbA==',
  ],
  mixedMbr: [
    'iaRhcGFhlMQESpaPj8QgfTbaGYKEgFJEtOZrvmw6zb1RhHD5RXCfrE/56iLAzR3EIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NAxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATiKRhcGlkzgAF83GjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCDd01MDA0Xv9QRjwB5HPXR1tw8xjMEHRJZUgJIckaOnQaJsds0D6aNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWkYXBwbA==',
    'iaRhcGFhlMQESpaPj8QgrEa7ykzAWlgeSYuBRkMzDJA1+LYsDh3rtcQFV2j7VfzEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NAxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATiKRhcGlkzgAF83GjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCDd01MDA0Xv9QRjwB5HPXR1tw8xjMEHRJZUgJIckaOnQaJsds0D6aNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWkYXBwbA==',
    'iqNhbXTNb1SjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCDd01MDA0Xv9QRjwB5HPXR1tw8xjMEHRJZUgJIckaOnQaJsds0D6aRub3RlxBVNQlIgZm9yIEFSQy0yMDAgY2xhaW2jcmN2xCCf7tVnsBDRwJzhj0VdRjdsjbmivTuaRrTAJ2gNxKiX86NzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWjcGF5',
    'iaRhcGFhlMQESpaPj8QgfTbaGYKEgFJEtOZrvmw6zb1RhHD5RXCfrE/56iLAzR3EIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NAxCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB6RhcGlkzgLPRRSjZmVlzQPoomZ2AaNnZW6rdm9pLXRlc3QtdjGjZ3JwxCDd01MDA0Xv9QRjwB5HPXR1tw8xjMEHRJZUgJIckaOnQaJsds0D6aNzbmTEIJrZBHqRqKjFueFFOPqRp7unGCbTF+k3EOb65Czl94NApHR5cGWkYXBwbA==',
  ],
};

const validFixtureClaims = (): Arc200ClaimParams[] => [
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

function expectNoNetworkCalls() {
  expect(mockGetSuggestedParams).not.toHaveBeenCalled();
  expect(mockGetAlgodClient).not.toHaveBeenCalled();
  expect(mockGetAllAccountAssets).not.toHaveBeenCalled();
}

describe('TASK-397 claim builder guards', () => {
  it.each([5000n, 1n])(
    'rejects the same owner and sender before network access (amount %s)',
    async (amount) => {
      const claims = validFixtureClaims();
      // Append after other valid claims to require a full preflight pass.
      claims.push({ ...claims[0], amount });

      await expect(
        Arc200TransactionService.buildBatchClaimTransactionGroup(
          claims,
          'voi-mainnet'
        )
      ).rejects.toThrow(
        new Error(
          `Duplicate claim for token ${CONTRACT_A} from ${OWNER_1} by ${CLAIMER}`
        )
      );
      expectNoNetworkCalls();
    }
  );

  it('allows the same owner with two different senders and builds the group', async () => {
    const first = validFixtureClaims()[0];
    const claims = [first, { ...first, sender: OTHER_SENDER }];
    const group =
      await Arc200TransactionService.buildBatchClaimTransactionGroup(claims);

    expectNoDuplicates(group.txnBytes);
    expectOneMbrPerContract(group.txnBytes, [CONTRACT_A]);
    expectCanonicalGroup(group.txnBytes);
    expect(
      decodeGroup(group.txnBytes)
        .filter((t) => t.type === algosdk.TransactionType.appl)
        .map(claimOf)
    ).toEqual(
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
  });

  it('rejects a string contractId duplicate before network access', async () => {
    const first = validFixtureClaims()[0];
    const duplicate = {
      ...first,
      contractId: String(first.contractId) as unknown as number,
    };
    await expect(
      Arc200TransactionService.buildBatchClaimTransactionGroup([
        first,
        duplicate,
      ])
    ).rejects.toThrow(
      new Error(
        `Duplicate claim for token ${CONTRACT_A} from ${OWNER_1} by ${CLAIMER}`
      )
    );
    expectNoNetworkCalls();
  });

  it('rejects different recipients with a string contractId before network access', async () => {
    const claims = validFixtureClaims();
    claims[1] = {
      ...claims[1],
      contractId: String(CONTRACT_A) as unknown as number,
      to: OWNER_2,
    };
    await expect(
      Arc200TransactionService.buildBatchClaimTransactionGroup(claims)
    ).rejects.toThrow(
      new Error(
        `All claims for token ${CONTRACT_A} must go to the same recipient`
      )
    );
    expectNoNetworkCalls();
  });

  it('rejects different recipients for one contract before network access', async () => {
    const claims = validFixtureClaims();
    claims[1] = { ...claims[1], to: OWNER_2 };

    await expect(
      Arc200TransactionService.buildBatchClaimTransactionGroup(claims)
    ).rejects.toThrow(
      new Error(
        `All claims for token ${CONTRACT_A} must go to the same recipient`
      )
    );
    expectNoNetworkCalls();
  });

  it.each([
    ['allMbr', []],
    ['noMbr', [CONTRACT_A, CONTRACT_B]],
    ['mixedMbr', [CONTRACT_A]],
  ] as const)(
    'encodes a valid %s batch byte-identically to the original builder',
    async (scenario, held) => {
      mockSimulate.mockImplementation(async (request) => ({
        txnGroups: [
          held.includes(
            Number(
              request.txnGroups[0].txns.at(-1).txn.applicationCall.appIndex
            ) as never
          )
            ? { txnResults: [{ txnResult: {} }] }
            : { failureMessage: 'box minimum balance' },
        ],
      }));
      const group =
        await Arc200TransactionService.buildBatchClaimTransactionGroup(
          validFixtureClaims(),
          'voi-mainnet'
        );
      const encoded = group.transactions.map((txn) =>
        Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64')
      );
      expect(encoded).toEqual(ORIGINAL_BATCH_BASE64[scenario]);
      expect(
        group.txnBytes.map((bytes) => Buffer.from(bytes).toString('base64'))
      ).toEqual(ORIGINAL_BATCH_BASE64[scenario]);
    }
  );
});

describe('TASK-416 simulation MBR decision and service fee parity', () => {
  const success = { txnGroups: [{ txnResults: [{ txnResult: {} }] }] };
  it.each(['send', 'claim'] as const)(
    '%s: success, failure, throws and remote signer',
    async (flow) => {
      const params = {
        from: CLAIMER,
        to: OWNER_1,
        sender: CLAIMER,
        amount: 42n,
        contractId: CONTRACT_A,
        networkId: 'voi-mainnet',
      };
      const build = () =>
        flow === 'send'
          ? Arc200TransactionService.buildArc200TransferGroup(params)
          : Arc200TransactionService.buildArc200TransferFromGroup(params);
      for (const scenario of [
        'success',
        'failure',
        'throws',
        'remote',
        'remote-auth',
      ]) {
        mockRemote.mockImplementation(
          (address: string) =>
            scenario === 'remote' ||
            (scenario === 'remote-auth' && address === OWNER_2)
        );
        mockSigningAddress.mockReturnValue(
          scenario === 'remote-auth' ? OWNER_2 : CLAIMER
        );
        mockSimulate.mockImplementation(async (request) => {
          if (scenario === 'throws' && request.txnGroups[0].txns.length === 1)
            throw new Error('algod unavailable');
          if (scenario === 'failure')
            return { txnGroups: [{ failureMessage: 'box minimum balance' }] };
          return success;
        });
        const group = await build();
        const needsMbr = scenario !== 'success';
        expect(group.needsMbrPayment).toBe(needsMbr);
        const decoded = decodeGroup(group.txnBytes);
        expect(decoded.filter(isMbrPayment)).toHaveLength(needsMbr ? 1 : 0);
        const cost = decoded.reduce(
          (sum, txn) =>
            sum + Number(txn.fee) + Number(txn.payment?.amount || 0),
          0
        );
        expect(cost).toBe(needsMbr ? 30500 : 1000);
        const estimate =
          flow === 'send'
            ? await Arc200TransactionService.estimateArc200TransferCost(params)
            : await Arc200TransactionService.estimateClaimCost(
                [{ ...params }],
                0,
                'voi-mainnet'
              );
        expect(estimate.total).toBe(cost);
        expect(
          (await Arc200TransactionService.estimateClaimCost(group)).total
        ).toBe(cost);
      }
      expect(mockGetAllAccountAssets).not.toHaveBeenCalled();
    }
  );

  it('decides per recipient/contract and funds a later remote sender only once', async () => {
    mockSimulate.mockResolvedValue(success);
    mockRemote.mockImplementation(
      (address: string) => address === OTHER_SENDER
    );
    const first = validFixtureClaims()[0];
    const claims = [
      first,
      { ...first, sender: OTHER_SENDER },
      { ...first, contractId: CONTRACT_B, to: OWNER_2 },
    ];
    const group =
      await Arc200TransactionService.buildBatchClaimTransactionGroup(claims);
    expectOneMbrPerContract(group.txnBytes, [CONTRACT_A], OTHER_SENDER);
    expectNoDuplicates(group.txnBytes);
    expectCanonicalGroup(group.txnBytes);
    expect(
      (await Arc200TransactionService.estimateClaimCost(claims)).total
    ).toBe(Arc200TransactionService.groupCost(group));
  });
});
