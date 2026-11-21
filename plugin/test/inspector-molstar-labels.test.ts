import { readFile } from 'node:fs/promises';
import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/commonjs/mol-model-formats/structure/mmcif.js';
import { Structure, StructureElement } from 'molstar/lib/commonjs/mol-model/structure.js';
import { Task } from 'molstar/lib/commonjs/mol-task/index.js';
import { distanceLabel, elementLabel, lociLabel, structureElementStatsLabel } from 'molstar/lib/commonjs/mol-theme/label.js';
import { describe, expect, it } from 'vitest';
// @ts-ignore The rewrite applied to structure text before Mol* parses it.
import { escapeStructureMarkup } from '../../lab/browser-roundtrip/structure-markup.mjs';
// @ts-ignore Production source-bound selection adapter.
import { createSelectionAdapter } from '../../lab/browser-roundtrip/selection.mjs';
// @ts-ignore The headset's structure readout.
import { createStructureSubjectReader } from '../../lab/browser-roundtrip/structure-subject.mjs';
import { DETAILED_VIEW_ESCAPE_SOURCE } from '../src/detailed-view-page.js';
import { extractInspectionCatalogBytes } from '../src/inspection-catalog.js';

const fixture = (name: string) => readFile(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
const detailedViewEscape = new Function(`return ${DETAILED_VIEW_ESCAPE_SOURCE};`)() as (text: string) => string;

/** One element name per file field, so a label shows which field reached it. */
const HOSTILE = {
  entry: '<x-entry onclick=1>',
  title: 'resolution <2 A <x-title onclick=1>',
  description: '<x-description onclick=1>',
  labelChain: '<x-label-asym onclick=1>',
  authorChain: '<x-auth-asym onclick=1>',
  labelComp: '<img src=x onerror=globalThis.__stereofoldHostile=1>',
  authorComp: '<x-auth-comp onclick=1>',
  labelAtom: '<x-label-atom onclick=1>',
  insertionCode: '<x-ins-code onclick=1>',
};

/**
 * A two-atom polymer whose names are markup. Every value is a quoted mmCIF
 * string, so the parser reads each one whole.
 */
function hostileCif() {
  const q = (value: string) => `'${value}'`;
  const atom = (id: number, name: string, x: number) => ['ATOM', id, 'C', q(name), '.', q(HOSTILE.labelComp), q(HOSTILE.labelChain), 1, 1,
    q(HOSTILE.insertionCode), x.toFixed(3), '0.000', '0.000', '1.00', '10.00', 1, q(HOSTILE.authorComp), q(HOSTILE.authorChain), q(name), 1].join(' ');
  return [
    'data_hostile',
    `_entry.id ${q(HOSTILE.entry)}`,
    `_struct.title ${q(HOSTILE.title)}`,
    'loop_', '_entity.id', '_entity.type', '_entity.pdbx_description',
    `1 polymer ${q(HOSTILE.description)}`,
    'loop_',
    ...['group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id', 'label_asym_id', 'label_entity_id',
      'label_seq_id', 'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv', 'auth_seq_id',
      'auth_comp_id', 'auth_asym_id', 'auth_atom_id', 'pdbx_PDB_model_num'].map(field => `_atom_site.${field}`),
    atom(1, HOSTILE.labelAtom, 0),
    atom(2, 'CB', 1.5),
    '',
  ].join('\n');
}

async function structureOf(text: string) {
  const parsed = await CIF.parse(text).run();
  if (parsed.isError) throw Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const model = await Task.resolveInContext(trajectory.getFrameAtIndex(0));
  return Structure.ofModel(model);
}

/**
 * Every label the stock Structure Tools in the Mol* tools dialog write with
 * `dangerouslySetInnerHTML` when the person selects the first atom, then the
 * second, labels the first and measures the distance. Each call is the one
 * Mol* 5.11 makes for that row:
 * - selection history (`measurements.js:146`, `superposition.js:284`):
 *   `structureElementStatsLabel(Stats.ofLoci(loci), { reverse: true })`,
 *   from `StructureSelectionManager.tryAddHistory`;
 * - a label or distance entry (`measurements.js:281`): `lociLabel` or
 *   `distanceLabel` with `{ condensed: true }`;
 * - a superposition chain entry (`superposition.js:280`):
 *   `elementLabel(location, { reverse: true, granularity: 'chain' })`.
 */
async function toolLabels(text: string) {
  const structure = await structureOf(text);
  const unit = structure.units[0];
  const atom = (index: number) => StructureElement.Loci(structure, [{ unit, indices: new Int32Array([index]) as any }]);
  const [first, second] = [atom(0), atom(1)];
  const history = [first, second].map(loci => structureElementStatsLabel(StructureElement.Stats.ofLoci(loci), { reverse: true }));
  const measurements = [lociLabel(first, { condensed: true }), distanceLabel({ loci: [first, second] } as any, { condensed: true, unitLabel: 'Å' })];
  const chain = elementLabel(StructureElement.Location.create(structure, unit, unit.elements[0]), { reverse: true, granularity: 'chain' }).split('|');
  return { history, measurements, superposition: [`${chain[0]} | ${chain[chain.length - 1]}`] };
}

/** Every element name the HTML parser would open for this string. */
const openedTags = (html: string) => [...html.matchAll(/<\/?([A-Za-z][^\s/>]*)/gu)].map(match => match[1].toLowerCase());
/** What the reader sees once the label is parsed: tags gone, the one entity the escape writes decoded. */
const shownText = (html: string) => html.replace(/<[^>]*>/gu, ' ').replace(/&lt;/gu, '<');
const MOLSTAR_TAGS = new Set(['b', 'small', 'br']);

describe('structure text in the inspector\'s Mol* tools labels', () => {
  it('opens elements named in the file when the text reaches Mol* unchanged', async () => {
    const labels = await toolLabels(hostileCif());
    const opened = new Set(Object.values(labels).flat().flatMap(openedTags));
    for (const tag of ['x-entry', 'x-label-asym', 'x-auth-asym', 'img', 'x-label-atom', 'x-ins-code']) expect(opened, tag).toContain(tag);
    expect(labels.history[0]).toContain(HOSTILE.labelComp);
  });

  it('keeps every name as label text once the text is escaped', async () => {
    const labels = await toolLabels(escapeStructureMarkup(hostileCif()));
    for (const [row, values] of Object.entries(labels)) {
      for (const label of values) {
        expect(new Set(openedTags(label).filter(tag => !MOLSTAR_TAGS.has(tag))), `${row}: ${label}`).toEqual(new Set());
      }
    }
    // The reader still sees each name, character for character.
    const shown = shownText(labels.history[0]);
    for (const value of [HOSTILE.labelChain, HOSTILE.authorChain, HOSTILE.labelComp, HOSTILE.labelAtom, HOSTILE.insertionCode]) {
      expect(shown).toContain(value);
    }
    // Mol* shortens a long entry id in a label, so only its start is compared.
    expect(shown).toContain('<x-entry');
  });

  it('agrees with the detailed view and leaves deposited files unchanged', async () => {
    const hostile = hostileCif();
    expect(escapeStructureMarkup(hostile)).toBe(detailedViewEscape(hostile));
    expect(escapeStructureMarkup(hostile)).not.toContain('<');
    for (const name of ['1CRN.cif', '4HHB.cif']) {
      const text = await fixture(name);
      expect(escapeStructureMarkup(text), name).toBe(text);
    }
  });

  it('binds an ordinary file the same way and refuses markup in an atom identity', async () => {
    const crambin = await fixture('1CRN.cif');
    const described = crambin.replace(/^_entity\.pdbx_description\s+CRAMBIN\s*$/mu, `_entity.pdbx_description '${HOSTILE.description}'`)
      .replace(/^_entry\.id\s+1CRN\s*$/mu, `_entry.id '${HOSTILE.entry}'`);
    expect(described).toContain(HOSTILE.description);
    const keys = async (text: string, catalog: unknown) => createSelectionAdapter(await structureOf(text), catalog).rows.map((row: { key: string }) => row.key);
    for (const text of [crambin, described]) {
      const catalog = await extractInspectionCatalogBytes(text, { assemblyId: 'asymmetric_unit' });
      expect(await keys(escapeStructureMarkup(text), catalog)).toEqual(await keys(text, catalog));
    }
    // A residue name the catalog accepts, which Mol* now reads with '&lt;'.
    const renamed = crambin.replace(/^(ATOM \d+ +\S+ \S+ +\. )THR( A 1 1 )/gmu, `$1'${HOSTILE.authorComp}'$2`);
    expect(renamed).toContain(HOSTILE.authorComp);
    const catalog = await extractInspectionCatalogBytes(renamed, { assemblyId: 'asymmetric_unit' });
    expect((await keys(renamed, catalog)).length).toBeGreaterThan(0);
    await expect(keys(escapeStructureMarkup(renamed), catalog)).rejects.toThrow('does not match the catalog source identity');
  });

  it('shows the file\'s own title in the headset readout', async () => {
    const titled = (await fixture('1CRN.cif')).replace(/^'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN.*$/mu, `'${HOSTILE.title}'`);
    expect(titled).toContain(HOSTILE.title);
    const subject = async (text: string) => {
      const structure = await structureOf(text);
      return createStructureSubjectReader()({ sha256: '0'.repeat(64), catalog: { rows: [] } }, structure.models[0], { ready: true, modelNumber: 1 }).title;
    };
    const original = await subject(titled);
    expect(original).toContain('<2 A <x-title');
    expect(await subject(escapeStructureMarkup(titled))).toBe(original);
  });

  it('shows a title that spells an entity exactly as the file wrote it', async () => {
    const crambin = await fixture('1CRN.cif');
    const subject = async (title: string) => {
      const titled = crambin.replace(/^'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN.*$/mu, `'${title}'`);
      expect(titled).toContain(title);
      const structure = await structureOf(escapeStructureMarkup(titled));
      return createStructureSubjectReader()({ sha256: '0'.repeat(64), cif: titled, catalog: { rows: [] } },
        structure.models[0], { ready: true, modelNumber: 1 }).title;
    };
    // No '<' anywhere, so Mol* parsed the file as written.
    expect(await subject('alpha &lt; beta')).toBe('alpha &lt; beta');
    // Both spellings in one title: each reads as the file wrote it.
    expect(await subject('alpha &lt; beta <2 A')).toBe('alpha &lt; beta <2 A');
    expect(await subject('resolution <2 A')).toBe('resolution <2 A');
  });

  it('takes the title\'s spelling from the title field, not from other text in the file', async () => {
    const crambin = await fixture('1CRN.cif');
    const subject = async (titled: string) => {
      const structure = await structureOf(escapeStructureMarkup(titled));
      return createStructureSubjectReader()({ sha256: '0'.repeat(64), cif: titled, catalog: { rows: [] } },
        structure.models[0], { ready: true, modelNumber: 1 }).title;
    };
    const commented = (field: string) => crambin.replace(/^_struct\.title\s+'WATER STRUCTURE OF A HYDROPHOBIC PROTEIN.*$/mu,
      `# alpha < beta\n${field}`);
    // On the line after the tag, as deposited files write it.
    expect(await subject(commented(`_struct.title\n'alpha &lt; beta'`))).toBe('alpha &lt; beta');
    // On the tag's own line.
    expect(await subject(commented(`_struct.title 'alpha &lt; beta'`))).toBe('alpha &lt; beta');
    // In a semicolon-delimited text field.
    expect(await subject(commented(`_struct.title\n;alpha &lt; beta\n;`))).toBe('alpha &lt; beta');
    // A title with both spellings still reads as written beside the comment.
    expect(await subject(commented(`_struct.title 'alpha < beta &lt; gamma'`))).toBe('alpha < beta &lt; gamma');
    // A comment between the tag and its value is skipped, as Mol* skips it.
    expect(await subject(commented(`_struct.title\n# comment\n'alpha < beta'`))).toBe('alpha < beta');
    expect(await subject(commented(`_struct.title # comment\n;alpha < beta\n;`))).toBe('alpha < beta');
  });

  it('is applied where the viewer gives structure text to Mol*', async () => {
    const viewer = await readFile(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    // The structure build is the one place the viewer hands Mol* file text.
    // The other raw-data call is the density map, which is binary CCP4.
    const handoffs = [...viewer.matchAll(/builders\.data\.rawData\(\{ data: ([^,]+),/gu)].map(match => match[1]);
    expect(handoffs.sort()).toEqual(['escapeStructureMarkup(source.cif)', 'source.map']);
    expect(viewer.includes("import { escapeStructureMarkup } from './structure-markup.mjs';")).toBe(true);
  });
});
