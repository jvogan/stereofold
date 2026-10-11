import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { QUEST2_ATOM_SITE_CEILING, stageFitsTier } from '../src/molecular-growth.js';
import type { DemoStage } from '../scripts/quest-demo.js';

/**
 * Nothing counts residues or atoms to refuse a person.
 *
 * `inspection-server.ts` used to hold every surface, the desktop included, to
 * 20,000 residue positions (30,000 for a requested assembly) and 200,000 atom
 * sites. Those three numbers kept one hydration
 * response small and were never measured against a viewer or a documented host
 * ceiling. Chunked hydration removed the reason they existed.
 *
 * The one ceiling that stays is the measured one: a paired Quest 2 refuses a
 * tier over QUEST2_ATOM_SITE_CEILING, and only a quest2-class device is held to
 * it. Both halves are asserted below.
 */
const ROWS = 25_000;
const SITES_PER_ROW = 10;

const synthetic = vi.hoisted(() => {
  const rows = 25_000, sitesPerRow = 10;
  const build = (sourceSha256: string) => ({
    schemaVersion: 'draft-identity-1', molstarVersion: 'synthetic',
    source: { sha256: sourceSha256 }, assemblyId: 'asymmetric_unit', modelNumbers: [1],
    rows: Array.from({ length: rows }, (_, row) => ({
      key: `r${row}`,
      identity: { modelNumber: 1, labelChain: 'A', labelSequenceId: row + 1, componentId: 'GLY' },
      entityType: 'polymer', sequenceDeclared: true, mappingOrigin: 'atom_site', coordinateState: 'resolved',
      atomSites: Array.from({ length: sitesPerRow }, (_, atom) => ({ id: row * sitesPerRow + atom + 1, atomName: 'CA', element: 'C' })),
    })),
  });
  return { build, cache: new Map<string, unknown>() };
});

// Only the extractor is replaced. A 250,000-site source parsed for real would
// build a canonical catalog past this Mac's 64 MiB decode policy, which is a
// named memory bound rather than the count-based refusal under test, so the
// coordinates stay 1CRN's and the catalog is the synthetic one.
vi.mock('../src/inspection-catalog.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/inspection-catalog.js')>();
  const { createHash: hash } = await import('node:crypto');
  return {
    ...original,
    extractInspectionCatalogBytes: async (input: Uint8Array | string) => {
      const text = typeof input === 'string' ? input : Buffer.from(input).toString('utf8');
      const digest = hash('sha256').update(text, 'utf8').digest('hex');
      if (!synthetic.cache.has(digest)) synthetic.cache.set(digest, synthetic.build(digest));
      return synthetic.cache.get(digest);
    },
  };
});

const { createStereoStructureServer } = await import('../src/server.js');
const crn = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

async function session(structureText: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'honest-atom-budget', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: any) => {
    const result = await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    if (result.isError) throw Error(result.content[0].text);
    return result;
  };
  return { call, structureText, close: async () => { await client.close(); await server.close(); } };
}

describe('a residue or atom count no longer refuses an inspection', () => {
  it('opens a catalog of 25,000 residue positions and 250,000 atom sites on the desktop path', async () => {
    const built: any = synthetic.build(createHash('sha256').update(crn, 'utf8').digest('hex'));
    expect(built.rows.length).toBe(ROWS);
    expect(built.rows.reduce((n: number, row: any) => n + row.atomSites.length, 0)).toBe(ROWS * SITES_PER_ROW);

    const t = await session(crn);
    try {
      // Both removed refusals sit on this one call: `verifySourceSelection`
      // before the source is committed, and `current()` while the attachment is
      // built. Either would have thrown for these counts.
      const opened = (await t.call('inspect', { structureText: t.structureText })).structuredContent;
      expect(typeof opened.sessionId).toBe('string');
      const state = (await t.call('get_inspection_state', { sessionId: opened.sessionId })).structuredContent;
      expect(state.sessionId).toBe(opened.sessionId);
    } finally { await t.close(); }
  }, 180_000);

  it('holds only a quest2-class headset to the one ceiling that was measured', () => {
    const stage = (atomSites: number): DemoStage => ({
      id: 'synthetic', order: '1', title: 'Synthetic', pdbId: '1CRN', tiers: ['quest2', 'quest3'],
      lesson: 'synthetic.json', sources: [],
      coordinates: { file: 'synthetic.cif', sha256: 'a'.repeat(64), bytes: 1_000, atomSites, download: 'https://example.invalid/synthetic.cif' },
    });
    expect(stageFitsTier(stage(ROWS * SITES_PER_ROW), 'quest2')).toBe(false);
    expect(stageFitsTier(stage(ROWS * SITES_PER_ROW), 'quest3')).toBe(true);
    expect(stageFitsTier(stage(QUEST2_ATOM_SITE_CEILING), 'quest2')).toBe(true);
    expect(stageFitsTier(stage(QUEST2_ATOM_SITE_CEILING + 1), 'quest2')).toBe(false);
  });
});
