/**
 * Telling a wearer that sharing ended, rather than that the
 * viewer failed.
 *
 * The Mac's share window closes on its own about half an hour after the last
 * pairing, and `inspection-lan.ts` closes the listener with it. A headset that
 * opens the companion after that reaches nothing: `boot()` in `inspector.ts`
 * makes `get_inspection` its first call, the companion transport fails, and
 * the page ends on "The viewer couldn't finish starting." over a Reload button
 * that reloads into the same closed door. The headset sits there reading
 * `WAITING FOR STRUCTURE` and then an error
 * about a structure, for a share that had simply run out of time.
 *
 * Nothing in the headset can reopen it: the share is the Mac's to open, with
 * `open_companion`. So the only useful thing this page can do is say so, in
 * the words the wearer needs, once. There is deliberately no retry loop here —
 * a viewer that keeps knocking on a closed share is the endless wait under
 * another name.
 */

/**
 * What the wearer reads instead of a startup error.
 *
 * It says what happened, who can fix it, and what the button in front of them
 * is for. The re-pairing half matters: a remembered headset needs no code
 * typed on it, which is the difference between "reopen it" being a moment's
 * work on the Mac and the wearer taking the headset off.
 */
export const SHARE_ENDED_MESSAGE = 'Sharing from your Mac has ended, so there is nothing here to load. '
  + 'On the Mac, ask Stereofold to open the companion again — this headset re-pairs with no code to type — '
  + 'and then press Reload viewer.';

/**
 * What the page stamps on `document.body.dataset.startupFailure` when the
 * failure behind the plate is a closed share rather than a viewer that broke.
 *
 * `inspector.ts` writes it beside the sentence above, and three tools read it:
 * `headset-drive.ts` before it spends a recovery on the tab, and
 * `headset-tabs.ts` to rank that tab stale so a launch closes it. It is one
 * constant because a string literal copied into four files is how a signal
 * drifts — which is exactly what the tab probe and the drive did on
 * when the drive could see the plate and the probe could not.
 */
export const SHARE_ENDED_STARTUP_FAILURE = 'share-ended';

/**
 * 401 or 410 from a host that is still listening and will not answer this
 * page's key any more: a share that ran out of time but has not yet torn down,
 * or one that `open_companion` reopened on the same port, which clears the
 * paired clients and leaves this tab holding a key nobody knows.
 */
const SHARE_EXPIRED_CODE = 'companion_expired';
/**
 * The same answers, for a caller that kept the status and lost the code.
 *
 * 404 joins them for the coordinate fetch: a share that is up routes `/source`,
 * and `inspection-lan.ts` answers 404 only for a path it does not route, so the
 * 404 a booting page sees is the listener it had a moment ago being gone.
 * Without it the page read a closed share as its own failure and offered a
 * Reload that knocked on the same closed door for as long as anyone pressed it.
 */
const SHARE_CLOSED_STATUSES = new Set([401, 404, 410]);
/**
 * The code `inspection-companion-client.ts` stamps on every failure that never
 * became an HTTP answer — and that is the trouble, because it covers both a
 * refused socket and the ordinary transients of a share that is still open.
 * Holding it is not enough to conclude anything; the sentence beside it is.
 */
const TRANSPORT_CODE = 'companion_connection';
/**
 * The transport's words for a socket that found nobody. An expired share closes
 * its listener (`inspection-lan.ts` `#close`), so this is what a wearer's page
 * gets when the share really is gone.
 */
const LISTENER_GONE = /connection was lost\b/i;
/**
 * The transport's words for a share that is still there and merely slow, busy
 * or briefly broken: the 15 s `get_inspection` deadline, a 429 or 5xx turned
 * into "temporarily unavailable", and a body that stopped arriving mid-read.
 * Each of these recovers on the Reload button in front of the wearer, so none
 * of them may send anyone to the Mac.
 */
const TRANSIENT_SENTENCE = /\btimed out\b|temporarily unavailable|connection was interrupted\b/i;
/** The host's own words for a link that has run out, code or no code. */
const EXPIRED_SENTENCE = /companion link expired/i;
const EXPIRED_SUBJECT = /\b(?:share|sharing|session)\b[^\n]*\bexpired\b/i;
/** A status a listening host answers with while the share is still open. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Whether a startup failure is a share that is no longer open.
 *
 * Anything else is left alone. A structure that will not parse, a catalog that
 * does not match its source, a host missing its load tool: those have their
 * own words already, and overwriting them with a share notice would send the
 * wearer to the Mac to fix something that is not there.
 *
 * A transient is left alone too, and that is the harder half. The transport
 * stamps `companion_connection` on a refused socket, on the 15 s deadline the
 * first `get_inspection` runs under, and on the host's own 429 `busy` alike, so
 * reading the code by itself told a wearer whose Mac was still sharing to go
 * and reopen the share while the Reload button beside the sentence was the real
 * recovery. Only a sentence saying the connection was lost, or a host that
 * answered 401 or 410, is a share that has ended.
 *
 * Both sentences are read, because `call()` in `inspector.ts` rewrites a failed
 * `get_inspection` into a fresh sentence for the flat page: `message` is then
 * the words about a structure, and `detail` the transport's own, which is the
 * only thing that separates a closed listener from a deadline.
 */
export function shareEndedAtStartup(input: { code?: unknown; status?: unknown; message?: unknown; detail?: unknown }): boolean {
  const sentences = [input.detail, input.message].filter((value): value is string => typeof value === 'string');
  // A deadline or a busy host beats every other signal: the share answered, or
  // would have. Nothing said here can be worth sending the wearer to the Mac.
  if (sentences.some(sentence => TRANSIENT_SENTENCE.test(sentence))) return false;
  if (sentences.some(sentence => EXPIRED_SENTENCE.test(sentence) || EXPIRED_SUBJECT.test(sentence))) return true;
  const status = typeof input.status === 'number' ? input.status : undefined;
  if (status !== undefined && SHARE_CLOSED_STATUSES.has(status)) return true;
  if (input.code === SHARE_EXPIRED_CODE) return true;
  if (status !== undefined && isTransientStatus(status)) return false;
  if (input.code === TRANSPORT_CODE) return sentences.some(sentence => LISTENER_GONE.test(sentence));
  return false;
}

/**
 * The sentence a companion page should end its failed startup on, or nothing
 * when the failure is the viewer's own and already says what it is.
 */
export function companionStartupMessage(input: { code?: unknown; status?: unknown; message?: unknown; detail?: unknown }): string | undefined {
  return shareEndedAtStartup(input) ? SHARE_ENDED_MESSAGE : undefined;
}
