import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

let mockCancelPress: (() => void) | undefined;
let mockModalVisible: boolean;
let mockRequestClose: (() => void) | undefined;
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  const descriptors = Object.getOwnPropertyDescriptors(native);
  descriptors.TouchableOpacity = {
    configurable: true,
    enumerable: true,
    value: (props: React.ComponentProps<typeof native.TouchableOpacity>) => {
      if (
        require('react').isValidElement(props.children) &&
        props.children.props.children === 'Cancel'
      )
        mockCancelPress = props.onPress;
      return require('react').createElement(native.TouchableOpacity, props);
    },
  };
  descriptors.Modal = {
    configurable: true,
    enumerable: true,
    value: (props: React.ComponentProps<typeof native.Modal>) => {
      mockModalVisible = props.visible;
      mockRequestClose = props.onRequestClose;
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
    require('react').createElement(require('react-native').Text, {
      testID: name,
    }),
}));
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
    jest
      .mocked(AccountSecureStorage.isBiometricEnabled)
      .mockResolvedValue(false);
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

import { setCovered, resetCoverForTests } from '@/utils/lockCover';

describe('cover start and synchronous result guards', () => {
  beforeEach(() => {
    mockCovered = false;
    resetCoverForTests();
    jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
    jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(true);
    jest
      .mocked(AccountSecureStorage.isBiometricEnabled)
      .mockResolvedValue(true);

    jest
      .mocked(LocalAuthentication.authenticateAsync)
      .mockResolvedValue({ success: false, error: 'user_cancel' });
  });
  afterEach(() => resetCoverForTests());

  it('DEFECT: opening under reactive cover defers the auto-prompt until uncover', async () => {
    const onSuccess = jest.fn();
    const tree = (visible: boolean) => (
      <SignerAuthModal
        visible={visible}
        onSuccess={onSuccess}
        onCancel={jest.fn()}
      />
    );
    const view = await render(tree(false));
    mockCovered = true;
    await view.rerender(tree(true));
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    mockCovered = false;
    await view.rerender(tree(true));
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'DEFECT: direct biometric start with synchronous cover=%s',
    async (cover) => {
      const onSuccess = jest.fn();
      const view = await render(
        <SignerAuthModal visible onSuccess={onSuccess} onCancel={jest.fn()} />
      );
      expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
      jest.mocked(LocalAuthentication.authenticateAsync).mockClear();
      jest
        .mocked(LocalAuthentication.authenticateAsync)
        .mockResolvedValue({ success: true });
      const button = view.getByTestId('finger-print');
      if (cover) setCovered(true);
      await fireEvent.press(button);
      expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(
        cover ? 0 : 1
      );

      expect(onSuccess).toHaveBeenCalledTimes(cover ? 0 : 1);
    }
  );

  it.each(['PIN', 'biometric'] as const)(
    'DEFECT: %s result observes cover before its epoch effect',
    async (kind) => {
      for (const cover of [true, false]) {
        resetCoverForTests();
        let finish!: () => void;
        if (kind === 'PIN') {
          jest
            .mocked(LocalAuthentication.hasHardwareAsync)
            .mockResolvedValue(false);
          jest.mocked(AccountSecureStorage.verifyPin).mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finish = () => resolve(true);
              })
          );
        } else {
          jest
            .mocked(LocalAuthentication.authenticateAsync)
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  finish = () => resolve({ success: true });
                })
            );
        }
        const onSuccess = jest.fn();
        const view = await render(
          <SignerAuthModal visible onSuccess={onSuccess} onCancel={jest.fn()} />
        );
        if (kind === 'PIN')
          for (const digit of ['1', '2', '3', '4', '5', '6'])
            await fireEvent.press(view.getByText(digit));
        if (cover) setCovered(true);
        await act(async () => finish());

        expect(onSuccess).toHaveBeenCalledTimes(cover ? 0 : 1);
        await view.unmount();
      }
    }
  );
});

describe('cancel invalidates pending authentication (U3d-9)', () => {
  beforeEach(() => {
    mockCovered = false;
    resetCoverForTests();
    jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
    jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(true);
    jest
      .mocked(LocalAuthentication.authenticateAsync)
      .mockResolvedValue({ success: false, error: 'user_cancel' });
  });
  afterEach(() => resetCoverForTests());
  it.each(['PIN', 'biometric'] as const)(
    'DEFECT: %s cancellation/close discards late success; uncancelled twin succeeds',
    async (kind) => {
      for (const action of ['cancel', 'close', 'none']) {
        let finish!: () => void;
        const onSuccess = jest.fn();
        const onCancel = jest.fn();
        jest
          .mocked(AccountSecureStorage.isBiometricEnabled)
          .mockResolvedValue(kind === 'biometric');
        if (kind === 'PIN')
          jest.mocked(AccountSecureStorage.verifyPin).mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finish = () => resolve(true);
              })
          );
        else
          jest
            .mocked(LocalAuthentication.authenticateAsync)
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  finish = () => resolve({ success: true });
                })
            );
        // Capture Cancel before verify disables it: this also covers an already queued tap.
        const view = await render(
          <SignerAuthModal visible onSuccess={onSuccess} onCancel={onCancel} />
        );
        const cancel = mockCancelPress!;
        if (kind === 'PIN') {
          for (const digit of ['1', '2', '3', '4', '5', '6'])
            await fireEvent.press(view.getByText(digit));
        } else {
          // Signer auto-prompt is already pending.
        }
        expect(finish).toBeDefined();
        if (action !== 'none')
          await act(async () => {
            if (action === 'close') mockRequestClose?.();
            else cancel();
          });
        await act(async () => finish());

        expect(onCancel).toHaveBeenCalledTimes(action === 'none' ? 0 : 1);
        expect(onSuccess).toHaveBeenCalledTimes(action === 'none' ? 1 : 0);
        await view.unmount();
      }
    }
  );
});

it('DEFECT: PIN lockout survives cover/uncover without a biometric prompt', async () => {
  mockCovered = false;
  resetCoverForTests();
  jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
  jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(true);
  jest.mocked(AccountSecureStorage.isBiometricEnabled).mockResolvedValue(true);
  jest
    .mocked(LocalAuthentication.authenticateAsync)
    .mockResolvedValue({ success: false, error: 'user_cancel' });
  jest.mocked(AccountSecureStorage.verifyPin).mockResolvedValue(false);
  const tree = () => (
    <SignerAuthModal visible onSuccess={jest.fn()} onCancel={jest.fn()} />
  );
  const view = await render(tree());
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const digit of ['1', '2', '3', '4', '5', '6'])
      await fireEvent.press(view.getByText(digit));
  }
  mockCovered = true;
  await view.rerender(tree());
  mockCovered = false;
  await view.rerender(tree());
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  jest.mocked(AccountSecureStorage.verifyPin).mockResolvedValue(true);
  await view.unmount();
  resetCoverForTests();
});

it('DEFECT: lockout expiry never auto-prompts; explicit biometric press after expiry works', async () => {
  jest.useFakeTimers();
  try {
    mockCovered = false;
    resetCoverForTests();
    jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
    jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(true);
    jest
      .mocked(AccountSecureStorage.isBiometricEnabled)
      .mockResolvedValue(true);
    jest
      .mocked(LocalAuthentication.authenticateAsync)
      .mockResolvedValue({ success: false, error: 'user_cancel' });
    jest.mocked(AccountSecureStorage.verifyPin).mockResolvedValue(false);
    const onSuccess = jest.fn();
    const view = await render(
      <SignerAuthModal visible onSuccess={onSuccess} onCancel={jest.fn()} />
    );
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    for (let attempt = 0; attempt < 5; attempt += 1)
      for (const digit of ['1', '2', '3', '4', '5', '6'])
        await fireEvent.press(view.getByText(digit));
    expect(view.getByText(/Too many attempts/)).toBeTruthy();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30000);
    });
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    jest
      .mocked(LocalAuthentication.authenticateAsync)
      .mockResolvedValue({ success: true });
    await fireEvent.press(view.getByTestId('finger-print'));
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    await view.unmount();
  } finally {
    jest.useRealTimers();
    jest.mocked(AccountSecureStorage.verifyPin).mockResolvedValue(true);
    resetCoverForTests();
  }
});
