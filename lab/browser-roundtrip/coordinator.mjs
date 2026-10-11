import { randomUUID } from 'node:crypto';
import { canonical, copy, digest, fields, identifier, requireValue, revision, same, sha256,
  snapshotInput, validateCommand, validateTarget } from '../protocol/contracts.mjs';
import { Receiver } from '../protocol/receiver.mjs';
import { Transfer } from '../protocol/transfer.mjs';
import sourceFacts from '../protocol/source-facts.cjs';
import { CAMERA_TOLERANCE, camerasEqual, validateCamera } from '../protocol/camera.mjs';
export { validateCamera } from '../protocol/camera.mjs';

const { selectionId } = sourceFacts;
const MAX_SOURCE_BYTES = 70_000;
const MAX_CAPTURES = 8;
const MAX_SELECTIONS = 128;
const DEFAULT_TARGET = { bindingId: 'binding-a', taskId: 'task-a', panelId: 'panel-a',
  sessionId: 'session-a', deviceId: 'device-a' };

function fullSelection(keys) {
  requireValue(Array.isArray(keys) && keys.length <= MAX_SELECTIONS
    && Array.from(keys).every(key => typeof key === 'string' && key.length > 0 && key.length <= 4096)
    && new Set(keys).size === keys.length, 'invalid_full_selection');
}

const sameSelection = (a, b) => same([...a].sort(), [...b].sort());
const rejected = reason => ({ status: 'rejected', reason });
const errorCode = error => typeof error?.code === 'string' ? error.code : 'browser_apply_failed';

// Trusted Node test coordinator. Browser snapshots are observations from the owned test adapter;
// this module establishes neither a network identity nor a Codex host connection.
export class BrowserCoordinator {
  #receiver; #transfer; #clock; #target; #sources = new Map(); #captures = new Map();
  #current = null; #bound = null; #jobs = new Map(); #tail = Promise.resolve(); #sequence = 0;
  #events = []; #eventCount = 0;

  constructor({ clock, pinnedSources, target = DEFAULT_TARGET }) {
    validateTarget(target);
    requireValue(typeof clock === 'function', 'invalid_clock');
    requireValue(Array.isArray(pinnedSources) && pinnedSources.length > 0 && pinnedSources.length <= 8,
      'invalid_pinned_sources');
    this.#clock = clock;
    this.#target = copy(target);
    for (const value of pinnedSources) {
      const source = snapshotInput(value);
      fields(source, ['id', 'cif', 'catalog'], 'invalid_pinned_source');
      requireValue(identifier(source.id) && !this.#sources.has(source.id), 'invalid_fixture_id');
      requireValue(typeof source.cif === 'string' && Buffer.byteLength(source.cif) > 0
        && Buffer.byteLength(source.cif) <= MAX_SOURCE_BYTES, 'source_size_limit');
      const bytes = Buffer.from(source.cif, 'utf8');
      const catalog = source.catalog;
      requireValue(catalog?.source?.sha256 === sha256(bytes) && catalog.source.byteLength === bytes.length,
        'pinned_catalog_source_mismatch');
      requireValue(identifier(catalog.assemblyId) && Array.isArray(catalog.modelNumbers)
        && catalog.modelNumbers.length > 0 && catalog.modelNumbers.every(value => revision(value) && value > 0)
        && Array.isArray(catalog.rows) && catalog.rows.length <= 16_384, 'invalid_pinned_catalog');
      const keys = new Set();
      for (const row of catalog.rows) {
        fullSelection([row.key]);
        requireValue(!keys.has(row.key) && row.identity?.sourceHash === catalog.source.sha256
          && row.identity.assemblyId === catalog.assemblyId
          && catalog.modelNumbers.includes(row.identity.modelNumber), 'invalid_pinned_identity');
        keys.add(row.key);
      }
      this.#sources.set(source.id, source);
    }
    this.#receiver = new Receiver({ clock, target, serverEpoch: randomUUID(), receiverEpoch: randomUUID(),
      leaseId: randomUUID(), actors: ['browser-driver'], policy: { inactivityMs: 1_800_000, leaseMs: 60_000, maxCommands: 32 },
      scene: { sceneId: 'receiver-placeholder', sourceSha256: '0'.repeat(64), revision: 0 } });
    this.#transfer = new Transfer({ receiver: this.#receiver,
      limits: { maxSourceBytes: MAX_SOURCE_BYTES, maxChunkBytes: 4096, maxSelectionKeys: MAX_SELECTIONS },
      inspectSource: async bytes => this.#sourceFacts(bytes) });
  }

  #sourceFacts(bytes) {
    const hash = sha256(bytes);
    const sources = [...this.#sources.values()].filter(source => source.catalog.source.sha256 === hash);
    requireValue(sources.length > 0, 'unpinned_source');
    const models = new Map();
    for (const { catalog } of sources) {
      for (const modelNumber of catalog.modelNumbers) {
        const model = models.get(modelNumber) ?? { modelNumber, assemblies: [] };
        if (!model.assemblies.some(assembly => assembly.assemblyId === catalog.assemblyId)) {
          model.assemblies.push({ assemblyId: catalog.assemblyId,
            selectionKeys: catalog.rows.filter(row => row.identity.modelNumber === modelNumber).map(selectionId) });
        }
        models.set(modelNumber, model);
      }
    }
    return { sha256: hash, byteLength: bytes.length, models: [...models.values()] };
  }

  #event(type, detail = {}) {
    this.#events.push({ index: ++this.#eventCount, type, ...copy(detail) });
    if (this.#events.length > 128) this.#events.shift();
  }

  #capture(input) {
    const envelope = snapshotInput(input);
    fields(envelope, ['version', 'captureId', 'target', 'sceneId', 'desktopRevision', 'fixtureId', 'cif', 'scene'],
      'invalid_capture_fields');
    requireValue(envelope.version === 1 && identifier(envelope.captureId) && identifier(envelope.sceneId)
      && revision(envelope.desktopRevision), 'invalid_capture');
    validateTarget(envelope.target);
    requireValue(same(envelope.target, this.#target), 'wrong_target');
    const source = this.#sources.get(envelope.fixtureId);
    requireValue(source, 'unknown_fixture');
    requireValue(typeof envelope.cif === 'string' && Buffer.byteLength(envelope.cif) <= MAX_SOURCE_BYTES,
      'source_size_limit');
    requireValue(envelope.cif === source.cif, 'source_bytes_mismatch');
    const scene = envelope.scene;
    fields(scene, ['sourceSha256', 'modelNumber', 'assemblyId', 'representation', 'color', 'selectionKeys', 'camera'],
      'invalid_scene_fields');
    requireValue(digest(scene.sourceSha256) && scene.sourceSha256 === source.catalog.source.sha256,
      'source_hash_mismatch');
    requireValue(source.catalog.modelNumbers.includes(scene.modelNumber), 'model_unavailable');
    requireValue(scene.assemblyId === source.catalog.assemblyId, 'assembly_unavailable');
    requireValue(['cartoon', 'ball-and-stick'].includes(scene.representation) && scene.color === 'chain-id',
      'unsupported_appearance');
    fullSelection(scene.selectionKeys);
    const rows = source.catalog.rows.filter(row => row.identity.modelNumber === scene.modelNumber);
    requireValue(scene.selectionKeys.every(key => rows.some(row => row.key === key)), 'selection_unavailable');
    scene.camera = validateCamera(scene.camera);
    return envelope;
  }

  async transfer(input) {
    const envelope = this.#capture(input);
    const captureDigest = sha256(canonical(envelope));
    const known = this.#captures.get(envelope.captureId);
    if (known) {
      requireValue(known.digest === captureDigest, 'capture_id_conflict');
      return copy(await known.promise);
    }
    requireValue(this.#captures.size < MAX_CAPTURES, 'capture_history_full');
    const record = { digest: captureDigest, promise: null };
    this.#captures.set(envelope.captureId, record);
    record.promise = this.#transferCapture(envelope, captureDigest);
    return copy(await record.promise);
  }

  async #transferCapture(envelope, captureDigest) {
    const scene = envelope.scene;
    const bytes = Buffer.from(envelope.cif, 'utf8');
    const manifest = { version: 1, sceneId: envelope.sceneId, privacy: 'public',
      source: { format: 'mmcif', sha256: scene.sourceSha256, byteLength: bytes.length },
      modelNumber: scene.modelNumber, assemblyId: scene.assemblyId, representation: scene.representation,
      color: scene.color, selectionKeys: scene.selectionKeys.map(key => selectionId({ key })),
      // The full camera is bound through captureDigest; these fields remain the narrower protocol summary.
      view: { centerAngstrom: copy(scene.camera.target), orientation: [0, 0, 0, 1],
        radiusAngstrom: scene.camera.radius } };
    const attempt = this.#transfer.begin(manifest).attemptId;
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      this.#transfer.append(attempt, offset, bytes.subarray(offset, offset + 4096));
    }
    await this.#transfer.prepare(attempt);
    const protocolState = this.#transfer.commit(attempt);
    const instruction = { captureId: envelope.captureId, captureDigest, sceneId: envelope.sceneId,
      sourceSha256: scene.sourceSha256, revision: protocolState.state.revision, scene: copy(scene), fixtureId: envelope.fixtureId };
    this.#current = { envelope, instruction };
    this.#bound = null;
    this.#event('capture_committed', { captureId: envelope.captureId, captureDigest, revision: instruction.revision });
    return { instruction, protocolState };
  }

  #proof(input, scene) {
    const snapshot = snapshotInput(input);
    requireValue(snapshot?.ready === true && snapshot.status === 'ready' && snapshot.error == null
      && snapshot.contextLost !== true,
      'viewer_not_ready');
    requireValue(identifier(snapshot.instanceId) && revision(snapshot.generation) && snapshot.generation > 0
      && revision(snapshot.loadCount) && snapshot.loadCount > 0 && revision(snapshot.revision)
      && revision(snapshot.drawCount) && snapshot.drawCount > 0, 'invalid_viewer_counters');
    requireValue(Number.isSafeInteger(snapshot.representationCount) && snapshot.representationCount > 0
      && Number.isSafeInteger(snapshot.renderObjectCount) && snapshot.renderObjectCount > 0,
      'missing_render_objects');
    requireValue(snapshot.sourceSha256 === scene.sourceSha256 && snapshot.modelNumber === scene.modelNumber
      && snapshot.assemblyId === scene.assemblyId, 'render_source_mismatch');
    requireValue(snapshot.representation === scene.representation && snapshot.color === scene.color,
      'render_appearance_mismatch');
    fullSelection(snapshot.selectionKeys);
    requireValue(sameSelection(snapshot.selectionKeys, scene.selectionKeys), 'render_selection_mismatch');
    const rows = [...this.#sources.values()].filter(source => source.catalog.source.sha256 === scene.sourceSha256
      && source.catalog.assemblyId === scene.assemblyId).flatMap(source => source.catalog.rows);
    const hasResolvedSelection = rows.some(row => row.identity.modelNumber === scene.modelNumber
      && scene.selectionKeys.includes(row.key) && row.atomSites?.length > 0);
    requireValue(revision(snapshot.selectedMarkerCount) && revision(snapshot.selectionLociElementCount)
      && (hasResolvedSelection ? snapshot.selectedMarkerCount > 0 && snapshot.selectionLociElementCount > 0
        : snapshot.selectedMarkerCount === 0 && snapshot.selectionLociElementCount === 0), 'render_selection_markers_mismatch');
    snapshot.camera = validateCamera(snapshot.camera);
    requireValue(camerasEqual(snapshot.camera, scene.camera), 'render_camera_mismatch');
    return snapshot;
  }

  bindRenderedCapture(input, snapshot) {
    const instruction = snapshotInput(input);
    requireValue(this.#current && same(instruction, this.#current.instruction), 'unknown_capture_instruction');
    const state = this.#receiver.inspect().state;
    requireValue(state.sceneId === instruction.sceneId && state.revision === instruction.revision,
      'capture_superseded');
    const proof = this.#proof(snapshot, instruction.scene);
    if (this.#bound) {
      const previous = this.#bound.snapshot;
      requireValue(proof.instanceId === previous.instanceId && proof.generation === previous.generation
        && proof.loadCount === previous.loadCount, 'capture_instance_changed');
    }
    this.#bound = { captureDigest: instruction.captureDigest, snapshot: proof };
    this.#event('capture_rendered', { captureId: instruction.captureId, instanceId: proof.instanceId,
      generation: proof.generation, loadCount: proof.loadCount, drawCount: proof.drawCount });
    return { status: 'capture_rendered', captureId: instruction.captureId, revision: instruction.revision,
      browser: this.#browserCounters(proof) };
  }

  #browserCounters(snapshot) {
    return { instanceId: snapshot.instanceId, generation: snapshot.generation, loadCount: snapshot.loadCount,
      revision: snapshot.revision, drawCount: snapshot.drawCount };
  }

  binding() { return this.#receiver.binding(); }

  makeCommand(operation, { sequence, ...changes } = {}) {
    if (sequence == null) sequence = ++this.#sequence;
    requireValue(Number.isSafeInteger(sequence) && sequence > 0 && sequence < 1e15, 'invalid_command_sequence');
    this.#sequence = Math.max(this.#sequence, sequence);
    const binding = this.binding();
    return { version: 1, commandId: `${binding.lease.id}/${sequence}`, actorId: 'browser-driver',
      target: binding.target, serverEpoch: binding.serverEpoch, receiverEpoch: binding.receiverEpoch,
      leaseId: binding.lease.id, deadline: Math.min(this.#clock() + 5000, binding.lease.expiresAt),
      sceneId: this.#receiver.inspect().state.sceneId, expectedRevision: this.#receiver.inspect().state.revision,
      operation: copy(operation), ...copy(changes) };
  }

  async command(input, apply) {
    let command;
    try { command = validateCommand(input); }
    catch (error) { return rejected(errorCode(error)); }
    const known = this.#jobs.get(command.commandId);
    if (!known && command.operation.kind !== 'set_representation') return rejected('unsupported_browser_operation');
    if (!known && (!this.#current || !this.#bound)) return rejected('capture_not_rendered');
    if (!known && typeof apply !== 'function') return rejected('missing_renderer_apply');
    const admission = this.#receiver.receive(command);
    if (admission.status === 'rejected') return admission;
    if (known) {
      await known.promise;
      return this.#jobResult(known);
    }
    if (admission.status !== 'accepted') return admission;
    const record = { command, promise: null, browser: null, failure: null, dispatched: false };
    this.#jobs.set(command.commandId, record);
    this.#event('command_accepted', { commandId: command.commandId });
    const execute = () => this.#apply(record, apply);
    record.promise = this.#tail.then(execute, execute);
    this.#tail = record.promise.catch(() => undefined);
    await record.promise;
    return this.#jobResult(record);
  }

  async #apply(record, apply) {
    const committed = this.#receiver.commit(record.command.commandId);
    if (committed.status !== 'committed') return;
    this.#event('command_committed', { commandId: record.command.commandId, revision: committed.committedRevision });
    const ticket = this.#receiver.renderTicket(record.command.commandId);
    const current = this.#current;
    const bound = this.#bound;
    try {
      requireValue(current && bound && bound.captureDigest === current.instruction.captureDigest
        && current.instruction.sceneId === record.command.sceneId, 'capture_superseded');
      const expectedScene = { ...copy(current.instruction.scene), ...{
        representation: record.command.operation.value, camera: copy(bound.snapshot.camera),
        selectionKeys: copy(bound.snapshot.selectionKeys) } };
      const instruction = { commandId: record.command.commandId, captureId: current.instruction.captureId,
        captureDigest: current.instruction.captureDigest, sceneId: record.command.sceneId,
        sourceSha256: expectedScene.sourceSha256, revision: committed.committedRevision,
        operation: copy(record.command.operation), expectedBrowser: this.#browserCounters(bound.snapshot) };
      record.dispatched = true;
      const proof = this.#proof(await apply(copy(instruction)), expectedScene);
      requireValue(proof.instanceId === bound.snapshot.instanceId && proof.generation === bound.snapshot.generation
        && proof.loadCount === bound.snapshot.loadCount, 'render_instance_mismatch');
      requireValue(proof.revision === bound.snapshot.revision + 1 && proof.drawCount > bound.snapshot.drawCount,
        'render_did_not_advance');
      const confirmed = this.#receiver.confirmRendered(ticket);
      requireValue(confirmed.status === 'rendered', 'render_ticket_retired');
      this.#bound = { captureDigest: current.instruction.captureDigest, snapshot: proof };
      record.browser = this.#browserCounters(proof);
      this.#event('command_rendered', { commandId: record.command.commandId, revision: confirmed.renderedRevision,
        browser: record.browser });
    } catch (error) {
      record.failure = errorCode(error);
      this.#event('command_render_unconfirmed', { commandId: record.command.commandId, reason: record.failure });
    }
  }

  #jobResult(record) {
    return { ...this.#receiver.receive(record.command), renderer: record.browser
      ? { status: 'confirmed', browser: copy(record.browser) }
      : { status: record.dispatched ? 'unconfirmed' : 'not_dispatched', reason: record.failure } };
  }

  inspect() {
    return { protocolState: this.#receiver.inspect(), currentCapture: this.#current ? copy(this.#current.instruction) : null,
      browser: this.#bound ? this.#browserCounters(this.#bound.snapshot) : null,
      events: copy(this.#events), eventCount: this.#eventCount, retainedCaptures: this.#captures.size,
      sourceLimits: { maxSourceBytes: MAX_SOURCE_BYTES, maxSelections: MAX_SELECTIONS }, cameraTolerance: CAMERA_TOLERANCE };
  }
}
