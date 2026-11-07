import AsyncStorage from '@react-native-async-storage/async-storage';
import { HandledStore } from '../handledStore';
import {
  RequestCoordinator,
  type CoordinatorTransport,
  type RequestRef,
} from '../requestCoordinator';
import { RequestQueue } from '../requestQueue';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// Population table T2 (ruled by the dev lead): a head that was never drawn, and
// the items waiting behind it, while the app stack refuses to draw (the host
// creates no session then). The deadline is the bound: every one is answered
// 'expired' and the queue holds no head and no waiting item.
let now: number;
let coordinator: RequestCoordinator;
let queue: RequestQueue;
let transport: jest.Mocked<CoordinatorTransport>;
const refFor = (id: number, kind: 'request' | 'proposal'): RequestRef => ({
  version: 2,
  kind,
  topic: kind === 'request' ? 'topic' : 'pairing',
  id,
});

beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  now = 1_800_000_000_000;
  jest.setSystemTime(now);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  transport = {
    rejectRequestV2: jest.fn(async () => {}),
    rejectRequestV1: jest.fn(async () => {}),
    rejectProposalV2: jest.fn(async () => {}),
    rejectProposalV1: jest.fn(async () => {}),
  };
  coordinator = new RequestCoordinator({
    store: new HandledStore({ now: () => Date.now() }),
    transport,
    now: () => Date.now(),
  });
  queue = new RequestQueue({ coordinator });
});
afterEach(() => {
  queue.__resetForTests();
  coordinator.__resetForTests();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('DEFECT an undrawn head and its waiting items are each answered expired at their deadline and the queue empties', async () => {
  const expiry = (offsetMs: number) => (Date.now() + offsetMs) / 1000;
  const refs = [
    refFor(1, 'request'),
    refFor(2, 'request'),
    refFor(3, 'proposal'),
  ];
  const offsets = [60_000, 120_000, 120_000];
  for (const [index, ref] of refs.entries()) {
    expect(await coordinator.admit(ref, expiry(offsets[index]))).toMatchObject({
      action: 'show',
    });
    expect(queue.push({ ref, payload: {}, firstSeenMs: Date.now() })).toBe(
      index === 0 ? 'head' : 'queued'
    );
  }
  expect(queue.getSnapshot().head?.ref.id).toBe(1);
  expect(queue.getSnapshot().waiting).toHaveLength(2);

  await jest.advanceTimersByTimeAsync(61_000);
  // The head's deadline passed: its card is written, and it is no longer a head.
  expect(queue.getSnapshot().head).toBeNull();
  expect(queue.getSnapshot().result?.title).toBe('Request ended');
  expect(transport.rejectRequestV2).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(60_000);
  // The items stuck behind the card clear on their own deadlines.
  expect(queue.getSnapshot().waiting).toHaveLength(0);
  expect(transport.rejectRequestV2).toHaveBeenCalledTimes(2);
  expect(transport.rejectProposalV2).toHaveBeenCalledTimes(1);
  for (const call of transport.rejectRequestV2.mock.calls)
    expect(call[2]).toEqual({ code: -32000, message: 'Request expired.' });
  expect(transport.rejectProposalV2.mock.calls[0][2]).toEqual({
    code: -32000,
    message: 'Request expired.',
  });
});
