/**
 * A plain structure, opened with no lesson, enters VR at the same size a
 * demo's first chapter does.
 *
 * Opening 9NOV (the sweet taste receptor's two VFT domains) and entering VR
 * seated it 15 degrees across in a 90 degree view. The resting card naming it
 * stood above the menu column and grew inboard to five degrees from the gaze,
 * and the entry seat, which keeps the subject centred and clears every plate,
 * shrank the structure until it fitted under that card's corner. The card now
 * takes the chapter card's forward seat above the subject.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT, toolbarPlatePoints, toolbarSeatBasis } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { tourReadout } from './spatial-toolbar.mjs';
import { structureDescriptionPages } from './structure-subject.mjs';
import { placementFromRoom } from './room-anchor.mjs';
import { resetViewPlacement } from './reset-view-placement.mjs';

const advances = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url))).advances;
const toolbarTextWidth = text => [...text].reduce((sum, glyph) => sum + (advances[glyph] ?? .6), 0);

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const HEAD_IN_ROOM = [...IDENTITY.slice(0, 12), 0, 1.6, 0, 1];
const HEAD = { matrix: HEAD_IN_ROOM, position: { x: 0, y: 1.6, z: 0 } };
const RECEPTOR = { title: 'Human sweet taste receptor (TAS1R2 + TAS1R3) VFT domains bound to sucralose',
  pdbId: '9NOV', chains: 2, assembly: 'asymmetric_unit', representation: 'cartoon', color: 'chain-id', selectionCount: 0 };
const HEMOGLOBIN = { title: 'THE CRYSTAL STRUCTURE OF HUMAN DEOXYHAEMOGLOBIN AT 1.74 ANGSTROMS RESOLUTION',
  pdbId: '4HHB', chains: 4, assembly: 'asymmetric_unit', representation: 'cartoon', color: 'chain-id', selectionCount: 0 };

const KINESIN = { ...RECEPTOR, pdbId: '3KIN', title: 'Kinesin (dimeric) from human', chains: 4 };

/** The compact menu and resting card a plain structure draws on entry, in room metres. */
function restingPanel(subject, tour) {
  const rows = spatialToolbarRows({ voice: { state: 'idle' }, passthrough: true, passthroughSupported: true,
    appearance: { representation: 'cartoon' }, readout: { descriptionPageCount: structureDescriptionPages(subject).length } });
  return createToolbarPanel({ rows, head: HEAD, constants: SPATIAL_TOOLBAR_LAYOUT, measureText: toolbarTextWidth,
    readout: tourReadout(tour, subject), status: '' });
}

/** Degrees off the forward axis, across and up, of each point of one plate. */
function degreesOf(points) {
  const { origin } = toolbarSeatBasis(HEAD);
  return points.map(([x, y, z]) => {
    const depth = origin[2] - z;
    return [Math.atan2(x - origin[0], depth) * 180 / Math.PI, Math.atan2(y - origin[1], depth) * 180 / Math.PI];
  });
}

/** The entry seat a 90 A structure gets beside this glass, as the page solves it. */
function entrySeatDegrees(panel) {
  const frame = { headInRoom: HEAD_IN_ROOM, renderFromRoom: IDENTITY, cameraScale: 0.02, center: [0, 0, 0], radius: 45 };
  const seat = placementFromRoom({ ...frame, mode: 'above' });
  const points = toolbarPlatePoints(panel);
  const placed = resetViewPlacement({ ...frame, seat, fit: true, recoverVisible: true, points });
  const roomPoint = placed.translation.map(value => value * frame.radius * frame.cameraScale);
  const distance = Math.hypot(roomPoint[0], roomPoint[1] - 1.6, roomPoint[2]);
  const radius = frame.radius * frame.cameraScale * placed.scale;
  return { across: 2 * Math.asin(Math.min(1, radius / distance)) * 180 / Math.PI,
    lateral: Math.atan2(roomPoint[0], -roomPoint[2]) * 180 / Math.PI };
}

test('a plain structure enters VR as large as a first chapter, centred', () => {
  for (const subject of [RECEPTOR, HEMOGLOBIN, KINESIN]) {
    const seat = entrySeatDegrees(restingPanel(subject));
    // A demo's first chapter measures 40 to 60 degrees across in the same view.
    assert.ok(seat.across >= 34, `${subject.pdbId} seats ${seat.across.toFixed(1)} degrees across`);
    assert.ok(Math.abs(seat.lateral) <= 8, `${subject.pdbId} stays centred (${seat.lateral.toFixed(1)} degrees)`);
  }
});

test('the resting card stands above the subject, clear of its centre', () => {
  const panel = restingPanel(RECEPTOR);
  const card = degreesOf(toolbarPlatePoints(panel).plates[0]);
  // Above a 40 degree subject seated six degrees up, and across the gaze.
  assert.ok(Math.min(...card.map(([, up]) => up)) >= 27, 'the card floor clears the subject');
  assert.ok(Math.min(...card.map(([across]) => across)) < 0 && Math.max(...card.map(([across]) => across)) > 0,
    'the card is centred over the subject');
  // Its lines still name the structure.
  const text = panel.readoutPoints.map(line => line.text).join(' ');
  assert.match(text, /9NOV · 2 chains/u);
  assert.match(text, /cartoon by chain/u);
});

test('the chooser and a lesson keep their own cards', () => {
  const chooser = tourReadout({ menuOpen: true, selectedTitle: 'Hemoglobin' }, RECEPTOR);
  assert.ok(chooser.every(line => line.forwardViewCap !== true));
  const chapter = tourReadout({ selectedId: 'hb', active: true, step: 0, total: 6, title: 'Wide reveal', bodyPage: 'Four chains.' }, RECEPTOR);
  assert.ok(chapter.every(line => line.forwardViewCap !== true));
  assert.equal(chapter[0].forwardView, true);
});

// Source replacement reports navigating while no lesson is selected. Its
// upcoming information card must be the same card used to solve the new seat.
test('a plain source swap keeps the forward card while loading', () => {
  const loading = { selectedId: null, active: false, navigating: true };
  assert.deepEqual(tourReadout(loading, HEMOGLOBIN), tourReadout(undefined, HEMOGLOBIN));
  assert.ok(entrySeatDegrees(restingPanel(HEMOGLOBIN, loading)).across >= 34);
});
