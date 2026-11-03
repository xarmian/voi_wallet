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
    expect(getByLabelText(`${title}. ${body}`)).toBeTruthy();
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
  it('calls reimport and supports visible and accessibility dismiss controls', async () => {
    const onReimport = jest.fn();
    const onDismiss = jest.fn();
    const { getByText, container } = await render(
      <RemovedAccountNotice
        {...props}
        onReimport={onReimport}
        onDismiss={onDismiss}
      />
    );
    fireEvent.press(getByText('Re-import'));
    expect(onReimport).toHaveBeenCalledTimes(1);
    fireEvent.press(
      container.queryAll(
        (n: any) => n.props?.testID === 'removed-account-dismiss'
      )[0]
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
    const card = container.queryAll((n: any) =>
      Array.isArray(n.props?.accessibilityActions)
    )[0];
    card.props.onAccessibilityAction({
      nativeEvent: { actionName: 'dismiss' },
    });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
