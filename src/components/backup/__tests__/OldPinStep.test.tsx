// TASK-504 (DOC-507 3.3, 3.4, 3.5): the old-PIN step's copy and countdown.
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import OldPinStep from '../OldPinStep';
import {
  OLD_PIN_NORMAL_TEXT,
  formatTimeLeft,
  oldPinLockedText,
} from '@/services/backup/oldPinCopy';

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));

describe('old-PIN copy (product 67483d49, verbatim)', () => {
  it('pins both lines', () => {
    expect(OLD_PIN_NORMAL_TEXT).toBe(
      'This phone still has a PIN from before. Enter it to restore your backup.'
    );
    expect(oldPinLockedText(5 * 60 * 1000)).toBe(
      'Too many wrong tries, so PIN entry is paused. Try again in 5 min. Nothing on this phone has changed.'
    );
  });

  it.each([
    [30 * 1000, '1 min'],
    [5 * 60 * 1000, '5 min'],
    [60 * 60 * 1000, '1 hr'],
    [2 * 60 * 60 * 1000 + 5 * 60 * 1000, '2 hr 5 min'],
    [24 * 60 * 60 * 1000, '24 hr'],
  ])('formats %d ms as %s', (ms, text) => {
    expect(formatTimeLeft(ms)).toBe(text);
  });
});

describe('OldPinStep countdown', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a lockout that expires while the screen is open returns to the normal state without a relaunch, and the field accepts input', async () => {
    let clock = 1_000_000;
    let stored: number | null = clock + 3000;
    const unlock = jest.fn(async () => ({ status: 'invalid' as const }));
    const view = await render(
      <OldPinStep
        unlock={unlock}
        readLockedUntil={async () => stored}
        onVerified={jest.fn()}
        now={() => clock}
      />
    );
    await act(async () => {});
    expect(view.getByText(/Too many wrong tries/)).toBeTruthy();
    expect(view.queryByLabelText('Old PIN')).toBeNull();

    // The stored throttle ends; the screen reads it again at the end time.
    stored = null;
    clock += 3500;
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    expect(view.getByText(OLD_PIN_NORMAL_TEXT)).toBeTruthy();
    const field = view.getByLabelText('Old PIN');
    await fireEvent.changeText(field, '000000');
    await fireEvent.press(view.getByText('Continue'));
    // A wrong PIN still goes to verification (and so still counts).
    expect(unlock).toHaveBeenCalledWith('000000');
  });

  it('while locked nothing is verified: pressing is impossible and unlock is never called', async () => {
    const unlock = jest.fn();
    const view = await render(
      <OldPinStep
        unlock={unlock}
        readLockedUntil={async () => Date.now() + 60_000}
        onVerified={jest.fn()}
      />
    );
    await act(async () => {});
    expect(view.queryByText('Continue')).toBeNull();
    expect(unlock).not.toHaveBeenCalled();
  });
});
