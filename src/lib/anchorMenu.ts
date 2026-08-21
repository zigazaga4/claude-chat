/**
 * Placement for the composer's portalled popovers.
 *
 * The composer clips overflow, so these menus are rendered into a portal and
 * positioned by hand against their trigger. Doing that naively — `left` copied
 * straight off the trigger's rect — puts the menu off the right edge of any
 * screen narrower than trigger-offset plus menu width, which on a phone is
 * every one of them.
 *
 * Shared by ModelPicker and BackendPicker: identical placement logic living in
 * two files is how they end up fixed in one and not the other.
 */

export type MenuCoords = {
  left: number;
  /** Distance from the viewport bottom — these menus open upward. */
  bottom: number;
  /** Cap so a long option label cannot widen the menu past the screen. */
  maxWidth: number;
};

/** Breathing room kept between the menu and every viewport edge. */
const MARGIN = 8;

/**
 * Position a menu above `trigger`, clamped to stay fully on screen.
 *
 * `measuredWidth` should be the menu's real `offsetWidth` when it is already
 * in the DOM; callers pass their preferred width on the first pass, when it
 * is not, and re-run once it is.
 *
 * Measures against `visualViewport` where available. That is the viewport the
 * software keyboard shrinks — `innerHeight` does not change when it opens, so
 * anchoring to it would push the menu behind the keyboard.
 */
export function placeMenuAbove(trigger: HTMLElement, measuredWidth: number): MenuCoords {
  const r = trigger.getBoundingClientRect();
  const vv = window.visualViewport;
  const vw = vv?.width ?? window.innerWidth;
  const vh = vv?.height ?? window.innerHeight;

  const maxWidth = Math.max(160, vw - MARGIN * 2);
  const width = Math.min(measuredWidth, maxWidth);

  // Prefer left-aligned with the trigger, but never past the right edge, and
  // never off the left. The outer Math.max guards the degenerate case where
  // the menu is wider than the viewport and the two bounds cross.
  const rightBound = Math.max(MARGIN, vw - width - MARGIN);
  const left = Math.min(Math.max(MARGIN, r.left), rightBound);

  return { left, bottom: Math.max(MARGIN, vh - r.top + 6), maxWidth };
}
