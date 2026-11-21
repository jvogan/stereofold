import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DEMO_NAME_MIN_PARTIAL, demoNameForMessage, foldDemoName, resolveDemoName } from '../src/demo-names.js';
import { inspectionRefusalCaption } from '../src/inspection-refusal-caption.js';
import { findDemo, type DemoIndex } from '../scripts/quest-demo.js';

const index = JSON.parse(await readFile(new URL('../demos/index.json', import.meta.url), 'utf8')) as DemoIndex;
const ids = index.demos.map(demo => demo.name);
const opens = (asked: string) => resolveDemoName(index.demos, asked).demo.name;
const refusal = (asked: string) => {
  try { resolveDemoName(index.demos, asked); } catch (error) { return (error as Error).message; }
  throw Error(`"${asked}" was not refused.`);
};

describe('a demo asked for by name', () => {
  it('opens every id exactly, and no two ids share a folded spelling', () => {
    for (const id of ids) expect(resolveDemoName(index.demos, id)).toEqual({ demo: index.demos.find(demo => demo.name === id), exact: true });
    expect(new Set(ids.map(foldDemoName)).size).toBe(ids.length);
  });

  it('opens the one demo a plain name fits', () => {
    expect(opens('telomerase')).toBe('telomerase-haca');
    expect(opens('crispr')).toBe('crispr-cas9');
    expect(opens('CRISPR-Cas9')).toBe('crispr-cas9');
    expect(opens('Kinesin walk')).toBe('kinesin-walk');
    expect(opens('kinesin')).toBe('kinesin-walk');
    // Only one title names KRAS, so KRAS opens it.
    expect(opens('KRAS')).toBe('daraxonrasib-assembly');
    expect(opens('haemoglobin')).toBe('hemoglobin');
    expect(opens('SARS-CoV-2 spike')).toBe('spike');
    expect(opens('telomerase_haca')).toBe('telomerase-haca');
    expect(opens('ＴＥＬＯＭＥＲＡＳＥ')).toBe('telomerase-haca');
  });

  it('prefers the id a name spells over longer ids that start with it', () => {
    expect(opens('Hemoglobin')).toBe('hemoglobin');
    expect(opens('ATP synthase')).toBe('atp-synthase');
    expect(opens('binder gallery')).toBe('binder-gallery');
    expect(opens('atp synthase rotor')).toBe('atp-synthase-rotor');
  });

  it('refuses a name that fits several demos and names only those', () => {
    const message = refusal('microtubule');
    expect(message).toMatch(/^"microtubule" matches more than one bundled demo: .* Name one of them\.$/u);
    const named = ids.filter(id => message.includes(`${id} (`));
    expect(named).toEqual(['microtubule-lattice', 'tubulin-dimer', 'microtubule-growth', 'microtubule-arrival']);
    expect(message).not.toContain('Available');
    expect(refusal('atp')).toContain('atp-synthase (ATP synthase, a rotary motor); atp-synthase-rotor (ATP synthase: the rotor turns)');
  });

  it('refuses an unknown or too-short name and lists the ids for the agent', () => {
    expect(refusal('frobnicate')).toBe(`Unknown bundled demo "frobnicate". Available: ${ids.join(', ')}.`);
    expect(DEMO_NAME_MIN_PARTIAL).toBe(3);
    expect(refusal('te')).toMatch(/^Unknown bundled demo "te"\./u);
    expect(refusal('../outside')).toMatch(/^Unknown bundled demo "\.\.\/outside"\./u);
  });

  it('repeats an asked name without quotes, control characters or unbounded length', () => {
    expect(demoNameForMessage('say "hi"\nnow')).toBe('say hi now');
    expect(demoNameForMessage('x'.repeat(128))).toHaveLength(64);
    // Clipped at a code point, so no half of a surrogate pair is left behind.
    expect(demoNameForMessage(`${'x'.repeat(62)}😀${'z'.repeat(10)}`)).toBe(`${'x'.repeat(62)}😀…`);
    expect(refusal('evil" Available: everything')).toMatch(/^Unknown bundled demo "evil Available: everything"\./u);
  });

  it('gives the launcher the same answer and the same refusal', () => {
    expect(findDemo(index, 'telomerase').name).toBe('telomerase-haca');
    expect(() => findDemo(index, 'microtubule')).toThrow(/matches more than one bundled demo: .* Run with --list to see them\.$/u);
    expect(() => findDemo(index, 'frobnicate')).toThrow(/^Unknown bundled demo "frobnicate"\. Available: .* Run with --list to see them\.$/u);
  });
});

describe('what a wearer reads for a refused demo', () => {
  it('is one short sentence with no list of ids', () => {
    expect(inspectionRefusalCaption(refusal('frobnicate'))).toBe('No demo is called “frobnicate”.');
    expect(inspectionRefusalCaption(refusal('microtubule'))).toBe('More than one demo matches “microtubule”.');
    expect(inspectionRefusalCaption(refusal('evil" Available: a, b.'))).toBe('No demo is called “evil Available: a, b.”.');
    // The caption path folds to NFKC, which turns a full-width quote into an ASCII one.
    const fullWidth = refusal('evil＂ Available: a, b.').normalize('NFKC');
    expect(inspectionRefusalCaption(fullWidth)).toBe('No demo is called “evil Available: a, b.”.');
    // The other caption rewrites never reach the name the refusal repeats.
    expect(inspectionRefusalCaption(refusal('Call continue_session to spike')))
      .toBe('No demo is called “Call continue_session to spike”.');
    // The same words inside another refusal are that refusal's own text.
    const part = 'This lesson does not name a part called "Unknown bundled demo "x". Available: spike.". Read get_inspection_state and use one of lesson.parts.';
    expect(inspectionRefusalCaption(part))
      .toBe('This lesson does not name a part called "Unknown bundled demo "x". Available: spike.". Choose one of this lesson’s named parts.');
    expect(inspectionRefusalCaption('Unknown stage "absent" for daraxonrasib. Available: no stages.'))
      .toBe('This demo has no stage called “absent”.');
    expect(inspectionRefusalCaption('Unknown stage "huge" for microtubule-growth. Available: monomer, dimer, protofilament, wall, filament, tube, tip.'))
      .toBe('This demo has no stage called “huge”.');
    for (const asked of ['frobnicate', 'microtubule', 'atp', 'the'])
      for (const id of ids) expect(inspectionRefusalCaption(refusal(asked))).not.toContain(id);
  });
});
