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
jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) =>
    require('react').createElement(require('react-native').Text, null, name),
}));
jest.mock(
  '@/components/common/KeyboardAwareScrollView',
  () => require('react-native').ScrollView
);
jest.mock('@/services/backup', () => ({
  validatePasswordStrength: () => ({ isValid: true, feedback: [], score: 4 }),
  getPasswordStrengthLabel: () => '',
  getPasswordStrengthColor: () => 'green',
}));

import PasswordInputModal from '../PasswordInputModal';

describe('PasswordInputModal lock cover', () => {
  const onSuccess = jest.fn();
  const onCancel = jest.fn();
  const element = (visible = true) => (
    <PasswordInputModal
      visible={visible}
      mode="enter"
      onConfirm={onSuccess}
      onCancel={onCancel}
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

  it('DEFECT: typed password is cleared and reveal is hidden across a cover', async () => {
    const view = await render(element());
    await fireEvent.changeText(
      view.getByPlaceholderText('Password'),
      'test-password'
    );
    await fireEvent.press(view.getByText('eye'));
    expect(view.getByPlaceholderText('Password').props.secureTextEntry).toBe(
      false
    );
    mockCovered = true;
    await view.rerender(element());
    expect(mockModalVisible).toBe(false);
    expect(view.queryByText('Cancel')).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    mockCovered = false;
    await view.rerender(element());
    expect(view.getByPlaceholderText('Password').props.value).toBe('');
    expect(view.getByPlaceholderText('Password').props.secureTextEntry).toBe(
      true
    );
    await fireEvent.changeText(
      view.getByPlaceholderText('Password'),
      'new-password'
    );
    await fireEvent.press(view.getByText('Decrypt'));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('new-password');
    expect(onCancel).not.toHaveBeenCalled();
  });
});

it('DEFECT: clears both create-password fields and both reveal controls across cover', async () => {
  const element = () => (
    <PasswordInputModal
      visible
      mode="create"
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
    />
  );
  const view = await render(element());
  await fireEvent.changeText(
    view.getByPlaceholderText('Password'),
    'first-password'
  );
  await fireEvent.changeText(
    view.getByPlaceholderText('Confirm password'),
    'first-password'
  );
  for (const eye of view.getAllByText('eye')) await fireEvent.press(eye);
  for (const field of ['Password', 'Confirm password'])
    expect(view.getByPlaceholderText(field).props.secureTextEntry).toBe(false);
  mockCovered = true;
  await view.rerender(element());
  mockCovered = false;
  await view.rerender(element());
  for (const field of ['Password', 'Confirm password']) {
    expect(view.getByPlaceholderText(field).props.value).toBe('');
    expect(view.getByPlaceholderText(field).props.secureTextEntry).toBe(true);
  }
});

it('DEFECT: cover resets validation history', async () => {
  mockCovered = false;
  const tree = () => (
    <PasswordInputModal
      visible
      mode="enter"
      onConfirm={jest.fn()}
      onCancel={jest.fn()}
    />
  );
  const view = await render(tree());
  await fireEvent.changeText(view.getByPlaceholderText('Password'), 'x');
  await fireEvent.changeText(view.getByPlaceholderText('Password'), '');
  expect(view.getByText('Please enter your backup password')).toBeTruthy();
  mockCovered = true;
  await view.rerender(tree());
  mockCovered = false;
  await view.rerender(tree());
  expect(view.queryByText('Please enter your backup password')).toBeNull();
});
