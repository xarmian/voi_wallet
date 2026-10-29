/**
 * TASK-257: a request the screen leaves WITHOUT an answer sent to the dApp
 * (the rejection or the signed response failed, signing failed, or the
 * request could not be loaded) must not stay marked delivered, or a relay
 * redelivery is swallowed and the dApp never gets an answer. A request that
 * was answered, or handed to the signing screen, keeps its mark. The screen's
 * UX (advance to the next queued request, or leave; the error screen) is
 * unchanged.
 *
 * Real TransactionRequestQueue over the AsyncStorage jest mock; only the
 * WalletConnect transports, wallet storage and UI leaves are stubbed. The
 * "signed transactions" are opaque placeholder strings handed to a mocked
 * transport; the one real transaction is an unsigned fixture payment. No key
 * or signature material is logged or produced.
 */

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';
import { VOI_CHAIN_DATA } from '@/services/walletconnect/config';
import { makeAccount, paymentTxn } from '@/__tests__/fixtures/algorand';

const mockRespondToRequest = jest.fn();
const mockRejectRequest = jest.fn();
const mockV1RejectRequest = jest.fn();
const mockGetAllAccounts = jest.fn();
let mockApprovedAccounts: string[] = [];
let mockCallbacks:
  | {
      onSuccess: (r: any) => Promise<void>;
      onReject: () => Promise<void>;
      onDismiss: () => void;
    }
  | undefined;

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: {
    getInstance: () => ({
      respondToRequest: mockRespondToRequest,
      rejectRequest: mockRejectRequest,
      getApprovedAccountsForChain: () => mockApprovedAccounts,
      getActiveSessions: () => [],
    }),
  },
}));

jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: {
    getInstance: () => ({
      rejectRequest: mockV1RejectRequest,
      approveRequest: jest.fn(),
    }),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getAllAccounts: () => mockGetAllAccounts() },
}));

jest.mock('@/services/auth/reviewGrant', () => ({
  reviewGrant: { leave: jest.fn(), revoke: jest.fn(), continueTo: jest.fn() },
  walletConnectRequestKey: (topic: string, id: number) =>
    JSON.stringify([topic, String(id)]),
}));

jest.mock('@/services/auth/transactionAuthController', () => ({
  useTransactionAuthController: () => ({ cleanup: jest.fn() }),
}));

jest.mock('@/services/navigation/callbackRegistry', () => ({
  registerNavigationCallbacks: (callbacks: any) => {
    mockCallbacks = callbacks;
    return 'callback-id';
  },
}));

jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/transaction/TransactionDangerBanner', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

import Toast from 'react-native-toast-message';
import TransactionRequestScreen from '../TransactionRequestScreen';

const TOPIC = 'topic-answer';

const makeNavigation = () => {
  const beforeRemove: (() => void)[] = [];
  return {
    replace: jest.fn(),
    navigate: jest.fn(),
    goBack: jest.fn(),
    canGoBack: jest.fn(() => true),
    addListener: jest.fn((event: string, listener: () => void) => {
      if (event === 'beforeRemove') beforeRemove.push(listener);
      return () => {
        const i = beforeRemove.indexOf(listener);
        if (i >= 0) beforeRemove.splice(i, 1);
      };
    }),
    /** The screen leaves the stack (OS back, swipe-back, replace). */
    leave: () => [...beforeRemove].forEach((listener) => listener()),
  };
};

/**
 * Mount the screen on request `id`, as delivery does: claimed, then marked
 * displayed. By default the mount-time loader stays parked on the account
 * lookup (it never settles), so the screen just sits on the request; a test
 * that exercises the loader sets `mockGetAllAccounts` first.
 */
const mountOn = async (
  id: number,
  version?: number,
  request: { method: string; params: any[] } = {
    method: 'test_method',
    params: [],
  },
  chainId: number | string = 1
) => {
  TransactionRequestQueue.claim(id, TOPIC);
  TransactionRequestQueue.markDisplayed(id, TOPIC);
  const navigation = makeNavigation();
  const requestEvent = { id, topic: TOPIC, params: { request, chainId } };
  const screen = await render(
    <TransactionRequestScreen
      navigation={navigation as any}
      route={{ params: { requestEvent, version } } as any}
    />
  );
  return { navigation, screen };
};

/** A relay redelivery of (id, TOPIC) would surface again. */
const redeliverySurfaces = (id: number) => {
  const surfaces = TransactionRequestQueue.claim(id, TOPIC);
  if (surfaces) TransactionRequestQueue.releaseClaim(id, TOPIC);
  return surfaces;
};

const enqueueNext = async (id: number) => {
  TransactionRequestQueue.claim(id, TOPIC);
  await TransactionRequestQueue.enqueue({
    id,
    topic: TOPIC,
    params: { request: { method: 'algo_signTxn', params: [] }, chainId: 1 },
  });
};

beforeEach(async () => {
  await AsyncStorage.clear();
  mockRespondToRequest.mockReset();
  mockRejectRequest.mockReset();
  mockV1RejectRequest.mockReset();
  mockCallbacks = undefined;
  mockApprovedAccounts = [];
  mockGetAllAccounts.mockReset();
  // Parked: the loader never reaches an exit unless a test says so.
  mockGetAllAccounts.mockImplementation(() => new Promise(() => {}));
  (Toast.show as jest.Mock).mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const signer = makeAccount('wc-answer-signer');
const handOff = async (id: number) => {
  mockGetAllAccounts.mockResolvedValue([
    { id: 'a1', address: signer.addr, type: 'standard', label: 'A' },
  ]);
  mockApprovedAccounts = [`${VOI_CHAIN_DATA.chainId}:${signer.addr}`];
  const txn = Buffer.from(paymentTxn(signer.addr).toByte()).toString('base64');
  const mounted = await mountOn(
    id,
    undefined,
    { method: 'algo_signTxn', params: [[{ txn }]] },
    VOI_CHAIN_DATA.chainId
  );
  await waitFor(() =>
    expect(mounted.navigation.replace).toHaveBeenCalledWith(
      'UniversalTransactionSigning',
      expect.anything()
    )
  );
  mounted.navigation.replace.mockClear();
  return mounted;
};

describe('reject', () => {
  it('a failed rejection clears the delivery mark and still advances', async () => {
    mockRejectRequest.mockRejectedValue(new Error('relay down'));
    const { navigation, screen } = await mountOn(11);
    await enqueueNext(12);

    await fireEvent.press(screen.getByText('Reject'));

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledTimes(1));
    expect(navigation.replace.mock.calls[0][1].requestEvent.id).toBe(12);
    expect(redeliverySurfaces(11)).toBe(true);
  });

  it('a failed v1 rejection clears the delivery mark and leaves', async () => {
    mockV1RejectRequest.mockRejectedValue(new Error('bridge down'));
    const { navigation, screen } = await mountOn(13, 1);

    await fireEvent.press(screen.getByText('Reject'));

    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    expect(redeliverySurfaces(13)).toBe(true);
  });

  it('a sent rejection keeps the request marked', async () => {
    mockRejectRequest.mockResolvedValue(undefined);
    const { navigation, screen } = await mountOn(14);

    await fireEvent.press(screen.getByText('Reject'));

    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    expect(redeliverySurfaces(14)).toBe(false);
  });
});

describe('approve', () => {
  const approve = async () => {
    expect(mockCallbacks).toBeDefined();
    await act(async () => {
      await mockCallbacks!.onSuccess({ signedTransactions: ['placeholder'] });
    });
  };

  it('a failed response clears the delivery mark and shows the error screen', async () => {
    mockRespondToRequest.mockRejectedValue(new Error('relay down'));
    const { navigation } = await handOff(21);
    await enqueueNext(22);

    await approve();

    expect(navigation.navigate).toHaveBeenCalledWith('WalletConnectError', {
      error: 'relay down',
    });
    // Unchanged UX: no advance on a failed response.
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(redeliverySurfaces(21)).toBe(true);
    // The queued one is untouched: still queued and still claimed.
    expect((await TransactionRequestQueue.getAll()).map((r) => r.id)).toEqual([
      22,
    ]);
    expect(redeliverySurfaces(22)).toBe(false);
  });

  it('a sent response keeps the request marked and advances', async () => {
    mockRespondToRequest.mockResolvedValue(undefined);
    const { navigation } = await handOff(23);
    await enqueueNext(24);

    await approve();

    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(navigation.replace.mock.calls[0][1].requestEvent.id).toBe(24);
    expect(redeliverySurfaces(23)).toBe(false);
    // Counts the request just shown, as before the take was atomic.
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ props: { queueSize: 1 } })
    );
  });

  it('a sent response whose advance fails keeps the answered request marked', async () => {
    mockRespondToRequest.mockResolvedValue(undefined);
    const { navigation } = await handOff(25);
    await enqueueNext(26);
    navigation.replace.mockImplementation(() => {
      throw new Error('replace failed');
    });

    await approve();

    expect(navigation.navigate).toHaveBeenCalledWith('WalletConnectError', {
      error: 'replace failed',
    });
    // Answered: a redelivery stays suppressed.
    expect(redeliverySurfaces(25)).toBe(false);
    // The success toast still shows, counting the request left queued.
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'walletConnectSuccess',
        props: { queueSize: 1 },
      })
    );
    // The next one stays queued, not marked displayed.
    expect((await TransactionRequestQueue.getAll()).map((r) => r.id)).toEqual([
      26,
    ]);
    expect(TransactionRequestQueue.markDisplayed(26, TOPIC)).toBe(true);
  });
});

describe('every other exit without an answer clears the mark', () => {
  it('a request that cannot be loaded (replace to the error screen)', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    const { navigation } = await mountOn(31);

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        'WalletConnectError',
        expect.anything()
      )
    );
    expect(redeliverySurfaces(31)).toBe(true);
  });

  describe('handed to the signing screen', () => {
    it('the hand-off itself keeps the mark (the signing screen answers)', async () => {
      await handOff(33);
      expect(mockCallbacks).toBeDefined();
      expect(redeliverySurfaces(33)).toBe(false);
    });

    it('a success without signed transactions clears it (error screen)', async () => {
      const { navigation } = await handOff(34);

      await act(async () => {
        await mockCallbacks!.onSuccess({});
      });

      expect(navigation.navigate).toHaveBeenCalledWith('WalletConnectError', {
        error: 'Failed to sign transactions',
      });
      expect(mockRespondToRequest).not.toHaveBeenCalled();
      expect(redeliverySurfaces(34)).toBe(true);
    });

    it('a signed response sent from the signing screen keeps it', async () => {
      mockRespondToRequest.mockResolvedValue(undefined);
      const { navigation } = await handOff(35);

      await act(async () => {
        await mockCallbacks!.onSuccess({ signedTransactions: ['placeholder'] });
      });

      expect(mockRespondToRequest).toHaveBeenCalledTimes(1);
      expect(navigation.goBack).toHaveBeenCalled();
      expect(
        require('@/services/auth/reviewGrant').reviewGrant.revoke
      ).toHaveBeenCalled();
      expect(redeliverySurfaces(35)).toBe(false);
    });

    it('leaving the signing screen with no answer (back, swipe) clears it', async () => {
      const { navigation } = await handOff(37);
      // This screen leaving the stack at the hand-off does not clear it...
      navigation.leave();
      expect(redeliverySurfaces(37)).toBe(false);

      // ...the signing screen's onDismiss does.
      mockCallbacks!.onDismiss();
      expect(redeliverySurfaces(37)).toBe(true);
    });

    it('leaving the signing screen after a sent answer keeps it', async () => {
      mockRejectRequest.mockResolvedValue(undefined);
      await handOff(38);

      await act(async () => {
        await mockCallbacks!.onReject();
      });
      mockCallbacks!.onDismiss();

      expect(redeliverySurfaces(38)).toBe(false);
    });

    it('leaving the signing screen with an answer in flight keeps it', async () => {
      let resolveRespond!: () => void;
      mockRespondToRequest.mockImplementation(
        () => new Promise<void>((resolve) => (resolveRespond = resolve))
      );
      await handOff(39);

      let answered!: Promise<void>;
      await act(async () => {
        answered = mockCallbacks!.onSuccess({
          signedTransactions: ['placeholder'],
        });
      });
      mockCallbacks!.onDismiss();
      expect(redeliverySurfaces(39)).toBe(false);

      await act(async () => {
        resolveRespond();
        await answered;
      });
      expect(redeliverySurfaces(39)).toBe(false);
    });

    it('a rejection from the signing screen that fails clears it', async () => {
      mockRejectRequest.mockRejectedValue(new Error('relay down'));
      const { navigation } = await handOff(36);

      await act(async () => {
        await mockCallbacks!.onReject();
      });

      expect(navigation.goBack).toHaveBeenCalled();
      expect(redeliverySurfaces(36)).toBe(true);
    });
  });
});

describe('leaving this screen without an answer', () => {
  it('OS back / swipe-back with nothing answered clears the mark', async () => {
    const { navigation } = await mountOn(41);
    navigation.leave();
    expect(redeliverySurfaces(41)).toBe(true);
  });

  it('a StrictMode effect replay is not a departure: the mark stays', async () => {
    TransactionRequestQueue.claim(43, TOPIC);
    TransactionRequestQueue.markDisplayed(43, TOPIC);
    const navigation = makeNavigation();
    const requestEvent = {
      id: 43,
      topic: TOPIC,
      params: { request: { method: 'test_method', params: [] }, chainId: 1 },
    };
    await render(
      <React.StrictMode>
        <TransactionRequestScreen
          navigation={navigation as any}
          route={{ params: { requestEvent } } as any}
        />
      </React.StrictMode>
    );

    expect(redeliverySurfaces(43)).toBe(false);
  });

  it('leaving after a sent rejection keeps it', async () => {
    mockRejectRequest.mockResolvedValue(undefined);
    const { navigation, screen } = await mountOn(42);

    await fireEvent.press(screen.getByText('Reject'));
    await waitFor(() => expect(navigation.goBack).toHaveBeenCalled());
    navigation.leave();

    expect(redeliverySurfaces(42)).toBe(false);
  });
});

// Kept LAST in this file: the two taps are two overlapping act() scopes (a
// real double tap is not serialized the way awaited fireEvent calls are),
// which broke the renders of tests that ran after it in this file.
describe('reject double tap', () => {
  it('a second tap while the first is in flight takes nothing', async () => {
    let resolveReject!: () => void;
    mockRejectRequest.mockImplementation(
      () => new Promise<void>((resolve) => (resolveReject = resolve))
    );
    const { navigation, screen } = await mountOn(15);
    await enqueueNext(16);
    await enqueueNext(17);

    // Not awaited: each press settles only once its handler has.
    const first = fireEvent.press(screen.getByText('Reject'));
    const second = fireEvent.press(screen.getByText('Reject'));
    await waitFor(() => expect(mockRejectRequest).toHaveBeenCalled());
    resolveReject();
    await Promise.all([first, second]);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(navigation.replace.mock.calls[0][1].requestEvent.id).toBe(16);
    expect(mockRejectRequest).toHaveBeenCalledTimes(1);
    // 17 was not taken: still queued, not marked displayed.
    expect((await TransactionRequestQueue.getAll()).map((r) => r.id)).toEqual([
      17,
    ]);
  });
});
