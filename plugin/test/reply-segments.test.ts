import { describe, it, expect } from 'vitest';
// @ts-ignore Shared JavaScript sequencing of the segments one long reply is spoken as.
import { createReplySegmentPlayer, replyCaptionHoldMs, replySegmentHoldSeconds, replySegmentsOf, REPLY_SEGMENT_EVENT, REPLY_SEGMENT_MAX_HOLD_SECONDS, REPLY_SEGMENT_SILENT_HOLD_SECONDS } from '../../lab/browser-roundtrip/reply-segments.mjs';

const clip = (voice: string) => ({ base64: 'T2dnUw==', mimeType: 'audio/ogg; codecs=opus', format: 'ogg-opus', bytes: 4, voice });

const reply = (overrides: Record<string, unknown> = {}) => ({
  id: 'caption-1', speak: true, holdSeconds: 6,
  text: 'First part. Second part. Third part.',
  segments: [
    { index: 0, text: 'First part.', audio: clip('a'), seconds: 2 },
    { index: 1, text: 'Second part.', audio: clip('b'), seconds: 3 },
    { index: 2, text: 'Third part.', audio: clip('c'), seconds: 1 },
  ],
  ...overrides,
});

/** A page-shaped event target that dispatches in registration order, as a browser does. */
function target() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  return {
    addEventListener(type: string, handler: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: any) => void) { listeners.get(type)?.delete(handler); },
    dispatchEvent(event: any) { for (const handler of [...(listeners.get(event.type) ?? [])]) handler(event); },
  };
}

function scopeWith() {
  const entries: Array<{ kind: string; detail: any }> = [];
  return { entries, scope: { __stereofoldDiagnostics: { record: (kind: string, detail: any) => { entries.push({ kind, detail }); return null; } } } as any };
}

/**
 * A play hook that only finishes when the test lets it, so "the next segment
 * started too early" is something a test can actually catch.
 */
function gatedPlay() {
  const started: number[] = [];
  const releases: Array<(played: boolean) => void> = [];
  const inFlight = () => started.length - releases.filter(release => (release as any).done).length;
  const play = (segment: any) => {
    started.push(segment.index);
    return new Promise<boolean>(resolve => {
      const release = (played: boolean) => { (release as any).done = true; resolve(played); };
      releases.push(release);
    });
  };
  return { play, started, releases, inFlight };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const kinds = (entries: Array<{ kind: string }>) => entries.map(entry => entry.kind);
const detailOf = (entries: Array<{ kind: string; detail: any }>, kind: string) => entries.find(entry => entry.kind === kind)?.detail;

describe('the segments one long reply is spoken as', () => {
  it('reads a caption back as its ordered segments, and a short one as the single segment it is', () => {
    expect(replySegmentsOf(reply()).map((segment: any) => segment.text))
      .toEqual(['First part.', 'Second part.', 'Third part.']);
    // A Mac that predates segments sends text and one clip.
    expect(replySegmentsOf({ id: 'c', speak: true, text: 'Thirteen protofilaments.', audio: clip('a') }))
      .toEqual([{ index: 0, text: 'Thirteen protofilaments.', audio: clip('a') }]);
    expect(replySegmentsOf({ speak: false, text: 'Rendered.' })).toEqual([]);
    expect(replySegmentsOf({ text: '   ' })).toEqual([]);
    expect(replySegmentsOf(undefined)).toEqual([]);
    // A segment carrying no readable text is skipped, and the rest renumbered.
    expect(replySegmentsOf({ speak: true, text: 'x', segments: [{ text: ' ' }, { text: 'Kept.' }] }))
      .toEqual([{ index: 0, text: 'Kept.' }]);
  });

  it('plays the segments in order and never two at once', async () => {
    const { scope } = scopeWith();
    const shown: string[] = [];
    const gate = gatedPlay();
    const player = createReplySegmentPlayer({ scope, target: target(), play: gate.play, show: (text: string) => shown.push(text) });
    player.start(reply(), replySegmentsOf(reply()), undefined);
    await settle();

    // Only the first segment has started, and its caption is the one drawn.
    expect(gate.started).toEqual([0]);
    expect(shown).toEqual(['First part.']);
    expect(player.running()).toMatchObject({ captionId: 'caption-1', index: 0, total: 3 });

    gate.releases[0]!(true);
    await settle();
    expect(gate.started).toEqual([0, 1]);
    expect(shown).toEqual(['First part.', 'Second part.']);

    gate.releases[1]!(true);
    await settle();
    expect(gate.started).toEqual([0, 1, 2]);
    expect(shown).toEqual(['First part.', 'Second part.', 'Third part.']);

    gate.releases[2]!(true);
    await settle();
    expect(player.running()).toBeUndefined();
  });

  it('advances the caption with each segment, on the page event as well as the hook', async () => {
    const { scope } = scopeWith();
    const events = target();
    const seen: any[] = [];
    events.addEventListener(REPLY_SEGMENT_EVENT, (event: any) => seen.push(event.detail));
    const gate = gatedPlay();
    const player = createReplySegmentPlayer({ scope, target: events, play: gate.play });
    player.start(reply(), replySegmentsOf(reply()), undefined);
    await settle();
    gate.releases[0]!(true);
    await settle();

    // `holdSeconds` rides with every segment: the page draws each one as it
    // starts, and each has to stay readable for the window the Mac asked for.
    expect(seen).toEqual([
      { captionId: 'caption-1', index: 0, total: 3, text: 'First part.', audible: true, seconds: 2, holdSeconds: 6 },
      { captionId: 'caption-1', index: 1, total: 3, text: 'Second part.', audible: true, seconds: 3, holdSeconds: 6 },
    ]);
  });

  it('drops the tail of an older reply when a newer one arrives, and says how much', async () => {
    const { entries, scope } = scopeWith();
    const gate = gatedPlay();
    const player = createReplySegmentPlayer({ scope, target: target(), play: gate.play });
    player.start(reply(), replySegmentsOf(reply()), undefined);
    await settle();
    gate.releases[0]!(true);
    await settle();
    // The second of three is sounding when the correction lands.
    expect(gate.started).toEqual([0, 1]);

    const newer = reply({ id: 'caption-2', text: 'Correction.', segments: [{ index: 0, text: 'Correction.', audio: clip('d'), seconds: 1 }] });
    // One segment of the older answer had not started, and is reported.
    expect(player.start(newer, replySegmentsOf(newer), undefined)).toBe(1);
    await settle();

    expect(detailOf(entries, 'reply-segments-dropped'))
      .toEqual({ captionId: 'caption-1', stoppedAt: 1, dropped: 1, total: 3, reason: 'replaced' });
    // The correction is what is sounding now.
    expect(gate.started).toEqual([0, 1, 0]);
    expect(player.running()).toMatchObject({ captionId: 'caption-2', index: 0, total: 1 });

    // The older reply's third segment never starts, not even after its second
    // one finishes late.
    gate.releases[1]!(true);
    await settle();
    expect(gate.started).toEqual([0, 1, 0]);
    expect(player.running()).toMatchObject({ captionId: 'caption-2' });
    // A single-segment correction is not itself worth a start record.
    expect(kinds(entries)).toEqual(['reply-segments-start', 'reply-segments-dropped']);
  });

  it('holds a silent segment for its own length rather than flashing past it', async () => {
    const { scope } = scopeWith();
    const waits: number[] = [];
    const shown: string[] = [];
    const player = createReplySegmentPlayer({
      scope, target: target(), show: (text: string) => shown.push(text),
      play: async () => false,
      setTimer: (fn: () => void, ms: number) => { waits.push(ms); fn(); return 0; },
      clearTimer: () => {},
    });
    const silent = { id: 'c', speak: true, holdSeconds: 6, text: 'One. Two. Three.', segments: [
      { index: 0, text: 'One.', seconds: 2 }, { index: 1, text: 'Two.' }, { index: 2, text: 'Three.' }] };
    player.start(silent, replySegmentsOf(silent), undefined);
    await settle();
    expect(shown).toEqual(['One.', 'Two.', 'Three.']);
    // The segment's own length, then the caption's hold; the last one is not
    // held at all, because nothing follows it.
    expect(waits).toEqual([2_000, 6_000]);
  });

  it('bounds how long one segment may hold the row', () => {
    expect(replySegmentHoldSeconds({ seconds: 3 }, { holdSeconds: 6 })).toBe(3);
    expect(replySegmentHoldSeconds({}, { holdSeconds: 9 })).toBe(9);
    expect(replySegmentHoldSeconds({}, {})).toBe(REPLY_SEGMENT_SILENT_HOLD_SECONDS);
    expect(replySegmentHoldSeconds({ seconds: 900 }, {})).toBe(REPLY_SEGMENT_MAX_HOLD_SECONDS);
  });

  // A 117-character answer was delivered with
  // `holdSeconds: 6` and sounded for 7.05 s behind a plate that came down at
  // 3.08 s. How long the words must stay readable is not the same question as
  // when a silent segment gives the row up.
  it('holds a segment for the longer of the clip and the window the Mac asked for', () => {
    expect(replyCaptionHoldMs({ seconds: 7.05 }, { holdSeconds: 6 })).toBe(7_050);
    expect(replyCaptionHoldMs({ seconds: 2 }, { holdSeconds: 6 })).toBe(6_000);
    expect(replyCaptionHoldMs({}, { holdSeconds: 15 })).toBe(15_000);
    expect(replyCaptionHoldMs({}, {})).toBe(REPLY_SEGMENT_SILENT_HOLD_SECONDS * 1_000);
    expect(replyCaptionHoldMs({ seconds: 900 }, { holdSeconds: 15 })).toBe(REPLY_SEGMENT_MAX_HOLD_SECONDS * 1_000);
  });

  it('stops for good, and refuses to start again', async () => {
    const { scope } = scopeWith();
    const gate = gatedPlay();
    const player = createReplySegmentPlayer({ scope, target: target(), play: gate.play });
    player.start(reply(), replySegmentsOf(reply()), undefined);
    await settle();
    player.stop();
    gate.releases[0]!(true);
    await settle();
    expect(gate.started).toEqual([0]);
    expect(player.start(reply(), replySegmentsOf(reply()), undefined)).toBe(0);
    await settle();
    expect(gate.started).toEqual([0]);
  });
});

it('keeps a silent segment reading window when the following batch has not arrived yet',async()=>{
  const {scope}=scopeWith();const shown:string[]=[];const waits:number[]=[];let finishHold!:()=>void;
  const player=createReplySegmentPlayer({scope,target:target(),show:(text:string)=>shown.push(text),
    play:async(segment:any)=>Boolean(segment.audio),
    setTimer:(fn:()=>void,ms:number)=>{waits.push(ms);finishHold=fn;return 1;},clearTimer:()=>{}});
  const first={id:'opening',speak:true,speechTotal:2,segments:[{index:0,text:'Silent opening.',seconds:2}]};
  player.start(first,replySegmentsOf(first));await settle();
  expect(waits).toEqual([2000]);
  const tail={id:'tail',voiceFor:'opening',voiceOffset:1,speechTotal:2,speak:true,
    segments:[{index:0,text:'Spoken tail.',audio:clip('tail')}]};
  player.enqueue(tail,replySegmentsOf(tail));await settle();
  expect(shown).toEqual(['Silent opening.']);
  finishHold();await settle();
  expect(shown).toEqual(['Silent opening.','Spoken tail.']);
  player.stop();
});
