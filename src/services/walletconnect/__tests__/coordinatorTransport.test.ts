import { createCoordinatorTransport } from '../coordinatorTransport';
import { WalletConnectService } from '@/services/walletconnect';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';

jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: { getInstance: jest.fn() },
}));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: { getInstance: jest.fn() },
}));

const v2 = {
  rejectRequest: jest.fn(async () => {}),
  rejectProposal: jest.fn(async () => {}),
};
const v1 = {
  rejectRequest: jest.fn(async () => {}),
  rejectSession: jest.fn(async () => {}),
};
const error = { code: -32000, message: 'Request expired.' };
beforeEach(() => {
  jest
    .mocked(WalletConnectService.getInstance)
    .mockReturnValue(v2 as unknown as WalletConnectService);
  jest
    .mocked(WalletConnectV1Client.getInstance)
    .mockReturnValue(v1 as unknown as WalletConnectV1Client);
});

it('DEFECT rejectRequestV2 forwards topic, id, code and message', async () => {
  await createCoordinatorTransport().rejectRequestV2('topic', 5, error);
  expect(v2.rejectRequest).toHaveBeenCalledWith('topic', 5, error);
});
it('DEFECT rejectRequestV1 forwards id, message and the request topic', async () => {
  await createCoordinatorTransport().rejectRequestV1(5, error.message, 'hs');
  expect(v1.rejectRequest).toHaveBeenCalledWith(5, error.message, 'hs');
});
it('DEFECT rejectProposalV2 forwards id and custom reason', async () => {
  await createCoordinatorTransport().rejectProposalV2(5, 'pairing', error);
  expect(v2.rejectProposal).toHaveBeenCalledWith(5, error);
});
it('DEFECT rejectProposalV1 rejects the active handshake', async () => {
  await createCoordinatorTransport().rejectProposalV1();
  expect(v1.rejectSession).toHaveBeenCalledWith();
});
