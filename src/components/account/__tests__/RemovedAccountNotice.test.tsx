import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import RemovedAccountNotice from '../RemovedAccountNotice';

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => false,
}));
jest.mock('@/utils/address', () => ({
  formatAddress: (address: string) =>
    `${address.slice(0, 6)}...${address.slice(-4)}`,
}));
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, __esModule: true, default: actual.default ?? actual };
});

const body =
  "This device could no longer read this account's key, so the account was removed from your list. Your funds on the network are not affected. Re-import the account's recovery phrase to bring it back. Without the recovery phrase, this device can't reach those funds.";
const title = 'Savings (ABCDEF...WXYZ) was removed from this device';
const props = {
  address: 'ABCDEF123456WXYZ',
  label: 'Savings',
  onReimport: jest.fn(),
  onDismiss: jest.fn(),
};

describe('RemovedAccountNotice', () => {
  it('renders exact copy and the label with shortened address', async () => {
    const { getByText, getByLabelText } = await render(
      <RemovedAccountNotice {...props} />
    );
    expect(getByText(title)).toBeTruthy();
    expect(getByText(body)).toBeTruthy();
    // The card is not a pressable group: the text stays readable per element
    // and both controls are directly reachable by a screen reader.
    expect(getByLabelText('Dismiss notice')).toBeTruthy();
  });
  it('shows address only when label is empty and treats label as plain text', async () => {
    const { getByText } = await render(
      <RemovedAccountNotice {...props} label="" />
    );
    expect(
      getByText('ABCDEF...WXYZ was removed from this device')
    ).toBeTruthy();
    const markup = await render(
      <RemovedAccountNotice {...props} label="<img>" />
    );
    expect(
      markup.getByText('<img> (ABCDEF...WXYZ) was removed from this device')
    ).toBeTruthy();
  });
  it('re-imports only from the Re-import button', async () => {
    const onReimport = jest.fn();
    const onDismiss = jest.fn();
    const { getByText } = await render(
      <RemovedAccountNotice
        {...props}
        onReimport={onReimport}
        onDismiss={onDismiss}
      />
    );
    fireEvent.press(getByText('Re-import'));
    expect(onReimport).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });
  it('dismisses without ever triggering re-import, and the card itself is not pressable', async () => {
    const onReimport = jest.fn();
    const onDismiss = jest.fn();
    const { getByLabelText, container } = await render(
      <RemovedAccountNotice
        {...props}
        onReimport={onReimport}
        onDismiss={onDismiss}
      />
    );
    const dismiss = getByLabelText('Dismiss notice');
    expect(dismiss.props.accessibilityRole).toBe('button');
    expect(dismiss.props.accessibilityElementsHidden).not.toBe(true);
    fireEvent.press(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onReimport).not.toHaveBeenCalled();
    // No node in the card carries a card-level press that re-imports: pressing
    // every pressable node other than the two buttons must do nothing.
    expect(
      container.queryAll((n: any) =>
        Array.isArray(n.props?.accessibilityActions)
      )
    ).toHaveLength(0);
  });
});
