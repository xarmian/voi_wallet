import AsyncStorage from '@react-native-async-storage/async-storage';
import { HandledStore } from '../handledStore';
import {
  requestRefFor,
  proposalRefFor,
  v1ProposalRefFor,
  requestExpiryOf,
} from '../requestRefs';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

beforeEach(async () => {
  await AsyncStorage.clear();
  HandledStore.getInstance().__resetForTests();
});

it('REGRESSION request refs default to v2 and accept v1', () => {
  expect(requestRefFor({ id: 5, topic: 'topic' })).toEqual({
    version: 2,
    kind: 'request',
    topic: 'topic',
    id: 5,
  });
  expect(requestRefFor({ id: '5', topic: 'topic' }, 1)).toEqual({
    version: 1,
    kind: 'request',
    topic: 'topic',
    id: '5',
  });
});

it('REGRESSION proposal refs use the pairing topic', () => {
  expect(proposalRefFor({ id: 5, pairingTopic: 'pairing' })).toEqual({
    version: 2,
    kind: 'proposal',
    topic: 'pairing',
    id: 5,
  });
});

it('DEFECT v1 proposal refs use the emitted id and a stable fallback', () => {
  expect(v1ProposalRefFor({ id: 0 })).toEqual({
    version: 1,
    kind: 'proposal',
    topic: 'v1-proposal',
    id: 0,
  });
  expect(v1ProposalRefFor({ id: '5' }).id).toBe('5');
  expect(v1ProposalRefFor({}).id).toBe('v1');
});

it('REGRESSION request expiry is passed through without coercion', () => {
  expect(
    requestExpiryOf({ params: { request: { expiryTimestamp: 123 } } })
  ).toBe(123);
  expect(
    requestExpiryOf({ params: { request: { expiryTimestamp: 'unknown' } } })
  ).toBe('unknown');
  expect(requestExpiryOf({})).toBeUndefined();
  expect(requestExpiryOf({ params: {} })).toBeUndefined();
});

it('DEFECT numeric 5 and string 5 have the same hashed HandledStore identity', async () => {
  const store = HandledStore.getInstance();
  const numeric = requestRefFor({ id: 5, topic: 'topic' });
  const string = requestRefFor({ id: '5', topic: 'topic' });
  const firstSeen = await store.noteSeen(numeric);
  expect(await store.noteSeen(string)).toBe(firstSeen);
  await store.markHandled(numeric, 'approved');
  expect(store.isHandled(string)).toBe(true);
  const saved = JSON.parse(
    (await AsyncStorage.getItem('@walletconnect_handled_v1')) ?? '{}'
  ) as { e: unknown[] };
  expect(saved.e).toHaveLength(1);
});
