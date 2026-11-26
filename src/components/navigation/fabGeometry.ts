/**
 * Geometry for the centre tab button (FABRadialMenu) — TASK-563.
 *
 * The button is an absolute overlay beside the Tab.Navigator, not a real tab
 * item, so it must be placed to match the tab bar by hand. The bar is
 * `TAB_BAR_CONTENT_HEIGHT + insets.bottom` tall: a content row holding the
 * tab icons, sitting on top of the bottom safe-area inset (home indicator on
 * iOS, system nav bar on Android edge-to-edge). Seating the button on that
 * row keeps it inside the bar on every inset.
 *
 * Kept pure so it is unit-testable without rendering — see the header comment
 * in fabMenuParams.ts.
 */

/**
 * Height of the tab bar's content row. Mirrors `TABBAR_HEIGHT_UIKIT` in
 * @react-navigation/bottom-tabs' BottomTabBar. That is the height bottom-tabs
 * uses in portrait with no custom `tabBarStyle.height`; the app is
 * portrait-only (app.config.js), so the compact landscape height never
 * applies. Update this if either assumption changes.
 */
export const TAB_BAR_CONTENT_HEIGHT = 49;

/** Diameter of the centre button: the largest that fits the content row. */
export const FAB_SIZE = 48;

/**
 * Distance from the screen bottom to the button's bottom edge, so the button
 * is vertically centred on the tab bar's content row above `insetBottom`.
 */
export function fabBottomOffset(insetBottom: number): number {
  return insetBottom + (TAB_BAR_CONTENT_HEIGHT - FAB_SIZE) / 2;
}
