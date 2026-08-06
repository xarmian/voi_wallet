// A Snowball 200 does NOT mean the swap is executable.
//
// The API prices the route and builds the transaction group in one call. When
// only the second half fails it still answers 200: `unsignedTransactions` comes
// back empty and the reason sits in `error`/`simulationError`. Observed on a
// live multi-hop route (410419 → 420069 → 0):
//
//   "Failed to generate swap transactions: Failed to build a fully-verified
//    transaction group: Strict resource verification did not converge after 8
//    iterations: tx references exceed MaxAppTotalTxnReferences = 8"
//
// Unguarded, the adapter copied that empty array through, SwapScreen rendered a
// healthy-looking quote, and Review navigated to UniversalTransactionSigning
// with ZERO transactions to sign.
//
// The guard is gated on userAddress because an empty array is legitimate
// without one — an address-less request is a price-only quote.

// AsyncStorage — force the community jest mock so networkStore, which
// src/services/swap imports for provider selection, resolves.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { SwapService, SwapServiceError } from '@/services/swap';
import SnowballApiService from '@/services/snowball';
import { NetworkId } from '@/types/network';

const ADDRESS = 'BUD2763FMK6EYVKGHWWUN4QKHPSPCVFUEPPI4PQCPGYVPGQ6GNKBX6IXCQ';

const BUILD_FAILURE =
  'Failed to generate swap transactions: Failed to build a fully-verified ' +
  'transaction group: Strict resource verification did not converge after 8 ' +
  'iterations: tx references exceed MaxAppTotalTxnReferences = 8';

const QUOTE_DETAILS = {
  inputAmount: '100000000',
  outputAmount: '39918194',
  minimumOutputAmount: '39519012',
  rate: 0.39918194,
  priceImpact: 0.00008537382481471524,
  networkFee: '0',
};

const ROUTE = {
  type: 'direct' as const,
  pools: [
    {
      poolId: '429999',
      dex: 'humbleswap',
      inputAmount: '100000000',
      outputAmount: '39918194',
    },
  ],
};

function quoteResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: '',
    json: async () => ({
      quote: QUOTE_DETAILS,
      unsignedTransactions: ['dHhu'],
      route: ROUTE,
      poolId: null,
      platformFee: {
        gain: '0',
        feeAmount: '0',
        feeBps: 0,
        feeAddress: null,
        applied: false,
      },
      ...overrides,
    }),
  };
}

const REQUEST = {
  inputTokenId: 410419,
  outputTokenId: 0,
  amount: '100000000',
  userAddress: ADDRESS,
  slippageTolerance: 1,
};

describe('SnowballSwapAdapter degraded-quote guard', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    SnowballApiService.clearCache();
  });

  const provider = () => SwapService.getProvider(NetworkId.VOI_MAINNET);

  it('rejects a 200 whose transaction group could not be built', async () => {
    fetchMock.mockResolvedValue(
      quoteResponse({
        unsignedTransactions: [],
        error: BUILD_FAILURE,
        simulationError: BUILD_FAILURE,
      })
    );

    const error = await provider()
      .getQuote(REQUEST)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SwapServiceError);
    expect((error as SwapServiceError).message).toBe(BUILD_FAILURE);
    expect((error as SwapServiceError).provider).toBe('snowball');
  });

  it('falls back to simulationError when only that is populated', async () => {
    fetchMock.mockResolvedValue(
      quoteResponse({ unsignedTransactions: [], simulationError: 'sim failed' })
    );

    await expect(provider().getQuote(REQUEST)).rejects.toThrow('sim failed');
  });

  it('explains itself when the API gives no reason at all', async () => {
    fetchMock.mockResolvedValue(quoteResponse({ unsignedTransactions: [] }));

    await expect(provider().getQuote(REQUEST)).rejects.toThrow(
      /could not be built/
    );
  });

  it('allows an empty transaction list for a price-only quote', async () => {
    // No userAddress: the API never returns transactions for these, so an
    // empty array is the expected shape, not a failure.
    fetchMock.mockResolvedValue(quoteResponse({ unsignedTransactions: [] }));

    const quote = await provider().getQuote({
      ...REQUEST,
      userAddress: undefined,
    });

    expect(quote.unsignedTransactions).toEqual([]);
    expect(quote.outputAmount).toBe('39918194');
  });

  it('passes a healthy quote through untouched', async () => {
    fetchMock.mockResolvedValue(quoteResponse());

    const quote = await provider().getQuote(REQUEST);

    expect(quote.unsignedTransactions).toEqual(['dHhu']);
    expect(quote.provider).toBe('snowball');
    expect(quote.minimumOutputAmount).toBe('39519012');
  });

  it('converts percentage slippage to the decimal the API expects', async () => {
    fetchMock.mockResolvedValue(quoteResponse());

    await provider().getQuote({ ...REQUEST, slippageTolerance: 1 });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.slippageTolerance).toBe(0.01);
  });
});
