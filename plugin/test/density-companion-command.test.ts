/**
 * The headset's own panel on a density session, and the agent commands aimed
 * at it.
 *
 * On a Quest 2 running `demo microtubule-growth --stage filament` the map drew
 * fine. The ring recorded page-open, grow parsed, volume-build {contour 3.3,
 * bytes 8389632, triangles 178236}, built, placed — and then every
 * `update_inspection` the Mac sent was refused with
 *
 *   The target panel is unavailable, busy, or has unsaved work.
 *
 * while `get_inspection_state` listed the companion as `unsaved` at
 * inspectionRevision 1. Driving BOTH panels headlessly against the real host —
 * the Mac's page, then a loopback companion that takes the `/density` route —
 * put the reason on the wire, inside a body the MCP-UI bridge had been
 * flattening to "Local host request failed":
 *
 *   POST /tool sync_inspection -> 409
 *   {"code":"invalid_value",
 *    "values":["cartoon","ball-and-stick","molecular-surface","spacefill"],
 *    "path":["scene","inspection","appearance","representation"]}
 *
 * A map is drawn as an `isosurface`. The page has known that since the density
 * tier existed — `inspection-state.mjs` admits it in `normalizeAppearance` and
 * every chapter of a volume lesson carries it — but `sceneSchema` was never
 * told, so the scene the headset captures could not be PARSED, let alone
 * identified. The refusal landed before `assertSceneSource` ever ran, so none
 * of the scene-identity checks reached it. `save()` then
 * retried forever, `dirty` never cleared, and a dirty panel answers `unsaved`,
 * which `enqueue` refuses.
 *
 * `density-scene-identity.test.ts` holds the representation rule in isolation.
 * This one plays the sequence the headset plays: save the scene the
 * headset actually captures, register the companion, heartbeat, and send the
 * placement command that was refused — plus the refusal itself, so the symptom
 * stays pinned to its cause.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { DENSITY_REPRESENTATION, PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { syntheticMap } from './synthetic-map.js';
// @ts-ignore Shared JavaScript density module: the page's own derivation.
import { VOLUME_REPRESENTATION, VOLUME_UNIFORM_COLOR, volumeSceneIdentity } from '../../lab/browser-roundtrip/volume-source.mjs';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const map = syntheticMap();
const mapSha256 = createHash('sha256').update(map).digest('hex');
const CONTOUR = 3.3;

const lesson = (mapRef: string) => ({
  version: 1, id: 'density-companion-command', title: 'A map beside its model', mode: 'explore',
  coordinates: { kind: 'volume', ref: mapRef, sha256: mapSha256, contour: CONTOUR, downsample: 4 },
  provenance: { sourceRefs: [{ kind: 'public', ref: 'https://www.ebi.ac.uk/emdb/EMD-6347' }], sourceSha256: mapSha256 },
  chapters: [{ id: 'reveal', title: 'Whole tube', caption: 'The reconstruction as its own density.', durationSeconds: 1,
    changes: [{ kind: 'rotate', durationSeconds: 1, degrees: 10 }],
    immersive: { appearance: { representation: 'isosurface', color: 'uniform', uniformColor: VOLUME_UNIFORM_COLOR,
      opacity: 1, labels: false, clipping: 0, fog: 30 } } }],
});

const camera = { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
  radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 };
const look = (representation: string, color = 'uniform') => ({
  representation, color, uniformColor: VOLUME_UNIFORM_COLOR, background: '#071015',
  opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0,
});
const placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
/** What the headset's `workspace.capture()` answers on the filament tier. */
const mapScene = (representation = VOLUME_REPRESENTATION) => ({
  ...(volumeSceneIdentity({ sha256: mapSha256 }) as Record<string, unknown>), selectionKeys: [],
  camera, inspection: { appearance: look(representation), placement },
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-density-command-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'Stereofold density command test', version: '1' });
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
  const data = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const binding = { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
  return { call, data, binding, sessionId,
    close: async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}

/** The binding the panel holds after a save, which is what a command must quote. */
const nextBinding = (sessionId: string, saved: any) => ({ sessionId, serverEpoch: saved.serverEpoch,
  sourceToken: saved.sourceToken, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision });

describe('a density companion, from its first save to an agent command', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  it('tells the desktop hydration that the lesson belongs to a map, before any scene is saved', async () => {
    const session = await setup();
    cleanups.push(session.close);
    expect(session.data.scene).toBeNull();
    expect(session.data.density).toEqual({ sha256: mapSha256, bytes: map.byteLength, contour: CONTOUR });
    // Desktop draws the reference coordinates; only the companion fetches map bytes.
    expect(session.data.mapBytes).toBeUndefined();
    expect(session.data.structureText).toBe(cif);
  });

  it('saves the isosurface scene the headset captures, registers, and takes a placement command', async () => {
    const session = await setup();
    cleanups.push(session.close);

    // 1. The save. This is the call that answered 409 on the headset, and
    //    it failed in the tool's own input schema rather than in `validateScene`.
    const saved = (await session.call('sync_inspection', { ...session.binding, scene: mapScene() })).structuredContent;
    expect(saved.saved).toBe(true);
    const bound = nextBinding(session.sessionId, saved);

    // 2. The registration. `attach()` in `inspector.ts` is guarded on `!blocked`,
    //    and `poll` lets a companion register while dirty — which is why the
    //    headset had a panel at all, listed as `unsaved`.
    const panelId = (await session.call('attach_inspection', { ...bound, surface: 'companion' })).structuredContent.panelId;
    expect(typeof panelId).toBe('string');

    // 3. The heartbeat. A saved scene means `dirty` is false, and
    //    `panelAvailability` answers `ready`.
    const beat = (await session.call('poll_inspection', { ...bound, panelId, availability: 'ready' })).structuredContent;
    expect(beat.attached).toBe(true);

    // 4. What the Mac sees: a current, ready companion, and the map in `view`.
    const state = (await session.call('get_inspection_state', { sessionId: session.sessionId })).structuredContent;
    expect(state.density).toMatchObject({ sha256: mapSha256, contour: CONTOUR });
    expect(state.view.assemblyId).toBe('map');
    expect(state.view.appearance.representation).toBe(DENSITY_REPRESENTATION);
    expect(state.panels).toContainEqual(expect.objectContaining({ panelId, surface: 'companion', availability: 'ready', current: true }));

    // 5. The command. Placement is the one the headset sent.
    const queued = await session.call('update_inspection', { ...bound, panelId, commandId: 'density-placement',
      change: { kind: 'placement', patch: { scale: 1.4 } } });
    expect(queued.isError).toBeFalsy();
    expect(queued.structuredContent.command).toMatchObject({ commandId: 'density-placement', panelId, status: 'queued' });
  });

  it('still refuses a command aimed at a companion whose work is unsaved', async () => {
    const session = await setup();
    cleanups.push(session.close);
    const saved = (await session.call('sync_inspection', { ...session.binding, scene: mapScene() })).structuredContent;
    const bound = nextBinding(session.sessionId, saved);
    const panelId = (await session.call('attach_inspection', { ...bound, surface: 'companion' })).structuredContent.panelId;
    // The heartbeat the headset's panel was sending for four minutes.
    await session.call('poll_inspection', { ...bound, panelId, availability: 'unsaved' });
    const refused = await session.call('update_inspection', { ...bound, panelId, commandId: 'density-refused',
      change: { kind: 'placement', patch: { scale: 1.4 } } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toMatch(/unavailable, busy, or has unsaved work/);
  });

  it('refuses a map scene drawn as a structure, and a structure scene drawn as a map', async () => {
    const session = await setup();
    cleanups.push(session.close);
    const catalog = session.data.catalog;

    // A map has no atoms, so none of the four structure representations can be
    // built over it. A scene claiming one describes a picture no panel can draw.
    const asCartoon = await session.call('sync_inspection', { ...session.binding, scene: mapScene('cartoon') });
    expect(asCartoon.isError).toBe(true);
    expect(JSON.stringify(asCartoon.content)).toMatch(/drawn as an isosurface and nothing else/);

    // And the mirror: the seed coordinates this session opened beside are still
    // held to the same four representations.
    const atoms = { sourceSha256: catalog.source.sha256, modelNumber: catalog.modelNumbers[0], assemblyId: catalog.assemblyId,
      selectionKeys: [], camera, inspection: { appearance: look(DENSITY_REPRESENTATION, 'chain-id'), placement } };
    const asMap = await session.call('sync_inspection', { ...session.binding, scene: atoms });
    expect(asMap.isError).toBe(true);
    expect(JSON.stringify(asMap.content)).toMatch(/Only a density map is drawn as an isosurface/);
  });

  it('never lets an agent ASK a panel for the map representation', async () => {
    const session = await setup();
    cleanups.push(session.close);
    const saved = (await session.call('sync_inspection', { ...session.binding, scene: mapScene() })).structuredContent;
    const bound = nextBinding(session.sessionId, saved);
    const panelId = (await session.call('attach_inspection', { ...bound, surface: 'companion' })).structuredContent.panelId;
    await session.call('poll_inspection', { ...bound, panelId, availability: 'ready' });
    // `update_inspection`'s appearance patch is built from the four structure
    // representations and nothing else, on every session, density or atomic.
    const refused = await session.call('update_inspection', { ...bound, panelId, commandId: 'density-look',
      change: { kind: 'appearance', patch: { representation: DENSITY_REPRESENTATION } } });
    expect(refused.isError).toBe(true);
  });

  it('names the map representation the page names', () => {
    // One value, two ends. `volume-source.mjs` is what the page builds the
    // isosurface with; `inspection-contract.ts` is what the host admits.
    expect(DENSITY_REPRESENTATION).toBe(VOLUME_REPRESENTATION);
  });
});
