/**
 * How tall this app asks its host card to be.
 *
 * The ext-apps `App` defaults to `autoResize: true`, which measures
 * `document.documentElement` with `height: max-content` on every
 * `ResizeObserver` tick and sends the measured height to the host as
 * `ui/notifications/size-changed`
 * (`@modelcontextprotocol/ext-apps/dist/src/app.js`,
 * `setupSizeChangedNotifications`). That measurement is meaningless for this
 * viewer: the shell is `height: 100%` around a flex stage with no intrinsic
 * height, so `max-content` reports whatever the canvas happened to be, the
 * host applies it, the canvas shrinks to match, and the loop converges on a
 * thin strip. On a Codex desktop mount the card settled at roughly
 * 1450 x 470 CSS px, and a window compression produced a visible resize
 * thrash at 440 x 720.
 *
 * So the app turns `autoResize` off and owns its own height. The height is a
 * function of the width alone, which is the property that stops the thrash:
 * a height this module returns can never change the width that produced it,
 * so applying it cannot feed back into the next measurement.
 *
 * What Codex actually does with the report, read out of its desktop bundle:
 *
 * - The reported height is stored; the reported width is parsed, validated
 *   and discarded. The frame's width comes from its target rectangle.
 * - The stored height is clamped to a fixed host band of 200 to 720 CSS px,
 *   `Math.min(Math.max(reported ?? hint ?? 240, minFrameHeight ?? 200), 720)`.
 * - An app that reports nothing at all gets 240 px.
 *
 * This module's own 600 to 720 band therefore sits inside the host's, so
 * every height it returns survives Codex's clamp unchanged.
 */

/**
 * Aspect the card is asked for: a 4:2.8 stage is roughly what a side-by-side
 * pair needs before each eye's viewport becomes too narrow to fuse.
 */
export const PANEL_ASPECT = 0.7;

/**
 * Below this the stage stops being a viewer.
 *
 * The aspect alone is too mean for the shapes a chat card actually takes. A
 * 440 CSS px side card would ask for 308 px and the inline Codex chat card,
 * about 700 px wide, would ask for 490 px. Card mode holds the header, the
 * scene heading and the readiness line to about 110 px together, so 490 px
 * leaves the stage under 380 px while the same chrome costs nothing extra in
 * a taller card. Asking for 600 buys the stage 220 px for 110 px of chrome.
 *
 * 600 is still inside the host's own 200 to 720 clamp, so Codex grants it.
 */
export const PANEL_MIN_HEIGHT_PX = 600;

/**
 * The top of Codex's own clamp band. A wide card is capped here rather than
 * growing without limit, and asking for more would be silently reduced to
 * this anyway.
 */
export const PANEL_MAX_HEIGHT_PX = 720;

export interface PanelHeightInput {
  /** Current app width in CSS px, normally `window.innerWidth`. */
  width: number;
  /**
   * A container height the host states as fixed, if it states one. This is
   * not a request the host can grant or refuse: it is what the container
   * already is, so it is returned unchanged.
   */
  fixedHeight?: number;
  /**
   * The measured height of the panel's content, set only while the panel
   * holds no structure (a scene compatibility check). There is no stage to
   * size then, and asking for the stage's height drew the notice above 400 px
   * of empty panel. The panel measures its shell at natural height rather than
   * at the card's height, so this too depends on the width alone.
   */
  contentHeight?: number;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Read a *fixed* container height out of the host's container dimensions.
 *
 * `maxHeight` is deliberately not read, and this is the correction that
 * matters. `McpUiHostContext.containerDimensions` looks like a pair of host
 * limits, but in Codex it is built by `{maxHeight: el.clientHeight, maxWidth:
 * el.clientWidth}`: it is the card's *current* measured size,
 * republished by a `ResizeObserver` on every layout change. Capping to it
 * would pin the card to whatever height it already had, so a card that
 * arrived short could never grow — a self-locking loop, and the exact failure
 * this module exists to remove.
 *
 * A `height` field is a different claim: the spec defines it as a fixed
 * container height (`ext-apps/dist/src/spec.types.d.ts`,
 * `McpUiHostContext.containerDimensions`), so a host that sends one is
 * describing a box that will not change, and it wins.
 */
export function panelFixedHeight(containerDimensions: unknown): number | undefined {
  if (typeof containerDimensions !== 'object' || containerDimensions == null) return undefined;
  return finite((containerDimensions as Record<string, unknown>).height);
}

/**
 * The height this app asks the host for, in CSS px.
 *
 * `clamp(round(width * 0.7), 600, 720)`, unless the host states a fixed
 * container height, which is returned unchanged. A panel with no structure
 * asks for its content height instead, capped at 720.
 */
export function desiredPanelHeight(input: PanelHeightInput): number {
  const fixed = finite(input.fixedHeight);
  if (fixed !== undefined) return Math.round(fixed);
  const content = finite(input.contentHeight);
  if (content !== undefined) return Math.min(Math.ceil(content), PANEL_MAX_HEIGHT_PX);
  const width = finite(input.width) ?? 0;
  const wanted = Math.round(width * PANEL_ASPECT);
  return Math.min(Math.max(wanted, PANEL_MIN_HEIGHT_PX), PANEL_MAX_HEIGHT_PX);
}
