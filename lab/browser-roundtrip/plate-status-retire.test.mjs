// A status sentence on the plate is never retired.
//
// On the Quest 2 the `talk-caption-seat` ring recorded a 5861 ms
// hold for `Tour chooser closed` and the plate still carried it as the title
// line 10.9 s and 42 s later; `This action belongs to a different structure.`
// stood for minutes, through a link loss and a recovery, until a rendered
// colour change wrote a different sentence over it. The readout's own reading
// window for the chooser was only ever read inside `update()`, the refusal had
// no window at all, and nothing calls `update()` on a clock.
//
// These tests advance a frame clock past the window and ask for the two things
// the wearer and the ring were missing: the title line gone with the structure
// lines still drawn, and a record of the retirement carrying the measured hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';

const runtime = await toolbarFrameRuntime();
const flush = () => new Promise(resolve => setImmediate(resolve));
const subject = { title: 'Human deoxyhaemoglobin', pdbId: '4HHB', chainCount: 4, assembly: 'asymmetric unit' };

/**
 * A toolbar on a clock the test moves by hand.
 *
 * The window is counted in presented frames, so it closes only when the
 * toolbar's per-frame hook runs. `advance` moves the clock and then delivers a
 * frame, which is the order a wearer's session delivers them in.
 */
function plate() {
  const records = [], previous = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  let now = 0;
  const live = new Set();
  const harness = toolbarFrameHarness(runtime, { state: {}, now: () => now,
    presentation: { add: repr => live.add(repr), remove: repr => live.delete(repr) } });
  const lines = () => {
    const text = harness.toolbar.readoutText();
    const glyphs = [...live].find(repr => repr.shape?.name === 'Stereofold toolbar readout')?.shape.geometry.lines ?? [];
    const paging = harness.toolbar.readout();
    const cue = paging.cardPageCount > 1 ? `${paging.cardPageIndex + 1}/${paging.cardPageCount}` : '';
    assert.equal(glyphs.join(''), text.join('').replaceAll(' ', '') + cue,
      'every reported readout character is submitted to the live text representation');
    return text;
  };
  return {
    ...harness, records,
    lines,
    /** The title sentence, rejoined from however many lines it wrapped to. */
    title: resting => {
      const drawn = lines(), structureStart = drawn.indexOf(resting[0]);
      // The forward card pages overflow. Its first page need not contain all
      // the resting facts; read the actual leading sentence before the title.
      return drawn.slice(0, structureStart < 0 ? undefined : structureStart).join(' ');
    },
    /** The lines this plate draws with nothing in the title slot. */
    async resting() {
      harness.setState({ tour: { active: false, menuOpen: false }, subject });
      await harness.toolbar.update();
      harness.toolbar.runAction({ kind: 'collapse', value: false });
      await new Promise(resolve => setImmediate(resolve));
      harness.toolbar.syncPose();
      return harness.toolbar.readoutText();
    },
    /** One presented frame at the current time. */
    async present() { harness.toolbar.syncPose(); await flush(); },
    /** Move the clock, then present a frame at the new time. */
    async advance(ms) {
      now += ms;
      harness.toolbar.syncPose();
      for (let step = 0; step < 4; step++) await flush();
    },
    async restore() { await harness.toolbar.dispose(); globalThis.__stereofoldDiagnostics = previous; },
  };
}

for (const { name, tour, sentence } of [
  { name: 'a refusal', sentence: 'This action belongs to a different structure.',
    tour: { active: false, menuOpen: false, feedbackError: true, feedback: 'This action belongs to a different structure.' } },
  { name: 'the chooser-closed notice', sentence: 'Tour chooser closed',
    tour: { active: false, menuOpen: false, feedback: 'Tour chooser closed', chapterStartedAt: 0 } },
]) test(`${name} leaves the plate title when its reading window elapses, and the ring says so`, async () => {
  const p = plate();
  try {
    const resting = await p.resting();
    p.setState({ tour: { ...tour, chapterStartedAt: performance.now() }, subject });
    await p.toolbar.update();
    assert.equal(p.title(resting), sentence, 'the sentence is drawn as the title line');
    await p.present();
    await p.advance(runtime.STATUS_LINE_WINDOW_MS - 1);
    assert.equal(p.title(resting), sentence, 'it stands for the whole window');
    await p.advance(1);
    assert.deepEqual(p.lines(), resting, 'only the structure lines are left');
    const retired = p.records.filter(entry => entry.kind === 'caption-retired');
    assert.equal(retired.length, 1, 'exactly one retirement is recorded');
    assert.equal(retired[0].detail.text, sentence);
    assert.equal(retired[0].detail.surface, 'plate');
    assert.equal(retired[0].detail.holdMs, runtime.STATUS_LINE_WINDOW_MS);
    assert.ok(retired[0].detail.shownMs >= runtime.STATUS_LINE_WINDOW_MS,
      `the measured hold is at least the window, got ${retired[0].detail.shownMs}`);
  } finally { await p.restore(); }
});

test('a retired plate sentence stays retired, and a different sentence still draws', async () => {
  const p = plate();
  try {
    const resting = await p.resting();
    p.setState({ tour: { active: false, menuOpen: false, feedbackError: true, feedback: 'Could not render.' }, subject });
    await p.toolbar.update();
    assert.equal(p.title(resting), 'Could not render.');
    await p.present();
    await p.advance(runtime.STATUS_LINE_WINDOW_MS);
    assert.deepEqual(p.lines(), resting);
    // An unrelated redraw must not put the retired sentence back on the glass.
    await p.toolbar.update();
    await p.advance(1);
    assert.deepEqual(p.lines(), resting);
    p.setState({ tour: { active: false, menuOpen: false, feedbackError: true, feedback: 'Atom budget exceeded.' }, subject });
    await p.toolbar.update();
    assert.equal(p.title(resting), 'Atom budget exceeded.');
    await p.present();
    await p.advance(runtime.STATUS_LINE_WINDOW_MS);
    assert.deepEqual(p.lines(), resting);
    assert.equal(p.records.filter(entry => entry.kind === 'caption-retired').length, 2);
  } finally { await p.restore(); }
});

test('a caption notice given a hold retires on it, and the ring carries the measured hold', async () => {
  let now = 0;
  const records = [], live = new Set();
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() },
    presentation: { add: repr => live.add(repr), remove: repr => live.delete(repr) },
    head: () => ({ position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }),
    now: () => now, record: (kind, detail) => records.push({ kind, detail }) });
  const advance = async ms => { now += ms; card.frame(); await flush(); };
  try {
    card.set({ notice: 'Tour chooser closed', holdMs: 6000 });
    await flush();
    assert.equal(card.text(), 'Tour chooser closed');
    await advance(5999);
    assert.equal(card.text(), 'Tour chooser closed', 'a notice stands for the hold it was given');
    await advance(1);
    assert.equal(card.text(), '', 'and leaves when the hold elapses');
    const retired = records.filter(entry => entry.kind === 'caption-retired');
    assert.equal(retired.length, 1);
    assert.equal(retired[0].detail.text, 'Tour chooser closed');
    assert.equal(retired[0].detail.surface, 'caption');
    assert.equal(retired[0].detail.holdMs, 6000);
    assert.ok(retired[0].detail.shownMs >= 6000, `measured hold ${retired[0].detail.shownMs}`);
  } finally { await card.dispose(); }
});

test('an outcome that expires records its retirement with the hold it was given', async () => {
  let now = 0;
  const records = [], live = new Set();
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() },
    presentation: { add: repr => live.add(repr), remove: repr => live.delete(repr) },
    head: () => ({ position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }),
    now: () => now, record: (kind, detail) => records.push({ kind, detail }) });
  const advance = async ms => { now += ms; card.frame(); await flush(); };
  try {
    card.set({ outcome: 'Applied · color · r9', holdMs: 4000 });
    await flush();
    assert.equal(card.text(), 'Applied · color · r9');
    await advance(4000);
    assert.equal(card.text(), '');
    const retired = records.filter(entry => entry.kind === 'caption-retired');
    assert.equal(retired.length, 1);
    assert.deepEqual({ text: retired[0].detail.text, surface: retired[0].detail.surface, holdMs: retired[0].detail.holdMs },
      { text: 'Applied · color · r9', surface: 'caption', holdMs: 4000 });
  } finally { await card.dispose(); }
});
