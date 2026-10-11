import {afterEach,expect,it,vi} from 'vitest';
// @ts-ignore Shared browser helper is exercised without a headset runtime.
import {nextViewerPose} from '../../lab/browser-roundtrip/xr-viewer-pose.mjs';
afterEach(()=>vi.useRealTimers());
function headset(){
  let callback:any;
  const session=Object.assign(new EventTarget(),{requestAnimationFrame:vi.fn(fn=>{callback=fn;return 7;}),cancelAnimationFrame:vi.fn()});
  return {session,frame:(pose:any)=>callback(0,{getViewerPose:()=>pose})};
}
it('waits past transient missing tracking and copies a later valid pose',async()=>{
  vi.useFakeTimers();const h=headset();
  const waiting=nextViewerPose(h.session,{});
  h.frame(null);await vi.advanceTimersByTimeAsync(500);h.frame(null);
  const position={x:1,y:2,z:3},matrix=Array(16).fill(0);h.frame({transform:{position,matrix}});
  expect(await waiting).toEqual({position,matrix});
  position.x=9;expect((await waiting).position.x).toBe(1);
  expect(h.session.requestAnimationFrame).toHaveBeenCalledTimes(3);
});
it('cancels a pending pose frame on timeout and ignores a late callback',async()=>{
  vi.useFakeTimers();const h=headset();
  const waiting=nextViewerPose(h.session,{},100);
  const rejected=expect(waiting).rejects.toThrow('Timed out');
  await vi.advanceTimersByTimeAsync(100);await rejected;
  expect(h.session.cancelAnimationFrame).toHaveBeenCalledWith(7);
  h.frame(null);expect(h.session.requestAnimationFrame).toHaveBeenCalledOnce();
});
it('settles immediately when the session ends',async()=>{
  const h=headset(),waiting=nextViewerPose(h.session,{});
  h.session.dispatchEvent(new Event('end'));
  await expect(waiting).rejects.toThrow('ended');
  expect(h.session.cancelAnimationFrame).toHaveBeenCalledOnce();
});

it('does not wait for a delayed end event after an ended session returns zero',async()=>{
  const session=Object.assign(new EventTarget(),{requestAnimationFrame:vi.fn(()=>0),cancelAnimationFrame:vi.fn()});
  await expect(nextViewerPose(session,{},10_000)).rejects.toThrow('ended');
  expect(session.requestAnimationFrame).toHaveBeenCalledOnce();
});
