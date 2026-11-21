import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStereoStructureServer } from '../src/server.js';

const ATOM_FIELDS = ['group_PDB', 'id', 'type_symbol', 'label_atom_id', 'label_alt_id', 'label_comp_id', 'label_asym_id',
  'label_entity_id', 'label_seq_id', 'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv',
  'auth_seq_id', 'auth_comp_id', 'auth_asym_id', 'auth_atom_id', 'pdbx_PDB_model_num'].map(field => `_atom_site.${field}`);
/** One atom, and 431 chains that each declare the same 400-position sequence: 172,400 rows. */
const declared = ['data_declared_rows', 'loop_', '_entity.id', '_entity.type', '1 polymer', '#',
  'loop_', '_entity_poly_seq.entity_id', '_entity_poly_seq.num', '_entity_poly_seq.mon_id',
  ...Array.from({ length: 400 }, (_, p) => `1 ${p + 1} ALA`), '#',
  'loop_', '_struct_asym.id', '_struct_asym.entity_id', ...Array.from({ length: 431 }, (_, c) => `C${c} 1`), '#',
  'loop_', ...ATOM_FIELDS, 'ATOM 1 C CA . ALA C0 1 1 ? 0 0 0 1 10 1 ALA C0 CA 1', '#', ''].join('\n');
const REFUSAL = /^Structure and sequence catalog exceeds the 64 MiB this plugin decodes in one browser\. Its declarations expand to at least 172,400 residue rows/;

async function session() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'catalog-row-limit', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: any) => {
    const result = await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    if (result.isError) throw Error(result.content[0].text);
    return result;
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

describe('a source that declares more rows than a catalog can decode', () => {
  it('is refused by inspect with the decode-policy reason', async () => {
    const t = await session();
    try {
      await expect(t.call('inspect', { structureText: declared })).rejects.toThrow(REFUSAL);
    } finally { await t.close(); }
  });
  it('keeps that reason when a source opened in the viewer is inspected later', async () => {
    const t = await session();
    try {
      const opened = (await t.call('open', { structureText: declared, format: 'mmcif' })).structuredContent;
      await expect(t.call('inspect', { sessionId: opened.sessionId })).rejects.toThrow(REFUSAL);
    } finally { await t.close(); }
  });
});
