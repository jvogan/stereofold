import { assistantStatus } from './assistant-status.mjs';
import { connectionStatus, markTalkLinkLost, TALK_LINK_LOST } from './connection-liveness.mjs';
/**
 * Hold a Quest face button to signal push-to-talk to the Mac.
 *
 * This was once the left grip, which is a guaranteed misfire: a wearer
 * squeezing the left grip to steady a two-hand scale opened a microphone. Both
 * grips now grab the structure and push-to-talk is holding A or X. The button
 * reader is
 * `xr-buttons.mjs`; it calls `start()` and `stop()` below, which are the same
 * two calls the grip edge used to make, so the transport is unchanged.
 *
 * `pushToTalkBinding()` publishes the live binding for the frame loop that
 * reads the buttons. The viewer builds the button reader and the immersive
 * session builds this, several layers apart, and neither holds the other.
 *
 * The page sends `push_to_talk` with `{state:'down'}` and `{state:'up'}`
 * through the same authenticated JSON `/tool` route every other companion
 * action uses. The grip edge itself carries no audio. In an authenticated
 * companion, optional microphone capture starts from the same user gesture
 * and sends a bounded PCM recording only after browser permission. The Mac
 * decides what the press means.
 *
 * `setPushToTalkSender` exists because the immersive session is built inside
 * the viewer, several layers below the page that owns the companion transport.
 * The page registers its sender once; the session reads it when it starts.
 */

import { pushToTalkAudioStream, pushToTalkAudioEvents, pushToTalkAudioSender } from './push-to-talk-audio.mjs';
import { setHeadsetCaptionSink } from './xr-manipulate.mjs';

/**
 * The synthetic source a held press holds, so it can never be mistaken for a
 * controller. Every press now arrives through `start()`, from a held A or X or
 * from the toolbar's Talk row, and both mean the same thing to the transport.
 */
const HELD_PRESS_SOURCE = Object.freeze({ handedness: 'none', origin: 'held-press' });

/** States that mean the streamer has closed the utterance it was given. */
const UTTERANCE_OVER = Object.freeze(['idle', 'heard', 'error']);

/** The status row while a press is open and nobody has named a better line. */
export const DEFAULT_LISTENING_TEXT = 'Listening…';

/** Diagnostics never cost a press: a broken recorder hook must not throw here. */
function recordGripDiagnostic(kind, detail) {
  try { globalThis.__stereofoldDiagnostics?.record?.(kind, detail); }
  catch { /* The page may have no diagnostics hook installed. */ }
}

export const PUSH_TO_TALK_TOOL = 'push_to_talk';

let registeredSender;
let registeredVoiceSender;
let activeBinding;

/**
 * The push-to-talk binding of the live immersive session, or `undefined`.
 *
 * One session runs at a time, and the binding registers itself here so the
 * viewer's face-button reader can open and close the microphone without the
 * viewer holding a reference to the immersive session that built it.
 */
export function pushToTalkBinding() { return activeBinding; }

/** Called once by the companion page with its authenticated tool caller. */
export function setPushToTalkSender(send) {
  registeredSender = typeof send === 'function' ? send : undefined;
}

export function pushToTalkSender() {
  return registeredSender;
}

/** The companion page supplies the authenticated LAN voice endpoint here. */
export function setVoiceCommandSender(sender) {
  registeredVoiceSender = typeof sender === 'function' ? { send: sender } : sender && typeof sender.send === 'function' ? sender : undefined;
}

export function voiceCommandSender() {
  return registeredVoiceSender;
}

/**
 * Bind push-to-talk to one session.
 *
 * @param {object} options
 * @param {XRSession} options.session live immersive session
 * @param {(state:'down'|'up')=>Promise<unknown>} [options.send] tool caller
 * @param {(text:string,progress?:'listening'|'sending'|'idle')=>unknown} [options.status] in-headset indicator
 * @param {string|(()=>string)} [options.listeningText] indicator text while held, or a reader called at each press
 * @param {{start:()=>Promise<unknown>,stop:()=>Promise<unknown>}} [options.capture] actual microphone capture
 * @param {{start:()=>Promise<unknown>,stop:()=>Promise<unknown>}} [options.interaction] shared voice controller owning capture, transport, and playback
 * @param {{unlock?:()=>Promise<unknown>,start?:()=>Promise<unknown>,send:(audio:unknown,context:unknown)=>Promise<{command?:unknown,message?:string}>}} [options.sendVoice] authenticated voice caller
 * @param {(command:unknown)=>Promise<{message?:string}>} [options.onCommand] applies a validated typed command
 * @param {{start:()=>Promise<unknown>,stop:()=>Promise<unknown>,dispose?:()=>Promise<unknown>}|null} [options.audio] version 2 microphone streamer; omitted means the page-registered one, `null` means none
 * @returns {{listening:()=>boolean, dispose:()=>Promise<void>}}
 */
export function attachGripPushToTalk({ session, send, status, listeningText = DEFAULT_LISTENING_TEXT, capture: rawCapture, interaction, sendVoice, onCommand, audio } = {}) {
  if (!session || typeof session.addEventListener !== 'function') throw new TypeError('A talk binding needs a live XR session.');
  const call = typeof send === 'function' ? send : state => registeredSender?.(state);
  const show = typeof status === 'function' ? status : () => undefined;
  let releaseWarning = '';
  let held, closed = false, chain = Promise.resolve(), voiceContext, voiceBusy = false, starting = false, pendingCapture;
  // Version 2 of push-to-talk streams the headset microphone to the Mac for
  // local transcription. It is present only when the companion page has
  // registered an authenticated sender, publishes its own state through
  // `pushToTalkAudioEvents()`, and never writes to the toolbar, so it can run
  // beside the version 1 command routes above without fighting them for the
  // status line.
  const audioStream = audio === undefined ? pushToTalkAudioStream() : audio || undefined;
  // One microphone per press. Version 2 owns the headset microphone whenever
  // the page has registered its sender, so the version 1 PCM routes are shut
  // off rather than run alongside it. Version 1 remains the whole feature on a
  // companion that never registered a version 2 sender.
  const v2 = Boolean(audioStream) || typeof pushToTalkAudioSender() === 'function';
  const shared = !v2 && interaction && typeof interaction.start === 'function' && typeof interaction.stop === 'function' ? interaction : undefined;
  const capture = v2 ? undefined : rawCapture;
  const voice = v2 ? undefined
    : typeof sendVoice === 'function' ? { send: sendVoice } : sendVoice?.send ? sendVoice : registeredVoiceSender;

  // The toolbar's one caption line is handed to this binding by the immersive
  // session. Publish it so picks and gestures write to the same plate.
  setHeadsetCaptionSink(show);

  function indicate(text, progress = text ? undefined : 'idle') {
    if (connectionStatus().voiceLost) { text = TALK_LINK_LOST;progress = 'idle'; }
    try { const result = show(text, progress); if (result && typeof result.catch === 'function') result.catch(() => {}); }
    catch { /* The toolbar can be mid-teardown; the transport still matters. */ }
  }

  /**
   * What the status row says while the press is open.
   *
   * A caller may pass a function instead of a string when the line depends on
   * something that can change between presses — whether a Mac-side agent is
   * attached, in the one caller that does. It is read at each press rather than
   * at bind time for exactly that reason, and a caller that returns nothing
   * falls back to the plain indicator, because a blank status row would read as
   * a microphone that never opened.
   */
  function listeningLine() {
    if (typeof listeningText !== 'function') return listeningText;
    try { const line = listeningText(); return typeof line === 'string' && line.trim() ? line : DEFAULT_LISTENING_TEXT; }
    catch { return DEFAULT_LISTENING_TEXT; }
  }

  /** Order down and up on one queue so an up can never overtake its down. */
  function post(state) {
    chain = chain.then(() => call(state), () => call(state)).then(() => {}, () => {
      if (closed) return;
      markTalkLinkLost();
      if (pendingCapture) pendingCapture.failed = true;
      held = undefined;
      indicate(TALK_LINK_LOST, 'idle');
      // Discard this utterance; a late microphone start must also stop below.
      void discardCapture();
    });
    return chain;
  }

  async function discardCapture() {
    try {
      if (audioStream) await (audioStream.cancel ? audioStream.cancel() : audioStream.stop());
      else if (shared) await shared.cancel?.();
      else if (capture) await capture.stop();
    } catch { /* The persistent lost-link line already reports the failure. */ }
  }

  /**
   * Take back a hold the streamer has already closed on its own.
   *
   * The streamer ends an utterance by itself in two ordinary cases: the
   * duration cap and the silence auto-stop. Both call its `stop()` directly,
   * so `release()` never runs and `held` stayed set for the rest of the
   * session. Every later press then returned at the guard in `press()`
   * without opening a microphone: the menu said it was listening, nothing was
   * recorded, and the wearer waited out a twelve-second backstop. That is
   * exactly what the second press did on the Quest 2.
   *
   * `busy()` is the streamer's own answer for whether an utterance is still
   * open, so the hold is dropped only when it says there is nothing left to
   * hold. A streamer that does not expose it keeps the old behaviour.
   */
  function reclaimStaleHold(reason) {
    if (!held || !audioStream || typeof audioStream.busy !== 'function' || audioStream.busy()) return false;
    held = undefined;
    // The press posted `down`; the Mac gets the matching `up` it never sent.
    void post('up');
    recordGripDiagnostic('voice-hold', { phase: 'reclaimed', reason });
    return true;
  }

  function press(source) {
    if (closed || !source) return;
    if (connectionStatus().line) { markTalkLinkLost();indicate(TALK_LINK_LOST, 'idle');return; }
    reclaimStaleHold('press');
    if (held) { recordGripDiagnostic('voice-press', { ignored: 'held' }); return; }
    if (voiceBusy || (starting && pendingCapture?.failed)) { indicate('Voice request in progress', 'sending'); return; }
    held = source; releaseWarning = '';
    const captureAttempt = { failed: false };pendingCapture = captureAttempt;
    indicate(shared || capture ? 'Starting microphone…' : listeningLine(), 'listening');
    void post('down');
    // The button reader awaits this promise, so a refused microphone is
    // recorded as a failed press instead of leaving the menu saying it is
    // listening. A failed start also gives the press back: leaving `held` set
    // would make every later press a no-op, which is how one refused
    // microphone used to end voice for the rest of the session.
    if (audioStream) {
      starting = true;
      return Promise.resolve(audioStream.start()).then(() => { if (captureAttempt.failed) return discardCapture(); }, error => {
        if (held === source) { held = undefined; void post('up'); }
        indicate('Voice unavailable. Use the menu controls instead.');
        throw error;
      }).finally(() => { starting = false; });
    }
    if (shared) {
      starting = true;
      void Promise.resolve(shared.start()).then(() => {
        if (captureAttempt.failed) return discardCapture();
        if (!closed && held === source) indicate(listeningLine(), 'listening');
      }, () => {
        if (!closed && held === source) {
          held = undefined; void post('up');
          indicate('Voice unavailable. Use the menu controls instead.');
        }
      }).finally(() => { starting = false; });
      return;
    }
    if (capture) {
      // Start the persistent reply context in this exact XR gesture. Waiting
      // for microphone permission or OAuth first would lose Quest autoplay
      // eligibility even though the wearer initiated the press.
      void Promise.resolve(voice?.unlock?.()).catch(() => {});
      // Keep the binding promise with this exact press. A later press cannot
      // overwrite it while the first recording is being transcribed.
      starting = true;
      voiceContext = Promise.resolve(capture.start()).then(() => voice?.start?.());
      void voiceContext.then(() => {
      if (captureAttempt.failed) return discardCapture();
      if (!closed && held === source) indicate(voice ? listeningLine() : 'Voice transport unavailable', voice ? 'listening' : undefined);
    }, () => {
      if (!closed && held === source) {
        held = undefined; void post('up');
        voiceContext = undefined;
        void Promise.resolve().then(() => capture.stop()).catch(() => {});
        indicate('Voice unavailable. Use the menu controls instead.');
      }
    }).finally(() => { starting = false; });
    }
  }

  /**
   * End a press.
   *
   * `force` is what the button reader and the toolbar's Talk row both use, and
   * it must always stop. The source check below exists so one controller can
   * never end another's press, but a released A or X has no such ambiguity:
   * the wearer let go, and a stop that quietly returned because the press was
   * still in flight is what used to leave a microphone open for the rest of
   * the session with no way to close it.
   */
  function release(source, { force = false } = {}) {
    const wasHeld = held;
    if (!wasHeld && !force) return;
    if (wasHeld && source && source !== wasHeld && !force) return;
    held = undefined;
    if (wasHeld) {
      void post('up');
      releaseWarning = assistantStatus.releaseLine();
      if (releaseWarning) indicate(releaseWarning, 'idle');
    }
    if (audioStream) {
      if (wasHeld && !releaseWarning) indicate('Transcribing…', 'sending');
      return Promise.resolve(audioStream.stop()).then(() => {});
    }
    if (!wasHeld) return;
    if (shared) {
      if (!releaseWarning) indicate('Transcribing…', 'sending'); voiceBusy = true;
      void Promise.resolve(shared.stop()).then(outcome => {
        if (!closed) indicate(typeof outcome?.message === 'string' ? outcome.message : '');
      }).catch(() => { if (!closed) indicate('Voice command failed'); }).finally(() => { voiceBusy = false; });
      return;
    }
    if (!capture) { if (!releaseWarning) indicate('', 'idle'); return; }
    const context = voiceContext; voiceContext = undefined; voiceBusy = true;
    if (!releaseWarning) indicate('Transcribing…', 'sending');
    void Promise.resolve(capture.stop()).then(async audio => {
      if (!audio) { if (!closed) indicate('No speech captured'); return; }
      if (typeof voice?.send !== 'function') { if (!closed) indicate('Voice transport unavailable'); return; }
      const binding = await context;
      const outcome = await voice.send(audio, binding);
      if (closed) return;
      if (outcome?.command && typeof onCommand === 'function') {
        indicate('Applying command…', 'sending');
        const applied = await onCommand(outcome.command);
        if (!closed) indicate(typeof applied?.message === 'string' ? applied.message : 'Command applied');
      } else indicate(typeof outcome?.message === 'string' ? outcome.message : 'Command was not recognized');
    }).catch(() => { if (!closed) indicate('Voice command failed'); }).finally(() => { voiceBusy = false; });
  }

  /**
   * Drop an open press without asking anyone to transcribe it.
   *
   * `release()` is the wearer letting go, and it means "say what I just said".
   * This is the other ending: the session stopped being visible — the headset
   * came off, or the system menu took over — and whatever the microphone has
   * been holding is a room, not a request. Sending it would let an agent act
   * on a conversation the wearer was not having with it.
   *
   * The Mac still gets the matching `up` edge. Its push-to-talk state machine
   * saw the `down` and has to be told the press ended; leaving it open is how
   * a headset on a table keeps a Mac believing a button is held.
   *
   * Each transport has its own honest discard. Version 2's streamer defines
   * `cancel()` — it stops the recorder and resolves the utterance without
   * uploading a tail. The shared voice controller has the inspector's own
   * `cancel()`, which is what the page's Cancel button and `pagehide` already
   * call. Version 1's bare capture is stopped and its audio dropped on the
   * floor, because `voice.send` is the only thing that would transmit it and
   * this path never reaches it.
   */
  function abandon(reason = 'hidden') {
    const wasHeld = held;
    held = undefined;
    const context = voiceContext; voiceContext = undefined;
    void context?.catch?.(() => {});
    if (wasHeld) void post('up');
    recordGripDiagnostic('voice-cancel', { reason, held: Boolean(wasHeld) });
    indicate('', 'idle');
    if (audioStream) {
      return Promise.resolve(audioStream.cancel ? audioStream.cancel() : audioStream.stop())
        .then(() => {}, () => {});
    }
    if (!wasHeld) return Promise.resolve();
    if (shared) {
      return Promise.resolve(typeof shared.cancel === 'function' ? shared.cancel() : shared.stop?.())
        .then(() => {}, () => {});
    }
    if (!capture) return Promise.resolve();
    // The recording is read back only so the microphone track is released.
    return Promise.resolve(capture.stop()).then(() => {}, () => {});
  }

  const onEnd = () => {
    release(); closed = true;
    setHeadsetCaptionSink(undefined);
    if (activeBinding === binding) activeBinding = undefined;
    // The page-wide emitter outlives the session, so a binding that is never
    // disposed must still stop listening when its session ends.
    try { unsubscribeAudioState?.(); } catch { /* Already detached. */ }
  };

  // The streamer's own state stream is the earliest news that an utterance is
  // over, so a hold the wearer never released is dropped as it closes rather
  // than at the next press. It keeps `listening()` honest for the toolbar and
  // costs nothing when the release edge did the work already.
  const unsubscribeAudioState = audioStream
    ? pushToTalkAudioEvents().on(event => {
      if (UTTERANCE_OVER.includes(event?.state)) reclaimStaleHold(event.state);
      if (event?.state === 'transcribing' && !releaseWarning) indicate('Transcribing…', 'sending');
      else if (event?.state === 'idle' && !releaseWarning) indicate('', 'idle');
      else if (event?.state === 'error') indicate('Voice command failed');
    })
    : undefined;

  session.addEventListener('end', onEnd, { once: true });

  const binding = {
    listening: () => Boolean(held),
    audio: audioStream,
    audioEvents: pushToTalkAudioEvents(),
    /**
     * Open the microphone. A held A or X reaches this through the viewer's
     * button reader, the toolbar's Talk row through its own press, and both run
     * the same path, so either opens exactly one microphone and posts the same
     * transport edges.
     */
    start: () => press(HELD_PRESS_SOURCE),
    stop: () => release(held, { force: true }),
    /**
     * Close the microphone and throw the recording away. The immersive
     * session calls this when the XR session stops being visible; nothing a
     * wearer does reaches it.
     */
    cancel: reason => abandon(reason),
    /** Version 2's state stream, exposed only when version 2 is actually running. */
    subscribe: audioStream ? listener => pushToTalkAudioEvents().on(listener) : undefined,
    /** Microphone loudness for the menu's mic pill, or `undefined` between presses. */
    level: () => audioStream?.level?.(),
    async dispose() {
      closed = true;
      setHeadsetCaptionSink(undefined);
      if (activeBinding === binding) activeBinding = undefined;
      try { unsubscribeAudioState?.(); } catch { /* The emitter may already be gone. */ }
      release();
      try { await capture?.stop?.(); } catch { /* Capture teardown is best effort. */ }
      try { await audioStream?.dispose?.(); } catch { /* The streamer owns its own microphone track. */ }
      try { session.removeEventListener('end', onEnd); } catch { /* The UA may have detached the session already. */ }
      await chain.catch(() => {});
    },
  };
  activeBinding = binding;
  return binding;
}
