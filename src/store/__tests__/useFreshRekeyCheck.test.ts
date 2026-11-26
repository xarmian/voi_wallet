// TASK-458: the recovery-phrase warning hides only on FRESH, cache-bypassing
// reads that show `self` on every configured network (Codex pass A M1/L3).
import { act, renderHook } from '@testing-library/react-native';
import { useFreshRekeyCheck } from '../useFreshRekeyCheck';

const mockLookup = jest.fn();
let mockNetworks: string[];
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (network: string) => ({
      getAccountRekeyInfo: (address: string, skip: boolean, bypass: boolean) =>
        mockLookup(address, network, skip, bypass),
    }),
  },
}));
jest.mock('../networkStore', () => ({
  useNetworkStore: (select: (state: object) => unknown) =>
    select({ availableNetworks: mockNetworks }),
}));
const mockRecord = jest.fn();
jest.mock('../rekeyDisplayStatus', () => ({
  recordRekeyObservation: (...args: unknown[]) => mockRecord(...args),
}));

const SELF = { isRekeyed: false };
const DELEGATED = { isRekeyed: true, authAddress: 'AUTH' };

beforeEach(() => {
  mockNetworks = ['voi-mainnet', 'algorand-mainnet'];
  mockLookup.mockReset();
  mockRecord.mockReset();
});

const settle = () => act(async () => {});

it('is true only once every network freshly reads self, and bypasses the cache', async () => {
  mockLookup.mockResolvedValue(SELF);
  const { result } = await renderHook(() => useFreshRekeyCheck('ADDR'));
  await settle();
  expect(result.current.allSelf).toBe(true);
  expect(mockLookup).toHaveBeenCalledTimes(2);
  for (const call of mockLookup.mock.calls) {
    expect(call[3]).toBe(true);
  }
  expect(mockRecord).toHaveBeenCalledWith('ADDR', 'voi-mainnet', SELF);
});

it.each([
  ['delegated on one network', [SELF, DELEGATED]],
  ['a failed read on one network', [SELF, new Error('timeout')]],
] as const)('is false for %s', async (_name, answers) => {
  answers.forEach((answer) =>
    answer instanceof Error
      ? mockLookup.mockRejectedValueOnce(answer)
      : mockLookup.mockResolvedValueOnce(answer)
  );
  const { result } = await renderHook(() => useFreshRekeyCheck('ADDR'));
  await settle();
  expect(result.current.allSelf).toBe(false);
});

it('is false while a read is still pending', async () => {
  mockLookup
    .mockResolvedValueOnce(SELF)
    .mockReturnValueOnce(new Promise(() => {}));
  const { result } = await renderHook(() => useFreshRekeyCheck('ADDR'));
  await settle();
  expect(result.current.allSelf).toBe(false);
});

it('is false with an empty network list', async () => {
  mockNetworks = [];
  const { result } = await renderHook(() => useFreshRekeyCheck('ADDR'));
  await settle();
  expect(result.current.allSelf).toBe(false);
  expect(mockLookup).not.toHaveBeenCalled();
});

it('is false with no address', async () => {
  const { result } = await renderHook(() => useFreshRekeyCheck(undefined));
  await settle();
  expect(result.current.allSelf).toBe(false);
});

it("never lets one address's reads vouch for another", async () => {
  let resolveA!: (value: unknown) => void;
  mockLookup.mockImplementation((address: string) =>
    address === 'A'
      ? new Promise((resolve) => (resolveA = resolve))
      : Promise.resolve(SELF)
  );
  const { result, rerender } = await renderHook(
    ({ address }: { address: string }) => useFreshRekeyCheck(address),
    { initialProps: { address: 'B' } }
  );
  await settle();
  expect(result.current.allSelf).toBe(true);
  await rerender({ address: 'A' });
  expect(result.current.allSelf).toBe(false);
  await act(async () => resolveA(SELF));
  // Only one of A's two networks has answered.
  expect(result.current.allSelf).toBe(false);
});
