import { createViewer } from './viewer.mjs';
import crambin from '../../fixtures/1CRN.cif';
import ligand from '../../fixtures/voice-ligand.cif';
import edge from '../../fixtures/identity-edge.cif';
import './style.css';

const catalogs = __ROUNDTRIP_CATALOGS__;
const fixtures = Object.fromEntries(Object.entries({ public_1crn: crambin, synthetic_ligand: ligand, identity_edge: edge })
  .map(([id, cif]) => [id, { id, cif, catalog: catalogs[id], sha256: catalogs[id].source.sha256 }]));
const panels = new Map();
const state = { status: 'loading', error: null, lastInteractedPanel: null, maxLiveViewers: 0, returnApplications: 0 };
const status = document.querySelector('#status');
let captureSerial = 0;
const clone = value => structuredClone(value);

function sceneOnly(scene) {
  return Object.fromEntries(['sourceSha256', 'modelNumber', 'assemblyId', 'representation', 'color', 'selectionKeys', 'camera']
    .map(key => [key, clone(scene[key])]));
}

function panelFor(id) {
  const panel = panels.get(id);
  if (!panel) throw new Error(`Unknown panel: ${id}`);
  return panel;
}

function updateSequence(panel, snapshot = panel.viewer?.snapshot()) {
  if (!snapshot || !panel.fixture) return;
  const selected = new Set(snapshot.selectionKeys ?? []);
  for (const button of panel.element.querySelectorAll('.sequence button')) {
    button.setAttribute('aria-pressed', String(selected.has(button.dataset.key)));
  }
  const rows = panel.fixture.catalog.rows.filter(row => selected.has(row.key));
  panel.element.querySelector('.selection-label').textContent = rows.length
    ? rows.map(r => `Chain ${r.identity.authorChain} · ${r.identity.componentId} ${r.identity.authorResidue ?? '?'}${r.identity.insertionCode}`
      + (r.coordinateState === 'unresolved' ? ' · coordinates missing' : '')).join('; ')
    : 'Select a sequence position or click the molecule.';
}

function renderSequence(panel) {
  const sequence = panel.element.querySelector('.sequence');
  sequence.replaceChildren();
  const snapshot = panel.viewer.snapshot();
  for (const row of panel.fixture.catalog.rows.filter(r => r.identity.modelNumber === snapshot.modelNumber
      && r.identity.assemblyId === snapshot.assemblyId)) {
    const button = document.createElement('button');
    const code = document.createElement('span');
    const id = row.identity;
    button.type = 'button';
    button.dataset.key = row.key;
    button.dataset.coordinate = row.coordinateState;
    button.dataset.labelSequence = String(id.labelSequenceId);
    button.dataset.labelChain = id.labelChain;
    button.dataset.copy = id.operatorIds.join(',');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `Select ${id.componentId} in chain ${id.authorChain}, author residue ${id.authorResidue ?? 'unknown'}${id.insertionCode}, copy ${id.operatorIds.join(',')}`);
    button.title = `${id.componentId}; label ${id.labelChain}:${id.labelSequenceId ?? 'none'}; author ${id.authorChain}:${id.authorResidue ?? '?'}${id.insertionCode}; copy ${id.operatorIds.join(',')}`;
    button.append(document.createTextNode(id.componentId));
    code.textContent = String(id.authorResidue ?? '?') + id.insertionCode;
    button.append(code);
    button.addEventListener('click', () => runUi(panel, () => panel.viewer.select([row.key])));
    sequence.append(button);
  }
  updateSequence(panel, snapshot);
}

function queued(panel, action) {
  if (panel.closing) return Promise.reject(new Error('Panel is closing.'));
  const work = panel.queue.then(async () => {
    if (!panel.mounted) throw new Error('Panel is unmounted.');
    panel.busy = true;
    panel.element.querySelector('.stage').style.pointerEvents = 'none';
    for (const control of panel.element.querySelectorAll('button, select')) control.disabled = true;
    try { return await action(); }
    finally {
      panel.busy = false;
      panel.element.querySelector('.stage').style.pointerEvents = '';
      for (const control of panel.element.querySelectorAll('button, select')) control.disabled = !panel.mounted;
      updateSequence(panel);
    }
  });
  panel.queue = work.catch(() => {});
  return work;
}

function runUi(panel, action) {
  state.lastInteractedPanel = panel.id;
  queued(panel, action).catch(error => { status.textContent = error.message; state.error = error.message; });
}

async function capturePanel(id) {
  const panel = panelFor(id);
  if (!panel.mounted) throw new Error('Panel is unmounted.');
  const scene = sceneOnly(await panel.viewer.capture());
  const signature = JSON.stringify(scene);
  if (signature !== panel.lastSignature) {
    panel.revision += 1;
    panel.lastSignature = signature;
    panel.lastScene = clone(scene);
  }
  return { version: 1, captureId: `capture-${++captureSerial}`, target: clone(panel.target), sceneId: panel.sceneId,
    desktopRevision: panel.revision, fixtureId: panel.fixture.id, cif: panel.fixture.cif, scene };
}

async function describePanel(id) {
  const panel = panelFor(id);
  if (panel.mounted) await capturePanel(id);
  return { target: clone(panel.target), mounted: panel.mounted, visibility: panel.hidden ? 'hidden' : 'visible',
    sceneId: panel.sceneId, sourceSha256: panel.lastScene.sourceSha256, revision: panel.revision };
}

async function loadPanel(id, fixtureId, options = {}) {
  const fixture = fixtures[fixtureId];
  if (!fixture) throw new Error('Fixture is outside this public experiment.');
  return loadFixture(id, fixture, options);
}

async function loadFixture(id, fixture, options = {}) {
  const panel = panelFor(id);
  return queued(panel, async () => {
    const result = await panel.viewer.load(fixture, { modelNumber: 1, assemblyId: '1', representation: 'ball-and-stick', ...options });
    panel.fixture = fixture;
    panel.sceneId = `${id}-scene-${++panel.sceneGeneration}`;
    panel.element.querySelector('.source-label').textContent = `${fixture.id} · model ${result.modelNumber} · assembly ${result.assemblyId}`;
    panel.element.querySelector('select').value = result.representation;
    renderSequence(panel);
    await capturePanel(id);
    return result;
  });
}

async function applyReturn(id, expectedPanel, inspection) {
  const panel = panelFor(id);
  if (!panel.mounted || panel.closing) return { status: 'recoverable', reason: 'original_panel_unmounted' };
  return queued(panel, async () => {
    // This read happens inside the same queue that owns every programmatic mutation.
    // Pointer input is suspended until the deliberate return finishes.
    const actual = await describePanel(id);
    if (JSON.stringify(actual) !== JSON.stringify(expectedPanel)) {
      return { status: 'save_snapshot', reason: 'desktop_changed_before_apply', actual };
    }
    const current = await panel.viewer.capture();
    if (inspection.sourceSha256 !== current.sourceSha256 || inspection.modelNumber !== current.modelNumber
      || inspection.assemblyId !== current.assemblyId) {
      return { status: 'save_snapshot', reason: 'inspection_source_changed' };
    }
    await panel.viewer.applyInspection({ selectionKeys: inspection.selectionKeys, camera: inspection.camera });
    state.returnApplications += 1;
    await capturePanel(id);
    return { status: 'applied', browserFrameConfirmed: true, actual: await describePanel(id),
      snapshot: panel.viewer.snapshot() };
  });
}

async function mount(id, title, fixtureId, representation) {
  const element = document.createElement('section');
  element.className = 'panel';
  element.id = id;
  element.innerHTML = `<div class="panel-head"><div class="panel-title"><h2></h2><span class="badge"></span></div><p class="source-label"></p></div>
    <div class="stage"><canvas></canvas></div>
    <div class="controls"><select aria-label="Representation"><option value="cartoon">Cartoon</option><option value="ball-and-stick">Ball and stick</option></select>
    <button type="button" class="focus">Focus selection</button></div>
    <div class="sequence" aria-label="Sequence selection"></div><div class="selection-label" role="status"></div>`;
  element.querySelector('h2').textContent = title;
  element.querySelector('.badge').textContent = id === 'receiver' ? 'RECEIVER' : 'SOURCE';
  element.querySelector('canvas').setAttribute('aria-label', `${title} molecular canvas`);
  document.querySelector('#panels').append(element);
  const panel = { id, element, fixture: fixtures[fixtureId], mounted: true, hidden: false, busy: false, closing: false, disposePromise: null,
    sceneId: `${id}-scene-0`, sceneGeneration: 0, revision: 0, lastSignature: null, lastScene: null, queue: Promise.resolve(),
    target: { bindingId: `binding-${id === 'panel-a' ? 'a' : id}`, taskId: 'task-a', panelId: id,
      sessionId: id === 'panel-a' ? 'session-a' : `session-${id}`, deviceId: 'device-a' } };
  panels.set(id, panel);
  panel.viewer = await createViewer({ canvas: element.querySelector('canvas'), container: element.querySelector('.stage'),
    enableTestHooks: true,
    onSelection: (_keys, snapshot) => { state.lastInteractedPanel = id; updateSequence(panel, snapshot); },
    onMutation: snapshot => updateSequence(panel, snapshot) });
  state.maxLiveViewers = Math.max(state.maxLiveViewers, [...panels.values()].filter(p => p.mounted).length);
  element.querySelector('canvas').addEventListener('pointerdown', () => { state.lastInteractedPanel = id; });
  element.querySelector('select').addEventListener('change', event => runUi(panel, () => panel.viewer.setRepresentation(event.target.value)));
  element.querySelector('.focus').addEventListener('click', () => runUi(panel, () => panel.viewer.focus(panel.viewer.snapshot().selectionKeys)));
  await loadPanel(id, fixtureId, { representation });
}

const api = {
  snapshot: () => ({ ...state, panels: Object.fromEntries([...panels].map(([id, p]) => [id,
    { ...(p.viewer?.snapshot() ?? { status: 'initializing', ready: false }), mounted: p.mounted,
      hidden: p.hidden, sceneId: p.sceneId, desktopRevision: p.revision }])) }),
  capturePanel, describePanel, loadPanel, applyReturn,
  loadMeasuredFixture: (id, fixture, options = {}) => {
    if (fixture?.id !== 'public_4hhb'
      || fixture.sha256 !== '2d3ca1bf21ddff35af2e2bc5d331720f7bfc46a16c4829ea3ec1b41062d5f5a6') {
      throw new Error('Performance fixture is outside the pinned public tier.');
    }
    return loadFixture(id, fixture, options);
  },
  bindTarget: (id, target) => {
    const panel = panelFor(id);
    const keys = ['bindingId', 'taskId', 'panelId', 'sessionId', 'deviceId'];
    if (panel.targetBound || target?.panelId !== id || Object.keys(target).length !== keys.length
      || !keys.every(key => typeof target[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(target[key]))) {
      throw new Error('Invalid or already-bound panel target.');
    }
    panel.target = clone(target); panel.targetBound = true;
  },
  applyInspection: (id, inspection) => { const p = panelFor(id); return queued(p, () => p.viewer.applyInspection(inspection)); },
  lifecycleTest: (id, method, ...args) => {
    const p = panelFor(id);
    if (!p.viewer.testHooks || typeof p.viewer.testHooks[method] !== 'function') throw new Error('Unknown lifecycle test method.');
    return p.viewer.testHooks[method](...args);
  },
  cancelLoad: id => panelFor(id).viewer.cancelLoad(),
  probeBusy: async id => {
    const p = panelFor(id);
    if (!p.viewer.snapshot().candidatePresent) throw new Error('A staged candidate is required for this test.');
    const outcomes = await Promise.allSettled([
      p.viewer.setRepresentation(p.viewer.snapshot().representation),
      p.viewer.load(fixtures.public_1crn, { modelNumber: 1, assemblyId: '1' }),
    ]);
    return outcomes.map(result => result.status === 'fulfilled' ? { status: 'fulfilled' }
      : { status: 'rejected', code: result.reason.code, message: result.reason.message });
  },
  disposeDuringLoad: async id => {
    const p = panelFor(id); p.closing = true; p.mounted = false; await p.viewer.dispose();
  },
  rows: id => clone(panelFor(id).fixture.catalog.rows.filter(r => r.identity.modelNumber === panelFor(id).viewer.snapshot().modelNumber)),
  select: (id, keys) => { const p = panelFor(id); return queued(p, () => p.viewer.select(keys)); },
  setCamera: (id, camera) => { const p = panelFor(id); return queued(p, () => p.viewer.setCamera(camera)); },
  setRepresentation: (id, value) => { const p = panelFor(id); return queued(p, async () => {
    const result = await p.viewer.setRepresentation(value); p.element.querySelector('select').value = value; return result;
  }); },
  pickPoint: (id, key) => panelFor(id).viewer.pickPoint(key),
  loadInstruction: async instruction => {
    const result = await loadPanel('receiver', instruction.fixtureId, instruction.scene);
    panelFor('receiver').sceneId = instruction.sceneId;
    return result;
  },
  applyCommand: async instruction => {
    const panel = panelFor('receiver');
    return queued(panel, async () => {
      const before = panel.viewer.snapshot();
      if (before.instanceId !== instruction.expectedBrowser.instanceId || before.generation !== instruction.expectedBrowser.generation
        || before.loadCount !== instruction.expectedBrowser.loadCount
        || before.revision !== instruction.expectedBrowser.revision || before.sourceSha256 !== instruction.sourceSha256
        || panel.sceneId !== instruction.sceneId) throw new Error('Renderer ownership changed before command apply.');
      if (instruction.operation.kind !== 'set_representation') throw new Error('Unsupported browser experiment command.');
      const result = await panel.viewer.setRepresentation(instruction.operation.value);
      panel.element.querySelector('select').value = instruction.operation.value;
      return result;
    });
  },
  setHidden: (id, hidden) => {
    const p = panelFor(id); p.hidden = Boolean(hidden); p.element.dataset.hidden = String(p.hidden);
  },
  disposePanel: async id => {
    const p = panelFor(id);
    if (p.disposePromise) return p.disposePromise;
    if (!p.mounted) return;
    p.closing = true;
    p.element.querySelector('.stage').style.pointerEvents = 'none';
    for (const control of p.element.querySelectorAll('button, select')) control.disabled = true;
    p.disposePromise = p.queue.then(async () => {
      try { await capturePanel(id); }
      finally { p.mounted = false; await p.viewer.dispose(); }
    });
    p.queue = p.disposePromise.catch(() => {});
    return p.disposePromise;
  },
  dispose: async () => { for (const id of panels.keys()) await api.disposePanel(id); state.status = 'disposed'; },
};
Object.defineProperty(window, '__stereofoldRoundtrip', { value: Object.freeze(api), writable: false, configurable: false });
window.addEventListener('pagehide', () => { for (const p of panels.values()) if (p.mounted) { p.viewer?.dispose(); p.mounted = false; } }, { once: true });

async function boot() {
  const role = document.body.dataset.roundtripRole;
  if (role !== 'receiver') {
    await mount('panel-a', 'Desktop panel A', 'public_1crn', 'cartoon');
    await mount('panel-b', 'Desktop panel B', 'synthetic_ligand', 'ball-and-stick');
  }
  if (role !== 'desktop') await mount('receiver', 'Independent viewer', 'synthetic_ligand', 'ball-and-stick');
  state.status = 'ready';
  status.textContent = `${panels.size} viewers are ready. Each panel owns its molecular scene and camera.`;
}
boot().catch(error => { state.status = 'error'; state.error = error.message; status.textContent = error.message; console.error(error); });
