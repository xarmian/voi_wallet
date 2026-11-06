import React, { useEffect } from 'react';
import { scopedNavigation } from '@/services/navigation/scopedNavigation';
import { View } from 'react-native';
import {
  act,
  render,
  cleanup,
  waitFor,
  fireEvent,
} from '@testing-library/react-native';
import {
  createNavigationContainerRef,
  createNavigatorFactory,
  NavigationContainer,
  StackRouter,
  StackActions,
  useNavigationBuilder,
  type ParamListBase,
  type RouteProp,
} from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackNavigatorProps,
} from '@react-navigation/native-stack';

// Headless navigator using the real StackRouter, with every route mounted.
function Nav(props: NativeStackNavigatorProps) {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(
    StackRouter,
    props
  );
  return (
    <NavigationContent>
      {state.routes.map((route) => (
        <View key={route.key}>{descriptors[route.key].render()}</View>
      ))}
    </NavigationContent>
  );
}
const Stack = createNavigatorFactory(Nav)();
type Routes = { Main: undefined; TRS: { id: string }; U: { id: string } };
type Navigation = NativeStackNavigationProp<Routes>;

afterEach(async () => {
  await cleanup();
});

it.each([
  'stale',
  'unscoped live',
  'scoped back',
  'scoped replace',
  'scoped top',
] as const)(
  'DEFECT real StackRouter scopes the %s source when A ends under B',
  async (source) => {
    const navs: Record<string, Navigation> = {};
    const Screen = ({
      navigation,
      route,
    }: {
      navigation: Navigation;
      route: RouteProp<ParamListBase>;
    }) => {
      const params = route.params as { id?: string } | undefined;
      const name = `${route.name}:${params?.id ?? ''}`;
      useEffect(() => {
        navs[name] = navigation;
      }, [name, navigation]);
      return <View />;
    };
    const ref = createNavigationContainerRef<Routes>();
    await render(
      <NavigationContainer ref={ref}>
        <Stack.Navigator initialRouteName="Main">
          <Stack.Screen name="Main" component={Screen} />
          <Stack.Screen name="TRS" component={Screen} />
          <Stack.Screen name="U" component={Screen} />
        </Stack.Navigator>
      </NavigationContainer>
    );
    await waitFor(() => expect(navs['Main:']).toBeDefined());
    const names = () =>
      ref.getRootState()!.routes.map((route) => {
        const params = route.params as { id?: string } | undefined;
        return `${route.name}:${params?.id ?? ''}`;
      });
    await act(async () => navs['Main:'].navigate('TRS', { id: 'A' }));
    const stale = navs['TRS:A'];
    await act(async () => stale.replace('U', { id: 'A' }));
    await act(async () => navs['U:A'].navigate('TRS', { id: 'B' }));
    await act(async () => navs['TRS:B'].replace('U', { id: 'B' }));
    expect(names()).toEqual(['Main:', 'U:A', 'U:B']);
    if (source === 'scoped top') {
      await act(async () => navs['U:B'].goBack());
      expect(names()).toEqual(['Main:', 'U:A']);
    }
    await act(async () => {
      if (source === 'stale') stale.goBack();
      else if (source === 'unscoped live') navs['U:A'].goBack();
      else {
        const scoped = scopedNavigation(navs['U:A']);
        if (source === 'scoped replace') scoped.replace('TRS', { id: 'C' });
        else scoped.goBack();
      }
    });
    // Measured hazard: the replaced route's stale source pops the focused B.
    // A live source also needs a target to preserve B.
    expect(names()).toEqual(
      source === 'stale' || source === 'unscoped live'
        ? ['Main:', 'U:A']
        : source === 'scoped replace'
          ? ['Main:', 'TRS:C', 'U:B']
          : source === 'scoped top'
            ? ['Main:']
            : ['Main:', 'U:B']
    );
  }
);

// Production proposal/request/error screens on the real router. Only native UI,
// account lookup and the wire are replaced. The signing stand-in produces real
// offline signed bytes and uses the same scoped callback boundary as UTS.
import {
  Alert,
  AppState,
  Text,
  Pressable,
  type AppStateStatus,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RootStackParamList } from '@/navigation/AppNavigator';
import {
  RequestCoordinator,
  type RequestRef,
} from '@/services/walletconnect/requestCoordinator';
import { HandledStore } from '@/services/walletconnect/handledStore';
import {
  requestRefFor,
  proposalRefFor,
} from '@/services/walletconnect/requestRefs';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';
import {
  getNavigationCallbacks,
  clearAllNavigationCallbacks,
} from '@/services/navigation/callbackRegistry';
import { makeAccount, paymentTxn } from '@/__tests__/fixtures/algorand';
import { AccountType, type AccountMetadata } from '@/types/wallet';
import { VOI_CHAIN_DATA } from '@/services/walletconnect/config';
import SessionProposalScreen from '../SessionProposalScreen';
import TransactionRequestScreen from '../TransactionRequestScreen';
import WalletConnectErrorScreen from '../WalletConnectErrorScreen';
import QRScannerScreen from '../QRScannerScreen';

let mockScannerProps: {
  onClose: () => void;
  onSuccess: (uri: string) => Promise<void>;
};
jest.mock('@/components/walletconnect/QRScanner', () => ({
  __esModule: true,
  default: (props: typeof mockScannerProps) => {
    mockScannerProps = props;
    return null;
  },
}));
const mockAccounts = jest.fn();
const mockApproveProposal = jest.fn();
const mockRespond = jest.fn();
const mockReject = jest.fn();
let mockApproved: string[] = [];
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getAllAccounts: () => mockAccounts() },
}));
jest.mock('@/services/walletconnect', () => ({
  ...jest.requireActual('@/services/walletconnect/config'),
  getNetworkNameByChainId: jest.requireActual('@/services/walletconnect/utils')
    .getNetworkNameByChainId,
  WalletConnectService: {
    getInstance: () => ({
      approveSession: mockApproveProposal,
      respondToRequest: mockRespond,
      getApprovedAccountsForChain: () => mockApproved,
      getActiveSessions: () => [],
    }),
  },
}));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: { getInstance: () => ({ approveSession: jest.fn() }) },
}));
jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    getSigningInfo: jest.fn(async (address: string) => ({
      signingAddress: address,
      canSign: true,
      isRekeyed: false,
    })),
  },
}));
jest.mock('@/services/auth/transactionAuthController', () => ({
  SIGNED_THEN_LAPSED_BATCH_MESSAGE: 'Signed result was not returned.',
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ authState: { isLocked: false, isAuthenticated: true } }),
}));
jest.mock('@/services/auth/reviewGrant', () => ({
  reviewGrant: {
    subscribe: () => () => {},
    isValid: () => true,
    leave: jest.fn(),
    revoke: jest.fn(),
    touch: jest.fn(),
  },
  walletConnectRequestKey: () => 'fixture',
  walletConnectProposalKey: () => 'fixture',
}));
jest.mock('@/hooks/useSecureScreen', () => ({
  useSecureScreen: jest.fn(),
  useAppSwitcherProtection: jest.fn(),
}));
jest.mock('@/store/experimentalStore', () => ({
  useExperimentalStore: {
    getState: () => ({ allowUnsupportedNetworks: false }),
  },
}));
jest.mock('@/hooks/useThemedStyles', () => ({ useThemedStyles: () => ({}) }));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));
jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/walletconnect/AccountSelectionItem', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/walletconnect/RequestAgeLabel', () => ({
  __esModule: true,
  default: () => null,
}));

const owner = makeAccount('c1u6-router');
const transaction = paymentTxn(owner.addr);
const encoded = Buffer.from(transaction.toByte()).toString('base64');
const signOffline = jest.fn(() =>
  Buffer.from(transaction.signTxn(owner.sk)).toString('base64')
);
const account = {
  id: 'fixture',
  address: owner.addr,
  type: AccountType.STANDARD,
  label: 'Fixture',
} as AccountMetadata;
const proposal = {
  id: 10,
  pairingTopic: 'fixture',
  requiredNamespaces: {
    algorand: { chains: [VOI_CHAIN_DATA.chainId], methods: [], events: [] },
  },
  optionalNamespaces: {},
  proposer: { metadata: { name: 'Fixture', icons: [] } },
};
const event = (id: number) => ({
  id,
  topic: 'fixture',
  params: {
    chainId: VOI_CHAIN_DATA.chainId,
    request: { method: 'algo_signTxn', params: [[{ txn: encoded }]] },
  },
});
let coordinator: RequestCoordinator;
let store: HandledStore;
let backgroundListeners: ((state: AppStateStatus) => void)[];
const beforeRemoveB = jest.fn();
const callbacksById = new Map<
  number,
  ReturnType<typeof getNavigationCallbacks>
>();
const navsById = new Map<
  number,
  NativeStackNavigationProp<RootStackParamList>
>();
let missingSignatures = false;
function Signing({
  navigation,
  route,
}: {
  navigation: NativeStackNavigationProp<
    RootStackParamList,
    'UniversalTransactionSigning'
  >;
  route: RouteProp<RootStackParamList, 'UniversalTransactionSigning'>;
}) {
  const callbacks = getNavigationCallbacks(route.params.callbackId);
  const ref = (
    route.params.walletConnect as typeof route.params.walletConnect & {
      ref: RequestRef;
    }
  ).ref;
  const busy = React.useRef(false);
  useEffect(() => {
    const id = Number(ref.id);
    callbacksById.set(id, callbacks);
    navsById.set(id, navigation);
    const stopRemove = navigation.addListener('beforeRemove', () => {
      if (id === 2) beforeRemoveB();
      callbacks?.onDismiss?.();
    });
    const stopEnd = coordinator.subscribe(ref, ({ reason }) => {
      if (!busy.current)
        void callbacks?.onEnd?.(
          reason,
          scopedNavigation(navigation, route.key)
        );
    });
    return () => {
      stopRemove();
      stopEnd();
    };
  }, [callbacks, ref, navigation, route.key]);
  return (
    <Pressable
      onPress={async () => {
        busy.current = true;
        await callbacks?.onSuccess?.(
          missingSignatures ? {} : { signedTransactions: [signOffline()] },
          scopedNavigation(navigation, route.key)
        );
      }}
    >
      <Text>{`Sign ${ref.id}`}</Text>
    </Pressable>
  );
}
let scannerNavigation: React.ComponentProps<
  typeof QRScannerScreen
>['navigation'];
function Scanner(props: React.ComponentProps<typeof QRScannerScreen>) {
  useEffect(() => {
    scannerNavigation = props.navigation;
  }, [props.navigation]);
  return <QRScannerScreen {...props} />;
}
async function mountReal(connect = false, root = false) {
  const ref = createNavigationContainerRef<RootStackParamList>();
  const view = await render(
    <NavigationContainer ref={ref}>
      <Stack.Navigator
        initialRouteName={root ? 'WalletConnectSessionProposal' : 'Main'}
      >
        <Stack.Screen name="Main" component={() => <View />} />
        <Stack.Screen name="QRScanner" component={Scanner} />
        <Stack.Screen
          name="WalletConnectSessionProposal"
          component={SessionProposalScreen}
          initialParams={{ proposal }}
        />
        <Stack.Screen
          name="WalletConnectTransactionRequest"
          component={TransactionRequestScreen}
        />
        <Stack.Screen name="UniversalTransactionSigning" component={Signing} />
        <Stack.Screen
          name="WalletConnectError"
          component={WalletConnectErrorScreen}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
  await waitFor(() => expect(ref.isReady()).toBe(true));
  const names = () =>
    ref.getRootState()!.routes.map((route) => {
      const params = route.params as
        | {
            walletConnect?: { ref: { id: unknown } };
            requestEvent?: { id: unknown };
          }
        | undefined;
      const id = params?.walletConnect?.ref.id ?? params?.requestEvent?.id;
      return `${route.name}${id === undefined ? '' : `:${id}`}`;
    });
  if (connect && !root)
    await act(async () =>
      ref.navigate('WalletConnectSessionProposal', {
        proposal: proposal as never,
      })
    );
  return { ref, view, names };
}
async function loadRequest(
  ref: ReturnType<typeof createNavigationContainerRef<RootStackParamList>>,
  id: number
) {
  await act(async () =>
    ref.navigate('WalletConnectTransactionRequest', { requestEvent: event(id) })
  );
  await waitFor(() => expect(callbacksById.has(id)).toBe(true));
}
beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  await AsyncStorage.clear();
  await TransactionRequestQueue.clear();
  for (const id of [1, 2, 3])
    TransactionRequestQueue.forgetDelivery(id, 'fixture');
  callbacksById.clear();
  navsById.clear();
  clearAllNavigationCallbacks();
  mockAccounts.mockReset().mockResolvedValue([account]);
  mockApproved = [`${VOI_CHAIN_DATA.chainId}:${owner.addr}`];
  mockApproveProposal.mockReset().mockResolvedValue(undefined);
  mockRespond.mockReset().mockResolvedValue(undefined);
  mockReject.mockReset().mockResolvedValue(undefined);
  missingSignatures = false;
  signOffline.mockClear();
  store = new HandledStore();
  coordinator = new RequestCoordinator({
    store,
    transport: {
      rejectRequestV2: mockReject,
      rejectRequestV1: mockReject,
      rejectProposalV2: mockReject,
      rejectProposalV1: mockReject,
    },
  });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  backgroundListeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      backgroundListeners.push(listener);
      return {
        remove: () => {
          backgroundListeners = backgroundListeners.filter(
            (value) => value !== listener
          );
        },
      };
    });
});
afterEach(() => {
  coordinator.__resetForTests();
  jest.restoreAllMocks();
});

it.each(['expiry listener', 'background', 'late Sign', 'success'] as const)(
  'U6 real Connect A %s removes only A under Signing B',
  async (ending) => {
    const h = await mountReal(true);
    await waitFor(() =>
      expect(h.view.getByRole('button', { name: 'Connect' })).toBeEnabled()
    );
    await loadRequest(h.ref, 2);
    expect(h.names()).toEqual([
      'Main',
      'WalletConnectSessionProposal',
      'UniversalTransactionSigning:2',
    ]);
    if (ending === 'expiry listener')
      await act(async () =>
        coordinator.settle(proposalRefFor(proposal), 'expired')
      );
    else if (ending === 'background')
      await act(async () =>
        backgroundListeners.forEach((listener) => listener('background'))
      );
    else {
      if (ending === 'late Sign')
        jest.spyOn(coordinator, 'decide').mockResolvedValueOnce(false);
      await fireEvent.press(h.view.getByRole('button', { name: 'Connect' }));
    }
    expect(h.names()).toEqual(['Main', 'UniversalTransactionSigning:2']);
    expect(beforeRemoveB).not.toHaveBeenCalled();
    expect(coordinator.isLive(requestRefFor(event(2)))).toBe(true);
  }
);
it('U6 real root Connect success replaces itself by exactly one Main', async () => {
  const h = await mountReal(true, true);
  await waitFor(() =>
    expect(h.view.getByRole('button', { name: 'Connect' })).toBeEnabled()
  );
  await fireEvent.press(h.view.getByRole('button', { name: 'Connect' }));
  expect(h.names()).toEqual(['Main']);
});
it.each(['expired', 'session-ended'] as const)(
  'U6 real queued successor loads through its scoped route after A %s under B',
  async (reason) => {
    const h = await mountReal();
    await loadRequest(h.ref, 1);
    let finishB!: (accounts: AccountMetadata[]) => void;
    mockAccounts.mockImplementationOnce(
      () =>
        new Promise<AccountMetadata[]>((resolve) => {
          finishB = resolve;
        })
    );
    await act(async () =>
      h.ref.navigate('WalletConnectTransactionRequest', {
        requestEvent: event(2),
      })
    );
    expect(h.names()).toEqual([
      'Main',
      'UniversalTransactionSigning:1',
      'WalletConnectTransactionRequest:2',
    ]);
    await TransactionRequestQueue.enqueue(event(3));
    await act(async () => finishB([account]));
    await waitFor(() => expect(callbacksById.has(2)).toBe(true));
    expect(h.names()).toEqual([
      'Main',
      'UniversalTransactionSigning:1',
      'UniversalTransactionSigning:2',
    ]);
    let finish!: (accounts: AccountMetadata[]) => void;
    mockAccounts.mockImplementationOnce(
      () =>
        new Promise<AccountMetadata[]>((resolve) => {
          finish = resolve;
        })
    );
    await act(async () => coordinator.settle(requestRefFor(event(1)), reason));
    expect(h.names()).toEqual([
      'Main',
      'WalletConnectTransactionRequest:3',
      'UniversalTransactionSigning:2',
    ]);
    await act(async () => finish([account]));
    await waitFor(() => expect(callbacksById.has(3)).toBe(true));
    expect(h.names()).toEqual([
      'Main',
      'UniversalTransactionSigning:3',
      'UniversalTransactionSigning:2',
    ]);
    expect(beforeRemoveB).not.toHaveBeenCalled();
    expect(coordinator.isLive(requestRefFor(event(2)))).toBe(true);
    expect(mockRespond).not.toHaveBeenCalled();
    expect(mockReject.mock.calls.filter((call) => call[1] === 2)).toHaveLength(
      0
    );
  }
);
it.each(['approval record', 'respond', 'missing signatures'] as const)(
  'U6 real Error Close Sign walk after %s failure removes signing A permanently',
  async (failure) => {
    const h = await mountReal();
    await loadRequest(h.ref, 1);
    await loadRequest(h.ref, 2);
    if (failure === 'approval record')
      jest
        .spyOn(store, 'markHandled')
        .mockRejectedValueOnce(new Error('write failed'));
    if (failure === 'respond')
      mockRespond.mockRejectedValueOnce(new Error('publish failed'));
    if (failure === 'missing signatures') missingSignatures = true;
    await fireEvent.press(h.view.getByText('Sign 1'));
    expect(signOffline).toHaveBeenCalledTimes(
      failure === 'missing signatures' ? 0 : 1
    );
    expect(h.names()).toEqual([
      'Main',
      'WalletConnectError',
      'UniversalTransactionSigning:2',
    ]);
    expect(h.view.queryByText('Sign 1')).toBeNull();
    await fireEvent.press(h.view.getByText('Close'));
    expect(h.names()).toEqual(['Main', 'UniversalTransactionSigning:2']);
    expect(h.view.queryByText('Sign 1')).toBeNull();
    expect(beforeRemoveB).not.toHaveBeenCalled();
    expect(coordinator.isLive(requestRefFor(event(2)))).toBe(true);
    expect(mockReject.mock.calls.filter((call) => call[1] === 2)).toHaveLength(
      0
    );
  }
);

it('U7 real proposal push preserves focused Connect A params while stacking B', async () => {
  const h = await mountReal(true);
  const original = h.ref.getRootState()!.routes[1];
  await act(async () =>
    h.ref.dispatch(
      StackActions.push('WalletConnectSessionProposal', {
        proposal: { ...proposal, id: 11 },
      })
    )
  );
  const routes = h.ref.getRootState()!.routes;
  expect(routes.map((r) => r.name)).toEqual([
    'Main',
    'WalletConnectSessionProposal',
    'WalletConnectSessionProposal',
  ]);
  expect(routes[1]).toEqual(original);
  expect(routes[2].params).toEqual({ proposal: { ...proposal, id: 11 } });
});
it('U7 real removed scoped source refuses replace without dispatching', async () => {
  const h = await mountReal();
  await loadRequest(h.ref, 1);
  const nav = navsById.get(1)!;
  const key = h.ref.getRootState()!.routes[1].key;
  const scoped = scopedNavigation(nav, key);
  await act(async () => nav.goBack());
  let changed: boolean | undefined;
  await act(async () => {
    changed = scoped.replace('WalletConnectTransactionRequest', {
      requestEvent: event(3),
    });
  });
  expect(changed).toBe(false);
  expect(h.names()).toEqual(['Main']);
});
it('U7 real Reject leaves C queued when user removes A during relay publish', async () => {
  const h = await mountReal();
  await loadRequest(h.ref, 1);
  await TransactionRequestQueue.enqueue(event(3));
  let resolve!: () => void;
  mockReject.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      })
  );
  let ending!: Promise<void>;
  const nav = navsById.get(1)!;
  const key = h.ref.getRootState()!.routes[1].key;
  await act(async () => {
    ending = callbacksById.get(1)!.onReject!(scopedNavigation(nav, key));
  });
  await waitFor(() => expect(resolve).toBeDefined());
  await act(async () => nav.goBack());
  await act(async () => {
    resolve();
    await ending;
  });
  expect(h.names()).toEqual(['Main']);
  expect((await TransactionRequestQueue.getAll()).map((r) => r.id)).toEqual([
    3,
  ]);
  expect(TransactionRequestQueue.markDisplayed(3, 'fixture')).toBe(true);
});
it('U7 real scanner close removes only scanner under a pushed request and is idempotent', async () => {
  const h = await mountReal();
  await act(async () => h.ref.navigate('QRScanner'));
  const close = mockScannerProps.onClose;
  const canGoBack = jest.spyOn(scannerNavigation, 'canGoBack');
  await act(async () => mockScannerProps.onSuccess('unrecognized-scan'));
  await loadRequest(h.ref, 2);
  await act(async () => close());
  expect(h.names()).toEqual(['Main', 'UniversalTransactionSigning:2']);
  await act(async () => close());
  await act(async () => new Promise((done) => setTimeout(done, 120)));
  expect(h.names()).toEqual(['Main', 'UniversalTransactionSigning:2']);
  expect(beforeRemoveB).not.toHaveBeenCalled();
  expect(canGoBack).toHaveBeenCalledTimes(1);
});
