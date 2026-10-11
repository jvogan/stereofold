/**
 * Keeping live capabilities out of harness report artifacts.
 *
 * A browser harness writes `browser-report.json` next to its screenshots, and
 * those directories get read by other people, pasted into reports and kept
 * long after the run. The addresses a harness observes are evidence worth
 * keeping; the secrets inside them are not. A companion address carries an
 * eight-digit pairing code in its fragment, and the detailed-view address
 * carries a 64-character page key in its, so writing either href verbatim
 * turns an artifact directory into a credential store.
 *
 * `redactLinkSecrets` keeps the part that is evidence — scheme, host, port and
 * path — and replaces the fragment with a description of its shape, the way
 * scenarios S6 and S7 of `claude-science-browser.ts` already did by hand.
 * `scrubSecrets` is the belt to that braces: it walks a finished report and
 * removes any known live secret that reached it by some other route.
 *
 * Both are pure and take their inputs as arguments, so the tests drive the
 * same functions the harnesses run.
 */

/** How a fragment is described once its value is gone. */
const PAIR_FRAGMENT = /^pair=\d{8}$/;
const PAGE_KEY_FRAGMENT = /^[0-9a-f]{16,}$/;

/**
 * Replace a URL's fragment with a description of its shape.
 *
 * A value with no fragment is already free of secrets and comes back
 * unchanged, as does anything that is not a string. The two fragments this
 * repository mints get their own labels so a reader can still tell a pairing
 * link from a detailed-view link; anything else is labelled generically rather
 * than guessed at, because an unrecognised fragment is the most likely place
 * for a secret nobody has thought about yet.
 */
export function redactLinkSecrets(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const marker = value.indexOf('#');
  if (marker < 0) return value;
  const fragment = value.slice(marker + 1);
  if (fragment === '') return value;
  const shape = PAIR_FRAGMENT.test(fragment)
    ? 'pair=<8 digits>'
    : PAGE_KEY_FRAGMENT.test(fragment)
      ? '<page key>'
      : '<fragment>';
  return `${value.slice(0, marker)}#${shape}`;
}

/** What a scrubbed secret leaves behind. */
export const SCRUBBED = '<redacted>';

/**
 * Anything long enough and dense enough to be a capability rather than a word.
 *
 * A harness that records what a page logged cannot know which of those lines
 * quote a bearer, a source token or a command claim, so the shape is refused
 * wherever it appears. Twenty-four characters is above every English word and
 * every identifier this repository logs, and below the shortest secret it
 * mints.
 */
const TOKEN_SHAPED = /[A-Za-z0-9_-]{24,}/gu;

/** Replace every token-shaped run in recorded text. */
export function redactTokens(value: unknown): string {
  return typeof value === 'string' ? value.replace(TOKEN_SHAPED, SCRUBBED) : '';
}

/**
 * The evidence half of a request address: scheme, host, port and path.
 *
 * A query and a fragment are dropped whole rather than described, because a
 * recorded request is evidence about a route and nothing below the path
 * changes which route it was. An address that will not parse is reported as
 * such instead of being written out raw.
 */
export function requestRoute(value: unknown): string {
  if (typeof value !== 'string') return '<no url>';
  try { const parsed = new URL(value); return redactTokens(`${parsed.origin}${parsed.pathname}`); }
  catch { return '<unparsed url>'; }
}

/**
 * Remove every occurrence of a known secret from a value about to be written.
 *
 * The caller passes the live secrets it minted during the run — a pairing
 * code, a page key, a device key. Short values are ignored: a four-character
 * secret would match half the numbers in a timings block, and over-redacting
 * evidence is its own kind of damage. Everything else is replaced wherever it
 * appears inside a string, including in the middle of a URL or a sentence.
 *
 * The input is not modified. Arrays and plain objects are rebuilt; anything
 * else comes back as it went in.
 */
export function scrubSecrets<T>(value: T, secrets: readonly unknown[]): T {
  const live = secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length >= 8);
  if (live.length === 0) return value;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      let text = node;
      for (const secret of live) text = text.split(secret).join(SCRUBBED);
      return text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
      const copy: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) copy[key] = walk(entry);
      return copy;
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * Report where a secret still survives, as `path` strings into the value.
 *
 * A harness calls this after scrubbing to prove the artifact is clean, and a
 * test calls it to prove the scrubber works. It finds substring matches, so a
 * secret hidden inside a longer string is still found.
 */
export function findLeakedSecrets(value: unknown, secrets: readonly unknown[]): string[] {
  const live = secrets.filter((secret): secret is string => typeof secret === 'string' && secret.length >= 8);
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (live.some(secret => node.includes(secret))) found.push(path);
      return;
    }
    if (Array.isArray(node)) { node.forEach((entry, index) => walk(entry, `${path}[${index}]`)); return; }
    if (node !== null && typeof node === 'object')
      for (const [key, entry] of Object.entries(node)) walk(entry, path === '' ? key : `${path}.${key}`);
  };
  walk(value, '');
  return found;
}
