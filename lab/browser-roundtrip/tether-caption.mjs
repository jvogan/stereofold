import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';

const captions = new WeakMap();
const identity = Mat4.identity();
export const tetherCaption = repr => captions.get(repr);

/** Allocate once with the plate; all pose and sizing updates reuse this record. */
export function registerTetherCaption(repr, tether) {
  const mapping = repr.renderObjects[0].values.aMapping.ref.value;
  let halfWidth = 0, halfHeight = 0;
  for (let i = 0; i < mapping.length; i += 2) {
    halfWidth = Math.max(halfWidth, Math.abs(mapping[i]));
    halfHeight = Math.max(halfHeight, Math.abs(mapping[i + 1]));
  }
  const caption = { automatic: tether.offsetX === undefined && tether.offsetY === undefined,
    from: Vec3.clone(tether.from.position), to: Vec3.clone(tether.to.position),
    centre: Vec3.clone(tether.centre ?? [0, 0, 0]), sourceCentre: Vec3.clone(tether.centre ?? [0, 0, 0]),
    eyeFrom: Vec3(), eyeTo: Vec3(), eyeCentre: Vec3(), halfWidth, halfHeight,
    x: 0, y: 0, nx: 0, ny: 1 };
  captions.set(repr, caption);
}

export function updateTetherCaption(repr, from, to, presentation) {
  const caption = captions.get(repr);
  if (!caption) return;
  Vec3.transformMat4(caption.from, from, presentation);
  Vec3.transformMat4(caption.to, to, presentation);
  Vec3.transformMat4(caption.centre, caption.sourceCentre, presentation);
}

function project(out, point, camera) {
  Vec3.scale(out, point, camera.scale ?? 1);
  Vec3.transformMat4(out, out, camera.view ?? identity);
  if (camera.state?.mode === 'perspective' && out[2] < -1e-6) {
    out[0] /= -out[2]; out[1] /= -out[2];
  }
}

/** Common camera basis for both eyes. `unit` is the painted text mapping unit
 * (pixels on desktop, molecular units in XR), including readability sizing.
 * The plate support radius clears even a diagonal line; a full plate height
 * of extra space leaves room for a neighbouring midpoint distance readout.
 */
export function placeTetherCaption(caption, camera, unit) {
  project(caption.eyeFrom, caption.from, camera);
  project(caption.eyeTo, caption.to, camera);
  project(caption.eyeCentre, caption.centre, camera);
  const a = caption.eyeFrom, b = caption.eyeTo, c = caption.eyeCentre;
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  let nx = length > 1e-8 ? -dy / length : 0;
  let ny = length > 1e-8 ? dx / length : 1;
  const outward = nx * ((a[0] + b[0]) / 2 - c[0]) + ny * ((a[1] + b[1]) / 2 - c[1]);
  // Deterministic up/right fallback for a centred or end-on connector.
  if (outward < -1e-8 || (Math.abs(outward) <= 1e-8 && (ny < 0 || (ny === 0 && nx < 0)))) {
    nx = -nx; ny = -ny;
  }
  const distance = (Math.abs(nx) * caption.halfWidth + Math.abs(ny) * caption.halfHeight
    + 2 * caption.halfHeight + .25) * unit;
  caption.nx = nx; caption.ny = ny;
  caption.x = nx * distance; caption.y = ny * distance;
  return caption;
}
