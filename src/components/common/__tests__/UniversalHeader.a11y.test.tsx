/**
 * UniversalHeader accessibility tests (TASK-42).
 *
 * UniversalHeader is imported at ~41 sites, and its back button was an
 * icon-only `AnimatedPressable` with no accessible name — i.e. the primary
 * navigation control on nearly every screen was unlabeled.
 */

import React from 'react';
import { render } from '@testing-library/react-native';

import UniversalHeader from '../UniversalHeader';

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

jest.mock('@/components/account/AccountSelector', () => () => null);

describe('UniversalHeader accessibility', () => {
  it('labels the back button by default', () => {
    const { getByLabelText } = render(
      <UniversalHeader
        title="Send"
        showBackButton
        showAccountSelector={false}
        onBackPress={() => {}}
        backButtonTestID="back"
      />
    );

    const back = getByLabelText('Go back');
    expect(back.props.accessibilityRole).toBe('button');
  });

  it('lets a screen name the destination and add a hint', () => {
    const { getByTestId } = render(
      <UniversalHeader
        title="NFT Details"
        showBackButton
        showAccountSelector={false}
        onBackPress={() => {}}
        backAccessibilityLabel="Back to collection"
        backAccessibilityHint="Returns to the NFT collection list"
        backButtonTestID="back"
      />
    );

    const back = getByTestId('back');
    expect(back.props.accessibilityLabel).toBe('Back to collection');
    expect(back.props.accessibilityHint).toBe(
      'Returns to the NFT collection list'
    );
  });

  it('marks the title as a header landmark', () => {
    const { getByText } = render(
      <UniversalHeader title="Settings" showAccountSelector={false} />
    );

    expect(getByText('Settings').props.accessibilityRole).toBe('header');
  });

  it('forwards a testID to the header container', () => {
    const { getByTestId } = render(
      <UniversalHeader
        title="Settings"
        showAccountSelector={false}
        testID="screen-header"
      />
    );

    expect(getByTestId('screen-header')).toBeTruthy();
  });

  it('renders no back button when it is not requested', () => {
    const { queryByLabelText } = render(
      <UniversalHeader title="Home" showAccountSelector={false} />
    );

    expect(queryByLabelText('Go back')).toBeNull();
  });
});
