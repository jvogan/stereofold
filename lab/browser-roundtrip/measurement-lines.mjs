import { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
import { measurementText } from './measurement-text.mjs';
import { createMeasurementClearance } from './measurement-clearance.mjs';
import { Shape } from 'molstar/lib/mol-model/shape.js';
import { ShapeRepresentation } from 'molstar/lib/mol-repr/shape/representation.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import { lessonLabelInk, LESSON_LABEL_BACKGROUND_OPACITY } from './lesson-label-style.mjs';
import { setMotionTransform, motionRenderObjects } from './motion-transform.mjs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createDashedLineRepresentation } from './lesson-figure.mjs';
import { tetherMatrix, createTetherRepresentations } from './animation-tethers.mjs';
import { measurementPosition } from './measurement-math.mjs';
import { sizeImmersiveAnnotation, registerImmersiveAnnotation } from './immersive-annotations.mjs';
import { desktopLabelPixels } from './desktop-annotations.mjs';
import { getMaxSize } from 'molstar/lib/mol-geo/geometry/size-data.js';
import { ValueCell } from 'molstar/lib/mol-util/value-cell.js';

const labelProps={background:true,backgroundColor:Color(0xffffff),backgroundOpacity:LESSON_LABEL_BACKGROUND_OPACITY,
  backgroundMargin:.25,borderWidth:0,tether:false,offsetY:0,offsetZ:3,fontQuality:3};
const distanceText=(a,b)=>`${Vec3.distance(a,b).toFixed(1)} Å`;

/** The seat stays in the midpoint's camera plane. Reserve a conservative
 * screen-sized plate before clearance, then shrink it to exactly the desktop
 * character size at the chosen seat's radial text standoff. No second search,
 * cross-frame estimate or geometry rebuild is needed. */
function desktopMeasurementSizing() {
  const eye=Vec3();
  let camera,values,scale,pixelsPerDepth,maximumUnit,offsetZ,perspective;
  const set=(cell,value)=>{
    if(Math.abs(cell.ref.value-value)<1e-6) return false;
    ValueCell.update(cell,value);return true;
  };
  return {
    prepare(canvas,label,midpoint) {
      camera=canvas.camera;values=motionRenderObjects(label)[0].values;
      if(canvas.xr?.isPresenting?.value || !camera?.view || !camera?.projection
        || !(camera.viewport?.height>0) || !(camera.scale>0)) return undefined;
      scale=camera.scale;perspective=camera.state?.mode==='perspective';offsetZ=label.props.offsetZ??0;
      Vec3.transformMat4(eye,Vec3.scale(eye,midpoint,scale),camera.view);
      const depth=perspective?-eye[2]:1;
      pixelsPerDepth=camera.projection[5]*camera.viewport.height*scale/(2*(canvas.webgl?.pixelRatio??1));
      maximumUnit=desktopLabelPixels(label.props.sizeFactor??1)/.8
        *(perspective?depth+Math.max(0,-offsetZ*scale):1)/pixelsPerDepth;
      if(!(depth>0 && maximumUnit>0 && Number.isFinite(maximumUnit))) return undefined;
      return maximumUnit;
    },
    offset:()=>offsetZ,
    apply(point,halfWidth,halfHeight) {
      Vec3.transformMat4(eye,Vec3.scale(eye,point,scale),camera.view);
      const depth=perspective?-eye[2]*(1-offsetZ*scale/Vec3.magnitude(eye)):1;
      const unit=Math.min(maximumUnit,desktopLabelPixels(1)/.8*depth/pixelsPerDepth);
      let changed=set(values.uSizeFactor,unit/getMaxSize(values));
      changed=set(values.uOffsetX,0)||changed;changed=set(values.uOffsetY,0)||changed;
      changed=set(values.uOffsetZ,offsetZ)||changed;
      // Text quads ignore aTransform scale. Its culling sphere must cover the
      // final billboard, including the standoff, after a seat transform update.
      const sphere=values.boundingSphere.ref.value;
      const radius=Math.hypot(halfWidth,halfHeight)*unit+Math.abs(offsetZ)+2;
      if(Math.abs(sphere.radius-radius)>1e-6 || Vec3.distance(sphere.center,point)>1e-6) {
        Vec3.copy(sphere.center,point);sphere.radius=radius;ValueCell.update(values.boundingSphere,sphere);changed=true;
      }
      return changed;
    },
  };
}
async function numericLabel(id,color,text) {
  const digits=measurementText(labelProps);
  const data={text};
  const repr=ShapeRepresentation(()=>Shape.create(id,data,digits.geometry,
    ()=>Color(lessonLabelInk(parseInt(color.slice(1),16))),()=>1,()=>data.text),Text.Utils);
  // Capture conservative bounds for the full capacity before collapsing unused glyphs.
  try { await repr.createOrUpdate(labelProps,{text}).run(); digits.update(text); registerImmersiveAnnotation(repr); return {repr,digits,data}; }
  catch(error) {repr.destroy();throw error;}
}

/** Separate source-bound overlay: chapter figures, molecular geometry and clocks are untouched. */
export function createMeasurementLines({canvas,getTransform,getAnimation,getGlass}) {
  let lines=[],records=[];
  const owned=new WeakSet();
  let serial=Promise.resolve();
  let renderCamera;
  const xrCamera={scale:1,state:{mode:'perspective'},views:[]};
  const emptyObjects=[];
  const desktopSizing=desktopMeasurementSizing();
  let blockers=emptyObjects, membershipDirty=true, membershipSubscription;
  const tick=currentCamera=>{
    if (currentCamera?.view || currentCamera?.left) renderCamera=currentCamera;
    if(!records.length) return;
    const animation=getAnimation(),presentation=getTransform();
    // Mol* emits reprCount on scene membership commits (also when replacing
    // objects without changing the count), not on pose/uniform updates.
    if(membershipDirty || !canvas.reprCount?.subscribe) {
      blockers=canvas.getRenderObjects?.() ?? emptyObjects;membershipDirty=false;
    }
    const objects=blockers;
    let camera=canvas.camera;
    if(canvas.xr?.isPresenting?.value && renderCamera?.left) {
      xrCamera.scale=canvas.camera.scale;xrCamera.views.length=0;
      if(!renderCamera.left.disabled) xrCamera.views.push(renderCamera.left);
      if(renderCamera.right && !renderCamera.right.disabled) xrCamera.views.push(renderCamera.right);
      camera=xrCamera;
    }
    // Room controls are drawn in a separate presentation scene, so they are
    // absent from Canvas3D's molecular render-object list. Use their current
    // drawn outlines and the same room-to-scene matrix as that presentation.
    const glass=canvas.xr?.isPresenting?.value?getGlass?.():undefined;
    for(const record of records) {
      if(record.retired) continue;
      const {line,repr,matrix,label,labelMatrix,leader,leaderMatrix,digits,data}=record;
      const a=measurementPosition(line.a,animation?.definition,animation?.timeSeconds ?? 0,record.a,record.pose);
      const b=measurementPosition(line.b,animation?.definition,animation?.timeSeconds ?? 0,record.b,record.pose);
      Mat4.mul(matrix,presentation,tetherMatrix(a,b,record.segment));
      const text=distanceText(a,b);
      const textChanged=digits.update(text);data.text=text;
      if(record.desktopSized && canvas.xr?.isPresenting?.value) {
        // Re-entry can retain the same camera scale and transform. Invalidate
        // only this plate's immersive cache after desktop uniform sizing.
        registerImmersiveAnnotation(label);record.desktopSized=false;
      }
      const labelResized=sizeImmersiveAnnotation(label,canvas);
      Vec3.transformMat4(record.worldA,a,presentation);Vec3.transformMat4(record.worldB,b,presentation);
      Vec3.add(record.midpoint,record.worldA,record.worldB);Vec3.scale(record.midpoint,record.midpoint,.5);
      const desktopUnit=desktopSizing.prepare(canvas,label,record.midpoint);
      const unit=desktopUnit??motionRenderObjects(label)[0].values.uSizeFactor.ref.value;
      const placed=record.clearance.solve(record.worldA,record.worldB,camera,objects,
        digits.halfWidth*unit,digits.halfHeight*unit,record.side,owned,
        desktopUnit===undefined?motionRenderObjects(label)[0].values.uOffsetZ.ref.value:desktopSizing.offset(),!canvas.xr?.isPresenting?.value,glass);
      record.side=placed.side;
      // If neither eye-safe ray has a finite seat, hide the plate and leader
      // until a later solve succeeds. Never submit an invalid GPU transform.
      const visible=placed.valid && placed.point.every(v=>Number.isFinite(v) && Math.abs(v)<3e38);
      for(const overlay of [label,leader]) if(overlay.state.visible!==visible) {
        overlay.setState({visible});canvas.update(overlay,false);
      }
      if(visible) {
        Mat4.fromTranslation(labelMatrix,placed.point);
        const labelMoved=!Mat4.areEqual(label.state.transform,labelMatrix,1e-12);
        if(labelMoved || textChanged) setMotionTransform(label,record.labelState);
        const sized=desktopUnit===undefined?sizeImmersiveAnnotation(label,canvas):desktopSizing.apply(placed.point,digits.halfWidth,digits.halfHeight);
        if(desktopUnit!==undefined) record.desktopSized=true;
        if(sized || labelResized || labelMoved || textChanged) canvas.update(label,false);
        tetherMatrix(record.midpoint,placed.point,leaderMatrix);
        const leaderMoved=!Mat4.areEqual(leader.state.transform,leaderMatrix,1e-12);
        if(leaderMoved) setMotionTransform(leader,record.leaderState);
        const leaderResized=sizeImmersiveAnnotation(leader,canvas);
        if(leaderMoved || leaderResized) canvas.update(leader,false);
      }
      const resized=sizeImmersiveAnnotation(repr,canvas);
      if(!resized && Mat4.areEqual(repr.state.transform,matrix,1e-12)) continue;
      setMotionTransform(repr,record.lineState);
      canvas.update(repr,false);
    }
  };
  const install=async next=>{
    if(JSON.stringify(lines)===JSON.stringify(next ?? [])) return;
    const staged=[];
    try {
      for(const line of next ?? []) {
        const distance=Vec3.distance(line.a.position,line.b.position);
        const repr=await createDashedLineRepresentation(line.id,[0,0,0],[0,0,1],line.color,distanceText(line.a.position,line.b.position),1/Math.max(2,Math.min(256,distance/.35)));
        registerImmersiveAnnotation(repr,{stroke:true});
        try {
          const text=distanceText(line.a.position,line.b.position);
          const numeric=await numericLabel(line.id+'-distance',line.color,text);
          // A label leader uses a fine annotation stroke. Animation linkers
          // deliberately use a much thicker molecular radius; both retain
          // the same readable headset diameter floor.
          let leader;
          try { leader=(await createTetherRepresentations({id:line.id+'-leader',color:'#ffe600'}, {radius:.07})).line; }
          catch(error) {numeric.repr.destroy();throw error;}

          staged.push({line,repr,label:numeric.repr,digits:numeric.digits,data:numeric.data,leader,
            matrix:Mat4(),labelMatrix:Mat4(),leaderMatrix:Mat4(),segment:Mat4(),side:0,
            a:Vec3(),b:Vec3(),midpoint:Vec3(),worldA:Vec3(),worldB:Vec3(),pose:{rotation:[0,0,0,1],translation:[0,0,0]},clearance:createMeasurementClearance()});
        } catch(error) {repr.destroy();throw error;}
      }
    } catch(error) { for(const r of staged) {r.repr.destroy();r.label.destroy();r.leader.destroy();} throw error; }
    for(const r of records) {r.retired=true;canvas.remove(r.repr);canvas.remove(r.label);canvas.remove(r.leader);r.repr.destroy();r.label.destroy();r.leader.destroy();}
    for(const r of staged) {r.labelState={transform:r.labelMatrix};r.leaderState={transform:r.leaderMatrix};r.lineState={transform:r.matrix};}
    records=staged;lines=structuredClone(next ?? []);membershipDirty=true;
    if(records.length && !membershipSubscription) membershipSubscription=canvas.reprCount?.subscribe(()=>{membershipDirty=true;});
    if(!records.length) {membershipSubscription?.unsubscribe();membershipSubscription=undefined;blockers=emptyObjects;}
    for(const r of records) for(const repr of [r.repr,r.label,r.leader]) {
      for(const object of repr.renderObjects) owned.add(object);canvas.add(repr);
    }
    tick();canvas.requestDraw();
  };
  return {
    install(next) {const p=serial.then(()=>install(next));serial=p.catch(()=>{});return p;},
    definition:()=>structuredClone(lines),count:()=>records.length,tick,
    // Every distance owns a line, numeric plate and midpoint leader.
    representationCount:()=>records.length*3,
    drawn:objects=>records.every(({repr,label,leader})=>[repr,label,leader].every(r=>r.renderObjects.length && r.renderObjects.every(o=>objects.has(o))
      && r.renderObjects.some(o=>o.values.drawCount.ref.value>0))),
  };
}
