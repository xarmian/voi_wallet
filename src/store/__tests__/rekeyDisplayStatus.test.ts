// TASK-458: display-only per-network rekey status fed by refreshes.
import { act, renderHook } from '@testing-library/react-native';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { NetworkId } from '@/types/network';
import { invalidateRekeyStatus } from '@/services/wallet/rekeyStatusInvalidation';
import {
  beginRekeyObservation,
  clearRekeyDisplayStatus,
  displayOverridesLoaded,
  recordRekeyObservation,
  useRekeyDisplayDelegatedAnywhere,
  useRekeyDisplayStatus,
} from '../rekeyDisplayStatus';

const VOI = NetworkId.VOI_MAINNET;
const ALGO = NetworkId.ALGORAND_MAINNET;

beforeEach(() => clearRekeyDisplayStatus());

it('records self and delegated from a refresh, with the auth address', async () => {
  const { result } = await renderHook(() => useRekeyDisplayStatus('ADDR', VOI));
  expect(result.current).toBeUndefined();
  await act(async () =>
    recordRekeyObservation(beginRekeyObservation(), 'ADDR', VOI, {
      isRekeyed: true,
      authAddress: 'AUTH',
    })
  );
  expect(result.current).toMatchObject({
    status: 'delegated',
    authAddress: 'AUTH',
  });
  expect(typeof result.current?.checkedAt).toBe('number');
  await act(async () =>
    recordRekeyObservation(beginRekeyObservation(), 'ADDR', VOI, {
      isRekeyed: false,
    })
  );
  expect(result.current).toMatchObject({ status: 'self' });
  expect(result.current?.authAddress).toBeUndefined();
});

it('a failed read never overwrites a known status', async () => {
  const { result } = await renderHook(() => useRekeyDisplayStatus('ADDR', VOI));
  await act(async () =>
    recordRekeyObservation(beginRekeyObservation(), 'ADDR', VOI, {
      isRekeyed: true,
      authAddress: 'AUTH',
    })
  );
  await act(async () =>
    recordRekeyObservation(beginRekeyObservation(), 'ADDR', VOI, null)
  );
  await act(async () =>
    recordRekeyObservation(beginRekeyObservation(), 'ADDR', VOI, {
      isRekeyed: false,
      unavailable: true,
    })
  );
  expect(result.current?.status).toBe('delegated');
});

it('a failed first read records unknown', async () => {
  const { result } = await renderHook(() => useRekeyDisplayStatus('ADDR', VOI));
  await act(async () =>
    recordRekeyObservation(beginRekeyObservation(), 'ADDR', VOI, null)
  );
  expect(result.current?.status).toBe('unknown');
});

it('is per network, and delegated-anywhere reads every network', async () => {
  const { result } = await renderHook(() => ({
    voi: useRekeyDisplayStatus('ADDR', VOI),
    anywhere: useRekeyDisplayDelegatedAnywhere('ADDR'),
    other: useRekeyDisplayDelegatedAnywhere('ADDR2'),
  }));
  await act(async () =>
    recordRekeyObservation(beginRekeyObservation(), 'ADDR', ALGO, {
      isRekeyed: true,
      authAddress: 'AUTH',
    })
  );
  expect(result.current.voi).toBeUndefined();
  expect(result.current.anywhere).toBe(true);
  expect(result.current.other).toBe(false);
});

it('a wallet-wide rekey invalidation clears it', async () => {
  const { result } = await renderHook(() => useRekeyDisplayStatus('ADDR', VOI));
  await act(async () =>
    recordRekeyObservation(beginRekeyObservation(), 'ADDR', VOI, {
      isRekeyed: false,
    })
  );
  await act(async () => invalidateRekeyStatus());
  expect(result.current).toBeUndefined();
});

// Codex pass B #3: results are ordered by ISSUE, and fenced by invalidation.
it('an older-issued read landing late never overwrites a newer one', async () => {
  const { result } = await renderHook(() => useRekeyDisplayStatus('ADDR', VOI));
  const older = beginRekeyObservation();
  const newer = beginRekeyObservation();
  await act(async () =>
    recordRekeyObservation(newer, 'ADDR', VOI, {
      isRekeyed: true,
      authAddress: 'AUTH',
    })
  );
  await act(async () =>
    recordRekeyObservation(older, 'ADDR', VOI, { isRekeyed: false })
  );
  expect(result.current?.status).toBe('delegated');
});

it('a read issued before an invalidation is dropped when it lands', async () => {
  const { result } = await renderHook(() => useRekeyDisplayStatus('ADDR', VOI));
  const inFlight = beginRekeyObservation();
  await act(async () => invalidateRekeyStatus());
  await act(async () =>
    recordRekeyObservation(inFlight, 'ADDR', VOI, { isRekeyed: false })
  );
  expect(result.current).toBeUndefined();
});

it.each([
  ['no display entry', undefined, { isRekeyed: false }, false],
  ['unknown display', 'unknown', { isRekeyed: true, authAddress: 'A' }, false],
  ['agreeing self', 'self', { isRekeyed: false }, false],
  ['agreeing delegation', 'A', { isRekeyed: true, authAddress: 'A' }, false],
  ['newer delegation over loaded self', 'A', { isRekeyed: false }, true],
  [
    'newer self over loaded delegation',
    'self',
    { isRekeyed: true, authAddress: 'A' },
    true,
  ],
  ['a different signer', 'B', { isRekeyed: true, authAddress: 'A' }, true],
] as const)(
  'displayOverridesLoaded: %s → %s',
  (_name, display, loaded, expected) => {
    const entry =
      display === undefined
        ? undefined
        : display === 'unknown' || display === 'self'
          ? { status: display, checkedAt: 0 }
          : {
              status: 'delegated' as const,
              authAddress: display,
              checkedAt: 0,
            };
    expect(displayOverridesLoaded(entry, loaded)).toBe(expected);
  }
);

// NO GATE MAY READ THIS: the read hooks are for components and screens only,
// so no service or store logic (where the gates live) can consume them.
it('only components and screens read the display status', () => {
  const root = join(__dirname, '..', '..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== '__tests__') walk(path);
      } else if (/\.(ts|tsx)$/.test(name)) {
        const file = relative(root, path);
        if (
          file.startsWith('components/') ||
          file.startsWith('screens/') ||
          file === 'store/rekeyDisplayStatus.ts'
        )
          continue;
        const source = readFileSync(path, 'utf8');
        if (/useRekeyDisplay(Status|DelegatedAnywhere)\b/.test(source))
          offenders.push(file);
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});
