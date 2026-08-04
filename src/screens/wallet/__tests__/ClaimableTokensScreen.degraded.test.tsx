/**
 * TASK-188 screen-level regressions for ClaimableTokensScreen.
 *
 * The store-timing tests cover when a fetch runs; they cover nothing about
 * presentation, and a degraded state is worthless if it never reaches the
 * screen. Two properties are asserted here:
 *
 *  1. a partial result (some owner balances unresolved) renders a degraded
 *     banner with a working retry, and a fully successful one does not; and
 *  2. items held for a non-active account are never rendered across a switch —
 *     showing account A's claimables under account B's name is worse than
 *     showing none.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

import ClaimableTokensScreen from '../ClaimableTokensScreen';
import { lightTheme } from '@/constants/themes';
import type { ClaimableItem } from '@/types/claimable';

const ACCOUNT_A = 'ACCOUNT_A_ADDRESS';
const ACCOUNT_B = 'ACCOUNT_B_ADDRESS';

const mockFetchApprovals = jest.fn(async () => {});

// Mutable store view driven per test.
let mockItems: ClaimableItem[] = [];
let mockItemsAccountAddress: string | null = null;
let mockHasPartialFailure = false;
let mockActiveAddress: string | null = ACCOUNT_A;
let mockRouteParams: Record<string, unknown> = {};

const makeItem = (id: string): ClaimableItem => ({
  id,
  contractId: 1,
  tokenName: `Token ${id}`,
  tokenSymbol: 'TKN',
  tokenDecimals: 0,
  tokenVerified: false,
  owner: 'OWNER',
  amount: 10n,
  ownerBalance: 100n,
  isClaimable: true,
  approval: {
    owner: 'OWNER',
    round: 1,
    amount: '10',
    spender: 'SPENDER',
    timestamp: 1,
    contractId: 1,
    transactionId: 'TX',
  },
});

jest.mock('@/store/claimableStore', () => ({
  useClaimableStore: Object.assign(
    () => ({
      fetchApprovals: mockFetchApprovals,
      hideApproval: jest.fn(),
      unhideApproval: jest.fn(),
      toggleShowHidden: jest.fn(),
      hiddenApprovals: new Set<string>(),
    }),
    { getState: () => ({ claimableItems: [] }) }
  ),
  // Mirrors the real hook's account binding: items belong to exactly one
  // account, and a mismatch renders as an empty list.
  useClaimableItemsForAccount: (address: string | null | undefined) =>
    address && mockItemsAccountAddress === address ? mockItems : [],
  useClaimablePartialFailure: (address: string | null | undefined) =>
    mockHasPartialFailure && !!address && mockItemsAccountAddress === address,
  useShowHiddenApprovals: () => false,
  useClaimableLoading: () => false,
}));

jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () =>
    mockActiveAddress ? { id: 'acct', address: mockActiveAddress } : null,
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
    goBack: jest.fn(),
    setParams: jest.fn(),
  }),
  useRoute: () => ({ params: mockRouteParams }),
  useFocusEffect: (callback: () => void) => {
    const React = require('react');
    React.useEffect(() => {
      callback();
    }, [callback]);
  },
}));

// Hand-rolled rather than `react-native-reanimated/mock`: that mock returns a
// NEW shared-value object on every render, which makes the screen's
// unmount-cleanup effect (dep: `pulseOpacity`) re-run on every render and clear
// the pending-refresh timer under test. Real `useSharedValue` is stable.
jest.mock('react-native-reanimated', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View },
    View,
    useSharedValue: (initial: unknown) =>
      ReactLib.useRef({ value: initial }).current,
    useAnimatedStyle: () => ({}),
    withRepeat: jest.fn(),
    withTiming: jest.fn(),
    cancelAnimation: jest.fn(),
  };
});

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    Swipeable: ({ children }: { children: React.ReactNode }) => (
      <View>{children}</View>
    ),
  };
});

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: () => null,
  }),
  { virtual: true }
);

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));

jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@/components/common/UniversalHeader', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ rightAction }: { rightAction?: React.ReactNode }) => (
      <View>{rightAction}</View>
    ),
  };
});

jest.mock('@/components/common/GlassButton', () => {
  const { Text } = require('react-native');
  return {
    GlassButton: ({ label }: { label: string }) => <Text>{label}</Text>,
  };
});

jest.mock('@/components/common/GlassCard', () => {
  const { View } = require('react-native');
  return {
    GlassCard: ({ children }: { children: React.ReactNode }) => (
      <View>{children}</View>
    ),
  };
});

jest.mock('@/components/claimable/ClaimableTokenItem', () => {
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ item }: { item: { id: string } }) => (
      <Text>{`row-${item.id}`}</Text>
    ),
  };
});

jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}));

beforeEach(() => {
  mockFetchApprovals.mockClear();
  mockItems = [makeItem('1_OWNER')];
  mockItemsAccountAddress = ACCOUNT_A;
  mockHasPartialFailure = false;
  mockActiveAddress = ACCOUNT_A;
  mockRouteParams = {};
  // Keep the theme import referenced so the mock factory's require resolves
  // the same module instance the screen renders against.
  expect(lightTheme).toBeDefined();
});

const settle = () => act(async () => {});

describe('ClaimableTokensScreen degraded state (TASK-188)', () => {
  it('renders the degraded banner with a retry when the last fetch was partial', async () => {
    mockHasPartialFailure = true;

    const { getByTestId } = render(<ClaimableTokensScreen />);
    await settle();

    expect(getByTestId('claimable-degraded-banner')).toBeTruthy();
    expect(getByTestId('claimable-degraded-retry')).toBeTruthy();
  });

  it('retry issues a FORCED refetch — a TTL-suppressed retry button is a dead button', async () => {
    mockHasPartialFailure = true;

    const { getByTestId } = render(<ClaimableTokensScreen />);
    await settle();

    mockFetchApprovals.mockClear();
    await act(async () => {
      fireEvent.press(getByTestId('claimable-degraded-retry'));
    });

    expect(mockFetchApprovals).toHaveBeenCalledWith(ACCOUNT_A, { force: true });
  });

  it('does not render the degraded banner after a fully successful fetch', async () => {
    mockHasPartialFailure = false;

    const { queryByTestId } = render(<ClaimableTokensScreen />);
    await settle();

    expect(queryByTestId('claimable-degraded-banner')).toBeNull();
  });

  it("does not show account A's degraded banner over account B's list", async () => {
    // The flag is cleared when a switch commits, but the render between the
    // active account changing and that commit must not attribute A's failure
    // to B.
    mockHasPartialFailure = true;
    mockItemsAccountAddress = ACCOUNT_A;
    mockActiveAddress = ACCOUNT_B;

    const { queryByTestId } = render(<ClaimableTokensScreen />);
    await settle();

    expect(queryByTestId('claimable-degraded-banner')).toBeNull();
  });
});

describe('ClaimableTokensScreen account binding (TASK-188)', () => {
  it("renders the active account's items", async () => {
    const { queryByText } = render(<ClaimableTokensScreen />);
    await settle();

    expect(queryByText('row-1_OWNER')).toBeTruthy();
  });

  it('renders nothing from a previous account across a switch', async () => {
    // Items still held for A while the active account is already B — the
    // window between the switch and the new fetch committing.
    mockItemsAccountAddress = ACCOUNT_A;
    mockActiveAddress = ACCOUNT_B;

    const { queryByText } = render(<ClaimableTokensScreen />);
    await settle();

    expect(queryByText('row-1_OWNER')).toBeNull();
    expect(queryByText('No Claimable Tokens')).toBeTruthy();
  });

  it('pull-to-refresh forces a fetch', async () => {
    const { UNSAFE_getByType } = render(<ClaimableTokensScreen />);
    await settle();

    const { RefreshControl } = require('react-native');
    mockFetchApprovals.mockClear();
    await act(async () => {
      UNSAFE_getByType(RefreshControl).props.onRefresh();
    });

    expect(mockFetchApprovals).toHaveBeenCalledWith(ACCOUNT_A, { force: true });
  });

  it('the focus fetch is NOT forced, so the TTL can suppress it', async () => {
    render(<ClaimableTokensScreen />);
    await settle();

    expect(mockFetchApprovals).toHaveBeenCalledWith(ACCOUNT_A);
  });
});

describe('ClaimableTokensScreen post-claim refresh (TASK-188)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const advance = async (ms: number) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }
    });
  };

  it('forces a refresh for the claiming account after the delay', async () => {
    mockRouteParams = { pendingRefresh: true, claimedItemIds: [] };

    render(<ClaimableTokensScreen />);
    mockFetchApprovals.mockClear();
    await advance(8000);

    expect(mockFetchApprovals).toHaveBeenCalledWith(ACCOUNT_A, { force: true });
  });

  it('abandons the delayed refresh when the account changed while it was pending', async () => {
    mockRouteParams = { pendingRefresh: true, claimedItemIds: [] };

    const { rerender } = render(<ClaimableTokensScreen />);
    mockFetchApprovals.mockClear();

    // User switches accounts inside the 8s window. A forced fetch takes
    // ownership of the store, so refreshing the account the claim was made
    // from would wipe the now-active account's list.
    mockActiveAddress = ACCOUNT_B;
    mockRouteParams = {};
    rerender(<ClaimableTokensScreen />);

    await advance(8000);

    expect(mockFetchApprovals).not.toHaveBeenCalledWith(ACCOUNT_A, {
      force: true,
    });
  });
});
