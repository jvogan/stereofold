import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_STRUCTURE_META_KEY } from '../src/structure-result.js';
import { inspectionSource, pdbConversionWork, pdbDeclaredRowCount } from '../src/structure-sources.js';

/**
 * Mol* converts PDB text to mmCIF before it builds any model, and while it
 * converts it lists every SEQRES residue of every chain once per model. These
 * check that the count Stereofold takes from the text is that product, and
 * that text past the bound is refused before Mol* parses or converts it, on
 * the server's own conversion and on the stereo viewer's open path.
 */
const molstar = vi.hoisted(() => ({ parsed: 0, converted: 0, stopConversion: undefined as string | undefined }));
vi.mock('molstar/lib/commonjs/mol-io/reader/pdb/parser.js', async importOriginal => {
  const actual: any = await importOriginal();
  return { ...actual, parsePDB: (...args: unknown[]) => { molstar.parsed += 1; return actual.parsePDB(...args); } };
});
vi.mock('molstar/lib/commonjs/mol-model-formats/structure/pdb/to-cif.js', async importOriginal => {
  const actual: any = await importOriginal();
  return { ...actual, pdbToMmCif: (...args: unknown[]) => {
    molstar.converted += 1;
    if (molstar.stopConversion) throw Error(molstar.stopConversion);
    return actual.pdbToMmCif(...args);
  } };
});
beforeEach(() => { molstar.parsed = 0; molstar.converted = 0; molstar.stopConversion = undefined; });

const require = createRequire(import.meta.url);
const { parsePDB: realParsePDB } = require('molstar/lib/commonjs/mol-io/reader/pdb/parser.js');
const { pdbToMmCif: realPdbToMmCif } = require('molstar/lib/commonjs/mol-model-formats/structure/pdb/to-cif.js');
const alignment = require('molstar/lib/commonjs/mol-model/sequence/alignment/alignment.js');
const components = require('molstar/lib/commonjs/mol-model-formats/structure/common/component.js');

/**
 * What Mol*'s own conversion of `text` does: the cells its SEQRES alignments
 * fill (observed x names, chain by chain) and the records its residue-name
 * scans visit, measured on Mol*'s own calls and its own parsed residue numbers.
 */
async function molstarWork(text: string): Promise<{ cells: number; steps: number }> {
  let cells = 0, steps = 0;
  const align = alignment.align, scan = components.ComponentBuilder.prototype.getAtomIds;
  alignment.align = (a: unknown[], b: unknown[], options: unknown) => { cells += a.length * b.length; return align(a, b, options); };
  components.ComponentBuilder.prototype.getAtomIds = function (this: any, index: number) {
    const first = this.seqId.value(index);
    let next = index;
    while (next < this.seqId.rowCount && this.seqId.value(next) === first) next++;
    steps += next - index;
    return scan.call(this, index);
  };
  try { await realPdbToMmCif((await realParsePDB(text).run()).result); }
  finally { alignment.align = align; components.ComponentBuilder.prototype.getAtomIds = scan; }
  return { cells, steps };
}
/** One ATOM or HETATM record with the given columns. */
const record = (kind: 'ATOM  ' | 'HETATM', serial: number, residue: string, chain: string, number: number | string, insertion = ' ') =>
  `${kind}${String(serial % 100000).padStart(5)}  CA  ${residue.padEnd(4)}${chain}${String(number).padStart(4)}${insertion}      0.000   0.000   0.000  1.00 10.00           C  `;
const seqresLines = (chain: string, names: number) => Array.from({ length: Math.ceil(names / 13) }, (_, i) =>
  `SEQRES ${String(i + 1).padStart(3)} ${chain} ${String(names).padStart(4)}  ` + Array.from({ length: Math.min(13, names - i * 13) }, () => 'ALA').join(' '));
/** A chain of `observed` residues, one CA record each, under SEQRES of `names` names. */
const alignedChain = (names: number, observed: number) => [...seqresLines('A', names),
  ...Array.from({ length: observed }, (_, r) => record('ATOM  ', r + 1, 'ALA', 'A', (r % 9999) + 1)), 'END', ''].join('\n');

const atom = (serial: number, chain: string, residue: number) =>
  `ATOM  ${String(serial % 100000).padStart(5)}  CA  ALA ${chain}${String(residue).padStart(4)}       0.000   0.000   0.000  1.00 10.00           C  `;
type Shape = { chains?: string[]; residues: number; perLine?: number; models: number; observed?: 'first' | 'all' | 'none';
  atomBeforeModel?: boolean; eol?: string; declared?: number; extra?: string[] };
/** PDB text: SEQRES for each chain, then `extra` lines, then `models` MODEL records holding CA atoms. */
function pdb({ chains = ['A'], residues, perLine = 13, models, observed = 'first', atomBeforeModel = false, eol = '\n', declared, extra = [] }: Shape) {
  const lines: string[] = [];
  for (const chain of chains) for (let i = 0, serial = 1; i < residues; i += perLine, serial++) {
    lines.push(`SEQRES ${String(serial).padStart(3)} ${chain} ${String(declared ?? residues).padStart(4)}  `
      + Array.from({ length: Math.min(perLine, residues - i) }, () => 'ALA').join(' '));
  }
  lines.push(...extra);
  let serial = 0;
  const atoms = () => {
    if (observed === 'none') return;
    for (const chain of chains) for (let r = 1; r <= (observed === 'all' ? residues : 1); r++) lines.push(atom(++serial, chain, r));
  };
  if (atomBeforeModel) lines.push(atom(++serial, chains[0], 1));
  if (models === 0) atoms();
  for (let m = 1; m <= models; m++) { lines.push(`MODEL     ${String(m).padStart(4)}`); atoms(); lines.push('ENDMDL'); }
  lines.push('END');
  return lines.join(eol) + eol;
}
/** The residues Mol*'s own conversion lists as unobserved across every model. */
async function molstarUnobserved(text: string): Promise<number> {
  const frame = await realPdbToMmCif((await realParsePDB(text).run()).result);
  return frame.categories.pdbx_unobs_or_zero_occ_residues?.rowCount ?? 0;
}
const refusal = (rows: string) => new RegExp(`^Structure and sequence catalog exceeds the 64 MiB this plugin decodes in one browser\\. `
  + `Its declarations expand to at least ${rows} residue rows; at most 1,000,000 fit\\.`);

describe('PDB residue rows counted from the text', () => {
  it('equals the SEQRES residues Mol* walks once per model', async () => {
    // [shape, expected count, residues Mol* finds observed]
    const cases: [Shape, number, number][] = [
      [{ chains: ['A', 'B'], residues: 30, models: 4 }, 2 * 30 * 4, 2 * 4],
      // Any number of names on a line counts, whatever the declared count says.
      [{ residues: 30, perLine: 30, declared: 5, models: 3 }, 30 * 3, 3],
      // A SEQRES line with no names still declares one.
      [{ residues: 26, models: 2, extra: ['SEQRES   9 A   26'] }, 27 * 2, 2],
      // Lines end at \r and \r\n as well as \n.
      [{ residues: 26, models: 3, eol: '\r' }, 26 * 3, 3],
      [{ residues: 26, models: 3, eol: '\r\n' }, 26 * 3, 3],
      // A MODEL record counts whether or not it holds atoms, and an atom
      // before the first MODEL record opens a model of its own.
      [{ residues: 20, models: 5, observed: 'none', atomBeforeModel: true }, 20 * 6, 1],
      // No MODEL records: one model.
      [{ residues: 20, models: 0 }, 20, 1],
    ];
    for (const [shape, expected, observed] of cases) {
      const text = pdb(shape);
      expect(pdbDeclaredRowCount(text), JSON.stringify(shape)).toBe(expected);
      expect(await molstarUnobserved(text) + observed, JSON.stringify(shape)).toBe(expected);
    }
  });

  it('counts nothing for a file without SEQRES, and only records that start a line', () => {
    expect(pdbDeclaredRowCount(pdb({ residues: 0, models: 40 }))).toBe(0);
    expect(pdbDeclaredRowCount(['REMARK SEQRES   1 A    2  ALA ALA', ' SEQRES   1 A    2  ALA ALA', 'SEQRES   1 A    2  ALA ALA',
      'MODELS', ' MODEL        1', 'MODEL        1', atom(1, 'A', 1), 'ENDMDL', ''].join('\n'))).toBe(2);
  });

  it('leaves a typical NMR ensemble far below the bound', () => {
    expect(pdbDeclaredRowCount(pdb({ residues: 300, models: 40, observed: 'all' }))).toBe(12_000);
  });
});

describe('PDB alignment and residue-name work counted from the text', () => {
  it('counts the alignment cells Mol* fills, chain by chain, from the first model', async () => {
    const cases: [string, string[]][] = [
      ['alternating chains', [...seqresLines('A', 20), ...seqresLines('B', 30),
        ...Array.from({ length: 12 }, (_, i) => record('ATOM  ', i + 1, 'ALA', i % 2 ? 'B' : 'A', 1 + (i >> 1)))]],
      ['insertion codes and repeated records', [...seqresLines('A', 25), record('ATOM  ', 1, 'ALA', 'A', 52), record('ATOM  ', 2, 'ALA', 'A', 52),
        record('ATOM  ', 3, 'ALA', 'A', 52, 'A'), record('ATOM  ', 4, 'ALA', 'A', 52, 'B'), record('ATOM  ', 5, 'ALA', 'A', 53)]],
      ['HETATM ligands and waters on the chain', [...seqresLines('A', 40), record('ATOM  ', 1, 'ALA', 'A', 1), record('HETATM', 2, 'HEM', 'A', 201),
        ...Array.from({ length: 9 }, (_, i) => record('HETATM', 3 + i, 'HOH', 'A', 301 + i))]],
      ['first model only', [...seqresLines('A', 30), 'MODEL        1', record('ATOM  ', 1, 'ALA', 'A', 1), record('ATOM  ', 2, 'ALA', 'A', 2), 'ENDMDL',
        'MODEL        2', ...Array.from({ length: 20 }, (_, i) => record('ATOM  ', 3 + i, 'ALA', 'A', 1 + i)), 'ENDMDL']],
      ['an atom before the first MODEL record', [...seqresLines('A', 30), record('ATOM  ', 1, 'ALA', 'A', 7), 'MODEL        1',
        ...Array.from({ length: 5 }, (_, i) => record('ATOM  ', 2 + i, 'ALA', 'A', 1 + i)), 'ENDMDL']],
      ['SEQRES without atoms, and atoms without SEQRES', [...seqresLines('A', 15), ...seqresLines('B', 50), record('ATOM  ', 1, 'ALA', 'A', 1),
        record('ATOM  ', 2, 'ALA', 'A', 2), ...Array.from({ length: 6 }, (_, i) => record('ATOM  ', 3 + i, 'ALA', 'C', 1 + i))]],
      ['a chain written as a dot', [...seqresLines('.', 15), record('ATOM  ', 1, 'ALA', '.', 1), record('ATOM  ', 2, 'ALA', '.', 2)]],
    ];
    for (const [name, lines] of cases) {
      const text = [...lines, 'END', ''].join('\n');
      const expected = await molstarWork(text);
      expect(pdbConversionWork(text).alignmentCells, name).toBe(expected.cells);
    }
    expect(pdbConversionWork(alignedChain(300, 280)).alignmentCells).toBe((await molstarWork(alignedChain(300, 280))).cells);
  });

  it('counts at least the records Mol* scans to classify residue names, and exactly as many for names it does not know', async () => {
    const unknown = [...Array.from({ length: 60 }, (_, i) => record('HETATM', i + 1, `Q${i}`, 'A', 1)),
      ...Array.from({ length: 30 }, (_, i) => record('HETATM', 61 + i, `R${i % 7}`, 'B', 2 + (i % 3))), 'END', ''].join('\n');
    expect(pdbConversionWork(unknown).nameScanSteps).toBe((await molstarWork(unknown)).steps);
    const known = alignedChain(300, 280);
    expect(pdbConversionWork(known).nameScanSteps).toBeGreaterThanOrEqual((await molstarWork(known)).steps);
  });

  it('leaves ordinary structures well inside both bounds', () => {
    // [description, chains of (SEQRES names, observed residues)]
    const shapes: [string, [number, number][]][] = [
      ['one 5,000-residue chain', [[5_000, 5_000]]],
      ['a 60-chain capsid of 500 residues', Array.from({ length: 60 }, () => [500, 500] as [number, number])],
      ['14 chains of 524 and 7 of 97', [...Array.from({ length: 14 }, () => [524, 524] as [number, number]), ...Array.from({ length: 7 }, () => [97, 97] as [number, number])]],
    ];
    const cells = Object.fromEntries(shapes.map(([name, chains]) => [name, chains.reduce((sum, [n, o]) => sum + n * o, 0)]));
    expect(cells).toEqual({ 'one 5,000-residue chain': 25_000_000, 'a 60-chain capsid of 500 residues': 15_000_000,
      '14 chains of 524 and 7 of 97': 3_909_927 });
    // A 40-model NMR ensemble of 300 residues aligns its first model only.
    const nmr = pdb({ residues: 300, models: 40, observed: 'all' });
    expect(pdbConversionWork(nmr)).toMatchObject({ rows: 12_000, alignmentCells: 90_000 });
  });
});

describe('the server conversion of PDB text', () => {
  const over = pdb({ residues: 1_001, models: 1_000 });
  const atBound = pdb({ residues: 1_000, models: 1_000 });

  it('refuses past 1,000,000 rows before Mol* parses or converts the text', async () => {
    await expect(inspectionSource({ kind: 'pasted', structureText: over, format: 'pdb' })).rejects.toThrow(refusal('1,001,000'));
    expect(molstar).toMatchObject({ parsed: 0, converted: 0 });
    expect(pdbDeclaredRowCount(over)).toBe(1_001_000);
  });

  it('hands text exactly at the bound to the converter', async () => {
    // The converter is stopped once reached, so the test does not build a million rows.
    molstar.stopConversion = 'converter reached';
    await expect(inspectionSource({ kind: 'pasted', structureText: atBound, format: 'pdb' })).rejects.toThrow('converter reached');
    expect(molstar).toMatchObject({ parsed: 1, converted: 1 });
    expect(pdbDeclaredRowCount(atBound)).toBe(1_000_000);
  });

  it('converts an ordinary NMR ensemble as before', async () => {
    const converted = await inspectionSource({ kind: 'pasted', structureText: pdb({ residues: 300, models: 20, observed: 'all' }), format: 'pdb' });
    expect(converted.format).toBe('mmcif');
    expect(converted.structureText).toContain('_atom_site.');
    expect(molstar).toMatchObject({ parsed: 1, converted: 1 });
  });
});

describe('PDB alignment and residue-name bounds on the server conversion', () => {
  const alignmentRefusal = (steps: string) => new RegExp(`^This PDB file's SEQRES records would take ${steps} sequence-alignment steps to match to its residues; `
    + 'at most 25,000,000 are allowed\\. Use the structure\'s mmCIF file, or remove its SEQRES records\\.$');
  const sharedNumbers = (count: number) => [...Array.from({ length: count }, (_, i) => record('HETATM', i + 1, i.toString(36).toUpperCase(), 'A', 1)), 'END', ''].join('\n');

  it('refuses SEQRES that would align past 25,000,000 cells before Mol* parses or converts the text', async () => {
    await expect(inspectionSource({ kind: 'pasted', structureText: alignedChain(5_001, 5_000), format: 'pdb' })).rejects.toThrow(alignmentRefusal('25,005,000'));
    expect(molstar).toMatchObject({ parsed: 0, converted: 0 });
  });

  it('hands text aligning exactly 25,000,000 cells to the converter', async () => {
    molstar.stopConversion = 'converter reached';
    await expect(inspectionSource({ kind: 'pasted', structureText: alignedChain(5_000, 5_000), format: 'pdb' })).rejects.toThrow('converter reached');
    expect(molstar).toMatchObject({ parsed: 1, converted: 1 });
  });

  it('refuses residue names that would take past 25,000,000 scan steps before Mol* parses or converts the text', async () => {
    // 7,071 new names on one residue number: 7,071 x 7,072 / 2 = 25,003,056 steps.
    await expect(inspectionSource({ kind: 'pasted', structureText: sharedNumbers(7_071), format: 'pdb' }))
      .rejects.toThrow(/^This PDB file's residue names would take 25,003,056 steps to classify, because records with new residue names share residue numbers; at most 25,000,000 are allowed\. Use the structure's mmCIF file, or give each residue its own number\.$/);
    expect(molstar).toMatchObject({ parsed: 0, converted: 0 });
    molstar.stopConversion = 'converter reached';
    // 7,070 names: 24,995,985 steps.
    await expect(inspectionSource({ kind: 'pasted', structureText: sharedNumbers(7_070), format: 'pdb' })).rejects.toThrow('converter reached');
  });
});

describe('PDB text through the MCP tools', () => {
  async function connected() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', import.meta.url).pathname);
    const client = new Client({ name: 'PDB row bound test', version: '0.1.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, close: async () => { await client.close(); await server.close(); } };
  }
  const text = (result: any) => (result.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '';
  const cached = async (client: Client, sessionId: string) =>
    ((await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId } })) as any)._meta[PRIVATE_STRUCTURE_META_KEY];

  it('refuses over-bound PDB for inspection before Mol* parses or converts it', async () => {
    const { client, close } = await connected();
    try {
      const refused: any = await client.callTool({ name: 'stereo_structure.inspect',
        arguments: { source: { kind: 'pasted', text: pdb({ residues: 1_001, models: 1_000 }), format: 'pdb' } } });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(refusal('1,001,000'));
      expect(molstar, text(refused).slice(0, 160)).toMatchObject({ parsed: 0, converted: 0 });
      const aligned: any = await client.callTool({ name: 'stereo_structure.inspect',
        arguments: { source: { kind: 'pasted', text: alignedChain(5_001, 5_000), format: 'pdb' } } });
      expect(aligned.isError).toBe(true);
      expect(text(aligned)).toMatch(/^This PDB file's SEQRES records would take 25,005,000 sequence-alignment steps/);
      expect(molstar, text(aligned).slice(0, 160)).toMatchObject({ parsed: 0, converted: 0 });
    } finally { await close(); }
  });

  it('refuses over-bound PDB for the stereo viewer before caching it, and opens one at the bound and an ordinary ensemble', async () => {
    const { client, close } = await connected();
    try {
      const ordinary = pdb({ residues: 300, models: 20, observed: 'all' }), atBound = pdb({ residues: 1_000, models: 1_000 });
      const opened: any = await client.callTool({ name: 'stereo_structure.open', arguments: { structureText: ordinary, format: 'pdb' } });
      expect(opened.isError, text(opened)).not.toBe(true);
      const sessionId = opened.structuredContent.sessionId as string;
      expect(await cached(client, sessionId)).toMatchObject({ structureText: ordinary, format: 'pdb' });

      // The second holds one atom and 250,000 empty MODEL records, each of which Mol* still walks.
      for (const [over, rows] of [[pdb({ residues: 1_001, models: 1_000 }), '1,001,000'],
        [pdb({ residues: 4, models: 250_000, observed: 'none', atomBeforeModel: true }), '1,000,004']]) {
        const refused: any = await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId, structureText: over, format: 'pdb' } });
        expect(refused.isError).toBe(true);
        expect(text(refused)).toMatch(refusal(rows));
        expect(await cached(client, sessionId)).toMatchObject({ structureText: ordinary, format: 'pdb' });
      }

      const aligned: any = await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId, structureText: alignedChain(5_001, 5_000), format: 'pdb' } });
      expect(aligned.isError).toBe(true);
      expect(text(aligned)).toMatch(/^This PDB file's SEQRES records would take 25,005,000 sequence-alignment steps/);
      expect(await cached(client, sessionId)).toMatchObject({ structureText: ordinary, format: 'pdb' });
      const alignedAtBound = alignedChain(5_000, 5_000);
      const accepted: any = await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId, structureText: alignedAtBound, format: 'pdb' } });
      expect(accepted.isError, text(accepted)).not.toBe(true);
      expect(await cached(client, sessionId)).toMatchObject({ structureText: alignedAtBound, format: 'pdb' });

      const bound: any = await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId, structureText: atBound, format: 'pdb' } });
      expect(bound.isError, text(bound)).not.toBe(true);
      expect(await cached(client, sessionId)).toMatchObject({ structureText: atBound, format: 'pdb' });
      // The stereo viewer's open path never converts on the server.
      expect(molstar).toMatchObject({ parsed: 0, converted: 0 });
    } finally { await close(); }
  });
});
