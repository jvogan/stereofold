import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { identity, syntheticViews } from './component-label-diagnostics.mjs';
import { toolbarFrameHarness } from './toolbar-frame-runtime.mjs';
import { pageFunction } from './label-action-harness.mjs';
import { applyMatrix4 } from '../room-lock.mjs';
import { resetViewPlacement } from '../reset-view-placement.mjs';
import { measureEntryStandoff } from '../entry-standoff.mjs';
import { journeySeatDetail } from '../journey-seat-record.mjs';

// A device run's normalized placement, from retained captures and drive
// summaries, but no plate-standoff entries or historical eye/mesh buffers.
// Use production toolbar geometry with a synthetic held menu/head relation
// and a 300px-wide silhouette. These are not recovered device matrices.
export const devicePlacement = { translation: [-5.270927385697206, .45333535809615233, 5.4901951036159575],
  rotation: [0, 0, 0], scale: 1.0325166955716267 };
const cell = value => ({ ref: { value } });
const matrixFor = placement => {
  const m = identity(); m[0] = m[5] = m[10] = placement.scale;
  m.splice(12, 3, ...placement.translation); return m;
};
export async function deviceDoneClearance({ runtime, getPlacement, setPlacement, beforeMenuDraw = async () => {}, placement = devicePlacement }) {
  const renderFromRoom = identity();
  renderFromRoom.splice(12, 3, ...placement.translation.map((v, i) => v - [0, 1.6, -4][i]));
  const headInRoom = identity(); headInRoom[13] = 1.6;
  const views = syntheticViews().map(view => {
    for (let i = 0; i < 3; i++) {
      view.transform.matrix[12 + i] += renderFromRoom[12 + i] + (i === 1 ? 1.6 : 0);
      view.transform.inverse.matrix[12 + i] = -view.transform.matrix[12 + i];
    }
    return view;
  });
  const objects = () => [{ type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(36), instanceCount: cell(1), aTransform: cell(matrixFor(getPlacement())),
    aPosition: cell([-.6, .6].flatMap(x => [-.3, .3].flatMap(y => [-.1, .1].flatMap(z => [x, y, z])))),
  } }];
  const geometry = () => ({ objects: objects(), views, cameraScale: 1, renderFromRoom });
  const subject = { title: 'Hemoglobin tetramer', pdbId: '4HHB', chains: 4, representation: 'molecular-surface', color: 'chain-id' };
  const live = toolbarFrameHarness(runtime, { getEntryGeometry: geometry,
    bounds: { center: [0, 1.6, -4], radius: .65 }, state: { subject } });
  // The menu remains at its previously drawn seat while the current head is
  // 20cm to its right. Done measures its completed glass on the held anchor.
  live.moveHead(-.2); await live.toolbar.update();
  const roomEntry = {}, moves = [];
  let frameTime = Date.now();
  const context = vm.createContext({ structuredClone, Mat4, applyMatrix4, resetViewPlacement,
    cameraSnapshot: value => value, roomEntry, entryRoomPoint: undefined,
    canvas: { xr: { isPresenting: { value: true } }, camera: { scale: 1 } },
    latestRoomPlacementPose: { headInRoom, renderFromRoom, labelViews: views },
    loadedSphere: () => ({ center: [0, 0, 0], radius: 1 }),
    inspectionSnapshot: () => ({ placement: getPlacement() }),
    retainedPoseHidden: false,
    scientificRepresentations: () => [{ renderObjects: objects() }],
    presentationTransform: () => matrixFor(getPlacement()), placementTransform: matrixFor,
    immersiveSession: { platePoints: () => live.toolbar.platePoints(),
      toolbarPlacementPoints: options => live.toolbar.placementPoints(options),
      // The one build of the upcoming panel that the solver measures
      // and the `journey-seat` record describes.
      toolbarPlacementPreview: options => live.toolbar.placementPreview(options),
      toolbarRows: () => live.toolbar.rows(), toolbarReadoutText: () => live.toolbar.readoutText(),
      toolbarHead: () => live.toolbar.head(), toolbarLayout: () => live.toolbar.layout(),
      isMenuCollapsed: () => live.toolbar.isCollapsed(),
      drawnMenuPoints: () => live.toolbar.drawnMenuPoints() },
    placeInspection: async patch => { moves.push(patch); setPlacement({ ...getPlacement(), ...patch }); },
    seatStructureForEntry: async () => { throw Error('A saved clear view must not use entry fitting.'); },
    restoreTourSeat: async options => { await beforeMenuDraw(); await live.toolbar.update({ restoreTourSeat: true, ...options }); },
  });
  context.journeySeatDetail = journeySeatDetail;
  const viewerSource = readFileSync(new URL('../viewer.mjs', import.meta.url), 'utf8');
  for (const name of ['restoreJourneySeat', 'recordJourneySeat']) vm.runInContext(pageFunction(viewerSource, name), context);
  return { context, moves, roomEntry,
    measure: () => measureEntryStandoff({ ...geometry(), menuPoints: live.toolbar.platePoints() }),
    seatAnchor: () => live.toolbar.seatAnchor(),
    moveChapterMenu: async offset => {
      live.moveHead(offset); await live.toolbar.update({ recenter: true, origin: 'wearer' }); live.moveHead(-.2);
      // Advance the pose sampler's clock; repeated runs must not reuse the
      // previous chapter's head sample through its existing 250 ms throttle.
      const now = Date.now; frameTime = Math.max(frameTime, now()) + 300;
      Date.now = () => frameTime;
      try { await live.frames(1); } finally { Date.now = now; }
    },
    setTour: async tour => { live.setState({ subject, tour }); await live.toolbar.update(); },
    chapter: async step => { live.setState({ subject, tour: { active: true, step, title: 'Hemoglobin', progress: `Scene ${step + 1}` } }); await live.toolbar.update(); },
    restore: async scene => context.restoreJourneySeat({ scene }),
    dispose: () => live.toolbar.dispose() };
}
