import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { applyScopedStyle } from './inspection-styles.mjs';
import { requireSceneGeometryBudget } from './representation-budget.mjs';
import { tourEndHarness } from './fixtures/tour-end-harness.mjs';
import { journeyNavigationHarness } from './fixtures/journey-navigation-harness.mjs';

const require = createRequire(new URL('../../plugin/package.json', import.meta.url));
const { tsImport } = require('tsx/esm/api');
const { transpileModule, ScriptTarget, ModuleKind } = require('typescript');
const { extractInspectionCatalogBytes } = await tsImport('../../plugin/src/inspection-catalog.ts', import.meta.url);
const { experienceGeometry } = await tsImport('../../plugin/src/experience-budget.ts', import.meta.url);
const { experienceById } = await tsImport('../../plugin/src/molecular-experience.ts', import.meta.url);
const { mountExperiencePlayer } = await tsImport('../../plugin/src/experience-player.ts', import.meta.url);
const source = readFileSync(new URL('../../plugin/src/inspector.ts', import.meta.url), 'utf8');
const begin = source.indexOf('placeExperienceStep:async()=>{');
const end = source.indexOf('      }}:{}),', begin);
assert.ok(begin >= 0 && end > begin, 'execute the shipped chapter placement');
const chapterBody = transpileModule(source.slice(begin + 'placeExperienceStep:async()=>{'.length, end),
  { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText;

test('Quest 2: 4HHB host chain A and HEM styles do not follow the journey; Done restores them', async () => {
  const h = tourEndHarness();
  const definition = experienceById('hemoglobin-quaternary-structure');
  const cif = readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
  const catalog = await extractInspectionCatalogBytes(cif, { assemblyId: 'asymmetric_unit' });
  const counts = await experienceGeometry(cif, definition.stages[0]);
  const chainA = catalog.rows.filter(row => row.identity.labelChain === 'A');
  const heme = catalog.rows.filter(row => row.identity.componentId === 'HEM');
  assert.ok(chainA.length && heme.length);
  const keys = rows => rows.map(row => row.key);
  let scene = { appearance: { representation: 'cartoon', color: 'chain-id' }, styles: [], selectionKeys: [] };
  scene.styles = applyScopedStyle(scene.styles, keys(chainA), { color: 'uniform', uniformColor: '#ff8800' });
  scene.styles = applyScopedStyle(scene.styles, keys(heme), { representation: 'ball-and-stick' });
  const original = structuredClone(scene);
  const geometry = (candidate) => {
    const entries = [{ representation: candidate.appearance.representation, ...counts },
      ...candidate.styles.map(style => {
        const rows = catalog.rows.filter(row => style.selectionKeys.includes(row.key));
        const atoms = rows.reduce((sum, row) => sum + row.atomSites.length, 0);
        return { representation: style.representation ?? candidate.appearance.representation,
          atoms, bonds: Math.ceil(atoms * counts.bonds / counts.atoms), residues: rows.length };
      })];
    return requireSceneGeometryBudget(entries, { deviceClass: 'quest2', presenting: true, quality: 'lowest' });
  };
  assert.doesNotThrow(() => geometry(scene), 'the host edit fits on Quest 2');
  const workspace = { viewer: { inspection: {
    styles: () => scene.styles,
    configure: async patch => { const next = { ...scene, appearance: { ...scene.appearance, ...patch } }; geometry(next); scene = next; },
    compound: async change => {
      const next = structuredClone(scene);
      for (const op of change.patch.ops) {
        if (op.kind === 'styles') next.styles = op.patch.styles;
        if (op.kind === 'appearance') next.appearance = { ...next.appearance, ...op.patch };
      }
      geometry(next); scene = next;
    },
  }, select: async selection => { scene.selectionKeys = [...selection]; } },
    identityRows: () => catalog.rows };
  const place = async stepIndex => {
    const placedStep = definition.steps[stepIndex];
    const stage = definition.stages.find(item => item.id === placedStep.stageId);
    const signal = { throwIfAborted() {} };
    await vm.runInNewContext(`(async()=>{${chapterBody}})()`, { workspace, placedStep, stage, signal, Set });
  };
  let player;
  try {
    const create = document.createElement.bind(document);
    document.createElement = (...args) => Object.assign(create(...args), { querySelectorAll: () => [], remove() {} });
    document.removeEventListener = () => {};
    player = mountExperiencePlayer({ after: h.after, explore() {},
      navigate: async (_id, index) => {
        await place(index);
        player.update({ definition, revision: index + 1, stepIndex: index,
          stageId: definition.steps[index].stageId, sourceKey: '4HHB:asymmetric_unit' });
      },
      finish: async () => { scene = structuredClone(original); return { status: 'rendered' }; },
    });
    player.setCatalog([{ id: definition.id, title: definition.title, steps: definition.steps.length }]);
    await player.select(definition.id);
    await player.start();
    assert.equal(player.getState().step, 0);
    await player.next();
    assert.equal(player.getState().step, 1);
    assert.equal(scene.styles.length, 0, 'the authored chapter owns its style layers');
    for (let index = 2; index < definition.steps.length; index++) await player.next();
    await player.finish('done');
    assert.deepEqual(scene, original, 'Done restores the exact host-styled pre-tour scene');
  } finally { player?.dispose(); h.cleanup(); }
});

test('a chapter that cannot fit gives the wearer one short sentence after rollback', async () => {
  let hydrations = 0, navigations = 0;
  const context = journeyNavigationHarness({
    hydrate: async () => {
      if (++hydrations === 1) throw Error('Both structures and their style layers together exceed the headset geometry budget at lowest detail. Choose a cheaper representation or smaller selection.');
      return { status: 'rendered' };
    },
    call: async (name, args) => {
      if (name === 'poll_inspection') return { structuredContent: { attached: true, sourceToken: args.sourceToken,
        stateRevision: args.baseStateRevision, inspectionRevision: args.baseInspectionRevision } };
      if (name === 'get_inspection') return { _meta: { private: { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1,
        inspectionRevision: 1, experience: { revision: 1 } } } };
      if (name === 'navigate_experience') return { structuredContent: { experienceTransition: ++navigations === 1
        ? { rollbackToken: 'rollback' } : { restored: true } } };
      throw Error(`Unexpected ${name}`);
    },
  });
  await assert.rejects(context.navigateExperience('hemoglobin-quaternary-structure', 1),
    { message: 'This chapter is too detailed for this headset; your previous view is back.' });
  assert.equal(hydrations, 2);
  assert.equal(navigations, 2);
});

test('host chapter preflight also keeps vertex accounting out of the wearer response', async () => {
  const context = journeyNavigationHarness({
    call: async (name, args) => {
      if (name === 'poll_inspection') return { structuredContent: { attached: true, sourceToken: args.sourceToken,
        stateRevision: args.baseStateRevision, inspectionRevision: args.baseInspectionRevision } };
      if (name === 'navigate_experience') throw Error('Chapter 2 refused: 4779 atoms in ball-and-stick exceed the 260000-vertex headset limit at lowest detail. Staying on the current chapter.');
      throw Error(`Unexpected ${name}`);
    },
  });
  await assert.rejects(context.navigateExperience('hemoglobin-quaternary-structure', 1),
    { message: 'This chapter is too detailed for this headset.' });
});
