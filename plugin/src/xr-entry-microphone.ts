/**
 * The microphone prompt an Enter VR press opens, and what the page says while
 * it is still up.
 *
 * Enter VR asks for the microphone in the same gesture as the immersive
 * session, because Quest Browser cannot draw a permission prompt over an
 * immersive session (`push-to-talk-audio.mjs`). On a Quest whose microphone
 * permission is still undecided, that press opens the browser's microphone
 * prompt, and Quest Browser refuses the session request it receives in the
 * same gesture. The next press enters, whether the prompt was answered or is
 * still showing. That first press is therefore not a failure, and the wearer
 * is owed one sentence saying what to do rather than an error and a reload
 * button.
 *
 * Nothing here changes what a press calls. The permission state is read from
 * a status object queried before the press and kept current by its `change`
 * event, because the session request needs the press's user activation and
 * nothing may be awaited between the press and that request.
 */

/** Shown when the session request was refused while the prompt is up. */
export const MICROPHONE_PROMPT_REFUSED_COPY = 'Answer the microphone prompt, then press Enter VR again.';

/** Shown when the session request is still waiting while the prompt is up. */
export const MICROPHONE_PROMPT_WAITING_COPY = 'Answer the microphone prompt to continue.';

/** Shown in place of the refused sentence once the prompt has been answered. */
export const MICROPHONE_PROMPT_ANSWERED_COPY = 'Press Enter VR again.';

/**
 * Shown while the session request waits on the browser's own headset-access
 * prompt, which a permission that reads `prompt` says is coming or up.
 */
export const HEADSET_PROMPT_WAITING_COPY = 'Answer the prompt in the headset to continue.';

/** Which microphone-prompt sentence an Enter VR press left on the status line. */
export type MicrophoneNotice = '' | 'refused' | 'waiting';

/**
 * The sentence for a notice, read against the permission and the microphone
 * request as they are now.
 *
 * Both sentences tell the wearer to answer a prompt, so they hold only while
 * the permission is still undecided and the microphone request the press
 * opened is still unanswered (`requesting`, or `pending-prompt` once the
 * priming gave up waiting). Once the permission is granted or denied, or the
 * request has settled, a refused press reads `Press Enter VR again.` and a
 * waiting one has nothing left to say. A dismissed prompt leaves the
 * permission undecided and settles the request, so only the request tells
 * that the prompt has closed. A permission or request state that cannot be
 * read keeps the sentence as it was.
 */
export function microphoneNoticeCopy(notice: MicrophoneNotice, permission: MicrophonePermission | undefined, microphone?: string): string {
  const answered = permission === 'granted' || permission === 'denied'
    || (microphone !== undefined && microphone !== 'requesting' && microphone !== 'pending-prompt');
  if (notice === 'refused') return answered ? MICROPHONE_PROMPT_ANSWERED_COPY : MICROPHONE_PROMPT_REFUSED_COPY;
  if (notice === 'waiting') return answered ? '' : MICROPHONE_PROMPT_WAITING_COPY;
  return '';
}

export type MicrophonePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

type PermissionStatusLike = {
  state?: unknown;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

const known = (value: unknown): MicrophonePermission =>
  value === 'granted' || value === 'denied' || value === 'prompt' ? value : 'unknown';

/**
 * The microphone permission as the browser last reported it.
 *
 * `state()` is synchronous and reads only the cached answer, so a click
 * handler can call it without giving up its user activation. It is
 * `unknown` until the query answers, and stays `unknown` where the browser
 * has no permissions API or refuses to name the microphone.
 *
 * `name` reads another permission the same way. Enter VR reads
 * `xr-spatial-tracking` with it; desktop Chromium 151 refuses that name and
 * every other XR permission name, so there it stays `unknown`.
 */
export function watchMicrophonePermission(navigatorLike: unknown, changed?: () => void, name = 'microphone'): { state(): MicrophonePermission; stop(): void } {
  let state: MicrophonePermission = 'unknown', status: PermissionStatusLike | undefined, stopped = false;
  const onChange = () => {
    if (stopped) return;
    state = known(status?.state);
    // A listener's failure must not leave the cached state behind.
    try { changed?.(); } catch { /* The state above is already current. */ }
  };
  try {
    const permissions = (navigatorLike as { permissions?: { query?: (descriptor: { name: string }) => unknown } } | undefined)?.permissions;
    if (typeof permissions?.query === 'function') {
      Promise.resolve(permissions.query({ name })).then(answer => {
        if (stopped) return;
        status = answer as PermissionStatusLike | undefined;
        state = known(status?.state);
        try { status?.addEventListener?.('change', onChange); } catch { /* The first answer still stands. */ }
      }, () => { /* A browser that cannot name the microphone leaves the state unknown. */ });
    }
  } catch { /* A permissions API that throws leaves the state unknown. */ }
  return {
    state: () => state,
    stop() {
      stopped = true;
      try { status?.removeEventListener?.('change', onChange); } catch { /* Already detached. */ }
    },
  };
}

/**
 * Whether a refused or waiting headset request is the microphone prompt that
 * this press opened, still unanswered.
 *
 * All of these must hold: the permission was undecided when the press read it
 * (so this press is what asked); it is still undecided; the microphone request
 * has not settled (`requesting`, or `pending-prompt` once the priming gave up
 * waiting), which tells an unanswered prompt from one the wearer dismissed;
 * the attempt never presented; and the page does not need a reload, since a
 * page that does cannot serve the next press.
 */
export function microphonePromptHoldsEntry({ undecidedAtPress, presented, permission, microphone, reloadRequired }: {
  undecidedAtPress: boolean | undefined;
  presented: boolean;
  permission: MicrophonePermission | undefined;
  microphone: string;
  reloadRequired: boolean | undefined;
}): boolean {
  return undecidedAtPress === true && !presented && reloadRequired !== true && permission === 'prompt'
    && (microphone === 'requesting' || microphone === 'pending-prompt');
}

/** Why a Talk press inside VR opens no microphone when the host has no voice route. */
export const VOICE_OFF_CAPTURE_MESSAGE = 'Microphone capture is unavailable: headset voice is off for this session.';

type CaptureLike = { start(): Promise<unknown>; stop(...args: unknown[]): Promise<unknown>; active?(): boolean };

/**
 * The Talk control's capture, refusing to start while `off()` holds.
 *
 * A refused start never reaches `getUserMedia`. The message is one the voice
 * controller already treats as an unavailable microphone, so the wearer gets
 * the same line as for any microphone that cannot open, and nothing hangs
 * waiting on a prompt that cannot be drawn.
 */
export function refuseCaptureWhileVoiceOff<T extends CaptureLike>(capture: T, off: () => boolean): T {
  return Object.freeze({ ...capture, start: () => off() ? Promise.reject(Error(VOICE_OFF_CAPTURE_MESSAGE)) : capture.start() });
}

/**
 * Whether the Talk control refuses a press, from what the host last said.
 *
 * A host whose person started the share with `--no-ptt` says
 * `microphoneRefused`, and then no press opens the microphone, on the flat
 * page or inside VR. Otherwise only a press inside VR on a host with no voice
 * route is refused, as before; `presenting` is read only for that case.
 */
/**
 * `microphoneRefused` after one host answer. An answer that carries it sets it;
 * one that lacks it, such as a heartbeat for a panel the host dropped, leaves
 * it set. Only a successful attach, a new binding that a restarted host
 * without --no-ptt would give, can clear it.
 */
export function microphoneRefusedAfter(previous: boolean, answer: unknown, attach: boolean): boolean {
  const said = (answer as { structuredContent?: { microphoneRefused?: unknown } } | undefined)?.structuredContent?.microphoneRefused === true;
  return attach ? said : previous || said;
}

export function talkCaptureClosed(host: { voiceCapture?: boolean; microphoneRefused?: boolean }, presenting: () => boolean): boolean {
  return host.microphoneRefused === true || (host.voiceCapture === false && presenting());
}
