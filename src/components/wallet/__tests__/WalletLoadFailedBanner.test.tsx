// TASK-514 (product ruling): when a wallet read failed while accounts are already
// on screen, a notice sits above the account view: "We couldn't refresh your
// accounts. Some accounts may not be showing." with Try again. It can be
// dismissed; it comes back only on the NEXT failed load; a successful load clears
// it; if Try again fails it stays. It replaces nothing and never offers Get Started.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import WalletLoadFailedBanner from '../WalletLoadFailedBanner';

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));

const TEXT =
  "We couldn't refresh your accounts. Some accounts may not be showing.";

const banner = (failed: boolean, failures: number, onTryAgain = jest.fn()) => (
  <WalletLoadFailedBanner
    walletLoadFailed={failed}
    failureCount={failures}
    onTryAgain={onTryAgain}
  />
);

it('shows nothing when the last wallet load did not fail', async () => {
  const view = await render(banner(false, 0));
  expect(view.queryByText(TEXT)).toBeNull();
  expect(view.queryByText('Try again')).toBeNull();
  // Earlier failures alone do not show it: the last load succeeded.
  await view.rerender(banner(false, 3));
  expect(view.queryByText(TEXT)).toBeNull();
});

it("shows product's text and Try again after a failed load; Try again calls the retry once", async () => {
  const onTryAgain = jest.fn();
  const view = await render(banner(true, 1, onTryAgain));
  expect(view.getByText(TEXT)).toBeTruthy();
  await fireEvent.press(view.getByText('Try again'));
  expect(onTryAgain).toHaveBeenCalledTimes(1);
});

it('never offers Get Started or the empty-wallet welcome', async () => {
  const view = await render(banner(true, 1));
  expect(view.queryByText('Get Started')).toBeNull();
  expect(view.queryByText('Welcome to Voi Wallet')).toBeNull();
});

it('can be dismissed, and stays dismissed for the same failure', async () => {
  const view = await render(banner(true, 1));
  await fireEvent.press(view.getByLabelText('Dismiss'));
  expect(view.queryByText(TEXT)).toBeNull();
  await view.rerender(banner(true, 1));
  expect(view.queryByText(TEXT)).toBeNull();
});

it('comes back on the next failed load after a dismissal, even if a success came between', async () => {
  const view = await render(banner(true, 1));
  await fireEvent.press(view.getByLabelText('Dismiss'));
  // A later load succeeds: cleared.
  await view.rerender(banner(false, 1));
  expect(view.queryByText(TEXT)).toBeNull();
  // The next load fails: a new failure, so it shows again.
  await view.rerender(banner(true, 2));
  expect(view.getByText(TEXT)).toBeTruthy();
});

it('if Try again fails (a new failure while shown) it stays', async () => {
  const view = await render(banner(true, 1));
  await fireEvent.press(view.getByText('Try again'));
  await view.rerender(banner(true, 2));
  expect(view.getByText(TEXT)).toBeTruthy();
});

it('a dismissed notice whose Try again was unreachable returns on a new failure while it was dismissed', async () => {
  const view = await render(banner(true, 1));
  await fireEvent.press(view.getByLabelText('Dismiss'));
  await view.rerender(banner(true, 2));
  expect(view.getByText(TEXT)).toBeTruthy();
});
