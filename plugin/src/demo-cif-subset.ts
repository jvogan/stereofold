/**
 * Cutting a deposited mmCIF file down to the chains one demo tier shows.
 *
 * This lived in `scripts/quest-demo.ts`, beside the launcher that warms the
 * demo cache before a headset goes on. The running server needs the same cut:
 * a grow into a tier nobody warmed has to fetch that tier itself, and two
 * of the microtubule tiers are subsets of a larger download rather than whole
 * files. The launcher still re-exports these, so there is one implementation
 * and one set of tests.
 *
 * Every retained line is a deposited line, byte for byte. Nothing here alters
 * a coordinate, and nothing here reaches the network.
 */
const CHAIN_TAG = /^_struct_asym\.id$|(?:^|\.)(?:label_asym_id|auth_asym_id|asym_id|pdb_strand_id|beg_label_asym_id|end_label_asym_id|beg_auth_asym_id|end_auth_asym_id|ptnr1_label_asym_id|ptnr2_label_asym_id|ptnr1_auth_asym_id|ptnr2_auth_asym_id|range_1_label_asym_id|range_2_label_asym_id|range_1_auth_asym_id|range_2_auth_asym_id|range_1_beg_label_asym_id|range_1_end_label_asym_id|range_2_beg_label_asym_id|range_2_end_label_asym_id|orig_label_asym_id|orig_auth_asym_id)$/;
const SHEET_TAG = /\.sheet_id$/;
type CifBlock = { kind: 'line'; text: string } | { kind: 'loop'; tags: string[]; tagLines: string[]; rows: string[] };

/** The assembly file names each expanded chain `<chain>-<operator>`; operator 1 keeps the deposited name. */
function operatorOf(chain: string): string {
  const dash = chain.lastIndexOf('-');
  return dash < 0 ? '1' : chain.slice(dash + 1);
}

function cifBlocks(text: string): CifBlock[] {
  const lines = text.split('\n');
  const blocks: CifBlock[] = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].trim() !== 'loop_') { blocks.push({ kind: 'line', text: lines[index] }); index++; continue; }
    index++;
    const tags: string[] = [], tagLines: string[] = [];
    while (index < lines.length && lines[index].trimStart().startsWith('_')) { tags.push(lines[index].trim().split(/\s+/)[0]); tagLines.push(lines[index]); index++; }
    const rows: string[] = [];
    while (index < lines.length && lines[index].trim() !== '#') { rows.push(lines[index]); index++; }
    blocks.push({ kind: 'loop', tags, tagLines, rows });
  }
  return blocks;
}

/**
 * Keep only the named operators of an RCSB biological-assembly mmCIF file.
 *
 * Every retained line is a deposited line, byte for byte: this drops chains and
 * the header rows that describe them, and alters no coordinate. The complete
 * assembly of a helical entry can be several times the inspector's source-byte
 * budget, and a subset of adjacent operators is the largest honest fallback.
 */
export function subsetAssemblyOperators(text: string, operators: readonly string[]): string {
  const keep = new Set(operators);
  const blocks = cifBlocks(text);
  const chains = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== 'loop' || !block.tags[0]?.startsWith('_atom_site.')) continue;
    const label = block.tags.indexOf('_atom_site.label_asym_id'), auth = block.tags.indexOf('_atom_site.auth_asym_id');
    if (label < 0 || auth < 0) throw Error('The assembly file has no chain columns in its atom-site loop.');
    for (const row of block.rows) {
      if (!/^(?:ATOM|HETATM)/.test(row)) continue;
      const fields = row.split(/\s+/).filter(Boolean);
      if (keep.has(operatorOf(fields[auth]))) { chains.add(fields[label]); chains.add(fields[auth]); }
    }
  }
  if (chains.size === 0) throw Error(`No deposited chain belongs to assembly operators ${operators.join(', ')}.`);
  return keepChains(blocks, chains);
}

/**
 * Keep only the deposited entities named by `entityIds`, as their own chains.
 *
 * The smallest honest tier of the growth demo is one tubulin monomer, and a
 * monomer is not an operator subset: it is one entity of the deposited
 * asymmetric unit. Every retained line is a deposited line, byte for byte.
 */
export function subsetDepositedEntities(text: string, entityIds: readonly string[]): string {
  const wanted = new Set(entityIds.map(String));
  const blocks = cifBlocks(text);
  const chains = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== 'loop' || !block.tags[0]?.startsWith('_atom_site.')) continue;
    const label = block.tags.indexOf('_atom_site.label_asym_id'), entity = block.tags.indexOf('_atom_site.label_entity_id');
    if (label < 0 || entity < 0) throw Error('The coordinate file has no chain and entity columns in its atom-site loop.');
    for (const row of block.rows) {
      if (!/^(?:ATOM|HETATM)/.test(row)) continue;
      const fields = row.split(/\s+/).filter(Boolean);
      if (wanted.has(fields[entity])) chains.add(fields[label]);
    }
  }
  if (chains.size === 0) throw Error(`No deposited chain belongs to entities ${entityIds.join(', ')}.`);
  return keepChains(blocks, chains);
}

/** Drop every row that names a chain outside `chains`, and every loop so emptied. */
function keepChains(blocks: readonly CifBlock[], chains: ReadonlySet<string>): string {
  // A row shorter than its tag list is a quoted or multi-line value this filter
  // does not tokenize. Those loops carry no chain column in practice; keep them.
  const rowKept = (tags: string[], row: string): boolean => {
    const fields = row.split(/\s+/).filter(Boolean);
    if (fields.length < tags.length) return true;
    return !tags.some((tag, column) => CHAIN_TAG.test(tag) && fields[column] !== '?' && fields[column] !== '.' && !chains.has(fields[column]));
  };
  // Sheet order and hydrogen-bond rows name a sheet rather than a chain, so
  // they survive only while one of that sheet's ranges survives.
  const sheets = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== 'loop' || !block.tags[0]?.startsWith('_struct_sheet_range.')) continue;
    const column = block.tags.findIndex(tag => SHEET_TAG.test(tag));
    for (const row of block.rows) if (column >= 0 && rowKept(block.tags, row)) sheets.add(row.split(/\s+/).filter(Boolean)[column]);
  }

  const output: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'line') { output.push(block.text); continue; }
    const hasChain = block.tags.some(tag => CHAIN_TAG.test(tag));
    const sheetColumn = block.tags.findIndex(tag => SHEET_TAG.test(tag));
    if (!hasChain && sheetColumn < 0) { output.push('loop_', ...block.tagLines, ...block.rows); continue; }
    const rows = block.rows.filter(row => {
      if (row.trim() === '') return false;
      if (hasChain && !rowKept(block.tags, row)) return false;
      const fields = row.split(/\s+/).filter(Boolean);
      if (sheetColumn >= 0 && fields.length >= block.tags.length && !sheets.has(fields[sheetColumn])) return false;
      return true;
    });
    // An empty loop is not valid mmCIF, so a category that lost every row goes.
    if (rows.length === 0) continue;
    output.push('loop_', ...block.tagLines, ...rows);
  }
  return output.join('\n');
}
