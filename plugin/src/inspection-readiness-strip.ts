import type { Readiness, ReadinessCapability, ReadinessItem } from './inspection-contract.js';

export type ReadinessStripActionId = 'load-saved-view' | 'connect-headset' | 'ask-assistant';
export type ReadinessStripAction = {
  id?: ReadinessStripActionId;
  label?: string;
  instruction: string;
};
export type ReadinessStripRow = {
  id: 'lesson' | 'headset' | 'microphone' | 'assistant';
  label: 'Structure ready' | 'Headset connected' | 'Headset check' | 'Headset push-to-talk recognizer' | 'Headset push-to-talk capture observed' | 'Headset microphone assistant';
  /** The few words the one-line summary shows for this row. */
  headline: string;
  state: 'ok' | 'missing' | 'not-checked';
  detail: string;
  /** The host's own wording, kept for a tooltip when `detail` was rewritten in plain words. */
  observed?: string;
  action?: ReadinessStripAction;
};
export type ReadinessStripView = { collapsed: boolean; tone: 'attention' | 'neutral'; summary: string; rows: ReadinessStripRow[] };

const byCapability = (readiness: Readiness) => new Map<ReadinessCapability, ReadinessItem>(
  readiness.items.map(item => [item.capability, item]),
);
const missing = (item: ReadinessItem | undefined) => item?.state === 'missing';
const notChecked = (item: ReadinessItem | undefined) => item?.state === 'not-checked';
const voiceOff = (item: ReadinessItem) => item.detail.startsWith('headset voice is off on this host');

function microphoneAction(item: ReadinessItem): ReadinessStripAction {
  // Keep the host's complete repair: a disabled recognizer can also be missing
  // its model or helper, and a restart alone cannot supply either one.
  return { instruction: item.nextAction };
}

function replyAction(item: ReadinessItem): ReadinessStripAction {
  return item.detail === 'spoken replies are turned off'
    ? { instruction: 'Turn on the headset reply route, then restart Stereofold.' }
    : { instruction: 'Fix the headset reply route, then restart Stereofold.' };
}

function microphoneRow(transcription: ReadinessItem | undefined): ReadinessStripRow {
  if (!transcription) {
    return { id: 'microphone', label: 'Headset push-to-talk recognizer', headline: 'Headset push-to-talk unchecked', state: 'not-checked',
      detail: 'Headset push-to-talk recognition has not been checked.' };
  }
  if (transcription.state === 'ok') {
    return { id: 'microphone', label: 'Headset push-to-talk capture observed', headline: 'Headset push-to-talk heard', state: 'ok',
      detail: 'Headset push-to-talk recordings are being transcribed.', observed: transcription.detail };
  }
  if (transcription.state === 'not-checked') {
    return { id: 'microphone', label: 'Headset push-to-talk recognizer', headline: 'Headset push-to-talk unheard', state: 'not-checked',
      detail: 'The recognizer is ready. No headset push-to-talk recording has been heard yet.', observed: transcription.detail,
      action: { instruction: transcription.nextAction } };
  }
  // Missing. The host's detail names binaries and paths; the row says what a
  // person needs and keeps the host's words as a tooltip.
  return voiceOff(transcription)
    ? { id: 'microphone', label: 'Headset push-to-talk recognizer', headline: 'Headset push-to-talk off', state: 'missing',
        detail: transcription.detail.includes('recognizer prerequisites missing:')
          ? 'Headset push-to-talk is off, and its recognizer needs setup.' : 'Headset push-to-talk is off on this Mac.',
        observed: transcription.detail, action: microphoneAction(transcription) }
    : { id: 'microphone', label: 'Headset push-to-talk recognizer', headline: 'No headset push-to-talk recognizer', state: 'missing',
        detail: 'Headset push-to-talk is on, but its recognizer is unavailable.', observed: transcription.detail, action: microphoneAction(transcription) };
}

/** Turn the host's six checks into the four things a person needs to know. */
export function readinessStripView(readiness: Readiness): ReadinessStripView {
  const items = byCapability(readiness);
  const structure = items.get('structure');
  const share = items.get('share');
  const headset = items.get('headset');
  const transcription = items.get('transcription');
  const agent = items.get('agent');
  const replies = items.get('replies');
  const microphone = microphoneRow(transcription);
  // The local Apple/Whisper streamer and Talk's OAuth capture are separate routes.
  microphone.detail = `${/[.!?]$/u.test(microphone.detail) ? microphone.detail : `${microphone.detail}.`} Talk and host voice are separate; this check does not cover either.`;

  const rows: ReadinessStripRow[] = [
    missing(structure)
      ? { id: 'lesson', label: 'Structure ready', headline: 'Structure not ready', state: 'missing', detail: 'The structure is not ready.',
          action: { id: 'load-saved-view', label: 'Load saved view', instruction: 'Load the saved view.' } }
      : { id: 'lesson', label: 'Structure ready', headline: 'Structure ready', state: 'ok', detail: 'The structure and panel are ready.' },
    missing(share) && headset?.detail.startsWith('Waiting for the Apple Vision Pro page')
      ? { id: 'headset', label: 'Headset check', headline: 'Waiting for the Apple Vision Pro page', state: 'not-checked',
          detail: headset.detail, action: { id: 'connect-headset', label: 'Connect headset', instruction: 'Open the share on Apple Vision Pro and pair the page.' } }
      : missing(share) && headset?.detail.startsWith('Apple Vision Pro is paired')
      ? { id: 'headset', label: 'Headset check', headline: 'Vision Pro paired', state: 'not-checked', detail: headset.detail,
          action: { instruction: 'Open the paired page on Apple Vision Pro.' } }
      // A share is open and the headset has not paired
      // yet, which is the middle of a launch rather than a fault.
      : missing(share) && share?.detail.endsWith('nothing has paired')
      ? { id: 'headset', label: 'Headset check', headline: 'Waiting for the headset', state: 'not-checked',
          detail: 'Sharing is open. The headset has not paired yet.', observed: share.detail,
          action: { id: 'connect-headset', label: 'Connect headset', instruction: 'Open the headset connection.' } }
      : missing(share)
      ? { id: 'headset', label: 'Headset connected', headline: 'No headset', state: 'missing', detail: 'The headset is not connected.',
          action: { id: 'connect-headset', label: 'Connect headset', instruction: 'Open the headset connection.' } }
      : missing(headset)
        ? { id: 'headset', label: 'Headset connected', headline: 'Headset needs attention', state: 'missing', detail: 'The headset connection needs attention.',
            action: { instruction: 'Reconnect the headset.' } }
        : notChecked(headset)
          ? headset?.detail.startsWith('Apple Vision Pro is paired')
            ? { id: 'headset', label: 'Headset check', headline: 'Vision Pro paired', state: 'not-checked', detail: headset.detail,
                action: { instruction: 'Open the paired page on Apple Vision Pro.' } }
            // Retained pairing and optional debugging do not prove a live page.
            : { id: 'headset', label: 'Headset check', headline: 'Paired over Wi-Fi', state: 'not-checked', detail: 'Pairing is retained. Check the live page for connection status; debugging is optional.',
                observed: headset?.detail,
                action: { instruction: headset?.nextAction ?? 'Check the paired page. Authorized USB or Wi-Fi debugging adds captures and browser recovery.' } }
        : headset?.detail.startsWith('Apple Vision Pro page is connected')
          ? { id: 'headset', label: 'Headset connected', headline: 'Vision Pro connected', state: 'ok',
              detail: 'Apple Vision Pro page is connected over Wi-Fi.' }
        : { id: 'headset', label: 'Headset connected', headline: 'Headset connected', state: 'ok', detail: 'The headset is connected.' },
    microphone,
    agent?.state !== 'ok'
      ? { id: 'assistant', label: 'Headset microphone assistant', headline: 'Headset mic: not ready', state: 'missing',
          detail: 'The headset microphone has no responding assistant yet. Host voice is separate and is not checked here. Controls and narration still work.', observed: agent?.detail,
          action: { id: 'ask-assistant', label: 'Connect headset mic assistant', instruction: 'Connect an assistant only if you want to speak through the headset microphone.' } }
      : missing(replies)
        ? { id: 'assistant', label: 'Headset microphone assistant', headline: 'Headset replies off', state: 'missing',
            detail: 'Headset spoken replies are off. Turn on the headset reply route to hear answers. Host voice is separate and is not checked here.',
            action: replyAction(replies!) }
        : { id: 'assistant', label: 'Headset microphone assistant', headline: 'Headset mic assistant ready', state: 'ok',
            detail: 'An assistant is responding to headset microphone requests. Host voice is separate and is not checked here.', observed: agent.detail },
  ];
  const collapsed = rows.every(row => row.state === 'ok');
  return {
    collapsed,
    // Nothing missing, only unchecked: the one-line summary is news, not a fault.
    tone: rows.some(row => row.state === 'missing') ? 'attention' : 'neutral',
    summary: collapsed ? 'Headset microphone session ready.' : rows.filter(row => row.state !== 'ok').map(row => row.headline).join(' · '),
    rows,
  };
}

export type ReadinessStripHandlers = Partial<Record<ReadinessStripActionId, () => void | Promise<void>>>;

/** Whether a strip's Details is open, so a readiness refresh does not fold it shut. */
const detailsOpen = new WeakMap<HTMLElement, boolean>();

type StripEvent = { preventDefault?: () => void; stopPropagation?: () => void } | undefined;

function actionButton(
  action: ReadinessStripAction,
  handler: () => void | Promise<void>,
  documentRef: Pick<Document, 'createElement'>,
): HTMLButtonElement {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.textContent = action.label ?? action.instruction;
  button.addEventListener('click', (event?: StripEvent) => {
    // Inside a <summary>, a click would also toggle the details.
    event?.preventDefault?.();
    event?.stopPropagation?.();
    button.disabled = true;
    void Promise.resolve().then(handler).catch(() => {}).finally(() => { button.disabled = false; });
  });
  return button;
}

/** Render without reading global DOM state, so the inspector's small DOM harness can exercise it. */
export function renderReadinessStrip(
  root: HTMLElement,
  readiness: Readiness,
  handlers: ReadinessStripHandlers = {},
  documentRef: Pick<Document, 'createElement'> = document,
): void {
  const view = readinessStripView(readiness);
  root.dataset.state = view.collapsed ? 'ready' : 'attention';
  root.dataset.tone = view.tone;
  root.replaceChildren();
  if (view.collapsed) {
    const line = documentRef.createElement('p');
    line.className = 'readiness-strip-summary';
    line.textContent = view.summary;
    root.append(line);
    return;
  }

  // One line names what needs attention, short enough to fit a 440 px card
  // beside Details. The observed facts and the fix for each sit behind
  // Details, so the card keeps its height for the structure.
  const details = documentRef.createElement('details');
  details.className = 'readiness-strip-details';
  details.open = detailsOpen.get(root) ?? false;
  details.addEventListener('toggle', () => { detailsOpen.set(root, details.open); });
  const summary = documentRef.createElement('summary');
  const line = documentRef.createElement('span');
  line.className = 'readiness-strip-summary';
  line.textContent = view.summary;
  const toggle = documentRef.createElement('span');
  toggle.className = 'readiness-strip-toggle';
  toggle.textContent = 'Details';
  summary.append(line, toggle);
  // Actions live with their rows behind Details. In a chat card the reader is
  // at a keyboard, so connecting a headset is not the line's primary action.

  const list = documentRef.createElement('ul');
  for (const row of view.rows) {
    const item = documentRef.createElement('li');
    item.dataset.readinessRow = row.id;
    item.dataset.state = row.state;
    const label = documentRef.createElement('strong');
    label.textContent = row.label;
    const detail = documentRef.createElement('span');
    detail.textContent = row.detail;
    if (row.observed) detail.setAttribute('title', row.observed);
    item.append(label, detail);
    if (row.action) {
      const handler = row.action.id ? handlers[row.action.id] : undefined;
      if (handler && row.action.label) {
        item.append(actionButton(row.action, handler, documentRef));
      } else {
        const instruction = documentRef.createElement('small');
        instruction.textContent = row.action.instruction;
        item.append(instruction);
      }
    }
    list.append(item);
  }
  details.append(summary, list);
  root.append(details);
}

export function createReadinessStrip(
  documentRef: Pick<Document, 'createElement'>,
  handlers: ReadinessStripHandlers = {},
): { element: HTMLElement; update: (readiness: unknown) => void } {
  const element = documentRef.createElement('section');
  element.className = 'readiness-strip';
  element.dataset.readinessStrip = '';
  element.setAttribute('aria-live', 'polite');
  const waiting = documentRef.createElement('p');
  waiting.className = 'readiness-strip-summary';
  waiting.textContent = 'Checking connection.';
  element.append(waiting);
  return {
    element,
    update(readiness: unknown) {
      if (!readiness || typeof readiness !== 'object' || !Array.isArray((readiness as Readiness).items)) return;
      renderReadinessStrip(element, readiness as Readiness, handlers, documentRef);
    },
  };
}
