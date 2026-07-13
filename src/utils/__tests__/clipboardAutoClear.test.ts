import * as Clipboard from 'expo-clipboard';
import { scheduleClipboardClear } from '../clipboardAutoClear';

jest.mock('expo-clipboard', () => ({
  getStringAsync: jest.fn(),
  setStringAsync: jest.fn(() => Promise.resolve()),
}));

const mockGet = Clipboard.getStringAsync as jest.Mock;
const mockSet = Clipboard.setStringAsync as jest.Mock;

const SECRET =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';

describe('scheduleClipboardClear', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // clearMocks resets call history but not implementations; re-assert default.
    mockSet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('clears the clipboard after the delay when it still holds the secret', async () => {
    mockGet.mockResolvedValue(SECRET);

    scheduleClipboardClear(SECRET, 60_000);
    // Nothing happens before the delay elapses.
    await jest.advanceTimersByTimeAsync(59_000);
    expect(mockSet).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith('');
  });

  it('does NOT clear when the clipboard changed since copying', async () => {
    mockGet.mockResolvedValue('a different thing the user copied later');

    scheduleClipboardClear(SECRET, 60_000);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('canceller stops the scheduled clear (clipboard is never read or wiped)', async () => {
    mockGet.mockResolvedValue(SECRET);

    const handle = scheduleClipboardClear(SECRET, 60_000);
    handle.cancel();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('clearNow() wipes immediately when the secret is still present and cancels the timer', async () => {
    mockGet.mockResolvedValue(SECRET);

    const handle = scheduleClipboardClear(SECRET, 60_000);
    await handle.clearNow();

    expect(mockSet).toHaveBeenCalledWith('');

    // The timer must not fire a second clear afterwards.
    mockSet.mockClear();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('fails SAFE: if the read rejects, it wipes the clipboard anyway (never throws)', async () => {
    // Can't verify the clipboard contents → wipe rather than risk the secret
    // lingering.
    mockGet.mockRejectedValue(new Error('clipboard unavailable'));

    scheduleClipboardClear(SECRET, 1_000);
    await expect(jest.advanceTimersByTimeAsync(1_000)).resolves.toBeUndefined();

    expect(mockSet).toHaveBeenCalledWith('');
  });

  it('does NOT fail-safe wipe on read error if the handle was cancelled first', async () => {
    mockGet.mockRejectedValue(new Error('clipboard unavailable'));

    const handle = scheduleClipboardClear(SECRET, 1_000);
    handle.cancel();
    await jest.advanceTimersByTimeAsync(1_000);

    // Cancelled before the timer fired → the (cleared) timer never runs, so no
    // read and no wipe.
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('does NOT fail-safe wipe if cancelled while the failing read is in flight', async () => {
    // Timer fires and starts the read; a re-copy cancels this stale handle;
    // only then does the read reject. The cancelled guard must suppress the wipe.
    let rejectGet!: (err: Error) => void;
    mockGet.mockReturnValue(
      new Promise<string>((_resolve, reject) => {
        rejectGet = reject;
      })
    );

    const handle = scheduleClipboardClear(SECRET, 60_000);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockGet).toHaveBeenCalledTimes(1);

    handle.cancel();
    rejectGet(new Error('clipboard unavailable'));
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('does NOT clear if cancelled after the timer fired but before the read resolves (TOCTOU guard)', async () => {
    // Model the real-world race: the timer fires and starts reading the
    // clipboard, then a concurrent re-copy cancels this (now stale) handle, and
    // only afterwards does the in-flight read resolve with the old secret.
    let resolveGet!: (value: string) => void;
    mockGet.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveGet = resolve;
      })
    );

    const handle = scheduleClipboardClear(SECRET, 60_000);

    // Timer fires; the clear callback begins and awaits getStringAsync().
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockSet).not.toHaveBeenCalled();

    // A re-copy cancels the stale handle...
    handle.cancel();
    // ...then the parked read resolves with the value that was there at read time.
    resolveGet(SECRET);
    await Promise.resolve();
    await Promise.resolve();

    // The cancelled-flag guard must stop the write.
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('clearNow() after cancel() is a no-op (never reads or wipes)', async () => {
    mockGet.mockResolvedValue(SECRET);

    const handle = scheduleClipboardClear(SECRET, 60_000);
    handle.cancel();
    await handle.clearNow();

    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  });
});
