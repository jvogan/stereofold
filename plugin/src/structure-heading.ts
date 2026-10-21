import { CIF } from './compatible-cif.js';

/**
 * The name the panel heading gives a structure.
 *
 * A file opened from disk used to read "Molecular structure" with an "mmCIF"
 * tag, although the file says what it is: `_entry.id` holds the PDB code and
 * `_entity.pdbx_description` names each polymer. Both sit in the header, ahead
 * of `_atom_site`, so only the header is parsed, and never more than 1 MiB of
 * it. A file that names neither keeps the generic heading.
 */
export interface StructureHeading {
  /** A polymer name, such as "Hemoglobin" for 4HHB or "Crambin" for 1CRN. */
  name?: string;
  /** A four-character PDB code, upper case. */
  code?: string;
}

const HEADER_LIMIT = 1 << 20;
const PDB_CODE = /^[0-9A-Za-z]{4}$/u;
const EMPTY = new Set(['', '?', '.']);

/** The text before `_atom_site`, cut at the last category boundary. */
function headerText(text: string): string {
  const atoms = text.slice(0, HEADER_LIMIT).search(/^_atom_site\./mu);
  const end = atoms < 0 ? Math.min(text.length, HEADER_LIMIT) : atoms;
  if (end === text.length) return text;
  const cut = Math.max(text.lastIndexOf('\n#', end), text.lastIndexOf('\nloop_', end));
  return cut > 0 ? text.slice(0, cut + 1) : '';
}

/**
 * Old entries spell names in capitals ("CRAMBIN"). Lower-case each all-letter
 * word of four or more letters and capitalise the first letter, so acronyms
 * such as DNA and codes such as HIV-1 keep their case.
 */
function tidy(name: string): string {
  const quiet = /\p{Ll}/u.test(name) ? name : name.replace(/\b\p{Lu}{4,}\b/gu, word => word.toLowerCase());
  return quiet.charAt(0).toUpperCase() + quiet.slice(1);
}

/**
 * One name for all the polymers: the name itself when there is one, otherwise
 * the words every name starts with ("Hemoglobin subunit alpha" and
 * "Hemoglobin subunit beta" give "Hemoglobin"). Nothing shared, no name.
 */
function polymerName(names: readonly string[]): string | undefined {
  const unique = [...new Set(names.map(name => name.trim().replace(/\s+/gu, ' ')))];
  if (unique.length === 1) return tidy(unique[0]);
  const words = unique.map(name => name.split(' '));
  const shared: string[] = [];
  while (shared.length < words[0].length
    && words.every(list => list[shared.length]?.toLowerCase() === words[0][shared.length].toLowerCase())) shared.push(words[0][shared.length]);
  while (shared.length && /^(subunit|chain|[-,:(])$|\([^)]*$/iu.test(shared[shared.length - 1])) shared.pop();
  return shared.length ? tidy(shared.join(' ')) : undefined;
}

export async function readStructureHeading(structureText: string): Promise<StructureHeading> {
  const header = headerText(structureText);
  if (!/^data_/mu.test(header.slice(0, 4096))) return {};
  const parsed = await CIF.parse(header).run();
  if (parsed.isError) return {};
  const block = parsed.result.blocks[0];
  const heading: StructureHeading = {};
  const id = block?.categories.entry?.getField('id')?.str(0);
  if (id && PDB_CODE.test(id)) heading.code = id.toUpperCase();
  const entity = block?.categories.entity;
  const names: string[] = [];
  for (let row = 0; row < (entity?.rowCount ?? 0); row++) {
    if (entity!.getField('type')?.str(row).toLowerCase() !== 'polymer') continue;
    const name = entity!.getField('pdbx_description')?.str(row) ?? '';
    if (!EMPTY.has(name.trim())) names.push(name);
  }
  const name = names.length ? polymerName(names) : undefined;
  if (name) heading.name = name;
  return heading;
}
