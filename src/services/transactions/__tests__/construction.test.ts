/**
 * TASK-153 — P0 transaction-construction tests.
 *
 * Purpose: pin down the ENCODED shape of the transactions the wallet builds, so a
 * regression in a constructor (wrong `rekeyTo`, a stray `closeRemainderTo`, a
 * swapped `assetIndex`/`appIndex`, or mangled ABI app-args) is caught here rather
 * than on-chain. Every assertion is made against the bytes returned by the real
 * production constructors, decoded through the exact production decode path
 * (`decodeUnsignedTransaction`) — never against the in-memory `Transaction` object
 * the builder happened to hold.
 *
 * DR-3 / CLAUDE.md: this is TEST-ONLY. It uses REAL algosdk-v3 crypto (accounts are
 * derived by algosdk from deterministic fixture seeds — see fixtures/algorand.ts)
 * and NEVER mocks a key or a signature. The only things mocked are the network I/O
 * boundaries (`getSuggestedParams`, the algod simulate client, and the recipient
 * balance lookup) so the builders run deterministically offline; the transaction
 * construction itself is entirely real. No key/mnemonic is ever logged.
 *
 * The danger-bearing fields (`closeRemainderTo` = account/asset drain, `rekeyTo` =
 * authority transfer) get explicit, dedicated coverage. A guard block first proves
 * the decode path actually surfaces those fields when they ARE present, so the
 * "must be absent" assertions elsewhere are meaningful rather than vacuous.
 */

import algosdk from 'algosdk';
import { AccountType } from '@/types/wallet';

import {
  makeAccount,
  makeAddress,
  SUGGESTED_PARAMS,
  FIXTURE_ASSET_ID,
  FIXTURE_APP_ID,
  paymentTxn,
  assetTransferTxn,
  roundTripTxn,
} from '@/__tests__/fixtures/algorand';

// --- network / balance boundaries (the only things mocked) -----------------

const mockGetSuggestedParams = jest.fn();
const mockGetAlgodClient = jest.fn();
const mockGetAccountBalance = jest.fn();
const mockGetAllAccountAssets = jest.fn();

jest.mock('@/services/network', () => {
  const svc = {
    getSuggestedParams: (...args: unknown[]) => mockGetSuggestedParams(...args),
    getAlgodClient: (...args: unknown[]) => mockGetAlgodClient(...args),
    getAccountBalance: (...args: unknown[]) => mockGetAccountBalance(...args),
    estimateTransactionFee: async () => 1000,
  };
  return {
    __esModule: true,
    networkService: svc, // default-network singleton (named import in the services)
    NetworkService: { getInstance: () => svc },
  };
});

// ARC-200's recipient-balance check goes through MimirApiService (default import).
jest.mock('@/services/mimir', () => ({
  __esModule: true,
  default: {
    getAllAccountAssets: (...args: unknown[]) =>
      mockGetAllAccountAssets(...args),
  },
}));

// TransactionService's module graph transitively pulls the wallet store, which
// imports AsyncStorage's native module (unavailable under jest). Swap in the
// library's official jest mock so the graph loads. None of the constructors
// under test touch storage.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// TransactionService also imports Ledger transport / wallet-store / secure-key
// modules at the top level. Those drag in native (BLE/HID) and ESM-only deps
// that jest can't load, but NONE of the pure offline constructors under test
// call into them. Stub them so the module graph resolves. The ARC-200/ARC-72
// services (./arc200, ./arc72) are intentionally NOT mocked — their real
// construction code is exercised.
jest.mock('@/store/walletStore', () => ({
  __esModule: true,
  useWalletStore: { getState: () => ({}) },
}));
jest.mock('@/services/ledger/transport', () => ({
  __esModule: true,
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({
  __esModule: true,
  ledgerAlgorandService: {},
}));
jest.mock('@/services/secure/keyManager', () => ({
  __esModule: true,
  SecureKeyManager: {
    getSigningInfo: jest.fn(async (sender: string) => ({
      signingAddress: sender,
    })),
    getLedgerSigningInfo: jest.fn(),
  },
}));
jest.mock('@/services/security/transactionTracker', () => ({
  __esModule: true,
  TransactionTracker: { validateNewTransaction: async () => [] },
}));

const mockSender = () => SENDER;
// The rekey builders check the receiving key is held (TASK-425 U3).
const mockCurrentWallet = jest.fn(async () => ({
  accounts: [
    { id: 'sender', address: mockSender(), type: 'standard' },
    { id: 'recipient', address: mockRecipient(), type: 'standard' },
  ] as { id: string; address: string; type: string }[],
}));
const mockRecipient = () => RECIPIENT;
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAllAccounts: async () => [{ address: mockSender() }],
    getCurrentWallet: () => mockCurrentWallet(),
  },
}));
// TASK-425 U3: which REKEYED records still hold their own secret.
const mockProbe = jest.fn(async (_id: string) => false);
const mockGetPrivateKey = jest.fn(async (_id: string): Promise<Uint8Array> => {
  throw new Error('no key');
});
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    probeSecretPresenceStrict: (id: string) => mockProbe(id),
    getPrivateKey: (id: string) => mockGetPrivateKey(id),
  },
}));
jest.mock('@/services/remoteSigner/signingRouter', () => ({
  checkRemoteSigningRequired: () => ({ needsRemoteSigning: false }),
}));

// Imported AFTER the mocks above are registered (jest hoists jest.mock, but keep
// the import here to make the ordering intent obvious).
import { TransactionService } from '@/services/transactions';

// ---------------------------------------------------------------------------
// Shared deterministic accounts (real algosdk-derived keys; never logged).
// ---------------------------------------------------------------------------

const SENDER = makeAddress('tx-construction:sender');
const RECIPIENT = makeAddress('tx-construction:recipient');
const SIGNER = makeAddress('tx-construction:airgap-signer');

const TEXT = new TextDecoder();

/** Decode the ACTUAL production-encoded bytes (not the in-memory txn object). */
function decodeBytes(bytes: Uint8Array): algosdk.Transaction {
  return algosdk.decodeUnsignedTransaction(bytes);
}

/**
 * Assert every txn in an encoded group carries the CANONICAL algosdk group id
 * (not merely the same arbitrary bytes). We decode the group, strip the group
 * field, recompute `computeGroupID` over the group-less txns, and require the
 * stored group to equal that canonical value on every member.
 */
function expectCanonicalGroup(txnBytes: Uint8Array[]): void {
  const decoded = txnBytes.map(decodeBytes);
  const stored = decoded.map((t) =>
    t.group ? Buffer.from(t.group).toString('hex') : undefined
  );
  // computeGroupID hashes the group-less encoding, so clear group first.
  decoded.forEach((t) => {
    t.group = undefined;
  });
  const canonical = Buffer.from(algosdk.computeGroupID(decoded)).toString(
    'hex'
  );
  for (const g of stored) {
    expect(g).toBe(canonical);
  }
}

beforeEach(() => {
  // Fresh suggested-params object per call: some builders spread/clone it, so we
  // never want two builds to share (and mutate) one instance.
  mockGetSuggestedParams.mockImplementation(async () => ({
    ...SUGGESTED_PARAMS,
  }));
  // Simulate client returns no unnamed resources / boxes by default.
  mockGetAlgodClient.mockReturnValue({
    simulateTransactions: () => ({
      do: async () => ({ txnGroups: [{ txnResults: [{ txnResult: {} }] }] }),
    }),
  });
  // ARC-72 balance path (network) and ARC-200 balance path (mimir) default to
  // "recipient already opted in" so no MBR payment is prepended — tests that
  // want the MBR branch override these explicitly.
  mockGetAccountBalance.mockResolvedValue({
    assets: [{ assetType: 'arc72', contractId: FIXTURE_APP_ID }],
  });
  mockGetAllAccountAssets.mockResolvedValue([
    { assetType: 'arc200', contractId: FIXTURE_APP_ID, balance: '1' },
  ]);
});

// ===========================================================================
// Guard: prove the decode path actually surfaces the danger fields.
//
// Without this, every "expect(...closeRemainderTo).toBeUndefined()" below could
// pass simply because the decoder never exposes the field — a false sense of
// safety. These use the shared fixtures to build txns that DO carry the fields.
// ===========================================================================

describe('decode path surfaces danger-bearing fields (guard)', () => {
  it('surfaces payment closeRemainderTo + rekeyTo when present', () => {
    const decoded = roundTripTxn(
      paymentTxn(SENDER, { closeRemainderTo: RECIPIENT, rekeyTo: RECIPIENT })
    );
    expect(decoded.payment?.closeRemainderTo?.toString()).toBe(RECIPIENT);
    expect(decoded.rekeyTo?.toString()).toBe(RECIPIENT);
  });

  it('surfaces asset-transfer closeRemainderTo when present', () => {
    const decoded = roundTripTxn(
      assetTransferTxn(SENDER, { closeRemainderTo: RECIPIENT })
    );
    // algosdk v3 stores the asset close-out under assetTransfer, NOT top-level.
    expect(decoded.assetTransfer?.closeRemainderTo?.toString()).toBe(RECIPIENT);
  });
});

// ===========================================================================
// Rekey transaction (index.ts buildRekeyTransaction)
// ===========================================================================

describe('buildRekeyTransaction', () => {
  it('encodes a 0-amount self-payment whose rekeyTo is the new authority', async () => {
    const { txnBytes } = await TransactionService.buildRekeyTransaction({
      fromAddress: SENDER,
      rekeyToAddress: RECIPIENT,
      note: 'rekey-note',
    });
    const d = decodeBytes(txnBytes);

    expect(d.type).toBe('pay');
    expect(d.sender.toString()).toBe(SENDER);
    // Self-payment: receiver === sender, amount 0.
    expect(d.payment?.receiver.toString()).toBe(SENDER);
    expect(d.payment?.amount).toBe(0n);
    // THE danger field: authority moves to the target and nowhere else.
    expect(d.rekeyTo?.toString()).toBe(RECIPIENT);
    // Must NOT also drain the account.
    expect(d.payment?.closeRemainderTo).toBeUndefined();
    // Flat fee is preserved from suggested params (no fee bump).
    expect(d.fee).toBe(1000n);
    expect(TEXT.decode(d.note)).toBe('rekey-note');
  });

  it('rekeyTo target is exactly the requested address (not the sender)', async () => {
    const { txnBytes } = await TransactionService.buildRekeyTransaction({
      fromAddress: SENDER,
      rekeyToAddress: RECIPIENT,
    });
    const d = decodeBytes(txnBytes);
    expect(d.rekeyTo?.toString()).toBe(RECIPIENT);
    expect(d.rekeyTo?.toString()).not.toBe(SENDER);
  });
});

// ===========================================================================
// Rekey-reverse transaction (index.ts buildRekeyReverseTransaction)
// ===========================================================================

describe('buildRekeyReverseTransaction', () => {
  it('rekeys the account back to itself (authority returns to source)', async () => {
    const { txnBytes } = await TransactionService.buildRekeyReverseTransaction({
      fromAddress: SENDER,
    });
    const d = decodeBytes(txnBytes);

    expect(d.type).toBe('pay');
    expect(d.sender.toString()).toBe(SENDER);
    expect(d.payment?.receiver.toString()).toBe(SENDER);
    expect(d.payment?.amount).toBe(0n);
    // Reverse rekey: rekeyTo === the source account itself.
    expect(d.rekeyTo?.toString()).toBe(SENDER);
    expect(d.payment?.closeRemainderTo).toBeUndefined();
  });
});

// ===========================================================================
// Verification transaction (index.ts buildVerificationTransaction)
//
// This one is signed by an airgap device but NEVER submitted. It is CRITICAL
// that it does not rekey or close out — a bug here could turn a "prove you can
// sign" tap into a real authority transfer / drain if it were ever submitted.
// ===========================================================================

describe('buildVerificationTransaction', () => {
  it('is a harmless self-payment with NO rekey and NO close-out', async () => {
    const { txnBytes } = await TransactionService.buildVerificationTransaction({
      signerAddress: SIGNER,
    });
    const d = decodeBytes(txnBytes);

    expect(d.type).toBe('pay');
    expect(d.sender.toString()).toBe(SIGNER);
    expect(d.payment?.receiver.toString()).toBe(SIGNER);
    expect(d.payment?.amount).toBe(0n);
    // The whole point: a verification tx must never carry authority/drain fields.
    expect(d.rekeyTo).toBeUndefined();
    expect(d.payment?.closeRemainderTo).toBeUndefined();
    // Carries the explicit do-not-submit marker note.
    expect(TEXT.decode(d.note)).toBe(
      'Airgap signer verification - DO NOT SUBMIT'
    );
  });
});

// ===========================================================================
// Native VOI payment (index.ts buildVoiTransaction, via buildTransaction)
// ===========================================================================

describe('native VOI payment construction', () => {
  it('encodes a pay to the recipient with the right amount and no drain/rekey', async () => {
    const result = await TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 1_000_000,
      assetType: 'voi',
      note: 'voi-note',
    });
    expect('txnBytes' in result).toBe(true);
    const d = decodeBytes((result as { txnBytes: Uint8Array }).txnBytes);

    expect(d.type).toBe('pay');
    expect(d.sender.toString()).toBe(SENDER);
    // Funds go to the intended recipient — NOT back to the sender.
    expect(d.payment?.receiver.toString()).toBe(RECIPIENT);
    expect(d.payment?.receiver.toString()).not.toBe(SENDER);
    expect(d.payment?.amount).toBe(1_000_000n);
    // A normal send must never sweep the account or move signing authority.
    expect(d.payment?.closeRemainderTo).toBeUndefined();
    expect(d.rekeyTo).toBeUndefined();
    expect(d.fee).toBe(1000n);
    expect(TEXT.decode(d.note)).toBe('voi-note');
  });
});

// ===========================================================================
// ASA transfer (index.ts buildAsaTransaction, via buildTransaction)
// ===========================================================================

describe('ASA transfer construction', () => {
  it('encodes an axfer with the right asset, receiver, amount and no drain', async () => {
    const result = await TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 250,
      assetId: FIXTURE_ASSET_ID,
      assetType: 'asa',
      note: 'asa-note',
    });
    // Single-transaction result.
    expect('txnBytes' in result).toBe(true);
    const d = decodeBytes((result as { txnBytes: Uint8Array }).txnBytes);

    expect(d.type).toBe('axfer');
    expect(d.sender.toString()).toBe(SENDER);
    expect(d.assetTransfer?.assetIndex).toBe(BigInt(FIXTURE_ASSET_ID));
    expect(d.assetTransfer?.receiver.toString()).toBe(RECIPIENT);
    expect(d.assetTransfer?.amount).toBe(250n);
    // Danger fields: a plain transfer is NOT an asset close-out and NOT a rekey.
    expect(d.assetTransfer?.closeRemainderTo).toBeUndefined();
    expect(d.rekeyTo).toBeUndefined();
    expect(TEXT.decode(d.note)).toBe('asa-note');
  });

  it('carries the intended assetIndex, not a stale/zero id', async () => {
    const result = await TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 1,
      assetId: FIXTURE_ASSET_ID,
      assetType: 'asa',
    });
    const d = decodeBytes((result as { txnBytes: Uint8Array }).txnBytes);
    expect(d.assetTransfer?.assetIndex).toBe(BigInt(FIXTURE_ASSET_ID));
    expect(d.assetTransfer?.assetIndex).not.toBe(0n);
  });
});

// ===========================================================================
// ARC-200 transfer (arc200.ts buildArc200TransferGroup, via buildTransaction)
// ===========================================================================

describe('ARC-200 transfer construction', () => {
  const arc200Selector = new algosdk.ABIMethod({
    name: 'arc200_transfer',
    desc: '',
    args: [
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'value' },
    ],
    returns: { type: 'bool' },
  }).getSelector();

  const addressType = algosdk.ABIType.from('address');
  const uint256Type = algosdk.ABIType.from('uint256');

  it('encodes an appl call to the contract with correct ABI selector + args (no MBR when opted in)', async () => {
    const result = (await TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 42,
      contractId: FIXTURE_APP_ID,
      assetType: 'arc200',
    })) as { transactions: algosdk.Transaction[]; txnBytes: Uint8Array[] };

    // Recipient already holds the token -> single app-call, no MBR payment.
    expect(result.txnBytes).toHaveLength(1);
    const d = decodeBytes(result.txnBytes[0]);

    expect(d.type).toBe('appl');
    expect(d.sender.toString()).toBe(SENDER);
    expect(d.applicationCall?.appIndex).toBe(BigInt(FIXTURE_APP_ID));

    const appArgs = d.applicationCall?.appArgs ?? [];
    expect(appArgs).toHaveLength(3);
    // arg0 = method selector; arg1 = recipient address; arg2 = uint256 amount.
    expect(Buffer.from(appArgs[0]).toString('hex')).toBe(
      Buffer.from(arc200Selector).toString('hex')
    );
    expect(addressType.decode(appArgs[1])).toBe(RECIPIENT);
    expect(uint256Type.decode(appArgs[2])).toBe(42n);

    // App calls carry no rekey.
    expect(d.rekeyTo).toBeUndefined();
  });

  it('prepends an MBR payment to the app escrow when the recipient is not opted in', async () => {
    mockGetAlgodClient.mockReturnValueOnce({
      simulateTransactions: () => ({
        do: async () => ({
          txnGroups: [{ failureMessage: 'box minimum balance' }],
        }),
      }),
    });

    const result = (await TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 7,
      contractId: FIXTURE_APP_ID,
      assetType: 'arc200',
    })) as { transactions: algosdk.Transaction[]; txnBytes: Uint8Array[] };

    expect(result.txnBytes).toHaveLength(2);

    // Tx 0: MBR payment -> the APPLICATION ESCROW, not the recipient.
    const mbr = decodeBytes(result.txnBytes[0]);
    const escrow = algosdk.getApplicationAddress(FIXTURE_APP_ID).toString();
    expect(mbr.type).toBe('pay');
    expect(mbr.sender.toString()).toBe(SENDER);
    expect(mbr.payment?.receiver.toString()).toBe(escrow);
    expect(mbr.payment?.receiver.toString()).not.toBe(RECIPIENT);
    expect(mbr.payment?.amount).toBe(28500n);
    // The prepended MBR payment must not itself drain or rekey the account.
    expect(mbr.payment?.closeRemainderTo).toBeUndefined();
    expect(mbr.rekeyTo).toBeUndefined();

    // Tx 1: the ARC-200 app call.
    const call = decodeBytes(result.txnBytes[1]);
    expect(call.type).toBe('appl');
    expect(call.applicationCall?.appIndex).toBe(BigInt(FIXTURE_APP_ID));
    expect(call.rekeyTo).toBeUndefined();

    // Atomic group: both txns carry the canonical algosdk group id.
    expect(mbr.group).toBeDefined();
    expect(call.group).toBeDefined();
    expectCanonicalGroup(result.txnBytes);
  });

  it('propagates GROUP-LEVEL simulation box references onto the app call', async () => {
    const boxName = new Uint8Array(Buffer.from('arc200-balance-box'));
    // Simulation reports one unnamed box on THIS contract via the group-level
    // `unnamedResourcesAccessed`; the builder must carry it into the final app
    // call (dropping it would break the transfer). ARC-72's test covers the
    // per-transaction (txnResults) branch.
    mockGetAlgodClient.mockReturnValueOnce({
      simulateTransactions: () => ({
        do: async () => ({
          txnGroups: [
            {
              txnResults: [{ txnResult: {} }],
              unnamedResourcesAccessed: {
                boxes: [{ app: FIXTURE_APP_ID, name: boxName }],
              },
            },
          ],
        }),
      }),
    });

    const result = (await TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 3,
      contractId: FIXTURE_APP_ID,
      assetType: 'arc200',
    })) as { transactions: algosdk.Transaction[]; txnBytes: Uint8Array[] };

    const d = decodeBytes(result.txnBytes[0]);
    const boxes = d.applicationCall?.boxes ?? [];
    expect(boxes).toHaveLength(1);
    // appIndex 0 = a box on the called app itself (algosdk foreign-app index).
    expect(Number(boxes[0].appIndex)).toBe(0);
    expect(Buffer.from(boxes[0].name).toString()).toBe('arc200-balance-box');
  });
});

// ===========================================================================
// ARC-72 transfer (arc72.ts buildArc72TransferGroup, via buildTransaction)
// ===========================================================================

describe('ARC-72 transfer construction', () => {
  const arc72Selector = new algosdk.ABIMethod({
    name: 'arc72_transferFrom',
    desc: '',
    args: [
      { type: 'address', name: 'from' },
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'tokenId' },
    ],
    returns: { type: 'void' },
  }).getSelector();

  const addressType = algosdk.ABIType.from('address');
  const uint256Type = algosdk.ABIType.from('uint256');

  it('encodes arc72_transferFrom(from,to,tokenId) with correct selector + args (no MBR when opted in)', async () => {
    const result = (await TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 1,
      contractId: FIXTURE_APP_ID,
      tokenId: '99',
      assetType: 'arc72',
    })) as { transactions: algosdk.Transaction[]; txnBytes: Uint8Array[] };

    // Recipient already holds a token from this contract -> single app-call.
    expect(result.txnBytes).toHaveLength(1);
    const d = decodeBytes(result.txnBytes[0]);

    expect(d.type).toBe('appl');
    expect(d.sender.toString()).toBe(SENDER);
    expect(d.applicationCall?.appIndex).toBe(BigInt(FIXTURE_APP_ID));

    const appArgs = d.applicationCall?.appArgs ?? [];
    expect(appArgs).toHaveLength(4);
    // arg0 selector; arg1 from-owner; arg2 to-recipient; arg3 uint256 tokenId.
    expect(Buffer.from(appArgs[0]).toString('hex')).toBe(
      Buffer.from(arc72Selector).toString('hex')
    );
    expect(addressType.decode(appArgs[1])).toBe(SENDER);
    expect(addressType.decode(appArgs[2])).toBe(RECIPIENT);
    expect(uint256Type.decode(appArgs[3])).toBe(99n);

    expect(d.rekeyTo).toBeUndefined();
  });

  it('prepends an MBR payment to the app escrow when the recipient holds no token', async () => {
    // No ARC-72 asset for this contract -> needsMbrPayment.
    mockGetAccountBalance.mockResolvedValueOnce({ assets: [] });

    const result = (await TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 1,
      contractId: FIXTURE_APP_ID,
      tokenId: '5',
      assetType: 'arc72',
    })) as { transactions: algosdk.Transaction[]; txnBytes: Uint8Array[] };

    expect(result.txnBytes).toHaveLength(2);

    const mbr = decodeBytes(result.txnBytes[0]);
    const escrow = algosdk.getApplicationAddress(FIXTURE_APP_ID).toString();
    expect(mbr.type).toBe('pay');
    // MBR is funded by the sender, not some other account.
    expect(mbr.sender.toString()).toBe(SENDER);
    expect(mbr.payment?.receiver.toString()).toBe(escrow);
    expect(mbr.payment?.receiver.toString()).not.toBe(RECIPIENT);
    expect(mbr.payment?.amount).toBe(28500n);
    // The prepended MBR payment must not itself drain or rekey the account.
    expect(mbr.payment?.closeRemainderTo).toBeUndefined();
    expect(mbr.rekeyTo).toBeUndefined();

    const call = decodeBytes(result.txnBytes[1]);
    expect(call.type).toBe('appl');
    expect(call.applicationCall?.appIndex).toBe(BigInt(FIXTURE_APP_ID));
    expect(call.rekeyTo).toBeUndefined();

    // Both txns carry the canonical algosdk group id.
    expectCanonicalGroup(result.txnBytes);
  });

  it('propagates PER-TRANSACTION simulation box references onto the app call', async () => {
    const boxName = new Uint8Array(Buffer.from('arc72-owner-box'));
    // The builder merges boxes from BOTH the group-level and the per-transaction
    // (txnResults[i]) `unnamedResourcesAccessed`. This test exercises the
    // per-transaction branch (ARC-200's test covers the group-level branch), so a
    // regression that ignores either source is caught.
    mockGetAlgodClient.mockReturnValueOnce({
      simulateTransactions: () => ({
        do: async () => ({
          txnGroups: [
            {
              txnResults: [
                {
                  unnamedResourcesAccessed: {
                    boxes: [{ app: FIXTURE_APP_ID, name: boxName }],
                  },
                },
              ],
            },
          ],
        }),
      }),
    });

    const result = (await TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 1,
      contractId: FIXTURE_APP_ID,
      tokenId: '77',
      assetType: 'arc72',
    })) as { transactions: algosdk.Transaction[]; txnBytes: Uint8Array[] };

    // Recipient already holds a token (default mock) -> single app-call.
    const d = decodeBytes(result.txnBytes[0]);
    const boxes = d.applicationCall?.boxes ?? [];
    expect(boxes).toHaveLength(1);
    // appIndex 0 = a box on the called app itself (algosdk foreign-app index).
    expect(Number(boxes[0].appIndex)).toBe(0);
    expect(Buffer.from(boxes[0].name).toString()).toBe('arc72-owner-box');
  });
});

test('signing preflight uses the request network and fails closed on strict lookup failure', async () => {
  const { SecureKeyManager } = require('@/services/secure/keyManager');
  const { NetworkId } = require('@/types/network');
  const account = {
    address: SENDER,
    type: 'rekeyed',
    authAddress: 'STALE',
    canSign: true,
  };
  SecureKeyManager.getSigningInfo.mockResolvedValue({ canSign: false });
  SecureKeyManager.getLedgerSigningInfo.mockRejectedValue(
    new Error('not ledger')
  );
  const errors: string[] = [];
  await (TransactionService as any).appendSigningValidation(
    errors,
    account,
    NetworkId.ALGORAND_MAINNET
  );
  expect(errors).toHaveLength(1);
  expect(SecureKeyManager.getSigningInfo).toHaveBeenCalledWith(
    SENDER,
    NetworkId.ALGORAND_MAINNET
  );
  SecureKeyManager.getSigningInfo.mockRejectedValue(new Error('offline'));
  errors.length = 0;
  await (TransactionService as any).appendSigningValidation(
    errors,
    account,
    NetworkId.ALGORAND_MAINNET
  );
  expect(errors).toEqual([
    'Unable to verify signing authority. Please try again.',
  ]);
});

it('bounds each ARC-200 simulation to 10 seconds and funds on timeout', async () => {
  jest.useFakeTimers();
  const simulate = jest.fn(() => new Promise(() => {}));
  mockGetAlgodClient.mockReturnValue({
    simulateTransactions: () => ({ do: simulate }),
  });
  try {
    const pending = TransactionService.buildTransaction({
      from: SENDER,
      to: RECIPIENT,
      amount: 1,
      contractId: FIXTURE_APP_ID,
      assetType: 'arc200',
    });
    await jest.advanceTimersByTimeAsync(10000);
    expect(simulate).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10000);
    const result = (await pending) as { txnBytes: Uint8Array[] };
    expect(decodeBytes(result.txnBytes[0]).payment?.amount).toBe(28500n);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it('passes validation cost estimation the request network', async () => {
  const {
    Arc200TransactionService: Arc,
  } = require('@/services/transactions/arc200');
  const { SecureKeyManager } = require('@/services/secure/keyManager');
  const { NetworkId } = require('@/types/network');
  const estimate = jest.spyOn(Arc, 'estimateArc200TransferCost');
  mockGetAccountBalance.mockResolvedValue({
    amount: 1000000,
    assets: [{ assetType: 'arc200', contractId: FIXTURE_APP_ID, amount: 10 }],
  });
  try {
    await TransactionService.validateTransaction(
      {
        from: SENDER,
        to: RECIPIENT,
        amount: 1,
        assetType: 'arc200',
        contractId: FIXTURE_APP_ID,
        networkId: NetworkId.ALGORAND_MAINNET,
      },
      { address: SENDER, type: AccountType.STANDARD }
    );
    expect(estimate).toHaveBeenCalledWith(
      expect.objectContaining({ networkId: NetworkId.ALGORAND_MAINNET })
    );
    expect(SecureKeyManager.getSigningInfo).toHaveBeenCalledWith(
      SENDER,
      NetworkId.ALGORAND_MAINNET
    );
  } finally {
    estimate.mockRestore();
  }
});

// The request network, rather than persisted account kind/authority, owns this verdict.
it.each([false, true])(
  'rekey duplicate check uses chain state (%s)',
  async (isRekeyed) => {
    mockGetAccountBalance.mockResolvedValue({
      amount: 1000000n,
      minBalance: 100000n,
      rekeyInfo: { isRekeyed, authAddress: isRekeyed ? RECIPIENT : undefined },
    });
    const errors = await TransactionService.validateRekeyTransaction(
      SENDER,
      RECIPIENT,
      {
        accounts: [
          {
            address: SENDER,
            type: isRekeyed ? AccountType.STANDARD : AccountType.REKEYED,
            authAddress: RECIPIENT,
            canSign: false,
          },
          { address: RECIPIENT, type: AccountType.STANDARD },
        ],
      }
    );
    expect(errors.includes('Account is already rekeyed to this address')).toBe(
      isRekeyed
    );
    expect(errors).not.toContain('Failed to validate transaction requirements');
  }
);

// TASK-425 U3: target, controller and source authority follow own-key custody
// and chain state, not the persisted kind.
describe('validateRekeyTransaction own-key custody (TASK-425 U3)', () => {
  const CONTROLLER = makeAddress('tx-construction:controller');
  const TARGET_ERROR =
    'Target address must be an account whose key you hold, a Ledger, or an airgap signer account in your wallet';
  const SOURCE_ERROR =
    'This account is not rekeyed on this network and its key is not in your wallet, so it cannot sign a rekey.';
  const funded = (rekeyInfo: { isRekeyed: boolean; authAddress?: string }) =>
    mockGetAccountBalance.mockResolvedValue({
      amount: 1000000n,
      minBalance: 100000n,
      rekeyInfo,
    });
  const validate = (accounts: unknown[]) =>
    TransactionService.validateRekeyTransaction(SENDER, RECIPIENT, {
      accounts,
    });

  const REVERSE_ERROR =
    "Removing the rekey returns control to this account's own key, which is not in your wallet.";
  const UNKNOWN_ERROR =
    "Couldn't check this account's rekey status on this network. Try again.";

  beforeEach(() => {
    mockProbe.mockReset();
    mockProbe.mockResolvedValue(false);
    mockGetPrivateKey.mockReset();
    mockGetPrivateKey.mockRejectedValue(new Error('no key'));
  });

  it('accepts a REKEYED target that is a converted STANDARD account (originalOwner)', async () => {
    funded({ isRekeyed: false });
    mockProbe.mockImplementation(async (id) => id === 'tgt');
    const errors = await validate([
      { id: 'src', address: SENDER, type: AccountType.STANDARD },
      {
        id: 'tgt',
        address: RECIPIENT,
        type: AccountType.REKEYED,
        originalOwner: true,
      },
    ]);
    expect(errors).toEqual([]);
  });

  it('accepts a REKEYED target whose key reads and is its own', async () => {
    const TGT = makeAccount('tx-construction:usable-target');
    funded({ isRekeyed: false });
    mockProbe.mockResolvedValue(true);
    mockGetPrivateKey.mockImplementation(async () => TGT.sk.slice());
    const errors = await TransactionService.validateRekeyTransaction(
      SENDER,
      TGT.addr,
      {
        accounts: [
          { id: 'src', address: SENDER, type: AccountType.STANDARD },
          { id: 'tgt', address: TGT.addr, type: AccountType.REKEYED },
        ],
      }
    );
    expect(errors).toEqual([]);
  });

  it('rejects a REKEYED target that probes present but has no readable key', async () => {
    funded({ isRekeyed: false });
    mockProbe.mockResolvedValue(true);
    const errors = await validate([
      { id: 'src', address: SENDER, type: AccountType.STANDARD },
      { id: 'tgt', address: RECIPIENT, type: AccountType.REKEYED },
    ]);
    expect(errors).toContain(TARGET_ERROR);
  });

  it.each([
    ['missing', undefined],
    ['unavailable', { isRekeyed: false, unavailable: true }],
    ['rekeyed without an auth address', { isRekeyed: true }],
  ])('fails closed when rekey state is %s', async (_label, rekeyInfo) => {
    mockGetAccountBalance.mockResolvedValue({
      amount: 1000000n,
      minBalance: 100000n,
      rekeyInfo,
    });
    const errors = await validate([
      { id: 'src', address: SENDER, type: AccountType.STANDARD },
      { id: 'tgt', address: RECIPIENT, type: AccountType.STANDARD },
    ]);
    expect(errors).toEqual([UNKNOWN_ERROR]);
  });

  it.each([
    ['WATCH', AccountType.WATCH, {}, false],
    ['keyless REKEYED', AccountType.REKEYED, {}, false],
    ['STANDARD', AccountType.STANDARD, {}, true],
    [
      'originalOwner REKEYED',
      AccountType.REKEYED,
      { originalOwner: true },
      true,
    ],
    ['LEDGER', AccountType.LEDGER, {}, true],
    ['REMOTE_SIGNER', AccountType.REMOTE_SIGNER, {}, true],
  ])(
    'removing a rekey from a %s source needs its own key afterwards',
    async (_label, type, extra, allowed) => {
      funded({ isRekeyed: true, authAddress: CONTROLLER });
      mockProbe.mockImplementation(async (id) => id === 'src');
      const errors = await TransactionService.validateRekeyTransaction(
        SENDER,
        SENDER,
        {
          accounts: [
            { id: 'src', address: SENDER, type, ...extra },
            { id: 'ctl', address: CONTROLLER, type: AccountType.STANDARD },
          ],
        }
      );
      expect(errors.includes(REVERSE_ERROR)).toBe(!allowed);
      if (allowed) expect(errors).toEqual([]);
    }
  );

  it.each([AccountType.LEDGER, AccountType.REMOTE_SIGNER])(
    'an unrekeyed %s source signs as itself without a software key',
    async (type) => {
      funded({ isRekeyed: false });
      const errors = await validate([
        { id: 'src', address: SENDER, type },
        { id: 'tgt', address: RECIPIENT, type: AccountType.STANDARD },
      ]);
      expect(errors).not.toContain(SOURCE_ERROR);
    }
  );

  it.each([
    ['REKEYED without its key', AccountType.REKEYED],
    ['WATCH', AccountType.WATCH],
  ])('rejects a %s target', async (_label, type) => {
    funded({ isRekeyed: false });
    const errors = await validate([
      { id: 'src', address: SENDER, type: AccountType.STANDARD },
      { id: 'tgt', address: RECIPIENT, type },
    ]);
    expect(errors).toContain(TARGET_ERROR);
  });

  it('accepts a controller that is a REKEYED record holding its own key', async () => {
    funded({ isRekeyed: true, authAddress: CONTROLLER });
    mockProbe.mockImplementation(async (id) => id === 'ctl');
    const errors = await validate([
      { id: 'src', address: SENDER, type: AccountType.WATCH },
      { id: 'ctl', address: CONTROLLER, type: AccountType.REKEYED },
      { id: 'tgt', address: RECIPIENT, type: AccountType.STANDARD },
    ]);
    expect(errors).toEqual([]);
  });

  it('rejects a controller that is a REKEYED record without its key', async () => {
    funded({ isRekeyed: true, authAddress: CONTROLLER });
    const errors = await validate([
      { id: 'src', address: SENDER, type: AccountType.WATCH },
      { id: 'ctl', address: CONTROLLER, type: AccountType.REKEYED },
      { id: 'tgt', address: RECIPIENT, type: AccountType.STANDARD },
    ]);
    expect(errors).toEqual([
      expect.stringContaining('You need this controlling account'),
    ]);
  });

  it.each([
    ['WATCH', AccountType.WATCH, false],
    ['REKEYED without its key', AccountType.REKEYED, false],
    ['REKEYED holding its key', AccountType.REKEYED, true],
    ['STANDARD', AccountType.STANDARD, false],
  ])(
    'unrekeyed %s source signs as itself only with its own key',
    async (_label, type, held) => {
      funded({ isRekeyed: false });
      mockProbe.mockImplementation(async (id) => held && id === 'src');
      const errors = await validate([
        { id: 'src', address: SENDER, type },
        { id: 'tgt', address: RECIPIENT, type: AccountType.STANDARD },
      ]);
      const ownsKey = type === AccountType.STANDARD || held;
      expect(errors.includes(SOURCE_ERROR)).toBe(!ownsKey);
    }
  );

  it('a rekeyed WATCH source is judged by its controller, not by its own key', async () => {
    funded({ isRekeyed: true, authAddress: CONTROLLER });
    const errors = await validate([
      { id: 'src', address: SENDER, type: AccountType.WATCH },
      { id: 'ctl', address: CONTROLLER, type: AccountType.STANDARD },
      { id: 'tgt', address: RECIPIENT, type: AccountType.STANDARD },
    ]);
    expect(errors).toEqual([]);
  });
});

// TASK-425 U3 Codex confirm 2: the builders are the last step before every
// signing path, so they re-check that the key receiving authority is held.
describe('rekey builders re-check the receiving key (TASK-425 U3)', () => {
  const REFUSED =
    'The account receiving signing authority has no key in this wallet. Rekey cancelled.';
  const only = (accounts: { id: string; address: string; type: string }[]) =>
    mockCurrentWallet.mockResolvedValueOnce({ accounts });

  beforeEach(() => {
    mockGetSuggestedParams.mockResolvedValue(SUGGESTED_PARAMS);
  });

  it.each([
    ['WATCH', AccountType.WATCH],
    ['keyless REKEYED', AccountType.REKEYED],
  ])('buildRekeyTransaction refuses a %s target', async (_label, type) => {
    only([
      { id: 'sender', address: SENDER, type: AccountType.STANDARD },
      { id: 'tgt', address: RECIPIENT, type },
    ]);
    await expect(
      TransactionService.buildRekeyTransaction({
        fromAddress: SENDER,
        rekeyToAddress: RECIPIENT,
        note: 'u3-refuse',
      })
    ).rejects.toThrow(REFUSED);
  });

  it('buildRekeyReverseTransaction refuses when the source key is gone', async () => {
    only([{ id: 'sender', address: SENDER, type: AccountType.WATCH }]);
    await expect(
      TransactionService.buildRekeyReverseTransaction({
        fromAddress: SENDER,
        note: 'u3-refuse-reverse',
      })
    ).rejects.toThrow(REFUSED);
  });

  it('re-checks even when the transaction is already cached', async () => {
    const params = { fromAddress: SENDER, note: 'u3-cached' };
    await TransactionService.buildRekeyReverseTransaction(params);
    only([{ id: 'sender', address: SENDER, type: AccountType.WATCH }]);
    await expect(
      TransactionService.buildRekeyReverseTransaction(params)
    ).rejects.toThrow(REFUSED);
  });

  it.each([
    ['sendRekeyTransaction', RECIPIENT],
    ['sendRekeyReverseTransaction', SENDER],
  ])(
    '%s does not submit when the receiving key is lost while signing',
    async (method, receiver) => {
      const sign = jest
        .spyOn(TransactionService as any, 'signTransactionWithRecovery')
        .mockImplementation(async () => {
          // A Ledger approval or PIN wait: meanwhile the receiver loses its key.
          mockCurrentWallet.mockResolvedValue({
            accounts: [
              { id: 'sender', address: SENDER, type: AccountType.WATCH },
              { id: 'recipient', address: receiver, type: AccountType.WATCH },
            ],
          });
          return new Uint8Array([1]);
        });
      const submit = jest
        .spyOn(TransactionService as any, 'submitWithRetries')
        .mockResolvedValue({ txId: 'TX', confirmed: true });
      try {
        await expect(
          (TransactionService as any)[method](
            {
              fromAddress: SENDER,
              rekeyToAddress: RECIPIENT,
              note: `u3-${method}`,
            },
            { address: SENDER }
          )
        ).rejects.toThrow(REFUSED);
        expect(sign).toHaveBeenCalled();
        expect(submit).not.toHaveBeenCalled();
      } finally {
        sign.mockRestore();
        submit.mockRestore();
        mockCurrentWallet.mockReset();
        mockCurrentWallet.mockImplementation(async () => ({
          accounts: [
            { id: 'sender', address: SENDER, type: 'standard' },
            { id: 'recipient', address: RECIPIENT, type: 'standard' },
          ],
        }));
      }
    }
  );
});
