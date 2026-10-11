/**
 * What the headset in front of us can actually do.
 *
 * The immersive code used to assume a Quest with two Touch controllers: a
 * fixed left grip for push-to-talk, no reading of `profiles`, no reading of
 * `targetRayMode`. On Vision Pro no squeeze event ever fires, and on Quest
 * hand tracking there is no grip to hold, so the grip binding is silently
 * unreachable — no error, it just never engages.
 *
 * These are pure descriptions, not policy. Nothing here binds an event or
 * touches the session's render state. Callers (the talk orb, push-to-talk,
 * the spatial toolbar) read a description and choose their own gesture.
 *
 * Every exported function is callable in Node against a plain object fake:
 * an input source is anything with `handedness`, `targetRayMode`, `profiles`
 * and optionally `hand`.
 */

/**
 * Profile prefixes whose registry entry carries a `squeeze` component, so a
 * runtime reporting one is expected to emit `squeezestart` / `squeezeend`.
 * Matching is on the whole profile name or on a `<prefix>-` segment boundary,
 * so `generic-trigger` never matches `generic-trigger-squeeze`.
 */
export const SQUEEZE_PROFILE_PREFIXES = Object.freeze([
  'oculus-touch',
  'meta-quest-touch',
  'generic-trigger-squeeze',
  'generic-hand-select-grasp',
  'htc-vive',
  'valve-index',
  'microsoft-mixed-reality',
  'samsung-odyssey',
  'pico-4',
  'pico-neo3',
  'magicleap-one',
]);

/** Target ray modes that never carry a persistent tracked source. */
export const TRANSIENT_RAY_MODE = 'transient-pointer';

const DEVICE_CLASSES = Object.freeze(['quest2', 'quest3', 'quest-pro', 'vision-pro', 'hand-only', 'unknown']);

function profileNames(profiles) {
  if (!profiles || typeof profiles === 'string') return typeof profiles === 'string' ? [profiles.toLowerCase()] : [];
  if (typeof profiles[Symbol.iterator] !== 'function') return [];
  return [...profiles].filter(name => typeof name === 'string').map(name => name.trim().toLowerCase()).filter(Boolean);
}

/** True when any listed profile is registered with a squeeze component. */
export function hasSqueezeProfile(profiles) {
  return profileNames(profiles).some(name =>
    SQUEEZE_PROFILE_PREFIXES.some(prefix => name === prefix || name.startsWith(`${prefix}-`)));
}

/**
 * Describe one input source. Accepts a real `XRInputSource`, a plain fake, or
 * a descriptor this function already produced, so a description can be passed
 * back in without losing `isHand`.
 *
 * @returns {{handedness:string,targetRayMode:string,profiles:readonly string[],hasSqueeze:boolean,isHand:boolean,isTransient:boolean}|null}
 */
export function describeInputSource(source) {
  if (!source || typeof source !== 'object') return null;
  const profiles = Object.freeze(profileNames(source.profiles));
  const targetRayMode = typeof source.targetRayMode === 'string' ? source.targetRayMode : 'gaze';
  return Object.freeze({
    handedness: typeof source.handedness === 'string' ? source.handedness : 'none',
    targetRayMode,
    profiles,
    hasSqueeze: hasSqueezeProfile(profiles),
    isHand: Boolean(source.hand) || source.isHand === true,
    isTransient: targetRayMode === TRANSIENT_RAY_MODE,
  });
}

/** Describe every source a live session currently reports. Never throws. */
export function describeInputSources(session) {
  let sources;
  try { sources = session?.inputSources; }
  catch { return []; }
  if (!sources || typeof sources[Symbol.iterator] !== 'function') return [];
  try { return [...sources].map(describeInputSource).filter(Boolean); }
  catch { return []; }
}

/**
 * Follow a session's input sources.
 *
 * `onChange` is called once immediately with the current description, then on
 * every `inputsourceschange`, and never after the session ends. A session
 * without `addEventListener` still gets a live `current()`; it simply cannot
 * be followed.
 *
 * @returns {{current:()=>ReadonlyArray<object>, dispose:()=>void}}
 */
export function watchInputCapabilities(session, onChange = () => {}) {
  const notify = typeof onChange === 'function' ? onChange : () => {};
  let disposed = false;
  let latest = describeInputSources(session);
  const emit = () => {
    if (disposed) return;
    latest = describeInputSources(session);
    // A capability consumer failing must not detach the session's own
    // listeners or break the next change notification.
    try { notify(latest); } catch { /* Capability consumers own their errors. */ }
  };
  const onSourcesChange = () => emit();
  const onEnd = () => dispose();
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [type, handler] of [['inputsourceschange', onSourcesChange], ['end', onEnd]]) {
      try { session?.removeEventListener?.(type, handler); } catch { /* The UA may have detached the session. */ }
    }
  }
  if (typeof session?.addEventListener === 'function') {
    session.addEventListener('inputsourceschange', onSourcesChange);
    session.addEventListener('end', onEnd, { once: true });
  }
  emit();
  return { current: () => latest, dispose };
}

/**
 * Classify the headset from its user agent plus whatever its input sources
 * report. Quest Browser puts the model in the UA; visionOS Safari does not
 * identify itself at all, so Vision Pro is recognised by its transient
 * pointer, which no other runtime emits.
 *
 * @param {{userAgent?:string}|null|undefined} navigatorLike
 * @param {Iterable<string|object>} [profiles] profile names, input sources, or descriptions
 * @returns {'quest2'|'quest3'|'quest-pro'|'vision-pro'|'hand-only'|'unknown'}
 */
export function deviceClass(navigatorLike, profiles = []) {
  const descriptors = normalizeDescriptors(profiles);
  const names = descriptors.flatMap(descriptor => descriptor.profiles);
  if (descriptors.some(descriptor => descriptor.isTransient) || names.includes('apple-vision-pro')) return 'vision-pro';
  let agent = '';
  try { agent = typeof navigatorLike?.userAgent === 'string' ? navigatorLike.userAgent : ''; }
  catch { agent = ''; }
  if (/quest\s*pro/iu.test(agent)) return 'quest-pro';
  if (/quest\s*3/iu.test(agent)) return 'quest3';
  if (/quest\s*2/iu.test(agent)) return 'quest2';
  // Model-specific controller profiles are a fallback when the UA is silent.
  // `oculus-touch-v3` is shared by Quest 2, Quest 3 and Quest Pro, so it
  // cannot identify a Quest 2 and impose that model's measured limits.
  if (names.some(name => name.startsWith('meta-quest-touch-pro'))) return 'quest-pro';
  if (names.some(name => name.startsWith('meta-quest-touch-plus'))) return 'quest3';
  if (descriptors.length > 0 && descriptors.every(descriptor => descriptor.isHand)) return 'hand-only';
  return 'unknown';
}

/** The classes this module can return, in the order they are tried. */
export function deviceClasses() { return DEVICE_CLASSES; }

function normalizeDescriptors(input) {
  if (!input) return [];
  const list = typeof input === 'string' ? [input]
    : typeof input?.[Symbol.iterator] === 'function' ? [...input] : [input];
  const loose = list.filter(entry => typeof entry === 'string');
  const described = list.filter(entry => entry && typeof entry === 'object').map(describeInputSource).filter(Boolean);
  if (!loose.length) return described;
  // Bare profile names carry no handedness or ray mode, so they become one
  // synthetic tracked-pointer source rather than being dropped.
  return [...described, describeInputSource({ handedness: 'none', targetRayMode: 'tracked-pointer', profiles: loose })];
}

/**
 * Which gesture a hold-to-talk control should bind on this device.
 *
 * `squeeze` is chosen only for a persistent controller that the profile
 * registry says has a grip. Hands and transient pointers fall back to
 * `select`, which every runtime emits — a Quest pinch and a Vision Pro tap
 * both arrive as `select`.
 *
 * @param {Iterable<object>} descriptors from `describeInputSources`
 * @param {{handedness?:string, navigator?:object}} [options] preferred hand, and the navigator to classify
 * @returns {{gesture:'squeeze'|'select', handedness:string|null, deviceClass:string, hasHands:boolean, reason:string}}
 */
export function talkInputPlan(descriptors, { handedness = 'left', navigator: navigatorLike } = {}) {
  const sources = normalizeDescriptors(descriptors);
  const device = deviceClass(navigatorLike ?? (typeof navigator === 'undefined' ? undefined : navigator), sources);
  const hasHands = sources.some(source => source.isHand);
  const grips = sources.filter(source => source.hasSqueeze && !source.isHand && !source.isTransient);
  const preferred = grips.find(source => source.handedness === handedness) ?? grips[0];
  if (preferred) {
    return { gesture: 'squeeze', handedness: preferred.handedness, deviceClass: device, hasHands,
      reason: preferred.handedness === handedness ? 'preferred-grip' : 'other-grip' };
  }
  return { gesture: 'select', handedness: null, deviceClass: device, hasHands,
    reason: sources.length === 0 ? 'no-input-sources'
      : sources.some(source => source.isTransient) ? 'transient-pointer-only'
      : hasHands ? 'hands-only' : 'no-squeeze-profile' };
}
