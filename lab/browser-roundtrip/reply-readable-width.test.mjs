/**
 * Replies keep their ordinary readable glass under the 2x2 lesson controls
 * and the expanded menu. Width is measured from the rendered words and font,
 * independently of the menu width; every page and whole word must be drawn.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url)));
const runtime = await toolbarFrameRuntime(undefined, { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: identity() }; head.matrix[13] = 1.6;
const tour = { active: true, selectedId: 'polish', title: 'Rotor stops', step: 6, total: 7, canNext: true, chapterStartedAt: 0,
  bodyPage: 'The shaft rotates through the catalytic head while the outer frame stays fixed.' };
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const until = async (done, ms = 2000) => {
  for (const end = Date.now() + ms; !done() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5));
};

async function caption({ collapsed }) {
  runtime.assistantStatus.update({ microphone: 'idle' });
  const menu = toolbarFrameHarness(runtime, { state: { tour, voice: { state: 'idle' } } });
  await menu.toolbar.update();
  if (!collapsed) {
    menu.toolbar.runAction(menu.toolbar.rows().find(row => row.id === 'menu').action);
    await new Promise(resolve => setImmediate(resolve));
  }
  let clock = 0;
  const live = new Set(), records = [];
  const views = () => syntheticViews().map(view => { view.transform.inverse.matrix[13] = -1.6; return view; });
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() },
    presentation: { add: r => live.add(r), remove: r => live.delete(r) }, head: () => head,
    menuPoints: () => menu.toolbar.menuPoints(), menuPlates: () => menu.toolbar.glassPlates(),
    captionColumn: () => menu.toolbar.captionColumn(), clearance: () => ({ views: views(), renderFromRoom: identity() }),
    now: () => clock, record: (kind, detail) => records.push({ kind, ...detail }) });
  return { menu, card, live, records,
    advance: async time => { clock = time; card.frame(); await until(() => false, 20); },
    // The drawn caption, one string per line, read back from its glyphs.
    drawnLines() {
      const label = [...live].find(r => r.shape?.name === 'Stereofold caption');
      const rows = new Map();
      for (const glyph of label?.shape?.geometry?.glyphs ?? []) {
        const key = Math.round(glyph.position[1] * 1e5);
        rows.set(key, [...(rows.get(key) ?? []), glyph]);
      }
      return [...rows.entries()].sort((a, b) => b[0] - a[0])
        .map(([, glyphs]) => glyphs.sort((a, b) => a.position[0] - b.position[0]).map(glyph => glyph.text).join(''));
    },
    dispose: async () => { runtime.setTalkOutcomeSink(undefined); await card.dispose(); await menu.toolbar.dispose(); } };
}

// Spaces are not drawn, so a line is compared by where it ends: a whole-word
// line ends exactly where one of the page's words ends.
function assertWholeWords(lines, page) {
  const words = page.split(' ');
  const ends = new Set(words.map((_, i) => words.slice(0, i + 1).join('').length));
  let drawn = 0;
  for (const line of lines) {
    drawn += line.length;
    assert.ok(ends.has(drawn), `"${line}" ends inside a word of "${page}"`);
  }
  assert.equal(lines.join(''), words.join(''), 'every glyph of the page is drawn');
}

async function readReply(h, reply) {
  const receipts = [], pages = [];
  runtime.setTalkOutcomeSink((text, holdMs, complete, onSeat) => h.card.set({ outcome: text, holdMs, complete, onSeat }));
  assert.equal(runtime.showTalkOutcome(reply, 6000, true, receipt => receipts.push(receipt)), true);
  await until(() => h.card.text());
  for (let time = 0; time < 120000 && h.card.text(); time += 6000) {
    const page = h.card.text();
    pages.push({ page, lines: h.drawnLines(), points: h.card.platePoints() });
    await h.advance(time + 5999);
    assert.equal(h.card.text(), page, 'the page holds its full reading window');
    await h.advance(time + 6000);
    await until(() => h.card.text() !== page);
  }
  assert.equal(receipts[0]?.outcome, 'shown', 'the reply is shown');
  return pages;
}

const twoSentences = 'Watch the molecule change shape while the binding site stays still. '
  + 'Follow the moving domain as it closes around the ligand, then compare the contacts in the open and closed structures.';

for (const collapsed of [true, false]) {
  test(`a two-sentence reply under the ${collapsed ? 'lesson' : 'expanded'} menu keeps the ordinary reply glass`, async () => {
    const h = await caption({ collapsed });
    try {
      const column = h.menu.toolbar.captionColumn();
      assert.equal(h.menu.toolbar.isCollapsed(), collapsed);
      const rows = h.menu.toolbar.menuRows();
      assert.equal(rows.length === 4, collapsed, 'the lesson retains its four controls; Menu opens the full grid');
      const pages = await readReply(h, twoSentences);
      assert.deepEqual(pages.map(({ page }) => page), runtime.captionPages(twoSentences), 'paged as the ordinary reply');
      assert.equal(pages.map(({ page }) => page).join(' '), twoSentences, 'every word is shown');
      for (const { page, lines, points } of pages) {
        assertWholeWords(lines, page);
        const xs = points.map(point => dot(point, column.right));
        const expectedLines = runtime.captionLines(page, { lineChars: runtime.CAPTION_WIDE_LINE_CHARS, maxLines: runtime.CAPTION_WIDE_MAX_LINES });
        assert.deepEqual(lines, expectedLines.map(line => line.replaceAll(' ', '')), 'the ordinary reply keeps its readable line width');
        const expectedWidth = Math.max(...expectedLines.map(line => [...line].reduce((width, char) => width + (metrics.advances[char] ?? .6), 0)))
          * runtime.CAPTION_FONT_METERS + 2 * runtime.CAPTION_PADDING_METERS;
        assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - expectedWidth) < 1e-9,
          `"${page}" has the full ordinary reply glass at the readable font size`);
      }
    } finally { await h.dispose(); }
  });
}

test('a long single word in a collapsed-menu reply is drawn whole', async () => {
  const h = await caption({ collapsed: true });
  try {
    const reply = 'Phosphoenolpyruvate carboxykinase.';
    const pages = await readReply(h, reply);
    assert.equal(pages.map(({ page }) => page).join(' '), reply);
    for (const { page, lines } of pages) assertWholeWords(lines, page);
    assert.ok(pages.some(({ lines }) => lines.includes('Phosphoenolpyruvate')), 'the long word is one line');
  } finally { await h.dispose(); }
});

// A short reply fits the narrow glass only by splitting its word, which drew
// "Phosphoenolpyru" over "vate binds." beneath the lesson controls.
for (const collapsed of [true, false]) for (const reply of ['Phosphoenolpyruvate binds.', 'Dephosphorylation complete.']) {
  test(`"${reply}" under the ${collapsed ? 'lesson' : 'expanded'} menu keeps its words whole`, async () => {
    const h = await caption({ collapsed });
    try {
      const pages = await readReply(h, reply);
      assert.deepEqual(pages.map(({ page }) => page), [reply]);
      assertWholeWords(pages[0].lines, reply);
    } finally { await h.dispose(); }
  });
}

// The reply seat clears each drawn menu plate. A reply standing still asked
// the menu for its plates every frame, and the menu rebuilt their outlines
// each time: twelve outline builds a frame for unchanged glass.
for (const collapsed of [true, false]) {
  test(`a still reply under the ${collapsed ? 'lesson' : 'expanded'} menu rebuilds no menu outlines`, async () => {
    const h = await caption({ collapsed });
    try {
      runtime.setTalkOutcomeSink((text, holdMs, complete, onSeat) => h.card.set({ outcome: text, holdMs, complete, onSeat }));
      runtime.showTalkOutcome('Phosphoenolpyruvate binds.', 6000, true);
      await until(() => h.drawnLines().length);
      await h.advance(100);
      runtime.reset();
      for (let frame = 0; frame < 72; frame++) h.card.frame();
      await until(() => false, 20);
      assert.equal(h.card.text(), 'Phosphoenolpyruvate binds.', 'the reply is still up');
      for (const name of ['toolbarPlateOutline', 'toolbarBackingOutline'])
        assert.equal(runtime.counts[name] ?? 0, 0, `${name} stays off unchanged frames`);
    } finally { await h.dispose(); }
  });
}

for (const [state, line] of [[{ talking: true }, 'Listening…'], [{ sending: true, progress: 'Transcribing…' }, 'Transcribing…'],
  [{ sending: true, progress: 'Asking Claude…' }, 'Asking Claude…']]) {
  test(`"${line}" shows whole beneath the lesson controls`, async () => {
    const h = await caption({ collapsed: true });
    try {
      h.card.set(state);
      await until(() => h.card.text());
      assert.equal(h.card.text(), line);
      const seat = h.records.filter(r => r.kind === 'talk-caption-seat').at(-1);
      assert.equal(seat?.outcome, 'shown');
      assert.equal(seat.lines, 1, 'one complete line');
      assertWholeWords(h.drawnLines(), line);
      const column = h.menu.toolbar.captionColumn();
      assert.ok(Math.abs(seat.seat[0] - column.top[0]) < 1e-3, 'centred beneath the lesson controls');
      assert.ok(seat.seat[1] < column.top[1], 'and beneath it');
    } finally { await h.dispose(); }
  });
}
