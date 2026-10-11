import test from 'node:test';
import assert from 'node:assert/strict';
import { copy, sha256 } from './contracts.mjs';
import { Receiver } from './receiver.mjs';
import { Transfer } from './transfer.mjs';
import { decideReturn } from './return.mjs';

const target = { bindingId: 'binding-a', taskId: 'task-a', panelId: 'panel-a', sessionId: 'session-a', deviceId: 'quest-a' };
const sourceBytes = Buffer.from('synthetic parser input; protocol unit tests inject independently declared parser facts');
const sourceSha256 = sha256(sourceBytes);
const view = { centerAngstrom: [0, 0, 0], orientation: [0, 0, 0, 1], radiusAngstrom: 12 };
const limits = { maxSourceBytes: 4096, maxChunkBytes: 128, maxSelectionKeys: 128 };
const manifest = () => ({ version: 1, sceneId: 'scene-b', privacy: 'public',
  source: { format: 'mmcif', sha256: sourceSha256, byteLength: sourceBytes.length },
  modelNumber: 2, assemblyId: '2', representation: 'ball-and-stick', color: 'chain-id', selectionKeys: ['residue-a'], view: copy(view) });
const facts = () => ({ sha256: sourceSha256, byteLength: sourceBytes.length,
  models: [{ modelNumber: 2, assemblies: [{ assemblyId: '2', selectionKeys: ['residue-a', 'residue-b'] }] }] });

function setup(overrides = {}) {
  let now = 100;
  const policy = { inactivityMs: 1_800_000, leaseMs: 3_600_000, maxCommands: 8, ...overrides.policy };
  const receiver = new Receiver({ clock: () => now, target, serverEpoch: 'server-a', receiverEpoch: 'receiver-a',
    leaseId: 'lease-a', scene: { sceneId: 'scene-a', revision: 0, sourceSha256 }, actors: ['codex-a', 'codex-b'],
    ...overrides, policy });
  function command(sequence = 1, changes = {}) {
    const binding = receiver.binding();
    return { version: 1, commandId: `${binding.lease.id}/${sequence}`, actorId: 'codex-a', target: copy(target),
      serverEpoch: binding.serverEpoch, receiverEpoch: binding.receiverEpoch, leaseId: binding.lease.id,
      deadline: Math.min(now + 5000, binding.lease.expiresAt), sceneId: receiver.inspect().state.sceneId,
      expectedRevision: receiver.inspect().state.revision,
      operation: { kind: 'rotate_object', axis: 'y', degrees: 15 }, ...changes };
  }
  return { receiver, command, advance: (ms) => { now += ms; }, time: () => now };
}

function transferSetup(options = {}) {
  const context = setup();
  const transfer = new Transfer({ receiver: context.receiver, limits, inspectSource: async () => facts(), ...options });
  const begin = (input = manifest()) => transfer.begin(input).attemptId;
  const fill = (id, bytes = sourceBytes) => transfer.append(id, 0, bytes);
  return { ...context, transfer, begin, fill };
}
const rejectsCode = (code) => (error) => error.code === code;

test('P01 acceptance, commit, and render are separate outcomes', () => {
  const { receiver, command } = setup();
  const request = command();
  const accepted = receiver.receive(request);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.committedRevision, null);
  assert.equal(accepted.renderedRevision, null);
  assert.equal(receiver.inspect().commitCount, 0);
  assert.equal(receiver.renderTicket(request.commandId), null);
  const committed = receiver.commit(request.commandId);
  assert.equal(committed.status, 'committed');
  assert.equal(committed.committedRevision, 1);
  assert.equal(committed.renderedRevision, null);
  const rendered = receiver.confirmRendered(receiver.renderTicket(request.commandId));
  assert.equal(rendered.status, 'rendered');
  assert.equal(rendered.renderedRevision, 1);
  assert.equal(rendered.currentlyRendered, true);
});

test('P02 lost acknowledgment retry returns the old result without a second relative rotation', () => {
  const { receiver, command } = setup();
  const request = command();
  receiver.receive(request);
  receiver.commit(request.commandId);
  const ticket = receiver.renderTicket(request.commandId);
  receiver.confirmRendered(ticket);
  const retry = receiver.receive(request);
  assert.equal(retry.status, 'rendered');
  assert.equal(retry.renderedRevision, 1);
  assert.equal(receiver.commit(request.commandId).status, 'rendered');
  assert.equal(receiver.confirmRendered(ticket).status, 'rendered');
  assert.equal(receiver.inspect().commitCount, 1);
  assert.equal(receiver.inspect().state.revision, 1);
  assert.equal(receiver.inspect().state.rotations.y, 15);
});

test('P03 pending and committed retries preserve their original phase', () => {
  const { receiver, command } = setup();
  const request = command();
  receiver.receive(request);
  assert.equal(receiver.receive(request).status, 'accepted');
  receiver.commit(request.commandId);
  assert.equal(receiver.receive(request).status, 'committed');
  assert.equal(receiver.inspect().retainedCommands, 1);
  assert.equal(receiver.inspect().commitCount, 1);
});

test('P04 object-key order does not change identity; changed content conflicts', () => {
  const { receiver, command } = setup();
  const request = command();
  receiver.receive(request);
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  reordered.operation = { degrees: 15, axis: 'y', kind: 'rotate_object' };
  assert.equal(receiver.receive(reordered).status, 'accepted');
  assert.equal(receiver.receive({ ...request, operation: { ...request.operation, degrees: 30 } }).reason, 'command_id_conflict');
  assert.equal(receiver.inspect().retainedCommands, 1);
});

test('P05 stored commands and returned tickets resist caller mutation', () => {
  const { receiver, command } = setup();
  const request = command();
  receiver.receive(request);
  request.operation.degrees = 90;
  request.target.panelId = 'panel-b';
  receiver.commit(request.commandId);
  assert.equal(receiver.inspect().state.rotations.y, 15);
  const ticket = receiver.renderTicket(request.commandId);
  ticket.target.panelId = 'panel-b';
  assert.equal(receiver.confirmRendered(ticket).reason, 'invalid_render_ticket');
  assert.equal(receiver.confirmRendered(receiver.renderTicket(request.commandId)).status, 'rendered');
});

for (const field of Object.keys(target)) {
  test(`P06 scope: wrong ${field} cannot mutate or disclose a known outcome`, () => {
    const { receiver, command } = setup();
    const request = command();
    receiver.receive(request);
    receiver.commit(request.commandId);
    const before = receiver.inspect();
    const result = receiver.receive({ ...request, target: { ...request.target, [field]: 'wrong' } });
    assert.deepEqual(result, { status: 'rejected', reason: 'wrong_target' });
    assert.deepEqual(receiver.inspect(), before);
  });
}
for (const [field, reason] of [['serverEpoch', 'wrong_epoch'], ['receiverEpoch', 'wrong_epoch'],
  ['sceneId', 'wrong_scene'], ['actorId', 'unknown_actor']]) {
  test(`P07 scope: wrong ${field} is refused`, () => {
    const { receiver, command } = setup();
    assert.equal(receiver.receive(command(1, { [field]: 'wrong' })).reason, reason);
    assert.equal(receiver.inspect().commitCount, 0);
  });
}

test('P08 strict schema rejects unknown fields, nonfinite values and undeclared operations', () => {
  const { receiver, command } = setup();
  for (const request of [command(1, { headPose: [0, 0, 0] }), command(1, { version: 2 }),
    command(1, { operation: { kind: 'eval', source: 'anything' } }),
    command(1, { operation: { kind: 'set_scale', value: NaN } }),
    command(1, { operation: { kind: 'rotate_object', axis: 'y', degrees: 181 } })]) {
    assert.equal(receiver.receive(request).status, 'rejected');
  }
  assert.equal(receiver.inspect().retainedCommands, 0);
});

test('P09 two actors can enqueue one revision but only one can commit it', () => {
  const { receiver, command } = setup();
  const a = command(1);
  const b = command(2, { actorId: 'codex-b' });
  receiver.receive(a);
  receiver.receive(b);
  assert.equal(receiver.commit(a.commandId).status, 'committed');
  assert.equal(receiver.commit(b.commandId).reason, 'revision_conflict');
  assert.equal(receiver.inspect().commitCount, 1);
  const c = command(3);
  receiver.receive(c);
  assert.equal(receiver.commit(c.commandId).status, 'committed');
});

test('P10 a full history rejects new work and preserves known retries', () => {
  const { receiver, command } = setup({ policy: { maxCommands: 1 } });
  const first = command(1);
  receiver.receive(first);
  receiver.commit(first.commandId);
  assert.equal(receiver.receive(command(2)).reason, 'command_history_full');
  assert.equal(receiver.receive(first).status, 'committed');
  assert.equal(receiver.inspect().retainedCommands, 1);
});

test('P11 a pending duplicate expires at the deadline without extending it', () => {
  const { receiver, command, advance } = setup();
  const request = command();
  receiver.receive(request);
  advance(5000);
  assert.equal(receiver.receive(request).reason, 'command_expired');
  assert.equal(receiver.commit(request.commandId).reason, 'command_expired');
  assert.equal(receiver.inspect().commitCount, 0);
});

test('P12 queued work rechecks its deadline at commit', () => {
  const { receiver, command, advance } = setup();
  const request = command();
  receiver.receive(request);
  advance(5000);
  assert.equal(receiver.commit(request.commandId).reason, 'command_expired');
  assert.equal(receiver.inspect().commitCount, 0);
});

test('P13 reads refresh inactivity without extending a command deadline', () => {
  const { receiver, command, advance } = setup({ policy: { inactivityMs: 1000 } });
  const request = command(1, { deadline: 1000 });
  receiver.receive(request);
  advance(600);
  receiver.getState();
  advance(600);
  receiver.getState();
  assert.equal(receiver.receive(request).reason, 'command_expired');
  advance(999);
  receiver.getState();
  advance(1000);
  assert.throws(() => receiver.getState(), rejectsCode('session_expired'));
  assert.throws(() => receiver.getState(), rejectsCode('session_expired'));
});

test('P14 reads cannot extend the receiver lease', () => {
  const { receiver, command, advance } = setup({ policy: { leaseMs: 1000 } });
  const request = command();
  receiver.receive(request);
  advance(999);
  receiver.getState();
  advance(1);
  assert.equal(receiver.receive(request).reason, 'lease_expired');
});

test('P15 renewing a lease retires old IDs, tickets and history', () => {
  const { receiver, command } = setup();
  const request = command();
  receiver.receive(request);
  receiver.commit(request.commandId);
  const ticket = receiver.renderTicket(request.commandId);
  receiver.renewLease();
  assert.equal(receiver.receive(request).reason, 'wrong_lease');
  const fresh = command();
  assert.equal(receiver.receive({ ...fresh, commandId: request.commandId }).reason, 'invalid_command_id');
  assert.equal(receiver.confirmRendered(ticket).reason, 'invalid_render_ticket');
  assert.equal(receiver.receive(fresh).status, 'accepted');
});

test('P16 receiver or server restart rejects original operations and callbacks', () => {
  const original = setup();
  const request = original.command();
  original.receiver.receive(request);
  original.receiver.commit(request.commandId);
  const ticket = original.receiver.renderTicket(request.commandId);
  for (const overrides of [{ serverEpoch: 'server-b' }, { receiverEpoch: 'receiver-b' }]) {
    const restarted = setup(overrides).receiver;
    assert.equal(restarted.receive(request).reason, 'wrong_epoch');
    assert.equal(restarted.confirmRendered(ticket).reason, 'invalid_render_ticket');
    assert.equal(restarted.inspect().commitCount, 0);
  }
});

test('P17 a forged render callback cannot confirm state', () => {
  const { receiver, command } = setup();
  const request = command();
  receiver.receive(request);
  receiver.commit(request.commandId);
  const ticket = receiver.renderTicket(request.commandId);
  for (const key of ['nonce', 'sceneId', 'receiverEpoch', 'serverEpoch', 'leaseId', 'generation', 'revision']) {
    assert.equal(receiver.confirmRendered({ ...ticket, [key]: 'wrong' }).status, 'rejected');
  }
  assert.equal(receiver.inspect().state.renderedRevision, null);
});

test('P18 an overtaken commit cannot be acknowledged by its late callback', () => {
  const { receiver, command } = setup();
  const a = command(1);
  receiver.receive(a);
  receiver.commit(a.commandId);
  const ticket = receiver.renderTicket(a.commandId);
  const b = command(2);
  receiver.receive(b);
  receiver.commit(b.commandId);
  assert.equal(receiver.confirmRendered(ticket).status, 'rejected');
  assert.equal(receiver.receive(a).status, 'superseded');
  assert.equal(receiver.confirmRendered(receiver.renderTicket(b.commandId)).renderedRevision, 2);
});

test('P19 historical rendered outcomes do not claim the current revision', () => {
  const { receiver, command } = setup();
  const a = command(1);
  receiver.receive(a);
  receiver.commit(a.commandId);
  receiver.confirmRendered(receiver.renderTicket(a.commandId));
  const b = command(2);
  receiver.receive(b);
  receiver.commit(b.commandId);
  const old = receiver.receive(a);
  assert.equal(old.status, 'rendered');
  assert.equal(old.renderedRevision, 1);
  assert.equal(old.currentlyRendered, false);
  assert.equal(old.currentRevision, 2);
});

test('P20 a grab blocks receipt and queued commit; another owner cannot release it', () => {
  const { receiver, command } = setup();
  const queued = command(1);
  receiver.receive(queued);
  receiver.setGrabbed(true, 'left-controller');
  assert.equal(receiver.receive(command(2)).reason, 'local_manipulation_active');
  assert.equal(receiver.commit(queued.commandId).reason, 'local_manipulation_active');
  assert.throws(() => receiver.setGrabbed(false, 'right-controller'), rejectsCode('wrong_grab_owner'));
  receiver.setGrabbed(false, 'left-controller');
  assert.equal(receiver.receive(queued).reason, 'local_manipulation_active');
  assert.equal(receiver.receive(command(3)).status, 'accepted');
});

test('P21 cancellation prevents pending commit and cannot undo a completed mutation', () => {
  const { receiver, command } = setup();
  const cancelled = command(1);
  receiver.receive(cancelled);
  assert.equal(receiver.cancel(cancelled.commandId).status, 'cancelled');
  assert.equal(receiver.commit(cancelled.commandId).status, 'cancelled');
  assert.equal(receiver.receive(cancelled).status, 'cancelled');
  const committed = command(2);
  receiver.receive(committed);
  receiver.commit(committed.commandId);
  assert.equal(receiver.cancel(committed.commandId).reason, 'already_committed_or_terminal');
  assert.equal(receiver.inspect().state.rotations.y, 15);
});

test('P22 exact revision exhaustion refuses mutation', () => {
  const { receiver, command } = setup({ scene: { sceneId: 'scene-a', revision: Number.MAX_SAFE_INTEGER, sourceSha256 } });
  const request = command();
  receiver.receive(request);
  assert.equal(receiver.commit(request.commandId).reason, 'revision_exhausted');
  assert.equal(receiver.inspect().commitCount, 0);
});

test('P23 command bounds include their stated endpoints', () => {
  for (const value of [0.25, 4]) {
    const { receiver, command } = setup();
    const request = command(1, { operation: { kind: 'set_scale', value } });
    receiver.receive(request);
    receiver.commit(request.commandId);
    assert.equal(receiver.inspect().state.scale, value);
  }
  const { receiver, command } = setup();
  for (const value of [0.249, 4.001, Infinity]) {
    assert.equal(receiver.receive(command(1, { operation: { kind: 'set_scale', value } })).reason, 'scale_out_of_bounds');
  }
});

test('P24 manifest, chunks, and parser facts commit only after explicit preparation', async () => {
  const { receiver, transfer, begin, fill } = transferSetup();
  const input = manifest();
  const id = begin(input);
  input.view.centerAngstrom[0] = 1000;
  const bytes = Buffer.from(sourceBytes);
  fill(id, bytes);
  bytes.fill(0);
  assert.equal(transfer.append(id, 0, sourceBytes).duplicate, true);
  assert.equal(receiver.inspect().state.sceneId, 'scene-a');
  assert.equal((await transfer.prepare(id)).status, 'prepared');
  assert.equal(receiver.inspect().state.sceneId, 'scene-a');
  const result = transfer.commit(id);
  assert.equal(result.state.sceneId, 'scene-b');
  assert.equal(result.state.manifest.modelNumber, 2);
  assert.equal(result.state.manifest.assemblyId, '2');
  assert.deepEqual(result.state.manifest.view.centerAngstrom, [0, 0, 0]);
  assert.equal(result.state.renderedRevision, null);
  assert.equal(transfer.inspect(), null);
});

for (const [label, change, code] of [
  ['private bytes', (m) => { m.privacy = 'private'; }, 'private_payload_refused'],
  ['undeclared fields', (m) => { m.clipping = {}; }, 'invalid_fields'],
  ['incomplete manifest', (m) => { delete m.view; }, 'invalid_fields'],
  ['oversized source', (m) => { m.source.byteLength = 4097; }, 'source_size_limit'],
  ['unsupported appearance', (m) => { m.representation = 'surface'; }, 'unsupported_appearance'],
  ['tracking fields', (m) => { m.view.headPose = [1, 2, 3]; }, 'invalid_fields'],
  ['negative radius', (m) => { m.view.radiusAngstrom = -1; }, 'invalid_view_radius'],
]) {
  test(`P25 manifest refuses ${label} before receiving bytes`, () => {
    const { receiver, begin } = transferSetup();
    const before = receiver.inspect();
    const input = manifest();
    change(input);
    assert.throws(() => begin(input), rejectsCode(code));
    assert.deepEqual(receiver.inspect(), before);
  });
}

test('P26 truncated and corrupted sources preserve the last scene', async () => {
  for (const mode of ['truncated', 'corrupt']) {
    const { receiver, transfer, begin, fill } = transferSetup();
    const before = receiver.inspect();
    const id = begin();
    fill(id, mode === 'truncated' ? sourceBytes.subarray(0, 10) : Buffer.alloc(sourceBytes.length));
    await assert.rejects(transfer.prepare(id), rejectsCode(mode === 'truncated' ? 'source_truncated' : 'source_hash_mismatch'));
    assert.deepEqual(receiver.inspect(), before);
    assert.equal(transfer.inspect(), null);
    assert.equal(typeof begin(), 'number');
  }
});

for (const [label, modify, code] of [
  ['hash', (f) => { f.sha256 = '0'.repeat(64); }, 'source_facts_mismatch'],
  ['model', (f) => { f.models[0].modelNumber = 1; }, 'model_unavailable'],
  ['assembly', (f) => { f.models[0].assemblies[0].assemblyId = '1'; }, 'assembly_unavailable'],
  ['selection', (f) => { f.models[0].assemblies[0].selectionKeys = []; }, 'selection_unavailable'],
]) {
  test(`P27 a valid byte hash cannot hide a missing ${label}`, async () => {
    const parsed = facts();
    modify(parsed);
    const { receiver, transfer, begin, fill } = transferSetup({ inspectSource: async () => parsed });
    const id = begin();
    fill(id);
    await assert.rejects(transfer.prepare(id), rejectsCode(code));
    assert.equal(receiver.inspect().state.sceneId, 'scene-a');
  });
}

test('P28 oversized, conflicting, or reordered chunks discard staging without scene mutation', () => {
  for (const mode of ['oversized', 'conflicting', 'reordered']) {
    const { receiver, transfer, begin, fill } = transferSetup();
    const before = receiver.inspect();
    const id = begin();
    if (mode === 'conflicting') fill(id);
    const input = mode === 'oversized' ? Buffer.alloc(129) : Buffer.from('wrong');
    assert.throws(() => transfer.append(id, mode === 'reordered' ? 1 : 0, input));
    assert.equal(transfer.inspect(), null);
    assert.deepEqual(receiver.inspect(), before);
  }
});

test('P29 cancellation during parsing retires late completion without clearing a newer attempt', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { receiver, transfer, begin, fill } = transferSetup({ inspectSource: async () => { await waiting; return facts(); } });
  const old = begin();
  fill(old);
  const pending = transfer.prepare(old);
  transfer.cancel(old);
  const next = begin();
  release();
  await assert.rejects(pending, rejectsCode('transfer_retired'));
  assert.equal(transfer.inspect().attemptId, next);
  assert.equal(receiver.inspect().state.sceneId, 'scene-a');
  assert.throws(() => transfer.commit(old), rejectsCode('transfer_retired'));
});

test('P30 a command during preparation makes the replacement conflict at commit', async () => {
  const { receiver, command, transfer, begin, fill } = transferSetup();
  const id = begin();
  fill(id);
  await transfer.prepare(id);
  const request = command();
  receiver.receive(request);
  receiver.commit(request.commandId);
  assert.throws(() => transfer.commit(id), rejectsCode('transfer_conflict'));
  assert.equal(receiver.inspect().state.sceneId, 'scene-a');
  assert.equal(receiver.inspect().state.rotations.y, 15);
});

test('P31 a replacement invalidates old callbacks and marks old rendered results historical', async () => {
  for (const rendered of [false, true]) {
    const { receiver, command, transfer, begin, fill } = transferSetup();
    const request = command();
    receiver.receive(request);
    receiver.commit(request.commandId);
    const ticket = receiver.renderTicket(request.commandId);
    if (rendered) receiver.confirmRendered(ticket);
    const id = begin();
    fill(id);
    await transfer.prepare(id);
    transfer.commit(id);
    assert.equal(receiver.confirmRendered(ticket).status, 'rejected');
    const old = receiver.receive(request);
    assert.equal(old.currentScene, false);
    assert.equal(old.currentlyRendered, false);
    assert.equal(old.status, rendered ? 'rendered' : 'superseded');
    assert.equal(receiver.inspect().state.renderedRevision, null);
  }
});

test('P32 a grab prevents replacement before upload and before commit', async () => {
  const { receiver, transfer, begin, fill } = transferSetup();
  receiver.setGrabbed(true);
  assert.throws(begin, rejectsCode('local_manipulation_active'));
  receiver.setGrabbed(false);
  const id = begin();
  fill(id);
  await transfer.prepare(id);
  receiver.setGrabbed(true);
  assert.throws(() => transfer.commit(id), rejectsCode('local_manipulation_active'));
  assert.equal(receiver.inspect().state.sceneId, 'scene-a');
});

test('P33 lease renewal during parsing invalidates that replacement', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const { receiver, transfer, begin, fill } = transferSetup({ inspectSource: async () => { await waiting; return facts(); } });
  const id = begin();
  fill(id);
  const pending = transfer.prepare(id);
  receiver.renewLease();
  release();
  await assert.rejects(pending, rejectsCode('transfer_conflict'));
  assert.equal(receiver.inspect().state.sceneId, 'scene-a');
});

const returnSnapshot = () => ({ version: 1, snapshotId: 'return-a', target: copy(target),
  sourceSceneId: 'scene-a', sourceSha256, baseDesktopRevision: 12, selectionKeys: ['residue-a'], view: copy(view) });
const panel = () => ({ target: copy(target), mounted: true, visibility: 'visible', sceneId: 'scene-a', sourceSha256, revision: 12 });

test('P34 a return names the original visible or hidden panel without claiming a host render', () => {
  for (const visibility of ['visible', 'hidden']) {
    const original = { ...panel(), visibility };
    const result = decideReturn(returnSnapshot(), original);
    assert.equal(result.status, 'apply_to_original');
    assert.equal(result.reason, visibility === 'visible' ? 'original_panel_ready' : 'original_panel_hidden');
    assert.equal(result.visibleRenderConfirmed, false);
    assert.deepEqual(result.snapshot.target, target);
  }
});

test('P35 an unavailable or recreated binding yields a recoverable original snapshot', () => {
  const alternatives = [null, { ...panel(), mounted: false },
    ...Object.keys(target).map((key) => ({ ...panel(), target: { ...target, [key]: 'other' } }))];
  for (const destination of alternatives) {
    const result = decideReturn(returnSnapshot(), destination);
    assert.equal(result.status, 'recoverable');
    assert.deepEqual(result.snapshot.target, target);
  }
});

test('P36 a newer, older or replaced desktop scene is preserved', () => {
  for (const changes of [{ revision: 13 }, { revision: 11 }, { sceneId: 'replacement' }, { sourceSha256: '0'.repeat(64) }]) {
    const original = { ...panel(), ...changes };
    const before = copy(original);
    assert.equal(decideReturn(returnSnapshot(), original).status, 'save_snapshot');
    assert.deepEqual(original, before);
  }
});

test('P37 return snapshots preserve object-relative view and isolate caller mutations', () => {
  const input = returnSnapshot();
  const result = decideReturn(input, panel());
  input.view.centerAngstrom[0] = 999;
  input.selectionKeys[0] = 'other';
  assert.deepEqual(result.snapshot.view, view);
  assert.deepEqual(result.snapshot.selectionKeys, ['residue-a']);
  const invalid = returnSnapshot();
  invalid.view.headPose = [1, 2, 3];
  assert.throws(() => decideReturn(invalid, panel()), rejectsCode('invalid_fields'));
});

for (const boundary of ['leaseMs', 'inactivityMs']) {
  test(`P38 crossing ${boundary} cannot produce a rejected result after mutation`, () => {
    let now = 0;
    let clockReads = 0;
    let ticking = false;
    const { receiver, command } = setup({ clock: () => { clockReads += 1; return ticking ? now++ : now; },
      policy: { [boundary]: 100 } });
    const request = command(1, { deadline: 100 });
    receiver.receive(request);
    now = 99;
    ticking = true;
    const beforeReads = clockReads;
    const committed = receiver.commit(request.commandId);
    assert.equal(committed.status, 'committed');
    assert.equal(committed.reason, null);
    assert.equal(receiver.inspect().state.rotations.y, 15);
    assert.equal(receiver.inspect().commitCount, 1);
    assert.equal(clockReads - beforeReads, 1, 'Commit samples time once before its atomic mutation');
  });
}

test('P39 repeated cancellation cannot accumulate parser jobs', async () => {
  let release;
  let active = 0;
  let peak = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const { transfer, begin, fill } = transferSetup({ inspectSource: async () => {
    active += 1;
    peak = Math.max(peak, active);
    await waiting;
    active -= 1;
    return facts();
  } });
  const first = begin();
  fill(first);
  const pending = transfer.prepare(first);
  transfer.cancel(first);
  for (let i = 0; i < 5; i++) {
    const next = begin();
    fill(next);
    await assert.rejects(transfer.prepare(next), rejectsCode('parser_busy'));
    assert.equal(transfer.resources().activeParsers, 1);
    transfer.cancel(next);
  }
  release();
  await assert.rejects(pending, rejectsCode('transfer_retired'));
  assert.equal(transfer.resources().activeParsers, 0);
  const final = begin();
  fill(final);
  await transfer.prepare(final);
  transfer.commit(final);
  assert.equal(peak, 1);
});

test('P40 validators inspect one detached snapshot of accessor-backed input', () => {
  const { receiver, command } = setup();
  const request = command();
  let reads = 0;
  Object.defineProperty(request, 'operation', { enumerable: true, get: () => ({ kind: 'rotate_object', axis: 'y', degrees: ++reads === 1 ? 15 : 9000 }) });
  assert.equal(receiver.receive(request).status, 'accepted');
  receiver.commit(request.commandId);
  assert.equal(receiver.inspect().state.rotations.y, 15);
  assert.equal(reads, 1);
  assert.equal(receiver.receive(command(2, { operation: () => {} })).reason, 'invalid_data');
});

test('P41 sparse selection and camera arrays are invalid', () => {
  const { begin } = transferSetup();
  const missingCenter = manifest();
  missingCenter.view.centerAngstrom = new Array(3);
  assert.throws(() => begin(missingCenter), rejectsCode('invalid_view_center'));
  const missingKey = manifest();
  missingKey.selectionKeys = new Array(1);
  assert.throws(() => begin(missingKey), rejectsCode('invalid_selection'));
  const returned = returnSnapshot();
  returned.selectionKeys = new Array(1);
  assert.throws(() => decideReturn(returned, panel()), rejectsCode('invalid_return_selection'));
});

test('P42 a committed command can be reconciled and rendered after its apply deadline', () => {
  const { receiver, command, advance } = setup();
  const request = command();
  receiver.receive(request);
  receiver.commit(request.commandId);
  const ticket = receiver.renderTicket(request.commandId);
  advance(5001);
  assert.equal(receiver.receive(request).status, 'committed');
  assert.equal(receiver.confirmRendered(ticket).status, 'rendered');
  assert.equal(receiver.receive(request).status, 'rendered');
  assert.equal(receiver.inspect().commitCount, 1);
  assert.equal(receiver.inspect().state.rotations.y, 15);
});

test('P43 object-relative rotations preserve a unit quaternion and rotation order', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} differs from ${b}`);
  for (const axes of [['x', 'y'], ['y', 'x']]) {
    const { receiver, command } = setup();
    for (let i = 0; i < axes.length; i++) {
      const request = command(i + 1, { operation: { kind: 'rotate_object', axis: axes[i], degrees: 90 } });
      receiver.receive(request);
      receiver.commit(request.commandId);
    }
    const q = receiver.inspect().state.orientation;
    const expected = [0.5, 0.5, axes[0] === 'x' ? 0.5 : -0.5, 0.5];
    q.forEach((value, i) => close(value, expected[i]));
    close(Math.hypot(...q), 1);
  }
});
