/**
 * Residue labels on one stretch of one strand, as one plate.
 *
 * The CRISPR lesson's PAM chapter labels three adjacent bases. Mol* draws a
 * residue label at each residue's own centre, and three bases a few Angstrom
 * apart put "DT 5", "DG 6" and "DG 7" on top of each other at the PAM, so
 * none of them could be read from the front or the side. Plates that name the
 * same strand are one plate: the run's names, anchored at the run's centre.
 *
 * Residues on several strands, or far apart on one, keep a label each: their
 * centres are apart, and one plate between them would sit on neither.
 *
 * A ligand built from several components has no sequence to run along.
 * Sucralose in 9NOV is RRY 1 bonded to RRJ 2, and their labels drew over each
 * other as `RRRY 1`. Components bonded into one molecule are one plate too.
 */

/** The longest run whose residues are named one by one; a longer one names its ends. */
export const RESIDUE_PLATE_LIST_MAX = 4;

/** One residue's name as Mol* labels it, e.g. `DT 5`. */
export function residueLabelText({ componentId, authorResidue, insertionCode } = {}) {
  return `${componentId} ${authorResidue}${insertionCode ?? ''}`;
}

const strandOf = ({ modelNumber, labelChain, copyId, assemblyId, generatorIndex, operatorIds } = {}) =>
  JSON.stringify([modelNumber, labelChain, copyId, assemblyId, generatorIndex, operatorIds]);

/**
 * The single plate for these labelled rows, or undefined when each residue
 * keeps its own label.
 *
 * @param rows selection rows in catalog order, each with `key` and `identity`
 * @returns {{ keys: string[], text: string } | undefined}
 */
export function residueRunPlate(rows = []) {
  if (rows.length < 2) return undefined;
  const strand = strandOf(rows[0].identity);
  if (rows.some(row => strandOf(row.identity) !== strand)) return undefined;
  const numbers = rows.map(row => row.identity.labelSequenceId);
  if (numbers.every(number => number === null || number === undefined)) {
    // A deposited branched entity (e.g. sucralose or a glycan) is one
    // molecule on this label chain. Do not infer bonds from proximity:
    // neighbouring waters, ions and separate ligands keep their identities.
    if (!rows.every(row => row.entityType === 'branched')) return undefined;
  } else {
    if (numbers.some(number => !Number.isInteger(number))) return undefined;
    for (let i = 1; i < numbers.length; i += 1) if (numbers[i] !== numbers[i - 1] + 1) return undefined;
  }
  const names = rows.map(row => residueLabelText(row.identity));
  const text = names.length <= RESIDUE_PLATE_LIST_MAX ? names.join(' · ') : `${names[0]} – ${names.at(-1)}`;
  return { keys: rows.map(row => row.key), text };
}
