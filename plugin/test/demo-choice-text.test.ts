import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { replaceInspectionSourceSchema } from '../src/inspection-contract.js';
import { resolveDemoName } from '../src/demo-names.js';
import type { DemoIndex } from '../scripts/quest-demo.js';

const index = JSON.parse(await readFile(new URL('../demos/index.json', import.meta.url), 'utf8')) as DemoIndex;

describe('what an agent reads before it picks a demo', () => {
  it('sends "microtubule growth" to the arrival animation and "grow it into a tube" to the staged wall', async () => {
    const description = replaceInspectionSourceSchema.shape.demo.description ?? '';
    expect(description).toContain('"telomerase" opens telomerase-haca');
    expect(description).toContain('For "microtubule growth" use microtubule-arrival');
    expect(description).toContain('microtubule-growth opens on a finished wall that grow_structure grows into a tube');
    expect(index.demos.find(demo => demo.name === 'microtubule-arrival')!.title).toMatch(/^Microtubule growth: tubulin units build a wall/u);
    expect(index.demos.find(demo => demo.name === 'microtubule-growth')!.title).toBe('A microtubule wall you can grow into a tube');
    // The resolver itself reads the words "microtubule growth" as the id they
    // spell. Reaching the animation depends on the agent sending
    // microtubule-arrival, which is what the text above tells it to do.
    expect(resolveDemoName(index.demos, 'microtubule growth').demo.name).toBe('microtubule-growth');
    expect(resolveDemoName(index.demos, 'microtubule-arrival').demo.name).toBe('microtubule-arrival');
    for (const skill of ['stereo-structure', 'stereofold-setup', 'molecular-presentation']) {
      const text = (await readFile(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8')).replace(/\s+/gu, ' ');
      expect(text, skill).toContain('For "microtubule growth" open `microtubule-arrival`');
      expect(text, skill).toContain('`microtubule-growth` opens on a finished wall that `grow_structure` grows into a tube');
      expect(text, skill).toContain('(`"telomerase"` opens `telomerase-haca`)');
    }
  });
});
