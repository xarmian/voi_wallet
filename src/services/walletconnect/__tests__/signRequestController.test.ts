import { RequestQueue } from '../requestQueue';
import { getHeadSession } from '@/components/wcHost/headSession';
import { Alert } from 'react-native';
import type { WalletTransaction } from '@/services/walletconnect';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import {
  RequestCoordinator,
  EXIT_ANSWERS,
  type ExitReason,
  type RequestRef,
} from '../requestCoordinator';
import { HandledStore } from '../handledStore';
import { requestRefFor } from '../requestRefs';
import { reviewGrant } from '@/services/auth/reviewGrant';
import { SIGNED_THEN_LAPSED_BATCH_MESSAGE } from '@/services/auth/transactionAuthController';
import type {
  CallbackNavigation,
  NavigationCallbacks,
} from '@/services/navigation/callbackRegistry';
import { makeAccount, paymentTxn } from '@/__tests__/fixtures/algorand';
import { VOI_CHAIN_DATA, ALGORAND_MAINNET_CHAIN_DATA } from '../config';
import { resolveV1Chain } from '../v1/config';
import { AccountType } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import {
  SignRequestController,
  NavigationTargetGoneError,
  type SignRequestSurface,
} from '../signRequestController';

const mockRespond = jest.fn();
const mockApproveV1 = jest.fn();
const mockAccounts = jest.fn();
const mockReject = jest.fn();
const mockRejectV1 = jest.fn();
let mockApproved: string[];
let mockCallbacks: Required<NavigationCallbacks>;
const peerMetadata = {
  name: 'Fixture dApp',
  url: 'https://fixture.invalid',
  icons: ['fixture-icon'],
};

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: {
    getInstance: () => ({
      respondToRequest: mockRespond,
      getApprovedAccountsForChain: () => mockApproved,
      getActiveSessions: () => [
        { topic: 'other', peerMetadata: { name: 'Wrong dApp' } },
        { topic: 'fixture', peerMetadata },
      ],
    }),
  },
}));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: {
    getInstance: () => ({ approveRequest: mockApproveV1 }),
  },
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getAllAccounts: () => mockAccounts() },
}));
jest.mock('@/services/auth/reviewGrant', () => ({
  reviewGrant: { leave: jest.fn(), revoke: jest.fn() },
  walletConnectRequestKey: (topic: string, id: number | string) =>
    JSON.stringify([topic, String(id)]),
}));
jest.mock('@/services/auth/transactionAuthController', () => ({
  SIGNED_THEN_LAPSED_BATCH_MESSAGE: 'Signed result was not returned.',
}));
jest.mock('@/services/navigation/callbackRegistry', () => ({
  registerNavigationCallbacks: (callbacks: Required<NavigationCallbacks>) => {
    mockCallbacks = callbacks;
    return 'callback-id';
  },
}));
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

const owner = makeAccount('controller-owner');
const other = makeAccount('controller-other');
const pool = makeAccount('controller-pool');
const account = {
  id: 'owner',
  address: owner.addr,
  type: AccountType.STANDARD,
  label: 'Owner',
};
const otherAccount = { ...account, id: 'other', address: other.addr };
const txn = Buffer.from(paymentTxn(owner.addr).toByte()).toString('base64');
const poolTxn = Buffer.from(paymentTxn(pool.addr).toByte()).toString('base64');
const entries: WalletTransaction[] = [{ txn, signers: [owner.addr] }];
const event = () => ({
  id: 42,
  topic: 'fixture',
  params: {
    chainId: VOI_CHAIN_DATA.chainId as number | string | undefined,
    request: { method: 'algo_signTxn', params: [entries] },
  },
});
const signed = { signedTransactions: ['signed-fixture'] };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
let coordinator: RequestCoordinator;
let store: HandledStore;
const answers: { recorded: boolean; reason: string; version: number }[] = [];
let durableAtPublish: boolean[];
let ref: RequestRef;

type TakeOutcome = 'empty' | 'advanced' | 'target-gone';
function fakeSurface(result: TakeOutcome = 'empty') {
  const calls: unknown[][] = [];
  const surface = {
    presentReview: jest.fn((params) => {
      calls.push(['review', params]);
    }),
    presentError: jest.fn((message) => {
      calls.push(['error', message]);
    }),
    adoptNavigation: jest.fn((nav) => {
      calls.push(['adopt', nav]);
    }),
    takeNext: jest.fn(async () => {
      calls.push(['takeNext']);
      if (result === 'target-gone') throw new NavigationTargetGoneError();
      return result === 'advanced'
        ? { request: { id: 'next' }, remaining: 1 }
        : { request: null, remaining: 0 };
    }),
    queueSize: jest.fn(async () => 3),
    leave: jest.fn(() => {
      calls.push(['leave']);
    }),
  } satisfies SignRequestSurface;
  return { surface, calls };
}
async function setup(
  requestEvent: unknown = event(),
  version?: number,
  result?: TakeOutcome
) {
  const recording = fakeSurface(result);
  ref = requestRefFor(
    requestEvent as ReturnType<typeof event>,
    version === 1 ? 1 : 2
  );
  await coordinator.admit(ref);
  const controller = new SignRequestController({
    requestEvent,
    version,
    surface: recording.surface,
    coordinator,
  });
  return { ...recording, controller };
}
async function handOff(version?: number) {
  const request = event();
  if (version === 1) {
    request.params.chainId = 416001;
    mockApproved = [`${ALGORAND_MAINNET_CHAIN_DATA.chainId}:${owner.addr}`];
  }
  const h = await setup(request, version);
  await h.controller.start();
  expect(h.surface.presentReview).toHaveBeenCalledTimes(1);
  h.calls.length = 0;
  return h;
}
const expectAnswer = (
  reason: Exclude<ExitReason, 'session-ended'>,
  version = 2,
  recorded = true
) => {
  expect(answers).toEqual([
    { recorded, reason: EXIT_ANSWERS[reason].message, version },
  ]);
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  answers.length = 0;
  durableAtPublish = [];
  store = new HandledStore();
  const answer = async (request: RequestRef, message: string) => {
    const persisted = new HandledStore();
    await persisted.load();
    answers.push({
      recorded: persisted.isHandled(request),
      reason: message,
      version: request.version,
    });
  };
  coordinator = new RequestCoordinator({
    store,
    transport: {
      rejectRequestV2: async (topic, id, error) => {
        await answer({ version: 2, kind: 'request', topic, id }, error.message);
        await mockReject();
      },
      rejectRequestV1: async (id, message) => {
        await answer(
          { version: 1, kind: 'request', topic: 'fixture', id },
          message
        );
        await mockRejectV1();
      },
      rejectProposalV1: async () => {},
      rejectProposalV2: async () => {},
    },
  });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  jest.spyOn(coordinator, 'settle');
  jest.spyOn(coordinator, 'sendError');
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockReject.mockReset().mockResolvedValue(undefined);
  mockRejectV1.mockReset().mockResolvedValue(undefined);
  mockAccounts.mockReset().mockResolvedValue([otherAccount, account]);
  mockApproved = [`${VOI_CHAIN_DATA.chainId}:${owner.addr}`];
  mockRespond.mockReset().mockImplementation(async () => {
    const persisted = new HandledStore();
    await persisted.load();
    durableAtPublish.push(persisted.isHandled(ref));
  });
  mockApproveV1.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  coordinator.__resetForTests();
  jest.restoreAllMocks();
});

it('REGRESSION reject sent records once and leaves with exact toast', async () => {
  const h = await setup();
  await h.controller.reject();
  expectAnswer('declined');
  expect(h.surface.leave).toHaveBeenCalledTimes(1);
  expect(h.surface.takeNext).toHaveBeenCalledWith(false);
  expect(Toast.show).toHaveBeenCalledWith({
    type: 'walletConnectRejected',
    text1: 'Transaction Request Rejected',
    text2: 'You declined to sign this transaction. You can return to the dApp.',
    visibilityTime: 4000,
    position: 'top',
    props: { queueSize: 0 },
  });
});
it('REGRESSION reject fails still advances with durable mark kept', async () => {
  mockReject.mockRejectedValue(new Error('relay down'));
  const h = await setup(undefined, undefined, 'advanced');
  await h.controller.reject();
  expectAnswer('declined');
  expect(store.isHandled(ref)).toBe(true);
  expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
  expect(Toast.show).toHaveBeenCalledWith(
    expect.objectContaining({ props: { queueSize: 2 } })
  );
});
it('REGRESSION v1 reject fails still advances with durable mark kept', async () => {
  mockRejectV1.mockRejectedValue(new Error('bridge down'));
  const h = await setup(undefined, 1);
  await h.controller.reject();
  expectAnswer('declined', 1);
  expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
});
it('DEFECT approve records durably before publishing and never sends an error', async () => {
  const h = await handOff();
  await mockCallbacks.onSuccess(signed);
  await mockCallbacks.onEnd('declined');
  mockCallbacks.onDismiss();
  expect(durableAtPublish).toEqual([true]);
  expect(mockRespond).toHaveBeenCalledWith(
    'fixture',
    42,
    signed.signedTransactions
  );
  expect(coordinator.sendError).not.toHaveBeenCalled();
  expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
  // Only a signed answer that reached the dApp counts as approved.
  expect(h.surface.takeNext).toHaveBeenCalledWith(true);
  expect(Toast.show).toHaveBeenCalledWith({
    type: 'walletConnectSuccess',
    text1: 'Transaction Signed Successfully',
    text2:
      'Your transaction has been signed and sent back to the dApp. You can now return to the dApp.',
    visibilityTime: 5000,
    position: 'top',
    props: { queueSize: 0 },
  });
});
it.each([0, 2])(
  'DEFECT a surface that does not advance never says the next request is processing (queue %s)',
  async (waiting) => {
    const h = await handOff();
    (h.surface as { advancesToNext?: boolean }).advancesToNext = false;
    h.surface.takeNext.mockResolvedValue({ request: null, remaining: waiting });
    await mockCallbacks.onSuccess(signed);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'walletConnectSuccess',
        text2: 'Your transaction has been signed and sent back to the dApp.',
      })
    );
  }
);
it.each([0, 2])(
  'DEFECT a surface that does not advance keeps the decline toast to its first sentence (queue %s)',
  async (waiting) => {
    const h = await setup();
    (h.surface as { advancesToNext?: boolean }).advancesToNext = false;
    h.surface.takeNext.mockResolvedValue({ request: null, remaining: waiting });
    await h.controller.reject();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'walletConnectRejected',
        text2: 'You declined to sign this transaction.',
      })
    );
  }
);
it('REGRESSION approve record fails shows one error and sends lapsed once', async () => {
  const h = await handOff();
  jest
    .spyOn(store, 'markHandled')
    .mockRejectedValueOnce(new Error('write failed'));
  await mockCallbacks.onSuccess(signed);
  mockCallbacks.onDismiss();
  expect(h.surface.presentError.mock.calls).toEqual([
    ['Failed to record the approval'],
  ]);
  expectAnswer('lapsed', 2, false);
  expect(coordinator.sendError).toHaveBeenCalledTimes(1);
  expect(coordinator.sendError).toHaveBeenCalledWith(ref, 'lapsed');
  expect(mockRespond).not.toHaveBeenCalled();
});
it('DEFECT approve after expiry publishes nothing, advances once and alerts', async () => {
  const h = await handOff();
  await coordinator.settle(ref, 'expired');
  await mockCallbacks.onSuccess(signed);
  await mockCallbacks.onEnd('expired');
  expect(mockRespond).not.toHaveBeenCalled();
  expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
  expect(Alert.alert).toHaveBeenCalledWith(
    'Request ended',
    SIGNED_THEN_LAPSED_BATCH_MESSAGE
  );
  expect(Toast.show).not.toHaveBeenCalled();
  expectAnswer('expired');
});
it('REGRESSION response fails shows error and sends lapsed', async () => {
  const h = await handOff();
  mockRespond.mockRejectedValue(new Error('relay down'));
  await mockCallbacks.onSuccess(signed);
  expect(h.surface.presentError.mock.calls).toEqual([['relay down']]);
  expectAnswer('lapsed');
  expect(h.surface.takeNext).not.toHaveBeenCalled();
});
it('REGRESSION response sent but advance fails keeps mark and sends no error', async () => {
  const h = await handOff();
  const failure = new Error('replace failed');
  h.surface.takeNext.mockRejectedValue(failure);
  await mockCallbacks.onSuccess(signed);
  expect(h.surface.presentError.mock.calls).toEqual([['replace failed']]);
  expect(store.isHandled(ref)).toBe(true);
  expect(coordinator.sendError).not.toHaveBeenCalled();
  // One revoke from the failed take, one from the failed answer path.
  expect(reviewGrant.revoke).toHaveBeenCalledTimes(2);
});
it('DEFECT terminal sign-failed answers once and advances once', async () => {
  const h = await handOff();
  await mockCallbacks.onEnd('sign-failed');
  await mockCallbacks.onEnd('declined');
  mockCallbacks.onDismiss();
  expectAnswer('sign-failed');
  expect(coordinator.settle).toHaveBeenCalledTimes(1);
  expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
});
it('REGRESSION missing signed transactions shows one error without advance', async () => {
  const h = await handOff();
  await mockCallbacks.onSuccess({});
  mockCallbacks.onDismiss();
  await flush();
  expectAnswer('sign-failed');
  expect(h.surface.presentError.mock.calls).toEqual([
    ['Failed to sign transactions'],
  ]);
  expect(h.surface.takeNext).not.toHaveBeenCalled();
});

it.each([
  ['malformed params', 'load-failed', 'Malformed request: missing params'],
  [
    'missing transactions',
    'load-failed',
    'Malformed request: missing transactions array',
  ],
  ['missing chain id', 'load-failed', 'Malformed request: missing chain id'],
  [
    'unsupported network',
    'load-failed',
    'This request targets a network this wallet does not support.',
  ],
  [
    'v1 ambiguous chain',
    'load-failed',
    'This WalletConnect v1 session uses a network this wallet cannot identify (v1 sessions carry an ambiguous numeric chain id). Please reconnect the dApp using WalletConnect v2.',
  ],
  [
    'no approved account',
    'unsupported-accounts',
    'This dApp session has no approved account on Voi Network. Reconnect the session and try again.',
  ],
  [
    'no signing account',
    'unsupported-accounts',
    'No account available to sign this request',
  ],
  [
    'unsupported method',
    'unsupported-method',
    'Unsupported request method: unsupported',
  ],
] as const)(
  'DEFECT load failure %s settles right reason and shows exactly one error',
  async (name, reason, message) => {
    const request = event();
    let input: unknown = request;
    if (name === 'malformed params') input = { id: 42, topic: 'fixture' };
    if (name === 'missing transactions') request.params.request.params = [];
    if (name === 'missing chain id') request.params.chainId = undefined;
    if (name === 'unsupported network' || name === 'v1 ambiguous chain')
      request.params.chainId = 'unknown';
    if (name === 'no approved account') mockApproved = [];
    if (name === 'no signing account')
      mockAccounts.mockResolvedValue([otherAccount]);
    if (name === 'unsupported method')
      request.params.request.method = 'unsupported';
    const h = await setup(input, name === 'v1 ambiguous chain' ? 1 : undefined);
    await h.controller.start();
    await flush();
    expect(coordinator.settle).toHaveBeenCalledWith(ref, reason);
    expect(coordinator.settle).toHaveBeenCalledTimes(1);
    expectAnswer(reason, name === 'v1 ambiguous chain' ? 1 : 2);
    expect(h.surface.presentError.mock.calls).toEqual([[message]]);
    expect(h.surface.presentReview).not.toHaveBeenCalled();
    expect(reviewGrant.leave).toHaveBeenCalledWith('["fixture","42"]');
  }
);
it.each(['handled', 'expired', 'unavailable'] as const)(
  'DEFECT restored %s closes before accounts are read',
  async (state) => {
    const h = await setup();
    jest.spyOn(coordinator, 'ensureOpen').mockResolvedValue(state);
    await h.controller.start();
    expect(mockAccounts).not.toHaveBeenCalled();
    expect(h.surface.leave).toHaveBeenCalledTimes(1);
    if (state === 'unavailable') expect(Toast.show).not.toHaveBeenCalled();
    else
      expect(Toast.show).toHaveBeenCalledWith({
        type: 'info',
        text1:
          state === 'expired' ? 'Request expired' : 'Request already handled',
        text2:
          state === 'expired'
            ? 'Try again in the dApp.'
            : 'Check the dApp before you try again.',
      });
  }
);
it('REGRESSION reject double tap takes nothing while first answer is in flight', async () => {
  const pending = deferred<void>();
  mockReject.mockReturnValue(pending.promise);
  const h = await setup();
  const first = h.controller.reject();
  await flush();
  await h.controller.reject();
  expect(coordinator.settle).toHaveBeenCalledTimes(1);
  expect(h.surface.takeNext).not.toHaveBeenCalled();
  pending.resolve();
  await first;
  expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
});
it('REGRESSION StrictMode dispose then start replay is not a departure', async () => {
  mockAccounts.mockReturnValue(new Promise(() => {}));
  const h = await setup();
  void h.controller.start();
  await flush();
  h.controller.dispose();
  void h.controller.start();
  await flush();
  expect(coordinator.settle).not.toHaveBeenCalled();
  expect(reviewGrant.leave).toHaveBeenCalledWith('["fixture","42"]');
  expect(h.surface.leave).not.toHaveBeenCalled();
});
it('REGRESSION leave before hand-off abandons once and leaves own grant', async () => {
  const h = await setup();
  h.controller.leave();
  h.controller.leave();
  await flush();
  expectAnswer('abandoned');
  expect(coordinator.settle).toHaveBeenCalledTimes(1);
  expect(reviewGrant.leave).toHaveBeenCalledWith('["fixture","42"]');
});
it('REGRESSION leave after hand-off does nothing', async () => {
  const h = await handOff();
  h.controller.leave();
  expect(coordinator.settle).not.toHaveBeenCalled();
  expect(reviewGrant.leave).not.toHaveBeenCalled();
});
it('REGRESSION dispose after hand-off does not leave grant', async () => {
  const h = await handOff();
  h.controller.dispose();
  expect(reviewGrant.leave).not.toHaveBeenCalled();
});
it('REGRESSION dispose before hand-off leaves own grant without settling', async () => {
  const h = await setup();
  h.controller.dispose();
  expect(reviewGrant.leave).toHaveBeenCalledWith('["fixture","42"]');
  expect(coordinator.settle).not.toHaveBeenCalled();
});
it('REGRESSION leave during account choice remains pre-hand-off and blocks review', async () => {
  const pending = deferred<(typeof account)[]>();
  mockAccounts.mockReturnValue(pending.promise);
  const h = await setup();
  const loading = h.controller.start();
  await flush();
  h.controller.leave();
  pending.resolve([account]);
  await loading;
  await flush();
  expectAnswer('abandoned');
  expect(h.surface.presentReview).not.toHaveBeenCalled();
});
it.each(['open', 'handled', 'expired'] as const)(
  'REGRESSION ensureOpen %s returning after leave causes no presentation',
  async (state) => {
    const pending = deferred<typeof state>();
    jest.spyOn(coordinator, 'ensureOpen').mockReturnValue(pending.promise);
    const h = await setup();
    const loading = h.controller.start();
    h.controller.leave();
    pending.resolve(state);
    await loading;
    expect(h.surface.takeNext).not.toHaveBeenCalled();
    expect(mockAccounts).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
  }
);
it('REGRESSION dismiss while approval decision is in flight cannot abandon it', async () => {
  const h = await handOff();
  const pending = deferred<boolean>();
  jest.spyOn(coordinator, 'decide').mockReturnValue(pending.promise);
  const approving = mockCallbacks.onSuccess(signed);
  mockCallbacks.onDismiss();
  expect(coordinator.settle).not.toHaveBeenCalled();
  pending.resolve(true);
  await approving;
  expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
});
it('REGRESSION success after reject does not take another request', async () => {
  const h = await handOff();
  await h.controller.reject();
  await mockCallbacks.onSuccess(signed);
  expect(mockRespond).not.toHaveBeenCalled();
  expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
});
it('REGRESSION advanced guard covers success after terminal end even if decide wins', async () => {
  const h = await handOff();
  await mockCallbacks.onEnd('expired');
  jest.spyOn(coordinator, 'decide').mockResolvedValue(true);
  await mockCallbacks.onSuccess(signed);
  expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
});

const liveNavigation: CallbackNavigation = {
  goBack: () => true,
  canGoBack: () => true,
  navigate: () => {},
  replace: () => true,
};
it.each(['success', 'reject', 'end'] as const)(
  'REGRESSION %s adopts callback navigation before outcome',
  async (callback) => {
    const h = await handOff();
    if (callback === 'success')
      await mockCallbacks.onSuccess({}, liveNavigation);
    if (callback === 'reject') await mockCallbacks.onReject(liveNavigation);
    if (callback === 'end')
      await mockCallbacks.onEnd('sign-failed', liveNavigation);
    expect(h.calls[0]).toEqual(['adopt', liveNavigation]);
    expect(h.calls[1][0]).toBe(callback === 'success' ? 'error' : 'takeNext');
  }
);
it.each(['success', 'reject', 'end'] as const)(
  'REGRESSION %s adopts undefined for surface fallback before outcome',
  async (callback) => {
    const h = await handOff();
    if (callback === 'success') await mockCallbacks.onSuccess({});
    if (callback === 'reject') await mockCallbacks.onReject();
    if (callback === 'end') await mockCallbacks.onEnd('sign-failed');
    expect(h.calls[0]).toEqual(['adopt', undefined]);
    expect(h.calls[1][0]).toBe(callback === 'success' ? 'error' : 'takeNext');
  }
);
it('REGRESSION dismiss retains no-navigation contract and abandons once', async () => {
  const h = await handOff();
  mockCallbacks.onDismiss();
  mockCallbacks.onDismiss();
  await flush();
  expectAnswer('abandoned');
  expect(h.surface.adoptNavigation).not.toHaveBeenCalled();
});
it.each(['empty', 'advanced', 'target-gone'] as const)(
  'REGRESSION takeNext %s obeys surface leave contract',
  async (result) => {
    const h = await setup(undefined, undefined, result);
    await h.controller.reject();
    await h.controller.reject();
    expect(h.surface.leave).toHaveBeenCalledTimes(result === 'empty' ? 1 : 0);
    expect(h.surface.takeNext).toHaveBeenCalledTimes(1);
  }
);
describe('the controller owns the signing permission after a take', () => {
  const key = '["fixture","42"]';
  it('DEFECT nothing waiting: leaves this request permission, no revoke', async () => {
    const h = await setup(undefined, undefined, 'empty');
    await h.controller.reject();
    expect(reviewGrant.leave).toHaveBeenCalledWith(key);
    expect(reviewGrant.revoke).not.toHaveBeenCalled();
  });
  it('DEFECT a successor was shown: permission untouched', async () => {
    const h = await setup(undefined, undefined, 'advanced');
    await h.controller.reject();
    expect(reviewGrant.leave).not.toHaveBeenCalled();
    expect(reviewGrant.revoke).not.toHaveBeenCalled();
  });
  it('DEFECT target gone: revokes, no queue-size toast, no throw, no leave of the surface', async () => {
    const h = await setup(undefined, undefined, 'target-gone');
    await h.controller.reject();
    expect(reviewGrant.revoke).toHaveBeenCalledTimes(1);
    expect(h.surface.queueSize).not.toHaveBeenCalled();
    expect(h.surface.leave).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
  });
  it('DEFECT any other take failure: revokes, toasts the queued count, rethrows', async () => {
    const h = await setup();
    const failure = new Error('persist failed');
    h.surface.takeNext.mockRejectedValue(failure);
    await expect(h.controller.reject()).rejects.toBe(failure);
    expect(reviewGrant.revoke).toHaveBeenCalledTimes(1);
    expect(h.surface.queueSize).toHaveBeenCalledTimes(1);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'walletConnectRejected',
        props: { queueSize: 3 },
      })
    );
  });
  it('DEFECT the success toast counts the shown request plus those remaining', async () => {
    const h = await handOff();
    h.surface.takeNext.mockResolvedValue({
      request: { id: 'next' },
      remaining: 2,
    });
    await mockCallbacks.onSuccess(signed);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'walletConnectSuccess',
        props: { queueSize: 3 },
      })
    );
  });
});
it('REGRESSION takeNext throw propagates unchanged from reject', async () => {
  const h = await setup();
  const failure = new Error('surface failed');
  h.surface.takeNext.mockRejectedValue(failure);
  await expect(h.controller.reject()).rejects.toBe(failure);
  expect(h.surface.leave).not.toHaveBeenCalled();
});
it('REGRESSION takeNext throw from closed admission is caught as load failure', async () => {
  const h = await setup();
  jest.spyOn(coordinator, 'ensureOpen').mockResolvedValue('handled');
  h.surface.takeNext.mockRejectedValue(new Error('surface failed'));
  await h.controller.start();
  expect(h.surface.presentError.mock.calls).toEqual([['surface failed']]);
  expect(coordinator.settle).toHaveBeenCalledWith(ref, 'load-failed');
});
it('REGRESSION v2 signing params exactly bind approved owned sender and active peer', async () => {
  const h = await handOff();
  expect(h.surface.presentReview.mock.calls).toEqual([
    [
      {
        transactions: [txn],
        account,
        chainId: VOI_CHAIN_DATA.chainId,
        networkId: NetworkId.VOI_MAINNET,
        title: 'WalletConnect Request',
        callbackId: 'callback-id',
        walletConnect: {
          ref: { version: 2, kind: 'request', topic: 'fixture', id: 42 },
          transactions: entries,
          binding: {
            topic: 'fixture',
            chainId: VOI_CHAIN_DATA.chainId,
            networkId: NetworkId.VOI_MAINNET,
            approvedAccounts: [`${VOI_CHAIN_DATA.chainId}:${owner.addr}`],
          },
          requestKey: '["fixture","42"]',
          dapp: {
            name: 'Fixture dApp',
            url: 'https://fixture.invalid',
            icon: 'fixture-icon',
          },
        },
      },
    ],
  ]);
});
it('REGRESSION v1 signing params chain comes from resolveV1Chain and uses v1 approve', async () => {
  const h = await handOff(1);
  const params = h.surface.presentReview.mock.calls[0][0];
  expect({ chainId: params.chainId, networkId: params.networkId }).toEqual(
    resolveV1Chain(416001)
  );
  expect(params.walletConnect.ref.version).toBe(1);
  await mockCallbacks.onSuccess(signed);
  expect(mockApproveV1).toHaveBeenCalledWith(42, signed.signedTransactions);
  expect(mockRespond).not.toHaveBeenCalled();
});
it.each([undefined, 0, 2, 7])(
  'REGRESSION raw version %s keeps v2 semantics',
  async (version) => {
    const h = await handOff(version);
    expect(
      h.surface.presentReview.mock.calls[0][0].walletConnect.ref.version
    ).toBe(2);
    await mockCallbacks.onSuccess(signed);
    expect(mockRespond).toHaveBeenCalledTimes(1);
    expect(mockApproveV1).not.toHaveBeenCalled();
  }
);
it('REGRESSION pool first and undecodable entry are skipped for first approved owned sender', async () => {
  const request = event();
  request.params.request.params = [
    [{ txn: poolTxn, signers: [] }, { txn: 'undecodable' }, ...entries],
  ];
  mockApproved.push(`${VOI_CHAIN_DATA.chainId}:${pool.addr}`);
  const h = await setup(request);
  await h.controller.start();
  expect(h.surface.presentReview.mock.calls[0][0].account).toEqual(account);
  expect(h.surface.presentReview.mock.calls[0][0].transactions).toEqual([
    poolTxn,
    'undecodable',
    txn,
  ]);
});
it('REGRESSION default coordinator is the existing singleton', async () => {
  const h = fakeSurface();
  const controller = new SignRequestController({
    requestEvent: event(),
    surface: h.surface,
  });
  await controller.start();
  expect(RequestCoordinator.getInstance).toHaveBeenCalled();
  expect(h.surface.presentReview).toHaveBeenCalledTimes(1);
});
it('REGRESSION hand-off remains unset during synchronous account choice', async () => {
  const h = await setup();
  const accounts = [account];
  jest.spyOn(accounts, 'find').mockImplementation((predicate) => {
    h.controller.leave();
    return [account].find(predicate);
  });
  mockAccounts.mockResolvedValue(accounts);
  await h.controller.start();
  await flush();
  expectAnswer('abandoned');
  expect(reviewGrant.leave).toHaveBeenCalledWith('["fixture","42"]');
});

it('REGRESSION signing account follows sender order among approved owned accounts', async () => {
  const request = event();
  const otherTxn = Buffer.from(paymentTxn(other.addr).toByte()).toString(
    'base64'
  );
  request.params.request.params = [[...entries, { txn: otherTxn }]];
  mockApproved.push(`${VOI_CHAIN_DATA.chainId}:${other.addr}`);
  const h = await setup(request);
  await h.controller.start();
  expect(h.surface.presentReview.mock.calls[0][0].account).toEqual(account);
});

it('REGRESSION real coordinator approved signing leaves lastReason undefined', async () => {
  await handOff();
  const queue = new RequestQueue({ coordinator });
  queue.push({ ref, payload: event(), firstSeenMs: Date.now() });
  const session = getHeadSession(queue.getSnapshot().head!, {
    queue,
    coordinator,
  });
  await mockCallbacks.onSuccess(signed);
  expect(coordinator.isOpen(ref)).toBe(false);
  expect(session.lastReason).toBeUndefined();
  session.end();
  queue.__resetForTests();
});
it.each([false, true])(
  'DEFECT close during accounts await closed=%s prevents callback registration and review',
  async (closed) => {
    const pending = deferred<(typeof account)[]>();
    mockAccounts.mockReturnValue(pending.promise);
    const h = await setup();
    const loading = h.controller.start();
    await flush();
    const previous = mockCallbacks;
    if (closed) await coordinator.settle(ref, 'expired');
    pending.resolve([account]);
    await loading;
    expect(h.surface.presentReview).toHaveBeenCalledTimes(closed ? 0 : 1);
    if (closed) expect(mockCallbacks).toBe(previous);
    else expect(mockCallbacks).not.toBe(previous);
    // The surface is told, so a route screen is not left on its spinner.
    expect(h.surface.takeNext).toHaveBeenCalledTimes(closed ? 1 : 0);
  }
);

it.each([
  ['load-failed', 'Malformed request: missing params'],
  ['sign-failed', 'Failed to sign transactions'],
  ['decide-threw', 'Failed to record the approval'],
] as const)(
  'DEFECT real coordinator and controller %s preserve error after synchronous close',
  async (path, message) => {
    const request =
      path === 'load-failed' ? { id: 42, topic: 'fixture' } : event();
    ref = requestRefFor(request, 2);
    await coordinator.admit(ref);
    const queue = new RequestQueue({ coordinator });
    queue.push({ ref, payload: request, firstSeenMs: Date.now() });
    const session = getHeadSession(queue.getSnapshot().head!, {
      queue,
      coordinator,
    });
    await session.controller!.start();
    if (path === 'sign-failed') await mockCallbacks.onSuccess({});
    if (path === 'decide-threw') {
      jest
        .spyOn(store, 'markHandled')
        .mockRejectedValueOnce(new Error('storage unavailable'));
      await mockCallbacks.onSuccess(signed);
    }
    await flush();
    expect(queue.getSnapshot().result?.title).toBe(message);
    expect(queue.getSnapshot().head).toBeNull();
    queue.__resetForTests();
  }
);

describe('the host ends a head whose request the controller still owns', () => {
  async function hostHead() {
    const request = event();
    ref = requestRefFor(request, 2);
    await coordinator.admit(ref);
    const queue = new RequestQueue({ coordinator });
    queue.push({ ref, payload: request, firstSeenMs: Date.now() });
    const session = getHeadSession(queue.getSnapshot().head!, {
      queue,
      coordinator,
    });
    // TransactionReview reports its departure to the controller like this.
    session.binding.onLeave(() => mockCallbacks?.onDismiss?.());
    return { queue, session };
  }

  it('DEFECT a head ended while its accounts load settles abandoned and answers the dApp once', async () => {
    const pending = deferred<(typeof account)[]>();
    mockAccounts.mockReturnValue(pending.promise);
    const { queue, session } = await hostHead();
    const loading = session.controller!.start();
    await flush();
    const previous = mockCallbacks;
    expect(session.binding.nav.goBack()).toBe(true);
    await flush();
    expect(coordinator.isOpen(ref)).toBe(false);
    expectAnswer('abandoned');
    pending.resolve([account]);
    await loading;
    expect(mockCallbacks).toBe(previous);
    expect(queue.getSnapshot().result?.title).toBe('Request ended');
    expectAnswer('abandoned');
    queue.__resetForTests();
  });

  it('DEFECT a head ended while presented abandons through the review departure once', async () => {
    const { queue, session } = await hostHead();
    await session.controller!.start();
    expect(session.binding.nav.goBack()).toBe(true);
    await flush();
    expectAnswer('abandoned');
    expect(queue.getSnapshot().result?.title).toBe('Request ended');
    queue.__resetForTests();
  });

  it('DEFECT a signed answer that reaches the dApp after the host ended the review corrects the card', async () => {
    const { queue, session } = await hostHead();
    await session.controller!.start();
    const pending = deferred<void>();
    mockRespond.mockImplementationOnce(() => pending.promise);
    const answering = mockCallbacks.onSuccess(signed);
    await flush();
    expect(session.binding.nav.goBack()).toBe(true);
    expect(queue.getSnapshot().result?.title).toBe('Request ended');
    pending.resolve();
    await answering;
    expect(mockRespond).toHaveBeenCalledTimes(1);
    expect(answers).toEqual([]);
    expect(queue.getSnapshot().result).toMatchObject({
      title: 'Transaction Signed Successfully',
      message: 'You can now return to the dApp.',
    });
    queue.__resetForTests();
  });
});

describe('admission running (a request the coordinator has not opened yet)', () => {
  async function admissionPending() {
    const request = event();
    ref = requestRefFor(request, 2);
    const loaded = deferred<void>();
    const load = store.load.bind(store);
    jest.spyOn(store, 'load').mockImplementation(async () => {
      await loaded.promise;
      return load();
    });
    const admitting = coordinator.admit(ref);
    await flush();
    expect(coordinator.isOpen(ref)).toBe(false);
    return { request, loaded, admitting };
  }

  it('DEFECT host side: the queue refuses the ref until the coordinator opens it, so the host never draws it', async () => {
    const { request, loaded, admitting } = await admissionPending();
    const queue = new RequestQueue({ coordinator });
    expect(queue.push({ ref, payload: request, firstSeenMs: 0 })).toBe(
      'not-open'
    );
    expect(queue.getSnapshot().head).toBeNull();
    loaded.resolve();
    await admitting;
    expect(coordinator.isOpen(ref)).toBe(true);
    expect(queue.push({ ref, payload: request, firstSeenMs: 0 })).toBe('head');
    queue.__resetForTests();
  });

  it('REGRESSION route side (base behaviour, filed): a duplicate admission still running reaches a review while the coordinator has not opened the request', async () => {
    const { request, loaded } = await admissionPending();
    const h = fakeSurface();
    const controller = new SignRequestController({
      requestEvent: request,
      surface: h.surface,
      coordinator,
    });
    await controller.start();
    // The controller treats a duplicate as open and presents the review...
    expect(h.surface.presentReview).toHaveBeenCalledTimes(1);
    // ...while the coordinator has not opened the request. Whether the review
    // then refuses to start signing (isLive) is covered where it is decided, in
    // UniversalTransactionSigningScreen.outcome.test.tsx.
    expect(coordinator.isLive(ref)).toBe(false);
    loaded.resolve();
    await flush();
  });
});
