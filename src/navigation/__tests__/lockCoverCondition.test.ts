import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  S2_NOT_EXEMPT_ROUTES,
  S2_REVIEW_ROUTES,
  shouldCover,
  type CoverInput,
} from '../lockCoverCondition';
import { ROOT_ROUTE_COVERAGE } from '../rootRouteCoverage';

// Independent state table: checked, locked, authenticated, PIN, resume, recovery.
const states: { name: string; flags: boolean[]; routes: boolean[] }[] = [
  {
    name: 'S0',
    flags: [false, true, false, false, false, false],
    routes: [false, false, false, false],
  },
  {
    name: 'S1',
    flags: [true, true, false, false, false, true],
    routes: [false, false, false, false],
  },
  {
    name: 'S2',
    flags: [true, true, false, false, true, false],
    routes: [false, false, true, true],
  },
  {
    name: 'S3',
    flags: [true, false, true, false, false, false],
    routes: [false, false, false, false],
  },
  {
    name: 'S4',
    flags: [true, false, true, true, false, false],
    routes: [false, false, false, false],
  },
  {
    name: 'S5',
    flags: [true, true, false, true, false, false],
    routes: [true, true, true, true],
  },
];
const routes = [null, 'SecuritySetup', 'Main', 'Onboarding'];
function inputFrom(flags: boolean[]): CoverInput {
  const [
    authChecked,
    isLocked,
    isAuthenticated,
    hasPin,
    pinSetupResume,
    securityUnavailable,
  ] = flags;
  return {
    authChecked,
    isLocked,
    isAuthenticated,
    hasPin,
    pinSetupResume,
    securityUnavailable,
  };
}
const combinations = Array.from({ length: 32 }, (_, bits) =>
  inputFrom([
    true,
    ...Array.from({ length: 5 }, (_, bit) => Boolean(bits & (1 << bit))),
  ])
);
function oracle(input: CoverInput, routeIndex: number): boolean {
  const named = states.find(
    (state) => JSON.stringify(inputFrom(state.flags)) === JSON.stringify(input)
  );
  if (named) return named.routes[routeIndex];
  // Anything else: recovery and unchecked boot always win. A resume without a
  // PIN may proceed only on setup (including navigation's pending initial route).
  if (!input.authChecked) return false;
  if (input.securityUnavailable) return false;
  if (input.pinSetupResume && !input.hasPin && routeIndex < 2) return false;
  if (input.isLocked) return true;
  if (!input.isAuthenticated) return true;
  return false;
}

it('DEFECT all 32 checked combinations on four routes match the independent oracle', () => {
  for (const input of combinations) {
    routes.forEach((route, index) => {
      expect({ input, route, covered: shouldCover(input, route) }).toEqual({
        input,
        route,
        covered: oracle(input, index),
      });
    });
  }
});
it('DEFECT unchecked boot and unavailable security never cover', () => {
  for (const input of combinations) {
    for (const route of routes) {
      expect(shouldCover({ ...input, authChecked: false }, route)).toBe(false);
      expect(shouldCover({ ...input, securityUnavailable: true }, route)).toBe(
        false
      );
    }
  }
});
it('DEFECT unreachable combinations fail-closed outside recovery and the setup exemption', () => {
  const unreachable = combinations.filter(
    (input) =>
      !states.some(
        (state) =>
          JSON.stringify(inputFrom(state.flags)) === JSON.stringify(input)
      )
  );
  expect(unreachable.length).toBeGreaterThan(0);
  for (const input of unreachable) {
    routes.forEach((route, index) => {
      if (input.securityUnavailable) return;
      if (input.pinSetupResume && !input.hasPin && index < 2) return;
      expect(shouldCover(input, route)).toBe(
        input.isLocked ? true : !input.isAuthenticated
      );
    });
  }
  expect(
    shouldCover(inputFrom([true, true, false, false, false, false]), 'Main')
  ).toBe(true);
});
it('DEFECT reachable states never cover without a PIN except S2 away from SecuritySetup', () => {
  for (const state of states) {
    const input = inputFrom(state.flags);
    routes.forEach((route, index) => {
      expect(shouldCover(input, route)).toBe(state.routes[index]);
      if (shouldCover(input, route) && !input.hasPin) {
        expect(state.name).toBe('S2');
        expect(['Main', 'Onboarding']).toContain(route);
      }
    });
  }
});

// PIN on the premise behind the host's accepted residual (a grant that survives
// a lock): the cover and the AppLockSignal that revokes grants both come from
// AuthContext's isAuthenticated and isLocked. If someone separates those two
// signals, one of these two tests fails.
it('DEFECT every covering combination has the lock signal not unlocked', () => {
  const unlockedSignal = (input: CoverInput) =>
    input.isAuthenticated && !input.isLocked;
  let covering = 0;
  for (const input of combinations) {
    for (const route of routes) {
      if (!shouldCover(input, route)) continue;
      covering++;
      expect({ input, route, unlocked: unlockedSignal(input) }).toEqual({
        input,
        route,
        unlocked: false,
      });
    }
  }
  expect(covering).toBeGreaterThan(0);
});
it('DEFECT AuthContext feeds the lock signal from the same two fields the cover reads', () => {
  const source = readFileSync(
    resolve(__dirname, '../../contexts/AuthContext.tsx'),
    'utf8'
  );
  expect(source).toContain(
    'const isUnlocked = authState.isAuthenticated && !authState.isLocked;'
  );
  expect(source).toContain('AppLockSignal.setUnlocked(isUnlocked);');
  expect(source).toContain(
    '}, [authState.isAuthenticated, authState.isLocked]);'
  );
});

// S2 (PIN setup resumed, no PIN): a WalletConnect link can push a review route.
// The lock screen would ask for a PIN that does not exist, so those routes keep
// the review's own gate (with Reject) reachable, as before the root boundary.
it('DEFECT S2 never covers the WalletConnect review routes, in every combination', () => {
  const s2 = combinations.filter(
    (input) => input.pinSetupResume && !input.hasPin
  );
  expect(s2.length).toBeGreaterThan(0);
  for (const input of s2)
    for (const route of S2_REVIEW_ROUTES)
      expect({ input, route, covered: shouldCover(input, route) }).toEqual({
        input,
        route,
        covered: false,
      });
});
it('DEFECT outside S2 the same routes are covered while locked, and S2 still covers other routes', () => {
  for (const route of S2_REVIEW_ROUTES) {
    expect(
      shouldCover(inputFrom([true, true, false, true, false, false]), route)
    ).toBe(true);
    // pinSetupResume with a PIN present is not S2.
    expect(
      shouldCover(inputFrom([true, true, false, true, true, false]), route)
    ).toBe(true);
  }
  const s2 = inputFrom([true, true, false, false, true, false]);
  for (const route of ['Main', 'Onboarding', 'QRScanner'])
    expect(shouldCover(s2, route)).toBe(true);
});
it('DEFECT every S2 review route is a real root route in the census', () => {
  for (const route of S2_REVIEW_ROUTES)
    expect(Object.keys(ROOT_ROUTE_COVERAGE)).toContain(route);
  expect(S2_REVIEW_ROUTES).toHaveLength(3);
});

// Census: a WalletConnect root route nobody classified for S2 fails here, so a
// new review route cannot silently fall under the cover (or out of it).
function unclassified(census: string[]): string[] {
  return census.filter(
    (name) =>
      /^WalletConnect/.test(name) &&
      !S2_REVIEW_ROUTES.includes(name) &&
      !(name in S2_NOT_EXEMPT_ROUTES)
  );
}
it('DEFECT every WalletConnect root route is classified for S2, in exactly one list', () => {
  const census = Object.keys(ROOT_ROUTE_COVERAGE);
  expect(unclassified(census)).toEqual([]);
  const wc = census.filter((name) => /^WalletConnect/.test(name));
  expect(wc.length).toBeGreaterThan(0);
  for (const name of wc)
    expect({
      name,
      inExactlyOne:
        S2_REVIEW_ROUTES.includes(name) !== name in S2_NOT_EXEMPT_ROUTES,
    }).toEqual({ name, inExactlyOne: true });
  // Both lists name only real root routes, and the shared signing review is
  // classified on purpose, not by omission.
  for (const name of [
    ...S2_REVIEW_ROUTES,
    ...Object.keys(S2_NOT_EXEMPT_ROUTES),
  ])
    expect(census).toContain(name);
  expect(S2_NOT_EXEMPT_ROUTES).toHaveProperty('UniversalTransactionSigning');
  for (const reason of Object.values(S2_NOT_EXEMPT_ROUTES))
    expect(reason.length).toBeGreaterThan(10);
});
it('REGRESSION the census matcher reports an unclassified WalletConnect route', () => {
  expect(unclassified(['Main', 'WalletConnectSessionProposal'])).toEqual([]);
  expect(unclassified(['Main', 'WalletConnectNewReview'])).toEqual([
    'WalletConnectNewReview',
  ]);
});
