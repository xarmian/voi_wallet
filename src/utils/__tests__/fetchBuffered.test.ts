import { fetchBuffered } from '../fetchBuffered';

// TASK-440 #9: the deadline must cover the body read, not just the headers.

type FakeResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
};

const respond = (r: Partial<FakeResponse>): FakeResponse => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => '{}',
  ...r,
});

describe('fetchBuffered', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('rejects with AbortError when headers arrive but the body stalls past the deadline', async () => {
    // Headers resolve immediately; the body never does. Before the fix the
    // timer was cleared here and the caller's body read hung forever.
    fetchMock.mockResolvedValue(
      respond({ text: () => new Promise<string>(() => {}) })
    );

    const result = fetchBuffered('https://x.test', {}, 1000);
    const assertion = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;

    const signal: AbortSignal = fetchMock.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(true);
  });

  it('rejects with AbortError when the headers themselves stall', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    const result = fetchBuffered('https://x.test', {}, 1000);
    const assertion = expect(result).rejects.toMatchObject({
      name: 'AbortError',
    });
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('returns a buffered response read inside the deadline and clears the timer', async () => {
    fetchMock.mockResolvedValue(
      respond({
        status: 201,
        statusText: 'Created',
        text: async () => '{"a":1}',
      })
    );

    const res = await fetchBuffered('https://x.test', {}, 1000);

    expect(res).toMatchObject({ ok: true, status: 201, statusText: 'Created' });
    expect(await res.json()).toEqual({ a: 1 });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('parses lazily: a non-JSON error body only throws if json() is called', async () => {
    fetchMock.mockResolvedValue(
      respond({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => '<html>bad gateway</html>',
      })
    );

    const res = await fetchBuffered('https://x.test', {}, 1000);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    await expect(res.json()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('passes the caller init through and adds its own abort signal', async () => {
    fetchMock.mockResolvedValue(respond({}));

    await fetchBuffered(
      'https://x.test',
      { method: 'POST', body: '[]', headers: { A: 'b' } },
      1000
    );

    const init = fetchMock.mock.calls[0][1];
    expect(init).toMatchObject({
      method: 'POST',
      body: '[]',
      headers: { A: 'b' },
    });
    expect(init.signal).toBeDefined();
  });
});
