import { geometryBudgetChanged } from '../browser-roundtrip/geometry-advisory.mjs';
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE, PLACEMENT_MAX_TRANSLATION } from '../browser-roundtrip/placement-limits.mjs';
import { demoSourceIdentity } from '../browser-roundtrip/demo-source-identity.mjs';
import { interruptibleCommand } from './interruptible-command.mjs';
import { createNamedPublication } from './named-publication.mjs';
import { captureNamedView, restoreNamedView } from './named-view.mjs';
import { summarizeHostViews, renderHostViews } from './named-view-library.mjs';
import { createViewer } from '../browser-roundtrip/viewer.mjs';
// One request's edits run as one operation. The ordering, the
// single undo group and the rollback live beside the state they act on.
import { applyCompoundChange } from '../browser-roundtrip/compound-change.mjs';
import './style.css';

export async function createInspectionWorkspace(options = {}) {
const root = options.root ?? document;
const namedPublication = createNamedPublication(snapshot => options.onMutation?.(snapshot));
const amino = { ALA:'A', ARG:'R', ASN:'N', ASP:'D', CYS:'C', GLN:'Q', GLU:'E', GLY:'G', HIS:'H', ILE:'I', LEU:'L', LYS:'K', MET:'M', PHE:'F', PRO:'P', SER:'S', THR:'T', TRP:'W', TYR:'Y', VAL:'V' };
const $ = selector => root.querySelector(selector);
const $$ = selector => [...root.querySelectorAll(selector)];
let viewer, fixture = null, queue = Promise.resolve(), busy = false, closing = false, anchor = null;
let disposed, lastGeneration = null, lastSavedSignature = '', searchValue = '', chainValue = 'all', sequenceSelectionJsonBytes = 2;
let loadedView, walkthrough = null;
// The host library (`namedViews` from inspection state /
// hydration) is the only saved-view authority once the host provides it. The
// tab-local `savedViews` snapshots below stay only for the no-host preview.
let hostLibrary = null;
const hostViewCallbacks = () => [options.onSaveNamedView, options.onRestoreNamedView, options.onDeleteNamedView];
const hostDriven = () => hostLibrary !== null && hostViewCallbacks().every(callback => typeof callback === 'function');
const sourceOf = snapshot => snapshot ? { sourceSha256:snapshot.sourceSha256, modelNumber:snapshot.modelNumber, assemblyId:snapshot.assemblyId } : undefined;
function setNamedViews(library) {
  if (library && typeof library === 'object' && Array.isArray(library.entries)) hostLibrary = structuredClone(library);
  if (viewer) sync();
}
const status = $('#status');
status.dataset.role = 'status';
const label = row => `${row.identity.authorChain} · ${row.identity.componentId} ${row.identity.authorResidue ?? '?'}${row.identity.insertionCode}`;
const colorField = (key, title, value) => `<label class="color-field"><span>${title}</span><span class="color-input"><input type="color" value="${value}" data-picker="${key}" aria-label="Choose ${title.toLowerCase()}"><input type="text" value="${value}" data-control="${key}" aria-label="${title} hex" maxlength="7" spellcheck="false"></span></label>`;
const slider = (key, title, min, max, step, value, suffix = '', numberBounds) => `<label class="slider-field"><span>${title}</span><span class="number-with-unit"><input data-control="${key}" aria-label="${title}" type="number" min="${numberBounds?.min ?? min}" max="${numberBounds?.max ?? max}" step="${numberBounds?.step ?? step}" value="${value}">${suffix}</span><input data-range="${key}" aria-label="${title} slider" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
const axes = (kind, title, min, max, step) => `<fieldset class="axes"><legend>${title}</legend>${['x','y','z'].map(axis => `<label><span>${axis.toUpperCase()}</span><input type="number" data-axis="${axis}" data-vector="${kind}" aria-label="${title} ${axis.toUpperCase()}" min="${min}" max="${max}" step="${step}" value="0"></label>`).join('')}</fieldset>`;

$('#app').innerHTML = `<header class="app-header">
  <a class="brand" href="#scene" aria-label="Stereofold molecular canvas"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 9 16 3l10 6v14l-10 6-10-6Zm0 0 10 6 10-6M16 15v14"/></svg>STEREOFOLD<span>/ INSPECT</span></a>
  <div class="header-actions"><span class="preview-badge">LOCAL PREVIEW</span><button data-action="undo" title="Undo last inspection change">↶ <span>Undo</span></button><button data-action="redo" title="Redo inspection change">↷ <span>Redo</span></button></div>
</header>
<div class="scene-heading"><div><div class="eyebrow">MOLECULAR WORKSPACE</div><h1>Crambin <span class="source-code">1CRN</span></h1></div><div class="scene-facts"><span>Model <b data-fact="model">1</b></span><span>Assembly <b data-fact="assembly">1</b></span><span><b data-fact="residues">46</b> residues</span><span><b data-fact="atoms">327</b> atoms</span></div></div>
<nav class="mobile-tabs" aria-label="Workspace"><button data-workspace="structure" aria-pressed="true">Structure</button><button data-workspace="sequence" aria-pressed="false">Sequence</button></nav>
<main class="workspace" data-workspace="structure">
  <section class="molecular-view" aria-label="Structure inspection"><div class="canvas-tools"><div class="view-label"><span class="live-dot"></span>3D STRUCTURE</div><div><button class="sheet-toggle" data-layout="inspector" data-action="toggle-inspector" aria-controls="inspector-sheet" aria-expanded="false" title="Show the inspection tools over the structure">Tools</button><button class="sheet-toggle" data-layout="sequence" data-action="toggle-sequence" aria-controls="sequence-sheet" aria-expanded="false" title="Show the residue sequence over the structure">Sequence</button><button data-action="rotation" title="Slowly rotate the structure">Rotate structure</button><button data-action="fit">Fit molecule</button><button data-action="reset-orientation" title="Restore the original viewing direction">Reset orientation</button></div></div>
    <div class="stage" id="scene"><canvas tabindex="0" aria-label="Molecular canvas. Click a residue to select it. Drag to orbit, scroll to zoom. F fits the molecule; Escape clears selection."></canvas><div class="canvas-caption" aria-hidden="true"><span>PUBLIC STRUCTURE / 1CRN</span><span class="canvas-legend">Chain identity</span></div></div>
    <div class="canvas-bottom"><span>Click to select <i>·</i> Drag to orbit <i>·</i> Scroll to zoom</span><span class="selection-count">No residues selected</span></div>
  </section>
  <aside class="inspector" id="inspector-sheet" aria-label="Inspection controls"><button class="sheet-close" data-layout="inspector" data-action="close-inspector">Hide tools</button><div class="inspector-heading"><div class="eyebrow">MAKE IT YOUR VIEW</div><h2>Inspect the structure</h2><p>Explore its form. Keep your place.</p></div>
    <section class="walkthrough" aria-label="Guided inspection" data-step="idle">
      <div class="walkthrough-intro"><p>Explore on this Mac. No headset needed.</p><button data-guide="start" aria-expanded="false">Start walkthrough <span aria-hidden="true">→</span></button></div>
      <div class="walkthrough-active" hidden><div class="eyebrow" data-guide-progress></div><h3 data-guide-title tabindex="-1"></h3><p data-guide-description></p><p class="walkthrough-result" role="status" data-guide-result></p><button class="primary full" data-guide="apply"></button><div class="walkthrough-exit"><button data-guide="restore">Restore starting view</button><button data-guide="keep">Keep exploring</button></div></div>
    </section>
    <nav class="tool-tabs" role="tablist" aria-label="Inspection tools"><button role="tab" id="tab-look" aria-controls="tools-look" data-tab="look" aria-selected="true">Appearance</button><button role="tab" id="tab-view" aria-controls="tools-view" data-tab="view" aria-selected="false">View</button><button role="tab" id="tab-move" aria-controls="tools-move" data-tab="move" aria-selected="false">Move</button></nav>
    <div class="tool-content"><section role="tabpanel" id="tools-look" aria-labelledby="tab-look" data-tools="look">
      <div class="quick-looks"><button data-action="residue-map"><span class="preset-dot rainbow"></span>Residue map</button><button data-action="ghost"><span class="preset-dot ghost"></span>Ghost surface</button></div>
      <label class="field">Representation<select data-control="representation"><option value="cartoon">Cartoon</option><option value="ball-and-stick">Ball and stick</option><option value="molecular-surface">Molecular surface</option><option value="spacefill">Spacefill</option></select></label>
      <label class="field" data-quality-field hidden>Render quality<select data-control="render-quality"><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="best">Best</option></select></label>
      <label class="field">Color by<select data-control="color"><option value="chain-id">Chain identity</option><option value="residue-name">Residue identity</option><option value="element-symbol">Chemical element</option><option value="sequence-id">Sequence position</option><option value="uniform">Uniform color</option></select></label>
      <div class="color-key" aria-label="Color legend"></div>
      ${colorField('uniform-color', 'Molecule color', '#58dcc9')}
      ${slider('opacity', 'Opacity', 0, 1, .01, 1)}
      <div class="section-rule"></div><div class="section-title">Selection</div>
      ${colorField('highlight-color', 'Selection color', '#f2c47c')}
      <label class="switch-row"><span>Label selected residues<small>Identity labels in the 3D scene</small></span><input type="checkbox" data-control="labels"></label>
      <p class="label-limit" hidden></p>
      <div class="section-rule"></div><div class="section-title">Environment</div>
      ${colorField('background', 'Background', '#071015')}
      <div class="background-presets"><button data-background="#071015" aria-label="Midnight background" style="--swatch:#071015">Midnight</button><button data-background="#192734" aria-label="Slate background" style="--swatch:#192734">Slate</button><button data-background="#eee9dd" aria-label="Paper background" style="--swatch:#eee9dd">Paper</button></div>
    </section><section role="tabpanel" id="tools-view" aria-labelledby="tab-view" data-tools="view" hidden>
      <div class="section-title">Viewpoint</div><p class="help">Move your viewpoint around the structure. Molecule placement stays fixed.</p>
      <div class="button-grid"><button data-orbit="y,-15">Orbit left</button><button data-orbit="y,15">Orbit right</button><button data-orbit="x,-15">Orbit up</button><button data-orbit="x,15">Orbit down</button><button data-dolly="0.85">Move closer</button><button data-dolly="1.18">Move farther</button></div>
      <div class="section-rule"></div><div class="section-title">Depth & atmosphere</div>
      ${slider('clipping', 'Cutaway', 0, 80, 1, 0, '%')}${slider('fog', 'Depth fog', 0, 100, 1, 0, '%')}
      <p class="help">Cutaway trims front and back depth. Fog softens distant geometry.</p><button class="full" data-action="reveal">Show the whole molecule</button><p class="help">Clears cutaway and fog, makes the molecule opaque, and fits it in view.</p>
      <div class="section-rule"></div><div class="section-title" data-views-title>Saved views · this tab</div><label class="field">Name this view<input data-control="view-name" placeholder="e.g. Active-site detail" maxlength="80"></label><button class="primary full" data-action="save-view">＋ Save inspection</button><div class="saved-views"><p class="help">Save color, placement, viewpoint and selection together.</p></div>
    </section><section role="tabpanel" id="tools-move" aria-labelledby="tab-move" data-tools="move" hidden>
      <div class="section-title">Molecule placement</div><p class="help">Move the molecule independently of the viewpoint. Source coordinates stay intact.</p>
      ${axes('translation', 'Position', -PLACEMENT_MAX_TRANSLATION, PLACEMENT_MAX_TRANSLATION, .1)}<p class="help">X / Y / Z in molecular radii. Z moves the structure through depth.</p>
      ${axes('rotation', 'Rotation', -180, 180, 15)}<p class="help">Degrees around the molecule’s center.</p>
      ${slider('scale', 'Molecule scale', .25, 4, 'any', 1, '×', { min: PLACEMENT_MIN_SCALE, max: PLACEMENT_MAX_SCALE, step: 'any' })}
      <button class="full" data-action="reset-placement">Reset molecule placement</button>
      <div class="section-rule"></div><div class="spatial-note"><span class="live-dot"></span><div><strong>Your viewpoint is separate</strong><p>In XR, moving your head changes what each eye sees. It does not change a saved inspection.</p></div></div>
    </section></div>
    <div class="inspector-foot"><span class="confirmation-dot"></span><span class="last-action">Awaiting structure</span></div>
  </aside>
  <section class="sequence-panel" id="sequence-sheet" aria-label="Sequence selection"><button class="sheet-close" data-layout="sequence" data-action="close-sequence">Hide sequence</button><div class="sequence-head"><h2>Sequence <span class="chain-label">CHAIN A</span></h2><div class="sequence-actions"><select data-control="chain" aria-label="Sequence chain"><option value="all">All chains</option></select><input type="search" data-control="search" aria-label="Find residue" placeholder="Find residue or 8–16"><button data-action="select-range">Select range</button><button data-action="clear">Clear</button><button class="primary" data-action="focus">Focus selection</button></div></div>
    <div class="sequence" role="group" aria-label="Residue positions"></div><div class="selection-details" role="status">Choose a residue to see its identity. Shift-click extends a range; ⌘/Ctrl-click adds or removes.</div>
  </section>
</main><div class="mobile-selection" aria-label="Current selection"><span class="mobile-selection-summary" role="status">No residues selected</span><div><button data-selection="focus">Focus selection</button><button data-selection="clear">Clear</button></div></div><footer class="app-footer"><span class="footer-note">Inspection preview <i>·</i> Opens on Meta Quest over private Wi-Fi</span><div class="status-slot"></div></footer>`;
$('.status-slot').append(status);
$('.workspace').before($('.mobile-selection'));
// Fragment navigation in a host's srcdoc iframe can replace the app document
// and disconnect its MCP bridge. Keep this canvas shortcut inside the view.
$('.brand').addEventListener('click', event => {
  event.preventDefault();
  $('#scene').scrollIntoView({ block: 'start' });
});
if (document.body.dataset.emulationUrl === '/emulation.html') {
  const link = document.createElement('a'); link.className = 'emulation-link';
  link.href = '/emulation.html'; link.target = '_blank'; link.rel = 'noopener';
  link.textContent = 'Emulated Quest sample ↗'; link.setAttribute('aria-label', 'Open a separate emulated Quest sample in a new tab');
  const note = document.createElement('small'); note.textContent = 'Opens a separate sample in a new tab.';
  $('.walkthrough-intro').append(link, note);
}
// IWER reparents this canvas during immersion; retain its owned element.
const moleculeCanvas = $('.stage canvas');

function setStatus(message, error = false) {
  status.textContent = message; status.dataset.error = String(error);
}

function currentRows() {
  const snapshot = viewer?.snapshot();
  return (fixture?.catalog.rows ?? []).filter(row => !snapshot || (row.identity.modelNumber === snapshot.modelNumber && row.identity.assemblyId === snapshot.assemblyId));
}

function selectedRows(snapshot = viewer.snapshot()) {
  const keys = new Set(snapshot.selectionKeys);
  return currentRows().filter(row => keys.has(row.key));
}

// The canonical catalog always remains available through rows()/identityRows()
// for saved-scene validation, tools and precise lookup. The sequence bulk
// action follows only the stage Mol* is currently displaying.
function visibleRows() {
  const visible = fixture?.visible;
  if (!visible) return currentRows();
  const entities = visible.entityIds ? new Set(visible.entityIds.map(String)) : undefined;
  const chains = visible.labelChains ? new Set(visible.labelChains.map(String)) : undefined;
  const operators = visible.operatorIds ? new Set(visible.operatorIds.map(String)) : undefined;
  return currentRows().filter(row => {
    const identity = row.identity;
    if (entities && !entities.has(String(identity.entityId))) return false;
    if (chains && !chains.has(String(identity.labelChain))) return false;
    const ids = Array.isArray(identity.operatorIds) ? identity.operatorIds.map(String) : [];
    return !operators || ids.some(id => operators.has(id));
  });
}

const guideSteps = [
  { title:'See the fold', button:'Show residue colors', tab:'look', description:'Start with the full Crambin structure. Colors distinguish amino-acid types.', result:'Residue colors are shown. You can also choose colors in Appearance.', apply:async () => {
    const next = structuredClone(loadedView); next.inspection.appearance.color = 'residue-name';
    await viewer.inspection.restore(next);
  } },
  { title:'Identify a residue', button:'Select and label residue 8', tab:'look', description:'Select valine 8 in chain A. A single label makes its identity easy to read in the structure.', result:'VAL 8 is labelled and selected in the sequence. Selection alone keeps your viewpoint still.', apply:async () => {
    const next = viewer.inspection.capture();
    next.selectionKeys = currentRows().filter(row => row.identity.authorChain === 'A' && row.identity.authorResidue === 8).map(row => row.key);
    next.inspection.appearance.labels = true; await viewer.inspection.restore(next);
  } },
  { title:'Inspect a larger region', button:'Select and focus residues 8–16', tab:'view', description:'Highlight nine residues and bring them into view. Hide their labels to keep the region clear; the sequence retains every identity.', result:'Residues 8–16 are highlighted and in focus. Fit molecule brings the full structure back.', apply:async () => {
    const next = viewer.inspection.capture();
    next.selectionKeys = currentRows().filter(row => row.identity.authorChain === 'A' && row.identity.authorResidue >= 8 && row.identity.authorResidue <= 16).map(row => row.key);
    next.inspection.appearance.labels = false; await viewer.inspection.restore(next); await viewer.focus(next.selectionKeys);
  } },
  { title:'Look through the surface', button:'Show a transparent cutaway', tab:'view', description:'Make the molecular surface see-through and trim its front and back depth.', result:'The surface is 35% opaque with a 20% cutaway. Show the whole molecule clears both effects.', apply:() => viewer.inspection.configure({ representation:'molecular-surface', color:'uniform', uniformColor:'#58dcc9', opacity:.35, clipping:20, fog:0 }) },
  { title:'Move the molecule', button:'Turn and move the molecule', tab:'move', description:'Translate, rotate and enlarge the molecule. Your viewpoint stays in place.', result:'The molecule moved; the viewpoint did not. Move gives you independent position, rotation and scale.', apply:() => viewer.inspection.place({ translation:[.35,0,.1], rotation:[0,30,0], scale:1.15 }) },
  { title:'Move your viewpoint', button:'Look from another angle', tab:'view', description:'Orbit around the placed molecule. Its position, rotation and scale stay fixed.', result:'Your viewpoint changed; molecule placement did not. Keep exploring or restore the view you started with.', apply:() => viewer.inspection.orbit('y', -30) },
];

function syncWalkthrough(snapshot = viewer?.snapshot()) {
  if (walkthrough && snapshot?.sourceSha256 !== walkthrough.start.sourceSha256) walkthrough = null;
  const active = Boolean(walkthrough), panel = $('.walkthrough');
  $('.inspector-heading').hidden = active;
  panel.dataset.step = active ? String(walkthrough.step) : 'idle';
  panel.dataset.applied = String(walkthrough?.applied ?? false);
  $('.walkthrough-intro').hidden = active; $('.walkthrough-active').hidden = !active;
  $('[data-guide="start"]').setAttribute('aria-expanded', String(active));
  const disabled = busy || closing || !snapshot?.ready || snapshot.xrPresenting;
  $('[data-guide="start"]').disabled = disabled || fixture?.id !== 'public_1crn';
  for (const button of $$('.walkthrough-active button')) button.disabled = disabled;
  if (!active) return;
  const step = guideSteps[walkthrough.step];
  $('[data-guide-progress]').textContent = `ON THIS MAC · ${walkthrough.step + 1} / ${guideSteps.length}`;
  $('[data-guide-title]').textContent = step.title;
  $('[data-guide-description]').textContent = step.description;
  $('[data-guide-result]').textContent = walkthrough.applied ? step.result : '';
  const apply = $('[data-guide="apply"]');
  apply.textContent = walkthrough.applied ? 'Next step →' : step.button;
  apply.hidden = walkthrough.applied && walkthrough.step === guideSteps.length - 1;
}

function startWalkthrough() {
  if (viewer.snapshot().xrPresenting) throw Error('Leave emulation to try the Mac walkthrough.');
  walkthrough = { start:viewer.inspection.capture(), step:0, applied:false };
  $('.workspace').dataset.workspace = 'structure';
  for (const tab of $$('.mobile-tabs button')) tab.setAttribute('aria-pressed', String(tab.dataset.workspace === 'structure'));
  syncWalkthrough(); $('[data-guide-title]').focus();
  setStatus('Walkthrough ready. Each step changes the real scene. Restore starting view is always available.');
}

$('[data-guide="start"]').addEventListener('click', () => ui('Walkthrough ready. Restore starting view is always available.', startWalkthrough));
$('[data-guide="apply"]').addEventListener('click', () => {
  if (!walkthrough) return;
  if (walkthrough.applied) {
    walkthrough.step++; walkthrough.applied = false; syncWalkthrough(); $('[data-guide-title]').focus();
    return;
  }
  const step = guideSteps[walkthrough.step];
  ui(step.result, async () => {
    if (viewer.snapshot().xrPresenting) throw Error('Leave emulation to continue the Mac walkthrough.');
    await step.apply(); walkthrough.applied = true; $(`[data-tab="${step.tab}"]`).click();
  }).then(() => { if (walkthrough?.applied && walkthrough.step === guideSteps.length - 1) $('[data-guide-title]').focus(); });
});
$('[data-guide="restore"]').addEventListener('click', () => run('Restored your starting appearance, placement, selection and viewpoint.', async () => {
  await viewer.inspection.restore(walkthrough.start); walkthrough = null;
}).then(() => $('[data-guide="start"]').focus()).catch(() => {}));
$('[data-guide="keep"]').addEventListener('click', () => {
  walkthrough = null; syncWalkthrough(); $('[data-guide="start"]').focus(); setStatus('Kept this view. Continue with Appearance, View and Move.');
});

function syncMotion(motion = viewer?.inspection.getMotion()) {
  const control = $('[data-action="rotation"]');
  control.textContent = motion && !motion.paused ? 'Pause rotation' : 'Rotate structure';
  control.title = motion?.reason === 'reduced-motion' ? 'Rotation follows your reduced-motion preference'
    : motion?.paused ? 'Slowly rotate the structure' : 'Pause at the current orientation';
  control.disabled = busy || closing || !viewer?.snapshot().ready || motion?.reason === 'reduced-motion';
}

/**
 * The desktop half of the render-budget setting.
 *
 * The headset has a menu row, a spoken phrase and an agent command for it, so
 * the desktop panel has to show the same three
 * levels or the two surfaces disagree about what the renderer is doing. The
 * field is hidden outright on a viewer with no render-budget lever rather than
 * offered as a control that would do nothing.
 */
function syncRenderQuality() {
  const field = $('[data-quality-field]');
  if (!field) return;
  const supported = typeof viewer?.inspection?.setRenderQuality === 'function';
  field.hidden = !supported;
  if (!supported) return;
  const level = viewer.inspection.renderQuality?.();
  if (typeof level === 'string') $('[data-control="render-quality"]').value = level;
}

function sceneHistory(snapshot = options.getSceneHistory ? viewer?.readiness?.() ?? viewer?.snapshot() : viewer?.snapshot()) {
  const history = options.getSceneHistory?.(snapshot) ?? snapshot?.inspection?.history ?? {};
  const unavailable = busy || closing || !snapshot?.ready;
  return { ...history,
    canUndo: !unavailable && (history.canUndo ?? history.undoCount > 0),
    canRedo: !unavailable && (history.canRedo ?? history.redoCount > 0) };
}
function syncSceneHistory(snapshot) {
  const history = sceneHistory(snapshot);
  $('[data-action="undo"]').disabled = !history.canUndo;
  $('[data-action="redo"]').disabled = !history.canRedo;
}
async function requestSceneHistory(kind) {
  // Drain admitted local work, then release this queue before requesting a
  // host command: normal polling needs the queue to render that command.
  await queue;
  if (closing) throw Error('The inspection has closed.');
  return options.onSceneHistoryAction(kind);
}

function sync(snapshot = viewer?.snapshot()) {
  if (!snapshot?.inspection) return;
  const { appearance: a, placement: p, history, savedViews } = snapshot.inspection;
  // Keep the slider useful around the current size while the numeric field
  // accepts the whole placement range. Hydrating a large or tiny saved scene
  // must not silently clamp the slider to an unrelated value.
  const scaleRange = $('[data-range="scale"]');
  const exploredScale = p.scale < .25 || p.scale > 4;
  scaleRange.min = Math.max(PLACEMENT_MIN_SCALE, exploredScale ? p.scale / 2 : .25);
  scaleRange.max = Math.min(PLACEMENT_MAX_SCALE, exploredScale ? p.scale * 2 : 4);
  const values = { representation:a.representation, color:a.color, 'uniform-color':a.uniformColor,
    background:a.background, 'highlight-color':a.highlightColor, opacity:a.opacity, clipping:a.clipping, fog:a.fog, scale:p.scale };
  for (const [key, value] of Object.entries(values)) for (const control of $$(`[data-control="${key}"], [data-range="${key}"], [data-picker="${key}"]`)) control.value = value;
  $('[data-control="labels"]').checked = a.labels;
  for (const kind of ['translation','rotation']) for (const input of $$(`[data-vector="${kind}"]`)) input.value = Math.round(p[kind][['x','y','z'].indexOf(input.dataset.axis)] * 1000) / 1000;
  const displayProvenance = demoSourceIdentity(fixture?.sha256);
  for (const [key, value] of Object.entries({ model:snapshot.modelNumber, assembly:snapshot.assemblyId, residues:snapshot.residueCount, atoms:snapshot.atomCount })) $(`[data-fact="${key}"]`).textContent = key === 'assembly' && value === 'asymmetric_unit'
    ? displayProvenance?.scope ?? (fixture?.code?.toUpperCase() === 'XXXX' ? 'Local coordinates' : 'Asymmetric unit') : value;
  const rows = selectedRows(snapshot), selected = new Set(snapshot.selectionKeys);
  for (const button of $$('.sequence button')) button.setAttribute('aria-pressed', String(selected.has(button.dataset.key)));
  $('.selection-count').textContent = rows.length ? `${rows.length} residue${rows.length === 1 ? '' : 's'} selected` : 'No residues selected';
  $('.selection-count').dataset.empty = String(rows.length === 0);
  $('.selection-details').textContent = rows.length
    ? `${rows.slice(0, 4).map(label).join('   /   ')}${rows.length > 4 ? `   + ${rows.length - 4} more` : ''}${rows.some(r => r.coordinateState !== 'resolved') ? ' · Coordinates missing for part of this selection.' : ''}`
    : 'Choose a residue to see its identity. Shift-click extends a range; ⌘/Ctrl-click adds or removes.';
  $('.mobile-selection-summary').textContent = rows.length
    ? `${rows.slice(0, 2).map(label).join(' / ')}${rows.length > 2 ? ` + ${rows.length - 2} more` : ''}${rows.some(r => r.coordinateState !== 'resolved') ? ' · Coordinates missing' : ''}` : 'No residues selected';
  $('.label-limit').hidden = !a.labels || rows.length <= 1;
  $('.label-limit').textContent = rows.length > 32 ? 'Showing up to 32 resolved residue labels. All selected identities remain in the sequence.'
    : 'Nearby labels may overlap. Select one residue for a clear label, or hide labels and inspect the highlighted range in the sequence.';
  $('.canvas-legend').textContent = $('[data-control="color"]').selectedOptions[0]?.textContent ?? a.color;
  const legends = {
    'chain-id': 'Each chain has a distinct color.', 'residue-name': 'Colors identify amino-acid types.',
    'element-symbol': 'Carbon · nitrogen · oxygen · sulfur', 'sequence-id': 'N terminus → C terminus', 'uniform': 'One color across the structure.',
  };
  $('.color-key').textContent = legends[a.color];
  $('.color-key').dataset.theme = a.color;
  const actionNames = { configure:'Appearance', place:'Molecule placement', orbit:'Viewpoint', dolly:'Viewpoint distance', selection:'Selection', pick:'Selection', fit:'Fit molecule', focus:'Selection focus', 'reset-orientation':'Orientation', 'restore-view':'Saved view', 'save-view':'Saved view', undo:'Undo', redo:'Redo', restore:'Inspection' };
  $('.confirmation-dot').hidden = !snapshot.ready;
  $('.last-action').textContent = !snapshot.ready ? 'No structure loaded' : history.lastAction ? `Shown · ${actionNames[history.lastAction] ?? 'Inspection'}` : 'Scene ready';
  const disabled = busy || closing || !snapshot.ready;
  for (const control of $$('#app button, #app input, #app select')) {
    if (control.dataset.workspace || control.dataset.tab || control.dataset.layout) continue;
    // The inspector owns XR entry, resume and exit. Done/reconnect refreshes
    // must not enable entry while presenting or overwrite its retry state.
    if (control.matches('[data-enter-xr], [data-resume-xr], [data-leave-xr]')) continue;
    control.disabled = disabled;
  }
  syncSceneHistory(snapshot);
  $('[data-action="focus"]').disabled = disabled || !rows.length || rows.some(r => r.coordinateState !== 'resolved' || !r.atomSites.length);
  $('[data-action="clear"]').disabled = disabled || !rows.length;
  $('[data-selection="focus"]').disabled = $('[data-action="focus"]').disabled;
  $('[data-selection="clear"]').disabled = $('[data-action="clear"]').disabled;
  for (const input of $$('[data-control="uniform-color"], [data-picker="uniform-color"]')) input.disabled = disabled || a.color !== 'uniform';
  moleculeCanvas.style.pointerEvents = disabled ? 'none' : '';
  if (snapshot.generation !== lastGeneration) { lastGeneration = snapshot.generation; renderSequence(); }
  syncSearchAction(); syncWalkthrough(snapshot); syncMotion(snapshot.inspectionMotion); syncRenderQuality();
  // Host-driven listing from the shared library, with
  // capacity, foreign-source labels and revision-carrying deletes. The
  // tab-local branch below is the no-host preview fallback only.
  const signature = JSON.stringify(hostDriven() ? { host:hostLibrary } : { tab:savedViews });
  if (signature !== lastSavedSignature) {
    lastSavedSignature = signature;
    const title = $('[data-views-title]'), list = $('.saved-views');
    if (!hostDriven()) {
      title.textContent = 'Saved views · this tab';
      list.replaceChildren();
      if (!savedViews.length) { const text = document.createElement('p'); text.className = 'help'; text.textContent = 'Save color, placement, viewpoint and selection together.'; list.append(text); }
      for (const view of savedViews) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'saved-view'; button.textContent = view.name;
        button.addEventListener('click', () => ui(`Restored ${view.name}`, () => viewer.inspection.restoreView(view.id))); list.append(button);
      }
    } else {
      const summary = summarizeHostViews(hostLibrary, sourceOf(snapshot));
      title.textContent = `Saved views · ${summary.capacityText}`;
      renderHostViews(list, summary, {
        onRestore: row => ui(`Restore sent for “${row.name}”`, () => options.onRestoreNamedView(row)),
        onDelete: row => ui(`Deleted “${row.name}”`, () => options.onDeleteNamedView(row)),
      });
    }
  }
}

function run(message, action, { publishSettled = true } = {}) {
  const work = queue.then(async () => {
    if (closing) throw Error('The inspection has closed.');
    busy = true;
    // Keep the user's edited value visible while its frame is pending. A full
    // sync here would briefly untick checkboxes and snap sliders backwards.
    for (const control of $$('#app button, #app input, #app select')) {
      if (!control.dataset.workspace && !control.dataset.tab && !control.dataset.layout
        && !control.matches('[data-enter-xr], [data-resume-xr], [data-leave-xr]')) control.disabled = true;
    }
    moleculeCanvas.style.pointerEvents = 'none';
    setStatus('Changing the scene…');
    try { const result = await action(); setStatus(result?.applied?.geometryBudget?.message ?? (typeof message === 'function' ? message(result) : message)); return result; }
    catch (error) { setStatus(error.message, true); throw error; }
    finally { busy = false; sync(); if (publishSettled) options.onSettled?.(); }
  });
  queue = work.catch(() => {});
  return work;
}

function ui(message, action) {
  return run(message, async () => {
    // Manual edits begin at the displayed orientation. Tool commands use their
    // separately admitted saved scene through applyRemote below.
    await viewer.inspection.setMotion({paused:true});
    return action();
  }).catch(() => {});
}
$('[data-action="rotation"]').addEventListener('click', () => {
  const paused = !viewer.inspection.getMotion().paused;
  void run(paused ? 'Rotation paused' : 'Structure rotating slowly', () => viewer.inspection.setMotion({paused})).catch(() => {});
});

function renderSequence() {
  // The companion deliberately hides the desktop sequence editor. Keep the
  // complete catalog available to tours and picking without creating thousands
  // of invisible residue buttons and their event handlers in a headset.
  if (options.enableXr === true) { sequenceSelectionJsonBytes = 2; $('.sequence').replaceChildren(); return; }
  const all = visibleRows();
  const chain = $('[data-control="chain"]');
  const choices = [...new Set(all.map(r => r.identity.labelChain))];
  if (JSON.stringify(choices) !== chain.dataset.choices) {
    chain.dataset.choices = JSON.stringify(choices); chain.replaceChildren(new Option('All chains', 'all'));
    choices.forEach(id => chain.append(new Option(`Chain ${id}`, id))); chainValue = 'all'; chain.value = 'all';
  }
  $('.chain-label').textContent = chainValue === 'all' ? `${choices.length} CHAIN${choices.length === 1 ? '' : 'S'}` : `CHAIN ${chainValue}`;
  const wanted = searchValue.trim().toUpperCase();
  const range = wanted.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
  const filtered = all.filter(row => (chainValue === 'all' || row.identity.labelChain === chainValue)
    && (!wanted || (range ? row.identity.authorResidue >= Number(range[1]) && row.identity.authorResidue <= Number(range[2])
      : `${label(row)} ${row.identity.labelChain}:${row.identity.labelSequenceId}`.toUpperCase().includes(wanted))));
  const sequence = $('.sequence'); sequence.replaceChildren();
  const chosen = new Set(viewer?.snapshot().selectionKeys ?? []);
  for (const row of filtered) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.key = row.key;
    button.dataset.coordinate = row.coordinateState; button.setAttribute('aria-pressed', String(chosen.has(row.key)));
    button.setAttribute('aria-label', `Select ${label(row)}${row.coordinateState !== 'resolved' ? ', coordinates missing' : ''}`);
    button.title = `${label(row)}; label ${row.identity.labelChain}:${row.identity.labelSequenceId ?? '?'}; copy ${row.identity.operatorIds.join(',')}; ${row.coordinateState}`;
    const code = document.createElement('b'); code.textContent = amino[row.identity.componentId] ?? row.identity.componentId;
    const number = document.createElement('span'); number.textContent = `${row.identity.authorResidue ?? '?'}${row.identity.insertionCode}`;
    button.append(code, number);
    button.addEventListener('click', event => {
      let keys = [row.key];
      if (event.shiftKey && anchor) {
        const from = all.findIndex(r => r.key === anchor), to = all.findIndex(r => r.key === row.key);
        const start = all[from];
        if (from >= 0 && start.identity.labelChain === row.identity.labelChain
          && start.identity.operatorIds.join(',') === row.identity.operatorIds.join(',')) keys = all.slice(Math.min(from,to), Math.max(from,to)+1).filter(r => r.identity.labelChain === row.identity.labelChain && r.identity.operatorIds.join(',') === row.identity.operatorIds.join(',')).map(r => r.key);
      } else if (event.metaKey || event.ctrlKey) {
        const selection = new Set(viewer.snapshot().selectionKeys); selection.has(row.key) ? selection.delete(row.key) : selection.add(row.key); keys = [...selection];
      }
      anchor = row.key; ui('Sequence selection shown', () => viewer.select(keys));
    });
    const hover = keys => { if (!busy && viewer?.snapshot().ready) viewer.inspection.hover(keys).catch(() => {}); };
    button.addEventListener('mouseenter', () => hover([row.key])); button.addEventListener('mouseleave', () => hover([]));
    button.addEventListener('focus', () => hover([row.key])); button.addEventListener('blur', () => hover([]));
    sequence.append(button);
  }
  if (!filtered.length) { const empty = document.createElement('p'); empty.textContent = viewer?.snapshot().ready ? 'No matching residues. Try a residue number, name, or range such as 8–16.' : 'The sequence appears after the structure loads.'; sequence.append(empty); }
  // This array is exactly the bulk action's keys. Cache its UTF-8 payload
  // once per sequence render; syncSearchAction only adds the small current
  // scene envelope around it.
  sequenceSelectionJsonBytes = new TextEncoder().encode(JSON.stringify(filtered.map(row => row.key))).byteLength;
  syncSearchAction();
}

// Kept in lockstep with plugin/src/inspection-limits.ts. This browser module
// cannot import the server TypeScript contract, so it measures the same UTF-8
// JSON scene that sync_inspection validates before offering a bulk selection.
const INSPECTION_SCENE_BYTE_LIMIT = 2 * 1024 * 1024;
function bulkSelectionSceneBytes() {
  const candidate = viewer.inspection.capture();
  delete candidate.inspection.history; delete candidate.inspection.savedViews;
  candidate.selectionKeys = [];
  // Replacing [] with the cached exact JSON array yields the exact encoded
  // candidate scene length without repeatedly serializing thousands of keys.
  return new TextEncoder().encode(JSON.stringify(candidate)).byteLength - 2 + sequenceSelectionJsonBytes;
}
function syncSearchAction() {
  const button = $('[data-action="select-range"]'), count = $$('.sequence button').length;
  const range = searchValue.trim().match(/^(\d+)\s*[-–:]\s*(\d+)$/);
  const overRowLimit = count > 20_000;
  const overSceneLimit = !overRowLimit && count > 0 && bulkSelectionSceneBytes() > INSPECTION_SCENE_BYTE_LIMIT;
  // Inspection scenes accept at most 20,000 canonical residue keys and 2 MiB
  // encoded JSON. A full lattice may legitimately exceed either, so require a
  // chain or residue search rather than creating an unsaveable selection.
  const overSelectionLimit = overRowLimit || overSceneLimit;
  button.textContent = !count ? 'No matches' : overSelectionLimit ? `Refine search · ${count} matches`
    : range ? `Select ${range[1]}–${range[2]} · ${count}`
      : searchValue.trim() ? `Select ${count} match${count === 1 ? '' : 'es'}` : `Select all ${count}`;
  button.title = overSelectionLimit ? 'Narrow by chain, residue name, or residue range before selecting. An inspection scene can save at most 20,000 residues and 2 MiB of encoded scene data.' : '';
  button.disabled = !count || overSelectionLimit || busy || closing || !viewer?.snapshot().ready;
}

const appearanceKeys = { 'uniform-color':'uniformColor', 'highlight-color':'highlightColor', representation:'representation', color:'color', opacity:'opacity', background:'background', labels:'labels', clipping:'clipping', fog:'fog' };
const representationNames = { cartoon:'Cartoon', 'ball-and-stick':'Ball and stick', 'molecular-surface':'Molecular surface', spacefill:'Spacefill' };
const describeSelection = () => {
  const rows = selectedRows();
  return rows.length === 1 ? label(rows[0]) : `${rows.length} residues${rows.length && new Set(rows.map(row => row.identity.authorChain)).size === 1 ? ` in chain ${rows[0].identity.authorChain}` : ''}`;
};
function appearanceMessage(field, value) {
  if (field === 'representation') return `${representationNames[value]} shown`;
  if (field === 'color') return `Colored by ${$('[data-control="color"]').selectedOptions[0].textContent.toLowerCase()}`;
  if (field === 'labels') return value ? (selectedRows().length ? `Labels shown for ${describeSelection()}` : 'Labels enabled. Select residues to show their identities.') : 'Residue labels hidden';
  if (field === 'opacity') return `Molecule opacity: ${Math.round(value * 100)}%`;
  if (field === 'clipping') return `Depth cutaway: ${value}%`;
  if (field === 'fog') return `Depth fog: ${value}%`;
  return `${{ uniformColor:'Molecule color', highlightColor:'Selection color', background:'Background' }[field]}: ${value}`;
}
for (const [key, field] of Object.entries(appearanceKeys)) {
  for (const control of $$(`[data-control="${key}"], [data-picker="${key}"], [data-range="${key}"]`)) control.addEventListener('change', () => {
    const value = control.type === 'checkbox' ? control.checked : ['range','number'].includes(control.type) ? Number(control.value) : control.value;
    ui(() => appearanceMessage(field, value), () => viewer.inspection.configure({ [field]:value }, { sceneRepresentation: field === 'representation' }));
  });
}
for (const control of $$('[data-control="scale"], [data-range="scale"]')) control.addEventListener('change', () => ui('Molecule scale shown', () => viewer.inspection.place({ scale:Number(control.value) })));
// The same three levels the headset menu row cycles and the agent's
// render-quality command sends, on the desktop panel.
const renderQualityNames = { fast:'Fast', balanced:'Balanced', best:'Best' };
// The status line is written from the result, not from the
// request. Raising the framebuffer scale cannot touch an XR layer that is
// already built, so when the headset is presenting that half of the change is
// waiting for the wearer's next entry and the line has to say so.
function renderQualityStatus(value, result) {
  const line = `Render quality: ${renderQualityNames[value] ?? value}`;
  return result?.applied?.scaleAppliesOnNextEntry === true ? `${line}. Sharper on the next headset entry.` : line;
}
for (const control of $$('[data-control="render-quality"]')) control.addEventListener('change',
  () => ui(result => renderQualityStatus(control.value, result), () => viewer.inspection.setRenderQuality(control.value)));
for (const control of $$('[data-vector]')) control.addEventListener('change', () => {
  const kind = control.dataset.vector, values = viewer.snapshot().inspection.placement[kind];
  values[['x','y','z'].indexOf(control.dataset.axis)] = Number(control.value);
  ui('Molecule placement shown', () => viewer.inspection.place({ [kind]:values }));
});
for (const button of $$('[data-background]')) button.addEventListener('click', () => ui('Background shown', () => viewer.inspection.configure({ background:button.dataset.background })));
for (const button of $$('[data-orbit]')) button.addEventListener('click', () => { const [axis,degrees] = button.dataset.orbit.split(','); ui('Viewpoint shown', () => viewer.inspection.orbit(axis, Number(degrees))); });
for (const button of $$('[data-dolly]')) button.addEventListener('click', () => ui('Viewpoint shown', () => viewer.inspection.dolly(Number(button.dataset.dolly))));
const actions = {
  fit: () => viewer.inspection.fit(), 'reset-orientation': () => viewer.inspection.resetOrientation(),
  undo: () => viewer.inspection.undo(), redo: () => viewer.inspection.redo(),
  'reset-placement': () => viewer.inspection.place({ translation:[0,0,0], rotation:[0,0,0], scale:1 }),
  clear: () => viewer.select([]), focus: () => viewer.focus(viewer.snapshot().selectionKeys),
  'residue-map': () => viewer.inspection.configure({ representation:'cartoon', color:'residue-name', opacity:1, clipping:0, fog:0 }),
  ghost: () => viewer.inspection.configure({ representation:'molecular-surface', color:'uniform', uniformColor:'#58dcc9', opacity:.35, labels:true, clipping:0, fog:0 }),
  reveal: async () => { await viewer.inspection.configure({ opacity:1, clipping:0, fog:0 }); await viewer.inspection.fit(); },
  // Host-driven saves go through the host command path
  // (the same validated manage_inspection_view flow the agent tool uses), so
  // the message stays queue-honest: sent, not saved. The tab-local branch is
  // the no-host preview fallback only.
  'save-view': () => {
    const name = $('[data-control="view-name"]').value
      || (hostDriven() ? `View ${summarizeHostViews(hostLibrary, sourceOf(viewer.snapshot())).used + 1}` : `View ${viewer.snapshot().inspection.savedViews.length + 1}`);
    if (hostDriven()) return options.onSaveNamedView(name).then(result => ({ name: result?.name ?? name }));
    return viewer.inspection.saveView(name);
  },
  'select-range': () => viewer.select($$('.sequence button').map(button => button.dataset.key)),
};
const actionMessages = {
  fit:'Full molecule fitted in view', 'reset-orientation':'Original viewing direction restored', 'reset-placement':'Molecule position, rotation and scale reset',
  undo:() => `Undo complete · ${representationNames[viewer.snapshot().representation]} · ${describeSelection()} selected`,
  redo:() => `Redo complete · ${representationNames[viewer.snapshot().representation]} · ${describeSelection()} selected`,
  clear:'Selection cleared', focus:() => `Focused ${describeSelection()}`,
  'residue-map':'Cartoon shown with residue colors', ghost:'Transparent surface shown. Select residues to add identity labels.',
  reveal:'Whole molecule shown · opaque, no cutaway or fog',
  'save-view':result => hostDriven() ? `Save sent for “${result?.name ?? 'the view'}”` : `Saved “${viewer.snapshot().inspection.savedViews.at(-1)?.name}” in this tab`,
  'select-range':() => `Selected ${describeSelection()}`,
};
for (const [name, action] of Object.entries(actions)) $(`[data-action="${name}"]`).addEventListener('click', () => {
  if (options.onSceneHistoryAction && (name === 'undo' || name === 'redo')) {
    void requestSceneHistory(name).then(result => setStatus(result?.command ? `${name === 'undo' ? 'Undo' : 'Redo'} requested`
      : `Nothing to ${name}.`)).catch(error => setStatus(error.message, true));
    return;
  }
  void ui(actionMessages[name], action);
});
for (const button of $$('[data-selection]')) button.addEventListener('click', () => ui(button.dataset.selection === 'focus' ? 'Selected residues brought into view' : 'Selection cleared', actions[button.dataset.selection]));
for (const button of $$('[data-tab]')) button.addEventListener('click', () => {
  for (const tab of $$('[data-tab]')) { tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; }
  for (const pane of $$('[data-tools]')) pane.hidden = pane.dataset.tools !== button.dataset.tab;
});
$('.tool-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
  const tabs = $$('[data-tab]'), current = tabs.indexOf(document.activeElement);
  const next = tabs[(current + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; next.click(); next.focus(); event.preventDefault();
});
// Card mode. A host card is a few hundred pixels tall and cannot scroll, so a
// narrow one gives the whole frame to the structure and puts the inspector and
// the sequence over it as sheets the toolbar opens. Nothing here decides how a
// sheet looks; it only records which ones are showing. style.css reads these
// attributes, and above 960 px, where both panels have their own column, it
// ignores them and hides the toggles.
const sheets = { inspector:'inspectorOpen', sequence:'sequenceOpen' };
const sheetOpen = name => $('.workspace').dataset[sheets[name]] === 'true';
function setSheet(name, open) {
  $('.workspace').dataset[sheets[name]] = String(open);
  for (const toggle of $$(`[data-action="toggle-${name}"]`)) toggle.setAttribute('aria-expanded', String(open));
}
function showSheet(name, open) {
  // One sheet at a time by default. Two of them stacked over one stage leaves
  // no structure to look at, which is the thing card mode exists to keep. A
  // journey is the exception below: its words have to stay on screen.
  if (open && $('.workspace').dataset.journey !== 'true')
    for (const other of Object.keys(sheets)) if (other !== name) setSheet(other, false);
  setSheet(name, open);
}
for (const name of Object.keys(sheets)) {
  setSheet(name, false);
  // A press that opens a sheet moves focus into it, so a keyboard reader does
  // not have to tab across the toolbar and the canvas to reach its controls.
  $(`[data-action="toggle-${name}"]`).addEventListener('click', () => {
    const open = !sheetOpen(name);
    showSheet(name, open);
    if (open) $(`[data-action="close-${name}"]`).focus();
  });
  // The sheet is display:none once closed, so focus would fall to the body
  // and the next Tab would restart at the top. Hand it back to the toggle.
  $(`[data-action="close-${name}"]`).addEventListener('click', () => { setSheet(name, false); $(`[data-action="toggle-${name}"]`).focus(); });
}
// Escape closes an open sheet where sheets exist, and hands focus back to the
// toggle that opened it. The header menu handles its own Escape first and
// stops the event, so this never fires while the menu is open.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (!matchMedia('(max-height:760px) and (max-width:959px)').matches) return;
  const open = Object.keys(sheets).find(sheetOpen);
  if (!open) return;
  event.preventDefault();
  setSheet(open, false);
  $(`[data-action="toggle-${open}"]`).focus();
});
// A tour or an experience narrates the structure while it changes it, so its
// panel opens itself and takes the bottom of the frame rather than the right
// edge. The panel is mounted by the host after this workspace is built, and a
// journey can start at any time, so this watches for it rather than asking
// once. Closing the panel afterwards stays the reader's call.
function syncJourneySheet() {
  // A selected tour that has finished keeps data-selected, so the running
  // states are what count here; otherwise the journey layout would stick
  // after the last scene until the tour menu was opened again.
  const journey = document.body.dataset.experienceActive === 'true'
    || !!$('.inspector').querySelector('.tour-player[data-active="true"]:not([hidden]), .tour-player[data-exploring="true"]:not([hidden])');
  if (String(journey) === $('.workspace').dataset.journey) return;
  $('.workspace').dataset.journey = String(journey);
  if (journey) showSheet('inspector', true);
}
if (typeof MutationObserver === 'function') {
  new MutationObserver(syncJourneySheet).observe(document.body, { attributes:true, attributeFilter:['data-experience-active'] });
  new MutationObserver(syncJourneySheet).observe($('.inspector'), { childList:true, subtree:true, attributes:true, attributeFilter:['data-active','data-exploring','hidden'] });
}
syncJourneySheet();

for (const button of $$('.mobile-tabs button')) button.addEventListener('click', () => {
  $('.workspace').dataset.workspace = button.dataset.workspace;
  for (const tab of $$('.mobile-tabs button')) tab.setAttribute('aria-pressed', String(tab === button));
  // Card mode hides these tabs, but a tour still presses them to send a reader
  // to the sequence. Open the matching sheet so the request lands somewhere.
  if (matchMedia('(max-height:760px) and (max-width:959px)').matches) showSheet('sequence', button.dataset.workspace === 'sequence');
});
$('[data-control="chain"]').addEventListener('change', event => { chainValue = event.target.value; renderSequence(); });
$('[data-control="search"]').addEventListener('input', event => { searchValue = event.target.value; renderSequence(); });
$('[data-control="search"]').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); $('[data-action="select-range"]').click(); }
});
moleculeCanvas.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); ui('Molecule fitted', actions.fit); }
  if (event.key === 'Escape') { event.preventDefault(); ui('Selection cleared', actions.clear); }
});

async function loadSource(next, { modelNumber = next.catalog.modelNumbers[0], assemblyId = next.catalog.assemblyId, scene, preserveCamera = false, restorePlacement = false, seatForEntry = false, xrRecoveryFrame } = {}) {
  return run('Structure shown', async () => {
    // XR owns its live camera through headset tracking. A source transition
    // retains the molecule's room anchor in the viewer instead of replaying a
    // desktop camera snapshot into the new source. `seatForEntry` marks a
    // different structure rather than a lesson tier: the room frame stays, but
    // the structure takes the entry seat instead of the outgoing size.
    const preserveRoomPlacement = preserveCamera && viewer.snapshot().ready && viewer.snapshot().xrPresenting;
    const result = await viewer.load(next, { representation: next.id === 'identity_edge' ? 'ball-and-stick' : 'cartoon', modelNumber, assemblyId,
      ...(preserveRoomPlacement ? { preserveRoomPlacement: true, ...(seatForEntry ? { seatForEntry: true } : {}) } : {}) });
    fixture = next; searchValue = ''; chainValue = 'all'; anchor = null; $('[data-control="search"]').value = '';
    // A saved view is valid only for the exact source, model and assembly being drawn.
    if (scene && (scene.sourceSha256 !== next.sha256 || scene.modelNumber !== modelNumber || scene.assemblyId !== assemblyId)) scene = undefined;
    if (scene) await viewer.inspection.restore(scene,{preserveCamera, preservePlacement: preserveRoomPlacement && !restorePlacement,restorePlacement,preservePreviewCamera:restorePlacement,xrRecoveryFrame});
    loadedView = viewer.inspection.capture(); walkthrough = null;
    const displayProvenance = demoSourceIdentity(next.sha256);
    $('.scene-heading h1').replaceChildren(document.createTextNode(displayProvenance ? `${displayProvenance.title} ` : next.title ?? 'Molecular structure '));
    const code = document.createElement('span'); code.className = 'source-code';
    code.textContent = displayProvenance?.pdbId ?? (next.code?.toUpperCase() === 'XXXX' ? '' : next.code ?? '');
    $('.scene-heading h1').append(code);
    const sourceCaption = [next.caption ?? 'SESSION STRUCTURE', displayProvenance?.scope].filter(Boolean).join(' · ');
    const resolvedChains = new Set(currentRows().filter(row => row.atomSites.length)
      .map(row => `${row.identity.copyId}:${row.identity.labelChain}`)).size;
    $('.canvas-caption > span').textContent = options.enableXr === true
      ? `${sourceCaption} · ${resolvedChains} ${resolvedChains === 1 ? 'CHAIN' : 'CHAINS'}` : sourceCaption;
    $('.walkthrough').hidden = next.id !== 'public_1crn';
    renderSequence(); document.body.dataset.ready = 'true'; return result;
  });
}

async function dispose() {
  if (disposed) return disposed;
  closing = true;
  disposed = queue.then(() => viewer.dispose());
  return disposed;
}

if (options.embedded) {
  // A host card has its own frame and title. A badge naming this view again
  // spends header width on something the card already says.
  $('.preview-badge')?.remove();
  $('.footer-note').textContent = `Current view saves to this session · Named views stay in this live session · ${options.onSceneHistoryAction ? 'Undo and Redo follow the shared scene' : 'Undo stays in this tab'}`;
  $('.scene-heading h1').textContent = 'Loading structure…';
  $('.walkthrough').hidden = true;
  $('.canvas-caption > span').textContent = 'WAITING FOR STRUCTURE';
  for (const fact of $$('[data-fact]')) fact.textContent = '—';
  for (const control of $$('#app button, #app input, #app select')) if (!control.dataset.workspace && !control.dataset.tab && !control.dataset.layout
    && !control.matches('[data-enter-xr], [data-resume-xr], [data-leave-xr]')) control.disabled = true;
}
viewer = await createViewer({ canvas:moleculeCanvas, container:$('.stage'), enableInspection:true, enableTestHooks:options.enableTestHooks === true, enableXr:options.enableXr===true,
  // An in-headset toolbar edit is admitted by the same serialized queue as
  // the desktop controls and applyRemote, so a saved scene arriving from the
  // host cannot land inside one.
  runSpatialAction: (_action, apply) => run('Headset control applied', apply),
  onOpenWorkbench: options.onOpenWorkbench,
  ...(options.getSceneHistory && options.onSceneHistoryAction
    ? { getSceneHistory: view => sceneHistory(view), onSceneHistoryAction: requestSceneHistory } : {}),
  // The spoken route to `grow_structure`. Passed straight
  // through because the panel owns the swap — this workspace only renders what
  // comes back on the next hydrate.
  onGrowStructure: options.onGrowStructure,
  onMotionChange: syncMotion,
  onInteraction: interaction => options.onInteraction?.(interaction),
  onSelection: (_keys, snapshot) => { sync(snapshot); setStatus('3D selection shown in sequence'); },
  onMutation: snapshot => { sync(snapshot);
    // A controller pick or shared restore updates an open sequence page only
    // after its molecular mutation rendered, never from the XR frame loop.
    void viewer?.xr?.refreshSequence?.();
    namedPublication.mutation(snapshot); } });
window.addEventListener('pagehide', () => { closing = true; viewer.dispose(); }, { once:true });
sync();
const captureScene = () => { const scene = viewer.inspection.capture(); delete scene.inspection.history; delete scene.inspection.savedViews; return scene; };
return Object.freeze({ viewer, snapshot:() => viewer.snapshot(), setNamedViews, syncSceneHistory, rows:() => structuredClone(currentRows()),
  registerComparisonSources: sources => viewer.inspection.registerComparisonSources(sources),
  identityRows:() => currentRows().map(({key,identity,coordinateState})=>({key,identity:structuredClone(identity),coordinateState})), loadSource, dispose, setStatus,
  // A tour is one admitted workspace action so a queued manual edit cannot
  // land between its visual operations. It uses the same pause and lifecycle
  // rules as the controls above without giving the catalog raw queue access.
  runTour: action => run('Tour scene shown', async () => {
    await viewer.inspection.setMotion({paused:true}); return action();
  }),
  capture:captureScene,
  restore:(scene,options) => run('Saved view restored', () => viewer.inspection.restore(scene,options)),
  // XR head tracking owns the live view. Replaying a shared desktop camera
  // into a presenting session reads as an unexpected head teleport, so the
  // camera stays local whenever this workspace is presenting.
  restoreShared:(scene,admit,preserveCamera,restorePlacement=false,onRestored) => run('Shared view rendered', async()=>{
    const restore = async () => {
      await admit();
      await viewer.inspection.restore(scene,{preserveCamera:preserveCamera===true || viewer.snapshot().xrPresenting===true,restorePlacement});
      // Adopt the peer's cursor before capture and before a queued local edit.
      // Otherwise the old player can publish its chapter over the new scene.
      onRestored?.(scene);
      return captureScene();
    };
    // Peer playback reconciliation owns publication; a renderer mutation must
    // not let the old player write its cursor during the restore transaction.
    return onRestored ? namedPublication.run(restore) : restore();
  }),
  captureNamedView:(admit,confirm) => run('Named view captured', () => namedPublication.run(() => captureNamedView(viewer,admit,confirm)), {publishSettled:false}),
  restoreNamedView:(scene,admit,confirm,namedViewIntent) => run('Named view restored', () => namedPublication.run(() => restoreNamedView(viewer,scene,admit,confirm,namedViewIntent), {publishAfter:true}), {publishSettled:false}),
  applyRemote:(change, admit, confirm, rolledBack, historyOptions = {}) => run('Agent change rendered and saved', () => namedPublication.run(() => interruptibleCommand(viewer,async()=>{
    if(change.kind==='camera' && viewer.snapshot().xrPresenting===true)
      throw Error('This panel is presenting in the headset, where head tracking owns the view. The camera was left alone.');
    await admit();
  },async (rebase) => {
    let replaced=false;
    try { while(true) {
    const previousGeometryBudget = viewer.snapshot().applied?.geometryBudget;
    // What the renderer actually did beyond the scene it leaves behind.
    // The receipt reads render quality and a held-glass placement adjustment.
    let applied;
    // `{recenter:true}` names no numbers, so there is no
    // requested placement for the menu clearance to be measured against.
    const recenter = change.kind === 'placement' && change.patch?.recenter === true;
    const placementPatch = change.kind === 'placement' && !recenter ? change.patch
      : change.kind === 'compound' ? change.patch.ops.find(op => op.kind === 'placement')?.patch : undefined;
    const geometryChange = kind => ['appearance', 'styles', 'companion-structure'].includes(kind);
    const requestedPlacement = placementPatch || geometryChange(change.kind)
      || change.kind === 'compound' && change.patch.ops.some(op => geometryChange(op.kind))
      ? { ...viewer.inspection.capture().inspection.placement, ...placementPatch } : undefined;
    // XR head tracking owns the live view, the same rule restoreShared applies
    // to a shared desktop camera. A pose captured in the Mac's Mol* window and
    // replayed into a presenting session is a head teleport the wearer never
    // asked for, so it is refused before admission rather than half-applied.
    if (change.kind === 'camera' && viewer.snapshot().xrPresenting === true)
      throw Error('This panel is presenting in the headset, where head tracking owns the view. The camera was left alone.');
    const appearanceOptions = patch => Object.hasOwn(patch ?? {}, 'representation')
      ? { ...historyOptions, sceneRepresentation: true } : historyOptions;
    if (change.kind === 'appearance') await viewer.inspection.configure(change.patch, appearanceOptions(change.patch));
    else if (change.kind === 'styles') await viewer.inspection.setStyles(change.patch.styles);
    // The agent's answer to "I can't see it". It is the Reset
    // the wearer's menu row runs, so the two cannot seat the structure apart.
    else if (recenter) {
      if (typeof viewer.inspection.recenter !== 'function') throw Error('This panel cannot recentre the structure.');
      const reset = await viewer.inspection.recenter();
      if (reset?.structureReset !== true || typeof reset.menuReseated !== 'boolean')
        throw Error('The headset did not confirm that Reset finished.');
      applied = { recenterCompletion: { structureReset: true, menuReseated: reset.menuReseated } };
    }
    // Agent patches retain omitted coordinates, matching the host's expected
    // scene. Resolve them after admission, inside this serialized operation.
    // Menu and grip scale controls can still solve their own local clearance.
    else if (change.kind === 'placement') await viewer.inspection.place({
      translation: [...viewer.inspection.capture().inspection.placement.translation], ...change.patch }, 'place', historyOptions);
    else if (change.kind === 'selection') await viewer.select(change.patch.selectionKeys);
    // One command that selects a region and brings it into view.
    // In a headset that is a placement move, not a camera move; on the desktop
    // it is the viewer's own focus. The panel owns which, because only the
    // panel knows whether a wearer is looking through it.
    else if (change.kind === 'focus') await viewer.focusSelection(change.patch);
    // The agent's request to light a named part, which paints the same colour
    // key and focus a lesson chapter does, over whatever the
    // panel is currently showing. A panel too old to have the primitive says so
    // rather than confirming a picture the wearer would not see.
    else if (change.kind === 'emphasis') {
      if (typeof viewer.inspection.emphasize !== 'function') throw Error('This panel cannot emphasise named parts.');
      await viewer.inspection.emphasize(change.patch);
    }
    // The agent's "hide chain B" / "show only the ligand".
    // The change carries the whole hidden set after the edit, so the panel does
    // not have to remember what was hidden before it, and an undo and a named
    // view come back through this same call. A panel too old to have the
    // primitive says so rather than confirming a picture nobody would see.
    else if (change.kind === 'companion-structure') await viewer.inspection.setCompanion(change.patch);
    else if (change.kind === 'visibility') {
      if (typeof viewer.inspection.setVisibility !== 'function') throw Error('This panel cannot hide part of the structure.');
      await viewer.inspection.setVisibility(change.patch);
    }
    // Several edits the person asked for in one breath. One
    // admission, one render, one saved scene, one confirmation, and one undo
    // entry: the ops run inside a single group, and a failure part way through
    // puts the panel back rather than leaving half a picture.
    else if (change.kind === 'compound') {
      if (typeof viewer.inspection.beginOperation !== 'function') throw Error('This panel cannot run several edits as one change.');
      // Stage all seven saved fields before building geometry, so admission
      // measures the final scene and completion waits for one combined frame.
      const staged = typeof viewer.inspection.compound === 'function';
      if (staged) await viewer.inspection.compound(change, change.patch.ops.some(op => op.kind === 'appearance' && Object.hasOwn(op.patch, 'representation'))
        ? { ...historyOptions, sceneRepresentation: true } : historyOptions);
      else await applyCompoundChange(change, {
        appearance: patch => viewer.inspection.configure(patch, appearanceOptions(patch)),
        styles: patch => viewer.inspection.setStyles(patch.styles),
        placement: patch => viewer.inspection.place({
          translation: [...viewer.inspection.capture().inspection.placement.translation], ...patch }, 'place', historyOptions),
        selection: patch => viewer.select(patch.selectionKeys),
        emphasis: patch => {
          if (typeof viewer.inspection.emphasize !== 'function') throw Error('This panel cannot emphasise named parts.');
          return viewer.inspection.emphasize(patch);
        },
        'companion-structure': patch => viewer.inspection.setCompanion(patch),
        visibility: patch => {
          if (typeof viewer.inspection.setVisibility !== 'function') throw Error('This panel cannot hide part of the structure.');
          return viewer.inspection.setVisibility(patch);
        },
      }, {
        begin: () => viewer.inspection.beginOperation('agent-compound'),
        end: () => viewer.inspection.endOperation(),
        rollback: checkpoint => viewer.inspection.rollbackOperation(checkpoint),
      });
    }
    // The agent's "spin it" / "stop", the same explicit target
    // the wearer's spoken command and the menu's Auto-rotate row set.
    else if (change.kind === 'motion') await viewer.inspection.setMotion({ paused: change.patch.state === 'stop' });
    // The agent's answer to "make it look better". The
    // runtime lever belongs to the viewer; until it lands, a panel that cannot
    // change its render budget says so rather than confirming a change the
    // wearer would not see.
    else if (change.kind === 'render-quality') {
      if (typeof viewer.inspection.setRenderQuality !== 'function') throw Error('This panel cannot change its render quality.');
      // The renderer's own answer travels with the receipt.
      // The framebuffer half of `best` cannot touch a live XR layer, so whether
      // it is still pending is the one thing the confirmation must not guess.
      applied = (await viewer.inspection.setRenderQuality(change.patch.level))?.applied;
    }
    else if (change.kind === 'camera') {
      // The only command that moves this panel's viewpoint. It is the same
      // restore the desktop's Load saved view performs: the scene the panel is
      // already showing, with one new pose. Only the pose is taken, matching
      // `cameraPose` in plugin/src/inspection-contract.ts, because scene
      // radius, fog and depth bounds belong to the renderer and the depth
      // controls; taking them here would fail the receipt comparison.
      const current = viewer.inspection.capture();
      delete current.inspection.history; delete current.inspection.savedViews;
      const { mode, fov, position, target, up } = change.patch.camera;
      await viewer.inspection.restore({ ...current, camera: { ...current.camera, mode, fov, position, target, up } });
    }
    else throw Error('Unsupported inspection command.');
    // Preserve the drawn appearance through configure's no-op comparison.
    // Only after it settles may the replacement collapse the undo history.
    if (replaced) rebase();
    const scene = viewer.inspection.capture();
    delete scene.inspection.history; delete scene.inspection.savedViews;
    const drawnPlacement = scene.inspection.placement;
    const placementAdjusted = requestedPlacement && drawnPlacement
      && (drawnPlacement.scale !== requestedPlacement.scale
        || drawnPlacement.translation.some((value, axis) => value !== requestedPlacement.translation[axis]));
    const reportsGeometry = change.kind === 'companion-structure' || change.kind === 'appearance' || change.kind === 'styles' || change.kind === 'render-quality'
      || (change.kind === 'compound' && change.patch.ops.some(op => op.kind === 'appearance' || op.kind === 'styles' || op.kind === 'companion-structure' || op.kind === 'render-quality'));
    const geometryBudget = reportsGeometry ? viewer.snapshot().applied?.geometryBudget : undefined;
    applied = { ...applied, ...(recenter ? { recenterCompletion: { ...applied.recenterCompletion,
      placement: structuredClone(drawnPlacement) } } : {}), ...(geometryBudget ? { geometryBudget, geometryBudgetChanged: geometryBudgetChanged(previousGeometryBudget, geometryBudget) } : {}),
      ...(placementAdjusted ? { placementAdjusted: true, placementFit: viewer.inspection.placementFitEvidence?.() } : {}) };
    const replacement = await confirm(scene, applied);
    if (!replacement) return;
    // The host claimed a full overwrite of the older appearance fields. Keep
    // the queue, original rollback checkpoint and publication until it draws.
    replaced=true;
    await replacement.admit();
    change=replacement.change;confirm=replacement.confirm;historyOptions=replacement.historyOptions ?? {};
    } } catch(error) {
      if(replaced) error.rollbackRequired=true;
      throw error;
    }
  }, rolledBack), {publishAfter:true}), {publishSettled:false}),
});
}
