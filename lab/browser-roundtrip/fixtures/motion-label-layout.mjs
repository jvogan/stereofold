import { BoundaryHelper } from 'molstar/lib/mol-math/geometry/boundary-helper.js';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { evaluateTrack } from '../../../packages/motion/src/keyframes.mjs';
import { poseMatrix } from '../molecular-animation.mjs';
import { drawnPlateRects, screenRectFromPoints, plateViewBasis } from '../label-layout.mjs';
import { FIGURE_REFERENCE_SCALE, immersivePlateOffset, immersivePlateStandoff, surfaceAnchorCandidates, facingAnchorIndex } from '../immersive-annotations.mjs';

// CPU reference seats calibrated from the recorded demo scales; optional yaw
// and pitch exercise oblique views as well as the exact front view.
// This checks geometric clearance, not GPU pixels or wearer comfort.
export const demoSeats = {
  'kinesin-walk':{file:'kinesin-walk-motion.cif',scale:.00504,placement:1.738056,distance:6.5,center:[0,45,0]},
  'hemoglobin-switch':{file:'hemoglobin-tr-motion.cif',scale:.02421,placement:1.618259,distance:4.097,center:[10,14,40]},
  'atp-synthase-rotor':{file:'atp-synthase-rotor-motion.cif',scale:.00777,placement:2.017061,distance:3.483,center:[0,53.22,0]},
};
export function sampleTimes(chapter) {
  const a=chapter.animation, samples=new Set([0,a?.durationSeconds ?? 0]);
  for(let t=0;t<(a?.durationSeconds ?? 0);t+=.1) samples.add(t);
  for(const track of a?.tracks ?? []) for(const e of [...track.keyframes,...(track.visibility ?? [])])
    for(const dt of [-.001,0,.001]) if(e.t+dt>=0 && e.t+dt<=a.durationSeconds) samples.add(e.t+dt);
  return [...samples].sort((a,b)=>a-b);
}
export function prepareLabelScene(chapter,atoms) {
  const selected=t=>atoms.filter(a=>a.chain===t.chain && (!t.copyId || a.copyId===t.copyId) && (!t.residues || a.residue>=t.residues.from && a.residue<=t.residues.to)
    && (!t.atomName || a.atom===t.atomName) && (!t.componentId || a.component===t.componentId));
  const sphere=points=>{
    if(!points.length) throw Error('Missing label target');
    const h=new BoundaryHelper('98');for(const p of points) h.includePosition(p);h.finishedIncludeStep();
    for(const p of points) h.radiusPosition(p);return h.getSphere();
  };
  const labels=(chapter.immersive.figure.labels ?? []).map(l=>{
    const points=selected(l.target).map(a=>a.position),bounds=sphere(points);
    return {...l,...bounds,chain:l.target.chain,anchors:surfaceAnchorCandidates(points.flat(),bounds.center,bounds.radius)};
  });
  for(const d of chapter.immersive.figure.distances ?? []) if(d.showText!==false) {
    const a=selected(d.a),b=selected(d.b);
    if(a.length!==1 || b.length!==1) throw Error(`Invalid distance ${d.id}`);
    labels.push({...d,sizeFactor:d.sizeFactor ?? .6,text:`${Vec3.distance(a[0].position,b[0].position).toFixed(2)} Å`,
      center:Vec3.scale(Vec3(),Vec3.add(Vec3(),a[0].position,b[0].position),.5),radius:0,chain:d.a.chain});
  }
  const chains=new Map();
  for(const a of atoms) {if(!chains.has(a.chain)) chains.set(a.chain,[]);chains.get(a.chain).push(a.position);}
  return {chapter,labels,chains,atoms};
}
// How far each drawn plate sits from the atoms of the part it names, in Å at
// that part's depth, and where its lower edge falls against the lattice's.
export function plateGaps(scene,seat,seconds,placement=seat.placement,eyeX=0,lattice=/^T/) {
  const {chapter,atoms}=scene, f=labelFrame(scene,seat,seconds,placement,eyeX), metres=seat.scale*placement;
  const poses=new Map((chapter.animation?.tracks ?? []).flatMap(t=>{const p=evaluateTrack(t,seconds);return t.chains.map(c=>[c,poseMatrix(p)]);}));
  const view={eye:[seat.center[0]+eyeX/metres+Math.sin(seat.yaw ?? 0)*seat.distance/metres,seat.center[1]+Math.sin(seat.pitch ?? 0)*seat.distance/metres,seat.center[2]+Math.cos(seat.yaw ?? 0)*seat.distance/metres],target:[seat.center[0]+eyeX/metres,seat.center[1],seat.center[2]],up:[0,1,0]};
  const basis=plateViewBasis(view);
  const project=(p,c)=>{const q=poses.has(c)?Vec3.transformMat4(Vec3(),p,poses.get(c)):p, r=Vec3.sub(Vec3(),q,view.eye), d=Vec3.dot(r,basis.forward);return [Vec3.dot(r,basis.right)/d,Vec3.dot(r,basis.up)/d,d];};
  const latticeBottom=Math.min(...f.bodies.filter(b=>lattice.test(b.id)).map(b=>b.rect.y-b.rect.halfHeight));
  return f.labels.map(({id,rect})=>{
    const chain=scene.labels.find(l=>l.id===id).chain;
    let gap=Infinity, depth=0, n=0;
    for(const a of atoms) if(a.chain===chain) {
      const [x,y,d]=project(a.position,chain);depth+=d;n++;
      gap=Math.min(gap,Math.hypot(Math.max(rect.x-rect.halfWidth-x,0,x-rect.x-rect.halfWidth),Math.max(rect.y-rect.halfHeight-y,0,y-rect.y-rect.halfHeight)));
    }
    return {id,rect,gap:gap*depth/n,below:rect.y-rect.halfHeight<latticeBottom,latticeBottom};
  });
}
export function labelFrame(scene,seat,seconds,placement=seat.placement,eyeX=0) {
  const {chapter,labels,chains,atoms}=scene;
  const poses=new Map((chapter.animation?.tracks ?? []).flatMap(t=>{const p=evaluateTrack(t,seconds);return t.chains.map(c=>[c,{visible:p.visible,matrix:poseMatrix(p)}]);}));
  const visibility=chapter.immersive.visibility;
  // A lesson names a chain by its letter, or by label chain and copy id where the letter alone is ambiguous.
  const shown=new Set((visibility?.chains ?? []).map(c=>typeof c==='string'?c:c.labelChain));
  const visible=c=>poses.has(c)?poses.get(c).visible:visibility?.op==='only'?shown.has(c):true;
  const transform=(p,c)=>poses.has(c)?Vec3.transformMat4(Vec3(),p,poses.get(c).matrix):p;
  const metres=seat.scale*placement,gain=FIGURE_REFERENCE_SCALE/metres;
  const view={eye:[seat.center[0]+eyeX/metres+Math.sin(seat.yaw ?? 0)*seat.distance/metres,seat.center[1]+Math.sin(seat.pitch ?? 0)*seat.distance/metres,seat.center[2]+Math.cos(seat.yaw ?? 0)*seat.distance/metres],target:[seat.center[0]+eyeX/metres,seat.center[1],seat.center[2]],up:[0,1,0]};
  // What XR draws: a wide selection anchors on the atom facing the eye, its
  // stand-off is capped at 3 Å, and its offset at the label's character-box cap.
  const anchorOf=l=>{
    if(!l.anchors) return transform(l.center,l.chain);
    const inverse=poses.has(l.chain)?Mat4.invert(Mat4(),poses.get(l.chain).matrix):Mat4.identity();
    const local=Vec3.sub(Vec3(),Vec3.transformMat4(Vec3(),view.eye,inverse),l.anchors.center);
    const i=facingAnchorIndex(l.anchors,Vec3.normalize(local,local))*3;
    return transform(Array.from(l.anchors.points.subarray(i,i+3)),l.chain);
  };
  const plates=labels.filter(l=>visible(l.chain)).map(l=>{
    const anchor=anchorOf(l),characterUnits=.8*6*(l.sizeFactor ?? 1)*gain;
    const rects=dx=>drawnPlateRects({plates:[{...l,anchor}],
      placements:[{id:l.id,offsetX:immersivePlateOffset(l.offsetX,gain,characterUnits,l.maxOffsetEm)+dx,offsetY:immersivePlateOffset(l.offsetY,gain,characterUnits,l.maxOffsetEm)}],
      characterUnits,backgroundMargin:.25,maxWidthEm:Infinity,standoff:immersivePlateStandoff(l.radius,1,gain),...view})[0];
    const result=rects(0);result.chain=l.chain;result.anchorRect=screenRectFromPoints({points:[anchor],...view});result.offsetUnit=rects(gain).rect.x-result.rect.x;return result;});
  const bodies=[...chains].filter(([c])=>visible(c)).map(([c,points])=>{
    const rect=screenRectFromPoints({points:points.map(p=>transform(p,c)),...view});
    rect.halfWidth+=2/(view.eye[2]-seat.center[2]);rect.halfHeight+=2/(view.eye[2]-seat.center[2]);return {id:c,rect,chain:c};
  });
  // Include the solid animated neck linkers, not only deposited atom bodies.
  for(const tether of chapter.animation?.tethers ?? []) {
    if(!visible(tether.from.chain) || !visible(tether.to.chain)) continue;
    const points=[tether.from,tether.to].map(end=>{
      const atom=atoms.find(a=>a.chain===end.chain && a.residue===end.residue && a.atom===end.atom);
      if(!atom) throw Error(`Missing tether endpoint ${tether.id}`);
      return transform(atom.position,end.chain);
    });
    const rect=screenRectFromPoints({points,...view});
    const radius=Math.max(1.5,.008/metres)/(view.eye[2]-seat.center[2]);
    rect.halfWidth+=radius;rect.halfHeight+=radius;
    bodies.push({id:tether.id,rect});
  }
  return {labels:plates,bodies};
}
