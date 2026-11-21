import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

// A headset chapter that lights a site inside a faded structure draws the
// structure as a faded cartoon and the site's residues as figure sticks, as
// the telomerase and CRISPR site chapters do. The haemoglobin heme chapters
// drew all 4,779 atoms of 4HHB as ball-and-stick behind the fade instead.
// Measured on a Quest 2: chapter 4 took 18.5 ms of app GPU time a frame
// (44 frames a second) and chapter 5 21.8 ms (36). With the fade made solid
// the same sticks still took 11.4 ms (67 to 68), and the fade over a cartoon
// took 3.2 ms (72). The sticks of the whole structure, not the fade, were
// what the frame could not afford.

const demos = new URL('../demos/', import.meta.url);
const lessonFiles = (dir = ''): string[] => readdirSync(new URL(dir, demos), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? lessonFiles(`${dir}${entry.name}/`)
    : entry.name.endsWith('.json') && !/recipe|^index\.json$/u.test(entry.name) ? [`${dir}${entry.name}`] : []);
type Chapter = { id: string; immersive?: { appearance?: { representation?: string };
  emphasis?: { parts?: { id: string; chain: string; residues?: { from: number; to: number } }[]; focus?: string[]; contextOpacity?: number };
  figure?: { layers: { target: { chain: string; residues?: { from: number; to: number }; componentId?: string }; representation: string }[] } } };
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, demos), 'utf8')) as { chapters?: Chapter[] };

it('lights no headset site inside a whole structure drawn as faded sticks', () => {
  const offending: string[] = [];
  for (const rel of lessonFiles()) {
    let representation: string | undefined;
    for (const chapter of read(rel).chapters ?? []) {
      representation = chapter.immersive?.appearance?.representation ?? representation;
      const emphasis = chapter.immersive?.emphasis;
      if (representation === 'ball-and-stick' && emphasis?.focus?.length && (emphasis.contextOpacity ?? 0.12) < 1)
        offending.push(`${rel}#${chapter.id}`);
    }
  }
  expect(offending).toEqual([]);
});

it('keeps every lit heme chapter part drawn as sticks on the haemoglobin cartoon', () => {
  const chapters = read('hemoglobin.json').chapters!;
  for (const [id, focus] of [['site', ['heme-a', 'heme-b', 'heme-c', 'heme-d']], ['pocket', ['heme-a', 'his-f8']]] as const) {
    const chapter = chapters.find(entry => entry.id === id)!;
    const { appearance, emphasis, figure } = chapter.immersive!;
    expect(appearance?.representation).toBe('cartoon');
    expect(emphasis?.focus).toEqual(focus);
    // Each lit part is drawn by one stick layer on exactly its residues.
    for (const partId of focus) {
      const part = emphasis!.parts!.find(entry => entry.id === partId)!;
      const layers = figure!.layers.filter(layer => layer.target.chain === part.chain
        && layer.target.residues?.from === part.residues!.from && layer.target.residues?.to === part.residues!.to);
      expect(layers.map(layer => layer.representation), partId).toEqual(['ball-and-stick']);
    }
    expect(figure!.layers).toHaveLength(focus.length);
  }
});
