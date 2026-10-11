import { ContractError, canonical, copy, digest, fields, identifier, requireValue, revision, same, sha256,
  validateTarget } from './contracts.mjs';
import { camerasEqual, validateCamera } from './camera.mjs';

const SNAPSHOT_FIELDS = ['revision', 'sourceSha256', 'modelNumber', 'assemblyId', 'representation',
  'color', 'selectionKeys', 'camera'];
const SCOPE_FIELDS = ['target', 'serverEpoch', 'receiverEpoch', 'leaseId', 'sceneId'];
const REQUEST_FIELDS = ['version', 'operationId', 'actorId', 'scope', 'expectedRevision', 'cause', 'operation'];
const EVENT_FIELDS = ['index', 'at', 'type', 'scope', 'operationId', 'actorId', 'cause', 'revision',
  'detail', 'previousHash', 'hash'];
const DEFAULT_LIMITS = { maxOperations: 64, maxEvents: 256, maxSavedViews: 16, maxSelectionKeys: 128,
  maxBytes: 8 * 1024 * 1024 };
const HARD_BYTES = 32 * 1024 * 1024;
const TERMINAL_RESERVE = 4096;
const byteLength = value => Buffer.byteLength(canonical(value));
const operationId = (value, leaseId) => typeof value === 'string' && value.startsWith(`${leaseId}/`)
  && /^[1-9][0-9]{0,14}$/u.test(value.slice(leaseId.length + 1));
const timeValue = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

function frozen(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

// Reject accessors before reading them. Logs accept bounded JSON data, including dense arrays only.
function jsonData(input, maxBytes = HARD_BYTES) {
  const active = new Set();
  let nodes = 0;
  let strings = 0;
  function visit(value, depth) {
    requireValue(++nodes <= 300_000 && depth <= 32, 'history_data_limit');
    if (typeof value === 'string') {
      strings += Buffer.byteLength(value);
      requireValue(strings <= maxBytes, 'history_byte_limit');
      return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      requireValue(Number.isFinite(value), 'invalid_history_data');
      return value;
    }
    requireValue(value && typeof value === 'object' && !active.has(value), 'invalid_history_data');
    const array = Array.isArray(value);
    requireValue(array ? Object.getPrototypeOf(value) === Array.prototype
      : Object.getPrototypeOf(value) === Object.prototype, 'invalid_history_data');
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    requireValue(keys.every(key => typeof key === 'string'), 'invalid_history_data');
    let result;
    if (array) {
      requireValue(value.length <= 16_384 && keys.length === value.length + 1
        && Array.from({ length: value.length }, (_, index) => String(index)).every(key => Object.hasOwn(descriptors, key)),
      'invalid_history_array');
      result = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[index];
        requireValue(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'invalid_history_data');
        result.push(visit(descriptor.value, depth + 1));
      }
    } else {
      result = {};
      for (const key of keys) {
        const descriptor = descriptors[key];
        requireValue(Object.hasOwn(descriptor, 'value') && descriptor.enumerable && key !== '__proto__',
          'invalid_history_data');
        strings += Buffer.byteLength(key);
        requireValue(strings <= maxBytes, 'history_byte_limit');
        Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true,
          writable: true, configurable: true });
      }
    }
    active.delete(value);
    return result;
  }
  const result = visit(input, 0);
  requireValue(byteLength(result) <= maxBytes, 'history_byte_limit');
  return result;
}

function validateScope(scope) {
  fields(scope, SCOPE_FIELDS, 'invalid_history_scope');
  validateTarget(scope.target);
  for (const key of SCOPE_FIELDS.filter(key => key !== 'target')) requireValue(identifier(scope[key]), 'invalid_history_scope');
}

function validateLimits(input) {
  fields(input, Object.keys(DEFAULT_LIMITS), 'invalid_history_limits');
  const upper = { maxOperations: 256, maxEvents: 1024, maxSavedViews: 64, maxSelectionKeys: 128, maxBytes: HARD_BYTES };
  requireValue(Object.keys(upper).every(key => Number.isSafeInteger(input[key]) && input[key] > 0
    && input[key] <= upper[key]) && input.maxEvents >= 3 && input.maxBytes >= 4096, 'invalid_history_limits');
}

function fullKey(key, scientific) {
  requireValue(typeof key === 'string' && key.length > 0 && key.length <= 4096, 'invalid_selection_key');
  let parsed;
  try { parsed = JSON.parse(key); } catch { throw new ContractError('invalid_selection_key'); }
  requireValue(Array.isArray(parsed) && parsed.length === 11 && parsed[0] === 'residue-v1'
    && JSON.stringify(parsed) === key, 'invalid_selection_key');
  requireValue(parsed[1] === scientific.sourceSha256 && parsed[2] === scientific.modelNumber,
    'selection_scope_mismatch');
  let assemblyCopy;
  try { assemblyCopy = JSON.parse(parsed[3]); } catch { throw new ContractError('invalid_selection_key'); }
  requireValue(Array.isArray(assemblyCopy) && assemblyCopy.length === 4 && assemblyCopy[0] === 'copy'
    && assemblyCopy[1] === scientific.assemblyId && Array.isArray(assemblyCopy[3])
    && (scientific.assemblyId === 'asymmetric_unit'
      ? assemblyCopy[2] === null && assemblyCopy[3].length === 0
      : Number.isSafeInteger(assemblyCopy[2]) && assemblyCopy[2] >= 0 && assemblyCopy[3].length > 0
        && assemblyCopy[3].every(value => typeof value === 'string' && value.length > 0))
    && JSON.stringify(assemblyCopy) === parsed[3], 'selection_scope_mismatch');
  requireValue([4, 5, 10].every(index => typeof parsed[index] === 'string' && parsed[index].length > 0)
    && [6, 9].every(index => parsed[index] === null || typeof parsed[index] === 'string')
    && (parsed[7] === null || Number.isSafeInteger(parsed[7]) && parsed[7] > 0)
    && (parsed[8] === null || Number.isSafeInteger(parsed[8])), 'invalid_selection_key');
}

function selected(keys, header) {
  requireValue(Array.isArray(keys) && keys.length <= header.limits.maxSelectionKeys
    && new Set(keys).size === keys.length, 'invalid_history_selection');
  requireValue(keys.every(key => header.selectionKeys.includes(key)), 'selection_unavailable');
  return [...keys].sort();
}

function snapshot(input, header) {
  fields(input, SNAPSHOT_FIELDS, 'invalid_history_snapshot');
  requireValue(revision(input.revision), 'invalid_history_revision');
  requireValue(digest(input.sourceSha256) && Number.isSafeInteger(input.modelNumber) && input.modelNumber > 0
    && identifier(input.assemblyId), 'invalid_history_scientific_identity');
  if (header) {
    requireValue(['sourceSha256', 'modelNumber', 'assemblyId'].every(key => input[key] === header.initial[key]),
      'scientific_identity_changed');
  }
  requireValue(['cartoon', 'ball-and-stick'].includes(input.representation) && input.color === 'chain-id',
    'unsupported_history_appearance');
  return { ...copy(input), selectionKeys: header ? selected(input.selectionKeys, header) : copy(input.selectionKeys),
    camera: validateCamera(input.camera) };
}

function equivalentSnapshot(a, b) {
  return SNAPSHOT_FIELDS.filter(key => key !== 'camera').every(key => same(a[key], b[key]))
    && camerasEqual(a.camera, b.camera);
}

function frame(value, withRevision = false) {
  fields(value, [...(withRevision ? ['revision'] : []), 'instanceId', 'generation', 'loadCount',
    'browserRevision', 'drawCount'], 'invalid_history_render_receipt');
  requireValue(identifier(value.instanceId) && ['generation', 'loadCount', 'drawCount'].every(key =>
    revision(value[key]) && value[key] > 0) && revision(value.browserRevision)
    && (!withRevision || revision(value.revision)), 'invalid_history_render_receipt');
  return value;
}

function rendererBaselineInput(input, header) {
  fields(input, ['operationId', 'snapshot', 'receipt'], 'invalid_history_renderer_baseline');
  requireValue(input.operationId === null || operationId(input.operationId, header.scope.leaseId),
    'invalid_history_renderer_baseline');
  return { operationId: input.operationId, snapshot: snapshot(input.snapshot, header),
    receipt: copy(frame(input.receipt, true)) };
}

function confirmedBaseline(rendered) {
  if (!rendered) return null;
  const { operationId: id, snapshot: observed, ...receipt } = rendered;
  return { operationId: id, snapshot: copy(observed), receipt: copy(receipt) };
}

function hasUnconfirmedRendering(model) {
  return model.lastRendered && [...model.records.values()].some(record =>
    record.requiresRender && record.after?.revision > model.lastRendered.revision);
}

function rendererBaseline(input, model, header) {
  const baseline = rendererBaselineInput(input, header);
  const receipt = baseline.receipt;
  const binding = header.initialRenderer;
  requireValue(binding && ['instanceId', 'generation', 'loadCount'].every(key => receipt[key] === binding[key]),
    'history_render_binding_mismatch');
  let observed;
  if (baseline.operationId === null) {
    observed = header.initial;
    requireValue(receipt.browserRevision === binding.browserRevision && receipt.drawCount >= binding.drawCount,
      'history_baseline_did_not_match');
  } else {
    const previous = model.records.get(baseline.operationId);
    requireValue(previous?.after && previous.requiresRender && previous.rendererBaseline,
      'history_baseline_operation_unavailable');
    observed = previous.after;
    const anchor = previous.rendererBaseline.receipt;
    requireValue(receipt.browserRevision === anchor.browserRevision + 1 && receipt.drawCount > anchor.drawCount,
      'history_baseline_did_not_advance');
    if (previous.receipt) requireValue(receipt.drawCount >= previous.receipt.drawCount,
      'history_baseline_did_not_advance');
  }
  requireValue(receipt.revision === observed.revision && equivalentSnapshot(baseline.snapshot, observed),
    'history_baseline_snapshot_mismatch');
  requireValue(equivalentSnapshot({ ...baseline.snapshot, revision: model.snapshot.revision }, model.snapshot),
    'history_renderer_reconciliation_required');
  const confirmed = model.lastRendered;
  requireValue(confirmed && receipt.browserRevision >= confirmed.browserRevision
    && receipt.drawCount >= confirmed.drawCount
    && (receipt.browserRevision === confirmed.browserRevision || receipt.drawCount > confirmed.drawCount),
  'history_baseline_precedes_confirmation');
  return baseline;
}

function cause(value, leaseId) {
  fields(value, ['kind', 'operationId'], 'invalid_history_cause');
  requireValue(['user', 'undo', 'cancel', 'renderer', 'supersession', 'rejection'].includes(value.kind)
    && (value.operationId === null || operationId(value.operationId, leaseId)), 'invalid_history_cause');
}

function request(input, header) {
  fields(input, REQUEST_FIELDS, 'invalid_history_request');
  requireValue(input.version === 1 && operationId(input.operationId, header.scope.leaseId), 'invalid_history_operation_id');
  validateScope(input.scope);
  requireValue(same(input.scope, header.scope), 'wrong_history_scope');
  requireValue(header.actors.includes(input.actorId), 'unknown_history_actor');
  requireValue(revision(input.expectedRevision), 'invalid_history_revision');
  cause(input.cause, header.scope.leaseId);
  const operation = input.operation;
  requireValue(operation && typeof operation === 'object', 'invalid_history_operation');
  switch (operation.kind) {
    case 'set_representation':
      fields(operation, ['kind', 'value']);
      requireValue(['cartoon', 'ball-and-stick'].includes(operation.value), 'unsupported_history_appearance');
      break;
    case 'set_selection':
      fields(operation, ['kind', 'selectionKeys']);
      selected(operation.selectionKeys, header);
      break;
    case 'set_camera':
      fields(operation, ['kind', 'camera']);
      operation.camera = validateCamera(operation.camera);
      break;
    case 'save_view':
      fields(operation, ['kind', 'viewId', 'name']);
      requireValue(identifier(operation.viewId), 'invalid_saved_view_id');
      requireValue(typeof operation.name === 'string' && operation.name.length > 0 && operation.name.length <= 80
        && operation.name === operation.name.trim() && operation.name === operation.name.normalize('NFC')
        && !/[\u0000-\u001f\u007f-\u009f]/u.test(operation.name), 'invalid_saved_view_name');
      break;
    case 'restore_view':
      fields(operation, ['kind', 'viewId']);
      requireValue(identifier(operation.viewId), 'invalid_saved_view_id');
      break;
    case 'undo':
      fields(operation, ['kind', 'operationId']);
      requireValue(operationId(operation.operationId, header.scope.leaseId)
        && operation.operationId !== input.operationId, 'invalid_undo_reference');
      break;
    default: throw new ContractError('unsupported_history_operation');
  }
  requireValue(operation.kind === 'undo'
    ? input.cause.kind === 'undo' && input.cause.operationId === operation.operationId
    : input.cause.kind === 'user' && input.cause.operationId === null, 'invalid_history_cause');
  return input;
}

function plan(model, value, header) {
  requireValue(value.expectedRevision === model.snapshot.revision, 'history_revision_conflict');
  requireValue(model.snapshot.revision < Number.MAX_SAFE_INTEGER, 'history_revision_exhausted');
  const after = copy(model.snapshot);
  after.revision++;
  const operation = value.operation;
  let saved = null;
  if (operation.kind === 'set_representation') after.representation = operation.value;
  if (operation.kind === 'set_selection') after.selectionKeys = selected(operation.selectionKeys, header);
  if (operation.kind === 'set_camera') after.camera = copy(operation.camera);
  if (operation.kind === 'save_view') {
    requireValue(model.lastRendered && !hasUnconfirmedRendering(model) && equivalentSnapshot({ ...model.lastRendered.snapshot,
      revision: model.snapshot.revision }, model.snapshot), 'save_requires_rendered_state');
    requireValue(!model.views.has(operation.viewId), 'saved_view_id_conflict');
    requireValue(![...model.views.values()].some(view => view.name.toLowerCase() === operation.name.toLowerCase()),
      'saved_view_name_conflict');
    requireValue(model.views.size < header.limits.maxSavedViews, 'saved_view_capacity');
    saved = { viewId: operation.viewId, name: operation.name, scope: copy(header.scope),
      sourceSha256: after.sourceSha256, modelNumber: after.modelNumber, assemblyId: after.assemblyId,
      camera: copy(after.camera), selectionKeys: copy(after.selectionKeys), actorId: value.actorId,
      operationId: value.operationId, capturedRevision: model.snapshot.revision, savedRevision: after.revision };
  }
  if (operation.kind === 'restore_view') {
    const view = model.views.get(operation.viewId);
    requireValue(view, 'unknown_saved_view');
    after.camera = copy(view.camera);
    after.selectionKeys = copy(view.selectionKeys);
  }
  if (operation.kind === 'undo') {
    const original = model.records.get(operation.operationId);
    requireValue(original && ['set_representation', 'set_selection', 'set_camera', 'restore_view']
      .includes(original.request.operation.kind), 'operation_not_undoable');
    requireValue(original.status === 'rendered', 'undo_requires_rendered_change');
    requireValue(original.request.actorId === value.actorId, 'undo_actor_conflict');
    requireValue(original.undoneBy === null, 'operation_already_undone');
    requireValue(original.after.revision === model.snapshot.revision
      && same(original.after, model.snapshot), 'undo_revision_conflict');
    Object.assign(after, copy(original.before), { revision: after.revision });
  }
  const beforeWithoutRevision = { ...model.snapshot, revision: after.revision };
  requireValue(saved || !equivalentSnapshot(beforeWithoutRevision, after), 'history_no_change');
  return { snapshot: after, saved, requiresRender: operation.kind !== 'save_view' };
}

function reservedEvents(model) {
  return [...model.records.values()].reduce((sum, record) => sum + (record.status === 'admitted' ? 2
    : record.status === 'committed' && record.requiresRender ? 1 : 0), 0);
}
function reservedBytes(model) {
  return [...model.records.values()].reduce((sum, record) => sum + record.reservedBytes, 0);
}
function outcome(record) {
  return { operationId: record.request.operationId, actorId: record.request.actorId, cause: copy(record.request.cause),
    status: record.status, committedRevision: record.after?.revision ?? null,
    renderedRevision: record.receipt?.revision ?? null, reason: record.reason, terminalCause: copy(record.terminalCause),
    requiresRender: record.requiresRender, undoneBy: record.undoneBy };
}

function validateHeader(input) {
  fields(input, ['version', 'scope', 'initial', 'initialRenderer', 'selectionKeys', 'actors', 'limits', 'startedAt'],
    'invalid_history_header');
  requireValue(input.version === 1 && timeValue(input.startedAt), 'invalid_history_header');
  validateScope(input.scope);
  validateLimits(input.limits);
  requireValue(Array.isArray(input.actors) && input.actors.length > 0 && input.actors.length <= 16
    && input.actors.every(identifier) && new Set(input.actors).size === input.actors.length, 'invalid_history_actors');
  input.initial = snapshot(input.initial);
  requireValue(Array.isArray(input.selectionKeys) && input.selectionKeys.length <= 16_384
    && new Set(input.selectionKeys).size === input.selectionKeys.length, 'invalid_selection_catalog');
  for (const key of input.selectionKeys) fullKey(key, input.initial);
  input.selectionKeys.sort();
  input.initial = snapshot(input.initial, input);
  if (input.initialRenderer !== null) frame(input.initialRenderer);
  requireValue(byteLength(input) <= input.limits.maxBytes, 'history_byte_limit');
  return input;
}

function initialModel(header) {
  return { snapshot: copy(header.initial), views: new Map(), records: new Map(), eventCount: 0,
    bytes: byteLength(header), lastAt: header.startedAt, lastHash: sha256(canonical(header)),
    lastRendered: header.initialRenderer ? { operationId: null, revision: header.initial.revision,
      ...copy(header.initialRenderer), snapshot: copy(header.initial) } : null };
}

function reduce(model, input, header) {
  const event = jsonData(input, header.limits.maxBytes);
  fields(event, EVENT_FIELDS, 'invalid_history_event');
  validateScope(event.scope);
  requireValue(same(event.scope, header.scope), 'wrong_history_scope');
  requireValue(event.index === model.eventCount + 1 && timeValue(event.at) && event.at >= model.lastAt,
    'history_event_order');
  requireValue(event.previousHash === model.lastHash && digest(event.hash), 'history_hash_chain');
  const { hash, ...body } = event;
  requireValue(hash === sha256(canonical(body)), 'history_hash_mismatch');
  requireValue(operationId(event.operationId, header.scope.leaseId) && header.actors.includes(event.actorId)
    && revision(event.revision), 'invalid_history_event');
  cause(event.cause, header.scope.leaseId);
  const bytes = byteLength(event);
  const next = copy(model);
  let record = next.records.get(event.operationId);
  if (event.type === 'admitted') {
    fields(event.detail, ['request']);
    const value = request(event.detail.request, header);
    requireValue(!record, 'duplicate_history_event');
    requireValue(value.operationId === event.operationId && value.actorId === event.actorId
      && same(value.cause, event.cause) && event.revision === next.snapshot.revision, 'history_event_request_mismatch');
    const planned = plan(next, value, header);
    // Reserve a full observation of the preceding state as well as the new snapshot.
    const reserve = byteLength(planned.snapshot) + byteLength(next.snapshot) + 2 * TERMINAL_RESERVE;
    requireValue(next.records.size < header.limits.maxOperations
      && next.eventCount + reservedEvents(next) + 3 <= header.limits.maxEvents, 'history_capacity');
    requireValue(next.bytes + bytes + reservedBytes(next) + reserve <= header.limits.maxBytes, 'history_byte_limit');
    record = { request: frozen(value), status: 'admitted', reason: null, terminalCause: null, before: null, after: null, receipt: null,
      requiresRender: planned.requiresRender, rendererBaseline: null, undoneBy: null, reservedBytes: reserve };
    next.records.set(value.operationId, record);
  } else {
    requireValue(record && event.actorId === record.request.actorId, 'unknown_history_operation');
    if (event.type === 'committed') {
      const explicitBaseline = event.detail !== null && Object.hasOwn(event.detail, 'rendererBaseline');
      fields(event.detail, explicitBaseline ? ['snapshot', 'rendererBaseline'] : ['snapshot']);
      requireValue(record.status === 'admitted' && same(event.cause, record.request.cause), 'history_phase_conflict');
      const planned = plan(next, record.request, header);
      const after = snapshot(event.detail.snapshot, header);
      requireValue(equivalentSnapshot(after, planned.snapshot) && event.revision === after.revision,
        'history_commit_mismatch');
      requireValue(![...next.records.values()].some(other => other !== record && other.status === 'committed'
        && other.requiresRender), 'pending_render_must_be_superseded');
      requireValue(!explicitBaseline || planned.requiresRender, 'history_metadata_has_no_renderer_baseline');
      if (planned.requiresRender) {
        requireValue(explicitBaseline || !hasUnconfirmedRendering(next),
        'history_renderer_reconciliation_required');
        const candidate = explicitBaseline ? event.detail.rendererBaseline : confirmedBaseline(next.lastRendered);
        record.rendererBaseline = candidate === null ? null : rendererBaseline(candidate, next, header);
      }
      record.before = copy(next.snapshot);
      record.after = after;
      record.status = 'committed';
      next.snapshot = copy(after);
      if (planned.saved) next.views.set(planned.saved.viewId, frozen(planned.saved));
      if (record.request.operation.kind === 'undo') {
        next.records.get(record.request.operation.operationId).undoneBy = record.request.operationId;
      }
      const remaining = record.requiresRender ? TERMINAL_RESERVE : 0;
      requireValue(bytes <= record.reservedBytes - remaining, 'history_event_reservation');
      record.reservedBytes = remaining;
    } else if (event.type === 'rendered') {
      fields(event.detail, ['receipt']);
      requireValue(record.status === 'committed' && record.requiresRender, 'history_phase_conflict');
      const receipt = frame(event.detail.receipt, true);
      requireValue(event.cause.kind === 'renderer' && event.cause.operationId === event.operationId,
        'invalid_history_cause');
      requireValue(event.revision === next.snapshot.revision && receipt.revision === next.snapshot.revision
        && record.after.revision === next.snapshot.revision, 'stale_history_render');
      const prior = record.rendererBaseline?.receipt;
      requireValue(prior && ['instanceId', 'generation', 'loadCount'].every(key => receipt[key] === prior[key]),
        'history_render_binding_mismatch');
      requireValue(receipt.browserRevision === prior.browserRevision + 1 && receipt.drawCount > prior.drawCount,
        'history_render_did_not_advance');
      record.status = 'rendered';
      record.receipt = copy(receipt);
      next.lastRendered = { operationId: event.operationId, ...copy(receipt), snapshot: copy(next.snapshot) };
      requireValue(bytes <= record.reservedBytes, 'history_event_reservation');
      record.reservedBytes = 0;
    } else {
      fields(event.detail, ['reason']);
      requireValue(identifier(event.detail.reason) && event.revision === next.snapshot.revision, 'invalid_history_reason');
      const eligible = event.type === 'cancelled' || event.type === 'rejected' ? record.status === 'admitted'
        : event.type === 'renderer_failed' ? record.status === 'committed' && record.requiresRender
          : event.type === 'superseded' && (record.status === 'admitted' || record.status === 'committed' && record.requiresRender);
      requireValue(eligible, 'history_phase_conflict');
      const kind = { cancelled: 'cancel', rejected: 'rejection', renderer_failed: 'renderer', superseded: 'supersession' }[event.type];
      requireValue(event.cause.kind === kind && (kind === 'supersession'
        ? event.cause.operationId === null || next.records.has(event.cause.operationId)
        : event.cause.operationId === event.operationId), 'invalid_history_cause');
      record.status = event.type;
      record.reason = event.detail.reason;
      record.terminalCause = copy(event.cause);
      requireValue(bytes <= record.reservedBytes, 'history_event_reservation');
      record.reservedBytes = 0;
    }
  }
  next.eventCount++;
  next.bytes += bytes;
  next.lastAt = event.at;
  next.lastHash = event.hash;
  requireValue(next.eventCount + reservedEvents(next) <= header.limits.maxEvents
    && next.bytes + reservedBytes(next) <= header.limits.maxBytes, 'history_capacity');
  return { model: next, event: frozen(event) };
}

// This records one trusted receiver binding. The caller still owns authorization,
// lease expiry, renderer proof, and routing; this module never dispatches a command.
export class InspectionHistory {
  #header; #model; #events = []; #clock;

  constructor({ clock, scope, initial, initialRenderer = null, selectionKeys, actors, limits = DEFAULT_LIMITS }) {
    requireValue(typeof clock === 'function', 'invalid_history_clock');
    this.#clock = clock;
    this.#header = frozen(validateHeader(jsonData({ version: 1, scope, initial, initialRenderer, selectionKeys,
      actors, limits: { ...DEFAULT_LIMITS, ...limits }, startedAt: clock() })));
    this.#model = initialModel(this.#header);
  }

  #append(type, id, detail, eventCause, revisionValue, draft = this.#model) {
    const record = draft.records.get(id);
    const value = type === 'admitted' ? detail.request : record?.request;
    requireValue(value, 'unknown_history_operation');
    const at = this.#clock();
    requireValue(timeValue(at) && at >= draft.lastAt, 'history_clock_not_monotonic');
    const body = { index: draft.eventCount + 1, at, type, scope: copy(this.#header.scope), operationId: id,
      actorId: value.actorId, cause: copy(eventCause ?? value.cause), revision: revisionValue ?? draft.snapshot.revision,
      detail: copy(detail), previousHash: draft.lastHash };
    return reduce(draft, { ...body, hash: sha256(canonical(body)) }, this.#header);
  }

  #accept(result) {
    this.#model = result.model;
    this.#events.push(result.event);
  }

  makeRequest(operation, { operationId: id, actorId, expectedRevision = this.#model.snapshot.revision } = {}) {
    const nextOperation = jsonData(operation, this.#header.limits.maxBytes);
    return request(jsonData({ version: 1, operationId: id, actorId, scope: this.#header.scope, expectedRevision,
      cause: nextOperation?.kind === 'undo' ? { kind: 'undo', operationId: nextOperation.operationId }
        : { kind: 'user', operationId: null }, operation: nextOperation }), this.#header);
  }

  prepareUndo(originalId, options) {
    const value = this.makeRequest({ kind: 'undo', operationId: originalId }, options);
    plan(this.#model, value, this.#header);
    return value;
  }

  admit(input) {
    const value = request(jsonData(input, this.#header.limits.maxBytes), this.#header);
    const known = this.#model.records.get(value.operationId);
    if (known) {
      requireValue(same(known.request, value), 'history_operation_id_conflict');
      return copy(outcome(known));
    }
    this.#accept(this.#append('admitted', value.operationId, { request: value }));
    return this.operation(value.operationId);
  }

  preview(id) {
    const record = this.#model.records.get(id);
    requireValue(record && record.status === 'admitted', 'history_operation_not_pending');
    const planned = plan(this.#model, record.request, this.#header);
    return copy({ snapshot: planned.snapshot, requiresRender: planned.requiresRender });
  }

  commit(id, afterInput, options = {}) {
    const settings = jsonData(options);
    const explicitBaseline = settings !== null && Object.hasOwn(settings, 'rendererBaseline');
    fields(settings, explicitBaseline ? ['rendererBaseline'] : [], 'invalid_history_commit_options');
    const record = this.#model.records.get(id);
    requireValue(record, 'unknown_history_operation');
    if (record.status !== 'admitted') {
      if (record.after) requireValue(same(snapshot(jsonData(afterInput), this.#header), record.after), 'history_commit_mismatch');
      if (record.after && explicitBaseline) requireValue(same(
        rendererBaselineInput(settings.rendererBaseline, this.#header), record.rendererBaseline),
      'history_renderer_baseline_conflict');
      return this.operation(id);
    }
    // Resolve ordering failures into a retained terminal result before accepting any new snapshot.
    try { plan(this.#model, record.request, this.#header); }
    catch (error) {
      if (!(error instanceof ContractError)) throw error;
      return this.reject(id, error.code);
    }
    const after = snapshot(jsonData(afterInput), this.#header);
    let draft = this.#model;
    const events = [];
    for (const older of draft.records.values()) {
      if (older.status !== 'committed' || !older.requiresRender) continue;
      const result = this.#append('superseded', older.request.operationId,
        { reason: 'newer_commit_before_render_confirmation' }, { kind: 'supersession', operationId: id }, undefined, draft);
      draft = result.model;
      events.push(result.event);
    }
    const detail = explicitBaseline ? { snapshot: after, rendererBaseline: settings.rendererBaseline } : { snapshot: after };
    const result = this.#append('committed', id, detail, undefined, after.revision, draft);
    this.#model = result.model;
    this.#events.push(...events, result.event);
    return this.operation(id);
  }

  #terminal(id, type, reason, kind, reference = id) {
    const record = this.#model.records.get(id);
    requireValue(record, 'unknown_history_operation');
    requireValue(identifier(reason), 'invalid_history_reason');
    if (record.status === type) {
      requireValue(record.reason === reason && same(record.terminalCause, { kind, operationId: reference }),
        'history_terminal_conflict');
      return this.operation(id);
    }
    this.#accept(this.#append(type, id, { reason }, { kind, operationId: reference }));
    return this.operation(id);
  }

  cancel(id, actorId) {
    requireValue(this.#model.records.get(id)?.request.actorId === actorId && this.#header.actors.includes(actorId),
      'history_cancel_actor_conflict');
    return this.#terminal(id, 'cancelled', 'cancelled_before_commit', 'cancel');
  }
  reject(id, reason) { return this.#terminal(id, 'rejected', reason, 'rejection'); }
  supersede(id, reason, byOperationId = null) { return this.#terminal(id, 'superseded', reason, 'supersession', byOperationId); }
  rendererFailed(id, reason) { return this.#terminal(id, 'renderer_failed', reason, 'renderer'); }

  confirmRendered(id, input) {
    const receipt = frame(jsonData(input), true);
    const record = this.#model.records.get(id);
    requireValue(record, 'unknown_history_operation');
    if (record.status === 'rendered') {
      requireValue(same(record.receipt, receipt), 'history_render_receipt_conflict');
      return this.operation(id);
    }
    this.#accept(this.#append('rendered', id, { receipt }, { kind: 'renderer', operationId: id }));
    return this.operation(id);
  }

  operation(id) {
    const record = this.#model.records.get(id);
    requireValue(record, 'unknown_history_operation');
    return copy(outcome(record));
  }
  savedView(id) { return copy(this.#model.views.get(id) ?? null); }

  inspect() { return inspect(this.#model); }
  exportLog() { return frozen(copy({ version: 1, header: this.#header, events: this.#events })); }
}

function inspect(model) {
  return copy({ snapshot: model.snapshot, savedViews: [...model.views.values()],
    operations: [...model.records.values()].map(outcome), lastRendered: model.lastRendered,
    eventCount: model.eventCount, bytes: model.bytes, reservedEvents: reservedEvents(model),
    reservedBytes: reservedBytes(model), lastAt: model.lastAt, lastHash: model.lastHash });
}

export function replayHistory(input) {
  const log = jsonData(input);
  fields(log, ['version', 'header', 'events'], 'invalid_history_log');
  requireValue(log.version === 1 && Array.isArray(log.events), 'invalid_history_log');
  const header = validateHeader(log.header);
  requireValue(log.events.length <= header.limits.maxEvents, 'history_capacity');
  let model = initialModel(header);
  for (const event of log.events) model = reduce(model, event, header).model;
  return inspect(model);
}
