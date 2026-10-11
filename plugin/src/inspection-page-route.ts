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
 * So exactly one parameter is admitted on a page route, with the same charset
 * the harness flag already validates. It carries no capability: an attacker
 * who can set it can only make the wearer's own frame slower or uglier, and
 * the page ignores any value it cannot parse. Nothing else is widened.
 */

/** The one query parameter a page route may carry. */
export const RENDER_BUDGET_PARAM = 'xrRenderBudget';

/** Knob lists are `key:value` pairs separated by `,` or `;`. */
const RENDER_BUDGET_VALUE = /^[A-Za-z0-9_.,;:=-]{1,128}$/u;

/**
 * The same allowlist as an expression for a served page to evaluate: the
 * page's own `?xrRenderBudget=` re-spelled as a search string, or `''`.
 *
 * The pairing page redirects to `/viewer`, so without this the knobs a wearer
 * typed are dropped one hop before the page that reads them, and the route
 * widening above would buy nothing on hardware. Rebuilding the parameter
 * rather than forwarding `location.search` whole keeps the allowlist in one
 * place: nothing else a wearer can put in the address survives the hop.
 */
export function renderBudgetSearchSource(): string {
  return `(()=>{try{const v=new URLSearchParams(location.search).get(${JSON.stringify(RENDER_BUDGET_PARAM)});`
    + `return v&&/${RENDER_BUDGET_VALUE.source}/u.test(v)`
    + `?'?${RENDER_BUDGET_PARAM}='+encodeURIComponent(v):''}catch(error){return ''}})()`;
}

/**
 * Whether `url` addresses the page at `path`, with no query or with only a
 * well-formed `?xrRenderBudget=`.
 *
 * @param url `request.url`, which is a path with an optional query
 * @param path the exact route, with no query of its own
 */
export function isPageRoute(url: string | undefined, path: string): boolean {
  if (typeof url !== 'string') return false;
  if (url === path) return true;
  if (!url.startsWith(`${path}?`)) return false;
  const query = url.slice(path.length + 1);
  // One pair, that pair being the budget knobs. A second parameter, a repeat,
  // or an empty value is not a page address. The value may itself contain `=`
  // (`scale=0.6` is a knob), so only the first one separates the pair.
  const split = query.indexOf('=');
  if (split < 0 || query.slice(0, split) !== RENDER_BUDGET_PARAM) return false;
  let value: string;
  try { value = decodeURIComponent(query.slice(split + 1)); }
  catch { return false; }
  return RENDER_BUDGET_VALUE.test(value);
}
