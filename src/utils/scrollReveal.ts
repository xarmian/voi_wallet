/**
 * Reveal rule for a focused field inside a vertical scroll view whose bottom
 * band is covered (by the keyboard and anything drawn on top of it, such as a
 * suggestions bar). All values are in points; `fieldTop` is in scroll-content
 * coordinates, so the field sits at `fieldTop - scrollY` within the viewport.
 */
export interface RevealInput {
  /** Top edge of the field in scroll-content coordinates. */
  fieldTop: number;
  fieldHeight: number;
  /** Current vertical content offset of the scroll view. */
  scrollY: number;
  /** Height of the scroll view's own frame. */
  viewportHeight: number;
  /** Height of the band at the bottom of the viewport that is covered. */
  obscuredBottom: number;
  /** Gap kept between the field and the visible area's edge after a scroll. */
  margin: number;
}

/**
 * Returns the content offset that brings the field fully into the visible
 * area (between the viewport's top and the covered band's top), or null when
 * no scroll is needed. A field that is already fully visible is never moved,
 * whatever the current scroll position, so a manual scroll is left alone.
 *
 * - Below (or under the band): scroll the minimum, so the field's bottom edge
 *   sits `margin` above the band. A field taller than the visible area is
 *   top-aligned instead, so its top stays in view.
 * - Above the viewport's top: scroll so its top sits `margin` below the top.
 * - Never negative; null if the target equals the current offset or nothing
 *   of the viewport is visible.
 */
export function computeRevealOffset({
  fieldTop,
  fieldHeight,
  scrollY,
  viewportHeight,
  obscuredBottom,
  margin,
}: RevealInput): number | null {
  const visibleHeight = viewportHeight - Math.max(0, obscuredBottom);
  if (!(visibleHeight > 0) || !(fieldHeight >= 0)) return null;

  const fieldBottom = fieldTop + fieldHeight;
  const visibleTop = scrollY;
  const visibleBottom = scrollY + visibleHeight;
  if (fieldTop >= visibleTop && fieldBottom <= visibleBottom) return null;

  const topAligned = fieldTop - margin;
  const target =
    fieldTop < visibleTop
      ? topAligned
      : Math.min(fieldBottom + margin - visibleHeight, topAligned);

  const offset = Math.max(0, target);
  return offset === scrollY ? null : offset;
}
