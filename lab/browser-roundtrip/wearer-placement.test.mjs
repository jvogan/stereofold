import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTION_FULL_MS, captionExpanded, createPlacementHold, latchedStandoff } from './wearer-placement.mjs';
// The size words a wearer says, through the same two tables the headset
// reads.
import { spatialVoiceAction } from './voice-command-runner.mjs';

test('a spoken size word is several steps, in the direction it names', () => {
  for (const [phrase, direction, steps] of [
    ['make it small', -1, 3], ['small', -1, 3], ['make it big', 1, 3], ['big', 1, 3],
    ['huge', 1, 6], ['make it huge', 1, 6], ['tiny', -1, 6], ['much bigger', 1, 6], ['much smaller', -1, 6],
    ['too big', -1, 3], ['too small', 1, 3],
  ]) {
    const resolved = spatialVoiceAction(phrase);
    assert.equal(resolved?.action?.kind, 'scale', `${phrase} must be a size change`);
    assert.equal(resolved.action.direction, direction, phrase);
    assert.equal(resolved.action.steps, steps, phrase);
  }
});

test('the comparatives already supported stay one step', () => {
  for (const phrase of ['smaller', 'smaller please', 'make it smaller', 'bigger', 'a bit smaller']) {
    const resolved = spatialVoiceAction(phrase);
    assert.equal(resolved?.action?.kind, 'scale', phrase);
    assert.equal(resolved.action.steps, undefined, `${phrase} is a nudge, not a size`);
  }
});

test('the short move, turn and reset forms all resolve to an action', () => {
  for (const [phrase, kind] of [
    ['move it left', 'move'], ['move it right', 'move'], ['move it up', 'move'], ['move it down', 'move'],
    ['move it closer', 'move'], ['move it away', 'move'], ['turn it', 'toggle-motion'],
    ['turn it around', 'turn'], ['reset', 'reset'], ['recenter', 'recenter-structure'],
  ]) {
    assert.equal(spatialVoiceAction(phrase)?.action?.kind, kind, phrase);
  }
});

test('a fresh hold lets a chapter frame and lets an authored placement land', () => {
  const hold = createPlacementHold();
  assert.equal(hold.allowsChapterFraming(), true);
  assert.equal(hold.holdsPlacement(), false);
});

test('a wearer move suspends automatic framing for that chapter only', () => {
  const hold = createPlacementHold();
  hold.chapterStart();
  hold.takeover('grab');
  assert.equal(hold.allowsChapterFraming(), false, 'the chapter the wearer moved in may not reframe');
  hold.chapterStart();
  assert.equal(hold.allowsChapterFraming(), true, 'the next chapter frames normally');
});

test('a wearer move outranks an authored placement until the seat is handed back', () => {
  const hold = createPlacementHold();
  hold.takeover('grab');
  assert.equal(hold.holdsPlacement(), true);
  hold.chapterStart();
  assert.equal(hold.holdsPlacement(), true, 'turning the page does not give the placement back');
  hold.release('reset-view');
  assert.equal(hold.holdsPlacement(), false);
  assert.equal(hold.allowsChapterFraming(), true);
});

test('the hold state carries the reason and the move count for the record ring', () => {
  const hold = createPlacementHold({ now: () => 1234 });
  hold.takeover('voice-move');
  hold.takeover('grab');
  const state = hold.state();
  assert.equal(state.reason, 'grab');
  assert.equal(state.moves, 2);
  assert.equal(state.at, 1234);
  assert.equal(state.held, true);
});

test('a latched stand-off never moves the menu, whatever the structure does', () => {
  assert.equal(latchedStandoff({ current: 0.3, required: 1.2, latched: true }), 0.3);
  assert.equal(latchedStandoff({ current: 0.3, required: 0, latched: true }), 0.3);
});

test('an unlatched stand-off takes the measurement, rounded up to a step', () => {
  assert.equal(Number(latchedStandoff({ current: 0, required: 0.11, latched: false }).toFixed(2)), 0.15);
  assert.equal(latchedStandoff({ current: 0.3, required: 0.29, latched: false }), 0.3, 'inside the release band it holds');
  assert.equal(Number(latchedStandoff({ current: 0.3, required: 0.01, latched: false }).toFixed(2)), 0.05);
  assert.equal(latchedStandoff({ current: 0.3, required: Number.NaN, latched: false }), 0.3);
});

test('the caption shows its full text only while held, playing, or just after a chapter', () => {
  assert.equal(captionExpanded({ talking: true, nowMs: 10_000, chapterStartedAt: 0 }), true);
  assert.equal(captionExpanded({ playing: true, nowMs: 10_000, chapterStartedAt: 0 }), true);
  assert.equal(captionExpanded({ nowMs: 100, chapterStartedAt: 0 }), true);
  assert.equal(captionExpanded({ nowMs: CAPTION_FULL_MS - 1, chapterStartedAt: 0 }), true);
  assert.equal(captionExpanded({ nowMs: CAPTION_FULL_MS, chapterStartedAt: 0 }), false, 'half open at the far end');
  assert.equal(captionExpanded({ nowMs: 10_000 }), false, 'no chapter, no window');
});
