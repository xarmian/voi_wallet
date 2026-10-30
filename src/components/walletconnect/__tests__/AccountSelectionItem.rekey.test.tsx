// TASK-458: the WalletConnect account row labels from the last refresh's
// display-only rekey status; the stored type is the fallback only when that is
// unknown (Codex pass B #5: a known self hides a stale REKEYED type).
import React from 'react';
import { act, render } from '@testing-library/react-native';
import AccountSelectionItem from '../AccountSelectionItem';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import {
  beginRekeyObservation,
  clearRekeyDisplayStatus,
  recordRekeyObservation,
} from '@/store/rekeyDisplayStatus';

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () => 'voi-mainnet',
}));
jest.mock('@/services/walletconnect/utils', () => ({
  truncateAddress: (a: string) => a,
}));

const item = (type: AccountType) => (
  <AccountSelectionItem
    account={{ id: 'a', address: 'ADDR', type, label: 'A' } as AccountMetadata}
    isSelected={false}
    onToggleSelection={jest.fn()}
  />
);
const observe = (info: object) =>
  act(async () =>
    recordRekeyObservation(
      beginRekeyObservation(),
      'ADDR',
      NetworkId.VOI_MAINNET,
      info as never
    )
  );

beforeEach(() => clearRekeyDisplayStatus());

it.each([
  ['unknown keeps the stored type', AccountType.STANDARD, null, 'standard'],
  [
    'an external rekey reads rekeyed',
    AccountType.STANDARD,
    { isRekeyed: true, authAddress: 'X' },
    'rekeyed',
  ],
  ['unknown keeps a stored REKEYED', AccountType.REKEYED, null, 'rekeyed'],
  [
    'a known self hides a stale REKEYED',
    AccountType.REKEYED,
    { isRekeyed: false },
    null,
  ],
] as const)('%s', async (_name, type, info, label) => {
  const view = await render(item(type));
  if (info) await observe(info);
  if (label) expect(view.getByText(label)).toBeTruthy();
  else expect(view.queryByText('rekeyed')).toBeNull();
});
