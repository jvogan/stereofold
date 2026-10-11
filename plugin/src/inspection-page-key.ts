/**
 * The page key, kept out of the address bar.
 *
 * Every authenticated Stereofold page is handed its bearer in a URL fragment:
 * a fragment is the one part of a URL a browser never puts in a request line,
 * so the key reaches the page without touching an access log or a Referer
 * header. That was the whole story on a Mac. In a headset it is not: Quest
 * Browser renders the complete address, fragment included, in a URL bar that
 * floats inside the wearer's view. The consequence is that the 64-character
 * page key is legible in device captures, in
 * `capture_headset_view` frames, and so in every screenshot anyone shares.
 * Text output can be redacted; pixels cannot.
 *
 * So a page now *takes* its key rather than reading it: it lifts the key out of
 * the fragment, hands a copy to `sessionStorage`, and rewrites the address to
 * the bare path in the same turn, before anything paints. `sessionStorage` is
 * the right store and `localStorage` is not: it is scoped to one origin *and*
 * one tab, it dies with the tab, it is never sent anywhere, and it survives
 * exactly what the fragment used to survive — a reload of this tab and the
 * same-tab `/viewer` <-> `/detailed` hops.
 *
 * The rewrite is conditional on the copy landing. A browser with storage turned
 * off keeps its fragment: a visible key is bad, and a key that vanishes on
 * reload is worse, so the page that cannot remember keeps the one copy it has.
 * `fragment` says which of the two happened, and every same-tab link is built
 * with it, so the way back works either way.
 *
 * Both functions take the browser objects they use as arguments and touch no
 * other global, so a Node test drives them with plain fakes and the served
 * pages run this very text: `pageKeySource()` and `keepPageKeySource()` embed
 * these functions in the generated HTML, the way `inspection-pair-fragment.ts`
 * already does, which keeps one implementation instead of two that drift.
 */

/** Only the parts of `window.location` these read. */
export type PageKeyLocation = { hash?: string; pathname?: string; search?: string };
/** Only the part of `window.history` these call. */
export type PageKeyHistory = { replaceState?: (data: unknown, title: string, url: string) => void };
/** Only the parts of `window.sessionStorage` these call. */
export type PageKeyStorage = { getItem?: (key: string) => string | null; setItem?: (key: string, value: string) => void };

/** What a page holding a key knows about it. */
export type HeldPageKey = {
  /** The 64 hex characters the authenticated routes want as a bearer, or '' when this page has none. */
  key: string;
  /** True when this tab has its own copy, so the address bar no longer has to carry one. */
  stored: boolean;
  /** What a same-tab link to another Stereofold page on this origin must append: '' or '#<key>'. */
  fragment: string;
};

/**
 * Read the page key, remember it for this tab, and clear the address bar.
 *
 * `useStored` is false for the pairing page, which must not bounce a wearer who
 * pressed "Pair again" straight back to a key this tab merely remembers; it
 * still writes the copy the page it redirects to will read. Everywhere else it
 * is true, which is what makes a reload of the same tab keep working after the
 * fragment is gone.
 *
 * This function is embedded verbatim in served pages. Keep it free of imports,
 * module-level constants and TypeScript-only syntax that survives into the
 * emitted body.
 */
export function readPageKey(location: PageKeyLocation, history: PageKeyHistory,
  storage: PageKeyStorage | undefined, useStored: boolean): HeldPageKey {
  const NAME = 'stereo_structure/page-key', SHAPE = /^[a-f0-9]{64}$/;
  const hash = location && typeof location.hash === 'string' ? location.hash : '';
  const raw = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  const fromAddress = SHAPE.test(raw);
  let key = fromAddress ? raw : '', stored = false;
  if (fromAddress) {
    try {
      if (storage && typeof storage.setItem === 'function') { storage.setItem(NAME, key); stored = true; }
    } catch (error) { stored = false; }
  } else if (useStored) {
    try {
      const remembered = storage && typeof storage.getItem === 'function' ? storage.getItem(NAME) : null;
      if (typeof remembered === 'string' && SHAPE.test(remembered)) { key = remembered; stored = true; }
    } catch (error) { /* A tab that cannot read its own copy simply has no key. */ }
  }
  // Only a key this tab can get back is worth taking out of the address, and
  // only an address that actually shows one needs rewriting.
  if (fromAddress && stored) {
    const pathname = location && typeof location.pathname === 'string' ? location.pathname : '/';
    const search = location && typeof location.search === 'string' ? location.search : '';
    try {
      if (history && typeof history.replaceState === 'function') history.replaceState(null, '', pathname + search);
      else stored = false;
    } catch (error) { stored = false; }
  }
  return {key: key, stored: stored, fragment: stored || !key ? '' : '#' + key};
}

/**
 * Remember a key this page was just handed by the network rather than by its
 * own address, and say what the link that spends it must carry.
 *
 * The pairing page is the one place this happens: `/pair` answers with a fresh
 * session token and the page immediately navigates to `/viewer`. Storing it
 * first is what lets that navigation leave the key out of the address entirely,
 * so on a headset it is never rendered at all.
 *
 * Embedded verbatim in served pages; same constraints as `readPageKey`.
 */
export function keepPageKey(key: string, storage: PageKeyStorage | undefined): string {
  const NAME = 'stereo_structure/page-key';
  if (!/^[a-f0-9]{64}$/.test(key)) return '';
  try {
    if (storage && typeof storage.setItem === 'function') { storage.setItem(NAME, key); return ''; }
  } catch (error) { /* Fall through to the address bar, which always works. */ }
  return '#' + key;
}

/**
 * `sessionStorage` itself throws in a browser configured to block site data, so
 * every embedded reader reaches it through this guard rather than inline.
 */
function pageKeyStorageSource(): string {
  return '(function(){try{return sessionStorage}catch(error){return undefined}})()';
}

/**
 * The same functions, as source the served pages run.
 *
 * They are emitted as called expressions rather than by name because the server
 * bundle is minified: a declaration's name is renamed there, while a string
 * written here would not be. Each function is self-contained, so its minified
 * body is still valid on its own.
 */
export function pageKeySource(useStored: boolean): string {
  return `(${readPageKey.toString()})(location,history,${pageKeyStorageSource()},${useStored ? 'true' : 'false'})`;
}

export function keepPageKeySource(keyExpression: string): string {
  return `(${keepPageKey.toString()})(${keyExpression},${pageKeyStorageSource()})`;
}

/**
 * Make the address bar say where the page actually is.
 *
 * `readPageKey` above rewrites the address only when a key arrived in the
 * fragment, which on a Mac is every page and in a headset is almost none of
 * them: the wearer's tab takes its key once on `/viewer` and then hops to
 * `/detailed` and back with no fragment at all, so nothing rewrites anything.
 *
 * Measured on the Quest 2: after the Mol*
 * handoff the page was `/detailed` and the URL bar above it still read
 * `/viewer`. A URL bar that names a different page than the one in front of the
 * wearer is not cosmetic in this product — the wearer reads it to tell the
 * viewer from the companion, and an operator reads it out of a capture to
 * decide whether the headset needs recalling.
 *
 * A same-document `replaceState` to the address the page already has costs
 * nothing, changes no history entry and forces the browser to re-read and
 * repaint the bar. The fragment is carried through untouched: where storage
 * was refused it is the tab's only copy of the key, and `readPageKey` has
 * already decided whether it may be dropped.
 */
export function settleAddressBar(location: PageKeyLocation & { hash?: string }, history: PageKeyHistory):
  'settled' | 'unavailable' {
  const pathname = location && typeof location.pathname === 'string' ? location.pathname : '/';
  const search = location && typeof location.search === 'string' ? location.search : '';
  const hash = location && typeof location.hash === 'string' ? location.hash : '';
  try {
    if (!history || typeof history.replaceState !== 'function') return 'unavailable';
    history.replaceState(null, '', pathname + search + hash);
    return 'settled';
  } catch (error) { return 'unavailable'; }
}

/** `settleAddressBar`, embedded verbatim in a served page. Same constraints as above. */
export function settleAddressBarSource(): string {
  return `(${settleAddressBar.toString()})(location,history)`;
}

/**
 * The address of this page, in the page's own words, for the page to draw.
 *
 * `settleAddressBar` above
 * rewrites the history entry and Quest Browser does not repaint its URL bar for
 * it. Nor does it repaint for the real cross-document navigation the Mol*
 * handoff already performs: the tab had genuinely navigated to
 * `/detailed`, CDP and `document.title` both said so, and the bar 40 px above
 * the page still read `/viewer`. A page cannot read the browser's bar and
 * cannot make that browser repaint it, so the page says where it is itself, in
 * the wearer's view, below the stale one.
 *
 * Host and path only. The fragment is where the page key rides and the search
 * carries render knobs; neither belongs in a line a wearer's camera can see,
 * and `readPageKey` has already taken the fragment out of the bar anyway.
 */
export function describePageAddress(location: { host?: string; pathname?: string }): string {
  const host = location && typeof location.host === 'string' ? location.host : '';
  const pathname = location && typeof location.pathname === 'string' && location.pathname ? location.pathname : '/';
  return `${host}${pathname}`;
}

/** `describePageAddress`, embedded verbatim in a served page. */
export function describePageAddressSource(): string {
  return `(${describePageAddress.toString()})(location)`;
}
