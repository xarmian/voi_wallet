import AsyncStorage from '@react-native-async-storage/async-storage';
import { RequestQueue } from '../requestQueue';
import { settleLegacyQueue } from '../legacyQueueMigration';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const QUEUE_KEY = '@walletconnect_transaction_queue';
const PROCESSING_KEY = '@walletconnect_queue_processing';

const v2Entry = { id: 11, topic: 'topic-a', timestamp: Date.now() };
const v1Entry = { id: 12, topic: 'topic-b', version: 1, timestamp: 1 };

const coordinator = () => ({
  settle: jest.fn(async () => 'settled' as const),
});

async function persist(value: unknown) {
  await AsyncStorage.setItem(
    QUEUE_KEY,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
  await AsyncStorage.setItem(PROCESSING_KEY, 'true');
}
async function expectCleared() {
  expect(await AsyncStorage.getItem(QUEUE_KEY)).toBeNull();
  expect(await AsyncStorage.getItem(PROCESSING_KEY)).toBeNull();
}

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

it('settles every persisted request as expired, v2 and v1, then clears both keys', async () => {
  await persist([v2Entry, v1Entry]);
  const c = coordinator();
  await settleLegacyQueue(c);
  expect(c.settle).toHaveBeenCalledTimes(2);
  expect(c.settle).toHaveBeenCalledWith(
    { version: 2, kind: 'request', topic: 'topic-a', id: 11 },
    'expired'
  );
  expect(c.settle).toHaveBeenCalledWith(
    { version: 1, kind: 'request', topic: 'topic-b', id: 12 },
    'expired'
  );
  await expectCleared();
});

it('does not admit, queue or review anything it finds', async () => {
  await persist([v2Entry]);
  const queue = RequestQueue.getInstance();
  const push = jest.spyOn(queue, 'push');
  await settleLegacyQueue(coordinator());
  expect(push).not.toHaveBeenCalled();
  expect(queue.getSnapshot().head).toBeNull();
  expect(queue.getSnapshot().waiting).toEqual([]);
});

it.each([
  ['unparseable text', 'not json{'],
  ['an object', { id: 1 }],
  ['a number', 7],
])('clears both keys when the stored queue is %s', async (_name, value) => {
  await persist(value);
  const c = coordinator();
  await expect(settleLegacyQueue(c)).resolves.toBeUndefined();
  expect(c.settle).not.toHaveBeenCalled();
  await expectCleared();
});

it('skips a malformed entry and still settles the rest', async () => {
  await persist([{ id: 1 }, null, 'x', { topic: 5, id: 2 }, v2Entry]);
  const c = coordinator();
  await settleLegacyQueue(c);
  expect(c.settle).toHaveBeenCalledTimes(1);
  expect(c.settle).toHaveBeenCalledWith(
    { version: 2, kind: 'request', topic: 'topic-a', id: 11 },
    'expired'
  );
  await expectCleared();
});

it('keeps settling and still clears when one answer is rejected', async () => {
  await persist([v2Entry, v1Entry]);
  const c = coordinator();
  c.settle.mockRejectedValueOnce(new Error('transport down'));
  await expect(settleLegacyQueue(c)).resolves.toBeUndefined();
  expect(c.settle).toHaveBeenCalledTimes(2);
  await expectCleared();
});

it('clears both keys even when the read is rejected', async () => {
  await persist([v2Entry]);
  jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('io'));
  const c = coordinator();
  await expect(settleLegacyQueue(c)).resolves.toBeUndefined();
  expect(c.settle).not.toHaveBeenCalled();
  await expectCleared();
});

it('does not throw when the clear itself is rejected', async () => {
  await persist([v2Entry]);
  jest
    .spyOn(AsyncStorage, 'multiRemove')
    .mockRejectedValueOnce(new Error('io'));
  const c = coordinator();
  await expect(settleLegacyQueue(c)).resolves.toBeUndefined();
  expect(c.settle).toHaveBeenCalledTimes(1);
});

it('does nothing when no queue was persisted', async () => {
  const c = coordinator();
  await settleLegacyQueue(c);
  expect(c.settle).not.toHaveBeenCalled();
  await expectCleared();
});
