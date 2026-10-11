import assert from 'node:assert/strict';
import test from 'node:test';
import { toolbarFrameRuntime, toolbarFrameHarness, identity } from './fixtures/toolbar-frame-runtime.mjs';
import { watchFrameCost } from './xr-render-budget.mjs';
import { toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';
import { ENTRY_SUBJECT_LENS } from './entry-menu-seat.mjs';
import { lensRect, lensRectFromPoints, lensRectsOverlap, PLATE_CLEARANCE_LENS } from './plate-standoff.mjs';

test('the published quiet Menu row opens a real figure appearance control before style selection', async () => {
  const runtime = await toolbarFrameRuntime();
  const h = toolbarFrameHarness(runtime, { state: {
    voice: { state: 'idle' }, appearance: { representation: 'cartoon' }, lessonFigure: { layers: [{}] },
    representations: ['cartoon', 'spacefill', 'molecular-surface'],
    tour: { active: true, autoplay: true, selectedId: 'lesson-daraxonrasib', canNext: true, step: 0, total: 2 },
  } });
  try {
    await h.toolbar.update();
    assert.deepEqual(h.toolbar.rows().map(row => row.label), ['Talk', 'Pause', 'Next', 'Menu']);
    assert.equal(h.toolbar.aimSynthetic({ id: 'appearance' }).fired, false, 'style has no quiet drawn target');
    const opened = h.toolbar.aimSynthetic({ id: 'menu' });
    assert.equal(opened.hitLabel, 'Menu');
    assert.equal(opened.fired, true, opened.reason);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.toolbar.isCollapsed(), false);
    const rows = h.toolbar.rows();
    assert.ok(rows.some(row => row.action?.kind === 'collapse' && row.action.value === true));
    assert.ok(rows.some(row => row.action?.kind === 'appearance-cycle'));
    const style = h.toolbar.aimSynthetic({ id: 'appearance' });
    assert.equal(style.hitLabel, 'Figure');
    assert.equal(style.fired, true, style.reason);
  } finally { await h.toolbar.dispose(); }
});

test('steady XR frames do not rebuild geometry or compare menu footprints', async t => {
  const runtime = await toolbarFrameRuntime();
  let ready = false, solves = 0;
  const timers = new Map();
  const resolver = runtime.createMenuResolve({ solve: () => { solves++; }, now: () => 0,
    schedule: fn => { timers.set(fn, fn); return fn; }, cancel: fn => timers.delete(fn) });
  const flush = () => { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); };
  const h = toolbarFrameHarness(runtime, { onRepresentationChange: count => {
    if (ready && count > 0) resolver.moved({ points: h.toolbar.menuPoints(), reason: h.toolbar.menuMotion() });
  } });
  try {
    await h.toolbar.update();
    assert.ok(h.toolbar.drawnMenuPoints().length > 0, 'the first explicit update commits the head-dependent seat');
    assert.equal(runtime.counts.getDepthRange, 1, 'entry measurement and drawing share captured depth inputs');
    const basis = toolbarSeatBasis(h.toolbar.head());
    const drawn = lensRectFromPoints({ points: h.toolbar.drawnMenuPoints(), origin: basis.origin, basis });
    const subject = lensRect({ x: 0, y: 0, halfWidth: ENTRY_SUBJECT_LENS, halfHeight: ENTRY_SUBJECT_LENS });
    // Compact entry is intentionally peripheral: central molecular framing
    // stays clear and the wearer turns left to read the full panel.
    assert.equal(lensRectsOverlap(drawn, subject, PLATE_CLEARANCE_LENS), false);
    assert.ok(drawn.right < 0, 'the actual glass remains left of the subject');
    resolver.seed(h.toolbar.menuPoints());
    ready = true;
    for (const state of [{}, { tour: { selectedId: 'test', active: true, step: 1, total: 3,
      captionCard: 'hidden', bodyPageCount: 2, bodyPageIndex: 0 } }]) {
      h.setState(state); await h.toolbar.update(); flush();
      const beforeSolves = solves;
      h.toolbar.depthRange(h.frame); // The new committed panel prepares its local slab once.
      runtime.reset();
      await h.frames(); flush();
      assert.equal(runtime.counts.syncPose, 72);
      assert.equal(runtime.counts.depthRange, 72);
      for (const name of ['update', 'createToolbarPanel', 'toolbarMenuPoints', 'toolbarDrawnMenuPoints',
        'menuFootprintSignature', 'fullDrawPanel', 'ShapeRepresentation', 'toolbarPlateOutline', 'toolbarBackingOutline']) {
        assert.equal(runtime.counts[name] ?? 0, 0, `${name} must stay off steady frames`);
      }
      assert.equal(runtime.counts.getDepthRange ?? 0, 0, 'depth/layout inputs must stay off steady frames');
      assert.equal(solves, beforeSolves);
      t.diagnostic(JSON.stringify({ frames: 72, counts: runtime.counts }));
    }

    const seated = h.toolbar.menuPoints(), beforeStatus = solves;
    runtime.reset();
    await h.toolbar.setStatus('Smaller.'); flush();
    assert.equal(runtime.counts.createToolbarPanel ?? 0, 0, 'talk-card status must not rebuild unchanged menu geometry');
    assert.equal(runtime.counts.menuFootprintSignature ?? 0, 0, 'unchanged glass needs no resolver invalidation');
    assert.deepEqual(h.toolbar.menuPoints(), seated);
    assert.equal(solves, beforeStatus, 'status text must not nudge plates');
    await h.toolbar.setStatus(''); flush();

    h.moveHead(.3); h.toolbar.unlatchSeat('menu');
    await h.toolbar.update({ origin: 'wearer' }); flush();
    assert.notDeepEqual(h.toolbar.menuPoints(), seated);
    assert.equal(solves, beforeStatus + 1, 'a real menu move still re-solves');
    runtime.reset();
    await h.frames(); flush();
    assert.equal(runtime.counts.menuFootprintSignature ?? 0, 0);
    assert.equal(runtime.counts.createToolbarPanel ?? 0, 0);
    assert.equal(solves, beforeStatus + 1);

    // A hidden redraw still reports representation counts, but the old label
    // obstacle stays reserved until reveal. Even an unchanged-pose explicit
    // reseat is owed exactly one solve, after all hidden redraws settle.
    h.toolbar.setHidden(true);
    h.toolbar.unlatchSeat('menu'); await h.toolbar.update({ origin: 'wearer' }); flush();
    await h.toolbar.setStatus('Smaller.'); flush();
    assert.equal(solves, beforeStatus + 1, 'hidden reseats must not solve the old obstacle');
    h.toolbar.setHidden(false); flush();
    assert.equal(solves, beforeStatus + 2, 'reveal preserves the explicit reseat through a status redraw');
    h.toolbar.setHidden(true); h.toolbar.setHidden(false); flush();
    assert.equal(solves, beforeStatus + 2, 'a later reveal must not replay the last reseat');
  } finally { resolver.dispose(); await h.toolbar.dispose(); }
});

test('menu depth reuses exact local outlines while projecting both current eyes and rebuilding for a new panel', async () => {
  const runtime = await toolbarFrameRuntime();
  const h = toolbarFrameHarness(runtime, { state: { subject: { title: 'A custom local structure' } } });
  try {
    await h.toolbar.update(); runtime.reset();
    const first = h.toolbar.depthRange(h.frame);
    assert.ok(first && runtime.counts.toolbarPlateOutline > 0 && runtime.counts.toolbarBackingOutline > 0,
      'first measurement uses actual committed button and backing outlines');
    const outlines = runtime.counts.toolbarPlateOutline, backings = runtime.counts.toolbarBackingOutline;
    for (let i = 0; i < 72; i++) assert.deepEqual(h.toolbar.depthRange(h.frame), first);
    assert.equal(runtime.counts.toolbarPlateOutline, outlines);
    assert.equal(runtime.counts.toolbarBackingOutline, backings);
    const pose = h.frame.getViewerPose;
    h.frame.getViewerPose = () => ({ ...pose(), views: [.15, -.2].map(z => {
      const matrix = [...identity]; matrix[14] = z;
      return { transform: { inverse: { matrix } } };
    }) });
    const movedEyes = h.toolbar.depthRange(h.frame);
    assert.ok(Math.abs(movedEyes.near - (first.near - .15)) < 1e-9, 'near uses the nearer current eye');
    assert.ok(Math.abs(movedEyes.far - (first.far + .2)) < 1e-9, 'far uses the farther current eye');
    assert.equal(runtime.counts.toolbarPlateOutline, outlines, 'eye movement never rebuilds local geometry');
    assert.equal(runtime.counts.toolbarBackingOutline, backings);
    await h.toolbar.setStatus('Sending', undefined, 'sending');
    assert.deepEqual(h.toolbar.depthRange(h.frame), movedEyes);
    assert.equal(runtime.counts.toolbarPlateOutline, outlines, 'talk-card feedback keeps the same committed panel cache');
    h.setState({ subject: { title: 'A custom local structure' }, tour: { selectedId: 'local', active: true,
      step: 0, total: 2, title: 'First chapter', body: 'A source-backed molecular description.' } });
    await h.toolbar.update(); runtime.reset();
    const newRange = h.toolbar.depthRange(h.frame);
    assert.ok(newRange && runtime.counts.toolbarPlateOutline > 0 && runtime.counts.toolbarBackingOutline > 0,
      'a real committed chapter redraw invalidates the old local points');
    runtime.reset(); assert.deepEqual(h.toolbar.depthRange(h.frame), newRange);
    assert.equal(runtime.counts.toolbarPlateOutline ?? 0, 0);
    assert.equal(runtime.counts.toolbarBackingOutline ?? 0, 0);
    await h.toolbar.dispose();
    assert.equal(h.toolbar.depthRange(h.frame), undefined, 'closed menu contributes no clipping band');
  } finally { await h.toolbar.dispose(); }
});

test('frame-cost counts animation callbacks rather than eyes or unique XR frames', async () => {
  const runtime = await toolbarFrameRuntime();
  const callbacks = [], records = [];
  let time = 0, poseSyncs = 0;
  const session = { requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; } };
  const observer = runtime.installFrameProbe({ toolbar: {
    syncPose: () => { poseSyncs++; }, syncInput() {},
  } }, session, {});
  const cost = watchFrameCost({ session, now: () => time, record: (kind, detail) => records.push({ kind, ...detail }) });
  try {
    // Render, motion, and a scheduled receipt can share one native XR frame.
    // The observer and diagnostics wrap each subscriber, independently of eyes.
    for (let index = 0; index < 3; index++) session.requestAnimationFrame(() => {});
    const frame = { getViewerPose: () => ({ views: [{}, {}] }) };
    callbacks.forEach((callback, index) => { time = (index + 1) * 1000 / 3; callback(42, frame); });
    assert.equal(poseSyncs, 1, 'menu input runs once for the shared XR timestamp');
    assert.equal(records.length, 1);
    assert.equal(records[0].callbackCount, 3);
    assert.equal(records[0].callbacksPerSecond, 3);
    assert.equal('fps' in records[0], false);
    assert.equal('frames' in records[0], false);
  } finally { cost.stop(); observer.restore(); }
});
