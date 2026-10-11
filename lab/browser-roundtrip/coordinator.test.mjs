import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserCoordinator, validateCamera } from './coordinator.mjs';
import { copy, sha256 } from '../protocol/contracts.mjs';
import identity from '../identity/identity.cjs';

// Unit fixtures supply catalogs and draw receipts. Only the browser verifier observes Mol* rendering.
const target = { bindingId: 'binding-a', taskId: 'task-a', panelId: 'panel-a', sessionId: 'session-a', deviceId: 'device-a' };
const camera = () => ({ mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 60], up: [0, 1, 0],
  target: [0, 0, 0], radius: 12, radiusMax: 16, fog: 50, clipFar: true, minNear: 5, minFar: 0 });
const rejects = code => error => error.code === code;

function sourceFixture() {
  const cif = 'data_synthetic_coordinator_unit_fixture\n';
  const hash = sha256(cif);
  const rows = [1, 2].map(modelNumber => {
    const value = { sourceHash: hash, modelNumber, assemblyId: '1', copyId: '["copy","1",0,["1"]]',
      entityId: '1', labelChain: 'A', authorChain: 'X', labelSequenceId: 1, authorResidue: 15,
      insertionCode: '', componentId: 'GLY' };
    return { key: identity.residueKey(value), identity: value, coordinateState: 'resolved', atomSites: [{}] };
  });
  return { id: 'fixture-a', cif, catalog: { source: { sha256: hash, byteLength: Buffer.byteLength(cif) },
    assemblyId: '1', modelNumbers: [1, 2], rows } };
}

function setup() {
  let now = 100;
  const source = sourceFixture();
  const coordinator = new BrowserCoordinator({ clock: () => now, target, pinnedSources: [source] });
  const envelope = { version: 1, captureId: 'capture-a', target: copy(target), sceneId: 'captured-scene-a',
    desktopRevision: 4, fixtureId: source.id, cif: source.cif,
    scene: { sourceSha256: source.catalog.source.sha256, modelNumber: 1, assemblyId: '1',
      representation: 'cartoon', color: 'chain-id', selectionKeys: [source.catalog.rows[0].key], camera: camera() } };
  return { coordinator, envelope, source, advance: ms => { now += ms; } };
}

function drawSnapshot(scene, changes = {}) {
  return { ...copy(scene), status: 'ready', ready: true, error: null, instanceId: 'receiver-instance',
    generation: 3, loadCount: 2, revision: 7, drawCount: 9, representationCount: 1, renderObjectCount: 1,
    selectedMarkerCount: scene.selectionKeys.length ? 1 : 0, selectionLociElementCount: scene.selectionKeys.length ? 1 : 0,
    ...changes };
}

async function boundSetup() {
  const context = setup();
  const { instruction, protocolState } = await context.coordinator.transfer(context.envelope);
  const snapshot = drawSnapshot(instruction.scene);
  context.coordinator.bindRenderedCapture(instruction, snapshot);
  return { ...context, instruction, protocolState, snapshot };
}

function nextDraw(snapshot, changes = {}) {
  return { ...copy(snapshot), representation: 'ball-and-stick', revision: snapshot.revision + 1,
    drawCount: snapshot.drawCount + 1, ...changes };
}

test('C01 full camera snapshots are detached and retain projection/clipping fields', () => {
  for (const mode of ['perspective', 'orthographic']) {
    const input = { ...camera(), mode };
    const result = validateCamera(input);
    input.position[0] = 123;
    assert.deepEqual(result, { ...camera(), mode });
  }
  for (const name of Object.keys(camera())) {
    const missing = camera();
    delete missing[name];
    assert.throws(() => validateCamera(missing), rejects('invalid_camera_fields'));
  }
});

for (const [label, mutate, code] of [
  ['tracking field', c => { c.headPose = [0, 0, 0]; }, 'invalid_camera_fields'],
  ['zero field of view', c => { c.fov = 0; }, 'invalid_camera_fov'],
  ['sparse vector', c => { c.position = new Array(3); }, 'invalid_camera_vector'],
  ['unbounded vector', c => { c.position[0] = 1_000_001; }, 'invalid_camera_vector'],
  ['zero radius', c => { c.radius = 0; }, 'invalid_camera_distance'],
  ['nonfinite clipping', c => { c.minNear = Infinity; }, 'invalid_camera_distance'],
  ['invalid fog', c => { c.fog = 101; }, 'invalid_camera_clipping'],
  ['coincident position', c => { c.position = copy(c.target); }, 'degenerate_camera'],
  ['parallel up', c => { c.up = [0, 0, 1]; }, 'degenerate_camera'],
]) {
  test(`C02 camera rejects ${label}`, () => {
    const input = camera(); mutate(input);
    assert.throws(() => validateCamera(input), rejects(code));
  });
}

test('C03 capture commits validated bytes and compact selections without claiming a rendered scene', async () => {
  const { coordinator, envelope, source } = setup();
  const expected = copy(envelope.scene);
  const pending = coordinator.transfer(envelope);
  envelope.scene.camera.position[0] = 555;
  envelope.scene.selectionKeys.length = 0;
  source.catalog.rows[0].key = 'changed-after-construction';
  const { instruction, protocolState } = await pending;
  assert.deepEqual(instruction.scene, expected);
  assert.equal(instruction.captureDigest.length, 64);
  assert.deepEqual(protocolState.state.manifest.selectionKeys, [sha256(expected.selectionKeys[0])]);
  assert.equal(protocolState.state.renderedRevision, null);
  assert.equal(coordinator.inspect().browser, null);
  instruction.scene.camera.position[0] = -999;
  assert.deepEqual(coordinator.inspect().currentCapture.scene, expected);
});

for (const [label, mutate, code] of [
  ['another panel', e => { e.target.panelId = 'panel-b'; }, 'wrong_target'],
  ['unknown fixture', e => { e.fixtureId = 'other'; }, 'unknown_fixture'],
  ['changed bytes', e => { e.cif += 'changed'; }, 'source_bytes_mismatch'],
  ['wrong source hash', e => { e.scene.sourceSha256 = '0'.repeat(64); }, 'source_hash_mismatch'],
  ['another model', e => { e.scene.modelNumber = 3; }, 'model_unavailable'],
  ['another assembly', e => { e.scene.assemblyId = '2'; }, 'assembly_unavailable'],
  ['selection from another model', e => { e.scene.modelNumber = 2; }, 'selection_unavailable'],
  ['missing camera field', e => { delete e.scene.camera.fog; }, 'invalid_camera_fields'],
  ['undeclared scene field', e => { e.scene.headPose = []; }, 'invalid_scene_fields'],
]) {
  test(`C04 capture rejects ${label} before changing protocol state`, async () => {
    const { coordinator, envelope } = setup();
    const before = coordinator.inspect(); mutate(envelope);
    await assert.rejects(coordinator.transfer(envelope), rejects(code));
    assert.deepEqual(coordinator.inspect(), before);
  });
}

test('C05 capture IDs retain immutable contents and duplicates do not replace the scene twice', async () => {
  const { coordinator, envelope } = setup();
  const first = await coordinator.transfer(envelope);
  const duplicate = await coordinator.transfer(Object.fromEntries(Object.entries(envelope).reverse()));
  assert.deepEqual(duplicate, first);
  assert.equal(coordinator.inspect().protocolState.state.revision, 1);
  envelope.scene.camera.position[0] = 4;
  await assert.rejects(coordinator.transfer(envelope), rejects('capture_id_conflict'));
});

test('C06 binding requires the issued instruction and a matching loaded draw', async () => {
  const { coordinator, envelope } = setup();
  const { instruction } = await coordinator.transfer(envelope);
  const snapshot = drawSnapshot(instruction.scene);
  assert.throws(() => coordinator.bindRenderedCapture({ ...instruction, captureDigest: '0'.repeat(64) }, snapshot),
    rejects('unknown_capture_instruction'));
  assert.throws(() => coordinator.bindRenderedCapture(instruction, { ...snapshot, drawCount: 0 }),
    rejects('invalid_viewer_counters'));
  const wrongCamera = copy(snapshot); wrongCamera.camera.fov += 0.1;
  assert.throws(() => coordinator.bindRenderedCapture(instruction, wrongCamera), rejects('render_camera_mismatch'));
  assert.equal(coordinator.bindRenderedCapture(instruction, snapshot).status, 'capture_rendered');
  assert.throws(() => coordinator.bindRenderedCapture(instruction, { ...snapshot, instanceId: 'replacement-viewer' }),
    rejects('capture_instance_changed'));
  assert.equal(coordinator.inspect().protocolState.state.renderedRevision, null,
    'The transfer state model has no command render ticket');
});

test('C07 actual apply proof authorizes only its Node-held revision and records a separate browser revision', async () => {
  const { coordinator, snapshot } = await boundSetup();
  const request = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
  let calls = 0;
  const result = await coordinator.command(request, async instruction => {
    calls++;
    assert.equal(instruction.revision, 2);
    assert.equal(instruction.expectedBrowser.revision, 7);
    assert.equal(Object.hasOwn(instruction, 'nonce'), false);
    instruction.expectedBrowser.revision = 1000;
    return nextDraw(snapshot);
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'rendered');
  assert.equal(result.renderedRevision, 2);
  assert.equal(result.renderer.browser.revision, 8);
  assert.equal(coordinator.inspect().protocolState.commitCount, 1);
});

test('C08 in-flight and completed duplicates dispatch the browser mutation once', async () => {
  const { coordinator, snapshot } = await boundSetup();
  const request = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
  let release; let entered; let calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const first = coordinator.command(request, async () => { calls++; entered(); await held; return nextDraw(snapshot); });
  await started;
  const duplicate = coordinator.command(copy(request), async () => { calls++; throw new Error('Duplicate dispatch'); });
  release();
  assert.equal((await first).status, 'rendered');
  assert.equal((await duplicate).status, 'rendered');
  assert.equal((await coordinator.command(request, async () => { calls++; })).status, 'rendered');
  assert.equal(calls, 1);
  assert.equal(coordinator.inspect().protocolState.commitCount, 1);
});

test('C09 wrong-target and conflicting duplicate content never dispatch a browser mutation', async () => {
  const { coordinator, snapshot } = await boundSetup();
  const request = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
  let calls = 0;
  const apply = async () => { calls++; return nextDraw(snapshot); };
  const wrong = { ...copy(request), target: { ...target, sessionId: 'another-session' } };
  assert.equal((await coordinator.command(wrong, apply)).reason, 'wrong_target');
  assert.equal(calls, 0);
  await coordinator.command(request, apply);
  assert.equal((await coordinator.command({ ...request, operation: { kind: 'set_representation', value: 'cartoon' } }, apply)).reason,
    'command_id_conflict');
  assert.equal(calls, 1);
});

for (const [label, mutate, code] of [
  ['old draw', s => { s.drawCount = 9; }, 'render_did_not_advance'],
  ['old revision', s => { s.revision = 7; }, 'render_did_not_advance'],
  ['two browser mutations', s => { s.revision = 9; }, 'render_did_not_advance'],
  ['another instance', s => { s.instanceId = 'other-viewer'; }, 'render_instance_mismatch'],
  ['another load', s => { s.loadCount++; }, 'render_instance_mismatch'],
  ['retired generation', s => { s.generation++; }, 'render_instance_mismatch'],
  ['another source', s => { s.sourceSha256 = '0'.repeat(64); }, 'render_source_mismatch'],
  ['wrong representation', s => { s.representation = 'cartoon'; }, 'render_appearance_mismatch'],
  ['lost selection', s => { s.selectionKeys = []; }, 'render_selection_mismatch'],
  ['missing selection markers', s => { s.selectedMarkerCount = 0; }, 'render_selection_markers_mismatch'],
  ['missing selection loci', s => { s.selectionLociElementCount = 0; }, 'render_selection_markers_mismatch'],
  ['moved camera', s => { s.camera.position[0] = 5; }, 'render_camera_mismatch'],
  ['missing render objects', s => { s.renderObjectCount = 0; }, 'missing_render_objects'],
  ['lost WebGL context', s => { s.contextLost = true; }, 'viewer_not_ready'],
]) {
  test(`C10 ${label} cannot confirm a command`, async () => {
    const { coordinator, snapshot } = await boundSetup();
    const request = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
    const proof = nextDraw(snapshot); mutate(proof);
    const result = await coordinator.command(request, async () => proof);
    assert.equal(result.status, 'committed');
    assert.equal(result.renderedRevision, null);
    assert.equal(result.renderer.status, 'unconfirmed');
    assert.equal(result.renderer.reason, code);
    assert.equal(coordinator.inspect().protocolState.commitCount, 1);
    assert.equal(coordinator.inspect().events.some(event => event.type === 'command_rendered'), false);
  });
}

test('C11 apply failure remains committed and a retry cannot dispatch again', async () => {
  const { coordinator } = await boundSetup();
  const request = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
  let calls = 0;
  const apply = async () => { calls++; throw new Error('Renderer failed after apply may have started'); };
  const first = await coordinator.command(request, apply);
  const retry = await coordinator.command(request, apply);
  assert.equal(first.status, 'committed');
  assert.equal(first.renderer.reason, 'browser_apply_failed');
  assert.equal(retry.status, 'committed');
  assert.equal(calls, 1);
  assert.equal(coordinator.inspect().protocolState.state.renderedRevision, null);
});

test('C12 queued commands recheck their revision before the browser is called', async () => {
  const { coordinator, snapshot } = await boundSetup();
  const first = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
  const second = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
  let calls = 0;
  const apply = async () => { calls++; return nextDraw(snapshot); };
  const [a, b] = await Promise.all([coordinator.command(first, apply), coordinator.command(second, apply)]);
  assert.equal(a.status, 'rendered');
  assert.equal(b.reason, 'revision_conflict');
  assert.equal(b.renderer.status, 'not_dispatched');
  assert.equal(calls, 1);
});

test('C13 replacement during apply retires the original rendering authorization', async () => {
  const { coordinator, envelope, snapshot } = await boundSetup();
  const request = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
  const result = await coordinator.command(request, async () => {
    await coordinator.transfer({ ...copy(envelope), captureId: 'capture-b', sceneId: 'captured-scene-b' });
    return nextDraw(snapshot);
  });
  assert.equal(result.status, 'superseded');
  assert.equal(result.renderer.reason, 'render_ticket_retired');
  assert.equal(coordinator.inspect().currentCapture.sceneId, 'captured-scene-b');
  assert.equal(coordinator.inspect().browser, null);
  assert.equal(coordinator.inspect().protocolState.state.renderedRevision, null);
});

test('C14 unsupported browser transforms cannot become unverified protocol mutations', async () => {
  const { coordinator } = await boundSetup();
  const request = coordinator.makeCommand({ kind: 'rotate_object', axis: 'x', degrees: 15 });
  const result = await coordinator.command(request, async () => { throw new Error('Unexpected call'); });
  assert.equal(result.reason, 'unsupported_browser_operation');
  assert.equal(coordinator.inspect().protocolState.commitCount, 0);
});

test('C15 an unresolved sequence selection requires zero spatial markers and loci', async () => {
  const source = sourceFixture();
  source.catalog.rows[0].coordinateState = 'unresolved';
  source.catalog.rows[0].atomSites = [];
  const coordinator = new BrowserCoordinator({ clock: () => 100, target, pinnedSources: [source] });
  const envelope = setup().envelope;
  const { instruction } = await coordinator.transfer(envelope);
  assert.throws(() => coordinator.bindRenderedCapture(instruction, drawSnapshot(instruction.scene)),
    rejects('render_selection_markers_mismatch'));
  assert.equal(coordinator.bindRenderedCapture(instruction, drawSnapshot(instruction.scene,
    { selectedMarkerCount: 0, selectionLociElementCount: 0 })).status, 'capture_rendered');
});
