import { chainIdentityKey, chainIdentityLabel, hiddenRowKeys, normalizeVisibility } from './inspection-visibility.mjs';
import { READOUT_PAGE_LINE_WIDTH, pageCaptionText } from './spatial-toolbar-geometry.mjs';
import { demoSourceIdentity } from './demo-source-identity.mjs';

/** Coordinate-free subject, cached by rendered source/model; never scan residues per frame. */
export function createStructureSubjectReader() {
  let priorSource, priorModel, priorModelNumber, priorAssembly, base, rows, scopedRows, chains;
  return (source, model, snapshot) => {
    if (!source || !snapshot?.ready) return undefined;
    const assembly = snapshot.assemblyId ?? source.catalog?.assemblyId;
    if (source !== priorSource || model !== priorModel || snapshot.modelNumber !== priorModelNumber || assembly !== priorAssembly) {
      priorSource = source; priorModel = model; priorModelNumber = snapshot.modelNumber; priorAssembly = assembly;
      const title = model?.sourceData?.data?.db?.struct?.title?.value(0);
      const displayProvenance = demoSourceIdentity(source.sha256);
      const entry = (displayProvenance?.kind === 'bundled-file' ? [displayProvenance.pdbId] : [displayProvenance?.pdbId, source.pdbId, source.code, model?.entryId])
        .find(value => typeof value === 'string' && /^[a-z0-9]{4}$/iu.test(value) && value.toUpperCase() !== 'XXXX');
      const pdbId = typeof entry === 'string' && /^[a-z0-9]{4}$/iu.test(entry) ? entry.toUpperCase() : undefined;
      rows = (source.catalog?.rows ?? []).filter(row => row.coordinateState === 'resolved'
        && (snapshot.modelNumber == null || row.identity.modelNumber === snapshot.modelNumber));
      scopedRows = rows.filter(row => (!source.visible?.entityIds?.length || source.visible.entityIds.includes(row.identity.entityId))
        && (!source.visible?.labelChains?.length || source.visible.labelChains.includes(row.identity.labelChain))
        && (!source.visible?.operatorIds?.length || (row.identity.operatorIds?.length && row.identity.operatorIds.every(id => source.visible.operatorIds.includes(id)))));
      chains = [...new Map(rows.map(row => [chainIdentityKey(row.identity), row.identity])).values()];
      const polymerChains = new Set(rows.filter(row => row.entityType === 'polymer').map(row => chainIdentityKey(row.identity)));
      const hiddenEntities = source.visible?.entityIds?.length
        ? [...new Set(rows.map(row => row.identity.entityId))].filter(id => !source.visible.entityIds.includes(id)) : [];
      base = { pdbId, sourceSha256: source.sha256, title: displayProvenance?.title ?? displayTitle(title || source.title || pdbId || 'Molecular structure'),
        chains: polymerChains.size, assembly, modelNumber: snapshot.modelNumber,
        ...(displayProvenance ? { displayProvenance } : {}),
        ...(hiddenEntities.length ? { hiddenEntities } : {}) };
    }
    const appearance = snapshot.appearance ?? snapshot.inspection?.appearance ?? {};
    const visibility = normalizeVisibility(snapshot.visibility);
    const hidden = new Set(hiddenRowKeys(scopedRows, visibility, snapshot.selectionKeys));
    const shownChains = new Set(scopedRows.filter(row => row.entityType === 'polymer' && !hidden.has(row.key))
      .map(row => chainIdentityKey(row.identity))).size;
    const emphasis = snapshot.emphasis;
    const focus = (emphasis?.focus ?? []).map(id => emphasis.parts?.find(part => part.id === id)?.label || id);
    return { ...base, selectionCount: snapshot.selectionKeys?.length ?? 0,
      representation: appearance.representation, color: appearance.color,
      ...(snapshot.figure ? { figure: true } : {}),
      ...(shownChains !== base.chains ? { shownChains } : {}),
      ...(visibility.hiddenChains.length ? { hiddenChains: visibility.hiddenChains.map(chain => chainIdentityLabel(chain, chains).replace(/^chain /u, '')) } : {}),
      ...(visibility.hiddenClasses.length ? { hiddenClasses: visibility.hiddenClasses } : {}),
      ...(visibility.showOnlySelection ? { showOnlySelection: true } : {}),
      ...(emphasis?.parts?.length ? { emphasisCount: emphasis.parts.length, focus, contextOpacity: emphasis.contextOpacity } : {}),
      ...(snapshot.styles?.length ? { styles: snapshot.styles } : {}) };
  };
}

/** Whole words fitted with the renderer's current font and line allocation. */
function entryTextFits(text, measureText, width, maxLines) {
  let lines = 1, current = '';
  for (const word of text.split(' ')) {
    if (measureText(word) > width) return false;
    const next = current ? `${current} ${word}` : word;
    if (current && measureText(next) > width) { lines += 1; current = word; }
    else current = next;
  }
  return lines <= maxLines;
}

/**
 * "5 PDB entries: 5SYF 9L7M 8RHB 1BG2 3KIN". IDs are kept whole. If they would
 * pass the row's two lines, as many whole IDs as fit are shown, then "+k more".
 */
export function compositeEntryLine(entries, modelled = [], { measureText = text => text.length, width = 26, maxLines = 2 } = {}) {
  const label = modelled.map(source => source.label || source.note || source.id).join(', ').replace(/\s+/gu, ' ').trim();
  // Keep disclosure even when the author's note is too long for this row.
  const shortLabel = label.length <= 12 ? label : 'parts';
  if (!entries.length && modelled.length) return `Local modelled ${shortLabel}`;
  const header = `${entries.length} PDB entries${modelled.length ? ` + modelled ${shortLabel}` : ''}:`;
  for (const heading of [header, `${entries.length} PDB${modelled.length ? ' + modelled' : ''}:`]) {
    for (let shown = entries.length; shown >= 0; shown -= 1) {
      const more = shown < entries.length ? ` +${entries.length - shown} more` : '';
      const text = `${heading}${shown ? ` ${entries.slice(0, shown).join(' ')}` : ''}${more}`;
      if (entryTextFits(text, measureText, width, maxLines)) return text;
    }
  }
  return `${header} +${entries.length} more`;
}

/**
 * A deposited title arrives in capitals and has to be read, not shouted. Only
 * an all-capitals title is touched; a mixed-case one is already written the way
 * its depositor meant it.
 *
 * 1CRN's title carries two sentences: `WATER STRUCTURE OF A HYDROPHOBIC PROTEIN
 * AT ATOMIC RESOLUTION. PENTAGON RINGS OF WATER MOLECULES IN CRYSTALS OF
 * CRAMBIN`. Lowercasing everything after the first character put `pentagon`
 * after a full stop on the Quest 2 plate. Each sentence keeps its capital instead.
 */
export function sentenceTitle(value) {
  const text = String(value).replace(/\s+/gu, ' ').trim();
  if (text !== text.toUpperCase()) return text;
  const lowered = text.charAt(0) + text.slice(1).toLowerCase();
  return lowered.replace(/([.?!] )(\p{Ll})/gu, (match, stop, letter) => stop + letter.toUpperCase());
}

/**
 * The deposited title, minus the words that every entry shares. "THE CRYSTAL
 * STRUCTURE OF HUMAN DEOXYHAEMOGLOBIN AT 1.74 A RESOLUTION" (4HHB) fitted one
 * caption line as "The crystal…" on the hardware run, which named
 * nothing. Method prefixes and resolution suffixes go; the subject stays.
 */
export function displayTitle(value) {
  let text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  text = text.replace(/^(?:the\s+)?(?:(?:x-?ray|crystal|cryo-?em|electron microscopy|solution|nmr|neutron|refined|high[- ]resolution|atomic[- ]resolution)\s+)*(?:crystal\s+|nmr\s+|solution\s+)?structures?\s+(?:of\s+|for\s+)(?:the\s+)?/iu, '');
  text = text.replace(/\s+(?:at|to)\s+\d+(?:\.\d+)?\s*(?:a|å|angstroms?)\s+resolution\.?$/iu, '');
  text = text.replace(/\s*[.;,]$/u, '');
  if (/^[a-z0-9]{4}$/iu.test(text)) return text.toUpperCase();
  return sentenceTitle(text || value);
}

/**
 * How many lines the description row owns, and how wide the glass promises to
 * be. Two lines at fifteen characters is the row's existing budget, unchanged:
 * the description is paged to exactly what it already had, so paging costs the
 * plate no height and moves nothing below it.
 */
export const DESCRIPTION_PAGE_LINES = 2;

/**
 * The description, cut into pages the row can hold whole.
 *
 * A Quest 2 resting plate read `Water structure of a hydrophobic
 * protein at atomic resolution, pentagon rings of water molecules in…` and the
 * expanded menu had no row that could reach the rest of the sentence
 * The ellipsis was the geometry
 * doing its job on a row that had never been paged; every other long line on
 * the plate — a reply, a refusal, a lesson's prose — had been given a page
 * control the frame before. This is that control's other half.
 *
 * The paginator is the one the tour caption uses (`pageCaptionText`), so the
 * two cannot cut a sentence differently. A description that fits stays one
 * page and nothing about the plate changes.
 */
export function structureDescriptionPages(subject) {
  const title = typeof subject?.title === 'string' ? subject.title : '';
  if (!title.trim()) return [];
  const pages = pageCaptionText(title, READOUT_PAGE_LINE_WIDTH * DESCRIPTION_PAGE_LINES,
    READOUT_PAGE_LINE_WIDTH, DESCRIPTION_PAGE_LINES);
  if (pages.length === 1) return pages;
  // Leave room for the continuation mark even when the geometry rewraps a
  // page. Paginate the complete title at that width so the mark displaces no
  // words; the page row counts these same pages.
  return pageCaptionText(title, READOUT_PAGE_LINE_WIDTH * DESCRIPTION_PAGE_LINES,
    READOUT_PAGE_LINE_WIDTH - 1, DESCRIPTION_PAGE_LINES);
}

/**
 * Names in first-seen order, each once. A name that repeats carries its count,
 * so "Alpha tubulin, Beta tubulin, Alpha tubulin, Beta tubulin" reads
 * "Alpha tubulin ×2, Beta tubulin ×2".
 */
export function countedNames(names) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
}

/**
 * Semantic rows; the shared geometry wraps within the existing glass.
 *
 * `descriptionPage` is which page of the description to draw, counted from
 * zero and wrapped around, so a caller that only ever increments a counter
 * cycles the sentence rather than running off its end.
 */
export function structureReadout(subject, { descriptionPage = 0 } = {}) {
  if (!subject) return [];
  const pages = structureDescriptionPages(subject);
  const pageIndex = pages.length > 1
    ? ((Math.trunc(Number(descriptionPage) || 0) % pages.length) + pages.length) % pages.length : 0;
  // The page reserves room for its continuation mark. The final page has no
  // mark, and a title that fits keeps its original text.
  const description = pages.length > 1
    ? { text: pages[pageIndex].replace(/\n/gu, ' ') + (pageIndex < pages.length - 1 ? '…' : ''), maxLines: DESCRIPTION_PAGE_LINES }
    : { text: subject.title, maxLines: DESCRIPTION_PAGE_LINES };
  const assembly = subject.assembly === 'asymmetric_unit'
    ? subject.displayProvenance?.scope ?? (subject.pdbId ? 'asymmetric unit' : 'local coordinates')
    : subject.assembly ? `biological assembly ${subject.assembly}` : '';
  const chainCount = Number.isInteger(subject.chains)
    ? Number.isInteger(subject.shownChains) ? `${subject.shownChains} of ${subject.chains} chains shown`
      : `${subject.chains} ${subject.chains === 1 ? 'chain' : 'chains'}` : '';
  // A prepared composite is named by the deposited entries it was built from.
  // Its copy chains (A1_1, K1T_2 …) are generated, so they are never read out.
  const isComposite = subject.displayProvenance?.kind === 'prepared-rigid-composite';
  const entries = isComposite ? subject.displayProvenance.entries : undefined;
  const modelled = subject.displayProvenance?.sources?.filter(source => source.kind === 'modelled') ?? [];
  const composite = modelled.length ? compositeEntryLine(entries ?? [], modelled) : entries?.length === 1 ? `${entries[0]} · prepared from one entry`
    : entries?.length ? compositeEntryLine(entries) : isComposite ? 'Prepared composite · source metadata unavailable' : '';
  const bundled = subject.displayProvenance?.kind === 'bundled-file';
  const identity = composite || [bundled ? subject.displayProvenance.sourceId : subject.pdbId, chainCount, assembly].filter(Boolean).join(' · ');
  const hidden = [...(isComposite || bundled ? [] : subject.hiddenChains ?? []), ...(subject.hiddenEntities ?? []).map(id => `entity ${id}`),
    ...(subject.hiddenClasses ?? []).map(name => ({ ligand: 'ligands', ion: 'ions', polymer: 'polymer', water: 'water' })[name] ?? name)];
  const visibility = [hidden.length ? `${hidden.join(', ')} hidden` : '', subject.showOnlySelection ? 'only selection shown' : ''].filter(Boolean).join(' · ');
  const appearance = value => {
    const representation = { 'ball-and-stick': 'sticks', 'molecular-surface': 'surface' }[value.representation] ?? value.representation;
    const color = { 'chain-id': 'chain', 'element-symbol': 'element', 'residue-name': 'residue', 'sequence-id': 'sequence' }[value.color] ?? value.color;
    if (value.color === 'uniform') return representation ? `${representation} in one colour` : '';
    return representation ? `${representation}${color ? ` by ${color}` : ''}` : '';
  };
  const styles = [...new Set((subject.styles ?? []).map(appearance).filter(Boolean))];
  const style = subject.figure ? 'labelled molecular scene'
    : [appearance(subject), styles.length ? `partial: ${styles.join(', ')}` : ''].filter(Boolean).join(' · ');
  const focus = subject.focus?.length ? `focus: ${countedNames(subject.focus).join(', ')}` : subject.emphasisCount ? `${subject.emphasisCount} parts emphasized` : '';
  const emphasis = [focus, focus && Number.isFinite(subject.contextOpacity) && subject.contextOpacity < 1
    ? `context ${Math.round(subject.contextOpacity * 100)}%` : ''].filter(Boolean).join(' · ');
  const detailed = Boolean(visibility || emphasis || styles.length);
  const compactIdentity = composite ? composite : Number.isInteger(subject.shownChains) ? `${subject.shownChains}/${subject.chains} chains shown`
    : [subject.pdbId, chainCount].filter(Boolean).join(' · ');
  return [description,
    { text: identity, maxLines: 2, ...(isComposite && entries?.length > 1
      ? { fitText: options => compositeEntryLine(entries, modelled, options) } : {}), keepTogether: ['asymmetric unit', 'biological assembly'], ...(detailed ? { compactText: compactIdentity } : {}) },
    ...(visibility ? [{ text: visibility, maxLines: 2 }] : []),
    { text: detailed ? style : `${style}${style ? ' · ' : ''}${subject.selectionCount ?? 0} selected`, maxLines: 2 },
    ...(detailed ? [{ text: `${subject.selectionCount ?? 0} selected`, maxLines: 1 }] : []),
    ...(emphasis ? [{ text: emphasis, maxLines: 2 }] : [])];
}
