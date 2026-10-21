/**
 * A menu folded to its compact control keeps the assistant status plate,
 * beneath the control.
 *
 * The compact seats a large subject leaves dropped the plate and its lines,
 * so the wearer lost "Hold A or X to talk" exactly when the menu folded.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { SPATIAL_TOOLBAR_LAYOUT } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { menuRelocationCandidates } from './menu-relocation.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url), 'utf8'));
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url), { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] };
const assistantLines = ['No assistant connected', 'Hold A or X to talk', 'Assistant: next tour'];
const tour = { active: true, selectedId: 'atp-synthase', selectedTitle: 'ATP synthase', title: 'The working part',
  progress: 'Scene 4 / 5', step: 3, total: 5, canNext: true, chapterStartedAt: 0,
  bodyPage: 'Gamma forms the shaft into the catalytic head; delta and epsilon complete the central stalk.' };

test('every compact seat keeps the status plate, beneath its control', () => {
  const options = { rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour }),
    readout: runtime.tourReadout(tour, undefined, 0), assistantLines, status: '', readoutPage: 0,
    measureText: runtime.toolbarTextWidth, constants: SPATIAL_TOOLBAR_LAYOUT };
  const compact = menuRelocationCandidates(options, head, { cardOnly: true }).filter(candidate => String(candidate.id).startsWith('compact'));
  assert.ok(compact.length > 0, 'the card-only search offers compact seats');
  for (const { panel } of compact) {
    assert.deepEqual(panel.statusPoints.map(line => line.text), assistantLines, 'the status lines stay');
    assert.ok(panel.statusBacking, 'the status plate stays');
    const control = panel.buttons[0].point, plate = panel.statusBacking;
    const up = panel.up, offset = plate.point.map((value, axis) => value - control[axis]);
    assert.ok(offset.reduce((sum, value, axis) => sum + value * up[axis], 0) < 0, 'the plate sits beneath the control');
    const across = offset.reduce((sum, value, axis) => sum + value * panel.right[axis], 0);
    assert.ok(Math.abs(across) <= plate.halfWidth, 'and under it, not beside it');
  }
});

test('a listening status keeps its compact seats though its widest line sizes the plate', () => {
  // The plate is sized from its widest line, and that line measured back
  // against the plate came out a rounding error too wide: every compact seat
  // was refused while Claude listened.
  const lines = ['Claude is listening', 'Listening...', 'No action applied yet'], glance = ['Claude · Listening...'];
  const listening = { ...tour, selectedId: 'polish', title: 'Rotor stops', step: 6, total: 7,
    bodyPage: 'The shaft rotates through the catalytic head while the outer frame stays fixed.' };
  const options = { rows: spatialToolbarRows({ collapsed: true, quiet: true, voice: { state: 'idle' }, tour: listening }),
    readout: runtime.tourReadout(listening, undefined, 0), assistantLines: lines, assistantGlance: glance, status: '', readoutPage: 0,
    measureText: runtime.toolbarTextWidth, constants: SPATIAL_TOOLBAR_LAYOUT };
  const compact = menuRelocationCandidates(options, head, { cardOnly: true }).filter(candidate => String(candidate.id).startsWith('compact'));
  assert.ok(compact.length > 0, 'the card-only search offers compact seats');
  for (const { panel } of compact) {
    assert.ok(panel.statusBacking, 'the status plate stays');
    assert.ok([lines, glance].some(shown => shown.join('\n') === panel.statusPoints.map(line => line.text).join('\n')),
      'it shows all three lines or the glance');
  }
  assert.ok(compact.some(({ panel }) => panel.statusPoints.length === 3), 'a seat with room shows all three lines');
});
