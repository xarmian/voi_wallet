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
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ authState: { biometricEnabled: false } }),
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    getCredentialSource: jest.fn(async () => 'pin'),
    verifyPin: jest.fn(async () => true),
  },
}));
jest.mock('@/utils/haptics', () => ({ hapticNotify: jest.fn() }));

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(),
}));

import UnifiedAuthModal from '../UnifiedAuthModal';

describe('UnifiedAuthModal lock cover', () => {
  const onSuccess = jest.fn();
  const onCancel = jest.fn();
  const element = (visible = true) => (
    <UnifiedAuthModal
      visible={visible}
      purpose="export_keys"
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
        <UnifiedAuthModal visible onSuccess={onSuccess} onCancel={jest.fn()} />
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
        <UnifiedAuthModal
          visible
          biometricEnabled
          onSuccess={onSuccess}
          onCancel={jest.fn()}
        />
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
      if (cover) expect(view.queryByText('Confirm')).toBeNull();
      else await fireEvent.press(view.getByText('Confirm'));
      expect(onSuccess).toHaveBeenCalledTimes(cover ? 0 : 1);
    }
  );
});

it('DEFECT: a completed biometric proof is discarded by cover', async () => {
  mockCovered = false;
  jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
  jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(true);
  jest
    .mocked(LocalAuthentication.authenticateAsync)
    .mockResolvedValue({ success: true });
  const onSuccess = jest.fn();
  const tree = () => (
    <UnifiedAuthModal
      visible
      biometricEnabled
      onSuccess={onSuccess}
      onCancel={jest.fn()}
    />
  );
  const view = await render(tree());
  expect(view.getByText('Confirm')).toBeTruthy();
  mockCovered = true;
  await view.rerender(tree());
  mockCovered = false;
  await view.rerender(tree());
  expect(view.queryByText('Confirm')).toBeNull();
  expect(onSuccess).not.toHaveBeenCalled();
  // A new biometric prompt is required and can authorize confirmation.
  await fireEvent.press(view.getByText('Use Biometric'));
  await fireEvent.press(view.getByText('Confirm'));
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(2);
  expect(onSuccess).toHaveBeenCalledTimes(1);
});

import { setCovered, resetCoverForTests } from '@/utils/lockCover';

describe('cover start and synchronous result guards', () => {
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

  it('DEFECT: opening under reactive cover defers the auto-prompt until uncover', async () => {
    const onSuccess = jest.fn();
    const tree = (visible: boolean) => (
      <UnifiedAuthModal
        visible={visible}
        biometricEnabled
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
        <UnifiedAuthModal
          visible
          biometricEnabled
          onSuccess={onSuccess}
          onCancel={jest.fn()}
        />
      );
      expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
      jest.mocked(LocalAuthentication.authenticateAsync).mockClear();
      jest
        .mocked(LocalAuthentication.authenticateAsync)
        .mockResolvedValue({ success: true });
      const button = view.getByText('Use Biometric');
      if (cover) setCovered(true);
      await fireEvent.press(button);
      expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(
        cover ? 0 : 1
      );
      if (!cover) await fireEvent.press(view.getByText('Confirm'));
      expect(onSuccess).toHaveBeenCalledTimes(cover ? 0 : 1);
      expect(view.queryByText('Authenticating...')).toBeNull();
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
          <UnifiedAuthModal
            visible
            biometricEnabled={kind === 'biometric'}
            onSuccess={onSuccess}
            onCancel={jest.fn()}
          />
        );
        if (kind === 'PIN')
          for (const digit of ['1', '2', '3', '4', '5', '6'])
            await fireEvent.press(view.getByText(digit));
        if (cover) setCovered(true);
        await act(async () => finish());
        if (kind === 'biometric') {
          if (cover) expect(view.queryByText('Confirm')).toBeNull();
          else await fireEvent.press(view.getByText('Confirm'));
        }
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
          <UnifiedAuthModal
            visible
            biometricEnabled={kind === 'biometric'}
            onSuccess={onSuccess}
            onCancel={onCancel}
          />
        );
        const cancel = mockCancelPress!;
        if (kind === 'PIN') {
          for (const digit of ['1', '2', '3', '4', '5', '6'])
            await fireEvent.press(view.getByText(digit));
        } else {
          // Auto-prompt is pending.
        }
        expect(finish).toBeDefined();
        if (action !== 'none')
          await act(async () => {
            if (action === 'close') mockRequestClose?.();
            else cancel();
          });
        await act(async () => finish());
        if (kind === 'biometric') {
          const confirm = view.queryByText('Confirm');
          if (action === 'none')
            await fireEvent.press(view.getByText('Confirm'));
          else expect(confirm).toBeNull();
        }
        expect(onCancel).toHaveBeenCalledTimes(action === 'none' ? 0 : 1);
        expect(onSuccess).toHaveBeenCalledTimes(action === 'none' ? 1 : 0);
        await view.unmount();
      }
    }
  );
});

it.each([true, false])(
  'DEFECT: availability await cover=%s rechecks before OS prompt and retries after unlock',
  async (cover) => {
    mockCovered = false;
    resetCoverForTests();
    jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(true);
    let finish!: (value: boolean) => void;
    jest.mocked(LocalAuthentication.isEnrolledAsync).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    jest
      .mocked(LocalAuthentication.authenticateAsync)
      .mockResolvedValue({ success: false, error: 'user_cancel' });
    const tree = () => (
      <UnifiedAuthModal
        visible
        biometricEnabled
        onSuccess={jest.fn()}
        onCancel={jest.fn()}
      />
    );
    const view = await render(tree());
    if (cover) {
      setCovered(true);
    }
    await act(async () => finish(true));
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(
      cover ? 0 : 1
    );
    expect(view.queryByText('Authenticating...')).toBeNull();
    if (cover) {
      mockCovered = true;
      await view.rerender(tree());
      setCovered(false);
      mockCovered = false;
      let finishRetry!: (value: boolean) => void;
      jest.mocked(LocalAuthentication.isEnrolledAsync).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = resolve;
          })
      );
      await view.rerender(tree());
      expect(finishRetry).toBeDefined();
      await act(async () => finishRetry(true));
      expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    }
    expect(view.queryByText('Authenticating...')).toBeNull();
    resetCoverForTests();
  }
);
