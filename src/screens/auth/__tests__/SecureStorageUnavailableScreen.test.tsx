// Regression tests for TASK-213 (Codex round-4 P2): the fail-closed recovery
// screen must offer an ESCAPE HATCH for a PERSISTENT failure. Retry alone leaves
// a permanently-desynced keystore / irrecoverably-corrupt blob stranded forever
// (Retry re-runs the identical, deterministically-failing reads). The screen adds
// a guarded "Reset & restore" that wipes ONLY local data (on-chain accounts are
// untouched, recoverable from the recovery phrase) then re-runs the auth check so
// the app lands in Onboarding.
//
// SECURITY NOTE: no real secret material — the wipe services are mocked sinks.

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';

import SecureStorageUnavailableScreen from '../SecureStorageUnavailableScreen';
import { AccountSecureStorage } from '@/services/secure';
import { MultiAccountWalletService } from '@/services/wallet';

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: { clearAll: jest.fn(async () => {}) },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { clearAllWallets: jest.fn(async () => {}) },
}));

// Keep the render host-component-light: theme + native leaves are opaque.
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: {
      colors: {
        error: '#f00',
        buttonText: '#fff',
        textMuted: '#999',
        primary: '#00f',
        text: '#000',
        textSecondary: '#333',
        background: '#fff',
      },
    },
  }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

const mockClearAll = AccountSecureStorage.clearAll as jest.Mock;
const mockClearAllWallets =
  MultiAccountWalletService.clearAllWallets as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

// Auto-confirm every Alert by invoking its destructive (or last) button, so the
// double confirmation chains straight through to performReset.
function autoConfirmAlerts() {
  return jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _msg, buttons) => {
      const btn =
        buttons?.find((b) => b.style === 'destructive') ??
        buttons?.[(buttons?.length ?? 1) - 1];
      btn?.onPress?.();
    });
}

describe('SecureStorageUnavailableScreen — reset escape hatch (TASK-213)', () => {
  it('exposes a Retry action wired to onRetry', async () => {
    const onRetry = jest.fn(async () => {});
    const { getByLabelText } = render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    await act(async () => {
      fireEvent.press(getByLabelText('Retry secure storage check'));
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    // Retry must NOT wipe anything.
    expect(mockClearAll).not.toHaveBeenCalled();
    expect(mockClearAllWallets).not.toHaveBeenCalled();
  });

  it('the guarded Reset wipes local data (clearAll + clearAllWallets) then re-runs the check', async () => {
    const alertSpy = autoConfirmAlerts();
    const onRetry = jest.fn(async () => {});
    const { getByLabelText, getByPlaceholderText } = render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    // Type-RESET friction (TASK-213): the wipe is gated until RESET is typed.
    fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');

    await act(async () => {
      fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });

    // Double confirmation was shown (two nested alerts).
    expect(alertSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Local data wiped, THEN the auth check re-run (→ Onboarding on absence).
    expect(mockClearAll).toHaveBeenCalledTimes(1);
    expect(mockClearAllWallets).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
  });

  it('still re-runs the check when clearAll throws (broken keystore) — best-effort wipe', async () => {
    const alertSpy = autoConfirmAlerts();
    mockClearAll.mockRejectedValueOnce(new Error('keystore delete failed'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onRetry = jest.fn(async () => {});
    const { getByLabelText, getByPlaceholderText } = render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');

    await act(async () => {
      fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });

    // A clearAll failure must NOT abort the reset: the wallet-metadata wipe (the
    // step that actually lets the next boot resolve "no wallet") still runs, and
    // the check is still re-run.
    expect(mockClearAllWallets).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('the wipe stays DISABLED until the exact word RESET is typed (TASK-213)', async () => {
    const alertSpy = autoConfirmAlerts();
    const onRetry = jest.fn(async () => {});
    const { getByLabelText, getByPlaceholderText } = render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    // Pressing with NOTHING typed does nothing — no confirm dialog, no wipe.
    await act(async () => {
      fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockClearAll).not.toHaveBeenCalled();

    // A near-miss (wrong case) still does NOT enable it.
    fireEvent.changeText(getByPlaceholderText('RESET'), 'reset');
    await act(async () => {
      fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockClearAll).not.toHaveBeenCalled();

    // Exact RESET enables it — now the confirm chain runs and the wipe fires.
    fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');
    await act(async () => {
      fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });
    expect(alertSpy).toHaveBeenCalled();
    expect(mockClearAll).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
  });

  it('the reset confirmation copy is accurate — no single-recovery-phrase over-promise (TASK-213)', async () => {
    const alertSpy = autoConfirmAlerts();
    const onRetry = jest.fn(async () => {});
    const { getByLabelText, getByPlaceholderText } = render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');
    await act(async () => {
      fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });

    const messages = alertSpy.mock.calls.map((c) => String(c[1]));
    const combined = messages.join('\n');
    // Erases ALL local data — not just "a wallet" restorable from one phrase.
    expect(combined).toMatch(/erases ALL local wallet data/i);
    // Names the account kinds a single seed does NOT restore.
    expect(combined).toMatch(/watch-only/i);
    expect(combined).toMatch(/ledger/i);
    expect(combined).toMatch(/remote-signer/i);
    // Each phrase restores only its own accounts; requires EVERY phrase.
    expect(combined).toMatch(/each from its own phrase/i);
    expect(combined).toMatch(/every recovery phrase/i);

    alertSpy.mockRestore();
  });

  it('FIX 3(a): shows a "reset didn\'t resolve it" message when the recheck stays on recovery', async () => {
    // onRetry that resolves WITHOUT clearing the recovery state (e.g. AsyncStorage
    // itself unwritable) leaves this screen mounted. Instead of silently looping,
    // the guidance renders.
    const alertSpy = autoConfirmAlerts();
    const onRetry = jest.fn(async () => {}); // does not resolve the failure
    const { getByLabelText, getByPlaceholderText, queryByText } = render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    // No message before a reset attempt.
    expect(queryByText(/resolve the problem/i)).toBeNull();

    fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');
    await act(async () => {
      fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(queryByText(/resolve the problem/i)).not.toBeNull();

    alertSpy.mockRestore();
  });
});
