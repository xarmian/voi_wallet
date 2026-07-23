/**
 * GlassCard accessibility tests (TASK-42).
 *
 * GlassCard is imported at ~30 sites and silently becomes an `AnimatedPressable`
 * whenever `onPress`/`onLongPress` is supplied — previously with no
 * `accessibilityRole` and no way to pass a name, so every tappable card in the
 * app was an unlabeled accessibility leaf. The static variant must stay
 * transparent to the a11y tree so its inner text remains individually
 * navigable.
 */

import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';

import { GlassCard } from '../GlassCard';

jest.mock('@/contexts/ThemeContext', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

const child = <Text>Balance</Text>;

describe('GlassCard accessibility', () => {
  it('gives a pressable card a button role and groups its children', () => {
    const { getByTestId } = render(
      <GlassCard
        onPress={() => {}}
        testID="card"
        accessibilityLabel="Voi asset"
      >
        {child}
      </GlassCard>
    );

    const card = getByTestId('card');
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessible).toBe(true);
    expect(card.props.accessibilityLabel).toBe('Voi asset');
  });

  it('treats a long-press-only card as pressable too', () => {
    const { getByTestId } = render(
      <GlassCard
        onLongPress={() => {}}
        testID="card"
        accessibilityLabel="Asset"
      >
        {child}
      </GlassCard>
    );

    expect(getByTestId('card').props.accessibilityRole).toBe('button');
  });

  it('forwards an overridden role, hint and state', () => {
    const { getByTestId } = render(
      <GlassCard
        onPress={() => {}}
        testID="card"
        accessibilityRole="checkbox"
        accessibilityLabel="Include this account"
        accessibilityHint="Toggles the account in the export"
        accessibilityState={{ checked: true }}
      >
        {child}
      </GlassCard>
    );

    const card = getByTestId('card');
    expect(card.props.accessibilityRole).toBe('checkbox');
    expect(card.props.accessibilityHint).toBe(
      'Toggles the account in the export'
    );
    expect(card.props.accessibilityState).toEqual({ checked: true });
  });

  it('lets a caller opt out of grouping on a pressable card', () => {
    const { getByTestId } = render(
      <GlassCard onPress={() => {}} testID="card" accessible={false}>
        {child}
      </GlassCard>
    );

    expect(getByTestId('card').props.accessible).toBe(false);
  });

  it('leaves a static card transparent to the a11y tree by default', () => {
    const { getByTestId } = render(
      <GlassCard testID="card" animated={false}>
        {child}
      </GlassCard>
    );

    const card = getByTestId('card');
    expect(card.props.accessibilityRole).toBeUndefined();
    expect(card.props.accessible).toBeUndefined();
  });

  it('still lets a static card opt into a label when it is a meaningful group', () => {
    const { getByTestId } = render(
      <GlassCard
        testID="card"
        animated={false}
        accessible
        accessibilityLabel="Total balance 12 VOI"
      >
        {child}
      </GlassCard>
    );

    const card = getByTestId('card');
    expect(card.props.accessible).toBe(true);
    expect(card.props.accessibilityLabel).toBe('Total balance 12 VOI');
  });
});
