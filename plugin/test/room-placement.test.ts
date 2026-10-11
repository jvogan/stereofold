import {expect,it} from 'vitest';
// @ts-ignore Shared XR room placement implementation.
import {roomPlacement} from '../../lab/browser-roundtrip/room-placement.mjs';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const base={headInRoom:[...identity.slice(0,12),0,1.6,0,1],renderFromRoom:identity,cameraScale:.01,center:[0,0,0],radius:100};
it('places a four-meter object three meters higher and 65 degrees forward of the wearer',()=>{
 const placed=roomPlacement({...base,target:'overhead'});
 expect(placed.translation[0]).toBe(0);expect(placed.translation[1]).toBeCloseTo(4.6);expect(placed.translation[2]).toBeLessThan(0);
 expect(Math.atan2(placed.translation[1]-1.6,-placed.translation[2])*180/Math.PI).toBeCloseTo(65);
 expect(2*base.radius*base.cameraScale*placed.scale).toBeCloseTo(4);
});
it('uses horizontal head direction for front placement without tilting room gravity',()=>{
 const yaw=[0,0,-1,0,0,1,0,0,1,0,0,0,0,1.6,0,1];
 expect(roomPlacement({...base,headInRoom:yaw,target:'front'}).translation).toEqual([-2,1.6,0]);
 expect(roomPlacement({...base,headInRoom:yaw,target:'overhead'}).translation[1]).toBeCloseTo(4.6);
});
it('transforms through the current room-to-render frame before unscaling coordinates',()=>{
 const rotated=[0,1,0,0,-1,0,0,0,0,0,1,0,2,0,0,1];
 const placed=roomPlacement({...base,renderFromRoom:rotated,center:[100,0,0],target:'overhead'});
 expect(placed.translation[0]).toBeCloseTo(-3.6);expect(placed.translation[1]).toBeCloseTo(0);
});
it('places small-source structures at the requested physical size without the old scale or travel cap',()=>{
 const placed=roomPlacement({...base,cameraScale:.0001,target:'overhead'});
 expect(placed.scale).toBeCloseTo(200);
 expect(placed.translation[1]).toBeCloseTo(460);
 expect(2*base.radius*.0001*placed.scale).toBeCloseTo(4);
});
it('rejects unavailable tracking and numerical overflow rather than silently changing the destination',()=>{
 expect(()=>roomPlacement({...base,cameraScale:NaN,target:'front'})).toThrow();
 expect(()=>roomPlacement({...base,cameraScale:1e-12,target:'overhead'})).toThrow(/range/);
 expect(()=>roomPlacement({...base,headInRoom:[...identity.slice(0,8),0,1,0,0,0,0,0,1],target:'front'})).toThrow(/Look ahead/);
});
