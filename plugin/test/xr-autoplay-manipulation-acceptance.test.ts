import { describe, expect, it } from 'vitest';
import { assertUntouchedMenuPose } from '../scripts/xr-autoplay-manipulation-acceptance.js';

const menu = () => {
  const plane = { right: [.8,-.6,0], up: [.6,.8,0], normal: [0,0,1] };
  return { anchor: [1,2,3], plane, geometry: { plates: ['controls','caption','status'].map(kind=>({
    kind,point:[1,2,3],halfHeight:1,halfWidth:2,...structuredClone(plane),
  })) } };
};
describe('untouched menu physical attachment acceptance',()=>{
  it('allows caption text to shrink toward its fixed lower edge on a turned plane',()=>{
    const before=menu(),after=structuredClone(before),caption=after.geometry.plates[1];
    caption.halfHeight=.5;caption.point=caption.point.map((value,axis)=>value-.5*caption.up[axis]);
    expect(()=>assertUntouchedMenuPose(after,before,'reflow')).not.toThrow();
  });
  it.each(['controls','caption','status'])('rejects a translated %s surface even when its anchor did not move',kind=>{
    const before=menu(),after=structuredClone(before);
    after.geometry.plates.find(plate=>plate.kind===kind)!.point[0]+=.01;
    expect(()=>assertUntouchedMenuPose(after,before,'chapter')).toThrow(`${kind} attachment moved`);
  });
  it('rejects a turned card or menu independently of translation',()=>{
    const before=menu(),after=structuredClone(before);
    after.geometry.plates[1].normal=[.1,0,.995];
    expect(()=>assertUntouchedMenuPose(after,before,'chapter')).toThrow('caption normal turned');
    const rotated=structuredClone(before);rotated.plane.right=[.7,-.7,0];
    expect(()=>assertUntouchedMenuPose(rotated,before,'chapter')).toThrow('menu right turned');
  });
});
