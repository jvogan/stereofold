import { recordLoopStage } from './loop-timing.mjs';
import { createVoiceCapture, VOICE_MAX_DURATION_MS, VOICE_MIN_DURATION_MS } from './voice-capture.mjs';
import { createVoicePlayback, prepareVoicePlayback } from './voice-playback.mjs';
import { showHeadsetCaption } from './xr-manipulate.mjs';

const AUTO_STOP_LEAD_MS = 100;
export const VOICE_STARTUP_TIMEOUT_MS = 15_000;
/**
 * How long a chapter line may wait for the speaker before it is given up on.
 *
 * Under the shortest autoplay pace a chapter lasts about seven seconds, so a
 * line still waiting after twenty is describing a scene the wearer has long
 * since left — and `TOUR_NARRATION_TIMEOUT_MS` in tour-player.ts would log it
 * as a stalled narration at thirty. Stop short of that, silently.
 */
export const DEFERRED_NARRATION_HOLD_MS = 20_000;

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : 'Voice command failed.';
}

/**
 * Whether a line stopped because something deliberately replaced it.
 *
 * A new tour chapter, a microphone press and a cancel all abort the audio in
 * progress. The wearer hears what was meant — the line that took its place —
 * so showing them `Voice failed` for it would report a fault they did not have
 * and, worse, would overwrite the status the new line had just set.
 */
function wasInterrupted(error) {
  return error?.name === 'AbortError';
}

/**
 * Owns one browser microphone interaction shared by the desktop page and XR.
 *
 * `toggle()` is the point/tap contract. `start()`/`stop()` are the hold
 * contract, and `cancel()` drops a press without sending it. `begin` runs
 * after capture starts (for example, to open an authenticated voice request);
 * `send` receives the bounded PCM result and that begin value. A successful
 * result may include `wavBase64`, which is played through the context unlocked
 * by the original gesture.
 */
export function createVoiceInteraction({ capture = createVoiceCapture(), playback = createVoicePlayback(), begin,
  send, onState } = {}) {
  if (!capture || typeof capture.start !== 'function' || typeof capture.stop !== 'function') throw new TypeError('Voice interaction needs microphone capture.');
  if (!playback || typeof playback.unlock !== 'function' || typeof playback.play !== 'function') throw new TypeError('Voice interaction needs playback controls.');
  if (typeof begin !== 'undefined' && typeof begin !== 'function') throw new TypeError('Voice interaction begin must be a function.');
  if (typeof send !== 'undefined' && typeof send !== 'function') throw new TypeError('Voice interaction send must be a function.');
  if (typeof onState !== 'undefined' && typeof onState !== 'function') throw new TypeError('Voice interaction onState must be a function.');

  const listeners = new Set();
  let phase = 'idle', message = '', context, timer, generation = 0, disposed = false, playbackAbort, playbackGeneration = 0, cancelStartup;
  // One queue for everything this page says out loud. Tour narration and
  // command acknowledgements are spoken by two
  // callers that cannot see each other, and both used to enter `playback.play`
  // directly, so the wearer heard two voices at once.
  const speechQueue = [];
  let speaking = false, speakingKind;
  // How many times the wearer has taken the audio channel for themselves. A
  // chapter's spoken line is fetched from the Mac and
  // can come back tens of seconds later; whoever asked for it needs to know
  // that a microphone press happened in between, because by then the line is
  // about a moment the wearer has already left. Only `start`, `cancel` and
  // `dispose` bump it — deliberately not every `stopSpeaking`, because one
  // chapter replacing another must not invalidate the chapter that replaced it.
  let takeovers = 0;
  // Interrupting lines take their turn one at a time. A turn ends the moment
  // the new line owns the speaker, not when it finishes speaking, so an
  // interrupt still cuts off what is playing rather than waiting it out.
  let interruptTurn = Promise.resolve();
  // The one chapter line that stood down, kept.
  //
  // Standing a chapter line down for the wearer's own answer was right; letting
  // it go was not. Under autoplay nothing asks for that line a second time, so
  // the chapter the agent talked over was watched in silence. It waits here
  // instead, and speaks the moment nothing else wants the speaker — but only if
  // its caller still says the line is worth saying. Exactly one line waits: a
  // newer chapter replaces an older one, because the newer one is the chapter
  // the wearer is actually on.
  let deferredNarration, deferredTimer, releaseScheduled = false;

  function notify(next, text = '') {
    phase = next; message = text;
    try { onState?.(phase, message); } catch {}
    for (const listener of [...listeners]) { try { listener(phase, message); } catch {} }
    // A press that ends, a cancel, or the last line of a lesson finishing all
    // land here. Any of them may be the moment the held line can be said.
    if (phase === 'idle') scheduleDeferredRelease();
  }

  function clearTimer() { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } }

  /**
   * Drop every line still waiting for its turn.
   *
   * A waiting line never reached the speakers, so it resolves `false` rather
   * than rejecting. A new tour chapter replacing it, or a wearer taking the
   * microphone, is not a speech failure and must not be recorded as one:
   * `speakNarration` in `inspector.ts` logs every rejection as `speech-failed`.
   */
  function dropQueuedSpeech() {
    while (speechQueue.length) speechQueue.shift().resolve(false);
  }

  /**
   * Drop the chapter lines waiting their turn and keep the answers.
   *
   * A new chapter replaces the lesson's own queued sentences, as it always
   * has. It does not replace an answer the wearer asked for: that reply was
   * queued behind a chapter that is now over, and dropping it would lose it for
   * good — the wearer asked a question and would simply never be answered.
   */
  function dropQueuedNarration() {
    const kept = speechQueue.filter(entry => entry.kind === 'reply');
    while (speechQueue.length) {
      const entry = speechQueue.shift();
      if (entry.kind !== 'reply') entry.resolve(false);
    }
    speechQueue.push(...kept);
  }

  /**
   * Cut off the line speaking right now. Its own caller still sees the abort,
   * which is the contract a microphone press has always had.
   *
   * The generation bump is what tells the aborted `speak` that it no longer
   * owns the speaker, so its `finally` leaves the queue alone.
   */
  function stopSpeaking() {
    ++playbackGeneration;
    playbackAbort?.abort(); playbackAbort = undefined;
    speaking = false; speakingKind = undefined;
  }

  /**
   * Whether the wearer is holding the conversation right now.
   *
   * `stop()` only submits a press from `starting` or `listening`, so a line
   * that reached `notify('playing')` during a press cost the wearer the press
   * itself: the release found the wrong phase and the recorded audio was never
   * transcribed. Nothing the page decides to say is worth that, so late speech
   * stands down until the press is over. The reply to that very press is the
   * one exception; it is the wearer's own turn continuing, not an interruption.
   */
  function microphoneBusy() {
    return phase === 'starting' || phase === 'listening' || phase === 'sending';
  }

  /** Whether an answer the wearer asked for is speaking or waiting to speak. */
  function replyPending() {
    return (speaking && speakingKind === 'reply') || speechQueue.some(entry => entry.kind === 'reply');
  }

  /** Nothing is speaking, nothing is waiting, and the microphone is closed. */
  function speechChannelFree() {
    return !disposed && !microphoneBusy() && !speaking && speechQueue.length === 0;
  }

  function clearDeferredTimer() { if (deferredTimer !== undefined) { clearTimeout(deferredTimer); deferredTimer = undefined; } }

  /**
   * Let go of a held line without speaking it.
   *
   * It never reached the speakers, so it resolves `false` like any other line
   * that was dropped before it played; `speakNarration` records a rejection as
   * `speech-failed`, and nobody had a failure here.
   */
  function dropDeferredNarration() {
    const held = deferredNarration;
    deferredNarration = undefined; clearDeferredTimer();
    held?.resolve(false);
  }

  /**
   * Hold this chapter line until the speaker is free.
   *
   * `stale` is the caller's own question, asked once more at the moment the
   * line would finally be spoken: is the lesson still on this chapter? Only a
   * caller that can answer it gets to wait — everyone else stands down as
   * before, because a line nobody can vouch for is worse said late than unsaid.
   */
  function deferNarration(wavBase64, text, kind, stale) {
    dropDeferredNarration();
    return new Promise((resolve, reject) => {
      const held = { wavBase64, text, kind, stale, resolve, reject };
      deferredNarration = held;
      // A line held past its own chapter is worse than silence, and the tour
      // player already treats a narration that takes more than thirty seconds
      // as a fault. Give up first, and quietly.
      deferredTimer = setTimeout(() => { if (deferredNarration === held) dropDeferredNarration(); }, DEFERRED_NARRATION_HOLD_MS);
    });
  }

  function releaseDeferredNarration() {
    if (!deferredNarration || !speechChannelFree()) return;
    const held = deferredNarration;
    let stale = true;
    // A predicate that throws cannot say the line is still wanted, so it is not.
    try { stale = held.stale() === true; } catch { stale = true; }
    deferredNarration = undefined; clearDeferredTimer();
    if (stale) { held.resolve(false); return; }
    speak(held.wavBase64, held.text, held.kind).then(held.resolve, held.reject);
  }

  /**
   * Ask again after the current job, not inside it.
   *
   * `notify('idle')` runs while `speak` still holds the speaker in its `finally`
   * and `drainSpeech` runs before the queue has settled. A microtask sees both
   * finished, and one is enough however many callers ask.
   */
  function scheduleDeferredRelease() {
    if (!deferredNarration || releaseScheduled) return;
    releaseScheduled = true;
    queueMicrotask(() => { releaseScheduled = false; releaseDeferredNarration(); });
  }

  function waitForStartup(promise) {
    let resolveCancel, timeout;
    const cancelled = new Promise(resolve => { resolveCancel = () => resolve('cancelled'); });
    const timedOut = new Promise(resolve => { timeout = setTimeout(() => resolve('timeout'), VOICE_STARTUP_TIMEOUT_MS); });
    cancelStartup = resolveCancel;
    return Promise.race([Promise.resolve(promise).then(() => 'ready'), cancelled, timedOut]).finally(() => {
      clearTimeout(timeout);
      if (cancelStartup === resolveCancel) cancelStartup = undefined;
    });
  }

  // Unlock reply audio from a trusted desktop/XR gesture without opening the
  // microphone or starting a voice request.
  function unlock() {
    if (disposed) throw Error('Voice interaction is closed.');
    return prepareVoicePlayback(playback);
  }

  // Transport-only surface for the existing grip adapter. It deliberately
  // does not own capture; attachGripPushToTalk supplies that separately.
  async function beginRequest() {
    await unlock();
    return begin?.();
  }

  async function sendAudio(audio, voiceContext, { playReply = true } = {}) {
    if (typeof send !== 'function') return { message: 'Voice transport unavailable' };
    const outcome = await send(audio, voiceContext);
    // The wearer asked for this one, so it goes ahead of any narration queued
    // while they were speaking. The command itself already succeeded, so a
    // chapter that later speaks over the reply does not undo it.
    if (playReply && outcome?.wavBase64) {
      try { await playLine(outcome.wavBase64, typeof outcome.message === 'string' ? outcome.message : 'Playing reply…', { interrupt: true, kind: 'reply', fromCapture: true, timing: voiceContext }); }
      catch (error) { if (!wasInterrupted(error)) throw error; }
    }
    return outcome;
  }

  async function start() {
    if (disposed) throw Error('Voice interaction is closed.');
    if (phase === 'playing') {
      // A queued OAuth reply must not make the next user microphone press
      // wait for audio to finish. Abort only this playback; the microphone
      // owns the interaction from this point onward.
      //
      // The press also drops the lines still waiting their turn. A
      // confirmation about what the wearer did a moment ago must not
      // surface on top of the request they have just started.
      dropQueuedSpeech();
      stopSpeaking();
    } else if (phase !== 'idle') return false;
    ++takeovers;
    const token = ++generation;
    notify('starting', 'Starting microphone…');
    // Invoke this synchronously from the trusted gesture so the browser can
    // authorize reply audio, but do not hold microphone startup on a browser
    // AudioContext resume that can remain pending behind a permission prompt.
    let captureStarted = false;
    try {
      // Both browser-gated operations begin inside the trusted gesture. Audio
      // unlock is deliberately independent: a suspended AudioContext must not
      // delay getUserMedia and lose the microphone activation boundary.
      try {
        const unlocking = unlock();
        Promise.resolve(unlocking).catch(error => {
          if (!disposed && token === generation && phase === 'starting') notify('starting', `Audio reply unavailable: ${errorMessage(error)}`);
        });
      } catch (error) { notify('starting', `Audio reply unavailable: ${errorMessage(error)}`); }
      if (disposed || token !== generation) return false;
      const captured = await waitForStartup(capture.start());
      if (captured === 'cancelled' || disposed || token !== generation) return false;
      if (captured === 'timeout') throw Error('Microphone startup timed out.');
      if (disposed || token !== generation) return false;
      captureStarted = true;
      context = await begin?.();
      if (disposed || token !== generation) return false;
      notify('listening', 'Listening…');
      // Capture has its own hard bound. Stop slightly before it so the
      // controller submits the completed PCM instead of racing auto-stop.
      // `begin` may wait for a save/heartbeat before returning. If capture's
      // own hard timer already completed during that wait, stop() consumes its
      // retained result immediately instead of starting another long timer.
      const autoStopMs = capture.active?.() === false ? 0
        : Math.max(VOICE_MIN_DURATION_MS, VOICE_MAX_DURATION_MS - AUTO_STOP_LEAD_MS);
      timer = setTimeout(() => { void stop(true); }, autoStopMs);
      return true;
    } catch (error) {
      // Availability failures need a local alternative, including when the
      // browser has no speech API. Recognition itself runs on the host.
      const unavailable = !captureStarted && (['NotAllowedError', 'SecurityError', 'NotFoundError'].includes(error?.name)
        || /microphone capture is unavailable/i.test(errorMessage(error)));
      if (unavailable) error = Object.assign(new Error('Voice unavailable. Use the menu controls instead.', { cause: error }),
        { name: error?.name ?? 'Error' });
      if (unavailable && token === generation && !disposed) showHeadsetCaption(error.message);
      if (token === generation && !disposed) notify('error', errorMessage(error));
      if (token === generation) { try { await capture.stop(); } catch {} }
      if (token === generation && !disposed) notify('idle', unavailable ? error.message : '');
      throw error;
    }
  }

  async function stop(auto = false) {
    if (disposed || (phase !== 'starting' && phase !== 'listening')) return false;
    const wasStarting = phase === 'starting';
    recordLoopStage('microphone-release', context);
    const token = ++generation;
    cancelStartup?.(); cancelStartup = undefined;
    clearTimer();
    notify('sending', auto ? 'Sending voice command…' : 'Transcribing…');
    try {
      const audio = await capture.stop();
      if (disposed || token !== generation) return false;
      // A release that races permission/startup cancels the press. There is no
      // complete listening interval to submit, even if a test double (or a
      // browser implementation) returns buffered samples immediately.
      if (wasStarting) { notify('idle'); return false; }
      if (!audio) { notify('idle', 'No speech captured'); return false; }
      if (typeof send !== 'function') { notify('idle', 'Voice transport unavailable'); return false; }
      const outcome = await sendAudio(audio, context, { playReply: false });
      if (disposed || token !== generation) return false;
      if (outcome?.wavBase64) await playLine(outcome.wavBase64, typeof outcome.message === 'string' ? outcome.message : 'Playing reply…', { interrupt: true, kind: 'reply', fromCapture: true, timing: context });
      else notify('idle', typeof outcome?.message === 'string' ? outcome.message : 'Voice command complete');
      return outcome;
    } catch (error) {
      // An interrupted reply is not a failed command, and the line that
      // replaced it has already set the status this would overwrite.
      if (!disposed && token === generation && !wasInterrupted(error)) { notify('error', errorMessage(error)); notify('idle'); }
      return false;
    } finally {
      if (token === generation) context = undefined;
    }
  }

  /**
   * Say one line, and never more than one at a time.
   *
   * Lines take turns: an acknowledgement waits out the narration already
   * speaking instead of talking over it. `interrupt` is the exception — a new
   * tour chapter, or the wearer's own answer, cuts off what is speaking and
   * drops what is waiting, because a queued sentence about the previous
   * chapter is worse than silence.
   *
   * `kind` says what is being spoken, so the in-headset menu can tell
   * narration from an answer to the wearer; see `spatial-toolbar-content.mjs`.
   * Resolves `false` when the line was dropped before it was ever played.
   *
   * `stale` asks the caller, at the last possible moment, whether the line is
   * still worth saying. A narration that supplies one is held back rather than
   * dropped when something else owns the speaker; see `deferNarration`.
   */
  async function play(wavBase64, text = 'Playing reply…', { interrupt = false, kind = 'reply', stale, timing } = {}) {
    return playLine(wavBase64, text, { interrupt, kind, stale, timing, fromCapture: false });
  }

  /**
   * `fromCapture` marks the answer to the press the wearer has just finished.
   * That one plays through `sending`, because it is what the press was for.
   */
  async function playLine(wavBase64, text, { interrupt = false, kind = 'reply', fromCapture = false, stale, timing } = {}) {
    if (disposed) throw Error('Voice interaction is closed.');
    // A chapter line that can be re-checked later waits its turn instead of
    // being thrown away. Everything else stands down exactly as before.
    const holdable = kind === 'narration' && typeof stale === 'function';
    if (!fromCapture && microphoneBusy()) return holdable ? deferNarration(wavBase64, text, kind, stale) : false;
    if (!interrupt) {
      if (speaking || speechQueue.length > 0) {
        return new Promise((resolve, reject) => speechQueue.push({ wavBase64, text, kind, timing, resolve, reject }));
      }
      return speak(wavBase64, text, kind, timing);
    }
    // Two interrupts arriving together — a chapter's line landing as the wearer
    // presses Next, say — both cut off what was speaking and both started their
    // own. Taking a turn makes the second one see the first one's decision
    // instead of the state that preceded it.
    const token = generation;
    const previous = interruptTurn;
    let handOver;
    interruptTurn = new Promise(resolve => { handOver = resolve; });
    try {
      await previous;
      // Exit, cancellation or a new microphone press invalidates speech that
      // was still waiting for this turn; it must not reopen released audio.
      if (disposed || token !== generation) return false;
      if (!fromCapture && microphoneBusy()) return holdable ? deferNarration(wavBase64, text, kind, stale) : false;
      // A chapter must not talk over the answer the wearer asked for. The
      // chapter is still drawn and still captioned; only its audio stands down,
      // and speaking it over the reply would lose the reply for good — an
      // aborted reply is reported as an interruption, never retried.
      if (kind === 'narration' && replyPending()) {
        // This line stands down for the answer, not for whatever happens to be
        // speaking. A reply that is only QUEUED would otherwise leave the
        // previous chapter talking over this chapter's scene and then play
        // after it — the wearer watches a new chapter while hearing the old
        // one. So the stale chapter is cut here exactly as it would be with no
        // reply in the queue, the reply keeps its place and starts, and this
        // line waits for it like any other held chapter.
        if (!(speaking && speakingKind === 'reply')) {
          dropQueuedNarration(); stopSpeaking(); drainSpeech();
        }
        return holdable ? deferNarration(wavBase64, text, kind, stale) : false;
      }
      dropQueuedSpeech(); stopSpeaking();
      // This chapter owns the speaker now, so an older one still waiting for it
      // is over. A reply taking the speaker leaves the held line alone: it is
      // the reply the line was standing down for in the first place.
      if (kind === 'narration') dropDeferredNarration();
      return speak(wavBase64, text, kind, timing);
    } finally { handOver(); }
  }

  /** Hold the speaker for exactly one line, then hand it to the next in line. */
  async function speak(wavBase64, text, kind, timing) {
    const token = ++playbackGeneration;
    speaking = true; speakingKind = kind;
    notify('playing', text);
    const controller = new AbortController(); playbackAbort = controller;
    try {
      await playback.play(wavBase64, { signal: controller.signal, timing: { ...timing, text } });
      // Stay in `playing` while another line is already waiting, so the menu
      // does not flash back to `Talk` between two sentences of one lesson.
      if (!disposed && token === playbackGeneration && speechQueue.length === 0) notify('idle', text);
      return true;
    } catch (error) {
      if (!disposed && token === playbackGeneration) { notify('error', errorMessage(error)); notify('idle'); }
      throw error;
    } finally {
      if (playbackAbort === controller) playbackAbort = undefined;
      // A newer generation already owns the speaker (an interruption, a
      // microphone press, a cancel). Releasing it here would start a queued
      // line underneath the one now playing — the very overlap this fixes.
      if (token === playbackGeneration) { speaking = false; speakingKind = undefined; drainSpeech(); }
    }
  }

  function drainSpeech() {
    if (disposed || speaking) return;
    // Nothing left to say: the chapter line that stood down for all of it may
    // speak now, if it is still the chapter the wearer is on.
    if (speechQueue.length === 0) { scheduleDeferredRelease(); return; }
    const next = speechQueue.shift();
    speak(next.wavBase64, next.text, next.kind, next.timing).then(next.resolve, next.reject);
  }

  async function cancel() {
    if (disposed) return false;
    ++generation;
    // An interrupt can be awaiting its turn before it changes the idle UI.
    if (phase === 'idle') return false;
    ++takeovers; cancelStartup?.(); cancelStartup = undefined; clearTimer();
    dropQueuedSpeech(); stopSpeaking();
    try { await capture.stop(); } catch {}
    context = undefined;
    if (!disposed) notify('idle', 'Voice request cancelled. Tap Talk to try again.');
    return true;
  }

  async function toggle() {
    if (phase === 'idle') return start();
    // The in-headset row reads `Talk` and stays pressable
    // through a chapter, so that press has to do what the row says. `start()`
    // already drops the queue and cuts the narration off.
    //
    // A reply the wearer actually asked for is still allowed to finish: that
    // row reads `Answering…` and refuses the press, and the two have to agree
    // or the menu is lying about one of them. Holding A/X reaches `start()`
    // directly and interrupts either way, as it always has.
    if (phase === 'playing' && speakingKind === 'narration') return start();
    if (phase === 'starting' || phase === 'listening') return stop();
    return false;
  }

  async function release() {
    if (disposed) return;
    ++takeovers; ++generation; cancelStartup?.(); cancelStartup = undefined; clearTimer();
    dropQueuedSpeech(); dropDeferredNarration(); stopSpeaking();
    try { await capture.stop(); } catch {}
    context = undefined;
    await playback.release?.();
    if (!disposed) notify('idle', '');
  }

  async function dispose() {
    if (disposed) return;
    disposed = true; ++takeovers; ++generation; cancelStartup?.(); cancelStartup = undefined; clearTimer();
    dropQueuedSpeech(); dropDeferredNarration(); stopSpeaking();
    try { await capture.stop(); } catch {}
    await playback.close?.().catch?.(() => {});
    listeners.clear(); phase = 'disposed'; message = '';
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Voice interaction subscriber must be a function.');
    listeners.add(listener); return () => listeners.delete(listener);
  }

  // `unlock` is called synchronously by an XR grip before getUserMedia or a
  // network round trip, which satisfies Quest's autoplay gesture policy.
  const voiceSender = Object.freeze({ unlock, start: beginRequest, send: sendAudio });
  return Object.freeze({ start, stop, toggle, cancel, unlock, play, release, dispose, abortPlayback: cancel, subscribe, state: () => phase, message: () => message,
    // What `playing` is playing: `narration` for a tour line the wearer did
    // not ask for, `reply` for an answer to something they did. The in-headset
    // voice row is the microphone's state light, and calling a lesson
    // "Answering…" told the wearer the microphone was busy when it was free.
    playbackKind: () => speakingKind,
    // How many times the wearer has taken the audio channel, for a caller that
    // wants to know whether a line it asked the Mac for was overtaken by a
    // press. `speakNarration` does not ask, because the only answer this can
    // give is "drop it" — see `deferNarration`.
    takeoverGeneration: () => takeovers,
    // Whether a chapter line is waiting for the speaker right now. Diagnostic
    // only: nothing decides anything from it, and it is how the tests tell a
    // line that is being held from one that was dropped.
    deferredNarrationPending: () => Boolean(deferredNarration),
    voiceSender, begin: beginRequest, send: sendAudio,
    listening: () => phase === 'listening' || phase === 'starting' });
}
