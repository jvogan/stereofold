import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createComponentLabelSession, planComponentLabels, componentPlateName } from './component-labels.mjs';
import { createLessonResting, platesWanted } from './lesson-resting.mjs';
import { normalizeEmphasisState, planLessonEmphasis, DEFAULT_CONTEXT_OPACITY } from './lesson-emphasis.mjs';
import { plateLayoutKey, reusablePlateLayout, layoutComponentPlates, screenRectFromPoints, wrapPlateText, PLATE_FIELD } from './label-layout.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
// Execute the viewer's actual scene/emphasis and layout wiring. Only Mol*'s
// paint and cell creation are replaced; plate policy and the solver are real.
const viewerFunction = name => {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
const demo = JSON.parse(readFileSync(new URL('../../plugin/demos/telomerase-haca.json', import.meta.url)));

test('all five shipped telomerase scenes retain ten named plates and record a scene solve', async () => {
  const records = [], cells = new Map();
  let status = 'Tour started.', outcome = 'Tour started.';
  const dependencies = { createComponentLabelSession, planComponentLabels, createLessonResting, platesWanted,
    normalizeEmphasisState, planLessonEmphasis, DEFAULT_CONTEXT_OPACITY, stylesState: [],
    plateLayoutKey, reusablePlateLayout, layoutComponentPlates, screenRectFromPoints, wrapPlateText, PLATE_FIELD, componentPlateName,
    records, cells, clearStatus: () => { status = ''; }, clearOutcome: () => { outcome = ''; },
    paint: () => { assert.equal(status, ''); assert.equal(outcome, ''); },
  };
  const h = new Function(...Object.keys(dependencies), `
    let emphasisState = { parts: [], focus: [], contextOpacity: 0.18 }, emphasisOrigin = 'resting';
    let componentLabelBuildSignature = null, componentLabelLayoutCache = null;
    const structure = { ref: 'structure' }, volume = null;
    const selection = { rows: [] };
    const spokenSelectionKeys = ({ chain }) => [chain];
    const paintedContextOpacity = value => value;
    const assertReady = () => {}, recordEmphasisResolution = () => {}, recordManipulation = () => {};
    const snapshot = () => ({}), lessonKey = { remember() {} };
    const talkCaption = { set: clearOutcome }, immersiveSession = { clearStatus };
    const mutate = async (_kind, apply) => apply(), paintEmphasisLayers = paint;
    const paintVisibilityLayers = async () => {};
    const canvas = { camera: { getSnapshot: () => ({ position: [0, 0, 100], target: [0, 0, 0], up: [0, 1, 0] }) } };
    let menuResolveReason = null;
    const latestRoomPlacementPose = null;
    const latestPlateSeat = null, componentLabelTextWidth = text => text.length * 0.6;
    const recordCost = (kind, detail) => records.push({ kind, ...detail });
    const COMPONENT_LABEL_LIMIT = 10;
    // Nothing is hidden in this tour, and the plate rule reads
    // the hidden set to drop a name for a part that is entirely off the screen.
    const hiddenSceneKeySet = () => new Set();
    ${['currentEmphasisPlan', 'componentLabelKeyPlan', 'componentLabelPlateParts', 'componentLabelsWanted',
      'componentLabelPartsSignature',
      'rebuildComponentLabels', 'componentLabelViewBasis', 'componentLabelLayout', 'emphasize'].map(viewerFunction).join('\n')}
    const componentLabels = createComponentLabelSession({
      isPresenting: () => true, wantsLabels: componentLabelsWanted,
      deletePlates: async refs => refs.forEach(ref => cells.delete(ref)),
      buildPlates: async ({ reason }) => {
        const plan = currentEmphasisPlan();
        const drawable = componentLabelPlateParts(plan).map((part, i) => ({ ...part,
          text: componentPlateName(emphasisState.parts.find(p => p.id === part.id).label),
          anchor: [(i % 5 - 2) * 3, (Math.floor(i / 5) - 0.5) * 6, 0], radius: 1 }));
        componentLabelLayout(drawable, { characterUnits: 1, minSizeScale: 0.6 }, plan, null, reason);
        for (const part of drawable) cells.set(part.id, part.text);
        return drawable.map(part => part.id);
      },
    });
    const lessonResting = createLessonResting({ emphasize, snapshot,
      rebuildLabels: rebuildComponentLabels, getEmphasis: () => emphasisState, getOrigin: () => emphasisOrigin });
    return { emphasize, lessonResting, componentLabels };
  `)(...Object.values(dependencies));
  // Resting paints are not scene boundaries, so reset the test receipt here.
  status = outcome = '';
  await h.lessonResting.install({ emphasis: demo.chapters[0].immersive.emphasis, componentLabels: true });
  for (const chapter of demo.chapters) {
    status = outcome = 'Tour started.';
    // Cached scene appearance does not carry the transient componentLabels
    // flag. The installed lesson still owns its names on this path.
    h.lessonResting.setLabelsEnabled(false);
    const before = records.length;
    await h.emphasize({ ...chapter.immersive.emphasis, framing: undefined, origin: 'lesson' });
    assert.equal(h.componentLabels.refs().length, 10, chapter.id);
    assert.deepEqual([...cells.values()].sort(), ['Dyskerin 1', 'Dyskerin 2', 'NOP10 1', 'NOP10 2',
      'NHP2 1', 'NHP2 2', 'GAR1 1', 'GAR1 2', 'TCAB1', 'Telomerase RNA H/ACA'].sort());
    assert.deepEqual([...cells].sort(), chapter.immersive.emphasis.parts
      .map(part => [part.id, componentPlateName(part.label)]).sort(), chapter.id);
    const layouts = records.slice(before).filter(row => row.kind === 'component-label-layout');
    assert.equal(layouts.length, 0, `${chapter.id} reuses the committed plate layout`);
  }
  assert.equal(demo.presentation.captionCard, 'hidden');
});
