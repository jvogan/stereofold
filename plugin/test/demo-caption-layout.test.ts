import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { captionLine, wearerPages } from '../src/tour-player.js';
// @ts-ignore Shared production structure readout.
import { structureDescriptionPages } from '../../lab/browser-roundtrip/structure-subject.mjs';
// @ts-ignore Execute the production toolbar with only its GPU boundary replaced.
import { toolbarFrameRuntime } from '../../lab/browser-roundtrip/fixtures/toolbar-frame-runtime.mjs';
// @ts-ignore Shared production layout, with measured Arial glyph advances.
import { createToolbarPanel } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';
// @ts-ignore Shared production menu rows.
import { spatialToolbarRows } from '../../lab/browser-roundtrip/spatial-toolbar-content.mjs';

const root = new URL('../demos/', import.meta.url);
const metrics = JSON.parse(readFileSync(new URL('../../lab/browser-roundtrip/fixtures/toolbar-bold-font-metrics.json', import.meta.url), 'utf8'));
const runtime = await toolbarFrameRuntime(undefined, { glyphAdvances: metrics.advances });
const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] };
const glyphs = (text: string) => text.replace(/[\s…]/gu, '');
const cardPages = (draw: (page: number) => any) => {
  const first = draw(0);
  return Array.from({ length: first.readoutPageCount }, (_, page) => page === 0 ? first : draw(page));
};

function draw(title: string, bodyPage: string, bodyPageIndex = 0, bodyPageCount = 1, collapsed = true, preview = false, readoutPage = 0) {
  const tour = { active: true, selectedId: 'lesson-caption-test', title, bodyPage, bodyPageIndex, bodyPageCount, autoplay: true, ...(preview ? { chapterPreview: { title, bodyPage, progress: 'Scene 2 / 9' } } : {}) };
  return createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed, tour }),
    readoutPage, readout: runtime.tourReadout(tour), measureText: runtime.toolbarTextWidth });
}

// What a wearer sees of the structure itself under the chapter title: the names
// the viewer reads off the loaded entry, from one word to a long deposited title.
// The three long ones are the deposited titles of the shipped demos.
const entry = { pdbId: '4HHB', chains: 4, assembly: 'asymmetric_unit', selectionCount: 0, representation: 'cartoon', color: 'chain-id' };
const subjects = [
  { ...entry, title: 'Crambin' },
  { ...entry, title: 'Human deoxyhaemoglobin' },
  { ...entry, pdbId: '9KJ6', title: 'SpCas9 ternary complex, amino acids (1242-1263) replaced with Gly-Ser linker' },
  { ...entry, pdbId: '8OUE', chains: 10, title: 'The H/ACA RNP lobe of human telomerase with the dyskerin thumb loop in a semi-closed conformation' },
];
const deg = (radians: number) => radians * 180 / Math.PI;
const source = (value: string) => new Set(value.split(/\s+/u).filter(Boolean).flatMap(word => word.match(/[^/-]+[/-]?/gu) ?? [word]));

// The card's first line: the chapter title and where it stands in the lesson.
const titleLine = (title: string) => `${title} · 1/6`;

// The card as the wearer reads it, `nowMs` after a chapter stamped at 0: a second
// in, while the scene is still arriving, or long after it has settled, which is
// what a wearer stepping with Next sees for most of every chapter.
function drawLive(title: string, page: string, index: number, count: number, subject: object | undefined, nowMs = 1000, readoutPage = 0) {
  const tour = { active: true, selectedId: 'lesson-caption-test', selectedTitle: 'A lesson', title, progress: 'Scene 1 / 6', step: 0, total: 6,
    bodyPage: page, bodyPageIndex: index, bodyPageCount: count, chapterStartedAt: 0 };
  return createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed: true, tour }),
    readoutPage, readout: runtime.tourReadout(tour, subject, nowMs), measureText: runtime.toolbarTextWidth });
}

// Every corner of the card's glass, in degrees, as each eye sees it. `turned` aims the
// head level at the menu first, which is how the resting card is read; the chapter card
// is read straight ahead.
function glassAngles(panel: any, turned: boolean) {
  const glass = panel.captionBacking;
  const length = Math.hypot(panel.anchor[0], panel.anchor[2]);
  const forward = turned ? [panel.anchor[0] / length, 0, panel.anchor[2] / length] : [0, 0, -1];
  const right = [-forward[2], 0, forward[0]];
  const out: { azimuth: number; elevation: number; cone: number }[] = [];
  for (const eye of [-0.032, 0.032]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const corner = glass.point.map((value: number, axis: number) => value + sx * glass.halfWidth * glass.right[axis] + sy * glass.halfHeight * glass.up[axis]);
    const v = [corner[0] - eye * right[0], corner[1] - 1.6, corner[2] - eye * right[2]];
    const depth = v[0] * forward[0] + v[2] * forward[2], lateral = v[0] * right[0] + v[2] * right[2];
    out.push({ azimuth: Math.abs(deg(Math.atan2(lateral, depth))), elevation: Math.abs(deg(Math.atan2(v[1], Math.hypot(lateral, depth)))),
      cone: deg(Math.atan2(Math.hypot(lateral, v[1]), depth)) });
  }
  return out;
}

// One card, judged as a Quest 2 wearer would: whole words, no fragments, inside
// the eye, readable type. `allowed` is every word the card may draw.
function expectReadableCard(panel: any, allowed: string, label: string) {
  const rows: string[] = panel.readoutPoints.map((row: { text: string }) => row.text);
  const font = panel.readoutFontMeters, glass = panel.captionBacking;
  const known = source(allowed.replaceAll('…', ''));
  for (const row of rows) {
    expect(row, `${label}: a fragment row`).not.toMatch(/^…|^·|·$/u);
    for (const token of source(row.replace(/…$/u, ''))) expect(known.has(token), `${label}: ${token} was cut out of a word in ${JSON.stringify(rows)}`).toBe(true);
    expect(runtime.toolbarTextWidth(row) * font, `${label}: ${row} runs past the glass`).toBeLessThanOrEqual(glass.halfWidth * 2 + 1e-6);
  }
  // Both eyes see every corner of the glass inside the 42 degree half field.
  for (const { azimuth, elevation, cone } of glassAngles(panel, false)) {
    expect(azimuth, `${label}: azimuth`).toBeLessThanOrEqual(42);
    expect(elevation, `${label}: elevation`).toBeLessThanOrEqual(45);
    // The structure keeps the central cone: a framed molecule is 13 to 20 degrees
    // across its half, so the card stays clear of it at 28 degrees and more.
    expect(cone, `${label}: card against the molecule's cone`).toBeGreaterThanOrEqual(28);
  }
  // 20 pixels per degree: a cap of 1 degree is 20 pixels tall.
  const centre = glass.point.map((value: number, axis: number) => value - [0, 1.6, 0][axis]);
  expect(deg(Math.atan2(font * 0.58, Math.hypot(...centre))), `${label}: cap height in degrees`).toBeGreaterThanOrEqual(1);
  return rows;
}

describe('shipped demo captions in the headset layout', () => {
  for (const file of readdirSync(root, { recursive: true }).filter(name => String(name).endsWith('.json'))) {
    const input = JSON.parse(readFileSync(new URL(String(file), root), 'utf8'));
    if (!Array.isArray(input.chapters)) continue; // index and composite recipes
    const tour = molecularLessonToTour(input);
    for (const step of tour.steps) it(`${file} / ${step.id} draws every caption glyph`, () => {
      const pages = wearerPages(step);
      expect(glyphs(pages.join(' '))).toBe(glyphs(captionLine(step)));
      for (const collapsed of [true, false]) for (const preview of [false, true]) for (const [index, page] of pages.entries()) {
        const panels = cardPages(p => draw(step.title, page, index, pages.length, collapsed, preview, p));
        const bodyRows = panels.flatMap(panel => panel.readoutPoints.filter((row: { forwardView?: boolean }) => !row.forwardView));
        const shown = bodyRows.map((row: { text: string }) => row.text).join(' ');
        expect(glyphs(shown), `menu collapsed=${collapsed}, preview=${preview}, page ${index + 1}`).toContain(glyphs(page));
        for (const panel of panels) expect(panel.readoutPoints.length).toBeLessThanOrEqual(4);
      }
    });
  }

  // The chapter card used to show its caption for a four-second reading window and
  // then settle on the structure's own lines, clipped: `Human` over `…`, `SpCas9
  // ternary` over `complex,…`. Every page of every chapter of every demo, a second
  // in and settled, under the deposited titles of the shipped demos, now draws the
  // chapter title and the whole page, in whole words, inside the eye and clear of
  // the molecule, and nothing of the structure.
  const lessons = readdirSync(root, { recursive: true }).filter(name => String(name).endsWith('.json'))
    .map(file => ({ file: String(file), input: JSON.parse(readFileSync(new URL(String(file), root), 'utf8')) }))
    .filter(({ input }) => Array.isArray(input.chapters));
  for (const { file, input } of lessons) {
    const tour = molecularLessonToTour(input);
    for (const step of tour.steps) it(`${file} / ${step.id} keeps its whole caption on the settled card`, () => {
      const pages = wearerPages(step);
      for (const [index, page] of pages.entries()) {
        const caption = index < pages.length - 1 ? `${page}…` : page;
        for (const [nowMs, subject] of [[1000, subjects[1]], [60_000, subjects[0]], [60_000, subjects[2]], [60_000, subjects[3]]] as const) {
          const panels = cardPages(p => drawLive(step.title, page, index, pages.length, subject, nowMs, p));
          const label = `${step.id} page ${index + 1}, ${nowMs} ms, ${subject.title.slice(0, 12)}`;
          const rows = panels.map(panel => expectReadableCard(panel, [titleLine(step.title), page].join(' '), label));
          // Every card page opens on the title line and carries the caption on
          // its other three lines.
          for (const page of rows) expect([titleLine(step.title), step.title], `${label}: ${JSON.stringify(rows)}`).toContain(page[0]);
          expect(glyphs(rows.flatMap(page => page.slice(1)).join('')), `${label}: ${JSON.stringify(rows)}`).toBe(glyphs(caption));
          for (const panel of panels) expect(panel.readoutPoints.length).toBeLessThanOrEqual(4);
        }
      }
    });
  }

  it('draws the five longest captions whole or in clean pages, and says how long they are', () => {
    const all = lessons.flatMap(({ file, input }) => molecularLessonToTour(input).steps.map(step => ({ file, step, line: captionLine(step) })));
    const longest = all.sort((a, b) => b.line.length - a.line.length).slice(0, 5);
    expect(longest[0].line.length).toBeGreaterThan(150);
    for (const { file, step, line } of longest) {
      const pages = wearerPages(step);
      expect(glyphs(pages.join(' ')), `${file} / ${step.id}`).toBe(glyphs(line));
      for (const [index, page] of pages.entries()) {
        const panels = cardPages(p => drawLive(step.title, page, index, pages.length, undefined, 60_000, p));
        const rows = panels.flatMap(panel => expectReadableCard(panel, [titleLine(step.title), page].join(' '), `${file} / ${step.id} page ${index + 1}`));
        // A page ends on a whole word, and only a page that continues ends on the mark.
        expect(rows.at(-1)!.endsWith('…'), `${file} / ${step.id} page ${index + 1} of ${pages.length}`).toBe(index < pages.length - 1);
      }
    }
  });

  // A hidden chapter card leaves its labelled figure clear. Source metadata
  // returns through the explicit chooser rather than replacing that card.
  for (const subject of subjects) it(`${subject.pdbId} ${subject.title.slice(0, 20)}: a hidden card stays absent while loading and showing its figure`, () => {
    const tour = { active: true, selectedId: 'lesson-caption-test', selectedTitle: 'A lesson', title: 'Wide reveal', captionCard: 'hidden', progress: 'Scene 1 / 6', step: 0, total: 6 };
    for (const state of [tour, { ...tour, active: false, navigating: true },
      { ...tour, chapterPreview: { title: 'Next figure', bodyPage: 'Preparation', progress: 'Scene 2 / 6' } }]) {
      const readout = runtime.tourReadout(state, subject);
      expect(readout).toEqual([]);
      const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed: true, tour: state }), readout, measureText: runtime.toolbarTextWidth });
      expect(panel.readoutPoints).toEqual([]);
      expect(panel.captionBacking).toBeUndefined();
    }
    const chooser = runtime.tourReadout({ ...tour, menuOpen: true }, subject);
    expect(chooser[0].text).toBe('A lesson');
    const descriptions = structureDescriptionPages(subject);
    const shown = descriptions.map((description: string, descriptionPage: number) => {
      const page = runtime.tourReadout({ ...tour, menuOpen: true }, subject, undefined, { descriptionPage });
      const line = page.find((line: any) => glyphs(line.text) === glyphs(description));
      expect(line).toBeDefined();
      return line.text;
    });
    expect(glyphs(shown.join(''))).toBe(glyphs(subject.title));
  });

  it('keeps the reported flipbook opening phrase through its last word', () => {
    const original = "Kinesin's steps, one at a time.";
    const panel = draw('The track', original);
    expect(panel.readoutPoints.map((row: { text: string }) => row.text).join(' ')).toContain(original);
  });
});
