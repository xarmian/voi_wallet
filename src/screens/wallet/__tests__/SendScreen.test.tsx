/**
 * TASK-239 — money-math regression tests for SendScreen's native
 * spendable/Max calculation.
 *
 * The bug: `accountBalance` state was declared but never populated, so
 * `getSpendableBase()` read `minBalance ?? 0` and the Algorand minimum-balance
 * reserve was silently dropped. The Max button (and the as-you-type validator)
 * therefore proposed an amount the on-chain send would reject.
 *
 * The fix populates the balance from `NetworkService.getAccountBalance`, keyed
 * to the EFFECTIVE transaction network (`selectedAsset?.networkId ??
 * selectedNetworkId`), stored WITH its (address, networkId) identity, and
 * validated during render — an unloaded/mismatched record makes native
 * spendable 0n rather than reintroducing `minBalance = 0`.
 *
 * These tests assert the four behaviours the task calls out:
 *   1. native Max/spendable = balance - fee - minBalance, and an amount equal to
 *      `balance - fee` is now rejected;
 *   2. dual-network: Max uses the SELECTED network's minBalance, never the
 *      cross-network aggregate;
 *   3. asset-switch across networks recomputes against the new network's MBR
 *      (and takes the balance term from the validated record, not the older
 *      assetOptions snapshot);
 *   4. no stale MBR during load: immediately after an identity change, before
 *      the fetch resolves, native spendable is 0n and Max is unavailable.
 *
 * The balance figures come entirely from a mocked NetworkService — nothing real.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import type { AccountBalance } from '@/types/wallet';

const VOI = 'voi-mainnet';
const ALGO = 'algorand-mainnet';

// ---------------------------------------------------------------------------
// Mutable per-test state (all `mock`-prefixed so jest.mock factories may close
// over them; factory functions read them lazily at call time).
// ---------------------------------------------------------------------------
let mockActiveAccount: { id: string; address: string; type?: string } | null;
let mockCurrentNetwork: string;
let mockMultiNetworkBalance: unknown;
let mockRouteParams: Record<string, unknown> | undefined;
let mockBalances: Record<string, AccountBalance>;
let mockTokenMappings: unknown[];

const mockGetAccountBalance = jest.fn();
const mockEstimateTransactionCost = jest.fn();
// Shared spy so a test can assert which NETWORK the ARC-0090 prefill resolved
// the asset's decimals against (getInstance(networkId).getAssetInfo(assetId)).
const mockGetAssetInfo = jest.fn();

const mockNetworkConfigs: Record<
  string,
  { nativeToken: string; features: { envoi: boolean } }
> = {
  [VOI]: { nativeToken: 'VOI', features: { envoi: true } },
  [ALGO]: { nativeToken: 'ALGO', features: { envoi: false } },
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (networkId: string) => ({
      getAccountBalance: (address: string) =>
        mockGetAccountBalance(networkId, address),
      getAssetInfo: (assetId: number) => mockGetAssetInfo(networkId, assetId),
      getSingleAssetBalance: jest.fn(async () => null),
      getAlgodClient: () => ({
        accountInformation: () => ({
          do: async () => ({ amount: 0, assets: [] }),
        }),
        getAssetByID: () => ({ do: async () => ({ params: {} }) }),
      }),
    }),
  },
}));

jest.mock('@/services/network/config', () => ({
  getNetworkConfig: (networkId: string) =>
    mockNetworkConfigs[networkId] ?? mockNetworkConfigs[VOI],
}));

jest.mock('@/services/transactions', () => ({
  TransactionService: {
    estimateTransactionCost: (...args: unknown[]) =>
      mockEstimateTransactionCost(...args),
    validateTransaction: jest.fn(async () => []),
  },
}));

jest.mock('@/services/token-mapping', () => ({
  __esModule: true,
  default: {
    getCachedMappings: () => mockTokenMappings,
    getTokenMappings: async () => mockTokenMappings,
  },
}));

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    getSigningInfo: jest.fn(async () => null),
    getLedgerSigningInfo: jest.fn(async () => null),
  },
}));

jest.mock('@/services/envoi', () => ({
  __esModule: true,
  default: { getInstance: () => ({ searchNames: jest.fn(async () => []) }) },
}));

jest.mock('@/utils/address', () => ({
  resolveAddressOrName: jest.fn(async () => ''),
  isLikelyEnvoiName: () => false,
  formatAddress: (a: string) => a,
}));

jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockActiveAccount,
  useMultiNetworkBalance: () => ({ balance: mockMultiNetworkBalance }),
}));

jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () => mockCurrentNetwork,
  useCurrentNetworkConfig: () => mockNetworkConfigs[mockCurrentNetwork],
}));

jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: mockRouteParams }),
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
    setParams: jest.fn(),
    dispatch: jest.fn(),
  }),
  CommonActions: { navigate: jest.fn() },
  useFocusEffect: () => {},
}));

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock('expo-image', () => ({ Image: () => null }));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

// Passthrough layout wrappers.
const passthrough = (name: string) => {
  const mod: Record<string, unknown> = {};
  mod[name] = ({ children }: { children: React.ReactNode }) => children;
  return mod;
};
jest.mock('@/components/common/NFTBackground', () =>
  passthrough('NFTBackground')
);
jest.mock('@/components/common/KeyboardAwareScrollView', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/BlurredContainer', () =>
  passthrough('BlurredContainer')
);
jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/common/GlassButton', () => ({
  GlassButton: () => null,
}));
jest.mock('@/components/account/AccountListModal', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/account/AddAccountModal', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/account/AccountRecipientModal', () => ({
  __esModule: true,
  default: () => null,
}));

// The real selector renders `options`; the mock exposes one press target per
// option so a test can switch the selected asset/network exactly as the UI
// does (onSelect(networkId, assetId), which sets selectedAsset WITHOUT touching
// selectedNetworkId).
jest.mock('@/components/send/NetworkAssetSelector', () => {
  const { View, Text, Pressable } = require('react-native');
  return {
    __esModule: true,
    default: ({
      options,
      onSelect,
      disabled,
    }: {
      options: { networkId: string; assetId: number }[];
      onSelect: (networkId: string, assetId: number) => void;
      disabled?: boolean;
    }) => (
      <View>
        {options.map((o) => (
          <Pressable
            key={`${o.networkId}-${o.assetId}`}
            testID={`asset-option-${o.networkId}-${o.assetId}`}
            onPress={() => !disabled && onSelect(o.networkId, o.assetId)}
          >
            <Text>{`${o.networkId}:${o.assetId}`}</Text>
          </Pressable>
        ))}
      </View>
    ),
  };
});

import SendScreen from '../SendScreen';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const bal = (
  networkId: string,
  amount: bigint,
  minBalance: bigint
): AccountBalance => ({
  address: mockActiveAccount?.address ?? 'ADDR',
  amount,
  minBalance,
  assets: [],
});

/** A multi-network balance carrying a native mapping present on both networks,
 * so SendScreen builds two asset options (VOI + ALGO native) and renders the
 * selector. `sourceAmounts` deliberately differs from the NetworkService
 * figures to prove the spendable BALANCE term comes from the validated record,
 * not this (older) snapshot. */
const dualNativeMultiBalance = (sourceAmounts: {
  voi: bigint;
  algo: bigint;
}) => ({
  minBalance: 0n,
  assets: [
    {
      isMapped: true,
      mappingId: 'm0',
      sourceBalances: [
        {
          networkId: VOI,
          balance: {
            assetId: 0,
            amount: sourceAmounts.voi,
            decimals: 6,
            symbol: 'VOI',
            name: 'Voi',
          },
        },
        {
          networkId: ALGO,
          balance: {
            assetId: 0,
            amount: sourceAmounts.algo,
            decimals: 6,
            symbol: 'ALGO',
            name: 'Algo',
          },
        },
      ],
    },
  ],
});

const dualNativeMappings = [
  {
    mappingId: 'm0',
    tokens: [
      { networkId: VOI, assetId: 0 },
      { networkId: ALGO, assetId: 0 },
    ],
  },
];

const MAX_LABEL = 'Send maximum spendable amount';
const AMOUNT_PLACEHOLDER = '0.000000';

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockActiveAccount = { id: 'a1', address: 'ADDR_VOI' };
  mockCurrentNetwork = VOI;
  mockMultiNetworkBalance = { minBalance: 0n, assets: [] };
  mockRouteParams = undefined;
  mockBalances = {};
  mockTokenMappings = [];

  mockGetAccountBalance.mockReset();
  mockGetAccountBalance.mockImplementation((networkId: string) =>
    Promise.resolve(
      mockBalances[networkId] ?? {
        address: 'ADDR',
        amount: 0n,
        minBalance: 0n,
        assets: [],
      }
    )
  );

  mockEstimateTransactionCost.mockReset();
  mockEstimateTransactionCost.mockResolvedValue({ fee: 1000 });

  mockGetAssetInfo.mockReset();
  mockGetAssetInfo.mockResolvedValue(null);
});

// Flush pending promises/effects (balance fetch, asset options, mappings).
const settle = () => act(async () => {});

describe('SendScreen native minimum-balance math (TASK-239)', () => {
  it('subtracts the selected network minBalance from native Max', async () => {
    // 5 VOI balance, 0.9 VOI reserve, 0.001 VOI fee (from the route param).
    mockBalances[VOI] = bal(VOI, 5_000_000n, 900_000n);
    mockRouteParams = { fee: '1000' };

    const screen = render(<SendScreen />);
    await settle();

    const maxButton = await screen.findByLabelText(MAX_LABEL);
    fireEvent.press(maxButton);

    // balance - fee - minBalance = 5_000_000 - 1000 - 900_000 = 4_099_000.
    // Before the fix (minBalance dropped) this would have filled "4.999".
    const amountInput = screen.getByPlaceholderText(AMOUNT_PLACEHOLDER);
    expect(amountInput.props.value).toBe('4.099');
    expect(amountInput.props.value).not.toBe('4.999');
    await settle();
  });

  it('rejects a native amount equal to balance - fee (reserve ignored)', async () => {
    mockBalances[VOI] = bal(VOI, 5_000_000n, 900_000n);
    mockRouteParams = { fee: '1000' };

    const screen = render(<SendScreen />);
    await settle();
    await screen.findByLabelText(MAX_LABEL);

    const amountInput = screen.getByPlaceholderText(AMOUNT_PLACEHOLDER);

    // "4.999" == balance - fee. Spendable is 4.099, so this must error now.
    // (Pre-fix, spendable == balance - fee, so this was wrongly accepted.)
    fireEvent.changeText(amountInput, '4.999');
    expect(screen.queryByText(/exceeds spendable balance/i)).toBeTruthy();

    // The actual spendable amount is accepted.
    fireEvent.changeText(amountInput, '4.099');
    expect(screen.queryByText(/exceeds spendable balance/i)).toBeNull();
    await settle();
  });

  it('uses only the SELECTED network MBR, never the cross-network aggregate', async () => {
    // Both networks hold a reserve. A regression that subtracted the aggregate
    // (multiNetworkBalance.minBalance, a documented cross-network SUM) would
    // compute a smaller Max.
    mockBalances[VOI] = bal(VOI, 5_000_000n, 900_000n);
    mockBalances[ALGO] = bal(ALGO, 3_000_000n, 500_000n);
    // Aggregate reserve = 0.9 + 0.5 = 1.4 VOI. Present but MUST be ignored.
    mockMultiNetworkBalance = { minBalance: 1_400_000n, assets: [] };

    const screen = render(<SendScreen />);
    await settle();

    const maxButton = await screen.findByLabelText(MAX_LABEL);
    fireEvent.press(maxButton);

    const amountInput = screen.getByPlaceholderText(AMOUNT_PLACEHOLDER);
    // Correct (VOI-only): 5_000_000 - 0 - 900_000 = 4_100_000 -> "4.1".
    // Aggregate bug would give 5_000_000 - 1_400_000 = 3_600_000 -> "3.6".
    expect(amountInput.props.value).toBe('4.1');
    expect(amountInput.props.value).not.toBe('3.6');

    // The spend network's balance is fetched; the other network's is not summed.
    const fetchedNetworks = mockGetAccountBalance.mock.calls.map((c) => c[0]);
    expect(fetchedNetworks).toContain(VOI);
    expect(fetchedNetworks).not.toContain(ALGO);
    await settle();
  });

  it('recomputes Max against network B when an asset on B is selected while selectedNetworkId is A', async () => {
    // selectedNetworkId stays VOI; selecting the ALGO asset only sets
    // selectedAsset, so the effective network becomes ALGO.
    mockBalances[VOI] = bal(VOI, 5_000_000n, 900_000n);
    mockBalances[ALGO] = bal(ALGO, 3_000_000n, 500_000n);
    mockMultiNetworkBalance = dualNativeMultiBalance({
      voi: 5_000_000n,
      algo: 3_000_000n,
    });
    mockTokenMappings = dualNativeMappings;

    const screen = render(<SendScreen />);
    await settle();
    // Auto-selected VOI native — wait until its balance has loaded.
    await screen.findByLabelText(MAX_LABEL);

    // Switch to the ALGO asset (network B) — selectedNetworkId is still VOI.
    await act(async () => {
      fireEvent.press(screen.getByTestId(`asset-option-${ALGO}-0`));
    });
    await settle();

    // Effective network is now ALGO: 3_000_000 - 500_000 = 2_500_000 -> "2.5",
    // using ALGO's reserve (0.5), NOT VOI's (0.9). A test keyed to
    // selectedNetworkId (still VOI) would instead compute VOI's reserve.
    const maxButton = await screen.findByLabelText(MAX_LABEL);
    fireEvent.press(maxButton);
    const amountInput = screen.getByPlaceholderText(AMOUNT_PLACEHOLDER);
    expect(amountInput.props.value).toBe('2.5');
    await settle();
  });

  it('takes the native balance term from the validated record, not the assetOptions snapshot', async () => {
    // The multi-network snapshot carries a STALE VOI amount (9.0); the fresh
    // NetworkService record says 5.0. Round-4 of the design requires BOTH the
    // balance and the reserve to come from the validated record.
    mockBalances[VOI] = bal(VOI, 5_000_000n, 900_000n);
    mockMultiNetworkBalance = dualNativeMultiBalance({
      voi: 9_000_000n,
      algo: 3_000_000n,
    });
    mockTokenMappings = dualNativeMappings;

    const screen = render(<SendScreen />);
    await settle();

    const maxButton = await screen.findByLabelText(MAX_LABEL);
    fireEvent.press(maxButton);

    const amountInput = screen.getByPlaceholderText(AMOUNT_PLACEHOLDER);
    // Record-based: 5_000_000 - 900_000 = 4_100_000 -> "4.1".
    // Snapshot-based (the bug round-4 closes): 9_000_000 - 900_000 -> "8.1".
    expect(amountInput.props.value).toBe('4.1');
    expect(amountInput.props.value).not.toBe('8.1');
    await settle();
  });

  it('treats native spendable as 0n (Max unavailable) while the new network balance is loading', async () => {
    mockMultiNetworkBalance = dualNativeMultiBalance({
      voi: 5_000_000n,
      algo: 3_000_000n,
    });
    mockTokenMappings = dualNativeMappings;

    // Control resolution per network so we can inspect the render BETWEEN an
    // identity change and the fetch resolving.
    const voiD = makeDeferred<AccountBalance>();
    const algoD = makeDeferred<AccountBalance>();
    mockGetAccountBalance.mockImplementation((networkId: string) =>
      networkId === VOI ? voiD.promise : algoD.promise
    );

    const screen = render(<SendScreen />);
    await settle();

    // Resolve VOI: Max becomes available for the VOI reserve.
    await act(async () => {
      voiD.resolve(bal(VOI, 5_000_000n, 900_000n));
    });
    expect(screen.getByLabelText(MAX_LABEL)).toBeTruthy();

    // Switch to ALGO but leave its fetch pending.
    await act(async () => {
      fireEvent.press(screen.getByTestId(`asset-option-${ALGO}-0`));
    });

    // The identity now mismatches the (VOI) record: native spendable is 0n, so
    // Max is gone — NOT a figure derived from VOI's reserve.
    expect(screen.queryByLabelText(MAX_LABEL)).toBeNull();

    // And the validator rejects any positive amount while spendable is 0n.
    const amountInput = screen.getByPlaceholderText(AMOUNT_PLACEHOLDER);
    fireEvent.changeText(amountInput, '0.1');
    expect(screen.queryByText(/exceeds spendable balance/i)).toBeTruthy();

    // Once ALGO resolves, Max returns and the amount is within spendable again.
    await act(async () => {
      algoD.resolve(bal(ALGO, 3_000_000n, 500_000n));
    });
    expect(screen.getByLabelText(MAX_LABEL)).toBeTruthy();
    expect(screen.queryByText(/exceeds spendable balance/i)).toBeNull();
    await settle();
  });
});

describe('SendScreen ARC-0090 prefill network resolution (TASK-245 item 1)', () => {
  it('resolves the prefill decimals against the deep-link networkId, not the previously-mounted network', async () => {
    // Asset 12345 carries DIFFERENT decimals per network: 6 on VOI, 2 on ALGO.
    // The prefill converts the URI's RAW base-unit amount to a display amount
    // using those decimals, so the network it looks them up on decides the
    // magnitude the user sees.
    mockGetAssetInfo.mockImplementation((networkId: string) =>
      Promise.resolve({ params: { decimals: networkId === VOI ? 6 : 2 } })
    );

    // The screen is ALREADY MOUNTED sitting on ALGORAND (no route network yet).
    mockCurrentNetwork = ALGO;
    mockRouteParams = undefined;
    const screen = render(<SendScreen />);
    await settle();

    // A deep link now arrives on the already-mounted screen, naming VOI + asset
    // 12345 + a raw base-unit amount of 1_000_000. On an already-mounted screen
    // the sibling network-setter has not committed VOI yet when the prefill
    // runs — the bug resolved decimals against the STALE ALGORAND network.
    mockRouteParams = { networkId: VOI, asset: '12345', amount: '1000000' };
    await act(async () => {
      screen.rerender(<SendScreen />);
    });
    await settle();

    // The decimals lookup MUST have gone to VOI (the link's network), never to
    // the stale ALGORAND network the screen was previously on.
    const assetInfoNetworks = mockGetAssetInfo.mock.calls.map((c) => c[0]);
    expect(assetInfoNetworks).toContain(VOI);
    expect(assetInfoNetworks).not.toContain(ALGO);
    // And it looked up the asset the link named.
    expect(mockGetAssetInfo).toHaveBeenCalledWith(VOI, 12345);

    // Magnitude proof: 1_000_000 raw / 10^6 (VOI decimals) = "1". The stale
    // network (ALGO, 2 decimals) would have prefilled "10000" — a 100x error.
    expect(screen.getByDisplayValue('1')).toBeTruthy();
    expect(screen.queryByDisplayValue('10000')).toBeNull();
    await settle();
  });

  it('resolves against the route network even when the global current network differs', async () => {
    // Cold-start equivalent: mounted directly with the deep link. Global network
    // is ALGO, but the link names VOI — the prefill must still use VOI.
    mockGetAssetInfo.mockImplementation((networkId: string) =>
      Promise.resolve({ params: { decimals: networkId === VOI ? 6 : 2 } })
    );
    mockCurrentNetwork = ALGO;
    mockRouteParams = { networkId: VOI, asset: '12345', amount: '1000000' };

    const screen = render(<SendScreen />);
    await settle();

    expect(mockGetAssetInfo).toHaveBeenCalledWith(VOI, 12345);
    const assetInfoNetworks = mockGetAssetInfo.mock.calls.map((c) => c[0]);
    expect(assetInfoNetworks).not.toContain(ALGO);
    expect(screen.getByDisplayValue('1')).toBeTruthy();
    await settle();
  });
});
