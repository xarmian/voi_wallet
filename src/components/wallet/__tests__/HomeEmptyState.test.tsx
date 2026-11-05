import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import HomeEmptyState from '../HomeEmptyState';

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));

const errorText = "We couldn't load your accounts. Nothing was changed.";

it('welcomes an empty wallet and opens onboarding', async () => {
  const onGetStarted = jest.fn();
  const onTryAgain = jest.fn();
  const view = await render(
    <HomeEmptyState
      walletLoadFailed={false}
      onGetStarted={onGetStarted}
      onTryAgain={onTryAgain}
    />
  );
  expect(view.getByText('Welcome to Voi Wallet')).toBeTruthy();
  expect(view.queryByText(errorText)).toBeNull();
  expect(view.queryByText('Try again')).toBeNull();
  await fireEvent.press(view.getByText('Get Started'));
  expect(onGetStarted).toHaveBeenCalledTimes(1);
  expect(onTryAgain).not.toHaveBeenCalled();
});

it('offers only retry when loading failed', async () => {
  const onGetStarted = jest.fn();
  const onTryAgain = jest.fn();
  const view = await render(
    <HomeEmptyState
      walletLoadFailed
      onGetStarted={onGetStarted}
      onTryAgain={onTryAgain}
    />
  );
  expect(view.getByText(errorText)).toBeTruthy();
  expect(view.queryByText('Welcome to Voi Wallet')).toBeNull();
  expect(view.queryByText('Get Started')).toBeNull();
  expect(view.queryByText(/Set up an account/)).toBeNull();
  await fireEvent.press(view.getByText('Try again'));
  expect(onTryAgain).toHaveBeenCalledTimes(1);
  expect(onGetStarted).not.toHaveBeenCalled();
});
