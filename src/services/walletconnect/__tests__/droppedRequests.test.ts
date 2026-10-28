/**
 * Requests the transaction queue drops without showing them are answered to
 * the dApp (TASK-394): a stale entry is reported 'expired' once the queue
 * lock is released, a full queue throws QueueFullError, and the boot's
 * handler routes v1 / v2 rejections with the decline-path payload. Real queue
 * over the AsyncStorage jest mock; both WalletConnect clients are mocked.
 * Payloads are opaque placeholders; no key or signature material.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  QueueFullError,
  QueuedTransactionRequest,
  TransactionRequestQueue,
} from '../TransactionRequestQueue';
import { answerDroppedRequests } from '../droppedRequestResponder';

const mockV2Reject = jest.fn(async (..._args: unknown[]) => {});
const mockV1Reject = jest.fn(async (..._args: unknown[]) => {});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: {
    getInstance: () => ({ rejectRequest: mockV2Reject }),
  },
}));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: {
    getInstance: () => ({ rejectRequest: mockV1Reject }),
  },
}));

const QUEUE_STORAGE_KEY = '@walletconnect_transaction_queue';
const params = {
  request: { method: 'algo_signTxn', params: [] },
  chainId: 1,
};

const enqueue = (id: number, topic = 'topic-d') =>
  TransactionRequestQueue.enqueue({ id, topic, params });

const storedIds = async () =>
  JSON.parse((await AsyncStorage.getItem(QUEUE_STORAGE_KEY)) ?? '[]').map(
    (r: QueuedTransactionRequest) => r.id
  );

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(async () => {
  await AsyncStorage.clear();
  mockV1Reject.mockReset().mockResolvedValue(undefined);
  mockV2Reject.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  TransactionRequestQueue.setDroppedRequestHandler(null);
  jest.restoreAllMocks();
});

describe('stale requests (expired)', () => {
  it('are reported once, after the lock is released, and stay answered', async () => {
    const realNow = Date.now();
    TransactionRequestQueue.claim(10, 'topic-d');
    await enqueue(10);
    await enqueue(11, 'topic-other');
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60_000);

    let nested: Promise<QueuedTransactionRequest[]> | undefined;
    let storedAtCall: unknown[] | undefined;
    const handler = jest.fn(() => {
      // A locked op from inside the handler must not deadlock: the queue
      // lock is already released when the handler runs.
      nested = TransactionRequestQueue.getAll();
      void storedIds().then((ids) => {
        storedAtCall = ids;
      });
    });
    TransactionRequestQueue.setDroppedRequestHandler(handler);

    expect(await TransactionRequestQueue.getAll()).toEqual([]);

    expect(handler).toHaveBeenCalledTimes(1);
    const [entries, reason] = handler.mock.calls[0] as unknown as [
      QueuedTransactionRequest[],
      string,
    ];
    expect(reason).toBe('expired');
    expect(entries.map((e) => [e.id, e.topic])).toEqual([
      [10, 'topic-d'],
      [11, 'topic-other'],
    ]);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'deadlock'>((resolve) => {
      timer = setTimeout(() => resolve('deadlock'), 1000);
    });
    expect(await Promise.race([nested!, timeout])).toEqual([]);
    clearTimeout(timer);
    expect(storedAtCall).toEqual([]);
    expect(await storedIds()).toEqual([]);

    // No second report for the same entries.
    await TransactionRequestQueue.getAll();
    expect(handler).toHaveBeenCalledTimes(1);

    // A relay redelivery of an answered request is treated as displayed.
    expect(TransactionRequestQueue.claim(10, 'topic-d')).toBe(false);
    expect(TransactionRequestQueue.markDisplayed(10, 'topic-d')).toBe(false);
    expect(TransactionRequestQueue.claim(11, 'topic-other')).toBe(false);
  });

  it('a stale queued copy of a request already displayed is removed, never answered', async () => {
    const realNow = Date.now();
    // Persisted by a previous session, then redelivered and shown directly.
    await enqueue(15);
    TransactionRequestQueue.claim(15, 'topic-d');
    TransactionRequestQueue.markDisplayed(15, 'topic-d');
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60_000);
    const handler = jest.fn();
    TransactionRequestQueue.setDroppedRequestHandler(handler);
    const report = jest.spyOn(TransactionRequestQueue, 'reportDropped');

    expect(await TransactionRequestQueue.getAll()).toEqual([]);
    expect(await storedIds()).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
    // The stale filter itself never collects it (not just reportDropped's
    // own displayed-skip).
    expect(report).not.toHaveBeenCalled();

    // The displayed mark survives, and reportDropped itself skips it too.
    TransactionRequestQueue.reportDropped(
      [{ id: 15, topic: 'topic-d', params, timestamp: 1 }],
      'expired'
    );
    expect(handler).not.toHaveBeenCalled();
    TransactionRequestQueue.forgetDeliveryIfAnsweredDrop(15, 'topic-d');
    expect(TransactionRequestQueue.markDisplayed(15, 'topic-d')).toBe(false);
    expect(TransactionRequestQueue.claim(15, 'topic-d')).toBe(false);
  });

  it('are reported by any locked operation, e.g. enqueue', async () => {
    const realNow = Date.now();
    await enqueue(20);
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60_000);
    const handler = jest.fn();
    TransactionRequestQueue.setDroppedRequestHandler(handler);

    await enqueue(21);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].map((e: any) => e.id)).toEqual([20]);
    expect(handler.mock.calls[0][1]).toBe('expired');
    expect(await storedIds()).toEqual([21]);
  });

  it('a handler that throws does not break the queue operation', async () => {
    const realNow = Date.now();
    await enqueue(30);
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60_000);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const handler = jest.fn(() => {
      throw new Error('handler blew up');
    });
    TransactionRequestQueue.setDroppedRequestHandler(handler);

    await expect(TransactionRequestQueue.getAll()).resolves.toEqual([]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();

    // The queue still works afterwards.
    await enqueue(31);
    expect(await storedIds()).toEqual([31]);
  });
});

describe('full queue', () => {
  it('enqueue at capacity throws QueueFullError and does not grow the queue', async () => {
    for (let id = 1; id <= 10; id++) await enqueue(id);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const attempt = enqueue(99);
    await expect(attempt).rejects.toBeInstanceOf(QueueFullError);
    await expect(attempt).rejects.toThrow(/queue is full/);
    expect(await storedIds()).toHaveLength(10);
  });

  it('reportDropped marks the request displayed and calls the handler', () => {
    const handler = jest.fn();
    TransactionRequestQueue.setDroppedRequestHandler(handler);
    TransactionRequestQueue.claim(40, 'topic-d');
    const entry = { id: 40, topic: 'topic-d', params, timestamp: 1 };

    TransactionRequestQueue.reportDropped([entry], 'full');

    expect(handler).toHaveBeenCalledWith([entry], 'full');
    expect(TransactionRequestQueue.markDisplayed(40, 'topic-d')).toBe(false);
  });

  it('with no handler installed, reportDropped releases the claim', () => {
    TransactionRequestQueue.claim(41, 'topic-d');
    TransactionRequestQueue.reportDropped(
      [{ id: 41, topic: 'topic-d', params, timestamp: 1 }],
      'full'
    );
    expect(TransactionRequestQueue.claim(41, 'topic-d')).toBe(true);
  });
});

describe('answerDroppedRequests (the boot-installed handler)', () => {
  const v1Entry = {
    id: 50,
    topic: 'handshake',
    params,
    timestamp: 1,
    version: 1,
  };
  const v2Entry = { id: 51, topic: 'topic-v2', params, timestamp: 1 };

  it('routes v1 and v2 with the decline-path payload (code 5001)', async () => {
    answerDroppedRequests([v1Entry, v2Entry], 'full');
    await flush();

    const full = 'Wallet busy: too many pending requests. Please retry.';
    expect(mockV1Reject).toHaveBeenCalledTimes(1);
    expect(mockV1Reject).toHaveBeenCalledWith(50, full);
    expect(mockV2Reject).toHaveBeenCalledTimes(1);
    expect(mockV2Reject).toHaveBeenCalledWith('topic-v2', 51, {
      code: 5001,
      message: full,
    });

    answerDroppedRequests([v1Entry, v2Entry], 'expired');
    await flush();
    const expired = 'Request expired before it could be reviewed.';
    expect(mockV1Reject).toHaveBeenLastCalledWith(50, expired);
    expect(mockV2Reject).toHaveBeenLastCalledWith('topic-v2', 51, {
      code: 5001,
      message: expired,
    });
  });

  it('a failed send is logged, never thrown, and the other entries still go out', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockV1Reject.mockRejectedValueOnce(new Error('Client not connected'));

    expect(() =>
      answerDroppedRequests([v1Entry, v2Entry], 'expired')
    ).not.toThrow();
    await flush();

    expect(mockV2Reject).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to answer dropped request'),
      'Client not connected'
    );
  });

  it('a failed send forgets the delivery mark so a redelivery can surface', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const forget = jest.spyOn(TransactionRequestQueue, 'forgetDelivery');
    mockV1Reject.mockRejectedValueOnce(new Error('Client not connected'));
    TransactionRequestQueue.setDroppedRequestHandler(answerDroppedRequests);
    TransactionRequestQueue.claim(50, 'handshake');
    TransactionRequestQueue.claim(51, 'topic-v2');

    TransactionRequestQueue.reportDropped([v1Entry, v2Entry], 'expired');
    await flush();

    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith(50, 'handshake');
    // The failed one can surface again; the answered one stays answered.
    expect(TransactionRequestQueue.claim(50, 'handshake')).toBe(true);
    expect(TransactionRequestQueue.claim(51, 'topic-v2')).toBe(false);
    forget.mockRestore();
  });

  it('a failed send never clears a mark the UI set', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockV2Reject.mockRejectedValue(new Error('relay down'));
    TransactionRequestQueue.setDroppedRequestHandler(answerDroppedRequests);

    // Shown by the UI, never dropped: the responder must not unmark it.
    TransactionRequestQueue.claim(60, 'topic-ui');
    TransactionRequestQueue.markDisplayed(60, 'topic-ui');
    answerDroppedRequests(
      [{ id: 60, topic: 'topic-ui', params, timestamp: 1 }],
      'expired'
    );
    await flush();
    expect(TransactionRequestQueue.markDisplayed(60, 'topic-ui')).toBe(false);

    // Answered as a drop, then shown by the UI after a redelivery (its first
    // answer failed): a later failure of a stale answer must not unmark it.
    TransactionRequestQueue.claim(61, 'topic-ui');
    const entry = { id: 61, topic: 'topic-ui', params, timestamp: 1 };
    mockV2Reject.mockImplementationOnce(() => new Promise(() => {})); // pending
    TransactionRequestQueue.reportDropped([entry], 'full');
    TransactionRequestQueue.forgetDelivery(61, 'topic-ui'); // its answer failed
    expect(TransactionRequestQueue.claim(61, 'topic-ui')).toBe(true);
    expect(TransactionRequestQueue.markDisplayed(61, 'topic-ui')).toBe(true);
    answerDroppedRequests([entry], 'full'); // rejects
    await flush();
    expect(TransactionRequestQueue.markDisplayed(61, 'topic-ui')).toBe(false);
    expect(TransactionRequestQueue.claim(61, 'topic-ui')).toBe(false);
  });
});
