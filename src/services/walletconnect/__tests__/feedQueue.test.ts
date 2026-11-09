import AsyncStorage from '@react-native-async-storage/async-storage';
import { HandledStore } from '../handledStore';
import { RequestCoordinator, EXIT_ANSWERS } from '../requestCoordinator';
import type { CoordinatorTransport, RequestRef } from '../requestCoordinator';
import { MAX_WAITING, RequestQueue } from '../requestQueue';
import { feedQueue } from '../feedQueue';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const makeTransport = (): jest.Mocked<CoordinatorTransport> => ({
  rejectRequestV2: jest.fn<
    Promise<void>,
    Parameters<CoordinatorTransport['rejectRequestV2']>
  >(async () => {}),
  rejectRequestV1: jest.fn<
    Promise<void>,
    Parameters<CoordinatorTransport['rejectRequestV1']>
  >(async () => {}),
  rejectProposalV2: jest.fn<
    Promise<void>,
    Parameters<CoordinatorTransport['rejectProposalV2']>
  >(async () => {}),
  rejectProposalV1: jest.fn<
    Promise<void>,
    Parameters<CoordinatorTransport['rejectProposalV1']>
  >(async () => {}),
});

const requestRef = (id: number, version: 1 | 2 = 2): RequestRef => ({
  version,
  kind: 'request',
  topic: 'topic-a',
  id,
});
const proposalRef = (id: number): RequestRef => ({
  version: 2,
  kind: 'proposal',
  topic: 'pairing-a',
  id,
});

let transport: jest.Mocked<CoordinatorTransport>;
let coordinator: RequestCoordinator;
let queue: RequestQueue;

const admitAndFeed = async (ref: RequestRef) => {
  const admission = await coordinator.admit(ref);
  expect(admission.action).toBe('show');
  return feedQueue(
    { ref, payload: { opaque: ref.id }, firstSeenMs: Date.now() },
    { queue, coordinator }
  );
};
const answers = () =>
  Object.values(transport).reduce(
    (count, fn) => count + fn.mock.calls.length,
    0
  );

beforeEach(async () => {
  await AsyncStorage.clear();
  transport = makeTransport();
  coordinator = new RequestCoordinator({
    store: new HandledStore(),
    transport,
  });
  queue = new RequestQueue({ coordinator });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  queue.__resetForTests();
  coordinator.__resetForTests();
  jest.restoreAllMocks();
});

it('a first admitted request becomes the head and nothing is answered or released', async () => {
  const release = jest.spyOn(coordinator, 'release');
  expect(await admitAndFeed(requestRef(1))).toBe('head');
  expect(queue.getSnapshot().head?.ref).toEqual(requestRef(1));
  expect(answers()).toBe(0);
  expect(release).not.toHaveBeenCalled();
});

it('a first admitted proposal becomes the head', async () => {
  expect(await admitAndFeed(proposalRef(1))).toBe('head');
  expect(queue.getSnapshot().head).toMatchObject({
    kind: 'proposal',
    ref: proposalRef(1),
  });
});

it('a second item waits behind the head in arrival order', async () => {
  await admitAndFeed(requestRef(1));
  expect(await admitAndFeed(proposalRef(2))).toBe('queued');
  expect(await admitAndFeed(requestRef(3))).toBe('queued');
  expect(queue.getSnapshot().waiting.map((item) => item.ref.id)).toEqual([
    2, 3,
  ]);
});

it('a ref fed twice is queued once and the second feed answers nothing and releases nothing', async () => {
  const release = jest.spyOn(coordinator, 'release');
  await admitAndFeed(requestRef(1));
  const second = await feedQueue(
    { ref: requestRef(1), payload: {}, firstSeenMs: Date.now() },
    { queue, coordinator }
  );
  expect(second).toBe('duplicate');
  expect(queue.getSnapshot().waiting).toHaveLength(0);
  expect(answers()).toBe(0);
  expect(release).not.toHaveBeenCalled();
});

it('a ref the coordinator no longer has open is not queued, answered or released by the feed', async () => {
  const release = jest.spyOn(coordinator, 'release');
  const ref = requestRef(1);
  await coordinator.admit(ref);
  await coordinator.settle(ref, 'declined');
  const before = answers();
  const outcome = await feedQueue(
    { ref, payload: {}, firstSeenMs: Date.now() },
    { queue, coordinator }
  );
  expect(outcome).toBe('not-open');
  expect(queue.getSnapshot().head).toBeNull();
  expect(answers()).toBe(before);
  expect(release).not.toHaveBeenCalled();
});

it('a ref that was never admitted is not queued and is not answered or closed by the feed', async () => {
  const release = jest.spyOn(coordinator, 'release');
  const ref = requestRef(42);
  const outcome = await feedQueue(
    { ref, payload: {}, firstSeenMs: Date.now() },
    { queue, coordinator }
  );
  expect(outcome).toBe('not-open');
  expect(queue.getSnapshot().head).toBeNull();
  expect(answers()).toBe(0);
  expect(release).not.toHaveBeenCalled();
  // Nothing was recorded for it: a later real arrival is still shown.
  expect((await coordinator.admit(ref)).action).toBe('show');
});

describe.each([
  ['request', (id: number) => requestRef(id)],
  ['proposal', (id: number) => proposalRef(id)],
] as const)('flood: the 11th waiting %s', (_kind, makeRef) => {
  it('is answered busy exactly once, is not queued, and the ten waiting are unchanged', async () => {
    const release = jest.spyOn(coordinator, 'release');
    await admitAndFeed(requestRef(1000));
    for (let id = 1; id <= MAX_WAITING; id += 1) {
      expect(await admitAndFeed(requestRef(id))).toBe('queued');
    }
    const waitingBefore = queue.getSnapshot().waiting.map((i) => i.ref.id);
    expect(answers()).toBe(0);

    const overflow = makeRef(5000);
    expect(await admitAndFeed(overflow)).toBe('full');

    expect(queue.getSnapshot().waiting.map((i) => i.ref.id)).toEqual(
      waitingBefore
    );
    expect(answers()).toBe(1);
    if (overflow.kind === 'request') {
      expect(transport.rejectRequestV2).toHaveBeenCalledWith(
        overflow.topic,
        overflow.id,
        EXIT_ANSWERS.busy
      );
    } else {
      expect(transport.rejectProposalV2).toHaveBeenCalledWith(
        overflow.id,
        overflow.topic,
        EXIT_ANSWERS.busy
      );
    }
    expect(coordinator.isOpen(overflow)).toBe(false);
    expect(release).not.toHaveBeenCalled();
  });

  it('a redelivery of the refused ref is not answered a second time', async () => {
    await admitAndFeed(requestRef(1000));
    for (let id = 1; id <= MAX_WAITING; id += 1)
      await admitAndFeed(requestRef(id));
    const overflow = makeRef(5000);
    await admitAndFeed(overflow);
    const after = answers();
    const redelivery = await coordinator.admit(overflow);
    expect(redelivery.action).not.toBe('show');
    expect(answers()).toBe(after);
  });
});

it('a place frees when a waiting item closes, and the next feed is queued', async () => {
  await admitAndFeed(requestRef(1000));
  for (let id = 1; id <= MAX_WAITING; id += 1)
    await admitAndFeed(requestRef(id));
  expect(await admitAndFeed(requestRef(6000))).toBe('full');
  await coordinator.settle(requestRef(4), 'expired');
  expect(await admitAndFeed(requestRef(6001))).toBe('queued');
});

it('a settle that throws while answering busy does not reject the feed', async () => {
  await admitAndFeed(requestRef(1000));
  for (let id = 1; id <= MAX_WAITING; id += 1)
    await admitAndFeed(requestRef(id));
  jest.spyOn(coordinator, 'settle').mockRejectedValueOnce(new Error('boom'));
  await expect(admitAndFeed(requestRef(7000))).resolves.toBe('full');
});
