import { MultiAccountWalletService } from '@/services/wallet';
import { SecureKeyManager as Keys } from '@/services/secure/keyManager';
import { resolveProposalEligibility } from '../utils';
jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: { getSigningInfo: jest.fn() },
}));
/**
 * TASK-240 / HT-249 — config-gated WalletConnect chain approval.
 *
 * `approveSession`'s chain policy is gated on the experimentalStore
 * `allowUnsupportedNetworks` flag (default OFF):
 *   - OFF (default, typical users) → STRICT: reject a proposal whose REQUIRED
 *     namespaces contain ANY unsupported chain; when the required chains are all
 *     supported, approve only the SUPPORTED chains and DROP unsupported OPTIONAL
 *     chains (rather than approving them).
 *   - ON (developers) → permissive union of ALL requested chains, incl. unknown
 *     ones (e.g. a local devnet).
 *
 * These tests drive the real `approveSession` with the WC sign client, the
 * `@walletconnect/utils` namespace builder, and the store flag mocked, and
 * assert on which chains we hand to `signClient.approve` (or whether we reject).
 */
import { AccountType, AccountMetadata } from '@/types/wallet';
import { VOI_CHAIN_DATA, ALGORAND_MAINNET_CHAIN_DATA } from '../config';
import { SessionProposal } from '../types';

const VOI = VOI_CHAIN_DATA.chainId;
const ALGO = ALGORAND_MAINNET_CHAIN_DATA.chainId;
const UNSUPPORTED = 'eip155:1';

// index.ts imports AsyncStorage at load time; use the library's official jest
// mock so the native module resolves under the test runtime.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Mock the sign client so getInstance()/getProvider() never load the real
// @walletconnect/universal-provider (native/network init).
const mockApprove = jest.fn(async () => ({ topic: 'session-topic' }));
const mockReject = jest.fn(async () => undefined);
const mockSessionGet = jest.fn(() => ({
  topic: 'session-topic',
  namespaces: {},
  peer: { metadata: { name: 'dApp' } },
}));
const mockSignClient = {
  approve: mockApprove,
  reject: mockReject,
  session: { get: mockSessionGet },
};
jest.mock('../client', () => ({
  WalletConnectClient: {
    getInstance: () => ({
      getProvider: () => ({ client: mockSignClient }),
    }),
  },
}));

// buildApprovedNamespaces echoes our supportedNamespaces so assertions target
// the chains WE selected (not the SDK's internal validation); getSdkError
// returns a recognizable object so we can check the rejection reason.
jest.mock('@walletconnect/utils', () => ({
  getSdkError: (key: string) => ({ code: 5100, message: key }),
  buildApprovedNamespaces: jest.fn(
    ({ supportedNamespaces }: { supportedNamespaces: unknown }) =>
      supportedNamespaces
  ),
}));

// The flag under test, flipped per-test.
let mockAllowUnsupportedNetworks = false;
jest.mock('@/store/experimentalStore', () => ({
  useExperimentalStore: {
    getState: () => ({
      allowUnsupportedNetworks: mockAllowUnsupportedNetworks,
    }),
  },
}));

// Heavy service deps index.ts imports at load time — stub so the module graph
// resolves without native modules. approveSession is called with explicit
// accounts here, so getSignableAccounts (MultiAccountWalletService) is unused.
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getAllAccounts: jest.fn(async () => []) },
}));

jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: {
    getInstance: () => ({ getSessionData: () => null }),
  },
}));

import { WalletConnectService } from '../index';

const account = (address: string): AccountMetadata =>
  ({
    id: address,
    address,
    type: AccountType.STANDARD,
    label: 'Test',
    color: '#000000',
  }) as unknown as AccountMetadata;

const proposalWith = (
  required?: string[],
  optional?: string[]
): SessionProposal =>
  ({
    id: 1,
    pairingTopic: 'pairing-topic',
    proposer: {
      publicKey: 'proposer-pk',
      metadata: { name: 'dApp', description: '', url: '', icons: [] },
    },
    requiredNamespaces: required
      ? { algorand: { chains: required, methods: [], events: [] } }
      : {},
    optionalNamespaces: optional
      ? { algorand: { chains: optional, methods: [], events: [] } }
      : undefined,
    expiryTimestamp: 0,
  }) as SessionProposal;

// `mock.calls` is typed as an array of empty-arg tuples (the mock's declared
// implementations take no params), so cast before indexing the recorded call.
const approvedChains = (): string[] =>
  (mockApprove.mock.calls as any)[0][0].namespaces.algorand.chains;

describe('WalletConnectService.approveSession — config-gated chain policy', () => {
  let service: WalletConnectService;

  beforeEach(() => {
    // jest.config.js sets clearMocks:true (mock.calls reset before each test);
    // clear explicitly too so each assertion reads only its own test's calls.
    jest.clearAllMocks();
    mockAllowUnsupportedNetworks = false;
    jest.mocked(Keys.getSigningInfo).mockResolvedValue({
      canSign: true,
      signingAddress: 'AAAA',
      isRekeyed: false,
    });
    service = WalletConnectService.getInstance();
  });

  describe('flag OFF (default, strict per-chain policy)', () => {
    it('REJECTS a proposal whose required chains include an unsupported chain', async () => {
      await expect(
        service.approveSession(proposalWith([VOI, UNSUPPORTED]), [
          account('AAAA'),
        ])
      ).rejects.toThrow(/Session approval failed/);

      // The dApp gets a protocol-level rejection with the UNSUPPORTED_CHAINS
      // reason, and the session is NOT approved.
      expect(mockReject).toHaveBeenCalledTimes(1);
      expect((mockReject.mock.calls as any)[0][0].reason.message).toBe(
        'UNSUPPORTED_CHAINS'
      );
      expect(mockApprove).not.toHaveBeenCalled();
    });

    it('REJECTS when a non-algorand required namespace carries an unsupported chain', async () => {
      const proposal = {
        ...proposalWith([VOI]),
        requiredNamespaces: {
          algorand: { chains: [VOI], methods: [], events: [] },
          eip155: { chains: [UNSUPPORTED], methods: [], events: [] },
        },
      } as SessionProposal;

      await expect(
        service.approveSession(proposal, [account('AAAA')])
      ).rejects.toThrow(/Session approval failed/);
      expect(mockApprove).not.toHaveBeenCalled();
    });

    it('APPROVES a supported-only proposal, DROPPING unsupported OPTIONAL chains', async () => {
      await service.approveSession(proposalWith([VOI], [ALGO, UNSUPPORTED]), [
        account('AAAA'),
      ]);

      expect(mockReject).not.toHaveBeenCalled();
      expect(mockApprove).toHaveBeenCalledTimes(1);
      const chains = approvedChains();
      expect(new Set(chains)).toEqual(new Set([VOI, ALGO]));
      expect(chains).not.toContain(UNSUPPORTED);
    });

    it('falls back to the default chains when no chains are requested', async () => {
      await service.approveSession(proposalWith(), [account('AAAA')]);
      expect(mockReject).not.toHaveBeenCalled();
      expect(new Set(approvedChains())).toEqual(new Set([VOI, ALGO]));
    });
  });

  describe('flag ON (developer, permissive union)', () => {
    beforeEach(() => {
      mockAllowUnsupportedNetworks = true;
    });

    it('APPROVES a proposal whose required chains include an unsupported chain', async () => {
      await service.approveSession(proposalWith([VOI, UNSUPPORTED]), [
        account('AAAA'),
      ]);

      expect(mockReject).not.toHaveBeenCalled();
      expect(mockApprove).toHaveBeenCalledTimes(1);
      const chains = approvedChains();
      expect(chains).toContain(UNSUPPORTED);
      expect(chains).toContain(VOI);
    });

    it('unions unsupported OPTIONAL chains too', async () => {
      await service.approveSession(proposalWith([VOI], [UNSUPPORTED]), [
        account('AAAA'),
      ]);
      const chains = approvedChains();
      expect(chains).toContain(UNSUPPORTED);
      expect(chains).toContain(VOI);
    });
  });
});

describe('proposal signing authority', () => {
  beforeEach(() => {
    mockAllowUnsupportedNetworks = false;
    jest.mocked(Keys.getSigningInfo).mockReset();
  });
  const rekeyed = {
    ...account('RK'),
    type: AccountType.REKEYED,
    canSign: false,
  } as AccountMetadata;
  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    'strict answer overrides persisted canSign=%s, fallback=%s',
    async (canSign, fallback) => {
      jest
        .mocked(Keys.getSigningInfo)
        .mockImplementation(async (_, network) => ({
          signingAddress: 'RK',
          isRekeyed: true,
          canSign: network === 'voi-mainnet',
        }));
      const selected = [{ ...rekeyed, canSign } as AccountMetadata];
      jest
        .mocked(MultiAccountWalletService.getAllAccounts)
        .mockResolvedValue(selected);
      await WalletConnectService.getInstance().approveSession(
        proposalWith([VOI], [ALGO]),
        fallback ? undefined : selected
      );
      expect(Keys.getSigningInfo).toHaveBeenCalledWith('RK', 'voi-mainnet');
      expect(Keys.getSigningInfo).toHaveBeenCalledWith(
        'RK',
        'algorand-mainnet'
      );
      expect(
        (mockApprove.mock.calls as any)[0][0].namespaces.algorand.accounts
      ).toEqual([`${VOI}:RK`]);
    }
  );
  it('excludes and records probe errors; rejects an empty required chain before SDK approval', async () => {
    jest.mocked(Keys.getSigningInfo).mockRejectedValue(new Error('offline'));
    jest.mocked(Keys.getSigningInfo).mockImplementation(async (_, network) => {
      if (network === 'algorand-mainnet') throw new Error('offline');
      return { signingAddress: 'RK', isRekeyed: true, canSign: true };
    });
    expect(await resolveProposalEligibility([rekeyed], [VOI, ALGO])).toEqual([
      { account: rekeyed, eligibleChains: [VOI], errorChains: [ALGO] },
    ]);
    await WalletConnectService.getInstance().approveSession(
      proposalWith([VOI], [ALGO]),
      [rekeyed]
    );
    expect(
      (mockApprove.mock.calls as any)[0][0].namespaces.algorand.accounts
    ).toEqual([`${VOI}:RK`]);
    mockApprove.mockClear();
    await expect(
      WalletConnectService.getInstance().approveSession(proposalWith([ALGO]), [
        rekeyed,
      ])
    ).rejects.toThrow('No signable accounts available for required chain');
    expect(mockApprove).not.toHaveBeenCalled();
  });
  it('includes STANDARD but excludes REKEYED on unknown chains in permissive mode', async () => {
    mockAllowUnsupportedNetworks = true;
    await WalletConnectService.getInstance().approveSession(
      proposalWith([UNSUPPORTED]),
      [rekeyed, account('STD')]
    );
    expect(
      (mockApprove.mock.calls as any)[0][0].namespaces.algorand.accounts
    ).toEqual([`${UNSUPPORTED}:STD`]);
    expect(Keys.getSigningInfo).not.toHaveBeenCalled();
  });
});

it('approves only covered Voi using the real SDK namespace builder', async () => {
  jest.mocked(Keys.getSigningInfo).mockImplementation(async (_, network) => ({
    canSign: network === 'voi-mainnet',
    signingAddress: 'RK',
    isRekeyed: true,
  }));
  const { buildApprovedNamespaces } = require('@walletconnect/utils');
  buildApprovedNamespaces.mockImplementationOnce(
    jest.requireActual('@walletconnect/utils').buildApprovedNamespaces
  );
  await WalletConnectService.getInstance().approveSession(
    proposalWith([VOI], [ALGO]),
    [account('RK')]
  );
  expect(approvedChains()).toEqual([VOI]);
  expect(
    (mockApprove.mock.calls as any)[0][0].namespaces.algorand.accounts
  ).toEqual([`${VOI}:RK`]);
});
