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
