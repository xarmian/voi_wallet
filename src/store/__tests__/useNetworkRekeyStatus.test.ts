import { act, renderHook } from '@testing-library/react-native';
import { NetworkId } from '@/types/network';
import { networkRekeyStatus } from '@/services/wallet/networkRekeyStatus';
import { invalidateRekeyStatus } from '@/services/wallet/rekeyStatusInvalidation';
import { useNetworkRekeyStatus } from '../useNetworkRekeyStatus';
import { useNetworkStore } from '../networkStore';
const mockLookup = jest.fn();
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (network: string) => ({
      getAccountRekeyInfo: (address: string, skip: boolean) =>
        mockLookup(address, network, skip),
    }),
  },
}));
jest.mock('../networkStore', () => ({
  useNetworkStore: require('zustand/vanilla').createStore(() => ({
    availableNetworks: ['voi-mainnet', 'algorand-mainnet'],
  })),
}));

beforeEach(() => {
  jest.useFakeTimers();
  networkRekeyStatus.invalidate();
  mockLookup
    .mockReset()
    .mockResolvedValue({ isRekeyed: true, authAddress: 'AUTH' });
});
afterEach(() => {
  networkRekeyStatus.invalidate();
  jest.useRealTimers();
});
it('fetches only the requested address after a frame and retains shallow selector identity', async () => {
  const { result, rerender, unmount } = await renderHook(() =>
    useNetworkRekeyStatus('SOURCE')
  );
  expect(mockLookup).not.toHaveBeenCalled();
  expect(result.current.delegatedEverywhere).toBe(false);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20);
  });
  expect(mockLookup).toHaveBeenCalledTimes(2);
  expect(
    mockLookup.mock.calls.every(
      ([address, , skip]) => address === 'SOURCE' && skip === true
    )
  ).toBe(true);
  expect(result.current.delegatedEverywhere).toBe(true);
  const first = result.current;
  await act(() => {
    networkRekeyStatus.store.setState((s) => ({
      entries: {
        ...s.entries,
        OTHER: { value: { status: 'self' }, expires: Date.now() + 10000 },
      },
    }));
  });
  await rerender({});
  expect(result.current).toBe(first);
  await act(() => {
    invalidateRekeyStatus();
  });
  expect(result.current.delegatedEverywhere).toBe(false);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20);
  });
  expect(mockLookup).toHaveBeenCalledTimes(4);
  await act(() => {
    useNetworkStore.setState({
      availableNetworks: [
        ...useNetworkStore.getState().availableNetworks,
        'future-network' as NetworkId,
      ],
    });
  });
  expect(result.current.perNetwork['future-network' as NetworkId]).toEqual({
    status: 'unknown',
  });
  expect(result.current.delegatedEverywhere).toBe(false);
  await unmount();
});
it('cancels scheduled loading on unmount', async () => {
  const { unmount } = await renderHook(() => useNetworkRekeyStatus('OTHER'));
  await unmount();
  await jest.advanceTimersByTimeAsync(20);
  expect(mockLookup).not.toHaveBeenCalled();
});
