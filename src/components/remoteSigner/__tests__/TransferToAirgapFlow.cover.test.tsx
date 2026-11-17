import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, AppStateStatus } from 'react-native';

const mockReveal = jest.fn(async () => new Uint8Array(64).fill(7));
const mockAuthSignals: (AbortSignal | undefined)[] = [];
let mockAuthFailure: string | null = null;

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    revealPrivateKey: (...args: unknown[]) => mockReveal(...(args as [])),
  },
}));
jest.mock('@/services/secure/freshAuth', () => {
  class FreshAuthError extends Error {
    code: string;
    constructor(code: string) {
      super('Authentication was ' + code);
      this.code = code;
    }
  }
  return {
    FreshAuthError,
    withFreshAuth: (
      _reason: string,
      fn: (cap: object) => unknown,
      opts?: { signal?: AbortSignal }
    ) => {
      mockAuthSignals.push(opts?.signal);
      if (mockAuthFailure) {
        return Promise.reject(new FreshAuthError(mockAuthFailure));
      }
      return Promise.resolve(fn({}));
    },
  };
});
jest.mock('@/utils/keyIdentity', () => ({ keyBelongsToAddress: () => true }));
const mockExportUri = jest.fn(() => 'arc0300://fixture-qr-payload');
const mockQrRenders: string[] = [];
jest.mock('@/utils/arc0300', () => ({
  generateArc0300AccountExportUri: () => mockExportUri(),
}));
jest.mock('@/components/remoteSigner/AnimatedQRCode', () => {
  const { Text } = require('react-native');
  return {
    AnimatedQRCode: ({ data }: { data: string }) => {
      mockQrRenders.push(data);
      return <Text>{`QR:${data}`}</Text>;
    },
  };
});
jest.mock('@/components/remoteSigner/AnimatedQRScanner', () => ({
  AnimatedQRScanner: () => null,
}));
jest.mock('@/services/remoteSigner', () => ({ RemoteSignerService: {} }));
jest.mock('@/services/wallet', () => ({ MultiAccountWalletService: {} }));
jest.mock('@/utils/signatureVerification', () => ({
  verifyAirgapTransferConfirmation: jest.fn(),
}));
jest.mock('@/services/network/config', () => ({
  getNetworkConfig: () => ({ name: 'Test', nativeToken: 'VOI' }),
}));
jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () => 'voi-mainnet',
}));
jest.mock('@/hooks/useSecureScreen', () => ({ useSecureScreen: () => {} }));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

import { TransferToAirgapFlow } from '../TransferToAirgapFlow';

const account = {
  id: 'acc-1',
  address: 'A'.repeat(58),
  label: 'Main',
} as never;

const listeners: ((state: AppStateStatus) => void)[] = [];

beforeEach(() => {
  mockExportUri.mockReset().mockReturnValue('arc0300://fixture-qr-payload');
  mockQrRenders.length = 0;
  mockAuthFailure = null;
  mockCovered = false;
  mockReveal.mockImplementation(async () => new Uint8Array(64).fill(7));
  mockAuthSignals.length = 0;
  mockReveal.mockClear();
  listeners.length = 0;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      listeners.push(listener as (state: AppStateStatus) => void);
      return { remove: jest.fn() } as never;
    });
});

afterEach(() => jest.restoreAllMocks());

const onSuccess = jest.fn();
const onCancel = jest.fn();
const element = () => (
  <TransferToAirgapFlow
    account={account}
    onSuccess={onSuccess}
    onCancel={onCancel}
  />
);
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

it('DEFECT 1: hides the Modal while covered and shows it on uncover', async () => {
  const view = await render(element());
  expect(mockModalVisible).toBe(true);
  mockCovered = true;
  await view.rerender(element());
  expect(mockModalVisible).toBe(false);
  mockCovered = false;
  await view.rerender(element());
  expect(mockModalVisible).toBe(true);
});
it('DEFECT 2: discards the key QR and requires fresh authentication after cover', async () => {
  const view = await render(element());
  await fireEvent.press(view.getByText('I Understand, Continue'));
  expect(view.getByText('QR:arc0300://fixture-qr-payload')).toBeTruthy();
  mockCovered = true;
  await view.rerender(element());
  expect(view.queryByText(/QR:/)).toBeNull();
  expect(JSON.stringify(view.toJSON())).not.toContain(
    'arc0300://fixture-qr-payload'
  );
  mockCovered = false;
  await view.rerender(element());
  expect(view.getByText('I Understand, Continue')).toBeTruthy();
  expect(view.queryByText(/QR:/)).toBeNull();
  expect(JSON.stringify(view.toJSON())).not.toContain(
    'arc0300://fixture-qr-payload'
  );
  expect(mockReveal).toHaveBeenCalledTimes(1);
});
it('DEFECT 3: aborts an in-flight export on cover and rejects its late result', async () => {
  let resolve!: (key: Uint8Array<ArrayBuffer>) => void;
  mockReveal.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const view = await render(element());
  await Promise.all([
    fireEvent.press(view.getByText('I Understand, Continue')),
    (async () => {
      await waitFor(() => expect(mockAuthSignals[0]?.aborted).toBe(false));
      mockCovered = true;
      await view.rerender(element());
      const aborted = mockAuthSignals[0]?.aborted;
      await act(async () => {
        resolve(new Uint8Array(64));
      });
      expect(aborted).toBe(true);
    })(),
  ]);
  mockCovered = false;
  await view.rerender(element());
  expect(view.getByText('I Understand, Continue')).toBeTruthy();
  expect(JSON.stringify(view.toJSON())).not.toContain(
    'arc0300://fixture-qr-payload'
  );
});
it('REGRESSION: without cover the gated QR stays available across rerenders', async () => {
  const view = await render(element());
  expect(mockReveal).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('I Understand, Continue'));
  await view.rerender(element());
  expect(view.getByText('QR:arc0300://fixture-qr-payload')).toBeTruthy();
  expect(mockReveal).toHaveBeenCalledTimes(1);
  expect(mockAuthSignals[0]?.aborted).toBe(false);
});

it('REGRESSION: re-entry never renders the previous QR while the next export is pending', async () => {
  mockExportUri
    .mockReturnValueOnce('arc0300://fixture-A')
    .mockReturnValueOnce('arc0300://fixture-B');
  const view = await render(element());
  await fireEvent.press(view.getByText('I Understand, Continue'));
  expect(view.getByText('QR:arc0300://fixture-A')).toBeTruthy();
  mockQrRenders.length = 0;
  mockCovered = true;
  await view.rerender(element());
  mockCovered = false;
  await view.rerender(element());
  expect(view.getByText('I Understand, Continue')).toBeTruthy();
  let resolve!: (key: Uint8Array<ArrayBuffer>) => void;
  mockReveal.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await Promise.all([
    fireEvent.press(view.getByText('I Understand, Continue')),
    (async () => {
      await waitFor(() => expect(mockReveal).toHaveBeenCalledTimes(2));
      expect(view.queryByText(/QR:/)).toBeNull();
      expect(mockQrRenders).not.toContain('arc0300://fixture-A');
      await act(async () => {
        resolve(new Uint8Array(64).fill(8));
      });
    })(),
  ]);
  expect(mockQrRenders).not.toContain('arc0300://fixture-A');
  expect(mockQrRenders).toContain('arc0300://fixture-B');
  expect(view.queryByText('QR:arc0300://fixture-A')).toBeNull();
  expect(view.getByText('QR:arc0300://fixture-B')).toBeTruthy();
});
