/** Compatibility readers for the single wearer status model. */
import { assistantStatus } from './assistant-status.mjs';
export { AGENT_PRESENCE_TTL_MS, NOBODY_LISTENING_LINE } from './assistant-status.mjs';

export function noteAgentPresence(attached, now = Date.now(), voiceDelivery, activeAssistant = voiceDelivery?.assistant) {
  assistantStatus.notePresence({ agentAttached: attached, activeAssistant, voiceDelivery }, now);
}
export function agentAttached(now = Date.now()) { return assistantStatus.presence(now).connected; }
export function voiceListening(now = Date.now()) { return assistantStatus.presence(now).listening; }
export function resetAgentPresence() { assistantStatus.resetPresence(); }
export function listeningStatusLine() { return assistantStatus.listeningLine(); }
