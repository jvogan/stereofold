import { measureComponentLabels, renderedSubjectPoints } from './component-label-measurement.mjs';
import { applyMatrix4 } from './room-lock.mjs';

const cell = (object, name) => object?.values?.[name]?.ref?.value;

// Mol* 5.11 assign-color-varying reads this same per-instance/group texture.
// The material shader treats transparency below 0.09 as fully lit. A smoothed
// volume retains the source group texture, so use its lit membership there.
export function litVertex(object, vertex, instance) {
  if (!cell(object, 'dTransparency')) return true;
  const type = cell(object, 'dTransparencyType');
  const instanceId = cell(object, 'aInstance')?.[instance] ?? instance;
  const index = type === 'instance' ? instanceId
    : type === 'vertexInstance' ? instanceId * cell(object, 'uVertexCount') + vertex
    : ['groupInstance', 'volumeInstance'].includes(type)
      ? instanceId * cell(object, 'uGroupCount') + cell(object, 'aGroup')?.[vertex] : NaN;
  const transparency = cell(object, 'tTransparency')?.array?.[index];
  return Number.isFinite(transparency)
    && transparency / 255 * (cell(object, 'uTransparencyStrength') ?? 1) < 0.09;
}

/**
 * Entry evidence shared with overprint: signed horizontal clearance in eye
 * tangent units, positive for a gap, zero for contact, negative for overlap.
 * `lit` means the silhouette excludes faded groups. No sphere or nominal
 * entry band can substitute for unreadable committed geometry.
 */
// Retain only this solve's projected subject. The menu changes at each rung,
// while committed vertices, lit membership, camera scale and eyes do not.
export function prepareEntryStandoff({ objects, cameraScale, views, renderFromRoom }) {
  let subjectEyes, subjectError, prepared = false;
  return menuPoints => {
    if ((!(views?.length === 1 && views[0].eye === 'none')
      && (!views?.some(view => view.eye === 'left') || !views.some(view => view.eye === 'right')))
      || !menuPoints?.length || renderFromRoom?.length !== 16) return undefined;
    if (!prepared) {
      prepared = true;
      try {
        const points = objects.flatMap(object => renderedSubjectPoints(object, cameraScale, 8192, litVertex));
        if (points.length) subjectEyes = measureComponentLabels({ views, subject: { points } });
      } catch (error) { subjectError = error; }
    }
    if (subjectError) throw subjectError;
    if (!subjectEyes) return undefined;
    return measureMenuStandoff(subjectEyes, views, menuPoints, renderFromRoom);
  };
}

export function measureEntryStandoff(options = {}) {
  return prepareEntryStandoff(options)(options.menuPoints);
}

function measureMenuStandoff(subjectEyes, views, menuPoints, renderFromRoom) {
  const menu = menuPoints.map(point => applyMatrix4(point, renderFromRoom));
  const menuEyes = measureComponentLabels({ views, subject: { points: menu } });
  const clearance = eye => {
    const subject = subjectEyes.find(value => value.eye === eye)?.silhouette;
    const column = menuEyes.find(value => value.eye === eye)?.silhouette;
    if (!subject || !column) return undefined;
    return Math.round((Math.abs(subject[0] - column[0]) - subject[2] - column[2]) * 10000) / 10000;
  };
  const eyeNames = views.length === 1 ? ['none'] : ['left', 'right'];
  if (!eyeNames.every(eye => Number.isFinite(clearance(eye)))) return undefined;
  // The two silhouettes each clearance was read from, per eye, so a ring
  // record can be checked against the drawn frame and against itself:
  // clearance = |subjectX - menuX| - subjectHalfWidth - menuHalfWidth.
  const fixed = value => Math.round(value * 10000) / 10000;
  const eyes = eyeNames.map(eye => {
    const subject = subjectEyes.find(value => value.eye === eye).silhouette;
    const column = menuEyes.find(value => value.eye === eye).silhouette;
    return { eye, lit: true, clearance: clearance(eye),
      subjectX: fixed(subject[0]), subjectY: fixed(subject[1]),
      subjectHalfWidth: fixed(subject[2]), subjectHalfHeight: fixed(subject[3]),
      menuX: fixed(column[0]), menuY: fixed(column[1]),
      menuHalfWidth: fixed(column[2]), menuHalfHeight: fixed(column[3]) };
  });
  return { phase: 'entry', ...(eyeNames.length === 1 ? { clearanceMono: clearance('none') }
    : { clearanceLeft: clearance('left'), clearanceRight: clearance('right') }),
    lit: true, units: 'tangent', eyes, frame: { menu: { clear: eyes.every(eye => eye.clearance > 0) } } };
}
