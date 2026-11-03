/**
 * TASK-485: the private-key QR export needs a fresh prompt, never reads the key
 * when the prompt is refused, and drops the key-bearing QR when the app goes to
 * the background.
 *
 * SECURITY NOTE: all key material here is a made-up fixture.
 */
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
jest.mock('@/utils/arc0300', () => ({
  generateArc0300AccountExportUri: () => 'arc0300://fixture-qr-payload',
}));
jest.mock('@/components/remoteSigner/AnimatedQRCode', () => {
  const { Text } = require('react-native');
  return {
    AnimatedQRCode: ({ data }: { data: string }) => <Text>{`QR:${data}`}</Text>,
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
  mockAuthFailure = null;
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

const renderFlow = async () =>
  render(
    <TransferToAirgapFlow
      account={account}
      onSuccess={jest.fn()}
      onCancel={jest.fn()}
    />
  );

describe('TransferToAirgapFlow key export gate', () => {
  it('shows the QR only after the gated read succeeds', async () => {
    const view = await renderFlow();
    expect(mockReveal).not.toHaveBeenCalled();
    await fireEvent.press(view.getByText('I Understand, Continue'));
    await waitFor(() =>
      expect(view.getByText('QR:arc0300://fixture-qr-payload')).toBeTruthy()
    );
    expect(mockReveal).toHaveBeenCalledTimes(1);
  });

  it('a refused prompt reads no key and shows no QR', async () => {
    mockAuthFailure = 'cancelled';
    const view = await renderFlow();
    await fireEvent.press(view.getByText('I Understand, Continue'));
    await act(async () => {});
    expect(mockReveal).not.toHaveBeenCalled();
    expect(view.queryByText(/QR:/)).toBeNull();
  });

  it('drops the key-bearing QR and returns to the disclaimer when the app backgrounds', async () => {
    const view = await renderFlow();
    await fireEvent.press(view.getByText('I Understand, Continue'));
    await waitFor(() =>
      expect(view.getByText('QR:arc0300://fixture-qr-payload')).toBeTruthy()
    );
    await act(async () => listeners.forEach((l) => l('background')));
    expect(view.queryByText(/QR:/)).toBeNull();
    expect(view.getByText('I Understand, Continue')).toBeTruthy();
  });

  it('does not drop the QR on inactive (the Face ID sheet makes the app inactive)', async () => {
    const view = await renderFlow();
    await fireEvent.press(view.getByText('I Understand, Continue'));
    await waitFor(() =>
      expect(view.getByText('QR:arc0300://fixture-qr-payload')).toBeTruthy()
    );
    await act(async () => listeners.forEach((l) => l('inactive')));
    expect(view.getByText('QR:arc0300://fixture-qr-payload')).toBeTruthy();
  });

  it('cancels the pending prompt when the flow unmounts', async () => {
    const view = await renderFlow();
    await fireEvent.press(view.getByText('I Understand, Continue'));
    await act(async () => {});
    expect(mockAuthSignals[0]?.aborted).toBe(false);
    await view.unmount();
    expect(mockAuthSignals[0]?.aborted).toBe(true);
  });
});
