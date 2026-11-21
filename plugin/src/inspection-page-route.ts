/**
 * Which request URLs count as "the wearer's page".
 *
 * Every route table in this package matched `request.url` exactly, and
 * `request.url` carries the query. That is deliberate for the capability
 * routes — a bearer or a page key must never be spellable as a query parameter
 * — and `inspection-companion-http.test.ts:96` pins it for `/xr-check`.
 *
 * It also meant the wearer's page 404'd the moment anything was appended to
 * its address, which silently disabled the entire `?xrRenderBudget=` knob
 * layer (`lab/browser-roundtrip/xr-render-budget.mjs`
 * `renderBudgetOverrides`, which reads `location.search`). Every A/B that
 * module documents — `postfx:on`, `light:off`, `palette:off`, `surface:lower`
 * — was unreachable on the emulator and on the headset alike, and
 * `companion-browser.ts --render-budget` returned a 404 page rather than a
 * frame.
 *
 * So a page route admits only the page settings below, each at most once,
 * each with its own value pattern. None carries a capability: someone who can
 * set one can only change how the wearer's own frame is drawn, and the page
 * ignores any value it cannot parse. Nothing else is widened.
 */

/** The render-budget knob list. */
export const RENDER_BUDGET_PARAM = 'xrRenderBudget';
/** The switch that draws the molecule into its own WebXR projection layer. */
export const XR_LAYERS_PARAM = 'xrLayers';
/**
 * Where the headset controls are drawn when the molecule has its own layer:
 * `quad` puts the menu column on a quad layer, `projection` keeps every
 * control on one projection layer.
 */
export const XR_UI_PARAM = 'xrUi';

/**
 * Every query parameter a page route may carry, with the values it accepts.
 * Knob lists are `key:value` pairs separated by `,` or `;`.
 */
const PAGE_SETTINGS: ReadonlyArray<readonly [string, RegExp]> = [
  [RENDER_BUDGET_PARAM, /^[A-Za-z0-9_.,;:=-]{1,128}$/u],
  [XR_LAYERS_PARAM, /^1$/u],
  [XR_UI_PARAM, /^(?:quad|projection)$/u],
];

/** Whether a page route admits `value`, already decoded, for the setting `key`. */
export function acceptsPageSetting(key: string, value: string): boolean {
  return PAGE_SETTINGS.some(([name, pattern]) => name === key && pattern.test(value));
}

/**
 * The same allowlist as an expression for a served page to evaluate: the
 * page's own settings re-spelled as a search string, or `''`.
 *
 * The pairing page redirects to `/viewer`, so without this the settings a
 * wearer typed are dropped one hop before the page that reads them, and the
 * route widening above would buy nothing on hardware. Rebuilding the
 * parameters rather than forwarding `location.search` whole keeps the
 * allowlist in one place: nothing else a wearer can put in the address
 * survives the hop.
 */
export function renderBudgetSearchSource(): string {
  const settings = JSON.stringify(PAGE_SETTINGS.map(([key, pattern]) => [key, pattern.source]));
  return `(()=>{try{const q=new URLSearchParams(location.search),out=[];`
    + `for(const [k,p] of ${settings}){const v=q.get(k);if(v&&new RegExp(p,'u').test(v))out.push(k+'='+encodeURIComponent(v))}`
    + `return out.length?'?'+out.join('&'):''}catch(error){return ''}})()`;
}

/**
 * Whether `url` addresses the page at `path`, with no query or with only
 * well-formed page settings, each at most once.
 *
 * @param url `request.url`, which is a path with an optional query
 * @param path the exact route, with no query of its own
 */
export function isPageRoute(url: string | undefined, path: string): boolean {
  if (typeof url !== 'string') return false;
  if (url === path) return true;
  if (!url.startsWith(`${path}?`)) return false;
  const seen = new Set<string>();
  for (const pair of url.slice(path.length + 1).split('&')) {
    // A value may itself contain `=` (`scale=0.6` is a knob), so only the
    // first one separates the pair.
    const split = pair.indexOf('=');
    if (split < 0) return false;
    const key = pair.slice(0, split);
    const pattern = PAGE_SETTINGS.find(([name]) => name === key)?.[1];
    if (!pattern || seen.has(key)) return false;
    seen.add(key);
    let value: string;
    try { value = decodeURIComponent(pair.slice(split + 1)); }
    catch { return false; }
    if (!pattern.test(value)) return false;
  }
  return true;
}
