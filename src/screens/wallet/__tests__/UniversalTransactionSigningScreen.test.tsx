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
import { AppState, type AppStateStatus } from 'react-native';
import { render, waitFor, fireEvent, act } from '@testing-library/react-native';
import algosdk from 'algosdk';
import { Buffer } from 'buffer';

import { makeAccount } from '@/__tests__/fixtures/algorand';
import { NetworkId } from '@/types/network';
import { truncateAddress } from '@/services/walletconnect/utils';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';

const VOI = NetworkId.VOI_MAINNET;
const ALGO = NetworkId.ALGORAND_MAINNET;

// ---------------------------------------------------------------------------
// Mutable per-test state (all `mock`-prefixed so jest.mock factories may close
// over them; the factories read them lazily at call time).
// ---------------------------------------------------------------------------
type AssetParamsStub = { decimals: number; name?: string; unitName?: string };

let mockLocked = false;
let mockModalProps: any;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: {
      isLocked: mockLocked,
      isAuthenticated: !mockLocked,
      biometricEnabled: false,
    },
  }),
}));
jest.mock('@/services/secure/sessionTeardown', () => ({
  clearSessionSecurity: jest.fn(() =>
    require('@/services/secure/SessionKeyVault').SessionKeyVault.clear()
  ),
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getCredentialSource: jest.fn(async () => 'pin'),
    verifyPin: jest.fn(),
    getBiometricSecret: jest.fn(),
    isBiometricEnabled: jest.fn(),
  },
}));

let mockAssetParams: Record<string, Record<string, AssetParamsStub | null>>;
let mockAccounts: {
  id: string;
  address: string;
  type: string;
  label: string;
}[];
let mockRoutes: Record<string, unknown>;
const mockGetCachedAssetParams = jest.fn();
const mockGetAssetInfo = jest.fn();
const mockResolveSigningRoute = jest.fn();
/** Registry callbacks by id (TASK-257: onDismiss on unmount). */
let mockRegistry: Record<
  string,
  { onDismiss?: () => void; onReject?: () => Promise<void> }
> = {};

// `@/utils/bigint` re-exports through `@/utils/formatting`, which pulls in the
// zustand wallet store (and therefore AsyncStorage). Only the locale lookup is
// involved, so a minimal store stub keeps this a pure display test.
jest.mock('expo-local-authentication', () => ({
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(),
  AuthenticationType: { FACIAL_RECOGNITION: 2 },
}));

jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: undefined }) },
}));

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (networkId: string) => ({
      getCachedAssetParams: (assetId: number) =>
        mockGetCachedAssetParams(networkId, assetId),
      getAssetInfo: (assetId: number) => mockGetAssetInfo(networkId, assetId),
    }),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAllAccounts: async () => mockAccounts,
  },
}));

const mockPreventCapture = jest.fn();
const mockEnableAppSwitcherProtection = jest.fn(
  async (_intensity?: number) => {}
);
jest.mock('expo-screen-capture', () => ({
  usePreventScreenCapture: (key?: string) => mockPreventCapture(key),
  enableAppSwitcherProtectionAsync: (intensity?: number) =>
    mockEnableAppSwitcherProtection(intensity),
  disableAppSwitcherProtectionAsync: async () => {},
}));

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    resolveSigningRoute: (address: string, networkId?: string) =>
      mockResolveSigningRoute(address, networkId),
  },
}));

jest.mock('@/services/auth/transactionAuthController', () => ({
  useTransactionAuthController: () => ({
    cleanup: jest.fn(),
    cancel: jest.fn(),
  }),
}));

jest.mock('@/services/navigation/callbackRegistry', () => ({
  getNavigationCallbacks: (id?: string) => (id ? mockRegistry[id] : undefined),
  clearNavigationCallbacks: jest.fn(),
}));

jest.mock('@/components/UnifiedTransactionAuthModal', () => ({
  __esModule: true,
  default: (props: any) => {
    mockModalProps = props;
    return null;
  },
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
  amount: number,
  note?: string
): algosdk.Transaction {
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver: sender,
    amount,
    suggestedParams: paramsFor(networkId),
    note: note ? Buffer.from(note) : undefined,
  });
}

const b64 = (txn: algosdk.Transaction): string =>
  Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64');

const chainIdOf = (networkId: NetworkId): string =>
  NETWORK_CONFIGURATIONS[networkId].chainId;

let mockBeforeRemove: (() => void)[] = [];
const navigationStub = {
  canGoBack: () => false,
  goBack: jest.fn(),
  navigate: jest.fn(),
  replace: jest.fn(),
  addListener: (event: string, listener: () => void) => {
    if (event === 'beforeRemove') mockBeforeRemove.push(listener);
    return () => {
      mockBeforeRemove = mockBeforeRemove.filter((l) => l !== listener);
    };
  },
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
  callbackId?: string;
}) {
  const {
    networkId,
    entries,
    approved,
    reviewedAccount,
    chainIdOverride,
    walletConnect = true,
    callbackId,
  } = options;
  const chainId = chainIdOverride ?? chainIdOf(networkId);

  const params: Record<string, unknown> = {
    transactions: entries.map((e) => e.txn),
    account: walletAccount(reviewedAccount.label, reviewedAccount.address),
    networkId,
    chainId,
    title: 'WalletConnect Request',
    callbackId,
  };
  if (walletConnect) {
    params.walletConnect = {
      transactions: entries,
      requestKey: 'topic-under-test:437',
      dapp: { name: 'Example dApp', url: 'https://example.org' },
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
  mockLocked = false;
  mockRegistry = {};
  mockBeforeRemove = [];
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
    const screen = await renderScreen({
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

    const screen = await renderScreen({
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

    const screen = await renderScreen({
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
    const screen = await renderScreen({
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

    const screen = await renderScreen({
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

    const screen = await renderScreen({
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

    const screen = await renderScreen({
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

    const screen = await renderScreen({
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

    const screen = await renderScreen({
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

    const screen = await renderScreen({
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

    const screen = await renderScreen({
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

    const screen = await renderScreen({
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

describe('UniversalTransactionSigningScreen — leaving the screen', () => {
  it('tells the caller it left the stack through its onDismiss (TASK-257)', async () => {
    const owner = makeAccount('dismiss').addr;
    mockAccounts = [walletAccount('Main', owner)];
    mockRoutes[owner] = { kind: 'software', signingAddress: owner };
    const onDismiss = jest.fn();
    mockRegistry['cb-dismiss'] = { onDismiss };

    const screen = await renderScreen({
      networkId: ALGO,
      entries: [{ txn: b64(pay(ALGO, owner, 1)) }],
      approved: [owner],
      reviewedAccount: { address: owner, label: 'Main' },
      callbackId: 'cb-dismiss',
    });
    await waitFor(() => {
      expect(screen.getByText('Algorand')).toBeTruthy();
    });
    expect(onDismiss).not.toHaveBeenCalled();

    // Leaving the stack (OS back, swipe-back) reports it once.
    mockBeforeRemove.forEach((listener) => listener());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

// TASK-437 negative control: no request data may be mounted before authentication.
it('shows only the locked request gate and rejects without authentication', async () => {
  mockLocked = true;
  const sender = makeAccount('locked-review').addr.toString();
  mockAccounts = [walletAccount('Private account label', sender)];
  const onReject = jest.fn(async () => {});
  mockRegistry.locked = { onReject } as any;
  const view = await renderScreen({
    networkId: VOI,
    entries: [{ txn: b64(pay(VOI, sender, 12500000, 'Private note')) }],
    approved: [sender],
    reviewedAccount: { address: sender, label: 'Private account label' },
    callbackId: 'locked',
  });
  expect(view.queryByText(/12.5 VOI/)).toBeNull();
  expect(view.queryByText('Private account label')).toBeNull();
  expect(view.queryByText('Private note')).toBeNull();
  expect(view.queryAllByText(truncateAddress(sender))).toHaveLength(0);
  expect(view.getByText('Unlock to review')).toBeTruthy();
  expect(view.getByText('Example dApp')).toBeTruthy();
  expect(view.getByText('example.org')).toBeTruthy();
  expect(view.queryByText(/Signing Accounts/)).toBeNull();
  expect(view.getByText(NETWORK_CONFIGURATIONS[VOI].name)).toBeTruthy();
  await fireEvent.press(view.getByText('Reject'));
  expect(onReject).toHaveBeenCalledTimes(1);
  expect(
    require('@/services/secure/AccountSecureStorage').AccountSecureStorage
      .verifyPin
  ).not.toHaveBeenCalled();
  expect(
    require('@/services/secure/AccountSecureStorage').AccountSecureStorage
      .getBiometricSecret
  ).not.toHaveBeenCalled();
  expect(
    require('expo-local-authentication').authenticateAsync
  ).not.toHaveBeenCalled();
});

it.each(['beforeRemove', 'unmount', 'cancel', 'background'])(
  'clears review keys and hides details on %s (TASK-437)',
  async (exit) => {
    const { reviewGrant } = require('@/services/auth/reviewGrant');
    const { AppLockSignal } = require('@/services/secure/appLockState');
    const { SessionKeyVault } = require('@/services/secure/SessionKeyVault');
    const {
      AccountSecureStorage,
    } = require('@/services/secure/AccountSecureStorage');
    AppLockSignal.setUnlocked(false);
    reviewGrant.revoke();
    AccountSecureStorage.verifyPin.mockResolvedValue(true);
    mockLocked = true;
    const sender = makeAccount('review-lifecycle').addr;
    mockAccounts = [walletAccount('Private review account', sender)];
    const appStateListeners: ((state: AppStateStatus) => void)[] = [];
    const spy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, listener) => {
        appStateListeners.push((state) => listener(state));
        return { remove: jest.fn() };
      });
    const view = await renderScreen({
      networkId: VOI,
      entries: [{ txn: b64(pay(VOI, sender, 12500000)) }],
      approved: [sender],
      reviewedAccount: { address: sender, label: 'Private review account' },
    });
    await act(async () => {
      expect(
        await reviewGrant.unlock('topic-under-test:437', { pin: '123456' })
      ).toBe(true);
    });
    await waitFor(() => expect(view.getByText('12.5 VOI')).toBeTruthy());
    expect(AccountSecureStorage.verifyPin).toHaveBeenCalledTimes(1);
    if (exit === 'beforeRemove')
      await act(() => mockBeforeRemove.forEach((fn) => fn()));
    if (exit === 'unmount') await view.unmount();
    if (exit === 'cancel') await act(() => mockModalProps.onCancel());
    if (exit === 'background')
      await act(() => appStateListeners.forEach((fn) => fn('background')));
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    expect(AppLockSignal.isUnlocked()).toBe(false);
    if (exit !== 'unmount') expect(view.queryByText('12.5 VOI')).toBeNull();
    spy.mockRestore();
  }
);

// TASK-437 (Luna P2): before review is unlocked nothing about the request is
// decoded, fetched or logged — no asset metadata lookup (it logs the asset
// id), no signer-route resolution, no account read.
it('looks nothing up before review is unlocked', async () => {
  jest.restoreAllMocks();
  // jest-expo's AppState.addEventListener returns no subscription; stub it
  // as the lifecycle tests above do.
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove: jest.fn() }) as any);
  require('@/services/auth/reviewGrant').reviewGrant.revoke();
  require('@/services/secure/appLockState').AppLockSignal.setUnlocked(false);
  mockGetCachedAssetParams.mockClear();
  mockResolveSigningRoute.mockClear();
  mockPreventCapture.mockClear();
  mockEnableAppSwitcherProtection.mockClear();
  mockLocked = true;
  const sender = makeAccount('locked-lookups').addr.toString();
  mockAccounts = [walletAccount('Locked lookups', sender)];
  const wallet = require('@/services/wallet').MultiAccountWalletService;
  const getAllAccounts = jest.spyOn(wallet, 'getAllAccounts');
  const view = await renderScreen({
    networkId: VOI,
    entries: [{ txn: b64(axfer(VOI, sender, USDC, 10000000n)) }],
    approved: [sender],
    reviewedAccount: { address: sender, label: 'Locked lookups' },
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(view.getByText('Unlock to review')).toBeTruthy();
  expect(mockGetCachedAssetParams).not.toHaveBeenCalled();
  expect(mockResolveSigningRoute).not.toHaveBeenCalled();
  expect(getAllAccounts).not.toHaveBeenCalled();
});

// TASK-437 (Luna P2): a WalletConnect review is kept out of screenshots and
// the app-switcher snapshot while mounted; in-app signing is unchanged.
it('guards a WalletConnect review against screen capture and the app switcher', async () => {
  jest.restoreAllMocks();
  // jest-expo's AppState.addEventListener returns no subscription; stub it
  // as the lifecycle tests above do.
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove: jest.fn() }) as any);
  require('@/services/auth/reviewGrant').reviewGrant.revoke();
  require('@/services/secure/appLockState').AppLockSignal.setUnlocked(false);
  mockGetCachedAssetParams.mockClear();
  mockResolveSigningRoute.mockClear();
  mockPreventCapture.mockClear();
  mockEnableAppSwitcherProtection.mockClear();
  mockLocked = true;
  const sender = makeAccount('capture-guard').addr.toString();
  mockAccounts = [walletAccount('Capture guard', sender)];
  await renderScreen({
    networkId: VOI,
    entries: [{ txn: b64(pay(VOI, sender, 1000000)) }],
    approved: [sender],
    reviewedAccount: { address: sender, label: 'Capture guard' },
  });

  expect(mockPreventCapture).toHaveBeenCalled();
  if (require('react-native').Platform.OS === 'ios') {
    expect(mockEnableAppSwitcherProtection).toHaveBeenCalledTimes(1);
  }
});

// TASK-440 audit #1 (negative control): the old per-kind aggregate kept only
// the FIRST rekey target, so a second, attacker-chosen rekey in the same batch
// was signed under a warning that named the first. Every dangerous operation
// is listed, with its transaction number and full destination.
it('lists every rekey in a batch, each with its transaction and full target', async () => {
  const sender = makeAccount('danger-batch').addr.toString();
  const first = makeAccount('danger-first').addr.toString();
  const attacker = makeAccount('danger-attacker').addr.toString();
  mockAccounts = [walletAccount('Danger batch', sender)];
  const rekeyTo = (to: string, amount: number) =>
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender,
      receiver: sender,
      amount,
      rekeyTo: to,
      suggestedParams: paramsFor(VOI),
    });
  const view = await renderScreen({
    networkId: VOI,
    entries: [
      { txn: b64(rekeyTo(first, 1)) },
      { txn: b64(rekeyTo(attacker, 2)) },
    ],
    approved: [sender],
    reviewedAccount: { address: sender, label: 'Danger batch' },
  });

  expect(
    view.getByText(new RegExp(`Transaction 1: REKEYS .*${first}`))
  ).toBeTruthy();
  expect(
    view.getByText(new RegExp(`Transaction 2: REKEYS .*${attacker}`))
  ).toBeTruthy();
});

// TASK-440 Luna r1 #3/#4: a reconfiguration restates every authority, so only
// the roles that differ from the asset's current holders (read on the bound
// network) are listed, each naming the full affected account. Negative
// control: at 50993c5 all four roles were listed and no lookup was made.
describe('asset reconfiguration review', () => {
  const ASSET = 777n;
  const holders = {
    manager: makeAccount('acfg-manager').addr.toString(),
    reserve: makeAccount('acfg-reserve').addr.toString(),
    freeze: makeAccount('acfg-freeze').addr.toString(),
    clawback: makeAccount('acfg-clawback').addr.toString(),
  };
  const attacker = makeAccount('acfg-attacker').addr.toString();

  const renderReconfig = () => {
    const sender = holders.manager;
    mockAccounts = [walletAccount('Asset manager', sender)];
    const txn = algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
      sender,
      assetIndex: ASSET,
      ...holders,
      clawback: attacker,
      strictEmptyAddressChecking: false,
      suggestedParams: paramsFor(VOI),
    });
    return renderScreen({
      networkId: VOI,
      entries: [{ txn: b64(txn) }],
      approved: [sender],
      reviewedAccount: { address: sender, label: 'Asset manager' },
    });
  };

  it('lists only the authority that changes, with the full affected account', async () => {
    mockGetAssetInfo.mockResolvedValue({ params: { ...holders } });
    const view = await renderReconfig();

    expect(
      await view.findByText(
        new RegExp(
          `Transaction 1: ${holders.manager} gives the clawback authority of asset #777 to ${attacker}\\.$`
        )
      )
    ).toBeTruthy();
    expect(view.queryByText(/manager authority/)).toBeNull();
    expect(view.queryByText(/reserve authority/)).toBeNull();
    expect(view.queryByText(/freeze authority/)).toBeNull();
    expect(mockGetAssetInfo).toHaveBeenCalledWith(VOI, 777);
  });

  // Codex pass on 3c5fee0 (HIGH): a pre-signed entry that moves clawback to
  // the attacker, followed by an entry that moves it back, compared each
  // entry to the on-chain snapshot, so the review showed no banner at all.
  // Two entries on one asset now keep every role of the signed one, unverified.
  it('counts a pre-signed reconfiguration earlier in the batch', async () => {
    mockGetAssetInfo.mockResolvedValue({ params: { ...holders } });
    const managerAccount = makeAccount('acfg-manager');
    const sender = holders.manager;
    mockAccounts = [walletAccount('Asset manager', sender)];
    const config = (clawback: string) =>
      algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
        sender,
        assetIndex: ASSET,
        ...holders,
        clawback,
        strictEmptyAddressChecking: false,
        suggestedParams: paramsFor(VOI),
      });
    const presigned = Buffer.from(
      config(attacker).signTxn(managerAccount.sk)
    ).toString('base64');
    const view = await renderScreen({
      networkId: VOI,
      entries: [
        { txn: presigned, signers: [] },
        { txn: b64(config(holders.clawback)) },
      ],
      approved: [sender],
      reviewedAccount: { address: sender, label: 'Asset manager' },
    });

    expect(
      await view.findByText(
        new RegExp(
          `Transaction 2: ${sender} gives the clawback authority of asset #777 to ${holders.clawback}\\. .*unverified`
        )
      )
    ).toBeTruthy();
    expect(view.queryByText(/Transaction 1:/)).toBeNull();
  });

  it('keeps every role, marked unverified, when the asset cannot be read', async () => {
    mockGetAssetInfo.mockRejectedValue(new Error('offline'));
    const view = await renderReconfig();

    await waitFor(() => expect(mockGetAssetInfo).toHaveBeenCalled());
    for (const role of ['manager', 'reserve', 'freeze', 'clawback']) {
      expect(
        await view.findByText(
          new RegExp(`gives the ${role} authority of asset #777 .*unverified`)
        )
      ).toBeTruthy();
    }
  });
});
