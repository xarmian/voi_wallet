/**
 * TASK-259 — what the signing-review screen SHOWS must equal what gets signed.
 *
 * The defects these tests pin:
 *   1. `txnAny.assetIndex` does not exist in algosdk v3 (it lives on
 *      `txn.assetTransfer.assetIndex`), so `assetId` was always undefined and a
 *      10 USDC transfer rendered as "10 ALGO" — the network currency.
 *   2. ASA metadata was resolved (when at all) against the ACTIVE network.
 *      WalletConnect never calls `switchNetwork`, so reviewing an Algorand
 *      request on a Voi-active wallet read the wrong chain's asset params.
 *   3. amounts were narrowed through `Number()`, so a uint64 above
 *      MAX_SAFE_INTEGER could display something other than the signed bytes.
 *   4. the screen named ONE account while an ARC-0001 group may span several.
 *   5. an unrecognized chain HID the network section instead of warning.
 *
 * Nothing cryptographic is mocked: the transactions are real algosdk v3 objects
 * built from real deterministic fixture accounts. Only leaf transports
 * (algod asset params, wallet storage, the signing-route lookup) are stubbed.
 * No mnemonic or secret key is logged.
 */

import React from 'react';
import { render, waitFor } from '@testing-library/react-native';
import algosdk from 'algosdk';
import { Buffer } from 'buffer';

import { makeAccount } from '@/__tests__/fixtures/algorand';
import { NetworkId } from '@/types/network';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';

const VOI = NetworkId.VOI_MAINNET;
const ALGO = NetworkId.ALGORAND_MAINNET;

// ---------------------------------------------------------------------------
// Mutable per-test state (all `mock`-prefixed so jest.mock factories may close
// over them; the factories read them lazily at call time).
// ---------------------------------------------------------------------------
type AssetParamsStub = { decimals: number; name?: string; unitName?: string };

let mockAssetParams: Record<string, Record<string, AssetParamsStub | null>>;
let mockAccounts: {
  id: string;
  address: string;
  type: string;
  label: string;
}[];
let mockRoutes: Record<string, unknown>;
const mockGetCachedAssetParams = jest.fn();
const mockResolveSigningRoute = jest.fn();

// `@/utils/bigint` re-exports through `@/utils/formatting`, which pulls in the
// zustand wallet store (and therefore AsyncStorage). Only the locale lookup is
// involved, so a minimal store stub keeps this a pure display test.
jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: undefined }) },
}));

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (networkId: string) => ({
      getCachedAssetParams: (assetId: number) =>
        mockGetCachedAssetParams(networkId, assetId),
    }),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAllAccounts: async () => mockAccounts,
  },
}));

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    resolveSigningRoute: (address: string, networkId?: string) =>
      mockResolveSigningRoute(address, networkId),
  },
}));

jest.mock('@/services/auth/transactionAuthController', () => ({
  useTransactionAuthController: () => ({ cleanup: jest.fn() }),
}));

jest.mock('@/services/navigation/callbackRegistry', () => ({
  getNavigationCallbacks: () => undefined,
  clearNavigationCallbacks: jest.fn(),
}));

jest.mock('@/components/UnifiedTransactionAuthModal', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

import UniversalTransactionSigningScreen from '../UniversalTransactionSigningScreen';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USDC = 31566704n;

function paramsFor(networkId: NetworkId): algosdk.SuggestedParams {
  const config = NETWORK_CONFIGURATIONS[networkId];
  return {
    fee: 1000,
    firstValid: 1,
    lastValid: 1001,
    genesisID: config.genesisId,
    genesisHash: new Uint8Array(Buffer.from(config.genesisHash, 'base64')),
    flatFee: true,
    minFee: 1000,
  };
}

function axfer(
  networkId: NetworkId,
  sender: string,
  assetIndex: bigint,
  amount: bigint
): algosdk.Transaction {
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount,
    assetIndex,
    suggestedParams: paramsFor(networkId),
  });
}

function pay(
  networkId: NetworkId,
  sender: string,
  amount: number
): algosdk.Transaction {
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount,
    suggestedParams: paramsFor(networkId),
  });
}

const b64 = (txn: algosdk.Transaction): string =>
  Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64');

const chainIdOf = (networkId: NetworkId): string =>
  NETWORK_CONFIGURATIONS[networkId].chainId;

const navigationStub = {
  canGoBack: () => false,
  goBack: jest.fn(),
  navigate: jest.fn(),
  replace: jest.fn(),
} as never;

function walletAccount(label: string, address: string) {
  return {
    id: `acct-${label}`,
    address,
    type: 'standard',
    label,
    color: '#000000',
  };
}

/**
 * Render the screen for a WalletConnect request bound to `networkId`, with the
 * given ARC-0001 entries and session-approved accounts.
 */
function renderScreen(options: {
  networkId: NetworkId;
  entries: { txn: string; signers?: string[]; authAddr?: string }[];
  approved: string[];
  reviewedAccount: { address: string; label: string };
  chainIdOverride?: string;
  walletConnect?: boolean;
}) {
  const {
    networkId,
    entries,
    approved,
    reviewedAccount,
    chainIdOverride,
    walletConnect = true,
  } = options;
  const chainId = chainIdOverride ?? chainIdOf(networkId);

  const params: Record<string, unknown> = {
    transactions: entries.map((e) => e.txn),
    account: walletAccount(reviewedAccount.label, reviewedAccount.address),
    networkId,
    chainId,
    title: 'WalletConnect Request',
  };
  if (walletConnect) {
    params.walletConnect = {
      transactions: entries,
      binding: {
        topic: 'topic-under-test',
        chainId,
        networkId,
        approvedAccounts: approved.map((a) => `${chainId}:${a}`),
      },
    };
  }

  return render(
    <UniversalTransactionSigningScreen
      navigation={navigationStub}
      route={{ params } as never}
    />
  );
}

beforeEach(() => {
  mockAssetParams = {};
  mockAccounts = [];
  mockRoutes = {};
  mockGetCachedAssetParams.mockImplementation(
    async (networkId: string, assetId: number) =>
      mockAssetParams[networkId]?.[String(assetId)] ?? null
  );
  mockResolveSigningRoute.mockImplementation(async (address: string) => {
    return (
      mockRoutes[address] ?? {
        kind: 'unavailable',
        reason: 'Account not found',
      }
    );
  });
});

afterEach(() => {
  jest.clearAllMocks();
});

// ===========================================================================

describe('UniversalTransactionSigningScreen — asset display', () => {
  it('renders a 10 USDC Algorand transfer as USDC while the wallet is on Voi', async () => {
    const owner = makeAccount('display-usdc').addr;
    mockAccounts = [walletAccount('Main', owner)];
    mockRoutes[owner] = { kind: 'software', signingAddress: owner };
    // Resolved on the TRANSACTION's network. The Voi entry is a decoy: if the
    // screen resolved against the active network it would pick this up.
    mockAssetParams[ALGO] = {
      [USDC.toString()]: { decimals: 6, unitName: 'USDC' },
    };
    mockAssetParams[VOI] = {
      [USDC.toString()]: { decimals: 2, unitName: 'WRONG' },
    };

    const txn = axfer(ALGO, owner, USDC, 10_000_000n);
    const screen = renderScreen({
      networkId: ALGO,
      entries: [{ txn: b64(txn) }],
      approved: [owner],
      reviewedAccount: { address: owner, label: 'Main' },
    });

    await waitFor(() => {
      expect(screen.getByText('10 USDC')).toBeTruthy();
    });
    // The old bug rendered the ASA amount with the network's native symbol.
    expect(screen.queryByText('10 ALGO')).toBeNull();
    expect(mockGetCachedAssetParams).toHaveBeenCalledWith(ALGO, 31566704);
    expect(mockGetCachedAssetParams).not.toHaveBeenCalledWith(
      VOI,
      expect.anything()
    );
  });

  it('uses the asset decimals, not a hardcoded 1e6', async () => {
    const owner = makeAccount('display-decimals').addr;
    mockAccounts = [walletAccount('Main', owner)];
    mockRoutes[owner] = { kind: 'software', signingAddress: owner };
    mockAssetParams[VOI] = { '777': { decimals: 2, unitName: 'CENT' } };

    const screen = renderScreen({
      networkId: VOI,
      entries: [{ txn: b64(axfer(VOI, owner, 777n, 12_345n)) }],
      approved: [owner],
      reviewedAccount: { address: owner, label: 'Main' },
    });

    // 12345 base units at 2 decimals = 123.45, NOT 0.012345.
    await waitFor(() => {
      expect(screen.getByText('123.45 CENT')).toBeTruthy();
    });
  });

  it('never falls back to the network currency when metadata is unavailable', async () => {
    const owner = makeAccount('display-unknown-asset').addr;
    mockAccounts = [walletAccount('Main', owner)];
    mockRoutes[owner] = { kind: 'software', signingAddress: owner };
    // No params registered -> getCachedAssetParams resolves null.

    const screen = renderScreen({
      networkId: VOI,
      entries: [{ txn: b64(axfer(VOI, owner, 4242n, 5_000_000n)) }],
      approved: [owner],
      reviewedAccount: { address: owner, label: 'Main' },
    });

    await waitFor(() => {
      expect(screen.getByText('5000000 base units of ASA #4242')).toBeTruthy();
    });
    // The active lie this task removes: an ASA amount labelled with the
    // network's own currency.
    expect(screen.queryByText('5 VOI')).toBeNull();
  });

  it('displays a uint64 amount above MAX_SAFE_INTEGER exactly', async () => {
    const owner = makeAccount('display-uint64').addr;
    mockAccounts = [walletAccount('Main', owner)];
    mockRoutes[owner] = { kind: 'software', signingAddress: owner };
    mockAssetParams[VOI] = { '9001': { decimals: 0, unitName: 'BIG' } };

    // Well beyond 2^53; a Number() narrowing anywhere would round this.
    const amount = 18446744073709551615n;
    const screen = renderScreen({
      networkId: VOI,
      entries: [{ txn: b64(axfer(VOI, owner, 9001n, amount)) }],
      approved: [owner],
      reviewedAccount: { address: owner, label: 'Main' },
    });

    await waitFor(() => {
      expect(screen.getByText(`${amount.toString()} BIG`)).toBeTruthy();
    });
  });

  it('labels a native payment with the transaction network currency', async () => {
    const owner = makeAccount('display-native').addr;
    mockAccounts = [walletAccount('Main', owner)];
    mockRoutes[owner] = { kind: 'software', signingAddress: owner };

    const screen = renderScreen({
      networkId: ALGO,
      entries: [{ txn: b64(pay(ALGO, owner, 1_500_000)) }],
      approved: [owner],
      reviewedAccount: { address: owner, label: 'Main' },
    });

    await waitFor(() => {
      expect(screen.getByText('1.5 ALGO')).toBeTruthy();
    });
  });
});

describe('UniversalTransactionSigningScreen — signer list', () => {
  it('names EVERY account that will sign, with its signing method', async () => {
    const a = makeAccount('signer-a').addr;
    const b = makeAccount('signer-b').addr;
    mockAccounts = [walletAccount('Alpha', a), walletAccount('Beta', b)];
    mockRoutes[a] = { kind: 'software', signingAddress: a };
    mockRoutes[b] = { kind: 'software', signingAddress: b };

    const screen = renderScreen({
      networkId: VOI,
      entries: [{ txn: b64(pay(VOI, a, 1)) }, { txn: b64(pay(VOI, b, 2)) }],
      approved: [a, b],
      reviewedAccount: { address: a, label: 'Alpha' },
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Signs with Alpha/).length).toBeGreaterThan(0);
    });
    // The second account is NAMED — the whole point of widening eligibility.
    expect(screen.getAllByText(/Signs with Beta/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Software key/).length).toBe(2);
  });

  it('shows a declined entry as declined, with its reason', async () => {
    const a = makeAccount('signer-declined-a').addr;
    mockAccounts = [walletAccount('Alpha', a)];
    mockRoutes[a] = { kind: 'software', signingAddress: a };

    const screen = renderScreen({
      networkId: VOI,
      entries: [
        { txn: b64(pay(VOI, a, 1)) },
        // The dApp explicitly asked another wallet to sign this one.
        { txn: b64(pay(VOI, a, 2)), signers: [] },
      ],
      approved: [a],
      reviewedAccount: { address: a, label: 'Alpha' },
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Declined — the dApp asked another wallet to sign/)
      ).toBeTruthy();
    });
  });

  it('declines — visibly — a sender this wallet does not hold', async () => {
    const mine = makeAccount('signer-mine').addr;
    const theirs = makeAccount('signer-theirs').addr;
    mockAccounts = [walletAccount('Alpha', mine)];
    mockRoutes[mine] = { kind: 'software', signingAddress: mine };

    const screen = renderScreen({
      networkId: VOI,
      entries: [
        { txn: b64(pay(VOI, mine, 1)) },
        { txn: b64(pay(VOI, theirs, 2)) },
      ],
      approved: [mine, theirs],
      reviewedAccount: { address: mine, label: 'Alpha' },
    });

    await waitFor(() => {
      expect(screen.getByText(/does not hold this account/)).toBeTruthy();
    });
  });

  it('surfaces a Ledger signer as Ledger, and its rekey authority', async () => {
    const owner = makeAccount('signer-ledger').addr;
    const device = makeAccount('signer-ledger-device').addr;
    mockAccounts = [walletAccount('Cold', owner)];
    mockRoutes[owner] = {
      kind: 'ledger',
      ledgerAccount: { derivationIndex: 0 },
      signerAddress: device,
      viaRekey: true,
      rekeyedTo: device,
    };

    const screen = renderScreen({
      networkId: VOI,
      entries: [{ txn: b64(pay(VOI, owner, 1)) }],
      approved: [owner],
      reviewedAccount: { address: owner, label: 'Cold' },
    });

    await waitFor(() => {
      expect(screen.getAllByText(/Ledger/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/rekeyed to/i).length).toBeGreaterThan(0);
  });

  it('reports that nothing is signable rather than silently signing nothing', async () => {
    const theirs = makeAccount('signer-none').addr;
    mockAccounts = [];

    const screen = renderScreen({
      networkId: VOI,
      entries: [{ txn: b64(pay(VOI, theirs, 1)) }],
      approved: [theirs],
      reviewedAccount: { address: theirs, label: 'Ghost' },
    });

    await waitFor(() => {
      expect(
        screen.getByText(/No account in this request can be signed/)
      ).toBeTruthy();
    });
  });
});

describe('UniversalTransactionSigningScreen — unknown chain', () => {
  it('warns instead of hiding the network section', async () => {
    const owner = makeAccount('chain-unknown').addr;
    mockAccounts = [walletAccount('Main', owner)];
    mockRoutes[owner] = { kind: 'software', signingAddress: owner };

    const screen = renderScreen({
      networkId: VOI,
      entries: [{ txn: b64(pay(VOI, owner, 1)) }],
      approved: [owner],
      reviewedAccount: { address: owner, label: 'Main' },
      chainIdOverride: 'algorand:not-a-chain-we-know',
    });

    await waitFor(() => {
      expect(screen.getByText('Unrecognized network')).toBeTruthy();
    });
    expect(
      screen.getByText(/cannot identify the network these transactions target/)
    ).toBeTruthy();
    // And it must not invent a currency for the amounts.
    expect(screen.queryByText(/ VOI$/)).toBeNull();
  });

  it('names a recognized network normally', async () => {
    const owner = makeAccount('chain-known').addr;
    mockAccounts = [walletAccount('Main', owner)];
    mockRoutes[owner] = { kind: 'software', signingAddress: owner };

    const screen = renderScreen({
      networkId: ALGO,
      entries: [{ txn: b64(pay(ALGO, owner, 1)) }],
      approved: [owner],
      reviewedAccount: { address: owner, label: 'Main' },
    });

    await waitFor(() => {
      expect(screen.getByText('Algorand')).toBeTruthy();
    });
    expect(screen.queryByText('Unrecognized network')).toBeNull();
  });
});
