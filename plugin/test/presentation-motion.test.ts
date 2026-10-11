import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ButtonsType } from 'molstar/lib/mol-util/input/input-observer';
// @ts-ignore Import-free presentation-spin policy, shared with the browser XR layer.
import { manipulationButtons, pointerManipulates, presentationDegreesPerSecond, IMMERSIVE_DEGREES_PER_SECOND, NON_MANIPULATION_BUTTONS, PRESENTATION_DEGREES_PER_SECOND } from '../../lab/browser-roundtrip/presentation-motion.mjs';
// @ts-ignore The controller map the exclusion is taken from.
import { FACE_BUTTONS, FACE_LOWER, FACE_UPPER, STICK_PRESS } from '../../lab/browser-roundtrip/xr-buttons.mjs';
// @ts-ignore The spoken grammar, for the two spin replies the wearer hears and reads.
import { attachVoiceCommandRunner, spatialVoiceAction, SPATIAL_VOICE_ACTIONS } from '../../lab/browser-roundtrip/voice-command-runner.mjs';
// @ts-ignore The push-to-talk transcript emitter the runner listens on.
import { createPushToTalkAudioEvents } from '../../lab/browser-roundtrip/push-to-talk-audio.mjs';

const VIEWER = fileURLToPath(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url));
const pointer = (buttons = 0, axes: number[] = [0, 0, 0, 0]) => ({ handedness: 'right', buttons, axes });

describe('what may stop the presentation spin', () => {
  it('excuses exactly the buttons the control map gives to talk and the menu', () => {
    // The exclusion has to track `FACE_BUTTONS`, not a retyped number. If talk
    // ever moves off the lower buttons this fails rather than silently
    // excusing whatever moved in.
    const excused = FACE_BUTTONS
      .filter((binding: any) => binding.action === 'push-to-talk' || binding.action === 'menu')
      .reduce((mask: number, binding: any) => mask | binding.mask, 0);
    expect(NON_MANIPULATION_BUTTONS).toBe(excused);
    expect(NON_MANIPULATION_BUTTONS).toBe(ButtonsType.Flag.Forth | ButtonsType.Flag.Five);
    expect(NON_MANIPULATION_BUTTONS & ButtonsType.Flag.Primary).toBe(0);
    expect(NON_MANIPULATION_BUTTONS & ButtonsType.Flag.Secondary).toBe(0);
    expect(NON_MANIPULATION_BUTTONS & STICK_PRESS).toBe(0);
  });

  it('keeps the grab, the trigger and the stick click as manipulation', () => {
    expect(pointerManipulates(pointer(ButtonsType.Flag.Secondary))).toBe(true);
    expect(pointerManipulates(pointer(ButtonsType.Flag.Primary))).toBe(true);
    expect(pointerManipulates(pointer(STICK_PRESS))).toBe(true);
    expect(pointerManipulates(pointer(0, [0, 0, 0.9, 0]))).toBe(true);
    expect(pointerManipulates(pointer(ButtonsType.Flag.Primary, [0, 0, 0, 0.7]))).toBe(true);
  });

  it('does not treat a talk hold or a menu tap as a hand on the structure', () => {
    expect(pointerManipulates(pointer(FACE_LOWER))).toBe(false);
    expect(pointerManipulates(pointer(FACE_UPPER))).toBe(false);
    expect(manipulationButtons(FACE_LOWER | FACE_UPPER)).toBe(0);
  });
});

/**
 * The viewer's spin loop, with only the parts this suite drives.
 *
 * It mirrors `viewer.mjs`: `xrInputHeld = pointers.some(pointerManipulates)`
 * at :316, the `interactionActive()` branch of `motionReason()` at :800, the
 * angle reset inside `stopPresentationMotion` at :818, and the integration
 * `motionAngle + elapsed * motionDegreesPerSecond() / 1000` at :1548. The wiring
 * test below pins those four lines to the predicate this drives.
 */
function spinLoop({ immersive = true } = {}) {
  let angle = 0, held = false;
  return {
    hold(pointers: unknown[]) {
      const next = pointers.some(pointerManipulates);
      if (next && !held) angle = 0; // stopPresentationMotion resets the transient pose.
      held = next;
    },
    advance(ms: number) { if (!held) angle = (angle + ms * presentationDegreesPerSecond(immersive) / 1000) % 360; },
    angle: () => angle,
    frozen: () => held,
  };
}

describe('a talk hold while the structure is turning', () => {
  it('leaves the yaw advancing through the hold and past the release', () => {
    // The wearer says "spin it", then holds A to say anything else. The press
    // used to stop the turn and snap the angle back to zero, so "keep turning"
    // looked like it had done nothing.
    const spin = spinLoop();
    spin.advance(1000);
    const beforeTalk = spin.angle();
    expect(beforeTalk).toBeGreaterThan(0);

    spin.hold([pointer(FACE_LOWER)]); // A down: push-to-talk.
    expect(spin.frozen()).toBe(false);
    spin.advance(1000);
    const duringTalk = spin.angle();
    expect(duringTalk).toBeGreaterThan(beforeTalk);

    spin.hold([pointer(0)]); // A released.
    spin.advance(1000);
    expect(spin.angle()).toBeGreaterThan(duringTalk);
    expect(spin.angle()).toBeCloseTo(3 * IMMERSIVE_DEGREES_PER_SECOND, 6);
  });

  it('leaves the yaw advancing through a menu tap too', () => {
    const spin = spinLoop();
    spin.advance(500);
    const before = spin.angle();
    spin.hold([pointer(FACE_UPPER)]);
    spin.advance(500);
    spin.hold([pointer(0)]);
    expect(spin.frozen()).toBe(false);
    expect(spin.angle()).toBeGreaterThan(before);
  });

  it('still stops and resets the yaw for a grab or a stick slide', () => {
    for (const manipulating of [pointer(ButtonsType.Flag.Secondary), pointer(0, [0, 0, 0.8, 0])]) {
      const spin = spinLoop();
      spin.advance(1000);
      expect(spin.angle()).toBeGreaterThan(0);
      spin.hold([manipulating]);
      expect(spin.frozen()).toBe(true);
      spin.advance(1000);
      expect(spin.angle()).toBe(0);
    }
  });

  it('freezes when a talk hold and a grab arrive on the two hands at once', () => {
    const spin = spinLoop();
    spin.advance(1000);
    spin.hold([pointer(FACE_LOWER), { handedness: 'left', buttons: ButtonsType.Flag.Secondary, axes: [0, 0, 0, 0] }]);
    expect(spin.frozen()).toBe(true);
  });
});

describe('the spin rate', () => {
  it('turns at 12 deg/s in an immersive session and 4 deg/s outside one', () => {
    // 30 s per revolution in the headset, where the structure is metres across
    // and the wearer asked for it out loud. 90 s stays the Mac panel's drift.
    expect(presentationDegreesPerSecond(true)).toBe(IMMERSIVE_DEGREES_PER_SECOND);
    expect(presentationDegreesPerSecond(false)).toBe(PRESENTATION_DEGREES_PER_SECOND);
    expect(IMMERSIVE_DEGREES_PER_SECOND).toBe(12);
    expect(PRESENTATION_DEGREES_PER_SECOND).toBe(4);
    expect(IMMERSIVE_DEGREES_PER_SECOND / PRESENTATION_DEGREES_PER_SECOND).toBe(3);
  });

  it('advances three times as far in the headset over the same elapsed frame', () => {
    const immersive = spinLoop({ immersive: true }), panel = spinLoop({ immersive: false });
    immersive.advance(2000);
    panel.advance(2000);
    expect(immersive.angle()).toBeCloseTo(24, 6);
    expect(panel.angle()).toBeCloseTo(8, 6);
  });
});

describe('the spoken spin replies', () => {
  // The runner writes the caption and speaks the confirmation from one field,
  // so the plate in front of the wearer's eyes and the voice cannot disagree.
  const harness = ({ spinning }: { spinning?: () => boolean } = {}) => {
    const events = createPushToTalkAudioEvents();
    const captions: string[] = [], spoken: string[] = [], actions: any[] = [];
    const runner = attachVoiceCommandRunner({
      events,
      dispatch: async (action: any) => { actions.push(action); },
      caption: (text: string) => { captions.push(text); },
      speak: async (text: string) => { spoken.push(text); },
      record: () => {},
      ...(spinning ? { spinning } : {}),
    });
    let utterance = 0;
    return {
      captions, spoken, actions,
      say: async (text: string) => {
        events.emit({ state: 'heard', utteranceId: `u${++utterance}`, text, message: `Heard: ${text}` });
        await runner.settled();
      },
    };
  };

  it('says and shows "Stopped." for a spoken stop over a turning structure', async () => {
    const voice = harness({ spinning: () => true });
    await voice.say('stop');
    expect(voice.actions).toEqual([{ kind: 'toggle-motion', paused: true }]);
    expect(voice.spoken).toEqual(['Stopped.']);
    expect(new Set(voice.captions)).toContain('Stopped.');
    expect(voice.spoken.every(line => voice.captions.includes(line))).toBe(true);
  });

  it('says and shows "Spinning." for a spoken spin, and the rate is not in the words', async () => {
    const voice = harness();
    await voice.say('spin it');
    expect(voice.actions).toEqual([{ kind: 'toggle-motion', paused: false }]);
    expect(voice.spoken).toEqual(['Spinning.']);
    expect(new Set(voice.captions)).toContain('Spinning.');
    // The action stays exactly `{ kind, paused }`: the faster headset rate is
    // chosen by the viewer, never carried in the command.
    expect(Object.keys(voice.actions[0]).sort()).toEqual(['kind', 'paused']);
  });

  it('keeps the two spin replies at the two-word style', () => {
    expect((SPATIAL_VOICE_ACTIONS as any)['toggle-motion']).toBeUndefined();
    expect(spatialVoiceAction('stop spinning')?.say).toBe('Stopped.');
    expect(spatialVoiceAction('spin')?.say).toBe('Spinning.');
  });
});

describe('the viewer wiring', () => {
  const source = readFileSync(VIEWER, 'utf8');

  it('routes both tracked-pointer reads through the shared predicate', () => {
    expect(source).toContain("import { pointerManipulates, presentationDegreesPerSecond } from './presentation-motion.mjs'");
    expect(source).toContain('xrInputHeld = pointers.some(pointerManipulates)');
    expect(source).toContain('pointers.filter(pointer => pointerManipulates(pointer) && !spatialOwnedHands.has(pointer.handedness))');
    // The bare button test is what froze the spin under a talk hold.
    expect(source).not.toContain('pointer.buttons !== 0');
  });

  it('integrates the angle at the session-chosen rate', () => {
    expect(source).toContain('presentationDegreesPerSecond(canvas.xr.isPresenting.value === true)');
    expect(source).toContain('elapsed * motionDegreesPerSecond() / 1000');
    expect(source).not.toContain('MOTION_DEGREES_PER_SECOND');
  });

  it('leaves the inspection motion contract at exactly a paused boolean', () => {
    expect(source).toContain("throw failure('invalid_motion', 'Motion requires exactly a paused boolean.')");
    expect(source).toContain('Object.keys(value).length !== 1');
  });
});
