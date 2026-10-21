import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { resolveStructureSource } from '../src/structure-sources.js';
import { textStateBlock, TEXT_STATE_MAX_CHARS } from '../src/tool-text-state.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
it.each(['4HHB.cif', 'private\nname\u202e.cif', 'x'.repeat(200) + '.cif'])('keeps only a bounded safe display name for local source %j', async filename => {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-provenance-'));
  try {
    const path = join(root, filename);
    await writeFile(path, cif);
    const resolved = await resolveStructureSource({ kind: 'file', path });
    expect(resolved.structureText).toBe(cif);
    expect(resolved.sourceFilename).toBe(filename.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, 160));
    expect(resolved.sourceFilename!.length).toBeLessThanOrEqual(160);
    expect(resolved.sourceFilename).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(resolved.sourceFilename).not.toContain(root);
    expect(resolved).not.toHaveProperty('path');
    expect(resolved).not.toHaveProperty('filePath');
    expect(resolved).not.toHaveProperty('pdbId');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('retains complete source provenance when a large text-only state is bounded', () => {
  const sourceProvenance = { kind: 'file', fileName: 'local-structure.cif', sha256: 'a'.repeat(64) };
  const block = textStateBlock({ sessionId: 'current-session', sourceToken: 'current-source', sourceProvenance,
    residues: { rows: Array.from({ length: 128 }, (_, i) => ({ key: 'canonical-' + i, identity: { componentId: 'ALA', authorResidue: i } })) } });
  expect(block.length).toBeLessThanOrEqual(TEXT_STATE_MAX_CHARS);
  const state = JSON.parse(block.slice(8, -4));
  expect(state.truncated).toBe(true);
  expect(state.sourceProvenance).toEqual(sourceProvenance);
  expect(state.sourceToken).toBe('current-source');
});
