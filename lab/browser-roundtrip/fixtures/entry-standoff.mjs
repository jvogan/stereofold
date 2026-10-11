import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { entryMenuSeat } from '../entry-menu-seat.mjs';
import { measureEntryStandoff } from '../entry-standoff.mjs';
import { toolbarLayoutForDepthRange, toolbarLayoutForStandoff } from '../spatial-toolbar-geometry.mjs';
import { identity, syntheticViews } from './component-label-diagnostics.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');

export function entryGeometry() {
  const object = { state: { visible: true }, values: Object.fromEntries(Object.entries({
    drawCount: 12, instanceCount: 1, aTransform: identity(),
    // Lit rectangle, then a faded fringe crossing the menu's inboard edge.
    aPosition: [-.4, -.2, -2, .4, -.2, -2, .4, .2, -2, -.4, .2, -2,
      -1, -.2, -2, -.4, -.2, -2, -.4, .2, -2, -1, .2, -2],
    aGroup: [0, 0, 0, 0, 1, 1, 1, 1], uGroupCount: 2,
    dTransparency: true, dTransparencyType: 'groupInstance',
    tTransparency: { array: new Uint8Array([0, 230]) }, uTransparencyStrength: 1,
  }).map(([key, value]) => [key, { ref: { value } }])) };
  return { objects: [object], cameraScale: 1, views: syntheticViews(), renderFromRoom: identity(),
    menuPoints: [[-.8, -.2, -1], [-.4, -.2, -1], [-.4, .2, -1], [-.8, .2, -1]] };
}

/**
 * The page's frame-loop entry producer, executed from its
 * production source under strict closure bindings: `recordEntryStandoff` in
 * viewer.mjs measures the drawn menu against the lit silhouettes once per
 * room entry and records `plate-standoff` through `recordCost`.
 */
export function entryStandoffHarness(recordCost) {
  const source = read('../viewer.mjs');
  const start = source.indexOf('  function recordEntryStandoff(');
  assert.ok(start >= 0, 'the viewer must produce measured entry plate-standoff evidence');
  assert.match(source, /recordEntryStandoff\(pose, roomFromRender\.inverse\.matrix\)/);
  const geometry = entryGeometry();
  const context = vm.createContext({ measureEntryStandoff, recordCost,
    roomEntry: {}, pendingRoomSeat: false, pendingRoomLabels: false, settlingRoomAnchor: null,
    busy: false, state: { status: 'ready', tour: { selectedId: 'demo', active: false, step: -1 } },
    canvas: { xr: { isPresenting: { value: true } }, camera: { scale: geometry.cameraScale } },
    representation: { obj: { data: { repr: { renderObjects: geometry.objects } } } }, ligandOverlay: null,
    immersiveSession: { drawnMenuPoints: () => geometry.menuPoints },
  });
  vm.runInContext('"use strict";\n' + source.slice(start, source.indexOf('\n  }', start) + 4), context);
  return { context, geometry, frame: () => context.recordEntryStandoff({ views: geometry.views }, geometry.renderFromRoom) };
}

/**
 * The page's entry clearance producer, executed from its
 * production sources under strict closure bindings.
 *
 * Two slices are cut at every run: `getEntryGeometry`, the property
 * viewer.mjs hands the immersive session (committed render objects, camera
 * scale, the latest placement pose's eye views and room transform), and
 * `seatEntryMenu`, the toolbar closure that measures through that provider
 * when the entry seat latches and records `plate-standoff`. Nothing is
 * re-implemented here, so a producer that moves, stops passing the geometry
 * or stops recording the shared measurement fails these assertions before any
 * test reads a record. `records` collects what the producer wrote.
 */
export function entryProducerHarness({ geometry = entryGeometry(), head, rows = [], tourReadout = () => [],
  getState = () => ({ tour: { selectedId: 'demo', active: false, step: -1 } }),
  seatedStandoff = 0, depthRange = {}, toolbarTextWidth = text => text.length * .6 } = {}) {
  const viewer = read('../viewer.mjs'), toolbar = read('../spatial-toolbar.mjs'), session = read('../immersive-session.mjs');
  const providerStart = viewer.indexOf('      getEntryGeometry: () => ({');
  assert.ok(providerStart >= 0, 'viewer.mjs must supply getEntryGeometry to the immersive session');
  const providerEnd = viewer.indexOf('\n      }),', providerStart);
  assert.ok(providerEnd > providerStart, 'the provider is one object property');
  const provider = viewer.slice(providerStart, providerEnd + '\n      }),'.length);
  assert.match(session, /createSpatialToolbar\(\{[\s\S]{0,600}?\bgetEntryGeometry\b/,
    'immersive-session.mjs must hand getEntryGeometry to the toolbar');
  const producerStart = toolbar.indexOf('  function seatEntryMenu() {');
  assert.ok(producerStart >= 0, 'spatial-toolbar.mjs must produce the entry plate-standoff record');
  const producer = toolbar.slice(producerStart, toolbar.indexOf('\n  }', producerStart) + 4);
  assert.match(producer, /entryMenuSeat\(\{[^}]*geometry: getEntryGeometry\(\)/,
    'the producer measures the committed geometry through the provider');
  assert.match(producer, /record\?\.\('plate-standoff', \{ \.\.\.seat\.measured, phase: 'entry'/,
    'the producer records the shared per-eye measurement');
  const page = vm.createContext({
    representation: { obj: { data: { repr: { renderObjects: geometry.objects } } } }, ligandOverlay: null,
    canvas: { camera: { scale: geometry.cameraScale } },
    latestRoomPlacementPose: { labelViews: geometry.views, renderFromRoom: geometry.renderFromRoom },
  });
  const getEntryGeometry = vm.runInContext('"use strict";\n({' + provider + '}).getEntryGeometry', page);
  const records = [];
  // The entry seat no longer reads `notice`, so the strict
  // producer binds only what the merged closure uses.
  const context = vm.createContext({
    committedDepthRange: depthRange, toolbarLayoutForStandoff, toolbarLayoutForDepthRange, seatedStandoff,
    entryMenuSeat, toolbarTextWidth, rows: () => rows, entryHead: head, getEntryGeometry, tourReadout, getState,
    __stereofoldDiagnostics: { record: (kind, detail) => records.push({ kind, detail }) },
  });
  vm.runInContext('"use strict";\n' + producer, context);
  return { records, getEntryGeometry, page, seat: () => context.seatEntryMenu() };
}
