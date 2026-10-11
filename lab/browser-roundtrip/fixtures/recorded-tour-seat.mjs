import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { tourEndHarness } from './tour-end-harness.mjs';
import { toolbarFrameRuntime, identity } from './toolbar-frame-runtime.mjs';
import { replayOptionsFromLayoutRecord } from './layout-replay.mjs';
import { layoutComponentPlates } from '../label-layout.mjs';
import { installSpatialMenuHook } from '../spatial-menu-hook.mjs';
import { entryGeometry } from './entry-standoff.mjs';
import { createMenuResolve } from '../menu-resolve.mjs';
import { menuLayoutHarness } from './label-action-harness.mjs';

export const recordedEndings = JSON.parse(readFileSync(new URL('./acceptance-6-tour-end.json', import.meta.url)));
const page = readFileSync(new URL('../viewer.mjs', import.meta.url), 'utf8');
const sessionSource = readFileSync(new URL('../immersive-session.mjs', import.meta.url), 'utf8');
const closure = (source, name) => {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  return start < 0 ? '' : source.slice(start, source.indexOf('\n  }', start) + 4);
};

// Recorded anchors and action times drive the scene/depth boundary. The GPU
// adapter uses 0.01 metres per replay scene unit, as in the page VM harnesses;
// this tests restoration ordering, not a reconstruction of headset pixels.
export async function recordedTourSeat(mountTourPlayer, tour) {
  const runtime = await toolbarFrameRuntime();
  const h = tourEndHarness();
  const player = mountTourPlayer({ ...h, tours: [tour] });
  const layouts = recordedEndings.completed.entries.filter(e => e.kind === 'component-label-layout');
  const baselineLayout = layouts[0].detail;
  let depthLayout = baselineLayout;
  const geometry = entryGeometry(); // GPU-only adapter for the live clearance producer
  geometry.objects[0].values.aTransform.ref.value[13] = 1.6;
  for (const view of geometry.views) view.transform.inverse.matrix[13] = -1.6;
  const frame = { getViewerPose: () => ({ transform: { position: { x: 0, y: 1.6, z: 0 }, matrix: identity } }) };
  const session = Object.assign(new EventTarget(), { inputSources: [],
    requestAnimationFrame: cb => { queueMicrotask(() => cb(0, frame)); return 1; }, cancelAnimationFrame() {} });
  const toolbar = runtime.createSpatialToolbar({ plugin: { runTask: task => task.run() }, canvas: {}, session, space: {}, Mat4: {},
    presentation: { add() {}, remove() {}, update() {}, setVisible() {}, roomMatrix: () => identity },
    getMolecularBounds: () => ({ center: [0, 1.6, -3], radius: .1 }), getEntryGeometry: () => geometry,
    getDepthRange: () => ({ near: Math.min(...depthLayout.anchors.map(a => a.z - a.r)) * .01,
      far: Math.max(...depthLayout.anchors.map(a => a.z + a.r)) * .01 }),
    getState: () => ({ tour: player.getState(), voice: { state: 'idle' } }),
    onAction: action => action.kind === 'tour-done' ? h.dispatchDone(player) : undefined,
    onActionError: error => { throw error; } });
  // Run the production page and session seams. The empty baseline closure is
  // intentional: at 396595e the player never requests a column restoration.
  const options = replayOptionsFromLayoutRecord(baselineLayout);
  const subject = options.subject;
  subject.points = [-1, 1].flatMap(x => [-1, 1].map(y =>
    [subject.x + x * subject.halfWidth, subject.y + y * subject.halfHeight, -1]));
  const labels = await menuLayoutHarness(options);
  labels.records.length = 0;
  const restore = h.workspace.viewer.inspection.restore;
  h.workspace.viewer.inspection.restore = async (...args) => {
    await restore(...args);
    // Model the representation-change notice while the snapshot is painting.
    // The production refresh must cancel this pending menu solve at the end.
    resolver.moved({ points: toolbar.menuPoints(), reason: 'grow' });
    await labels.session.relayout('scene');
  };
  h.workspace.viewer.inspection.batchComponentLabels = operation => labels.session.transaction(operation);
  const context = vm.createContext({ immersiveSession: {}, active: { toolbar },
    spatialTour: undefined, detachSpatialTour: undefined,
    menuResolveFor: () => resolver, menuPoints: toolbar.menuPoints,
    labelMeasurementGate: { invalidate() {} }, componentLabelsWanted: () => true,
    componentLabels: labels.session, menuResolveReason: null });
  const resolver = createMenuResolve({ solve: reason => { void labels.session.relayout(reason); } });
  vm.runInContext('"use strict";\n' + closure(sessionSource, 'refreshToolbar'), context);
  context.immersiveSession.refreshToolbar = context.refreshToolbar;
  vm.runInContext('"use strict";\n' + closure(page, 'restoreTourSeat'), context);
  vm.runInContext('"use strict";\n' + closure(page, 'setSpatialTour'), context);
  h.workspace.viewer.inspection.restoreTourSeat = () => context.restoreTourSeat?.();
  const detach = installSpatialMenuHook({ readRows: toolbar.rows, runAction: toolbar.runAction });
  await h.install(tour); await player.select(tour.id); await toolbar.update();
  context.setSpatialTour(player);
  await toolbar.update();
  const baseline = { scene: h.capture(), column: toolbar.menuRows(), head: toolbar.head() };
  return { ...h, player, toolbar, baseline, runtime, labels,
    async scene(record) {
      const previous = recordedEndings[record.reason ?? 'completed'].entries;
      depthLayout = previous.filter(e => e.kind === 'component-label-layout' && e.seq < record.seq).at(-1)?.detail ?? baselineLayout;
      await toolbar.update();
    },
    replayResting() {
      const options = replayOptionsFromLayoutRecord(baselineLayout);
      const result = layoutComponentPlates(options);
      assert.equal(result.overlaps, 0);
      assert.equal(result.subjectOverlaps, 0);
    },
    captureSeat: () => ({ scene: h.capture(), column: toolbar.menuRows(), head: toolbar.head() }),
    cleanup: async () => { detach(); context.detachSpatialTour?.(); resolver.dispose(); player.pause(); await toolbar.dispose(); h.cleanup(); },
  };
}
