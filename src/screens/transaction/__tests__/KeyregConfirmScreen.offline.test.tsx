/**
 * TASK-439 — "Go Offline" must never ask for nonParticipation.
 *
 * On Algorand/Voi a keyreg with nonpart=true marks the account permanently
 * non-participating: it can never register keys and go online again. A plain
 * go-offline keyreg carries no participation fields and no nonpart flag.
 *
 * Negative control: before the fix, KeyregConfirmScreen built the offline
 * request with `nonParticipation: !params.isOnline` (= true), so both cases
 * below fail against it.
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import KeyregConfirmScreen from '../KeyregConfirmScreen';

const ADDRESS = 'OFFLINEACCOUNT';
let mockParams: Record<string, unknown>;
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
  useRoute: () => ({ params: mockParams }),
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: () => ({
    wallet: { accounts: [{ id: 'acct', address: 'OFFLINEACCOUNT' }] },
  }),
}));
jest.mock('@/services/auth/transactionAuthController', () => ({
  useTransactionAuthController: () => ({ cleanup: jest.fn() }),
}));
// The auth modal is where the screen hands its request to the signer;
// capture what it receives.
let mockModalRequest: unknown;
jest.mock('@/components/UnifiedTransactionAuthModal', () => ({
  __esModule: true,
  default: ({ request }: { request: unknown }) => {
    mockModalRequest = request;
    return null;
  },
}));
// The real module builds a network client on load.
jest.mock('@/utils/address', () => ({
  formatAddress: (address: string) => address,
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: (create: (theme: unknown) => unknown) =>
    create(require('@/constants/themes').lightTheme),
  useThemeColors: () => require('@/constants/themes').lightTheme.colors,
}));
jest.mock('@/services/network/config', () => ({
  getNetworkConfig: () => ({ name: 'Voi', currency: 'VOI' }),
}));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View };
});

beforeEach(() => {
  mockModalRequest = null;
  mockParams = { address: ADDRESS, isOnline: false, networkId: 'voi-mainnet' };
});

const confirmGoOffline = async () => {
  const view = await render(<KeyregConfirmScreen />);
  // The status badge carries the same label; the confirm button is last.
  await fireEvent.press(view.getAllByText('Go Offline').at(-1)!);
  return mockModalRequest as {
    type: string;
    keyregParams: Record<string, unknown>;
  };
};

it('builds the go-offline request with goOffline and without nonParticipation', async () => {
  const request = await confirmGoOffline();

  expect(request.type).toBe('keyreg');
  expect(request.keyregParams.goOffline).toBe(true);
  expect('nonParticipation' in request.keyregParams).toBe(false);
});

it('builds the go-online request with goOffline false', async () => {
  mockParams = {
    address: ADDRESS,
    isOnline: true,
    networkId: 'voi-mainnet',
    votekey: 'AQ',
    selkey: 'Ag',
  };
  const view = await render(<KeyregConfirmScreen />);
  await fireEvent.press(view.getAllByText('Go Online').at(-1)!);
  const request = mockModalRequest as { keyregParams: Record<string, unknown> };

  expect(request.keyregParams.goOffline).toBe(false);
  expect('nonParticipation' in request.keyregParams).toBe(false);
});
