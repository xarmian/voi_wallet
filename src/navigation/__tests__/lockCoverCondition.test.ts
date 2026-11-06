import { shouldCover, type CoverInput } from '../lockCoverCondition';

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
