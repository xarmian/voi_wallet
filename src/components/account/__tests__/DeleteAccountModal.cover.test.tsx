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
import DeleteAccountModal from '../DeleteAccountModal';
const confirm = jest.fn();
const cancel = jest.fn();
const element = () => (
  <DeleteAccountModal
    accountName="Fixture"
    onConfirm={confirm}
    onCancel={cancel}
  />
);
beforeEach(() => {
  mockCovered = false;
});
it('DEFECT: hides the Modal while covered and shows it on uncover', async () => {
  const view = await render(element());
  expect(mockModalVisible).toBe(true);
  mockCovered = true;
  await view.rerender(element());
  expect(mockModalVisible).toBe(false);
  mockCovered = false;
  await view.rerender(element());
  expect(mockModalVisible).toBe(true);
});
it('DEFECT: confirmation is unreachable while covered and works uncovered', async () => {
  const view = await render(element());
  await fireEvent.changeText(
    view.getByLabelText('Type DELETE to confirm account deletion'),
    'DELETE'
  );
  mockCovered = true;
  await view.rerender(element());
  expect(view.queryByRole('button', { name: 'Delete account' })).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
  mockCovered = false;
  await view.rerender(element());
  await fireEvent.changeText(
    view.getByLabelText('Type DELETE to confirm account deletion'),
    'DELETE'
  );
  await fireEvent.press(view.getByRole('button', { name: 'Delete account' }));
  expect(confirm).toHaveBeenCalledTimes(1);
});
it('DEFECT: typed deletion confirmation is cleared across cover', async () => {
  const view = await render(element());
  await fireEvent.changeText(
    view.getByLabelText('Type DELETE to confirm account deletion'),
    'DELETE'
  );
  expect(
    view.getByLabelText('Type DELETE to confirm account deletion').props.value
  ).toBe('DELETE');
  mockCovered = true;
  await view.rerender(element());
  mockCovered = false;
  await view.rerender(element());
  expect(
    view.getByLabelText('Type DELETE to confirm account deletion').props.value
  ).toBe('');
  await fireEvent.press(view.getByRole('button', { name: 'Delete account' }));
  expect(confirm).not.toHaveBeenCalled();
  await fireEvent.changeText(
    view.getByLabelText('Type DELETE to confirm account deletion'),
    'DELETE'
  );
  await fireEvent.press(view.getByRole('button', { name: 'Delete account' }));
  expect(confirm).toHaveBeenCalledTimes(1);
});
