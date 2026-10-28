import { resolveProposalEligibility } from '../utils';
import { getRekeyStateStrict } from '@/store/walletStore';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { VOI_CHAIN_DATA, ALGORAND_MAINNET_CHAIN_DATA } from '../config';

jest.mock('@/store/walletStore', () => ({ getRekeyStateStrict: jest.fn() }));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getCurrentWallet: jest.fn() },
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    probeSecretPresenceStrict: jest.fn(async () => true),
  },
}));
jest.mock('@/services/ledger/algorand', () => ({}));
jest.mock('@/services/ledger/transport', () => ({}));
jest.mock('@/services/network', () => ({}));
const VOI = VOI_CHAIN_DATA.chainId;
const ALGO = ALGORAND_MAINNET_CHAIN_DATA.chainId;
it.each([AccountType.REKEYED, AccountType.STANDARD])(
  'resolves actual signing info for %s across networks',
  async (type) => {
    const account = { id: 'key', address: 'OWNER', type } as AccountMetadata;
    jest
      .mocked(MultiAccountWalletService.getCurrentWallet)
      .mockResolvedValue({ accounts: [account] } as any);
    jest.mocked(getRekeyStateStrict).mockImplementation(async (_, network) => ({
      status: 'loaded',
      isRekeyed:
        network === 'algorand-mainnet' && type === AccountType.STANDARD,
      authAddress:
        network === 'algorand-mainnet' && type === AccountType.STANDARD
          ? 'MISSING'
          : undefined,
      canSign: type === AccountType.STANDARD && network === 'voi-mainnet',
    }));
    expect(await resolveProposalEligibility([account], [VOI, ALGO])).toEqual([
      {
        account,
        eligibleChains: type === AccountType.REKEYED ? [VOI, ALGO] : [VOI],
        errorChains: [],
      },
    ]);
    if (type === AccountType.REKEYED)
      expect(
        AccountSecureStorage.probeSecretPresenceStrict
      ).toHaveBeenCalledWith('key');
  }
);
