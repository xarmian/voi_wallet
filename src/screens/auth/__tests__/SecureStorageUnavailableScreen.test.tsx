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

import SecureStorageUnavailableScreen, {
  RECOVERY_WIPE_DEADLINE_MS,
} from '../SecureStorageUnavailableScreen';
import { AccountSecureStorage } from '@/services/secure';
import { MultiAccountWalletService } from '@/services/wallet';
import { wipeAllLocalData } from '@/services/wipe';
import {
  WIPE_COMPLETE_NOTICE,
  WIPE_INCOMPLETE_NOTICE,
} from '@/services/wipe/notices';

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: { clearAll: jest.fn(async () => {}) },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { clearAllWallets: jest.fn(async () => {}) },
}));

// TASK-469: the screen resets through wipeAllLocalData(); here it is the plain
// composition of the two mocked calls, so the assertions below stay about what
// the wipe does and in what order. Like the real one, a call made while a wipe
// runs joins it, and isWipeInFlight is true until that wipe settles.
let mockInFlight: Promise<void> | null = null;
jest.mock('@/services/wipe', () => ({
  wipeAllLocalData: jest.fn(() => {
    if (mockInFlight) return mockInFlight;
    const { AccountSecureStorage: secure } = require('@/services/secure');
    const { MultiAccountWalletService: wallet } = require('@/services/wallet');
    const run = (async () => {
      await secure.clearAll();
      await wallet.clearAllWallets();
    })().finally(() => {
      mockInFlight = null;
    });
    mockInFlight = run;
    return run;
  }),
  isWipeInFlight: () => mockInFlight !== null,
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
  // A wipe left hung by an earlier test belongs to that test only.
  mockInFlight = null;
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
    const { getByLabelText } = await render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    await act(async () => {
      await fireEvent.press(getByLabelText('Retry secure storage check'));
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    // Retry must NOT wipe anything.
    expect(mockClearAll).not.toHaveBeenCalled();
    expect(mockClearAllWallets).not.toHaveBeenCalled();
  });

  it('the guarded Reset wipes local data (clearAll + clearAllWallets) then re-runs the check', async () => {
    const alertSpy = autoConfirmAlerts();
    const onRetry = jest.fn(async () => {});
    const { getByLabelText, getByPlaceholderText } = await render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    // Type-RESET friction (TASK-213): the wipe is gated until RESET is typed.
    await fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');

    await act(async () => {
      await fireEvent.press(
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

  it('failed clearAll shows actionable error, preserves metadata, and permits a successful retry', async () => {
    const alertSpy = autoConfirmAlerts();
    mockClearAll.mockRejectedValueOnce(new Error('disk I/O failure'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onRetry = jest.fn(async () => {});
    const { getByLabelText, getByPlaceholderText, getByText } = await render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );
    await fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');
    await act(async () => {
      await fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
    });
    expect(mockClearAllWallets).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(
      getByText(
        "Couldn't erase all wallet data from secure storage. Restart your device and try again. If your device is low on storage, free some up first."
      )
    ).toBeTruthy();
    await act(async () => {
      await fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
    });
    expect(mockClearAll).toHaveBeenCalledTimes(2);
    expect(mockClearAllWallets).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('the wipe stays DISABLED until the exact word RESET is typed (TASK-213)', async () => {
    const alertSpy = autoConfirmAlerts();
    const onRetry = jest.fn(async () => {});
    const { getByLabelText, getByPlaceholderText } = await render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    // Pressing with NOTHING typed does nothing — no confirm dialog, no wipe.
    await act(async () => {
      await fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockClearAll).not.toHaveBeenCalled();

    // A near-miss (wrong case) still does NOT enable it.
    await fireEvent.changeText(getByPlaceholderText('RESET'), 'reset');
    await act(async () => {
      await fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockClearAll).not.toHaveBeenCalled();

    // Exact RESET enables it — now the confirm chain runs and the wipe fires.
    await fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');
    await act(async () => {
      await fireEvent.press(
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
    const { getByLabelText, getByPlaceholderText } = await render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    await fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');
    await act(async () => {
      await fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });

    const messages = alertSpy.mock.calls.map((c) => String(c[1]));
    const combined = messages.join('\n');
    // TASK-469: the first dialog opens with the exact statement of what is
    // deleted and what is kept, then the recovery-phrase guidance on its own.
    expect(messages[0]).toBe(
      'This deletes all accounts, keys, contacts, messages and connections from this device. App settings like theme and network are kept.\n\n' +
        'Only accounts backed by a recovery phrase you personally hold can be restored — each from its own phrase. Watch-only, Ledger, and remote-signer accounts must be re-added manually. This cannot be undone.'
    );
    // Names the account kinds a single seed does NOT restore.
    expect(combined).toMatch(/watch-only/i);
    expect(combined).toMatch(/ledger/i);
    expect(combined).toMatch(/remote-signer/i);
    // Each phrase restores only its own accounts; requires EVERY phrase.
    expect(combined).toMatch(/each from its own phrase/i);
    expect(combined).toMatch(/every recovery phrase/i);

    alertSpy.mockRestore();
  });

  it('an incomplete wipe shows the same "didn\'t finish" notice as the lock screen, and the user stays here', async () => {
    const alertSpy = autoConfirmAlerts();
    mockClearAll.mockRejectedValueOnce(new Error('disk I/O failure'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onRetry = jest.fn(async () => {});
    const { getByLabelText, getByPlaceholderText } = await render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );
    await fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');
    await act(async () => {
      await fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
    });
    const titles = alertSpy.mock.calls.map((c) => c[0]);
    expect(titles).toContain(WIPE_INCOMPLETE_NOTICE.title);
    expect(titles).not.toContain(WIPE_COMPLETE_NOTICE.title);
    expect(onRetry).not.toHaveBeenCalled();
    expect(
      getByLabelText('Reset app and restore from recovery phrase')
    ).toBeTruthy();
    errorSpy.mockRestore();
    alertSpy.mockRestore();
  });

  it('FIX 3(a): shows a "reset didn\'t resolve it" message when the recheck stays on recovery', async () => {
    // onRetry that resolves WITHOUT clearing the recovery state (e.g. AsyncStorage
    // itself unwritable) leaves this screen mounted. Instead of silently looping,
    // the guidance renders.
    const alertSpy = autoConfirmAlerts();
    const onRetry = jest.fn(async () => {}); // does not resolve the failure
    const { getByLabelText, getByPlaceholderText, queryByText } = await render(
      <SecureStorageUnavailableScreen onRetry={onRetry} />
    );

    // No message before a reset attempt.
    expect(queryByText(/resolve the problem/i)).toBeNull();

    await fireEvent.changeText(getByPlaceholderText('RESET'), 'RESET');
    await act(async () => {
      await fireEvent.press(
        getByLabelText('Reset app and restore from recovery phrase')
      );
      await Promise.resolve();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(queryByText(/resolve the problem/i)).not.toBeNull();

    alertSpy.mockRestore();
  });

  describe('a wipe that outlasts the step bound (TASK-469)', () => {
    // The wipe's own steps are bounded at 5 s or 15 s each, and on this
    // screen the keychain is failing, so they can run out: the wipe can take
    // longer than the screen's 8 s step bound and still finish. A step that
    // never settles keeps it running for good, so the screen also has a hard
    // deadline.
    const settleAfter = (ms: number, outcome: 'resolve' | 'reject') =>
      new Promise<void>((resolve, reject) =>
        setTimeout(
          () =>
            outcome === 'resolve'
              ? resolve()
              : reject(new Error('disk I/O failure')),
          ms
        )
      );
    const advance = async (ms: number) => {
      await act(async () => {
        jest.advanceTimersByTime(ms);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
    };
    const RESET_LABEL = 'Reset app and restore from recovery phrase';
    const ERROR_TEXT = /Restart your device and try again/;
    const startReset = async () => {
      const alertSpy = autoConfirmAlerts();
      const onRetry = jest.fn(async () => {});
      const screen = await render(
        <SecureStorageUnavailableScreen onRetry={onRetry} />
      );
      await fireEvent.changeText(screen.getByPlaceholderText('RESET'), 'RESET');
      const pressReset = async () => {
        await act(async () => {
          await fireEvent.press(screen.getByLabelText(RESET_LABEL));
          await Promise.resolve();
        });
      };
      await pressReset();
      const titles = () => alertSpy.mock.calls.map((c) => c[0]);
      const count = (title: string) =>
        titles().filter((t) => t === title).length;
      const resetDisabled = () =>
        screen.getByLabelText(RESET_LABEL).props.accessibilityState?.disabled;
      return {
        alertSpy,
        onRetry,
        screen,
        titles,
        count,
        pressReset,
        resetDisabled,
      };
    };
    // A wipe the test settles by hand; it stays in flight until then.
    const holdClearAll = () => {
      const held: {
        resolve: () => void;
        reject: (error: Error) => void;
      } = { resolve: () => {}, reject: () => {} };
      mockClearAll.mockReturnValueOnce(
        new Promise<void>((resolve, reject) => {
          held.resolve = resolve;
          held.reject = reject;
        })
      );
      return held;
    };

    let errorSpy: jest.SpyInstance;
    beforeEach(() => {
      jest.useFakeTimers();
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      errorSpy.mockRestore();
      jest.useRealTimers();
    });

    it('the recovery deadline is 120 s', () => {
      expect(RECOVERY_WIPE_DEADLINE_MS).toBe(120000);
    });

    it('a wipe that finishes after 8 s shows the complete notice, not the incomplete one', async () => {
      mockClearAll.mockReturnValueOnce(settleAfter(12000, 'resolve'));
      const { alertSpy, onRetry, screen, titles, count } = await startReset();

      await advance(8000);
      expect(titles()).not.toContain(WIPE_INCOMPLETE_NOTICE.title);
      expect(titles()).not.toContain(WIPE_COMPLETE_NOTICE.title);
      expect(screen.queryByText(ERROR_TEXT)).toBeNull();

      await advance(4000);
      await advance(RECOVERY_WIPE_DEADLINE_MS);
      expect(count(WIPE_COMPLETE_NOTICE.title)).toBe(1);
      expect(titles()).not.toContain(WIPE_INCOMPLETE_NOTICE.title);
      expect(onRetry).toHaveBeenCalledTimes(1);
      alertSpy.mockRestore();
    });

    it('a wipe that fails after 8 s shows the incomplete notice only when it fails', async () => {
      mockClearAll.mockReturnValueOnce(settleAfter(12000, 'reject'));
      const { alertSpy, onRetry, titles, count } = await startReset();

      await advance(8000);
      expect(titles()).not.toContain(WIPE_INCOMPLETE_NOTICE.title);

      await advance(4000);
      await advance(RECOVERY_WIPE_DEADLINE_MS);
      expect(count(WIPE_INCOMPLETE_NOTICE.title)).toBe(1);
      expect(titles()).not.toContain(WIPE_COMPLETE_NOTICE.title);
      expect(onRetry).not.toHaveBeenCalled();
      alertSpy.mockRestore();
    });

    it('a hung wipe shows the incomplete notice at the deadline, not at 8 s, and frees the buttons', async () => {
      mockClearAll.mockReturnValueOnce(new Promise<void>(() => {}));
      const { alertSpy, onRetry, screen, titles, count, resetDisabled } =
        await startReset();

      await advance(8000);
      expect(titles()).not.toContain(WIPE_INCOMPLETE_NOTICE.title);
      expect(screen.queryByText('Resetting…')).not.toBeNull();
      expect(resetDisabled()).toBe(true);

      await advance(RECOVERY_WIPE_DEADLINE_MS - 8000 - 1);
      expect(titles()).not.toContain(WIPE_INCOMPLETE_NOTICE.title);

      await advance(1);
      expect(count(WIPE_INCOMPLETE_NOTICE.title)).toBe(1);
      expect(titles()).not.toContain(WIPE_COMPLETE_NOTICE.title);
      expect(screen.queryByText(ERROR_TEXT)).not.toBeNull();
      expect(screen.queryByText('Resetting…')).toBeNull();
      expect(resetDisabled()).toBe(false);
      expect(mockClearAllWallets).not.toHaveBeenCalled();
      expect(onRetry).not.toHaveBeenCalled();

      // Retry is usable too.
      await act(async () => {
        await fireEvent.press(
          screen.getByLabelText('Retry secure storage check')
        );
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
      alertSpy.mockRestore();
    });

    it('a wipe that finishes after the deadline shows incomplete at the deadline, then complete when it finishes', async () => {
      const held = holdClearAll();
      const { alertSpy, onRetry, count } = await startReset();

      await advance(RECOVERY_WIPE_DEADLINE_MS);
      expect(count(WIPE_INCOMPLETE_NOTICE.title)).toBe(1);
      expect(count(WIPE_COMPLETE_NOTICE.title)).toBe(0);
      expect(onRetry).not.toHaveBeenCalled();

      held.resolve();
      await advance(0);
      expect(count(WIPE_COMPLETE_NOTICE.title)).toBe(1);
      expect(count(WIPE_INCOMPLETE_NOTICE.title)).toBe(1);
      expect(mockClearAllWallets).toHaveBeenCalledTimes(1);
      // The recheck the success path runs.
      expect(onRetry).toHaveBeenCalledTimes(1);
      alertSpy.mockRestore();
    });

    it('a wipe that fails after the deadline shows nothing new', async () => {
      const held = holdClearAll();
      const { alertSpy, onRetry, titles, count, screen } = await startReset();

      await advance(RECOVERY_WIPE_DEADLINE_MS);
      expect(count(WIPE_INCOMPLETE_NOTICE.title)).toBe(1);
      const shown = titles().length;

      held.reject(new Error('disk I/O failure'));
      await advance(0);
      expect(titles()).toHaveLength(shown);
      expect(count(WIPE_COMPLETE_NOTICE.title)).toBe(0);
      expect(onRetry).not.toHaveBeenCalled();
      expect(screen.queryByText(ERROR_TEXT)).not.toBeNull();
      alertSpy.mockRestore();
    });

    it('a wipe that finishes after the screen unmounted shows nothing', async () => {
      const held = holdClearAll();
      const { alertSpy, onRetry, count, screen } = await startReset();

      await advance(RECOVERY_WIPE_DEADLINE_MS);
      expect(count(WIPE_INCOMPLETE_NOTICE.title)).toBe(1);
      await screen.unmount();

      held.resolve();
      await advance(0);
      expect(count(WIPE_COMPLETE_NOTICE.title)).toBe(0);
      expect(onRetry).not.toHaveBeenCalled();
      alertSpy.mockRestore();
    });

    it('a second press during a hung wipe joins it, and its outcome is shown once', async () => {
      const held = holdClearAll();
      const { alertSpy, onRetry, count, pressReset } = await startReset();

      await advance(RECOVERY_WIPE_DEADLINE_MS);
      expect(count(WIPE_INCOMPLETE_NOTICE.title)).toBe(1);

      await pressReset();
      expect(wipeAllLocalData).toHaveBeenCalledTimes(2);
      // Joined, not a second wipe.
      expect(mockClearAll).toHaveBeenCalledTimes(1);

      held.resolve();
      await advance(0);
      expect(count(WIPE_COMPLETE_NOTICE.title)).toBe(1);
      expect(count(WIPE_INCOMPLETE_NOTICE.title)).toBe(1);
      expect(mockClearAllWallets).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
      alertSpy.mockRestore();
    });
  });
});
