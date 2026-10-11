/**
 * The pairing code the companion page may be handed in its URL fragment.
 *
 * Nobody should have to type on a headset, so the Mac can hand the code over
 * inside the link it opens: `https://<host>:8443/#pair=12345678`. A fragment is
 * the only part of a URL a browser never puts in a request line, so the code
 * does not reach an access log or a Referer header on the way in. The page still
 * has to get rid of it: this helper reads the code and rewrites the address in
 * the same turn, before any await, so the code never survives in the address
 * bar, in session history, or in a later navigation from this page.
 *
 * `readPairFragment` takes the two browser objects it uses as arguments and
 * touches no other global, so a Node test drives it with plain fakes and the
 * page runs the very same function: `pairFragmentSource()` embeds this
 * function's own text in the served page as an immediately-called expression,
 * which keeps one implementation rather than two that can drift.
 */

/** Only the parts of `window.location` this reads. */
export type FragmentLocation = { hash?: string; pathname?: string; search?: string };
/** Only the part of `window.history` this calls. */
export type FragmentHistory = { replaceState?: (data: unknown, title: string, url: string) => void };

/**
 * Read a one-time pairing code out of the fragment and strip the fragment.
 *
 * The code is eight digits, the same shape the listener mints and the same
 * shape a person would type. Anything else in the fragment, including a longer
 * or shorter value, reads as no code at all rather than as something to send to
 * `/pair`. The rewrite is attempted whenever a `pair=` fragment was present, so
 * a malformed one is cleared too, and a browser that refuses `replaceState`
 * still pairs.
 *
 * This function is embedded verbatim in the served page. Keep it free of
 * imports, module-level constants and TypeScript-only syntax that survives
 * into the emitted body.
 */
export function readPairFragment(location: FragmentLocation, history: FragmentHistory): string | undefined {
  const hash = location && typeof location.hash === 'string' ? location.hash : '';
  const raw = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  if (raw.indexOf('pair=') < 0) return undefined;
  let code: string | undefined;
  const parts = raw.split('&');
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index], split = part.indexOf('=');
    if (split < 0 || part.slice(0, split) !== 'pair') continue;
    const value = part.slice(split + 1);
    if (/^[0-9]{8}$/.test(value)) code = value;
    break;
  }
  const pathname = location && typeof location.pathname === 'string' ? location.pathname : '/';
  const search = location && typeof location.search === 'string' ? location.search : '';
  try {
    if (history && typeof history.replaceState === 'function') history.replaceState(null, '', pathname + search);
  } catch (error) { /* A browser that refuses the rewrite still pairs; the fragment is simply not cleared. */ }
  return code;
}

/**
 * The same function, as source the served page runs.
 *
 * It is emitted as a called expression rather than by name because the server
 * bundle is minified: the declaration's name is renamed there, while a string
 * written here would not be. The function is self-contained, so its minified
 * body is still valid on its own.
 */
export function pairFragmentSource(): string {
  return `(${readPairFragment.toString()})(location,history)`;
}
