import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createToolbarPanel, toolbarPlatePoints, toolbarBackingOutline, HALF_IPD_METERS, pageCaptionText, EYE_HALF_FIELD_DEGREES } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { menuSeatWithinView, menuSeatWithinGlance } from './menu-view-band.mjs';
import { menuCapDegrees, QUEST_MENU_MIN_CAP_DEGREES } from './menu-legibility.mjs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url)));
const measureText = text => [...text].reduce((sum, glyph) => sum + (metrics.advances[glyph] ?? .6), 0);
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] };
const assistantLines = ['Claude is listening', 'Hold A or X to talk', 'Claude: paused animation'];

test('Quest 2 ink cap height exceeds 0.6 degrees for every menu/status/caption row in both eyes', () => {
  for (const count of [4, 9, 10, 15, 24, 30, 40]) {
    const panel = createToolbarPanel({ head, rows: Array.from({ length: count }, () => ({ label: 'Move menu' })),
      assistantLines, measureText, readout: [{ text: 'Kinesin flipbook' }, { text: 'The motor walks along the track.' }] });
    assert.ok(menuSeatWithinView(toolbarPlatePoints(panel), head), `${count} rows, all glass`);
    const samples = [...panel.buttons.map(row => [row.point, panel.fontMeters]),
      ...panel.statusPoints.map(row => [row.point, panel.assistantFontMeters]),
      ...panel.readoutPoints.map(row => [row.point, panel.readoutFontMeters])];
    for (const [point, size] of samples) for (const eye of [-HALF_IPD_METERS, HALF_IPD_METERS]) {
      const distance = Math.hypot(point[0] - eye, point[1] - 1.6, point[2]);
      assert.ok(menuCapDegrees(size, distance, point[1] - 1.6) >= QUEST_MENU_MIN_CAP_DEGREES,
        `${count} rows: ${menuCapDegrees(size, distance, point[1] - 1.6)} degrees at ${distance} m`);
    }
    assert.ok([0, 1, 3].includes(panel.statusPoints.length), 'full status, one line or off');
    for (const [i, row] of panel.statusPoints.entries()) {
      assert.ok(assistantLines[i].startsWith(row.text.replace(/…$/u, '')), 'whole words remain in order');
      assert.ok(measureText(row.text) * panel.assistantFontMeters < 2 * panel.statusBacking.halfWidth, 'text fits column width');
    }
  }
});

test('flipbook chapters 1–3 keep caption glass and glyphs in the forward left eye at the peripheral seat', async () => {
  const runtime = await toolbarFrameRuntime(undefined, { glyphAdvances: metrics.advances });
  const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/kinesin-walk/flipbook.json', import.meta.url)));
  for (const [step, chapter] of lesson.chapters.slice(0, 3).entries()) for (const collapsed of [true, false]) for (const page of new Set([chapter.immersive.narration, ...pageCaptionText(chapter.immersive.narration)])) {
    const tour = { active: true, selectedId: lesson.id, step, total: lesson.chapters.length,
      title: chapter.title, body: chapter.immersive.narration, bodyPage: page, chapterStartedAt: 1000 };
    const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed, tour, voice: { state: 'idle' } }),
      assistantLines, measureText, readout: runtime.tourReadout(tour, false, 1000) });
    assert.ok(panel.captionBacking);
    if (collapsed) assert.ok(Math.abs(Math.atan2(-panel.anchor[0], -panel.anchor[2]) * 180 / Math.PI - 29.454808610857068) < 1e-6);
    const captionCorners = toolbarBackingOutline(panel, { plate: panel.captionBacking, segments: 1 });
    for (const point of captionCorners) for (const eye of [-HALF_IPD_METERS, HALF_IPD_METERS]) {
      assert.ok(Math.abs(Math.atan2(point[0] - eye, -point[2])) * 180 / Math.PI < EYE_HALF_FIELD_DEGREES,
        'caption glass stays inside both forward eyes');
      assert.ok(Math.abs(Math.atan2(point[1] - 1.6, -point[2])) * 180 / Math.PI < 45);
    }
    const glyphCorners = (rows, size, frame = panel) => rows.flatMap(row => [-1, 1].flatMap(side => [-1, 1].map(vertical =>
      row.point.map((v, axis) => v + side * measureText(row.text) * size / 2 * frame.right[axis]
        + vertical * size / 2 * frame.up[axis] - Math.max(.004, panel.fontMeters / 2) * frame.normal[axis]))));
    const chapterGlyphs = glyphCorners(panel.readoutPoints, panel.readoutFontMeters, panel.captionBacking);
    for (const point of chapterGlyphs) {
      const leftEyeAngle = Math.abs(Math.atan2(point[0] + HALF_IPD_METERS, -point[2])) * 180 / Math.PI;
      assert.ok(Math.abs(Math.atan2(point[1] - 1.6, -point[2])) * 180 / Math.PI < 45, 'glyph stays in the vertical field');
      assert.ok(leftEyeAngle < EYE_HALF_FIELD_DEGREES, `left-eye caption edge: ${leftEyeAngle}°`);
    }
    if (collapsed) for (const point of [...captionCorners, ...chapterGlyphs]) {
      assert.ok(Math.atan2(Math.hypot(point[0], point[1] - 1.6), -point[2]) * 180 / Math.PI >= 30,
        'chapter glass and glyphs leave the central sixty-degree cone empty');
    }
    assert.ok(panel.readoutPoints.map(row => row.text).join(' ').includes(page.replace(/\s+/g, ' ')), 'the real narrated page is drawn');
    assert.ok(menuSeatWithinView(toolbarPlatePoints(panel), head), `${step + 1}, collapsed=${collapsed}`);
    // Check the real menu labels and narrated captions, not only synthetic rows.
    for (const [rows, size] of [[panel.buttons, panel.fontMeters],
      [panel.statusPoints, panel.assistantFontMeters], [panel.readoutPoints, panel.readoutFontMeters]]) {
      for (const { point } of rows) for (const eye of [-HALF_IPD_METERS, HALF_IPD_METERS]) {
        const distance = Math.hypot(point[0] - eye, point[1] - 1.6, point[2]);
        assert.ok(menuCapDegrees(size, distance, point[1] - 1.6) >= QUEST_MENU_MIN_CAP_DEGREES,
          `chapter ${step + 1}, collapsed=${collapsed}: ink cap below minimum`);
      }
    }
  }
});

test('compact listener edges use the talk glass once for three seconds, without overwriting a reply', async () => {
  const runtime = await toolbarFrameRuntime(undefined, { glyphAdvances: metrics.advances });
  let time = 0;
  const live = new Set();
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() }, head: () => head,
    presentation: { add: r => live.add(r), remove: r => live.delete(r) }, now: () => time });
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const presence = mode => runtime.assistantStatus.notePresence({ activeAssistant: 'Claude', voiceDelivery: { assistant: 'Claude', mode } });
  try {
    presence('polling'); await settle();
    assert.equal(card.text(), 'Claude is listening');
    time = 2999; presence('channel'); card.frame(); await settle();
    assert.equal(card.text(), 'Claude is listening');
    time = 3000; card.frame(); await settle(); assert.equal(card.text(), '');
    card.set({ outcome: 'Scene updated', holdMs: 6000 }); await settle();
    presence('none'); await settle(); assert.equal(card.text(), 'Scene updated');
    time = 9001; card.frame(); await settle(); assert.equal(card.text(), 'Claude · voice off');
    time = 12002; card.frame(); await settle(); assert.equal(card.text(), '');
    runtime.assistantStatus.resetPresence(); await settle(); assert.equal(card.text(), 'No assistant connected');
  } finally { await card.dispose(); }
  presence('polling'); await settle(); assert.equal(live.size, 0, 'dispose unsubscribes');
});
