import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createGenericMolecularLesson } from '../src/molecular-lesson.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { lessonRestingState, placeLessonScene, type Tour, type Workspace } from '../src/tour-player.js';

/**
 * The `placed` phase of a hydrate, held against a workspace.
 *
 * 73bd9eb made the loaded lesson's first chapter the structure's resting
 * appearance, which is what was asked for, and paid for it twice:
 *
 *   1. It widened the placed-phase condition with `|| data.customTour`, so a
 *      lesson with no experience started going through `workspace.runTour` —
 *      whose first act is `setMotion({ paused: true })`. Every lesson page then
 *      came up frozen, a reload of a saved scene whose motion was running
 *      included. A colour key is not a scene and has no business pausing one.
 *   2. It sent the resting state only from inside that block, so a later plain
 *      hydrate on the same structure sent nothing at all. The viewer drops a
 *      resting key only on a source change, so the previous lesson's key stayed
 *      installed and the next release repainted its parts underneath a session
 *      that had no lesson in it.
 *
 * `placeLessonScene` is the one decision both defects live in, and the fake
 * workspace below pauses motion inside `runTour` exactly as the real one does
 * (`lab/inspection/workspace.mjs`, `runTour`), so a
 * regression on either half shows up here as a real call rather than as text.
 */
const record = () => {
  const calls: { name: string; arg: unknown }[] = [];
  const note = (name: string) => async (arg?: unknown) => { calls.push({ name, arg: arg ?? null }); };
  const inspection = {
    configure: note('configure'), place: note('place'), fit: note('fit'),
    resetOrientation: note('resetOrientation'), orbit: note('orbit'), dolly: note('dolly'),
    restore: note('restore'), emphasize: note('emphasize'),
    setMotion: note('setMotion'), setLessonRestingState: note('setLessonRestingState'),
  };
  const workspace = {
    snapshot: () => ({ ready: true, sourceSha256: 'a', xrPresenting: true }),
    rows: () => [], identityRows: () => [], capture: () => ({}), setStatus: () => undefined,
    // The real workspace admits a tour as one queued action and pauses the
    // presentation turn before running it. That pause is the whole question.
    runTour: async (action: () => Promise<void>) => {
      await inspection.setMotion({ paused: true });
      return action();
    },
    viewer: { select: note('select'), focus: note('focus'), inspection },
  } as unknown as Workspace;
  return { calls, workspace, names: () => calls.map(call => call.name) };
};

const lessonTour = (): Tour => molecularLessonToTour(createGenericMolecularLesson({ sourceRef: 'own.cif' }));

describe('what a hydrate puts on the structure', () => {
  it('installs the first authored visibility only for a fresh source', async () => {
    const { workspace, names } = record();
    const tour = lessonTour();
    tour.steps[0].visibility = { op: 'only', chains: ['A'], classes: ['polymer'] };
    workspace.rows = () => [
      { key: 'a', entityType: 'polymer', identity: { labelChain: 'A', copyId: '1', modelNumber: 1 } },
      { key: 'b', entityType: 'polymer', identity: { labelChain: 'B', copyId: '1', modelNumber: 1 } },
    ];
    workspace.identityRows = workspace.rows;
    const masks: unknown[] = [];
    workspace.viewer.inspection.setVisibility = async value => { masks.push(value); };
    await placeLessonScene(workspace, { tour, applyInitialVisibility: true });
    expect(masks).toEqual([{ hiddenChains: [{ labelChain: 'B', copyId: '1' }], hiddenClasses: [], showOnlySelection: false }]);
    await placeLessonScene(workspace, { tour });
    expect(masks).toHaveLength(1);
    expect(names()).not.toContain('setMotion');
    expect(names()).not.toContain('place');
  });
  it('sends a loaded lesson its first chapter and never pauses the structure', async () => {
    const { calls, workspace, names } = record();
    const tour = lessonTour();
    await placeLessonScene(workspace, { tour });

    // The key and the plates go on, taken from chapter one and nowhere else.
    expect(names()).toEqual(['setLessonRestingState']);
    expect(calls[0]!.arg).toEqual({
      emphasis: tour.steps[0]!.emphasis,
      componentLabels: tour.steps[0]!.appearance?.componentLabels === true,
    });
    // The defect, stated as the wearer met it: a lesson page came up still.
    expect(names()).not.toContain('setMotion');
  });

  it('carries the shipped telomerase lesson: ten named parts and its plates', async () => {
    const demo = JSON.parse(readFileSync(new URL('../demos/telomerase-haca.json', import.meta.url), 'utf8'));
    const { calls, workspace, names } = record();
    await placeLessonScene(workspace, { tour: molecularLessonToTour(demo) });

    const resting = calls[0]!.arg as { emphasis?: { parts: unknown[] }; componentLabels: boolean };
    expect(resting.emphasis?.parts).toHaveLength(10);
    // This is the demo entered without starting the tour: the plates
    // are the whole point of it, and they are opt-in, so `true` has to survive.
    expect(resting.componentLabels).toBe(true);
    expect(names()).not.toContain('setMotion');
  });

  it('sends undefined on a plain hydrate, so no lesson key outlives its lesson', async () => {
    const { calls, workspace, names } = record();
    await placeLessonScene(workspace, {});

    expect(names()).toEqual(['setLessonRestingState']);
    // `null` is this recorder's spelling of "called with nothing", which is the
    // call the viewer needs: it forgets the key it is holding only when asked.
    expect(calls[0]!.arg).toBeNull();
    expect(names()).not.toContain('setMotion');
  });

  it('still pauses the structure for an experience chapter, which is a scene', async () => {
    const { workspace, names } = record();
    await placeLessonScene(workspace, {
      placeExperienceStep: async () => { await workspace.viewer.inspection.configure({ representation: 'cartoon' }); },
    });

    // A chapter rewrites the appearance and the selection; it cannot land on a
    // structure turning underneath it, so it keeps the workspace tour queue.
    expect(names()).toEqual(['setMotion', 'configure', 'setLessonRestingState']);
  });

  it('places a chapter and a lesson together, chapter first and resting key after', async () => {
    const { calls, workspace, names } = record();
    const tour = lessonTour();
    await placeLessonScene(workspace, {
      tour,
      placeExperienceStep: async () => { await workspace.viewer.select(['A:1']); },
    });

    expect(names()).toEqual(['setMotion', 'select', 'setLessonRestingState']);
    expect((calls.at(-1)!.arg as { emphasis?: unknown }).emphasis).toEqual(tour.steps[0]!.emphasis);
  });

  it('is a no-op on a viewer built before the resting baseline existed', async () => {
    const { workspace, names } = record();
    delete (workspace.viewer.inspection as { setLessonRestingState?: unknown }).setLessonRestingState;
    await expect(placeLessonScene(workspace, { tour: lessonTour() })).resolves.toBeUndefined();
    expect(names()).toEqual([]);
  });

  it('reads the baseline off chapter one alone', () => {
    const tour = lessonTour();
    expect(lessonRestingState(undefined)).toBeUndefined();
    expect(lessonRestingState(tour)).toEqual({
      emphasis: tour.steps[0]!.emphasis,
      componentLabels: tour.steps[0]!.appearance?.componentLabels === true,
    });
    // Plates are opt-in: a lesson that never authored them must not get them,
    // and a later chapter's choice is not the baseline's to make.
    const plain = { ...tour, steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', appearance: { componentLabels: true } }] } as Tour;
    expect(lessonRestingState(plain)).toEqual({ emphasis: undefined, componentLabels: false });
  });
});

describe('the panel sends this on every hydrate', () => {
  const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const placed = inspector.slice(inspector.indexOf('const placedStep='), inspector.indexOf("await tourPlayer?.replaceTours("));

  it('routes the placed phase through the one decision above', () => {
    expect(placed).toContain('placeLessonScene(workspace,{');
    // The resting paint must not be inside the workspace tour queue again.
    expect(placed).not.toContain('workspace.runTour');
    expect(placed).not.toContain('setLessonRestingState');
  });

  it('sends it whether or not the hydrate carries a lesson or a chapter', () => {
    // One call, with the lesson when there is one. No `|| data.customTour`
    // condition guarding the phase: that guard is what skipped a plain hydrate.
    expect(placed.match(/placeLessonScene\(/gu)).toHaveLength(1);
    expect(placed).toContain('...(panelCustomTour?{tour:panelCustomTour}:{})');
    // A map's reference-atoms panel sends the same clearing call, without
    // applying the unrenderable map lesson's resting key to those atoms.
    expect(inspector).toContain('const panelCustomTour=densityReferencePreview ? undefined : data.customTour;');
    // A failed map draw leaves the loaded lesson exactly as it was, so it is
    // the one hydrate that sends nothing rather than sending `undefined`.
    expect(placed).toContain("if(mapDrawFailure) await trace.phase('placed');");
  });
});


describe('lesson plate viewer wiring', () => {
  const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  it('asks the lesson plate rule with the installed state, live flag, and origin', () => {
    const predicate = viewer.slice(viewer.indexOf('function componentLabelsWanted()'), viewer.indexOf('async function deleteComponentLabelCells'));
    expect(predicate).toContain('platesWanted(installed, lessonResting.labelsEnabled(), emphasisOrigin)');
  });
  it('passes XR mode and context opacity to the plate painter', () => {
    const build = viewer.slice(viewer.indexOf('async function buildComponentLabelPlates('), viewer.indexOf('function ligandRows()'));
    // The candidate key includes context; XR filters it by chapter emphasis.
    const parts = viewer.slice(viewer.indexOf('function componentLabelPlateParts('), viewer.indexOf('function componentLabelKeyPlan()'));
    expect(parts).toContain('...explained, ...(key?.colours ?? [])');
    expect(build).toContain('componentLabelKeyPlan()?.colours');
    // XR chooses readable or absent ink; desktop keeps its existing fades.
    // Every build, repaint and relayout must pass the captured session mode.
    expect(build.match(/componentLabelPaint\(\{ presenting,/gu)).toHaveLength(3);
    expect(build).toContain('componentLabelPaint({ presenting, placeAlpha: place.alpha,');
    expect(build).toContain('contextAlpha: contextAlpha.get(entry.id) ?? 1,');
    // Each layer the painter returns, the backing and a detached plate's key.
    expect(build).toContain('for (const [layer, params] of Object.entries(paint))');
    expect(build).toContain('...common, ...params,');
    expect(build).not.toContain('...paint.text');
    expect(build).not.toContain('...paint.leader');
    // And the structure's own silhouette reaches the solver, so a plate is
    // never left on top of the thing it names.
    expect(build).toContain('subject = loaded ?');
  });
});

describe('the menu column reaches the plate solver at runtime', () => {
  const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../../lab/browser-roundtrip/immersive-session.mjs', import.meta.url), 'utf8');

  it('passes the toolbar rectangle as an obstacle on the runtime path', () => {
    const layout = viewer.slice(viewer.indexOf('function componentLabelLayout('), viewer.indexOf('function ligandRows()'));
    expect(layout).toContain('immersiveSession?.menuPoints?.()');
    expect(layout).toContain('roomMatrix?.()');
    // The caption card is glass too, so the plates keep off both.
    expect(layout).toContain('immersiveSession?.captionPoints?.()');
    expect(layout).toContain('obstacles: menuGlassObstacles([toolbarRect, captionRect])');
  });

  it('re-solves the plates once the menu has drawn, because the first pass runs before it exists', () => {
    // `canvas.xr.isPresenting` flips before the toolbar is built, so the pass
    // the presenting subscriber fires asks a panel-less toolbar for its points
    // and is handed an empty list. This is the second pass.
    expect(session).toContain('onMenuPlaced = () => {}');
    expect(session).toContain('onMenuPlaced({ session })');
    // After the toolbar's own update has resolved, which is where the panel
    // the points come from is first assigned.
    expect(session.indexOf('onMenuPlaced({ session })')).toBeGreaterThan(session.indexOf('await withTimeout(record.toolbar.update()'));
    expect(viewer).toContain('onMenuPlaced: ({ reason } = {}) => {');
    const wiring = viewer.slice(viewer.indexOf('onMenuPlaced: ({ reason } = {}) => {'), viewer.indexOf('onPresented: async () =>'));
    expect(wiring).toContain('componentLabels.relayout(');
  });

  it('records the menu overlap count beside the plate overlap count', () => {
    expect(viewer).toContain("recordCost('component-label-layout'");
    const record = viewer.slice(viewer.indexOf("recordCost('component-label-layout'"), viewer.indexOf('return new Map(solved.placements'));
    expect(record).toContain('menu: toolbarRect ? solved.menuOverlaps : null');
    expect(record).toContain('yielded: solved.yielded');
  });
});

describe('the plates are solved again when the menu column moves', () => {
  const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../../lab/browser-roundtrip/immersive-session.mjs', import.meta.url), 'utf8');
  const toolbar = readFileSync(new URL('../../lab/browser-roundtrip/spatial-toolbar.mjs', import.meta.url), 'utf8');

  it('names why the drawn panel moved, on the draw that moved it', () => {
    // Menu/Close fold and re-seat in one committed draw. Retain the explicit
    // re-seat even at an unchanged head pose, alongside the fold reason;
    // clear it after the commit so later redraws cannot inherit it.
    const commit = toolbar.slice(toolbar.indexOf('const firstDraw = renderedSeat === undefined;'),
      toolbar.indexOf('representation = next; stateRepresentation = nextState;'));
    expect(commit).toContain("lastMenuMotion.push(collapsed ? 'collapse' : 'expand')");
    expect(commit).toContain("if (!firstDraw && (menuReseatRequested || seatSignature !== renderedSeat)) lastMenuMotion.push('reseat')");
    expect(commit).toContain('renderedSeat = seatSignature; renderedGrid = collapsed;\n      menuReseatRequested = false;');
    expect(commit).toContain("!sameLayout(physicalLayout, renderedLayout)) lastMenuMotion.push('follow')");
    // The session reads the column, its rows and the motion from the
    // toolbar's public surface, whatever else that surface also carries.
    const surface = toolbar.slice(toolbar.lastIndexOf('return Object.freeze({'));
    const exported = surface.slice(0, surface.indexOf('\n')).split(/[\s,{}()]+/);
    for (const name of ['menuPoints', 'menuRows', 'menuMotion', 'setStatus']) expect(exported).toContain(name);
  });

  it('coalesces a burst of redraws into one re-solve that names every cause', () => {
    // Debounced rather than per-redraw: the plate offsets are static uniforms,
    // and one Menu press is a fold and a re-seat an XR tick apart.
    expect(session).toContain("import { createMenuResolve } from './menu-resolve.mjs'");
    const redrawn = session.slice(session.indexOf('function menuRedrawn(record)'),
      session.indexOf('function menuRows()'));
    expect(redrawn).toContain('menuResolveFor(record).moved({ points: menuPoints(), reason: menuMotion(record) })');
    expect(redrawn).toContain('record.toolbar?.menuMotion?.()');
    expect(redrawn).toContain('onMenuPlaced({ session: record.session, reason })');
    // The entry pass has already solved against the column as it stands, so
    // the first redraw after entry must not ask for the same layout again.
    expect(session).toContain('menuResolveFor(record).seed(menuPoints())');
    // And a session going away takes its owed re-solve with it.
    expect(session).toContain('record.menuResolve?.dispose()');
  });

  it('carries the reason into the layout record, and only onto the pass it asked for', () => {
    const layout = viewer.slice(viewer.indexOf('function componentLabelLayout('), viewer.indexOf('function ligandRows()'));
    expect(layout).toContain('const menuReason = menuResolveReason;');
    expect(layout).toContain('menuResolveReason = null;');
    const record = layout.slice(layout.indexOf("recordCost('component-label-layout'"));
    expect(record).toContain('...(menuReason ? { menuReason } : {})');
  });
});

describe('plain lesson entry stays resting on the first hydrate', () => {
  const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');

  it('marks the first successful hydrate so grown-tier continuation cannot autoplay it', () => {
    expect(inspector).toContain('const initialOpen=!completedHydration;');
    expect(inspector).toContain('completedHydration=true;');
    expect(inspector).toContain('openGrownTier(grownLesson,priorLessonOnScreen,\n      options.autoplayContinuation ? options.autoplayContinuation() : priorAutoplay,initialOpen,options.continuationNarration)');
  });
});

it('a saved chapter hydrate installs baseline metadata without repainting emphasis', async()=>{
  const {workspace}=record(), calls:any[]=[];
  workspace.viewer.inspection.setLessonRestingState=async (...args:any[])=>{calls.push(args);};
  const tour=lessonTour();
  await placeLessonScene(workspace,{tour,preserveEmphasis:true});
  expect(calls).toEqual([[lessonRestingState(tour),{preserveEmphasis:true}]]);
});
