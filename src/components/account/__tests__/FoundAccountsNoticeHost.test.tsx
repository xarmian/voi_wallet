// TASK-478: the Home notice for keys found on this device, and the summary the
// Settings row reads on focus. Real storage, wallet service and reconcile over
// the in-memory platform; neither surface reads a key.
import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@/platform', () =>
  require('@/services/secure/__tests__/fixtures/task478Platform').createTask478Platform()
);
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
    multiSet: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
  },
}));
jest.mock('@/store/walletStore', () => ({
  removePersistedBalanceCaches: jest.fn(async () => {}),
}));
jest.mock('@react-navigation/native', () =>
  require('@/__tests__/fixtures/navigationFocus').createNavigationFocusMock()
);
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => false,
}));
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, __esModule: true, default: actual.default ?? actual };
});

import FoundAccountsNoticeHost from '../FoundAccountsNoticeHost';
import { useFoundAccountsSummary } from '@/hooks/useFoundAccountsSummary';
import { refocus } from '@/__tests__/fixtures/navigationFocus';
import * as found from '@/services/secure/foundAccounts';
import type { FoundSummary } from '@/services/secure/foundAccounts';
import { AccountType } from '@/types/wallet';
import { formatAddress } from '@/utils/address';
import {
  SEEN_KEY,
  boot,
  mockPlatform,
  pinDeviceWithTwoOrphans,
  resetAll,
  spyDecryptors,
  unlock,
  writeUnboundKey,
} from '@/services/secure/__tests__/fixtures/task478Helpers';

function SettingsProbe() {
  const { summary, error } = useFoundAccountsSummary();
  return (
    <Text>{error ? 'error' : `found ${summary?.presentCount ?? '-'}`}</Text>
  );
}

beforeEach(() => {
  resetAll();
  jest.restoreAllMocks();
});

describe('FoundAccountsNoticeHost', () => {
  it('shows once', async () => {
    await pinDeviceWithTwoOrphans();
    const reads = spyDecryptors();
    const onReview = jest.fn();
    const view = await render(<FoundAccountsNoticeHost onReview={onReview} />);
    await view.findByText('2 accounts found on this device');

    await act(async () => {
      fireEvent.press(view.getByText('Not now'));
    });
    await waitFor(() =>
      expect(view.queryByText('2 accounts found on this device')).toBeNull()
    );
    await act(async () => {
      refocus();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.queryByText(/found on this device/)).toBeNull();

    // A key found later is announced again.
    await writeUnboundKey('orphan-later');
    await boot();
    unlock();
    await act(async () => {
      refocus();
    });
    await view.findByText('3 accounts found on this device');
    fireEvent.press(view.getByText('Review'));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(reads.total()).toBe(0);
  });

  it('Home and Settings focus read no key', async () => {
    await pinDeviceWithTwoOrphans();
    const reads = spyDecryptors();
    const view = await render(
      <>
        <FoundAccountsNoticeHost onReview={jest.fn()} />
        <SettingsProbe />
      </>
    );
    await view.findByText('found 2');
    await view.findByText('2 accounts found on this device');
    for (let i = 0; i < 3; i++)
      await act(async () => {
        refocus();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    await view.findByText('found 2');
    expect(reads.total()).toBe(0);
  });
});

describe('FoundAccountsNoticeHost counts what can be acted on', () => {
  const READY = 'AAAAREADYADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const WALLET = 'BBBBWALLETADDRESSBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const inWallet = {
    kind: 'in-wallet' as const,
    id: 'w1',
    address: WALLET,
    walletLabel: 'Main',
    walletType: AccountType.STANDARD,
    walletKeyUsable: true,
  };
  const given = (summary: Partial<FoundSummary>) =>
    jest.spyOn(found, 'readFoundAccountsSummary').mockResolvedValue({
      hasPin: true,
      presentCount: 0,
      rows: [],
      unreadableIds: [],
      unscannedIds: [],
      ...summary,
    });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

  it('one ready address with two copies, plus an in-wallet copy, is one account', async () => {
    given({
      presentCount: 3,
      rows: [
        { kind: 'ready', id: 'r1', ids: ['r1', 'r2'], address: READY },
        inWallet,
      ],
    });
    const view = await render(<FoundAccountsNoticeHost onReview={jest.fn()} />);
    await view.findByText('1 account found on this device');
    expect(view.getByText(formatAddress(READY))).toBeTruthy();
    await act(async () => {
      fireEvent.press(view.getByText('Not now'));
    });
    // Only the ids the notice announced are recorded, never an in-wallet copy.
    await waitFor(() =>
      expect(
        JSON.parse(mockPlatform.__kv.get(SEEN_KEY) ?? '[]').sort()
      ).toEqual(['r1', 'r2'])
    );
  });

  it('an in-wallet copy left unseen is announced once it becomes a ready row', async () => {
    given({
      presentCount: 3,
      rows: [
        { kind: 'ready', id: 'r1', ids: ['r1', 'r2'], address: READY },
        inWallet,
      ],
    });
    const view = await render(<FoundAccountsNoticeHost onReview={jest.fn()} />);
    await view.findByText('1 account found on this device');
    await act(async () => {
      fireEvent.press(view.getByText('Not now'));
    });
    await waitFor(() =>
      expect(view.queryByText('1 account found on this device')).toBeNull()
    );
    // The wallet account at WALLET is deleted: w1 is now the only copy there.
    given({
      presentCount: 3,
      rows: [
        { kind: 'ready', id: 'r1', ids: ['r1', 'r2'], address: READY },
        { kind: 'ready', id: 'w1', ids: ['w1'], address: WALLET },
      ],
    });
    await act(async () => {
      refocus();
    });
    await view.findByText('2 accounts found on this device');
  });

  it('only in-wallet copies show no notice', async () => {
    given({ presentCount: 2, rows: [inWallet, { ...inWallet, id: 'w2' }] });
    const view = await render(<FoundAccountsNoticeHost onReview={jest.fn()} />);
    await settle();
    expect(view.queryByText(/^\d+ accounts? found on this device$/)).toBeNull();
  });

  it('counts unscanned rows and unreadable ids, and names no address for two', async () => {
    given({
      presentCount: 3,
      rows: [{ kind: 'unscanned', id: 'u1', hintAddress: READY }, inWallet],
      unscannedIds: ['u1'],
      unreadableIds: ['x1'],
    });
    const view = await render(<FoundAccountsNoticeHost onReview={jest.fn()} />);
    await view.findByText('2 accounts found on this device');
    expect(view.queryByText(formatAddress(READY))).toBeNull();
  });

  it('a single unscanned row with a hint names its address', async () => {
    given({
      presentCount: 2,
      rows: [{ kind: 'unscanned', id: 'u1', hintAddress: READY }, inWallet],
      unscannedIds: ['u1'],
    });
    const view = await render(<FoundAccountsNoticeHost onReview={jest.fn()} />);
    await view.findByText('1 account found on this device');
    expect(view.getByText(formatAddress(READY))).toBeTruthy();
  });
});
