import {
  setupOutcomeHarness,
  openOutcome,
  lapse,
  act,
  waitFor,
} from './helpers/reviewOutcomeHarness';
import { flowLapsedSince } from '@/services/auth/flowLapse';

setupOutcomeHarness();

// Real coordinator and durable store, as the lapse suite; only the wire is fake.
import type React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
const callbackRegistry: typeof import('@/services/navigation/callbackRegistry') = require('@/services/navigation/callbackRegistry');
import {
  RequestCoordinator,
  EXIT_ANSWERS,
  type ExitReason,
  type RequestRef,
} from '@/services/walletconnect/requestCoordinator';
import { HandledStore } from '@/services/walletconnect/handledStore';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
const mockRequestRef: RequestRef = {
  version: 2,
  kind: 'request',
  topic: 'outcome-topic',
  id: 'fixture-request',
};
jest.mock('@/screens/wallet/UniversalTransactionSigningScreen', () => {
  const Actual = jest.requireActual(
    '@/screens/wallet/UniversalTransactionSigningScreen'
  ).default;
  return {
    __esModule: true,
    default: (
      props: React.ComponentProps<
        typeof import('../UniversalTransactionSigningScreen').default
      >
    ) => {
      const params = props.route.params;
      return require('react').createElement(Actual, {
        ...props,
        route: {
          ...props.route,
          params: {
            ...params,
            ...(params.walletConnect
              ? {
                  callbackId: 'coordinator-outcome',
                  walletConnect: {
                    ...params.walletConnect,
                    ref: mockRequestRef,
                  },
                }
              : {}),
          },
        },
      });
    },
  };
});
let coordinator: RequestCoordinator;
let onEnd: jest.Mock<Promise<void>, [ExitReason]>;
const wireAnswers: { recorded: boolean; code: number; message: string }[] = [];
beforeEach(async () => {
  await AsyncStorage.clear();
  wireAnswers.length = 0;
  coordinator = new RequestCoordinator({
    store: new HandledStore(),
    transport: {
      rejectRequestV2: async (_topic, _id, error) => {
        const persisted = new HandledStore();
        await persisted.load();
        wireAnswers.push({
          ...error,
          recorded: persisted.isHandled(mockRequestRef),
        });
      },
      rejectRequestV1: async () => {},
      rejectProposalV1: async () => {},
      rejectProposalV2: async () => {},
    },
  });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  await coordinator.admit(mockRequestRef);
  onEnd = jest.fn(async (reason: ExitReason) => {
    await coordinator.settle(mockRequestRef, reason);
  });
  jest
    .spyOn(callbackRegistry, 'getNavigationCallbacks')
    .mockReturnValue({ onEnd });
});
afterEach(() => coordinator.__resetForTests());
const expectEnd = (reason: Exclude<ExitReason, 'session-ended'>) => {
  expect(onEnd).toHaveBeenCalledTimes(1);
  expect(wireAnswers).toEqual([{ ...EXIT_ANSWERS[reason], recorded: true }]);
};

const STOPPED =
  'Your wallet locked or the app went to the background before signing finished. Nothing was sent. Please try again.';
const WC_STOPPED =
  'Your approval ended before signing finished. Try again in the dApp.';

/** An unlocked request with no review grant: entry 1 of 3 is on the device. */
async function noGrantLedger(shape: 'inApp' | 'wc') {
  const h = await openOutcome({
    locked: false,
    ledger: true,
    realSigner: true,
    entries: 3,
    ...(shape === 'inApp' ? { inApp: true } : { waitingKeys: [] }),
  });
  let finish!: (bytes: Uint8Array) => void;
  h.deviceSign.mockImplementationOnce(
    () =>
      new Promise<Uint8Array>((resolve) => {
        finish = resolve;
      })
  );
  h.deviceSign.mockResolvedValue(new Uint8Array([1]));
  await h.ready();
  await waitFor(() => expect(h.deviceSign).toHaveBeenCalledTimes(1));
  return {
    ...h,
    finish: async () => {
      await act(async () => {
        finish(new Uint8Array([1]));
        await Promise.allSettled(h.signerRuns);
      });
    },
  };
}

// Product (11-06): a lock or background stops a Ledger batch before its next
// entry and withholds delivery, whether or not the request holds a grant.
// wc:background already passes before this change: the screen's own background
// handler ends a WalletConnect request (cancel bumps the generation).
it.each(
  (['inApp', 'wc'] as const).flatMap((shape) =>
    (['lock', 'background'] as const).map((reason) => ({ shape, reason }))
  )
)('noGrantLockStopsNextEntry:$shape:$reason', async ({ shape, reason }) => {
  const h = await noGrantLedger(shape);
  await lapse(reason);
  await h.finish();
  expect(h.deviceSign).toHaveBeenCalledTimes(1);
  expect(h.onSuccess).not.toHaveBeenCalled();
  if (shape === 'inApp') {
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith('Request ended', STOPPED);
  } else if (reason === 'lock') {
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith('Request ended', WC_STOPPED);
    expectEnd('lapsed');
  } else {
    expect(h.alert).not.toHaveBeenCalled();
    expectEnd('lapsed');
  }
});

// With no lapse the in-app batch is delivered with the epoch its caller checks
// right before the send.
it('noGrantInAppDeliversLapseEpoch', async () => {
  const h = await noGrantLedger('inApp');
  await h.finish();
  expect(h.deviceSign).toHaveBeenCalledTimes(3);
  expect(h.onSuccess).toHaveBeenCalledTimes(1);
  expect(h.alert).not.toHaveBeenCalled();
  const delivered = (h.onSuccess.mock.calls[0] as unknown[])[0] as {
    lapseEpoch?: number;
  };
  expect(typeof delivered.lapseEpoch).toBe('number');
  expect(flowLapsedSince(delivered.lapseEpoch)).toBe(false);
  await lapse('background');
  expect(flowLapsedSince(delivered.lapseEpoch)).toBe(true);
});
