import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

let mockModalVisible: boolean;
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  const descriptors = Object.getOwnPropertyDescriptors(native);
  descriptors.Modal = {
    configurable: true,
    enumerable: true,
    value: (props: React.ComponentProps<typeof native.Modal>) => {
      mockModalVisible = props.visible;
      return require('react').createElement(native.Modal, props);
    },
  };
  return Object.defineProperties({}, descriptors);
});

let mockCovered = false;
jest.mock('@/hooks/useCoverPaused', () => ({
  useCoverPaused: () => mockCovered,
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import SigningPrompt from '../SigningPrompt';

describe('SigningPrompt lock cover', () => {
  const onSuccess = jest.fn();
  const onCancel = jest.fn();
  const element = (visible = true) => (
    <SigningPrompt
      visible={visible}
      onRetry={onSuccess}
      onCancel={onCancel}
      showRetryButton
    />
  );

  beforeEach(() => {
    mockCovered = false;
  });

  it('DEFECT: hides the native Modal while covered and respects the visible prop', async () => {
    const view = await render(element());
    expect(mockModalVisible).toBe(true);
    mockCovered = true;
    await view.rerender(element());
    expect(mockModalVisible).toBe(false);
    mockCovered = false;
    await view.rerender(element());
    expect(mockModalVisible).toBe(true);
    await view.rerender(element(false));
    expect(mockModalVisible).toBe(false);
  });

  it('DEFECT: covering and uncovering preserves the open flow without callbacks or reset', async () => {
    const view = await render(element());
    mockCovered = true;
    await view.rerender(element());
    expect(mockModalVisible).toBe(false);
    expect(view.queryByText('Cancel')).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    mockCovered = false;
    await view.rerender(element());
    await fireEvent.press(view.getByText('Try Again'));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
