import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { build } = createRequire(new URL('../../../plugin/package.json', import.meta.url))('esbuild');

// Execute the real toolbar, geometry and coalescer. Only Mol*'s GPU/text
// boundary is replaced; the counters are injected at actual function entries.
const molstar = `
import { count } from 'frame-audit';
export const MeshBuilder = {
  createState: () => ({}), addTriangleWithNormal() {}, getMesh: () => ({}),
};
export const Mesh = { Utils: {} }, Text = { Utils: {} };
export const TextBuilder = { create: () => { const lines = [];
  return { add: text => lines.push(text), getText: () => ({ lines }) }; } };
export const Shape = { create: (name, data, geometry) => ({ name, data, geometry }) };
export const ShapeRepresentation = getShape => {
  count('ShapeRepresentation');
  let shape;
  return { get shape() { return shape; }, renderObjects: [], setState() { count('toolbarRepresentationStateWrites'); }, destroy() {},
    createOrUpdate: (props, data) => ({ async run() {
      count('toolbarRepresentationUpdates');
      shape = await getShape({}, data, props, shape);
    } }) };
};
export const Color = value => value;
export const getFontAtlas = () => ({ buffer: 0, lineHeight: 1, get: () => ({ nw: .6 }) });
`;

const watched = {
  'spatial-toolbar.mjs': ['update', 'syncPose', 'syncInput', 'depthRange', 'structureRoomSphere', 'fullDrawPanel'],
  'spatial-toolbar-geometry.mjs': ['createToolbarPanel', 'toolbarMenuPoints', 'toolbarDrawnMenuPoints', 'toolbarPlateOutline', 'toolbarBackingOutline'],
  'menu-resolve.mjs': ['menuFootprintSignature'],
};

// The production presentation layer can also run against a recording GPU
// boundary. Its room matrices and offset composition remain the real code.
const roomSceneMolstar = `
const cell = value => ({ ref: { value } });
function frameRenderObject() {
  return { type: 'mesh', state: { visible: true }, values: {
    matrix: { kind: 'room-matrix', ref: { value: new Float64Array(16) } },
    aTransform: cell(new Float64Array(16)), invariantBoundingSphere: cell({ center: [0,0,0], radius: 1 }),
    boundingSphere: cell({ center: [0,0,0], radius: 1 }), instanceCount: cell(1), instanceGrid: cell({}) } };
}
export const Scene = { create: () => {
  const objects = new Set();
  return { get count() { return objects.size; }, add: object => objects.add(object),
    remove: object => objects.delete(object), clear: () => objects.clear(), commit() {}, syncVisibility() {},
    update() { count('roomSceneUpdates'); } };
} };
export const ValueCell = {
  update(cell, value) { if (cell.kind === 'room-matrix') count('roomMatrixWrites'); cell.ref.value = value; return cell; },
  updateIfChanged(cell, value) { if (cell.ref.value !== value) cell.ref.value = value; return cell; },
};
export const updateTransformData = values => values.aTransform.ref.value.set(values.matrix.ref.value);
export const calculateTransformBoundingSphere = () => ({ center: [0,0,0], radius: 1 });
`;

export async function toolbarFrameRuntime(directory = new URL('../', import.meta.url), { resolver = true, instrumentTimers = false, glyphAdvances, peripheralSeat, roomScene = false } = {}) {
  const root = fileURLToPath(directory);
  const sessionSource = await readFile(new URL('immersive-session.mjs', directory), 'utf8');
  const frameErrorStart = sessionSource.indexOf('function recordXrFrameError(');
  const observerStart = sessionSource.indexOf('function installHeadFrameObserver(');
  assert.ok(frameErrorStart >= 0);
  assert.ok(observerStart >= 0);
  const frameError = sessionSource.slice(frameErrorStart, observerStart);
  const observer = sessionSource.slice(observerStart, sessionSource.indexOf('\n}', observerStart) + 2);
  const headCallback = sessionSource.slice(sessionSource.indexOf('record.headObserver ='))
    .match(/onHeadFrame: context => \{([\s\S]*?)\n        \} \}\);/);
  const inputCallback = sessionSource.slice(sessionSource.indexOf('record.headObserver ='))
    .match(/onInputFrame: context => \{([\s\S]*?)\n        \}, onHeadFrame:/);
  assert.ok(headCallback, 'use the production frame callback');
  const built = await build({
    stdin: { contents: `export * from './spatial-toolbar.mjs';
      export * from './talk-caption.mjs';
      ${roomScene ? "export { createPresentationScene } from './presentation-scene.mjs';" : ''}
      ${resolver ? "export * from './menu-resolve.mjs';" : ''}
      export { counts, count, reset, setTimers } from 'frame-audit';
      export function installFrameProbe(record, session, space, onHeadFrame = () => {}, onInputFrame = () => {}) {
        let frameCount = 0, viewCount = 0, errorName;
        ${frameError}
        ${observer}
        return installHeadFrameObserver({ session, space, mode: 'immersive-vr',
          ${inputCallback ? `onInputFrame: context => { ${inputCallback[1]}\n },` : ''}
          onHeadFrame: context => { ${headCallback[1]}\n } });
      }`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'toolbar-frame-audit', setup(api) {
      api.onResolve({ filter: /^(molstar\/|frame-audit$)/ }, args => ({ path: args.path, namespace: 'frame-audit' }));
      api.onLoad({ filter: /.*/, namespace: 'frame-audit' }, args => ({ contents: args.path === 'frame-audit'
        ? `export const counts = {}; export const count = name => { counts[name] = (counts[name] ?? 0) + 1; };
           export const reset = () => { for (const key of Object.keys(counts)) delete counts[key]; };
           let timers = globalThis;
           export const setTimers = value => { timers = value; };
           export const auditSetTimeout = (...args) => timers.setTimeout(...args);
           export const auditClearTimeout = (...args) => timers.clearTimeout(...args);
           export const auditSetInterval = (...args) => timers.setInterval(...args);
           export const auditClearInterval = (...args) => timers.clearInterval(...args);`
        : (glyphAdvances ? molstar.replace('get: () => ({ nw: .6 })', `get: char => ({ nw: (${JSON.stringify(glyphAdvances)})[char] ?? .6 })`) : molstar)
          .replace('renderObjects: [],', roomScene ? 'renderObjects: [frameRenderObject()],' : 'renderObjects: [],')
          + (roomScene ? roomSceneMolstar : '') }));
      api.onLoad({ filter: /\.mjs$/ }, async args => {
        const names = watched[args.path.split('/').at(-1)];
        if (!names && !instrumentTimers) return undefined;
        let contents = await readFile(args.path, 'utf8');
        // Historical captured overlaps must retain their original forward-seat
        // geometry. Default tests continue to exercise the shipped peripheral seat.
        if (args.path.endsWith('/spatial-toolbar-geometry.mjs') && peripheralSeat === false) {
          assert.match(contents, /peripheralSeat: true,/u);
          contents = contents.replace('peripheralSeat: true,', 'peripheralSeat: false,');
        }
        for (const name of names ?? []) {
          // Single-line signatures; assert matches so a refactor cannot silently
          // turn a zero-call result into an uninstrumented function.
          const entry = new RegExp(`(^\\s*(?:export )?(?:async )?function ${name}\\([^\\n]*\\{\\n)`, 'm');
          if (name === 'toolbarDrawnMenuPoints' && !contents.includes(`function ${name}(`)) continue;
          assert.match(contents, entry, `instrument ${name}`);
          contents = contents.replace(entry, `$1    frameAuditCount('${name}');\n`);
        }
        const timerImports = instrumentTimers
          ? `import { auditSetTimeout as setTimeout, auditClearTimeout as clearTimeout,
              auditSetInterval as setInterval, auditClearInterval as clearInterval } from 'frame-audit';` : '';
        return { contents: `import { count as frameAuditCount } from 'frame-audit';\n${timerImports}\n${contents}` };
      });
    } }],
  });
  const runtime = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
  runtime.reset();
  return runtime;
}

export const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function toolbarFrameHarness(runtime, { state = {}, bounds = { center: [0, 0, -1], radius: .1 }, onRepresentationChange = () => {}, onAction = async () => {}, onConsumeSelect = () => {}, presentation = {}, getEntryGeometry = () => ({}),
  // The toolbar's own clock, for a test that watches the title line's
  // reading window close. Omitted, the toolbar reads `performance.now()`.
  now, runTask = task => task.run() } = {}) {
  let x = 0, depth = {}, frameTime = 0;
  const frame = {
    getViewerPose: () => ({ transform: { position: { x, y: 1.6, z: 0 }, matrix: identity },
      views: [{ transform: { inverse: { matrix: identity } } }, { transform: { inverse: { matrix: identity } } }] }),
    getPose: space => space?.pose,
  };
  const session = Object.assign(new EventTarget(), { inputSources: [],
    requestAnimationFrame(callback) { queueMicrotask(() => callback(++frameTime, frame)); return 1; },
    cancelAnimationFrame() {},
  });
  const toolbar = runtime.createSpatialToolbar({
    plugin: { runTask }, canvas: {}, session, space: {}, Mat4: {},
    presentation: { add() {}, remove() {}, update() {}, setVisible() {}, roomMatrix: () => identity, ...presentation },
    getEntryGeometry,
    getMolecularBounds: () => { runtime.count('molecularBounds'); return bounds; },
    getDepthRange: () => { runtime.count('getDepthRange'); return depth; }, getState: () => state, onRepresentationChange, onAction, onConsumeSelect,
    ...(now ? { now } : {}),
  });
  return { toolbar, frame, session, moveHead: value => { x = value; },
    setDepth: value => { depth = value; }, setState: value => { state = value; },
    setBounds: value => { bounds = value; },
    async frames(count = 72) {
      // Event setup is driven separately. During the steady replay, dispatch
      // through the session's actual observer and toolbar frame callback.
      const observer = runtime.installFrameProbe({ toolbar }, session, {});
      try {
        for (let index = 0; index < count; index++) {
          await new Promise(resolve => session.requestAnimationFrame((_time, xrFrame) => {
            toolbar.depthRange(xrFrame);
            resolve();
          }));
        }
      } finally { observer.restore(); }
    } };
}
