/**
 * Press Enter VR for the wearer, over the headset browser's debugger.
 *
 * On 2026-09-28 a wearer had the Stereofold page open in Quest Browser, flat,
 * and could not see the molecule. The agent had no tool that pressed Enter VR,
 * so it asked, and the wearer took the headset off to answer. When told to try,
 * it found the debugger itself and clicked the button with one
 * `Runtime.evaluate`; the page reported `presenting: true` in immersive-ar.
 * This module is that click, sent once, with a wait for the session and a
 * sentence for each way it can fail.
 *
 * It lives apart from `headset-devtools.ts` because that module only reads.
 * This one presses the page's own entry button, the one the wearer would
 * press, and only when the page is not already presenting.
 *
 * WebXR grants a session only inside a user gesture. `Runtime.evaluate` with
 * `userGesture: true` gives the click one: Quest Browser 152 entered VR that
 * way on 2026-09-27 and again on 2026-09-28. The first entry on a new address
 * stops at Quest Browser's "Allow VR" prompt, which only the wearer can
 * answer; the request waits behind it with the page in `requesting-headset`,
 * and the result says so rather than reporting a failure.
 */
import {
  evaluateParameters, isSilentTargetError, isStereofoldTargetUrl, pageTargets, parseTargets, readEvaluateResult,
  redactDevtoolsText, redactUrl, type DevtoolsTarget, type DevtoolsTransport,
} from './headset-devtools.js';

/** How long the page gets to report a presenting session after the press. */
export const ENTER_VR_WAIT_MS = 15_000;
/** How often the page is read while it starts the session. */
export const ENTER_VR_POLL_MS = 250;

/**
 * What the page says about entry, as one expression. It writes nothing.
 *
 * `__stereofoldMenu.xrStartup()` is the page's own answer to "is a session
 * presenting", and a `false` from it is authoritative for the tab. The mode
 * comes from the newest `session-start` diagnostic, which is fresh right
 * after an entry. `button` names the control a press would use: the resume
 * button of a pending blend-mode switch first, then the primary Enter VR.
 */
export const ENTER_VR_STATE_EXPRESSION = `(() => {
  const pick = fn => { try { const value = fn(); return value === undefined ? null : value; } catch { return null; } };
  const usable = node => Boolean(node) && !node.disabled && !node.closest('[hidden]') && node.getClientRects().length > 0;
  const startup = pick(() => globalThis.__stereofoldMenu.xrStartup());
  const resume = pick(() => document.querySelector('[data-resume-xr]'));
  const enter = pick(() => document.querySelector('[data-enter-xr="immersive-ar"]'));
  const entries = pick(() => globalThis.__stereofoldDiagnostics.entries()) || [];
  let started = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index] && entries[index].kind === 'session-start') { started = entries[index]; break; }
  }
  return {
    origin: pick(() => location.origin),
    pathname: pick(() => location.pathname),
    marker: typeof globalThis.__stereofoldMenu?.xrStartup === 'function',
    presenting: startup ? startup.presenting === true : null,
    phase: startup ? startup.phase : null,
    sessionVisibility: startup ? startup.sessionVisibility : null,
    mode: started && started.detail ? started.detail.mode || null : null,
    button: usable(resume) ? 'resume' : usable(enter) ? 'enter' : enter ? 'disabled' : 'none',
    note: pick(() => (document.querySelector('.xr-controls [role="status"]').textContent || '').trim().slice(0, 200)),
  };
})()`;

/** The press. It clicks the same control `button` above names, or nothing. */
export const ENTER_VR_PRESS_EXPRESSION = `(() => {
  if (location.origin !== __EXPECTED_ORIGIN__ || !['/viewer', '/companion', '/inspection', '/experience'].includes(location.pathname)
    || typeof globalThis.__stereofoldMenu?.xrStartup !== 'function') return 'identity';
  let startup;
  try { startup = globalThis.__stereofoldMenu.xrStartup(); } catch { return 'identity'; }
  if (!startup || startup.presenting !== false || startup.phase === 'requesting-headset') return 'presenting';
  const usable = node => Boolean(node) && !node.disabled && !node.closest('[hidden]') && node.getClientRects().length > 0;
  const resume = document.querySelector('[data-resume-xr]');
  const enter = document.querySelector('[data-enter-xr="immersive-ar"]');
  const button = usable(resume) ? resume : usable(enter) ? enter : null;
  if (!button) return 'none';
  button.click();
  return button === resume ? 'resume' : 'enter';
})()`;

/** `Runtime.evaluate` for the press: the one call in this product that is a user gesture. */
export function pressParameters(expectedOrigin: string): Record<string, unknown> {
  return { ...evaluateParameters(ENTER_VR_PRESS_EXPRESSION.replace('__EXPECTED_ORIGIN__', JSON.stringify(expectedOrigin))), userGesture: true };
}

type PageEntryState = {
  origin: string | null;
  pathname: string | null;
  marker: boolean;
  presenting: boolean | null;
  phase: string | null;
  sessionVisibility: string | null;
  mode: string | null;
  button: 'resume' | 'enter' | 'disabled' | 'none';
  note: string | null;
};

export type EnterVrState = 'presenting' | 'already-presenting' | 'hidden' | 'awaiting-allow' | 'not-started'
  | 'no-button' | 'detailed-view' | 'paused-tab' | 'no-page' | 'no-debugger' | 'no-share' | 'ambiguous-page' | 'changed-page';

export type EnterVrOutcome = {
  /** Whether the page reports a presenting session when this returns. */
  entered: boolean;
  /** Whether this call pressed anything. */
  pressed: boolean;
  state: EnterVrState;
  mode?: string | null;
  phase?: string | null;
  sessionVisibility?: string | null;
  waitedMs?: number;
  target?: { id: string; url: string; title: string };
  /** The page's own status line, when it had one. */
  note?: string;
  /** Why the debugger could not be reached, for the structured result. */
  reason?: string;
  /** The sentence the agent reads first. */
  text: string;
};

/** The one sentence for a Mac that cannot reach the debugger at all. */
export const ENTER_VR_ASK_WEARER = 'No authorized debugging connection reaches the headset browser from this Mac, so ask the wearer to tap Enter VR on the page.';

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * Press Enter VR on the Stereofold tab and wait for the page to present.
 *
 * Never throws for a state the wearer or the agent can fix: no debugger, no
 * page, a paused tab, a missing button and a request waiting on the wearer
 * each come back as an outcome with its sentence.
 */
export async function enterHeadsetVr(transport: DevtoolsTransport, {
  port, expectedOrigin, timeoutMs = ENTER_VR_WAIT_MS, pollMs = ENTER_VR_POLL_MS, livenessMs = 1_500,
  now = Date.now, sleep = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }),
}: {
  port: number; expectedOrigin?: string; timeoutMs?: number; pollMs?: number; livenessMs?: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}): Promise<EnterVrOutcome> {
  const unreachable = (error: unknown): EnterVrOutcome => ({ entered: false, pressed: false, state: 'no-debugger',
    reason: redactDevtoolsText((error instanceof Error ? error.message : String(error)).slice(0, 300)), text: ENTER_VR_ASK_WEARER });
  if (!expectedOrigin) return { entered: false, pressed: false, state: 'no-share',
    text: 'This session has no private Wi-Fi share to identify its headset page. Open the companion for this session first.' };
  let target: DevtoolsTarget | undefined;
  let candidates: DevtoolsTarget[];
  try {
    candidates = pageTargets(parseTargets(await transport.fetch(port, '/json')))
      .filter(tab => isStereofoldTargetUrl(tab.url, expectedOrigin)
        && ['/viewer', '/companion', '/inspection', '/experience'].includes(new URL(tab.url).pathname));
    target = candidates[0];
  }
  catch (error) { return unreachable(error); }
  if (candidates.length > 1) return { entered: false, pressed: false, state: 'ambiguous-page',
    text: 'More than one page from this share is open in Quest Browser. Ask the wearer to keep one Stereofold page open, then try again.' };
  if (!target) {
    return { entered: false, pressed: false, state: 'no-page',
      text: 'The headset browser shows no Stereofold page, so there is no Enter VR to press. Put the page there with manage_companion action="launch", then try again.' };
  }
  const described = { id: target.id, url: redactUrl(target.url), title: redactDevtoolsText(target.title) };
  let session;
  try { session = await transport.open(port, target.webSocketDebuggerUrl); }
  catch (error) { return unreachable(error); }
  try {
    try { await session.send('Runtime.enable', {}, livenessMs); }
    catch (error) {
      if (!isSilentTargetError(error)) return unreachable(error);
      // Quest Browser freezes every tab but the one in front of the wearer;
      // a frozen tab takes the connection and then answers nothing.
      return { entered: false, pressed: false, state: 'paused-tab', target: described,
        text: 'Quest Browser has paused the Stereofold tab because another tab is in front of the wearer. Ask the wearer to switch to it and tap Enter VR.' };
    }
    const read = async (): Promise<PageEntryState | undefined> => {
      const outcome = readEvaluateResult(await session.send('Runtime.evaluate', evaluateParameters(ENTER_VR_STATE_EXPRESSION)));
      return outcome.ok && outcome.value && typeof outcome.value === 'object' ? outcome.value as PageEntryState : undefined;
    };
    const facts = (state: PageEntryState | undefined) => ({ mode: state?.mode ?? null, phase: state?.phase ?? null,
      sessionVisibility: state?.sessionVisibility ?? null, target: described,
      ...(state?.note ? { note: redactDevtoolsText(state.note) } : {}) });
    const before = await read();
    if (before?.origin !== expectedOrigin || !before.marker || !before.pathname
      || !['/viewer', '/companion', '/inspection', '/experience', '/detailed'].includes(before.pathname))
      return { entered: false, pressed: false, state: 'changed-page', ...facts(before),
        text: 'The headset tab changed away from this Stereofold share before Enter VR could be pressed.' };
    if (before?.presenting) {
      if (before.sessionVisibility === 'hidden')
        return { entered: true, pressed: false, state: 'hidden', ...facts(before),
          text: 'The headset has a hidden VR session, so nothing was pressed. Wait for get_inspection_state to report wearer.state "in-vr" after visible frames resume.' };
      return { entered: true, pressed: false, state: 'already-presenting', ...facts(before),
        text: `The headset is already in VR${before.mode ? ` (${before.mode})` : ''}, so nothing was pressed.` };
    }
    if (before?.pathname?.startsWith('/detailed')) {
      return { entered: false, pressed: false, state: 'detailed-view', ...facts(before),
        text: 'The headset is on the full Mol* viewer, which has no Enter VR. Ask the wearer to press Back to headset view, then try again.' };
    }
    const pressed = before && before.button !== 'none' && before.button !== 'disabled'
      ? readEvaluateResult(await session.send('Runtime.evaluate', pressParameters(expectedOrigin))) : undefined;
    if (pressed?.ok && (pressed.value === 'identity' || pressed.value === 'presenting'))
      return { entered: false, pressed: false, state: 'changed-page', ...facts(before),
        text: 'The headset page or its presentation state changed before Enter VR could be pressed.' };
    if (!pressed?.ok || (pressed.value !== 'enter' && pressed.value !== 'resume')) {
      const disabled = before?.button === 'disabled';
      const note = before?.note ? redactDevtoolsText(before.note) : '';
      return { entered: false, pressed: false, state: 'no-button', ...facts(before),
        text: `The page's Enter VR button is ${disabled ? 'disabled' : 'not showing'}${note ? `, and the page says "${note}"` : ''}. `
          + 'Ask the wearer to tap Enter VR once it is available.' };
    }
    const started = now();
    let state: PageEntryState | undefined;
    for (;;) {
      await sleep(pollMs);
      // A page busy building its first immersive frame can miss one read;
      // the deadline, not one silent answer, decides the outcome.
      try { state = await read(); } catch { state = undefined; }
      if (state && (state.origin !== expectedOrigin || state.marker !== true
        || !['/viewer', '/companion', '/inspection', '/experience'].includes(state.pathname ?? '')))
        return { entered: false, pressed: true, state: 'changed-page', ...facts(state),
          text: 'The headset tab changed after Enter VR was pressed; its new page was not used as confirmation.' };
      if (state?.presenting && state.sessionVisibility !== 'hidden') {
        const waitedMs = now() - started;
        return { entered: true, pressed: true, state: 'presenting', ...facts(state), waitedMs,
          text: `Pressed Enter VR; the headset is presenting ${state.mode ?? 'an immersive session'} after ${seconds(waitedMs)}.` };
      }
      if (now() - started >= timeoutMs) break;
    }
    const waitedMs = now() - started;
    if (state?.presenting) {
      return { entered: true, pressed: true, state: 'hidden', ...facts(state), waitedMs,
        text: 'Pressed Enter VR and the session started, but a Quest system dialog is in front of it, usually "Confirm boundary". Only the wearer can answer it.' };
    }
    if (state?.phase === 'requesting-headset') {
      return { entered: false, pressed: true, state: 'awaiting-allow', ...facts(state), waitedMs,
        text: `Pressed Enter VR, and after ${seconds(waitedMs)} Quest Browser is still holding the request. `
          + 'The first entry on a new address shows an "Allow VR" prompt that only the wearer can answer: ask them to choose Allow.' };
    }
    const note = state?.note ? redactDevtoolsText(state.note) : '';
    return { entered: false, pressed: true, state: 'not-started', ...facts(state), waitedMs,
      text: `Pressed Enter VR, but the page was not presenting after ${seconds(waitedMs)} (phase ${state?.phase ?? 'unknown'})`
        + `${note ? `, and it says "${note}"` : ''}. Ask the wearer what the headset shows.` };
  } catch (error) {
    return { entered: false, pressed: false, state: 'no-debugger', target: described,
      reason: redactDevtoolsText((error instanceof Error ? error.message : String(error)).slice(0, 300)),
      text: 'The headset browser\'s debugger connected but the page did not answer it, so ask the wearer to tap Enter VR on the page.' };
  } finally {
    session.close();
  }
}
