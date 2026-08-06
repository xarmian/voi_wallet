// The Snowball API requires every asset/app ID as a STRING of digits and
// rejects the whole request otherwise:
//
//   POST /quote {"inputToken":410419,...}
//     → 400 {"error":"Invalid inputToken/outputToken: must be a string of
//                     digits (asset/app id) <= 9007199254740891"}
//
// The app carries IDs as numbers (/config/tokens returns them inconsistently —
// "0" as a string, 300279 as a number — so getTokens normalizes to number), and
// the request objects were passed to JSON.stringify verbatim. Every Voi quote
// therefore 400'd. Worse, the 400 was unreadable: makeRequest read only
// `errorData.message`, but the API answers with `errorData.error`, and RN's
// fetch leaves `statusText` empty — so the reason collapsed to the literal
// string "HTTP 400: " and the real explanation was thrown away unread.
//
// These tests pin both halves: what goes out on the wire, and what comes back
// out of a failure.

import SnowballApiService, { SnowballApiError } from '@/services/snowball';

const ADDRESS = 'BUD2763FMK6EYVKGHWWUN4QKHPSPCVFUEPPI4PQCPGYVPGQ6GNKBX6IXCQ';

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: '',
  json: async () => body,
});

const errorResponse = (status: number, body: unknown, statusText = '') => ({
  ok: false,
  status,
  statusText,
  json: async () => body,
});

/** The request body the service actually put on the wire, parsed. */
const sentBody = (fetchMock: jest.Mock, call = 0) =>
  JSON.parse(fetchMock.mock.calls[call][1].body as string);

describe('Snowball wire format (TASK-313)', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    SnowballApiService.clearCache();
  });

  describe('getQuote', () => {
    it('sends token IDs as strings of digits, not numbers', async () => {
      fetchMock.mockResolvedValue(okResponse({ quote: {} }));

      await SnowballApiService.getQuote({
        inputToken: 410419,
        outputToken: 0,
        amount: '100000000',
        address: ADDRESS,
        slippageTolerance: 0.01,
      });

      const body = sentBody(fetchMock);
      expect(body.inputToken).toBe('410419');
      expect(body.outputToken).toBe('0');
      // The native token is ID 0 — it must survive as "0", not become 0 or "".
      expect(typeof body.inputToken).toBe('string');
      expect(typeof body.outputToken).toBe('string');
    });

    it('stringifies poolId, which the API rejects as a number too', async () => {
      fetchMock.mockResolvedValue(okResponse({ quote: {} }));

      await SnowballApiService.getQuote({
        inputToken: 0,
        outputToken: 420069,
        amount: '1000000',
        poolId: 429999,
      });

      expect(sentBody(fetchMock).poolId).toBe('429999');
    });

    it('omits poolId entirely when it was not requested', async () => {
      fetchMock.mockResolvedValue(okResponse({ quote: {} }));

      await SnowballApiService.getQuote({
        inputToken: 0,
        outputToken: 420069,
        amount: '1000000',
      });

      expect(sentBody(fetchMock)).not.toHaveProperty('poolId');
    });

    it('passes the non-ID fields through untouched', async () => {
      fetchMock.mockResolvedValue(okResponse({ quote: {} }));

      await SnowballApiService.getQuote({
        inputToken: 410419,
        outputToken: 0,
        amount: '100000000',
        address: ADDRESS,
        slippageTolerance: 0.01,
        dex: ['humbleswap'],
      });

      const body = sentBody(fetchMock);
      expect(body.amount).toBe('100000000');
      expect(body.address).toBe(ADDRESS);
      expect(body.slippageTolerance).toBe(0.01);
      expect(body.dex).toEqual(['humbleswap']);
    });

    it('rejects an unrepresentable ID before it reaches the network', async () => {
      await expect(
        SnowballApiService.getQuote({
          inputToken: Number.MAX_SAFE_INTEGER + 2,
          outputToken: 0,
          amount: '1',
        })
      ).rejects.toThrow(/inputToken/);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('unwrap', () => {
    it('sends wrappedTokenId as a string of digits', async () => {
      fetchMock.mockResolvedValue(okResponse({ transactions: [] }));

      await SnowballApiService.unwrap({
        address: ADDRESS,
        items: [
          { wrappedTokenId: 410419, amount: '1' },
          { wrappedTokenId: 420069, amount: '2' },
        ],
      });

      const body = sentBody(fetchMock);
      expect(body.items).toEqual([
        { wrappedTokenId: '410419', amount: '1' },
        { wrappedTokenId: '420069', amount: '2' },
      ]);
      expect(body.address).toBe(ADDRESS);
    });
  });

  describe('error surfacing', () => {
    it("reports the API's `error` field instead of an empty status line", async () => {
      const apiReason =
        'Invalid inputToken/outputToken: must be a string of digits (asset/app id) <= 9007199254740991';
      fetchMock.mockResolvedValue(errorResponse(400, { error: apiReason }));

      await expect(
        SnowballApiService.getQuote({
          inputToken: 410419,
          outputToken: 0,
          amount: '1',
        })
      ).rejects.toMatchObject({
        name: 'SnowballApiError',
        message: apiReason,
        statusCode: 400,
      });
    });

    it('still prefers `message` when the API sends one', async () => {
      fetchMock.mockResolvedValue(
        errorResponse(400, { message: 'from message', error: 'from error' })
      );

      await expect(
        SnowballApiService.getQuote({
          inputToken: 1,
          outputToken: 0,
          amount: '1',
        })
      ).rejects.toThrow('from message');
    });

    it('does not leave a dangling colon when statusText is empty', async () => {
      // RN's fetch gives an empty statusText; the old fallback produced the
      // bare, uninformative "HTTP 400: " that sent this bug to a device.
      fetchMock.mockResolvedValue(errorResponse(400, {}));

      const error = await SnowballApiService.getQuote({
        inputToken: 1,
        outputToken: 0,
        amount: '1',
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SnowballApiError);
      expect((error as Error).message).toBe('HTTP 400');
    });

    it('keeps statusText when the platform provides one', async () => {
      fetchMock.mockResolvedValue(errorResponse(404, {}, 'Not Found'));

      await expect(
        SnowballApiService.getQuote({
          inputToken: 1,
          outputToken: 0,
          amount: '1',
        })
      ).rejects.toThrow('HTTP 404: Not Found');
    });
  });
});
