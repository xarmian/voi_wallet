import React from 'react';
import {
  Alert,
  Text as MockText,
  TouchableOpacity as MockTouchableOpacity,
  View as MockView,
  ScrollView as MockScrollView,
} from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';
import algosdk from 'algosdk';
import { makeAddress, SUGGESTED_PARAMS } from '@/__tests__/fixtures/algorand';
import { Arc200TransactionService as Arc } from '@/services/transactions/arc200';
import { TransactionService } from '@/services/transactions';
import { getNavigationCallbacks } from '@/services/navigation/callbackRegistry';
import { networkService } from '@/services/network';
import {
  TransactionExpiredError,
  TransactionMaybeSubmittedError,
  TransactionPendingError,
} from '@/types/network';
import {
  isArc200MbrRace,
  isArc200ExpiredGroup,
  ARC200_RECONFIRM_MESSAGE,
} from '@/services/transactions/arc200MbrRace';
import Send from '../TransactionConfirmationScreen';
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
let mockAuthProps: any;
let mockRequest: any;
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
jest.mock('@/components/UnifiedTransactionAuthModal', () => (p: any) => {
  mockRequest = p.request;
  mockAuthProps = p;
  return null;
});
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

it.each([
  ['send', Send],
  ['claim', Claim],
  ['all', All],
] as const)(
  '%s retains the displayed group and bypasses stale decisions',
  async (flow, Screen) => {
    const item = {
      contractId: 123,
      owner: makeAddress(2),
      amount: '1',
      ownerBalance: '1',
      tokenDecimals: 0,
      tokenSymbol: 'T',
      tokenName: 'Token',
    };
    mockParams = {
      claimableItem: item,
      items: [item],
      fromAccount: mockAccount,
      recipient: makeAddress(2),
      amount: '1',
      assetType: 'arc200',
      assetDecimals: 0,
      contractId: 123,
      estimatedFee: 999999,
      assetSymbol: 'T',
    };
    const builder = (
      flow === 'send'
        ? Arc.buildArc200TransferGroup
        : flow === 'claim'
          ? Arc.buildArc200TransferFromGroup
          : Arc.buildBatchClaimTransactionGroup
    ) as jest.Mock;
    for (const funded of [false, true]) {
      const transactions = [
        algosdk.makeApplicationNoOpTxnFromObject({
          sender: mockAccount.address,
          appIndex: 123,
          suggestedParams: SUGGESTED_PARAMS,
        }),
      ];
      if (funded)
        transactions.unshift(
          algosdk.makePaymentTxnWithSuggestedParamsFromObject({
            sender: mockAccount.address,
            receiver: algosdk.getApplicationAddress(123),
            amount: 28500,
            suggestedParams: SUGGESTED_PARAMS,
          })
        );
      algosdk.assignGroupID(transactions);
      const group = {
        transactions,
        txnBytes: transactions.map(algosdk.encodeUnsignedTransaction),
        needsMbrPayment: funded,
      };
      builder.mockClear().mockResolvedValue(group);
      const view = await render(<Screen />);
      expect(
        await view.findByText(`${(Arc.groupCost(group) / 1e6).toFixed(6)} VOI`)
      ).toBeTruthy();
      await fireEvent.press(
        view.getByText(
          flow === 'send'
            ? 'Confirm & Send'
            : flow === 'claim'
              ? 'Claim Tokens'
              : 'Claim 1 Token'
        )
      );
      if (flow === 'send') {
        const params = mockRequest.transferParams;
        const signed = await TransactionService.buildTransaction(params);
        expect((signed as any).txnBytes).toEqual(group.txnBytes);
        expect(builder).toHaveBeenCalledTimes(1);
        expect(TransactionService.getCachedUnsignedTransaction(params)).toBe(
          group
        );
        // Without a retained group, the next build must still consult current state.
        const { preparedArc200Group, ...fresh } = params;
        expect(
          TransactionService.getCachedUnsignedTransaction(fresh)
        ).toBeNull();
        expect(
          ((await TransactionService.buildTransaction(fresh)) as any).txnBytes
        ).toEqual(group.txnBytes);
      } else {
        expect(builder).toHaveBeenCalledTimes(1);
        expect(mockNavigate.mock.calls.at(-1)![1].transactions).toEqual(
          group.txnBytes.map((bytes) => Buffer.from(bytes).toString('base64'))
        );
      }
      await view.unmount();
    }
  }
);

const makeGroup = (
  funded: boolean,
  mixed = false,
  fundBoth = false,
  suggestedParams = SUGGESTED_PARAMS
) => {
  const transactions = [
    algosdk.makeApplicationNoOpTxnFromObject({
      sender: mockAccount.address,
      appIndex: 123,
      suggestedParams,
    }),
  ];
  if (funded)
    transactions.unshift(
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: mockAccount.address,
        receiver: algosdk.getApplicationAddress(123),
        amount: 28500,
        suggestedParams,
      })
    );
  if (mixed && fundBoth)
    transactions.push(
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: mockAccount.address,
        receiver: algosdk.getApplicationAddress(456),
        amount: 28500,
        suggestedParams,
      })
    );
  if (mixed)
    transactions.push(
      algosdk.makeApplicationNoOpTxnFromObject({
        sender: mockAccount.address,
        appIndex: 456,
        suggestedParams,
      })
    );
  algosdk.assignGroupID(transactions);
  return {
    transactions,
    txnBytes: transactions.map(algosdk.encodeUnsignedTransaction),
    needsMbrPayment: funded,
  };
};
const belowMin = (address = algosdk.getApplicationAddress(123).toString()) =>
  `TransactionPool.Remember: transaction ABC: account ${address} balance 100000 below min 128500 (0 assets)`;

it.each([
  belowMin(mockAccount.address),
  belowMin(algosdk.getApplicationAddress(456).toString()),
  'logic eval error: invalid Box reference 0x1234. Details: app=123, pc=45',
  'logic eval error: box not found. Details: app=123, pc=45',
  'logic eval error: assert failed pc=45',
  'Network request error. Received status 503 (Service Unavailable)',
  'overspend (account balance 1000, tried to spend 2000)',
  'txn dead: round 0 outside of 1--1001',
  'txn dead: round 5000 outside of 2--3',
  'transaction expired',
])('does not classify unrelated rejection: %s', (message) => {
  expect(isArc200MbrRace(new Error(message), makeGroup(false))).toBe(false);
  expect(isArc200ExpiredGroup(new Error(message), makeGroup(false))).toBe(
    false
  );
});
it.each([
  '',
  'Network request error. Received status 400 (Bad Request): ',
  'Transaction failed: Network submission failed after 3 attempts: Transaction failed: ',
])(
  'classifies the escrow rejection through SDK/service wrappers: %s',
  (prefix) => {
    expect(
      isArc200MbrRace(new Error(prefix + belowMin()), makeGroup(false))
    ).toBe(true);
  }
);

it.each(['send', 'claim', 'all'] as const)(
  '%s recovers once and requires renewed confirmation',
  async (flow) => {
    const item = {
      contractId: 123,
      owner: makeAddress(2),
      amount: '1',
      ownerBalance: '1',
      tokenDecimals: 0,
      tokenSymbol: 'T',
      tokenName: 'Token',
    };
    mockParams = {
      claimableItem: item,
      items: [item],
      fromAccount: mockAccount,
      recipient: makeAddress(2),
      amount: '1',
      assetType: 'arc200',
      assetDecimals: 0,
      contractId: 123,
      estimatedFee: 999999,
      assetSymbol: 'T',
    };
    const Screen = flow === 'send' ? Send : flow === 'claim' ? Claim : All;
    const builder = (
      flow === 'send'
        ? Arc.buildArc200TransferGroup
        : flow === 'claim'
          ? Arc.buildArc200TransferFromGroup
          : Arc.buildBatchClaimTransactionGroup
    ) as jest.Mock;
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const sign = jest
      .spyOn(TransactionService as any, 'signTransactionWithRecovery')
      .mockResolvedValue(new Uint8Array([1]));
    const delay = jest
      .spyOn(TransactionService as any, 'delay')
      .mockResolvedValue(undefined);
    // Claims submit through NetworkService.submitTransaction too (TASK-451).
    const submit = networkService.submitTransaction as jest.Mock;
    const pressLabel =
      flow === 'send'
        ? 'Confirm & Send'
        : flow === 'claim'
          ? 'Claim Tokens'
          : 'Claim 1 Token';
    try {
      for (const scenario of [
        'race',
        'expired',
        'mixed',
        'buildFailure',
        'initialFailure',
        'other',
        'funded',
        'mixedFunded',
      ] as const) {
        if (scenario.startsWith('mixed') && flow !== 'all') continue;
        mockParams.items = scenario.startsWith('mixed')
          ? [item, { ...item, contractId: 456 }]
          : [item];
        const original = makeGroup(
          ['funded', 'mixed', 'mixedFunded', 'expired'].includes(scenario),
          scenario === 'mixed' || scenario === 'mixedFunded'
        );
        const rebuilt = makeGroup(
          scenario !== 'expired',
          scenario.startsWith('mixed'),
          true,
          scenario === 'expired'
            ? { ...SUGGESTED_PARAMS, firstValid: 1002, lastValid: 2002 }
            : SUGGESTED_PARAMS
        );
        builder
          .mockReset()
          .mockResolvedValueOnce(original)
          .mockResolvedValue(rebuilt);
        if (scenario === 'buildFailure')
          builder
            .mockReset()
            .mockResolvedValueOnce(original)
            .mockRejectedValueOnce(new Error('build failed'))
            .mockResolvedValue(rebuilt);
        if (scenario === 'initialFailure')
          builder
            .mockReset()
            .mockRejectedValueOnce(new Error('build failed'))
            .mockResolvedValue(original);
        alert.mockClear();
        mockReplace.mockClear();
        mockNavigate.mockClear();
        mockGoBack.mockClear();
        const error = new Error(
          scenario === 'other'
            ? 'logic eval error: invalid Box reference'
            : scenario === 'expired'
              ? expiredMessage(original)
              : scenario === 'mixed'
                ? belowMin(algosdk.getApplicationAddress(456).toString())
                : belowMin()
        );
        submit.mockReset().mockRejectedValue(error);
        const view = await render(<Screen />);
        if (scenario === 'initialFailure') {
          expect(
            await view.findByText(
              'Unable to prepare transaction. Please retry.'
            )
          ).toBeTruthy();
          await act(async () => {
            fireEvent.press(view.getByText('Retry'));
          });
          expect(builder).toHaveBeenCalledTimes(2);
          await view.findByText(
            `${(Arc.groupCost(original) / 1e6).toFixed(6)} VOI`
          );
          await view.unmount();
          continue;
        }
        expect(
          await view.findByText(
            `${(Arc.groupCost(original) / 1e6).toFixed(6)} VOI`
          )
        ).toBeTruthy();
        const confirm = async () => {
          await act(async () => {
            await fireEvent.press(
              view.getByText(
                flow === 'all'
                  ? `Claim ${mockParams.items.length} Token${mockParams.items.length > 1 ? 's' : ''}`
                  : pressLabel
              )
            );
          });
        };
        const fail = async () => {
          await act(async () => {
            if (flow === 'send') {
              let failure;
              try {
                await TransactionService.sendTransaction(
                  mockRequest.transferParams,
                  mockAccount as any
                );
              } catch (caught) {
                failure = caught;
              }
              expect(failure).toBeInstanceOf(Error);
              await mockAuthProps.onComplete(false, { error: failure });
            } else {
              const callbackId = mockNavigate.mock.calls.at(-1)![1].callbackId;
              await getNavigationCallbacks(callbackId)!.onSuccess!({
                signedTransactions: ['AQ=='],
              });
            }
          });
        };
        await confirm();
        const signedBefore = sign.mock.calls.length;
        if (flow === 'send')
          expect(mockAuthProps.formatErrorMessage(error)).toBe(
            ['race', 'expired', 'mixed', 'buildFailure'].includes(scenario)
              ? ARC200_RECONFIRM_MESSAGE
              : undefined
          );
        await fail();
        if (scenario === 'buildFailure') {
          expect(
            await view.findByText(
              'Unable to prepare transaction. Please retry.'
            )
          ).toBeTruthy();
          expect(alert).not.toHaveBeenCalled();
          expect(mockReplace).not.toHaveBeenCalled();
          await act(async () => {
            fireEvent.press(view.getByText('Retry'));
          });
          expect(
            await view.findByText(
              `${(Arc.groupCost(rebuilt) / 1e6).toFixed(6)} VOI`
            )
          ).toBeTruthy();
          expect(builder).toHaveBeenCalledTimes(3);
          await view.unmount();
          continue;
        }
        if (['race', 'expired', 'mixed'].includes(scenario)) {
          expect(builder).toHaveBeenCalledTimes(2);
          if (flow === 'all')
            expect(builder.mock.calls[1][2]).toBe(scenario !== 'expired');
          else
            expect(builder.mock.calls[1][0].forceMbrPayment).toBe(
              scenario !== 'expired'
            );
          expect(alert).toHaveBeenLastCalledWith(
            'Confirm Again',
            ARC200_RECONFIRM_MESSAGE
          );
          expect(
            await view.findByText(
              `${(Arc.groupCost(rebuilt) / 1e6).toFixed(6)} VOI`
            )
          ).toBeTruthy();
          expect(mockReplace).not.toHaveBeenCalled();
          expect(mockNavigate).toHaveBeenCalledTimes(flow === 'send' ? 0 : 1);
          expect(mockGoBack).toHaveBeenCalledTimes(flow === 'send' ? 0 : 1);
          expect(sign.mock.calls.length).toBe(
            signedBefore + (flow === 'send' ? 1 : 0)
          );
          // One submit per send: resends live inside
          // NetworkService.submitTransaction (mocked here), not in
          // TransactionService (TASK-440 #8).
          const submits = submit.mock.calls.length;
          expect(submits).toBe(1);
          await confirm();
          expect(mockReplace).not.toHaveBeenCalled();
          if (flow === 'send')
            expect(mockRequest.transferParams.preparedArc200Group).toBe(
              rebuilt
            );
          else
            expect(mockNavigate.mock.calls.at(-1)![1].transactions).toEqual(
              rebuilt.txnBytes.map((bytes) =>
                Buffer.from(bytes).toString('base64')
              )
            );
          // Cross rejection types to prove MBR and expiry share the same latch.
          error.message =
            scenario === 'expired' ? belowMin() : expiredMessage(rebuilt);
          submit.mockRejectedValue(error);
          await fail();
          expect(builder).toHaveBeenCalledTimes(2);
          expect(submit.mock.calls.length).toBe(submits * 2);
        } else expect(builder).toHaveBeenCalledTimes(1);
        if (flow === 'send')
          // The failure copy comes from the modal's { error } (TASK-453), not
          // the generic fallback.
          expect(mockReplace).toHaveBeenLastCalledWith(
            'TransactionResult',
            expect.objectContaining({
              isSuccess: false,
              errorMessage: expect.not.stringMatching(
                /^Transaction failed\.?$/
              ),
            })
          );
        else
          expect(alert).toHaveBeenLastCalledWith(
            'Submission Failed',
            error.message
          );
        await view.unmount();
      }
    } finally {
      alert.mockRestore();
      sign.mockRestore();
      delay.mockRestore();
    }
  }
);

const expiredMessage = (group = makeGroup(false)) => {
  const txn = group.transactions[0];
  return `TransactionPool.Remember: txn dead: round ${txn.lastValid + 1n} outside of ${txn.firstValid}--${txn.lastValid}`;
};

// TASK-451: a claim that was, or may have been, submitted and is not confirmed
// is pending: it leaves the screen like a confirmed claim, never says
// 'Submission Failed', and keeps the latch held so the same group can't submit
// again. A genuine rejection keeps its failure rendering.
describe.each(['claim', 'all'] as const)('%s submit outcome', (flow) => {
  const item = {
    contractId: 123,
    owner: makeAddress(2),
    amount: '1',
    ownerBalance: '1',
    tokenDecimals: 0,
    tokenSymbol: 'T',
    tokenName: 'Token',
  };
  const builder = () =>
    (flow === 'claim'
      ? Arc.buildArc200TransferFromGroup
      : Arc.buildBatchClaimTransactionGroup) as jest.Mock;
  const submit = networkService.submitTransaction as jest.Mock;
  let alert: jest.SpyInstance;

  beforeEach(() => {
    mockParams = { claimableItem: item, items: [item] };
    builder().mockReset().mockResolvedValue(makeGroup(false));
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    submit.mockReset();
    mockDispatch.mockClear();
    mockNavigate.mockClear();
  });
  afterEach(() => alert.mockRestore());

  const signAndSubmit = async () => {
    const view = await render(flow === 'claim' ? <Claim /> : <All />);
    await view.findByText(
      `${(Arc.groupCost(makeGroup(false)) / 1e6).toFixed(6)} VOI`
    );
    await act(async () => {
      await fireEvent.press(
        view.getByText(flow === 'claim' ? 'Claim Tokens' : 'Claim 1 Token')
      );
    });
    const callbackId = mockNavigate.mock.calls.at(-1)![1].callbackId;
    const onSuccess = getNavigationCallbacks(callbackId)!.onSuccess!;
    await act(async () => {
      await onSuccess({ signedTransactions: ['AQ=='] });
    });
    return { view, onSuccess };
  };

  it('leaves for the claim list on a confirmed claim, with no alert', async () => {
    submit.mockResolvedValue({ txId: 'TX', confirmed: true });
    const { view } = await signAndSubmit();

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    await view.unmount();
  });

  it.each([
    [
      'a confirmed=false result',
      () => submit.mockResolvedValue({ txId: 'TX', confirmed: false }),
      'Not Confirmed Yet',
    ],
    [
      'a pending error',
      () => submit.mockRejectedValue(new TransactionPendingError('TX')),
      'Not Confirmed Yet',
    ],
    [
      'a maybe-submitted error',
      () => submit.mockRejectedValue(new TransactionMaybeSubmittedError()),
      'May Have Been Sent',
    ],
  ])(
    'shows %s as pending, leaves the screen and holds the latch',
    async (_, arrange, title) => {
      arrange();
      const { view, onSuccess } = await signAndSubmit();

      expect(alert).toHaveBeenLastCalledWith(title, expect.any(String));
      expect(alert).not.toHaveBeenCalledWith(
        'Submission Failed',
        expect.anything()
      );
      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(builder()).toHaveBeenCalledTimes(1);
      // A second success callback for the same group must not submit again.
      await act(async () => {
        await onSuccess({ signedTransactions: ['AQ=='] });
      });
      expect(submit).toHaveBeenCalledTimes(1);
      await view.unmount();
    }
  );

  it('rebuilds when the reconcile finds the group expired (TransactionExpiredError)', async () => {
    const group = makeGroup(false);
    submit.mockRejectedValue(
      new TransactionExpiredError('TX', group.transactions[0].lastValid)
    );
    const { view } = await signAndSubmit();

    expect(alert).toHaveBeenLastCalledWith(
      'Confirm Again',
      ARC200_RECONFIRM_MESSAGE
    );
    expect(builder()).toHaveBeenCalledTimes(2);
    expect(mockDispatch).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('keeps Submission Failed for a genuine rejection', async () => {
    submit.mockRejectedValue(
      new Error('logic eval error: invalid Box reference')
    );
    const { view } = await signAndSubmit();

    expect(alert).toHaveBeenLastCalledWith(
      'Submission Failed',
      'logic eval error: invalid Box reference'
    );
    expect(mockDispatch).not.toHaveBeenCalled();
    await view.unmount();
  });
});

// TASK-451: NetworkService's reconciled expiry is an expired group too, but
// only for a last valid round this group carries.
describe('isArc200ExpiredGroup on a reconciled expiry', () => {
  const group = makeGroup(false);
  const lastValid = group.transactions[0].lastValid;

  it('matches TransactionExpiredError for this group, typed or wrapped', () => {
    const expired = new TransactionExpiredError('TX', lastValid);
    expect(isArc200ExpiredGroup(expired, group)).toBe(true);
    expect(
      isArc200ExpiredGroup(
        new Error(`Transaction failed: ${expired.message}`),
        group
      )
    ).toBe(true);
  });

  it("does not match another group's last valid round", () => {
    expect(
      isArc200ExpiredGroup(
        new TransactionExpiredError('TX', lastValid + 7n),
        group
      )
    ).toBe(false);
  });

  it('is not an MBR race', () => {
    expect(
      isArc200MbrRace(new TransactionExpiredError('TX', lastValid), group)
    ).toBe(false);
  });
});
