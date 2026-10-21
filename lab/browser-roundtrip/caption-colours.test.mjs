/**
 * A caption that names a colour the wearer cannot find is a wrong caption.
 *
 * "Orange is the guide RNA" played over a pink RNA, and "the recognition lobe
 * in purple" over a pink lobe: the lesson's framing selected the part it lit,
 * and the selection mark covered the authored colour. This reads every
 * caption and narration line in every shipped demo, takes each colour word,
 * and looks for it among the colours that chapter renders: the colour key as
 * the lesson paints it (focus, sub-range order and the lesson's own
 * selections included), the figure's colours, the ghost's uniform colour and
 * a density map's radial colours.
 *
 * The few lines that still name a colour the chapter does not draw are listed
 * in `UNPAINTED`, each with its reason, so a new one fails here and a fixed
 * one has to come off the list.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { mergeEmphasisColourLayers, planLessonEmphasis } from './lesson-emphasis.mjs';
import { composeOverpaintLayers, selectionPaintPlan, selectionSignature } from './selection-paint.mjs';
import { VOLUME_CROWN_COLOR, VOLUME_WALL_COLOR } from './volume-color.mjs';
import { CHAIN_COLOR_PARAMS } from './inspection-appearance.mjs';

const demos = new URL('../../plugin/demos/', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, demos), 'utf8'));

/** Lines whose colour the chapter does not draw, and why each stays. */
const UNPAINTED = Object.freeze({
  // Names the colour the next stage brings in ("say grow it").
  'microtubule-growth/monomer.json#wide narration amber': 'names the next stage',
});

const COLOUR_WORDS = /\b(red|orange|amber|yellow|gold|golden|green|teal|cyan|blue|purple|violet|magenta|pink|grey|gray|white)\b/gi;

function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

/** The colour words a wearer could fairly use for one drawn colour. */
export function colourWords(hex) {
  const { h, s, l } = hsl(hex);
  if (l >= 0.86) return new Set(['white']);
  if (s < 0.18 || l < 0.12) return new Set(['grey', 'gray']);
  const words = new Set();
  const band = (from, to, ...names) => { if (h >= from && h < to) for (const name of names) words.add(name); };
  band(0, 15, 'red'); band(345, 360, 'red', 'pink');
  band(8, 42, 'orange'); band(32, 52, 'amber', 'gold', 'golden'); band(45, 70, 'yellow', 'gold', 'golden');
  band(70, 170, 'green'); band(160, 200, 'teal', 'cyan'); band(190, 250, 'blue');
  band(245, 295, 'purple', 'violet'); band(285, 345, 'magenta', 'pink');
  return words;
}

function lessons() {
  const index = read('index.json'), out = new Map();
  for (const entry of index.demos) {
    for (const stage of [entry, ...(entry.stages ?? [])]) {
      const coordinates = stage.coordinates ?? entry.coordinates ?? {};
      out.set(stage.lesson, { density: Boolean(coordinates.volume) });
    }
  }
  return out;
}

/** Row keys per part. A whole chain runs past every residue any part names on
 * it, so a sub-range painted over its chain never stands for the whole chain. */
function keyResolver(parts) {
  const spans = new Map();
  for (const part of parts) {
    const span = spans.get(part.chain) ?? [1, 100];
    if (part.residues) { span[0] = Math.min(span[0], part.residues.from - 10); span[1] = Math.max(span[1], part.residues.to + 10); }
    spans.set(part.chain, span);
  }
  return ({ chain, residues }) => {
    const [from, to] = residues ?? spans.get(chain) ?? [1, 100];
    return Array.from({ length: to - from + 1 }, (_, i) => `${chain}:${from + i}`);
  };
}

/** Every colour this chapter draws, with the lesson's own selections applied. */
function renderedColours(chapter, { density }) {
  const immersive = chapter.immersive ?? {}, appearance = immersive.appearance ?? {};
  const emphasis = immersive.emphasis ?? {}, parts = emphasis.parts ?? [];
  const drawn = new Set();
  if (appearance.uniformColor) drawn.add(appearance.uniformColor.toLowerCase());
  if (appearance.color === 'chain') for (const value of CHAIN_COLOR_PARAMS.palette.params.list.colors)
    drawn.add(`#${value.toString(16).padStart(6, '0')}`);
  if (density) { drawn.add(VOLUME_WALL_COLOR); drawn.add(VOLUME_CROWN_COLOR); }
  for (const hex of JSON.stringify(immersive.figure ?? null).match(/#[0-9a-fA-F]{6}/g) ?? []) drawn.add(hex.toLowerCase());
  if (!parts.length) return drawn;
  const resolve = keyResolver(parts);
  const rowKeys = [...new Set(parts.flatMap(part => resolve({ chain: part.chain,
    residues: part.residues ? [part.residues.from, part.residues.to] : undefined })))];
  const plan = planLessonEmphasis({ parts, focus: emphasis.focus, alsoLit: emphasis.alsoLit,
    contextOpacity: emphasis.contextOpacity }, resolve, rowKeys);
  // The chapter's framing selects what it lights, then an authored selection
  // replaces it. Both are the lesson's, so neither is marked.
  const selections = [plan.lit, immersive.selection && resolve({ chain: immersive.selection.chain,
    residues: immersive.selection.residues && [immersive.selection.residues.from, immersive.selection.residues.to] })]
    .filter(keys => keys?.length);
  const selected = selections.at(-1) ?? [];
  const mark = selectionPaintPlan({ selectionKeys: selected, appearance,
    lessonColorKeys: plan.colours.flatMap(part => part.keys),
    lessonSelection: selected.length ? selectionSignature(selected) : undefined });
  const layers = composeOverpaintLayers(mergeEmphasisColourLayers(plan.colours)
    .map(layer => ({ keys: new Set(layer.keys), color: layer.color })),
  mark.keys.length ? { keys: new Set(mark.keys), color: mark.color } : undefined);
  const faded = new Set(plan.faded);
  for (const key of rowKeys) {
    if (faded.has(key)) continue;
    const top = layers.findLast(layer => layer.keys.has(key));
    if (top) drawn.add(top.color.toLowerCase());
  }
  return drawn;
}

test('every colour a caption names is a colour its chapter draws', () => {
  const found = {};
  for (const [path, info] of lessons()) {
    for (const chapter of read(path).chapters ?? []) {
      const drawn = [...renderedColours(chapter, info)];
      for (const [field, text] of [['caption', chapter.caption], ['narration', chapter.immersive?.narration]]) {
        for (const word of new Set((text ?? '').toLowerCase().match(COLOUR_WORDS) ?? [])) {
          if (drawn.some(hex => colourWords(hex).has(word))) continue;
          found[`${path}#${chapter.id} ${field} ${word}`] = drawn.join(' ');
        }
      }
    }
  }
  assert.deepEqual(Object.keys(found).sort(), Object.keys(UNPAINTED).sort(), JSON.stringify(found, null, 1));
});

test('the reported chapters draw the colour their captions name', () => {
  const crispr = read('crispr-cas9.json'), telomerase = read('telomerase-haca.json');
  const chapter = (lesson, id) => lesson.chapters.find(entry => entry.id === id);
  const words = (lesson, id) => new Set([...renderedColours(chapter(lesson, id), { density: false })]
    .flatMap(hex => [...colourWords(hex)]));
  assert.ok(words(crispr, 'guide-rna').has('orange'));
  assert.ok(!words(crispr, 'guide-rna').has('magenta'));
  assert.ok(words(crispr, 'recap-guide').has('orange'));
  for (const id of ['rec-lobe', 'recap-rec']) {
    assert.ok(words(crispr, id).has('purple'), id);
    assert.ok(!words(crispr, id).has('magenta'), id);
  }
  // The PAM is selected to be labelled and still reads yellow, on the blue
  // non-target strand the caption names.
  for (const id of ['target-dna', 'recap-dna']) {
    for (const word of ['magenta', 'yellow', 'blue']) assert.ok(words(crispr, id).has(word), `${id} ${word}`);
    assert.deepEqual(chapter(crispr, id).immersive.emphasis.alsoLit, ['nontarget'], id);
  }
  // The closing recap lights the whole key it recites, and the nucleases stay
  // its subject.
  const recap = chapter(crispr, 'recap-nucleases').immersive.emphasis;
  for (const word of ['grey', 'orange', 'magenta', 'blue', 'yellow', 'purple', 'green', 'red'])
    assert.ok(words(crispr, 'recap-nucleases').has(word), word);
  assert.deepEqual(recap.focus, chapter(crispr, 'nucleases').immersive.emphasis.focus);
  // Framed to fill, the nucleases put the lit complex at 90 degrees, where no
  // seat clears it and the menu and the closing card were hidden. The context
  // framing keeps them on the subject at 58 degrees with both seated.
  assert.equal(recap.framing, 'context');
  assert.ok(words(crispr, 'nucleases').has('red'));
  // Dyskerin's plate key is purple, and so is dyskerin.
  assert.deepEqual([...words(telomerase, 'site')].filter(word => word !== 'grey' && word !== 'gray'), ['purple', 'violet']);
});
