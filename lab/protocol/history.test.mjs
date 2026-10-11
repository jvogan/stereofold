import test from 'node:test';
import assert from 'node:assert/strict';
import { InspectionHistory, replayHistory } from './history.mjs';
import { canonical, copy, sha256 } from './contracts.mjs';
import identity from '../identity/identity.cjs';

// These tests inject camera snapshots and draw receipts. The browser verifier owns actual Mol* observations.
const target = { bindingId: 'binding-a', taskId: 'task-a', panelId: 'panel-a', sessionId: 'session-a', deviceId: 'device-a' };
const scope = { target, serverEpoch: 'server-a', receiverEpoch: 'receiver-a', leaseId: 'lease-a', sceneId: 'scene-a' };
const sourceSha256 = sha256('public synthetic history unit fixture');
const camera = () => ({ mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 60], up: [0, 1, 0],
  target: [0, 0, 0], radius: 12, radiusMax: 16, fog: 50, clipFar: true, minNear: 5, minFar: 0 });
const cameraB = () => ({ mode: 'orthographic', fov: Math.PI / 3, position: [24, 12, 36], up: [0, 1, 0],
  target: [1, 2, 3], radius: 9, radiusMax: 18, fog: 35, clipFar: false, minNear: 2, minFar: 1 });
const initialRenderer = { instanceId: 'viewer-a', generation: 2, loadCount: 1, browserRevision: 5, drawCount: 10 };
const rejects = code => error => error.code === code;

function keys(assemblyId = 'asymmetric_unit') {
  return [1, 2, 3].map(position => identity.residueKey({ sourceHash: sourceSha256, modelNumber: 1, assemblyId,
    copyId: identity.copyKey({ assemblyId, generatorIndex: assemblyId === 'asymmetric_unit' ? null : 0,
      operatorIds: assemblyId === 'asymmetric_unit' ? [] : ['1'] }), entityId: '1', labelChain: 'A',
    authorChain: position === 3 ? null : 'X', labelSequenceId: position,
    authorResidue: position === 3 ? null : position + 14, insertionCode: position === 3 ? null : '', componentId: 'GLY' }));
}

function setup(options = {}) {
  let now = 100;
  let sequence = 0;
  const selectionKeys = keys(options.initial?.assemblyId);
  const initial = { revision: 0, sourceSha256, modelNumber: 1, assemblyId: 'asymmetric_unit',
    representation: 'cartoon', color: 'chain-id', selectionKeys: [selectionKeys[0]], camera: camera(), ...options.initial };
  const configuration = { clock: () => now, scope: copy(scope), initial, initialRenderer: copy(initialRenderer),
    selectionKeys, actors: ['actor-a', 'actor-b'], ...options, initial };
  const history = new InspectionHistory(configuration);
  function request(operation = { kind: 'set_representation', value: 'ball-and-stick' }, changes = {}) {
    return history.makeRequest(operation, { operationId: `lease-a/${++sequence}`, actorId: 'actor-a', ...changes });
  }
  function receipt(revisionValue = history.inspect().snapshot.revision, changes = {}) {
    const previous = history.inspect().lastRendered;
    return { revision: revisionValue, instanceId: previous.instanceId, generation: previous.generation,
      loadCount: previous.loadCount, browserRevision: previous.browserRevision + 1,
      drawCount: previous.drawCount + 1, ...changes };
  }
  function complete(value = request()) {
    history.admit(value);
    const planned = history.preview(value.operationId);
    history.commit(value.operationId, planned.snapshot);
    if (planned.requiresRender) history.confirmRendered(value.operationId, receipt());
    return value;
  }
  return { history, initial, configuration, selectionKeys, request, receipt, complete,
    advance: ms => { now += ms; } };
}

function resign(input) {
  const log = copy(input);
  let previousHash = sha256(canonical(log.header));
  for (const event of log.events) {
    delete event.hash;
    event.previousHash = previousHash;
    event.hash = sha256(canonical(event));
    previousHash = event.hash;
  }
  return log;
}

test('H01 admission preserves the view; commit and rendered confirmation retain different revisions', () => {
  const { history, request, receipt } = setup();
  const value = request();
  history.admit(value);
  assert.equal(history.inspect().snapshot.representation, 'cartoon');
  assert.equal(history.inspect().lastRendered.revision, 0);
  const next = history.preview(value.operationId);
  assert.equal(next.snapshot.representation, 'ball-and-stick');
  assert.equal(history.operation(value.operationId).committedRevision, null);
  history.commit(value.operationId, next.snapshot);
  assert.equal(history.inspect().snapshot.representation, 'ball-and-stick');
  assert.equal(history.operation(value.operationId).status, 'committed');
  assert.equal(history.inspect().lastRendered.revision, 0);
  history.confirmRendered(value.operationId, receipt());
  assert.equal(history.operation(value.operationId).renderedRevision, 1);
  assert.deepEqual(history.exportLog().events.map(event => event.type), ['admitted', 'committed', 'rendered']);
});

test('H02 cancellation before commit prevents the pending change and cannot cancel another actor', () => {
  const { history, request, initial } = setup();
  const value = request();
  history.admit(value);
  const after = history.preview(value.operationId).snapshot;
  assert.throws(() => history.cancel(value.operationId, 'actor-b'), rejects('history_cancel_actor_conflict'));
  assert.equal(history.cancel(value.operationId, 'actor-a').status, 'cancelled');
  const count = history.inspect().eventCount;
  assert.equal(history.commit(value.operationId, after).status, 'cancelled');
  assert.equal(history.cancel(value.operationId, 'actor-a').status, 'cancelled');
  assert.equal(history.inspect().eventCount, count);
  assert.deepEqual(history.inspect().snapshot, initial);
  assert.equal(history.inspect().reservedEvents, 0);
});

test('H03 cancellation cannot reverse a committed change', () => {
  const { history, request } = setup();
  const value = request();
  history.admit(value);
  history.commit(value.operationId, history.preview(value.operationId).snapshot);
  const before = history.inspect();
  assert.throws(() => history.cancel(value.operationId, 'actor-a'), rejects('history_phase_conflict'));
  assert.deepEqual(history.inspect(), before);
});

test('H04 queued operations recheck revision; the later actor receives a retained rejection', () => {
  const { history, request, complete } = setup();
  const a = request();
  const b = request({ kind: 'set_camera', camera: cameraB() }, { actorId: 'actor-b' });
  history.admit(b);
  const stale = history.preview(b.operationId).snapshot;
  complete(a);
  assert.equal(history.commit(b.operationId, stale).reason, 'history_revision_conflict');
  assert.equal(history.admit(b).status, 'rejected');
  assert.deepEqual(history.inspect().snapshot.camera, camera());
  assert.equal(history.inspect().snapshot.revision, 1);
});

test('H05 exact retries preserve all phases without adding log entries or applying an operation again', () => {
  const { history, request, receipt } = setup();
  const value = request();
  history.admit(value);
  assert.equal(history.admit(copy(value)).status, 'admitted');
  assert.equal(history.inspect().eventCount, 1);
  const next = history.preview(value.operationId).snapshot;
  history.commit(value.operationId, next);
  assert.equal(history.admit(value).status, 'committed');
  assert.equal(history.commit(value.operationId, copy(next)).status, 'committed');
  const draw = receipt();
  history.confirmRendered(value.operationId, draw);
  assert.equal(history.admit(value).status, 'rendered');
  assert.equal(history.confirmRendered(value.operationId, draw).status, 'rendered');
  assert.equal(history.inspect().eventCount, 3);
  assert.equal(history.inspect().snapshot.revision, 1);
});

test('H06 operation IDs retain exact contents, including selection array order', () => {
  const { history, request, selectionKeys } = setup();
  const value = request({ kind: 'set_selection', selectionKeys: [selectionKeys[1], selectionKeys[2]] });
  history.admit(value);
  const changed = copy(value);
  changed.operation.selectionKeys.reverse();
  assert.throws(() => history.admit(changed), rejects('history_operation_id_conflict'));
  changed.operation = { kind: 'set_camera', camera: cameraB() };
  assert.throws(() => history.admit(changed), rejects('history_operation_id_conflict'));
  assert.equal(history.inspect().eventCount, 1);
});

for (const [name, change] of [
  ['task', s => { s.target.taskId = 'task-b'; }],
  ['panel', s => { s.target.panelId = 'panel-b'; }],
  ['session', s => { s.target.sessionId = 'session-b'; }],
  ['device', s => { s.target.deviceId = 'device-b'; }],
  ['binding', s => { s.target.bindingId = 'binding-b'; }],
  ['scene', s => { s.sceneId = 'scene-b'; }],
  ['server epoch', s => { s.serverEpoch = 'server-b'; }],
  ['receiver epoch', s => { s.receiverEpoch = 'receiver-b'; }],
  ['lease', s => { s.leaseId = 'lease-b'; }],
]) {
  test(`H07 a known operation from another ${name} cannot disclose its outcome`, () => {
    const { history, request, complete } = setup();
    const value = complete(request());
    const wrong = copy(value); change(wrong.scope);
    assert.throws(() => history.admit(wrong), rejects('wrong_history_scope'));
    assert.equal(history.inspect().eventCount, 3);
  });
}

test('H08 undo uses a new revision and operation ID; duplicate undo changes the appearance once', () => {
  const { history, request, complete, receipt, initial } = setup();
  const original = complete(request());
  const undo = history.prepareUndo(original.operationId, { operationId: 'lease-a/20', actorId: 'actor-a' });
  assert.equal(undo.cause.operationId, original.operationId);
  assert.equal(undo.expectedRevision, 1);
  history.admit(undo);
  const planned = history.preview(undo.operationId).snapshot;
  assert.equal(planned.representation, 'cartoon');
  history.commit(undo.operationId, planned);
  const draw = receipt();
  history.confirmRendered(undo.operationId, draw);
  const count = history.inspect().eventCount;
  assert.equal(history.admit(undo).status, 'rendered');
  assert.equal(history.commit(undo.operationId, planned).status, 'rendered');
  assert.equal(history.confirmRendered(undo.operationId, draw).status, 'rendered');
  assert.equal(history.inspect().eventCount, count);
  assert.deepEqual(history.inspect().snapshot, { ...initial, revision: 2 });
  assert.equal(history.operation(original.operationId).undoneBy, undo.operationId);
  assert.throws(() => history.prepareUndo(original.operationId, { operationId: 'lease-a/21', actorId: 'actor-a' }),
    rejects('operation_already_undone'));
});

test('H09 a newer edit conflicts with undo even when that edit comes from the same actor', () => {
  for (const actorId of ['actor-a', 'actor-b']) {
    const { history, request, complete } = setup();
    const original = complete(request());
    complete(request({ kind: 'set_camera', camera: cameraB() }, { actorId }));
    const before = history.inspect();
    assert.throws(() => history.prepareUndo(original.operationId, { operationId: 'lease-a/20', actorId: 'actor-a' }),
      rejects('undo_revision_conflict'));
    assert.deepEqual(history.inspect(), before);
  }
});

test('H10 undo queued before another actor commits is rejected without restoring stale camera or style', () => {
  const { history, request, complete } = setup();
  const original = complete(request());
  const undo = history.prepareUndo(original.operationId, { operationId: 'lease-a/20', actorId: 'actor-a' });
  history.admit(undo);
  const undoSnapshot = history.preview(undo.operationId).snapshot;
  complete(request({ kind: 'set_camera', camera: cameraB() }, { actorId: 'actor-b' }));
  const before = history.inspect().snapshot;
  assert.equal(history.commit(undo.operationId, undoSnapshot).reason, 'history_revision_conflict');
  assert.deepEqual(history.inspect().snapshot, before);
  assert.equal(history.operation(original.operationId).undoneBy, null);
});

test('H11 another actor cannot undo a completed change', () => {
  const { history, request, complete } = setup();
  const original = complete(request());
  assert.throws(() => history.prepareUndo(original.operationId, { operationId: 'lease-a/20', actorId: 'actor-b' }),
    rejects('undo_actor_conflict'));
});

test('H12 an unconfirmed, cancelled, saved-view, or undo operation cannot be used as a completed inverse', () => {
  for (const phase of ['admitted', 'committed', 'cancelled', 'renderer_failed']) {
    const { history, request } = setup();
    const original = request(); history.admit(original);
    if (phase === 'committed' || phase === 'renderer_failed') history.commit(original.operationId, history.preview(original.operationId).snapshot);
    if (phase === 'cancelled') history.cancel(original.operationId, 'actor-a');
    if (phase === 'renderer_failed') history.rendererFailed(original.operationId, 'context_lost');
    assert.throws(() => history.prepareUndo(original.operationId, { operationId: 'lease-a/20', actorId: 'actor-a' }),
      rejects('undo_requires_rendered_change'));
  }
  const { history, request, complete } = setup();
  const saved = complete(request({ kind: 'save_view', viewId: 'view-a', name: 'Ligand inspection' }));
  assert.throws(() => history.prepareUndo(saved.operationId, { operationId: 'lease-a/20', actorId: 'actor-a' }),
    rejects('operation_not_undoable'));
  const changed = complete(request());
  const inverse = history.prepareUndo(changed.operationId, { operationId: 'lease-a/21', actorId: 'actor-a' });
  complete(inverse);
  assert.throws(() => history.prepareUndo(inverse.operationId, { operationId: 'lease-a/22', actorId: 'actor-a' }),
    rejects('operation_not_undoable'));
});

test('H13 saved views preserve all camera fields and semantic selection without changing appearance on restore', () => {
  const { history, selectionKeys, request, complete, initial } = setup();
  const savedRequest = complete(request({ kind: 'save_view', viewId: 'active-site', name: 'Active site' }));
  const saved = history.savedView('active-site');
  assert.equal(history.operation(savedRequest.operationId).requiresRender, false);
  assert.equal(history.operation(savedRequest.operationId).status, 'committed');
  assert.deepEqual(saved.scope, scope);
  assert.deepEqual(saved.camera, camera());
  assert.deepEqual(saved.selectionKeys, initial.selectionKeys);
  assert.equal(saved.capturedRevision, 0);
  complete(request({ kind: 'set_camera', camera: cameraB() }));
  complete(request({ kind: 'set_selection', selectionKeys: [selectionKeys[2]] }));
  complete(request());
  const beforeRestore = copy(history.inspect().snapshot);
  const restored = complete(request({ kind: 'restore_view', viewId: 'active-site' }));
  assert.deepEqual(history.inspect().snapshot.camera, camera());
  assert.deepEqual(history.inspect().snapshot.selectionKeys, initial.selectionKeys);
  assert.equal(history.inspect().snapshot.representation, 'ball-and-stick');
  saved.camera.position[0] = 999;
  saved.selectionKeys.length = 0;
  assert.deepEqual(history.savedView('active-site').camera, camera());
  const undo = history.prepareUndo(restored.operationId, { operationId: 'lease-a/20', actorId: 'actor-a' });
  complete(undo);
  assert.deepEqual(history.inspect().snapshot, { ...beforeRestore, revision: beforeRestore.revision + 2 });
});

test('H14 saved view IDs and names are unique; the capacity rejects additional views without evicting one', () => {
  const { history, request, complete } = setup({ limits: { maxSavedViews: 1 } });
  complete(request({ kind: 'save_view', viewId: 'view-a', name: 'Binding site' }));
  const before = history.inspect();
  assert.throws(() => history.admit(request({ kind: 'save_view', viewId: 'view-a', name: 'Another name' })),
    rejects('saved_view_id_conflict'));
  assert.throws(() => history.admit(request({ kind: 'save_view', viewId: 'view-b', name: 'binding site' })),
    rejects('saved_view_name_conflict'));
  assert.throws(() => history.admit(request({ kind: 'save_view', viewId: 'view-b', name: 'Another view' })),
    rejects('saved_view_capacity'));
  assert.deepEqual(history.inspect(), before);
});

test('H15 saved views cannot import tracking or a user-supplied camera under a save request', () => {
  const { history, request } = setup();
  for (const name of ['', '  ', ' leading', 'trailing ', 'x\nname', 'x'.repeat(81)]) {
    assert.throws(() => request({ kind: 'save_view', viewId: 'view-a', name }), rejects('invalid_saved_view_name'));
  }
  const value = request({ kind: 'save_view', viewId: 'view-a', name: 'Site' });
  value.operation.headPose = [0, 0, 0];
  assert.throws(() => history.admit(value), rejects('invalid_fields'));
  delete value.operation.headPose;
  value.operation.camera = cameraB();
  assert.throws(() => history.admit(value), rejects('invalid_fields'));
  assert.equal(history.inspect().savedViews.length, 0);
});

test('H16 a missing-coordinate residue remains a full key through selection, save, restore, and replay', () => {
  const { history, request, complete, selectionKeys } = setup();
  complete(request({ kind: 'set_selection', selectionKeys: [selectionKeys[2]] }));
  complete(request({ kind: 'save_view', viewId: 'gap', name: 'Unresolved position' }));
  complete(request({ kind: 'set_selection', selectionKeys: [] }));
  complete(request({ kind: 'restore_view', viewId: 'gap' }));
  assert.deepEqual(history.inspect().snapshot.selectionKeys, [selectionKeys[2]]);
  assert.deepEqual(history.inspect().snapshot.camera, camera());
  assert.deepEqual(replayHistory(history.exportLog()).snapshot, history.inspect().snapshot);
  assert.equal(Object.hasOwn(history.savedView('gap'), 'positionAngstrom'), false);
});

for (const [name, mutate, code] of [
  ['source', value => { value.sourceSha256 = '0'.repeat(64); }, 'scientific_identity_changed'],
  ['model', value => { value.modelNumber = 2; }, 'scientific_identity_changed'],
  ['assembly', value => { value.assemblyId = '1'; }, 'scientific_identity_changed'],
  ['undeclared head tracking', value => { value.headPose = []; }, 'invalid_history_snapshot'],
  ['missing clipping field', value => { delete value.camera.clipFar; }, 'invalid_camera_fields'],
  ['degenerate camera', value => { value.camera.position = copy(value.camera.target); }, 'degenerate_camera'],
  ['unbounded camera', value => { value.camera.target[0] = 1_000_001; }, 'invalid_camera_vector'],
  ['different selection', value => { value.selectionKeys = []; }, 'history_commit_mismatch'],
  ['wrong shared revision', value => { value.revision = 7; }, 'history_commit_mismatch'],
]) {
  test(`H17 commit rejects ${name} before changing history or the model`, () => {
    const { history, request } = setup();
    const value = request(); history.admit(value);
    const candidate = history.preview(value.operationId).snapshot;
    const before = history.inspect(); mutate(candidate);
    assert.throws(() => history.commit(value.operationId, candidate), rejects(code));
    assert.deepEqual(history.inspect(), before);
  });
}

test('H18 full selection catalogs bind source, model, and assembly copy; an unknown key cannot be selected', () => {
  for (const index of [1, 2, 3]) {
    const { configuration } = setup();
    const altered = JSON.parse(configuration.selectionKeys[0]);
    if (index === 1) altered[1] = '0'.repeat(64);
    if (index === 2) altered[2] = 2;
    if (index === 3) altered[3] = identity.copyKey({ assemblyId: '1', generatorIndex: 0, operatorIds: ['1'] });
    configuration.selectionKeys = [JSON.stringify(altered)];
    assert.throws(() => new InspectionHistory(configuration), rejects('selection_scope_mismatch'));
  }
  const { history, request } = setup();
  assert.throws(() => request({ kind: 'set_selection', selectionKeys: ['residue-a'] }), rejects('selection_unavailable'));
  assert.equal(history.inspect().eventCount, 0);
  assert.equal(setup({ initial: { assemblyId: '1' } }).history.inspect().snapshot.assemblyId, '1');
});

for (const [name, changes, code] of [
  ['an old draw', { drawCount: initialRenderer.drawCount }, 'history_render_did_not_advance'],
  ['the old browser revision', { browserRevision: initialRenderer.browserRevision }, 'history_render_did_not_advance'],
  ['a skipped browser revision', { browserRevision: initialRenderer.browserRevision + 2 }, 'history_render_did_not_advance'],
  ['another instance', { instanceId: 'viewer-b' }, 'history_render_binding_mismatch'],
  ['a newer load generation', { generation: 3 }, 'history_render_binding_mismatch'],
  ['a replacement load', { loadCount: 2 }, 'history_render_binding_mismatch'],
  ['the old shared revision', { revision: 0 }, 'stale_history_render'],
]) {
  test(`H19 confirmation rejects ${name} and leaves the operation committed`, () => {
    const { history, request, receipt } = setup();
    const value = request(); history.admit(value);
    history.commit(value.operationId, history.preview(value.operationId).snapshot);
    const before = history.inspect();
    assert.throws(() => history.confirmRendered(value.operationId, receipt(undefined, changes)), rejects(code));
    assert.deepEqual(history.inspect(), before);
    assert.equal(history.confirmRendered(value.operationId, receipt()).status, 'rendered');
  });
}

test('H20 unconfirmed older commits become superseded; their callbacks cannot confirm the newer revision', () => {
  const { history, request, receipt } = setup();
  const older = request(); history.admit(older);
  history.commit(older.operationId, history.preview(older.operationId).snapshot);
  const oldReceipt = receipt();
  const observedOlder = { operationId: older.operationId, snapshot: history.inspect().snapshot, receipt: oldReceipt };
  const newer = request({ kind: 'set_camera', camera: cameraB() }); history.admit(newer);
  history.commit(newer.operationId, history.preview(newer.operationId).snapshot, { rendererBaseline: observedOlder });
  assert.equal(history.operation(older.operationId).status, 'superseded');
  assert.throws(() => history.confirmRendered(older.operationId, oldReceipt), rejects('history_phase_conflict'));
  const newReceipt = { ...oldReceipt, revision: 2, browserRevision: oldReceipt.browserRevision + 1,
    drawCount: oldReceipt.drawCount + 1 };
  assert.equal(history.confirmRendered(newer.operationId, newReceipt).renderedRevision, 2);
  assert.deepEqual(history.exportLog().events.slice(-3).map(event => event.type), ['superseded', 'committed', 'rendered']);
  assert.deepEqual(replayHistory(history.exportLog()), history.inspect());
});

test('H21 a failed newer commit cannot leave an older renderer callback superseded', () => {
  const { history, request, receipt } = setup();
  const older = request(); history.admit(older);
  history.commit(older.operationId, history.preview(older.operationId).snapshot);
  const newer = request({ kind: 'set_camera', camera: cameraB() }); history.admit(newer);
  const malformed = history.preview(newer.operationId).snapshot;
  malformed.camera = camera();
  const before = history.inspect();
  assert.throws(() => history.commit(newer.operationId, malformed), rejects('history_commit_mismatch'));
  assert.deepEqual(history.inspect(), before);
  assert.equal(history.confirmRendered(older.operationId, receipt()).status, 'rendered');
});

test('H22 known renderer failure preserves the committed model and prior draw without reapplying a retry', () => {
  const { history, request, receipt } = setup();
  const value = request(); history.admit(value);
  history.commit(value.operationId, history.preview(value.operationId).snapshot);
  assert.equal(history.rendererFailed(value.operationId, 'context_lost').status, 'renderer_failed');
  const before = history.inspect();
  assert.equal(history.admit(value).status, 'renderer_failed');
  assert.equal(history.rendererFailed(value.operationId, 'context_lost').status, 'renderer_failed');
  assert.equal(history.inspect().snapshot.representation, 'ball-and-stick');
  assert.equal(history.inspect().lastRendered.revision, 0);
  assert.throws(() => history.confirmRendered(value.operationId, receipt()), rejects('history_phase_conflict'));
  assert.throws(() => history.rendererFailed(value.operationId, 'different_failure'), rejects('history_terminal_conflict'));
  assert.deepEqual(history.inspect(), before);
});

test('H23 event capacity reserves room for every admitted operation to reach a terminal result', () => {
  const { history, request, receipt } = setup({ limits: { maxEvents: 6, maxOperations: 2 } });
  const a = request(); const b = request({ kind: 'set_camera', camera: cameraB() });
  history.admit(a); history.admit(b);
  assert.equal(history.inspect().eventCount + history.inspect().reservedEvents, 6);
  assert.throws(() => history.admit(request()), rejects('history_capacity'));
  history.cancel(b.operationId, 'actor-a');
  history.commit(a.operationId, history.preview(a.operationId).snapshot);
  history.confirmRendered(a.operationId, receipt());
  assert.equal(history.inspect().reservedEvents, 0);
  assert.equal(history.inspect().eventCount, 5);
  assert.equal(history.admit(b).status, 'cancelled');
  assert.throws(() => history.admit(request({ kind: 'set_camera', camera: cameraB() })), rejects('history_capacity'));
  assert.deepEqual(replayHistory(history.exportLog()), history.inspect());
});

test('H24 byte capacity rejects new admission while preserving room to commit and report a pending failure', () => {
  const { history, request } = setup({ limits: { maxBytes: 17_000 } });
  const first = request(); history.admit(first);
  const before = history.inspect();
  assert.throws(() => history.admit(request({ kind: 'set_camera', camera: cameraB() })), rejects('history_byte_limit'));
  assert.deepEqual(history.inspect(), before);
  history.commit(first.operationId, history.preview(first.operationId).snapshot);
  history.rendererFailed(first.operationId, 'renderer_unavailable');
  assert.equal(history.inspect().reservedBytes, 0);
  assert.ok(history.inspect().bytes <= 17_000);
});

test('H25 inputs, exported records, saved views, and inspection results cannot mutate retained history', () => {
  const { history, request, complete, initial } = setup();
  const value = request({ kind: 'set_camera', camera: cameraB() });
  const expected = copy(value);
  history.admit(value);
  value.operation.camera.position[0] = 900;
  value.scope.target.panelId = 'changed';
  initial.camera.target[0] = 500;
  assert.deepEqual(history.exportLog().events[0].detail.request, expected);
  const returned = history.preview(value.operationId);
  returned.snapshot.camera.position[0] = 777;
  assert.deepEqual(history.preview(value.operationId).snapshot.camera, cameraB());
  history.cancel(value.operationId, 'actor-a');
  complete(request({ kind: 'save_view', viewId: 'view-a', name: 'Inspection' }));
  const log = history.exportLog();
  assert.ok(Object.isFrozen(log.events[0].detail.request.operation.camera.position));
  assert.throws(() => { log.events[0].type = 'rendered'; }, TypeError);
  const diagnostic = history.inspect(); diagnostic.snapshot.camera.position[0] = -500;
  assert.deepEqual(history.inspect().snapshot.camera, camera());
  assert.deepEqual(replayHistory(log), history.inspect());
});

test('H26 accessors, sparse arrays, cycles, and nonfinite data fail before they can enter an event', () => {
  const { history, request } = setup();
  const value = request();
  let reads = 0;
  Object.defineProperty(value, 'expectedRevision', { enumerable: true, get() { reads++; return 0; } });
  assert.throws(() => history.admit(value), rejects('invalid_history_data'));
  assert.equal(reads, 0);
  const sparse = request({ kind: 'set_camera', camera: cameraB() }); sparse.operation.camera.up = new Array(3);
  assert.throws(() => history.admit(sparse), rejects('invalid_history_array'));
  const cycle = request(); cycle.operation.value = cycle;
  assert.throws(() => history.admit(cycle), rejects('invalid_history_data'));
  const infinite = request(); infinite.expectedRevision = Infinity;
  assert.throws(() => history.admit(infinite), rejects('invalid_history_data'));
  assert.equal(history.inspect().eventCount, 0);
});

test('H27 replay reconstructs saved views and mixed outcomes repeatedly without dispatch', () => {
  const { history, request, complete } = setup();
  let dispatches = 0;
  const change = request(); complete(change); dispatches++;
  const undo = history.prepareUndo(change.operationId, { operationId: 'lease-a/40', actorId: 'actor-a' });
  complete(undo); dispatches++;
  complete(request({ kind: 'save_view', viewId: 'home', name: 'Home' }));
  const cancelled = request(); history.admit(cancelled); history.cancel(cancelled.operationId, 'actor-a');
  const rejected = request(); history.admit(rejected); history.reject(rejected.operationId, 'controller_holding_object');
  const superseded = request(); history.admit(superseded); history.supersede(superseded.operationId, 'scene_replaced');
  const failed = request(); history.admit(failed);
  history.commit(failed.operationId, history.preview(failed.operationId).snapshot);
  history.rendererFailed(failed.operationId, 'context_lost'); dispatches++;
  const log = JSON.parse(JSON.stringify(history.exportLog()));
  for (let index = 0; index < 3; index++) assert.deepEqual(replayHistory(log), history.inspect());
  assert.equal(dispatches, 3);
  assert.equal(replayHistory(log).lastRendered.revision, 2);
  assert.equal(replayHistory(log).snapshot.revision, 4);
});

test('H28 a log ending with admitted or committed work preserves that phase during replay', () => {
  const { history, request } = setup();
  const value = request(); history.admit(value);
  assert.equal(replayHistory(history.exportLog()).operations[0].status, 'admitted');
  history.commit(value.operationId, history.preview(value.operationId).snapshot);
  const reconstructed = replayHistory(history.exportLog());
  assert.equal(reconstructed.operations[0].status, 'committed');
  assert.equal(reconstructed.lastRendered.revision, 0);
  assert.equal(reconstructed.snapshot.revision, 1);
});

test('H29 edited event bytes fail hash validation', () => {
  const { history, request, complete } = setup(); complete(request());
  const log = copy(history.exportLog()); log.events[1].detail.snapshot.camera.fog = 0;
  assert.throws(() => replayHistory(log), rejects('history_hash_mismatch'));
});

for (const [label, mutate, code] of [
  ['foreign target', log => { log.events[1].scope.target.panelId = 'panel-b'; }, 'wrong_history_scope'],
  ['skipped event number', log => { log.events[1].index = 8; }, 'history_event_order'],
  ['backward time', log => { log.events[1].at = 99; }, 'history_event_order'],
  ['foreign actor', log => { log.events[1].actorId = 'actor-b'; }, 'unknown_history_operation'],
  ['different committed style', log => { log.events[1].detail.snapshot.representation = 'cartoon'; }, 'history_commit_mismatch'],
  ['forged cause', log => { log.events[2].cause = { kind: 'user', operationId: null }; }, 'invalid_history_cause'],
  ['old draw', log => { log.events[2].detail.receipt.drawCount = initialRenderer.drawCount; }, 'history_render_did_not_advance'],
]) {
  test(`H30 recomputing hashes cannot excuse ${label}`, () => {
    const { history, request, complete } = setup(); complete(request());
    const log = copy(history.exportLog()); mutate(log);
    assert.throws(() => replayHistory(resign(log)), rejects(code));
  });
}

test('H31 rendered before commit fails even with a valid hash chain and consecutive event numbers', () => {
  const { history, request, complete } = setup(); complete(request());
  const log = copy(history.exportLog());
  log.events.splice(1, 1);
  log.events[1].index = 2;
  assert.throws(() => replayHistory(resign(log)), rejects('history_phase_conflict'));
});

test('H32 a backward clock leaves the event log and model unchanged', () => {
  const { history, request, advance } = setup();
  const value = request(); history.admit(value);
  const before = history.inspect(); advance(-1);
  assert.throws(() => history.cancel(value.operationId, 'actor-a'), rejects('history_clock_not_monotonic'));
  assert.deepEqual(history.inspect(), before);
});

test('H33 saving the same visual state uses metadata commit, and claiming a new draw for it fails', () => {
  const { history, request, complete, receipt } = setup();
  const value = complete(request({ kind: 'save_view', viewId: 'home', name: 'Home' }));
  assert.equal(history.inspect().snapshot.revision, 1);
  assert.equal(history.inspect().lastRendered.revision, 0);
  assert.throws(() => history.confirmRendered(value.operationId, receipt()), rejects('history_phase_conflict'));
  assert.throws(() => history.admit(request({ kind: 'restore_view', viewId: 'home' })), rejects('history_no_change'));
});

test('H34 missing initial renderer binding prevents a draw claim without preventing model-only history', () => {
  const { history, request } = setup({ initialRenderer: null });
  const value = request(); history.admit(value);
  history.commit(value.operationId, history.preview(value.operationId).snapshot);
  assert.throws(() => history.confirmRendered(value.operationId, { revision: 1, ...initialRenderer }),
    rejects('history_render_binding_mismatch'));
  assert.equal(history.inspect().lastRendered, null);
});

test('H35 a saved view requires a confirmed inspection state; queued camera changes cannot become bookmarks', () => {
  const { history, request, receipt } = setup();
  const change = request({ kind: 'set_camera', camera: cameraB() }); history.admit(change);
  history.commit(change.operationId, history.preview(change.operationId).snapshot);
  const before = history.inspect();
  assert.throws(() => history.admit(request({ kind: 'save_view', viewId: 'site', name: 'Site' })),
    rejects('save_requires_rendered_state'));
  assert.deepEqual(history.inspect(), before);
  history.confirmRendered(change.operationId, receipt());
  const saved = request({ kind: 'save_view', viewId: 'site', name: 'Site' }); history.admit(saved);
  history.commit(saved.operationId, history.preview(saved.operationId).snapshot);
  assert.deepEqual(history.savedView('site').camera, cameraB());
});

// This counter belongs to the simulated browser, not to history.lastRendered.
// The browser verifier repeats the lost-acknowledgment sequence with actual Mol* draws.
function lostConfirmation() {
  const context = setup();
  const { history, request } = context;
  let browser = { ...copy(initialRenderer), revision: 0 };
  function draw(planned) {
    browser = { ...browser, revision: planned.revision, browserRevision: browser.browserRevision + 1,
      drawCount: browser.drawCount + 1 };
    return { snapshot: copy(planned), receipt: copy(browser) };
  }
  const older = request(); history.admit(older);
  const olderSnapshot = history.preview(older.operationId).snapshot;
  history.commit(older.operationId, olderSnapshot);
  const baseline = { operationId: older.operationId, ...draw(olderSnapshot) };
  const newer = request({ kind: 'set_camera', camera: cameraB() }); history.admit(newer);
  const planned = history.preview(newer.operationId).snapshot;
  return { ...context, older, newer, planned, baseline, draw };
}

test('H36 a lost acknowledgment uses the observed dispatch baseline without inventing an older confirmation', () => {
  const { history, request, older, newer, planned, baseline, draw, selectionKeys } = lostConfirmation();
  history.commit(newer.operationId, planned, { rendererBaseline: baseline });
  assert.equal(history.operation(older.operationId).status, 'superseded');
  assert.equal(history.operation(older.operationId).renderedRevision, null);
  assert.equal(history.operation(newer.operationId).renderedRevision, null);
  assert.equal(history.inspect().lastRendered.revision, 0);
  assert.equal(history.inspect().lastRendered.browserRevision, initialRenderer.browserRevision);
  assert.throws(() => history.confirmRendered(older.operationId, baseline.receipt), rejects('history_phase_conflict'));
  assert.throws(() => history.prepareUndo(older.operationId, { operationId: 'lease-a/90', actorId: 'actor-a' }),
    rejects('undo_requires_rendered_change'));
  assert.deepEqual(replayHistory(history.exportLog()), history.inspect());
  const actual = draw(planned);
  assert.equal(actual.receipt.browserRevision, initialRenderer.browserRevision + 2);
  assert.equal(history.confirmRendered(newer.operationId, actual.receipt).renderedRevision, 2);
  const following = request({ kind: 'set_selection', selectionKeys: [selectionKeys[2]] });
  history.admit(following);
  const next = history.preview(following.operationId).snapshot;
  history.commit(following.operationId, next);
  history.confirmRendered(following.operationId, draw(next).receipt);
  assert.equal(history.inspect().lastRendered.browserRevision, initialRenderer.browserRevision + 3);
  assert.equal(history.operation(older.operationId).renderedRevision, null);
  assert.deepEqual(replayHistory(history.exportLog()), history.inspect());
});

test('H37 an unconfirmed predecessor requires reconciliation before a newer commit can supersede it', () => {
  const { history, older, newer, planned, baseline } = lostConfirmation();
  const before = history.inspect();
  assert.throws(() => history.commit(newer.operationId, planned), rejects('history_renderer_reconciliation_required'));
  assert.deepEqual(history.inspect(), before);
  assert.equal(history.operation(older.operationId).status, 'committed');
  assert.equal(history.operation(newer.operationId).status, 'admitted');
  history.commit(newer.operationId, planned, { rendererBaseline: baseline });
  assert.equal(history.operation(older.operationId).status, 'superseded');
});

for (const [label, alter, code] of [
  ['another source', value => { value.snapshot.sourceSha256 = '0'.repeat(64); }, 'scientific_identity_changed'],
  ['another model', value => { value.snapshot.modelNumber = 2; }, 'scientific_identity_changed'],
  ['another assembly', value => { value.snapshot.assemblyId = '1'; }, 'scientific_identity_changed'],
  ['another instance', value => { value.receipt.instanceId = 'viewer-b'; }, 'history_render_binding_mismatch'],
  ['a replacement generation', value => { value.receipt.generation++; }, 'history_render_binding_mismatch'],
  ['another successful load', value => { value.receipt.loadCount++; }, 'history_render_binding_mismatch'],
  ['an unexplained browser revision', value => { value.receipt.browserRevision++; }, 'history_baseline_did_not_advance'],
  ['an unchanged draw', value => { value.receipt.drawCount = initialRenderer.drawCount; }, 'history_baseline_did_not_advance'],
  ['another shared revision', value => { value.receipt.revision++; }, 'history_baseline_snapshot_mismatch'],
  ['a different appearance', value => { value.snapshot.representation = 'cartoon'; }, 'history_baseline_snapshot_mismatch'],
  ['a different selection', value => { value.snapshot.selectionKeys = []; }, 'history_baseline_snapshot_mismatch'],
  ['a different camera', value => { value.snapshot.camera = cameraB(); }, 'history_baseline_snapshot_mismatch'],
  ['an unknown operation', value => { value.operationId = 'lease-a/404'; }, 'history_baseline_operation_unavailable'],
]) {
  test(`H38 reconciliation rejects ${label} before changing either operation`, () => {
    const { history, newer, planned, baseline } = lostConfirmation();
    const before = history.inspect(); alter(baseline);
    assert.throws(() => history.commit(newer.operationId, planned, { rendererBaseline: baseline }), rejects(code));
    assert.deepEqual(history.inspect(), before);
  });
}

test('H39 duplicate commits preserve the exact retained baseline and detached snapshots', () => {
  const { history, newer, planned, baseline } = lostConfirmation();
  const original = copy(baseline);
  history.commit(newer.operationId, planned, { rendererBaseline: baseline });
  const before = history.inspect();
  assert.equal(history.commit(newer.operationId, planned, { rendererBaseline: copy(original) }).status, 'committed');
  baseline.snapshot.camera.position[0] = 999;
  baseline.snapshot.selectionKeys.length = 0;
  baseline.receipt.drawCount++;
  assert.throws(() => history.commit(newer.operationId, planned, { rendererBaseline: baseline }),
    rejects('history_renderer_baseline_conflict'));
  assert.deepEqual(history.inspect(), before);
  const committed = history.exportLog().events.find(event => event.type === 'committed'
    && event.operationId === newer.operationId);
  assert.deepEqual(committed.detail.rendererBaseline, original);
  assert.ok(Object.isFrozen(committed.detail.rendererBaseline.snapshot.camera.position));
  assert.deepEqual(replayHistory(history.exportLog()), history.inspect());
});

for (const [label, alter, code] of [
  ['a counter jump', value => { value.receipt.browserRevision++; }, 'history_baseline_did_not_advance'],
  ['a foreign source', value => { value.snapshot.sourceSha256 = '0'.repeat(64); }, 'scientific_identity_changed'],
  ['a different selection', value => { value.snapshot.selectionKeys = []; }, 'history_baseline_snapshot_mismatch'],
]) {
  test(`H40 replay rejects ${label} in a rehashed dispatch baseline`, () => {
    const { history, newer, planned, baseline, draw } = lostConfirmation();
    history.commit(newer.operationId, planned, { rendererBaseline: baseline });
    history.confirmRendered(newer.operationId, draw(planned).receipt);
    const log = copy(history.exportLog());
    const committed = log.events.find(event => event.type === 'committed' && event.operationId === newer.operationId);
    alter(committed.detail.rendererBaseline);
    assert.throws(() => replayHistory(resign(log)), rejects(code));
  });
}

test('H41 successive lost confirmations each require a separately validated one-step observation', () => {
  const { history, request, older, newer, planned, baseline, draw } = lostConfirmation();
  history.commit(newer.operationId, planned, { rendererBaseline: baseline });
  const observedNewer = { operationId: newer.operationId, ...draw(planned) };
  const third = request({ kind: 'set_representation', value: 'cartoon' }); history.admit(third);
  const thirdSnapshot = history.preview(third.operationId).snapshot;
  history.commit(third.operationId, thirdSnapshot, { rendererBaseline: observedNewer });
  const observedThird = { operationId: third.operationId, ...draw(thirdSnapshot) };
  assert.equal(observedThird.receipt.browserRevision, initialRenderer.browserRevision + 3);
  history.confirmRendered(third.operationId, observedThird.receipt);
  for (const value of [older, newer]) {
    assert.equal(history.operation(value.operationId).status, 'superseded');
    assert.equal(history.operation(value.operationId).renderedRevision, null);
  }
  assert.equal(history.inspect().lastRendered.operationId, third.operationId);
  assert.deepEqual(replayHistory(history.exportLog()), history.inspect());
});

test('H42 returning to the initial visible fields does not conceal unconfirmed browser mutations', () => {
  const { history, request, newer, planned, baseline, draw } = lostConfirmation();
  history.commit(newer.operationId, planned, { rendererBaseline: baseline });
  let observation = { operationId: newer.operationId, ...draw(planned) };
  for (const operation of [{ kind: 'set_representation', value: 'cartoon' }, { kind: 'set_camera', camera: camera() }]) {
    const value = request(operation); history.admit(value);
    const next = history.preview(value.operationId).snapshot;
    history.commit(value.operationId, next, { rendererBaseline: observation });
    observation = { operationId: value.operationId, ...draw(next) };
  }
  assert.throws(() => history.admit(request({ kind: 'save_view', viewId: 'unconfirmed', name: 'Unconfirmed' })),
    rejects('save_requires_rendered_state'));
  const next = request({ kind: 'set_representation', value: 'ball-and-stick' }); history.admit(next);
  const before = history.inspect();
  assert.deepEqual({ ...before.snapshot, revision: 0 }, before.lastRendered.snapshot);
  assert.throws(() => history.commit(next.operationId, history.preview(next.operationId).snapshot),
    rejects('history_renderer_reconciliation_required'));
  assert.deepEqual(history.inspect(), before);
  history.commit(next.operationId, history.preview(next.operationId).snapshot, { rendererBaseline: observation });
});
