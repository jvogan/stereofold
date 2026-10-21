import { estimateHeadsetSpeechSeconds, HEADSET_REPLY_RENDER_BUDGET_MS,
  type HeadsetCaptionAudio, type HeadsetCaptionSegment } from './headset-captions.js';

/**
 * How a long reply gets rendered, and why the wearer stopped waiting for it.
 *
 * `say_to_headset` used to render its segments one at a time, and hand the
 * whole answer over only once the last one came back. Every segment is a
 * separate round trip to the narration helper, so the wait the wearer sat
 * through was the sum of them: on this Mac three ordinary sentences measured
 * 4.3 s, 4.4 s and 5.2 s, and the first sound arrived 14.2 s after the caption.
 *
 * Almost all of one round trip is fixed cost rather than speech. Measured on
 * this Mac against the shipped `agent-voice` helper, a call costs about 4.0 s
 * before it has produced anything plus about 0.18 s for each second of audio:
 * 0.17 s of Python start-up, 0.09 s importing the auth helper, 0.78 s minting
 * the OAuth client secret, and the rest opening the realtime socket and
 * waiting for the model's first samples. The model then generates faster than
 * real time, which is why a 15 s answer costs 6.9 s and a 4 s answer costs
 * 4.8 s.
 *
 * Fixed cost that large is why these calls are now run together. Three at once
 * measured 4.6 s, 4.9 s and 5.2 s each, against 4.3 s, 4.4 s and 5.2 s alone,
 * so the overlap is close to free and the same three sentences are ready in
 * 5.3 s instead of 14.2 s. Three is the fan-out because each call is a Python
 * process holding its own websocket, and a 200-word reply is at most six
 * segments.
 *
 * A later local pass measured another wait after the opening was encoded:
 * once the page had taken the caption, delivery held that clip until the last
 * segment settled. The caller now sends each ready prefix as a continuation
 * batch. Five fixed two-segment trials went from a 6.14 s median caption-to-
 * playback delay to 3.91 s, with encoding-to-playback for the opening falling
 * from 1.51-2.21 s to 23-58 ms on a 50 ms loopback polling interval. A single
 * segment still pays the helper's setup and socket-close costs.
 *
 * Nothing here changes what is said. The returned segments carry the same text
 * in the same order `splitHeadsetSpeech` produced, whatever order the helper
 * answered in.
 */
export const HEADSET_REPLY_RENDER_CONCURRENCY = 3;

export type ReplySpeechRender = {
  /**
   * A leading run of the reply, in playback order.
   *
   * It is a prefix and never a scattering: a segment whose predecessor was
   * abandoned is dropped rather than moved forward, so the page can play the
   * array straight through and hear the answer in the order it was written.
   */
  segments: HeadsetCaptionSegment[];
  /**
   * When the wearer could first have heard something, in milliseconds from the
   * start of the render, or undefined when no segment carries audio.
   *
   * It is the moment the leading run of settled segments first contained a
   * clip, not the moment any clip finished. A page plays index 0 before index
   * 1, so a second segment that came back early is not yet sound the wearer
   * can be given.
   */
  firstAudioMs?: number;
  /** True when a segment carries no audio because the render budget ran out. */
  budgetSpent: boolean;
  /** Segments never started, because a newer reply took the turn mid-render. */
  abandoned: number;
};

export type ReplySpeechRenderOptions = {
  lines: readonly string[];
  /** Renders one segment, answering undefined rather than throwing. */
  synthesize: (line: string) => Promise<HeadsetCaptionAudio | undefined>;
  budgetMs?: number;
  concurrency?: number;
  /** False once a newer reply owns the turn; no further segment is started. */
  stillCurrent?: () => boolean;
  now?: () => number;
  /**
   * Called each time the leading run of settled segments grows and contains a
   * clip, with that run. It is how the caller can hand the opening of an
   * answer to the caption or a continuation batch, instead of holding every
   * word until the last segment lands.
   */
  onReady?: (segments: readonly HeadsetCaptionSegment[]) => void;
};

/**
 * Render every segment of one reply, several at a time, in playback order.
 *
 * A segment that fails or runs past the budget still comes back, carrying its
 * text and an estimated length and no clip, exactly as the one-at-a-time
 * render left it: a reply the wearer can read beats no reply at all.
 */
export async function renderReplySpeech({
  lines, synthesize,
  budgetMs = HEADSET_REPLY_RENDER_BUDGET_MS,
  concurrency = HEADSET_REPLY_RENDER_CONCURRENCY,
  stillCurrent = () => true,
  now = Date.now,
  onReady,
}: ReplySpeechRenderOptions): Promise<ReplySpeechRender> {
  const total = lines.length;
  if (!total) return { segments: [], budgetSpent: false, abandoned: 0 };
  const startedAt = now();
  const clips = new Array<HeadsetCaptionAudio | undefined>(total);
  const settled = new Array<boolean>(total).fill(false);
  let firstAudioMs: number | undefined;
  let budgetSpent = false;
  let abandoned = 0;
  let ready = 0;
  let next = 0;

  const segmentAt = (index: number): HeadsetCaptionSegment => {
    const clip = clips[index];
    return { index, text: lines[index]!, ...(clip ? { audio: clip } : {}),
      seconds: clip?.seconds ?? estimateHeadsetSpeechSeconds(lines[index]!) };
  };
  const prefix = () => Array.from({ length: ready }, (_unused, index) => segmentAt(index));
  const publish = () => {
    const before = ready;
    while (ready < total && settled[ready]) ready++;
    if (ready === before) return;
    const run = prefix();
    if (!run.some(segment => segment.audio)) return;
    if (firstAudioMs === undefined) firstAudioMs = Math.max(0, Math.round(now() - startedAt));
    // A listener that throws must not cost the wearer the rest of the answer.
    try { onReady?.(run); } catch { /* The caller's delivery attempt is its own problem. */ }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      // A turn the wearer has already moved past stops costing processes here,
      // rather than after every remaining segment has been rendered.
      if (index > 0 && !stillCurrent()) { abandoned += total - index; next = total; return; }
      const overBudget = now() - startedAt >= budgetMs;
      if (overBudget) budgetSpent = true;
      clips[index] = overBudget ? undefined : await synthesize(lines[index]!);
      settled[index] = true;
      publish();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
  // Whatever settled behind an abandoned segment is discarded with it, so the
  // answer the caller ships is always a run the page can play straight through.
  return { segments: prefix(), ...(firstAudioMs === undefined ? {} : { firstAudioMs }),
    budgetSpent, abandoned };
}
