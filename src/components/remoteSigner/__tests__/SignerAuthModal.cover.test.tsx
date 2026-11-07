import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

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
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(),
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    getCredentialSource: jest.fn(async () => 'pin'),
    isBiometricEnabled: jest.fn(async () => false),
    verifyPin: jest.fn(async () => true),
  },
}));
jest.mock('@/utils/haptics', () => ({ hapticNotify: jest.fn() }));

import SignerAuthModal from '../SignerAuthModal';

describe('SignerAuthModal lock cover', () => {
  const onSuccess = jest.fn();
  const onCancel = jest.fn();
  const element = (visible = true) => (
    <SignerAuthModal
      visible={visible}
      onSuccess={onSuccess}
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

  it('DEFECT: typed PIN is cleared across a cover without cancelling the flow', async () => {
    const view = await render(element());
    await fireEvent.press(view.getByText('1'));
    mockCovered = true;
    await view.rerender(element());
    expect(mockModalVisible).toBe(false);
    expect(view.queryByText('Cancel')).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    mockCovered = false;
    await view.rerender(element());
    for (const digit of ['2', '3', '4', '5', '6']) {
      await fireEvent.press(view.getByText(digit));
    }
    expect(onSuccess).not.toHaveBeenCalled();
    await fireEvent.press(view.getByText('7'));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith('234567');
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// Each pending operation has an uncovered control with the identical result.
import { AccountSecureStorage } from '@/services/secure';
import * as LocalAuthentication from 'expo-local-authentication';

describe('pending authentication', () => {
  beforeEach(() => {
    mockCovered = false;
    jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(false);
    jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(false);
  });

  it.each([true, false])(
    'DEFECT: pending PIN result after cover=%s',
    async (cover) => {
      let finish!: (valid: boolean) => void;
      jest.mocked(AccountSecureStorage.verifyPin).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const onSuccess = jest.fn();
      const tree = () => (
        <SignerAuthModal visible onSuccess={onSuccess} onCancel={jest.fn()} />
      );
      const view = await render(tree());
      for (const digit of ['1', '2', '3', '4', '5', '6'])
        await fireEvent.press(view.getByText(digit));
      expect(AccountSecureStorage.verifyPin).toHaveBeenCalledTimes(1);
      if (cover) {
        mockCovered = true;
        await view.rerender(tree());
      }
      await act(async () => finish(true));
      expect(onSuccess).toHaveBeenCalledTimes(cover ? 0 : 1);
      if (!cover) expect(onSuccess).toHaveBeenCalledWith('123456');
      else {
        mockCovered = false;
        await view.rerender(tree());
        for (const digit of ['2', '3', '4', '5', '6', '7'])
          await fireEvent.press(view.getByText(digit));
        expect(onSuccess).toHaveBeenCalledWith('234567');
      }
    }
  );

  it.each([true, false])(
    'DEFECT: pending biometric result after cover=%s',
    async (cover) => {
      jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
      jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(true);
      jest
        .mocked(AccountSecureStorage.isBiometricEnabled)
        .mockResolvedValueOnce(true);
      let finish!: (
        result: LocalAuthentication.LocalAuthenticationResult
      ) => void;
      jest.mocked(LocalAuthentication.authenticateAsync).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const onSuccess = jest.fn();
      const tree = () => (
        <SignerAuthModal visible onSuccess={onSuccess} onCancel={jest.fn()} />
      );
      const view = await render(tree());
      expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
      if (cover) {
        mockCovered = true;
        await view.rerender(tree());
      }
      await act(async () => finish({ success: true }));
      mockCovered = false;
      await view.rerender(tree());

      expect(onSuccess).toHaveBeenCalledTimes(cover ? 0 : 1);
    }
  );
});
