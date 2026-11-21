/**
 * When no card seat clears a lesson chapter, `clearChapterMenu` keeps the card
 * anyway at the seat whose rank comes first. How much of the chapter a seat
 * covers decides before the full card and the top band, so a short or bottom
 * card beside the molecule beats a full card on it. A card that keeps its
 * caption in whole sentences decides before that cover.
 *
 * The figures are the ones the ATP rotor recorded in the emulated Quest 2.
 * Its rotor chapter kept a full top card over its faded head (covered 0.035,
 * controls 0.0241) when the short top card covered only its controls'
 * 0.0241. Its distance chapter kept a full top card on the head.
 *
 * The rank is evaluated from the page source itself, as the seat loop runs it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const menu = pageFunction(readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8'), 'clearChapterMenu');
const rankText = /const order = (\[[^\]]*\]);/u.exec(menu)?.[1];
const earlierText = /const earlier = (\(a, b\) => \{[^}]*\});/u.exec(menu)?.[1];
assert.ok(rankText && earlierText, 'the kept-card rank and comparison are found in clearChapterMenu');
const rankOf = vm.runInNewContext(`(({ shown, seat, status, named, covers, controlCover, rank, lines }) => ${rankText})`);
const earlier = vm.runInNewContext(earlierText);
const order = card => rankOf({
  shown: card, seat: card, status: card.statusCovers === true, lines: card.lines ?? 1,
  controlCover: card.controlCover ?? 0, rank: () => card.rank ?? 0,
  named: { spheres: card.crossesPlates ? [{}] : [] },
  covers: (_, field) => field ? (card.crossesPlates ? 1 : 0) : card.covered ?? 0,
});
const first = cards => cards.reduce((kept, card) => !kept || earlier(order(card), order(kept)) ? card : kept, undefined);

test('a short card that covers less beats a full card over the ATP rotor chapter', () => {
  const full = { id: 'full-top', controlCover: .0241, covered: .035 };
  const short = { id: 'short-top', controlCover: .0241, covered: .0241, shortCard: true };
  assert.equal(first([full, short]).id, 'short-top');
  assert.equal(first([short, full]).id, 'short-top');
});

test('a bottom card clear of the molecule beats a top card on its head', () => {
  assert.equal(first([{ id: 'top', covered: .003 }, { id: 'bottom', covered: 0, rank: 2 }]).id, 'bottom');
});

test('equal cover keeps the full card, then the top band', () => {
  assert.equal(first([{ id: 'short', covered: .01, shortCard: true }, { id: 'full', covered: .01 }]).id, 'full');
  assert.equal(first([{ id: 'bottom', covered: .01, rank: 2 }, { id: 'top', covered: .01 }]).id, 'top');
});

test('status cover, crossed name plates and covered controls still decide before the chapter cover', () => {
  assert.equal(first([{ id: 'over-status', statusCovers: true }, { id: 'covers', covered: .2 }]).id, 'covers');
  assert.equal(first([{ id: 'over-plate', crossesPlates: true }, { id: 'covers', covered: .2 }]).id, 'covers');
  assert.equal(first([{ id: 'over-controls', controlCover: .05 }, { id: 'covers', controlCover: .01, covered: .2 }]).id, 'covers');
});

// Kinesin's first chapter kept the title over one caption line because it
// covered less, and read `Pink and green heads trade…`, then `the lead, hand
// over hand.` A card one line taller held the sentence whole.
test('a card that keeps its sentences whole beats a one-line card that splits one, though that covers less', () => {
  const split = { id: 'one-line', covered: 0, shortCard: true, splitsSentence: true };
  const whole = { id: 'two-line', covered: .004, shortCard: true };
  assert.equal(first([split, whole]).id, 'two-line');
  assert.equal(first([whole, split]).id, 'two-line');
  assert.equal(first([split, { id: 'full', covered: .02 }]).id, 'full');
});

test('text on a name plate or the controls still loses to a card that splits a sentence', () => {
  assert.equal(first([{ id: 'whole-over-plate', crossesPlates: true }, { id: 'split', splitsSentence: true, covered: .2 }]).id, 'split');
  assert.equal(first([{ id: 'whole-over-controls', controlCover: .05 }, { id: 'split', splitsSentence: true, controlCover: .01 }]).id, 'split');
});
