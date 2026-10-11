import { describe, expect, it } from 'vitest';
import { PRIVATE_STRUCTURE_META_KEY } from '../src/structure-result.js';
import { privateStructurePayload, structuredToolContent, thrownErrorMessage, toolResultError } from '../src/tool-result.js';

describe('MCP tool result readers', () => {
  it('distinguishes a successful result from a fulfilled MCP error result', () => {
    expect(toolResultError({ structuredContent: { kind: 'view' } })).toBeUndefined();
    expect(toolResultError({
      isError: true,
      content: [{ type: 'text', text: 'RCSB returned HTTP 404.' }],
    })).toBe('RCSB returned HTTP 404.');
  });

  it('joins portable text blocks and never returns a blank error', () => {
    expect(toolResultError({
      isError: true,
      content: [
        { type: 'image', data: 'ignored' },
        { type: 'text', text: '  First sentence. ' },
        { type: 'text', text: 'Second sentence.' },
      ],
    })).toBe('First sentence. Second sentence.');
    expect(toolResultError({ isError: true, content: [] })).toBe('The server returned an error.');
  });

  it('reads only object structured content', () => {
    expect(structuredToolContent<{ kind: string }>({ structuredContent: { kind: 'open' } }))
      .toEqual({ kind: 'open' });
    expect(structuredToolContent({ structuredContent: 'not an object' })).toBeUndefined();
    expect(structuredToolContent(undefined)).toBeUndefined();
  });

  it('reads coordinates only from namespaced private result metadata', () => {
    const coordinates = 'ATOM      1  N   GLY A   1\nEND\n';
    expect(privateStructurePayload<{ structureText: string }>({
      structuredContent: { kind: 'structure', structureText: coordinates },
    })).toBeUndefined();
    expect(privateStructurePayload<{ structureText: string }>({
      structuredContent: { kind: 'structure', empty: false },
      _meta: { [PRIVATE_STRUCTURE_META_KEY]: { kind: 'structure', structureText: coordinates } },
    })).toEqual({ kind: 'structure', structureText: coordinates });
  });

  it('normalizes thrown bridge failures', () => {
    expect(thrownErrorMessage(new Error('Host disconnected.'))).toBe('Host disconnected.');
    expect(thrownErrorMessage('  timed out ')).toBe('timed out');
    expect(thrownErrorMessage(undefined)).toBe('The host did not complete the request.');
  });
});
