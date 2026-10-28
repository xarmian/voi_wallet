import { WalletConnectV1Client } from '../client';
import { getRekeyStateStrict } from '@/store/walletStore';
import { MultiAccountWalletService } from '@/services/wallet';
import { createSessionApprovalResponse } from '../protocol';
import { AccountMetadata, AccountType } from '@/types/wallet';

jest.mock('@/store/walletStore', () => ({ getRekeyStateStrict: jest.fn() }));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getAllAccounts: jest.fn() },
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../protocol', () => ({
  createSessionApprovalResponse: jest.fn(() => ({})),
  encryptResponse: jest.fn(async () => 'encrypted'),
}));

it.each(['eligible', 'ineligible', 'error'])(
  'v1 probes Voi and fails closed when %s',
  async (answer) => {
    const selected = {
      id: 'rk',
      address: 'RK',
      type: AccountType.REKEYED,
      canSign: answer !== 'eligible',
    } as AccountMetadata;
    jest
      .mocked(MultiAccountWalletService.getAllAccounts)
      .mockResolvedValue([selected]);
    jest.mocked(getRekeyStateStrict).mockReset();
    if (answer === 'error') {
      jest.mocked(getRekeyStateStrict).mockRejectedValue(new Error('offline'));
    } else {
      jest.mocked(getRekeyStateStrict).mockResolvedValue({
        status: 'loaded',
        isRekeyed: true,
        canSign: answer === 'eligible',
      });
    }
    const socket = {
      onTopicMessageWithMeta: jest.fn(),
      subscribeToTopic: jest.fn(),
      publishToTopic: jest.fn(),
    };
    const client = new WalletConnectV1Client();
    Object.assign(client, {
      config: { key: 'placeholder' },
      socket,
      clientId: 'client',
      sessionData: { chainId: 123, peerId: 'peer' },
      storeSession: jest.fn(),
    });
    if (answer === 'eligible') {
      await client.approveSession(['RK']);
      expect(createSessionApprovalResponse).toHaveBeenCalledWith(
        0,
        true,
        123,
        ['RK'],
        expect.anything(),
        'client'
      );
      expect(socket.publishToTopic).toHaveBeenCalledTimes(1);
    } else {
      await expect(client.approveSession(['RK'])).rejects.toThrow(
        'No signable accounts available'
      );
      expect(socket.publishToTopic).not.toHaveBeenCalled();
    }
    expect(getRekeyStateStrict).toHaveBeenCalledWith('RK', 'voi-mainnet');
  }
);
