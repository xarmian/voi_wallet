/**
 * TASK-485: a biometric result that resolves after the modal was reset (an
 * aborted prompt, then a new one) is stale. It must not mark the NEW prompt as
 * biometrically authenticated, or one tap would confirm it with no biometric.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';

type Pending = { resolve: (r: { success: boolean }) => void };
const mockPending: Pending[] = [];

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(
    () =>
      new Promise<{ success: boolean }>((resolve) => {
        mockPending.push({ resolve });
      })
  ),
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => new Proxy({}, { get: () => ({}) }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ authState: { biometricEnabled: true } }),
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    getCredentialSource: jest.fn(async () => 'pin'),
    verifyPin: jest.fn(async () => false),
  },
}));
jest.mock('@/utils/haptics', () => ({ hapticNotify: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import UnifiedAuthModal from '../UnifiedAuthModal';

const element = (visible: boolean) => (
  <UnifiedAuthModal
    visible={visible}
    onSuccess={jest.fn()}
    onCancel={jest.fn()}
    purpose="export_keys"
  />
);

describe('UnifiedAuthModal biometric result vs a reset modal', () => {
  beforeEach(() => {
    mockPending.length = 0;
  });

  it('shows the confirm state when the current prompt passes biometrics (control)', async () => {
    const view = await render(element(true));
    await act(async () => {});
    expect(mockPending).toHaveLength(1);
    await act(async () => mockPending[0].resolve({ success: true }));
    expect(view.getByText('Authentication Successful')).toBeTruthy();
  });

  it('ignores a stale success from a prompt that was closed before a new one opened', async () => {
    const view = await render(element(true));
    await act(async () => {});
    expect(mockPending).toHaveLength(1);

    // The first prompt is aborted (closed) while its biometric is pending, and
    // a second prompt opens and starts its own biometric.
    await view.rerender(element(false));
    await view.rerender(element(true));
    await act(async () => {});
    expect(mockPending).toHaveLength(2);

    // The first prompt's biometric now resolves with success.
    await act(async () => mockPending[0].resolve({ success: true }));
    expect(view.queryByText('Authentication Successful')).toBeNull();

    // The second prompt's own success still works.
    await act(async () => mockPending[1].resolve({ success: true }));
    expect(view.getByText('Authentication Successful')).toBeTruthy();
  });
});
