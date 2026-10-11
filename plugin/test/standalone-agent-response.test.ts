import { describe, expect, it } from 'vitest';
import { standaloneAgentResponse } from '../src/standalone-agent-response.js';

const key = 'stereo_structure/inspection';

describe('standalone admin voice response boundary', () => {
  it('preserves only the claim receipt needed by the local headset relay', () => {
    const claim = { intent: { id: 'intent', transcript: 'explain this', sessionId: 'session' }, claimToken: 'claim' };
    const result = { content: [{ type: 'text', text: 'claimed' }], structuredContent: { pending: true }, _meta: {
      [key]: { voiceIntent: claim, structureText: 'private coordinates', delivery: { claimToken: 'renderer' } },
      unrelated: { secret: true },
    } };
    expect(standaloneAgentResponse('claim_voice_intent', result)).toEqual({
      content: result.content, structuredContent: result.structuredContent,
      _meta: { [key]: { voiceIntent: claim } },
    });
  });

  it('does not forward app metadata for ordinary agent calls', () => {
    const result = { content: [], structuredContent: { pending: false }, _meta: { [key]: { structureText: 'private' } } };
    expect(standaloneAgentResponse('get_inspection_state', result)).toEqual({ content: [], structuredContent: { pending: false } });
  });
});
