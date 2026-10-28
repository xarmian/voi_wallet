import React from 'react';
import {
  Text as MockText,
  TouchableOpacity as MockTouchableOpacity,
  View as MockView,
  ScrollView as MockScrollView,
} from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import algosdk from 'algosdk';
import { makeAddress, SUGGESTED_PARAMS } from '@/__tests__/fixtures/algorand';
import { Arc200TransactionService as Arc } from '@/services/transactions/arc200';
import { TransactionService } from '@/services/transactions';
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
  networkService: {},
  NetworkService: { getInstance: () => ({}) },
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
let mockRequest: any;
const mockAccount = { id: 'a', address: makeAddress(1) };
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: mockParams }),
  useNavigation: () => ({ navigate: mockNavigate }),
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
