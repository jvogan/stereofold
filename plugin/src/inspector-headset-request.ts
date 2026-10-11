export type HeadsetChoice = 'quest' | 'apple' | 'manual';

/** Keep the card's launch choices aligned with the server's LAN routes. */
export function inspectorHeadsetRequest(binding: Record<string, unknown>, choice: HeadsetChoice,
  lanHost: string, lanPort: number): Record<string, unknown> {
  return { ...binding, connection: 'lan', ...(lanHost ? { lanHost } : {}), lanPort,
    launch: choice === 'manual' ? 'none' : 'auto',
    ...(choice === 'quest' ? { waitForHeadsetMs: 20000 } : {}),
    ...(choice === 'manual' ? {} : { headset: choice === 'apple' ? 'apple' : 'meta' }) };
}
