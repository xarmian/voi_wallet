/**
 * TASK-485: FreshAuthHost registers the fresh-auth prompter and maps the auth
 * modal's outcome (and app lifecycle) to the prompter's boolean.
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { AppState, AppStateStatus } from 'react-native';

type ModalProps = {
  visible: boolean;
  onSuccess: () => void;
  onCancel: () => void;
  purpose?: string;
};
let mockModalProps: ModalProps | undefined;
jest.mock('../UnifiedAuthModal', () => ({
  __esModule: true,
  default: (props: ModalProps) => {
    mockModalProps = props;
    return null;
  },
}));

import FreshAuthHost from '../FreshAuthHost';
import { withFreshAuth } from '@/services/secure/freshAuth';

describe('FreshAuthHost', () => {
  const appStateListeners: ((state: AppStateStatus) => void)[] = [];

  beforeEach(() => {
    mockModalProps = undefined;
    appStateListeners.length = 0;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_type, listener) => {
        appStateListeners.push(listener as (state: AppStateStatus) => void);
        return { remove: jest.fn() } as never;
      });
  });

  afterEach(() => jest.restoreAllMocks());

  const start = () => {
    const fn = jest.fn(async () => 'revealed');
    const run = withFreshAuth('reveal_recovery_phrase', fn);
    // Observe the rejection so a cancelled run never becomes unhandled.
    const settled = run.then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e })
    );
    return { fn, settled };
  };

  it('registers on mount and shows no prompt until asked', async () => {
    await render(<FreshAuthHost />);
    expect(mockModalProps?.visible).toBe(false);
    expect(appStateListeners).toHaveLength(0);
  });

  it('opens the modal for a request and a successful modal lets the function run', async () => {
    await render(<FreshAuthHost />);
    const { fn, settled } = start();
    await act(async () => {});
    expect(mockModalProps?.visible).toBe(true);
    expect(mockModalProps?.purpose).toBe('export_keys');
    await act(async () => mockModalProps?.onSuccess());
    expect(await settled).toEqual({ ok: true, v: 'revealed' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockModalProps?.visible).toBe(false);
  });

  it('a cancelled modal never runs the function', async () => {
    await render(<FreshAuthHost />);
    const { fn, settled } = start();
    await act(async () => {});
    await act(async () => mockModalProps?.onCancel());
    expect(await settled).toMatchObject({ ok: false });
    expect(fn).not.toHaveBeenCalled();
    expect(mockModalProps?.visible).toBe(false);
  });

  it('cancels when the app goes to the background while the prompt is open', async () => {
    await render(<FreshAuthHost />);
    const { fn, settled } = start();
    await act(async () => {});
    await act(async () => appStateListeners.forEach((l) => l('background')));
    expect(await settled).toMatchObject({ ok: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('does NOT cancel on inactive (the Face ID sheet makes the app inactive)', async () => {
    await render(<FreshAuthHost />);
    const { fn, settled } = start();
    await act(async () => {});
    await act(async () => appStateListeners.forEach((l) => l('inactive')));
    expect(mockModalProps?.visible).toBe(true);
    await act(async () => mockModalProps?.onSuccess());
    expect(await settled).toEqual({ ok: true, v: 'revealed' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('closes the modal when the prompt times out, and a second prompt then works', async () => {
    jest.useFakeTimers();
    try {
      await render(<FreshAuthHost />);
      let first: Promise<string | undefined> = Promise.resolve(undefined);
      await act(async () => {
        first = withFreshAuth('reveal_recovery_phrase', async () => 'ok', {
          timeoutMs: 1000,
        }).then(
          () => 'ok',
          (e: { code?: string }) => e.code
        );
      });
      expect(mockModalProps?.visible).toBe(true);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1500);
      });
      expect(await first).toBe('timeout');
      expect(mockModalProps?.visible).toBe(false);

      let second: ReturnType<typeof start> | undefined;
      await act(async () => {
        second = start();
      });
      expect(mockModalProps?.visible).toBe(true);
      await act(async () => mockModalProps?.onSuccess());
      expect(await second!.settled).toEqual({ ok: true, v: 'revealed' });
      expect(second!.fn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes the modal when the requesting caller aborts', async () => {
    await render(<FreshAuthHost />);
    const abort = new AbortController();
    const run = withFreshAuth('reveal_recovery_phrase', async () => 1, {
      signal: abort.signal,
    }).then(
      () => 'ok',
      (e: { code?: string }) => e.code
    );
    await act(async () => {});
    expect(mockModalProps?.visible).toBe(true);
    await act(async () => abort.abort());
    expect(await run).toBe('cancelled');
    expect(mockModalProps?.visible).toBe(false);
  });

  it('removes the prompter on unmount so a later request is unavailable', async () => {
    const view = await render(<FreshAuthHost />);
    await view.unmount();
    await expect(
      withFreshAuth('reveal_recovery_phrase', async () => 1)
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});
