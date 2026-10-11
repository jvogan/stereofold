/**
 * The Mac's own panel saving a scene on a density session.
 *
 * A density run started with
 * `pnpm --dir plugin run demo microtubule-growth --stage filament` never
 * reached the headset. The host printed
 *
 *   Waiting for the panel to render and save · 120s
 *     still loading · 32s/63s/95s
 *   Timed out after 120s waiting for the panel to save a scene.
 *
 * and the reproduction — the real standalone host, the real 8.39 MB map, the
 * page driven in headless Chromium — put the reason on the wire:
 *
 *   POST /rpc sync_inspection -> 409
 *   {"error":"The inspection must match this exact density map."}
 *
 * A density session has two renderers and they draw different bytes. Only a
 * companion fetches `/density`, because 8.4 MB of binary cannot ride inside the
 * JSON hydration a desktop panel is handed; the Mac's panel draws the seed
 * coordinates the session opened beside. Teaching the host to admit the map's
 * identity made every scene the desktop could save illegal. The panel blocked,
 * `attach()` is guarded on `!blocked`, and the host's wait was for a panel
 * nothing was going to register.
 *
 * `density-scene-identity.test.ts` holds the rule in isolation. This one plays
 * the sequence: open a volume lesson with a prepared map, read the hydration a
 * DESKTOP panel gets, save the scene that hydration describes, and attach.
 * Then the same for the headset's map scene on the same session, because the
 * fix must not cost the map-identity check anything.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { syntheticMap } from './synthetic-map.js';
// @ts-ignore Shared JavaScript density module: the page's own derivation.
import { volumeSceneIdentity } from '../../lab/browser-roundtrip/volume-source.mjs';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const map = syntheticMap();
const mapSha256 = createHash('sha256').update(map).digest('hex');
const CONTOUR = 3.3;

/** A volume lesson, shaped as `readLessonDensity` and the manifest schema require. */
const lesson = (mapRef: string) => ({
  version: 1, id: 'density-desktop-save', title: 'A map beside its model', mode: 'explore',
  coordinates: { kind: 'volume', ref: mapRef, sha256: mapSha256, contour: CONTOUR, downsample: 4 },
  provenance: { sourceRefs: [{ kind: 'public', ref: 'https://www.ebi.ac.uk/emdb/EMD-6347' }], sourceSha256: mapSha256 },
  chapters: [{ id: 'reveal', title: 'Whole tube', caption: 'The reconstruction as its own density.', durationSeconds: 1,
    changes: [{ kind: 'rotate', durationSeconds: 1, degrees: 10 }],
    immersive: { appearance: { representation: 'isosurface', color: 'uniform', uniformColor: '#9aa5b0',
      opacity: 1, labels: false, clipping: 0, fog: 30 } } }],
});

/** Everything but the identity: both panels save the same appearance and camera. */
const body = {
  camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
    radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
  inspection: {
    appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
      opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  },
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-density-save-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'Stereofold density save test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const filePath = join(root, 'source.mmcif'), lessonPath = join(root, 'lesson.json'), densityPath = join(root, 'grid.map');
  await writeFile(filePath, cif);
  await writeFile(densityPath, map);
  await writeFile(lessonPath, JSON.stringify(lesson('grid.map')));
  const opened = await call('inspect_lesson', { filePath, lessonPath, densityPath });
  expect(JSON.stringify(opened.content)).not.toMatch(/Invalid|cannot|must/);
  const sessionId = opened.structuredContent.sessionId as string;
  // The hydration a DESKTOP panel gets: the coordinates and their catalog, plus
  // a descriptor for a map it has no route to fetch. `mapBytes` is set only by
  // `inspection-companion-client.ts`, so `inspector.ts` computes its
  // `loadedSha256` from the catalog and draws the atoms.
  const data = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const binding = { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
  return { call, data, binding, sessionId,
    close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}

describe('the first save of a density session, from each of its two renderers', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  it('takes the desktop panel’s scene of the coordinates, and registers the panel', async () => {
    const session = await setup();
    cleanups.push(session.close);
    const catalog = session.data.catalog;

    // The session is a density session — `get_inspection_state` says so, and
    // that block is what makes `sync_inspection` check against the map.
    const state = (await session.call('get_inspection_state', { sessionId: session.sessionId })).structuredContent;
    expect(state.density).toMatchObject({ sha256: mapSha256, contour: CONTOUR });
    // And the desktop draws the coordinates, because that is all it is handed.
    // The `/density` descriptor is added by `InspectionCompanionHttp` on the
    // companion's own hydration; a desktop panel never sees the map at all,
    // and `inspector.ts` takes its `loadedSha256` from the catalog.
    expect(session.data.density).toBeUndefined();
    expect(session.data.mapBytes).toBeUndefined();
    expect(typeof session.data.structureText).toBe('string');

    const desktop = { sourceSha256: catalog.source.sha256, modelNumber: catalog.modelNumbers[0],
      assemblyId: catalog.assemblyId, selectionKeys: [catalog.rows[0].key], ...body };
    const saved = (await session.call('sync_inspection', { ...session.binding, scene: desktop })).structuredContent;
    expect(saved.saved).toBe(true);
    expect(saved.hasScene).toBe(true);

    // The save is the whole of what the host's wait was for: `attach()` runs
    // only on a panel that is neither dirty nor blocked, and `isDesktopReady`
    // in quest-share.ts needs both `hasScene` and a ready desktop panel.
    const attached = (await session.call('attach_inspection', { ...session.binding,
      baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision,
      surface: 'desktop' })).structuredContent;
    expect(typeof attached.panelId).toBe('string');
    // `isDesktopReady` in quest-share.ts reads exactly these two fields, and
    // both were false for the whole of the filament run.
    const after = (await session.call('get_inspection_state', { sessionId: session.sessionId })).structuredContent;
    expect(after.hasScene).toBe(true);
    expect(after.panels.some((panel: any) => panel.surface === 'desktop' && panel.availability === 'ready')).toBe(true);
  });

  it('still takes the headset’s scene of the map, with maptier7’s identity', async () => {
    const session = await setup();
    cleanups.push(session.close);
    // The map's look is the map's own. This scene used to carry
    // `body`'s cartoon, which no density panel has ever captured — the page
    // builds an isosurface and `workspace.capture()` reports one — and the
    // schema refused every real one. `density-companion-command.test.ts` plays
    // the whole sequence; the identity is what this case is for.
    const headset = { ...(volumeSceneIdentity({ sha256: mapSha256 }) as Record<string, unknown>), selectionKeys: [], ...body,
      inspection: { ...body.inspection, appearance: { ...body.inspection.appearance, representation: 'isosurface' } } };
    expect((headset as Record<string, unknown>).assemblyId).toBe('map');
    const saved = (await session.call('sync_inspection', { ...session.binding, scene: headset })).structuredContent;
    expect(saved.saved).toBe(true);
  });

  it('refuses Mol* on the saved map with its tier name and an actionable recovery', async () => {
    const session = await setup();
    cleanups.push(session.close);
    const headset = { ...volumeSceneIdentity({ sha256: mapSha256 }), selectionKeys: [], ...body,
      inspection: { ...body.inspection, appearance: { ...body.inspection.appearance, representation: 'isosurface' } } };
    const saved = (await session.call('sync_inspection', { ...session.binding, scene: headset })).structuredContent;
    const refused = await session.call('open_detailed_view', { ...session.binding,
      baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('The A map beside its model tier has no atom coordinates. Switch to an atomic tier, then open Mol* again.');
    const after = (await session.call('get_inspection_state', { sessionId: session.sessionId })).structuredContent;
    expect(after.inspectionRevision).toBe(saved.inspectionRevision);
    expect(after.view.assemblyId).toBe('map');
  });

  it('refuses a scene that is neither of this session’s two sources', async () => {
    const session = await setup();
    cleanups.push(session.close);
    const stranger = { sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1', selectionKeys: [], ...body };
    const refused = await session.call('sync_inspection', { ...session.binding, scene: stranger });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/density map, or the exact coordinates/);
  });
});
