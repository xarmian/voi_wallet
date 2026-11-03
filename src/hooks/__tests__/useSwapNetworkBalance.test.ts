import { renderHook, waitFor, act } from '@testing-library/react-native';
import { NetworkId } from '@/types/network';
import { useSwapNetworkBalance } from '../useSwapNetworkBalance';

const mockGetAccountBalance: Record<string, jest.Mock> = {};

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (id: string) => ({
      getAccountBalance: (address: string) =>
        mockGetAccountBalance[id](address),
    }),
  },
}));

const bal = (amount: string) => ({ amount, minBalance: '100000', assets: [] });

describe('useSwapNetworkBalance', () => {
  beforeEach(() => {
    mockGetAccountBalance[NetworkId.VOI_MAINNET] = jest.fn();
    mockGetAccountBalance[NetworkId.ALGORAND_MAINNET] = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('fetches the VOI balance from the VOI network, not any store balance', async () => {
    mockGetAccountBalance[NetworkId.VOI_MAINNET].mockResolvedValue(bal('777'));
    const { result } = await renderHook(() =>
      useSwapNetworkBalance('ADDR', NetworkId.VOI_MAINNET)
    );
    await waitFor(() => expect(result.current.balance?.amount).toBe('777'));
    expect(mockGetAccountBalance[NetworkId.VOI_MAINNET]).toHaveBeenCalledWith(
      'ADDR'
    );
    expect(
      mockGetAccountBalance[NetworkId.ALGORAND_MAINNET]
    ).not.toHaveBeenCalled();
  });

  it('drops the previous network balance immediately when the network changes', async () => {
    mockGetAccountBalance[NetworkId.VOI_MAINNET].mockResolvedValue(bal('777'));
    mockGetAccountBalance[NetworkId.ALGORAND_MAINNET].mockReturnValue(
      new Promise(() => {})
    );
    const { result, rerender } = await renderHook(
      ({ net }: { net: NetworkId }) => useSwapNetworkBalance('ADDR', net),
      { initialProps: { net: NetworkId.VOI_MAINNET } }
    );
    await waitFor(() => expect(result.current.balance?.amount).toBe('777'));
    await rerender({ net: NetworkId.ALGORAND_MAINNET });
    expect(result.current.balance).toBeNull();
  });

  it('reports a fetch failure and retry re-runs the same fetch', async () => {
    mockGetAccountBalance[NetworkId.VOI_MAINNET]
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(bal('5'));
    const { result } = await renderHook(() =>
      useSwapNetworkBalance('ADDR', NetworkId.VOI_MAINNET)
    );
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.balance).toBeNull();
    await act(async () => result.current.retry());
    await waitFor(() => expect(result.current.balance?.amount).toBe('5'));
    expect(result.current.error).toBeNull();
  });

  it('ignores a stale response from a previous selection', async () => {
    let resolveVoi!: (b: unknown) => void;
    mockGetAccountBalance[NetworkId.VOI_MAINNET].mockReturnValue(
      new Promise((r) => (resolveVoi = r))
    );
    mockGetAccountBalance[NetworkId.ALGORAND_MAINNET].mockResolvedValue(
      bal('9')
    );
    const { result, rerender } = await renderHook(
      ({ net }: { net: NetworkId }) => useSwapNetworkBalance('ADDR', net),
      { initialProps: { net: NetworkId.VOI_MAINNET } }
    );
    await rerender({ net: NetworkId.ALGORAND_MAINNET });
    await waitFor(() => expect(result.current.balance?.amount).toBe('9'));
    await act(async () => resolveVoi(bal('777')));
    expect(result.current.balance?.amount).toBe('9');
  });

  it('refresh refetches and keeps the shown balance until the new one lands', async () => {
    let resolveSecond!: (b: unknown) => void;
    mockGetAccountBalance[NetworkId.VOI_MAINNET]
      .mockResolvedValueOnce(bal('5'))
      .mockReturnValueOnce(new Promise((r) => (resolveSecond = r)));
    const { result } = await renderHook(() =>
      useSwapNetworkBalance('ADDR', NetworkId.VOI_MAINNET)
    );
    await waitFor(() => expect(result.current.balance?.amount).toBe('5'));
    await act(async () => result.current.refresh());
    expect(result.current.balance?.amount).toBe('5');
    await act(async () => resolveSecond(bal('3')));
    expect(result.current.balance?.amount).toBe('3');
  });
});
