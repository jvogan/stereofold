import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnosticsBuffer, watchSessionInput } from './headset-diagnostics.mjs';

test('ten minutes of traffic retains every changed or costly plate update', () => {
  let clock = 0;
  const buffer = createDiagnosticsBuffer({ now: () => clock });
  const important = [];
  for (clock = 0; clock <= 600000; clock += 1000) {
    if (clock % 60000 === 0) {
      // Acceptance 5 #471/#580: changed geometry; also cheap repaint and
      // the exact 50 ms costly-no-op boundary must bypass both policies.
      for (const detail of [{ changed: 30, ms: 289 }, { changed: 1, ms: 2 }, { changed: 0, ms: 50 }])
        important.push(buffer.record('plate-update', detail));
    }
    buffer.record('plate-update', { changed: 0, ms: 49 });
    for (const kind of ['frame-rate', 'frame-cost', 'component-labels-drawn']) buffer.record(kind, { sample: clock });
    for (const phase of ['rows', 'plates']) buffer.record('toolbar', { phase });
  }
  assert.equal(buffer.size(), 200);
  assert.ok(important.every(Boolean), 'important bursts bypass sampling');
  assert.deepEqual(buffer.all().filter(entry => entry.kind === 'plate-update'
    && (entry.detail.changed > 0 || entry.detail.ms >= 50)), important);
  assert.deepEqual(buffer.all().map(entry => entry.seq), buffer.all().map(entry => entry.seq).sort((a, b) => a - b));
});

test('sampled no-ops and toolbar redraws cannot displace an all-important plate window', () => {
  let clock = 0;
  const buffer = createDiagnosticsBuffer({ limit: 3, now: () => clock });
  for (const detail of [{ changed: 1, ms: 1 }, { changed: 0, ms: 50 }, { changed: 30, ms: 277 }])
    buffer.record('plate-update', detail);
  const rare = buffer.all();
  clock = 5000;
  assert.ok(buffer.record('plate-update', { changed: 0, ms: 49 }), 'exercise an admitted no-op sample');
  for (const phase of ['rows', 'plates']) buffer.record('toolbar', { phase });
  buffer.record('frame-rate', { fps: 72 });
  assert.deepEqual(buffer.all(), rare);
  buffer.record('plate-update', { changed: 1, ms: 1 });
  assert.equal(buffer.size(), 3);
  assert.deepEqual(buffer.all().slice(0, 2), rare.slice(1), 'important-only overflow still uses bounded FIFO');
});

test('frequent frame records cannot evict layout, drawn, toolbar, tour or voice evidence', () => {
  let clock = 0;
  const rareKinds = ['component-label-layout', 'component-labels-drawn', 'toolbar', 'tour',
    'voice', 'voice-press', 'voice-command'];
  const limit = rareKinds.length * 10 + 2;
  const buffer = createDiagnosticsBuffer({ now: () => clock, limit });
  for (let index = 0; index < 10; index += 1) {
    buffer.record('frame-cost', { index });
    buffer.record('frame-rate', { index });
    for (const kind of rareKinds) {
      buffer.record(kind, { index });
    }
    clock += 100;
  }
  const entries = buffer.all();
  assert.equal(entries.length, limit);
  assert.equal(entries.filter(entry => entry.kind === 'frame-cost').length, 1);
  assert.equal(entries.filter(entry => entry.kind === 'frame-rate').length, 1);
  for (const kind of rareKinds) {
    assert.deepEqual(entries.filter(entry => entry.kind === kind).map(entry => entry.detail.index),
      Array.from({ length: 10 }, (_, index) => index), kind);
  }
});

test('twenty minutes of sampled frames and redraws retain rare records for a late reader', () => {
  let clock = 0;
  const buffer = createDiagnosticsBuffer({ now: () => clock,
    rateLimitMs: { 'frame-rate': 5000, 'frame-cost': 5000, 'future-sample': 1000 } });
  const rare = ['tour', 'xr-frame-error', 'voice-command', 'talk-caption',
    'component-label-layout', 'plate-standoff', 'session-start', 'head-rotation-hold'].map(kind => buffer.record(kind, { proof: kind }));
  rare.push(buffer.record('toolbar', { event: 'seat', reason: 'entry' }));
  rare.push(buffer.record('toolbar', { phase: 'status', text: 'Filament tier has no atoms. Switch to an atomic tier.' }));
  // Acceptance 3 ring-now-0016 held seq 407..606: 100 frame-cost and
  // 100 frame-rate, with every tour/entry record gone. Run longer, including
  // redraw and per-eye telemetry, and ask for the first heartbeat only now.
  for (clock = 1000; clock <= 20 * 60 * 1000; clock += 1000) {
    for (const kind of ['frame-rate', 'frame-cost', 'component-labels-drawn', 'future-sample'])
      buffer.record(kind, { sample: clock });
    buffer.record('xr-grab', { event: 'rejected', reason: 'not-ready' });
    buffer.record('component-labels', { visible: 10 });
    buffer.record('toolbar', { phase: 'rows', draw: clock });
  }
  assert.equal(buffer.size(), 200);
  assert.ok(buffer.dropped() > 200);
  assert.deepEqual(buffer.all().slice(0, rare.length), rare);
  const received = [];
  while (buffer.pending().length) {
    const batch = buffer.pending();
    assert.deepEqual(buffer.pending(), batch, 'a lost heartbeat is retried unchanged');
    received.push(...batch);
    buffer.acknowledge(batch.at(-1).seq);
  }
  assert.deepEqual(received, buffer.all(), 'gaps in sequence never skip retained evidence');
  assert.equal(buffer.acknowledged(), buffer.sequence());
});

test('rare-only overflow stays bounded and a sample cannot displace a full rare window', () => {
  const buffer = createDiagnosticsBuffer({ limit: 3, rateLimitMs: 0 });
  for (let i = 0; i < 4; i++) buffer.record('tour', { i });
  const rare = buffer.all();
  assert.deepEqual(rare.map(entry => entry.detail.i), [1, 2, 3]);
  buffer.record('frame-rate', { fps: 72 });
  assert.deepEqual(buffer.all(), rare);
  assert.equal(buffer.dropped(), 2);
  buffer.clear();
  assert.equal(buffer.size(), 0);
  assert.equal(buffer.dropped(), 0);
  assert.deepEqual(buffer.pending(), []);
  buffer.record('frame-rate', { fps: 71 });
  assert.equal(buffer.pending()[0].seq, 6);
});

test('acknowledged rare traffic makes room for new frame samples', () => {
  const buffer = createDiagnosticsBuffer({ limit: 3, rateLimitMs: 0 });
  buffer.record('render-operation-cost', { i: 0 });
  buffer.record('voice-command', { i: 1 });
  buffer.record('tour', { i: 2 });
  buffer.acknowledge(3);

  buffer.record('frame-rate', { fps: 72 });
  buffer.record('frame-cost', { frameMs: 4 });

  assert.deepEqual(buffer.pending().map(entry => entry.kind), ['frame-rate', 'frame-cost']);
  assert.equal(buffer.all().filter(entry => entry.kind === 'frame-rate').length, 1);
  assert.equal(buffer.all().filter(entry => entry.kind === 'frame-cost').length, 1);
  assert.equal(buffer.dropped(), 2);
});

test('an unacknowledged rare record remains protected from a frequent overflow', () => {
  const buffer = createDiagnosticsBuffer({ limit: 3, rateLimitMs: 0 });
  buffer.record('tour', { i: 0 });
  buffer.record('voice-command', { i: 1 });
  buffer.record('render-operation-cost', { i: 2 });
  buffer.acknowledge(1);
  buffer.record('component-label-layout', { i: 3 });

  buffer.record('frame-rate', { fps: 72 });

  assert.deepEqual(buffer.all().map(entry => entry.kind), ['voice-command', 'render-operation-cost', 'component-label-layout']);
  assert.deepEqual(buffer.pending().map(entry => entry.kind), ['voice-command', 'render-operation-cost', 'component-label-layout']);
});


test('controller event diagnostics distinguish hand skeletons from pose tracking', () => {
  const session = new EventTarget(), events = [];
  const stop = watchSessionInput(session, (kind, detail) => events.push({ kind, detail }));
  session.dispatchEvent(Object.assign(new Event('squeezestart'), { inputSource: {
    handedness: 'right', targetRayMode: 'tracked-pointer', gripSpace: {} } }));
  assert.deepEqual(events[0], { kind: 'xr-squeezestart', detail: {
    hand: 'right', ray: 'tracked-pointer', handTracking: false, gripSpace: true } });
  assert.equal('tracked' in events[0].detail, false, 'event identity must not imply unavailable controller pose');
  stop();
});
