const PRIVATE_INSPECTION_META_KEY = 'stereo_structure/inspection';

/**
 * Shape the loopback admin response without forwarding arbitrary app-private
 * metadata. The headset voice relay needs only the one-time claim receipt;
 * coordinates, audio and renderer delivery metadata stay out of /agent.
 */
export function standaloneAgentResponse(name: string, result: any) {
  const response: Record<string, unknown> = { content: result?.content, structuredContent: result?.structuredContent };
  if (name !== 'claim_voice_intent') return response;
  const metadata = result?._meta?.[PRIVATE_INSPECTION_META_KEY];
  const voiceIntent = metadata?.voiceIntent;
  if (voiceIntent && typeof voiceIntent === 'object' && !Array.isArray(voiceIntent)) {
    response._meta = { [PRIVATE_INSPECTION_META_KEY]: { voiceIntent } };
  }
  return response;
}
