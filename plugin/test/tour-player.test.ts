import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
// @ts-ignore Shared browser plate planner.
import { planComponentLabels, createComponentLabelSession } from '../../lab/browser-roundtrip/component-labels.mjs';
import { TOURS } from '../src/tour-catalog.js';
import { applyTourStep, applyTourVisibility, captionLine, wearerPages, createTourIntentGate, pageText, resolveTourSelection, reportedFrameRate, grownTierIntent, tourRejoinEligibility, tourStepIsSilentInXr, tourTransportIntent, tourVisibilityTransition, withTourDeadline,
  tourOperationTimeoutMs, tourSceneTimeoutMs, TOUR_FREE_ATOM_SITES, TOUR_OPERATION_TIMEOUT_CAP_MS,
  TOUR_OPERATION_TIMEOUT_MS, TOUR_SCENE_TIMEOUT_MS, XR_AUTOPLAY_MINIMUM_FPS, XR_AUTOPLAY_MAXIMUM_HOLD_MS, XR_FRAME_COST_FRESH_MS,
  TOUR_AUTOPLAY_DWELL_MS, TOUR_FRAMING_TRAVEL_MS, easeInOut, normalizeChapterMotion, tourStepDwellMs, mountTourPlayer,
  type TourStep, type Workspace, type Tour } from '../src/tour-player.js';
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { READOUT_PAGE_LINE_WIDTH, READOUT_PAGE_LINES } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';
// @ts-ignore Shared page harness executes the viewer's real framing and placement closures.
import { tourFocusHarness, framedTourScene } from '../../lab/browser-roundtrip/fixtures/tour-focus-harness.mjs';
// @ts-ignore Shared middle lens band contract.
import { SUBJECT_CENTRE_LENS } from '../../lab/browser-roundtrip/plate-standoff.mjs';

const rows = [
  { key:'A:8', identity:{ authorChain:'A', authorResidue:8 } },
  { key:'A:9', identity:{ authorChain:'A', authorResidue:9 } },
  { key:'B:8', identity:{ authorChain:'B', authorResidue:8 } },
  { key:'A:10A', identity:{ authorChain:'A', authorResidue:'10' } },
];

const visibilityHarness = () => {
  const calls: string[] = [];
  const catalog = [
    { key: 'alpha', entityType: 'polymer', identity: { labelChain: 'A-2', authorChain: 'A-2', copyId: '1', modelNumber: 1, componentId: 'ALA' } },
    { key: 'beta', entityType: 'polymer', identity: { labelChain: 'B-2', authorChain: 'B-2', copyId: '1', modelNumber: 1, componentId: 'ALA' } },
    { key: 'above', entityType: 'polymer', identity: { labelChain: 'A-3', authorChain: 'A-3', copyId: '1', modelNumber: 1, componentId: 'ALA' } },
    { key: 'gtp', entityType: 'non-polymer', identity: { labelChain: 'C-2', authorChain: 'A-2', copyId: '1', modelNumber: 1, componentId: 'GTP' } },
  ];
  let visibility = { hiddenChains: [] as { labelChain: string; copyId: string }[], hiddenClasses: [] as string[], showOnlySelection: false };
  let placement = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const camera = { position: [0, 0, 10], target: [0, 0, 0] };
  let held = false;
  const note = (name: string) => async () => { calls.push(name); };
  const capture = () => structuredClone({ visibility, placement, camera });
  const workspace: Workspace = {
    snapshot: () => ({ ready: true, sourceSha256: 'a', xrPresenting: true, modelNumber: 1,
      inspection: { placement: structuredClone(placement) } }),
    rows: () => catalog, capture, runTour: async action => action(), setStatus: () => {},
    viewer: {
      select: note('select'), focus: note('focus'), inspection: {
        configure: note('configure'), place: note('place'), fit: note('fit'), resetOrientation: note('reset'),
        orbit: note('orbit'), dolly: note('dolly'), setMotion: note('motion'), emphasize: note('emphasize'),
        visibility: () => structuredClone(visibility),
        setVisibility: async wanted => { calls.push('visibility'); visibility = structuredClone(wanted); },
        holdsWearerPlacement: () => held,
        restore: async (scene, options) => {
          calls.push('restore');
          const saved = scene as ReturnType<typeof capture>;
          visibility = structuredClone(saved.visibility);
          if (!options?.preservePlacement) placement = structuredClone(saved.placement);
        },
      },
    },
  };
  return { calls, workspace, capture, catalog,
    move: () => { held = true; placement = { translation: [1, 2, 3], rotation: [10, 20, 30], scale: 1.7 }; },
  };
};

describe('lesson chain visibility', () => {
  it('reveals cumulative label chains after colour updates while keeping placement and camera', async () => {
    const h = visibilityHarness(), before = h.capture();
    const first: TourStep = { id: 'alpha', title: 'Alpha', emphasis: { parts: [{ id: 'alpha', label: 'Alpha', color: '#4a90e2', chain: 'A-2' }] },
      visibility: { op: 'only', chains: ['A-2'], classes: ['polymer'] } };
    expect(tourStepIsSilentInXr({ id: 'one', title: 'One', visibility: first.visibility })).toBe(false);
    await applyTourStep(h.workspace, first, () => true, false);
    expect(h.calls).toEqual(['emphasize', 'visibility']);
    expect(h.capture().visibility.hiddenChains.map(chain => chain.labelChain)).toEqual(['A-3', 'B-2', 'C-2']);
    await applyTourStep(h.workspace, { ...first, id: 'dimer', visibility: { op: 'only', chains: ['A-2', 'B-2'], classes: ['polymer'] } }, () => true, false);
    expect(h.capture().visibility.hiddenChains.map(chain => chain.labelChain)).toEqual(['A-3', 'C-2']);
    expect(h.capture().visibility.hiddenClasses).toEqual(['ligand']);
    expect(h.capture().placement).toEqual(before.placement);
    expect(h.capture().camera).toEqual(before.camera);
  });

  it('refuses absent and ambiguous chains before appearance or placement changes', async () => {
    const h = visibilityHarness();
    const chapter: TourStep = { id: 'bad', title: 'Bad', appearance: { representation: 'cartoon' }, placement: { scale: 2 },
      visibility: { op: 'only', chains: ['missing'] } };
    await expect(applyTourStep(h.workspace, chapter, () => true, false)).rejects.toThrow('no chain missing');
    expect(h.calls).toEqual([]);
    h.catalog.push({ ...h.catalog[0], key: 'alpha-copy', identity: { ...h.catalog[0].identity, copyId: '2' } });
    await expect(applyTourVisibility(h.workspace, { op: 'only', chains: ['A-2'] })).rejects.toThrow('2 copies');
    expect(h.calls).toEqual([]);
  });

  it('refuses an empty chain/class intersection and viewers without visibility support', async () => {
    const h = visibilityHarness();
    await expect(applyTourVisibility(h.workspace, { op: 'only', chains: ['C-2'], classes: ['polymer'] })).rejects.toThrow('hide every part');
    expect(h.calls).toEqual([]);
    delete h.workspace.viewer.inspection.setVisibility;
    await expect(applyTourVisibility(h.workspace, { op: 'only', chains: ['A-2'] })).rejects.toThrow('does not support lesson visibility');
  });

  it('keeps the existing hide/show/reset semantics and leaves unauthored visibility untouched', async () => {
    const h = visibilityHarness();
    await applyTourVisibility(h.workspace, { op: 'hide', chains: ['B-2'] });
    expect(h.capture().visibility.hiddenChains).toEqual([{ labelChain: 'B-2', copyId: '1' }]);
    await applyTourStep(h.workspace, { id: 'plain', title: 'Plain' }, () => true, false);
    expect(h.capture().visibility.hiddenChains).toEqual([{ labelChain: 'B-2', copyId: '1' }]);
    await applyTourVisibility(h.workspace, { op: 'show', chains: ['B-2'] });
    expect(h.capture().visibility.hiddenChains).toEqual([]);
    await applyTourVisibility(h.workspace, { op: 'hide', classes: ['ligand'] });
    await applyTourVisibility(h.workspace, { op: 'reset' });
    expect(h.capture().visibility).toEqual({ hiddenChains: [], hiddenClasses: [], showOnlySelection: false });
  });

  it('keeps a density hold chapter at the wearer placement without automatic framing', async () => {
    const h = visibilityHarness(); h.move();
    const before = h.capture();
    h.workspace.snapshot = () => ({ ready: true, sourceSha256: 'a', xrPresenting: true, atomCount: 0, triangleCount: 178236 });
    const paints: unknown[] = [];
    h.workspace.viewer.inspection.emphasize = async value => { h.calls.push('emphasize'); paints.push(value); };
    await applyTourStep(h.workspace, { id: 'hold-density', title: 'Above us', motion: 'hold', narration: 'Explore the tube.' }, () => true, false);
    expect(h.calls).toEqual(['motion', 'emphasize']);
    expect(paints).toEqual([{ parts: [], origin: 'lesson' }]);
    expect(h.capture().placement).toEqual(before.placement);
    expect(h.capture().camera).toEqual(before.camera);
  });
});

describe('tour selection resolver', () => {
  it('resolves author chain and residue ranges against the loaded catalog', () => {
    expect(resolveTourSelection(rows, { chain:'A', residues:{ from:8, to:10 } })).toEqual(['A:8','A:9','A:10A']);
  });

  it('does not let a tour selection leak across similarly numbered chains', () => {
    expect(resolveTourSelection(rows, { chain:'B', residues:[8] })).toEqual(['B:8']);
    expect(resolveTourSelection(rows, { chain:'C', residues:[8] })).toEqual([]);
  });

  it('uses an explicit empty selection for a clear scene', () => {
    expect(resolveTourSelection(rows, 'clear')).toEqual([]);
  });

  it('invalidates a queued scene when a newer navigation or pause takes over', () => {
    const gate = createTourIntentGate();
    const queuedFirst = gate.issue();
    const next = gate.issue();
    expect(gate.isCurrent(queuedFirst)).toBe(false);
    expect(gate.isCurrent(next)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(next)).toBe(false);
  });
});

describe('tour visibility policy', () => {
  it('pauses hidden autoplay while preserving a resume intent', () => {
    expect(tourVisibilityTransition({ visible:false, autoplay:true, resumeOnVisible:false, active:true }))
      .toEqual({ autoplay:false, resumeOnVisible:true, message:'Autoplay paused while this tab is hidden.' });
  });

  it('resumes only an active tour when the tab returns', () => {
    expect(tourVisibilityTransition({ visible:true, autoplay:false, resumeOnVisible:true, active:true }))
      .toEqual({ autoplay:true, resumeOnVisible:false, message:'Autoplay resumed.' });
    expect(tourVisibilityTransition({ visible:true, autoplay:false, resumeOnVisible:true, active:false }))
      .toEqual({ autoplay:false, resumeOnVisible:false });
  });

  it('does not create a hidden-tab resume intent when autoplay was already paused', () => {
    expect(tourVisibilityTransition({ visible:false, autoplay:false, resumeOnVisible:false, active:true }))
      .toEqual({ autoplay:false, resumeOnVisible:false });
  });
});

describe('tour rejoin policy', () => {
  it('allows rejoining a cached scene only when the source is unchanged', () => {
    expect(tourRejoinEligibility({ ready:true, selected:true, baseline:true, step:2, cached:true, sourceSha256:'same', baselineSource:'same' }))
      .toEqual({ ok:true });
    expect(tourRejoinEligibility({ ready:true, selected:true, baseline:true, step:2, cached:true, sourceSha256:'new', baselineSource:'same' }).ok)
      .toBe(false);
    expect(tourRejoinEligibility({ ready:true, selected:true, baseline:true, step:2, cached:false, sourceSha256:'same', baselineSource:'same' }).ok)
      .toBe(false);
  });
});

describe('spatial tour pagination', () => {
  // The page shape is the caption glass's, not a number chosen here: a page
  // wider or taller than the glass is re-wrapped on arrival and loses its last
  // line. `spatial-toolbar.test.ts` asserts the glass is at least this big
  // above every shipped menu, so the two ends of the contract meet.
  it('keeps every bundled narration word across pages the caption glass holds', () => {
    for (const tour of TOURS) {
      for (const step of tour.steps) {
        const narration = step.body ?? step.description ?? '';
        const pages = pageText(narration);
        const physicalLines = pages.flatMap(page => page.split('\n'));
        expect(physicalLines.every(line => line.length <= READOUT_PAGE_LINE_WIDTH
          || (!/\s/u.test(line) && narration.includes(line) && !/[/-]/u.test(line)))).toBe(true);
        expect(pages.every(page => page.split('\n').length <= READOUT_PAGE_LINES)).toBe(true);
        const sourceWords = narration.trim().split(/\s+/u).filter(Boolean);
        const pagedWords = pages.join(' ').split(/\s+/u).filter(Boolean);
        // Nothing is dropped or reordered: the pages carry every character of
        // the narration, in order.
        expect(pages.join(' ').replace(/\s+/gu, '')).toBe(narration.replace(/\s+/gu, ''));
        // A word the glass can hold on one line is never broken across two.
        // One that cannot -- `Sequence-position` is 17 characters against a
        // 15-character line -- breaks only at its separator. A longer atomic
        // word stays whole for the geometry fitter; it is never hard-chopped.
        expect(sourceWords.filter(word => word.length <= READOUT_PAGE_LINE_WIDTH)
          .every(word => pagedWords.includes(word))).toBe(true);
      }
    }
  });
});

describe('the line the wearer is shown', () => {
  const wall = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/microtubule-growth/wall.json', import.meta.url), 'utf8')));
  const wide = wall.steps[wall.steps.length - 1];
  // Every stage of the growing lesson ships its own authored spoken lines.
  const stagedTours = () => readdirSync(new URL('../demos/microtubule-growth/', import.meta.url))
    .filter(file => file.endsWith('.json'))
    .map(file => molecularLessonToTour(JSON.parse(readFileSync(new URL(`../demos/microtubule-growth/${file}`, import.meta.url), 'utf8'))));
  // A standalone run of digits, with or without separators: a measurement. A
  // digit inside a name (`EB3`, `9KJ6`) is a name, not a number.
  const NUMERIC_TOKEN = /(?<![\w.])\d+(?:[.,]\d+)*(?![\w.])/u;

  it('puts the spoken line on the plate and leaves the desktop caption on the Mac', () => {
    // The wall lesson's closing chapter used to put the desktop caption on the
    // plate, so the wearer read a coordinate string -- "Operators 2 to 7, at
    // 166.20, 138.50" -- while the voice said "Three strands side by side;
    // thirteen close the tube." The plate follows the voice now.
    expect(wide.narration).toBe('Three strands side by side; thirteen close the tube.');
    // The coordinates live in provenance.note, so neither the body nor the
    // plate carries them any more.
    expect(wide.body ?? '').not.toContain('166.20');
    expect(captionLine(wide)).toBe(wide.narration);
    expect(captionLine(wide)).not.toContain('166.20');
    // A chapter with no narration keeps its authored caption: the catalog
    // lessons are written to be read.
    const catalogStep = TOURS[0].steps[0];
    expect(captionLine(catalogStep)).toBe(catalogStep.body ?? catalogStep.description ?? '');
    expect(captionLine(undefined)).toBe('');
  });

  it('sends the plate line whole, spoken or not: the card pages it at its own width', () => {
    expect(wearerPages(wide)).toEqual([wide.narration]);
    const catalogStep = TOURS[0].steps[0];
    const prose = catalogStep.body ?? catalogStep.description ?? '';
    expect(pageText(prose).length).toBeGreaterThan(1);
    expect(wearerPages(catalogStep)).toEqual([prose]);
  });

  it('keeps every bundled spoken line free of numbers', () => {
    // A plate is read across the room at a glance; measurements live on the
    // desktop caption, where there is room to read them. `EB3` and `EB1` are
    // names, not numbers: the rule refuses a standalone numeric token.
    for (const tour of [...TOURS, ...stagedTours()]) {
      for (const step of tour.steps) {
        const line = captionLine(step);
        expect(line.match(NUMERIC_TOKEN), `${tour.id} / ${step.id}: ${line}`).toBeNull();
      }
    }
  });
});

// The workspace defaults an immersive session opens with, from
// DEFAULT_INSPECTION in browser-roundtrip/inspection-state.mjs.
const liveDefaults = {
  appearance: { representation:'cartoon', color:'chain-id', uniformColor:'#58dcc9', background:'#071015',
    opacity:1, labels:false, highlightColor:'#f2c47c', clipping:0, fog:0 },
  placement: { translation:[0,0,0], rotation:[0,0,0], scale:1 },
};

describe('applying one scene to the workspace', () => {
  const recorder = () => {
    const calls: string[] = [];
    const note = (name: string) => async (...args: unknown[]) => { calls.push(`${name}:${JSON.stringify(args[0] ?? null)}`); };
    const workspace = {
      snapshot: () => ({ ready:true, sourceSha256:'a', xrPresenting:true, selectionKeys:['A:8'] }),
      rows: () => rows, capture: () => ({}), runTour: async (action: () => Promise<void>) => action(),
      setStatus: () => undefined,
      viewer: {
        select: note('select'), focus: note('focus'),
        inspection: { configure: note('configure'), place: note('place'), fit: note('fit'),
          resetOrientation: note('reset'), orbit: note('orbit'), dolly: note('dolly'),
          setMotion: note('motion'), restore: note('restore') },
      },
    } as unknown as Workspace;
    return { calls, workspace };
  };
  const step: TourStep = { id:'reveal', title:'Wide reveal', motion:'spin',
    appearance:{ representation:'molecular-surface' }, placement:{ scale:1.6 }, view:'fit' };

  it('authored chapter placement keeps automatic clearance and does not claim agent room intent', async () => {
    const h = tourFocusHarness();
    const place = h.workspace.viewer.inspection.place;
    const actions: string[] = [];
    h.workspace.viewer.inspection.place = async (patch: Record<string, unknown>, action?: string) => {
      actions.push(action ?? 'place');
      return place(patch, action);
    };
    await applyTourStep(h.workspace, { id: 'first', title: 'First', placement: { scale: .5 } }, () => true, false);
    expect(h.hold.holdsPlacement()).toBe(false);
    await applyTourStep(h.workspace, { id: 'next', title: 'Next', placement: { scale: .7 } }, () => true, false);
    expect(actions).toEqual(['tour-placement', 'tour-placement']);
    expect(h.hold.holdsPlacement()).toBe(false);
  });

  it('Wide reveal preserves the held smaller placement without requesting XR framing', async () => {
    // Acceptance 3 #667 and #682-686 retain the top-edge silhouette. This
    // opening has no framing: preserving that hold is a compatibility check,
    // while the framed companion below is the parent-failing regression.
    const manifest = JSON.parse(readFileSync(new URL('../demos/telomerase-haca.json', import.meta.url), 'utf8'));
    const opening = molecularLessonToTour(manifest).steps[0];
    const h = tourFocusHarness();
    await h.wearerMove();
    const before = h.snapshot().placement, hold = h.hold.state(), writes = h.writes.length;
    expect(h.targetLens()[1]).toBeGreaterThan(SUBJECT_CENTRE_LENS);
    await applyTourStep(h.workspace, opening, () => true, false,
      undefined, error => { throw error; });
    expect(opening.title).toBe('Wide reveal');
    expect(opening.emphasis?.framing).toBeUndefined();
    expect(h.paints).toHaveLength(1);
    expect(h.snapshot().placement).toEqual(before);
    expect(h.hold.state()).toEqual(hold);
    expect(h.writes).toHaveLength(writes);
    expect(h.records.filter((row: { kind: string }) => row.kind === 'xr-focus')).toHaveLength(0);
  });

  it('a framed chapter updates content without moving the wearer placement', async () => {
    const h = tourFocusHarness();
    await h.wearerMove();
    const before = h.snapshot().placement, writes = h.writes.length;
    await applyTourStep(h.workspace, framedTourScene, () => true, false,
      undefined, error => { throw error; });
    expect(h.records.filter((row: { kind: string }) => row.kind === 'xr-focus')).toHaveLength(0);
    expect(h.snapshot().placement).toEqual(before);
    expect(h.writes).toHaveLength(writes);
    expect(h.paints).toHaveLength(1);
    expect(h.hold.holdsPlacement()).toBe(true);
  });

  it('places and starts the turn before it pays for a representation rebuild', async () => {
    const { calls, workspace } = recorder();
    await applyTourStep(workspace, step, () => true, false);
    expect(calls.map(call => call.split(':')[0])).toEqual(['place', 'motion', 'configure']);
  });

  it('reads spin as running and hold as paused', async () => {
    const spin = recorder(), hold = recorder();
    await applyTourStep(spin.workspace, { id:'a', title:'A', motion:'spin' }, () => true, false);
    await applyTourStep(hold.workspace, { id:'a', title:'A', motion:'hold' }, () => true, false);
    expect(spin.calls).toEqual(['motion:{"paused":false}']);
    expect(hold.calls).toEqual(['motion:{"paused":true}']);
  });

  it('emphasises only after the rebuild that would have dropped the layer', async () => {
    const { calls, workspace } = recorder();
    const emphasis = { parts:[{ id:'guide', label:'Guide RNA', color:'#ff8a1f', chain:'B' }], focus:'guide' };
    (workspace.viewer.inspection as Record<string, unknown>).emphasize =
      async (value: unknown) => { calls.push(`emphasize:${JSON.stringify(value)}`); };
    await applyTourStep(workspace, { ...step, emphasis }, () => true, false);
    // Emphasis is a transparency and overpaint layer over the representation,
    // so a `configure` rebuild after it would silently wipe it.
    expect(calls.map(call => call.split(':')[0])).toEqual(['place', 'motion', 'configure', 'emphasize']);
    expect(calls.at(-1)).toContain('"focus":"guide"');
  });

  // Both of these are one wearer-visible failure: a chapter that is not about a
  // part leaves the previous chapter's part lit and the rest of the complex at
  // twelve per cent, and nothing afterwards clears it.
  it('clears the previous chapter when this one emphasises nothing', async () => {
    const { calls, workspace } = recorder();
    (workspace.viewer.inspection as Record<string, unknown>).emphasize =
      async (value: unknown) => { calls.push(`emphasize:${JSON.stringify(value)}`); };
    await applyTourStep(workspace, { id:'recap', title:'Recap', appearance:{ representation:'cartoon' } }, () => true, false);
    expect(calls).toContain('emphasize:{"parts":[],"origin":"lesson"}');
    expect(calls.map(call => call.split(':')[0])).toEqual(['configure', 'emphasize']);
  });

  // A Quest 2 rebuild takes seconds; a wearer who pauses inside one abandons
  // the chapter. `applyInspectionAppearance`
  // repaints whatever key the viewer believes it is wearing after a rebuild, so
  // an abandoned chapter used to leave the NEW representation wearing the
  // PREVIOUS chapter's key, with no chapter coming that would clear it.
  it('paints the plain structure when the wearer pauses between the rebuild and the emphasis', async () => {
    const { calls, workspace } = recorder();
    (workspace.viewer.inspection as Record<string, unknown>).emphasize =
      async (value: unknown) => { calls.push(`emphasize:${JSON.stringify(value)}`); };
    let admitted = true;
    (workspace.viewer.inspection as Record<string, unknown>).configure =
      async (patch: unknown) => { calls.push(`configure:${JSON.stringify(patch)}`); admitted = false; };
    const emphasis = { parts:[{ id:'guide', label:'Guide RNA', color:'#ff8a1f', chain:'B' }], focus:'guide' };
    await applyTourStep(workspace, { id:'guide', title:'The guide', appearance:{ representation:'cartoon' },
      emphasis, selection:{ chain:'B' } }, () => admitted, false);
    // The abandoned chapter's own key is never painted, and the scene stops
    // before the selection it was going to make.
    expect(calls).toEqual(['configure:{"representation":"cartoon"}', 'emphasize:{"parts":[],"origin":"lesson"}']);
  });

  // A density chapter carries no `emphasis` — a map has no
  // chains to paint — so without this the tier would never be framed and the
  // map would sit wherever the entry seat left it. A density scene frames its
  // whole map at `fill`; an authored framing still wins and an abandoned
  // chapter still paints plain.
  it('frames the whole map when a density chapter emphasises nothing', async () => {
    const { calls, workspace } = recorder();
    (workspace.viewer.inspection as Record<string, unknown>).emphasize =
      async (value: unknown) => { calls.push(`emphasize:${JSON.stringify(value)}`); };
    (workspace as { snapshot: () => unknown }).snapshot = () => ({ ready: true, sourceSha256: 'map',
      xrPresenting: true, selectionKeys: [], atomCount: 0, triangleCount: 178236 });
    await applyTourStep(workspace, { id: 'reveal', title: 'Real density', motion: 'spin',
      appearance: { representation: 'isosurface' } }, () => true, false);
    expect(calls).toContain('emphasize:{"parts":[],"origin":"lesson","framing":"fill"}');
  });

  it('leaves a live key alone when a scene is abandoned before it rebuilds anything', async () => {
    const { calls, workspace } = recorder();
    (workspace.viewer.inspection as Record<string, unknown>).emphasize =
      async (value: unknown) => { calls.push(`emphasize:${JSON.stringify(value)}`); };
    let admitted = true;
    (workspace.viewer.inspection as Record<string, unknown>).place =
      async (patch: unknown) => { calls.push(`place:${JSON.stringify(patch)}`); admitted = false; };
    await applyTourStep(workspace, { id:'move', title:'Move', placement:{ scale:1.2 } }, () => admitted, false);
    // Nothing was rebuilt, so nothing can be wearing a key that does not match
    // the representation: clearing here would only take a chapter off screen.
    expect(calls).toEqual(['place:{"scale":1.2}']);
  });

  it('plays a lesson with emphasis on a workspace too old to have it', async () => {
    const { calls, workspace } = recorder();
    await applyTourStep(workspace, { ...step,
      emphasis:{ parts:[{ id:'a', label:'A', color:'#ffffff', chain:'A' }] } }, () => true, false);
    expect(calls.some(call => call.startsWith('emphasize'))).toBe(false);
  });

  it('drops the desktop camera intent in a headset and keeps it on a desktop', async () => {
    const headset = recorder(), desktop = recorder();
    await applyTourStep(headset.workspace, step, () => true, false);
    await applyTourStep(desktop.workspace, step, () => true, true);
    expect(headset.calls.some(call => call.startsWith('fit'))).toBe(false);
    expect(desktop.calls.at(-1)).toBe('fit:null');
  });

  it('abandons the rest of a scene the moment it stops being admitted', async () => {
    const { calls, workspace } = recorder();
    let admitted = true;
    await applyTourStep(workspace, step, () => { const now = admitted; admitted = false; return now; }, true);
    expect(calls).toEqual(['place:{"scale":1.6}']);
  });

  // On the microtubule wall, chapter 5's emphasis threw `Could not find node
  // '<ref>'` — a Mol* state ref the chapter's own appearance had just deleted —
  // and because that rejection came out of `applyTourStep` the wearer got no
  // chapter 5 at all. Not a wrong
  // colour: no caption, no placement, no representation, and a lesson that
  // would not advance again. Placement and appearance land BEFORE the emphasis,
  // so by the time a key fails the chapter is already on screen.
  it('still shows the chapter when its colour key cannot be painted', async () => {
    const { calls, workspace } = recorder();
    (workspace.viewer.inspection as Record<string, unknown>).emphasize =
      async () => { throw Error("Could not find node 'yEw1bmA1hVpstsCEqyENWg'."); };
    const failures: string[] = [];
    const emphasis = { parts:[{ id:'guide', label:'Guide RNA', color:'#ff8a1f', chain:'B' }], focus:'guide' };
    await expect(applyTourStep(workspace, { ...step, emphasis, selection:{ chain:'B' } }, () => true, true,
      undefined, error => failures.push(String((error as Error).message)))).resolves.toBeUndefined();
    // The whole chapter ran: the move, the turn, the rebuild, the selection and
    // the desktop view, all of it after the key that would not paint.
    expect(calls.map(call => call.split(':')[0])).toEqual(['place', 'motion', 'configure', 'select', 'fit']);
    expect(failures).toEqual(["Could not find node 'yEw1bmA1hVpstsCEqyENWg'."]);
  });

  // CRISPR chapter 3 selects the PAM to label it, and the caption calls the
  // PAM yellow. A wearer's selection is marked in magenta; the lesson's own is
  // marked by its colour key, so the chapter selects as the lesson.
  it('selects an authored chapter selection as the lesson', async () => {
    const { workspace } = recorder();
    const selected: unknown[][] = [];
    workspace.viewer.select = async (...args: unknown[]) => { selected.push(args); };
    await applyTourStep(workspace, { ...step, selection:{ chain:'B' } }, () => true, false);
    expect(selected).toEqual([[['B:8'], 'selection', { lesson:true }]]);
  });

  it('records the lost key rather than swallowing it silently', async () => {
    const { workspace } = recorder();
    (workspace.viewer.inspection as Record<string, unknown>).emphasize =
      async () => { throw Error('The overpaint layer could not be built.'); };
    const failures: unknown[] = [];
    await applyTourStep(workspace, { id:'recap', title:'Recap', appearance:{ representation:'cartoon' } },
      () => true, false, undefined, error => failures.push(error));
    expect(failures).toHaveLength(1);
  });

  it('still fails the scene when the key never comes back at all', async () => {
    // A rejection means the paint is over and the chapter stands. A hang means
    // the viewer's mutation queue is still holding the work, and walking the
    // transport on into a wedged viewer is the half-played lesson the bound
    // exists to catch. The two must not be treated alike.
    const { workspace } = recorder();
    (workspace.viewer.inspection as Record<string, unknown>).emphasize = () => new Promise(() => {});
    const failures: unknown[] = [];
    await expect(applyTourStep(workspace, { id:'recap', title:'Recap', appearance:{ representation:'cartoon' } },
      () => true, false, 40, error => failures.push(error))).rejects.toThrow(/colour emphasis did not finish/u);
    expect(failures).toEqual([]);
  });

  it('leaves every other failure fatal to the scene', async () => {
    // Only the key is optional. An appearance that will not build is a chapter
    // the wearer cannot be shown, and the player must still say so.
    const { workspace } = recorder();
    (workspace.viewer.inspection as Record<string, unknown>).configure =
      async () => { throw Error('This representation has no supported geometry.'); };
    await expect(applyTourStep(workspace, { ...step }, () => true, false))
      .rejects.toThrow('This representation has no supported geometry.');
  });
});

describe('emphasis on a scene the wearer comes back to', () => {
  // In the rewritten CRISPR lesson, chapters 1 and 2 were both lit as chapter
  // 3. A scene the player has
  // already rendered is replayed from `scenes`, and a capture carries
  // appearance, placement, selection and camera but has no notion of the
  // emphasis layers — so Back, or a second play of the lesson, left the
  // molecule wearing the colours of the chapter the wearer had just left.
  const source = readFileSync(new URL('../src/tour-player.ts', import.meta.url), 'utf8');

  it('re-applies the scene emphasis after restoring a cached scene', () => {
    const cachedBranch = source.slice(source.indexOf('if (cached) {'), source.indexOf('liveStep = target;'));
    expect(cachedBranch).toContain('restore(cached');
    expect(cachedBranch).toContain('applyStepEmphasis(tour.steps[target], owned)');
  });

  it('clears the emphasis layers with the lesson starting view', () => {
    expect(source).toContain('applyStepEmphasis(undefined, admitted)');
  });

  // The cached restore is the SECOND place a chapter's key is painted, and it
  // reached `visit`'s catch exactly as the linear walk did.
  // Back into a chapter whose key will not paint must not end the lesson
  // either: the scene has already been restored when this runs.
  it('keeps a restored chapter when its key will not paint', () => {
    const cachedBranch = source.slice(source.indexOf('if (cached) {'), source.indexOf('liveStep = target;'));
    expect(cachedBranch).toContain('recordEmphasisFailure(error)');
    // A key that never came back still fails the scene, here as in the walk.
    expect(cachedBranch).toContain('isTourDeadlineError(error)');
  });

  it('records a lost key from both places a chapter paints one', () => {
    expect(source).toContain('recordEmphasisFailure');
    // The linear walk hands the recorder to applyTourStep; the cached restore
    // calls it directly. Both, or the rule only half holds.
    expect(source).toContain('operationBound(), recordEmphasisFailure');
    expect(source.match(/recordEmphasisFailure/gu)!.length).toBeGreaterThanOrEqual(3);
  });

  // The cached branch above was fixed first; the FIRST linear pass through a
  // lesson — the one a wearer actually sees — went through `applyTourStep`,
  // which only emphasised when the chapter had an emphasis block. A recap after
  // a focused chapter therefore arrived with every other chain still at twelve
  // per cent.
  it('makes the no-cache branch clear a chapter that emphasises nothing', () => {
    const liveBranch = source.slice(source.indexOf('export async function applyTourStep'),
      source.indexOf('export function mountTourPlayer'));
    expect(liveBranch).toContain('stepEmphasis(entry, resting)');
    // Never guarded on the block being present: that guard IS the defect.
    expect(liveBranch).not.toContain('if (entry.emphasis) await bound');
  });

  // `notifyMutation` stopped the lesson on a grab, an agent focus, a quality
  // change or a workbench sync and
  // left the chapter's fade painted, so the wearer was handed a molecule at
  // twelve per cent with no lesson running that would ever clear it.
  it('takes the lesson fade off on a takeover and on a source change', () => {
    const notify = source.slice(source.indexOf('notifyMutation(snapshot, options) {'), source.indexOf('stop(reason ='));
    expect(notify.match(/dropLessonEmphasis\(\)/gu)).toHaveLength(2);
    expect(notify.indexOf('dropLessonEmphasis()')).toBeLessThan(notify.indexOf("reason: 'source-changed'"));
    // The viewer decides whether the key is the lesson's to take: a key the
    // wearer or an agent asked for by name is refused there, not here.
    expect(source).toContain('workspace.viewer.inspection.clearLessonEmphasis?.()');
    // Never awaited: this is a notification from a mutation that has happened.
    expect(source).not.toContain('await workspace.viewer.inspection.clearLessonEmphasis');
  });

  it('asks for no framing on a replay, because the restored placement is already framed', () => {
    // Replayed overviews keep the baseline key without reframing the restored seat.
    expect(source).toContain('workspace.viewer.inspection.emphasize?.({ ...stepEmphasis(entry, lessonRestingState(selected)), framing: undefined })');
  });
});

describe('immersive opening scene', () => {
  it('reads every scene of the shipped CRISPR lesson as visible in a headset', () => {
    const tour = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/crispr-cas9.json', import.meta.url), 'utf8')));
    // Wide reveal restates the default cartoon at identity placement and asks
    // only for a desktop `fit`, which XR drops, so it used to read as silent
    // and the wearer's first press skipped it. It now starts the presentation
    // turn, which is a change a wearer sees within a frame, so the lesson opens
    // where it was written to open.
    expect(tourStepIsSilentInXr(tour.steps[0], liveDefaults)).toBe(false);
    expect(tour.steps.filter(step => tourStepIsSilentInXr(step, liveDefaults))).toEqual([]);
  });

  it('still reads a scene with no motion and nothing new to paint as silent', () => {
    expect(tourStepIsSilentInXr({ id:'a', title:'A', appearance:{ representation:'cartoon' },
      placement:{ scale:1 } }, liveDefaults)).toBe(true);
    expect(tourStepIsSilentInXr({ id:'a', title:'A', appearance:{ representation:'cartoon' },
      placement:{ scale:1 }, motion:'spin' }, liveDefaults)).toBe(false);
    // A taught lesson holds one representation and one placement for its whole
    // length and changes only which part is lit. That is the most visible thing
    // a chapter does, so it must never read as a silent scene to skip past.
    expect(tourStepIsSilentInXr({ id:'a', title:'A', appearance:{ representation:'cartoon' },
      placement:{ scale:1 }, emphasis:{ parts:[{ id:'p', label:'P', color:'#ffffff', chain:'A' }], focus:'p' },
    }, liveDefaults)).toBe(false);
  });

  it('treats fog alone as no visible scene change and any other field as one', () => {
    expect(tourStepIsSilentInXr({ id:'a', title:'A', appearance:{ fog:30 } }, liveDefaults)).toBe(true);
    expect(tourStepIsSilentInXr({ id:'a', title:'A', appearance:{ representation:'spacefill' } }, liveDefaults)).toBe(false);
    expect(tourStepIsSilentInXr({ id:'a', title:'A', placement:{ scale:1.1 } }, liveDefaults)).toBe(false);
  });

  it('never calls a step with its own selection or a staged appearance silent', () => {
    expect(tourStepIsSilentInXr({ id:'a', title:'A', selection:'clear' }, liveDefaults)).toBe(false);
    expect(tourStepIsSilentInXr({ id:'a', title:'A', appearances:[{ fog:30 }] }, liveDefaults)).toBe(false);
  });

  it('keeps a step that carries a view intent alone silent, because XR drops the camera', () => {
    expect(tourStepIsSilentInXr({ id:'a', title:'A', view:'fit' }, liveDefaults)).toBe(true);
  });

  it('assumes a scene is visible when the workspace reports no inspection state', () => {
    expect(tourStepIsSilentInXr({ id:'a', title:'A', appearance:{ fog:30 } }, undefined)).toBe(false);
  });
});

describe('immersive autoplay frame-rate hold', () => {
  const at = 1_000_000;
  it('reads the newest frame-rate record', () => {
    expect(reportedFrameRate([{ kind:'frame-rate', at, detail:{ fps:71.8 } },
      { kind:'frame-rate', at: at + 1_000, detail:{ fps:34.2 } }], at + 1_200)).toBe(34.2);
  });

  it('lets a Quest 2 at its normal resting and rebuild rates advance', () => {
    // A Quest 2 rests at 50-55 fps and drops to 25-35 for up to forty seconds
    // while Mol* rebuilds. None of that may hold a lesson.
    for (const fps of [50, 55, 25, 35, 72]) {
      const measured = reportedFrameRate([{ kind:'frame-rate', at, detail:{ fps } }], at + 500);
      expect(measured !== undefined && measured < XR_AUTOPLAY_MINIMUM_FPS).toBe(false);
    }
  });

  it('holds only below twenty', () => {
    const held = reportedFrameRate([{ kind:'frame-rate', at, detail:{ fps:12 } }], at + 500);
    expect(held !== undefined && held < XR_AUTOPLAY_MINIMUM_FPS).toBe(true);
  });

  it('caps the hold so a stuck budget cannot strand a lesson', () => {
    expect(XR_AUTOPLAY_MAXIMUM_HOLD_MS).toBe(5_000);
    expect(XR_AUTOPLAY_MAXIMUM_HOLD_MS).toBeLessThan(XR_FRAME_COST_FRESH_MS);
  });

  it('ignores a record older than the freshness window, so a closed session holds nothing', () => {
    expect(reportedFrameRate([{ kind:'frame-rate', at, detail:{ fps:20 } }],
      at + XR_FRAME_COST_FRESH_MS + 1)).toBeUndefined();
  });

  it('ignores every other diagnostics kind and an empty ring', () => {
    expect(reportedFrameRate([{ kind:'toolbar', at, detail:{} }], at + 100)).toBeUndefined();
    expect(reportedFrameRate([], at)).toBeUndefined();
  });
});

describe('tour transport with nothing playing', () => {
  // `control_tour back` and `next` used to answer "queued" and move nothing,
  // because the player refused both unless a lesson was already active: press
  // the transport and nothing happens. A transport press is a request for the
  // lesson, so an idle player starts it instead of doing nothing.
  const idle = { active:false, stopped:false, hasLesson:true, step:-1, canNext:false, canBack:false, navigating:false };

  it('starts the lesson at its first chapter when Next is pressed with no tour running', () => {
    expect(tourTransportIntent({ ...idle, action:'next' })).toEqual({ do:'start', startAt:'first' });
  });

  it('starts at the last chapter when Back is pressed with no tour running', () => {
    expect(tourTransportIntent({ ...idle, action:'back' })).toEqual({ do:'start', startAt:'last' });
  });

  it('rejoins the chapter a workspace takeover stopped rather than replaying the lesson', () => {
    expect(tourTransportIntent({ ...idle, action:'next', stopped:true, step:3 })).toEqual({ do:'rejoin' });
  });

  it('still moves a running lesson one scene', () => {
    expect(tourTransportIntent({ ...idle, action:'next', active:true, step:1, canNext:true })).toEqual({ do:'move' });
    expect(tourTransportIntent({ ...idle, action:'back', active:true, step:1, canBack:true })).toEqual({ do:'move' });
  });

  it('refuses with a sentence rather than silently, at the ends and mid-render', () => {
    expect(tourTransportIntent({ ...idle, action:'next', active:true, step:5, canNext:false }))
      .toEqual({ do:'none', reason:'This tour has no scene in that direction.' });
    expect(tourTransportIntent({ ...idle, action:'next', navigating:true }))
      .toEqual({ do:'none', reason:'This tour is still rendering a scene.' });
    expect(tourTransportIntent({ ...idle, action:'next', hasLesson:false }))
      .toEqual({ do:'none', reason:'No lesson is loaded in this panel.' });
  });
});

describe('a grown tier and the lesson that arrives with it', () => {
  // Every grow used to swap the coordinates and stop there. The tier arrived in
  // Mol*'s chain-id rainbow, a few per cent of the lens up by the ceiling, the
  // menu fully expanded, and nothing spoken. The rule pinned here is that a swap made
  // while a lesson is on screen opens that lesson's opening chapter, which is
  // what paints the key, speaks the line, collapses the menu and applies the
  // lesson's own immersive framing.
  const swap = { presenting:true, hasChapters:true, lessonOnScreen:true, autoplay:true };

  it('opens the grown tier at chapter one and keeps the lesson auto-advancing', () => {
    expect(grownTierIntent(swap)).toEqual({ open:'chapter', autoplay:true });
  });

  it('still opens chapter one for a lesson the wearer had paused, but holds there', () => {
    // "grow it" should feel like the lesson continuing, so a paused lesson is
    // not a stopped one: the chapter is painted and spoken, and only the
    // auto-advance stays off.
    expect(grownTierIntent({ ...swap, autoplay:false })).toEqual({ open:'chapter', autoplay:false });
  });

  it('paints the key with no chapter when no lesson was on screen', () => {
    expect(grownTierIntent({ ...swap, lessonOnScreen:false })).toEqual({ open:'key', autoplay:false });
  });

  it('keeps a fresh host entry at the resting key even if a stale tour says active', () => {
    expect(grownTierIntent({ ...swap, initialOpen:true })).toEqual({ open:'key', autoplay:false });
  });

  it('never leaves a tier that has a key wearing chain-id colours', () => {
    for (const lessonOnScreen of [true, false]) {
      expect(grownTierIntent({ ...swap, lessonOnScreen }).open).not.toBe('none');
    }
  });

  it('does nothing for a source with no authored lesson, or a swap made off a headset', () => {
    expect(grownTierIntent({ ...swap, hasChapters:false })).toEqual({ open:'none', autoplay:false });
    expect(grownTierIntent({ ...swap, presenting:false })).toEqual({ open:'none', autoplay:false });
  });
});

/**
 * A Quest 2 regression, as a test.
 *
 * Chapter 2 of the CRISPR lesson applied its colour emphasis on real hardware
 * and then never came back. `emphasize` frames the part it lit, that framing
 * travel scheduled its next frame on the window clock a live immersive session
 * does not run, and the promise behind it never settled. The lesson reported
 * nothing, the page's heartbeat to the Mac stopped for seven minutes, and all
 * the wearer had was a chapter still wearing chapter 1's title.
 *
 * No headset is needed to hold the rule: a never-resolving primitive is a
 * never-resolving primitive, and a lesson that cannot finish a chapter has to
 * give up on it inside a bounded time and say which part stalled.
 */
describe('a lesson scene that never comes back', () => {
  const hung = () => new Promise<never>(() => {});
  const workspaceWith = (emphasize: () => Promise<never>) => ({
    snapshot: () => ({ ready:true, sourceSha256:'a', xrPresenting:true, selectionKeys:[] }),
    rows: () => rows, capture: () => ({}), runTour: async (action: () => Promise<void>) => action(),
    setStatus: () => undefined,
    viewer: {
      select: async () => undefined, focus: async () => undefined,
      inspection: { configure: async () => undefined, place: async () => undefined, fit: async () => undefined,
        resetOrientation: async () => undefined, orbit: async () => undefined, dolly: async () => undefined,
        setMotion: async () => undefined, restore: async () => undefined, emphasize },
    },
  } as unknown as Workspace);
  const chapter: TourStep = { id:'guide', title:'2: THE GUIDE', narration:'Orange is the guide RNA.',
    emphasis:{ parts:[{ id:'guide', label:'Guide RNA', color:'#ff8a1f', chain:'B' }], focus:'guide', framing:'context' } };
  /** A workspace that records what a late scene would paint if it were let through. */
  const lateScene = () => {
    const calls: string[] = [];
    const note = (name: string) => async (...args: unknown[]) => { calls.push(`${name}:${JSON.stringify(args[0] ?? null)}`); };
    const workspace = {
      snapshot: () => ({ ready:true, sourceSha256:'a', xrPresenting:true, selectionKeys:[] }),
      rows: () => rows, capture: () => ({}), runTour: async (action: () => Promise<void>) => action(),
      setStatus: () => undefined,
      viewer: {
        select: note('select'), focus: note('focus'),
        inspection: { configure: note('configure'), place: note('place'), fit: note('fit'),
          resetOrientation: note('reset'), orbit: note('orbit'), dolly: note('dolly'),
          setMotion: note('motion'), restore: note('restore'), emphasize: note('emphasize') },
      },
    } as unknown as Workspace;
    return { calls, workspace };
  };
  const lateStep: TourStep = { id:'reveal', title:'Wide reveal', motion:'spin',
    appearance:{ representation:'molecular-surface' }, placement:{ scale:1.6 } };

  it('fails the scene within its deadline instead of hanging on the emphasis apply', async () => {
    const started = Date.now();
    await expect(applyTourStep(workspaceWith(hung), chapter, () => true, false, 40))
      .rejects.toThrow(/colour emphasis did not finish/u);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('names which part of the chapter stalled, so the failure is readable afterwards', async () => {
    await expect(withTourDeadline('colour emphasis', hung(), 20)).rejects
      .toThrow("This lesson scene's colour emphasis did not finish within 0 seconds.");
    await expect(withTourDeadline('narration', hung(), 20)).rejects.toThrow(/narration did not finish/u);
  });

  // The bound scales with the tier, because it bounds a hang.
  it('keeps twenty seconds for a tier the bound was measured on', () => {
    expect(tourOperationTimeoutMs(undefined)).toBe(TOUR_OPERATION_TIMEOUT_MS);
    expect(tourOperationTimeoutMs(0)).toBe(TOUR_OPERATION_TIMEOUT_MS);
    expect(tourOperationTimeoutMs(6_818)).toBe(TOUR_OPERATION_TIMEOUT_MS);
    expect(tourOperationTimeoutMs(TOUR_FREE_ATOM_SITES)).toBe(TOUR_OPERATION_TIMEOUT_MS);
  });

  it('buys a bigger tier its own share, and never more than the cap', () => {
    // The microtubule wall: 40,908 atom sites, whose cartoon re-theme was
    // measured at 22.0 and 26.8 seconds and therefore lost every race against a
    // flat twenty. It must now have room for one rebuild and not for a hang.
    const wall = tourOperationTimeoutMs(40_908);
    expect(wall).toBeGreaterThan(27_000);
    expect(wall).toBeLessThanOrEqual(TOUR_OPERATION_TIMEOUT_CAP_MS);
    expect(tourOperationTimeoutMs(177_268)).toBe(TOUR_OPERATION_TIMEOUT_CAP_MS);
    // An unusable count is not a licence to wait longer: it falls back to the
    // flat bound, which is the conservative answer.
    expect(tourOperationTimeoutMs(Number.POSITIVE_INFINITY)).toBe(TOUR_OPERATION_TIMEOUT_MS);
    expect(tourOperationTimeoutMs(Number.NaN)).toBe(TOUR_OPERATION_TIMEOUT_MS);
    expect(tourOperationTimeoutMs(-5)).toBe(TOUR_OPERATION_TIMEOUT_MS);
    // The outer net is never tighter than the operations it has to contain.
    expect(tourSceneTimeoutMs(40_908)).toBeGreaterThanOrEqual(2 * wall);
    expect(tourSceneTimeoutMs(0)).toBe(TOUR_SCENE_TIMEOUT_MS);
  });

  it('reads the loaded tier off the workspace rather than assuming one', async () => {
    // A step that takes longer than the flat bound and less than the tier's own
    // must finish, because the wall tier is the case that was failing.
    const slow = () => new Promise(resolve => { setTimeout(resolve, 30); });
    const workspace = {
      snapshot: () => ({ ready: true, sourceSha256: 'a', xrPresenting: true, atomCount: 40_908 }),
      rows: () => [], capture: () => ({}), runTour: async (action: () => Promise<void>) => action(),
      setStatus: () => undefined,
      viewer: { select: slow, focus: slow,
        inspection: { configure: slow, place: slow, fit: slow, resetOrientation: slow, orbit: slow,
          dolly: slow, setMotion: slow, restore: slow, emphasize: slow } },
    } as unknown as Workspace;
    const chapter: TourStep = { id: 'wide', title: 'Six of many',
      appearance: { representation: 'cartoon' }, emphasis: { parts: [] } };
    // 20 would fail this step; the tier's own bound is bigger, and applyTourStep
    // takes it from the workspace with no caller passing a number.
    expect(tourOperationTimeoutMs(40_908)).toBeGreaterThan(20);
    await expect(applyTourStep(workspace, chapter, () => true, false)).resolves.toBeUndefined();
  });

  it('lets a healthy scene through untouched, promise or not', async () => {
    await expect(withTourDeadline('colour emphasis', Promise.resolve('done'), 20)).resolves.toBe('done');
    await expect(withTourDeadline('colour emphasis', undefined, 20)).resolves.toBeUndefined();
    // A workspace too old to have `emphasize` returns undefined, not a promise.
    await expect(withTourDeadline('colour emphasis', 'sync' as unknown as Promise<string>, 20)).resolves.toBe('sync');
  });

  it('carries a real rejection through rather than replacing it with a timeout', async () => {
    await expect(withTourDeadline('colour emphasis', Promise.reject(Error('Mol* refused the layer.')), 5_000))
      .rejects.toThrow('Mol* refused the layer.');
  });

  it('keeps the bounds generous enough that no healthy Quest chapter reaches them', () => {
    expect(TOUR_OPERATION_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(TOUR_SCENE_TIMEOUT_MS).toBeGreaterThan(TOUR_OPERATION_TIMEOUT_MS);
  });

  it('bounds the scene as a whole, including the wait for the workspace queue', () => {
    const source = readFileSync(new URL('../src/tour-player.ts', import.meta.url), 'utf8');
    // A rollback that outlasts its own bound answers through `answered`, so
    // the caller still hears within this net while the queue stays held.
    expect(source).toContain("withTourDeadline('scene', Promise.race([answered, workspace.runTour(");
    // The scene net scales with the loaded tier, and `tourSceneTimeoutMs` is
    // never tighter than TOUR_SCENE_TIMEOUT_MS.
    expect(source).toContain('tourSceneTimeoutMs(workspace.snapshot().atomCount));');
    // Every await inside `visit` is bounded; an unbounded one is the bug.
    expect(source).not.toMatch(/await workspace\.viewer\.inspection\.restore\(/u);
  });

  // The bound rejecting is what the wearer is told about; the work it gave up
  // on is still on the workspace queue. Until this, that work
  // stayed admitted, so a rebuild that landed a few seconds after "Tour paused"
  // painted the chapter anyway — and the player then read its own late paint as
  // a takeover and stripped the colours straight back off.
  it('stops admitting the work still in flight once the scene has missed its deadline', async () => {
    const intents = createTourIntentGate();
    const { calls, workspace } = lateScene();
    const token = intents.issue();
    const admitted = () => intents.isCurrent(token);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const scene = held.then(() => applyTourStep(workspace, lateStep, admitted, false));
    await expect(withTourDeadline('scene', scene, 20)).rejects.toThrow(/scene did not finish/u);
    // What `visit` does with that rejection, and the whole of the fix.
    if (intents.isCurrent(token)) intents.invalidate();
    release(); await scene;
    expect(calls).toEqual([]);
  });

  it('leaves a scene that is merely slow alone, so the same work still paints', async () => {
    const intents = createTourIntentGate();
    const { calls, workspace } = lateScene();
    const token = intents.issue();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const scene = held.then(() => applyTourStep(workspace, lateStep, () => intents.isCurrent(token), false));
    release(); await scene;
    expect(calls.map(call => call.split(':')[0])).toEqual(['place', 'motion', 'configure', 'emphasize']);
  });

  it('cancels its own intent when the scene fails, and never a newer visit’s', () => {
    const source = readFileSync(new URL('../src/tour-player.ts', import.meta.url), 'utf8');
    // The failure path of `visit`: give up the work before the status is set.
    expect(source).toMatch(/if \(intents\.isCurrent\(token\)\) intents\.invalidate\(\);\n\s*autoplay = false; setStatus\(.Tour paused/);
    // A visit that was already superseded — Next pressed twice — must not
    // cancel the press that superseded it, so the guard is not optional.
    expect(source).not.toMatch(/setStatus\(.Tour paused[\s\S]{0,200}intents\.invalidate\(\)/);
  });

  // `spokenLine` is what stops one scene from being narrated twice while it is
  // on screen. Nothing ever cleared it,
  // so a wearer who paused, explored, and pressed Rejoin lesson got the scene
  // back without a word — the line it wanted to say was the line it had said
  // before they left. Every edge that ends a visit now forgets it; `speakScene`
  // keeps the check, so a repeat inside one visit still dedupes.
  it('forgets the line it has spoken whenever a visit ends', () => {
    const source = readFileSync(new URL('../src/tour-player.ts', import.meta.url), 'utf8');
    const speak = source.slice(source.indexOf('const speakScene'), source.indexOf('const applyIntent'));
    expect(speak).toContain('line === spokenLine');
    const forget = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));
    // Pause covers rejoin, explore, the tour menu and the starting-view
    // restore, which all pause before they move.
    expect(forget('const pause = (reason', 'const state = (')).toContain('forgetSpokenLine()');
    expect(forget('const begin = (autoStart', 'const select = (')).toContain('forgetSpokenLine()');
    expect(forget('const select = (id', 'const replaceTours = (')).toContain('forgetSpokenLine()');
    expect(forget('const replaceTours = (', 'const cycleTour = (')).toContain('forgetSpokenLine()');
    expect(forget('notifyMutation(snapshot, options)', 'stop(reason =')).toContain('forgetSpokenLine()');
    expect(source.slice(source.indexOf('stop(reason ='))).toContain('forgetSpokenLine()');
    // rejoin() reaches the same clear through pause rather than repeating it.
    expect(forget('const rejoin = (', 'const restoreStart = (')).toContain('pause(');
  });

  // A chapter line that had to wait for the speaker needs one question
  // answered before it is finally spoken — is the
  // lesson still on this line? `spokenLine` already is that answer, so it is
  // published rather than duplicated: every edge that ends a visit clears it,
  // and a microphone press is one of them (it pauses the tour first).
  it('publishes the line the lesson is currently narrating', () => {
    const source = readFileSync(new URL('../src/tour-player.ts', import.meta.url), 'utf8');
    expect(source).toContain('narratingLine: () => spokenLine');
    const surface = source.slice(source.indexOf('export type TourPlayer = Readonly<{'), source.indexOf('function residueNumbers('));
    expect(surface).toContain('narratingLine(): string | undefined;');
  });

  it('records a narration that never returns instead of letting it hang or go silent', () => {
    const source = readFileSync(new URL('../src/tour-player.ts', import.meta.url), 'utf8');
    // The bound and the record moved into
    // `spokenTurn`, which is what every fired-and-forgotten spoken line on this
    // player goes through — the chapter's own line and the failed-highlight
    // aside alike. The rule is unchanged and now covers both of them.
    const bound = source.slice(source.indexOf('const spokenTurn'), source.indexOf('const applyIntent'));
    // Never awaited by the scene, never unhandled, never invisible afterwards.
    expect(bound).toContain("withTourDeadline('narration'");
    expect(bound).toContain("record('narration', { ...detail, outcome: 'error'");
    expect(bound).not.toMatch(/\bawait narrate\(/u);
    expect(bound).not.toMatch(/\bawait aside\(/u);
    // Both spoken lines are bounded by that one helper, and neither by hand.
    expect(bound).toContain('narrationTurn = spokenTurn(narrate(line) as unknown);');
    expect(bound).toContain('spokenTurn(aside(EMPHASIS_FAILURE_LINE) as unknown');
  });

  // The caption's reading window is measured against
  // `performance.now()` in `spatial-toolbar.mjs`. A wall-clock stamp would be
  // an epoch number thirteen digits long, which closes the window before it
  // opens, so the stamp has to be on the readout's own clock and has to be
  // absent whenever there is no live chapter to read.
  it('stamps the chapter start on the readout clock, and clears it off a chapter', () => {
    const source = readFileSync(new URL('../src/tour-player.ts', import.meta.url), 'utf8');
    expect(source).toContain('chapterStartedAt?: number;');
    expect(source).toContain('chapterStartedAt = readoutClock();');
    expect(source).not.toContain('chapterStartedAt = Date.now();');
    expect(source).toContain('globalThis.performance?.now?.() ?? Date.now()');
    // Every route that leaves a chapter forgets the window: select, open menu,
    // replace the catalog, restore the starting view, and a fresh play.
    expect(source.match(/chapterStartedAt = undefined;/gu)?.length).toBeGreaterThanOrEqual(5);
  });
});

describe('cinematic playback & motion scheduling', () => {
  it('exports timing constants for autoplay dwell and framing travel', () => {
    expect(TOUR_AUTOPLAY_DWELL_MS).toBe(2500);
    expect(TOUR_FRAMING_TRAVEL_MS).toBe(1000);
  });

  it('computes symmetric easeInOut S-curve transitions', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.25)).toBeCloseTo(0.0625, 4);
    expect(easeInOut(0.75)).toBeCloseTo(0.9375, 4);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 5);
  });

  it('normalizes legacy and authored chapter motions', () => {
    expect(normalizeChapterMotion(undefined)).toBeUndefined();
    expect(normalizeChapterMotion('spin')).toEqual({ kind: 'turntable', continuous: true });
    expect(normalizeChapterMotion('hold')).toEqual({ kind: 'hold' });
    expect(normalizeChapterMotion({ kind: 'orbit', degrees: 20, seconds: 8, axis: 'y' })).toEqual({
      kind: 'orbit', degrees: 20, seconds: 8, axis: 'y'
    });
    expect(normalizeChapterMotion({ kind: 'dolly', metres: 0.15, seconds: 8 })).toEqual({
      kind: 'dolly', metres: 0.15, seconds: 8
    });
    expect(normalizeChapterMotion({ kind: 'turntable', degrees: 25, seconds: 8 })).toEqual({
      kind: 'turntable', continuous: false, degrees: 25, seconds: 8
    });
  });

  it('calculates tourStepDwellMs from narration length plus dwell constant', () => {
    expect(tourStepDwellMs(undefined, 1000)).toBe(1000);
    expect(tourStepDwellMs({ id: 's1', title: 'S1', narration: '' })).toBe(2500);
    // 6 words narration: ceil(6/3 * 1000) = 2000 ms; 2000 + 2500 = 4500 ms
    const stepWithNarration: TourStep = {
      id: 's2',
      title: 'S2',
      narration: 'One two three four five six.'
    };
    expect(tourStepDwellMs(stepWithNarration)).toBe(4500);
    // Respects explicit step.durationMs if higher
    const stepWithDuration: TourStep = {
      id: 's3',
      title: 'S3',
      narration: 'Short',
      durationMs: 8000
    };
    expect(tourStepDwellMs(stepWithDuration)).toBe(8000);
  });

  const setupMockDom = () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const elements: Record<string, unknown> = {};
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;

    const makeElement = (tag = 'div') => {
      const el: Record<string, unknown> = {
        tagName: tag.toUpperCase(),
        dataset: {} as Record<string, string>,
        className: '',
        innerHTML: '',
        textContent: '',
        value: '',
        hidden: false,
        disabled: false,
        children: [] as unknown[],
        attributes: {} as Record<string, string>,
        setAttribute: (k: string, v: string) => { (el.attributes as Record<string, string>)[k] = v; },
        getAttribute: (k: string) => (el.attributes as Record<string, string>)[k],
        removeAttribute: (k: string) => { delete (el.attributes as Record<string, string>)[k]; },
        append: (...nodes: unknown[]) => { (el.children as unknown[]).push(...nodes); },
        replaceChildren: (...nodes: unknown[]) => { el.children = [...nodes]; },
        after: vi.fn(),
        addEventListener: (evt: string, cb: (...args: unknown[]) => void) => {
          listeners[evt] = listeners[evt] || [];
          listeners[evt].push(cb);
        },
        querySelector: (sel: string) => elements[sel] ?? makeElement(),
        querySelectorAll: (sel: string) => [elements[sel]].filter(Boolean),
      };
      return el;
    };

    const selectors = [
      '[data-tour-menu]', '[data-tour-summary]', '[data-tour-progress]',
      '[data-tour-title]', '[data-tour-body]', '[data-tour-sources]', '[data-tour-details-disclosure]', '[data-tour-details]',
      '[data-tour-status]', '[data-tour-start]', '[data-tour-rejoin]',
      '[data-tour-back]', '[data-tour-next]', '[data-tour-play]',
      '[data-tour-pace]', '[data-tour-restart]', '[data-tour-restore]',
      '[data-tour-menu-button]', '.tour-player-scene', '[data-tour-scroll-hint]'
    ];
    for (const s of selectors) {
      elements[s] = makeElement();
    }

    const root = makeElement('section');
    root.querySelector = ((sel: string) => elements[sel] ?? makeElement()) as any;

    const originalDoc = (globalThis as any).document;
    const originalWin = (globalThis as any).window;

    (globalThis as any).document = {
      createElement: (tag: string) => (tag === 'section' ? root : makeElement(tag)),
      body: { dataset: {} },
      hidden: false,
      addEventListener: (evt: string, cb: (...args: unknown[]) => void) => {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(cb);
      },
      removeEventListener: vi.fn(),
    };

    (globalThis as any).window = {
      requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
      cancelAnimationFrame: (id: number) => frames.delete(id),
      addEventListener: (evt: string, cb: (...args: unknown[]) => void) => {
        listeners[evt] = listeners[evt] || [];
        listeners[evt].push(cb);
      },
      removeEventListener: vi.fn(),
    };

    const mountAnchor = makeElement('div');

    return {
      elements,
      root,
      dispatch: (event: string) => { for (const listener of listeners[event] ?? []) listener(); },
      frame: () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); },
      pendingFrames: () => frames.size,
      mountAnchor: mountAnchor as unknown as Element,
      setHidden: (hidden: boolean) => {
        (globalThis as any).document.hidden = hidden;
        for (const listener of listeners.visibilitychange ?? []) listener();
      },
      restore: () => {
        (globalThis as any).document = originalDoc;
        (globalThis as any).window = originalWin;
      }
    };
  };

  const testTours: readonly Tour[] = [
    {
      id: 'tour-1',
      title: 'Microtubule Growth',
      summary: 'Cinematic tour of microtubule growth',
      steps: [
        {
          id: 'step-1',
          title: 'Monomer',
          narration: 'Tubulin starts as an isolated monomer.', // 6 words: 2000ms + 2500ms = 4500ms
          motion: { kind: 'turntable', degrees: 25, seconds: 8 },
        },
        {
          id: 'step-2',
          title: 'Dimer',
          narration: 'Alpha and beta tubulin form a heterodimer.', // 7 words: 2334ms + 2500ms = 4834ms
          motion: { kind: 'orbit', degrees: 20, seconds: 8, axis: 'y' },
        },
        {
          id: 'step-3',
          title: 'Protofilament',
          narration: 'Dimers align head to tail.', // 5 words: 1667ms + 2500ms = 4167ms
          motion: { kind: 'dolly', metres: 0.15, seconds: 8 },
        },
        {
          id: 'step-4',
          title: 'Tube',
          narration: 'The wall curves into a tube.',
          motion: { kind: 'turntable', degrees: 30, seconds: 8 },
        },
      ],
    },
  ];

  const createMockWorkspace = () => {
    const calls: { kind: string; args: unknown[] }[] = [];
    const note = (kind: string) => async (...args: unknown[]) => {
      calls.push({ kind, args });
      return undefined;
    };
    const workspace = {
      snapshot: () => ({ ready: true, sourceSha256: 'a', xrPresenting: true, selectionKeys: ['A:8'] }),
      rows: () => rows,
      capture: () => ({ camera: {} }),
      runTour: async (action: () => Promise<void>) => action(),
      setStatus: () => undefined,
      viewer: {
        select: note('select'),
        focus: note('focus'),
        inspection: {
          configure: note('configure'),
          place: note('place'),
          fit: note('fit'),
          resetOrientation: note('reset'),
          orbit: note('orbit'),
          dolly: note('dolly'),
          setMotion: note('motion'),
          restore: note('restore'),
        },
      },
    } as unknown as Workspace;
    return { calls, workspace };
  };

  const revealTour: Tour = { id: 'reveal-wall', title: 'Wall', summary: 'Cumulative chain reveal', steps: [
    { id: 'alpha', title: 'Alpha', visibility: { op: 'only', chains: ['A-2'], classes: ['polymer'] } },
    { id: 'dimer', title: 'Dimer', visibility: { op: 'only', chains: ['A-2', 'B-2'], classes: ['polymer'] } },
    { id: 'above', title: 'Above', visibility: { op: 'only', chains: ['A-2', 'B-2', 'A-3'], classes: ['polymer'] } },
  ] };

  it('opens a changed caption at its beginning while preserving reading position on Pause', async () => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    const caption = dom.elements['.tour-player-scene'] as { scrollTop: number };
    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(false);
      caption.scrollTop = 180;
      player.pause();
      expect(caption.scrollTop).toBe(180);
      await player.next();
      expect(caption.scrollTop).toBe(0);
      caption.scrollTop = 90;
      await player.back();
      expect(caption.scrollTop).toBe(0);
    } finally { dom.restore(); }
  });

  it('keeps caption writes out of layout reads and preserves unchanged caption/source nodes', async () => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    const originalObserver = globalThis.ResizeObserver;
    let notify!: () => void;
    const observed = new Set<Element>();
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { notify = callback; }
      observe(element: Element) { observed.add(element); }
      disconnect() { observed.clear(); }
      unobserve(element: Element) { observed.delete(element); }
    } as unknown as typeof ResizeObserver;
    const caption = dom.elements['.tour-player-scene'] as HTMLDivElement;
    const hint = dom.elements['[data-tour-scroll-hint]'] as HTMLSpanElement;
    let reads = 0, height = 100, scrollHeight = 300, scrollTop = 0;
    Object.defineProperties(caption, {
      clientHeight: { get: () => { reads++; return height; } },
      scrollHeight: { get: () => { reads++; return scrollHeight; } },
      scrollTop: { get: () => { reads++; return scrollTop; }, set: value => { scrollTop = value; } },
    });
    const sources = dom.elements['[data-tour-sources]'] as HTMLParagraphElement;
    const rebuildSources = vi.spyOn(sources, 'replaceChildren');
    const chapter = { id: 'same', title: 'Same chapter', body: 'A readable caption.', sources: [{ title: 'Original source', url: 'https://example.org/first' }] };
    let bodyWrites = 0, bodyValue = '';
    Object.defineProperty(dom.elements['[data-tour-body]'], 'textContent', {
      get: () => bodyValue, set: value => { bodyWrites++; bodyValue = value; },
    });
    try {
      const player = mountTourPlayer({ workspace, tours: [{ id: 'caption', title: 'Caption', summary: 'Overview', steps: [chapter] }], after: dom.mountAnchor });
      await player.select('caption'); await player.start(false);
      expect(reads).toBe(0);
      expect(observed).toEqual(new Set(['.tour-player-scene', '[data-tour-progress]', '[data-tour-title]', '[data-tour-body]', '[data-tour-sources]', '[data-tour-details-disclosure]', '[data-tour-status]'].map(selector => dom.elements[selector])));
      notify(); expect(reads).toBe(3); expect(hint.hidden).toBe(false);
      const nodes = [...sources.children], rebuilds = rebuildSources.mock.calls.length, writes = bodyWrites;
      scrollTop = 180;
      for (let i = 0; i < 8; i++) player.pause();
      expect(scrollTop).toBe(180);
      expect(reads).toBe(3);
      expect(bodyWrites).toBe(writes); expect(rebuildSources).toHaveBeenCalledTimes(rebuilds);
      expect(sources.children).toEqual(nodes);
      // Same-sized text still updates, but only the browser's post-layout
      // observer decides whether overflow needs another measurement.
      chapter.body = 'Another caption.'; player.pause();
      expect(scrollTop).toBe(0); expect(bodyValue).toBe(chapter.body); expect(reads).toBe(3);
      expect(rebuildSources).toHaveBeenCalledTimes(rebuilds);
      scrollTop = 50;
      chapter.sources = [{ title: 'Replacement source', url: 'https://example.org/second' }]; player.pause();
      expect(scrollTop).toBe(0); expect(rebuildSources).toHaveBeenCalledTimes(rebuilds + 1);
      expect((sources.children[1] as HTMLAnchorElement).href).toBe('https://example.org/second');
      scrollHeight = 90; notify(); expect(hint.hidden).toBe(true);
      height = 0; const beforeHidden = reads; notify(); expect(reads).toBe(beforeHidden + 1);
      dom.dispatch('pagehide'); expect(observed.size).toBe(0);
      const beforeSuspended = reads; notify(); expect(reads).toBe(beforeSuspended);
      dom.dispatch('pageshow'); expect(observed.size).toBe(7);
      height = 100; scrollHeight = 300; notify(); expect(hint.hidden).toBe(false);
    } finally { dom.dispatch('pagehide'); globalThis.ResizeObserver = originalObserver; dom.restore(); }
  });

  it('coalesces caption scroll/resize fallback after paint and cancels hidden or detached work', async () => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    const originalObserver = globalThis.ResizeObserver;
    (globalThis as any).ResizeObserver = undefined;
    vi.useFakeTimers();
    const caption = dom.elements['.tour-player-scene'] as HTMLDivElement;
    const hint = dom.elements['[data-tour-scroll-hint]'] as HTMLSpanElement;
    let reads = 0, height = 100, scrollTop = 0;
    Object.defineProperties(caption, {
      clientHeight: { get: () => { reads++; return height; } },
      scrollHeight: { get: () => { reads++; return 300; } },
      scrollTop: { get: () => { reads++; return scrollTop; }, set: value => { scrollTop = value; } },
    });
    const paint = () => { dom.frame(); vi.runOnlyPendingTimers(); };
    try {
      const player = mountTourPlayer({ workspace, tours: [{ id: 'caption', title: 'Caption', summary: 'Overview', steps: [{ id: 'one', title: 'One', body: 'Full body' }] }], after: dom.mountAnchor });
      await player.select('caption'); await player.start(false);
      expect(reads).toBe(0); expect(dom.pendingFrames()).toBe(1);
      dom.frame(); expect(reads).toBe(0); vi.runOnlyPendingTimers();
      expect(reads).toBe(3); expect(hint.hidden).toBe(false);
      // Native details can resize the reading region without any player write
      // or viewport resize, including in a browser without ResizeObserver.
      height = 350; dom.dispatch('toggle'); expect(dom.pendingFrames()).toBe(1); expect(reads).toBe(3);
      paint(); expect(hint.hidden).toBe(true);
      height = 100; dom.dispatch('toggle'); paint(); expect(hint.hidden).toBe(false);
      const beforePause = reads;
      player.pause(); player.pause(); expect(dom.pendingFrames()).toBe(1); expect(reads).toBe(beforePause);
      paint(); const settled = reads; player.pause(); expect(dom.pendingFrames()).toBe(0); expect(reads).toBe(settled);
      scrollTop = 200; dom.dispatch('scroll'); dom.dispatch('scroll'); dom.dispatch('resize');
      expect(dom.pendingFrames()).toBe(1); expect(reads).toBe(settled); paint(); expect(hint.hidden).toBe(true);
      // Pagehide can itself call Pause/sync; the lifecycle cancellation still
      // removes both the previously queued frame and any after-paint timer.
      dom.dispatch('resize'); dom.dispatch('pagehide'); expect(dom.pendingFrames()).toBe(0);
      const hiddenReads = reads; vi.runOnlyPendingTimers(); expect(reads).toBe(hiddenReads);
      dom.dispatch('pageshow'); dom.frame(); expect(vi.getTimerCount()).toBe(1);
      dom.dispatch('pagehide'); vi.runOnlyPendingTimers(); expect(reads).toBe(hiddenReads);
      dom.dispatch('pageshow'); paint(); expect(reads).toBe(hiddenReads + 3);
      dom.setHidden(true); dom.dispatch('resize'); expect(dom.pendingFrames()).toBe(0);
      dom.setHidden(false); expect(dom.pendingFrames()).toBe(1); paint();
      dom.dispatch('resize'); dom.root.isConnected = false;
      const beforeDetached = reads; paint(); expect(reads).toBe(beforeDetached);
      dom.dispatch('resize'); expect(dom.pendingFrames()).toBe(0);
      dom.root.isConnected = true; dom.dispatch('pageshow'); paint(); expect(reads).toBe(beforeDetached + 3);
    } finally { dom.dispatch('pagehide'); vi.useRealTimers(); globalThis.ResizeObserver = originalObserver; dom.restore(); }
  });

  it('replays exact visible subsets through Next, cached Back, Rejoin, and Restore start', async () => {
    const dom = setupMockDom(), h = visibilityHarness(), baseline = h.capture();
    try {
      const player = mountTourPlayer({ workspace: h.workspace, tours: [revealTour], after: dom.mountAnchor });
      await player.select(revealTour.id);
      await player.start(false);
      expect(player.getState().step).toBe(0);
      const alpha = h.capture().visibility;
      await player.next();
      const dimer = h.capture().visibility;
      expect(dimer.hiddenChains.map(chain => chain.labelChain)).toEqual(['A-3', 'C-2']);
      await player.back();
      expect(h.capture().visibility).toEqual(alpha);
      await player.next();
      expect(h.capture().visibility).toEqual(dimer);
      player.stop();
      await applyTourVisibility(h.workspace, { op: 'only', chains: ['A-3'] });
      await player.rejoin();
      expect(h.capture().visibility).toEqual(dimer);
      await player.restoreStart();
      expect(h.capture().visibility).toEqual(baseline.visibility);
      expect(h.capture().camera).toEqual(baseline.camera);
      expect(h.calls).not.toContain('fit');
    } finally { dom.restore(); }
  });

  it('continues a forward reveal after a wearer grip at the live transform', async () => {
    const dom = setupMockDom(), h = visibilityHarness();
    try {
      const player = mountTourPlayer({ workspace: h.workspace, tours: [revealTour], after: dom.mountAnchor });
      await player.select(revealTour.id);
      await player.start(false);
      h.move();
      player.notifyMutation(h.workspace.snapshot());
      expect(player.getState().stopped).toBe(false);
      const moved = h.capture(); h.calls.length = 0;
      await player.next();
      expect(player.getState().step).toBe(1);
      expect(h.capture().placement).toEqual(moved.placement);
      expect(h.capture().camera).toEqual(moved.camera);
      expect(h.capture().visibility.hiddenChains.map(chain => chain.labelChain)).toEqual(['A-3', 'C-2']);
      expect(h.calls).toEqual(['emphasize', 'visibility']);
      await player.next();
      expect(h.capture().placement).toEqual(moved.placement);
      expect(h.capture().visibility.hiddenChains.map(chain => chain.labelChain)).toEqual(['C-2']);
      expect(h.calls).not.toContain('restore');
      expect(h.calls).not.toContain('place');
    } finally { dom.restore(); }
  });

  it('keeps source details safe, optional and open across chapter changes without entering the HUD', async () => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    const tour = structuredClone(testTours[0]);
    const original = tour.steps[0];
    const hostileText = '<img src=x onerror=alert(1)> & original UUID\nPredicted complex';
    tour.steps = [
      { ...original, id: 'details-one', details: hostileText },
      { ...original, id: 'details-two', details: 'Second original identifier' },
      { ...original, id: 'no-details' },
      { ...original, id: 'details-again', details: 'Final source' },
    ];
    const disclosure = dom.elements['[data-tour-details-disclosure]'] as HTMLDetailsElement;
    const details = dom.elements['[data-tour-details]'] as HTMLParagraphElement;
    try {
      const player = mountTourPlayer({ workspace, tours: [tour], after: dom.mountAnchor });
      await player.select(tour.id);
      expect(disclosure.hidden).toBe(true);
      await player.start(false);
      expect(disclosure.hidden).toBe(false);
      expect(details.textContent).toBe(hostileText);
      expect(details.innerHTML).toBe('');
      expect(details.children).toHaveLength(0);
      expect(player.getState().body).toBe(captionLine(original));
      expect(player.getState()).not.toHaveProperty('details');
      disclosure.open = true;
      await player.next();
      expect(details.textContent).toBe('Second original identifier');
      expect(disclosure.open).toBe(true);
      await player.next();
      expect(disclosure.hidden).toBe(true);
      expect(details.textContent).toBe('');
      expect(disclosure.open).toBe(true);
      await player.next();
      expect(disclosure.hidden).toBe(false);
      expect(disclosure.open).toBe(true);
      disclosure.open = false;
      await player.back(); await player.back();
      expect(disclosure.hidden).toBe(false);
      expect(disclosure.open).toBe(false);
      expect(details.textContent).toBe('Second original identifier');
    } finally { dom.restore(); }
  });

  it('renders local modelled sources as text beside deposited source links', async () => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    const tour = structuredClone(testTours[0]);
    tour.steps[0].sources = [
      { title: 'Local modelled source: linkers.cif — Idealised linkers' },
      { title: 'Structure source', url: 'https://www.rcsb.org/structure/5SYF' },
    ];
    try {
      const player = mountTourPlayer({ workspace, tours: [tour], after: dom.mountAnchor });
      await player.select(tour.id);
      await player.start(false);
      const children = (dom.elements['[data-tour-sources]'] as any).children;
      expect(children).toContain('Local modelled source: linkers.cif — Idealised linkers');
      const links = children.filter((child: any) => child.tagName === 'A');
      expect(links).toHaveLength(1);
      expect(links[0].href).toBe('https://www.rcsb.org/structure/5SYF');
    } finally { dom.restore(); }
  });

  it.each([false, true])('keeps every telomerase chapter\'s plates on first play and cached replay (omit emphasis: %s)', async omitEmphasis => {
    const dom = setupMockDom();
    const { workspace } = createMockWorkspace();
    const tour = molecularLessonToTour(JSON.parse(readFileSync(new URL('../demos/telomerase-haca.json', import.meta.url), 'utf8')));
    if (omitEmphasis) for (const step of tour.steps.slice(1)) delete step.emphasis;
    // One plate per part the chapter names; a chapter without emphasis keeps the first chapter's.
    const platesAt = (i: number) => (tour.steps[i]!.emphasis ?? tour.steps[0]!.emphasis)!.parts!.length;
    let painted: any;
    const plates = createComponentLabelSession({ isPresenting: () => true, wantsLabels: () => true,
      buildPlates: async () => planComponentLabels(painted, (part: any) => [part.chain]).colours.map((part: any) => part.id),
      deletePlates: async () => {},
    });
    workspace.viewer.inspection.emphasize = async value => {
      painted = value;
      await plates.rebuild();
    };
    vi.useFakeTimers();
    try {
      const player = mountTourPlayer({ workspace, tours: [tour], after: dom.mountAnchor });
      await player.select(tour.id);
      await player.start(false);
      for (let i = 0; i < tour.steps.length; i++) {
        if (i) await player.next();
        expect(player.getState().step).toBe(i);
        expect(plates.refs(), `first play ${tour.steps[i]!.id}`).toHaveLength(platesAt(i));
        if (!tour.steps[i]!.emphasis) {
          expect(painted.parts).toEqual(tour.steps[0]!.emphasis!.parts);
          expect(painted.focus).toBeUndefined();
        }
      }
      for (let i = tour.steps.length - 2; i >= 0; i--) {
        await player.back();
        expect(player.getState().step).toBe(i);
        expect(plates.refs(), `cached ${tour.steps[i]!.id}`).toHaveLength(platesAt(i));
      }
      player.pause();
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it('autoplays tours by default and advances through chapters based on dwell timing', async () => {
    const dom = setupMockDom();
    const { workspace } = createMockWorkspace();
    vi.useFakeTimers();

    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1');
      await player.start(true);

      expect(player.getState().autoplay).toBe(true);
      expect(player.getState().step).toBe(0);
      expect(player.getState().motionRunning).toBe(true);
      expect(player.getState().motionKind).toBe('turntable');

      // Step 1 dwell = 4500ms
      await vi.advanceTimersByTimeAsync(4500);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(player.getState().step).toBe(1);
      expect(player.getState().autoplay).toBe(true);
      expect(player.getState().motionRunning).toBe(true);
      expect(player.getState().motionKind).toBe('orbit');

      // Step 2 dwell = 4834ms
      await vi.advanceTimersByTimeAsync(4834);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(player.getState().step).toBe(2);
      expect(player.getState().autoplay).toBe(true);
      expect(player.getState().motionRunning).toBe(true);
      expect(player.getState().motionKind).toBe('dolly');
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  it('pauses autoplay and chapter motion when wearer pauses, and resumes on togglePlay or rejoin', async () => {
    const dom = setupMockDom();
    const { workspace } = createMockWorkspace();
    vi.useFakeTimers();

    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1');
      await player.start(true);

      expect(player.getState().autoplay).toBe(true);
      expect(player.getState().step).toBe(0);

      // Wearer says "pause"
      player.pause('wearer-paused');
      expect(player.getState().autoplay).toBe(false);
      expect(player.getState().motionRunning).toBe(false);

      // Time passes while paused; scene does not advance
      await vi.advanceTimersByTimeAsync(10000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(player.getState().step).toBe(0);

      // Wearer hits togglePlay (or says "play" / "continue")
      await player.togglePlay();
      expect(player.getState().autoplay).toBe(true);

      // Wearer can pause again and resume via rejoin(true)
      player.pause('voice-pause');
      expect(player.getState().autoplay).toBe(false);

      await player.rejoin(true);
      expect(player.getState().autoplay).toBe(true);
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  it('schedules eased motion ticks during a chapter and stops on wearer grab/takeover', async () => {
    const dom = setupMockDom();
    const { calls, workspace } = createMockWorkspace();
    vi.useFakeTimers();

    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1');
      await player.start(true);

      // Advance to step 1 which has orbit
      await player.next();
      expect(player.getState().step).toBe(1);
      expect(player.getState().motionRunning).toBe(true);
      expect(player.getState().motionKind).toBe('orbit');

      // Tick through 500ms of motion (10 ticks)
      const orbitCallsBefore = calls.filter(c => c.kind === 'orbit').length;
      await vi.advanceTimersByTimeAsync(500);
      const orbitCallsAfter = calls.filter(c => c.kind === 'orbit').length;
      expect(orbitCallsAfter).toBeGreaterThan(orbitCallsBefore);

      // Wearer grabs the molecule -> notifyMutation stops chapter motion
      player.notifyMutation(workspace.snapshot());
      expect(player.getState().motionRunning).toBe(false);

      // Further ticks do not produce more orbit calls for this chapter
      const orbitCallsStopped = calls.filter(c => c.kind === 'orbit').length;
      await vi.advanceTimersByTimeAsync(500);
      expect(calls.filter(c => c.kind === 'orbit').length).toBe(orbitCallsStopped);
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  it('keeps playback and labels through a grip, freezing only automatic motion until release', async () => {
    const dom = setupMockDom(), { workspace, calls } = createMockWorkspace();
    vi.useFakeTimers();
    let held = false;
    const snapshot = workspace.snapshot;
    workspace.snapshot = () => ({ ...snapshot(), interactionActive: held });
    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(true); await player.next();
      await vi.advanceTimersByTimeAsync(300);
      held = true; player.notifyMutation(undefined, { interaction: true });
      player.notifyMutation(workspace.snapshot()); // presentation freeze while held
      const count = calls.filter(c => c.kind === 'orbit').length;
      await vi.advanceTimersByTimeAsync(500);
      expect(calls.filter(c => c.kind === 'orbit')).toHaveLength(count);
      expect(player.getState()).toMatchObject({ autoplay: true, stopped: false, step: 1 });
      held = false; player.notifyMutation(workspace.snapshot()); // release bake
      await vi.advanceTimersByTimeAsync(50);
      expect(calls.filter(c => c.kind === 'orbit')).toHaveLength(count + 1);
      expect(Math.abs(Number(calls.filter(c => c.kind === 'orbit').at(-1)?.args[1]))).toBeLessThan(.1);
      expect(player.getState().autoplay).toBe(true);
      player.notifyMutation({ sourceSha256: 'different', xrPresenting: true }, { agent: true });
      expect(player.getState()).toMatchObject({ autoplay: false, stopped: true });
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it.each([false, true])('resumes a continuous turn only after the grip releases with autoplay=%s', async autoplay => {
    const dom = setupMockDom(), { workspace, calls } = createMockWorkspace();
    vi.useFakeTimers(); let held = false;
    const snapshot = workspace.snapshot;
    workspace.snapshot = () => ({ ...snapshot(), interactionActive: held });
    const tours: Tour[] = [{ ...testTours[0], steps: [{ ...testTours[0].steps[0], motion: 'spin' }, testTours[0].steps[1]] }];
    try {
      const player = mountTourPlayer({ workspace, tours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(autoplay);
      const count = calls.filter(c => c.kind === 'motion').length;
      held = true; player.notifyMutation(undefined, { interaction: true });
      await vi.advanceTimersByTimeAsync(300);
      expect(calls.filter(c => c.kind === 'motion')).toHaveLength(count);
      held = false; player.notifyMutation(workspace.snapshot());
      await vi.advanceTimersByTimeAsync(50);
      expect(calls.filter(c => c.kind === 'motion')).toHaveLength(count + 1);
      expect(calls.filter(c => c.kind === 'motion').at(-1)?.args[0]).toEqual({ paused: false });
      await vi.advanceTimersByTimeAsync(300);
      expect(calls.filter(c => c.kind === 'motion')).toHaveLength(count + 1);
      expect(player.getState()).toMatchObject({ autoplay, stopped: false, step: 0 });
      player.pause();
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it.each(['pause', 'stop', 'source change'] as const)('cancels continuous-turn grip recovery on %s', async cancellation => {
    const dom = setupMockDom(), { workspace, calls } = createMockWorkspace();
    vi.useFakeTimers(); let held = false, sourceSha256 = 'a';
    const snapshot = workspace.snapshot;
    workspace.snapshot = () => ({ ...snapshot(), sourceSha256, interactionActive: held });
    const tours: Tour[] = [{ ...testTours[0], steps: [{ ...testTours[0].steps[0], motion: 'spin' }] }];
    try {
      const player = mountTourPlayer({ workspace, tours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(false);
      const count = calls.filter(c => c.kind === 'motion').length;
      held = true; player.notifyMutation(undefined, { interaction: true });
      await vi.advanceTimersByTimeAsync(100);
      if (cancellation === 'pause') player.pause();
      else if (cancellation === 'stop') player.stop();
      else { sourceSha256 = 'replacement'; player.notifyMutation(workspace.snapshot(), { agent: true }); }
      held = false; player.notifyMutation(workspace.snapshot());
      await vi.advanceTimersByTimeAsync(100);
      // A later grip must not silently rearm explicitly paused motion either.
      held = true; player.notifyMutation(undefined, { interaction: true });
      held = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(calls.filter(c => c.kind === 'motion')).toHaveLength(count);
      expect(player.getState().autoplay).toBe(false);
      if (cancellation === 'pause') {
        await player.togglePlay();
        await vi.advanceTimersByTimeAsync(50);
        expect(calls.filter(c => c.kind === 'motion')).toHaveLength(count + 1);
      }
      player.stop();
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it('waits for visibility before resuming a manual chapter continuous turn', async () => {
    const dom = setupMockDom(), { workspace, calls } = createMockWorkspace();
    vi.useFakeTimers(); let held = false;
    const snapshot = workspace.snapshot;
    workspace.snapshot = () => ({ ...snapshot(), interactionActive: held });
    const tours: Tour[] = [{ ...testTours[0], steps: [{ ...testTours[0].steps[0], motion: 'spin' }] }];
    try {
      const player = mountTourPlayer({ workspace, tours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(false);
      const count = calls.filter(c => c.kind === 'motion').length;
      held = true; player.notifyMutation(undefined, { interaction: true });
      dom.setHidden(true); held = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(calls.filter(c => c.kind === 'motion')).toHaveLength(count);
      dom.setHidden(false); await vi.advanceTimersByTimeAsync(50);
      expect(calls.filter(c => c.kind === 'motion')).toHaveLength(count + 1);
      expect(player.getState().autoplay).toBe(false);
      player.pause();
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it('defers an autoplay boundary while held and advances promptly on release', async () => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    vi.useFakeTimers(); let held = false;
    const snapshot = workspace.snapshot;
    workspace.snapshot = () => ({ ...snapshot(), interactionActive: held });
    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(true);
      held = true; player.notifyMutation(undefined, { interaction: true });
      await vi.advanceTimersByTimeAsync(tourStepDwellMs(testTours[0].steps[0]) + 1000);
      expect(player.getState()).toMatchObject({ autoplay: true, stopped: false, step: 0, navigating: false });
      held = false; player.notifyMutation(workspace.snapshot());
      await vi.advanceTimersByTimeAsync(250);
      expect(player.getState()).toMatchObject({ autoplay: true, stopped: false, step: 1 });
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it('queues a requested chapter while held, even during the gesture freeze, and keeps its placement on Back', async () => {
    const dom = setupMockDom(), h = visibilityHarness();
    vi.useFakeTimers(); let held = false;
    const snapshot = h.workspace.snapshot;
    h.workspace.snapshot = () => ({ ...snapshot(), ready: !held, interactionActive: held });
    try {
      const player = mountTourPlayer({ workspace: h.workspace, tours: [revealTour], after: dom.mountAnchor });
      await player.select(revealTour.id); await player.start(false);
      h.move(); held = true; player.notifyMutation(undefined, { interaction: true });
      const moved = h.capture().placement;
      await expect(player.next()).rejects.toThrow('waiting for the molecular drag');
      expect(player.getState()).toMatchObject({ stopped: false, step: 0, navigating: false });
      await vi.advanceTimersByTimeAsync(500);
      expect(player.getState().step).toBe(0);
      held = false; player.notifyMutation(h.workspace.snapshot());
      await vi.advanceTimersByTimeAsync(250);
      expect(player.getState().step).toBe(1);
      expect(h.capture().placement).toEqual(moved);
      await player.back();
      expect(player.getState().step).toBe(0);
      expect(h.capture().placement).toEqual(moved);
      expect(h.capture().visibility.hiddenChains.map(chain => chain.labelChain)).toContain('B-2');
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it.each(['autoplay', 'next'] as const)('waits for the release bake before advancing via %s', async route => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    vi.useFakeTimers(); let held = false, ready = true;
    const snapshot = workspace.snapshot;
    workspace.snapshot = () => ({ ...snapshot(), ready, status: ready ? 'ready' : 'mutating', interactionActive: held });
    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(route === 'autoplay');
      held = true; player.notifyMutation(undefined, { interaction: true });
      if (route === 'autoplay') await vi.advanceTimersByTimeAsync(tourStepDwellMs(testTours[0].steps[0]) + 1000);
      // Releasing the controller ends the gesture before its baked placement
      // has passed the viewer's frame gate. The molecular source is unchanged.
      held = false; ready = false;
      if (route === 'next') await expect(player.next()).rejects.toMatchObject({ code: 'viewer_not_ready' });
      await vi.advanceTimersByTimeAsync(500);
      expect(player.getState()).toMatchObject({ step: 0, stopped: false, autoplay: route === 'autoplay' });
      ready = true; player.notifyMutation(workspace.snapshot());
      await vi.advanceTimersByTimeAsync(250);
      expect(player.getState()).toMatchObject({ step: 1, stopped: false, autoplay: route === 'autoplay' });
      player.pause();
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it('rearms a deferred manual chapter after visibility returns without enabling autoplay', async () => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    vi.useFakeTimers(); let held = false;
    const snapshot = workspace.snapshot;
    workspace.snapshot = () => ({ ...snapshot(), interactionActive: held });
    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(false);
      held = true; player.notifyMutation(undefined, { interaction: true });
      await expect(player.next()).rejects.toMatchObject({ code: 'interaction_active' });
      dom.setHidden(true); await vi.advanceTimersByTimeAsync(500);
      held = false; player.notifyMutation(workspace.snapshot());
      dom.setHidden(false); await vi.advanceTimersByTimeAsync(250);
      expect(player.getState()).toMatchObject({ step: 1, stopped: false, autoplay: false });
      player.pause();
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it.each(['pause', 'source change'] as const)('cancels a settling chapter on %s even after visibility returns', async cancellation => {
    const dom = setupMockDom(), { workspace, calls } = createMockWorkspace();
    vi.useFakeTimers(); let ready = true, sourceSha256 = 'a';
    const snapshot = workspace.snapshot;
    workspace.snapshot = () => ({ ...snapshot(), ready, status: ready ? 'ready' : 'mutating', sourceSha256 });
    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(false);
      ready = false;
      await expect(player.next()).rejects.toMatchObject({ code: 'viewer_not_ready' });
      dom.setHidden(true); await vi.advanceTimersByTimeAsync(500);
      if (cancellation === 'pause') player.pause();
      else { sourceSha256 = 'replacement'; player.notifyMutation(workspace.snapshot(), { agent: true }); }
      ready = true; dom.setHidden(false);
      const count = calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(count);
      expect(player.getState()).toMatchObject({ step: 0, autoplay: false, stopped: cancellation === 'source change' });
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it('retries a mid-chapter drag admission without reporting an unrendered chapter as success', async () => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    vi.useFakeTimers(); let attempts = 0;
    const tours: Tour[] = [{ ...testTours[0], steps: [testTours[0].steps[0],
      { ...testTours[0].steps[1], appearance: { representation: 'cartoon' } }] }];
    workspace.viewer.inspection.configure = async () => {
      if (++attempts === 1) throw Object.assign(Error('Release the molecular drag.'), { code: 'interaction_active' });
    };
    try {
      const player = mountTourPlayer({ workspace, tours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(true);
      await expect(player.next()).rejects.toThrow('Release the molecular drag');
      expect(player.getState()).toMatchObject({ autoplay: true, stopped: false, step: 0 });
      await vi.advanceTimersByTimeAsync(250);
      expect(attempts).toBe(2);
      expect(player.getState()).toMatchObject({ autoplay: true, stopped: false, step: 1 });
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it('Pause cancels a deferred chapter instead of applying it later', async () => {
    const dom = setupMockDom(), { workspace } = createMockWorkspace();
    vi.useFakeTimers(); let attempts = 0;
    const tours: Tour[] = [{ ...testTours[0], steps: [testTours[0].steps[0],
      { ...testTours[0].steps[1], appearance: { representation: 'cartoon' } }] }];
    workspace.viewer.inspection.configure = async () => {
      attempts++; throw Object.assign(Error('Release the molecular drag.'), { code: 'interaction_active' });
    };
    try {
      const player = mountTourPlayer({ workspace, tours, after: dom.mountAnchor });
      await player.select('tour-1'); await player.start(true);
      await expect(player.next()).rejects.toThrow('Release the molecular drag');
      player.pause(); await vi.advanceTimersByTimeAsync(2000);
      expect(attempts).toBe(1);
      expect(player.getState()).toMatchObject({ autoplay: false, step: 0 });
    } finally { vi.useRealTimers(); dom.restore(); }
  });

  it('preserves autoplay through forward and backward manual steps', async () => {
    const dom = setupMockDom();
    const { workspace } = createMockWorkspace();
    vi.useFakeTimers();

    try {
      const player = mountTourPlayer({ workspace, tours: testTours, after: dom.mountAnchor });
      await player.select('tour-1');
      await player.start(true);

      expect(player.getState().autoplay).toBe(true);
      expect(player.getState().step).toBe(0);

      // Next pressed
      await player.next();
      expect(player.getState().step).toBe(1);
      expect(player.getState().autoplay).toBe(true);

      // Back pressed
      await player.back();
      expect(player.getState().step).toBe(0);
      expect(player.getState().autoplay).toBe(true);
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  describe('a chapter of orbit motion does not read as a wearer takeover', () => {
  // On the wall tier, the lesson's own chapter ticks travelled through
  // `orbit`/`dolly` — admitted inspection mutations — so the first orbit tick
  // reached `notifyMutation` as a wearer grab. The tour recorded
  // `tour {action:"motion", outcome:"stopped", reason:"workspace-takeover"}`,
  // interrupted itself 0.2 s into its opening chapter, stripped its own colour
  // key, and sat still waiting for a chapter that never came.
  //
  // This suite mounts the exact failure shape: a viewer whose `orbit`/`dolly`
  // ARE mutations whose `onMutation` reaches the player, and whose
  // `applyLessonMotion` is the silent entry the chapter must use. The chapter
  // ticks through the silent entry, never touches the mutation entries, and is
  // still playing at its dwell; a real mutation — the wearer's grip bake —
  // still stops it.
  const orbitChapter = (narration: string): TourStep => ({
    id: 'wide', title: 'Three wide', narration, durationMs: 4500,
    motion: { kind: 'orbit', degrees: 20, seconds: 8, axis: 'y' },
  });
  const takeoverTours: readonly Tour[] = [{
    id: 'wall', title: 'Wall', summary: 'An opening chapter that turns',
    steps: [orbitChapter('One two three four five six.'), { id: 'next', title: 'Next', narration: 'Two words here.' }],
  }];

  const takeoverWorkspace = () => {
    const calls: { kind: string; args: unknown[] }[] = [];
    let notify: (() => void) | undefined;
    const note = (kind: string) => async (...args: unknown[]) => { calls.push({ kind, args }); return undefined; };
    const workspace = {
      snapshot: () => ({ ready: true, sourceSha256: 'a', xrPresenting: true, selectionKeys: [] }),
      rows: () => rows, capture: () => ({}), runTour: async (action: () => Promise<void>) => action(),
      setStatus: () => undefined,
      viewer: {
        select: note('select'), focus: note('focus'),
        inspection: {
          configure: note('configure'), place: note('place'), fit: note('fit'),
          resetOrientation: note('reset'), setMotion: note('motion'), restore: note('restore'),
          // The real viewer's orbit/dolly are admitted mutations whose
          // committed change reaches the tour player as `onMutation` — the
          // takeover. Model exactly that: any tick that lands here fails the
          // chapter the way it failed on real hardware.
          orbit: async (...args: unknown[]) => { calls.push({ kind: 'orbit', args }); notify?.(); return undefined; },
          dolly: async (...args: unknown[]) => { calls.push({ kind: 'dolly', args }); notify?.(); return undefined; },
          // The silent entry: a camera move that is not a workspace mutation,
          // so nothing here may notify the player.
          applyLessonMotion: async (move: unknown) => { calls.push({ kind: 'applyLessonMotion', args: [move] }); return undefined; },
          // The camera equivalent of `bakeGrab`. Synchronous and never a
          // mutation, so it must not notify the player either.
          bakeLessonMotion: () => { calls.push({ kind: 'bakeLessonMotion', args: [] }); return true; },
        },
      },
    } as unknown as Workspace;
    return { calls, workspace, setNotify: (fn: () => void) => { notify = fn; } };
  };

  it('ticks the orbit chapter on the silent path, never mutates, and advances at its dwell', async () => {
    const dom = setupMockDom();
    const env = takeoverWorkspace();
    vi.useFakeTimers();

    try {
      const player = mountTourPlayer({ workspace: env.workspace, tours: takeoverTours, after: dom.mountAnchor });
      env.setNotify(() => player.notifyMutation());
      await player.select('wall');
      await player.start(true);

      expect(player.getState().step).toBe(0);
      expect(player.getState().motionRunning).toBe(true);
      expect(player.getState().motionKind).toBe('orbit');

      // 4.5 s of 50 ms ticks — the exact shape that failed on hardware, one
      // millisecond short of the dwell so the advance below is the dwell's.
      await vi.advanceTimersByTimeAsync(4499);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      // Not one tick reached the tour as a mutation.
      expect(env.calls.filter(call => call.kind === 'orbit' || call.kind === 'dolly')).toEqual([]);
      expect(env.calls.some(call => call.kind === 'applyLessonMotion')).toBe(true);
      expect(player.getState().active).toBe(true);
      expect(player.getState().stopped).toBe(false);

      // And the lesson still advances at its dwell.
      await vi.advanceTimersByTimeAsync(50);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(player.getState().step).toBe(1);
      expect(player.getState().active).toBe(true);
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  it('yields camera motion while keeping the XR chapter when the wearer takes the structure', async () => {
    const dom = setupMockDom();
    const env = takeoverWorkspace();
    vi.useFakeTimers();

    try {
      const player = mountTourPlayer({ workspace: env.workspace, tours: takeoverTours, after: dom.mountAnchor });
      env.setNotify(() => player.notifyMutation());
      await player.select('wall');
      await player.start(true);
      await vi.advanceTimersByTimeAsync(200);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(player.getState().motionRunning).toBe(true);

      // The wearer's grip bakes in its own mutation on release, and that
      // mutation — never the lesson's ticks — is what reaches the player here.
      player.notifyMutation(env.workspace.snapshot());
      expect(player.getState().motionRunning).toBe(false);
      expect(player.getState()).toMatchObject({ stopped: false, active: true });

      // The chapter's silent ticks end with the takeover and never resume.
      const silentCalls = env.calls.filter(call => call.kind === 'applyLessonMotion').length;
      await vi.advanceTimersByTimeAsync(500);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(env.calls.filter(call => call.kind === 'applyLessonMotion').length).toBe(silentCalls);
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  it('routes the dolly chapter through the silent path too', async () => {
    const dom = setupMockDom();
    const env = takeoverWorkspace();
    const dollyTours: readonly Tour[] = [{
      id: 'wall', title: 'Wall', summary: 'A dolly chapter',
      steps: [{
        id: 'closer', title: 'Closer', narration: 'One two three four five six.', durationMs: 4500,
        motion: { kind: 'dolly', metres: 0.15, seconds: 8 },
      }],
    }];
    vi.useFakeTimers();

    try {
      const player = mountTourPlayer({ workspace: env.workspace, tours: dollyTours, after: dom.mountAnchor });
      env.setNotify(() => player.notifyMutation());
      await player.select('wall');
      await player.start(true);
      await vi.advanceTimersByTimeAsync(1000);
      for (let i = 0; i < 5; i++) await Promise.resolve();

      expect(player.getState().motionKind).toBe('dolly');
      const dollied = env.calls.filter(call => call.kind === 'applyLessonMotion'
        && (call.args[0] as { kind?: string })?.kind === 'dolly');
      expect(dollied.length).toBeGreaterThan(0);
      expect(env.calls.filter(call => call.kind === 'orbit' || call.kind === 'dolly')).toEqual([]);
      expect(player.getState().active).toBe(true);
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  /**
   * The chapter's turn is a transient the viewer pins, so nothing saves it
   * until the player says the chapter is done. One bake per chapter — not one
   * per 50 ms tick, which kept the companion panel `unsaved` and refused every
   * agent command on the Quest 2.
   */
  it('bakes the chapter turn once, when the motion ends', async () => {
    const dom = setupMockDom();
    const env = takeoverWorkspace();
    // A two-second turn inside a long chapter, so the bake below is the
    // motion's own end and not the scene transition that follows it.
    const shortTurn: readonly Tour[] = [{
      id: 'wall', title: 'Wall', summary: 'A short turn in a long chapter',
      steps: [{
        id: 'wide', title: 'Three wide', narration: 'One two three four five six.', durationMs: 20_000,
        motion: { kind: 'orbit', degrees: 20, seconds: 2, axis: 'y' },
      }, { id: 'next', title: 'Next', narration: 'Two words here.' }],
    }];
    vi.useFakeTimers();
    try {
      const player = mountTourPlayer({ workspace: env.workspace, tours: shortTurn, after: dom.mountAnchor });
      env.setNotify(() => player.notifyMutation());
      await player.select('wall');
      await player.start(true);
      // Mid-chapter: ticking, and nothing baked yet.
      await vi.advanceTimersByTimeAsync(1_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(env.calls.filter(call => call.kind === 'applyLessonMotion').length).toBeGreaterThan(5);
      expect(env.calls.filter(call => call.kind === 'bakeLessonMotion')).toEqual([]);
      // The turn ends inside the chapter and bakes exactly once, and the ticks
      // that would have kept saving stop with it.
      await vi.advanceTimersByTimeAsync(1_200);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(player.getState().motionRunning).toBe(false);
      expect(env.calls.filter(call => call.kind === 'bakeLessonMotion').length).toBe(1);
      // The rest of the chapter adds no second bake and no further ticks.
      const ticked = env.calls.filter(call => call.kind === 'applyLessonMotion').length;
      await vi.advanceTimersByTimeAsync(3_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(env.calls.filter(call => call.kind === 'applyLessonMotion').length).toBe(ticked);
      expect(env.calls.filter(call => call.kind === 'bakeLessonMotion').length).toBe(1);
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  it('bakes the chapter turn when the lesson pauses', async () => {
    const dom = setupMockDom();
    const env = takeoverWorkspace();
    vi.useFakeTimers();
    try {
      const player = mountTourPlayer({ workspace: env.workspace, tours: takeoverTours, after: dom.mountAnchor });
      env.setNotify(() => player.notifyMutation());
      await player.select('wall');
      await player.start(true);
      await vi.advanceTimersByTimeAsync(500);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(player.getState().motionRunning).toBe(true);
      expect(env.calls.filter(call => call.kind === 'bakeLessonMotion')).toEqual([]);
      // A grip bake reaches the player as a takeover; the pinned camera must
      // not be stranded behind it.
      player.notifyMutation(env.workspace.snapshot());
      expect(env.calls.filter(call => call.kind === 'bakeLessonMotion').length).toBe(1);
      expect(player.getState().motionRunning).toBe(false);
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  /**
   * The wearer must be able to say "bigger" and have it happen while the
   * cinematic keeps playing. An agent command is
   * a committed inspection change, so before this it arrived as a workspace
   * takeover and killed the lesson on its first word.
   */
  it('keeps the chapter turning under a change the agent rendered', async () => {
    const dom = setupMockDom();
    const env = takeoverWorkspace();
    vi.useFakeTimers();
    try {
      const player = mountTourPlayer({ workspace: env.workspace, tours: takeoverTours, after: dom.mountAnchor });
      env.setNotify(() => player.notifyMutation());
      await player.select('wall');
      await player.start(true);
      await vi.advanceTimersByTimeAsync(500);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const ticked = env.calls.filter(call => call.kind === 'applyLessonMotion').length;

      player.notifyMutation(env.workspace.snapshot(), { agent: true });
      expect(player.getState().stopped).toBe(false);
      expect(player.getState().active).toBe(true);
      expect(player.getState().autoplay).toBe(true);
      expect(player.getState().motionRunning).toBe(true);
      // The turn keeps turning, and nothing was baked out from under it.
      await vi.advanceTimersByTimeAsync(500);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(env.calls.filter(call => call.kind === 'applyLessonMotion').length).toBeGreaterThan(ticked);
      expect(env.calls.filter(call => call.kind === 'bakeLessonMotion')).toEqual([]);
    } finally {
      vi.useRealTimers();
      dom.restore();
    }
  });

  it('falls back to the mutation entries on a viewer that has no silent path', () => {
    // A workspace built before `applyLessonMotion` existed keeps the old
    // calls — the motion survives there, with the old (false-takeover)
    // behaviour, rather than going missing.
    const source = readFileSync(new URL('../src/tour-player.ts', import.meta.url), 'utf8');
    const tick = source.slice(source.indexOf('const applyMotionTick'), source.indexOf('const visit = ('));
    expect(tick).toContain("typeof inspection.applyLessonMotion === 'function'");
    expect(tick).toContain('inspection.applyLessonMotion(move)');
    expect(tick).toContain('orbit(move.axis, move.degrees)');
    expect(tick).toContain('dolly(move.factor)');
  });
  });

  /**
   * What a lesson leaves behind when it lets go.
   *
   * A chapter's key is the chapter's. When the lesson stops, the viewer is
   * asked to release it, and a viewer holding a resting baseline returns to
   * that baseline instead of to plain chain colours — which is how the plates
   * survive the end of a tour. Two calls carry the release and one of them has
   * to be able to stay silent:
   *
   *   `stop()` and `restoreStart()` release, because a lesson that has ended
   *   must not leave a focus fade painted with nothing running to explain it.
   *
   *   `stop(reason, { restoreResting: false })` does not. `hydrate` calls it
   *   just before replacing the source, and a repaint racing a load paints the
   *   OLD structure's chains onto a structure that is being taken away.
   */
  describe('releasing a chapter back to the resting key', () => {
    const restingTours: readonly Tour[] = [{
      id: 'lesson-telo', title: 'Telomerase', summary: 'Ten named parts',
      presentation: { captionCard: 'hidden' },
      steps: [
        { id: 'reveal', title: 'Wide reveal', narration: 'Two words.',
          appearance: { componentLabels: true },
          emphasis: { parts: [{ id: 'dyskerin', label: 'Dyskerin', color: '#ff8a1f', chain: 'A' }] } },
        { id: 'closer', title: 'Closer', narration: 'Two more.' },
      ],
    }, { id: 'plain', title: 'Plain', summary: 'A catalog tour with no lesson presentation', steps: [{ id: 'one', title: 'One' }] }];

    const restingWorkspace = ({ clears = true } = {}) => {
      const calls: { kind: string; args: unknown[] }[] = [];
      const note = (kind: string) => async (...args: unknown[]) => { calls.push({ kind, args }); return undefined; };
      const inspection: Record<string, unknown> = {
        configure: note('configure'), place: note('place'), fit: note('fit'),
        resetOrientation: note('reset'), orbit: note('orbit'), dolly: note('dolly'),
        setMotion: note('motion'), restore: note('restore'), emphasize: note('emphasize'),
      };
      // A viewer old enough to have no resting baseline has no release call
      // either, and then the player still has to clear back to plain.
      if (clears) inspection.clearLessonEmphasis = note('clearLessonEmphasis');
      const workspace = {
        snapshot: () => ({ ready: true, sourceSha256: 'a', xrPresenting: true, selectionKeys: [] }),
        rows: () => rows, capture: () => ({ camera: {} }),
        runTour: async (action: () => Promise<void>) => action(),
        setStatus: () => undefined,
        viewer: { select: note('select'), focus: note('focus'), inspection },
      } as unknown as Workspace;
      return { calls, workspace, kinds: () => calls.map(call => call.kind) };
    };

    it('releases the chapter when a tour stops normally', async () => {
      const dom = setupMockDom();
      const env = restingWorkspace();
      try {
        const player = mountTourPlayer({ workspace: env.workspace, tours: restingTours, after: dom.mountAnchor });
        await player.select('lesson-telo');
        await player.start(false);
        env.calls.length = 0;

        player.stop('Tour stopped.');
        expect(env.kinds()).toEqual(['clearLessonEmphasis']);
        // The release is the viewer's decision to make: nothing here paints a
        // key of its own over a baseline it cannot see.
        expect(env.kinds()).not.toContain('emphasize');
      } finally { dom.restore(); }
    });

    it('releases the chapter when the wearer restores the starting view', async () => {
      const dom = setupMockDom();
      const env = restingWorkspace();
      try {
        const player = mountTourPlayer({ workspace: env.workspace, tours: restingTours, after: dom.mountAnchor });
        await player.select('lesson-telo');
        await player.start(false);
        env.calls.length = 0;

        await player.restoreStart();
        // `applyStepEmphasis(undefined)` is the release, and it arrives after
        // the baseline scene so the chapter's focus cannot survive over it.
        expect(env.kinds()).toEqual(['restore', 'clearLessonEmphasis']);
        expect(player.getState().stopped).toBe(true);
      } finally { dom.restore(); }
    });

    it('clears back to plain on a viewer with no resting baseline', async () => {
      const dom = setupMockDom();
      const env = restingWorkspace({ clears: false });
      try {
        const player = mountTourPlayer({ workspace: env.workspace, tours: restingTours, after: dom.mountAnchor });
        await player.select('lesson-telo');
        await player.start(false);
        env.calls.length = 0;

        await player.restoreStart();
        expect(env.kinds()).toEqual(['restore', 'emphasize']);
        expect(env.calls.at(-1)!.args[0]).toEqual({ parts: [], origin: 'lesson' });
      } finally { dom.restore(); }
    });

    it('paints nothing when the stop is a source swap getting out of the way', async () => {
      const dom = setupMockDom();
      const env = restingWorkspace();
      try {
        const player = mountTourPlayer({ workspace: env.workspace, tours: restingTours, after: dom.mountAnchor });
        await player.select('lesson-telo');
        await player.start(false);
        env.calls.length = 0;

        // The call `hydrate` makes before `loadSource` replaces the structure.
        player.stop('Tour stopped because a new inspection loaded.', { restoreResting: false });
        expect(env.calls).toEqual([]);
        expect(player.getState().stopped).toBe(true);
        expect(player.getState().active).toBe(false);
      } finally { dom.restore(); }
    });

    it('honors the hidden caption card during playback and at rest', async () => {
      const dom = setupMockDom();
      const env = restingWorkspace();
      try {
        const player = mountTourPlayer({ workspace: env.workspace, tours: restingTours, after: dom.mountAnchor });
        expect(player.getState().captionCard).toBeUndefined();

        await player.select('lesson-telo');
        expect(player.getState().captionCard).toBe('hidden');
        await player.start(false);
        expect(player.getState().active).toBe(true);
        expect(player.getState().step).toBeGreaterThanOrEqual(0);
        expect(player.getState().captionCard).toBe('hidden');
        player.stop('Tour stopped.');
        expect(player.getState().captionCard).toBe('hidden');

        // A catalog tour that never authored one reads as absent, which the
        // readout takes as `shown` — exactly what it drew before the field.
        await player.select('plain');
        expect(player.getState().captionCard).toBeUndefined();
      } finally { dom.restore(); }
    });
  });
});

it('pages alpha/beta-tubulin at separators and never chops an unbreakable word', () => {
  const prose = 'An alpha/beta-tubulin dimer is a macromolecularassembly.';
  const pages = pageText(prose);
  expect(pages.join(' ').replace(/\s+/gu, '')).toBe(prose.replace(/\s+/gu, ''));
  expect(pages.join(' ')).toMatch(/\btubulin\b/u);
  expect(pages.join(' ')).toContain('macromolecularassembly.');
  expect(pages.join(' ')).not.toContain('tubu lin');
  expect(pages.every(page => page.split('\n').length <= READOUT_PAGE_LINES)).toBe(true);
});
