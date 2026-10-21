import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import { LocalSceneService } from '../src/scene-service.js';
import { createStereoStructureServer } from '../src/server.js';
import { expectedInspection, PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { registerTextTool, textStateBlock, withTextState, TEXT_STATE_MAX_CHARS } from '../src/tool-text-state.js';
import { z } from 'zod';

// This is the entire model-facing client: structuredContent and _meta are dropped.
function textOnly(answer: any) {
  expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
  const text = answer.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
  const blocks = [...text.matchAll(/```json\n(\{"textStateVersion":1,[\s\S]*?)\n```/g)];
  expect(blocks).toHaveLength(1);
  expect(blocks[0][0].length).toBeLessThanOrEqual(TEXT_STATE_MAX_CHARS);
  return Object.assign({}, ...[...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(block => JSON.parse(block[1])));
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-text-state-'));
  const filePath = join(root, 'source.cif'), lessonPath = join(root, 'lesson.json');
  await writeFile(filePath, await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url)));
  await writeFile(lessonPath, JSON.stringify({ version: 1, id: 'text-state', title: 'Motion lesson', mode: 'explore',
    provenance: { sourceRefs: [{ kind: 'local', ref: filePath }] },
    chapters: [{ id: 'two-steps', title: 'Two steps', caption: 'Motion chapter.', durationSeconds: 10,
      changes: [{ kind: 'rotate', durationSeconds: 10, degrees: 10 }],
      immersive: { emphasis: { parts: [{ id: 'head-1', label: 'Head 1', color: '#ffaa33', chain: 'A' }], contextOpacity: .18 } } }] }));
  let sessionId: string;
  const ownerScene = new LocalSceneService({ file: join(root, 'scene.json') });
  // Replace only the scene service's socket transport: the restricted test
  // environment cannot listen on loopback. Both MCP servers use real handlers.
  vi.spyOn(ownerScene, 'share').mockImplementation(async () => ({ role: 'owner', sessionId, sceneId: 'test-scene' }));
  const connect = async (attached = false) => {
    const service = attached ? new LocalSceneService({ file: join(root, 'scene.json') }) : ownerScene;
    if (attached) {
      vi.spyOn(service, 'role', 'get').mockReturnValue('attached');
      vi.spyOn(service, 'share').mockImplementation(async () => ({ role: 'attached', sessionId, sceneId: 'test-scene' }));
      vi.spyOn(service, 'proxies').mockImplementation(id => id === sessionId);
      vi.spyOn(service, 'call').mockImplementation((name, args) => ownerScene.dispatch(name, args ?? {}));
      vi.spyOn(service, 'forward').mockImplementation(async (name, args) => (args as any)?.sessionId === sessionId
        ? { value: await ownerScene.dispatch(name, args as Record<string, unknown>) } : undefined);
    }
    const server = createStereoStructureServer(undefined, { sceneService: service });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'Text state test', version: '1' });
    await server.connect(st); await client.connect(ct);
    return { server, client, call: (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any> };
  };
  const owner = await connect();
  sessionId = textOnly(await owner.call('inspect_lesson', { filePath, lessonPath })).sessionId;
  // Only the simulated renderer uses private hydration and structured receipts.
  const h = (await owner.call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  let scene: any = { sourceSha256: h.catalog.source.sha256, modelNumber: h.catalog.modelNumbers[0],
    assemblyId: h.catalog.assemblyId, selectionKeys: [],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
      opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
  const binding = { sessionId, serverEpoch: h.serverEpoch, sourceToken: h.sourceToken,
    baseStateRevision: h.stateRevision, baseInspectionRevision: h.inspectionRevision };
  const advance = (value: any) => {
    binding.baseStateRevision = value.stateRevision; binding.baseInspectionRevision = value.inspectionRevision;
  };
  advance((await owner.call('sync_inspection', { ...binding, scene })).structuredContent);
  const panelId = (await owner.call('attach_inspection', { ...binding, surface: 'desktop' })).structuredContent.panelId;
  let animation: any = null, tourState: any;
  const beat = () => owner.call('poll_inspection', { ...binding, panelId, availability: 'ready', animation,
    ...(tourState ? { tourState } : {}) });
  const render = async (failure?: string) => {
    let delivery: any;
    for (let i = 0; i < 100 && !delivery; i++) {
      delivery = (await beat())._meta[PRIVATE_KEY]?.delivery;
      if (!delivery) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(delivery).toBeDefined();
    if (!failure) {
      if (delivery.change.kind === 'tour') {
        tourState = { selectedId: delivery.change.patch.tourId, step: 0, total: 1, active: true,
          autoplay: false, narration: false, navigating: false };
        animation = { id: 'test-motion', chapterId: 'two-steps', state: 'playing', speed: 1,
          timeSeconds: 1, durationSeconds: 10, loop: true };
      } else if (delivery.change.kind === 'animation') {
        const p = delivery.change.patch;
        animation = { ...animation, ...(p.state ? { state: p.state === 'pause' ? 'paused' : 'playing' } : {}),
          ...(p.speed ? { speed: p.speed } : {}) };
      } else scene = expectedInspection(scene, delivery.change);
    }
    const complete = await owner.call('complete_inspection', { ...binding, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, ...(failure ? { failure: 'render_failed', failureReason: failure } : { scene, animation,
        ...(tourState ? { tourState } : {}) }) });
    expect(complete.isError, JSON.stringify(complete.content)).not.toBe(true);
    advance(complete.structuredContent); await beat();
  };
  textOnly(await owner.call('continue_session', { assistant: 'Codex' }));
  const attached = await connect(true);
  const call = async (name: string, args: Record<string, unknown> = {}) => textOnly(await attached.call(name, args));
  return { call, rawCall: attached.call, render, sessionId, panelId, filePath,
    close: async () => { await attached.client.close(); await attached.server.close(); await owner.client.close(); await owner.server.close();
      await rm(root, { recursive: true, force: true }); } };
}

it('a text-only host joins, starts a lesson, controls animation, emphasizes a part and confirms receipts', async () => {
  const t = await setup();
  try {
    const joined = await t.call('continue_session', { assistant: 'Claude' });
    expect(joined, JSON.stringify(joined)).toMatchObject({ role: 'attached', sessionId: t.sessionId, scene: { hasScene: true } });
    const sessionId = joined.sessionId;
    const state = await t.call('get_inspection_state', { sessionId });
    const explicit = await t.call('get_inspection_state', {sessionId, includeLesson:true, residues:{limit:2}});
    expect(explicit.lessonManifest.id).toBe('text-state');
    expect(explicit.residues.rows).toHaveLength(2);
    const measured=await t.call('measure',{sessionId,targets:[{part:'head-1'},{part:'head-1'}]});
    expect(measured.measurement.ok).toBe(true);
    expect(measured.measurement.atoms[0].part).toBe('head-1');
    const tourId = state.tours.find((tour: any) => tour.title === 'Motion lesson').id;
    expect(state).toMatchObject({ targetPanel: { panelId: t.panelId, current: true, availability: 'ready' }, placement: { scale: 1 } });
    const start = await t.call('control_tour', { sessionId, tourId, action: 'start', autoplay: false, narration: false });
    expect(start.command).toMatchObject({ commandId: start.commandId, status: 'queued' });
    await t.render();
    const started = await t.call('get_inspection_state', { sessionId, commandId: start.commandId });
    expect(started.command).toMatchObject({ commandId: start.commandId, status: 'rendered', renderedRevision: expect.any(Number),
      acceptedAt: expect.any(Number), renderedAt: expect.any(Number) });
    expect(started.targetPanel.tour).toMatchObject({ selectedId: tourId, step: 0, autoplay: false, active: true });
    expect(started.animation).toMatchObject({ chapterId: 'two-steps', state: 'playing', speed: 1, timeSeconds: 1, durationSeconds: 10, loop: true });
    const part = started.lesson.parts.find((part: any) => part.label === 'Head 1');
    expect(part.id).toBe('head-1');
    for (const patch of [{ state: 'pause' }, { state: 'play' }, { speed: .5 }, { speed: 1 }]) {
      const pending = t.call('update_inspection', { sessionId, change: { kind: 'animation', patch }, waitForRenderMs: 5000 });
      await t.render();
      const applied = await pending;
      expect(applied.command).toMatchObject({ commandId: applied.commandId, status: 'rendered' });
      const after = await t.call('get_inspection_state', { sessionId, commandId: applied.commandId });
      expect(after.command.status).toBe('rendered');
      expect(after.animation).toMatchObject({ chapterId: 'two-steps', ...(patch.state ? { state: patch.state === 'pause' ? 'paused' : 'playing' } : patch) });
    }
    const highlight = await t.call('emphasize', { sessionId, parts: [part.id] });
    await t.render();
    expect((await t.call('get_inspection_state', { sessionId, commandId: highlight.commandId })).command.status).toBe('rendered');
    for (const tool of ['undo_last_change', 'redo_last_change', 'focus_selection']) {
      const queued = await t.call(tool, { sessionId, ...(tool === 'focus_selection' ? { residues: { labelChain: 'A' } } : {}) });
      expect(queued.commandId).toBeTruthy(); await t.render();
      expect((await t.call('get_inspection_state', { sessionId, commandId: queued.commandId })).command.status).toBe('rendered');
    }
    const pendingFailure = t.rawCall('update_inspection', { sessionId, change: { kind: 'appearance', patch: { opacity: .3 } },
      waitForRenderMs: 5000 });
    await t.render('Test draw failure.');
    const failureAnswer = await pendingFailure;
    expect(failureAnswer.content[0].text).toContain('It did not render');
    expect(failureAnswer.content[0].text).toContain('Test draw failure.');
    const failed = textOnly(failureAnswer);
    expect(failed.command).toMatchObject({ status: 'rejected', reason: 'render_failed', detail: 'Test draw failure.' });
    expect((await t.call('get_inspection_state', { sessionId, commandId: failed.commandId })).command)
      .toMatchObject({ status: 'rejected', reason: 'render_failed', detail: 'Test draw failure.' });
    expect((await t.call('list_experiences')).experiences[0]).toMatchObject({ id: expect.any(String), stages: expect.any(Array) });
    expect(await t.call('get_state', { sessionId })).toMatchObject({ sessionId, mode: expect.any(String), motion: expect.any(Object) });
    expect((await t.call('get_readiness', { sessionId })).readiness).toMatchObject({ ready: false, blocking: expect.any(Array) });
    const page = await t.call('get_inspection_state', { sessionId, residues: { offset: 0, limit: 1 } });
    expect(page.residues.rows[0].key).toBeTruthy();
    const replaced = await t.call('replace_inspection_source', { sessionId, source: { kind: 'file', path: t.filePath } });
    expect(replaced).toMatchObject({ commandId: expect.any(String), sourceTransition: { sourceChanged: true },
      sourceRenderStatus: { rendered: false, commandId: expect.any(String) } });
    const replacement = await t.call('get_inspection_state', { sessionId, commandId: replaced.commandId });
    expect(replacement.command).toMatchObject({ commandId: replaced.commandId, status: 'rendering' });
  } finally { await t.close(); }
});

it('bounds text deterministically, preserves requested receipts and excludes secrets and coordinates', () => {
  const secret = 'DO_NOT_EXPOSE';
  const payload = { sessionId: 'session', command: { commandId: 'requested', status: 'rendered', renderedRevision: 42,
    acceptedAt: 1, renderedAt: 2, claimToken: secret },
    lesson: { id: 'lesson', parts: [{ id: 'head-1', label: 'Head 1', coordinates: [secret] }] },
    view: { placement: { translation: [1, 2, 3], rotation: [0, 0, 0], scale: 1 },
      animation: { definition: { coordinates: secret } }, cameraPose: { position: [secret] } },
    lan: { pairingCode: secret, privateKey: secret, token: secret, url: `https://user:${secret}@localhost/#${secret}` },
    source: { kind: 'pasted', text: secret }, structureText: secret,
    wearer: { linked: true, deviceKey: secret, note: `Open https://localhost/#${secret}` },
    diagnostics: { private_key: secret, detail: `-----BEGIN PRIVATE KEY-----\n${secret}` },
    experiences: Array.from({ length: 100 }, (_, i) => ({ id: `experience-${i}`, summary: 'x'.repeat(500) })) };
  const before = structuredClone(payload);
  const answer = withTextState({ content: [{ type: 'text', text: 'Original prose.' }], structuredContent: payload });
  expect(answer.content[0].text).toBe('Original prose.');
  expect(answer.structuredContent).toBe(payload); expect(payload).toEqual(before);
  const block = answer.content[1].text;
  expect(block).toBe(textStateBlock(payload)); expect(block.length).toBeLessThanOrEqual(TEXT_STATE_MAX_CHARS);
  expect(block).not.toContain(secret);
  expect(textOnly(answer)).toMatchObject({ maxChars: 6000, truncated: true, truncationMarker: '[truncated]',
    commandId: 'requested', command: { status: 'rendered', renderedRevision: 42 },
    lesson: { parts: [{ id: 'head-1', label: 'Head 1' }] }, placement: { scale: 1 } });
  expect(withTextState(answer).content).toEqual(answer.content);
  const small = textOnly(withTextState({ structuredContent: { ...payload, experiences: [] } }));
  expect(small.truncated).toBe(false); expect(JSON.stringify(small)).not.toContain(secret);
});

it('keeps success state separate from advisory prose without hiding readiness or altering authored labels', () => {
  const payload = { wearer: { linked: false, state: 'no-page', note: 'Speech cannot reach this page.' },
    readiness: { ready: false, blocking: ['structure'], checkedAt: 'now',
      items: [{ capability: 'structure', label: 'Structure', state: 'missing',
        detail: 'A structure must be loaded.', nextAction: 'Load a structure before continuing.' }] },
    sourceRecovery: { reason: 'loading', message: 'The panel cannot draw yet.' },
    command: { commandId: 'saved', status: 'rendered', renderedRevision: 2, detail: 'Invalid advisory example.' },
    lesson: { id: 'authored', title: 'A title must remain intact', parts: [] } };
  const answer = withTextState({ content: [{ type: 'text', text: 'Scene opened.' }], structuredContent: payload });
  expect(answer.content[0].text).toBe('Scene opened.');
  expect(answer.structuredContent).toBe(payload);
  const state = textOnly(answer);
  expect(state).toMatchObject({ wearer: { linked: false, state: 'no-page' },
    readiness: { ready: false, blocking: ['structure'], items: [{ capability: 'structure', state: 'missing' }] },
    sourceRecovery: { reason: 'loading' }, command: { status: 'rendered', renderedRevision: 2 },
    lesson: { title: payload.lesson.title } });
  expect(state.isError).toBeUndefined(); expect(state.error).toBeUndefined();
  expect(state.wearer.note).toBeUndefined(); expect(state.readiness.items[0].detail).toBeUndefined();
  expect(state.readiness.items[0].nextAction).toBeUndefined(); expect(state.command.detail).toBeUndefined();
  delete state.lesson;
  expect(JSON.stringify(state)).not.toMatch(/Invalid|cannot|must/);
});

it('preserves failed command and source receipts even when the state query itself succeeds', () => {
  for (const key of ['command', 'sourceRenderReceipt']) {
    const receipt = { commandId: 'failed-draw', status: key === 'command' ? 'rejected' : 'failed',
      reason: 'render_failed', detail: 'Invalid selection; cannot draw it.' };
    const answer = withTextState({ content: [{ type: 'text', text: receipt.detail }], structuredContent: { [key]: receipt } });
    expect(answer.content[0].text).toBe(receipt.detail);
    expect(textOnly(answer)[key]).toMatchObject(receipt);
  }
});

it('marks explicit tool errors in bounded JSON, including text-only and already projected errors', () => {
  for (const structuredContent of [undefined, { reason: 'render_failed', detail: 'Cannot draw this source.' }]) {
    const answer = withTextState({ isError: true, content: [{ type: 'text', text: 'Cannot draw this source.' }], structuredContent });
    expect(answer.content[0].text).toBe('Cannot draw this source.');
    expect(answer.structuredContent).toBe(structuredContent);
    expect(JSON.parse(answer.content[1].text.slice(8, -4))).toMatchObject({ isError: true,
      error: { message: 'Cannot draw this source.' } });
    expect(withTextState(answer).content).toEqual(answer.content);
  }
  const huge = withTextState({ isError: true, content: [{ type: 'text', text: 'Cannot draw. '.repeat(1000) }] });
  expect(huge.content[1].text.length).toBeLessThanOrEqual(TEXT_STATE_MAX_CHARS);
  expect(JSON.parse(huge.content[1].text.slice(8, -4))).toMatchObject({ isError: true, truncated: true });
});

it('names the failing field when a handler throws a validation error, never an empty message', async () => {
  const server = new McpServer({ name: 'Validation boundary test', version: '1' });
  const client = new Client({ name: 'Validation boundary client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  // A validation error's own message is its issue list as JSON.
  registerTextTool(server, 'invalid', { description: 'Save a scene.', inputSchema: {}, _meta: {} }, async () => {
    z.object({ emphasis: z.object({ parts: z.array(z.string()).max(2) }) }).parse({ emphasis: { parts: ['a', 'b', 'c'] } });
    return { content: [] };
  });
  try {
    await server.connect(st); await client.connect(ct);
    const failed: any = await client.callTool({ name: 'invalid', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toMatch(/^Invalid emphasis\.parts: .*2/);
    expect(JSON.parse(failed.content[1].text.slice(8, -4)).error.message).toBe(failed.content[0].text);
  } finally { await client.close(); await server.close(); }
});

it('wraps model-visible handler failures with the original prose first and leaves app-only results alone', async () => {
  const server = new McpServer({ name: 'Text boundary test', version: '1' });
  const client = new Client({ name: 'Text boundary client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  registerTextTool(server, 'throws', { description: 'Fail a draw.', inputSchema: {}, _meta: {} }, async () => {
    throw Error('The draw failed.');
  });
  registerTextTool(server, 'plain', { description: 'Read a receipt.', inputSchema: {}, _meta: {} }, async () => ({
    content: [{ type: 'text', text: 'Receipt read.' }],
  }));
  const privateResult = { content: [{ type: 'text' as const, text: 'Private receipt.' }], structuredContent: { saved: true } };
  registerTextTool(server, 'private', { description: 'Save a draw.', inputSchema: {},
    _meta: { ui: { visibility: ['app'] } } }, async () => privateResult);
  try {
    await server.connect(st); await client.connect(ct);
    const failed: any = await client.callTool({ name: 'throws', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(2);
    expect(failed.content[0].text).toBe('The draw failed.');
    expect(JSON.parse(failed.content[1].text.slice(8, -4))).toMatchObject({ isError: true, error: { message: 'The draw failed.' } });
    const plain: any = await client.callTool({ name: 'plain', arguments: {} });
    expect(plain.content[0].text).toBe('Receipt read.');
    expect(textOnly(plain)).toMatchObject({ textStateVersion: 1, truncated: false });
    expect(await client.callTool({ name: 'private', arguments: {} })).toEqual(privateResult);
  } finally { await client.close(); await server.close(); }
});

it('emits one JSON block and prioritizes explicitly requested state over catalogs and history',()=>{
  const measurement={ok:false,errors:[{field:'targets.0',code:'ambiguous',candidates:[{label:'GLY A:1 CA',atomName:'CA'}]}]};
  for(const requested of [{measurement},{residues:{rows:[{key:'residue-key',authorResidue:1}]}}]) {
    const answer=withTextState({structuredContent:{...requested,history:Array(200).fill({id:'past',detail:'x'.repeat(200)}),
      tours:Array(200).fill({id:'tour',title:'x'.repeat(100)})},
      content:[{type:'text',text:JSON.stringify(requested)},{type:'text',text:'State read.'}]});
    const joined=answer.content.map(i=>i.text).join('\n');
    expect(joined.match(/```json/g)).toHaveLength(1);
    expect(joined.split('```')[0]).toBe('State read.\n');
    const state=textOnly(answer);
    expect(state).toMatchObject(requested);
    expect(state.toolSetVersion).toBe('2026-10-14.demo.1');
    expect(state.history).toBeUndefined();
    expect(withTextState(answer).content).toEqual(answer.content);
  }
});

it('returns a complete requested kinesin manifest separately from bounded state and never a partial manifest', async () => {
  const lessonManifest = JSON.parse(await readFile(new URL('../demos/kinesin-walk/motion.json', import.meta.url), 'utf8'));
  expect(JSON.stringify(lessonManifest).length).toBeGreaterThan(6000);
  const answer = withTextState({ structuredContent: { sessionId: 'kinesin', lessonManifest, history: Array(100).fill('x'.repeat(1000)) } });
  expect(textOnly(answer).lessonManifest).toEqual(lessonManifest);
  expect(answer.content).toHaveLength(2);
  expect(answer.content[0].text.length).toBeGreaterThan(6000);
  expect(answer.content[1].text.length).toBeLessThanOrEqual(6000);
  expect(withTextState(answer).content).toEqual(answer.content);
  for (const manifest of [{ ...lessonManifest, chapters: [] }, { ...lessonManifest, title: 'x'.repeat(262145) }]) {
    const rejected = withTextState({ structuredContent: { lessonManifest: manifest } });
    const projected = textOnly(rejected);
    expect(projected.lessonManifest).toBeUndefined();
    expect(projected.truncated).toBe(true);
    expect(projected.lessonManifestNotice).toContain('omitted');
    expect(JSON.stringify(rejected.content)).not.toContain('structuredContent');
  }
});

it('states terminal polling semantics on every command and source receipt', () => {
  const terminals = ['rendered','saved','rejected','conflict','expired','unconfirmed','cancelled','superseded','failed'];
  for (const status of [...terminals, 'queued', 'rendering']) {
    const state = textOnly(withTextState({ structuredContent: {
      command: {commandId:'edit', status}, sourceRenderReceipt: {commandId:'source', status},
    } }));
    for (const key of ['command', 'sourceRenderReceipt']) {
      expect(state[key].terminal).toBe(terminals.includes(status));
    }
    expect(state.terminalStatuses).toEqual(terminals);
  }
});

it('names each lesson chapter and the current scale when a voice host joins, so a request needs no read first', async () => {
  const t = await setup();
  try {
    const raw = await t.rawCall('continue_session', { assistant: 'Claude' });
    const joined = textOnly(raw);
    expect(joined.scene.lesson.chapters).toEqual([{ step: 0, id: 'two-steps', title: 'Two steps', line: 'Motion chapter.' }]);
    const text = raw.content.map((item: any) => item.text).join('\n');
    expect(text).toContain('Placement scale 1.');
    expect(text).toContain('Steps: 0 Two steps (Motion chapter.).');
  } finally { await t.close(); }
});
