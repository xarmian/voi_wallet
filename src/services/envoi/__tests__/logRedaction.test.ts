/**
 * Envoi name resolution must not put a full wallet address into a surviving
 * log level (TASK-290). babel.config.js strips console.log from release bundles
 * but keeps console.error / console.warn, so anything logged at those levels on
 * a failed resolution reaches production logs.
 */
import algosdk from 'algosdk';

jest.mock('@/services/network/offline', () => ({
  shouldSkipForOffline: () => false,
}));

import EnvoiService from '@/services/envoi';

const envoi = EnvoiService.getInstance();

// Flatten every console argument (including an Error's message and stack) so
// an address hidden inside a logged error is caught too.
const flatten = (args: unknown[]): string =>
  args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');

describe('EnvoiService logging (TASK-290)', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  const originalFetch = (global as unknown as { fetch: unknown }).fetch;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const config = (envoi as unknown as { config: Record<string, number> })
      .config;
    config.retryDelay = 0;
    config.timeout = 50;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (global as unknown as { fetch: unknown }).fetch = originalFetch;
  });

  it('does not log the full address when name resolution fails', async () => {
    const address = algosdk.generateAccount().addr.toString();
    // The rejection text carries the request URL, and so the address, the way
    // a real fetch failure can.
    (global as unknown as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.reject(
        new Error(`request to https://api.envoi.sh/api/name/${address} failed`)
      )
    );

    await expect(envoi.getName(address)).resolves.toBeNull();

    const logged = [...errorSpy.mock.calls, ...warnSpy.mock.calls].map(flatten);
    // The failure is still logged, with a correlatable prefix.
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to resolve Envoi name:',
      `${address.slice(0, 6)}…[redacted]`,
      expect.any(String)
    );
    for (const line of logged) {
      expect(line).not.toContain(address);
    }
  });
});
