// TASK-504 (DOC-507 3.3, 3.4, 3.5): the old-PIN step's copy and countdown.
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import OldPinStep from '../OldPinStep';
import {
  BIOMETRIC_CANCELLED_TEXT,
  BIOMETRIC_INVALID_TEXT,
  BIOMETRIC_NO_ITEM_TEXT,
  BIOMETRIC_UNLOCK_LABEL,
  OLD_PIN_NORMAL_TEXT,
  OLD_PIN_WRONG_TEXT,
  formatTimeLeft,
  oldPinLockedText,
} from '@/services/backup/oldPinCopy';
import type { BiometricRestoreUnlockResult } from '@/contexts/AuthContext';

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

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
        onForgotten={jest.fn()}
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
        onForgotten={jest.fn()}
      />
    );
    await act(async () => {});
    expect(view.queryByText('Continue')).toBeNull();
    expect(unlock).not.toHaveBeenCalled();
  });
});

describe('OldPinStep: "I don\'t remember it"', () => {
  it('is reachable while PIN entry is paused, and leads only to the callback', async () => {
    const onForgotten = jest.fn();
    const unlock = jest.fn();
    const view = await render(
      <OldPinStep
        unlock={unlock}
        readLockedUntil={async () => Date.now() + 60_000}
        onVerified={jest.fn()}
        onForgotten={onForgotten}
      />
    );
    await act(async () => {});
    expect(view.getByText(/Too many wrong tries/)).toBeTruthy();
    await fireEvent.press(view.getByText("I don't remember it"));
    expect(onForgotten).toHaveBeenCalledTimes(1);
    expect(unlock).not.toHaveBeenCalled();
  });

  it('is there in the normal state too', async () => {
    const view = await render(
      <OldPinStep
        unlock={jest.fn()}
        readLockedUntil={async () => null}
        onVerified={jest.fn()}
        onForgotten={jest.fn()}
      />
    );
    await act(async () => {});
    expect(view.getByText("I don't remember it")).toBeTruthy();
  });
});

describe('biometric copy (pinned)', () => {
  it('pins every line and the button label', () => {
    expect(BIOMETRIC_UNLOCK_LABEL).toBe('Use Biometric');
    expect(BIOMETRIC_NO_ITEM_TEXT).toBe(
      'No biometric unlock is saved on this phone. Enter your old PIN.'
    );
    expect(BIOMETRIC_CANCELLED_TEXT).toBe(
      "Biometric unlock didn't finish. Enter your old PIN or try again."
    );
    expect(BIOMETRIC_INVALID_TEXT).toBe(
      "The saved biometric unlock doesn't match. Enter your old PIN."
    );
  });
});

describe('OldPinStep: biometric unlock (TASK-509)', () => {
  type Result = BiometricRestoreUnlockResult;

  async function renderStep(
    opts: {
      canOfferBiometric?: () => Promise<boolean>;
      unlockWithBiometric?: () => Promise<Result>;
      lockedUntil?: number | null;
      onVerified?: jest.Mock;
      onForgotten?: jest.Mock;
      unlock?: jest.Mock;
    } = {}
  ) {
    const props = {
      unlock:
        opts.unlock ?? jest.fn(async () => ({ status: 'invalid' as const })),
      onVerified: opts.onVerified ?? jest.fn(),
      onForgotten: opts.onForgotten ?? jest.fn(),
    };
    const readLockedUntil = jest.fn(async () => opts.lockedUntil ?? null);
    const view = await render(
      <OldPinStep
        unlock={props.unlock}
        readLockedUntil={readLockedUntil}
        onVerified={props.onVerified}
        onForgotten={props.onForgotten}
        canOfferBiometric={opts.canOfferBiometric}
        unlockWithBiometric={opts.unlockWithBiometric}
      />
    );
    await act(async () => {});
    return { view, readLockedUntil, ...props };
  }

  it('no button without the props', async () => {
    const { view } = await renderStep();
    expect(view.queryByText(BIOMETRIC_UNLOCK_LABEL)).toBeNull();
  });

  it('no button when the device cannot offer it', async () => {
    const unlockWithBiometric = jest.fn();
    const { view } = await renderStep({
      canOfferBiometric: async () => false,
      unlockWithBiometric,
    });
    expect(view.queryByText(BIOMETRIC_UNLOCK_LABEL)).toBeNull();
    expect(unlockWithBiometric).not.toHaveBeenCalled();
  });

  it('no button when the availability check throws', async () => {
    const { view } = await renderStep({
      canOfferBiometric: async () => {
        throw new Error('unreadable');
      },
      unlockWithBiometric: jest.fn(),
    });
    expect(view.queryByText(BIOMETRIC_UNLOCK_LABEL)).toBeNull();
  });

  it('shows the button when offered, and reads nothing until it is tapped', async () => {
    const canOfferBiometric = jest.fn(async () => true);
    const unlockWithBiometric = jest.fn();
    const { view } = await renderStep({
      canOfferBiometric,
      unlockWithBiometric,
    });
    expect(view.getByText(BIOMETRIC_UNLOCK_LABEL)).toBeTruthy();
    expect(canOfferBiometric).toHaveBeenCalledTimes(1);
    expect(unlockWithBiometric).not.toHaveBeenCalled();
  });

  it('while PIN entry is paused: no button and no PIN input, the countdown shows', async () => {
    const unlockWithBiometric = jest.fn();
    const { view } = await renderStep({
      canOfferBiometric: async () => true,
      unlockWithBiometric,
      lockedUntil: Date.now() + 60_000,
    });
    expect(view.getByText(/Too many wrong tries/)).toBeTruthy();
    expect(view.queryByLabelText('Old PIN')).toBeNull();
    expect(view.queryByText(BIOMETRIC_UNLOCK_LABEL)).toBeNull();
    expect(unlockWithBiometric).not.toHaveBeenCalled();
  });

  it('a verified biometric unlock reports the vault epoch, like a correct PIN', async () => {
    const onVerified = jest.fn();
    const unlockWithBiometric = jest.fn(async (): Promise<Result> => ({
      status: 'verified',
      epoch: 42,
    }));
    const { view } = await renderStep({
      canOfferBiometric: async () => true,
      unlockWithBiometric,
      onVerified,
    });
    await act(async () => {
      fireEvent.press(view.getByText(BIOMETRIC_UNLOCK_LABEL));
    });
    expect(unlockWithBiometric).toHaveBeenCalledTimes(1);
    expect(onVerified).toHaveBeenCalledWith(42);
  });

  it.each([
    ['no_item', BIOMETRIC_NO_ITEM_TEXT],
    ['biometric_cancelled', BIOMETRIC_CANCELLED_TEXT],
    ['invalid', BIOMETRIC_INVALID_TEXT],
  ] as const)(
    '%s shows its line and keeps PIN entry and the forgotten link working',
    async (status, line) => {
      const onVerified = jest.fn();
      const onForgotten = jest.fn();
      const unlock = jest.fn(async (): Promise<Result> => ({
        status: 'verified',
        epoch: 9,
      }));
      const { view } = await renderStep({
        canOfferBiometric: async () => true,
        unlockWithBiometric: async () => ({ status }) as Result,
        onVerified,
        onForgotten,
        unlock,
      });
      await act(async () => {
        fireEvent.press(view.getByText(BIOMETRIC_UNLOCK_LABEL));
      });
      expect(view.getByText(line)).toBeTruthy();
      expect(view.queryByText(OLD_PIN_WRONG_TEXT)).toBeNull();
      expect(onVerified).not.toHaveBeenCalled();
      // The button stays for a retry.
      expect(view.getByText(BIOMETRIC_UNLOCK_LABEL)).toBeTruthy();

      await act(async () => {
        fireEvent.press(view.getByText("I don't remember it"));
      });
      expect(onForgotten).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.changeText(view.getByLabelText('Old PIN'), '123456');
      });
      await act(async () => {
        fireEvent.press(view.getByText('Continue'));
      });
      expect(unlock).toHaveBeenCalledWith('123456');
      expect(onVerified).toHaveBeenCalledWith(9);
    }
  );

  it.each(['locked', 'wipe_pending', 'cancelled', 'unavailable'] as const)(
    '%s re-reads the stored throttle and shows no extra line',
    async (status) => {
      const { view, readLockedUntil } = await renderStep({
        canOfferBiometric: async () => true,
        unlockWithBiometric: async () => ({ status }) as Result,
      });
      readLockedUntil.mockClear();
      await act(async () => {
        fireEvent.press(view.getByText(BIOMETRIC_UNLOCK_LABEL));
      });
      expect(readLockedUntil).toHaveBeenCalledTimes(1);
      expect(view.queryByText(BIOMETRIC_NO_ITEM_TEXT)).toBeNull();
      expect(view.queryByText(BIOMETRIC_CANCELLED_TEXT)).toBeNull();
      expect(view.queryByText(BIOMETRIC_INVALID_TEXT)).toBeNull();
      expect(view.queryByText(OLD_PIN_WRONG_TEXT)).toBeNull();
    }
  );

  it('a locked result hides the button and the input once the throttle is re-read', async () => {
    let stored: number | null = null;
    const view = await render(
      <OldPinStep
        unlock={jest.fn()}
        readLockedUntil={async () => stored}
        onVerified={jest.fn()}
        onForgotten={jest.fn()}
        canOfferBiometric={async () => true}
        unlockWithBiometric={async () => {
          stored = Date.now() + 60_000;
          return { status: 'locked' };
        }}
      />
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.press(view.getByText(BIOMETRIC_UNLOCK_LABEL));
    });
    expect(view.getByText(/Too many wrong tries/)).toBeTruthy();
    expect(view.queryByText(BIOMETRIC_UNLOCK_LABEL)).toBeNull();
    expect(view.queryByLabelText('Old PIN')).toBeNull();
  });

  it('the forgotten link stays pressable while a biometric attempt is pending, and one authentication runs at a time', async () => {
    const onForgotten = jest.fn();
    const unlock = jest.fn();
    let finish: (r: Result) => void = () => {};
    const unlockWithBiometric = jest.fn(
      () =>
        new Promise<Result>((resolve) => {
          finish = resolve;
        })
    );
    const { view } = await renderStep({
      canOfferBiometric: async () => true,
      unlockWithBiometric,
      onForgotten,
      unlock,
    });
    await act(async () => {
      fireEvent.changeText(view.getByLabelText('Old PIN'), '123456');
    });
    await act(async () => {
      fireEvent.press(view.getByText(BIOMETRIC_UNLOCK_LABEL));
    });
    expect(unlockWithBiometric).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(view.getByText("I don't remember it"));
    });
    expect(onForgotten).toHaveBeenCalledTimes(1);

    // A second tap and a PIN submit while the first attempt runs do nothing.
    await act(async () => {
      fireEvent.press(view.getByText(BIOMETRIC_UNLOCK_LABEL));
    });
    await act(async () => {
      fireEvent(view.getByLabelText('Old PIN'), 'submitEditing');
    });
    expect(unlockWithBiometric).toHaveBeenCalledTimes(1);
    expect(unlock).not.toHaveBeenCalled();

    await act(async () => {
      finish({ status: 'biometric_cancelled' });
    });
    expect(view.getByText(BIOMETRIC_CANCELLED_TEXT)).toBeTruthy();
  });

  it('a wrong PIN after a biometric failure replaces the biometric line', async () => {
    const { view } = await renderStep({
      canOfferBiometric: async () => true,
      unlockWithBiometric: async () => ({ status: 'no_item' }),
      unlock: jest.fn(async () => ({ status: 'invalid' as const })),
    });
    await act(async () => {
      fireEvent.press(view.getByText(BIOMETRIC_UNLOCK_LABEL));
    });
    expect(view.getByText(BIOMETRIC_NO_ITEM_TEXT)).toBeTruthy();
    await act(async () => {
      fireEvent.changeText(view.getByLabelText('Old PIN'), '000000');
    });
    await act(async () => {
      fireEvent.press(view.getByText('Continue'));
    });
    expect(view.getByText(OLD_PIN_WRONG_TEXT)).toBeTruthy();
    expect(view.queryByText(BIOMETRIC_NO_ITEM_TEXT)).toBeNull();
  });
});
