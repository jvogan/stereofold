// @ts-ignore The page's own JavaScript voice grammar.
import { spatialVoiceAction } from '../../lab/browser-roundtrip/voice-command-runner.mjs';

/**
 * Whether the headset page acts on this sentence itself.
 *
 * The page runs every finished transcript through its own grammar, and the
 * same transcript reaches the assistant through the channel or listen_voice.
 * A sentence the grammar turns into an action ("bigger", "start the tour")
 * would then be done twice, or done once and answered twice. The Mac reads it
 * the way the page does, raw text first and the scene-checked reading only
 * when the raw text means nothing, and marks it; the page acts on a marked
 * sentence and leaves every other one to a listening assistant.
 *
 * Reserve sequence-browser phrases for the page even though the host does
 * not know whether that browser is open. Only the page can navigate it; the
 * page's live context still decides the action (or explains an unavailable
 * command). Lesson part names remain with the assistant.
 */
export function headsetActsOn(record: { text: string; normalizedText?: string }): boolean {
  const text = record.text.trim();
  if (!text) return false;
  const proposed = record.normalizedText?.trim();
  const context = { sequenceOpen: true };
  const heard = spatialVoiceAction(text, context) ?? (proposed && proposed !== text ? spatialVoiceAction(proposed, context) : undefined);
  return Boolean(heard?.action);
}
