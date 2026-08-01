import { computePieSlices, pointOnCircle } from '../pieChartGeometry';

const TWO_PI = Math.PI * 2;

/**
 * Parity fixture, recorded from the `react-native-chart-kit` `PieChart` this
 * replaced. Captured by rendering the old chart with `@testing-library/react-
 * native` and reading the emitted SVG (not from a screenshot):
 *
 *   props: data = [50, 30, 20], width = 375 - 60 = 315, height = 220,
 *          paddingLeft = "15", hasLegend = false, absolute
 *
 *   <G matrix=[1,0,0,1,93.75,110]>                    → cx = 93.75, cy = 110
 *     <Path d="M 0 -88 A 88 88 0 0 1 0 88 …"/>        → radius = 88
 *     <Path d="M 0 88 A 88 88 0 0 1 -83.692973 -27.193496 …"/>
 *     <Path d="M -83.692973 -27.193496 A 88 88 0 0 1 -0.0088 -88 …"/>
 *
 * Read off that output:
 *   - start angle 0 is at **12 o'clock**: the first slice starts at (0, -88),
 *     i.e. straight up from the centre.
 *   - sweep is **clockwise**: the 50% slice ends at (0, +88) (6 o'clock) with
 *     SVG sweep-flag 1.
 *   - cx = 93.75 = width / 2 / 2 + paddingLeft; cy = 110 = height / 2;
 *     radius = 88 = height / 2.5.
 *
 * chart-kit's coordinates are relative to a translated <G>; ours are absolute,
 * so the expectations below add (93.75, 110). The one deliberate difference:
 * chart-kit clamps any arc ending at 2π back by 1e-4 rad, so its final slice
 * stopped at x = -0.0088 instead of 0. We close exactly on 2π (and use a
 * <Circle> for the single-slice case), which is why the last slice lands on
 * (93.75, 22) rather than (93.7412, 22).
 */
const FIXTURE = {
  values: [50, 30, 20],
  radius: 220 / 2.5,
  cx: (375 - 60) / 2 / 2 + 15,
  cy: 220 / 2,
};

const allNumbersIn = (path: string): number[] =>
  (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe('computePieSlices', () => {
  describe('parity with the recorded chart-kit fixture', () => {
    it('resolves the same centre and radius', () => {
      expect(FIXTURE.cx).toBe(93.75);
      expect(FIXTURE.cy).toBe(110);
      expect(FIXTURE.radius).toBe(88);
    });

    it('starts at 12 o’clock and sweeps clockwise', () => {
      const [first] = computePieSlices(FIXTURE);

      expect(first.startAngle).toBe(0);
      // 50 of 100 → half the circle.
      expect(first.endAngle).toBeCloseTo(Math.PI, 12);
      // Starts straight up from the centre, ends straight down: clockwise.
      expect(first.path).toContain('L 93.75 22 ');
      expect(first.path).toContain('A 88 88 0 0 1 93.75 198');
      // SVG sweep-flag is the `1` before the end point.
      expect(first.path).toMatch(/A 88 88 0 [01] 1 /);
    });

    it('reproduces every chart-kit slice boundary', () => {
      const slices = computePieSlices(FIXTURE);
      expect(slices).toHaveLength(3);

      const boundaries = [
        ...slices.map((s) =>
          pointOnCircle(FIXTURE.cx, FIXTURE.cy, FIXTURE.radius, s.startAngle)
        ),
        pointOnCircle(
          FIXTURE.cx,
          FIXTURE.cy,
          FIXTURE.radius,
          slices[2].endAngle
        ),
      ];

      // chart-kit's group-relative points, shifted into absolute coordinates.
      expect(boundaries[0]).toEqual({ x: 93.75, y: 22 }); // 0 + 93.75, -88 + 110
      expect(boundaries[1]).toEqual({ x: 93.75, y: 198 }); // 0 + 93.75, 88 + 110
      expect(boundaries[2].x).toBeCloseTo(-83.692973 + 93.75, 5);
      expect(boundaries[2].y).toBeCloseTo(-27.193496 + 110, 5);
      // chart-kit stopped 1e-4 rad short here (x = -0.0088 relative); we close
      // exactly on 2π, back at the 12 o'clock start.
      expect(boundaries[3]).toEqual({ x: 93.75, y: 22 });
    });

    it('sets the large-arc flag only for slices over half the circle', () => {
      const slices = computePieSlices({ ...FIXTURE, values: [70, 30] });

      expect(slices[0].path).toMatch(/A 88 88 0 1 1 /); // 252° → large
      expect(slices[1].path).toMatch(/A 88 88 0 0 1 /); // 108° → not large
    });

    it('keeps `absolute` semantics — proportions follow the raw values', () => {
      const slices = computePieSlices(FIXTURE);
      const sweeps = slices.map((s) => s.endAngle - s.startAngle);

      expect(sweeps[0] / TWO_PI).toBeCloseTo(0.5, 12);
      expect(sweeps[1] / TWO_PI).toBeCloseTo(0.3, 12);
      expect(sweeps[2] / TWO_PI).toBeCloseTo(0.2, 12);
    });
  });

  describe('edge semantics', () => {
    it('renders nothing for zero slices', () => {
      expect(computePieSlices({ ...FIXTURE, values: [] })).toEqual([]);
    });

    it('renders nothing when the total is zero — no division by zero', () => {
      const slices = computePieSlices({ ...FIXTURE, values: [0, 0, 0] });

      expect(slices).toEqual([]);
      expect(slices.every((s) => Number.isFinite(s.startAngle))).toBe(true);
    });

    it('renders nothing for a non-positive radius or a non-finite centre', () => {
      expect(computePieSlices({ ...FIXTURE, radius: 0 })).toEqual([]);
      expect(computePieSlices({ ...FIXTURE, radius: -5 })).toEqual([]);
      expect(computePieSlices({ ...FIXTURE, cx: NaN })).toEqual([]);
      expect(computePieSlices({ ...FIXTURE, cy: Infinity })).toEqual([]);
    });

    it('emits a full circle for one slice, not a degenerate 0→2π arc', () => {
      const slices = computePieSlices({ ...FIXTURE, values: [42] });

      expect(slices).toHaveLength(1);
      expect(slices[0].isFullCircle).toBe(true);
      expect(slices[0].startAngle).toBe(0);
      expect(slices[0].endAngle).toBe(TWO_PI);
      // A single arc path here would paint nothing at all.
      expect(slices[0].path).toBe('');
    });

    it('treats one non-zero slice among zeros as the full circle too', () => {
      const slices = computePieSlices({ ...FIXTURE, values: [0, 7, 0] });

      expect(slices).toHaveLength(1);
      expect(slices[0].index).toBe(1);
      expect(slices[0].isFullCircle).toBe(true);
    });

    it('drops zero-value slices but still tiles the whole circle', () => {
      const slices = computePieSlices({
        ...FIXTURE,
        values: [10, 0, 30, 0, 60],
      });

      expect(slices.map((s) => s.index)).toEqual([0, 2, 4]);
      expect(slices[0].startAngle).toBe(0);
      expect(slices[slices.length - 1].endAngle).toBe(TWO_PI);
    });

    it('ignores negative and non-finite values', () => {
      const slices = computePieSlices({
        ...FIXTURE,
        values: [50, -30, NaN, Infinity, 50],
      });

      expect(slices.map((s) => s.index)).toEqual([0, 4]);
      expect(slices[0].endAngle).toBeCloseTo(Math.PI, 12);
    });

    it('tiles 2π with no gaps or overlap for many slices', () => {
      const values = [13, 1, 47, 2.5, 0.75, 9, 120, 33, 4, 88];
      const slices = computePieSlices({ ...FIXTURE, values });

      expect(slices).toHaveLength(values.length);
      const total = slices.reduce(
        (sum, s) => sum + (s.endAngle - s.startAngle),
        0
      );
      expect(Math.abs(total - TWO_PI)).toBeLessThan(1e-9);

      slices.forEach((slice, i) => {
        expect(slice.endAngle).toBeGreaterThan(slice.startAngle);
        if (i > 0) {
          // Adjacent: previous end IS this start — no gap, no overlap.
          expect(slice.startAngle).toBe(slices[i - 1].endAngle);
        }
      });
      expect(slices[0].startAngle).toBe(0);
      expect(slices[slices.length - 1].endAngle).toBe(TWO_PI);
    });

    it('never emits NaN coordinates', () => {
      const cases: number[][] = [
        [50, 30, 20],
        [1],
        [1, 1],
        [0, 0, 1, 0],
        [1e-9, 1e9],
        [-1, 5, NaN, 5],
        new Array(64).fill(1),
      ];

      for (const values of cases) {
        for (const slice of computePieSlices({ ...FIXTURE, values })) {
          expect(Number.isFinite(slice.startAngle)).toBe(true);
          expect(Number.isFinite(slice.endAngle)).toBe(true);
          expect(slice.path).not.toMatch(/NaN|Infinity|undefined/);
          for (const n of allNumbersIn(slice.path)) {
            expect(Number.isFinite(n)).toBe(true);
          }
        }
      }
    });
  });
});

describe('pointOnCircle', () => {
  it('places angle 0 at 12 o’clock and advances clockwise', () => {
    expect(pointOnCircle(0, 0, 10, 0)).toEqual({ x: 0, y: -10 });
    expect(pointOnCircle(0, 0, 10, Math.PI / 2)).toEqual({ x: 10, y: 0 });
    expect(pointOnCircle(0, 0, 10, Math.PI)).toEqual({ x: 0, y: 10 });
    expect(pointOnCircle(0, 0, 10, (3 * Math.PI) / 2)).toEqual({
      x: -10,
      y: 0,
    });
  });
});
