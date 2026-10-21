import { evaluateTrack } from '../../packages/motion/src/keyframes.mjs';
/** Match the renderer's union of residue/component selectors within author chains. */
const noTracks=[];
export function measurementTrack(endpoint, definition) {
  for(const track of definition?.tracks ?? noTracks) {
    if(!track.chains.includes(endpoint.authorChain)) continue;
    const selector=track.selector;
    if(!selector) return track;
    if(endpoint.authorResidue!=null) for(const range of selector.residues ?? noTracks)
      if(endpoint.authorResidue>=range.from && endpoint.authorResidue<=range.to) return track;
    if(endpoint.componentId!=null && selector.componentIds?.includes(endpoint.componentId)) return track;
  }
}
/** Assembly-space Å with the same absolute quaternion/translation convention as the chapter renderer. */
export function measurementPosition(endpoint, definition, seconds, out = [0,0,0], pose) {
  const track=measurementTrack(endpoint, definition),p=endpoint.position;
  if(!track) {out[0]=p[0];out[1]=p[1];out[2]=p[2];return out;}
  const {rotation:q,translation:t}=evaluateTrack(track,seconds,pose);
  const [x,y,z]=p,[qx,qy,qz,qw]=q;
  const ux=qy*z-qz*y,uy=qz*x-qx*z,uz=qx*y-qy*x;
  out[0]=x+2*(qw*ux+qy*uz-qz*uy)+t[0];
  out[1]=y+2*(qw*uy+qz*ux-qx*uz)+t[1];
  out[2]=z+2*(qw*uz+qx*uy-qy*ux)+t[2];
  return out;
}
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function measurementValues(p) {
  const result={distanceAngstrom:Math.hypot(...sub(p[1],p[0]))};
  if(p.length>=3) {
    const a=sub(p[0],p[1]),b=sub(p[2],p[1]),n=Math.hypot(...a)*Math.hypot(...b);
    if(n<1e-12) throw Error('An angle needs noncoincident adjacent atoms.');
    result.angleDegrees=Math.acos(Math.max(-1,Math.min(1,dot(a,b)/n)))*180/Math.PI;
  }
  if(p.length===4) {
    const b=sub(p[2],p[1]),n=Math.hypot(...b),axis=b.map(v=>v/n);
    const a=sub(p[0],p[1]),c=sub(p[3],p[2]);
    const v=a.map((x,i)=>x-dot(a,axis)*axis[i]),w=c.map((x,i)=>x-dot(c,axis)*axis[i]);
    if(Math.hypot(...v)*Math.hypot(...w)<1e-12) throw Error('A dihedral needs noncollinear adjacent bonds.');
    result.dihedralDegrees=Math.atan2(dot(cross(axis,v),w),dot(v,w))*180/Math.PI;
  }
  return result;
}
