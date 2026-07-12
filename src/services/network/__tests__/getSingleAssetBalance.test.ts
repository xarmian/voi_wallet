import algosdk from 'algosdk';
import { NetworkService } from '../index';
import { NetworkId } from '@/types/network';
import type { MimirAsset } from '@/services/mimir';

// A syntactically valid address (all-zero public key) so isValidAddress passes.
const ADDRESS = algosdk.encodeAddress(new Uint8Array(32));
const ASSET_ID = 12345;

function mimirAsa(overrides: Partial<MimirAsset> = {}): MimirAsset {
  return {
    name: 'Stale ASA',
    symbol: 'STALE',
    balance: '1000',
    decimals: 6,
    imageUrl: 'stale-img',
    usdValue: '1',
    verified: 0,
    accountId: ADDRESS,
    assetType: 'asa',
    contractId: ASSET_ID,
    ...overrides,
  };
}

/**
 * Regression coverage for getSingleAssetBalance's targeted lookup (TASK-52),
 * focused on the financial-correctness edges: a genuine not-found ASA must not
 * be papered over with stale Mimir metadata, and decimals must never be
 * fabricated.
 */
describe('NetworkService.getSingleAssetBalance', () => {
  let service: NetworkService;

  beforeEach(() => {
    service = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    // Account holds the ASA (algod is the source of truth for the holding).
    (service as any).algodClient = {
      accountInformation: () => ({
        do: async () => ({
          assets: [{ assetId: BigInt(ASSET_ID), amount: 1000n }],
        }),
      }),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns null (not-found) when algod getAssetInfo returns null, even if Mimir has stale ASA metadata', async () => {
    jest
      .spyOn(service as any, 'getMimirAssets')
      .mockResolvedValue([mimirAsa()]);
    // Genuine 404 / not-found (getAssetInfo returns null, does not throw).
    jest.spyOn(service as any, 'getAssetInfo').mockResolvedValue(null);

    const result = await service.getSingleAssetBalance(ADDRESS, ASSET_ID);

    expect(result).toBeNull();
  });

  it('falls back to Mimir decimals when getAssetInfo THROWS (transient error)', async () => {
    jest
      .spyOn(service as any, 'getMimirAssets')
      .mockResolvedValue([
        mimirAsa({ symbol: 'USDC', name: 'USDC', decimals: 6 }),
      ]);
    jest
      .spyOn(service as any, 'getAssetInfo')
      .mockRejectedValue(new Error('request timed out'));

    const result = await service.getSingleAssetBalance(ADDRESS, ASSET_ID);

    expect(result).not.toBeNull();
    expect(result?.assetType).toBe('asa');
    expect(result?.decimals).toBe(6);
    expect(result?.symbol).toBe('USDC');
    expect(result?.amount).toBe(1000n);
  });

  it('uses genuine algod decimals, preserving a legitimate decimals:0', async () => {
    jest.spyOn(service as any, 'getMimirAssets').mockResolvedValue([]);
    jest.spyOn(service as any, 'getAssetInfo').mockResolvedValue({
      params: { decimals: 0, name: 'Zero Decimals', unitName: 'ZERO' },
    });

    const result = await service.getSingleAssetBalance(ADDRESS, ASSET_ID);

    expect(result).not.toBeNull();
    expect(result?.decimals).toBe(0);
    expect(result?.name).toBe('Zero Decimals');
    expect(result?.assetType).toBe('asa');
  });

  it('returns null when neither algod nor Mimir yields genuine decimals (never fabricates 0)', async () => {
    jest.spyOn(service as any, 'getMimirAssets').mockResolvedValue([]);
    // Asset exists but its params carry no usable decimals.
    jest
      .spyOn(service as any, 'getAssetInfo')
      .mockResolvedValue({ params: { name: 'No Decimals' } });

    const result = await service.getSingleAssetBalance(ADDRESS, ASSET_ID);

    expect(result).toBeNull();
  });

  it('does NOT fall back to stale Mimir decimals when a reachable algod returned unusable params (throw-only fallback)', async () => {
    // Mimir has decimals, but algod is REACHABLE (getAssetInfo resolves, does
    // not throw) and its params lack usable decimals. Since algod is
    // authoritative when reachable, we must not substitute Mimir here.
    jest
      .spyOn(service as any, 'getMimirAssets')
      .mockResolvedValue([mimirAsa({ decimals: 6 })]);
    jest
      .spyOn(service as any, 'getAssetInfo')
      .mockResolvedValue({ params: { name: 'Missing Decimals' } });

    const result = await service.getSingleAssetBalance(ADDRESS, ASSET_ID);

    expect(result).toBeNull();
  });

  it('rejects a non-integer/NaN decimals rather than returning a bad asset', async () => {
    jest.spyOn(service as any, 'getMimirAssets').mockResolvedValue([]);
    jest
      .spyOn(service as any, 'getAssetInfo')
      .mockResolvedValue({ params: { decimals: 'not-a-number', name: 'Bad' } });

    const result = await service.getSingleAssetBalance(ADDRESS, ASSET_ID);

    expect(result).toBeNull();
  });

  it('rejects a Number()-coercible malformed decimals (e.g. empty string) instead of fabricating 0', async () => {
    // Mimir has real decimals, but a reachable algod returned decimals: ''.
    // Number('') === 0, so a naive coercion would surface a fabricated 0 and an
    // inflated balance; it must return null (algod reachable => no Mimir fallback).
    jest
      .spyOn(service as any, 'getMimirAssets')
      .mockResolvedValue([mimirAsa({ decimals: 6 })]);
    jest
      .spyOn(service as any, 'getAssetInfo')
      .mockResolvedValue({ params: { decimals: '', name: 'Empty Decimals' } });

    const result = await service.getSingleAssetBalance(ADDRESS, ASSET_ID);

    expect(result).toBeNull();
  });

  it('discovers an unmapped ARC-200 via Mimir without an algod asset lookup (no regression)', async () => {
    jest.spyOn(service as any, 'getMimirAssets').mockResolvedValue([
      mimirAsa({
        assetType: 'arc200',
        decimals: 8,
        name: 'ARC Token',
        symbol: 'ARC',
        balance: '500',
      }),
    ]);
    const getAssetInfoSpy = jest.spyOn(service as any, 'getAssetInfo');

    const result = await service.getSingleAssetBalance(ADDRESS, ASSET_ID);

    expect(result?.assetType).toBe('arc200');
    expect(result?.contractId).toBe(ASSET_ID);
    expect(result?.decimals).toBe(8);
    expect(result?.amount).toBe(500n);
    expect(getAssetInfoSpy).not.toHaveBeenCalled();
  });

  it('returns null for an ARC-200 whose Mimir decimals are missing/invalid', async () => {
    jest.spyOn(service as any, 'getMimirAssets').mockResolvedValue([
      mimirAsa({
        assetType: 'arc200',
        // Simulate a malformed runtime payload lacking decimals.
        decimals: undefined as unknown as number,
      }),
    ]);

    const result = await service.getSingleAssetBalance(ADDRESS, ASSET_ID);

    expect(result).toBeNull();
  });
});
