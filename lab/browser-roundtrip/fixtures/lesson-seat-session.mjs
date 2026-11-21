import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { BoundaryHelper } from 'molstar/lib/mol-math/geometry/boundary-helper.js';
import { fitChapterField, framingEnvelopeObject, sweptChapterBalls, visibleChapterSpheres } from '../chapter-field.mjs';
import { turnSweptPoints } from '../focus-placement.mjs';
import { renderedMeshVertexCount } from '../component-label-measurement.mjs';
import { FIGURE_REFERENCE_SCALE, annotationFieldBounds, facingAnchorIndex, immersivePlateOffset, immersivePlateStandoff } from '../immersive-annotations.mjs';
import { drawnPlateRects } from '../label-layout.mjs';
import { motionFocusPlacement } from '../motion-framing.mjs';
import { poseMatrix, trackPointEnvelope } from '../molecular-animation.mjs';
import { evaluateTrack } from '../../../packages/motion/src/keyframes.mjs';
import { applyMatrix4 } from '../room-lock.mjs';
import { identity, syntheticViews } from './component-label-diagnostics.mjs';
import { toolbarFrameHarness } from './toolbar-frame-runtime.mjs';
import { tourFocusHarness } from './tour-focus-harness.mjs';
import { pageFunction } from './label-action-harness.mjs';
import { coordinates } from './kinesin-layout.mjs';
import { prepareLabelScene } from './motion-label-layout.mjs';

// One wearer at the standard seat, eyes 1.6 m up and looking level down -z,
// and one headset session of the real toolbar. Lessons and structures open
// in it one after another, the way a session opens them. Only the GPU, the
// tour player and the source loader are adapters: the menu seat, the card,
// the assistant line and the clearance proof (`clearChapterMenu`,
// `chapterFieldBounds`) and the chapter framing (`focusSelection`) are the
// shipped code. The molecule is drawn as a ball per atom; name plates are the
// lesson's own, anchored as the headset anchors them.
const EYE = 1.6;
const motionDemos = JSON.parse(readFileSync(new URL('./motion-demo-bounds.json', import.meta.url)));
const viewerSource = readFileSync(process.env.OVERPRINT_VIEWER_BASELINE ?? new URL('../viewer.mjs', import.meta.url), 'utf8');
const lessonFile = path => JSON.parse(readFileSync(new URL(`../../../plugin/demos/${path}`, import.meta.url), 'utf8'));
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
const cell = value => ({ ref: { value, version: 0 } });

function boundingSphere(points) {
  const helper = new BoundaryHelper('98');
  for (const p of points) helper.includePosition(p);
  helper.finishedIncludeStep();
  for (const p of points) helper.radiusPosition(p);
  const sphere = helper.getSphere();
  return { center: Array.from(sphere.center), radius: sphere.radius };
}

// The lessons this session can open. A still lesson is framed on its whole
// complex (or on a close-up's parts); a moving one on its recorded motion
// envelope, at the scales the headset framed it at.
export const SEAT_LESSONS = {
  // The structure a session enters on, with no lesson open.
  '4HHB': { file: 'hemoglobin.json', composite: '4HHB.cif', cameraScale: .0240464, plain: true },
  'telomerase-haca': { file: 'telomerase-haca.json', composite: '8OUE.cif', cameraScale: .0067 },
  'kinesin-walk': { file: 'kinesin-walk/motion.json', motion: 'kinesin-walk', cameraScale: .00504, previousScale: 1.738056 },
  'atp-synthase-rotor': { file: 'atp-synthase-rotor/motion.json', motion: 'atp-synthase-rotor', cameraScale: .00777, previousScale: 2.017061 },
  'hemoglobin-switch': { file: 'hemoglobin-switch/motion.json', motion: 'hemoglobin-switch', cameraScale: .0240464, previousScale: .782137849783092 },
  // Opens at a whole-structure spin.
  'crispr-cas9': { file: 'crispr-cas9.json', composite: '9KJ6.cif', cameraScale: .011 },
};

export async function lessonSeatSession(runtime, { cache = process.env.STEREOFOLD_DEMO_CACHE } = {}) {
  const { h, records } = tourFocusHarness();
  const head = identity(); head[13] = EYE;
  const views = syntheticViews().map(view => {
    view.transform.matrix[13] = EYE; view.transform.inverse.matrix[13] = -EYE; return view;
  });
  const eyeX = views.map(view => view.transform.matrix[12]);
  Object.assign(h, { motionFocusPlacement, fitChapterField, visibleChapterSpheres, annotationFieldBounds, renderedMeshVertexCount,
    framingEnvelopeObject, interactionActive: () => false,
    latestRoomPlacementPose: { headInRoom: head, renderFromRoom: identity(), labelViews: views } });
  h.presentationTransform = () => h.placementTransform(h.inspectionSnapshot().placement);
  vm.runInContext('var menuClearanceMovedFor = null;', h);
  for (const name of ['chapterFieldBounds', 'clearChapterMenu']) vm.runInContext(pageFunction(viewerSource, name), h);
  // A chapter that spins is painted as the tour paints it (`chapterPainting`),
  // then turns while it is on show (`spins`).
  Object.assign(h, { sweptChapterBalls, turnSweptPoints, motionReason: () => h.spins ? null : 'tool' });
  vm.runInContext('var paintingChapter, paintingTurn, turnHeldFor = null, spinningChapter = null, spins = false;', h);
  if (/\n  function chapterSpinning\(/.test(viewerSource)) vm.runInContext(pageFunction(viewerSource, 'chapterSpinning'), h);
  if (/\n  function sweptChapterField\(/.test(viewerSource))
    vm.runInContext(`var sweptFieldCache = new Map(), lastSpinProof = null;\n${pageFunction(viewerSource, 'sweptChapterField')}`, h);

  let shown, subject, tour, chapterIndex = -1, labelScene;
  const decisions = [];
  const atomsOf = new Map();
  const state = () => ({ subject, ...(tour ? { tour } : {}),
    placementMoves: h.wearerPlacement.state().moves, placementHeld: h.wearerPlacement.state().held });
  const t = toolbarFrameHarness(runtime, { state: state(),
    // The scene's metres: the presentation maps the room into scene units.
    presentation: { roomMatrix: () => { const m = identity(); m[0] = m[5] = m[10] = 1 / h.canvas.camera.scale; return m; }, setRoomOffset() {} },
    getEntryGeometry: ({ keyOnly = false } = {}) => {
      const bounds = h.chapterFieldBounds(undefined, { still: true }) ?? h.chapterFieldBounds(undefined, { still: true, drawn: true });
      const transform = h.presentationTransform();
      return { objects: keyOnly || !bounds ? [] : [framingEnvelopeObject(bounds, transform)],
        clearanceKey: JSON.stringify([shown?.name, chapterIndex, Array.from(transform), h.canvas.camera.scale]),
        cameraScale: h.canvas.camera.scale, views, renderFromRoom: identity() };
    },
    beforeMenuDraw: async options => { const answer = await h.clearChapterMenu(options); decisions.push(answer); return answer; } });
  /** Where the wearer's head is, in metres from the standard seat. */
  function moveHead([x = 0, y = 0, z = 0] = []) {
    head[12] = x; head[13] = EYE + y; head[14] = z;
    views.forEach((view, i) => {
      view.transform.matrix[12] = eyeX[i] + x; view.transform.matrix[13] = EYE + y; view.transform.matrix[14] = z;
      view.transform.inverse.matrix[12] = -(eyeX[i] + x); view.transform.inverse.matrix[13] = -(EYE + y); view.transform.inverse.matrix[14] = -z;
    });
    t.frame.getViewerPose = () => ({ transform: { position: { x, y: EYE + y, z }, matrix: identity() },
      views: [{ transform: { inverse: { matrix: identity() } } }, { transform: { inverse: { matrix: identity() } } }] });
  }
  // The chapter framing reads the live glass, as it does in the headset.
  h.immersiveSession = { ...h.immersiveSession, platePoints: () => t.toolbar.platePoints(), captionPoints: () => t.toolbar.captionPoints(),
    drawnMenuPoints: () => t.toolbar.drawnMenuPoints(), menuRows: () => t.toolbar.menuRows(), menuPoints: () => t.toolbar.menuPoints(),
    glassPlates: () => t.toolbar.glassPlates(), chapterCardSeats: pose => t.toolbar.chapterCardSeats(pose) };
  // The toolbar measures the drawn structure's bounds before the camera scale.
  const publish = () => {
    if (shown) {
      const sphere = h.loadedSphere(), transform = h.presentationTransform();
      t.setBounds({ center: Array.from(Vec3.transformMat4(Vec3(), sphere.center, transform)), radius: sphere.radius * Mat4.getMaxScaleOnAxis(transform) });
    }
    t.setState(state());
  };

  // The drawn molecule: one ball per atom of what the chapter shows, in the
  // pose it opens at, carried by the presentation transform.
  function chapterAtoms() {
    const atoms = atomsOf.get(shown.name);
    const chapter = shown.lesson.chapters[Math.max(0, chapterIndex)];
    const tracks = shown.motion ? chapter.animation?.tracks ?? [] : [];
    const poses = new Map(tracks.flatMap(track => { const pose = evaluateTrack(track, 0);
      return track.chains.map(chain => [chain, { visible: pose.visible, matrix: poseMatrix(pose) }]); }));
    const visibility = chapter.immersive?.visibility;
    const only = new Set((visibility?.chains ?? []).map(c => typeof c === 'string' ? c : c.labelChain));
    const visible = chain => poses.has(chain) ? poses.get(chain).visible !== false : visibility?.op === 'only' ? only.has(chain) : true;
    return atoms.filter(atom => visible(atom.chain)).map(atom => poses.has(atom.chain)
      ? Vec3.transformMat4(Vec3(), atom.position, poses.get(atom.chain).matrix) : atom.position);
  }
  function drawnObject() {
    const points = chapterAtoms(), positions = new Float32Array(points.length * 4);
    points.forEach((p, i) => positions.set([p[0], p[1], p[2], i], i * 4));
    const sphere = boundingSphere(points), transform = h.presentationTransform();
    return { type: 'spheres', state: { visible: true }, values: {
      boundingSphere: cell({ center: Vec3.transformMat4(Vec3(), sphere.center, transform), radius: sphere.radius * Mat4.getMaxScaleOnAxis(transform) }),
      tPositionGroup: cell({ array: positions }), drawCount: cell(points.length * 6), dSizeType: cell('uniform'), uSize: cell(1.6),
      aTransform: cell(Array.from(transform)), instanceCount: cell(1), uGroupCount: cell(points.length) } };
  }
  // Text plates as Mol* draws them, from the chapter's authored labels.
  function annotations() {
    const placement = h.inspectionSnapshot().placement, gain = FIGURE_REFERENCE_SCALE / h.canvas.camera.scale;
    return (labelScene?.labels ?? []).map(label => {
      const halfWidth = .8 * label.text.length * .55 / 2 + .3;
      return { label, renderObjects: [{ type: 'text', state: { visible: true }, values: {
        drawCount: cell(6), instanceCount: cell(1), elements: cell([0, 1, 2, 0, 2, 3]),
        aPosition: cell(Array.from({ length: 4 }, () => Array.from(label.center)).flat()),
        aMapping: cell([-halfWidth, -.7, halfWidth, -.7, halfWidth, .7, -halfWidth, .7]),
        aTransform: cell(Array.from(h.presentationTransform())), aTexCoord: cell([10, 10, 10, 10, 10, 10, 10, 10]),
        dSizeType: cell('uniform'), uSize: cell(1), uSizeFactor: cell(6 * (label.sizeFactor ?? 1) * gain),
        uOffsetX: cell((label.offsetX ?? 0) * gain), uOffsetY: cell((label.offsetY ?? 0) * gain),
        uOffsetZ: cell(label.radius * placement.scale + 3 * gain) } }] };
    });
  }

  /** Open a structure: its lesson is selected, nothing is playing yet. */
  async function open(name) {
    const spec = SEAT_LESSONS[name];
    const lesson = lessonFile(spec.file);
    const demo = spec.motion ? motionDemos.find(d => d.demo === spec.motion) : undefined;
    if (!atomsOf.has(name)) atomsOf.set(name, coordinates(`${cache}/${demo?.composite ?? spec.composite}`, lesson.provenance.sourceSha256));
    shown = { name, lesson, demo, motion: Boolean(spec.motion), spec };
    const sphere = demo ? demo.source : boundingSphere(atomsOf.get(name).map(a => a.position));
    Object.assign(h, { loadedSphere: () => sphere, recordBoundingSphere: () => sphere, pivotCenter: () => sphere.center,
      pivotBounds: () => ({ baseCenter: sphere.center, visibleCenter: sphere.center, radius: sphere.radius }) });
    h.canvas.camera.scale = spec.cameraScale;
    h.scientificRepresentations = () => [{ renderObjects: [drawnObject()] }];
    h.molecularAnimation = { ...h.molecularAnimation, envelope: () => undefined, framingEnvelope: () => undefined,
      fieldEnvelope: () => undefined, snapshot: () => null, annotationEnvelope: () => undefined, representations: () => [] };
    h.lessonFigure = { snapshot: () => null, annotations: () => [] };
    labelScene = undefined; chapterIndex = -1;
    // A new source releases the wearer's placement (`source-load`).
    if (h.wearerPlacement.holdsPlacement()) h.wearerPlacement.release('source-load');
    h.inspectionState.place({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
    await frame(-1);
    subject = { title: lesson.title, pdbId: name === 'telomerase-haca' ? '8OUE' : undefined, sourceSha256: lesson.provenance.sourceSha256,
      chains: 4, representation: 'cartoon', color: 'chain-id' };
    // A plain structure has no lesson; a demo arrives with its lesson chosen.
    tour = spec.plain ? undefined : { selectedId: `lesson-${name}`, active: false, step: -1, total: lesson.chapters.length, captionCard: 'shown' };
    publish(); await t.toolbar.update(); await settle();
  }

  // The chapter's framing, by the shipped `focusSelection`.
  async function frame(index) {
    const chapter = shown.lesson.chapters[Math.max(0, index)];
    chapterIndex = index;
    if (shown.motion && index >= 0) {
      const target = shown.demo.target;
      Object.assign(h.molecularAnimation, { envelope: () => shown.demo.whole, framingEnvelope: () => target, fieldEnvelope: () => target,
        snapshot: () => ({ chapterId: chapter.id }),
        annotationEnvelope: (repr, point) => {
          const track = chapter.animation.tracks.find(track => track.chains.includes(repr.label?.chain));
          return track && trackPointEnvelope(track, point);
        } });
      await h.focusSelection({ wholeStructure: true, liftEmphasis: false, framing: 'fill', elevationDegrees: 0,
        durationMs: 0, motionFrame: { target, previousScale: shown.spec.previousScale } });
    } else {
      const authored = index >= 0 ? chapter.immersive?.placement?.rotation ?? [0, 0, 0] : [0, 0, 0];
      h.inspectionState.place({ rotation: authored });
      // A source opens on the seat entering the headset gives it, about half
      // a chapter's fill; a chapter frames its own view.
      if (index < 0) {
        await h.focusSelection({ wholeStructure: true, liftEmphasis: false, framing: 'context', elevationDegrees: 0, durationMs: 0 });
        labelScene = undefined; h.lessonFigure = { snapshot: () => null, annotations };
        return;
      }
      const close = chapter.immersive?.emphasis?.framing === 'context';
      const focus = close ? (chapter.immersive.emphasis.focus ?? []).map(id => chapter.immersive.emphasis.parts.find(part => part.id === id)) : [];
      const ghost = focus.length ? boundingSphere(atomsOf.get(shown.name).filter(atom => focus.some(part => part.chain === atom.chain
        && (!part.residues || atom.residue >= part.residues.from && atom.residue <= part.residues.to))).map(atom => atom.position)) : undefined;
      await h.focusSelection({ wholeStructure: true, liftEmphasis: false, framing: close ? 'context' : 'fill', elevationDegrees: 0,
        durationMs: 0, ...(ghost ? { ghost } : {}) });
    }
    labelScene = index >= 0 && chapter.immersive?.figure?.labels?.length ? prepareLabelScene(chapter, atomsOf.get(shown.name)) : undefined;
    h.lessonFigure = { snapshot: () => (labelScene ? {} : null), annotations };
  }

  const chapterTour = (index, extra = {}) => {
    const chapter = shown.lesson.chapters[index];
    return { selectedId: `lesson-${shown.name}`, active: true, step: index, total: shown.lesson.chapters.length,
      title: chapter.title, progress: `Scene ${index + 1}`, bodyPage: chapter.caption ?? chapter.immersive?.narration ?? '',
      captionCard: shown.lesson.presentation?.captionCard ?? 'shown', canNext: index + 1 < shown.lesson.chapters.length,
      canBack: index > 0, chapterStartedAt: 0, ...extra };
  };

  // A chapter whose headset motion is `spin` is painted with its turn, then
  // turns once the paint ends; the menu redraws while it turns. A lesson's
  // opening chapter paints through the install, which tells the page its
  // spin for the glass alone; a page without that option was not told it.
  const spin = index => shown.lesson.chapters[index]?.immersive?.motion === 'spin';
  const glassOnly = /glassOnly/.test(viewerSource);
  function paint(index, opening = false) {
    if (!spin(index) || (opening && !glassOnly)) return;
    Object.assign(h, { paintingChapter: shown.lesson.chapters[index].id,
      paintingTurn: { axis: [0, 1, 0], degrees: 360, continuous: true, ...(opening ? { glassOnly: true } : {}) },
      spinningChapter: shown.lesson.chapters[index].id, spins: false });
  }
  async function painted(index) {
    if (!spin(index)) return;
    Object.assign(h, { paintingChapter: undefined, paintingTurn: undefined, spins: true });
    await t.toolbar.update(); await settle();
  }

  /** Start the lesson: its opening chapter opens on the seat the lesson started from. */
  async function start(index = shown.motion ? shown.lesson.chapters.findIndex(c => c.id === shown.demo.chapter) : 0) {
    tour = chapterTour(index, { navigating: true });
    publish(); paint(index, true);
    await t.toolbar.update({ restoreTourSeat: true, restartTourSeat: true }); await settle();
    await frame(index);
    tour = chapterTour(index); publish();
    await t.toolbar.update(); await settle();
    await painted(index);
  }

  /** Next, to chapter `index`. */
  async function chapter(index) {
    tour = chapterTour(index, { navigating: true }); publish(); paint(index);
    await t.toolbar.update(); await settle();
    // An authored chapter frames afresh and gives the wearer's hold back.
    h.wearerPlacement.chapterStart();
    if (h.wearerPlacement.holdsPlacement()) h.wearerPlacement.release('authored-chapter');
    await frame(index);
    tour = chapterTour(index); publish();
    await t.toolbar.update(); await settle();
    await painted(index);
  }

  /** The wearer grabs the molecule and sets it down `metres` away, in the room, or at `to`. */
  async function grab(metres = [0, 0, 0], to) {
    const placement = h.inspectionSnapshot().placement, unit = h.canvas.camera.scale * h.loadedSphere().radius;
    h.inspectionState.place(to ? structuredClone(to) : { translation: placement.translation.map((v, i) => v + metres[i] / unit) }, 'grab');
    h.takeWearerPlacement('grab', { moved: Math.hypot(...metres) });
    publish(); await t.toolbar.update(); await settle();
  }

  /** Done: the starting view comes back; a held placement stays held. */
  async function done() {
    // `restoreStart` keeps a held placement where the wearer left it and
    // otherwise puts the molecule back on its starting view.
    if (!h.wearerPlacement.holdsPlacement()) await frame(-1);
    const end = shown.lesson.presentation?.endFigure === 'last' ? shown.lesson.chapters.length - 1 : undefined;
    if (end !== undefined) labelScene = prepareLabelScene(shown.lesson.chapters[end], atomsOf.get(shown.name));
    else labelScene = undefined;
    h.lessonFigure = { snapshot: () => (labelScene ? {} : null), annotations };
    tour = { selectedId: `lesson-${shown.name}`, active: false, step: -1, total: 0, autoplay: false, navigating: false,
      captionCard: shown.lesson.presentation?.captionCard ?? 'shown' };
    publish();
    await t.toolbar.update({ restoreTourSeat: true }); await settle();
    publish(); await t.toolbar.update(); await settle();
  }

  // ---- What the wearer sees, measured in each eye, in tangents of the lens.
  const toEye = (point, view) => applyMatrix4(point, view.transform.inverse.matrix);
  const rectOf = (points, view) => {
    const eye = points.map(p => toEye(p, view)).filter(p => p[2] < -1e-4);
    if (!eye.length) return undefined;
    const xs = eye.map(p => p[0] / -p[2]), ys = eye.map(p => p[1] / -p[2]);
    return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
  };
  const roomPoint = p => {
    const render = Vec3.transformMat4(Vec3(), p, h.presentationTransform());
    return Array.from(render).map(v => v * h.canvas.camera.scale);
  };
  const glass = () => {
    const plates = t.toolbar.glassPlates(), menu = t.toolbar.menuPlate();
    if (!plates.length) return {};
    // The menu's own glass is the plate that holds its backing centre.
    const holds = (plate, point) => {
      const r = rectOf(plate, views[0]), p = rectOf([point], views[0]);
      return r && p && p.left >= r.left && p.left <= r.right && p.bottom >= r.bottom && p.bottom <= r.top;
    };
    const menuIndex = menu ? plates.findIndex(plate => holds(plate, menu.point)) : plates.length > 1 ? 1 : 0;
    const named = { menu: plates[menuIndex] };
    if (menuIndex > 0) named.card = plates[0];
    if (plates[menuIndex + 1]) named.status = plates[menuIndex + 1];
    return named;
  };
  function labelRects(view) {
    if (!labelScene) return [];
    const placement = h.inspectionSnapshot().placement, cameraScale = h.canvas.camera.scale;
    const transform = h.presentationTransform(), inverse = Mat4.invert(Mat4(), transform);
    const roomEye = Array.from(Mat4.invert(Mat4(), view.transform.inverse.matrix)).slice(12, 15);
    const eye = Vec3.transformMat4(Vec3(), roomEye.map(v => v / cameraScale), inverse);
    const direction = v => { const d = Vec3.transformDirection(Vec3(), v, inverse); return Vec3.normalize(d, d); };
    const forward = direction([0, 0, -1]), up = direction([0, 1, 0]);
    const metres = cameraScale * placement.scale, gain = FIGURE_REFERENCE_SCALE / metres;
    const chapter = labelScene.chapter;
    const tracks = shown.motion ? chapter.animation?.tracks ?? [] : [];
    const poses = new Map(tracks.flatMap(track => { const pose = evaluateTrack(track, 0);
      return track.chains.map(chain => [chain, { visible: pose.visible, matrix: poseMatrix(pose) }]); }));
    const shownChains = new Set((chapter.immersive?.visibility?.chains ?? []).map(c => typeof c === 'string' ? c : c.labelChain));
    const visible = c => poses.has(c) ? poses.get(c).visible : chapter.immersive?.visibility?.op === 'only' ? shownChains.has(c) : true;
    return labelScene.labels.filter(label => visible(label.chain)).map(label => {
      const pose = poses.get(label.chain)?.matrix;
      let anchor = label.center;
      if (label.anchors) {
        const local = Vec3.sub(Vec3(), pose ? Vec3.transformMat4(Vec3(), eye, Mat4.invert(Mat4(), pose)) : eye, label.anchors.center);
        const i = facingAnchorIndex(label.anchors, Vec3.normalize(local, local)) * 3;
        anchor = Array.from(label.anchors.points.subarray(i, i + 3));
      }
      if (pose) anchor = Array.from(Vec3.transformMat4(Vec3(), anchor, pose));
      const characterUnits = .8 * 6 * (label.sizeFactor ?? 1) * gain;
      const { rect } = drawnPlateRects({ plates: [{ ...label, anchor }],
        placements: [{ id: label.id, offsetX: immersivePlateOffset(label.offsetX, gain, characterUnits, label.maxOffsetEm),
          offsetY: immersivePlateOffset(label.offsetY, gain, characterUnits, label.maxOffsetEm) }],
        characterUnits, backgroundMargin: .25, maxWidthEm: Infinity, standoff: immersivePlateStandoff(label.radius, 1, gain),
        eye: Array.from(eye), target: Array.from(Vec3.add(Vec3(), eye, forward)), up: Array.from(up) })[0];
      return rect && { id: label.id, text: label.text, left: rect.x - rect.halfWidth, right: rect.x + rect.halfWidth,
        bottom: rect.y - rect.halfHeight, top: rect.y + rect.halfHeight };
    }).filter(Boolean);
  }
  const overlap = (a, b) => Boolean(a && b) && a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;
  const inside = (p, r) => p[0] > r.left && p[0] < r.right && p[1] > r.bottom && p[1] < r.top;

  /** Every eye: which glass covers which glass, label or atom. */
  function measure() {
    const plates = glass(), atoms = chapterAtoms().map(roomPoint);
    return views.map(view => {
      const rects = Object.fromEntries(Object.entries(plates).map(([name, points]) => [name, rectOf(points, view)]));
      const labels = labelRects(view);
      const projected = atoms.map(p => toEye(p, view)).filter(p => p[2] < -1e-4).map(p => [p[0] / -p[2], p[1] / -p[2]]);
      const names = Object.keys(rects);
      const result = { eye: view.eye, rects, labels: labels.length, glassOverGlass: [], glassOverLabel: [], atomsUnder: {} };
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++)
        if (overlap(rects[names[i]], rects[names[j]])) result.glassOverGlass.push(`${names[i]}/${names[j]}`);
      for (const name of names) {
        for (const label of labels) if (overlap(rects[name], label)) result.glassOverLabel.push(`${name}/${label.text}`);
        result.atomsUnder[name] = rects[name] ? projected.filter(p => inside(p, rects[name])).length : 0;
      }
      return result;
    });
  }

  /** Each eye, the most atoms under each glass plate at any angle of the spin, in `step` degree steps. */
  function spinCover(step = 15) {
    const plates = glass(), base = h.presentationTransform(), points = chapterAtoms();
    const pivot = Vec3.transformMat4(Vec3(), h.pivotCenter(), base), most = views.map(() => ({}));
    for (let degrees = 0; degrees < 360; degrees += step) {
      const turned = Mat4.mul3(Mat4(), Mat4.fromTranslation(Mat4(), pivot), Mat4.fromRotation(Mat4(), degrees * Math.PI / 180, Vec3.create(0, 1, 0)),
        Mat4.mul(Mat4(), Mat4.fromTranslation(Mat4(), Vec3.negate(Vec3(), pivot)), base));
      const atoms = points.map(p => Array.from(Vec3.transformMat4(Vec3(), p, turned)).map(v => v * h.canvas.camera.scale));
      views.forEach((view, i) => {
        const projected = atoms.map(p => toEye(p, view)).filter(p => p[2] < -1e-4).map(p => [p[0] / -p[2], p[1] / -p[2]]);
        for (const [name, points] of Object.entries(plates)) {
          const r = rectOf(points, view), under = r ? projected.filter(p => inside(p, r)).length : 0;
          if (under >= (most[i][name]?.atoms ?? 0)) most[i][name] = { atoms: under, degrees: under ? degrees : 0 };
        }
      });
    }
    return most;
  }

  return { h, t, records, decisions, open, start, chapter, grab, done, measure, spinCover, publish, moveHead, settle,
    placement: () => structuredClone(h.inspectionSnapshot().placement),
    seat: () => t.toolbar.seatAnchor(), shown: () => shown, tour: () => tour, labelRects: eye => labelRects(views[eye]),
    dispose: () => t.toolbar.dispose() };
}
