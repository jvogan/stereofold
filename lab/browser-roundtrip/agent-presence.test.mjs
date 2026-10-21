import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_PRESENCE_TTL_MS, agentAttached, voiceListening, listeningStatusLine, noteAgentPresence, resetAgentPresence } from './agent-presence.mjs';
import { assistantStatus } from './assistant-status.mjs';

test('compatibility readers use the menu model, including expiry and reset', () => {
  resetAgentPresence();
  assert.equal(agentAttached(1_000), false);
  noteAgentPresence(true, 1_000, { mode: 'none', assistant: 'Codex' });
  assert.equal(agentAttached(1_000), true);
  assert.equal(voiceListening(1_000), false);
  assert.equal(agentAttached(1_000 + AGENT_PRESENCE_TTL_MS), true);
  assert.equal(agentAttached(1_001 + AGENT_PRESENCE_TTL_MS), false);
  for (const mode of ['channel', 'polling']) {
    noteAgentPresence(false, Date.now(), { mode, assistant: 'Codex' });
    assert.equal(voiceListening(), true);
    assert.equal(listeningStatusLine(), assistantStatus.lines()[0]);
    assert.equal(listeningStatusLine(), 'Codex is listening');
  }
  noteAgentPresence(false, Date.now(), { mode: 'none', assistant: 'Codex' });
  assert.equal(voiceListening(), false);
  assert.equal(agentAttached(), true);
  resetAgentPresence();
  assert.equal(assistantStatus.lines()[0], 'No assistant connected');
});
