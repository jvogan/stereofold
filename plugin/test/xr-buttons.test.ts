import { describe, expect, it, vi } from 'vitest';
import { ButtonsType, ModifiersKeys } from 'molstar/lib/mol-util/input/input-observer';
import { Binding } from 'molstar/lib/mol-util/binding';
// @ts-ignore Import-free controller mapping, shared with the browser XR layer.
import { createXrButtons, createXrThumbstick, rememberSpokenReply, stickAxis, stickDeflection, BUTTON_DEBOUNCE_MS, BUTTON_PULSE, FACE_BUTTONS, FACE_LOWER, FACE_UPPER, HOLD_HINT_MS, RESET_HOLD_MS, STICK_CLICK_MAX_DEFLECTION, STICK_DEAD_ZONE, STICK_DEGREES_PER_SECOND, STICK_METRES_PER_SECOND, STICK_MAX_FRAME_MS, STICK_PRESS, TALK_MIN_HOLD_MS, TAP_DEBOUNCE_MS, TAP_MAX_MS } from '../../lab/browser-roundtrip/xr-buttons.mjs';
// @ts-ignore The retired stock thumbstick and controller bindings.
import { createStickModifiers, firePassthroughToggle, xrLocomotionAttribs, xrManagerAttribs, MISSING_POINTER_GRACE_MS, MODIFIER_PICK_GUARD_MS, PASSTHROUGH_BINDING, PASSTHROUGH_KEY, STICK_MODE, STICK_RECENTRE, XR_CLEARED_CAMERA_DRAGS } from '../../lab/browser-roundtrip/xr-locomotion.mjs';

const pointer = (handedness: string, buttons = 0, axes: number[] = [0, 0, 0, 0]) => ({ handedness, buttons, axes });

describe('the face buttons Mol* already reports', () => {
  it('reads A and X as Forth and B and Y as Five, never as a trigger', () => {
    // xr-manager.js:150-158 builds the mask from the Touch gamepad: buttons[3]
    // is Auxilary, buttons[4] is Forth, buttons[5] is Five. Nothing here may
    // collide with the trigger, which is the residue pick.
    expect(FACE_LOWER).toBe(ButtonsType.Flag.Forth);
    expect(FACE_UPPER).toBe(ButtonsType.Flag.Five);
    expect(STICK_PRESS).toBe(ButtonsType.Flag.Auxilary);
    for (const binding of FACE_BUTTONS) {
      expect(binding.mask & ButtonsType.Flag.Primary).toBe(0);
      expect(binding.mask & ButtonsType.Flag.Trigger).toBe(0);
      expect(binding.mask & ButtonsType.Flag.Secondary).toBe(0);
    }
  });

  it('gives both hands the same map, so one controller does everything', () => {
    // Either controller alone does everything, so a wearer only has to rely on
    // one hand. Every binding on the right hand has a twin on the left with the
    // same action, the same modifiers and the same timing flags.
    const shape = (binding: any) => JSON.stringify([binding.mask, binding.action, binding.holdAction ?? null,
      Boolean(binding.hold), Boolean(binding.tapHold), Boolean(binding.restingStick)]);
    const byHand = (hand: string) => FACE_BUTTONS.filter((binding: any) => binding.hand === hand).map(shape);
    expect(byHand('left')).toEqual(byHand('right'));
    expect(byHand('right')).toHaveLength(3);
  });

  it('binds talk to the lower buttons, menu-or-reset to the upper, reset to the stick click', () => {
    expect(FACE_BUTTONS.map((binding: any) => `${binding.hand}:${binding.button}:${binding.action}`)).toEqual([
      'right:A:push-to-talk', 'left:X:push-to-talk', 'right:B:menu', 'left:Y:menu',
      'right:stick:recenter-structure', 'left:stick:recenter-structure',
    ]);
    expect(FACE_BUTTONS.filter((binding: any) => binding.hold).map((binding: any) => binding.button)).toEqual(['A', 'X']);
    expect(FACE_BUTTONS.filter((binding: any) => binding.tapHold).map((binding: any) => binding.holdAction))
      .toEqual(['recenter-structure', 'recenter-structure']);
  });
});

describe('a face button press', () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const actions: string[] = [], records: any[] = [], pulses: unknown[] = [];
    let clock = 0;
    const buttons = createXrButtons({
      run: (action: string, _binding: any, phase?: string) => { actions.push(phase ? `${action}:${phase}` : action); },
      pulse: (_source: unknown, shape: unknown) => { pulses.push(shape); },
      record: (kind: string, detail: any) => records.push({ kind, ...detail }),
      now: () => clock,
      ...over,
    });
    return { buttons, actions, records, pulses, tick: (ms: number) => { clock += ms; } };
  };

  it('fires once on the press and not again while the thumb is down', () => {
    const { buttons, actions } = harness();
    buttons.update([pointer('right', STICK_PRESS)]);
    buttons.update([pointer('right', STICK_PRESS)]);
    buttons.update([pointer('right', STICK_PRESS)]);
    expect(actions).toEqual(['recenter-structure']);
  });

  it('fires again after a release and a debounce', () => {
    const { buttons, actions, tick } = harness();
    buttons.update([pointer('right', STICK_PRESS)]);
    buttons.update([pointer('right', 0)]);
    tick(BUTTON_DEBOUNCE_MS + 1);
    buttons.update([pointer('right', STICK_PRESS)]);
    expect(actions).toEqual(['recenter-structure', 'recenter-structure']);
  });

  it('swallows a bounce inside the debounce window and says so', () => {
    const { buttons, actions, records, tick } = harness();
    buttons.update([pointer('right', STICK_PRESS)]);
    buttons.update([pointer('right', 0)]);
    tick(BUTTON_DEBOUNCE_MS - 50);
    buttons.update([pointer('right', STICK_PRESS)]);
    expect(actions).toEqual(['recenter-structure']);
    expect(records.filter(record => record.outcome === 'debounced')).toHaveLength(1);
  });

  it('buzzes the hand that pressed and records the press', () => {
    const sources: unknown[] = [];
    const { buttons, records, pulses } = harness({ sourceFor: (hand: string) => { sources.push(hand); return { hand }; } });
    buttons.update([pointer('left', STICK_PRESS)]);
    expect(pulses).toEqual([BUTTON_PULSE]);
    expect(sources).toEqual(['left']);
    expect(records).toEqual([{ kind: 'xr-button', hand: 'left', button: 'stick', action: 'recenter-structure' }]);
  });

  it('gives the same tap on either upper button', () => {
    // B and Y used to be two different actions, which is why one controller
    // could not do everything. Either hand alone now taps the same menu; two
    // thumbs at once are one press, which the first-hand-wins test below owns.
    const { buttons, actions, records, tick } = harness();
    for (const hand of ['right', 'left']) {
      buttons.update([pointer(hand, FACE_UPPER)]);
      tick(100);
      buttons.update([pointer(hand, 0)]);
      tick(TAP_DEBOUNCE_MS + 1);
    }
    expect(actions).toEqual(['menu:tap', 'menu:tap']);
    expect(records.filter(record => record.phase === 'tap').map(record => record.button)).toEqual(['B', 'Y']);
  });

  it('is never fired by a trigger or a grip', () => {
    const { buttons, actions } = harness();
    buttons.update([pointer('right', ButtonsType.Flag.Primary | ButtonsType.Flag.Secondary | ButtonsType.Flag.Trigger)]);
    expect(actions).toEqual([]);
  });

  it('records a failed action rather than letting it stop the next press', () => {
    const records: any[] = [];
    let clock = 0;
    const buttons = createXrButtons({
      run: (action: string) => { if (action === 'menu') throw Error('no toolbar'); },
      record: (kind: string, detail: any) => records.push({ kind, ...detail }),
      now: () => clock,
    });
    buttons.update([pointer('right', FACE_UPPER)]);
    buttons.update([pointer('right', 0)]);
    expect(records.find(record => record.outcome === 'failed')).toMatchObject({ button: 'B', error: 'no toolbar' });
    clock += TAP_DEBOUNCE_MS + 1;
    buttons.update([pointer('left', FACE_UPPER)]);
    buttons.update([pointer('left', 0)]);
    expect(records.find(record => record.button === 'Y' && !record.outcome)).toBeTruthy();
  });

  it('records a rejected promise the same way', async () => {
    const records: any[] = [];
    const buttons = createXrButtons({
      run: () => Promise.reject(Error('tour asleep')),
      record: (kind: string, detail: any) => records.push({ kind, ...detail }),
      now: () => 0,
    });
    buttons.update([pointer('left', FACE_UPPER)]);
    buttons.update([pointer('left', 0)]);
    await Promise.resolve(); await Promise.resolve();
    expect(records.find(record => record.outcome === 'failed')).toMatchObject({ button: 'Y', error: 'tour asleep' });
  });

  it('treats a controller that stopped reporting as a release', () => {
    const { buttons, actions, tick } = harness();
    buttons.update([pointer('right', STICK_PRESS)]);
    buttons.update([]);
    tick(BUTTON_DEBOUNCE_MS + 1);
    buttons.update([pointer('right', STICK_PRESS)]);
    expect(actions).toEqual(['recenter-structure', 'recenter-structure']);
  });
});

describe('tapping B or Y for the menu and holding it for the reset', () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const actions: string[] = [], records: any[] = [], pulses: unknown[] = [];
    let clock = 0;
    const buttons = createXrButtons({
      run: (action: string, binding: any, phase?: string) => { actions.push(`${binding.button}:${action}${phase ? ':' + phase : ''}`); },
      pulse: (_source: unknown, shape: unknown) => { pulses.push(shape); },
      record: (kind: string, detail: any) => records.push({ kind, ...detail }),
      now: () => clock,
      ...over,
    });
    return { buttons, actions, records, pulses, tick: (ms: number) => { clock += ms; } };
  };

  it('toggles the menu on a tap, on either hand', () => {
    for (const [hand, button] of [['right', 'B'], ['left', 'Y']]) {
      const { buttons, actions, tick } = harness();
      buttons.update([pointer(hand, FACE_UPPER)]);
      expect(actions).toEqual([]);           // Nothing on the press: it may yet be a hold.
      tick(TAP_MAX_MS - 100);
      buttons.update([pointer(hand, 0)]);
      expect(actions).toEqual([`${button}:menu:tap`]);
    }
  });

  it('captions the reset from 150 ms and fires it once at 500 ms', () => {
    const { buttons, actions, pulses, tick } = harness();
    buttons.update([pointer('right', FACE_UPPER)]);
    tick(HOLD_HINT_MS - 1);
    buttons.update([pointer('right', FACE_UPPER)]);
    expect(actions).toEqual([]);
    // The hint is what makes a hold abortable: the wearer who meant to tap the
    // menu sees "Hold to reset…" and has 350 ms to let go.
    tick(2);
    buttons.update([pointer('right', FACE_UPPER)]);
    buttons.update([pointer('right', FACE_UPPER)]);
    expect(actions).toEqual(['B:recenter-structure:hint']);
    tick(RESET_HOLD_MS - HOLD_HINT_MS);
    buttons.update([pointer('right', FACE_UPPER)]);
    buttons.update([pointer('right', FACE_UPPER)]);
    tick(1000);
    buttons.update([pointer('right', FACE_UPPER)]);
    expect(actions).toEqual(['B:recenter-structure:hint', 'B:recenter-structure:hold']);
    expect(pulses).toEqual([BUTTON_PULSE]);
  });

  it('does not toggle the menu with the release that ends a hold', () => {
    // The whole reason the hold and the tap can share one button: a wearer who
    // resets the view must not also be handed the menu on the way up.
    const { buttons, actions, tick } = harness();
    buttons.update([pointer('left', FACE_UPPER)]);
    tick(RESET_HOLD_MS + 10);
    buttons.update([pointer('left', FACE_UPPER)]);
    tick(50);
    buttons.update([pointer('left', 0)]);
    buttons.update([pointer('left', 0)]);
    // One frame straddled both thresholds, so the hold fired and the hint it
    // would have aborted never went up. A dropped frame must not leave a
    // "Hold to reset…" caption standing over a reset that already happened.
    expect(actions).toEqual(['Y:recenter-structure:hold']);
    expect(actions.some(action => action.endsWith(':tap'))).toBe(false);
  });

  it('takes the caption back down when the wearer lets go in time', () => {
    const { buttons, actions, tick } = harness();
    buttons.update([pointer('right', FACE_UPPER)]);
    tick(200);
    buttons.update([pointer('right', FACE_UPPER)]);
    buttons.update([pointer('right', 0)]);
    // Aborted, so the caption clears, and the press was still a tap: the menu
    // is what the wearer was reaching for.
    expect(actions).toEqual(['B:recenter-structure:hint', 'B:recenter-structure:abort', 'B:menu:tap']);
  });

  it('is not a tap when the thumb rested on the button and no hold followed', () => {
    // A release past the tap window with the hold already fired is handled
    // above; this is a frame gap that straddled the hold without a frame inside
    // it, so the reset never fired and the menu must not open either.
    const { buttons, actions, records, tick } = harness();
    buttons.update([pointer('right', FACE_UPPER)]);
    tick(RESET_HOLD_MS + 100);
    buttons.update([pointer('right', 0)]);
    expect(actions.filter(action => action.endsWith(':tap'))).toEqual([]);
    expect(records.some(record => record.outcome === 'no-tap')).toBe(true);
  });

  it('answers a hold that fell short instead of hiding the menu', () => {
    // The band between the tap and the reset used to be a tap: a wearer holding
    // B for a reset who let go at 400 ms got the menu hidden, at the moment
    // they were already lost enough to be reaching for a reset. That band is
    // now a hold that fell short. It toggles nothing and says what to do next.
    expect(TAP_MAX_MS).toBe(250);
    expect(TAP_MAX_MS).toBeGreaterThan(HOLD_HINT_MS);
    expect(TAP_MAX_MS).toBeLessThan(RESET_HOLD_MS);
    for (const elapsed of [TAP_MAX_MS, 400, RESET_HOLD_MS - 1]) {
      const { buttons, actions, records, tick } = harness();
      buttons.update([pointer('right', FACE_UPPER)]);
      tick(elapsed);
      buttons.update([pointer('right', FACE_UPPER)]);
      buttons.update([pointer('right', 0)]);
      expect(actions, `${elapsed} ms`).toEqual(['B:recenter-structure:hint', 'B:recenter-structure:short-hold']);
      expect(records.some(record => record.outcome === 'no-tap'), `${elapsed} ms`).toBe(true);
    }
    // Under the window it is still the menu, and past the hold it is the reset.
    for (const [elapsed, expected] of [[TAP_MAX_MS - 1, 'B:menu:tap'], [RESET_HOLD_MS, 'B:recenter-structure:hold']] as const) {
      const { buttons, actions, tick } = harness();
      buttons.update([pointer('right', FACE_UPPER)]);
      tick(elapsed);
      buttons.update([pointer('right', FACE_UPPER)]);
      buttons.update([pointer('right', 0)]);
      expect(actions.at(-1), `${elapsed} ms`).toBe(expected);
      expect(actions.filter(action => action.endsWith(':short-hold')), `${elapsed} ms`).toEqual([]);
    }
  });

  it('swallows a contact bounce that would toggle the menu straight back', () => {
    // A Touch face button can break contact twice on one release. Two taps put
    // the menu back where it started and buzzed twice saying so.
    const { buttons, actions, records, pulses, tick } = harness();
    buttons.update([pointer('right', FACE_UPPER)]);
    tick(120);
    buttons.update([pointer('right', 0)]);
    tick(TAP_DEBOUNCE_MS - 20);
    buttons.update([pointer('right', FACE_UPPER)]);
    buttons.update([pointer('right', 0)]);
    expect(actions).toEqual(['B:menu:tap']);
    expect(pulses).toEqual([BUTTON_PULSE]);
    expect(records.some(record => record.outcome === 'debounced')).toBe(true);
    // Past the window it is a wearer tapping twice, which is two toggles.
    tick(TAP_DEBOUNCE_MS + 1);
    buttons.update([pointer('right', FACE_UPPER)]);
    buttons.update([pointer('right', 0)]);
    expect(actions).toEqual(['B:menu:tap', 'B:menu:tap']);
  });

  it('gives the upper button to the first thumb and ignores the other hand', () => {
    // B and Y are the same button on two hands. A wearer with a thumb on each
    // toggled the menu twice, or reset twice, from one intent.
    const { buttons, actions, records, tick } = harness();
    buttons.update([pointer('right', FACE_UPPER), pointer('left', FACE_UPPER)]);
    tick(200);
    buttons.update([pointer('right', 0), pointer('left', 0)]);
    expect(actions).toEqual(['B:menu:tap']);
    expect(records.find(record => record.outcome === 'other-hand')).toMatchObject({ hand: 'left', button: 'Y' });
    // A hold is the same: one reset, from the hand that got there first.
    const second = harness();
    second.buttons.update([pointer('left', FACE_UPPER)]);
    second.tick(20);
    second.buttons.update([pointer('left', FACE_UPPER), pointer('right', FACE_UPPER)]);
    second.tick(RESET_HOLD_MS);
    second.buttons.update([pointer('left', FACE_UPPER), pointer('right', FACE_UPPER)]);
    expect(second.actions.filter(action => action.endsWith(':hold'))).toEqual(['Y:recenter-structure:hold']);
    // And the released owner hands the button back for the next press.
    second.buttons.update([pointer('left', 0), pointer('right', 0)]);
    second.tick(1000);
    second.buttons.update([pointer('right', FACE_UPPER)]);
    second.tick(100);
    second.buttons.update([pointer('right', 0)]);
    expect(second.actions.filter(action => action.endsWith(':tap'))).toEqual(['B:menu:tap']);
  });
});

describe('clicking the stick to reset', () => {
  const harness = () => {
    const actions: string[] = [], records: any[] = [];
    const buttons = createXrButtons({
      run: (action: string, binding: any, phase?: string) => {
        actions.push(`${binding.hand}:${action}${phase ? `:${phase}` : ''}`);
      },
      record: (kind: string, detail: any) => records.push({ kind, ...detail }),
      now: () => 0,
    });
    return { buttons, actions, records };
  };

  it('resets from a resting stick, on either hand', () => {
    const { buttons, actions } = harness();
    buttons.update([pointer('right', STICK_PRESS, [0, 0, 0.1, -0.1])]);
    buttons.update([]);
    buttons.update([pointer('left', STICK_PRESS, [0, 0, 0, 0])]);
    expect(actions).toEqual(['right:recenter-structure', 'left:recenter-structure']);
  });

  it('drops a click made on a stick the thumb was steering, and says it did', () => {
    // A Touch stick clicks off-axis under a push, so a wearer sliding the
    // structure sideways clicks it without meaning to. The reset is a jump the
    // wearer cannot undo, which is why it is the click that yields.
    //
    // It yields out loud. A click dropped for deflection used to leave nothing
    // but a log line, which a wearer in a headset cannot see. The refusal now
    // reaches the action, with the deflection that caused it.
    const { buttons, actions, records } = harness();
    buttons.update([pointer('right', STICK_PRESS, [0, 0, 0.5, 0])]);
    expect(actions).toEqual(['right:recenter-structure:refused']);
    const refusals = records.filter(record => record.outcome === 'stick-deflected');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ phase: 'refused', deflection: 0.5, action: 'recenter-structure' });
    expect(stickDeflection({ axes: [0, 0, 0.5, 0] })).toBeCloseTo(0.5, 6);
    expect(stickDeflection({ axes: [0, 0, 0.3, 0.4] })).toBeCloseTo(0.5, 6);
    expect(stickDeflection({})).toBe(0);
    expect(STICK_CLICK_MAX_DEFLECTION).toBeLessThan(0.5);
  });
});

describe('the trigger and grip modifiers on the stick', () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const engaged: string[] = [], records: any[] = [];
    const modifiers = createStickModifiers({
      onEngage: (hand: string) => engaged.push(hand),
      record: (kind: string, detail: any) => records.push({ kind, ...detail }),
      ...over,
    });
    return { modifiers, engaged, records };
  };
  const TRIGGER = 1, GRIP = 2;

  it('slides on a bare stick and pushes under a trigger, the same on both hands', () => {
    const { modifiers, engaged } = harness();
    modifiers.update([pointer('right'), pointer('left')]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.slide);
    expect(modifiers.mode('left')).toBe(STICK_MODE.slide);
    modifiers.update([pointer('right', TRIGGER), pointer('left', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
    expect(modifiers.mode('left')).toBe(STICK_MODE.depthYaw);
    expect(engaged).toEqual(['left', 'right']);
    expect(modifiers.engaged()).toBe(true);
  });

  it('scales under a grip and goes back to sliding when the hand opens', () => {
    const { modifiers } = harness();
    modifiers.update([pointer('right', GRIP)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.scale);
    modifiers.update([pointer('right')]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.slide);
  });

  it('leaves the stick inert for a trigger pressed on the menu', () => {
    // On the menu the trigger is a select and nothing else, so the stick must
    // not start pushing the structure while the wearer is picking a row.
    const { modifiers, records } = harness({ isRayOnMenu: (hand: string) => hand === 'right' });
    modifiers.update([pointer('right', TRIGGER), pointer('left', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.inert);
    expect(modifiers.mode('left')).toBe(STICK_MODE.depthYaw);
    expect(records.find(record => record.event === 'modifier-blocked')).toMatchObject({ hand: 'right', reason: 'menu' });
  });

  it('keeps a modifier that engaged off the menu when the ray crosses it', () => {
    // Midas touch: a wearer pushing the structure away must not have the push
    // turn into a menu press because the structure travelled behind the panel.
    let onMenu = false;
    const { modifiers } = harness({ isRayOnMenu: () => onMenu });
    modifiers.update([pointer('right', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
    onMenu = true;
    modifiers.update([pointer('right', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
    // Only the trigger coming up ends it.
    modifiers.update([pointer('right')]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.slide);
    expect(modifiers.engaged()).toBe(false);
  });

  it('never claims a trigger it did not see go down', () => {
    // A hand that arrives mid-press, or one that returns from lost tracking,
    // is not a press this layer can call a modifier.
    const { modifiers, engaged } = harness({ isRayOnMenu: () => true });
    modifiers.update([pointer('right', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.inert);
    modifiers.update([pointer('right', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.inert);
    expect(engaged).toEqual([]);
    // A controller that stops reporting with nothing latched has nothing to keep.
    modifiers.update([]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.slide);
  });

  it('keeps the pushed lane when a modifier is added, then blocks after release until centre', () => {
    // Adding a modifier under a pushed thumb must not change lanes. Releasing
    // that modifier is different: its action stops until the thumb recentres,
    // so depth does not keep running after the trigger comes up.
    const { modifiers } = harness();
    modifiers.update([pointer('right', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
    modifiers.update([pointer('right', TRIGGER, [0, 0, 0, -0.9])]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
    modifiers.update([pointer('right', 0, [0, 0, 0, -0.9])]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.inert);
    modifiers.update([pointer('right', 0, [0, 0, 0.2, -0.5])]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.inert);
    modifiers.update([pointer('right', 0, [0, 0, 0, -(STICK_RECENTRE - 0.01)])]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.slide);
    // And the gate is symmetric: a trigger pressed under a pushed stick waits
    // the same way rather than throwing the structure into depth mid-slide.
    modifiers.update([pointer('right', 0, [0, 0, 0.9, 0])]);
    modifiers.update([pointer('right', TRIGGER, [0, 0, 0.9, 0])]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.slide);
    modifiers.update([pointer('right', TRIGGER, [0, 0, 0, 0])]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
  });

  it('holds the latch through a frame with no pointer', () => {
    // One dropped tracking frame used to clear the latch, and the still-held
    // trigger arrived next frame as a fresh press, flipping the mode in the
    // middle of the gesture.
    const { modifiers, engaged } = harness();
    modifiers.update([pointer('right', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
    modifiers.update([]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
    modifiers.update([pointer('right', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
    expect(engaged).toEqual(['right']);
    modifiers.update([pointer('right', 0)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.slide);
  });

  it('lets the latch go when the controller has been put down, not just lost', () => {
    // A latch kept for a controller that never comes back would suppress every
    // residue pick for the rest of the session.
    let clock = 0;
    const { modifiers } = harness({ now: () => clock });
    modifiers.update([pointer('right', TRIGGER)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.depthYaw);
    modifiers.update([]);
    clock += MISSING_POINTER_GRACE_MS + 1;
    modifiers.update([]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.slide);
    clock += MODIFIER_PICK_GUARD_MS + 1;
    expect(modifiers.engagedWithin()).toBe(false);
  });

  it('reads the grab\'s own grip latch rather than the thresholded bit', () => {
    // The bitmask crosses at a different squeeze than the grab's hysteresis, so
    // a hand relaxing to about 0.5 kept the structure and lost the scale stick:
    // one hand driving two paths at once.
    let squeezing = false;
    const { modifiers } = harness({ gripHeld: (hand: string) => squeezing && hand === 'right' });
    modifiers.update([pointer('right', GRIP)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.slide);
    squeezing = true;
    modifiers.update([pointer('right', 0)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.scale);
  });

  it('leaves the stick alone while both grips are scaling', () => {
    // Two grips already scale with the span between the hands. A thumb on
    // either stick must not scale a third time.
    const { modifiers } = harness({ gripHeld: () => true, scaleActive: () => true });
    modifiers.update([pointer('right', GRIP), pointer('left', GRIP)]);
    expect(modifiers.mode('right')).toBe(STICK_MODE.inert);
    expect(modifiers.mode('left')).toBe(STICK_MODE.inert);
  });

  it.each(['left', 'right'])('stops an already-pushed %s resize stick when the second grip joins', hand => {
    let scaling = false;
    const { modifiers } = harness({ gripHeld: () => true, scaleActive: () => scaling });
    modifiers.update([pointer(hand, GRIP)]);
    modifiers.update([pointer(hand, GRIP, [0, 0, 0, -1])]);
    expect(modifiers.mode(hand)).toBe(STICK_MODE.scale);
    scaling = true;
    modifiers.update([pointer(hand, GRIP, [0, 0, 0, -1])]);
    expect(modifiers.mode(hand)).toBe(STICK_MODE.inert);
    scaling = false;
    modifiers.update([pointer(hand, GRIP, [0, 0, 0, -1])]);
    expect(modifiers.mode(hand)).toBe(STICK_MODE.inert);
    modifiers.update([pointer(hand, GRIP)]);
    modifiers.update([pointer(hand, GRIP, [0, 0, 0, -1])]);
    expect(modifiers.mode(hand)).toBe(STICK_MODE.scale);
  });

  it.each(['left', 'right'])('pulls a targeted trigger drag with the %s stick and keeps a pending tap inert', hand => {
    let dragging = false;
    const { modifiers } = harness({ triggerOwned: (name: string) => name === hand,
      triggerDragging: () => dragging });
    modifiers.update([pointer(hand, TRIGGER, [0, 0, 0, -0.8])]);
    expect(modifiers.mode(hand)).toBe(STICK_MODE.inert);
    dragging = true;
    modifiers.update([pointer(hand, TRIGGER, [0, 0, 0, -0.8])]);
    expect(modifiers.mode(hand)).toBe(STICK_MODE.depthYaw);
    expect(modifiers.engagedWithin(undefined, hand)).toBe(true);
  });

  it('keeps a grip-first trigger combination in the same resize mode', () => {
    const { modifiers } = harness({ gripHeld: () => true });
    modifiers.update([pointer('left', GRIP)]);
    modifiers.update([pointer('left', GRIP | TRIGGER)]);
    expect(modifiers.mode('left')).toBe(STICK_MODE.scale);
    const two = harness({ gripHeld: () => true, scaleActive: () => true });
    two.modifiers.update([pointer('left', GRIP | TRIGGER)]);
    expect(two.modifiers.mode('left')).toBe(STICK_MODE.inert);
  });

  it('remembers a consumed depth push while the stick rests and releases the guard on a new tap', () => {
    let clock = 0;
    const { modifiers } = harness({ now: () => clock });
    modifiers.update([pointer('left', TRIGGER)]);
    modifiers.update([pointer('left', TRIGGER, [0, 0, 0, -0.8])]);
    clock += 2000;
    modifiers.update([pointer('left', TRIGGER)]);
    expect(modifiers.engagedWithin(undefined, 'left')).toBe(true);
    expect(modifiers.engagedWithin(undefined, 'right')).toBe(false);
    modifiers.update([pointer('left', 0)]);
    expect(modifiers.engagedWithin(undefined, 'left')).toBe(true);
    modifiers.update([pointer('left', TRIGGER)]);
    modifiers.update([pointer('left', 0)]);
    expect(modifiers.engagedWithin(undefined, 'left')).toBe(false);
  });

  it('owns the residue pick for as long as the click takes to arrive', () => {
    // Mol* raises its click on the release, by which time the latch is gone.
    // Without this window a wearer pushing the structure away also selected
    // whatever atom the ray crossed.
    let clock = 0;
    const { modifiers } = harness({ now: () => clock });
    expect(modifiers.engagedWithin()).toBe(false);
    modifiers.update([pointer('right', TRIGGER)]);
    expect(modifiers.engagedWithin()).toBe(false); // A trigger tap alone still picks.
    modifiers.update([pointer('right', TRIGGER, [0, 0, 0, -0.8])]);
    expect(modifiers.engagedWithin()).toBe(true);
    clock += 5_000;
    modifiers.update([pointer('right', TRIGGER, [0, 0, 0, -0.8])]);
    modifiers.update([pointer('right', 0)]);
    expect(modifiers.engagedWithin()).toBe(true);
    clock += MODIFIER_PICK_GUARD_MS + 1;
    expect(modifiers.engagedWithin()).toBe(false);
    // A trigger the menu blocked never becomes a modifier, so it still picks.
    const blocked = harness({ now: () => clock, isRayOnMenu: () => true });
    blocked.modifiers.update([pointer('left', TRIGGER)]);
    expect(blocked.modifiers.engagedWithin()).toBe(false);
  });
});

describe('holding A or X to talk', () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const actions: string[] = [], records: any[] = [], pulses: unknown[] = [];
    let clock = 0;
    const buttons = createXrButtons({
      run: (action: string, binding: any, phase?: string) => { actions.push(`${binding.button}:${action}:${phase}`); },
      pulse: (_source: unknown, shape: unknown) => { pulses.push(shape); },
      record: (kind: string, detail: any) => records.push({ kind, ...detail }),
      now: () => clock,
      ...over,
    });
    return { buttons, actions, records, pulses, tick: (ms: number) => { clock += ms; } };
  };

  it('opens the microphone only once the thumb has stayed on the button', () => {
    const { buttons, actions, tick } = harness();
    buttons.update([pointer('right', FACE_LOWER)]);
    tick(TALK_MIN_HOLD_MS - 1);
    buttons.update([pointer('right', FACE_LOWER)]);
    expect(actions).toEqual([]);
    tick(2);
    buttons.update([pointer('right', FACE_LOWER)]);
    expect(actions).toEqual(['A:push-to-talk:down']);
  });

  it('closes it when the thumb comes off, and never twice', () => {
    const { buttons, actions, tick } = harness();
    buttons.update([pointer('right', FACE_LOWER)]);
    tick(TALK_MIN_HOLD_MS + 1);
    buttons.update([pointer('right', FACE_LOWER)]);
    buttons.update([pointer('right', 0)]);
    buttons.update([pointer('right', 0)]);
    expect(actions).toEqual(['A:push-to-talk:down', 'A:push-to-talk:up']);
  });

  it('drops a tap and only buzzes, which is the one-word "you" from the 11:08 pass', () => {
    const { buttons, actions, records, pulses, tick } = harness();
    buttons.update([pointer('right', FACE_LOWER)]);
    tick(TALK_MIN_HOLD_MS - 20);
    buttons.update([pointer('right', 0)]);
    expect(actions).toEqual([]);
    expect(pulses).toEqual([BUTTON_PULSE]);
    expect(records.filter(record => record.outcome === 'tap')).toHaveLength(1);
  });

  it('opens one microphone for two thumbs, not two', () => {
    const { buttons, actions, tick } = harness();
    buttons.update([pointer('right', FACE_LOWER), pointer('left', FACE_LOWER)]);
    tick(TALK_MIN_HOLD_MS + 1);
    buttons.update([pointer('right', FACE_LOWER), pointer('left', FACE_LOWER)]);
    expect(actions).toEqual(['A:push-to-talk:down']);
    expect(buttons.holding()).toBe('right:A');
    // The second hand letting go must not close the first hand's microphone.
    buttons.update([pointer('right', FACE_LOWER), pointer('left', 0)]);
    expect(actions).toEqual(['A:push-to-talk:down']);
    buttons.update([pointer('right', 0), pointer('left', 0)]);
    expect(actions).toEqual(['A:push-to-talk:down', 'A:push-to-talk:up']);
  });

  it('closes the microphone when the controller stops reporting', () => {
    const { buttons, actions, tick } = harness();
    buttons.update([pointer('left', FACE_LOWER)]);
    tick(TALK_MIN_HOLD_MS + 1);
    buttons.update([pointer('left', FACE_LOWER)]);
    expect(actions).toEqual(['X:push-to-talk:down']);
    buttons.update([]);
    expect(actions).toEqual(['X:push-to-talk:down', 'X:push-to-talk:up']);
    expect(buttons.holding()).toBeUndefined();
  });

  it('starts a new session with no thumb held', () => {
    const { buttons, actions, tick } = harness();
    buttons.update([pointer('right', FACE_LOWER)]);
    tick(TALK_MIN_HOLD_MS + 1);
    buttons.update([pointer('right', FACE_LOWER)]);
    buttons.reset();
    expect(buttons.holding()).toBeUndefined();
    buttons.update([pointer('right', FACE_LOWER)]);
    tick(TALK_MIN_HOLD_MS + 1);
    buttons.update([pointer('right', FACE_LOWER)]);
    expect(actions).toEqual(['A:push-to-talk:down', 'A:push-to-talk:down']);
  });
});

describe('a thumbstick, moving the structure', () => {
  const drive = (over: Record<string, unknown> = {}) => {
    const moves: any[] = [], ends: number[] = [], records: any[] = [];
    let clock = 0;
    const stick = createXrThumbstick({
      onMove: (deflection: any) => moves.push(deflection),
      onEnd: () => ends.push(clock),
      record: (kind: string, detail: any) => records.push({ kind, ...detail }),
      now: () => clock,
      ...over,
    });
    return { stick, moves, ends, records, tick: (ms: number) => { clock += ms; } };
  };

  it('ignores a resting stick and rescales from the dead zone edge', () => {
    expect(stickAxis(0)).toBe(0);
    expect(stickAxis(STICK_DEAD_ZONE)).toBe(0);
    expect(stickAxis(-STICK_DEAD_ZONE)).toBe(0);
    expect(stickAxis(1)).toBeCloseTo(1, 12);
    expect(stickAxis(-1)).toBeCloseTo(-1, 12);
    // Just past the edge is the slowest speed, not an immediate jump.
    expect(stickAxis(STICK_DEAD_ZONE + 0.001)).toBeGreaterThan(0);
    expect(stickAxis(STICK_DEAD_ZONE + 0.001)).toBeLessThan(0.01);
    expect(stickAxis(NaN)).toBe(0);
  });

  it('reports a forward push as positive y and the elapsed frame in seconds', () => {
    const { stick, moves, tick } = drive();
    stick.update([pointer('right', 0, [0, 0, 0, 0])]);
    tick(100);
    // WebXR reports a stick pushed forward as negative on its second axis.
    stick.update([pointer('right', 0, [0, 0, 0, -1])]);
    expect(moves).toHaveLength(1);
    expect(moves[0].y).toBeCloseTo(1, 12);
    expect(moves[0].x).toBe(0);
    expect(moves[0].seconds).toBeCloseTo(0.1, 12);
  });

  it('reports a pull back and a sideways push on their own axes', () => {
    const { stick, moves, tick } = drive();
    stick.update([pointer('right', 0, [0, 0, 0, 0])]);
    tick(100);
    stick.update([pointer('right', 0, [0, 0, 1, 1])]);
    expect(moves[0].y).toBeCloseTo(-1, 12);
    expect(moves[0].x).toBeCloseTo(1, 12);
  });

  it('travels the same distance at 30 fps as at 72', () => {
    const slow = drive(), fast = drive();
    slow.stick.update([pointer('right', 0)]);
    fast.stick.update([pointer('right', 0)]);
    for (let frame = 0; frame < 3; frame += 1) { slow.tick(33); slow.stick.update([pointer('right', 0, [0, 0, 0, -1])]); }
    for (let frame = 0; frame < 7; frame += 1) { fast.tick(14); fast.stick.update([pointer('right', 0, [0, 0, 0, -1])]); }
    const metres = (moves: any[]) => moves.reduce((sum, move) => sum + move.y * move.seconds * STICK_METRES_PER_SECOND, 0);
    expect(metres(slow.moves)).toBeCloseTo(metres(fast.moves), 2);
  });

  it('does not integrate travel across a stall', () => {
    const { stick, moves, tick } = drive();
    stick.update([pointer('right', 0)]);
    tick(5_000);
    stick.update([pointer('right', 0, [0, 0, 0, -1])]);
    expect(moves).toEqual([]);
    tick(20);
    stick.update([pointer('right', 0, [0, 0, 0, -1])]);
    expect(moves).toHaveLength(1);
    expect(moves[0].seconds).toBeCloseTo(0.02, 12);
  });

  it('bakes once when the stick comes back to rest', () => {
    const { stick, ends, records, tick } = drive();
    stick.update([pointer('right', 0)]);
    tick(20); stick.update([pointer('right', 0, [0, 0, 0, -1])]);
    tick(20); stick.update([pointer('right', 0, [0, 0, 0, -1])]);
    tick(20); stick.update([pointer('right', 0, [0, 0, 0, 0])]);
    tick(20); stick.update([pointer('right', 0, [0, 0, 0, 0])]);
    expect(ends).toHaveLength(1);
    expect(records.map(record => `${record.kind}:${record.event}`)).toEqual(['xr-stick:start', 'xr-stick:end']);
  });

  it('stands down only for the hand that is holding the structure', () => {
    // A grab with the left hand must leave the right thumb its coarse control:
    // hold the structure with one hand, push it away with the other.
    const held = new Set(['left']);
    const right = drive({ hand: 'right', isClaimed: (hand: string) => held.has(hand) });
    const left = drive({ hand: 'left', isClaimed: (hand: string) => held.has(hand) });
    right.stick.update([pointer('right', 0)]);
    left.stick.update([pointer('left', 0)]);
    right.tick(100); left.tick(100);
    right.stick.update([pointer('right', 0, [0, 0, 0, -1])]);
    left.stick.update([pointer('left', 0, [0, 0, 0, -1])]);
    expect(right.moves).toHaveLength(1);
    expect(left.moves).toEqual([]);
  });

  it('reads only its own hand', () => {
    const { stick, moves, tick } = drive();
    stick.update([pointer('left', 0, [0, 0, 0, -1])]);
    tick(100);
    stick.update([pointer('left', 0, [0, 0, 0, -1])]);
    expect(moves).toEqual([]);
  });

  it('lets the caller read the same deflection as metres or as degrees', () => {
    // The two sticks mean different things by the same push, so the reader
    // reports deflection and time and the viewer turns it into either one.
    const { stick, moves, tick } = drive({ hand: 'left' });
    stick.update([pointer('left', 0)]);
    tick(STICK_MAX_FRAME_MS);
    stick.update([pointer('left', 0, [0, 0, 1, -1])]);
    expect(moves[0].y * moves[0].seconds * STICK_METRES_PER_SECOND).toBeCloseTo(STICK_METRES_PER_SECOND / 10, 9);
    expect(moves[0].x * moves[0].seconds * STICK_DEGREES_PER_SECOND).toBeCloseTo(STICK_DEGREES_PER_SECOND / 10, 9);
  });
});

describe('the stock camera thumbstick, retired', () => {
  it('takes every gamepad code off the trackball and leaves the keys', () => {
    const bindings: any = {
      keyMoveForward: { triggers: [Binding.TriggerKey('KeyW'), Binding.TriggerKey('GamepadUp')] },
      keyMoveBack: { triggers: [Binding.TriggerKey('KeyS'), Binding.TriggerKey('GamepadDown')] },
      dragRotate: 'keep',
    };
    const next: any = xrLocomotionAttribs(bindings, Binding.Empty);
    expect(next.keyMoveForward.triggers.map((trigger: any) => trigger.code)).toEqual(['KeyW']);
    expect(next.keyMoveBack.triggers.map((trigger: any) => trigger.code)).toEqual(['KeyS']);
  });

  it('is idempotent, so a second session start changes nothing', () => {
    const bindings: any = { keyMoveForward: { triggers: [Binding.TriggerKey('KeyW')] },
      ...Object.fromEntries(XR_CLEARED_CAMERA_DRAGS.map((name: string) => [name, Binding.Empty])) };
    expect(xrLocomotionAttribs(bindings, Binding.Empty)).toBeUndefined();
  });

  it('takes every controller drag off the camera while the wearer is in XR', () => {
    // xr-manager.js:146-160 rebuilds the controller buttons as a pointer mask,
    // so the trigger arrives as ButtonsType.Flag.Primary and the grip as
    // Secondary. trackball.js:22-33 binds Primary to dragRotate and Secondary
    // to dragPan, and canvas3d.js:507 runs controls.update on XR frames too, so
    // a held trigger orbited the camera about camera.target: an invisible point
    // the structure is nowhere near, so the structure looped across the room
    // for as long as the trigger was held, with no stick or grab in between.
    const bindings: any = { dragRotate: 'rotate', dragRotateZ: 'roll', dragPan: 'pan',
      dragZoom: 'zoom', dragFocus: 'focus', dragFocusZoom: 'focus-zoom',
      keyMoveForward: { triggers: [Binding.TriggerKey('KeyW')] }, scrollZoom: 'scroll' };
    const next: any = xrLocomotionAttribs(bindings, Binding.Empty);
    for (const name of XR_CLEARED_CAMERA_DRAGS) expect(next[name]).toBe(Binding.Empty);
    // A wheel never reaches a headset, and the desktop keys keep working.
    expect(next.scrollZoom).toBe('scroll');
    expect(next.keyMoveForward.triggers.map((trigger: any) => trigger.code)).toEqual(['KeyW']);
    expect(xrLocomotionAttribs(next, Binding.Empty)).toBeUndefined();
  });

  it('leaves the desktop drags alone when no empty binding is supplied', () => {
    const bindings: any = { dragRotate: 'rotate', keyMoveForward: { triggers: [Binding.TriggerKey('GamepadUp')] } };
    const next: any = xrLocomotionAttribs(bindings);
    expect(next.dragRotate).toBe('rotate');
  });
});

describe('the stock bindings that owned A and B', () => {
  it('takes the session exit off B and moves the passthrough toggle off A', () => {
    // input-observer.js:441 emits GamepadA for buttons[4] on the right hand and
    // GamepadB for buttons[5]; xr-manager.js:38-41 binds those to
    // togglePassthrough and exit. B ended the session outright, and A is now
    // push-to-talk, so the toggle moves to a code no controller sends rather
    // than being cleared: the menu row and the spoken phrases still reach it.
    const stock: any = { exit: 'exit', togglePassthrough: 'passthrough', gestureScale: 'scale' };
    const next: any = xrManagerAttribs(stock, Binding.Empty);
    expect(next.exit).toBe(Binding.Empty);
    expect(next.gestureScale).toBe(Binding.Empty);
    expect(next.togglePassthrough).toBe(PASSTHROUGH_BINDING);
    expect(next.togglePassthrough.triggers.map((trigger: any) => trigger.code)).toEqual([PASSTHROUGH_KEY]);
    expect(PASSTHROUGH_KEY.startsWith('Gamepad')).toBe(false);
    expect(xrManagerAttribs(next, Binding.Empty)).toBeUndefined();
  });

  it('reaches the toggle through the key subject Mol* actually listens on', () => {
    // Mol* keeps the passthrough flag in a Canvas3D closure and rewrites
    // transparentBackground every XR frame, so the only durable route is the
    // togglePassthrough subject, and the only route to that is a key event.
    const events: any[] = [];
    expect(firePassthroughToggle({ keyUp: { next: (event: any) => events.push(event) } })).toBe(true);
    expect(events.map(event => event.code)).toEqual([PASSTHROUGH_KEY]);
    expect(Binding.matchKey(PASSTHROUGH_BINDING as any, events[0].code, ModifiersKeys.None, events[0].key)).toBe(true);
    // A page with no input, or one whose subject throws, never breaks a frame.
    expect(firePassthroughToggle(undefined)).toBe(false);
    expect(firePassthroughToggle({ keyUp: {} })).toBe(false);
    expect(firePassthroughToggle({ keyUp: { next: () => { throw Error('detached'); } } })).toBe(false);
  });
});

describe('the reply the menu row and \'say that again\' play again', () => {
  it('remembers the last reply without the reply producer knowing', async () => {
    const play = vi.fn(async () => true);
    const voice = Object.freeze({ play, toggle: () => 'toggled', state: () => 'idle' });
    const wrapped: any = rememberSpokenReply(voice);
    expect(wrapped.toggle()).toBe('toggled');
    await wrapped.play('AAAA', 'First');
    await wrapped.play('BBBB', 'Second');
    expect(wrapped.lastSpokenReply()).toEqual({ audio: 'BBBB', text: 'Second' });
    await wrapped.repeatLastReply();
    expect(play).toHaveBeenCalledTimes(3);
    expect(play).toHaveBeenLastCalledWith('BBBB', 'Second');
  });

  it('refuses when nothing has been said', async () => {
    const wrapped: any = rememberSpokenReply({ play: async () => true });
    expect(() => wrapped.repeatLastReply()).toThrow(/Nothing has been said/);
  });

  it('leaves a controller with no playback alone', () => {
    const bare = { toggle: () => {}, state: () => 'idle' };
    expect(rememberSpokenReply(bare)).toBe(bare);
    expect(rememberSpokenReply(undefined)).toBeUndefined();
  });
});
