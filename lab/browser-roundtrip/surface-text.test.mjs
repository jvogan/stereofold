import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceText } from './surface-text.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { createToolbarPanel, toolbarTextPoint } from './spatial-toolbar-geometry.mjs';
import { readFileSync } from 'node:fs';
import { SPATIAL_TOOLBAR_LAYOUT, toolbarLayoutForStandoff, TOOLBAR_READING_RANGE_METERS } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';

const cell = value => ({ ref: { value } });
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const subtract = (a, b) => a.map((value, i) => value - b[i]);

test('SDF quad corners share each glass plane, including independently seated readout groups', () => {
  const angle = .8, right = [Math.cos(angle), 0, -Math.sin(angle)], up = [0, 1, 0];
  const text = { charCount: 2, centerBuffer: cell(new Float32Array([1,2,3, 1,2,3, 1,2,3, 1,2,3, 4,5,6, 4,5,6, 4,5,6, 4,5,6])),
    mappingBuffer: cell(new Float32Array([-.02,.03, -.02,-.03, .02,.03, .02,-.03, -.02,.03, -.02,-.03, .02,.03, .02,-.03])),
    groupBuffer: cell(new Float32Array([0,0,0,0,1,1,1,1])), tcoordBuffer: cell(new Float32Array([.1,.2])) };
  let sphere;
  text.setBoundingSphere = value => { sphere = value; };
  const uv = [...text.tcoordBuffer.ref.value];
  surfaceText(text, [{ right, up }, { right: [1,0,0], up: [0,0,1] }]);
  const normal = [Math.sin(angle), 0, Math.cos(angle)];
  for (let vertex = 0; vertex < 8; vertex++) {
    const point = [...text.centerBuffer.ref.value.slice(vertex * 3, vertex * 3 + 3)];
    if (vertex < 4) assert.ok(Math.abs(dot(subtract(point,[1,2,3]), normal)) < 2e-7);
    else assert.equal(point[1], 5);
    assert.ok(Math.hypot(...subtract(point, sphere.center)) <= sphere.radius + 1e-9, 'all distinct quad corners remain inside culling bounds');
  }
  assert.ok([...text.mappingBuffer.ref.value].every(value => value === 0), 'the shader cannot billboard baked corners again');
  assert.deepEqual([...text.tcoordBuffer.ref.value], uv, 'retain SDF texture lookup');
});

test('the actual toolbar draws Talk, Play and Next quads inside their button plane after a head turn', async () => {
  const runtime = await toolbarFrameRuntime();
  const draws = [];
  const state = { tour: { active: true, selectedId: 'custom-lesson', step: 0, total: 3,
    canNext: true, canBack: false, canPlay: true }, voice: { state: 'idle' } };
  const h = toolbarFrameHarness(runtime, { state, presentation: { add: representation => draws.push(representation.shape) } });
  const angle = .7, matrix = [...identity];
  matrix[0] = Math.cos(angle); matrix[2] = -Math.sin(angle);
  matrix[8] = Math.sin(angle); matrix[10] = Math.cos(angle);
  h.frame.getViewerPose = () => ({ transform: { position: { x: .2, y: 1.6, z: .1 }, matrix } });
  try {
    await h.toolbar.update();
    const panel = createToolbarPanel({ head: h.toolbar.head(), rows: h.toolbar.rows(),
      stableLesson: true, constants: h.toolbar.layout(), seatAnchor: h.toolbar.seatAnchor(), measureText: runtime.toolbarTextWidth });
    const geometry = draws.findLast(shape => shape?.name === 'Stereofold spatial toolbar').geometry;
    assert.ok([...geometry.mappingBuffer.ref.value].every(value => value === 0));
    for (const label of ['Talk', 'Play', 'Next']) {
      const group = panel.buttons.findIndex(button => button.label === label);
      assert.ok(group >= 0, `${label} exists in the rendered toolbar`);
      const button = panel.buttons[group];
      let checked = 0;
      const textPlane = toolbarTextPoint(panel, button.point, .003, panel.plateDepthMeters - panel.faceLiftMeters);
      for (let vertex = 0; vertex < geometry.charCount * 4; vertex++) {
        if (geometry.groupBuffer.ref.value[vertex] !== group) continue;
        const point = [...geometry.centerBuffer.ref.value.slice(vertex*3, vertex*3+3)];
        const relative = subtract(point, textPlane);
        assert.ok(Math.abs(dot(relative, panel.normal)) < 2e-7, `${label}: its glyph corners lie on the glass plane`);
        assert.ok(Math.abs(dot(relative, panel.right)) < button.halfWidth - panel.plateInsetMeters, `${label}: ink stays within its button width`);
        assert.ok(Math.abs(dot(relative, panel.up)) < button.halfHeight - panel.plateInsetMeters, `${label}: ink stays within its button height`);
        checked++;
      }
      assert.ok(checked > 0);
    }
  } finally { await h.toolbar.dispose(); }
});

test('assistant status uses readable button-sized type and the same orientation as its menu', () => {
  const head = { position: {x:0,y:1.6,z:0}, matrix: identity };
  for (const stableLesson of [false, true]) {
    const panel = createToolbarPanel({ head, rows: [{label:'Talk'}, {label:'Play'}, {label:'Next'}, {label:'Menu'}],
      stableLesson, assistantLines: ['Codex'], assistantGlance: ['Codex listening · A/X to talk'] });
    assert.equal(panel.assistantFontMeters, panel.fontMeters);
    assert.deepEqual(panel.statusBacking.right, panel.right);
    assert.deepEqual(panel.statusBacking.normal, panel.normal);
    assert.ok(panel.statusPoints.length > 0);
  }
});

test('idle and microphone footer glyphs reach the actual builder at the same size as Talk', async () => {
  const runtime = await toolbarFrameRuntime();
  for (const microphone of ['idle', 'listening', 'transcribing', 'error']) {
    runtime.assistantStatus.update({ assistant: 'Codex', connected: true,
      voiceDelivery: { mode: 'channel', assistant: 'Codex' }, microphone });
    const draws = [];
    const state = { tour: { active: true, selectedId: 'local-lesson', step: 0, total: 3,
      canNext: true, canPlay: true }, voice: { state: microphone } };
    const h = toolbarFrameHarness(runtime, { state, presentation: { add: representation => draws.push(representation.shape) } });
    try {
      await h.toolbar.update();
      const panel = createToolbarPanel({ head: h.toolbar.head(), rows: h.toolbar.rows(), stableLesson: true,
        constants: h.toolbar.layout(), seatAnchor: h.toolbar.seatAnchor(), measureText: runtime.toolbarTextWidth,
        assistantLines: runtime.assistantStatus.panelLines(), assistantGlance: runtime.assistantStatus.panelGlance() });
      const buttons = draws.findLast(shape => shape?.name === 'Stereofold spatial toolbar').geometry.glyphs;
      const readout = draws.findLast(shape => shape?.name === 'Stereofold toolbar readout').geometry.glyphs;
      const footerFirstGroup = Math.max(...readout.map(glyph => glyph.group)) - panel.statusPoints.length + 1;
      const footer = readout.filter(glyph => glyph.group >= footerFirstGroup);
      assert.ok(footer.length > 0, `${microphone}: footer is drawn`);
      const labelSize = buttons[0].size;
      for (const glyph of footer) assert.equal(glyph.size, labelSize, `${microphone}: footer and button use the same room-metre glyph scale`);
    } finally { await h.toolbar.dispose(); }
  }
});

test('full-size footer states fit their glass at the 0.09 m lesson label size', () => {
  const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url)));
  const width = text => [...text].reduce((sum, character) => sum + (metrics.advances[character] ?? .6), 0);
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: identity };
  for (const text of ['Codex', 'Listening...', 'Starting microphone...', 'Transcribing...', 'Microphone unavailable', 'View reset.']) {
    const panel = createToolbarPanel({ head, stableLesson: true,
      constants: { ...SPATIAL_TOOLBAR_LAYOUT, fontMeters: SPATIAL_TOOLBAR_LAYOUT.fontMeters * 1.5 },
      rows: [{label:'Talk'}, {label:'Play'}, {label:'Next'}, {label:'Menu'}], assistantLines: [text], measureText: width });
    assert.ok(Math.abs(panel.fontMeters - .09) < 1e-12);
    assert.equal(panel.assistantFontMeters, panel.fontMeters);
    assert.equal(panel.statusPoints.map(line => line.text).join(' '), text, 'all words remain visible');
    const glass = panel.statusBacking;
    for (const line of panel.statusPoints) {
      const offset = subtract(line.point, glass.point);
      assert.ok(Math.abs(dot(offset, glass.right)) + width(line.text) * panel.assistantFontMeters / 2 < glass.halfWidth);
      assert.ok(Math.abs(dot(offset, glass.up)) + panel.assistantFontMeters / 2 < glass.halfHeight);
    }
  }
});

test('quiet, compact and expanded control ink fits retained planes across standoff scales', () => {
  const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url)));
  const width = text => [...text].reduce((sum, character) => sum + (metrics.advances[character] ?? .6), 0);
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: identity };
  const tour = { active: true, selectedId: 'local-lesson', step: 1, total: 4, canPlay: true,
    canNext: true, canBack: true, bodyPageIndex: 1, bodyPageCount: 2 };
  for (const factor of [1, 1.25, 1.5]) for (const yaw of [-.8, 0, .65]) {
    const normal = [-Math.sin(yaw), 0, -Math.cos(yaw)], right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const constants = { ...toolbarLayoutForStandoff(TOOLBAR_READING_RANGE_METERS * factor), heldMenuPlane: { normal, right } };
    for (const [mode, flags] of [['quiet', { quiet: true, collapsed: true }],
      ['compact', { quiet: false, collapsed: true }], ['expanded', { quiet: false, collapsed: false }]]) {
      for (const voiceState of ['idle', 'listening', 'transcribing', 'error']) {
        const rows = spatialToolbarRows({ ...flags, tour, voice: { state: voiceState }, passthrough: true, quality: 'balanced' });
        const panel = createToolbarPanel({ head, constants, stableLesson: mode !== 'expanded', rows,
          seatAnchor: [.65, 1.3, -1.2], measureText: width });
        assert.deepEqual(panel.right, right, `${mode}: keep wearer plane`);
        assert.deepEqual(panel.normal, normal, `${mode}: keep wearer plane`);
        for (const button of panel.buttons) {
          const lines = button.labelLines ?? [button.label];
          const faceWidth = button.halfWidth - panel.plateInsetMeters - panel.bevelMeters;
          for (const line of lines) assert.ok(width(line) * panel.fontMeters / 2 <= faceWidth + 1e-9,
            `${mode}, ${voiceState}, ${factor}: ${line} fits its beveled face`);
          const inkHalfHeight = (lines.length - 1) / 2 * panel.fontMeters * .7 + panel.fontMeters * .25;
          assert.ok(inkHalfHeight <= button.halfHeight - panel.plateInsetMeters,
            `${mode}, ${factor}: ${button.label} stays between its row edges`);
        }
      }
    }
  }
});
