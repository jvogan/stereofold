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
    // The desktop needs the map's identity to avoid starting density chapters
    // on reference atoms. `bytes` is only a count: neither hydration transport
    // may contain the map or a URL to fetch it. Only the companion adds /density.
    const chunked = (await session.call('get_inspection', { sessionId: session.sessionId,
      transport: 'chunked' }))._meta[PRIVATE_KEY];
    for (const data of [session.data, chunked]) {
      expect(data.density).toEqual({ sha256: mapSha256, bytes: map.byteLength, contour: CONTOUR });
      expect(data.density.url).toBeUndefined();
      expect(data.mapBytes).toBeUndefined();
      expect(data.mapSha256).toBeUndefined();
      expect(data.mapContour).toBeUndefined();
    }
    // Without map bytes, inspector.ts draws the coordinates and takes its
    // loadedSha256 from the catalog, as the desktop save below verifies.
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

  it('keeps the shared map authoritative when its reference-atoms desktop follows or edits', async () => {
    const session = await setup(); cleanups.push(session.close);
    const catalog = session.data.catalog;
    const desktop = { sourceSha256: catalog.source.sha256, modelNumber: catalog.modelNumbers[0],
      assemblyId: catalog.assemblyId, selectionKeys: [], ...body };
    const mapScene = { ...volumeSceneIdentity({ sha256: mapSha256 }), selectionKeys: [], ...body,
      inspection: { ...body.inspection, appearance: { ...body.inspection.appearance, representation: 'isosurface' } } };
    const at = (state: any) => ({ ...session.binding, baseStateRevision: state.stateRevision,
      baseInspectionRevision: state.inspectionRevision, sourceToken: state.sourceToken });
    const initial = (await session.call('sync_inspection', { ...session.binding, scene: desktop })).structuredContent;
    const firstDesktop = (await session.call('attach_inspection', { ...at(initial), surface: 'desktop' })).structuredContent.panelId;
    const edited = (await session.call('sync_inspection', { ...at(initial), scene: { ...desktop,
      inspection: { ...desktop.inspection, placement: { ...desktop.inspection.placement, scale: 1.2 } } } })).structuredContent;
    expect(edited.history.undoCount).toBe(1);
    const mapped = (await session.call('sync_inspection', { ...at(edited), scene: mapScene })).structuredContent;
    const companion = (await session.call('attach_inspection', { ...at(mapped), surface: 'companion' })).structuredContent.panelId;
    await session.call('poll_inspection', { ...at(mapped), panelId: companion, availability: 'ready' });

    // The desktop began loading before any scene existed, but finishes after
    // the map. It may refresh its binding without claiming that its atoms saved.
    const late = await session.call('sync_inspection', { ...session.binding, scene: desktop });
    expect(late.structuredContent).toMatchObject({ saved: false, referenceOnly: true,
      inspectionRevision: mapped.inspectionRevision });

    // A late desktop load has the current binding but still draws reference atoms.
    // Its heartbeat must remain available for a later source replacement, without
    // presenting it as a renderer of the shared density scene.
    const following = await session.call('attach_inspection', { ...at(mapped), surface: 'desktop',
      replacesPanelId: firstDesktop, renderedSourceSha256: desktop.sourceSha256 });
    expect(following.isError).not.toBe(true);
    const desktopId = following.structuredContent.panelId;
    const beat = await session.call('poll_inspection', { ...at(mapped), panelId: desktopId, availability: 'ready' });
    expect(beat.structuredContent.attached).toBe(true);
    const before = (await session.call('get_inspection_state', { sessionId: session.sessionId })).structuredContent;
    expect(before.panels).toContainEqual(expect.objectContaining({ panelId: desktopId, current: false, referenceOnly: true }));
    expect(before.panels).toContainEqual(expect.objectContaining({ panelId: companion, current: true }));
    expect(before.history.undoCount).toBe(0);

    const refused = await session.call('sync_inspection', { ...at(mapped), panelId: desktopId, scene: desktop });
    expect(refused.structuredContent).toMatchObject({ saved: false, referenceOnly: true });
    expect(refused.structuredContent.reason).toContain('reference coordinates');
    const after = (await session.call('get_inspection_state', { sessionId: session.sessionId })).structuredContent;
    expect(after.inspectionRevision).toBe(mapped.inspectionRevision);
    expect(after.view.assemblyId).toBe('map');
    expect(after.history.undoCount).toBe(0);
    const explicit = await session.call('update_inspection', { ...at(mapped), panelId: desktopId,
      commandId: 'reference-is-not-map', change: { kind: 'placement', patch: { scale: 1.4 } } });
    expect(explicit.isError).toBe(true);
    const invalidIdentity = await session.call('attach_inspection', { ...at(mapped), surface: 'desktop',
      renderedSourceSha256: 'a'.repeat(64) });
    expect(invalidIdentity.isError).toBe(true);
    const falseMap = await session.call('attach_inspection', { ...at(mapped), surface: 'desktop',
      renderedSourceSha256: mapSha256 });
    expect(falseMap.isError).toBe(true);
    const queued = await session.call('update_inspection', { sessionId: session.sessionId,
      commandId: 'map-after-reference', change: { kind: 'placement', patch: { scale: 1.4 } } });
    expect(queued.isError).not.toBe(true);
    expect(queued.structuredContent.command.panelId).toBe(companion);
  });

  it('keeps a pre-map detailed viewer reference-only after it follows the new map revision', async () => {
    const session = await setup(); cleanups.push(session.close);
    const catalog = session.data.catalog;
    const atoms = { sourceSha256: catalog.source.sha256, modelNumber: catalog.modelNumbers[0],
      assemblyId: catalog.assemblyId, selectionKeys: [], ...body };
    const mapScene = { ...volumeSceneIdentity({ sha256: mapSha256 }), selectionKeys: [], ...body,
      inspection: { ...body.inspection, appearance: { ...body.inspection.appearance, representation: 'isosurface' } } };
    const at = (state: any) => ({ ...session.binding, sourceToken: state.sourceToken,
      baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision });
    const initial = (await session.call('sync_inspection', { ...session.binding, scene: atoms })).structuredContent;
    // Mol* can open before the companion adopts the map. Its actual attachment
    // omits the optional digest; the host knows it loaded reference coordinates.
    const detailed = (await session.call('attach_inspection', { ...at(initial), surface: 'detailed' })).structuredContent.panelId;
    const before = (await session.call('get_inspection_state', { sessionId: session.sessionId })).structuredContent;
    expect(before.panels).toContainEqual(expect.objectContaining({ panelId: detailed, current: true }));
    const mapped = (await session.call('sync_inspection', { ...at(initial), scene: mapScene })).structuredContent;
    const companion = (await session.call('attach_inspection', { ...at(mapped), surface: 'companion' })).structuredContent.panelId;

    // The detailed page refreshes its binding on every beat. Following the
    // revision does not replace its loaded atom coordinates with a volume.
    const staleBeat = await session.call('poll_inspection', { ...at(initial), panelId: detailed, availability: 'ready' });
    expect(staleBeat.structuredContent).toMatchObject({ attached: true, inspectionRevision: mapped.inspectionRevision });
    const refreshedBeat = await session.call('poll_inspection', { ...at(staleBeat.structuredContent), panelId: detailed, availability: 'ready' });
    expect(refreshedBeat.structuredContent.attached).toBe(true);
    const after = (await session.call('get_inspection_state', { sessionId: session.sessionId })).structuredContent;
    expect(after.panels).toContainEqual(expect.objectContaining({ panelId: detailed, current: false, referenceOnly: true }));
    expect(after.panels).toContainEqual(expect.objectContaining({ panelId: companion, current: true }));
    const explicit = await session.call('update_inspection', { ...at(mapped), panelId: detailed,
      commandId: 'detailed-reference-is-not-map', change: { kind: 'appearance', patch: { opacity: 0.8 } } });
    expect(explicit.isError).toBe(true);
    const queued = await session.call('update_inspection', { sessionId: session.sessionId,
      commandId: 'map-after-detailed-reference', change: { kind: 'appearance', patch: { opacity: 0.8 } } });
    expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
    expect(queued.structuredContent.command.panelId).toBe(companion);
  });

  it.each(['desktop', 'detailed'] as const)('restores normal %s saves and commands after switching from a map to atoms', async surface => {
    const session = await setup(); cleanups.push(session.close);
    const mapScene = { ...volumeSceneIdentity({ sha256: mapSha256 }), selectionKeys: [], ...body,
      inspection: { ...body.inspection, appearance: { ...body.inspection.appearance, representation: 'isosurface' } } };
    const mapped = (await session.call('sync_inspection', { ...session.binding, scene: mapScene })).structuredContent;
    const mappedBinding = { ...session.binding, baseInspectionRevision: mapped.inspectionRevision };
    const companion = (await session.call('attach_inspection', { ...mappedBinding, surface: 'companion' })).structuredContent.panelId;
    const preview = (await session.call('attach_inspection', { ...mappedBinding, surface,
      renderedSourceSha256: session.data.catalog.source.sha256 })).structuredContent.panelId;
    const swapped = await session.call('replace_inspection_source', { sessionId: session.sessionId,
      panelId: companion, source: { kind: 'pasted', text: cif + '\n# density return to atoms\n' }, waitForRenderMs: 0 });
    expect(swapped.isError, JSON.stringify(swapped.content)).not.toBe(true);
    const data = (await session.call('get_inspection', { sessionId: session.sessionId }))._meta[PRIVATE_KEY];
    expect(data.density).toBeUndefined();
    const atomic = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
      assemblyId: data.catalog.assemblyId, selectionKeys: [], ...body };
    const current = { ...session.binding, sourceToken: data.sourceToken, baseStateRevision: data.stateRevision,
      baseInspectionRevision: data.inspectionRevision };
    const saved = (await session.call('sync_inspection', { ...current, scene: atomic })).structuredContent;
    expect(saved.saved).toBe(true);
    const attached = await session.call('attach_inspection', { ...current, baseInspectionRevision: saved.inspectionRevision,
      replacesPanelId: preview, surface, renderedSourceSha256: atomic.sourceSha256 });
    expect(attached.isError, JSON.stringify(attached.content)).not.toBe(true);
    const desktopId = attached.structuredContent.panelId;
    const state = (await session.call('get_inspection_state', { sessionId: session.sessionId })).structuredContent;
    expect(state.panels).toContainEqual(expect.objectContaining({ panelId: desktopId, current: true }));
    expect(state.panels.find((panel: any) => panel.panelId === desktopId).referenceOnly).toBeUndefined();
    const queued = await session.call('update_inspection', { sessionId: session.sessionId,
      panelId: desktopId, commandId: 'atoms-after-density', change: { kind: 'appearance', patch: { opacity: 0.8 } } });
    expect(queued.isError, JSON.stringify(queued.content)).not.toBe(true);
    expect(queued.structuredContent.command.panelId).toBe(desktopId);
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
