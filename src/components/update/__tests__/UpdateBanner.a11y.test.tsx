/**
 * UpdateBanner accessibility + reduce-motion tests (TASK-42).
 *
 * The banner is the one place in the app where a secondary control (dismiss)
 * is nested inside a pressable GlassCard. Because a pressable card is a single
 * accessibility group, that nested button is unreachable to a screen reader —
 * so the dismiss path must be exposed as a custom accessibility action on the
 * group instead. These tests pin that contract.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import UpdateBanner from '../UpdateBanner';

jest.mock('@/contexts/ThemeContext', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: () => null,
  }),
  { virtual: true }
);

const mockUseReducedMotion = jest.fn(() => false);
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

const mockWithRepeat = jest.fn();
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return {
    ...actual,
    __esModule: true,
    default: actual.default ?? actual,
    withRepeat: (...args: unknown[]) => {
      mockWithRepeat(...args);
      return 0;
    },
  };
});

const findCard = (root: { findAll: (p: (n: any) => boolean) => any[] }) =>
  root.findAll(
    (node: any) => Array.isArray(node.props?.accessibilityActions) === true
  )[0];

beforeEach(() => {
  mockUseReducedMotion.mockReturnValue(false);
  mockWithRepeat.mockClear();
});

describe('UpdateBanner accessibility', () => {
  it('exposes dismiss as a custom action on the grouped card', () => {
    const onDismiss = jest.fn();
    const { UNSAFE_root } = render(
      <UpdateBanner onInstall={jest.fn()} onDismiss={onDismiss} />
    );

    const card = findCard(UNSAFE_root);
    expect(card.props.accessibilityActions).toEqual([
      { name: 'dismiss', label: 'Dismiss update' },
    ]);

    card.props.onAccessibilityAction({
      nativeEvent: { actionName: 'dismiss' },
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores unrelated accessibility actions', () => {
    const onDismiss = jest.fn();
    const { UNSAFE_root } = render(
      <UpdateBanner onInstall={jest.fn()} onDismiss={onDismiss} />
    );

    findCard(UNSAFE_root).props.onAccessibilityAction({
      nativeEvent: { actionName: 'activate' },
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('drops the dismiss action while the update is busy', () => {
    const { UNSAFE_root } = render(
      <UpdateBanner onInstall={jest.fn()} onDismiss={jest.fn()} isInstalling />
    );

    expect(findCard(UNSAFE_root)).toBeUndefined();
  });
});

describe('UpdateBanner reduce-motion (DR-13)', () => {
  it('pulses the icon when motion is allowed', () => {
    render(<UpdateBanner onInstall={jest.fn()} onDismiss={jest.fn()} />);
    expect(mockWithRepeat).toHaveBeenCalled();
  });

  it('never starts the infinite pulse under Reduce Motion', () => {
    mockUseReducedMotion.mockReturnValue(true);
    render(<UpdateBanner onInstall={jest.fn()} onDismiss={jest.fn()} />);
    expect(mockWithRepeat).not.toHaveBeenCalled();
  });
});
