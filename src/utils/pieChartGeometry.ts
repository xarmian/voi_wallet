/**
 * Pure slice geometry for the hand-rolled `react-native-svg` pie chart.
 *
 * This replaces the arc math that `react-native-chart-kit` (via `paths-js`)
 * used to do for `AccountInfoScreen`'s asset-distribution pie. The conventions
 * below were measured from the chart-kit output, not assumed — see
 * `__tests__/pieChartGeometry.test.ts` for the recorded parity fixture.
 *
 * Conventions (matching the previous rendering exactly):
 * - Angles are radians, `0` at 12 o'clock, increasing **clockwise** on screen.
 *   A point at angle `a` is `(cx + r*sin(a), cy - r*cos(a))`.
 * - Slices are laid out in array order starting from `0`, so slice `i` sits
 *   clockwise of slice `i - 1`. The hand-rolled legend is ordered to match.
 * - Arcs use SVG `sweep-flag = 1` (clockwise) and set `large-arc-flag` when the
 *   slice spans more than half the circle.
 *
 * Intentionally free of React, theming and `Dimensions` — callers resolve the
 * geometry and the palette and pass concrete numbers in.
 */

export interface PieGeometryInput {
  /** Raw slice magnitudes, in render order. Non-finite/negative are treated as 0. */
  values: number[];
  /** Outer radius in SVG user units. */
  radius: number;
  /** Centre x in SVG user units. */
  cx: number;
  /** Centre y in SVG user units. */
  cy: number;
}

export interface PieSlice {
  /** Index into the original `values` array — use it to look up colour/label. */
  index: number;
  /** Slice start angle in radians (0 = 12 o'clock, clockwise). */
  startAngle: number;
  /** Slice end angle in radians. */
  endAngle: number;
  /**
   * True when this slice covers the whole circle. An SVG arc from 0 to 2π is
   * degenerate and paints nothing, so callers MUST render a `<Circle>` (or two
   * half-arcs) for these and ignore `path`. This is the common
   * single-asset-account case.
   */
  isFullCircle: boolean;
  /** SVG path `d` for the wedge. Empty string when `isFullCircle` is true. */
  path: string;
}

const TWO_PI = Math.PI * 2;

/**
 * Match paths-js' 6-decimal path formatting so output stays compact and stable.
 * Normalises `-0` to `0` — cos/sin produce it at the cardinal angles.
 */
const round6 = (n: number): number => {
  const r = Math.round(n * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};

const normalizeValue = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Cartesian point on the pie's rim at `angle`.
 * Exported for tests; not part of the render path.
 */
export const pointOnCircle = (
  cx: number,
  cy: number,
  radius: number,
  angle: number
): { x: number; y: number } => ({
  x: round6(cx + radius * Math.sin(angle)),
  y: round6(cy - radius * Math.cos(angle)),
});

/**
 * Build drawable descriptors for a pie.
 *
 * Returns `[]` — draw nothing — when there is no geometry to draw: empty input,
 * a zero total, a non-positive radius, or a non-finite centre. Slices whose
 * value is zero are omitted rather than emitted as zero-width wedges; the
 * surviving slices' angles still tile the full circle.
 */
export function computePieSlices({
  values,
  radius,
  cx,
  cy,
}: PieGeometryInput): PieSlice[] {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    !Number.isFinite(cx) ||
    !Number.isFinite(cy)
  ) {
    return [];
  }

  const safeValues = values.map(normalizeValue);
  const total = safeValues.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return [];

  const drawableCount = safeValues.filter((v) => v > 0).length;
  const slices: PieSlice[] = [];

  let consumed = 0;
  for (let index = 0; index < safeValues.length; index++) {
    const value = safeValues[index];
    if (value === 0) continue;

    const startAngle = (consumed / total) * TWO_PI;
    consumed += value;
    // Pin the final slice to exactly 2π so the angles sum without float drift.
    const endAngle =
      slices.length === drawableCount - 1
        ? TWO_PI
        : (consumed / total) * TWO_PI;

    if (drawableCount === 1) {
      slices.push({
        index,
        startAngle: 0,
        endAngle: TWO_PI,
        isFullCircle: true,
        path: '',
      });
      continue;
    }

    const start = pointOnCircle(cx, cy, radius, startAngle);
    const end = pointOnCircle(cx, cy, radius, endAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

    slices.push({
      index,
      startAngle,
      endAngle,
      isFullCircle: false,
      path:
        `M ${round6(cx)} ${round6(cy)} L ${start.x} ${start.y} ` +
        `A ${round6(radius)} ${round6(radius)} 0 ${largeArc} 1 ${end.x} ${end.y} Z`,
    });
  }

  return slices;
}
