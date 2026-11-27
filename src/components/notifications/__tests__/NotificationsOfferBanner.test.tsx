// TASK-565: the Home offer to turn on notifications. The body opens the
// notification settings and a separate X dismisses it; both are buttons a
// screen reader reaches on their own.

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import NotificationsOfferBanner from '../NotificationsOfferBanner';

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const banner = (onPress = jest.fn(), onDismiss = jest.fn()) => (
  <NotificationsOfferBanner onPress={onPress} onDismiss={onDismiss} />
);

it('shows the title and the line', async () => {
  const view = await render(banner());
  expect(view.getByText('Turn on notifications')).toBeTruthy();
  expect(view.getByText('Get alerts for payments and messages.')).toBeTruthy();
});

it('opens from the labelled body button and does not dismiss', async () => {
  const onPress = jest.fn();
  const onDismiss = jest.fn();
  const view = await render(banner(onPress, onDismiss));

  await fireEvent.press(
    view.getByRole('button', { name: 'Turn on notifications' })
  );

  expect(onPress).toHaveBeenCalledTimes(1);
  expect(onDismiss).not.toHaveBeenCalled();
});

it('dismisses from the labelled X button and does not open', async () => {
  const onPress = jest.fn();
  const onDismiss = jest.fn();
  const view = await render(banner(onPress, onDismiss));

  await fireEvent.press(
    view.getByRole('button', { name: 'Dismiss notifications offer' })
  );

  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onPress).not.toHaveBeenCalled();
});

it('gives the X a hit area of at least 44pt', async () => {
  const view = await render(banner());
  const close = view.getByRole('button', {
    name: 'Dismiss notifications offer',
  });
  const style = Object.assign(
    {},
    ...[close.props.style].flat(Infinity).filter(Boolean)
  );
  expect(style.minWidth).toBeGreaterThanOrEqual(44);
  expect(style.minHeight).toBeGreaterThanOrEqual(44);
});
