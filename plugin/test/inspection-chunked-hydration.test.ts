import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { MAX_INSPECTION_CHUNK_BYTES, MAX_STRUCTURE_SOURCE_BYTES } from '../src/inspection-limits.js';
import { MAX_INSPECTION_CATALOG_COMPRESSED_BYTES } from '../src/inspection-catalog-codec.js';
import { assembleInspectionPart, hydrateInspectionBytes } from '../src/inspection-chunk-client.js';
import { decodeInspectionCatalog, verifyInspectionCatalogSource } from '../src/inspection-catalog-codec.js';

const crn = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const hhb = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
const sha256 = (text: string | Buffer) => createHash('sha256').update(text as any).digest('hex');

/**
 * A synthetic source past the 6,275,072-byte cap that used to refuse 1AON
 * (6,293,816 bytes). The atoms are 1CRN's, so nothing about the catalog is
 * invented; the padding is mmCIF comment lines, which is what makes it a test
 * of the BYTE policy rather than of the residue and atom-site budgets.
 */
function oversizedSource(): string {
  const comment = '# padding that carries no atoms, only bytes\n';
  const padding = comment.repeat(Math.ceil(6_400_000 / comment.length));
  return `${crn.trimEnd()}\n${padding}`;
}

async function session(structureText: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'honest-caps chunked hydration', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: any) => {
    const result = await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    if (result.isError) throw Error(result.content[0].text);
    return result;
  };
  const sessionId = (await call('inspect', { structureText })).structuredContent.sessionId;
  return { call, sessionId, close: async () => { await client.close(); await server.close(); } };
}

describe('chunked hydration replaces the invented byte caps', () => {
  it('returns descriptors instead of the coordinates, and the chunks reassemble to the exact source', async () => {
    const t = await session(crn);
    try {
      const inline = (await t.call('get_inspection', { sessionId: t.sessionId }))._meta[KEY];
      const chunked = (await t.call('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY];
      expect(inline.structureText).toBe(crn);
      expect(chunked.structureText).toBeUndefined();
      expect(chunked.sourceBytes).toEqual({ sha256: sha256(crn), bytes: Buffer.byteLength(crn, 'utf8') });
      // 1CRN's catalog is small enough that the inline hydration keeps it as a
      // plain object. The chunked one still takes a wire, so the panel has one
      // path rather than a behaviour change at a size threshold.
      expect(inline.catalog).toBeTruthy();
      expect(inline.catalogWire).toBeUndefined();
      expect(chunked.catalog).toBeUndefined();
      expect(chunked.catalogWire.data).toBeUndefined();
      expect(chunked.catalogBytes.bytes).toBe(chunked.catalogWire.compressedBytes);

      const assembled = await assembleInspectionPart((name, args) => t.call(name, args), t.sessionId, 'source', chunked.sourceBytes);
      expect(Buffer.from(assembled).toString('utf8')).toBe(crn);
    } finally { await t.close(); }
  });

  it('serves exact bytes at and across every chunk boundary', async () => {
    const t = await session(crn);
    try {
      const source = Buffer.from(crn, 'utf8');
      const digest = sha256(source);
      for (const [offset, byteCount] of [[0, 1], [0, 3], [1, 7], [source.byteLength - 1, 1],
        [source.byteLength - 5, MAX_INSPECTION_CHUNK_BYTES], [source.byteLength, 1]] as const) {
        const chunk = (await t.call('get_inspection_bytes',
          { sessionId: t.sessionId, part: 'source', offset, byteCount }))._meta[KEY];
        const expected = source.subarray(offset, Math.min(source.byteLength, offset + byteCount));
        expect(Buffer.from(chunk.data, 'base64').equals(expected)).toBe(true);
        expect(chunk.byteCount).toBe(expected.byteLength);
        expect(chunk.totalBytes).toBe(source.byteLength);
        expect(chunk.sha256).toBe(digest);
        expect(chunk.hasMore).toBe(offset + expected.byteLength < source.byteLength);
      }
    } finally { await t.close(); }
  });

  it('refuses an offset past the end and a chunk larger than the documented ceiling', async () => {
    const t = await session(crn);
    try {
      await expect(t.call('get_inspection_bytes',
        { sessionId: t.sessionId, part: 'source', offset: Buffer.byteLength(crn, 'utf8') + 1, byteCount: 8 }))
        .rejects.toThrow(/past the end/);
      await expect(t.call('get_inspection_bytes',
        { sessionId: t.sessionId, part: 'source', offset: 0, byteCount: MAX_INSPECTION_CHUNK_BYTES + 1 }))
        .rejects.toThrow();
      expect(MAX_INSPECTION_CHUNK_BYTES).toBe(98_304);
      // 131,072 base64 characters, under the ~150,000-character threshold the
      // Claude MCP Apps troubleshooting page documents.
      expect(Math.ceil(MAX_INSPECTION_CHUNK_BYTES / 3) * 4).toBe(131_072);
    } finally { await t.close(); }
  });

  it('assembles a large compressed catalog and verifies it against the assembled source', async () => {
    const t = await session(hhb);
    try {
      const data = (await t.call('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY];
      expect(data.catalogWire).toBeTruthy();
      expect(data.catalogWire.data).toBeUndefined();
      expect(data.catalogBytes.bytes).toBe(data.catalogWire.compressedBytes);
      await hydrateInspectionBytes(data, (name, args) => t.call(name, args));
      expect(data.sourceBytes).toBeUndefined();
      expect(data.catalogBytes).toBeUndefined();
      expect(data.structureText).toBe(hhb);
      const catalog = await decodeInspectionCatalog(data.catalogWire);
      await expect(verifyInspectionCatalogSource(data.structureText, catalog)).resolves.toBeUndefined();
      expect(catalog.rows.length).toBeGreaterThan(0);
    } finally { await t.close(); }
  });

  it('rejects a corrupted, short, misdigested or out-of-order chunk', async () => {
    const t = await session(crn);
    try {
      const descriptor = (await t.call('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY].sourceBytes;
      const tamper = (change: (chunk: any) => void) => async (name: string, args: any) => {
        const answer = await t.call(name, args);
        change(answer._meta[KEY]);
        return answer;
      };
      const flip = (chunk: any) => {
        const bytes = Buffer.from(chunk.data, 'base64');
        bytes[0] = bytes[0] ^ 0xff;
        chunk.data = bytes.toString('base64');
      };
      for (const corrupt of [flip,
        (chunk: any) => { chunk.data = Buffer.from(chunk.data, 'base64').subarray(0, 4).toString('base64'); },
        (chunk: any) => { chunk.sha256 = 'f'.repeat(64); },
        (chunk: any) => { chunk.offset = chunk.offset + 1; },
        (chunk: any) => { chunk.totalBytes = chunk.totalBytes + 1; },
        (chunk: any) => { chunk.data = '!!!not base64!!!'; }]) {
        await expect(assembleInspectionPart(tamper(corrupt), t.sessionId, 'source', descriptor)).rejects.toThrow();
      }
      // The untampered assembly still succeeds, so the rejections above are
      // about the corruption and not about the harness.
      await expect(assembleInspectionPart((name, args) => t.call(name, args), t.sessionId, 'source', descriptor)).resolves.toBeTruthy();
    } finally { await t.close(); }
  });

  it('rejects an assembly whose session source was really replaced between two chunk calls', async () => {
    const t = await session(hhb);
    try {
      const descriptor = (await t.call('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY].sourceBytes;
      // More than one chunk, so there is a gap between two calls to swap in.
      expect(descriptor.bytes).toBeGreaterThan(MAX_INSPECTION_CHUNK_BYTES);
      // Not a tampered answer: the session itself opens different coordinates
      // while the panel is midway through assembling the ones it asked for.
      const replacement = `${hhb.trimEnd()}\n# one comment line, which makes this a different source\n`;
      let chunks = 0;
      const replaceAfterFirstChunk = async (name: string, args: any) => {
        const answer = await t.call(name, args);
        if (++chunks === 1) await t.call('open', { sessionId: t.sessionId, structureText: replacement });
        return answer;
      };
      await expect(assembleInspectionPart(replaceAfterFirstChunk, t.sessionId, 'source', descriptor))
        .rejects.toThrow(/changed during delivery/);
      // The refusal came from the second chunk's own digest and totalBytes, not
      // from the whole-part digest at the end, so no further bytes were pulled.
      expect(chunks).toBe(2);
    } finally { await t.close(); }
  }, 60_000);

  it('refuses a descriptor declaring more bytes than its part is ever allowed', async () => {
    const t = await session(crn);
    try {
      const data = (await t.call('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY];
      const never = async () => { throw Error('no chunk should be requested for a descriptor past the bound'); };
      await expect(assembleInspectionPart(never, t.sessionId, 'source',
        { sha256: data.sourceBytes.sha256, bytes: MAX_STRUCTURE_SOURCE_BYTES + 1 }))
        .rejects.toThrow(/invalid coordinate descriptor/);
      await expect(assembleInspectionPart(never, t.sessionId, 'catalog',
        { sha256: data.catalogBytes.sha256, bytes: MAX_INSPECTION_CATALOG_COMPRESSED_BYTES + 1 }))
        .rejects.toThrow(/invalid coordinate descriptor/);
      // The bound itself is allowed, so the refusal above is the descriptor and
      // not an off-by-one that would refuse a source this plugin will download.
      await expect(assembleInspectionPart(never, t.sessionId, 'source',
        { sha256: data.sourceBytes.sha256, bytes: MAX_STRUCTURE_SOURCE_BYTES }))
        .rejects.toThrow(/no chunk should be requested/);
    } finally { await t.close(); }
  });

  it('rejects a descriptor whose digest disagrees with the catalog it arrived with', async () => {
    const t = await session(crn);
    try {
      const data = (await t.call('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY];
      data.sourceBytes = { ...data.sourceBytes, sha256: 'a'.repeat(64) };
      await expect(hydrateInspectionBytes(data, (name, args) => t.call(name, args)))
        .rejects.toThrow(/changed during delivery/);
    } finally { await t.close(); }
  });
});

describe('a source past the caps that were removed', () => {
  it('opens a 1AON-sized source, which the 6,275,072-byte cap refused', async () => {
    const big = oversizedSource();
    const bytes = Buffer.byteLength(big, 'utf8');
    expect(bytes).toBeGreaterThan(6_293_816);
    expect(bytes).toBeLessThan(MAX_STRUCTURE_SOURCE_BYTES);
    const t = await session(big);
    try {
      const data = (await t.call('get_inspection', { sessionId: t.sessionId, transport: 'chunked' }))._meta[KEY];
      expect(data.sourceBytes).toEqual({ sha256: sha256(big), bytes });
      await hydrateInspectionBytes(data, (name, args) => t.call(name, args));
      expect(data.structureText).toBe(big);
      const catalog = await decodeInspectionCatalog(data.catalogWire);
      await expect(verifyInspectionCatalogSource(data.structureText, catalog)).resolves.toBeUndefined();
    } finally { await t.close(); }
  }, 120_000);
});
