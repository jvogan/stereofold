import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';
import { annotationOutsideFigure, annotationOffsetCap, annotationRadius, annotationAnchorKey } from './immersive-annotations.mjs';
import { renderedSubjectSpheres } from './component-label-measurement.mjs';
import { capPlateInEyes, plateObstaclesInEyes, PLATE_MIN_EYE_DEPTH } from './plate-eye-cap.mjs';
import { updatePlacementBounds } from './placement-bounds.mjs';

// Initial exterior placement is local and lens-bounded. Its derived label
// anchor then travels with the molecule; glyphs keep their billboard facing.
export const EXTERIOR_LABEL_MAX_OFFSET_EM = 12;

/** Conservative projected molecular silhouettes. The eight corners enclose
 * each committed instance sphere, including its placement scale/rotation.
 * This avoids sampling holes and never treats label-inflated bounds as matter. */
export function figureLabelObstacles(representations, views, cameraScale) {
  const obstacles = [];
  for (const repr of representations) {
    if (repr.state?.visible === false) continue;
    for (const object of repr.renderObjects ?? []) {
      if (object.type === 'text') continue;
      for (const sphere of renderedSubjectSpheres(object, cameraScale)) {
        const points = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z =>
          sphere.center.map((value, axis) => value + [x, y, z][axis] * sphere.radius))));
        const projected = plateObstaclesInEyes([points], views)[0];
        // A conservative bound crossing the eye plane cannot prove an empty
        // exterior region in that eye. Never place readable ink over it.
        for (let eye = 0; eye < views.length; eye++) {
          const m = views[eye].transform.inverse.matrix, c = sphere.center;
          const depth = -(m[2]*c[0]+m[6]*c[1]+m[10]*c[2]+m[14]);
          if (depth + sphere.radius <= 0)
            projected[eye] = [];
          else if (depth <= sphere.radius + PLATE_MIN_EYE_DEPTH)
            projected[eye] = [{ left: -1, right: 1, bottom: -1, top: 1 }];
        }
        obstacles.push(projected);
      }
    }
  }
  return obstacles;
}

const extents = new WeakMap();
const anchoredLabels = new WeakMap();
const sourceOffsets = new WeakMap();

// Offsets in the text shader are eye-space. Bake the first chosen placement
// into the derived label anchor so later head rotation cannot swing it around
// the source. Atomic geometry and the eye-facing glyph shader remain unchanged.
function anchorLabel(object, view, cameraScale, memory, offset) {
  const v = object.values, positions = v.aPosition.ref.value, transform = v.aTransform.ref.value;
  if (!(positions?.length >= 3) || !(transform?.length >= 16) || !(cameraScale > 0)
    || !(v.drawCount?.ref.value>0) || !view?.transform?.matrix) return false;
  const world = Vec3.transformMat4(Vec3(), positions, transform), eye = view.transform.matrix;
  const towardEye = Vec3.sub(Vec3(), [eye[12]/cameraScale,eye[13]/cameraScale,eye[14]/cameraScale], world);
  const distance = Vec3.magnitude(towardEye);
  if (!(distance > 0)) return false;
  Vec3.scaleAndAdd(world,world,towardEye,((v.uOffsetZ?.ref.value ?? 0)+(v.aDepth?.ref.value?.[0] ?? 0)*.95)/distance);
  const x=v.uOffsetX.ref.value,y=v.uOffsetY.ref.value;
  for(let axis=0;axis<3;axis++)world[axis]+=eye[axis]*x+eye[axis+4]*y;
  const source=offset ? Vec3.add(Vec3(),positions,offset) : Vec3.transformMat4(Vec3(),world,Mat4.invert(Mat4(),transform));
  if (!Array.from(source).every(Number.isFinite)) return false;
  const original=positions.slice();
  for(let i=0;i<positions.length;i+=3)for(let axis=0;axis<3;axis++)positions[i+axis]=source[axis];
  ValueCell.update(v.aPosition,positions);
  anchoredLabels.set(object,{positions,version:v.aPosition.ref.version,offset:Array.from(source,(value,axis)=>value-original[axis])});
  memory.get(object).figureAnchor={positions,original,version:v.aPosition.ref.version};
  return true;
}
function clearEyeOffsets(object) {
  for(const name of ['uOffsetX','uOffsetY','uOffsetZ'])if(object.values[name]?.ref.value!==0)ValueCell.update(object.values[name],0);
}
/** Rebuild only the bounds after the solver moves uniform offsets. The base
 * sphere is restored first, so consecutive frames never inflate it again. */
export function updateExteriorLabelBounds(repr) {
  const objects = repr.renderObjects ?? [];
  updatePlacementBounds(repr, objects);
  for (const object of objects) {
    if (object.type !== 'text') continue;
    const v = object.values, mapping = v.aMapping.ref.value;
    let cached = extents.get(v);
    if (!cached || cached.mapping !== mapping || cached.version !== v.aMapping.ref.version) {
      let extent = 0;
      for (let i = 0; i < mapping.length; i += 2) extent = Math.max(extent, Math.hypot(mapping[i], mapping[i+1]));
      cached = { mapping, version: v.aMapping.ref.version, extent }; extents.set(v, cached);
    }
    const positions=v.aPosition.ref.value,center=v.invariantBoundingSphere.ref.value.center;
    let anchorReach=0;
    for(let i=0;i<positions.length;i+=3)anchorReach=Math.max(anchorReach,Math.hypot(positions[i]-center[0],positions[i+1]-center[1],positions[i+2]-center[2]));
    const reach = cached.extent * getMaxSize(v) * v.uSizeFactor.ref.value
      + Math.hypot(v.uOffsetX.ref.value, v.uOffsetY.ref.value) + Math.abs(v.uOffsetZ.ref.value)
      + (annotationRadius(repr)+anchorReach) * Mat4.getMaxScaleOnAxis(v.aTransform.ref.value) + 2;
    const sphere = v.boundingSphere.ref.value;
    sphere.radius += reach;
    ValueCell.update(v.boundingSphere, sphere);
  }
}

/** Reuse the ordinary binocular collision solver. No exterior annotations means
 * no molecular-bound work; attached labels retain their exact former policy. */
export function capFigureAnnotations({ figure, views, cameraScale, memory, placed }) {
  if(!figure || !views?.length || !(cameraScale>0))return;
  const annotations = figure?.annotations?.() ?? [];
  const identity=figure.annotationSourceIdentity?.() ?? figure;
  let offsets=sourceOffsets.get(identity);
  if(!offsets){offsets=new Map();sourceOffsets.set(identity,offsets);}
  const needsAnchor = repr => repr.renderObjects.some(object => object.type === 'text' &&
    (anchoredLabels.get(object)?.positions !== object.values.aPosition.ref.value || anchoredLabels.get(object)?.version !== object.values.aPosition.ref.version));
  const outside = annotations.some(repr => repr.state.visible && annotationOutsideFigure(repr) && needsAnchor(repr) && !offsets.has(annotationAnchorKey(repr)));
  const obstacles = outside ? figureLabelObstacles(figure.molecular?.() ?? [], views, cameraScale) : [];
  for (const repr of annotations) {
    if (!repr.state.visible) continue;
    const exterior = annotationOutsideFigure(repr);
    const key=annotationAnchorKey(repr),offset=key===undefined?undefined:offsets.get(key);
    if(exterior && needsAnchor(repr) && offset){
      // A replacement chapter label uses its own molecular selection anchor
      // plus the source's first offset for this authored role, never fresh gaze.
      let moved=false;
      for(const object of repr.renderObjects)if(object.type==='text'){
        // Establish ordinary restoration/sizing memory before baking.
        capPlateInEyes({objects:[object],views,cameraScale,memory,fixedAnchor:true});
        if(anchorLabel(object,views[0],cameraScale,memory,offset)){
          memory.get(object).figureAnchor.notify=()=>figure.notifyAnnotationMoved?.(repr);
          clearEyeOffsets(object);moved=true;
        }
      }
      if(moved)figure.notifyAnnotationMoved?.(repr);
    }
    if(exterior && !needsAnchor(repr)) {
      for(const object of repr.renderObjects)if(object.type==='text')clearEyeOffsets(object);
      capPlateInEyes({objects:repr.renderObjects,views,cameraScale,memory,placed,fixedAnchor:true});
      updateExteriorLabelBounds(repr);
      continue;
    }
    const result = capPlateInEyes({ objects: repr.renderObjects, views, cameraScale, memory, placed,
      maxOffsetEm: exterior ? EXTERIOR_LABEL_MAX_OFFSET_EM : annotationOffsetCap(repr),
      obstacles: exterior ? obstacles : [] });
    // A close or large silhouette can fill the bounded exterior search. Keep
    // the scientific name/metric available under the ordinary attached policy,
    // which still enforces binocular lens margins and preceding UI/label glass.
    if (exterior && result.clipped)
      capPlateInEyes({ objects: repr.renderObjects, views, cameraScale, memory, placed,
        maxOffsetEm: annotationOffsetCap(repr), obstacles: [] });
    if (exterior) {
      let moved=false;
      for(const object of repr.renderObjects)if(object.type==='text' && object.state.visible && anchorLabel(object,views[0],cameraScale,memory)) {
        memory.get(object).figureAnchor.notify=()=>figure.notifyAnnotationMoved?.(repr);
        if(key!==undefined && !offsets.has(key))offsets.set(key,anchoredLabels.get(object).offset);
        clearEyeOffsets(object); moved=true;
      }
      updateExteriorLabelBounds(repr);
      if(moved)figure.notifyAnnotationMoved?.(repr);
    }
  }
}
