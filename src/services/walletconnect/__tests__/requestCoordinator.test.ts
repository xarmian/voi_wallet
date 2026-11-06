import AsyncStorage from '@react-native-async-storage/async-storage';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HandledStore, HandledOutcome } from '../handledStore';
import {
  RequestCoordinator,
  RequestRef,
  CoordinatorTransport,
  ExitReason,
  EXIT_ANSWERS,
  AnswerError,
} from '../requestCoordinator';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const ref: RequestRef = {
  version: 2,
  kind: 'request',
  topic: 'test-topic',
  id: 'test-id',
};
let now: number;
let store: HandledStore;
let transport: jest.Mocked<CoordinatorTransport>;
let coordinator: RequestCoordinator;
const makeTransport = (): jest.Mocked<CoordinatorTransport> => ({
  rejectRequestV2: jest.fn(
    async (_topic: string, _id: number | string, _error: AnswerError) => {}
  ),
  rejectRequestV1: jest.fn(
    async (_id: number | string, _message: string) => {}
  ),
  rejectProposalV2: jest.fn(
    async (_id: number | string, _topic: string, _error: AnswerError) => {}
  ),
  rejectProposalV1: jest.fn(async () => {}),
});
const calls = () =>
  Object.values(transport).reduce(
    (count, fn) => count + fn.mock.calls.length,
    0
  );
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeEach(async () => {
  jest.useFakeTimers();
  await AsyncStorage.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  now = 1_800_000_000_000;
  store = new HandledStore({ now: () => now });
  transport = makeTransport();
  coordinator = new RequestCoordinator({ store, transport, now: () => now });
});
afterEach(() => {
  coordinator.__resetForTests();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('DEFECT a new request is shown with its dapp deadline without an answer', async () => {
  expect(await coordinator.admit(ref, (now + 900_000) / 1000)).toEqual({
    action: 'show',
    ref,
    firstSeenMs: now,
    deadlineMs: now + 900_000,
    source: 'dapp',
  });
  expect(coordinator.isOpen(ref)).toBe(true);
  expect(coordinator.isLive(ref)).toBe(true);
  now += 900_000;
  expect(coordinator.isLive(ref)).toBe(false);
  expect(calls()).toBe(0);
});

it.each(['request', 'proposal'] as const)(
  'DEFECT handled %s replay after restart is suppressed and answered once',
  async (kind) => {
    const replay = { ...ref, kind };
    await store.markHandled(replay, 'approved');
    store = new HandledStore({ now: () => now });
    coordinator = new RequestCoordinator({ store, transport, now: () => now });
    expect(await coordinator.admit(replay)).toEqual({
      action: 'suppressed',
      reason: 'handled',
    });
    const error = { code: -32000, message: 'Request already handled.' };
    if (kind === 'request')
      expect(transport.rejectRequestV2).toHaveBeenCalledWith(
        ref.topic,
        ref.id,
        error
      );
    else
      expect(transport.rejectProposalV2).toHaveBeenCalledWith(
        ref.id,
        ref.topic,
        error
      );
    expect(calls()).toBe(1);
    const writes = jest.mocked(AsyncStorage.setItem).mock.calls.length;
    transport.rejectRequestV2.mockRejectedValue(new Error('publish failed'));
    transport.rejectProposalV2.mockRejectedValue(new Error('publish failed'));
    await expect(coordinator.admit(replay)).resolves.toEqual({
      action: 'suppressed',
      reason: 'handled',
    });
    expect(AsyncStorage.setItem).toHaveBeenCalledTimes(writes);
  }
);

it('DEFECT past dapp expiry is answered expired without showing', async () => {
  expect(await coordinator.admit(ref, now - 1)).toEqual({ action: 'expired' });
  expect(coordinator.isOpen(ref)).toBe(false);
  expect(transport.rejectRequestV2).toHaveBeenCalledWith(ref.topic, ref.id, {
    code: -32000,
    message: 'Request expired.',
  });
});
it.each([5, 6])(
  'DEFECT restart at %i minutes does not refresh the wallet deadline',
  async (minutes) => {
    await store.noteSeen(ref);
    now += minutes * 60_000;
    store = new HandledStore({ now: () => now });
    coordinator = new RequestCoordinator({ store, transport, now: () => now });
    expect(await coordinator.admit(ref)).toEqual({ action: 'expired' });
    expect(transport.rejectRequestV2).toHaveBeenCalledWith(
      ref.topic,
      ref.id,
      EXIT_ANSWERS.expired
    );
  }
);

it('DEFECT settle records before calling the transport', async () => {
  await coordinator.admit(ref);
  const handledAtPublish: boolean[] = [];
  transport.rejectRequestV2.mockImplementation(async () => {
    handledAtPublish.push(store.isHandled(ref));
    expect(store.isHandled(ref)).toBe(true);
  });
  expect(await coordinator.settle(ref, 'declined')).toBe('settled');
  expect(transport.rejectRequestV2).toHaveBeenCalledTimes(1);
  // Assertions inside transport can be swallowed by best-effort publication.
  expect(handledAtPublish).toEqual([true]);
});
it('DEFECT settle is single-flight and idempotent; settle after decide sends nothing', async () => {
  await coordinator.admit(ref);
  const first = coordinator.settle(ref, 'declined');
  expect(coordinator.isOpen(ref)).toBe(false);
  const second = coordinator.settle({ ...ref }, 'expired');
  expect(await second).toBe('already-settled');
  expect(await first).toBe('settled');
  expect(await coordinator.settle(ref, 'abandoned')).toBe('already-settled');
  expect(calls()).toBe(1);
  const approved = { ...ref, id: 'approved' };
  await coordinator.admit(approved);
  expect(await coordinator.decide(approved, 'approved')).toBe(true);
  expect(await coordinator.settle(approved, 'declined')).toBe(
    'already-settled'
  );
  expect(calls()).toBe(1);
});

const exits: [
  Exclude<ExitReason, 'session-ended'>,
  number,
  string,
  HandledOutcome,
][] = [
  ['declined', 5000, 'User rejected.', 'rejected'],
  ['abandoned', 5000, 'User rejected.', 'abandoned'],
  ['background', 5000, 'User rejected.', 'abandoned'],
  ['unsupported-method', 5101, 'Unsupported methods.', 'unsupported'],
  ['unsupported-accounts', 5103, 'Unsupported accounts.', 'unsupported'],
  ['load-failed', -32001, 'Request could not be reviewed.', 'failed'],
  ['sign-failed', -32001, 'Signing failed.', 'failed'],
  ['expired', -32000, 'Request expired.', 'expired'],
  [
    'timing-unknown',
    -32000,
    'Cannot establish request time. Please retry.',
    'failed',
  ],
  [
    'busy',
    -32000,
    'Wallet busy: too many pending requests. Please retry.',
    'failed',
  ],
];
it.each(exits)(
  'DEFECT exact answer and outcome for %s across both versions and kinds',
  async (reason, code, message, outcome) => {
    expect(EXIT_ANSWERS[reason]).toEqual({ code, message });
    for (const version of [1, 2] as const) {
      for (const kind of ['request', 'proposal'] as const) {
        const target = { ...ref, version, kind };
        await coordinator.admit(target);
        await coordinator.settle(target, reason);
        expect(store.isHandled(target)).toBe(true);
        if (kind === 'request' && version === 2)
          expect(transport.rejectRequestV2).toHaveBeenLastCalledWith(
            ref.topic,
            ref.id,
            { code, message }
          );
        else if (kind === 'request')
          expect(transport.rejectRequestV1).toHaveBeenLastCalledWith(
            ref.id,
            message
          );
        else if (version === 2)
          expect(transport.rejectProposalV2).toHaveBeenLastCalledWith(
            ref.id,
            ref.topic,
            { code, message }
          );
        else expect(transport.rejectProposalV1).toHaveBeenLastCalledWith();
      }
    }
    expect(calls()).toBe(4);
    const saved = JSON.parse(
      (await AsyncStorage.getItem('@walletconnect_handled_v1')) ?? '{}'
    ) as { e: { o: string }[] };
    expect(saved.e.map((entry) => entry.o)).toEqual([
      outcome,
      outcome,
      outcome,
      outcome,
    ]);
  }
);

it('DEFECT failed transport is swallowed, stays handled, notifies and suppresses a later admit', async () => {
  await coordinator.admit(ref);
  const listener = jest.fn();
  coordinator.subscribe(ref, listener);
  transport.rejectRequestV2.mockRejectedValue(new Error('publish failed'));
  await expect(coordinator.settle(ref, 'load-failed')).resolves.toBe('settled');
  expect(store.isHandled(ref)).toBe(true);
  expect(listener).toHaveBeenCalledWith({ reason: 'load-failed' });
  await expect(coordinator.admit(ref)).resolves.toEqual({
    action: 'suppressed',
    reason: 'handled',
  });
});

it('DEFECT deadline timer expires and notifies at the deadline', async () => {
  await coordinator.admit(ref, now + 1000);
  const listener = jest.fn();
  coordinator.subscribe(ref, listener);
  now += 999;
  jest.advanceTimersByTime(999);
  await flush();
  expect(calls()).toBe(0);
  now++;
  jest.advanceTimersByTime(1);
  await flush();
  expect(transport.rejectRequestV2).toHaveBeenCalledWith(
    ref.topic,
    ref.id,
    EXIT_ANSWERS.expired
  );
  expect(listener).toHaveBeenCalledWith({ reason: 'expired' });
});
it.each(['approved', 'declined'] as const)(
  'DEFECT %s clears the timer with no later answer',
  async (decision) => {
    await coordinator.admit(ref, now + 1000);
    if (decision === 'approved') await coordinator.decide(ref, 'approved');
    else await coordinator.settle(ref, 'declined');
    const count = calls();
    expect(jest.getTimerCount()).toBe(0);
    now += 1000;
    jest.advanceTimersByTime(1000);
    await flush();
    expect(calls()).toBe(count);
  }
);
it('DEFECT clamped deadlines re-arm and timers tolerate a backwards clock', async () => {
  const maxDelay = 2_147_483_000;
  const deadline = now + maxDelay + 1000;
  await coordinator.admit(ref, deadline);
  now += maxDelay;
  jest.advanceTimersByTime(maxDelay);
  await flush();
  expect(coordinator.isOpen(ref)).toBe(true);
  expect(calls()).toBe(0);
  now -= 500;
  jest.advanceTimersByTime(1000);
  await flush();
  expect(calls()).toBe(0);
  now = deadline;
  jest.advanceTimersByTime(1500);
  await flush();
  expect(calls()).toBe(1);
});
it('REGRESSION Node timer handles are unref safe', async () => {
  const handle = { unref: jest.fn() };
  const setTimer = jest.fn(() => handle) as unknown as typeof setTimeout;
  const clearTimer = jest.fn() as unknown as typeof clearTimeout;
  coordinator = new RequestCoordinator({
    store,
    transport,
    now: () => now,
    setTimer,
    clearTimer,
  });
  await coordinator.admit(ref);
  expect(handle.unref).toHaveBeenCalledTimes(1);
  await coordinator.decide(ref, 'approved');
  expect(clearTimer).toHaveBeenCalledWith(handle);
});

it('DEFECT onSessionEnded closes only matching open request and proposal topics without sending', async () => {
  const proposal = { ...ref, kind: 'proposal' as const };
  const other = { ...ref, topic: 'other' };
  await coordinator.admit(ref);
  await coordinator.admit(proposal);
  await coordinator.admit(other);
  const listener = jest.fn();
  coordinator.subscribe(ref, listener);
  coordinator.subscribe(proposal, listener);
  await coordinator.onSessionEnded(ref.topic);
  expect(coordinator.isOpen(ref)).toBe(false);
  expect(coordinator.isOpen(proposal)).toBe(false);
  expect(coordinator.isOpen(other)).toBe(true);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(listener).toHaveBeenCalledWith({ reason: 'session-ended' });
  expect(calls()).toBe(0);
  const saved = JSON.parse(
    (await AsyncStorage.getItem('@walletconnect_handled_v1')) ?? '{}'
  ) as { e: { o?: string }[] };
  expect(saved.e.filter((entry) => entry.o === 'session-ended')).toHaveLength(
    2
  );
});

it('DEFECT duplicate OPEN admits, including concurrent delivery, suppress without answering', async () => {
  const results = await Promise.all([
    coordinator.admit(ref),
    coordinator.admit({ ...ref }),
  ]);
  expect(results[0].action).toBe('show');
  expect(results[1]).toEqual({ action: 'suppressed', reason: 'duplicate' });
  expect(await coordinator.admit(ref)).toEqual({
    action: 'suppressed',
    reason: 'duplicate',
  });
  expect(calls()).toBe(0);
  expect(jest.getTimerCount()).toBe(1);
});

it.each(['load', 'noteSeen'] as const)(
  'DEFECT store %s failure makes admission unavailable with timing-unknown answer',
  async (method) => {
    jest.spyOn(store, method).mockRejectedValueOnce(new Error('store failed'));
    expect(await coordinator.admit(ref)).toEqual({ action: 'unavailable' });
    expect(transport.rejectRequestV2).toHaveBeenCalledWith(
      ref.topic,
      ref.id,
      EXIT_ANSWERS['timing-unknown']
    );
    expect(coordinator.isOpen(ref)).toBe(false);
  }
);
it('DEFECT unavailable best-effort answer tolerates a rejecting transport', async () => {
  jest.spyOn(store, 'load').mockRejectedValueOnce(new Error('store failed'));
  transport.rejectRequestV2.mockRejectedValue(new Error('send failed'));
  await expect(coordinator.admit(ref)).resolves.toEqual({
    action: 'unavailable',
  });
});

it.each(['approved', 'failed'] as const)(
  'DEFECT decide %s records and closes without sending; sendError answers afterwards',
  async (outcome) => {
    await coordinator.admit(ref);
    const results = await Promise.all([
      coordinator.decide(ref, outcome),
      coordinator.decide(ref, 'failed'),
    ]);
    expect(results).toEqual([true, false]);
    expect(store.isHandled(ref)).toBe(true);
    expect(coordinator.isOpen(ref)).toBe(false);
    expect(calls()).toBe(0);
    await coordinator.sendError(ref, 'sign-failed');
    expect(calls()).toBe(1);
    expect(transport.rejectRequestV2).toHaveBeenCalledWith(
      ref.topic,
      ref.id,
      EXIT_ANSWERS['sign-failed']
    );
  }
);
it('REGRESSION already recorded settlement sends nothing and decide loses', async () => {
  await store.markHandled(ref, 'approved');
  expect(await coordinator.settle(ref, 'declined')).toBe('settled');
  expect(calls()).toBe(0);
  expect(await coordinator.decide({ ...ref, id: 'another' }, 'approved')).toBe(
    false
  );
  const recorded = { ...ref, id: 'recorded' };
  await store.markHandled(recorded, 'approved');
  expect(await coordinator.decide(recorded, 'failed')).toBe(false);
});
it('REGRESSION unsubscribe removes a listener and a throwing listener cannot block others', async () => {
  await coordinator.admit(ref);
  const removed = jest.fn();
  coordinator.subscribe(ref, removed)();
  coordinator.subscribe(ref, () => {
    throw new Error('listener failed');
  });
  const remaining = jest.fn();
  coordinator.subscribe(ref, remaining);
  await coordinator.settle(ref, 'abandoned');
  expect(removed).not.toHaveBeenCalled();
  expect(remaining).toHaveBeenCalledWith({ reason: 'abandoned' });
});
it('DEFECT a past-deadline request whose write fails is still answered expired and not shown', async () => {
  jest
    .spyOn(store, 'markHandled')
    .mockRejectedValueOnce(new Error('write failed'));
  expect(await coordinator.admit(ref, now - 1)).toEqual({ action: 'expired' });
  expect(transport.rejectRequestV2).toHaveBeenCalledWith(
    ref.topic,
    ref.id,
    EXIT_ANSWERS.expired
  );
  expect(coordinator.isOpen(ref)).toBe(false);
});
it('REGRESSION default transport is replaceable and rejects safely until installed', async () => {
  coordinator = new RequestCoordinator({ store, now: () => now });
  await expect(coordinator.sendError(ref, 'busy')).resolves.toBeUndefined();
  expect(console.warn).toHaveBeenCalled();
  coordinator.setTransport(transport);
  expect(await coordinator.retryUnpublished(ref)).toBe(true);
  expect(calls()).toBe(1);
});
it('REGRESSION coordinator has no service index, v1 client or navigation imports', () => {
  const source = readFileSync(
    join(__dirname, '../requestCoordinator.ts'),
    'utf8'
  );
  const imports = [
    ...source.matchAll(
      /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g
    ),
  ].map((match) => match[1]);
  expect(
    imports.every((specifier) =>
      ['@/utils/logRedaction', './handledStore', './requestTiming'].includes(
        specifier
      )
    )
  ).toBe(true);
});

it('DEFECT a store that cannot persist a settle still answers the dApp once', async () => {
  await coordinator.admit(ref);
  const listener = jest.fn();
  coordinator.subscribe(ref, listener);
  jest
    .spyOn(store, 'markHandled')
    .mockRejectedValueOnce(new Error('disk full'));
  await expect(coordinator.settle(ref, 'declined')).resolves.toBe('settled');
  expect(transport.rejectRequestV2).toHaveBeenCalledTimes(1);
  expect(transport.rejectRequestV2).toHaveBeenCalledWith(
    ref.topic,
    ref.id,
    EXIT_ANSWERS.declined
  );
  expect(listener).toHaveBeenCalledWith({ reason: 'declined' });
  expect(await coordinator.settle(ref, 'abandoned')).toBe('already-settled');
  expect(calls()).toBe(1);
});

it('DEFECT a decide that cannot persist leaves the request open and retryable', async () => {
  await coordinator.admit(ref);
  jest
    .spyOn(store, 'markHandled')
    .mockRejectedValueOnce(new Error('disk full'));
  await expect(coordinator.decide(ref, 'approved')).rejects.toThrow(
    'disk full'
  );
  expect(coordinator.isOpen(ref)).toBe(true);
  expect(await coordinator.decide(ref, 'approved')).toBe(true);
  expect(coordinator.isOpen(ref)).toBe(false);
  expect(calls()).toBe(0);
});

it('DEFECT concurrent decides: exactly one wins, and a settle after it sends nothing', async () => {
  await coordinator.admit(ref);
  const results = await Promise.all([
    coordinator.decide(ref, 'approved'),
    coordinator.decide({ ...ref }, 'approved'),
  ]);
  expect(results.sort()).toEqual([false, true]);
  expect(await coordinator.settle(ref, 'declined')).toBe('already-settled');
  expect(calls()).toBe(0);
});

it('DEFECT a lapse after the signer answers -32000 with a fixed message', async () => {
  await coordinator.admit(ref);
  await coordinator.settle(ref, 'lapsed');
  expect(EXIT_ANSWERS.lapsed).toEqual({
    code: -32000,
    message: 'Approval ended before signing finished.',
  });
  expect(transport.rejectRequestV2).toHaveBeenCalledWith(
    ref.topic,
    ref.id,
    EXIT_ANSWERS.lapsed
  );
  expect(await store.isHandled(ref)).toBe(true);
});

it('DEFECT describe returns the first-seen time and deadline of an open request only', async () => {
  expect(coordinator.describe(ref)).toBeNull();
  await coordinator.admit(ref);
  expect(coordinator.describe(ref)).toEqual({
    firstSeenMs: now,
    deadlineMs: now + 300_000,
    source: 'wallet',
  });
  await coordinator.settle(ref, 'declined');
  expect(coordinator.describe(ref)).toBeNull();
});

it('REGRESSION the protocol codes equal the SDK constants', () => {
  const { getSdkError } = require('@walletconnect/utils');
  expect(EXIT_ANSWERS.declined.code).toBe(getSdkError('USER_REJECTED').code);
  expect(EXIT_ANSWERS['unsupported-method'].code).toBe(
    getSdkError('UNSUPPORTED_METHODS').code
  );
  expect(EXIT_ANSWERS['unsupported-accounts'].code).toBe(
    getSdkError('UNSUPPORTED_ACCOUNTS').code
  );
});

it('DEFECT release permits readmission with the same firstSeenMs and no answer or write', async () => {
  const admission = await coordinator.admit(ref);
  const listener = jest.fn();
  coordinator.subscribe(ref, listener);
  const write = jest.spyOn(AsyncStorage, 'setItem');
  write.mockClear();
  coordinator.release(ref);
  expect(coordinator.isOpen(ref)).toBe(false);
  expect(write).not.toHaveBeenCalled();
  now += 1000;
  expect(await coordinator.admit(ref)).toEqual(admission);
  expect(store.isHandled(ref)).toBe(false);
  expect(calls()).toBe(0);
  await coordinator.settle(ref, 'session-ended');
  expect(listener).not.toHaveBeenCalled();
});

it('REGRESSION release of an unknown ref is a no-op', () => {
  expect(() => coordinator.release(ref)).not.toThrow();
  expect(calls()).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

it('DEFECT release keeps an expiry timer armed', async () => {
  await coordinator.admit(ref);
  expect(jest.getTimerCount()).toBe(1);
  coordinator.release(ref);
  expect(jest.getTimerCount()).toBe(1);
});

it('DEFECT a released ref still expires at its original deadline', async () => {
  await coordinator.admit(ref);
  coordinator.release(ref);
  now += 300_000;
  jest.advanceTimersByTime(300_000);
  await flush();
  expect(calls()).toBe(1);
  expect(transport.rejectRequestV2).toHaveBeenCalledWith(
    ref.topic,
    ref.id,
    EXIT_ANSWERS.expired
  );
});

it.each([true, false])(
  'DEFECT settle waits for an in-flight decide: write succeeds=%s',
  async (succeeds) => {
    await coordinator.admit(ref);
    let resolve!: (recorded: boolean) => void;
    let reject!: (error: Error) => void;
    jest.spyOn(store, 'markHandled').mockImplementationOnce(
      () =>
        new Promise<boolean>((yes, no) => {
          resolve = yes;
          reject = no;
        })
    );
    const decision = coordinator.decide(ref, 'approved');
    const observed = decision.catch(() => false);
    const settlement = coordinator.settle(ref, 'expired');
    await flush();
    expect(calls()).toBe(0);
    expect(coordinator.isOpen(ref)).toBe(true);
    if (succeeds) resolve(true);
    else reject(new Error('write failed'));
    expect(await observed).toBe(succeeds);
    expect(await settlement).toBe(succeeds ? 'already-settled' : 'settled');
    expect(calls()).toBe(succeeds ? 0 : 1);
    if (!succeeds)
      expect(transport.rejectRequestV2).toHaveBeenCalledWith(
        ref.topic,
        ref.id,
        EXIT_ANSWERS.expired
      );
  }
);

it('DEFECT decide past deadline expires instead of approving', async () => {
  await coordinator.admit(ref, now + 1000);
  now += 1000;
  expect(await coordinator.decide(ref, 'approved')).toBe(false);
  expect(coordinator.isOpen(ref)).toBe(false);
  expect(transport.rejectRequestV2).toHaveBeenCalledWith(
    ref.topic,
    ref.id,
    EXIT_ANSWERS.expired
  );
  expect(calls()).toBe(1);
});

it('DEFECT decide never admitted or closed touches no store', async () => {
  const mark = jest.spyOn(store, 'markHandled');
  expect(await coordinator.decide(ref, 'approved')).toBe(false);
  expect(mark).not.toHaveBeenCalled();
  await coordinator.admit(ref);
  await coordinator.settle(ref, 'declined');
  mark.mockClear();
  expect(await coordinator.decide(ref, 'approved')).toBe(false);
  expect(mark).not.toHaveBeenCalled();
});

it('DEFECT sendError after failed approval closes clears timer and forbids another answer or signature', async () => {
  await coordinator.admit(ref);
  const listener = jest.fn();
  coordinator.subscribe(ref, listener);
  jest
    .spyOn(store, 'markHandled')
    .mockRejectedValueOnce(new Error('write failed'));
  await expect(coordinator.decide(ref, 'approved')).rejects.toThrow(
    'write failed'
  );
  await coordinator.sendError(ref, 'sign-failed');
  expect(coordinator.isOpen(ref)).toBe(false);
  expect(jest.getTimerCount()).toBe(0);
  expect(listener).toHaveBeenCalledWith({ reason: 'sign-failed' });
  expect(await coordinator.decide(ref, 'approved')).toBe(false);
  await coordinator.settle(ref, 'declined');
  now += 300_000;
  jest.advanceTimersByTime(300_000);
  await flush();
  expect(calls()).toBe(1);
});

it('DEFECT sendError and settle share the answered guard', async () => {
  await coordinator.admit(ref);
  await coordinator.sendError(ref, 'sign-failed');
  await coordinator.sendError(ref, 'declined');
  await coordinator.settle(ref, 'expired');
  expect(calls()).toBe(1);
  const other = { ...ref, id: 'settled-first' };
  await coordinator.admit(other);
  await coordinator.settle(other, 'declined');
  await coordinator.sendError(other, 'sign-failed');
  expect(calls()).toBe(2);
});

it('DEFECT listeners run before a publish that never resolves', async () => {
  await coordinator.admit(ref);
  const listener = jest.fn();
  coordinator.subscribe(ref, listener);
  transport.rejectRequestV2.mockImplementationOnce(() => new Promise(() => {}));
  void coordinator.settle(ref, 'expired');
  await flush();
  expect(transport.rejectRequestV2).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith({ reason: 'expired' });
  expect(jest.getTimerCount()).toBe(0);
});

it('DEFECT readmission cancels the released timer and preserves the deadline', async () => {
  const admission = await coordinator.admit(ref);
  coordinator.release(ref);
  now += 1000;
  expect(await coordinator.admit(ref)).toEqual(admission);
  jest.advanceTimersByTime(1000);
  await flush();
  expect(calls()).toBe(0);
  expect(jest.getTimerCount()).toBe(1);
});

it('DEFECT failed publish retries on redelivery until success and never afterwards', async () => {
  await coordinator.admit(ref);
  transport.rejectRequestV2.mockRejectedValueOnce(new Error('publish failed'));
  await coordinator.settle(ref, 'expired');
  transport.rejectRequestV2.mockRejectedValueOnce(new Error('still down'));
  expect(await coordinator.retryUnpublished(ref)).toBe(false);
  expect(await coordinator.retryUnpublished(ref)).toBe(true);
  expect(await coordinator.retryUnpublished(ref)).toBe(false);
  await coordinator.sendError(ref, 'declined');
  await coordinator.settle(ref, 'declined');
  expect(calls()).toBe(3);
});

it('DEFECT ensureOpen admits a never-admitted request', async () => {
  expect(await coordinator.ensureOpen(ref)).toBe('open');
  expect(coordinator.isLive(ref)).toBe(true);
});
it('DEFECT ensureOpen preserves a live admission', async () => {
  const admission = await coordinator.admit(ref);
  expect(await coordinator.ensureOpen(ref, now + 900_000)).toBe('open');
  expect(coordinator.describe(ref)).toEqual(
    expect.objectContaining(
      admission.action === 'show' ? { deadlineMs: admission.deadlineMs } : {}
    )
  );
  expect(calls()).toBe(0);
});
it('DEFECT ensureOpen settles an open past-deadline request', async () => {
  await coordinator.admit(ref);
  now += 300_000;
  expect(await coordinator.ensureOpen(ref)).toBe('expired');
  expect(coordinator.isOpen(ref)).toBe(false);
  expect(calls()).toBe(1);
});
it.each(['handled', 'expired', 'unavailable'] as const)(
  'DEFECT ensureOpen closes a %s admission',
  async (state) => {
    if (state === 'handled') await store.markHandled(ref, 'approved');
    if (state === 'unavailable')
      jest.spyOn(store, 'load').mockRejectedValueOnce(new Error('unavailable'));
    expect(
      await coordinator.ensureOpen(
        ref,
        state === 'expired' ? now - 1 : undefined
      )
    ).toBe(state);
    expect(calls()).toBe(1);
  }
);

it('DEFECT ensureOpen treats a concurrent duplicate admission as open without answering', async () => {
  await store.load();
  let finish!: () => void;
  jest.spyOn(store, 'load').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const admission = coordinator.admit(ref);
  expect(await coordinator.ensureOpen(ref)).toBe('open');
  expect(calls()).toBe(0);
  finish();
  expect((await admission).action).toBe('show');
});
it('DEFECT ensureOpen identifies an already closed request as handled', async () => {
  await coordinator.admit(ref);
  await coordinator.settle(ref, 'declined');
  expect(await coordinator.ensureOpen(ref)).toBe('handled');
  expect(calls()).toBe(1);
});
