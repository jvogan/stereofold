import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
// @ts-ignore Shared browser module is bundled by the roundtrip build.
import { createVoiceInteraction, VOICE_STARTUP_TIMEOUT_MS } from '../../lab/browser-roundtrip/voice-interaction.mjs';
// @ts-ignore Shared browser module is bundled by the roundtrip build.
import { createVoicePlayback } from '../../lab/browser-roundtrip/voice-playback.mjs';

/** Let every pending microtask chain run out before asserting on the speaker. */
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

function fakes() {
  const capture = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => ({ pcm16leBase64: 'AAAA', sampleRate: 24_000, durationMs: 180 })),
  };
  const playback = { unlock: vi.fn(async () => undefined), play: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  return { capture, playback };
}

describe('browser voice interaction', () => {
  it('unlocks playback before microphone startup so a gesture can authorize both', async () => {
    const order: string[] = [];
    const capture = { start: vi.fn(async () => { order.push('capture'); }), stop: vi.fn(async () => undefined) };
    const playback = { unlock: vi.fn(async () => { order.push('unlock'); }), play: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const interaction = createVoiceInteraction({ capture, playback, send: async () => undefined });
    await interaction.start();
    expect(order).toEqual(['unlock', 'capture']);
    await interaction.cancel();
  });

  it('unlocks reply audio without opening the microphone', async () => {
    const { capture, playback } = fakes();
    const interaction = createVoiceInteraction({ capture, playback });
    await interaction.unlock();
    expect(playback.unlock).toHaveBeenCalledOnce();
    expect(capture.start).not.toHaveBeenCalled();
  });

  it('resumes the gesture-unlocked audio context before delayed playback', async () => {
    const contexts: any[] = [];
    class FakeAudioContext {
      state = 'suspended'; destination = {};
      constructor() { contexts.push(this); }
      async resume() { this.state = 'running'; }
      async decodeAudioData() { return {}; }
      createBufferSource() {
        const source: any = { connect: vi.fn(), start: vi.fn(() => queueMicrotask(() => source.onended?.())), stop: vi.fn() };
        return source;
      }
      async close() { this.state = 'closed'; }
    }
    const playback = createVoicePlayback({ AudioContextClass: FakeAudioContext as any });
    await playback.unlock();
    await playback.play('AAAA');
    expect(contexts).toHaveLength(1);
    expect(contexts[0].state).toBe('running');
    await playback.close();
    expect(contexts[0].state).toBe('closed');
  });

  it('bounds a suspended audio resume and releases it on cancellation', async () => {
    class HangingAudioContext {
      state = 'suspended'; destination = {};
      resume() { return new Promise(() => {}); }
      async close() { this.state = 'closed'; }
    }
    const timedOut = createVoicePlayback({ AudioContextClass: HangingAudioContext as any });
    await expect(timedOut.play('AAAA', { timeoutMs: 20 })).rejects.toThrow('timed out');
    await timedOut.close();

    const cancelled = createVoicePlayback({ AudioContextClass: HangingAudioContext as any });
    const controller = new AbortController();
    const pending = cancelled.play('AAAA', { signal: controller.signal, timeoutMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await cancelled.close();
  });

  it('supports tap toggle, gesture unlock, typed send, and audible reply playback', async () => {
    const { capture, playback } = fakes();
    const states: string[] = [];
    const send = vi.fn(async (audio: unknown, context: unknown) => {
      expect(audio).toMatchObject({ sampleRate: 24_000, durationMs: 180 });
      expect(context).toEqual({ requestId: 'voice-1' });
      return { message: 'Next scene queued.', command: 'tour-next', wavBase64: 'AAAA' };
    });
    const interaction = createVoiceInteraction({ capture, playback, begin: async () => ({ requestId: 'voice-1' }), send,
      onState: (state: string) => states.push(state) });

    await interaction.toggle();
    expect(interaction.state()).toBe('listening');
    await interaction.toggle();

    expect(capture.start).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(playback.unlock).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(playback.play).toHaveBeenCalledWith('AAAA', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(interaction.state()).toBe('idle');
    expect(states).toEqual(['starting', 'listening', 'sending', 'playing', 'idle']);
  });

  it('cancels a hold without sending audio and exposes a subscriber', async () => {
    const { capture, playback } = fakes();
    const send = vi.fn();
    const seen: string[] = [];
    const interaction = createVoiceInteraction({ capture, playback, send });
    const unsubscribe = interaction.subscribe((state: string) => seen.push(state));

    await interaction.start();
    expect(interaction.listening()).toBe(true);
    await interaction.cancel();
    unsubscribe();

    expect(send).not.toHaveBeenCalled();
    expect(interaction.state()).toBe('idle');
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(seen).toEqual(['starting', 'listening', 'idle']);
  });

  it('plays a queued host reply and does not toggle a second request while busy', async () => {
    const { capture, playback } = fakes();
    let resolveSend!: (value: { message: string }) => void;
    const send = vi.fn(() => new Promise<{ message: string }>(resolve => { resolveSend = resolve; }));
    const interaction = createVoiceInteraction({ capture, playback, send });

    await interaction.start();
    const submitting = interaction.stop();
    await Promise.resolve();
    expect(interaction.state()).toBe('sending');
    expect(await interaction.toggle()).toBe(false);
    resolveSend({ message: 'Done.' });
    await submitting;
    expect(send).toHaveBeenCalledOnce();

    await interaction.play('AAAA', 'Queued reply');
    expect(playback.play).toHaveBeenCalledWith('AAAA', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(interaction.state()).toBe('idle');
  });

  it('aborts an in-flight reply when its source or XR owner cancels the interaction', async () => {
    const { capture, playback } = fakes();
    let signal: AbortSignal | undefined;
    (playback.play as any).mockImplementation((_wav: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' })), { once: true });
    }));
    const interaction = createVoiceInteraction({ capture, playback });
    const playing = interaction.play('AAAA');
    await Promise.resolve();
    await interaction.cancel();
    await expect(playing).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
  });

  it('does not submit after a start/release race', async () => {
    const { capture, playback } = fakes();
    let releaseStart!: () => void;
    capture.start.mockImplementationOnce(() => new Promise<undefined>(resolve => { releaseStart = () => resolve(undefined); }));
    const send = vi.fn();
    const interaction = createVoiceInteraction({ capture, playback, send });
    const starting = interaction.start();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = interaction.stop();
    releaseStart();
    await Promise.all([starting, stopping]);

    expect(send).not.toHaveBeenCalled();
    expect(interaction.state()).toBe('idle');
  });

  it('cancels microphone startup during a pending audio unlock without entering listening', async () => {
    const { capture } = fakes();
    let resolveUnlock!: () => void;
    let resolveCapture!: () => void;
    capture.start.mockImplementationOnce(() => new Promise<undefined>(resolve => { resolveCapture = () => resolve(undefined); }));
    const playback = { unlock: vi.fn(() => new Promise<void>(resolve => { resolveUnlock = resolve; })), play: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const begin = vi.fn(async () => ({ requestId: 'late' }));
    const interaction = createVoiceInteraction({ capture, playback, begin });
    const starting = interaction.start();
    await Promise.resolve();
    await interaction.cancel();
    resolveUnlock();
    resolveCapture();
    await expect(starting).resolves.toBe(false);
    expect(capture.start).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(begin).not.toHaveBeenCalled();
    expect(interaction.state()).toBe('idle');
  });

  it('lets a new microphone press interrupt pending reply playback', async () => {
    const { capture } = fakes();
    const playback = {
      unlock: vi.fn(async () => {}),
      play: vi.fn((_wav: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(Error('cancelled'), { name: 'AbortError' })), { once: true });
      })),
      close: vi.fn(async () => {}),
    };
    const interaction = createVoiceInteraction({ capture, playback });
    const reply = interaction.play('AAAA');
    await Promise.resolve();
    await expect(interaction.start()).resolves.toBe(true);
    await expect(reply).rejects.toMatchObject({ name: 'AbortError' });
    expect(capture.start).toHaveBeenCalledOnce();
    await interaction.cancel();
  });

  // A tour chapter's narration and a command acknowledgement both reach
  // `play()`, from two callers that do not know about each other. Before the
  // queue they entered `playback.play` at the same time and the wearer heard
  // two voices at once.
  function concurrencyProbe() {
    const state = { open: 0, peak: 0, started: [] as string[], release: [] as (() => void)[] };
    const play = vi.fn((wav: string, { signal }: { signal: AbortSignal }) => {
      state.open += 1; state.peak = Math.max(state.peak, state.open); state.started.push(wav);
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { state.open -= 1; if (error) reject(error); else resolve(); };
        state.release.push(() => finish());
        signal.addEventListener('abort', () => finish(Object.assign(Error('cancelled'), { name: 'AbortError' })), { once: true });
      });
    });
    return { state, playback: { unlock: vi.fn(async () => {}), play, close: vi.fn(async () => {}) } };
  }

  it('never plays two spoken lines at once', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const narration = interaction.play('TOUR', 'Chapter one.');
    const acknowledgement = interaction.play('ACK', 'Spinning.');
    await Promise.resolve(); await Promise.resolve();
    // The second line waited instead of doubling up.
    expect(state.peak).toBe(1);
    expect(state.started).toEqual(['TOUR']);
    state.release.shift()!();
    await expect(narration).resolves.toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(state.started).toEqual(['TOUR', 'ACK']);
    state.release.shift()!();
    await expect(acknowledgement).resolves.toBe(true);
    expect(state.peak).toBe(1);
  });

  it('lets an interruption cancel what is speaking and drop what is waiting', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    // Both lines here are chapter lines. An answer the wearer
    // asked for is not something a chapter may cut off or drop — the two tests
    // below own that case — so the queue this one drops is a lesson's own.
    const speaking = interaction.play('OLD', 'Old chapter.', { kind: 'narration' });
    const waiting = interaction.play('ACK', 'Old chapter, continued.', { kind: 'narration' });
    await settle();
    const chapter = interaction.play('NEW', 'Chapter two.', { interrupt: true, kind: 'narration' });
    await expect(speaking).rejects.toMatchObject({ name: 'AbortError' });
    // A line that never started is dropped, not spoken late and not a failure.
    await expect(waiting).resolves.toBe(false);
    await settle();
    expect(state.started).toEqual(['OLD', 'NEW']);
    expect(state.peak).toBe(1);
    expect(interaction.playbackKind()).toBe('narration');
    state.release.pop()!();
    await expect(chapter).resolves.toBe(true);
    expect(interaction.playbackKind()).toBeUndefined();
  });

  it('drops queued lines when the wearer takes the microphone or cancels', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const speaking = interaction.play('OLD', 'Old chapter.');
    const waiting = interaction.play('ACK', 'Spinning.');
    await Promise.resolve(); await Promise.resolve();
    await expect(interaction.start()).resolves.toBe(true);
    await expect(speaking).rejects.toMatchObject({ name: 'AbortError' });
    await expect(waiting).resolves.toBe(false);
    expect(state.started).toEqual(['OLD']);
    await interaction.cancel();
  });

  it('reports narration separately from an answer to the wearer', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const seen: string[] = [];
    const interaction = createVoiceInteraction({ capture, playback,
      onState: (phase: string) => { seen.push(`${phase}:${interaction?.playbackKind?.() ?? '-'}`); } });
    const narration = interaction.play('TOUR', 'Chapter one.', { kind: 'narration' });
    await Promise.resolve();
    expect(interaction.state()).toBe('playing');
    expect(interaction.playbackKind()).toBe('narration');
    state.release.shift()!();
    await expect(narration).resolves.toBe(true);
    expect(interaction.playbackKind()).toBeUndefined();
    const reply = interaction.play('ACK', 'Spinning.');
    await Promise.resolve();
    expect(interaction.playbackKind()).toBe('reply');
    state.release.shift()!();
    await expect(reply).resolves.toBe(true);
    expect(seen.some(entry => entry.startsWith('playing:'))).toBe(true);
  });

  // The menu row reads `Talk` and stays pressable through a chapter, but
  // `toggle()` used to return false while anything was `playing`. The row
  // advertised an interrupt that did nothing, and a wearer using the menu
  // rather than the A/X hold was stuck until the chapter ended.
  it('opens the microphone when the wearer presses Talk during narration', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const narration = interaction.play('TOUR', 'Chapter one.', { kind: 'narration' });
    await Promise.resolve();
    expect(interaction.state()).toBe('playing');
    await expect(interaction.toggle()).resolves.toBe(true);
    expect(capture.start).toHaveBeenCalledOnce();
    await expect(narration).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.peak).toBe(1);
    await interaction.cancel();
  });

  it('lets an answer the wearer asked for finish, as the row that refuses the press says', async () => {
    const { capture } = fakes();
    const { playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    void interaction.play('ACK', 'Spinning.').catch(() => {});
    await Promise.resolve();
    expect(interaction.playbackKind()).toBe('reply');
    await expect(interaction.toggle()).resolves.toBe(false);
    expect(capture.start).not.toHaveBeenCalled();
    await interaction.cancel();
  });

  // The Mac renders a chapter line over HTTP and the page plays it whenever it
  // comes back — which used to be in the middle of the answer the wearer had
  // just asked for. The reply was aborted, an aborted reply is reported as an
  // interruption rather than retried, and the wearer got the chapter they had
  // spoken over instead of their answer.
  it('does not let a late chapter line speak over the answer the wearer asked for', async () => {
    const { state, playback } = concurrencyProbe();
    const capture = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => ({ pcm16leBase64: 'AAAA', sampleRate: 24_000, durationMs: 180 })),
    };
    const seen: { phase: string; message: string }[] = [];
    const interaction = createVoiceInteraction({ capture, playback,
      send: async () => ({ wavBase64: 'REPLY', message: 'Next step.' }),
      onState: (phase: string, message: string) => { seen.push({ phase, message }); } });
    await interaction.start();
    const submitted = interaction.stop();
    await settle();
    expect(state.started).toContain('REPLY');
    // Autoplay reaches the next chapter while the reply is still speaking.
    const chapter = interaction.play('TOUR', 'Chapter two.', { interrupt: true, kind: 'narration' });
    await expect(chapter).resolves.toBe(false);
    expect(state.started).toEqual(['REPLY']);
    expect(interaction.playbackKind()).toBe('reply');
    state.release.shift()!();
    await submitted;
    expect(seen.some(entry => entry.phase === 'error')).toBe(false);
  });

  // Standing the new chapter down for an answer that has not started speaking
  // left the PREVIOUS chapter's audio running over the
  // new chapter's scene, and put the answer behind it. What the protection is
  // for is a reply the wearer is hearing; a queued one is not that.
  it('cuts the previous chapter for the next one and leaves the queued reply in line', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const first = interaction.play('ONE', 'Chapter one.', { kind: 'narration' });
    // Chapter one's scene is gone, so chapter one's audio goes with it. The
    // expectation is attached now because that is when the cut happens.
    const firstCut = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const reply = interaction.play('ACK', 'Spinning.');
    await settle();
    expect(state.started).toEqual(['ONE']);
    // Autoplay opens chapter two while the answer is still waiting its turn.
    const second = interaction.play('TWO', 'Chapter two.', { interrupt: true, kind: 'narration', stale: () => false });
    await settle();
    await firstCut;
    // The wearer's own answer kept its place and speaks now; the new chapter
    // waits for it exactly as it waits for a reply that was already speaking.
    expect(state.started).toEqual(['ONE', 'ACK']);
    expect(interaction.deferredNarrationPending()).toBe(true);
    state.release.pop()!();
    await expect(reply).resolves.toBe(true);
    await settle();
    expect(state.started).toEqual(['ONE', 'ACK', 'TWO']);
    state.release.pop()!();
    await expect(second).resolves.toBe(true);
    expect(state.peak).toBe(1);
  });

  it('still cuts the stale chapter for a new one that cannot be held back', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const first = interaction.play('ONE', 'Chapter one.', { kind: 'narration' });
    const firstCut = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const reply = interaction.play('ACK', 'Spinning.');
    await settle();
    // No `stale` predicate, so this line cannot wait: it is dropped, as before.
    await expect(interaction.play('TWO', 'Chapter two.', { interrupt: true, kind: 'narration' })).resolves.toBe(false);
    await firstCut;
    await settle();
    // What must not happen is chapter one carrying on over chapter two.
    expect(state.started).toEqual(['ONE', 'ACK']);
    state.release.pop()!();
    await expect(reply).resolves.toBe(true);
    expect(state.peak).toBe(1);
  });

  it('leaves a reply that is already speaking alone, and the chapter waits for it', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const reply = interaction.play('ACK', 'Spinning.');
    await settle();
    expect(state.started).toEqual(['ACK']);
    const chapter = interaction.play('TWO', 'Chapter two.', { interrupt: true, kind: 'narration', stale: () => false });
    await settle();
    // Nothing was cut: the wearer is listening to the answer they asked for.
    expect(state.started).toEqual(['ACK']);
    expect(interaction.deferredNarrationPending()).toBe(true);
    state.release.shift()!();
    await expect(reply).resolves.toBe(true);
    await settle();
    expect(state.started).toEqual(['ACK', 'TWO']);
    state.release.pop()!();
    await expect(chapter).resolves.toBe(true);
  });

  // Standing a chapter line down for the wearer's own answer was right;
  // throwing it away was not. Under autoplay nothing ever asks for that line
  // again, so the chapter that was talked over was watched in silence.
  it('speaks the chapter line it stood down for a reply once the reply is over', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const reply = interaction.play('REPLY', 'Reply from your task');
    await settle();
    expect(state.started).toEqual(['REPLY']);
    // Autoplay reaches the next chapter while the agent's reply is speaking.
    const chapter = interaction.play('TOUR', 'Chapter two.', { interrupt: true, kind: 'narration', stale: () => false });
    await settle();
    // Held, not dropped, and never on top of the reply.
    expect(state.started).toEqual(['REPLY']);
    expect(interaction.deferredNarrationPending()).toBe(true);
    state.release.shift()!();
    await expect(reply).resolves.toBe(true);
    await settle();
    expect(state.started).toEqual(['REPLY', 'TOUR']);
    expect(interaction.deferredNarrationPending()).toBe(false);
    state.release.shift()!();
    await expect(chapter).resolves.toBe(true);
    expect(state.peak).toBe(1);
  });

  it('drops the line it was holding when the lesson has moved on', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const reply = interaction.play('REPLY', 'Reply from your task');
    await settle();
    let movedOn = false;
    const chapter = interaction.play('TOUR', 'Chapter two.', { interrupt: true, kind: 'narration', stale: () => movedOn });
    await settle();
    expect(interaction.deferredNarrationPending()).toBe(true);
    // The chapter changed, or the wearer paused the lesson, while it waited.
    movedOn = true;
    state.release.shift()!();
    await expect(reply).resolves.toBe(true);
    await expect(chapter).resolves.toBe(false);
    expect(state.started).toEqual(['REPLY']);
  });

  it('replaces a held chapter line with the newer one rather than saying both', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const reply = interaction.play('REPLY', 'Reply from your task');
    await settle();
    const first = interaction.play('ONE', 'Chapter one.', { interrupt: true, kind: 'narration', stale: () => false });
    const second = interaction.play('TWO', 'Chapter two.', { interrupt: true, kind: 'narration', stale: () => false });
    await settle();
    // The chapter that arrived second is the one on screen.
    await expect(first).resolves.toBe(false);
    state.release.shift()!();
    await expect(reply).resolves.toBe(true);
    await settle();
    expect(state.started).toEqual(['REPLY', 'TWO']);
    state.release.shift()!();
    await expect(second).resolves.toBe(true);
  });

  it('holds a chapter line through a microphone press and speaks it after the press', async () => {
    const { state, playback } = concurrencyProbe();
    const capture = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => ({ pcm16leBase64: 'AAAA', sampleRate: 24_000, durationMs: 180 })),
    };
    const send = vi.fn(async () => ({ message: 'Spinning.' }));
    const interaction = createVoiceInteraction({ capture, playback, send });
    await expect(interaction.start()).resolves.toBe(true);
    const chapter = interaction.play('TOUR', 'Chapter two.', { interrupt: true, kind: 'narration', stale: () => false });
    await settle();
    expect(state.started).toEqual([]);
    expect(interaction.state()).toBe('listening');
    // The press itself is untouched: the release still transcribes and sends.
    await expect(interaction.stop()).resolves.toMatchObject({ message: 'Spinning.' });
    expect(send).toHaveBeenCalledOnce();
    await settle();
    expect(state.started).toEqual(['TOUR']);
    state.release.shift()!();
    await expect(chapter).resolves.toBe(true);
  });

  // The mirror of the gap above: the agent's own sentence arriving while a
  // chapter is speaking. A chapter never cuts a reply off, so the reply has to
  // be waiting behind it when it ends — dropping it would lose the answer, and
  // `receiveSpokenReply` only re-offers a line the queue tells it was dropped.
  it('queues an agent reply behind a chapter line instead of losing it', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const chapter = interaction.play('TOUR', 'Chapter two.', { interrupt: true, kind: 'narration', stale: () => false });
    await settle();
    expect(state.started).toEqual(['TOUR']);
    const reply = interaction.play('REPLY', 'Reply from your task');
    await settle();
    expect(state.started).toEqual(['TOUR']);
    state.release.shift()!();
    await expect(chapter).resolves.toBe(true);
    await settle();
    expect(state.started).toEqual(['TOUR', 'REPLY']);
    state.release.shift()!();
    await expect(reply).resolves.toBe(true);
    expect(state.peak).toBe(1);
  });

  it('lets a line with no way to say whether it is still wanted stand down as before', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    void interaction.play('REPLY', 'Reply from your task').catch(() => {});
    await settle();
    await expect(interaction.play('TOUR', 'Chapter two.', { interrupt: true, kind: 'narration' })).resolves.toBe(false);
    expect(interaction.deferredNarrationPending()).toBe(false);
    expect(state.started).toEqual(['REPLY']);
    await interaction.cancel();
  });

  // `stop()` submits a press only from `starting` or
  // `listening`. A chapter line that reached `notify('playing')` during a press
  // moved the phase out from under the release, and the recorded audio was
  // never transcribed — the press was simply lost.
  it('keeps a chapter line off the speakers while the wearer is holding the microphone', async () => {
    const { state, playback } = concurrencyProbe();
    const capture = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => ({ pcm16leBase64: 'AAAA', sampleRate: 24_000, durationMs: 180 })),
    };
    const send = vi.fn(async () => ({ message: 'Spinning.' }));
    const interaction = createVoiceInteraction({ capture, playback, send });
    await expect(interaction.start()).resolves.toBe(true);
    expect(interaction.state()).toBe('listening');
    // The chapter's own TTS finally comes back, mid-press.
    await expect(interaction.play('TOUR', 'Chapter two.', { interrupt: true, kind: 'narration' })).resolves.toBe(false);
    // An acknowledgement that does not interrupt is refused on the same ground.
    await expect(interaction.play('ACK', 'Spinning.')).resolves.toBe(false);
    expect(state.started).toEqual([]);
    expect(interaction.state()).toBe('listening');
    // The press itself is untouched: the release still transcribes and sends.
    await expect(interaction.stop()).resolves.toMatchObject({ message: 'Spinning.' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('still plays the answer to the press it belongs to, sent while the phase is sending', async () => {
    const { state, playback } = concurrencyProbe();
    const capture = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => ({ pcm16leBase64: 'AAAA', sampleRate: 24_000, durationMs: 180 })),
    };
    const interaction = createVoiceInteraction({ capture, playback,
      send: vi.fn(async () => ({ wavBase64: 'REPLY', message: 'Spinning.' })) });
    await interaction.start();
    const submitted = interaction.stop();
    await settle();
    expect(state.started).toEqual(['REPLY']);
    state.release.shift()!();
    await submitted;
  });

  it('counts a microphone press so a line fetched before it can be dropped after it', async () => {
    const { capture, playback } = fakes();
    const interaction = createVoiceInteraction({ capture, playback });
    const before = interaction.takeoverGeneration();
    await interaction.start();
    expect(interaction.takeoverGeneration()).toBeGreaterThan(before);
    const afterStart = interaction.takeoverGeneration();
    await interaction.cancel();
    expect(interaction.takeoverGeneration()).toBeGreaterThan(afterStart);
    // One chapter replacing another must not read as the wearer taking over,
    // or the chapter that did the replacing would drop itself.
    const stable = interaction.takeoverGeneration();
    void interaction.play('TOUR', 'Chapter two.', { interrupt: true, kind: 'narration' }).catch(() => {});
    await settle();
    expect(interaction.takeoverGeneration()).toBe(stable);
    await interaction.cancel();
  });

  // Two `interrupt: true` calls landing together — rapid
  // Next/Back, or a chapter's audio arriving in the same tick as another
  // interrupt — each cut off what was speaking and each started their own.
  it('serializes two interrupts that arrive together', async () => {
    const { capture } = fakes();
    const { state, playback } = concurrencyProbe();
    const interaction = createVoiceInteraction({ capture, playback });
    const first = interaction.play('ONE', 'Chapter one.', { interrupt: true, kind: 'narration' });
    // Claim the rejection now: the second interrupt cancels this one before the
    // assertion below could attach a handler.
    const firstOutcome = first.then(() => 'played', (error: Error) => error.name);
    const second = interaction.play('TWO', 'Chapter two.', { interrupt: true, kind: 'narration' });
    await settle();
    expect(state.peak).toBe(1);
    expect(state.started).toEqual(['ONE', 'TWO']);
    await expect(firstOutcome).resolves.toBe('AbortError');
    state.release.pop()!();
    await expect(second).resolves.toBe(true);
    expect(state.peak).toBe(1);
  });

  // The same guarantee one level down, for a caller that shares the playback
  // without an abort signal to link the two lines together.
  it('stops the source still playing before it starts another on the same context', async () => {
    const live: { started: number; stopped: number } = { started: 0, stopped: 0 };
    class FakeAudioContext {
      state = 'running'; destination = {};
      async resume() {}
      async decodeAudioData() { return {}; }
      createBufferSource() {
        // A real BufferSource fires `onended` after `stop()` returns, not
        // inside it; firing it synchronously would resolve a line the caller
        // had just cancelled.
        const source: any = { connect: vi.fn(), start: vi.fn(() => { live.started += 1; }),
          stop: vi.fn(() => { live.stopped += 1; queueMicrotask(() => source.onended?.()); }) };
        return source;
      }
      async close() { this.state = 'closed'; }
    }
    const playback = createVoicePlayback({ AudioContextClass: FakeAudioContext as any });
    await playback.unlock();
    const first = playback.play('AAAA');
    const firstOutcome = first.then(() => 'played', (error: Error) => error.name);
    await settle();
    expect(live.started).toBe(1);
    const second = playback.play('BBBB');
    const secondOutcome = second.then(() => 'played', (error: Error) => error.name);
    await settle();
    // The second line owns the speaker, and the first was stopped, not left
    // connected to the same destination underneath it.
    await expect(firstOutcome).resolves.toBe('AbortError');
    expect(live.stopped).toBe(1);
    expect(live.started).toBe(2);
    await playback.close();
    await expect(secondOutcome).resolves.toBe('AbortError');
  });

  it('times out microphone startup separately from reply playback', async () => {
    const { playback } = fakes();
    const capture = { start: vi.fn(() => new Promise<void>(() => {})), stop: vi.fn(async () => undefined) };
    const interaction = createVoiceInteraction({ capture, playback });
    const started = interaction.start().then(() => undefined, (error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, VOICE_STARTUP_TIMEOUT_MS + 10));
    await expect(started).resolves.toMatchObject({ message: 'Microphone startup timed out.' });
    expect(capture.stop).toHaveBeenCalledOnce();
  }, VOICE_STARTUP_TIMEOUT_MS + 1_000);
});

/**
 * The companion page asks the Mac to render every spoken line over HTTP, so
 * what it decided to say and what the wearer is doing
 * when the audio arrives are separated by seconds. These are the rules for that
 * gap, read off the page that has to keep them.
 */
describe('companion narration gate', () => {
  const inspector = () => readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');

  // Two chapters in flight together return in whatever order they
  // finish. The loser arrived with `interrupt: true` and spoke the chapter the
  // wearer had already left over the one they were on.
  it('drops a chapter line whose chapter, or whose wearer, has moved on', async () => {
    const source = await inspector();
    const speak = source.slice(source.indexOf('let narrationGeneration=0;'), source.indexOf('async function receive('));
    expect(speak).toContain('const stamp=++narrationGeneration;');
    expect(speak).toContain('stamp!==narrationGeneration');
    expect(speak).toContain("{kind:'narration',interrupt:true,stale}");
    // The second half of the question used to be
    // `takeoverGeneration` — had the wearer taken the microphone since the line
    // was asked for? That answer could only ever be "drop it", which is what
    // left a chapter unnarrated. The lesson's own memory of the line answers
    // better: a press pauses the tour, and pause forgets the line, so the
    // microphone case is still covered — and a line the lesson still holds is
    // now held back and spoken rather than thrown away.
    expect(speak).toContain('narratingLine');
    expect(speak).not.toContain('takeoverGeneration');
    // A lesson that let go of the scene drops the line; a lesson merely paused
    // between two of its own chapters does not. `receive()` pauses before every
    // remote command, so reading a forgotten line as "moved on" silenced four of
    // nine chapters.
    expect(speak).toContain('lesson.stopped || !lesson.active');
    expect(speak).toContain('held!==undefined && held!==line');
    // The check is made where the audio is, not where the request was: the
    // speaker asks again after the round trip and before anything is played,
    // and hands the same question down so it can be asked once more if the
    // line has to wait for the speaker.
    const speaker = source.slice(source.indexOf('setVoiceCommandSpeaker(createPanelNarrator('), source.indexOf("orb.addEventListener('click'"));
    expect(speaker).toContain('if(speech?.stale?.())');
    expect(speaker.indexOf('speech?.stale?.()')).toBeLessThan(speaker.indexOf('voiceInteraction.play('));
    expect(speaker).toContain("recordHeadsetEvent('speech-dropped'");
    expect(speaker).toContain('stale:speech.stale');
  });

  // "Next scene." used to take its turn behind the chapter the same press had
  // just opened, and was spoken about twenty seconds after the move.
  it('lets the new chapter be its own acknowledgement instead of queueing one behind it', async () => {
    const source = await inspector();
    const receive = source.slice(source.indexOf("if(delivery.change.kind==='tour') {"), source.indexOf('} else await workspace.applyRemote('));
    expect(receive).toContain('const narrationBefore=narrationGeneration;');
    expect(receive).toContain('speakRemoteConfirmation(delivery.change,appliedTour,narrationGeneration!==narrationBefore,delivery)');
    const confirm = source.slice(source.indexOf('function speakRemoteConfirmation('), source.indexOf('function speechWasInterrupted('));
    expect(confirm).toContain("if(narrated) { recordHeadsetEvent('remote-confirmation',{change:change?.kind,say,route:'chapter-line'}); return; }");
    // A command with no chapter line of its own still answers in two words.
    expect(confirm.indexOf('if(narrated)')).toBeGreaterThan(confirm.indexOf('if(!say) return;'));
  });
});


it('keeps correlation through microphone release and queued speech',async()=>{
  const {capture,playback}=fakes();const entries:any[]=[];
  vi.stubGlobal('__stereofoldDiagnostics',{record:(_kind:string,detail:any)=>entries.push(detail)});
  const interaction=createVoiceInteraction({capture,playback,begin:async()=>({utteranceId:'u1'}),
    send:async()=>({message:'Done.',wavBase64:'AAAA'})});
  try {
    await interaction.start();await interaction.stop();
    expect(entries).toContainEqual({stage:'microphone-release',utteranceId:'u1'});
    expect(playback.play).toHaveBeenCalledWith('AAAA',expect.objectContaining({timing:{utteranceId:'u1',text:'Done.'}}));
    // Timing is kept on a line that waits behind another line.
    let release!:()=>void;
    const play=vi.fn().mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;})).mockResolvedValue(undefined);
    const queued=createVoiceInteraction({capture: fakes().capture,playback:{...playback,play}});
    const first=queued.play('AAAA','First.');await settle();
    const second=queued.play('AAAA','Done.',{timing:{commandId:'c1',utteranceId:'u1'}});
    release();await Promise.all([first,second]);
    expect(play.mock.calls[1][1].timing).toEqual({commandId:'c1',utteranceId:'u1',text:'Done.'});
  } finally {vi.unstubAllGlobals();}
});


it('records native audio start only after decode succeeds',async()=>{
  const entries:any[]=[];
  vi.stubGlobal('__stereofoldDiagnostics',{record:(_kind:string,detail:any)=>entries.push(detail)});
  let decode!:(value:unknown)=>void;
  class Audio {
    state='running';destination={};
    decodeAudioData(){return new Promise(resolve=>{decode=resolve;});}
    createBufferSource(){const source:any={connect(){},stop(){},start(){queueMicrotask(()=>source.onended());}};return source;}
    async close(){}
  }
  const playback=createVoicePlayback({AudioContextClass:Audio});
  try {
    const played=playback.play('AAAA',{timing:{commandId:'c1',utteranceId:'u1',text:'Here is TCAB1.'}});
    await settle();expect(entries).toEqual([]);
    decode({});await played;
    expect(entries).toEqual([{stage:'spoken-confirmation-started',commandId:'c1',utteranceId:'u1',spokenText:'Here is TCAB1.',spokenWords:3}]);
  } finally {await playback.close();vi.unstubAllGlobals();}
});

it('releases idle native audio on XR exit and reopens on another gesture', async () => {
  const contexts:any[]=[];
  class Audio {
    state='running';
    constructor() { contexts.push(this); }
    close=vi.fn(async()=>{this.state='closed';});
  }
  const playback=createVoicePlayback({AudioContextClass:Audio});
  const capture={start:vi.fn(async()=>{}),stop:vi.fn(async()=>{})};
  const interaction=createVoiceInteraction({playback,capture});
  await interaction.unlock();
  expect(interaction.state()).toBe('idle');
  await interaction.release?.();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(playback.unlocked()).toBe(false);
  expect(capture.stop).toHaveBeenCalledOnce();
  await interaction.unlock();
  expect(contexts).toHaveLength(2);
  expect(contexts[1].state).toBe('running');
  await interaction.dispose();
});

it.each(['release', 'cancel'] as const)('drops queued speech interrupts across %s and permits a fresh line', async action => {
  const played:string[]=[];
  const playback={unlock:vi.fn(async()=>{}),play:vi.fn(async (clip:string)=>{played.push(clip);}),
    release:vi.fn(async()=>{}),close:vi.fn(async()=>{})};
  const capture={start:vi.fn(async()=>{}),stop:vi.fn(async()=>{})};
  const interaction=createVoiceInteraction({playback,capture});
  try {
    // Both interrupts are waiting for their serialized turn while the UI is
    // still idle. Exit/cancel must invalidate them before either opens audio.
    const first=interaction.play('OLD-ONE','Old one',{interrupt:true});
    const second=interaction.play('OLD-TWO','Old two',{interrupt:true});
    await interaction[action]();
    expect(await Promise.all([first,second])).toEqual([false,false]);
    expect(played).toEqual([]);
    expect(interaction.state()).toBe('idle');
    await expect(interaction.play('FRESH','New request',{interrupt:true})).resolves.toBe(true);
    expect(played).toEqual(['FRESH']);
  } finally { await interaction.dispose(); }
});

it('does not recreate playback when release overtakes preparation', async () => {
  const Audio=vi.fn();
  const playback=createVoicePlayback({AudioContextClass:Audio});
  const playing=playback.play('AAAA');
  const outcome=playing.catch((error:any)=>error);
  await playback.release?.();
  expect(await outcome).toMatchObject({name:'AbortError'});
  expect(Audio).not.toHaveBeenCalled();
  expect(playback.unlocked()).toBe(false);
  await playback.close();
});
