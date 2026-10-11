import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findLiveStructureRepresentation, isStereofoldAuxiliaryCell, liveEmphasisTargets,
  STEREOFOLD_AUXILIARY_TAGS } from './representation-refs.mjs';

const INSPECTION = new Set(['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill']);
const isInspection = name => INSPECTION.has(name);

test('layered lesson figures cannot replace the main representation on the next chapter', () => {
  const figure = representationEntry('figure-kras', 'cartoon', ['stereofold-lesson-figure']);
  const hierarchy = [{ components: [componentEntry('figure-component', ['stereofold-lesson-figure'], [figure])],
    genericRepresentations: [representationEntry('base-cartoon', 'cartoon')] }];
  assert.equal(findLiveStructureRepresentation(hierarchy, isInspection), undefined);
  hierarchy[0].components[0].cell.transform.tags = [];
  assert.equal(findLiveStructureRepresentation(hierarchy, isInspection), undefined);
});

/** A hierarchy representation entry shaped like Mol*'s StructureRepresentationRef. */
function representationEntry(ref, type, tags = []) {
  return { cell: { transform: { ref, tags }, status: 'ok', params: { values: { type: { name: type } } },
    obj: { data: { repr: { state: { visible: true }, renderObjects: [{}] } } } } };
}

function componentEntry(ref, tags, representations) {
  return { cell: { transform: { ref, tags }, status: 'ok' }, representations };
}

test('the wall chapter 5 failure: a ligand overlay is not the molecule', async t => {
  // The wall stage has no visibility restriction, so the viewer adds the
  // molecule's own representation to the STRUCTURE cell. Mol* files that under
  // `genericRepresentations`, which this scan never walks. The only component
  // under the structure was the ligand overlay chapter 4 had just built, drawn
  // as `spacefill`.
  const overlay = representationEntry('yEw1bmA1hVpstsCEqyENWg', 'spacefill', ['stereofold-ligand-overlay']);
  const hierarchy = [{
    components: [componentEntry('overlay-component',
      ['stereofold-ligand-overlay', 'structure-component-stereofold-ligand-overlay'], [overlay])],
    genericRepresentations: [representationEntry('molecule-representation', 'cartoon')],
  }];

  await t.test('the overlay is never returned as the live representation', () => {
    assert.equal(findLiveStructureRepresentation(hierarchy, isInspection), undefined);
  });

  await t.test('the pre-fix scan returned exactly the ref that killed the chapter', () => {
    // The rule as it stood, kept here so the reproduction cannot rot: the scan
    // walked components only and asked nothing about whose component it was.
    const before = (structures) => {
      for (const root of structures) {
        for (const component of root.components ?? []) {
          for (const candidate of component.representations ?? []) {
            const params = candidate.cell?.params?.values;
            const repr = candidate.cell?.obj?.data?.repr;
            if (candidate.cell?.status !== 'ok' || !repr?.state?.visible || !repr.renderObjects?.length) continue;
            if (INSPECTION.has(params?.type?.name)) return candidate;
          }
        }
      }
      return undefined;
    };
    assert.equal(before(hierarchy)?.cell.transform.ref, 'yEw1bmA1hVpstsCEqyENWg');
  });

  await t.test('and the chapter then painted onto the ref it had just deleted', () => {
    // The rest of the chain, at the paint. `representation` is the hijacked
    // overlay ref; the appearance has already deleted the overlay component.
    const live = new Map([['molecule-representation', {}]]);
    const { targets, missing } = liveEmphasisTargets(
      [{ repr: { ref: 'yEw1bmA1hVpstsCEqyENWg' }, suffix: '' }], ref => live.has(ref));
    assert.deepEqual(targets, []);
    assert.deepEqual(missing, ['structure']);
  });
});

test('a real component representation is still found', () => {
  const wanted = representationEntry('stage-cartoon', 'cartoon');
  const hierarchy = [{
    components: [
      componentEntry('experience-visible', ['structure-component-experience-visible'], [wanted]),
      componentEntry('overlay-component', ['stereofold-ligand-overlay'],
        [representationEntry('overlay-spacefill', 'spacefill', ['stereofold-ligand-overlay'])]),
    ],
  }];
  assert.equal(findLiveStructureRepresentation(hierarchy, isInspection)?.cell.transform.ref, 'stage-cartoon');
});

test('an auxiliary representation under a plain component is skipped too', () => {
  // The tag lives on the representation as well as the component, and either
  // one is enough: a stock Mol* action can reparent the representation.
  const hierarchy = [{
    components: [componentEntry('some-component', [], [
      representationEntry('overlay-spacefill', 'spacefill', ['stereofold-ligand-overlay']),
      representationEntry('stage-cartoon', 'cartoon'),
    ])],
  }];
  assert.equal(findLiveStructureRepresentation(hierarchy, isInspection)?.cell.transform.ref, 'stage-cartoon');
});

test('labels were never a candidate and still are not', () => {
  const hierarchy = [{
    components: [componentEntry('labels-component', ['stereofold-inspection-labels'],
      [representationEntry('labels', 'label', ['stereofold-inspection-selected-labels'])])],
  }];
  assert.equal(findLiveStructureRepresentation(hierarchy, isInspection), undefined);
});

test('an empty, absent or malformed hierarchy answers undefined', () => {
  assert.equal(findLiveStructureRepresentation(undefined, isInspection), undefined);
  assert.equal(findLiveStructureRepresentation([], isInspection), undefined);
  assert.equal(findLiveStructureRepresentation([{}], isInspection), undefined);
  assert.equal(findLiveStructureRepresentation([{ components: [{}] }], isInspection), undefined);
  assert.equal(findLiveStructureRepresentation([{ components: [componentEntry('c', [], [{}])] }], isInspection), undefined);
});

test('a hidden, empty or failed representation is not the live one', () => {
  const hidden = representationEntry('a', 'cartoon');
  hidden.cell.obj.data.repr.state.visible = false;
  const empty = representationEntry('b', 'cartoon');
  empty.cell.obj.data.repr.renderObjects = [];
  const failed = representationEntry('c', 'cartoon');
  failed.cell.status = 'error';
  for (const entry of [hidden, empty, failed]) {
    assert.equal(findLiveStructureRepresentation([{ components: [componentEntry('x', [], [entry])] }], isInspection),
      undefined);
  }
});

test('isStereofoldAuxiliaryCell reads both the bare tag and the component key', () => {
  for (const tag of STEREOFOLD_AUXILIARY_TAGS) {
    assert.equal(isStereofoldAuxiliaryCell({ transform: { tags: [tag] } }), true);
    assert.equal(isStereofoldAuxiliaryCell({ transform: { tags: [`structure-component-${tag}`] } }), true);
    assert.equal(isStereofoldAuxiliaryCell({ transform: { tags: tag } }), true, 'a single tag may be a bare string');
  }
  assert.equal(isStereofoldAuxiliaryCell({ transform: { tags: ['structure-component-polymer'] } }), false);
  assert.equal(isStereofoldAuxiliaryCell({ transform: {} }), false);
  assert.equal(isStereofoldAuxiliaryCell(undefined), false);
});

test('liveEmphasisTargets keeps every target whose cell survives', () => {
  const live = new Map([['structure-repr', {}], ['overlay-repr', {}]]);
  const all = [{ repr: { ref: 'structure-repr' }, suffix: '' }, { repr: { ref: 'overlay-repr' }, suffix: '-ligand' }];
  const kept = liveEmphasisTargets(all, ref => live.has(ref));
  assert.deepEqual(kept.targets, all);
  assert.deepEqual(kept.missing, []);
});

test('liveEmphasisTargets drops only the dead target and names it', () => {
  const live = new Map([['structure-repr', {}]]);
  const { targets, missing } = liveEmphasisTargets(
    [{ repr: { ref: 'structure-repr' }, suffix: '' }, { repr: { ref: 'overlay-repr' }, suffix: '-ligand' }],
    ref => live.has(ref));
  assert.deepEqual(targets.map(target => target.suffix), ['']);
  assert.deepEqual(missing, ['-ligand']);
});

test('a target with no ref at all is dropped rather than handed to the builder', () => {
  const { targets, missing } = liveEmphasisTargets([{ repr: undefined, suffix: '' }, { suffix: '-ligand' }], () => true);
  assert.deepEqual(targets, []);
  assert.deepEqual(missing, ['structure', '-ligand']);
  assert.deepEqual(liveEmphasisTargets(undefined, () => true), { targets: [], missing: [] });
});

// ---------------------------------------------------------------------------
// The viewer holds these rules; these read its source so the wiring cannot be
// undone without the reason showing up in a failing test.
// ---------------------------------------------------------------------------
const viewerSource = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');

test('the viewer asks this module which representation is the molecule', () => {
  const scan = viewerSource.slice(viewerSource.indexOf('function findCurrentStructureRepresentation'),
    viewerSource.indexOf('function asViewerRepresentation'));
  assert.match(scan, /findLiveStructureRepresentation\(/u);
  // Never a second copy of the walk: that copy is what could not know the
  // ligand overlay was not the molecule.
  assert.ok(!/root\.components/u.test(scan), 'The viewer still walks the component hierarchy itself.');
});

test('the emphasis paint is addressed only to refs the state tree still has', () => {
  const paint = viewerSource.slice(viewerSource.indexOf('async function paintEmphasisLayers'),
    viewerSource.indexOf('function currentEmphasisPlan'));
  assert.match(paint, /dropDeadOverlayRefs\(\)/u);
  assert.match(paint, /liveEmphasisTargets\(/u);
  assert.match(paint, /plugin\.state\.data\.cells\.get\(ref\)/u);
  // New decorators target a surviving representation. A reused decorator has
  // its own ref, guarded by both the live cell and its current representation.
  for (const match of paint.matchAll(/plugin\.build\(\)\.to\(([^)]*)\)/gu)) {
    assert.ok(['repr.ref', 'ref'].includes(match[1]), `paintEmphasisLayers addresses ${match[1]}, which the filter does not cover.`);
  }
  assert.match(paint, /const cell = plugin\.state\.data\.cells\.get\(ref\)/u);
  assert.match(paint, /const reusable = cell\?\.status === 'ok'[\s\S]*?decorator\?\.repr === live/u);
  assert.match(paint, /if \(layers\.length && reusable\) \{\s*await plugin\.build\(\)\.to\(ref\)\.update/u);
  // A lost representation is a recorded loss, not a silent one: there is no
  // console in a headset.
  assert.match(paint, /recordCost\('emphasis-target-missing'/u);
});

test('a torn-down overlay is forgotten before it is reused or counted', () => {
  const drop = viewerSource.slice(viewerSource.indexOf('function dropDeadOverlayRefs'),
    viewerSource.indexOf('async function removeLigandOverlay'));
  assert.match(drop, /ligandOverlay = undefined/u);
  assert.match(drop, /inspectionLabel = undefined/u);
  // And the rebuild starts from it, so `scientificRepresentationCount` — the
  // render wait's strict equality — never counts a representation that is gone.
  const rebuild = viewerSource.slice(viewerSource.indexOf('async function rebuildLigandOverlay'),
    viewerSource.indexOf('function canRebuildForXr'));
  assert.match(rebuild, /dropDeadOverlayRefs\(\)/u);
});

test('the representation count ignores an overlay whose cell is gone', () => {
  const count = viewerSource.slice(viewerSource.indexOf('function scientificRepresentationCount'),
    viewerSource.indexOf('function dropDeadOverlayRefs'));
  assert.match(count, /plugin\.state\.data\.cells\.has\(ref\)/u);
  assert.match(count, /ligandOverlay\?\.representation\?\.ref/u);
  assert.match(count, /inspectionLabel\?\.representation\?\.ref/u);
});

test('the overlay teardown survives a ref that is already gone', () => {
  // `plugin.build().to(ref)` throws on a missing ref; Mol*'s `delete(ref)` is a
  // no-op on one. This is the rule that keeps a teardown from becoming the next
  // chapter's failure.
  const remove = viewerSource.slice(viewerSource.indexOf('async function removeLigandOverlay'),
    viewerSource.indexOf('async function removeInspectionLabels'));
  assert.match(remove, /plugin\.state\.data\.cells\.has\(component\.ref\)/u);
  assert.ok(remove.indexOf('ligandOverlay = undefined') < remove.indexOf('.delete(component.ref)'),
    'The record must be cleared before the delete, or a failed delete leaves a live ref to a dead cell.');
});


test('a second structure cannot become the primary appearance or emphasis target',()=>{
  const primary=representationEntry('primary-cartoon','cartoon');
  const companion=representationEntry('companion-cartoon','cartoon');
  const roots=[{cell:{transform:{ref:'companion'}},components:[componentEntry('c',[],[companion])]},
    {cell:{transform:{ref:'primary'}},components:[componentEntry('p',[],[primary])]}];
  assert.equal(findLiveStructureRepresentation(roots,isInspection,'primary'),primary);
  assert.equal(findLiveStructureRepresentation(roots,isInspection,'missing'),undefined);
});
