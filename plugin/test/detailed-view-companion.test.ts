import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const discard = (path: string) => rm(path, {force: true, recursive: true});

const camera = {mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0],
  radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0};

/**
 * The headset's "Open in Mol*" row does not call the tool the way the desktop
 * host does: it goes over the companion `/tool` route, which dispatches only
 * the names `registerInspection` put in its handler map. This suite drives the
 * real map and the real listener, so a tool advertised to the headset but
 * registered outside the map fails here rather than in the headset.
 */
async function setup() {
  // The companion listener reads the packaged inspector page and the detailed
  // route reads the viewer bundle beside it, so the fixture is a miniature dist/.
  const dist = await mkdtemp(join(tmpdir(), 'stereofold-dist-'));
  await writeFile(join(dist, 'viewer.html'), '<html><script>void 0;</script></html>');
  await writeFile(join(dist, 'inspector.html'), '<html><script>void 0;</script></html>');
  await mkdir(join(dist, 'molstar'), {recursive: true});
  await writeFile(join(dist, 'molstar/molstar.js'), 'globalThis.molstar={};');
  await writeFile(join(dist, 'molstar/molstar.css'), '.msp-plugin{color:#fff}');
  const [a, b] = InMemoryTransport.createLinkedPair(), server = createStereoStructureServer(join(dist, 'viewer.html'));
  const client = new Client({name: 'Detailed view companion route test', version: '1'});
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({name: `stereo_structure.${name}`, arguments: args}) as any;
  const sessionId = (await call('inspect', {structureText: cif})).structuredContent.sessionId;
  const data = (await call('get_inspection', {sessionId}))._meta[KEY];
  const scene = {sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
    assemblyId: data.catalog.assemblyId, selectionKeys: [], camera: structuredClone(camera),
    inspection: {
      appearance: {representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734',
        highlightColor: '#ffccee', opacity: 1, labels: false, clipping: 0, fog: 30},
      placement: {translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1},
    }};
  const saved = (await call('sync_inspection', {sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene})).structuredContent;
  const binding = {sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
    baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision};
  const companion = (await call('open_companion', {...binding, connection: 'loopback'})).structuredContent.companion;
  return {call, binding, companion,
    close: async () => { await client.close(); await server.close(); await discard(dist); }};
}

/** What the headset page sends: the page key as the bearer, same-origin POST. */
async function press(companion: {url: string}, name: string, args: Record<string, unknown>) {
  const origin = new URL(companion.url).origin, pageKey = new URL(companion.url).hash.slice(1);
  return await fetch(`${origin}/tool`, {method: 'POST',
    headers: {Authorization: `Bearer ${pageKey}`, Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({name, args})});
}

describe('open_detailed_view over the companion route the headset uses', () => {
  it('answers a headset press with the detailed view address, not Unsupported companion action', async () => {
    const t = await setup();
    try {
      const {sessionId: _sessionId, ...args} = t.binding;
      const response = await press(t.companion, 'open_detailed_view', args);
      // A 409 here is the field failure this covers: the name is advertised on
      // both transports but absent from the dispatch map, so every press from
      // VR died as "Could not open Mol* on the Mac".
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.structuredContent.detailedView.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/detailed#[a-f0-9]{64}$/);
      expect(body.structuredContent.detailedView.snapshotId).toMatch(/^[a-f0-9]{32}$/);
      expect(body.structuredContent.detailedView.carried).toContain('selection');
      // The wearer never sees coordinates over this route.
      expect(JSON.stringify(body)).not.toContain('ATOM');
    } finally { await t.close(); }
  });

  it('refuses the same press on a stale source capability', async () => {
    const t = await setup();
    try {
      const {sessionId: _sessionId, sourceToken: _token, ...rest} = t.binding;
      const response = await press(t.companion, 'open_detailed_view', {...rest, sourceToken: `${'0'.repeat(64)}`});
      expect(response.status).toBe(409);
    } finally { await t.close(); }
  });
});

/**
 * The headset press must not have to ask the network where to
 * open. Before this, `inspector.ts` ran a live `fetch('/detailed')` on every
 * press and read any failure as "not served here", which opened Mol* on a Mac
 * monitor the wearer could not see. The host knows the answer, so it says it.
 */
describe('the host advertises whether this origin serves the full Mol* viewer', () => {
  it('carries detailedViewAvailable on the state the headset page reads', async () => {
    const t = await setup();
    try {
      const state = (await t.call('get_inspection_state', {sessionId: t.binding.sessionId})).structuredContent;
      expect(state.detailedViewAvailable).toBe(true);
      // The same field rides every inspection answer, so the page learns it
      // from whichever call happens first rather than only from one tool.
      const {sessionId: _sessionId, ...args} = t.binding;
      const pressed = await press(t.companion, 'open_detailed_view', args);
      expect(((await pressed.json()) as any).structuredContent.detailedViewAvailable).toBe(true);
    } finally { await t.close(); }
  });

  it('advertises it only because that origin really serves the page', async () => {
    const t = await setup();
    try {
      const origin = new URL(t.companion.url).origin;
      const served = await fetch(`${origin}/detailed`, {headers: {Origin: origin}});
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toMatch(/^text\/html/);
      await served.arrayBuffer();
    } finally { await t.close(); }
  });
});
