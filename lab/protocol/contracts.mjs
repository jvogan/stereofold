import { createHash } from 'node:crypto';

export class ContractError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function requireValue(condition, code) {
  if (!condition) throw new ContractError(code);
}
export function fields(value, names, code = 'invalid_fields') {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype, code);
  requireValue(Object.keys(value).length === names.length
    && names.every((name) => Object.hasOwn(value, name)), code);
}
export const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value);
export const revision = (value) => Number.isSafeInteger(value) && value >= 0;
export const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Sorting keys makes property order irrelevant; every accepted field is validated first.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const copy = (value) => structuredClone(value);
export function snapshotInput(value) {
  try { return copy(value); }
  catch { throw new ContractError('invalid_data'); }
}
export const same = (a, b) => canonical(a) === canonical(b);

export function validateTarget(target) {
  fields(target, ['bindingId', 'taskId', 'panelId', 'sessionId', 'deviceId']);
  requireValue(Object.values(target).every(identifier), 'invalid_target');
}

export function validateView(view) {
  fields(view, ['centerAngstrom', 'orientation', 'radiusAngstrom']);
  requireValue(Array.isArray(view.centerAngstrom) && view.centerAngstrom.length === 3
    && Array.from(view.centerAngstrom).every(Number.isFinite), 'invalid_view_center');
  requireValue(Array.isArray(view.orientation) && view.orientation.length === 4
    && Array.from(view.orientation).every(Number.isFinite)
    && Math.abs(Math.hypot(...view.orientation) - 1) < 1e-9, 'invalid_view_orientation');
  requireValue(Number.isFinite(view.radiusAngstrom) && view.radiusAngstrom > 0, 'invalid_view_radius');
}

export function validateCommand(input) {
  const command = snapshotInput(input);
  fields(command, ['version', 'commandId', 'actorId', 'target', 'serverEpoch', 'receiverEpoch',
    'leaseId', 'deadline', 'sceneId', 'expectedRevision', 'operation']);
  requireValue(command.version === 1, 'unsupported_version');
  validateTarget(command.target);
  for (const key of ['actorId', 'serverEpoch', 'receiverEpoch', 'leaseId', 'sceneId']) {
    requireValue(identifier(command[key]), `invalid_${key}`);
  }
  const prefix = `${command.leaseId}/`;
  requireValue(typeof command.commandId === 'string' && command.commandId.startsWith(prefix)
    && /^[1-9][0-9]{0,14}$/u.test(command.commandId.slice(prefix.length)), 'invalid_command_id');
  requireValue(revision(command.expectedRevision) && Number.isFinite(command.deadline), 'invalid_ordering');
  const operation = command.operation;
  requireValue(operation !== null && typeof operation === 'object', 'invalid_operation');
  switch (operation.kind) {
    case 'set_representation':
      fields(operation, ['kind', 'value']);
      requireValue(['cartoon', 'ball-and-stick'].includes(operation.value), 'unsupported_representation');
      break;
    case 'set_scale':
      fields(operation, ['kind', 'value']);
      requireValue(Number.isFinite(operation.value) && operation.value >= 0.25 && operation.value <= 4,
        'scale_out_of_bounds');
      break;
    case 'rotate_object':
      fields(operation, ['kind', 'axis', 'degrees']);
      requireValue(['x', 'y', 'z'].includes(operation.axis) && Number.isFinite(operation.degrees)
        && operation.degrees >= -180 && operation.degrees <= 180, 'rotation_out_of_bounds');
      break;
    default: throw new ContractError('unsupported_operation');
  }
  return command;
}

// This draft envelope intentionally declares a small scene subset. Richer fields need a schema increment.
export function validateManifest(input, limits) {
  const manifest = snapshotInput(input);
  fields(manifest, ['version', 'sceneId', 'privacy', 'source', 'modelNumber', 'assemblyId',
    'representation', 'color', 'selectionKeys', 'view']);
  requireValue(manifest.version === 1, 'unsupported_scene_version');
  requireValue(identifier(manifest.sceneId), 'invalid_scene_id');
  requireValue(manifest.privacy === 'public', 'private_payload_refused');
  fields(manifest.source, ['format', 'sha256', 'byteLength']);
  requireValue(manifest.source.format === 'mmcif' && digest(manifest.source.sha256), 'invalid_source');
  requireValue(Number.isSafeInteger(manifest.source.byteLength) && manifest.source.byteLength > 0
    && manifest.source.byteLength <= limits.maxSourceBytes, 'source_size_limit');
  requireValue(Number.isSafeInteger(manifest.modelNumber) && manifest.modelNumber >= 1
    && identifier(manifest.assemblyId), 'invalid_model_or_assembly');
  requireValue(['cartoon', 'ball-and-stick'].includes(manifest.representation)
    && manifest.color === 'chain-id', 'unsupported_appearance');
  requireValue(Array.isArray(manifest.selectionKeys) && manifest.selectionKeys.length <= limits.maxSelectionKeys
    && Array.from(manifest.selectionKeys).every(identifier)
    && new Set(manifest.selectionKeys).size === manifest.selectionKeys.length, 'invalid_selection');
  validateView(manifest.view);
  return manifest;
}

export function checkSourceFacts(manifest, facts) {
  requireValue(facts && facts.sha256 === manifest.source.sha256
    && facts.byteLength === manifest.source.byteLength, 'source_facts_mismatch');
  const model = facts.models?.find((entry) => entry.modelNumber === manifest.modelNumber);
  requireValue(model && Array.isArray(model.assemblies), 'model_unavailable');
  const assembly = model.assemblies.find((entry) => entry.assemblyId === manifest.assemblyId);
  requireValue(assembly && Array.isArray(assembly.selectionKeys), 'assembly_unavailable');
  requireValue(manifest.selectionKeys.every((key) => assembly.selectionKeys.includes(key)), 'selection_unavailable');
}
