import React from 'react';
import { render } from '@testing-library/react-native';
import AccountAvatar from '../AccountAvatar';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { useRekeyState } from '@/store/walletStore';
import { NetworkId } from '@/types/network';
jest.mock('@/store/walletStore', () => ({ useRekeyState: jest.fn() }));
jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () =>
    require('@/types/network').NetworkId.ALGORAND_MAINNET,
}));
jest.mock('@/services/envoi', () => ({}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => {
    const { Text } = require('react-native');
    return <Text>{name}</Text>;
  },
}));
it.each(['loading', 'error', 'loaded'])(
  'uses derived canSign and neutral pending/error (%s)',
  async (status) => {
    jest.mocked(useRekeyState).mockReturnValue({
      status,
      isRekeyed: true,
      canSign: false,
    } as ReturnType<typeof useRekeyState>);
    const account = {
      type: AccountType.REKEYED,
      canSign: true,
      authAddress: 'STALE',
    } as AccountMetadata;
    const view = await render(
      <AccountAvatar
        address="SOURCE"
        account={account}
        useEnvoiAvatar={false}
      />
    );
    const colors = require('@/constants/themes').lightTheme.colors;
    expect(view.getByText('lock-closed').parent).toHaveStyle({
      backgroundColor: status === 'loaded' ? colors.warning : colors.textMuted,
    });
    expect(view.queryByText('key')).toBeNull();
    expect(useRekeyState).toHaveBeenCalledWith(
      'SOURCE',
      NetworkId.ALGORAND_MAINNET
    );
  }
);

// TASK-458: while chain state loads, a refresh that saw `self` clears the
// neutral badge; a delegated or unknown refresh keeps it neutral (never a key).
it.each([
  ['self', false],
  ['delegated', true],
  [undefined, true],
] as const)(
  'loading with display status %s: neutral badge = %s',
  async (status, shown) => {
    const { recordRekeyObservation, clearRekeyDisplayStatus } =
      await import('@/store/rekeyDisplayStatus');
    clearRekeyDisplayStatus();
    if (status)
      recordRekeyObservation(
        'SOURCE',
        NetworkId.ALGORAND_MAINNET,
        status === 'self'
          ? { isRekeyed: false }
          : { isRekeyed: true, authAddress: 'AUTH' }
      );
    jest
      .mocked(useRekeyState)
      .mockReturnValue({ status: 'loading' } as ReturnType<
        typeof useRekeyState
      >);
    const view = await render(
      <AccountAvatar
        address="SOURCE"
        account={{ type: AccountType.STANDARD } as AccountMetadata}
        useEnvoiAvatar={false}
      />
    );
    expect(Boolean(view.queryByText('lock-closed'))).toBe(shown);
    expect(view.queryByText('key')).toBeNull();
  }
);
