import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { Visual } from 'molstar/lib/mol-repr/visual.js';
import { updatePlacementBounds } from './placement-bounds.mjs';

// MultiRepresentation.renderObjects allocates a fresh array on every read.
// Geometry/visual membership changes only at scene/appearance boundaries.
const objectLists = new WeakMap();
export function motionRenderObjects(repr) {
  let entry = objectLists.get(repr);
  const version = repr.geometryVersion, visuals = repr.props?.visuals;
  if (!entry || entry.version !== version || entry.visuals !== visuals) {
    entry = {version, visuals, objects:repr.renderObjects}; objectLists.set(repr, entry);
  }
  return entry.objects;
}

// A common body transform does not change instance membership. Preserve Mol*'s
// grid ordering and buffers instead of allocating/rebinning it on every tick.
// Use setState so all nested representation states (including picking) agree.
// This synchronous scope restores the stock setter even if a visual throws;
// appearance, unit-transform and geometry updates always use the stock path.
let upstream;
function setTransform(object, matrix, instances) {
  const v = object?.values;
  if (!matrix || instances !== undefined || !v?.aInstance || !v.transform)
    return upstream(object, matrix, instances);
  Mat4.copy(v.matrix.ref.value, matrix); ValueCell.update(v.matrix, v.matrix.ref.value);
  const output = v.aTransform.ref.value, base = v.transform.ref.value, extra = v.extraTransform.ref.value;
  const order = v.aInstance.ref.value, count = v.instanceCount.ref.value;
  for (let i = 0; i < count; i++) {
    const offset = order[i] * 16, out = i * 16;
    if (v.hasExtraTransform.ref.value) {
      Mat4.mulOffset(output, extra, base, out, offset, offset);
      Mat4.mulOffset(output, matrix, output, out, 0, out);
    } else Mat4.mulOffset(output, matrix, base, out, 0, offset);
  }
  ValueCell.update(v.aTransform, output);
}
export function setMotionTransform(repr, state) {
  const saved = Visual.setTransform, previous = upstream;
  upstream = saved === setTransform ? previous : saved; Visual.setTransform = setTransform;
  try { repr.setState(state); }
  finally { Visual.setTransform = saved; upstream = previous; }
  updatePlacementBounds(repr, motionRenderObjects(repr));
}
