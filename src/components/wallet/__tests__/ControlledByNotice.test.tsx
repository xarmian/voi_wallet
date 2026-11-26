import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { NetworkId } from '@/types/network';
import ControlledByNotice from '../ControlledByNotice';
import { useControlledByNotice } from '@/store/useControlledByNotice';
import { copyToClipboard } from '@/utils/clipboard';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));
jest.mock('@/store/useControlledByNotice', () => ({
  useControlledByNotice: jest.fn(),
}));
jest.mock('@/utils/clipboard', () => ({ copyToClipboard: jest.fn() }));
jest.mock('@/utils/address', () => ({
  formatAddress: (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`,
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
const notices = jest.mocked(useControlledByNotice);
const address = 'AUTHADDRESS';
beforeEach(() => {
  jest.clearAllMocks();
  notices.mockReturnValue([
    { address, networks: [NetworkId.VOI_MAINNET], showNetworks: false },
  ]);
});
it('links to the auth backup with address only and copies its full address', async () => {
  const screen = await render(<ControlledByNotice />);
  await fireEvent.press(
    screen.getByRole('button', {
      name: "This account is controlled by AUTHAD...RESS, and that key hasn't been backed up yet.",
    })
  );
  expect(mockNavigate).toHaveBeenCalledWith('VerifyBackup', {
    accountAddress: address,
  });
  await fireEvent.press(
    screen.getByRole('button', { name: `Copy controlling address ${address}` })
  );
  expect(copyToClipboard).toHaveBeenCalledWith(
    address,
    'Address copied to clipboard'
  );
});
it('renders one line per auth with network names only on disagreement', async () => {
  notices.mockReturnValue([
    { address, networks: [NetworkId.VOI_MAINNET], showNetworks: true },
    {
      address: 'OTHERADDRESS',
      networks: [NetworkId.ALGORAND_MAINNET],
      showNetworks: true,
    },
  ]);
  const screen = await render(<ControlledByNotice />);
  expect(screen.getAllByText(/This account is controlled by/)).toHaveLength(2);
  expect(screen.getByText(/\(Voi Network\)/)).toBeTruthy();
  expect(screen.getByText(/\(Algorand\)/)).toBeTruthy();
});
it('has no notice without positive evidence', async () => {
  notices.mockReturnValue([]);
  const screen = await render(<ControlledByNotice />);
  expect(screen.queryByText(/controlled by/)).toBeNull();
});
