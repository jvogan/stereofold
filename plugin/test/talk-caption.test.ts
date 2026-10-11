/**
 * The one caption a wearer can always read.
 *
 * Holding A used to look like a dead button: nothing appeared in front of the
 * wearer. The menu's status row was reporting the whole time, about 47 degrees
 * off to one side of a Quest 2 field of view. This plate
 * is seated on the wearer's own gaze instead, and everything here is about what
 * it says and where it sits.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { diagnosticEntrySchema, salvageDiagnosticEntries } from '../src/headset-diagnostics.js';
import { fileURLToPath } from 'node:url';
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { GLYPH_CAP_FRACTION, META_MIN_CAP_METERS } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';

// The caption builds Mol* geometry, which pulls a renderer and rxjs into Node.
// Bundle it with the GPU-only imports replaced, the way `immersive-startup`
// does: the seat, the line and the outcome sink are plain arithmetic and plain
// strings, and none of them touches what is stubbed here.
let createTalkCaption: any, captionGlass: any, captionLines: any, captionSeat: any, captionText: any, setTalkOutcomeSink: any, showTalkOutcome: any;
let CAPTION_BELOW_DEGREES: number, CAPTION_FORWARD_METERS: number, CAPTION_OUTCOME_MS: number;
let CAPTION_FONT_METERS: number, CAPTION_LINE_CHARS: number, CAPTION_MAX_LINES: number;

beforeAll(async () => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL('../../lab/browser-roundtrip/talk-caption.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'caption-fixture', setup(api: any) {
      api.onResolve({ filter: /^molstar\// }, (args: any) => ({ path: args.path, namespace: 'gpu-stub' }));
      api.onLoad({ filter: /.*/, namespace: 'gpu-stub' }, () => ({
        contents: `export const MeshBuilder={createState:()=>({}),addTriangleWithNormal(){},getMesh:()=>({})},
          Mesh={Utils:{}},TextBuilder={create:()=>({add(){},getText:()=>({})})},Text={Utils:{}},
          getFontAtlas=()=>({buffer:0,lineHeight:1,get:()=>({nw:0.6})}),Shape={create:()=>({})},
          ShapeRepresentation=()=>({createOrUpdate:()=>({}),destroy(){}}),Color=x=>x;`,
      }));
    } }],
  });
  const module: any = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  ({ createTalkCaption, captionGlass, captionLines, captionSeat, captionText, setTalkOutcomeSink, showTalkOutcome,
    CAPTION_BELOW_DEGREES, CAPTION_FORWARD_METERS, CAPTION_OUTCOME_MS,
    CAPTION_FONT_METERS, CAPTION_LINE_CHARS, CAPTION_MAX_LINES } = module);
});

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('what the caption reads', () => {
  it('walks a talk press from Listening to Sending to the outcome', () => {
    // The sequence the wearer sees for one press of A or X. The outcome is the
    // last thing standing, which is why it is the only line with a lifetime.
    expect(captionText({ talking: true, sending: false, outcome: '' })).toBe('Listening…');
    expect(captionText({ talking: false, sending: true })).toBe('Sending…');
    expect(captionText({ talking: false, sending: false, outcome: 'Bigger.' })).toBe('Bigger.');
    expect(captionText({ talking: false, sending: false, outcome: 'Not a command' })).toBe('Not a command');
    expect(captionText({})).toBe('');
    expect(CAPTION_OUTCOME_MS).toBeGreaterThanOrEqual(2000);
  });

  it('never carries a wearer sentence, whatever it is handed', () => {
    // Repeating the wearer's own sentence back to them is annoying. Every
    // branch above the outcome is a fixed string, and the outcome is the
    // runner's confirmation.
    const sentence = 'delete every water molecule';
    expect(captionText({ talking: true, outcome: sentence })).toBe('Listening…');
    expect(captionText({ sending: true, outcome: sentence })).toBe('Sending…');
    expect(captionText({ holding: true, outcome: sentence })).toBe('Move hand to move · grip + stick: size');
  });

  it('says what the hand is doing before it says what was said', () => {
    // A wearer holding the structure while an old outcome is still up wants to
    // know what their hand has, not what the microphone heard a moment ago.
    expect(captionText({ holding: true, outcome: 'View reset.' })).toBe('Move hand to move · grip + stick: size');
    expect(captionText({ modifier: true, outcome: 'View reset.' })).toBe('Trigger + stick: turn / depth');
    expect(captionText({ notice: 'Hold to reset…', holding: true })).toBe('Hold to reset…');
    // Talking outranks all of it: the microphone is open and nothing else is.
    expect(captionText({ talking: true, holding: true, notice: 'Hold to reset…' })).toBe('Listening…');
  });
});

describe('how big the caption is', () => {
  it('clears the same cap-height floor the menu enforces', () => {
    // The caption drew at 0.026 m of Mol* `size`, a 0.0151 m cap: about half
    // the floor `spatial-toolbar-geometry.mjs` holds every menu glyph to, on
    // the one surface a wearer always faces. Same constant, same floor.
    expect(CAPTION_FONT_METERS * GLYPH_CAP_FRACTION).toBeGreaterThanOrEqual(META_MIN_CAP_METERS);
    // And not so large that two lines cannot sit inside a downward glance.
    expect(CAPTION_FONT_METERS).toBeLessThan(0.08);
  });

  it('keeps the widest line inside a head-still reading angle', () => {
    // Bigger type is a wider plate at a fixed seat distance. A full line of the
    // widest character the caption can draw must still span less than the
    // 45 degrees a wearer can read without turning their head.
    const widestAdvance = 1.0; // An em-wide glyph; real sans advances are narrower.
    const width = CAPTION_LINE_CHARS * widestAdvance * CAPTION_FONT_METERS;
    const degrees = 2 * Math.atan(width / 2 / CAPTION_FORWARD_METERS) * 180 / Math.PI;
    expect(degrees).toBeLessThan(45);
  });

  it('wraps and truncates rather than widening the plate', () => {
    // Fixed lines are untouched: these are what the wearer sees for a press.
    expect(captionLines('Listening…')).toEqual(['Listening…']);
    for (const state of [{ holding: true }, { modifier: true }]) {
      const text = captionText(state), lines = captionLines(text, captionGlass(text));
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(lines.join(' ')).toBe(text);
    }
    expect(captionLines('Not a command')).toEqual(['Not a command']);
    // A voice or agent confirmation is written elsewhere and can be longer.
    const wrapped = captionLines('Showing the whole structure');
    expect(wrapped.length).toBeLessThanOrEqual(CAPTION_MAX_LINES);
    expect(wrapped.every((line: string) => line.length <= CAPTION_LINE_CHARS)).toBe(true);
    expect(wrapped.join(' ')).toContain('Showing the');
    // Past the last line the wearer is shown that it was cut, not a plate that
    // runs out of their field of view.
    const long = captionLines('Every water molecule has been hidden from the scene');
    expect(long).toHaveLength(CAPTION_MAX_LINES);
    expect(long.every((line: string) => line.length <= CAPTION_LINE_CHARS)).toBe(true);
    expect(long[long.length - 1].endsWith('…')).toBe(true);
    // A single unbreakable word is split, never allowed to set the width.
    const solid = captionLines('supercalifragilisticexpialidocious');
    expect(solid.every((line: string) => line.length <= CAPTION_LINE_CHARS)).toBe(true);
    expect(captionLines('')).toEqual([]);
    expect(captionLines(undefined)).toEqual([]);
  });
});

describe('where the caption sits', () => {
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] };

  it('seats a plate ahead of the eyes and below the gaze', () => {
    const seat: any = captionSeat(head);
    // An identity head pose looks down -Z, so the seat is ahead of the wearer
    // and lower than their eyes, by the drop the constant names.
    expect(seat.origin[2]).toBeLessThan(0);
    expect(seat.origin[1]).toBeLessThan(head.position.y);
    const offset = [seat.origin[0] - 0, seat.origin[1] - 1.6, seat.origin[2] - 0];
    expect(Math.hypot(...offset)).toBeCloseTo(CAPTION_FORWARD_METERS, 6);
    const drop = Math.asin(-offset[1] / CAPTION_FORWARD_METERS) * 180 / Math.PI;
    expect(drop).toBeCloseTo(CAPTION_BELOW_DEGREES, 6);
    // It is a glance down, not a chin on the chest.
    expect(CAPTION_BELOW_DEGREES).toBeLessThanOrEqual(30);
  });

  it('faces the wearer, with square axes', () => {
    const seat: any = captionSeat(head);
    for (const axis of [seat.right, seat.up, seat.normal]) expect(Math.hypot(...axis)).toBeCloseTo(1, 6);
    expect(dot(seat.right, seat.up)).toBeCloseTo(0, 6);
    expect(dot(seat.right, seat.normal)).toBeCloseTo(0, 6);
    expect(dot(seat.up, seat.normal)).toBeCloseTo(0, 6);
    // The plate's normal points back at the eyes it was seated from.
    const toEyes = [0 - seat.origin[0], 1.6 - seat.origin[1], 0 - seat.origin[2]];
    expect(dot(seat.normal, toEyes)).toBeGreaterThan(0);
  });

  it('has no seat at all before tracking arrives', () => {
    expect(captionSeat(undefined)).toBeUndefined();
    expect(captionSeat({} as any)).toBeUndefined();
  });
});

describe('the outcome sink the voice runner writes through', () => {
  it('delivers one line to the live caption and refuses when none is up', () => {
    const lines: string[] = [];
    expect(showTalkOutcome('Bigger.')).toBe(false);
    setTalkOutcomeSink((text: string) => lines.push(text));
    expect(showTalkOutcome('Bigger.')).toBe(true);
    expect(showTalkOutcome('')).toBe(true); // Empty text retires the previous turn.
    expect(showTalkOutcome(undefined as any)).toBe(false);
    setTalkOutcomeSink(undefined);
    expect(showTalkOutcome('Smaller.')).toBe(false);
    expect(lines).toEqual(['Bigger.', '']);
  });

  it('never lets a torn-down caption break the voice runner', () => {
    // The session ends between the Mac returning a transcript and the runner
    // captioning it, which is exactly when the sink is a dead reference.
    setTalkOutcomeSink(() => { throw Error('caption disposed'); });
    expect(showTalkOutcome('View reset.')).toBe(false);
    setTalkOutcomeSink(undefined);
  });
});


describe('reply card retirement during a mesh build', () => {
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  function liveCaption() {
    let time = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const live = new Set();
    const card = createTalkCaption({ plugin: { runTask: () => gate },
      presentation: { add: (repr: unknown) => live.add(repr), remove: (repr: unknown) => live.delete(repr) },
      head: () => ({ position: { x: 0, y: 1.6, z: 0 },
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] }),
      now: () => time,
    });
    return { card, live, release, advance: (ms: number) => { time = ms; card.frame(); } };
  }
  it('cannot resurrect a receipt cleared before or during its mesh build', async () => {
    for (const inFlight of [false, true]) {
      const h = liveCaption();
      h.card.set({ outcome: 'Tour started.' });
      if (inFlight) await flush();
      h.card.set({ outcome: '' });
      h.release(); await flush();
      expect(h.live.size).toBe(0);
      expect(h.card.text()).toBe('');
      await h.card.dispose();
    }
  });
  it('finishes a slow build through repeated XR frames and expires on time', async () => {
    const h = liveCaption();
    h.card.set({ outcome: 'Tour started.' });
    await flush();
    for (let frame = 1; frame <= 10; frame++) h.advance(frame * 14);
    h.release(); await flush();
    expect(h.live.size).toBe(2);
    expect(h.card.text()).toBe('Tour started.');
    h.advance(CAPTION_OUTCOME_MS);
    expect(h.live.size).toBe(0);
    await h.card.dispose();
  });
  it('draws no empty card and retires visible or pending text on a whitespace-only caption', async () => {
    for (const inFlight of [false, true]) {
      const h = liveCaption();
      h.card.set({ outcome: ' \n\t ' });
      await flush();
      expect(h.live.size).toBe(0);
      h.card.set({ outcome: 'Filament tier has no atoms. Switch to an atomic tier.' });
      await flush();
      if (!inFlight) {
        h.release(); await flush();
        expect(h.live.size).toBe(2);
      }
      h.card.set({ outcome: ' \n\t ' });
      h.release(); await flush();
      expect(h.live.size).toBe(0);
      expect(h.card.text()).toBe('');
      await h.card.dispose();
    }
  });
});

it('transports the production reply seat evidence without salvage loss', async () => {
  const entries: any[] = [];
  const card = createTalkCaption({ plugin: { runTask: async () => {} },
    presentation: { add() {}, remove() {} },
    head: () => ({ position: { x: 0, y: 0, z: 0 },
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }),
    now: () => 0, record: (kind: string, detail: unknown) => entries.push({ seq: entries.length + 1, at: 0, kind, detail }),
  });
  card.set({ outcome: 'Both dyskerin copies.' });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const seat = entries.find(e => e.kind === 'talk-caption-seat');
  expect(seat.detail.replyOffset).toEqual([0, 0, 0]);
  expect(diagnosticEntrySchema.parse(seat)).toEqual(seat);
  expect(salvageDiagnosticEntries(entries)).toEqual(entries);
  await card.dispose();
});
