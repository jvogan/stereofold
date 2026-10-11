/**
 * What a browser page may load in place of the structure it is showing.
 *
 * Every `/tool` call on the companion comes from a page, and through the LAN
 * listener and the Quest link that page can be a paired headset. The resolver
 * behind `replace_inspection_source` reads absolute local paths, fetches any
 * https URL and accepts pasted coordinates, so a headset that named a path
 * could make this Mac read any .cif file on it. A page may name a public
 * entry: a PDB ID or an AlphaFold accession. The agent's own MCP calls never
 * reach this route and keep every source kind.
 */
export const PAGE_SOURCE_KINDS: ReadonlySet<string> = new Set(['pdb', 'alphafold']);

export const PAGE_SOURCE_REFUSAL = 'A page can load only a PDB ID or an AlphaFold accession. '
  + 'Ask the assistant on the Mac to open a file, a web address or pasted coordinates.';

/**
 * The refusal for a page's tool call that names any other source, or
 * undefined when the call may run.
 *
 * `replace_inspection_source` is the one page tool that takes a source from
 * its caller, and its compare mode resolves the same `source` field. Its
 * `pdbId` field is held to four characters by the tool's own schema.
 */
export function pageSourceRefusal(name: string, args: unknown): string | undefined {
  if (name !== 'replace_inspection_source' || !args || typeof args !== 'object') return undefined;
  const source = (args as { source?: unknown }).source;
  if (source === undefined) return undefined;
  const kind = source && typeof source === 'object' ? (source as { kind?: unknown }).kind : undefined;
  return typeof kind === 'string' && PAGE_SOURCE_KINDS.has(kind) ? undefined : PAGE_SOURCE_REFUSAL;
}
