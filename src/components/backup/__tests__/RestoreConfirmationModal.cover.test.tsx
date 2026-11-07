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
import RestoreConfirmationModal from '../RestoreConfirmationModal';
const confirm = jest.fn();
const cancel = jest.fn();
const info = {
  createdAt: '2026-01-01',
  appVersion: 'test',
  accountCount: 1,
  accountTypes: { standard: 1, watch: 0, rekeyed: 0, ledger: 0 },
  hasFriends: false,
  friendsCount: 0,
} as never;
const element = (visible = true) => (
  <RestoreConfirmationModal
    visible={visible}
    backupInfo={info}
    deviceHasAccounts={false}
    onConfirm={confirm}
    onCancel={cancel}
  />
);
beforeEach(() => {
  mockCovered = false;
});
it('DEFECT: hides the Modal while covered and respects visible', async () => {
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
it('DEFECT: restore is unreachable covered and works uncovered', async () => {
  const view = await render(element());
  mockCovered = true;
  await view.rerender(element());
  expect(view.queryByText('Restore')).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
  mockCovered = false;
  await view.rerender(element());
  await fireEvent.press(view.getByText('Restore'));
  expect(confirm).toHaveBeenCalledTimes(1);
});
