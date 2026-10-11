/**
 * Quest Browser's certificate warning, told apart from a page that is slow
 * to draw.
 *
 * The private Wi-Fi share serves HTTPS with a certificate this Mac made for
 * itself, so Quest Browser answers the first visit with Chromium's "Your
 * connection is not private" page (`NET::ERR_CERT_AUTHORITY_INVALID`). The
 * person's "Proceed" lasts for one browser session, so the same page comes
 * back after every Quest Browser restart. In one headset run an adb launch
 * on the Quest 2 landed on it, `open_companion` waited 20 s and reported only
 * that nothing drew, and the agent told the person to put the headset on and
 * tap Enter VR. The page had not loaded, so there was no Enter VR to tap.
 *
 * Three things mark the warning, and the debugger can read all three:
 *
 * - the tab title, "Privacy error", from the `/json` listing;
 * - the page's own address, `chrome-error://chromewebdata/`, while the listing
 *   still shows the address that failed;
 * - the error code in the page text, `NET::ERR_CERT_...`, which Chromium
 *   prints untranslated in every language.
 *
 * The listing needs no page to answer. The page text needs the tab to be the
 * one in front, which the warning is right after a launch.
 *
 * Nothing here clicks Advanced or Proceed. Accepting a certificate is the
 * person's decision, so this module only reports the warning and the steps.
 */

import { evaluateParameters, parseTargets, pageTargets, readEvaluateResult, STEREOFOLD_PATHS, targetOrigin,
  type DevtoolsTarget, type DevtoolsTransport } from './headset-devtools.js';

/** The title Chromium gives its certificate warning page, in English. */
const PRIVACY_ERROR_TITLE = /^privacy error$/iu;
/** The address a Chromium error page reports for itself. */
const ERROR_PAGE_SCHEME = 'chrome-error:';
/** Chromium's certificate error codes, which it never translates. */
const CERTIFICATE_ERROR_CODE = /NET::ERR_CERT_[A-Z_]+/u;
/** Titles this product serves. A tab with one of these has loaded the page. */
const STEREOFOLD_TITLE = /stereofold|mol\*/iu;
const PAIR_FRAGMENT = /#pair=\d{8}$/u;

/**
 * What the page says about itself, read-only.
 *
 * The code is read from the visible text only on an error page, so a live
 * viewer is never asked to lay out its text. Only the code leaves the page.
 */
export const CERTIFICATE_PAGE_EXPRESSION = `(() => {
  const pick = fn => { try { const value = fn(); return value === undefined ? null : value; } catch { return null; } };
  const errorPage = pick(() => location.protocol) === ${JSON.stringify(ERROR_PAGE_SCHEME)};
  const text = errorPage ? (pick(() => document.body ? document.body.innerText : '') || '') : '';
  const code = ${CERTIFICATE_ERROR_CODE}.exec(text);
  return { href: pick(() => location.href), title: pick(() => document.title), code: code ? code[0] : null };
})()`;

/** What the page answered to `CERTIFICATE_PAGE_EXPRESSION`. */
export type CertificatePage = { href?: string | null; title?: string | null; code?: string | null };

/** Which signal identified the warning. */
export type CertificateEvidence = 'title' | 'error-page' | 'error-code';

export type CertificateWarning = {
  /** The share address Quest Browser refused: scheme, host and port. */
  address: string;
  /** The host the warning's Proceed link names. Chromium leaves the port out. */
  host: string;
  /** Chromium's error code, when the page text was read. */
  code?: string;
  /** The debugger id of the tab that shows the warning. */
  tab: string;
  evidence: CertificateEvidence[];
  /** The share certificate's SHA-256 fingerprint, when the caller knows it. */
  fingerprint?: string;
  /** The steps for the person in the headset, to relay word for word. */
  instruction: string;
};

/**
 * The steps, in the order the person does them.
 *
 * `worn: false` adds the first step. An unknown `worn` leaves it out, because
 * the steps already happen in the headset.
 */
export function certificateInstruction(host: string, worn?: boolean): string {
  return `${worn === false ? 'Put the headset on. ' : ''}Quest Browser in the headset shows "Your connection is not private". `
    + `Choose Advanced, then "Proceed to ${host} (unsafe)". Then tap Enter VR. `
    + 'The warning returns each time Quest Browser restarts.';
}

/** The sentence a tool result leads with, before the instruction. */
export function describeCertificateWarning(warning: CertificateWarning): string {
  return `Quest Browser is showing a certificate warning for ${warning.address}${warning.code ? ` (${warning.code})` : ''}, `
    + 'so the page has not loaded. Nothing on this Mac can accept the certificate. '
    + `Tell the user: ${warning.instruction}`;
}

/**
 * Whether this tab could be the Stereofold page, judged on its address alone.
 *
 * With the share's origin, the origin decides, whatever the path: an adb
 * launch opens the share's root with `#pair=`, and the warning stops it there,
 * before the redirect to `/viewer`. Without an origin, a Stereofold path or a
 * pairing fragment is required. An error page that lists its own
 * `chrome-error://` address carries no origin, so it stays a candidate and
 * `certificateWarningFor` reports it against the share origin or not at all.
 */
function candidateAddress(url: string, expectedOrigin?: string): boolean {
  if (url.startsWith(ERROR_PAGE_SCHEME)) return true;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  if (expectedOrigin !== undefined) return parsed.origin === expectedOrigin;
  return STEREOFOLD_PATHS.some(path => parsed.pathname.startsWith(path)) || PAIR_FRAGMENT.test(url);
}

/**
 * Is this tab on the certificate warning for this share?
 *
 * Pure: the listing entry, what the page answered if it answered, and the
 * share origin if the caller knows it. The title or the error code is
 * required. An error page with neither is a different failure, such as an
 * address that refused the connection, and is not reported as a certificate
 * warning. A listing that shows only `chrome-error://` names no host, so it
 * is reported only when the caller knows the share origin.
 */
export function certificateWarningFor({ target, page, expectedOrigin, worn, fingerprint }: {
  target: { id: string; url: string; title: string }; page?: CertificatePage; expectedOrigin?: string;
  worn?: boolean; fingerprint?: string;
}): CertificateWarning | undefined {
  if (!candidateAddress(target.url, expectedOrigin)) return undefined;
  const evidence: CertificateEvidence[] = [];
  if (PRIVACY_ERROR_TITLE.test(target.title) || PRIVACY_ERROR_TITLE.test(page?.title ?? '')) evidence.push('title');
  if (target.url.startsWith(ERROR_PAGE_SCHEME) || (page?.href ?? '').startsWith(ERROR_PAGE_SCHEME)) evidence.push('error-page');
  const code = CERTIFICATE_ERROR_CODE.exec(page?.code ?? '')?.[0];
  if (code) evidence.push('error-code');
  if (!evidence.includes('title') && !code) return undefined;
  const origin = target.url.startsWith(ERROR_PAGE_SCHEME) ? expectedOrigin : targetOrigin(target.url);
  if (origin === undefined) return undefined;
  const host = new URL(origin).hostname;
  return { address: origin, host, ...(code ? { code } : {}), tab: target.id, evidence,
    ...(fingerprint ? { fingerprint } : {}), instruction: certificateInstruction(host, worn) };
}

/** What one look at the headset found. `read: false` means the debugger did not answer. */
export type CertificateReading = { read: true; warning?: CertificateWarning } | { read: false; reason: string };

/**
 * Look for the warning on the headset, over a debugger port already forwarded.
 *
 * Tabs that carry a Stereofold title have loaded the page and are skipped. The
 * rest are checked newest first. A tab whose title already says "Privacy
 * error" is reported even when its page does not answer, because Quest
 * Browser freezes every tab that is not in front. At most `maxProbes` pages
 * are asked, each for at most `probeMs`, so a strip of frozen tabs costs a
 * bounded wait.
 */
export async function readCertificateWarning(transport: DevtoolsTransport, { port, expectedOrigin, worn, fingerprint,
  probeMs = 1_500, maxProbes = 3 }: {
  port: number; expectedOrigin?: string; worn?: boolean; fingerprint?: string; probeMs?: number; maxProbes?: number;
}): Promise<CertificateReading> {
  let targets: DevtoolsTarget[];
  try { targets = pageTargets(parseTargets(await transport.fetch(port, '/json'))); }
  catch (error) { return { read: false, reason: error instanceof Error ? error.message : String(error) }; }
  const extra = { ...(expectedOrigin === undefined ? {} : { expectedOrigin }),
    ...(worn === undefined ? {} : { worn }), ...(fingerprint ? { fingerprint } : {}) };
  const candidates = targets.filter(target => candidateAddress(target.url, expectedOrigin) && !STEREOFOLD_TITLE.test(target.title))
    .sort((a, b) => /^\d+$/u.test(a.id) && /^\d+$/u.test(b.id) ? Number(b.id) - Number(a.id) : 0);
  let probes = 0;
  for (const target of candidates) {
    const page = probes++ < maxProbes ? await readCertificatePage(transport, port, target, probeMs) : undefined;
    const warning = certificateWarningFor({ target, ...(page ? { page } : {}), ...extra });
    if (warning) return { read: true, warning };
  }
  return { read: true };
}

async function readCertificatePage(transport: DevtoolsTransport, port: number, target: DevtoolsTarget,
  probeMs: number): Promise<CertificatePage | undefined> {
  let session;
  try { session = await transport.open(port, target.webSocketDebuggerUrl); } catch { return undefined; }
  try {
    const outcome = readEvaluateResult(await session.send('Runtime.evaluate', evaluateParameters(CERTIFICATE_PAGE_EXPRESSION), probeMs));
    return outcome.ok && outcome.value !== null && typeof outcome.value === 'object' ? outcome.value as CertificatePage : undefined;
  } catch { return undefined; } finally { session.close(); }
}
