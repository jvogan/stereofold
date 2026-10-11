import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_LISTENING_LINE, AGENT_PRESENCE_TTL_MS, agentAttached, noteAgentPresence, resetAgentPresence } from './agent-presence.mjs';

test('a wearer is told Claude is there only while the host keeps saying so', () => {
  resetAgentPresence();
  // Nothing has been heard from the host yet. The headset must not claim a
  // listener it has never been told about.
  assert.equal(agentAttached(1_000), false);

  noteAgentPresence(true, 1_000);
  assert.equal(agentAttached(1_000), true);
  // Several missed heartbeats still count: the poll runs about once a second.
  assert.equal(agentAttached(1_000 + AGENT_PRESENCE_TTL_MS), true);
  // Past the window the page stops promising a listener it has lost contact
  // with. Being wrong this way costs the wearer "Not a command"; being wrong
  // the other way promises an answer that never comes.
  assert.equal(agentAttached(1_001 + AGENT_PRESENCE_TTL_MS), false);
});

test('a host that positively reports nobody clears the slot rather than letting it age out', () => {
  resetAgentPresence();
  noteAgentPresence(true, 5_000);
  assert.equal(agentAttached(5_100), true);
  noteAgentPresence(false, 5_100);
  assert.equal(agentAttached(5_100), false);
});

test('only a literal true is presence', () => {
  // The field arrives off a JSON heartbeat, so a host that does not report it
  // at all, or reports something else, must read as absent and never as
  // truthy-by-accident.
  for (const value of [undefined, null, 0, '', 'yes', 1, {}]) {
    resetAgentPresence();
    noteAgentPresence(value, 10_000);
    assert.equal(agentAttached(10_000), false, `${JSON.stringify(value)} must not read as an attached agent.`);
  }
});

test('the listening line names no assistant, because the heartbeat does not say which one is attached', () => {
  // A Codex user was told "Claude is listening."
  assert.equal(AGENT_LISTENING_LINE, 'Agent is listening.');
  assert.doesNotMatch(AGENT_LISTENING_LINE, /claude|codex/iu);
});
