import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { createMeasurementGeometryBounds, MEASUREMENT_GEOMETRY_LIMIT } from './measurement-geometry-bounds.mjs';

const identity = Mat4.identity();
const empty = [];
// A quarter Angstrom of endpoint/blocker travel, 0.5 mm of eye translation,
// or ~0.03 degrees of view rotation invalidates a seat. The clearance margin
// is deliberately much larger; comparisons use the last SOLVED pose.
const travel = .25, viewTolerance = .0005;
function changed(a,b,tolerance) {
  for(let i=0;i<a.length;i++) if(Math.abs(a[i]-b[i])>tolerance) return true;
  return false;
}
function movedTransform(a,b) {
  for(let i=0;i<16;i++) if(Math.abs(a[i]-b[i])>(i>=12 && i<15?travel:.0005)) return true;
  return false;
}
function eye(out,p,m,s) {
  const x=p[0]*s,y=p[1]*s,z=p[2]*s;
  out[0]=m[0]*x+m[4]*y+m[8]*z+m[12];
  out[1]=m[1]*x+m[5]*y+m[9]*z+m[13];
  out[2]=m[2]*x+m[6]*y+m[10]*z+m[14];
}
/** Persistent per-measurement workspace. Cached boxes and interval storage are
 * reused; stationary ticks neither project blockers nor allocate scratch.
 * Membership/visibility, plate uniforms, moving blockers, and either XR eye
 * invalidate the seat, even when the endpoints themselves are stationary.
 */
export function createMeasurementClearance() {
  const entries=new Map(), views=[Mat4(),Mat4()], savedA=Vec3(),savedB=Vec3();
  const eyeProjections=[Mat4(),Mat4()],hasEyeProjection=[false,false];
  const ea=Vec3(),eb=Vec3(),em=Vec3(),ray=Vec3(),point=Vec3(),direction=Vec3(),corner=Vec3();
  const projection=Mat4(),desktopDirection=Vec3(),bestDirection=Vec3();
  const result={point:Vec3(),midpoint:Vec3(),side:0,offset:0,valid:true};
  let intervals=new Float64Array(128),count=0,epoch=0,ready=false,lastScale,lastWidth,lastHeight,lastPerspective,lastViewCount;
  let desktopRects=new Float64Array(256),rectCount=0,lastDesktop,lastViewportWidth,lastViewportHeight,lastOffsetZ;
  const glassSignature=[];
  let glassRects=new Float64Array(64),glassRectCount=0;
  let molecularRects=new Float64Array(256),molecularRectCount=0;
  const stats={solves:0,boxUpdates:0,refinementBuilds:0,refinementPoints:0,glassProjections:0,alternateSearches:0};
  let lo,hi;
  function constrain(v,c) {
    if(Math.abs(v)<1e-9) {if(c>0) hi=-Infinity;}
    else if(v>0) lo=Math.max(lo,c/v);else hi=Math.min(hi,c/v);
  }
  function escape(side,start,gap) {
    let distance=start;
    for(let pass=0;pass<=count;pass++) {
      const before=distance;
      for(let i=0;i<count;i+=2) {
        const begin=side>0?intervals[i]:-intervals[i+1],end=side>0?intervals[i+1]:-intervals[i];
        if(distance>=begin && distance<=end) distance=end+gap;
      }
      if(distance===before) break;
    }
    return distance;
  }
  function solve(a,b,camera,objects,halfWidth,halfHeight,previousSide=result.side,excluded,offsetZ=0,desktopEnabled=true,glass) {
    const cameraViews=camera?.views, n=cameraViews?.length || 1, scale=camera?.scale || 1;
    const perspective=camera?.state?.mode==='perspective';
    // A tracked eye set keeps the existing binocular clearance contract. Only
    // an actual flat camera has a single projection and finite viewport here.
    const desktop=desktopEnabled && !cameraViews?.length && camera?.projection?.length===16 && camera?.viewport?.width>0 && camera?.viewport?.height>0;
    // Compare values, not array identities: the toolbar returns fresh arrays
    // for its drawn drag offset. A stationary menu must not re-project each
    // frame, while a fold, re-entry, room transform or movement must invalidate.
    const plates=desktop?empty:glass?.plates ?? empty,roomToScene=glass?.roomToScene;
    let signatureIndex=0,glassChanged=false,glassInvalid=false;
    const remember=value=>{if(!Object.is(glassSignature[signatureIndex],value))glassChanged=true;glassSignature[signatureIndex++]=value;};
    remember(plates.length);
    if(plates.length) {
      if(roomToScene?.length!==16) glassInvalid=true;
      for(let i=0;i<16;i++){const value=roomToScene?.[i];remember(value);if(!Number.isFinite(value))glassInvalid=true;}
      for(const plate of plates) {
        remember(plate.length);if(plate.length<3)glassInvalid=true;
        for(const p of plate) {if(p?.length!==3)glassInvalid=true;for(let k=0;k<3;k++){remember(p?.[k]);if(!Number.isFinite(p?.[k]))glassInvalid=true;}}
      }
      remember(offsetZ);
    }
    if(glassSignature.length!==signatureIndex){glassChanged=true;glassSignature.length=signatureIndex;}
    let dirty=!ready || n!==lastViewCount || scale!==lastScale || perspective!==lastPerspective
      || Math.abs(halfWidth-lastWidth)>.05 || Math.abs(halfHeight-lastHeight)>.05
      || changed(a,savedA,travel) || changed(b,savedB,travel) || glassChanged;
    if(desktop!==lastDesktop || (desktop && (changed(camera.projection,projection,0)
      || camera.viewport.width!==lastViewportWidth || camera.viewport.height!==lastViewportHeight
      || offsetZ!==lastOffsetZ || halfWidth!==lastWidth || halfHeight!==lastHeight))) dirty=true;
    for(let i=0;i<n;i++) {
      if(changed(cameraViews?.[i]?.view ?? camera?.view ?? identity,views[i],viewTolerance)) dirty=true;
      if(plates.length){const p=cameraViews?.[i]?.projection,has=p?.length===16;
        if(has!==hasEyeProjection[i] || (has && changed(p,eyeProjections[i],0)))dirty=true;}
    }
    epoch++;
    for(const object of objects ?? empty) {
      if(excluded?.has(object) || object.state?.visible===false || object.state?.alphaFactor===0
        || (object.type==='text' && !object.state?.stereofoldLessonLabel)) continue;
      const v=object.values,s=v?.boundingSphere?.ref.value;
      if(!s || !(s.radius>0)) continue;
      let e=entries.get(object);
      if(!e) {
        e={object,box:new Float64Array(6),localBox:new Float64Array(6),positionVersion:-1,center:Vec3(),matrix:Mat4(),version:-1,epoch, radius:NaN,
          mappingVersion:-1,extent:new Float64Array(4)};entries.set(object,e);dirty=true;
      }
      e.epoch=epoch;
      if(desktop && e.refinementChecked && !e.refinement.matches(object)) dirty=true;
      if(changed(s.center,e.center,travel) || Math.abs(s.radius-e.radius)>travel
        || (v.matrix && movedTransform(v.matrix.ref.value,e.matrix))
        || (object.type==='text' && (e.mappingVersion!==v.aMapping?.ref.version
          || e.size!==v.uSizeFactor?.ref.value || e.ox!==v.uOffsetX?.ref.value || e.oy!==v.uOffsetY?.ref.value || e.oz!==v.uOffsetZ?.ref.value))) dirty=true;
    }
    for(const e of entries.values()) if(e.epoch!==epoch) {entries.delete(e.object);dirty=true;}
    if(!dirty) return result;
    // A desktop/XR handoff or a deliberate large camera turn defines a new
    // perpendicular axis; choose its empty side once, then retain it.
    const resetSide=ready && (n!==lastViewCount || changed(cameraViews?.[0]?.view ?? camera?.view ?? identity,views[0],.5));
    if(resetSide || (ready && glassChanged)) previousSide=0;
    stats.solves++;ready=true;lastScale=scale;lastWidth=halfWidth;lastHeight=halfHeight;lastPerspective=perspective;lastViewCount=n;
    lastDesktop=desktop;
    if(desktop) {Mat4.copy(projection,camera.projection);lastViewportWidth=camera.viewport.width;lastViewportHeight=camera.viewport.height;lastOffsetZ=offsetZ;}
    Vec3.copy(savedA,a);Vec3.copy(savedB,b);
    for(let i=0;i<n;i++) {
      Mat4.copy(views[i],cameraViews?.[i]?.view ?? camera?.view ?? identity);
      hasEyeProjection[i]=plates.length>0 && cameraViews?.[i]?.projection?.length===16;
      if(hasEyeProjection[i])Mat4.copy(eyeProjections[i],cameraViews[i].projection);
    }
    const view=views[0];eye(ea,a,view,scale);eye(eb,b,view,scale);
    Vec3.add(result.midpoint,a,b);Vec3.scale(result.midpoint,result.midpoint,.5);
    const dx=eb[0]-ea[0],dy=eb[1]-ea[1],length=Math.hypot(dx,dy);
    const nx=length>1e-8?-dy/length:0,ny=length>1e-8?dx/length:1;
    for(let i=0;i<3;i++) corner[i]=view[i*4]*nx+view[i*4+1]*ny;
    // Endpoint order can reverse as the heads pass. Keep the perpendicular
    // axis oriented continuously so that a retained side stays the same side.
    const sign=!resetSide && Vec3.dot(corner,direction)<0?-1:1;
    Vec3.scale(direction,corner,sign);
    // Cache render-space boxes once per changed object, shared by both eyes.
    for(const e of entries.values()) {
      e.refinementChecked=false;e.desktopOffset=undefined;
      const object=e.object,v=object.values,s=v.boundingSphere.ref.value,version=v.boundingSphere.ref.version;
      Vec3.copy(e.center,s.center);e.radius=s.radius;if(v.matrix) Mat4.copy(e.matrix,v.matrix.ref.value);
      const textChanged=object.type==='text' && (e.mappingVersion!==v.aMapping?.ref.version
        || e.size!==v.uSizeFactor?.ref.value || e.ox!==v.uOffsetX?.ref.value
        || e.oy!==v.uOffsetY?.ref.value || e.oz!==v.uOffsetZ?.ref.value);
      if(e.version===version && version!==undefined && !textChanged) continue;
      e.version=version;stats.boxUpdates++;
      const box=e.box;box[0]=box[1]=box[2]=Infinity;box[3]=box[4]=box[5]=-Infinity;
      if(object.type==='text' && v.aPosition && v.aTransform && v.aMapping) {
        const positions=v.aPosition.ref.value,transforms=v.aTransform.ref.value,local=e.localBox;
        if(e.positionVersion!==v.aPosition.ref.version) {
          local[0]=local[1]=local[2]=Infinity;local[3]=local[4]=local[5]=-Infinity;
          for(let i=0;i<positions.length;i+=3) for(let k=0;k<3;k++) {
            local[k]=Math.min(local[k],positions[i+k]);local[k+3]=Math.max(local[k+3],positions[i+k]);
          }
          e.positionVersion=v.aPosition.ref.version;
        }
        for(let j=0;j<(v.instanceCount?.ref.value ?? 1);j++) for(let i=0;i<8;i++) {
          for(let k=0;k<3;k++) corner[k]=local[k+((i>>k)&1)*3];
          Vec3.transformMat4Offset(point,corner,transforms,0,0,j*16);
          for(let k=0;k<3;k++) {box[k]=Math.min(box[k],point[k]);box[k+3]=Math.max(box[k+3],point[k]);}
        }
        if(e.mappingVersion!==v.aMapping.ref.version) {
          const mapping=v.aMapping.ref.value,x=e.extent;x[0]=x[1]=Infinity;x[2]=x[3]=-Infinity;
          for(let i=0;i<mapping.length;i+=2) {x[0]=Math.min(x[0],mapping[i]);x[2]=Math.max(x[2],mapping[i]);x[1]=Math.min(x[1],mapping[i+1]);x[3]=Math.max(x[3],mapping[i+1]);}
        }
        e.mappingVersion=v.aMapping.ref.version;e.size=v.uSizeFactor.ref.value;
        e.ox=v.uOffsetX.ref.value;e.oy=v.uOffsetY.ref.value;e.oz=v.uOffsetZ.ref.value;e.text=true;
      } else if(s.extrema?.length && object.type!=='text') {
        for(const p of s.extrema) for(let k=0;k<3;k++) {box[k]=Math.min(box[k],p[k]-2);box[k+3]=Math.max(box[k+3],p[k]+2);}
      } else for(let k=0;k<3;k++) {box[k]=s.center[k]-s.radius;box[k+3]=s.center[k]+s.radius;}
    }
    count=0;
    rectCount=0;
    glassRectCount=0;
    molecularRectCount=0;
    if(intervals.length<(entries.size+plates.length)*n*2) intervals=new Float64Array((entries.size+plates.length)*n*2);
    if(glassRects.length<plates.length*n*5)glassRects=new Float64Array(plates.length*n*5);
    if(plates.length && molecularRects.length<entries.size*n*5)molecularRects=new Float64Array(entries.size*n*5);
    if(desktop && desktopRects.length<entries.size*4) desktopRects=new Float64Array(entries.size*4);
    const gap=Math.max(2*scale,halfHeight*scale*.5);
    for(let i=0;i<n;i++) {
      const matrix=views[i];eye(em,result.midpoint,matrix,scale);
      const depth=Math.max(1e-6,-em[2]);Vec3.transformDirection(ray,direction,matrix);
      for(const e of entries.values()) {
        let left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity,front=false;
        for(let j=0;j<8;j++) {
          for(let k=0;k<3;k++) corner[k]=e.box[k+((j>>k)&1)*3];
          eye(point,corner,matrix,scale);
          if(point[2]<0) front=true;
          // Billboard offsets and glyph dimensions do not rotate with the body.
          const z=e.text?Math.abs(e.oz)*scale:0;
          const gain=perspective?depth/Math.max(1e-6,-point[2]-z):1;
          left=Math.min(left,(point[0]+(e.text?(e.ox+e.extent[0]*e.size)*scale:0))*gain);
          right=Math.max(right,(point[0]+(e.text?(e.ox+e.extent[2]*e.size)*scale:0))*gain);
          bottom=Math.min(bottom,(point[1]+(e.text?(e.oy+e.extent[1]*e.size)*scale:0))*gain);
          top=Math.max(top,(point[1]+(e.text?(e.oy+e.extent[3]*e.size)*scale:0))*gain);
        }
        if(perspective && !front) continue;
        if(desktop && !e.text) {
          // A box combines extrema that need not coexist on the molecule: its
          // near corner can cover an entire narrow viewport. The committed
          // sphere independently encloses the same render object. Intersect
          // those conservative screen bounds without visiting mesh vertices.
          eye(point,e.center,matrix,scale);
          const radius=e.radius*scale,d=-point[2],den=d*d-radius*radius;
          if(!perspective) {
            left=Math.max(left,point[0]-radius);right=Math.min(right,point[0]+radius);
            bottom=Math.max(bottom,point[1]-radius);top=Math.min(top,point[1]+radius);
          } else if(d>radius && den>0) {
            const sx=radius*Math.sqrt(den+point[0]*point[0]),sy=radius*Math.sqrt(den+point[1]*point[1]);
            left=Math.max(left,depth*(point[0]*d-sx)/den);right=Math.min(right,depth*(point[0]*d+sx)/den);
            bottom=Math.max(bottom,depth*(point[1]*d-sy)/den);top=Math.min(top,depth*(point[1]*d+sy)/den);
          }
        }
        if(desktop) {e.desktopOffset=rectCount;desktopRects[rectCount++]=left;desktopRects[rectCount++]=right;desktopRects[rectCount++]=bottom;desktopRects[rectCount++]=top;}
        if(plates.length){const gain=perspective?1/depth:1;
          molecularRects[molecularRectCount++]=i;molecularRects[molecularRectCount++]=left*gain;molecularRects[molecularRectCount++]=right*gain;
          molecularRects[molecularRectCount++]=bottom*gain;molecularRects[molecularRectCount++]=top*gain;}
        const w=halfWidth*scale+gap,h=halfHeight*scale+gap,dz=perspective?ray[2]/depth:0;
        lo=-Infinity;hi=Infinity;
        constrain(ray[0]+left*dz,left-em[0]-w);constrain(-ray[0]-right*dz,em[0]-right-w);
        constrain(ray[1]+bottom*dz,bottom-em[1]-h);constrain(-ray[1]-top*dz,em[1]-top-h);
        if(lo<=hi) {intervals[count++]=lo;intervals[count++]=hi;}
      }
      if(!glassInvalid) for(const plate of plates) {
        let left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity,front=0;
        for(const p of plate) {
          Vec3.transformMat4(corner,p,roomToScene);eye(point,corner,matrix,scale);
          if(perspective && point[2]>=-1e-8)continue;
          front++;const gain=perspective?1/-point[2]:1;
          left=Math.min(left,point[0]*gain);right=Math.max(right,point[0]*gain);
          bottom=Math.min(bottom,point[1]*gain);top=Math.max(top,point[1]*gain);
        }
        stats.glassProjections++;
        if(!front)continue;
        // A plate straddling the eye cannot be given a finite safe rectangle.
        if(front!==plate.length || ![left,right,bottom,top].every(Number.isFinite)){glassInvalid=true;break;}
        glassRects[glassRectCount++]=i;glassRects[glassRectCount++]=left;glassRects[glassRectCount++]=right;
        glassRects[glassRectCount++]=bottom;glassRects[glassRectCount++]=top;
        const gain=perspective?depth:1;left*=gain;right*=gain;bottom*=gain;top*=gain;
        const w=halfWidth*scale+gap,h=halfHeight*scale+gap,dz=perspective?ray[2]/depth:0;
        lo=-Infinity;hi=Infinity;
        constrain(ray[0]+left*dz,left-em[0]-w);constrain(-ray[0]-right*dz,em[0]-right-w);
        constrain(ray[1]+bottom*dz,bottom-em[1]-h);constrain(-ray[1]-top*dz,em[1]-top-h);
        if(lo<=hi){intervals[count++]=lo;intervals[count++]=hi;}
      }
    }
    const start=Math.max(12*scale,2*halfHeight*scale);
    let positive=escape(1,start,gap),negative=escape(-1,start,gap);
    if(desktop) {
      // Text's perspective standoff moves its centre toward the eye along the
      // same ray, retaining its screen centre but enlarging the billboard.
      // Its radial distance is at least its depth: this gain bounds the whole
      // glyph/background plate, including the closest possible standoff.
      const depth=-em[2],z=offsetZ*scale;
      const gain=perspective?depth/(depth-Math.max(0,z)):1;
      // Blocker intervals already include `gap`; a tiny strict separation is
      // enough when escaping them. A second full gap needlessly consumes the
      // remaining space beside a molecule in a narrow desktop canvas.
      const separation=1e-6*scale;
      const w=halfWidth*scale*gain,h=halfHeight*scale*gain;
      const limitX=1-4/lastViewportWidth,limitY=1-4/lastViewportHeight;
      const cx=projection[0]*em[0]+projection[4]*em[1]+projection[8]*em[2]+projection[12];
      const cy=projection[1]*em[0]+projection[5]*em[1]+projection[9]*em[2]+projection[13];
      const cw=projection[3]*em[0]+projection[7]*em[1]+projection[11]*em[2]+projection[15];
      const frustumValid=Number.isFinite(gain) && gain>0 && cw>0 && limitX>0 && limitY>0
        && (!Number.isFinite(camera.near) || depth-Math.max(0,z)>camera.near)
        && (!Number.isFinite(camera.far) || depth-Math.min(0,z)<camera.far);
      function boundedEscapes() {
        lo=-Infinity;hi=Infinity;
        const rx=projection[0]*ray[0]+projection[4]*ray[1]+projection[8]*ray[2];
        const ry=projection[1]*ray[0]+projection[5]*ray[1]+projection[9]*ray[2];
        const rw=projection[3]*ray[0]+projection[7]*ray[1]+projection[11]*ray[2];
        constrain(limitX*rw+rx,Math.abs(projection[0])*w-limitX*cw-cx);
        constrain(limitX*rw-rx,Math.abs(projection[0])*w-limitX*cw+cx);
        constrain(limitY*rw+ry,Math.abs(projection[5])*h-limitY*cw-cy);
        constrain(limitY*rw-ry,Math.abs(projection[5])*h-limitY*cw+cy);
        positive=frustumValid && lo<=hi?escape(1,Math.max(start,lo),separation):Infinity;
        negative=frustumValid && lo<=hi?escape(-1,Math.max(start,-hi),separation):Infinity;
        if(positive>hi) positive=Infinity;
        if(-negative<lo) negative=Infinity;
      }
      boundedEscapes();
      if(!Number.isFinite(positive) && !Number.isFinite(negative) && frustumValid) {
        // A short desktop can have no room on either perpendicular half-ray.
        // Try six additional, fixed camera-plane directions. Reuse projected
        // blockers; do not move the molecule, measured endpoints or camera.
        Vec3.copy(desktopDirection,direction);
        const baseX=ray[0],baseY=ray[1];
        let best=Infinity,bestSide=0;
        for(let pass=0;pass<2;pass++) {
          if(pass===1) {
            if(bestSide) break;
            const budget={remaining:MEASUREMENT_GEOMETRY_LIMIT};
            // Only a coarse no-seat result may inspect supported geometry.
            // Local mesh/impostor data is reduced once to at most 27 cells;
            // camera changes project these cells, not every mesh vertex.
            // Their aggregate rectangle encloses the projected convex
            // primitives between cells; any cell crossing the eye refuses
            // refinement for the entire object and retains the coarse bound.
            for(const e of entries.values()) {
              if(e.text || e.desktopOffset===undefined) continue;
              const refinement=(e.refinement ??= createMeasurementGeometryBounds());
              const builds=refinement.stats.builds,points=refinement.stats.points;
              const boxes=refinement.get(e.object,budget);
              // Stable refusals (e.g. GPU animation) must recover when their
              // inputs change. An unattempted shared-budget refusal has no
              // signature and must not force scans on stationary frames.
              e.refinementChecked=refinement.hasSignature();
              stats.refinementBuilds+=refinement.stats.builds-builds;stats.refinementPoints+=refinement.stats.points-points;
              if(!boxes) continue;
              let left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity,safe=true;
              for(let j=0;j<boxes.length;j+=6) for(let c=0;c<8;c++) {
                for(let k=0;k<3;k++) corner[k]=boxes[j+k+((c>>k)&1)*3];
                eye(point,corner,view,scale);
                if(perspective && point[2]>=-1e-6) {safe=false;break;}
                const gain=perspective?depth/-point[2]:1;
                left=Math.min(left,point[0]*gain);right=Math.max(right,point[0]*gain);
                bottom=Math.min(bottom,point[1]*gain);top=Math.max(top,point[1]*gain);
              }
              if(safe && Number.isFinite(left+right+bottom+top)) {
                const index=e.desktopOffset;
                desktopRects[index]=left;desktopRects[index+1]=right;desktopRects[index+2]=bottom;desktopRects[index+3]=top;
              }
            }
          }
        for(const angle of [0,Math.PI/4,-Math.PI/4,Math.PI/2]) {
          const x=baseX*Math.cos(angle)-baseY*Math.sin(angle),y=baseX*Math.sin(angle)+baseY*Math.cos(angle);
          Vec3.set(ray,x,y,0);
          count=0;
          for(let j=0;j<rectCount;j+=4) {
            const left=desktopRects[j],right=desktopRects[j+1],bottom=desktopRects[j+2],top=desktopRects[j+3];
            const bw=halfWidth*scale+gap,bh=halfHeight*scale+gap;
            lo=-Infinity;hi=Infinity;
            constrain(x,left-em[0]-bw);constrain(-x,em[0]-right-bw);
            constrain(y,bottom-em[1]-bh);constrain(-y,em[1]-top-bh);
            if(lo<=hi) {intervals[count++]=lo;intervals[count++]=hi;}
          }
          boundedEscapes();
          const candidate=Math.min(positive,negative);
          if(candidate<best) {
            best=candidate;bestSide=positive<=negative?1:-1;
            for(let k=0;k<3;k++) bestDirection[k]=view[k*4]*x+view[k*4+1]*y;
          }
        }
        }
        if(bestSide) {Vec3.copy(direction,bestDirection);positive=bestSide>0?best:Infinity;negative=bestSide<0?best:Infinity;previousSide=0;}
        else {Vec3.copy(direction,desktopDirection);positive=negative=Infinity;}
      }
    }
    // The interval broad phase uses the anchor plane. Verify the complete
    // numeric plate at its actual radial shader standoff in BOTH eyes. This
    // also fails closed for near-eye/malformed glass without moving science.
    const clearsGlass=(distance,checkMolecular=false)=>{
      if(glassInvalid || !Number.isFinite(distance))return false;
      Vec3.scaleAndAdd(corner,result.midpoint,direction,distance/scale);
      for(let i=0;i<n;i++) {
        eye(point,corner,views[i],scale);
        const z=offsetZ*scale;
        if(perspective){const length=Vec3.magnitude(point);if(!(length>z && -point[2]>0))return false;Vec3.scale(point,point,1-z/length);}
        else point[2]+=z;
        const gain=perspective?1/-point[2]:1,w=halfWidth*scale,h=halfHeight*scale;
        const left=(point[0]-w)*gain,right=(point[0]+w)*gain,bottom=(point[1]-h)*gain,top=(point[1]+h)*gain;
        for(let j=0;j<glassRectCount;j+=5)if(glassRects[j]===i
          && left<=glassRects[j+2] && right>=glassRects[j+1] && bottom<=glassRects[j+4] && top>=glassRects[j+3])return false;
        if(checkMolecular)for(let j=0;j<molecularRectCount;j+=5)if(molecularRects[j]===i
          && left<=molecularRects[j+2] && right>=molecularRects[j+1] && bottom<=molecularRects[j+4] && top>=molecularRects[j+3])return false;
        // A new menu must not push a readable number beyond either lens.
        // Check the final quad, including radial standoff, and try the other
        // finite escape when this one leaves the tracked projection.
        if(hasEyeProjection[i])for(let k=0;k<4;k++) {
          const p=eyeProjections[i],x=point[0]+(k&1?w:-w),y=point[1]+(k&2?h:-h),z=point[2];
          const cw=p[3]*x+p[7]*y+p[11]*z+p[15],cx=p[0]*x+p[4]*y+p[8]*z+p[12],cy=p[1]*x+p[5]*y+p[9]*z+p[13],cz=p[2]*x+p[6]*y+p[10]*z+p[14];
          if(!(cw>0 && Math.abs(cx)<cw*.99 && Math.abs(cy)<cw*.99 && Math.abs(cz)<cw))return false;
        }
      }
      return true;
    };
    if(plates.length){if(!clearsGlass(positive))positive=Infinity;if(!clearsGlass(-negative))negative=Infinity;}
    if(plates.length && !glassInvalid && !Number.isFinite(positive) && !Number.isFinite(negative)) {
      // A side menu can block both perpendicular escapes while leaving clear
      // space above or beside the molecule. Try six additional camera-plane
      // rays only after that no-seat result. Every ray rebuilds BOTH eyes'
      // molecular and glass intervals from already projected rectangles; no
      // geometry is scanned again and a stationary result remains cached.
      stats.alternateSearches++;
      Vec3.copy(desktopDirection,direction);Vec3.transformDirection(ray,direction,view);
      const baseX=ray[0],baseY=ray[1];let best=Infinity,bestSide=0;
      const addIntervals=(rects,length)=>{
        for(let j=0;j<length;j+=5) {
          const matrix=views[rects[j]];eye(em,result.midpoint,matrix,scale);Vec3.transformDirection(ray,direction,matrix);
          const depth=Math.max(1e-6,-em[2]),gain=perspective?depth:1;
          const left=rects[j+1]*gain,right=rects[j+2]*gain,bottom=rects[j+3]*gain,top=rects[j+4]*gain;
          // Reserve standoff inflation before the exact final-quad proof.
          // Canted eyes still receive their own exact test below.
          const inflate=perspective?depth/(depth-Math.max(0,offsetZ*scale)):1;
          if(!(inflate>0 && Number.isFinite(inflate))){intervals[count++]=-Infinity;intervals[count++]=Infinity;continue;}
          const w=halfWidth*scale*inflate+gap,h=halfHeight*scale*inflate+gap,dz=perspective?ray[2]/depth:0;
          lo=-Infinity;hi=Infinity;
          constrain(ray[0]+left*dz,left-em[0]-w);constrain(-ray[0]-right*dz,em[0]-right-w);
          constrain(ray[1]+bottom*dz,bottom-em[1]-h);constrain(-ray[1]-top*dz,em[1]-top-h);
          if(lo<=hi){intervals[count++]=lo;intervals[count++]=hi;}
        }
      };
      for(const angle of [Math.PI/4,-Math.PI/4,Math.PI/2]) {
        const x=baseX*Math.cos(angle)-baseY*Math.sin(angle),y=baseX*Math.sin(angle)+baseY*Math.cos(angle);
        for(let k=0;k<3;k++)direction[k]=view[k*4]*x+view[k*4+1]*y;
        count=0;addIntervals(molecularRects,molecularRectCount);addIntervals(glassRects,glassRectCount);
        const forward=escape(1,start,gap),backward=escape(-1,start,gap);
        for(const side of [1,-1]) {
          const distance=side>0?forward:backward;
          if(distance<best && clearsGlass(side*distance,true)){best=distance;bestSide=side;Vec3.copy(bestDirection,direction);}
        }
      }
      if(bestSide){Vec3.copy(direction,bestDirection);positive=bestSide>0?best:Infinity;negative=bestSide<0?best:Infinity;previousSide=0;}
      else Vec3.copy(direction,desktopDirection);
    }
    // Retain a side only while its escape is finite. A near-eye blocker can
    // occupy an entire half-ray in one eye while the opposite side stays clear.
    const finitePositive=Number.isFinite(positive/scale),finiteNegative=Number.isFinite(negative/scale);
    result.side=previousSide>0 && finitePositive?1:previousSide<0 && finiteNegative?-1
      :finitePositive && (!finiteNegative || positive<=negative)?1:finiteNegative?-1:0;
    result.offset=result.side?(result.side>0?positive:negative)/scale:0;
    Vec3.scaleAndAdd(result.point,result.midpoint,direction,result.side*result.offset);
    result.valid=result.side!==0 && result.point.every(v=>Number.isFinite(v) && Math.abs(v)<3e38);
    if(!result.valid) { result.side=0;result.offset=0;Vec3.set(result.point,0,0,0); }
    return result;
  }
  return {solve,stats};
}
/** Stateless convenience for callers without a persistent frame loop. */
export function measurementClearance(a,b,camera,objects,halfWidth,halfHeight,previousSide=0) {
  return createMeasurementClearance().solve(a,b,camera,objects,halfWidth,halfHeight,previousSide);
}
