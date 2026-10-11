import { describe, it, expect } from 'vitest';
import { createHeadsetCaptionQueue, estimateHeadsetSpeechSeconds, headsetSpeechLine, headsetSpeechWords,
  normalizeHeadsetCaption, sayToHeadsetSchema, splitHeadsetSpeech,
  HEADSET_CAPTION_DEFAULT_HOLD_SECONDS, HEADSET_CAPTION_MAX_CHARS, HEADSET_REPLY_MAX_CHARS,
  HEADSET_REPLY_MAX_WORDS, HEADSET_SPEECH_MAX_CHARS, HEADSET_SPEECH_MAX_WORDS } from '../src/headset-captions.js';

describe('the reply a headset wearer is given', () => {
  it('accepts one short line and refuses text that carries nothing readable', () => {
    expect(sayToHeadsetSchema.parse({ text: 'The lattice is thirteen protofilaments wide.' }).text)
      .toBe('The lattice is thirteen protofilaments wide.');
    expect(sayToHeadsetSchema.parse({ text: 'Done.', speak: false, holdSeconds: 12 }))
      .toEqual({ text: 'Done.', speak: false, holdSeconds: 12 });
    expect(() => sayToHeadsetSchema.parse({ text: '' })).toThrow();
    expect(() => sayToHeadsetSchema.parse({ text: '   ' })).toThrow();
    // A paragraph is what an explanation takes, so the old 280-character
    // ceiling is no longer a refusal; the whole-reply bound is.
    expect(sayToHeadsetSchema.parse({ text: 'a'.repeat(HEADSET_CAPTION_MAX_CHARS + 1) }).text.length)
      .toBe(HEADSET_CAPTION_MAX_CHARS + 1);
    expect(() => sayToHeadsetSchema.parse({ text: 'a'.repeat(HEADSET_REPLY_MAX_CHARS + 1) })).toThrow();
    expect(() => sayToHeadsetSchema.parse({ text: 'ok', holdSeconds: 1 })).toThrow();
    expect(() => sayToHeadsetSchema.parse({ text: 'ok', holdSeconds: 16 })).toThrow();
    expect(() => sayToHeadsetSchema.parse({ text: 'ok', sessionId: 'x' } as any)).toThrow();
  });

  it('flattens a caption to one printable line', () => {
    expect(normalizeHeadsetCaption('  two\nlines\tand   spaces ')).toBe('two lines and spaces');
    expect(normalizeHeadsetCaption('bell\u0007here')).toBe('bell here');
    expect(normalizeHeadsetCaption(undefined)).toBe('');
  });

  it('speaks a complete two or three sentence short reply', () => {
    for (const text of ['Probe complete. Thank you.', 'I selected the other copy. It is blue now. You can inspect it.'])
      expect(headsetSpeechLine(text)).toEqual({text,truncated:false});
  });

  it('bounds speech by 36 complete words and 240 characters without splitting a word', () => {
    const full=Array.from({length:40},()=> 'word').join(' ');
    expect(headsetSpeechLine(full)).toEqual({text:Array.from({length:36},()=> 'word').join(' '),truncated:true});
    expect(headsetSpeechLine('a'.repeat(239)+' b')).toEqual({text:'a'.repeat(239),truncated:true});
    expect(headsetSpeechLine('a'.repeat(241))).toEqual({text:'',truncated:true});
    expect(headsetSpeechLine('Ready…')).toEqual({text:'Ready',truncated:true});
  });

  it('carries the clip the Mac rendered, and drops it from a reply meant to stay silent', () => {
    const queue = createHeadsetCaptionQueue({ now: () => 1_000 });
    const audio = { base64: 'T2dnUw==', mimeType: 'audio/ogg; codecs=opus', format: 'ogg-opus', bytes: 4, voice: 'Samantha' };
    expect(queue.claim('companion')).toBeUndefined();
    queue.say({ text: 'Thirteen protofilaments.' }, { audio });
    expect(queue.claim('companion')?.audio).toEqual(audio);
    // speak:false is the agent asking for a caption only, so a clip rendered
    // before that flag was read is never sent.
    queue.say({ text: 'Rendered.', speak: false }, { audio });
    const quiet = queue.claim('companion');
    expect(quiet?.speak).toBe(false);
    expect(quiet?.audio).toBeUndefined();
    // A host that cannot render one sends the caption exactly as before.
    queue.say({ text: 'No sound here.' });
    expect(queue.claim('companion')).not.toHaveProperty('audio');
  });

  it('gives each connected page one copy and never the same one twice', () => {
    const queue = createHeadsetCaptionQueue({ now: () => 1_000 });
    // Both pages have to be seen before a reply exists, the way a page that
    // has been polling for a while has been seen.
    expect(queue.claim('a')).toBeUndefined();
    expect(queue.claim('b')).toBeUndefined();
    const caption = queue.say({ text: 'Thirteen protofilaments.' });
    expect(caption.speak).toBe(true);
    expect(caption.holdSeconds).toBe(HEADSET_CAPTION_DEFAULT_HOLD_SECONDS);
    expect(caption).toMatchObject({speechText: 'Thirteen protofilaments.', truncated: false});
    expect(queue.claim('a')?.text).toBe('Thirteen protofilaments.');
    expect(queue.claim('a')).toBeUndefined();
    expect(queue.claim('b')?.id).toBe(caption.id);
    expect(queue.deliveries(caption.id)).toBe(2);
  });

  it('does not replay an answer into a page that connected after it', () => {
    const queue = createHeadsetCaptionQueue({ now: () => 1_000 });
    queue.say({ text: 'An answer nobody was waiting for.' });
    expect(queue.claim('late')).toBeUndefined();
    const next = queue.say({ text: 'The answer that page is waiting for.' });
    expect(queue.claim('late')?.id).toBe(next.id);
  });

  it('hands over queued answers in the order they were given', () => {
    const queue = createHeadsetCaptionQueue({ now: () => 1_000 });
    queue.claim('page');
    queue.say({ text: 'First.' });
    queue.say({ text: 'Second.' });
    expect(queue.claim('page')?.text).toBe('First.');
    expect(queue.claim('page')?.text).toBe('Second.');
    expect(queue.claim('page')).toBeUndefined();
  });

  it('drops the oldest answer rather than growing, and forgets stale ones', () => {
    let clock = 1_000;
    const queue = createHeadsetCaptionQueue({ now: () => clock, ttlMs: 5_000, maxPending: 3 });
    queue.claim('page');
    for (const text of ['one', 'two', 'three', 'four']) queue.say({ text });
    expect(queue.size()).toBe(3);
    expect(queue.claim('page')?.text).toBe('two');
    clock += 6_000;
    expect(queue.size()).toBe(0);
    expect(queue.claim('page')).toBeUndefined();
  });

  it('bounds how many pages it remembers', () => {
    const queue = createHeadsetCaptionQueue({ now: () => 1_000, maxPanels: 4 });
    for (let index = 0; index < 40; index++) queue.claim(`panel-${index}`);
    expect(queue.panels()).toBe(4);
  });

  it('reports delivery as soon as a page takes the answer, and gives up at the deadline', async () => {
    const queue = createHeadsetCaptionQueue({ now: () => 1_000 });
    queue.claim('page');
    const caption = queue.say({ text: 'Rendered.' });
    const waiting = queue.waitForDelivery(caption.id, 2_000);
    setTimeout(() => queue.claim('page'), 5);
    expect(await waiting).toBe(true);
    // A delivery already recorded answers without waiting at all.
    expect(await queue.waitForDelivery(caption.id, 0)).toBe(true);

    const lonely = queue.say({ text: 'Nobody is listening.' });
    const started = Date.now();
    expect(await queue.waitForDelivery(lonely.id, 30)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it('refuses an unbounded lifetime or capacity', () => {
    expect(() => createHeadsetCaptionQueue({ ttlMs: 0 })).toThrow(TypeError);
    expect(() => createHeadsetCaptionQueue({ maxPending: 0 })).toThrow(TypeError);
    expect(() => createHeadsetCaptionQueue({ maxPanels: 0 })).toThrow(TypeError);
    expect(() => createHeadsetCaptionQueue({ now: 5 as any })).toThrow(TypeError);
  });
});

it('keeps exact voice loop IDs on the delivered caption',()=>{
  const queue=createHeadsetCaptionQueue();queue.claim('panel');
  const input=sayToHeadsetSchema.parse({text:'Done.',commandId:'c1',utteranceId:'u1'});
  queue.say(input);
  expect(queue.claim('panel', { activeUtteranceId: 'u1' })).toMatchObject({commandId:'c1',utteranceId:'u1'});
});

it('skips a stale bound caption at claim time and still delivers an unbound reply', () => {
  const queue = createHeadsetCaptionQueue();
  queue.claim('panel');
  const stale = queue.say({ text: 'Answer A.', utteranceId: 'A' });
  const unbound = queue.say({ text: 'Unbound.' });
  const rejected: unknown[] = [];
  expect(queue.claim('panel', { activeUtteranceId: 'B', onStale: receipt => rejected.push(receipt) })?.id).toBe(unbound.id);
  expect(queue.deliveries(stale.id)).toBe(0);
  expect(rejected).toEqual([{ captionId: stale.id, utteranceId: 'A', activeUtteranceId: 'B', stale: true }]);
  expect(queue.claim('panel', { activeUtteranceId: 'A' })).toBeUndefined();
});

it('checks bindings per panel and refuses a bound caption when no utterance is active', () => {
  const queue = createHeadsetCaptionQueue();
  for (const panel of ['a', 'b', 'none']) queue.claim(panel);
  const caption = queue.say({ text: 'Answer A.', utteranceId: 'A' });
  expect(queue.claim('b', { activeUtteranceId: 'B' })).toBeUndefined();
  expect(queue.claim('none')).toBeUndefined();
  expect(queue.claim('a', { activeUtteranceId: 'A' })?.id).toBe(caption.id);
  expect(queue.deliveries(caption.id)).toBe(1);
});


describe('a reply longer than one segment', () => {
  const sentence = (words: number, word = 'lattice') => Array.from({ length: words }, () => word).join(' ') + '.';

  it('splits at sentence boundaries and packs whole sentences into each segment', () => {
    // Three sentences that together pass the per-segment character ceiling.
    const first = sentence(20), second = sentence(20), third = sentence(20);
    const segments = splitHeadsetSpeech([first, second, third].join(' '));
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(HEADSET_SPEECH_MAX_CHARS);
      expect(segment.split(' ').length).toBeLessThanOrEqual(HEADSET_SPEECH_MAX_WORDS);
      // Packing keeps sentences whole, so every segment ends one.
      expect(segment.endsWith('.')).toBe(true);
    }
    expect(segments.join(' ')).toBe([first, second, third].join(' '));
  });

  it('keeps a reply that fits one segment as exactly one', () => {
    expect(splitHeadsetSpeech('Thirteen protofilaments. EB3 marks the seam.'))
      .toEqual(['Thirteen protofilaments. EB3 marks the seam.']);
    expect(splitHeadsetSpeech('   ')).toEqual([]);
    expect(splitHeadsetSpeech(undefined)).toEqual([]);
  });

  it('bounds each segment by both limits and never splits a word', () => {
    const forty = Array.from({ length: 40 }, () => 'word').join(' ');
    expect(splitHeadsetSpeech(forty)).toEqual([
      Array.from({ length: HEADSET_SPEECH_MAX_WORDS }, () => 'word').join(' '),
      Array.from({ length: 40 - HEADSET_SPEECH_MAX_WORDS }, () => 'word').join(' '),
    ]);
    // 120 four-letter words is 599 characters in one sentence, so the
    // character ceiling cuts it before the word ceiling does.
    const long = splitHeadsetSpeech(Array.from({ length: 120 }, () => 'aaaa').join(' '));
    for (const segment of long) {
      expect(segment.length).toBeLessThanOrEqual(HEADSET_SPEECH_MAX_CHARS);
      expect(segment.startsWith(' ')).toBe(false);
      expect(segment.endsWith(' ')).toBe(false);
    }
    expect(long.join(' ').split(' ')).toHaveLength(120);
  });

  it('cuts at a clause when a sentence has no full stop to cut at', () => {
    const clause = Array.from({ length: 20 }, () => 'residue').join(' ');
    const segments = splitHeadsetSpeech(`${clause}, ${clause}, ${clause}`);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]!.endsWith(',')).toBe(true);
  });

  it('cuts a single token no boundary can help with, rather than dropping the rest', () => {
    const token = 'a'.repeat(HEADSET_SPEECH_MAX_CHARS + 41);
    expect(splitHeadsetSpeech(token)).toEqual(['a'.repeat(HEADSET_SPEECH_MAX_CHARS), 'a'.repeat(41)]);
  });

  it('refuses a reply past the whole-reply bound with a message that names it', () => {
    const chars = () => sayToHeadsetSchema.parse({ text: 'a'.repeat(HEADSET_REPLY_MAX_CHARS + 1) });
    expect(chars).toThrow(String(HEADSET_REPLY_MAX_CHARS));
    const words = () => sayToHeadsetSchema.parse({ text: Array.from({ length: HEADSET_REPLY_MAX_WORDS + 1 }, () => 'a').join(' ') });
    expect(words).toThrow(String(HEADSET_REPLY_MAX_WORDS));
    // At the bound it is accepted, so the refusal is the bound and not a
    // margin below it.
    expect(sayToHeadsetSchema.parse({ text: 'a'.repeat(HEADSET_REPLY_MAX_CHARS) }).text.length).toBe(HEADSET_REPLY_MAX_CHARS);
    expect(headsetSpeechWords('one two three')).toBe(3);
    expect(headsetSpeechWords('   ')).toBe(0);
  });

  it('needs no segment ceiling of its own: the character and word bounds cap it', () => {
    // The shape that wastes the most segments is a one-word sentence in front
    // of a full one. Even at the character bound that comes to ten, so a
    // separate segment refusal would be one that could never fire.
    const pair = `A. ${'x'.repeat(HEADSET_SPEECH_MAX_CHARS - 2)}.`;
    const text = Array.from({ length: 5 }, () => pair).join(' ').slice(0, HEADSET_REPLY_MAX_CHARS);
    expect(splitHeadsetSpeech(text).length).toBeLessThanOrEqual(12);
    const wordy = Array.from({ length: HEADSET_REPLY_MAX_WORDS / 2 }, () => 'A. word').join(' ');
    expect(headsetSpeechWords(wordy)).toBeLessThanOrEqual(HEADSET_REPLY_MAX_WORDS);
    expect(splitHeadsetSpeech(wordy).length).toBeLessThanOrEqual(12);
  });

  it('estimates how long a segment takes to say', () => {
    expect(estimateHeadsetSpeechSeconds('')).toBe(0);
    // Three words at 180 words a minute is one second.
    expect(estimateHeadsetSpeechSeconds('one two three')).toBe(1);
    expect(estimateHeadsetSpeechSeconds(Array.from({ length: 200 }, () => 'word').join(' '))).toBe(15);
  });

  it('carries the segments in order, and the first clip where a page that predates them looks', () => {
    const queue = createHeadsetCaptionQueue({ now: () => 1_000 });
    const clip = (name: string) => ({ base64: 'T2dnUw==', mimeType: 'audio/ogg', format: 'ogg-opus', bytes: 4, voice: name });
    queue.claim('companion');
    const caption = queue.say({ text: 'First part. Second part.' }, {
      segments: [
        { index: 0, text: 'First part.', audio: clip('a'), seconds: 2 },
        { index: 1, text: 'Second part.', audio: clip('b'), seconds: 3 },
      ],
    });
    expect(caption.segmentCount).toBe(2);
    expect(caption.segments?.map(segment => segment.text)).toEqual(['First part.', 'Second part.']);
    expect(caption.audio).toEqual(clip('a'));
    expect(caption.speechText).toBe('First part. Second part.');
    expect(caption.truncated).toBe(false);
    expect(queue.claim('companion')?.segments).toHaveLength(2);

    // A reply meant to stay silent carries no segments and no sound, however
    // they were produced.
    const quiet = queue.say({ text: 'Rendered.', speak: false }, {
      segments: [{ index: 0, text: 'Rendered.', audio: clip('a'), seconds: 1 }] });
    expect(quiet.segments).toBeUndefined();
    expect(quiet.audio).toBeUndefined();
  });

  it('reports the tail a newer reply cuts off, and nothing when one had already finished', () => {
    let clock = 1_000;
    const queue = createHeadsetCaptionQueue({ now: () => clock });
    const segments = [0, 1, 2, 3].map(index => ({ index, text: `Part ${index}.`, seconds: 5 }));
    queue.claim('companion');
    const first = queue.say({ text: 'Part 0. Part 1. Part 2. Part 3.' }, { segments });
    // Nothing is running until a page takes it.
    expect(queue.interrupted()).toBeUndefined();
    expect(queue.claim('companion')?.id).toBe(first.id);
    // Six seconds in, the second of four segments is sounding.
    clock += 6_000;
    expect(queue.interrupted()).toEqual({ captionId: first.id, segments: 4, playedSegments: 2,
      droppedSegments: 2, playedSeconds: 6, totalSeconds: 20 });
    // Past its whole length there is nothing left to drop.
    clock += 20_000;
    expect(queue.interrupted()).toBeUndefined();
  });

  it('reports no interruption for a single-segment reply that is still sounding', () => {
    let clock = 1_000;
    const queue = createHeadsetCaptionQueue({ now: () => clock });
    queue.claim('companion');
    queue.say({ text: 'Thirteen protofilaments.' });
    queue.claim('companion');
    clock += 100;
    expect(queue.interrupted()).toBeUndefined();
  });
});

it('refusal captions stay on their session, source, target panel and latest request', () => {
  const queue=createHeadsetCaptionQueue();
  const scope={sessionId:'session',sourceToken:'source',panelId:'wearer',serial:1};
  const binding={sessionId:'session',sourceToken:'source',refusalSerial:1};
  for (const id of ['wearer','other-panel','other-session','other-source','newer-request','old-utterance']) queue.claim(id);
  queue.say({text:'Could not load · insecure address.',speak:false},{refusalScope:scope});
  expect(queue.claim('other-panel',binding)).toBeUndefined();
  expect(queue.claim('wearer',binding)?.text).toBe('Could not load · insecure address.');
  const {panelId,...shared}=scope;
  queue.say({text:'Could not apply.',speak:false},{refusalScope:shared});
  expect(queue.claim('other-session',{...binding,sessionId:'elsewhere'})).toBeUndefined();
  expect(queue.claim('other-source',{...binding,sourceToken:'replacement'})).toBeUndefined();
  expect(queue.claim('newer-request',{...binding,refusalSerial:2})).toBeUndefined();
  queue.say({text:'Refused the old request.',utteranceId:'old',speak:false},{refusalScope:shared});
  queue.claim('old-utterance',{...binding,activeUtteranceId:'new'});
  expect(queue.claim('old-utterance',{...binding,activeUtteranceId:'new'})).toBeUndefined();
});

/**
 * The field that says a reply is a refusal raised before dispatch.
 *
 * A wearer who asked the conversational loop for an insecure URL saw nothing
 * at all, because the request never became a tool call and only a tool call
 * had a refusal path.
 */
describe('a refusal reported by the caller', () => {
  it('names the tool it refused, and optionally the session that scopes the card', () => {
    expect(sayToHeadsetSchema.parse({ text: 'Insecure URLs are refused.',
      refusal: { tool: 'replace_inspection_source', sessionId: '11111111-1111-4111-8111-111111111111' } }).refusal)
      .toEqual({ tool: 'replace_inspection_source', sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(sayToHeadsetSchema.parse({ text: 'That paste is too large.', refusal: { tool: 'inspect_file' } }).refusal)
      .toEqual({ tool: 'inspect_file' });
    expect(sayToHeadsetSchema.parse({ text: 'An ordinary answer.' }).refusal).toBeUndefined();
  });

  it('refuses a malformed tool name, a non-uuid session and any field it was not given', () => {
    for (const refusal of [{ tool: '' }, { tool: 'Replace_Inspection_Source' }, { tool: 'a'.repeat(65) },
      { tool: 'replace_inspection_source', sessionId: 'not-a-uuid' },
      { tool: 'replace_inspection_source', panelId: '11111111-1111-4111-8111-111111111111' }]) {
      expect(sayToHeadsetSchema.safeParse({ text: 'Refused.', refusal }).success, JSON.stringify(refusal)).toBe(false);
    }
  });

  it('carries no refusal scope of its own into the queue, which the host still supplies', () => {
    const queue = createHeadsetCaptionQueue();
    queue.claim('wearer');
    const caption = queue.say(sayToHeadsetSchema.parse({ text: 'Could not load · insecure address.', speak: false,
      refusal: { tool: 'replace_inspection_source' } }));
    expect(caption.refusalScope).toBeUndefined();
    expect(queue.claim('wearer')?.text).toBe('Could not load · insecure address.');
  });
  /**
   * A reply is queued before its speech exists, so the
   * queue has to be able to hang clips on a caption nobody has taken, take
   * back one a newer turn superseded, and name the card still on the plate.
   */
  it('hangs late speech on a caption no page has taken, and sends it separately once one has', () => {
    const clip = { base64: 'T2dnUw==', mimeType: 'audio/ogg; codecs=opus', format: 'ogg-opus', bytes: 4, seconds: 7.7 };
    const queue = createHeadsetCaptionQueue();
    queue.claim('wearer');
    const silent = queue.say(sayToHeadsetSchema.parse({ text: 'Turn your head.' }),
      { segments: [{ index: 0, text: 'Turn your head.', seconds: 1 }] });
    expect(silent.audio).toBeUndefined();
    expect(queue.attachSpeech(silent.id, [{ index: 0, text: 'Turn your head.', audio: clip, seconds: 7.7 }])).toBe(true);
    const drawn = queue.claim('wearer');
    expect(drawn?.audio).toEqual(clip);
    expect(drawn?.segments?.[0]?.seconds).toBe(7.7);
    // The page has it now, so a second clip cannot join it.
    expect(queue.attachSpeech(silent.id, [{ index: 0, text: 'Turn your head.', audio: clip }])).toBe(false);
    const voice = queue.say(sayToHeadsetSchema.parse({ text: 'Turn your head.' }),
      { segments: [{ index: 0, text: 'Turn your head.', audio: clip, seconds: 7.7 }], voiceFor: silent.id });
    expect(queue.claim('wearer')).toMatchObject({ id: voice.id, voiceFor: silent.id });
  });

  it('takes back a superseded caption no page has taken, and refuses one a page has', () => {
    const queue = createHeadsetCaptionQueue();
    queue.claim('wearer');
    const older = queue.say(sayToHeadsetSchema.parse({ text: 'Older answer.' }));
    expect(queue.withdraw(older.id)).toBe(true);
    expect(queue.claim('wearer')).toBeUndefined();
    const read = queue.say(sayToHeadsetSchema.parse({ text: 'Read answer.' }));
    expect(queue.claim('wearer')?.id).toBe(read.id);
    expect(queue.withdraw(read.id)).toBe(false);
  });

  it('names the card still inside its hold and forgets it once the hold runs out', () => {
    let clock = 5_000;
    const queue = createHeadsetCaptionQueue({ now: () => clock });
    queue.claim('wearer');
    expect(queue.retiring()).toBeUndefined();
    const card = queue.say(sayToHeadsetSchema.parse({ text: 'Could not apply.', speak: false, holdSeconds: 6 }),
      { refusal: { tool: 'change_inspection', reason: 'camera ownership' } });
    // A card nobody has taken is not on the plate yet.
    expect(queue.retiring()).toBeUndefined();
    queue.claim('wearer');
    clock += 1_000;
    expect(queue.retiring()).toEqual({ captionId: card.id, kind: 'refusal', holdMs: 6_000, shownMs: 1_000 });
    clock += 5_000;
    expect(queue.retiring()).toBeUndefined();
  });
});
