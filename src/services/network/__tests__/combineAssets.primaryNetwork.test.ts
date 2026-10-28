// GH #13 / TASK-391: MultiNetworkBalanceService.combineAssets seeds a mapped
// group from its native (assetId 0) source, so opting into aAlgo on Voi (seen
// first: networks are walked Voi-first) no longer makes the ALGO group Voi's.

jest.mock('../index', () => ({ NetworkService: {} }));
jest.mock('../../token-mapping', () => ({ __esModule: true, default: {} }));

import { NetworkId } from '@/types/network';
import type { AccountBalance } from '@/types/wallet';
import type { MappedAsset, TokenMapping } from '@/services/token-mapping/types';
import { MultiNetworkBalanceService } from '../multi-network';

type CombineAssets = (
  networkBalances: { networkId: NetworkId; balance: AccountBalance }[],
  tokenMappings: TokenMapping[]
) => MappedAsset[];

// combineAssets is private; exercise it directly rather than through the
// network-fetching getAggregatedBalance.
const combineAssets = (
  MultiNetworkBalanceService as unknown as { combineAssets: CombineAssets }
).combineAssets.bind(MultiNetworkBalanceService);

const AALGO = 302189;
const AVOI = 2320775407;

const mappings: TokenMapping[] = [
  {
    mappingId: 'algo',
    name: 'ALGO',
    verified: true,
    tokens: [
      {
        networkId: NetworkId.ALGORAND_MAINNET,
        assetId: 0,
        symbol: 'ALGO',
        decimals: 6,
      },
      {
        networkId: NetworkId.VOI_MAINNET,
        assetId: AALGO,
        symbol: 'aALGO',
        decimals: 6,
      },
    ],
  },
  {
    mappingId: 'voi',
    name: 'VOI',
    verified: true,
    tokens: [
      {
        networkId: NetworkId.VOI_MAINNET,
        assetId: 0,
        symbol: 'VOI',
        decimals: 6,
      },
      {
        networkId: NetworkId.ALGORAND_MAINNET,
        assetId: AVOI,
        symbol: 'aVOI',
        decimals: 6,
      },
    ],
  },
];

const balance = (
  amount: bigint,
  assets: AccountBalance['assets'] = []
): AccountBalance => ({
  address: 'ADDR',
  amount,
  minBalance: 0n,
  assets,
});

const find = (assets: MappedAsset[], mappingId: string) =>
  assets.find((a) => a.mappingId === mappingId)!;

describe('combineAssets primaryNetwork (GH #13)', () => {
  it('ALGO group is Algorand-primary when aAlgo on Voi is processed first', () => {
    const result = combineAssets(
      [
        {
          networkId: NetworkId.VOI_MAINNET,
          balance: balance(5_000_000n, [
            { assetId: AALGO, amount: 2_000_000n, decimals: 6, name: 'aALGO' },
          ]),
        },
        { networkId: NetworkId.ALGORAND_MAINNET, balance: balance(3_000_000n) },
      ],
      mappings
    );

    const algo = find(result, 'algo');
    expect(algo.primaryNetwork).toBe(NetworkId.ALGORAND_MAINNET);
    // Top-level identity is the native source's, consistent with primaryNetwork.
    expect(algo.assetId).toBe(0);
    // Sum across same-decimals sources is unchanged by the seed choice.
    expect(algo.amount).toBe(5_000_000n);
    // Source order stays encounter order.
    expect(algo.sourceBalances.map((s) => s.networkId)).toEqual([
      NetworkId.VOI_MAINNET,
      NetworkId.ALGORAND_MAINNET,
    ]);

    // VOI group: native VOI is seen first anyway; still Voi-primary.
    const voi = find(result, 'voi');
    expect(voi.primaryNetwork).toBe(NetworkId.VOI_MAINNET);
    expect(voi.assetId).toBe(0);
  });

  it('VOI group stays Voi-primary when aVoi on Algorand is opted in', () => {
    const result = combineAssets(
      [
        { networkId: NetworkId.VOI_MAINNET, balance: balance(1n) },
        {
          networkId: NetworkId.ALGORAND_MAINNET,
          balance: balance(2n, [
            { assetId: AVOI, amount: 7n, decimals: 6, name: 'aVOI' },
          ]),
        },
      ],
      mappings
    );
    const voi = find(result, 'voi');
    expect(voi.primaryNetwork).toBe(NetworkId.VOI_MAINNET);
    expect(voi.amount).toBe(8n);
  });

  it('without the native token, the first-seen source stays primary', () => {
    const result = combineAssets(
      [
        {
          networkId: NetworkId.VOI_MAINNET,
          balance: {
            address: 'ADDR',
            amount: undefined as unknown as bigint, // no native entry
            minBalance: 0n,
            assets: [{ assetId: AALGO, amount: 4n, decimals: 6 }],
          },
        },
      ],
      mappings
    );
    const algo = find(result, 'algo');
    expect(algo.primaryNetwork).toBe(NetworkId.VOI_MAINNET);
    expect(algo.assetId).toBe(AALGO);
    expect(algo.amount).toBe(4n);
  });

  it('unmapped single-network assets are unaffected', () => {
    const result = combineAssets(
      [
        {
          networkId: NetworkId.ALGORAND_MAINNET,
          balance: balance(1n, [{ assetId: 999, amount: 3, decimals: 0 }]),
        },
      ],
      mappings
    );
    const lone = result.find((a) => a.assetId === 999)!;
    expect(lone.isMapped).toBe(false);
    expect(lone.primaryNetwork).toBe(NetworkId.ALGORAND_MAINNET);
    expect(lone.amount).toBe(3);
  });
});
