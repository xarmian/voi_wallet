/**
 * TASK-77 — render smoke test for the hand-rolled `react-native-svg` pie that
 * replaced `react-native-chart-kit`'s `PieChart` in AccountInfoScreen.
 *
 * The arc math itself is covered by `src/utils/__tests__/pieChartGeometry.test.ts`.
 * What this file proves is the wiring: that the component mounts, emits one SVG
 * element per slice, colours them from the distribution in array order (so the
 * hand-rolled legend below the chart stays aligned with the wedges), and does
 * not throw on the zero- and one-slice cases.
 */

import React from 'react';
import { Dimensions } from 'react-native';
import { render } from '@testing-library/react-native';

// AccountInfoScreen is a large screen module; the pie is one exported piece of
// it. These stubs exist only to make the module importable under jest — the
// same shims the other screen-level render tests in this directory use. None of
// them is reachable from AssetDistributionPie, which takes plain data and
// renders react-native-svg (kept real, since the SVG output is what we assert).
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: {} }),
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: (factory: (theme: unknown) => unknown) =>
    factory(require('@/constants/themes').lightTheme),
}));
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => null,
  useAccountEnvoiName: () => null,
  useMultiNetworkBalance: () => null,
  useWalletStore: () => ({}),
}));
jest.mock('@/services/network', () => ({ NetworkService: {} }));
jest.mock('@/services/mimir', () => ({ MimirApiService: {} }));
jest.mock('@/services/envoi', () => ({ __esModule: true, default: {} }));
jest.mock('@/components/envoi/EnvoiProfileCard', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/BlurredContainer', () => ({
  BlurredContainer: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));

import {
  AssetDistributionPie,
  ASSET_DISTRIBUTION_COLORS,
} from '../AccountInfoScreen';

type Distribution = React.ComponentProps<typeof AssetDistributionPie>['data'];

// The layout constants the component derives from the screen width, mirrored
// here so the assertions do not hardcode jest's window size.
const chartWidth = Dimensions.get('window').width - 60;
const radius = 220 / 2.5;
const cx = chartWidth / 4 + 15;
const cy = 220 / 2;

/** react-native-svg stores a resolved colour as an ARGB integer payload. */
const rgbaPayload = (hex: string) =>
  (0xff000000 | parseInt(hex.slice(1), 16)) >>> 0;

const distribution = (populations: number[]): Distribution =>
  populations.map((population, i) => ({
    name: `Asset ${i} (${population}%)`,
    population,
    color: ASSET_DISTRIBUTION_COLORS[i % ASSET_DISTRIBUTION_COLORS.length],
    legendFontColor: '#ffffff',
    legendFontSize: 11,
    percentage: population,
    assetSymbol: `A${i}`,
  }));

/** The subset of a rendered react-native-svg host node these tests read. */
interface SvgHostNode {
  props: { d?: string; r?: number | string; fill?: { payload?: number } };
}

// react-test-renderer host names for react-native-svg's rendered components.
const findHosts = (
  tree: ReturnType<typeof render>,
  hostName: string
): SvgHostNode[] => tree.UNSAFE_root.findAllByType(hostName as never);

const paths = (tree: ReturnType<typeof render>) => findHosts(tree, 'RNSVGPath');
const circles = (tree: ReturnType<typeof render>) =>
  findHosts(tree, 'RNSVGCircle');

describe('AssetDistributionPie', () => {
  it('mounts and emits one path per slice for a representative distribution', () => {
    const data = distribution([50, 30, 20]);
    const tree = render(<AssetDistributionPie data={data} />);

    expect(paths(tree)).toHaveLength(3);
    expect(circles(tree)).toHaveLength(0);
  });

  it('fills the slices in array order, matching the hand-rolled legend', () => {
    const data = distribution([50, 30, 20]);
    const tree = render(<AssetDistributionPie data={data} />);
    const rendered = paths(tree);

    // The legend at the bottom of the card lists `assetDistribution` in the
    // same array order, so slice N must carry item N's colour.
    expect(rendered.map((p) => p.props.fill?.payload)).toEqual(
      data.map((d) => rgbaPayload(d.color))
    );

    const ds = rendered.map((p) => String(p.props.d));
    ds.forEach((d) => expect(d).not.toMatch(/NaN|Infinity|undefined/));
    // Each slice starts where the previous one ended, sweeping clockwise from
    // 12 o'clock — the same traversal order the legend lists. (The absolute
    // numbers depend on the screen width; the fixed-width parity numbers are
    // pinned in src/utils/__tests__/pieChartGeometry.test.ts.)
    const top = `L ${cx} ${cy - radius} `;
    const bottom = `L ${cx} ${cy + radius} `;
    expect(ds[0]).toContain(top); // 50% starts at 12 o'clock
    expect(ds[0]).toContain(`1 ${cx} ${cy + radius} Z`); // …and ends at 6
    expect(ds[1]).toContain(bottom); // 30% picks up at 6 o'clock
  });

  it('renders a single-slice distribution as a full circle, not a blank arc', () => {
    const data = distribution([100]);
    const tree = render(<AssetDistributionPie data={data} />);

    expect(paths(tree)).toHaveLength(0);
    const [circle] = circles(tree);
    expect(circle).toBeDefined();
    expect(Number(circle.props.r)).toBeGreaterThan(0);
  });

  it('does not throw and draws nothing for an empty distribution', () => {
    const tree = render(<AssetDistributionPie data={[]} />);

    expect(paths(tree)).toHaveLength(0);
    expect(circles(tree)).toHaveLength(0);
  });

  it('does not throw and draws nothing when every population is zero', () => {
    const tree = render(
      <AssetDistributionPie data={distribution([0, 0, 0])} />
    );

    expect(paths(tree)).toHaveLength(0);
    expect(circles(tree)).toHaveLength(0);
  });
});

describe('ASSET_DISTRIBUTION_COLORS', () => {
  it('assigns 8 slices eight distinct colours', () => {
    const data = distribution([8, 7, 6, 5, 4, 3, 2, 1]);
    const assigned = data.map((d) => d.color.toLowerCase());

    expect(assigned).toHaveLength(8);
    expect(new Set(assigned).size).toBe(8);
    // Regression guard: index 6 used to repeat index 0.
    expect(assigned[6]).not.toBe(assigned[0]);
  });

  it('has no duplicate hue anywhere in the palette', () => {
    const normalized = ASSET_DISTRIBUTION_COLORS.map((c) => c.toLowerCase());

    expect(new Set(normalized).size).toBe(ASSET_DISTRIBUTION_COLORS.length);
  });
});
