import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReplySpeech, HEADSET_REPLY_RENDER_CONCURRENCY } from '../src/reply-speech-render.js';
import { createReplyVoiceCache, replyVoiceCacheRoot, REPLY_VOICE_CACHE_DIRECTORY } from '../src/reply-voice-cache.js';
import type { HeadsetCaptionAudio } from '../src/headset-captions.js';

const clip = (voice: string, seconds = 3): HeadsetCaptionAudio =>
  ({ base64: 'T2dnUw==', mimeType: 'audio/ogg; codecs=opus', format: 'ogg-opus', bytes: 4, voice, seconds });

/**
 * A synthesiser whose segments finish when the test says so, and a clock the
 * test moves by hand. "The second segment came back first" is the case that
 * has to be catchable, so the render cannot be allowed to decide its own order.
 */
function gatedSynthesizer() {
  const started: string[] = [];
  const gates = new Map<string, (value: HeadsetCaptionAudio | undefined) => void>();
  const clock = { ms: 1_700_000_000_000 };
  const synthesize = (line: string) => {
    started.push(line);
    return new Promise<HeadsetCaptionAudio | undefined>(resolve => { gates.set(line, resolve); });
  };
  const finish = async (line: string, value: HeadsetCaptionAudio | undefined, advanceMs = 0) => {
    clock.ms += advanceMs;
    gates.get(line)!(value);
    gates.delete(line);
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { started, synthesize, finish, clock, now: () => clock.ms };
}

const LINES = ['First part.', 'Second part.', 'Third part.'];

describe('rendering the segments of one reply', () => {
  it('starts several segments at once instead of waiting for each to come back', async () => {
    const gate = gatedSynthesizer();
    const done = renderReplySpeech({ lines: LINES, synthesize: gate.synthesize, now: gate.now });
    await new Promise(resolve => setTimeout(resolve, 0));
    // The old render had one call open at a time and charged the wearer the
    // whole round trip again for every sentence.
    expect(gate.started).toEqual(LINES);
    expect(HEADSET_REPLY_RENDER_CONCURRENCY).toBe(3);

    const startedAt = gate.clock.ms;
    await gate.finish('First part.', clip('a', 2), 4_600);
    await gate.finish('Second part.', clip('b', 3));
    await gate.finish('Third part.', clip('c', 1), 600);
    const render = await done;
    expect(render.segments.map(segment => segment.index)).toEqual([0, 1, 2]);
    // Three calls overlapping, not three end to end: the whole answer costs
    // the slowest segment rather than the sum of all of them.
    expect(gate.clock.ms - startedAt).toBe(5_200);
    expect(render.firstAudioMs).toBe(4_600);
    expect(render.abandoned).toBe(0);
    expect(render.budgetSpent).toBe(false);
  });

  it('hands over the opening of an answer as soon as it is playable, before the rest exists', async () => {
    const gate = gatedSynthesizer();
    const handed: string[][] = [];
    const done = renderReplySpeech({ lines: LINES, synthesize: gate.synthesize, now: gate.now,
      onReady: segments => handed.push(segments.map(segment => segment.text)) });
    await new Promise(resolve => setTimeout(resolve, 0));

    await gate.finish('First part.', clip('a'), 4_600);
    // The first segment is playable while the other two are still rendering.
    expect(handed).toEqual([['First part.']]);
    await gate.finish('Second part.', clip('b'), 300);
    expect(handed.at(-1)).toEqual(['First part.', 'Second part.']);
    await gate.finish('Third part.', clip('c'), 300);
    const render = await done;
    expect(render.firstAudioMs).toBe(4_600);
    expect(render.segments).toHaveLength(3);
  });

  it('gives nothing to play until the leading segment is settled, whatever order the helper answers in', async () => {
    const gate = gatedSynthesizer();
    const handed: string[][] = [];
    const done = renderReplySpeech({ lines: LINES, synthesize: gate.synthesize, now: gate.now,
      onReady: segments => handed.push(segments.map(segment => segment.text)) });
    await new Promise(resolve => setTimeout(resolve, 0));

    // Segments two and three come back first. A page plays index 0 before
    // index 1, so neither is yet sound the wearer can be handed.
    await gate.finish('Third part.', clip('c'), 3_000);
    await gate.finish('Second part.', clip('b'), 500);
    expect(handed).toEqual([]);
    await gate.finish('First part.', clip('a'), 1_100);
    expect(handed).toEqual([['First part.', 'Second part.', 'Third part.']]);
    const render = await done;
    // Playback order is the order the reply was written in, never the order
    // the helper answered in.
    expect(render.segments.map(segment => segment.text)).toEqual(LINES);
    expect(render.segments.map(segment => segment.index)).toEqual([0, 1, 2]);
    expect(render.firstAudioMs).toBe(4_600);
  });

  it('never returns a segment whose predecessor was abandoned', async () => {
    const gate = gatedSynthesizer();
    let current = true;
    const lines = ['One.', 'Two.', 'Three.', 'Four.', 'Five.'];
    const done = renderReplySpeech({ lines, synthesize: gate.synthesize, now: gate.now,
      concurrency: 2, stillCurrent: () => current });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(gate.started).toEqual(['One.', 'Two.']);

    // A newer reply owns the turn. Whatever is already open finishes; nothing
    // further is started, and the wearer is never handed the tail of an
    // answer without its middle.
    current = false;
    await gate.finish('One.', clip('a'), 4_000);
    await gate.finish('Two.', clip('b'), 200);
    const render = await done;
    expect(gate.started).toEqual(['One.', 'Two.']);
    expect(render.segments.map(segment => segment.text)).toEqual(['One.', 'Two.']);
    expect(render.abandoned).toBe(3);
  });

  it('drops a settled segment that sits behind an abandoned one rather than moving it forward', async () => {
    const gate = gatedSynthesizer();
    let current = true;
    const lines = ['One.', 'Two.', 'Three.'];
    const done = renderReplySpeech({ lines, synthesize: gate.synthesize, now: gate.now,
      concurrency: 3, stillCurrent: () => current });
    await new Promise(resolve => setTimeout(resolve, 0));
    current = false;
    // Every segment was already open when the turn changed, so all three
    // settle; the prefix rule is what keeps the order honest here.
    await gate.finish('Two.', clip('b'), 100);
    await gate.finish('Three.', clip('c'), 100);
    await gate.finish('One.', undefined, 100);
    const render = await done;
    expect(render.segments.map(segment => segment.text)).toEqual(lines);
    expect(render.segments[0]!.audio).toBeUndefined();
    expect(render.firstAudioMs).toBe(300);
  });

  it('keeps a segment the budget ran out on, with its text and an estimate and no clip', async () => {
    const gate = gatedSynthesizer();
    const done = renderReplySpeech({ lines: LINES, synthesize: gate.synthesize, now: gate.now,
      concurrency: 1, budgetMs: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(gate.started).toEqual(['First part.']);
    await gate.finish('First part.', clip('a', 2), 4_000);
    await gate.finish('Second part.', clip('b', 3), 2_000);
    const render = await done;
    // The third was past the budget, so it was never sent to the helper.
    expect(gate.started).toEqual(['First part.', 'Second part.']);
    expect(render.budgetSpent).toBe(true);
    expect(render.segments).toHaveLength(3);
    expect(render.segments[2]).toMatchObject({ index: 2, text: 'Third part.' });
    expect(render.segments[2]!.audio).toBeUndefined();
    expect(render.segments[2]!.seconds).toBeGreaterThan(0);
  });

  it('answers an empty reply without starting anything', async () => {
    const gate = gatedSynthesizer();
    const render = await renderReplySpeech({ lines: [], synthesize: gate.synthesize, now: gate.now });
    expect(render).toEqual({ segments: [], budgetSpent: false, abandoned: 0 });
    expect(gate.started).toEqual([]);
  });

  it('survives a delivery attempt that throws, and still returns the whole answer', async () => {
    const gate = gatedSynthesizer();
    const done = renderReplySpeech({ lines: LINES, synthesize: gate.synthesize, now: gate.now,
      onReady: () => { throw Error('the page went away'); } });
    await new Promise(resolve => setTimeout(resolve, 0));
    await gate.finish('First part.', clip('a'), 4_000);
    await gate.finish('Second part.', clip('b'));
    await gate.finish('Third part.', clip('c'));
    const render = await done;
    expect(render.segments.map(segment => segment.text)).toEqual(LINES);
  });
});

describe('the cache of recently spoken lines', () => {
  const withCacheRoot = async (body: (root: string) => Promise<void>) => {
    const root = join(await mkdtemp(join(tmpdir(), 'stereofold-voice-cache-')), 'reply-voice');
    try { await body(root); } finally { await rm(root, { recursive: true, force: true }); }
  };

  it('lives under the host cache directory and not in any project folder', () => {
    expect(REPLY_VOICE_CACHE_DIRECTORY).toBe('Library/Caches/Stereofold/reply-voice');
    expect(replyVoiceCacheRoot('/home/example')).toBe('/home/example/Library/Caches/Stereofold/reply-voice');
  });

  it('returns the same clip for the same words and voice, and nothing for a different one', async () => {
    await withCacheRoot(async root => {
      const cache = createReplyVoiceCache({ root });
      const key = cache.key(['marin', '1', 'read it', 'Thirteen protofilaments.']);
      expect(await cache.get(key)).toBeUndefined();
      await cache.put(key, clip('marin', 2.4));
      expect(await cache.get(key)).toEqual(clip('marin', 2.4));
      expect(await cache.get(cache.key(['alloy', '1', 'read it', 'Thirteen protofilaments.']))).toBeUndefined();
      expect(await cache.get(cache.key(['marin', '1', 'read it', 'Fourteen protofilaments.']))).toBeUndefined();
    });
  });

  it('names its files after a digest, so the directory listing does not hold the sentence', async () => {
    await withCacheRoot(async root => {
      const cache = createReplyVoiceCache({ root });
      await cache.put(cache.key(['marin', '1', 'read it', 'The wearer asked about the binding pocket.']), clip('marin'));
      const names = await readdir(root);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^[0-9a-f]{64}\.json$/u);
      expect(names[0]).not.toContain('binding');
    });
  });

  it('drops what has expired and keeps the directory under its entry count', async () => {
    await withCacheRoot(async root => {
      const clock = { ms: 1_700_000_000_000 };
      const cache = createReplyVoiceCache({ root, maxEntries: 3, maxAgeMs: 60_000, now: () => clock.ms });
      const keys = ['one', 'two', 'three', 'four'].map(word => cache.key([word]));
      for (const key of keys) { await cache.put(key, clip('marin')); clock.ms += 1_000; }
      // Four entries went in against a ceiling of three, so the oldest is gone
      // and the newest is still there.
      expect(await readdir(root)).toHaveLength(3);
      expect(await cache.get(keys[0]!)).toBeUndefined();
      expect(await cache.get(keys[3]!)).toBeTruthy();

      clock.ms += 86_400_000;
      await cache.put(cache.key(['five']), clip('marin'));
      // Everything written before the cutoff has aged out; only the write that
      // triggered the sweep survives.
      expect(await readdir(root)).toHaveLength(1);
      expect(await cache.get(keys[3]!)).toBeUndefined();
    });
  });

  it('treats an unreadable, oversized or wrong-shaped entry as a miss', async () => {
    await withCacheRoot(async root => {
      const cache = createReplyVoiceCache({ root });
      expect(await cache.get('not-a-digest')).toBeUndefined();
      const key = cache.key(['marin', 'Only https URLs are supported.']);
      await cache.put(key, { ...clip('marin'), base64: '' } as HeadsetCaptionAudio);
      expect(await cache.get(key)).toBeUndefined();
      await cache.put(key, { ...clip('marin'), bytes: 0 } as HeadsetCaptionAudio);
      expect(await cache.get(key)).toBeUndefined();

      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${key}.json`), 'not json at all', { mode: 0o600 });
      expect(await cache.get(key)).toBeUndefined();
      await writeFile(join(root, `${key}.json`), JSON.stringify({ at: Date.now(), clip: { base64: 'T2dnUw==' } }), { mode: 0o600 });
      expect(await cache.get(key)).toBeUndefined();
      // An entry written by a build that predates the recorded write time
      // cannot be aged, so it is a miss rather than a clip that never expires.
      await writeFile(join(root, `${key}.json`), JSON.stringify(clip('marin')), { mode: 0o600 });
      expect(await cache.get(key)).toBeUndefined();
    });
  });

  it('never throws when the cache directory cannot be written', async () => {
    const cache = createReplyVoiceCache({ root: '/dev/null/reply-voice' });
    const key = cache.key(['marin', 'A reply the disk refused.']);
    await expect(cache.put(key, clip('marin'))).resolves.toBeUndefined();
    expect(await cache.get(key)).toBeUndefined();
  });
});
