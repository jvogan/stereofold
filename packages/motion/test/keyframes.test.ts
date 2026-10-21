import { describe, it, expect } from 'vitest';
import { evaluateTrack, createPlaybackClock } from '../src/keyframes.mjs';
const track = { id: 'body', chains: ['C'], keyframes: [
  { t: 0, rotation: [0,0,0,1], translation: [0,0,0] },
  { t: 2, rotation: [0,0,-1,0], translation: [8,4,2] },
], visibility: [{t: .5, visible: false}, {t: 1.5, visible: true}] };
describe('absolute molecular poses', () => {
  it('lerps translations and takes a normalized shortest quaternion arc', () => {
    const p = evaluateTrack(track, 1); expect(p.translation).toEqual([4,2,1]);
    expect(Math.abs(p.rotation[2])).toBeCloseTo(Math.SQRT1_2); expect(p.rotation[3]).toBeCloseTo(Math.SQRT1_2);
    const opposite = {...track, keyframes: [track.keyframes[0], {...track.keyframes[1], rotation: [0,0,0,-1]}]};
    expect(evaluateTrack(opposite, 1).rotation).toEqual([0,0,0,1]);
  });
  it('holds endpoints and resolves visibility backwards without event history', () => {
    expect(evaluateTrack(track, 10).translation).toEqual([8,4,2]);
    expect(evaluateTrack(track, -1).translation).toEqual([0,0,0]);
    expect(evaluateTrack(track, 2).visible).toBe(true);
    expect(evaluateTrack(track, 1).visible).toBe(false);
    expect(evaluateTrack(track, 0).visible).toBe(true);
  });
});
it('integrates irregular timestamps, freezes pause, changes speed without jumps and seeks absolutely', () => {
  const c = createPlaybackClock(2, {autoplay:true}); c.sample(100); c.sample(370);
  expect(c.sample(800).timeSeconds).toBeCloseTo(.7);
  c.patch({state:'pause'}, 1000); expect(c.sample(5000).timeSeconds).toBeCloseTo(.9);
  c.patch({state:'play', speed:2}, 5000); expect(c.sample(5250).timeSeconds).toBeCloseTo(1.4);
  c.patch({seekSeconds: .2, loop:true}, 5250); expect(c.sample(6500).timeSeconds).toBeCloseTo(.7);
  c.patch({loop:false, seekSeconds:1.9}, 6500); expect(c.sample(7000)).toMatchObject({timeSeconds:2,state:'paused'});
  c.patch({state:'play',seekSeconds:0}); c.sample(1); expect(c.sample(101).timeSeconds).toBeCloseTo(.2);
});
it('reanchors a changed scheduler and rejects invalid controls before mutating time', () => {
  const c = createPlaybackClock(2, {autoplay:true}); c.sample(100); c.sample(200); c.reanchor(); c.sample(10000);
  expect(c.snapshot().timeSeconds).toBeCloseTo(.1); expect(c.sample(9999).timeSeconds).toBeCloseTo(.1);
  expect(c.sample(10001).timeSeconds).toBeCloseTo(.101);
  expect(() => c.patch({speed:Infinity}, 11000)).toThrow(); expect(() => c.patch({seekSeconds:3})).toThrow();
});

it('reanchors speed, seeks absolutely and restarts at zero without changing play state', () => {
  const c=createPlaybackClock(20,{autoplay:true});c.sample(1000);c.sample(2000);
  expect(c.patch({speed:0.5},2500).timeSeconds).toBe(1.5);
  expect(c.sample(3500).timeSeconds).toBe(2);
  expect(c.patch({seekSeconds:7},3500).timeSeconds).toBe(7);
  expect(c.patch({seekSeconds:2},3500).timeSeconds).toBe(2);
  expect(c.patch({restart:true},3500)).toMatchObject({timeSeconds:0,state:'playing',speed:0.5});
  expect(c.sample(4500).timeSeconds).toBe(0.5);
  c.patch({state:'pause'},4500);
  expect(c.patch({restart:true,seekSeconds:9},9500)).toMatchObject({timeSeconds:0,state:'paused'});
  expect(c.sample(20000).timeSeconds).toBe(0);
});

it('reuses caller-owned pose and clock storage across frame samples',()=>{
  const pose=evaluateTrack(track,0), translation=pose.translation, rotation=pose.rotation;
  const clock=createPlaybackClock(2,{autoplay:true,loop:true}), sample=clock.snapshot();
  for(let i=0;i<1000;i++) {
    expect(clock.sample(i*13.89,sample)).toBe(sample);
    expect(evaluateTrack(track,sample.timeSeconds,pose)).toBe(pose);
    expect(pose.translation).toBe(translation); expect(pose.rotation).toBe(rotation);
    expect(pose).toEqual(evaluateTrack(track,sample.timeSeconds));
  }
});

it('interpolates hinge rotation before converting to an absolute transform and never accumulates pivot offsets',()=>{
  const hinge={...track,pivot:[10,0,0]}, pose=evaluateTrack(hinge,0), translation=pose.translation;
  // Halfway: -90 degrees about [10,0,0], plus the interpolated [4,2,1].
  evaluateTrack(hinge,1,pose);
  expect(pose.translation[0]).toBeCloseTo(14);
  expect(pose.translation[1]).toBeCloseTo(12);
  expect(pose.translation[2]).toBeCloseTo(1);
  for(let i=0;i<1000;i++)evaluateTrack(hinge,1,pose);
  expect(pose.translation).toBe(translation);
  expect(pose.translation[0]).toBeCloseTo(14);expect(pose.translation[1]).toBeCloseTo(12);
  evaluateTrack(hinge,0,pose);expect(pose.translation).toEqual([0,0,0]);
  evaluateTrack(track,1,pose);expect(pose.translation).toEqual([4,2,1]);
});
