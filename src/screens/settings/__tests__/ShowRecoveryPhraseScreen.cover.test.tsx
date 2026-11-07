import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

let mockCovered = false;
const mockGoBack = jest.fn();
const mockNavigation = { goBack: mockGoBack };
const mockAccount = { address: 'test-address', type: 'standard' };
const mockAccounts = [mockAccount];
jest.mock('@/hooks/useCoverPaused', () => ({
  useCoverPaused: () => mockCovered,
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: {} }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockAccount,
  useAccounts: () => mockAccounts,
}));
jest.mock('@/store/useFreshRekeyCheck', () => ({
  useFreshRekeyCheck: () => ({ allSelf: true }),
}));
jest.mock('@/store/rekeyDisplayStatus', () => ({
  useRekeyDisplayDelegatedAnywhere: () => false,
}));
jest.mock('@/hooks/useSecureScreen', () => ({ useSecureScreen: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: { revealMnemonic: jest.fn(async () => 'synthetic-phrase') },
}));
jest.mock('@/services/secure/freshAuth', () => ({
  withFreshAuth: jest.fn(
    async (_purpose: string, body: () => Promise<string>) => body()
  ),
  FreshAuthError: class extends Error {},
}));
jest.mock('@/utils/clipboardAutoClear', () => ({
  scheduleClipboardClear: jest.fn(),
}));
import ShowRecoveryPhraseScreen from '../ShowRecoveryPhraseScreen';
import { withFreshAuth } from '@/services/secure/freshAuth';

it.each([true, false])(
  'DEFECT: revealed phrase after cover=%s',
  async (cover) => {
    mockCovered = false;
    const view = await render(<ShowRecoveryPhraseScreen />);
    await fireEvent.press(view.getByText('Reveal'));
    expect(view.getByText('synthetic-phrase')).toBeTruthy();
    expect(view.getByText('Hide')).toBeTruthy();
    if (cover) {
      mockCovered = true;
      await view.rerender(<ShowRecoveryPhraseScreen />);
      expect(view.queryByText('synthetic-phrase')).toBeNull();
      mockCovered = false;
      await view.rerender(<ShowRecoveryPhraseScreen />);
      expect(view.queryByText('synthetic-phrase')).toBeNull();
      expect(view.getByText('Reveal')).toBeTruthy();
      await fireEvent.press(view.getByText('Reveal'));
      expect(view.queryByText('synthetic-phrase')).toBeNull();
      expect(withFreshAuth).toHaveBeenCalledTimes(1);
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    }
  }
);
