import { readFile } from 'node:fs/promises';
import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/commonjs/mol-model-formats/structure/mmcif.js';
import { Structure, StructureElement } from 'molstar/lib/commonjs/mol-model/structure.js';
import { DefaultLociLabelProvider } from 'molstar/lib/commonjs/mol-plugin/behavior/dynamic/representation.js';
import { Task } from 'molstar/lib/commonjs/mol-task/index.js';
import { describe, expect, it } from 'vitest';
import { DETAILED_VIEW_ESCAPE_SOURCE, detailedViewHtml } from '../src/detailed-view-page.js';

const fixture = (name: string) => readFile(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
const escapeMarkup = new Function(`return ${DETAILED_VIEW_ESCAPE_SOURCE};`)() as (text: string) => string;
const HOSTILE_DESCRIPTION = '<img src=x onerror=globalThis.__stereofoldHostile=1>';
const HOSTILE_ENTRY = '<svg onload=globalThis.__stereofoldHostile=2>';

async function hostileCrambin() {
  const text = (await fixture('1CRN.cif'))
    .replace(/^_entity\.pdbx_description\s+CRAMBIN\s*$/mu, `_entity.pdbx_description '${HOSTILE_DESCRIPTION}'`)
    .replace(/^_entry\.id\s+1CRN\s*$/mu, `_entry.id '${HOSTILE_ENTRY}'`);
  expect(text).toContain(HOSTILE_DESCRIPTION);
  expect(text).toContain(HOSTILE_ENTRY);
  return text;
}

/**
 * What Mol* 5.11 writes into the page when the first atom is hovered.
 *
 * `DefaultLociLabelProvider` is the stock provider the viewer registers, and
 * the string it returns is what `LociLabels` renders with
 * `dangerouslySetInnerHTML`. It runs here against a stand-in plugin that only
 * collects the provider, so the label under test is Mol*'s own.
 */
async function hoverLabel(text: string): Promise<string> {
  const parsed = await CIF.parse(text).run();
  if (parsed.isError) throw Error(parsed.message);
  const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
  const model = await Task.resolveInContext(trajectory.getFrameAtIndex(0));
  const structure = Structure.ofModel(model);
  const loci = StructureElement.Loci(structure, [{ unit: structure.units[0], indices: new Int32Array([0]) as any }]);
  const providers: { label: (loci: unknown) => string | undefined }[] = [];
  const plugin = { managers: { lociLabels: { addProvider: (provider: any) => providers.push(provider), removeProvider() {} } } };
  const behavior = await (DefaultLociLabelProvider.definition.apply as any)({ params: {} }, plugin);
  behavior.data.register();
  expect(providers).toHaveLength(1);
  return providers[0].label(loci) ?? '';
}

/** Every element name the HTML parser would open for this string. */
const openedTags = (html: string) => [...html.matchAll(/<\/?([A-Za-z][^\s/>]*)/gu)].map(match => match[1].toLowerCase());
/** What the reader sees once the label is parsed: tags gone, the one entity the escape writes decoded. */
const shownText = (html: string) => html.replace(/<[^>]*>/gu, ' ').replace(/&lt;/gu, '<');

describe('structure text in the detailed view\'s Mol* labels', () => {
  it('turns a hostile entity description into label text, not an element', async () => {
    const hostile = await hostileCrambin();
    // The unescaped path is the one that ran script on hover.
    const raw = await hoverLabel(hostile);
    expect(raw).toContain(HOSTILE_DESCRIPTION);
    expect(openedTags(raw)).toContain('img');
    expect(openedTags(raw)).toContain('svg');

    const label = await hoverLabel(escapeMarkup(hostile));
    // Only Mol*'s own formatting survives as markup.
    expect(new Set(openedTags(label))).toEqual(new Set(['b', 'small', 'br']));
    expect(label).toContain('&lt;img src=x onerror=');
    // The reader still sees the description, character for character. Mol*
    // shortens the entry id in a label, so only its start is compared.
    expect(shownText(label)).toContain(HOSTILE_DESCRIPTION);
    expect(shownText(label)).toContain('<svg onload=');
  });

  it('hands deposited coordinates to Mol* unchanged', async () => {
    for (const name of ['1CRN.cif', '4HHB.cif']) {
      const text = await fixture(name);
      expect(escapeMarkup(text), name).toBe(text);
    }
    const label = await hoverLabel(await fixture('1CRN.cif'));
    expect(label).toContain('CRAMBIN</br>');
    expect(label).toContain('<b>THR 1</b>');
  });

  it('is applied where the page gives the coordinates to Mol*, and only there', () => {
    const html = detailedViewHtml();
    expect(html).toContain(`const escapeMarkup = ${DETAILED_VIEW_ESCAPE_SOURCE};`);
    expect(html).toContain('rawData({data: escapeMarkup(handoff.structureText),');
    expect(html.match(/handoff\.structureText/gu)).toHaveLength(1);
  });
});
