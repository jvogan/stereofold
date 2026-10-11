import { describe, it, expect } from 'vitest';
import { armXrReentry, armXrReentryTap, consumeXrReentry, readXrReentry, xrReentryEntryView,
  xrReentryTapTarget, XR_REENTRY_KEY, XR_REENTRY_MAX_AGE_MS, XR_REENTRY_NOTICE } from '../src/xr-reentry-hint.js';

/** A `sessionStorage` stand-in, and one that refuses everything. */
function storage(seed: Record<string, string> = {}) {
  const cells = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => { cells.set(key, value); },
    removeItem: (key: string) => { cells.delete(key); },
    size: () => cells.size,
    raw: (key: string) => cells.get(key),
  };
}
const refusing = {
  getItem() { throw Error('storage is blocked in this browser'); },
  setItem() { throw Error('storage is blocked in this browser'); },
  removeItem() { throw Error('storage is blocked in this browser'); },
};

describe('the hint the detailed page leaves for the companion page', () => {
  it('arms a timestamp and how the wearer left, and nothing else', () => {
    const cells = storage();
    expect(armXrReentry(cells, () => 5000)).toBe(true);
    expect(JSON.parse(cells.raw(XR_REENTRY_KEY)!)).toEqual({at: 5000, via: 'back-link'});
    // The browser's own Back arrow, the controller B button
    // and the back gesture all leave through `pagehide` rather than the link,
    // and each of them must arm the same one-tap return.
    expect(armXrReentry(cells, () => 6000, 'unload')).toBe(true);
    expect(JSON.parse(cells.raw(XR_REENTRY_KEY)!)).toEqual({at: 6000, via: 'unload'});
  });

  it('is consumed exactly once', () => {
    const cells = storage();
    armXrReentry(cells, () => 5000);
    expect(consumeXrReentry(cells, () => 5100)).toBe(true);
    expect(cells.size()).toBe(0);
    expect(consumeXrReentry(cells, () => 5100)).toBe(false);
  });

  it('expires rather than arming a much later visit, and clears itself either way', () => {
    const cells = storage();
    armXrReentry(cells, () => 1000);
    expect(consumeXrReentry(cells, () => 1000 + XR_REENTRY_MAX_AGE_MS)).toBe(true);
    armXrReentry(cells, () => 1000);
    expect(consumeXrReentry(cells, () => 1001 + XR_REENTRY_MAX_AGE_MS)).toBe(false);
    expect(cells.size()).toBe(0);
  });

  it('ignores a hint from a clock that has gone backwards, or junk in the cell', () => {
    expect(consumeXrReentry(storage({[XR_REENTRY_KEY]: JSON.stringify({at: 9000})}), () => 1000)).toBe(false);
    expect(consumeXrReentry(storage({[XR_REENTRY_KEY]: 'not json'}), () => 1000)).toBe(false);
    expect(consumeXrReentry(storage({[XR_REENTRY_KEY]: JSON.stringify({at: 'soon'})}), () => 1000)).toBe(false);
    expect(consumeXrReentry(storage(), () => 1000)).toBe(false);
  });

  it('never throws where storage is unavailable, so the way back still works', () => {
    expect(armXrReentry(refusing)).toBe(false);
    expect(consumeXrReentry(refusing)).toBe(false);
    expect(armXrReentry(null)).toBe(false);
    expect(consumeXrReentry(undefined)).toBe(false);
  });
});

describe('which tap stands in for Enter VR', () => {
  const element = (matches: string[]) => ({closest: (selector: string) => matches.includes(selector) ? {} : null});

  it('takes a tap on the page background', () => {
    expect(xrReentryTapTarget(element([]))).toBe(true);
    expect(xrReentryTapTarget(null)).toBe(true);
  });

  it('leaves a tap on a real control to that control', () => {
    const controls = 'button, a, select, input, textarea, summary, label, [role="button"]';
    expect(xrReentryTapTarget(element([controls]))).toBe(false);
    // A DOM that cannot answer is not a reason to press a button for the wearer.
    expect(xrReentryTapTarget({closest() { throw Error('detached node'); }})).toBe(false);
  });

  it('says what the next tap will do, and why a tap is needed at all', () => {
    expect(XR_REENTRY_NOTICE)
      .toBe('Tap Enter VR, or anywhere on this page — the headset needs one real tap to go back in.');
    // One line, and it names the control the page is about to show alone.
    expect(XR_REENTRY_NOTICE.split('\n')).toHaveLength(1);
    expect(XR_REENTRY_NOTICE).toContain('Enter VR');
  });

  /**
   * What a wearer coming home from Mol* is offered.
   *
   * A device test watched the return land on a flat page whose
   * entry row, disclosure and status paragraph all describe a choice the wearer
   * already made ninety seconds ago. Coming back is one control and one line.
   */
  describe('the way back in from the full viewer', () => {
    it('offers one control and one line once the page is quiet', () => {
      const view = xrReentryEntryView({returning: true});
      expect(view).toEqual({single: true, line: XR_REENTRY_NOTICE});
    });

    it('leaves the ordinary entry row alone when nobody is returning', () => {
      expect(xrReentryEntryView({returning: false})).toEqual({single: false});
    });

    it('never speaks over news the wearer needs more', () => {
      for (const state of [
        {returning: true, presenting: true},
        {returning: true, pending: true},
        {returning: true, problem: 'This browser does not support immersive sessions.'},
        {returning: true, pendingEntry: true},
        {returning: true, enterDisabled: true},
      ]) expect(xrReentryEntryView(state), JSON.stringify(state)).toEqual({single: false});
    });
  });
});

describe('arming the companion page for one tap', () => {
  /** A document stand-in that can deliver a capture-phase click. */
  function page() {
    const handlers = new Set<(event: {target?: unknown}) => void>();
    return {
      addEventListener: (_type: string, handler: (event: {target?: unknown}) => void) => { handlers.add(handler); },
      removeEventListener: (_type: string, handler: (event: {target?: unknown}) => void) => { handlers.delete(handler); },
      tap: (target: unknown) => { for (const handler of [...handlers]) handler({target}); },
      listeners: () => handlers.size,
    };
  }
  function enterButton(disabled = false) {
    const calls = {clicks: 0, focused: 0, scrolled: 0};
    return {
      disabled, calls,
      click() { calls.clicks += 1; },
      focus() { calls.focused += 1; },
      scrollIntoView() { calls.scrolled += 1; },
    };
  }
  const timers = () => {
    const queue: (() => void)[] = [];
    return {queue, setTimer: (fn: () => void) => { queue.push(fn); return queue.length; },
      clearTimer: (handle: unknown) => { queue[(handle as number) - 1] = () => {}; },
      fire: () => { for (const fn of queue.splice(0)) fn(); }};
  };

  it('puts the button in view and under focus, and spends the next background tap on it', () => {
    const document = page(), button = enterButton(), clock = timers(), states: string[] = [];
    const reentry = armXrReentryTap({document, button, onState: state => states.push(state),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer});
    expect(button.calls.focused).toBe(1);
    expect(button.calls.scrolled).toBe(1);
    expect(states).toEqual(['armed']);
    document.tap({closest: () => null});
    expect(button.calls.clicks).toBe(1);
    expect(states).toEqual(['armed', 'tapped']);
    expect(reentry.armed()).toBe(false);
    expect(document.listeners()).toBe(0);
    // A second tap is the page's own again.
    document.tap({closest: () => null});
    expect(button.calls.clicks).toBe(1);
  });

  it('leaves a tap on a control alone, and stays armed for the next one', () => {
    const document = page(), button = enterButton(), clock = timers();
    armXrReentryTap({document, button, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
    document.tap({closest: () => ({})});
    expect(button.calls.clicks).toBe(0);
    document.tap({closest: () => null});
    expect(button.calls.clicks).toBe(1);
  });

  it('wastes no tap while entry is unavailable', () => {
    const document = page(), button = enterButton(true), clock = timers();
    const reentry = armXrReentryTap({document, button, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
    document.tap({closest: () => null});
    expect(button.calls.clicks).toBe(0);
    expect(reentry.armed()).toBe(true);
    button.disabled = false;
    document.tap({closest: () => null});
    expect(button.calls.clicks).toBe(1);
  });

  it('expires, and disarming twice is harmless', () => {
    const document = page(), button = enterButton(), clock = timers(), states: string[] = [];
    const reentry = armXrReentryTap({document, button, onState: state => states.push(state),
      setTimer: clock.setTimer, clearTimer: clock.clearTimer});
    clock.fire();
    expect(states).toEqual(['armed', 'expired']);
    expect(document.listeners()).toBe(0);
    document.tap({closest: () => null});
    expect(button.calls.clicks).toBe(0);
    reentry.disarm();
    expect(states).toEqual(['armed', 'expired']);
  });
});

/**
 * What the companion needs to record the leg home.
 *
 * `viewer.mjs` records the `workbench` entry for the leg out and nothing
 * recorded the return, so a run on a headset showed the wearer going to Mol* and
 * then simply stopping. The detailed page is a stock Mol* document with none
 * of the headset page's modules in it, so the hint is the only thing that can
 * carry how long the wearer was away and which control brought them back.
 */
describe('what one consumed hint says about the trip', () => {
  it('reports the way out and how long the wearer was away', () => {
    const cells = storage();
    armXrReentry(cells, () => 1000, 'unload');
    expect(readXrReentry(cells, () => 9000)).toEqual({fresh: true, via: 'unload', awayMs: 8000});
  });

  it('reports an expired hint as a trip, not as nothing at all', () => {
    const cells = storage();
    armXrReentry(cells, () => 1000, 'recall');
    // Four minutes over in Mol* is exactly the stranding this guards against,
    // and the companion must still be able to log it even though the one-tap
    // shortcut is long gone.
    const stale = readXrReentry(cells, () => 1000 + XR_REENTRY_MAX_AGE_MS + 1);
    expect(stale.fresh).toBe(false);
    expect(stale.via).toBe('recall');
    expect(stale.awayMs).toBe(XR_REENTRY_MAX_AGE_MS + 1);
    expect(cells.size()).toBe(0);
  });

  it('says nothing about a page that simply loaded', () => {
    expect(readXrReentry(storage(), () => 1000)).toEqual({fresh: false});
    expect(readXrReentry(refusing, () => 1000)).toEqual({fresh: false});
    // An old hint written before `via` existed still arms, and reads as the
    // link, which is the only way one could have been written then.
    const legacy = storage({[XR_REENTRY_KEY]: JSON.stringify({at: 1000})});
    expect(readXrReentry(legacy, () => 2000)).toEqual({fresh: true, via: 'back-link', awayMs: 1000});
  });
});
