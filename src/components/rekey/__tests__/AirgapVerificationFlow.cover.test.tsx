import React from 'react';
import { NetworkId } from '@/types/network';
import { render } from '@testing-library/react-native';
let mockCovered = false;
let mockModalVisible: boolean | undefined;
jest.mock('@/hooks/useCoverPaused', () => ({
  useCoverPaused: () => mockCovered,
}));
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  const descriptors = Object.getOwnPropertyDescriptors(native);
  descriptors.Modal = {
    configurable: true,
    enumerable: true,
    value: (props: React.ComponentProps<typeof native.Modal>) => {
      mockModalVisible = props.visible;
      return require('react').createElement(native.Modal, props);
    },
  };
  return Object.defineProperties({}, descriptors);
});

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/services/transactions', () => ({
  TransactionService: {
    buildVerificationTransaction: jest.fn(async () => ({ txn: {} })),
  },
}));
jest.mock('@/services/remoteSigner', () => ({
  RemoteSignerService: {
    createSingleTxnRequest: jest.fn(async () => ({})),
    encodePayload: () => 'verification-fixture',
  },
}));
jest.mock('@/utils/signatureVerification', () => ({
  verifySignedTransaction: jest.fn(),
}));
jest.mock('@/components/remoteSigner/AnimatedQRCode', () => ({
  AnimatedQRCode: ({ data }: { data: string }) => {
    const { Text } = require('react-native');
    return <Text>{data}</Text>;
  },
}));
jest.mock('@/components/remoteSigner/AnimatedQRScanner', () => ({
  AnimatedQRScanner: () => null,
}));
import { AirgapVerificationFlow } from '../AirgapVerificationFlow';
import { TransactionService } from '@/services/transactions';
const account = { address: 'fixture-address', label: 'Fixture' } as never;
const onSuccess = jest.fn();
const onFailure = jest.fn();
const onCancel = jest.fn();
const element = () => (
  <AirgapVerificationFlow
    targetAccount={account}
    networkId={NetworkId.VOI_MAINNET}
    onVerificationSuccess={onSuccess}
    onVerificationFailure={onFailure}
    onCancel={onCancel}
  />
);
beforeEach(() => {
  mockCovered = false;
  jest.clearAllMocks();
});
it('DEFECT: hides the Modal on cover and restores the QR on uncover', async () => {
  const view = await render(element());
  expect(mockModalVisible).toBe(true);
  expect(view.getByText('verification-fixture')).toBeTruthy();
  mockCovered = true;
  await view.rerender(element());
  expect(mockModalVisible).toBe(false);
  expect(view.queryByText('verification-fixture')).toBeNull();
  mockCovered = false;
  await view.rerender(element());
  expect(mockModalVisible).toBe(true);
  expect(view.getByText('verification-fixture')).toBeTruthy();
  expect(TransactionService.buildVerificationTransaction).toHaveBeenCalledTimes(
    1
  );
});
it('REGRESSION: without cover verification builds once and keeps its QR', async () => {
  const view = await render(element());
  await view.rerender(element());
  expect(mockModalVisible).toBe(true);
  expect(view.getByText('verification-fixture')).toBeTruthy();
  expect(TransactionService.buildVerificationTransaction).toHaveBeenCalledTimes(
    1
  );
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});
