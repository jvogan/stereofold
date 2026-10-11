/**
 * Where a locally executed voice command gets its spoken confirmation.
 *
 * A Quest 2 reports zero `speechSynthesis` voices, so nothing the page says
 * for itself is audible there. The Mac already renders short lines with its
 * established OAuth voice through the existing `voice_acknowledgement` route, and the
 * companion page already owns an authenticated caller and an unlocked audio
 * context for it. This is one registration slot so the immersive session,
 * several layers below the page, can reach that without importing it.
 *
 * It follows exactly the pattern `setPushToTalkSender` established: registering
 * the speaker is the opt-in, and a page that never registers one still runs
 * every voice command and still writes every caption. Speech is an accessory.
 */

let registeredSpeaker;

/** Called once by the companion page with its authenticated narration caller. */
export function setVoiceCommandSpeaker(speak) {
  registeredSpeaker = typeof speak === 'function' ? speak : undefined;
}

export function voiceCommandSpeaker() {
  return registeredSpeaker;
}
