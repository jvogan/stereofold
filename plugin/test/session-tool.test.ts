import { describe, expect, it } from 'vitest';
import { sessionToolArguments } from '../src/session-tool.js';

describe('session-scoped app tool arguments', () => {
  it('attaches the retained session to arbitrary app payloads', () => {
    expect(sessionToolArguments('54d4de0f-e188-42a8-9921-0c51ea458c44', { action: 'load_pdb', pdbId: '1CRN' }))
      .toEqual({ sessionId: '54d4de0f-e188-42a8-9921-0c51ea458c44', action: 'load_pdb', pdbId: '1CRN' });
  });

  it('does not make an unscoped call and does not accept a caller override', () => {
    expect(sessionToolArguments(undefined, { mode: 'cross' })).toBeUndefined();
    expect(sessionToolArguments('server-session', { sessionId: 'wrong', mode: 'cross' }))
      .toEqual({ sessionId: 'server-session', mode: 'cross' });
  });
});
