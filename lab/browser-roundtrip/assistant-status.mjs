/** Shared wearer status. Only changed text notifies the menu; no molecular draws. */
export const AGENT_PRESENCE_TTL_MS = 8_000;
export const NOBODY_LISTENING_LINE = 'Nobody is listening for voice';
const short = (text, limit = 48) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};
export function createAssistantStatus({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let visible = false, presenceAt, expiryTimer;
  const applied = new Set();
  let assistant = '', connected = false, delivery, microphone = 'idle', heard = '', lastAction = '';
  const listeners = new Set();
  const presence = (at = now()) => {
    const fresh = presenceAt !== undefined && at - presenceAt <= AGENT_PRESENCE_TTL_MS;
    const listening = fresh && Boolean(assistant) && delivery?.assistant?.trim().toLowerCase() === assistant.toLowerCase()
      && ['channel', 'polling'].includes(delivery?.mode);
    return { listening, connected: fresh && Boolean(assistant) && (connected || listening), assistant };
  };
  const connectionLine = (at = now()) => {
    const state = presence(at);
    return state.listening ? `${assistant} is listening`
      : state.connected ? `${assistant} is connected, not listening to voice` : 'No assistant connected';
  };
  const compactLine = () => {
    const state = presence();
    return state.listening ? `${short(assistant, 20)} is listening`
      : state.connected ? `${short(assistant, 14)} · voice off` : 'No assistant connected';
  };
  // The status card at one line, where three would cover the structure: who
  // is there, and how to talk (or what the microphone is doing).
  const glanceLine = () => {
    const state = presence(), name = state.listening || state.connected ? short(assistant, 14) : 'No assistant';
    const talk = microphone === 'listening' || microphone === 'recording' ? 'Listening...'
      : ['starting', 'requesting-microphone'].includes(microphone) ? 'Starting microphone...'
      : ['sending', 'transcribing', 'uploading'].includes(microphone) ? 'Transcribing...'
      : microphone === 'error' ? 'Microphone unavailable' : 'A/X to talk';
    return `${name} · ${talk}`;
  };
  const lines = () => [
    connectionLine(),
    microphone === 'listening' || microphone === 'recording' ? 'Listening...'
      : ['starting', 'requesting-microphone'].includes(microphone) ? 'Starting microphone...'
      : ['sending', 'transcribing', 'uploading'].includes(microphone) ? 'Transcribing...'
      : microphone === 'error' ? 'Microphone unavailable'
      : heard ? `Heard: ${short(heard, 40)}` : 'Hold A or X to talk',
    lastAction || 'No action applied yet',
  ];
  let signature = JSON.stringify(lines());
  function publish(first = false) {
    const next = JSON.stringify(lines());
    if (next === signature && !first) return false;
    signature = next;
    for (const listener of listeners) listener(lines());
    return true;
  }
  function armExpiry() {
    clearTimer(expiryTimer);
    // A missed heartbeat must also remove the claim from an already open menu.
    expiryTimer = setTimer(() => publish(), Math.max(0, presenceAt + AGENT_PRESENCE_TTL_MS + 1 - now()));
    expiryTimer?.unref?.();
  }
  const status = {
    lines, presence, connectionLine, compactLine,
    listeningLine: () => presence().listening ? connectionLine() : 'Listening…',
    releaseLine: () => presence().listening ? '' : NOBODY_LISTENING_LINE,
    panelLines: () => visible ? [compactLine(), ...lines().slice(1)] : [],
    panelGlance: () => visible ? [glanceLine()] : [],
    notePresence(state, at = now()) {
      // activeAssistant comes from the attached-assistant registry. agentAttached
      // is an older conversation-recency signal, not a connection or listener.
      return status.update({ assistant: state?.activeAssistant, connected: Boolean(state?.activeAssistant),
        voiceDelivery: state?.voiceDelivery }, at);
    },
    resetPresence() {
      clearTimer(expiryTimer);
      presenceAt = undefined; assistant = ''; connected = false; delivery = undefined;
      return publish();
    },
    renderedCommand(receipt) {
      // Anonymous local scene saves are not assistant commands.
      if (!receipt?.assistantName || receipt.status !== 'rendered') return false;
      return status.update({ action: { status: receipt.status, id: receipt.commandId,
        source: receipt.assistantName, text: receipt.action ?? 'updated scene' } });
    },
    update(event, at = now()) {
      const first = !visible; visible = true;
      if (['assistant', 'connected', 'voiceDelivery'].some(key => Object.hasOwn(event, key))) {
        if (Object.hasOwn(event, 'assistant')) assistant = String(event.assistant ?? '').trim();
        if (Object.hasOwn(event, 'connected')) connected = event.connected === true;
        if (Object.hasOwn(event, 'voiceDelivery')) delivery = event.voiceDelivery;
        presenceAt = at; armExpiry();
      }
      if (event.microphone) { microphone = event.microphone; if (['starting', 'requesting-microphone', 'recording', 'listening'].includes(microphone)) heard = ''; }
      if (event.heard) { heard = short(event.heard); microphone = 'idle'; }
      if (event.action?.status === 'rendered' && (!event.action.id || !applied.has(event.action.id))) {
        if(event.action.id) {applied.add(event.action.id);if(applied.size>64)applied.delete(applied.values().next().value);}
        lastAction = `${short(event.action.source || 'Assistant', 40)}: ${short(event.action.text, 48)}`;
      }
      return publish(first);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return status;
}
export const assistantStatus = createAssistantStatus();
