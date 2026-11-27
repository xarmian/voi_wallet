import React from 'react';
import {
  Alert,
  AppState,
  type AppStateStatus,
  Text as MockText,
  TouchableOpacity as MockTouchableOpacity,
  View as MockView,
} from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { getNavigationCallbacks } from '@/services/navigation/callbackRegistry';
import { AppLockSignal } from '@/services/secure/appLockState';
import { lapseEpoch } from '@/services/auth/flowLapse';
import { PENDING_TRANSACTION_ALERT } from '@/utils/errorMapping';
import SwapScreen from '../SwapScreen';

const mockSubmit = jest.fn();
const mockNavigate = jest.fn();
const mockDispatch = jest.fn();
const mockAccount = { id: 'a', address: 'ADDR' };

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-image', () => ({ Image: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: { accountId: 'a', assetId: 5 } }),
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: jest.fn(),
    dispatch: mockDispatch,
    setParams: jest.fn(),
  }),
  CommonActions: { reset: (state: unknown) => ({ type: 'RESET', state }) },
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => new Proxy({}, { get: () => ({}) }),
  useThemeColors: () => ({}),
}));
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockAccount,
  useWalletStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ wallet: { accounts: [mockAccount] } }),
    {
      getState: () => ({
        wallet: { accounts: [mockAccount] },
        loadAccountBalance: jest.fn(),
        refreshAllBalances: jest.fn(),
      }),
    }
  ),
}));
jest.mock('@/store/experimentalStore', () => ({
  useIsSwapEnabled: () => true,
}));
jest.mock('@/hooks/useSwapNetworkBalance', () => ({
  useSwapNetworkBalance: () => ({
    balance: null,
    error: null,
    retry: jest.fn(),
    refresh: jest.fn(),
  }),
}));
jest.mock('@/utils/tokenImages', () => ({
  getTokenImageSource: () => null,
}));
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({ submitTransaction: mockSubmit }),
  },
}));
jest.mock('@/services/token-mapping', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('@/services/swap', () => ({
  SwapService: {
    getProvider: () => ({
      getTokenById: async (id: number) => ({
        id,
        symbol: id === 0 ? 'VOI' : 'TKN',
        name: id === 0 ? 'Voi' : 'Token',
        decimals: 6,
      }),
      getQuote: async () => ({
        unsignedTransactions: ['AQ=='],
        outputAmount: '1000000',
      }),
    }),
    getProviderInfo: () => ({ name: 'Provider', url: 'https://x.invalid' }),
  },
}));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock(
  '@/components/common/KeyboardAwareScrollView',
  () =>
    ({ children }: { children: React.ReactNode }) =>
      children
);
jest.mock('@/components/swap/TokenSelector', () => ({
  TokenSelector: () => null,
}));
jest.mock('@/components/swap/SwapQuoteDisplay', () => ({
  SwapQuoteDisplay: () => null,
}));
jest.mock('@/components/swap/RouteDetailModal', () => ({
  RouteDetailModal: () => null,
}));
jest.mock('@/components/swap/SlippageSettingsModal', () => ({
  SlippageSettingsModal: () => null,
  getStoredSlippage: async () => 1,
}));
jest.mock('@/components/account/AccountListModal', () => () => null);
jest.mock('@/components/common/WaitingForConfirmationModal', () => () => null);
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: MockView,
}));
jest.mock('@/components/common/GlassCard', () => ({ GlassCard: MockView }));
jest.mock('@/components/common/GlassButton', () => ({
  GlassButton: (p: { onPress: () => void; label: string }) => (
    <MockTouchableOpacity onPress={p.onPress}>
      <MockText>{p.label}</MockText>
    </MockTouchableOpacity>
  ),
}));
jest.mock('@/components/network/NetworkSelector', () => () => null);
jest.mock('@/components/common/ErrorStateView', () => ({
  ErrorStateView: () => null,
}));

const WITHHELD =
  'Your wallet locked or the app went to the background before this was sent. Nothing was sent. Please try again.';
const toast = Toast.show as jest.Mock;

let appListeners: Set<(state: AppStateStatus) => void>;
const lapse = (reason: 'lock' | 'background') => {
  if (reason === 'lock') AppLockSignal.setUnlocked(false);
  else [...appListeners].forEach((cb) => cb('background'));
};
let alert: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers();
  appListeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, cb) => {
    appListeners.add(cb);
    return { remove: () => appListeners.delete(cb) } as never;
  });
  AppLockSignal.setUnlocked(true);
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockSubmit.mockReset().mockResolvedValue({ txId: 'TXID', confirmed: true });
  mockNavigate.mockClear();
  mockDispatch.mockClear();
  toast.mockClear();
});
afterEach(() => {
  AppLockSignal.setUnlocked(false);
  jest.clearAllTimers();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** Quote a swap, review it, and return the success callback the signing screen gets. */
async function reviewed() {
  const view = await render(<SwapScreen />);
  await act(async () => {});
  await act(async () => {
    fireEvent.changeText(view.getByPlaceholderText('0.0'), '1');
  });
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
  await act(async () => {});
  await act(async () => {
    fireEvent.press(view.getByText('Review Swap'));
  });
  const params = mockNavigate.mock.calls.at(-1)![1];
  expect(mockNavigate.mock.calls.at(-1)![0]).toBe(
    'UniversalTransactionSigning'
  );
  const onSuccess = getNavigationCallbacks(params.callbackId)!.onSuccess!;
  return { view, onSuccess };
}
const signedWith = (epoch?: number) => ({
  signedTransactions: ['AQ=='],
  ...(epoch === undefined ? {} : { lapseEpoch: epoch }),
});

// Signed, then locked or backgrounded before the send: nothing is sent.
it.each(['lock', 'background'] as const)(
  'swap:staleLapseEpochWithholdsSubmit:%s',
  async (reason) => {
    const { view, onSuccess } = await reviewed();
    const epoch = lapseEpoch();
    lapse(reason);
    AppLockSignal.setUnlocked(true);
    await act(async () => {
      await onSuccess(signedWith(epoch));
    });
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith('Request ended', WITHHELD);
    expect(toast).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    await view.unmount();
  }
);

// Once the send is issued it runs to its end and shows its real outcome,
// including a result that arrives after the lock.
it.each(
  (['lock', 'background'] as const).flatMap((reason) =>
    [true, false].map((confirmedOnChain) => ({ reason, confirmedOnChain }))
  )
)(
  'swap:lockAfterSubmitIssuedShowsRealOutcome:$reason:confirmed=$confirmedOnChain',
  async ({ reason, confirmedOnChain }) => {
    const { view, onSuccess } = await reviewed();
    let answer!: (value: { txId: string; confirmed: boolean }) => void;
    mockSubmit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    let delivered!: Promise<void>;
    await act(async () => {
      delivered = Promise.resolve(onSuccess(signedWith(lapseEpoch())));
    });
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    lapse(reason);
    await act(async () => {
      answer({ txId: 'TXID', confirmed: confirmedOnChain });
      await delivered;
    });
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0].text1).toBe(
      confirmedOnChain
        ? 'Swap submitted successfully'
        : PENDING_TRANSACTION_ALERT.title
    );
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    await view.unmount();
  }
);

// A result with no epoch (an unwatched flow) is never withheld here.
it('swap:resultWithoutEpochIsNotWithheld', async () => {
  const { view, onSuccess } = await reviewed();
  lapse('lock');
  AppLockSignal.setUnlocked(true);
  await act(async () => {
    await onSuccess(signedWith());
  });
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  expect(alert).not.toHaveBeenCalled();
  await view.unmount();
});
