import { WalletConnectV1Client } from '../client';
import { SecureKeyManager as Keys } from '@/services/secure/keyManager';
import { MultiAccountWalletService } from '@/services/wallet';
import { createSessionApprovalResponse } from '../protocol';
import { AccountMetadata, AccountType } from '@/types/wallet';

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: { getSigningInfo: jest.fn() },
}));
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

it.each(['eligible', 'ineligible', 'error', 'unsupported'])(
  'v1 probes Algorand and fails closed when %s',
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
    jest.mocked(Keys.getSigningInfo).mockReset();
    if (answer === 'error') {
      jest.mocked(Keys.getSigningInfo).mockRejectedValue(new Error('offline'));
    } else {
      jest.mocked(Keys.getSigningInfo).mockResolvedValue({
        signingAddress: 'RK',
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
      sessionData: {
        chainId: answer === 'unsupported' ? 123 : 416001,
        peerId: 'peer',
      },
      storeSession: jest.fn(),
    });
    if (answer === 'eligible') {
      await client.approveSession(['RK']);
      expect(createSessionApprovalResponse).toHaveBeenCalledWith(
        0,
        true,
        416001,
        ['RK'],
        expect.anything(),
        'client'
      );
      expect(socket.publishToTopic).toHaveBeenCalledTimes(1);
    } else {
      await expect(client.approveSession(['RK'])).rejects.toThrow(
        answer === 'unsupported'
          ? 'Unsupported v1 chain'
          : 'No signable accounts available'
      );
      expect(socket.publishToTopic).not.toHaveBeenCalled();
    }
    if (answer === 'unsupported')
      expect(Keys.getSigningInfo).not.toHaveBeenCalled();
    else
      expect(Keys.getSigningInfo).toHaveBeenCalledWith(
        'RK',
        'algorand-mainnet'
      );
  }
);
