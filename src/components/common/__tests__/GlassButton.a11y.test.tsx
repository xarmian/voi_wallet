/**
 * GlassButton accessibility + reduce-motion tests (TASK-42).
 *
 * GlassButton is imported at ~18 sites. Its `label` was already enough for RN
 * to infer a name, but `disabled`/`loading` were never surfaced as
 * `accessibilityState`, so a busy or unavailable button was announced as a
 * perfectly ordinary one. It is also DR-13's loudest offender: an infinite
 * `withRepeat` glow with hardcoded 1200ms durations that bypasses the shared
 * animation configs entirely.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import { GlassButton } from '../GlassButton';

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: () => null,
  }),
  { virtual: true }
);

jest.mock('@/utils/haptics', () => ({
  hapticImpact: jest.fn(),
}));

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

beforeEach(() => {
  mockUseReducedMotion.mockReturnValue(false);
  mockWithRepeat.mockClear();
});

describe('GlassButton accessibility', () => {
  it('exposes the visible label as the accessible name with a button role', () => {
    const { getByTestId } = render(
      <GlassButton label="Send" onPress={() => {}} testID="btn" />
    );

    const button = getByTestId('btn');
    expect(button.props.accessibilityLabel).toBe('Send');
    expect(button.props.accessibilityRole).toBe('button');
  });

  it('lets callers override the accessible name and add a hint', () => {
    const { getByTestId } = render(
      <GlassButton
        label="Max"
        accessibilityLabel="Send maximum spendable amount"
        accessibilityHint="Fills the amount field with your full balance"
        onPress={() => {}}
        testID="btn"
      />
    );

    const button = getByTestId('btn');
    expect(button.props.accessibilityLabel).toBe(
      'Send maximum spendable amount'
    );
    expect(button.props.accessibilityHint).toBe(
      'Fills the amount field with your full balance'
    );
  });

  it('surfaces `disabled` as accessibilityState', () => {
    const { getByTestId } = render(
      <GlassButton label="Send" disabled onPress={() => {}} testID="btn" />
    );

    expect(getByTestId('btn').props.accessibilityState).toEqual({
      disabled: true,
      busy: false,
    });
  });

  it('surfaces `loading` as both busy and disabled', () => {
    const { getByTestId } = render(
      <GlassButton label="Send" loading onPress={() => {}} testID="btn" />
    );

    expect(getByTestId('btn').props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
  });

  it('reports neither busy nor disabled in the resting state', () => {
    const { getByTestId } = render(
      <GlassButton label="Send" onPress={() => {}} testID="btn" />
    );

    expect(getByTestId('btn').props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
  });
});

describe('GlassButton reduce-motion (DR-13)', () => {
  it('starts the infinite glow pulse when motion is allowed', () => {
    render(<GlassButton label="Send" glow onPress={() => {}} testID="btn" />);

    expect(mockWithRepeat).toHaveBeenCalled();
    // -1 == repeat forever; that is precisely what Reduce Motion must suppress.
    expect(mockWithRepeat.mock.calls[0][1]).toBe(-1);
  });

  it('never starts the infinite glow pulse under Reduce Motion', () => {
    mockUseReducedMotion.mockReturnValue(true);

    render(<GlassButton label="Send" glow onPress={() => {}} testID="btn" />);

    expect(mockWithRepeat).not.toHaveBeenCalled();
  });

  it('does not start a pulse when `glow` is off, regardless of the preference', () => {
    render(<GlassButton label="Send" onPress={() => {}} testID="btn" />);

    expect(mockWithRepeat).not.toHaveBeenCalled();
  });
});
