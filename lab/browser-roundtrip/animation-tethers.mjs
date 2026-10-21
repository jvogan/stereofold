import { lessonLabelInk, LESSON_LABEL_BACKGROUND_OPACITY } from './lesson-label-style.mjs';
import { registerTetherCaption } from './tether-caption.mjs';
import { registerImmersiveAnnotation } from './immersive-annotations.mjs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { Shape } from 'molstar/lib/mol-model/shape.js';
import { ShapeRepresentation } from 'molstar/lib/mol-repr/shape/representation.js';
import { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { CylindersBuilder } from 'molstar/lib/mol-geo/geometry/cylinders/cylinders-builder.js';
import { Cylinders } from 'molstar/lib/mol-geo/geometry/cylinders/cylinders.js';
import { resolveFigureLoci } from './lesson-figure.mjs';
import { resolveAnimationOwnership, animationLociOwner } from './animation-selection.mjs';

export const TETHER_RADIUS_ANGSTROM = 1.5;
export const TETHER_COLOR = '#ffe600';
// 1832 px/eye at 85% viewport and a conservative 110-degree field gives
// f=545 px; 16 mm * 545 / 3.5 m = 2.49 pixels. Stretched cylinder matrices
// do not scale radius by placement, so preserve this floor with a uniform.
export const TETHER_MIN_DIAMETER_METERS = .016;

/** Resolve before replacing the live chapter; never average ambiguous atoms. */
export function resolveAnimationTethers(definition, source, owners = resolveAnimationOwnership(source, definition)) {
  const ids = new Set();
  if ((definition.tethers?.length ?? 0) > 16) throw Error('Animation allows at most 16 tethers.');
  return (definition.tethers ?? []).map(tether => {
    if (ids.has(tether.id)) throw Error('Animation tether ids must be unique.');
    ids.add(tether.id);
    const endpoint = atom => {
      const loci = resolveFigureLoci({chain:atom.chain, residues:{from:atom.residue, to:atom.residue}, atomName:atom.atom}, source);
      if (StructureElement.Loci.size(loci) !== 1)
        throw Error(`Tether ${tether.id} endpoint ${atom.chain}:${atom.residue}:${atom.atom} must resolve to exactly one atom in the loaded source.`);
      return {body:animationLociOwner(loci, owners), loci, position:StructureElement.Loci.getBoundingSphere(loci).center};
    };
    const from = endpoint(tether.from), to = endpoint(tether.to);
    if (from.body === to.body) throw Error('Tether endpoints must lie on different bodies, with at least one moving body.');
    return {...tether, from, to, centre: source.boundary.sphere.center};
  });
}

export async function createTetherRepresentations(tether, { radius = TETHER_RADIUS_ANGSTROM } = {}) {
  const color = tether.color ?? TETHER_COLOR;
  // One capped unit cylinder reaches both atoms; only its matrix changes on a
  // tick. Do not share the thin dashed measurement representation.
  const cylinders = CylindersBuilder.create(1, 1);
  cylinders.add(0, 0, 0, 0, 0, 1, 1, true, true, 2, 0);
  const shape = Shape.create(tether.id, {}, cylinders.getCylinders(),
    () => Color(parseInt(color.slice(1), 16)), () => radius, () => tether.label ?? '');
  const line = ShapeRepresentation(() => shape, Cylinders.Utils);
  let label;
  try {
    await line.createOrUpdate({ alpha: 1, quality: 'low' }, {}).run();
    if (tether.label) {
      const props = {background:true, backgroundColor:Color(0xffffff), backgroundOpacity:LESSON_LABEL_BACKGROUND_OPACITY,
        backgroundMargin:.25, borderWidth:0, tether:false, offsetX:tether.offsetX ?? 0, offsetY:tether.offsetY ?? 0, offsetZ:3, fontQuality:3};
      const builder = TextBuilder.create(props, 128, 64);
      builder.add(tether.label, 0, 0, 0, 0, 1, 0);
      const labelInk = Color(lessonLabelInk(parseInt(color.slice(1),16)));
      const shape = Shape.create(tether.id, {}, builder.getText(), () => labelInk, () => 1, () => tether.label);
      label = ShapeRepresentation(() => shape, Text.Utils);
      await label.createOrUpdate(props, {}).run();
    }
    registerImmersiveAnnotation(line, {stroke:true, minDiameter:TETHER_MIN_DIAMETER_METERS});
    if (label) { registerImmersiveAnnotation(label); registerTetherCaption(label, tether); }
    return {line, label};
  } catch (error) { line.destroy(); label?.destroy(); throw error; }
}

/** Map unit Z to the endpoint segment, retaining finite axes at zero length. */
export function tetherMatrix(from, to, out = Mat4()) {
  const zx = to[0] - from[0], zy = to[1] - from[1], zz = to[2] - from[2];
  const length = Math.hypot(zx, zy, zz);
  const dx = length > 1e-10 ? zx / length : 0;
  const dy = length > 1e-10 ? zy / length : 0;
  const dz = length > 1e-10 ? zz / length : 1;
  let xx = Math.abs(dy) < .9 ? dz : 0;
  let xy = Math.abs(dy) < .9 ? 0 : -dz;
  let xz = Math.abs(dy) < .9 ? -dx : dy;
  const norm = Math.hypot(xx, xy, xz); xx /= norm; xy /= norm; xz /= norm;
  Mat4.setIdentity(out);
  out[0] = xx; out[1] = xy; out[2] = xz;
  out[4] = dy * xz - dz * xy; out[5] = dz * xx - dx * xz; out[6] = dx * xy - dy * xx;
  out[8] = zx; out[9] = zy; out[10] = zz;
  out[12] = from[0]; out[13] = from[1]; out[14] = from[2];
  return out;
}
