import React from 'react';
import {
  Alert,
  AppState,
  type AppStateStatus,
  Text as MockText,
  TouchableOpacity as MockTouchableOpacity,
  View as MockView,
  ScrollView as MockScrollView,
} from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';
import algosdk from 'algosdk';
import { makeAddress, SUGGESTED_PARAMS } from '@/__tests__/fixtures/algorand';
import { Arc200TransactionService as Arc } from '@/services/transactions/arc200';
import { getNavigationCallbacks } from '@/services/navigation/callbackRegistry';
import { networkService } from '@/services/network';
import { AppLockSignal } from '@/services/secure/appLockState';
import { lapseEpoch } from '@/services/auth/flowLapse';
import { PENDING_TRANSACTION_ALERT } from '@/utils/errorMapping';
import Claim from '../ClaimTokenScreen';
import All from '../ClaimAllConfirmationScreen';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/services/network', () => ({
  networkService: {
    submitTransaction: jest.fn(),
  },
  NetworkService: {
    getInstance: () => require('@/services/network').networkService,
  },
}));
jest.mock('@/services/secure/keyManager', () => ({ SecureKeyManager: {} }));
jest.mock('@/services/wallet', () => ({ MultiAccountWalletService: {} }));
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/security/transactionTracker', () => ({
  TransactionTracker: {},
}));

let mockParams: any;
const mockNavigate = jest.fn();
const mockReplace = jest.fn();
const mockGoBack = jest.fn();
const mockDispatch = jest.fn();
const mockAccount = { id: 'a', address: makeAddress(1) };
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: mockParams }),
  useNavigation: () => ({
    navigate: mockNavigate,
    replace: mockReplace,
    goBack: mockGoBack,
    dispatch: mockDispatch,
  }),
  CommonActions: { reset: (state: unknown) => ({ type: 'RESET', state }) },
}));
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockAccount,
  useMultiNetworkBalance: () => ({}),
}));
jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () => 'voi-mainnet',
  useCurrentNetworkConfig: () => ({}),
}));
jest.mock('@/services/auth/transactionAuthController', () => ({
  useTransactionAuthController: () => ({ cleanup: jest.fn() }),
}));
jest.mock('@/components/UnifiedTransactionAuthModal', () => () => null);
jest.mock(
  '@/components/ledger/TransactionVerification',
  () =>
    function MockVerification(p: any) {
      return <MockText>{(p.fee / 1e6).toFixed(6)} VOI</MockText>;
    }
);
jest.mock('@/components/envoi/EnvoiProfileCard', () => () => null);
jest.mock('@/services/envoi', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getName: async () => null,
      configureForNetwork: jest.fn(),
    }),
  },
}));
jest.mock('@/components/common/GlassCard', () => ({ GlassCard: MockView }));
jest.mock('@/components/common/GlassButton', () => ({
  GlassButton: (p: any) => (
    <MockTouchableOpacity onPress={p.onPress} disabled={p.disabled}>
      <MockText>{p.label}</MockText>
    </MockTouchableOpacity>
  ),
}));
jest.mock('@/components/common/KeyboardAwareScrollView', () => MockScrollView);
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: MockView,
}));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/account/AccountRecipientModal', () => () => null);
jest.mock('@/services/transactions/arc200', () => {
  const actual = jest.requireActual('@/services/transactions/arc200');
  return {
    Arc200TransactionService: {
      groupCost: actual.Arc200TransactionService.groupCost,
      buildArc200TransferGroup: jest.fn(),
      buildArc200TransferFromGroup: jest.fn(),
      buildBatchClaimTransactionGroup: jest.fn(),
    },
  };
});

const WITHHELD =
  'Your wallet locked or the app went to the background before this was sent. Nothing was sent. Please try again.';
const submit = networkService.submitTransaction as jest.Mock;
const item = {
  contractId: 123,
  owner: makeAddress(2),
  amount: '1',
  ownerBalance: '1',
  tokenDecimals: 0,
  tokenSymbol: 'T',
  tokenName: 'Token',
};
const group = () => {
  const transactions = [
    algosdk.makeApplicationNoOpTxnFromObject({
      sender: mockAccount.address,
      appIndex: 123,
      suggestedParams: SUGGESTED_PARAMS,
    }),
  ];
  algosdk.assignGroupID(transactions);
  return {
    transactions,
    txnBytes: transactions.map(algosdk.encodeUnsignedTransaction),
    needsMbrPayment: false,
  };
};

let appListeners: Set<(state: AppStateStatus) => void>;
const lapse = (reason: 'lock' | 'background') => {
  if (reason === 'lock') AppLockSignal.setUnlocked(false);
  else [...appListeners].forEach((cb) => cb('background'));
};
let alert: jest.SpyInstance;
beforeEach(() => {
  appListeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, cb) => {
    appListeners.add(cb);
    return { remove: () => appListeners.delete(cb) } as never;
  });
  AppLockSignal.setUnlocked(true);
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  submit.mockReset().mockResolvedValue({ txId: 'TX', confirmed: true });
  mockNavigate.mockClear();
  mockDispatch.mockClear();
  mockGoBack.mockClear();
  mockParams = {
    claimableItem: item,
    items: [item],
    fromAccount: mockAccount,
    recipient: makeAddress(2),
  };
  (Arc.buildArc200TransferFromGroup as jest.Mock).mockResolvedValue(group());
  (Arc.buildBatchClaimTransactionGroup as jest.Mock).mockResolvedValue(group());
});
afterEach(() => {
  AppLockSignal.setUnlocked(false);
  jest.restoreAllMocks();
});

const screens = [
  ['claim', Claim, 'Claim Tokens'],
  ['all', All, 'Claim 1 Token'],
] as const;

/** Confirm on the screen and return the success callback the signing screen gets. */
async function confirmed(Screen: (typeof screens)[number][1], label: string) {
  const view = await render(<Screen />);
  await view.findByText(`${(Arc.groupCost(group()) / 1e6).toFixed(6)} VOI`);
  await act(async () => {
    await fireEvent.press(view.getByText(label));
  });
  const callbackId = mockNavigate.mock.calls.at(-1)![1].callbackId;
  const onSuccess = getNavigationCallbacks(callbackId)!.onSuccess!;
  return { view, onSuccess };
}
const signedWith = (epoch?: number) => ({
  signedTransactions: ['AQ=='],
  ...(epoch === undefined ? {} : { lapseEpoch: epoch }),
});

describe.each(screens)('%s', (_name, Screen, label) => {
  // Signed, then locked or backgrounded before the send: nothing is sent.
  it.each(['lock', 'background'] as const)(
    'staleLapseEpochWithholdsSubmit:%s',
    async (reason) => {
      const { view, onSuccess } = await confirmed(Screen, label);
      const epoch = lapseEpoch();
      lapse(reason);
      AppLockSignal.setUnlocked(true);
      await act(async () => {
        await onSuccess(signedWith(epoch));
      });
      expect(submit).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith('Request ended', WITHHELD);
      expect(mockDispatch).not.toHaveBeenCalled();
      await view.unmount();
    }
  );

  // The withhold check runs before the duplicate-submit latch is taken, so the
  // next confirmed flow through this callback can still submit.
  it('withheldSubmitLeavesLatchOpen', async () => {
    const { view, onSuccess } = await confirmed(Screen, label);
    const stale = lapseEpoch();
    lapse('lock');
    AppLockSignal.setUnlocked(true);
    await act(async () => {
      await onSuccess(signedWith(stale));
    });
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
      await onSuccess(signedWith(lapseEpoch()));
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  // Once the send is issued it runs to its end and shows its real outcome,
  // including a result that arrives after the lock.
  it.each(
    (['lock', 'background'] as const).flatMap((reason) =>
      [true, false].map((confirmedOnChain) => ({ reason, confirmedOnChain }))
    )
  )(
    'lockAfterSubmitIssuedShowsRealOutcome:$reason:confirmed=$confirmedOnChain',
    async ({ reason, confirmedOnChain }) => {
      const { view, onSuccess } = await confirmed(Screen, label);
      let answer!: (value: { txId: string; confirmed: boolean }) => void;
      submit.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          })
      );
      let delivered!: Promise<void>;
      await act(async () => {
        delivered = Promise.resolve(onSuccess(signedWith(lapseEpoch())));
      });
      expect(submit).toHaveBeenCalledTimes(1);
      lapse(reason);
      await act(async () => {
        answer({ txId: 'TX', confirmed: confirmedOnChain });
        await delivered;
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(alert).not.toHaveBeenCalledWith('Request ended', WITHHELD);
      if (confirmedOnChain) expect(alert).not.toHaveBeenCalled();
      else
        expect(alert).toHaveBeenCalledWith(
          PENDING_TRANSACTION_ALERT.title,
          PENDING_TRANSACTION_ALERT.message
        );
      await view.unmount();
    }
  );

  // A result with no epoch (a grant-held or unwatched flow) is never withheld here.
  it('resultWithoutEpochIsNotWithheld', async () => {
    const { view, onSuccess } = await confirmed(Screen, label);
    lapse('lock');
    AppLockSignal.setUnlocked(true);
    await act(async () => {
      await onSuccess(signedWith());
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    await view.unmount();
  });
});
