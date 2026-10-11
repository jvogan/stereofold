import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLessonResting } from '../lesson-resting.mjs';
import { createDiagnosticsBuffer } from '../headset-diagnostics.mjs';

// Source player DOM boundary, with real viewer release/Done closures and the
// same resting-key owner used by the live page. GPU and saved-scene I/O only
// are adapted; the player, authored dwell and diagnostics producer are real.
export function tourEndHarness({ xr = true } = {}) {
  const globals = { document: globalThis.document, window: globalThis.window,
    __stereofoldDiagnostics: globalThis.__stereofoldDiagnostics };
  const elements = new Map();
  const element = () => ({ dataset: {}, value: '1', textContent: '',
    setAttribute() {}, removeAttribute() {}, append() {}, replaceChildren() {},
    after() {}, focus() {}, addEventListener() {},
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    } });
  globalThis.document = { createElement: element, body: { dataset: {} }, hidden: false, addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  const records = createDiagnosticsBuffer();
  globalThis.__stereofoldDiagnostics = records;
  let painted = { parts: [], origin: 'resting' }, appearance = {}, placement = { scale: 1 };
  const restores = [], spoken = [], statuses = [];
  const capture = () => structuredClone({ painted, appearance, placement });
  const snapshot = () => ({ ready: true, sourceSha256: 'same', xrPresenting: xr,
    inspection: { appearance, placement } });
  const emphasize = async value => { painted = structuredClone(value); };
  const lessonResting = createLessonResting({ emphasize, snapshot,
    rebuildLabels: async () => {}, getEmphasis: () => painted, getOrigin: () => painted.origin });
  const source = readFileSync(new URL('../viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  async function clearLessonEmphasis(');
  const context = vm.createContext({ lessonResting });
  vm.runInContext(source.slice(start, source.indexOf('\n  }', start) + 4), context);
  const workspace = { snapshot, capture, rows: () => [], runTour: async action => action(),
    setStatus: line => statuses.push(line), viewer: { select: async () => {}, focus: async () => {}, inspection: {
      configure: async patch => { appearance = { ...appearance, ...patch }; },
      place: async patch => { placement = { ...placement, ...patch }; },
      emphasize, clearLessonEmphasis: context.clearLessonEmphasis,
      setMotion: async () => {}, fit: async () => {}, resetOrientation: async () => {},
      orbit: async () => {}, dolly: async () => {},
      restore: async (saved, options) => {
        restores.push(options);
        ({ painted, appearance, placement } = structuredClone(saved));
        painted.origin = lessonResting.noteRestoredKey(painted, painted.origin) ?? painted.origin;
      },
    } } };
  // Include the old no-op at the tip as well: this is a behavioral regression,
  // not a source-string assertion requiring the new handler to exist.
  const doneStart = source.indexOf("        if (action.kind === 'tour-done')");
  const doneEnd = source.indexOf("        if (action.kind === 'tour-menu')", doneStart);
  assert.ok(doneStart >= 0 && doneEnd > doneStart);
  const dispatchDone = player => vm.runInNewContext(
    `(async () => { ${source.slice(doneStart, doneEnd)} })()`,
    { action: { kind: 'tour-done' }, spatialTour: player });
  return { workspace, after: element(), records, restores, spoken, statuses, capture,
    aside: line => spoken.push(line), dispatchDone,
    install: tour => lessonResting.install({ emphasis: tour.steps[0]?.emphasis,
      componentLabels: tour.steps[0]?.appearance?.componentLabels === true }),
    cleanup() { Object.assign(globalThis, globals); },
  };
}
