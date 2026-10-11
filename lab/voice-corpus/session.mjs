/**
 * One inspection session, driven the way a panel drives one.
 *
 * The corpus runner needs a scene it can command and a renderer that answers
 * the way the headset page answers: take the delivery, apply the change, hand
 * the scene back, and let the host decide whether that is a rendered receipt.
 * Nothing here decides what any case means — that is `consumer.mjs` — and
 * nothing here invents a receipt: a command is "rendered" only when the host
 * says so, which is the whole point of playing the corpus through this path.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeAppearance, normalizePlacement } from '../browser-roundtrip/inspection-state.mjs';

/** Frozen in `plugin/src/inspection-contract.ts`; the panel's private channel. */
export const PRIVATE_KEY = 'stereo_structure/inspection';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(here, '../../fixtures');

/** The look the corpus pins for the synthetic fixtures: sparse CA sites must be visible. */
const BALL_AND_STICK = {
  representation: 'ball-and-stick', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
  opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0,
};
const CAMERA = {
  mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
  radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0,
};

export class ToolRefusal extends Error {
  constructor(message, tool) { super(message); this.name = 'ToolRefusal'; this.tool = tool; }
}

/** A tool call whose refusal is an outcome rather than a crash. */
export async function callTool(call, name, args) {
  const answer = await call(name, args);
  if (answer?.isError) throw new ToolRefusal(String(answer.content?.[0]?.text ?? 'The host refused without a sentence.'), name);
  return answer;
}

/**
 * Open a fixture, save its first scene and attach a panel.
 *
 * `representation` and `selectionKeys` are the case's declared precondition,
 * committed before the utterance so the run measures the command and not the
 * setup.
 */
export async function openSession(call, { file, modelNumber, assemblyId, appearance = BALL_AND_STICK, surface = 'companion' }) {
  const structureText = await readFile(resolve(FIXTURES, file), 'utf8');
  const opened = await callTool(call, 'inspect', {
    structureText,
    ...(modelNumber === undefined ? {} : { modelNumber }),
    ...(assemblyId === undefined ? {} : { assemblyId }),
  });
  const sessionId = opened.structuredContent.sessionId;
  const priv = (await callTool(call, 'get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const catalog = priv.catalog;
  const scene = {
    sourceSha256: catalog.source.sha256,
    modelNumber: modelNumber ?? catalog.modelNumbers[0],
    assemblyId: catalog.assemblyId,
    selectionKeys: [],
    camera: structuredClone(CAMERA),
    inspection: { appearance: { ...appearance }, placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
  };
  const session = { call, sessionId, catalog, scene, panelId: null, binding: null, file };
  await refresh(session);
  const saved = await callTool(call, 'sync_inspection', { ...session.binding, scene });
  session.binding.baseStateRevision = saved.structuredContent.stateRevision;
  session.binding.baseInspectionRevision = saved.structuredContent.inspectionRevision;
  const attached = await callTool(call, 'attach_inspection', { ...session.binding, surface });
  session.panelId = attached.structuredContent.panelId;
  return session;
}

/** Re-read the binding the host expects on the next command. */
export async function refresh(session) {
  const state = (await callTool(session.call, 'get_inspection_state', { sessionId: session.sessionId })).structuredContent;
  session.binding = {
    sessionId: session.sessionId,
    serverEpoch: state.serverEpoch,
    sourceToken: state.sourceToken,
    baseStateRevision: state.stateRevision,
    baseInspectionRevision: state.inspectionRevision,
  };
  session.state = state;
  return state;
}

/** The canonical rows a region names, read from the host rather than guessed. */
export async function residues(session, query) {
  const state = await callTool(session.call, 'get_inspection_state', { sessionId: session.sessionId, residues: query });
  return state.structuredContent.residues?.rows ?? [];
}

/**
 * What the panel draws for a delivered change.
 *
 * This is `expectedInspection` from the contract, in the renderer's voice: the
 * scene the page would come back with if the change applied cleanly. A case
 * that wants a render to fail says so by not calling this.
 */
export function renderChange(scene, change) {
  if (change.kind === 'compound') return change.patch.ops.reduce((carried, op) => renderChange(carried, op), scene);
  const next = structuredClone(scene);
  if (change.kind === 'appearance') next.inspection.appearance = normalizeAppearance(change.patch, scene.inspection.appearance);
  else if (change.kind === 'placement') next.inspection.placement = normalizePlacement(change.patch, scene.inspection.placement);
  else if (change.kind === 'selection' || change.kind === 'focus') next.selectionKeys = [...change.patch.selectionKeys];
  else if (change.kind === 'emphasis') next.inspection.emphasis = structuredClone(change.patch);
  else if (change.kind === 'restore-view') return structuredClone(change.patch.scene);
  // motion, render-quality, tour and save-view leave the saved scene alone.
  return next;
}

/** One heartbeat. Returns the delivery the panel was handed, if any. */
export async function poll(session, availability = 'ready') {
  const answer = await callTool(session.call, 'poll_inspection', {
    ...session.binding, panelId: session.panelId, availability,
  });
  return answer._meta?.[PRIVATE_KEY]?.delivery;
}

/**
 * Take one delivery all the way to a receipt, the way the page does.
 *
 * `phases` lets a case stop half way — `admit` without `settled` is the
 * withheld-acknowledgment fault V27 needs — and the receipt that comes back is
 * always the host's own.
 */
export async function render(session, delivery, { scene, admitFirst = false } = {}) {
  const drawn = scene ?? renderChange(session.scene, delivery.change);
  if (admitFirst) {
    const admitted = await callTool(session.call, 'complete_inspection', {
      ...session.binding, panelId: session.panelId, commandId: delivery.commandId, claimToken: delivery.claimToken, phase: 'admit',
    });
    if (admitted.structuredContent.admitted !== true) return { admitted: false, answer: admitted };
  }
  const done = await callTool(session.call, 'complete_inspection', {
    ...session.binding, panelId: session.panelId, commandId: delivery.commandId, claimToken: delivery.claimToken, scene: drawn,
  });
  if (done.structuredContent.command?.status === 'rendered') {
    session.scene = drawn;
    await refresh(session);
    await poll(session);
  }
  return { admitted: true, answer: done, scene: drawn };
}

/** Deliver and render whatever is queued, and hand back the host's receipt. */
export async function settle(session, { scene } = {}) {
  const delivery = await poll(session);
  if (!delivery) return { delivered: false };
  const outcome = await render(session, delivery, { ...(scene ? { scene } : {}) });
  return { delivered: true, delivery, ...outcome, receipt: outcome.answer.structuredContent.command };
}

/** The receipt the host holds for one command ID, never a local guess. */
export async function receiptFor(session, commandId) {
  const state = await callTool(session.call, 'get_inspection_state', { sessionId: session.sessionId, commandId });
  // Snapshot it. In-process, `command` comes back as the host's own live
  // receipt object, so a reference held across a later render would silently
  // read as though it had been rendered all along.
  return structuredClone(state.structuredContent.command);
}
