import { describe, expect, it } from 'vitest';
import { bindOpenedPanel, createPanelPairings, endPanelPairings, forgetPanelPairing, mayHoldPanel, movePanelPairing } from '../src/panel-pairing.js';

// Which pairing a headset panel is on decides which pages a revoke takes
// away. A panel gets one only from the attach the Mac answered over that
// pairing; a heartbeat can never give a page someone else's panel.
const session = (...panels: string[]) => { const known = new Set(panels); return { known, remembers: (id: string) => known.has(id) }; };
const a = { id: 'client-a' }, b = { id: 'client-b' };

describe('a panel tied to the pairing it was opened on', () => {
  it('ties nothing to a heartbeat, whatever panel it names', () => {
    const pairings = createPanelPairings(), { remembers } = session('page-a', 'cable-page');
    for (let n = 0; n < 1_000; n++) expect(movePanelPairing(pairings, b, `made-up-${n}`, remembers)).toBeUndefined();
    // A panel the session knows that no attach over a pairing opened: a cable or desktop page.
    expect(movePanelPairing(pairings, b, 'cable-page', remembers)).toBeUndefined();
    expect([pairings.holders.size, pairings.openers.size]).toEqual([0, 0]);
    expect(bindOpenedPanel(pairings, a, 'page-a', remembers)).toBe(true);
    for (let n = 0; n < 1_000; n++) movePanelPairing(pairings, b, `made-up-${n}`, remembers);
    expect([...pairings.holders]).toEqual([['page-a', 'client-a']]);
    expect([...pairings.openers.keys()]).toEqual(['page-a']);
  });

  it('binds only a panel the session knows, when the Mac issued it', () => {
    const pairings = createPanelPairings(), { remembers } = session('page-a');
    expect(bindOpenedPanel(pairings, a, 'gone-page', remembers)).toBe(false);
    expect(pairings.holders.size).toBe(0);
  });

  it('keeps a panel with its opener when another paired client beats with it', () => {
    const pairings = createPanelPairings(), { remembers } = session('page-a');
    bindOpenedPanel(pairings, { id: 'client-a', deviceId: 'headset-1' }, 'page-a', remembers);
    expect(movePanelPairing(pairings, { id: 'client-b', deviceId: 'headset-2' }, 'page-a', remembers)).toBeUndefined();
    expect(movePanelPairing(pairings, b, 'page-a', remembers)).toBeUndefined();
    expect(pairings.holders.get('page-a')).toBe('client-a');
    expect(mayHoldPanel(pairings, b, 'page-a')).toBe(false);
  });

  it('moves a panel to a later pairing of the opener’s remembered headset, and back to the opener', () => {
    const pairings = createPanelPairings(), { remembers } = session('page-a');
    const opener = { id: 'client-a', deviceId: 'headset-1' }, again = { id: 'client-a2', deviceId: 'headset-1' };
    bindOpenedPanel(pairings, opener, 'page-a', remembers);
    expect(movePanelPairing(pairings, again, 'page-a', remembers)).toBeTypeOf('function');
    expect(pairings.holders.get('page-a')).toBe('client-a2');
    expect(movePanelPairing(pairings, opener, 'page-a', remembers)).toBeTypeOf('function');
    expect(pairings.holders.get('page-a')).toBe('client-a');
    // An opener without a remembered headset has no later pairing to follow it.
    bindOpenedPanel(pairings, a, 'page-a', remembers);
    expect(movePanelPairing(pairings, { id: 'client-c' }, 'page-a', remembers)).toBeUndefined();
  });

  it('puts the previous holder back for a beat the Mac refused, unless the panel moved since', () => {
    const pairings = createPanelPairings(), { remembers } = session('page-a');
    const opener = { id: 'client-a', deviceId: 'headset-1' }, tab = { id: 'client-a2', deviceId: 'headset-1' }, third = { id: 'client-a3', deviceId: 'headset-1' };
    bindOpenedPanel(pairings, opener, 'page-a', remembers);
    expect(movePanelPairing(pairings, tab, 'page-a', remembers)!(false)).toBe('client-a');
    expect(pairings.holders.get('page-a')).toBe('client-a');
    const settle = movePanelPairing(pairings, tab, 'page-a', remembers)!;
    movePanelPairing(pairings, third, 'page-a', remembers);
    expect(settle(false)).toBeUndefined();
    expect(pairings.holders.get('page-a')).toBe('client-a3');
    // A panel no pairing held before the refused beat holds none after it.
    const bare = createPanelPairings();
    bindOpenedPanel(bare, opener, 'page-a', remembers); bare.holders.delete('page-a');
    movePanelPairing(bare, tab, 'page-a', remembers)!(false);
    expect(bare.holders.has('page-a')).toBe(false);
  });

  it('keeps a move when any beat of the moving client is accepted, in whatever order the answers come', () => {
    const { remembers } = session('page-a');
    const opener = { id: 'client-a', deviceId: 'headset-1' }, tab = { id: 'client-a2', deviceId: 'headset-1' };
    for (const order of ['first refused', 'second refused'] as const) {
      const pairings = createPanelPairings();
      bindOpenedPanel(pairings, opener, 'page-a', remembers);
      const first = movePanelPairing(pairings, tab, 'page-a', remembers)!, second = movePanelPairing(pairings, tab, 'page-a', remembers)!;
      if (order === 'first refused') { first(false); second(true); } else { second(true); first(false); }
      expect(pairings.holders.get('page-a'), order).toBe('client-a2');
    }
    // Every beat refused: the opener holds it again.
    const pairings = createPanelPairings();
    bindOpenedPanel(pairings, opener, 'page-a', remembers);
    const first = movePanelPairing(pairings, tab, 'page-a', remembers)!, second = movePanelPairing(pairings, tab, 'page-a', remembers)!;
    expect(first(false)).toBeUndefined();
    expect(second(false)).toBe('client-a');
    expect(pairings.holders.get('page-a')).toBe('client-a');
  });

  it('ignores an old refusal after the panel moved away and back', () => {
    const pairings = createPanelPairings(), { remembers } = session('page-a');
    const opener = { id: 'client-a', deviceId: 'headset-1' }, tab = { id: 'client-a2', deviceId: 'headset-1' };
    bindOpenedPanel(pairings, opener, 'page-a', remembers);
    const old = movePanelPairing(pairings, tab, 'page-a', remembers)!;
    movePanelPairing(pairings, opener, 'page-a', remembers)!(true);
    movePanelPairing(pairings, tab, 'page-a', remembers)!(true);
    expect(old(false)).toBeUndefined();
    expect(pairings.holders.get('page-a')).toBe('client-a2');
  });

  it('counts a panel as ended with its holder, unless that holder only had an unanswered beat moving it from a live pairing', () => {
    const { remembers } = session('page-a', 'page-b');
    const opener = { id: 'client-a', deviceId: 'headset-1' }, tab = { id: 'client-a2', deviceId: 'headset-1' };
    const pairings = createPanelPairings();
    bindOpenedPanel(pairings, opener, 'page-a', remembers);
    bindOpenedPanel(pairings, b, 'page-b', remembers);
    const settle = movePanelPairing(pairings, tab, 'page-a', remembers)!;
    // The tab's pairing ends with its beat unanswered: the opener, still paired, keeps the panel.
    expect(endPanelPairings(pairings, new Set(['client-a', 'client-a2', 'client-b']), new Set(['client-a', 'client-b']))).toEqual([]);
    expect(pairings.holders.get('page-a')).toBe('client-a');
    expect(settle(true)).toBeUndefined();
    expect(pairings.holders.get('page-a')).toBe('client-a');
    // Its own holder ending counts it, and forgets it.
    expect(endPanelPairings(pairings, new Set(['client-a', 'client-b']), new Set(['client-b']))).toEqual(['page-a']);
    expect(pairings.holders.has('page-a')).toBe(false);
    // An unanswered move from a holder that is gone too counts as ended.
    bindOpenedPanel(pairings, opener, 'page-a', remembers);
    movePanelPairing(pairings, tab, 'page-a', remembers);
    expect(endPanelPairings(pairings, new Set(['client-a2', 'client-b']), new Set(['client-b']))).toEqual(['page-a']);
  });

  it('drops the entries of panels the session no longer knows when it binds or moves the next one', () => {
    const pairings = createPanelPairings(), { known, remembers } = session('page-a', 'page-b');
    bindOpenedPanel(pairings, a, 'page-a', remembers);
    bindOpenedPanel(pairings, b, 'page-b', remembers);
    known.delete('page-a');
    bindOpenedPanel(pairings, b, 'page-b', remembers);
    expect([...pairings.holders]).toEqual([['page-b', 'client-b']]);
    expect([...pairings.openers.keys()]).toEqual(['page-b']);
    forgetPanelPairing(pairings, 'page-b');
    expect([pairings.holders.size, pairings.openers.size]).toEqual([0, 0]);
  });
});
