import {
  consumeFreshAuth,
  FreshAuthError,
  registerFreshAuthPrompter,
  withFreshAuth,
} from '../freshAuth';

describe('fresh authentication capabilities', () => {
  afterEach(() => jest.useRealTimers());

  it('rejects without a prompter and does not call the protected function', async () => {
    const fn = jest.fn();
    await expect(
      withFreshAuth('reveal_recovery_phrase', fn)
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not call the function when authentication is cancelled or fails', async () => {
    const fn = jest.fn();
    let unregister = registerFreshAuthPrompter(async () => false);
    await expect(
      withFreshAuth('reveal_recovery_phrase', fn)
    ).rejects.toMatchObject({ code: 'cancelled' });
    unregister();
    unregister = registerFreshAuthPrompter(async () => {
      throw new Error('no');
    });
    await expect(
      withFreshAuth('reveal_recovery_phrase', fn)
    ).rejects.toMatchObject({ code: 'failed' });
    expect(fn).not.toHaveBeenCalled();
    unregister();
  });

  it('prompts every time and invalidates capabilities when the callback returns', async () => {
    const prompt = jest.fn(async () => true);
    const unregister = registerFreshAuthPrompter(prompt);
    let stale: Parameters<typeof consumeFreshAuth>[0] | undefined;
    await withFreshAuth('reveal_recovery_phrase', async (cap) => {
      stale = cap;
      consumeFreshAuth(cap, 'reveal_recovery_phrase');
    });
    expect(() => consumeFreshAuth(stale!, 'reveal_recovery_phrase')).toThrow(
      FreshAuthError
    );
    await withFreshAuth('reveal_recovery_phrase', async () => 'ok');
    expect(prompt).toHaveBeenCalledTimes(2);
    unregister();
  });

  it('invalidates a capability that was never used once the callback returns', async () => {
    const unregister = registerFreshAuthPrompter(async () => true);
    const cap = await withFreshAuth('reveal_recovery_phrase', async (c) => c);
    expect(() => consumeFreshAuth(cap, 'reveal_recovery_phrase')).toThrow(
      FreshAuthError
    );
    unregister();
  });

  it('invalidates a capability when the callback throws', async () => {
    const unregister = registerFreshAuthPrompter(async () => true);
    let leaked: Parameters<typeof consumeFreshAuth>[0] | undefined;
    await expect(
      withFreshAuth('reveal_recovery_phrase', async (c) => {
        leaked = c;
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(() => consumeFreshAuth(leaked!, 'reveal_recovery_phrase')).toThrow(
      FreshAuthError
    );
    unregister();
  });

  it('does not abort the prompt signal after a successful prompt while the export runs', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const unregister = registerFreshAuthPrompter(async (_reason, s) => {
      signal = s;
      return true;
    });
    let release: () => void = () => {};
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = withFreshAuth('export_backup', async () => work);
    await jest.advanceTimersByTimeAsync(200000);
    expect(signal?.aborted).toBe(false);
    release();
    await run;
    unregister();
  });

  it('limits reads and binds capabilities to their reason', async () => {
    const unregister = registerFreshAuthPrompter(async () => true);
    await withFreshAuth('export_backup', async (cap) => {
      consumeFreshAuth(cap, 'export_backup');
      expect(() => consumeFreshAuth(cap, 'export_backup')).toThrow(
        FreshAuthError
      );
    });
    await withFreshAuth('export_backup', async (cap) => {
      expect(() => consumeFreshAuth(cap, 'reveal_recovery_phrase')).toThrow(
        FreshAuthError
      );
    });
    unregister();
  });

  it('rejects a concurrent prompt as busy while the original can finish', async () => {
    let resolve!: (value: boolean) => void;
    const unregister = registerFreshAuthPrompter(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const first = withFreshAuth('reveal_recovery_phrase', async () => 'done');
    await Promise.resolve();
    await expect(
      withFreshAuth('reveal_recovery_phrase', async () => 'bad')
    ).rejects.toMatchObject({ code: 'busy' });
    resolve(true);
    await expect(first).resolves.toBe('done');
    unregister();
  });

  it('aborts timed out prompts and clears busy state', async () => {
    jest.useFakeTimers();
    let signal!: AbortSignal;
    const unregister = registerFreshAuthPrompter((_reason, s) => {
      signal = s;
      return new Promise(() => {});
    });
    const result = withFreshAuth('reveal_recovery_phrase', async () => 'bad', {
      timeoutMs: 10,
    });
    jest.advanceTimersByTime(10);
    await expect(result).rejects.toMatchObject({ code: 'timeout' });
    expect(signal.aborted).toBe(true);
    unregister();
  });

  it('an unregister function cannot remove a replacement prompter', async () => {
    const first = registerFreshAuthPrompter(async () => false);
    const second = registerFreshAuthPrompter(async () => true);
    first();
    await expect(
      withFreshAuth('reveal_recovery_phrase', async () => 'ok')
    ).resolves.toBe('ok');
    second();
  });
});
