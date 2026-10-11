import {expect, it, vi} from 'vitest';
// @ts-ignore Shared browser helper is exercised without a headset runtime.
import {describeInputSource, describeInputSources, deviceClass, hasSqueezeProfile, talkInputPlan, watchInputCapabilities} from '../../lab/browser-roundtrip/input-capabilities.mjs';
// @ts-ignore Shared render policy verifies the consequences of classification.
import {isosurfaceForBudget, renderBudget} from '../../lab/browser-roundtrip/xr-render-budget.mjs';

const QUEST_2_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/39.2.0.0.56.754450099 Chrome/146.0.0.0 VR Safari/537.36';
const QUEST_3_AGENT = QUEST_2_AGENT.replace('Quest 2', 'Quest 3S');
const QUEST_PRO_AGENT = QUEST_2_AGENT.replace('Quest 2', 'Quest Pro');
// visionOS Safari identifies itself as desktop Safari, so the user agent
// carries no headset signal at all.
const VISION_PRO_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const touch = (handedness: string) => ({handedness, targetRayMode: 'tracked-pointer',
  profiles: ['oculus-touch-v3', 'oculus-touch', 'generic-trigger-squeeze-thumbstick']});
const hand = (handedness: string) => ({handedness, targetRayMode: 'tracked-pointer',
  profiles: ['generic-hand-select-grasp', 'generic-hand'], hand: new Map([['wrist', {}]])});
const transient = () => ({handedness: 'none', targetRayMode: 'transient-pointer', profiles: ['generic-touchscreen']});

function fakeSession(sources: unknown[] = []) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    inputSources: [...sources],
    addEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(handler);
    }),
    removeEventListener: vi.fn((type: string, handler: (event: unknown) => void) => {
      listeners.get(type)?.delete(handler);
    }),
    emit(type: string, event: unknown = {}) { for (const handler of [...(listeners.get(type) ?? [])]) handler(event); },
    listenerCount(type: string) { return listeners.get(type)?.size ?? 0; },
  };
}

it('describes a Quest controller pair with squeeze and a hand without a grip', () => {
  const described = describeInputSources(fakeSession([touch('left'), hand('right')]));
  expect(described).toHaveLength(2);
  expect(described[0]).toMatchObject({handedness: 'left', targetRayMode: 'tracked-pointer', hasSqueeze: true,
    isHand: false, isTransient: false});
  expect(described[0].profiles).toContain('oculus-touch-v3');
  expect(described[1]).toMatchObject({handedness: 'right', isHand: true});
});

it('reads squeeze from the profile registry rather than from handedness', () => {
  expect(hasSqueezeProfile(['generic-trigger-squeeze-touchpad'])).toBe(true);
  expect(hasSqueezeProfile(['oculus-touch'])).toBe(true);
  expect(hasSqueezeProfile(['meta-quest-touch-plus', 'oculus-touch-v3'])).toBe(true);
  // `generic-trigger` has no squeeze component; a prefix match must not claim one.
  expect(hasSqueezeProfile(['generic-trigger', 'generic-touchscreen'])).toBe(false);
  expect(hasSqueezeProfile([])).toBe(false);
  expect(hasSqueezeProfile(undefined)).toBe(false);
});

it('normalises a missing or malformed source instead of throwing', () => {
  expect(describeInputSource(null)).toBeNull();
  expect(describeInputSource({})).toMatchObject({handedness: 'none', targetRayMode: 'gaze', hasSqueeze: false, isHand: false});
  expect(describeInputSources(undefined)).toEqual([]);
  expect(describeInputSources({get inputSources() { throw Error('detached'); }})).toEqual([]);
});

it('re-describes its own description without losing that a source is a hand', () => {
  const once = describeInputSource(hand('left'));
  expect(describeInputSource(once)).toMatchObject({isHand: true, handedness: 'left', hasSqueeze: true});
});

it('delivers the current sources immediately, then on every change, and stops at session end', () => {
  const session = fakeSession([touch('left')]);
  const seen: unknown[][] = [];
  const watch = watchInputCapabilities(session, (sources: unknown[]) => { seen.push(sources); });
  expect(seen).toHaveLength(1);
  expect(watch.current()).toHaveLength(1);
  session.inputSources = [touch('left'), hand('right')];
  session.emit('inputsourceschange', {added: [hand('right')], removed: []});
  expect(seen).toHaveLength(2);
  expect(watch.current()).toHaveLength(2);
  session.emit('end');
  expect(session.listenerCount('inputsourceschange')).toBe(0);
  session.inputSources = [];
  session.emit('inputsourceschange', {});
  expect(seen).toHaveLength(2);
});

it('keeps following the session when a capability consumer throws', () => {
  const session = fakeSession([touch('left')]);
  const watch = watchInputCapabilities(session, () => { throw Error('consumer failed'); });
  session.inputSources = [];
  expect(() => session.emit('inputsourceschange', {})).not.toThrow();
  expect(watch.current()).toEqual([]);
  watch.dispose();
  expect(session.listenerCount('inputsourceschange')).toBe(0);
});

it('still reports current sources for a session that cannot be listened to', () => {
  const watch = watchInputCapabilities({inputSources: [touch('right')]}, () => {});
  expect(watch.current()).toHaveLength(1);
  expect(() => watch.dispose()).not.toThrow();
});

it('classifies each headset from its user agent', () => {
  expect(deviceClass({userAgent: QUEST_2_AGENT}, [touch('left')])).toBe('quest2');
  expect(deviceClass({userAgent: QUEST_3_AGENT}, [touch('left')])).toBe('quest3');
  expect(deviceClass({userAgent: QUEST_PRO_AGENT}, [touch('left')])).toBe('quest-pro');
});

it('keeps an identifying Quest user agent ahead of controller-profile fallbacks', () => {
  expect(deviceClass({userAgent: QUEST_2_AGENT}, ['meta-quest-touch-plus', 'oculus-touch-v3'])).toBe('quest2');
  expect(deviceClass({userAgent: QUEST_3_AGENT}, ['meta-quest-touch-pro', 'oculus-touch-v3'])).toBe('quest3');
  expect(deviceClass({userAgent: QUEST_PRO_AGENT}, ['meta-quest-touch-plus', 'oculus-touch-v3'])).toBe('quest-pro');
});

it('recognises Vision Pro by its transient pointer, not by its desktop user agent', () => {
  expect(deviceClass({userAgent: VISION_PRO_AGENT}, [transient()])).toBe('vision-pro');
  expect(deviceClass({userAgent: VISION_PRO_AGENT}, ['apple-vision-pro'])).toBe('vision-pro');
});

it('falls back to controller profiles and to hands when the user agent is silent', () => {
  expect(deviceClass({}, ['meta-quest-touch-pro', 'oculus-touch-v3'])).toBe('quest-pro');
  expect(deviceClass({}, ['meta-quest-touch-plus', 'oculus-touch-v3'])).toBe('quest3');
  expect(deviceClass({}, ['oculus-touch-v3'])).toBe('unknown');
  expect(deviceClass({}, [hand('left'), hand('right')])).toBe('hand-only');
  expect(deviceClass(undefined, [])).toBe('unknown');
  expect(deviceClass(null, [{handedness: 'right', targetRayMode: 'gaze', profiles: []}])).toBe('unknown');
});

it('leaves shared Touch controllers unidentified when no model is reported', () => {
  const sources = describeInputSources(fakeSession([touch('left'), touch('right')]));
  for (const navigator of [undefined, {}, {userAgent: VISION_PRO_AGENT}, {get userAgent() { throw Error('unavailable'); }}]) {
    expect(deviceClass(navigator, sources)).toBe('unknown');
  }
  // Device identity and grip capability are independent: talking still works.
  expect(talkInputPlan(sources, {navigator: {}})).toMatchObject({
    deviceClass: 'unknown', gesture: 'squeeze', handedness: 'left', reason: 'preferred-grip',
  });
});

it('applies Quest 2 rendering limits only when the reported model identifies it', () => {
  const sources = describeInputSources(fakeSession([touch('left'), touch('right')]));
  const unidentified = deviceClass({}, sources);
  const identified = deviceClass({userAgent: QUEST_2_AGENT}, sources);
  expect(renderBudget({device: unidentified, atomSites: 177_268, triangles: 500_001})).toMatchObject({
    framebufferScale: 1, targetFrameRate: null, representationQuality: null,
  });
  expect(isosurfaceForBudget({deviceClass: unidentified, triangles: 500_001})).toBe('allow');
  expect(renderBudget({device: identified, atomSites: 177_268, triangles: 500_001})).toMatchObject({
    framebufferScale: 0.5, targetFrameRate: 72, representationQuality: 'low',
  });
  expect(isosurfaceForBudget({deviceClass: identified, triangles: 500_001})).toBe('refuse');
});

it('binds hold-to-talk to a controller grip when one is present', () => {
  const plan = talkInputPlan(describeInputSources(fakeSession([touch('left'), touch('right')])),
    {navigator: {userAgent: QUEST_2_AGENT}});
  expect(plan).toMatchObject({gesture: 'squeeze', handedness: 'left', deviceClass: 'quest2', hasHands: false, reason: 'preferred-grip'});
});

it('uses the remaining grip when the preferred hand has no controller', () => {
  const plan = talkInputPlan([touch('right')], {handedness: 'left', navigator: {userAgent: QUEST_2_AGENT}});
  expect(plan).toMatchObject({gesture: 'squeeze', handedness: 'right', reason: 'other-grip'});
});

it('falls back to select on hands, on Vision Pro, and with no input at all', () => {
  expect(talkInputPlan([hand('left'), hand('right')], {navigator: {userAgent: QUEST_2_AGENT}}))
    .toMatchObject({gesture: 'select', handedness: null, deviceClass: 'quest2', hasHands: true, reason: 'hands-only'});
  expect(talkInputPlan([transient()], {navigator: {userAgent: VISION_PRO_AGENT}}))
    .toMatchObject({gesture: 'select', deviceClass: 'vision-pro', reason: 'transient-pointer-only'});
  expect(talkInputPlan([], {navigator: {userAgent: QUEST_2_AGENT}}))
    .toMatchObject({gesture: 'select', deviceClass: 'quest2', reason: 'no-input-sources'});
});
