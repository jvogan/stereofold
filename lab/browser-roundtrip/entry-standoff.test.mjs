import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticsBuffer } from './headset-diagnostics.mjs';
import { measureEntryStandoff } from './entry-standoff.mjs';
import { entryGeometry, entryStandoffHarness } from './fixtures/entry-standoff.mjs';

function expectedClearance(geometry, eye, subjectLeft = -.4) {
  const view = geometry.views.find(view => view.eye === eye), p = view.projectionMatrix;
  const tangentX = (x, z) => {
    const eyeX = x + view.transform.inverse.matrix[12];
    const clipX = p[0] * eyeX + p[8] * z, w = -z;
    return (clipX / w + p[8]) / p[0];
  };
  const subjectEdge = tangentX(subjectLeft + geometry.objects[0].values.aTransform.ref.value[12], -2);
  const menuEdge = tangentX(Math.max(...geometry.menuPoints.map(point => point[0])) + geometry.renderFromRoom[12], -1);
  return Math.round((subjectEdge - menuEdge) * 10000) / 10000;
}

test('monoscopic clearance records the supplied view without inventing stereo evidence', () => {
  const geometry = entryGeometry();
  geometry.views = [{ ...geometry.views[0], eye: 'none' }];
  const result = measureEntryStandoff(geometry);
  assert.equal(result.eyes.length, 1);
  assert.equal(result.eyes[0].eye, 'none');
  assert.ok(Number.isFinite(result.clearanceMono));
  assert.equal(result.clearanceLeft, undefined);
  assert.equal(result.clearanceRight, undefined);
  geometry.views[0].eye = 'left';
  assert.equal(measureEntryStandoff(geometry), undefined);
});

test('entry clearance measures the lit silhouette in each eye, excluding the faded fringe', () => {
  const geometry = entryGeometry();
  const detail = measureEntryStandoff(geometry);
  assert.equal(detail.clearanceLeft, expectedClearance(geometry, 'left'));
  assert.equal(detail.clearanceRight, expectedClearance(geometry, 'right'));
  assert.equal(detail.lit, true);
  assert.equal(detail.frame.menu.clear, true);
  geometry.objects[0].values.dTransparency.ref.value = false;
  const whole = measureEntryStandoff(geometry);
  assert.equal(whole.clearanceLeft, expectedClearance(geometry, 'left', -1));
  assert.equal(whole.clearanceRight, expectedClearance(geometry, 'right', -1));
  assert.equal(whole.frame.menu.clear, false);
});

test('entry clearance respects committed transforms and reports contact per eye', () => {
  const geometry = entryGeometry();
  // Offset the room and scientific geometry equally in render space.
  geometry.renderFromRoom[12] = .1;
  geometry.objects[0].values.aTransform.ref.value[12] = .1;
  const detail = measureEntryStandoff(geometry);
  assert.equal(detail.clearanceLeft, expectedClearance(geometry, 'left'));
  assert.equal(detail.clearanceRight, expectedClearance(geometry, 'right'));
  geometry.objects[0].values.aTransform.ref.value[12] = -.168;
  const contact = measureEntryStandoff(geometry);
  assert.equal(contact.clearanceLeft, 0);
  assert.equal(contact.frame.menu.clear, false);
});

test('selected-tour entry waits for settled stereo geometry and records once per entry', () => {
  const buffer = createDiagnosticsBuffer();
  const h = entryStandoffHarness((kind, detail) => buffer.record(kind, detail));
  h.context.pendingRoomSeat = true; h.frame();
  h.context.pendingRoomSeat = false; h.context.pendingRoomLabels = true; h.frame();
  h.context.pendingRoomLabels = false;
  const views = h.geometry.views;
  h.geometry.views = views.slice(0, 1); h.frame();
  h.geometry.views = views;
  const points = h.geometry.menuPoints;
  h.geometry.menuPoints = []; h.frame();
  h.geometry.menuPoints = points;
  assert.equal(buffer.size(), 0, 'missing geometry never claims clearance or consumes entry');
  h.frame(); h.frame();
  assert.equal(buffer.size(), 1);
  assert.equal(buffer.all()[0].detail.clearanceLeft, expectedClearance(h.geometry, 'left'));
  h.context.roomEntry = {}; h.frame();
  assert.equal(buffer.size(), 2, 'a fresh entry takes a fresh measurement');
});

test('the actual entry record survives ten minutes of frame and toolbar traffic', () => {
  let clock = 0;
  const buffer = createDiagnosticsBuffer({ now: () => clock });
  const h = entryStandoffHarness((kind, detail) => buffer.record(kind, detail));
  h.frame();
  const entry = buffer.all()[0];
  for (clock = 1000; clock <= 600000; clock += 1000) {
    for (const kind of ['frame-cost', 'frame-rate']) buffer.record(kind, { sample: clock });
    for (const phase of ['rows', 'plates']) buffer.record('toolbar', { phase });
    buffer.record('plate-update', { changed: 0, ms: 20 });
  }
  assert.equal(buffer.size(), 200);
  assert.deepEqual(buffer.all()[0], entry);
});
