/**
 * Whether a Mac-side agent is listening to this headset right now.
 *
 * Everything the agent can do was already built — it reads the wearer's speech
 * with `poll_voice_transcripts`, answers with `say_to_headset`, and drives tours
 * and framing with `control_tour` and `focus_selection` — but none of it was
 * visible from inside the headset. A wearer who cannot tell whether anyone is on
 * the other end has, for their purposes, no one on the other end.
 *
 * There was no signal to read. The transport runs the other way: the page
 * polls the Mac once a second and the answer carries per-command state, never
 * a peer count and never a heartbeat from the agent. So the host now stamps
 * the moment any agent-facing tool ran and reports the freshness of that stamp
 * on the same heartbeat the page already sends. This module is the page's half
 * of it: one slot, written by the poll loop and read by the immersive session,
 * which cannot import the poll loop.
 *
 * It is deliberately a recency model rather than a connection. An agent that
 * has said nothing for a while is indistinguishable from one that has gone,
 * and treating a long silence as absence is the failure that costs least: the
 * wearer is told the page could not act, which is true either way.
 *
 * It follows the pattern `voice-command-speaker.mjs` established: a page that
 * never writes the slot simply reports no agent, and every caller degrades to
 * the wording it used before this existed.
 */

/**
 * How long a reported presence stays believable without a fresh heartbeat.
 *
 * The companion polls about once a second, so this is several missed beats: it
 * absorbs a stalled poll or a slow Wi-Fi moment without ever letting a wearer
 * be told an agent is listening long after the host stopped saying so.
 */
export const AGENT_PRESENCE_TTL_MS = 8_000;

/**
 * When the host last reported an agent, or `undefined` for never.
 *
 * Undefined rather than zero so a clock that legitimately reads zero cannot be
 * mistaken for silence, and silence cannot be mistaken for a stamp.
 */
let attachedAt;

/**
 * Record what the latest heartbeat said about the agent.
 *
 * `attached` false clears the slot outright rather than letting it expire: the
 * host has positively said nobody is there, which is better information than
 * the timestamp.
 */
export function noteAgentPresence(attached, now = Date.now()) {
  attachedAt = attached === true ? now : undefined;
}

/** Whether an agent was reported present recently enough to still count. */
export function agentAttached(now = Date.now()) {
  return attachedAt !== undefined && now - attachedAt <= AGENT_PRESENCE_TTL_MS;
}

/** Forget any reported presence. A new session starts with no claim about the Mac. */
export function resetAgentPresence() { attachedAt = undefined; }

/**
 * The one line the headset says about the Mac, and when it is allowed to.
 *
 * An earlier version spoke this on entry, whenever an agent was attached, so a
 * wearer would know there was anyone to talk to. But an attached follower is not
 * the headset listening to the wearer — it is a process on a Mac holding a
 * heartbeat open — and a line that claims otherwise before the wearer has
 * touched a control teaches them the status row lies.
 *
 * So it is the status row of an OPEN PRESS and nothing else. A held A or X with
 * an agent attached reads `Agent is listening.`; the
 * same press with nobody on the Mac reads `Listening…`, which is the truth
 * about a microphone recording for a page with nowhere to send it; and a wearer
 * who has pressed nothing reads neither.
 *
 * The line used to read `Claude is listening.`, and a Codex user saw it too.
 * The heartbeat says only that some agent is attached, not which one, so the
 * line names no assistant.
 */
export const AGENT_LISTENING_LINE = 'Agent is listening.';

/** The line a press shows when nobody is listening on the Mac. */
export const NOBODY_LISTENING_LINE = 'Listening…';

/**
 * What the menu's status row should say while push-to-talk is held.
 *
 * Read at each press rather than when the binding is made, because an agent can
 * attach and drop away inside one session and the reading above expires on a
 * window rather than latching.
 */
export function listeningStatusLine(attached = agentAttached) {
  try { return attached() === true ? AGENT_LISTENING_LINE : NOBODY_LISTENING_LINE; }
  catch { return NOBODY_LISTENING_LINE; }
}
