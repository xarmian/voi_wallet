/**
 * TASK-554: the reveal rule for a focused field inside a scroll view whose
 * bottom is covered by the keyboard and an overlay above it (the recovery-word
 * suggestions bar). Coordinates are scroll-content coordinates: a field at
 * fieldTop is on screen at fieldTop - scrollY within the viewport.
 */
import { computeRevealOffset } from '../scrollReveal';

// A 600-high viewport with a 300-high keyboard and a 56-high suggestions bar
// above it: rows of content from scrollY to scrollY + 244 are visible.
const base = {
  fieldHeight: 56,
  viewportHeight: 600,
  obscuredBottom: 300 + 56,
  margin: 12,
};

describe('computeRevealOffset', () => {
  it('returns null when the field is already fully visible', () => {
    expect(computeRevealOffset({ ...base, fieldTop: 20, scrollY: 0 })).toBe(
      null
    );
    // Visible after a manual scroll: still no scroll, whatever the offset.
    expect(computeRevealOffset({ ...base, fieldTop: 400, scrollY: 300 })).toBe(
      null
    );
  });

  it('treats a field exactly touching the visible edges as visible', () => {
    // Top edge at the viewport top, and bottom edge at the band's top.
    expect(computeRevealOffset({ ...base, fieldTop: 100, scrollY: 100 })).toBe(
      null
    );
    expect(computeRevealOffset({ ...base, fieldTop: 188, scrollY: 0 })).toBe(
      null
    );
  });

  it('scrolls a field below the band the minimum amount: bottom edge at band top minus margin', () => {
    // Field 500..556; visible bottom 244; target = 556 + 12 - 244.
    expect(computeRevealOffset({ ...base, fieldTop: 500, scrollY: 0 })).toBe(
      324
    );
    // From a scrolled position the result is still absolute and minimal.
    expect(computeRevealOffset({ ...base, fieldTop: 500, scrollY: 100 })).toBe(
      324
    );
  });

  it('scrolls a field that sits above the keyboard but behind the suggestions bar', () => {
    // Field 224..280: above the keyboard's top (300) but under the bar
    // (244..300). Measured against the keyboard alone it would count as
    // visible; that is the reported bug.
    expect(
      computeRevealOffset({
        ...base,
        obscuredBottom: 300,
        fieldTop: 224,
        scrollY: 0,
      })
    ).toBe(null);
    expect(computeRevealOffset({ ...base, fieldTop: 224, scrollY: 0 })).toBe(
      48
    );
  });

  it('scrolls a field above the viewport so its top sits at the margin', () => {
    expect(computeRevealOffset({ ...base, fieldTop: 200, scrollY: 300 })).toBe(
      188
    );
    // Partly above (top cut off, bottom visible) counts as hidden too.
    expect(computeRevealOffset({ ...base, fieldTop: 280, scrollY: 300 })).toBe(
      268
    );
  });

  it('never returns a negative offset', () => {
    const offset = computeRevealOffset({ ...base, fieldTop: 5, scrollY: 50 });
    expect(offset).toBe(0);
  });

  it('shows the top of a field taller than the visible area', () => {
    // 300-high field, 244 visible: aligning its bottom would hide its top.
    expect(
      computeRevealOffset({
        ...base,
        fieldHeight: 300,
        fieldTop: 400,
        scrollY: 0,
      })
    ).toBe(388);
  });

  it('returns null when nothing of the viewport is visible, or the target is the current offset', () => {
    expect(
      computeRevealOffset({
        ...base,
        obscuredBottom: 600,
        fieldTop: 500,
        scrollY: 0,
      })
    ).toBe(null);
    // A tall field already top-aligned at the margin: no no-op scroll call.
    expect(
      computeRevealOffset({
        ...base,
        fieldHeight: 300,
        fieldTop: 400,
        scrollY: 388,
      })
    ).toBe(null);
  });
});
