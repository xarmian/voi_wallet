/**
 * Regression tests for the centre tab button's geometry (TASK-563).
 *
 * The bug: the FAB sat at a fixed `bottom: 20` with a 60pt diameter, while
 * the tab bar is `49 + insets.bottom` tall. With no bottom inset (iPhone SE)
 * it stuck ~31pt above the bar; with an inset it sat off-centre in the icon
 * row; on Android the position varied with the system nav bar. These tests
 * pin the button to the tab bar's content row on every inset.
 */
import {
  FAB_SIZE,
  TAB_BAR_CONTENT_HEIGHT,
  fabBottomOffset,
} from '../fabGeometry';

/** Distance from the screen bottom to the button's top edge. */
const fabTop = (inset: number) => fabBottomOffset(inset) + FAB_SIZE;
/** Distance from the screen bottom to the button's centre. */
const fabCentre = (inset: number) => fabBottomOffset(inset) + FAB_SIZE / 2;
/** Distance from the screen bottom to the centre of the icon row. */
const rowCentre = (inset: number) => inset + TAB_BAR_CONTENT_HEIGHT / 2;

describe('fabBottomOffset', () => {
  it('seats the button inside the bar with no bottom inset (iPhone SE)', () => {
    expect(fabTop(0)).toBeLessThanOrEqual(TAB_BAR_CONTENT_HEIGHT);
    expect(fabCentre(0)).toBe(24.5);
    expect(fabCentre(0)).toBe(rowCentre(0));
  });

  it('centres the button on the icon row above a 34pt home indicator inset', () => {
    expect(fabTop(34)).toBeLessThanOrEqual(34 + TAB_BAR_CONTENT_HEIGHT);
    expect(fabTop(34)).toBeLessThanOrEqual(83);
    expect(fabCentre(34)).toBe(58.5);
    expect(fabCentre(34)).toBe(rowCentre(34));
  });

  it('centres the button on the icon row above Android 3-button nav (48)', () => {
    expect(fabTop(48)).toBeLessThanOrEqual(48 + TAB_BAR_CONTENT_HEIGHT);
    expect(fabCentre(48)).toBe(72.5);
    expect(fabCentre(48)).toBe(rowCentre(48));
  });

  it('never sits below the safe-area inset', () => {
    for (const inset of [0, 20, 34, 48]) {
      expect(fabBottomOffset(inset)).toBeGreaterThanOrEqual(inset);
    }
  });
});

describe('FAB_SIZE', () => {
  it('fits inside the tab bar content row', () => {
    expect(FAB_SIZE).toBeLessThanOrEqual(TAB_BAR_CONTENT_HEIGHT);
  });
});
