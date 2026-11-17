/**
 * TASK-425: ASA opt-in and opt-out sign on the network they build and submit
 * on, not the app's active network.
 */
import algosdk from 'algosdk';
import { NetworkId } from '@/types/network';

jest.mock('@/services/network', () => ({
  NetworkService: { getInstance: jest.fn() },
}));
jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: { signTransaction: jest.fn() },
}));

import { NetworkService } from '@/services/network';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { submitAsaOptIn, submitAsaOptOut } from '../asa';

const mockGetInstance = NetworkService.getInstance as unknown as jest.Mock;
const mockSignTransaction =
  SecureKeyManager.signTransaction as unknown as jest.Mock;

const ADDRESS = algosdk.generateAccount().addr.toString();
const ASSET_ID = 31566704;
const CREATOR = algosdk.generateAccount().addr.toString();

function serviceWith(assets: { assetId: number; amount: number }[]) {
  return {
    getAlgodClient: () => ({
      accountInformation: () => ({
        do: async () => ({ amount: 10_000_000, minBalance: 100_000, assets }),
      }),
      getAssetByID: () => ({
        do: async () => ({ params: { creator: CREATOR } }),
      }),
    }),
    getSuggestedParams: jest.fn().mockResolvedValue({
      fee: 1000,
      firstValid: 1,
      lastValid: 1001,
      genesisID: 'mainnet-v1.0',
      genesisHash: new Uint8Array(32),
      flatFee: true,
      minFee: 1000,
    }),
    submitTransaction: jest.fn().mockResolvedValue({ txId: 'TXID' }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSignTransaction.mockResolvedValue(new Uint8Array([1]));
});

describe('ASA opt-in/opt-out signing network (TASK-425)', () => {
  it('opt-in signs on its own network', async () => {
    mockGetInstance.mockReturnValue(serviceWith([]));

    await submitAsaOptIn(ASSET_ID, ADDRESS, NetworkId.ALGORAND_MAINNET, '1234');

    expect(mockGetInstance).toHaveBeenCalledWith(NetworkId.ALGORAND_MAINNET);
    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
    expect(mockSignTransaction.mock.calls[0][1]).toBe(ADDRESS);
    expect(mockSignTransaction.mock.calls[0][3]).toBe(
      NetworkId.ALGORAND_MAINNET
    );
  });

  it('opt-out signs on its own network', async () => {
    mockGetInstance.mockReturnValue(
      serviceWith([{ assetId: ASSET_ID, amount: 0 }])
    );

    await submitAsaOptOut(
      ASSET_ID,
      ADDRESS,
      NetworkId.ALGORAND_MAINNET,
      '1234'
    );

    expect(mockGetInstance).toHaveBeenCalledWith(NetworkId.ALGORAND_MAINNET);
    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
    expect(mockSignTransaction.mock.calls[0][1]).toBe(ADDRESS);
    expect(mockSignTransaction.mock.calls[0][3]).toBe(
      NetworkId.ALGORAND_MAINNET
    );
  });
});
