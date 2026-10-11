/**
 * The per-strand lightness steps, as arithmetic.
 *
 * The wall tier's whole-structure chapters shade each protofilament by
 * lightness only, so the three strands are countable while alpha stays blue
 * and beta stays amber. These run the checked-in wall.json through the real
 * plan entry point, so the rule is tested against what actually ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  STRAND_BASE_ALPHA, STRAND_BASE_BETA, STRAND_LIGHTNESS_STEPS,
  hexToHsl, hslToHex, shadeHex, wallStrandIndex, applyWallStrandShades,
} from './strand-shade.mjs';
import { planLessonEmphasis } from './lesson-emphasis.mjs';

const wall = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../plugin/demos/microtubule-growth/wall.json'), 'utf8'));
const chapter = (id) => wall.chapters.find((entry) => entry.id === id).immersive.emphasis;

test('hex conversion round-trips the two base colours exactly', () => {
  for (const base of [STRAND_BASE_ALPHA, STRAND_BASE_BETA]) {
    const { h, s, l } = hexToHsl(base);
    assert.equal(hslToHex({ h, s, l }), base);
  }
  assert.throws(() => hexToHsl('blue'), /Not a hex colour/);
});

test('the steps move lightness only, about twelve points each way', () => {
  for (const base of [STRAND_BASE_ALPHA, STRAND_BASE_BETA]) {
    const before = hexToHsl(base);
    const lighter = hexToHsl(shadeHex(base, STRAND_LIGHTNESS_STEPS[1]));
    const darker = hexToHsl(shadeHex(base, STRAND_LIGHTNESS_STEPS[2]));
    assert.ok(Math.abs(lighter.h - before.h) < 0.5, `hue held for ${base}`);
    assert.ok(Math.abs(darker.h - before.h) < 0.5, `hue held for ${base}`);
    assert.ok(Math.abs(lighter.s - before.s) < 0.02, `saturation held for ${base}`);
    assert.ok(Math.abs((lighter.l - before.l) - 0.12) < 0.005, `lighter step for ${base}`);
    assert.ok(Math.abs((darker.l - before.l) + 0.12) < 0.005, `darker step for ${base}`);
  }
});

test('the steps land on the documented hex values', () => {
  assert.equal(shadeHex(STRAND_BASE_ALPHA, 0), '#4a90e2');
  assert.equal(shadeHex(STRAND_BASE_ALPHA, 0.12), '#7fb0ea');
  assert.equal(shadeHex(STRAND_BASE_ALPHA, -0.12), '#2171ce');
  assert.equal(shadeHex(STRAND_BASE_BETA, 0), '#f5a623');
  assert.equal(shadeHex(STRAND_BASE_BETA, 0.12), '#f8be5e');
  assert.equal(shadeHex(STRAND_BASE_BETA, -0.12), '#d1860a');
});

test('every wall part maps to its own strand, ligands to the front one', () => {
  const parts = wall.chapters[0].immersive.emphasis.parts;
  assert.equal(parts.length, 14);
  for (const part of parts) {
    const strand = wallStrandIndex(part);
    if (part.id.startsWith('middle-')) assert.equal(strand, 1, part.id);
    else if (part.id.startsWith('new-')) assert.equal(strand, 2, part.id);
    else assert.equal(strand, 0, part.id);
  }
  assert.equal(new Set(parts.map(wallStrandIndex)).size, 3);
});

test('without the flag the parts pass through untouched', () => {
  const parts = chapter('orbit').parts;
  assert.equal(applyWallStrandShades(parts, false), parts);
  assert.equal(applyWallStrandShades(parts), parts);
});

test('only the two whole-wall chapters carry the flag', () => {
  assert.equal(chapter('reveal').strandShades, true);
  assert.equal(chapter('wide').strandShades, true);
  for (const id of ['orbit', 'highlight', 'site']) {
    assert.equal(chapter(id).strandShades, undefined, id);
  }
});

test('a whole-wall plan paints six colours, two hues in three lightnesses', () => {
  // A stub structure: one row per wall chain, so every part resolves.
  const chains = [...new Set(chapter('reveal').parts.map((part) => part.chain))];
  const rows = (chain) => [`${chain}:1`];
  const resolveKeys = ({ chain }) => (chain ? rows(chain) : []);
  const every = chains.flatMap(rows);
  const plan = planLessonEmphasis(chapter('reveal'), resolveKeys, every);
  assert.deepEqual(plan.faded, []);
  assert.deepEqual([...new Set(plan.colours.map((part) => part.color))].sort(),
    ['#2171ce', '#4a90e2', '#7fb0ea', '#d1860a', '#f5a623', '#f8be5e'].sort());
  // Hue check per strand: each shaded colour sits within half a degree of base.
  for (const part of plan.colours) {
    const base = part.color === '#4a90e2' || part.color === '#7fb0ea' || part.color === '#2171ce'
      ? STRAND_BASE_ALPHA : STRAND_BASE_BETA;
    assert.ok(Math.abs(hexToHsl(part.color).h - hexToHsl(base).h) < 0.5, part.id);
  }
});

test('a part chapter plan keeps its exact authored colours', () => {
  const chains = [...new Set(chapter('orbit').parts.map((part) => part.chain))];
  const rows = (chain) => [`${chain}:1`];
  const resolveKeys = ({ chain }) => (chain ? rows(chain) : []);
  const every = chains.flatMap(rows);
  const plan = planLessonEmphasis(chapter('orbit'), resolveKeys, every);
  for (const part of plan.colours) {
    assert.ok([STRAND_BASE_ALPHA, STRAND_BASE_BETA].includes(part.color), `${part.id} kept ${part.color}`);
  }
});
