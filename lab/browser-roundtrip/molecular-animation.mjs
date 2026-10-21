import { updateTetherCaption } from './tether-caption.mjs';
import { setMotionTransform } from './motion-transform.mjs';
import { sizeImmersiveAnnotation } from './immersive-annotations.mjs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { StructureElement, StructureSelection } from 'molstar/lib/mol-model/structure.js';
import { selectAnimationTrack, resolveAnimationOwnership, animationLociOwner } from './animation-selection.mjs';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { Overpaint } from 'molstar/lib/mol-theme/overpaint.js';
import { Transparency } from 'molstar/lib/mol-theme/transparency.js';
import { evaluateTrack, evaluateTrackVisibility, createPlaybackClock } from '../../packages/motion/src/keyframes.mjs';
import { updatePlacementBounds } from './placement-bounds.mjs';
import { resolveAnimationTethers, createTetherRepresentations, tetherMatrix } from './animation-tethers.mjs';

// Object key order changes at schema/transport boundaries; identity must not.
async function animationIdentity(definition) {
  const canonical = JSON.stringify(definition, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,'0')).join('');
}

export function poseMatrix(pose, out = Mat4()) {
  Mat4.fromQuat(out, pose.rotation); Mat4.setTranslation(out, pose.translation); return out;
}
export function applyBodyPose(repr, presentation, pose, canvas, matrix = Mat4()) {
  Mat4.mul(matrix, presentation, poseMatrix(pose));
  repr.setState({ transform: matrix }); updatePlacementBounds(repr); canvas.update(repr, false);
}

/** Spheres stay in source space; scene placement is applied by the viewer. */
export function transformSphere(sphere, matrix) {
  return {center: Vec3.transformMat4(Vec3(), sphere.center, matrix), radius:sphere.radius * Mat4.getMaxScaleOnAxis(matrix)};
}
function enclose(spheres) {
  if (!spheres.length) return undefined;
  if (spheres.length === 1) return spheres[0];
  const center = [0, 1, 2].map(i => (Math.min(...spheres.map(s => s.center[i] - s.radius))
    + Math.max(...spheres.map(s => s.center[i] + s.radius))) / 2);
  return {center, radius:Math.max(...spheres.map(s => Vec3.distance(center, s.center) + s.radius))};
}
function bodyBounds(loci, definition) {
  let remainder = loci;
  const bounds = [];
  for (const track of definition.tracks) {
    const part = StructureElement.Loci.intersect(loci, selectAnimationTrack(loci.structure, track));
    remainder = StructureElement.Loci.subtract(remainder, part);
    if (!StructureElement.Loci.isEmpty(part)) bounds.push({body:track.id, sphere:StructureElement.Loci.getBoundingSphere(part)});
  }
  if (!StructureElement.Loci.isEmpty(remainder)) bounds.push({sphere:StructureElement.Loci.getBoundingSphere(remainder)});
  return bounds;
}
export function animationEnvelope(source, definition, { movingOnly = false, focus, bodies } = {}) {
  const spheres = [];
  for (const {body, sphere} of bodies ?? bodyBounds(StructureElement.Loci.all(source), definition)) {
    const track = definition.tracks.find(t => t.id === body);
    if (!track) { if (!movingOnly) spheres.push(sphere); continue; }
    const frames = track.keyframes.map(frame => evaluateTrack(track, frame.t));
    const posed = frames.map(frame => transformSphere(sphere, poseMatrix(frame)));
    spheres.push(...posed);
    // Slerp follows an arc, which can leave the union of endpoint bounds.
    // Bound its sagitta away from the chord; translation along the chord is linear.
    for (let i = 1; i < frames.length; i++) {
      const dot = Math.min(1, Math.abs(frames[i].rotation.reduce((sum, v, j) => sum + v * frames[i-1].rotation[j], 0)));
      const bulge = (track.pivot ? Vec3.distance(sphere.center, track.pivot) : Vec3.magnitude(sphere.center)) * (1 - dot);
      spheres.push({center:Vec3.lerp(Vec3(), posed[i-1].center, posed[i].center, .5),
        radius:sphere.radius + Vec3.distance(posed[i-1].center, posed[i].center) / 2 + bulge});
    }
  }
  if (focus && !StructureElement.Loci.isEmpty(focus)) {
    // Include the authored subject over its full travel, not only time zero.
    const focused = animationEnvelope(StructureElement.Loci.toStructure(focus), definition);
    if (focused) spheres.push(focused);
  }
  return enclose(spheres);
}

/**
 * Full anchor travel, including the rotational arc between keyframes. Its
 * `path` holds the same travel in order as a few spheres, each enclosing a
 * run of steps no wider than a sixth of the whole, a long step cut into
 * pieces along its own interpolation: a head that walks along a filament
 * sweeps a band, which one sphere round its ends overstates by half its
 * length above and below.
 */
export function trackPointEnvelope(track, point) {
  const frames = track.keyframes.map(frame => evaluateTrack(track, frame.t));
  const points = frames.map(frame => Vec3.transformMat4(Vec3(), point, poseMatrix(frame)));
  // The arc between two poses stays within its chord's sphere widened by the sagitta.
  const step = (a, b, from, to) => {
    const dot = Math.min(1, Math.abs(to.rotation.reduce((sum, v, j) => sum + v * from.rotation[j], 0)));
    const bulge = (track.pivot ? Vec3.distance(point, track.pivot) : Vec3.magnitude(point)) * (1 - dot);
    return { center: Vec3.lerp(Vec3(), a, b, .5), radius: Vec3.distance(a, b) / 2 + bulge };
  };
  const steps = points.slice(1).map((to, i) => step(points[i], to, frames[i], frames[i + 1]));
  const whole = enclose([...points.map(center => ({ center, radius: 0 })), ...steps]);
  if (!steps.length || !(whole.radius > 0)) return { ...whole, path: [whole] };
  const piece = whole.radius / 6, path = [];
  let run = [];
  const add = sphere => {
    if (run.length && enclose([...run, sphere]).radius > Math.max(piece, sphere.radius)) { path.push(enclose(run)); run = []; }
    run.push(sphere);
  };
  steps.forEach((whole, i) => {
    const count = Math.min(16, Math.ceil(whole.radius / piece));
    if (count <= 1) return add(whole);
    // A sub-span of a lerp and slerp is the lerp and slerp of its ends.
    const span = { pivot: track.pivot, keyframes: [{ ...track.keyframes[i], t: 0 }, { ...track.keyframes[i + 1], t: 1 }] };
    let from = evaluateTrack(span, 0), a = Vec3.transformMat4(Vec3(), point, poseMatrix(from));
    for (let k = 1; k <= count; k++) {
      const to = evaluateTrack(span, k / count), b = Vec3.transformMat4(Vec3(), point, poseMatrix(to));
      add(step(a, b, from, to));
      from = to; a = b;
    }
  });
  path.push(enclose(run));
  return { ...whole, path };
}

export function animationBodiesVisible(source, definition, hidden) {
  const tracks = definition.tracks.filter(track => evaluateTrackVisibility(track, 0));
  return tracks.length > 0 && tracks.every(track => {
    const loci = selectAnimationTrack(source, track);
    return !StructureElement.Loci.isEmpty(loci)
      && (!hidden || StructureElement.Loci.isEmpty(StructureElement.Loci.intersect(loci, hidden)));
  });
}

/**
 * Body copies inherit the template's transparency. A static scene masks the
 * state copies its chapter animation hides at t=0; the bodies themselves show
 * and hide by their tracks, so drop that mask from their full-transparency layers.
 */
export function unmaskTransparency(transparency, mask, data) {
  if (!mask || StructureElement.Loci.isEmpty(mask) || !transparency?.layers?.length) return transparency;
  const local = StructureElement.Loci.remap(mask, data);
  if (StructureElement.Loci.isEmpty(local)) return transparency;
  const layers = [];
  for (const layer of transparency.layers) {
    const loci = layer.value === 1 ? StructureElement.Loci.subtract(layer.loci, local) : layer.loci;
    if (!StructureElement.Loci.isEmpty(loci)) layers.push(loci === layer.loci ? layer : { ...layer, loci });
  }
  return { ...transparency, layers };
}

/** Owns geometry only at install/appearance boundaries. tick() never touches the state tree.
 * `onRelease` runs when a teardown hands attached plates back to their owner;
 * `getStaticMask` returns the loci a static scene hides for its t=0 state. */
export function createMolecularAnimation({ plugin, canvas = plugin.canvas3d, getStructure,
  getRepresentations, getAnnotations = () => [], getTransform, schedule, cancel, cachePresentation = false,
  canTick = () => true, isImmersive = () => false, record = () => {}, onError = () => {},
  onRelease = () => {}, getStaticMask = () => undefined }) {
  let ready = false, frameError;
  // Reused bodies share the static representation. Keep its latest painted
  // transparency separate from the unmasked state we temporarily display.
  const reusedTransparency = new Map();
  const restoreTransparency = repr => {
    const saved = reusedTransparency.get(repr);
    if (!saved) return;
    // A subsequent user paint wins even if teardown precedes refresh().
    if (repr.state.transparency === saved.applied) repr.setState({transparency: saved.original});
    reusedTransparency.delete(repr);
  };
  let definition, clock, id, chapterId, source, recording = false, records = [], originals = new Map(), attachments = [];
  let frame, epoch = 0, generation = 0, serial = Promise.resolve(), samples = new Float64Array(240), geometryRebuilds = 0, ticks = 0;
  let frameSamples = 0, lastFrameTimestampMs;
  // One source-bound lookahead. Preparation does not hide geometry, create a
  // playback clock or publish a scene; admission still validates live layers.
  let prepared;
  const prepare = value => {
    const data = getStructure()?.obj?.data, key = JSON.stringify(value);
    if (prepared?.source === data && prepared.key === key) return prepared.work;
    const entry = { source: data, key };
    prepared = entry;
    entry.work = (async () => {
      const began = performance.now();
      if (!data) throw Error('Molecular animation needs atomic coordinates.');
      const definition = structuredClone(value);
      const owners = resolveAnimationOwnership(data, definition);
      const tethers = resolveAnimationTethers(definition, data, owners);
      const bodies = bodyBounds(StructureElement.Loci.all(data), definition);
      const envelope = animationEnvelope(data, definition, { bodies });
      const movingEnvelope = animationEnvelope(data, definition, { movingOnly: true, bodies });
      const id = await animationIdentity(definition);
      record('animation-phase', { phase: 'prepare', elapsedMs: performance.now() - began });
      return { definition, owners, tethers, envelope, movingEnvelope, bodies: bodies.filter(bound => bound.body), id };
    })();
    entry.work.catch(() => { if (prepared === entry) prepared = undefined; });
    return entry.work;
  };
  let movingEnvelope;
  const presentationMatrix = Mat4.identity();
  let presentationValid = false;
  const identity = Mat4.identity(), composed = Mat4(), poses = new Map();
  const owned = new Map();
  let tethers = [], tetherReprs = [], drawRecords = [], published, controlRevision = 0, suspended = false, halted = false;
  const clockSample = {}, transformState = {transform:composed}, visibilityState = {visible:true};
  const changedRepresentations = [];
  const bodyMatrices = new Map(), sortedSamples = new Float64Array(240);
  let representationCounts;
  let atomOwners = new Map();
  const costSample = {id:undefined, poseUpdateMs:0, p50Ms:0, p95Ms:0, samples:0, geometryRebuilds:0, representationCounts:undefined};
  const endpointVisible = e => {
    // Endpoints are unresolved during construction; a malformed entry stays hidden.
    if (!Array.isArray(e?.representations) || poses.get(e.body)?.visible === false) return false;
    for (const repr of e.representations)
      if (repr.state.visible && (repr.state.alphaFactor ?? 1) * (repr.props.alpha ?? 1) > 0) return true;
    return false;
  };
  const place = (repr, local, presentation) => {
    Mat4.mul(composed, presentation, local);
    if (repr.state.transform && Mat4.areEqual(repr.state.transform, composed, 1e-12)) return;
    setMotionTransform(repr, transformState); sizeImmersiveAnnotation(repr, canvas); changedRepresentations.push(repr);
  };
  const tetherRepresentations = () => tetherReprs;
  let selectionBounds = new WeakMap(), envelope, movingBodies;
  const enqueue = fn => { const p = serial.then(fn); serial = p.catch(() => {}); return p; };
  const stop = () => { epoch++; if (frame !== undefined) cancel?.(frame); frame = undefined; };
  const snapshot = () => clock && source === getStructure()?.obj?.data ? { id, chapterId, durationSeconds:definition.durationSeconds,
    ...(representationCounts ? {representationCounts} : {}), ...clock.snapshot() } : null;
  const ownerOfLoci = loci => animationLociOwner(loci, atomOwners);
  // Count additional active molecular representations, excluding the hidden
  // originals. Whole-body overlays already present add no submissions.
  const checkSplitBudget = (value, data) => {
    const splits = new Map(value.tracks.filter(t => t.selector).map(t => [t.id, 0]));
    if (!splits.size) return;
    for (const original of getRepresentations()) {
      const cell = [...plugin.state.data.cells.values()].find(c => c.obj?.data?.repr === original
        && c.transform.transformer === StateTransforms.Representation.StructureRepresentation3D);
      if (cell?.params?.values?.type?.name === 'label') continue;
      const part = cell?.obj?.data?.sourceData;
      if (!part?.units || part.root !== data.root) continue;
      let fragments = 0;
      const cut = [];
      for (const track of value.tracks) {
        const n = StructureElement.Loci.size(selectAnimationTrack(part, track));
        if (!n) continue;
        fragments += n;
        if (splits.has(track.id) && n < part.elementCount) cut.push(track.id);
      }
      // A fully selected template already supplies one of the body draws.
      if (fragments === part.elementCount) cut.shift();
      for (const id of cut) splits.set(id, splits.get(id) + 1);
    }
    for (const [id, count] of splits) if (count > 1)
      throw Error(`Animation selection "${id}" would add ${count} representations; at most one is allowed. Use a single molecular layer across this selection or pre-scope overlapping layers.`);
  };
  const remove = async () => {
    ready = false; clock = undefined; stop(); presentationValid = false; halted = false;
    for (const repr of tetherRepresentations()) { canvas.remove(repr); repr.destroy(); }
    tethers = []; tetherReprs = [];
    const old = records;
    for (const repr of reusedTransparency.keys()) restoreTransparency(repr);
    // Plates return to their static decision, never to all-visible: the
    // template is back, drawing only the copies shown at t=0.
    for (const r of [...records, ...attachments]) if (!r.root) {
      r.repr.setState({visible:r.gate ? r.gate.rest : true, transform:getTransform()}); updatePlacementBounds(r.repr); canvas.update(r.repr,false);
    }
    records = []; attachments = []; drawRecords = []; owned.clear(); poses.clear(); bodyMatrices.clear(); published = undefined;
    envelope = undefined; movingEnvelope = undefined; movingBodies = undefined; selectionBounds = new WeakMap();
    representationCounts = undefined; atomOwners.clear();
    const currentTemplates = new Set(getRepresentations());
    for (const [repr, {visible, ref}] of originals) {
      if (!currentTemplates.has(repr) || !plugin.state.data.cells.has(ref)) continue;
      plugin.state.data.updateCellState(ref, {isHidden:!visible});
      repr.setState({visible, transform: getTransform()}); updatePlacementBounds(repr); canvas.update(repr, false);
    }
    originals.clear();
    if (old.length) onRelease();
    const builder = plugin.build(); let count = 0;
    for (const r of old) if (r.root && plugin.state.data.cells.has(r.root)) { builder.delete(r.root); count++; }
    if (count) await builder.commit();
    canvas.syncVisibility();
  };
  const refresh = async (beforeReveal) => {
    if (!definition || source !== getStructure()?.obj?.data) return;
    const began = performance.now();
    const token = generation, sourceData = source;
    const check = () => { if (token !== generation || sourceData !== getStructure()?.obj?.data) throw Error('Molecular animation source or chapter changed during installation.'); };
    const templates = getRepresentations(), staticMask = getStaticMask();
    checkSplitBudget(definition, source);
    const cells = [...plugin.state.data.cells.values()];
    for (const [repr, {ref}] of originals) if (!plugin.state.data.cells.has(ref)) originals.delete(repr);
    const next = [], staged = [], incomingOriginals = new Map();
    try {
      for (const original of templates) {
        check();
        const cell = cells.find(c => c.obj?.data?.repr === original && c.transform.transformer === StateTransforms.Representation.StructureRepresentation3D);
        if (!cell) continue;
        const data = cell.obj.data.sourceData;
        if (!data?.units || data.root !== source.root) continue;
        const signature = JSON.stringify(cell.params.values);
        const annotation = cell.params.values.type.name === 'label';
        const old = records.filter(r => r.original === original);
        if (old.length && old.every(r => r.signature === signature && r.geometryVersion === original.geometryVersion)) {
          next.push(...old);
        } else {
          const all = StructureElement.Loci.all(data);
          let remainder = all;
          const parts = definition.tracks.map(track => {
            const loci = selectAnimationTrack(data, track); remainder = StructureElement.Loci.subtract(remainder, loci);
            return {body: track.id, loci};
          });
          parts.push({body: undefined, loci: remainder});
          for (const {body, loci} of parts) {
            if (StructureElement.Loci.isEmpty(loci)) continue;
            // A figure layer or scoped style wholly on one body already is a component.
            if (StructureElement.Loci.size(loci) === data.elementCount && cell.transform.parent !== getStructure().ref) {
              next.push({original, repr: original, ref:cell.transform.ref, body, signature, geometryVersion: original.geometryVersion, data, annotation}); break;
            }
            // Keep the template drawing until all replacement bodies are posed.
            // Register it only at the synchronous handoff: input-frame apply()
            // can run while these state-tree builds yield.
            if (!originals.has(original)) incomingOriginals.set(original, {ref:cell.transform.ref,
              // Hidden incoming appearance templates are intended for the final scene.
              visible:original.state.visible || cell.state.isHidden});
            const component = await plugin.builders.structure.tryCreateComponentFromSelection(getStructure(), {
              label: body ?? 'Static remainder', referencesCurrent: true,
              getSelection: async () => StructureSelection.Singletons(source, StructureElement.Loci.toStructure(loci)),
            }, `animation-${crypto.randomUUID()}`, {label:body ?? 'Static remainder', tags:['stereofold-molecular-animation']});
            if (!component) throw Error('Could not build molecular animation body.');
            const pending = { root: component.ref }; staged.push(pending);
            check();
            const reprCell = await plugin.build().to(component).apply(StateTransforms.Representation.StructureRepresentation3D,
              cell.params.values, {tags:['stereofold-molecular-animation'], state:{isHidden:true}}).commit();
            const repr = reprCell.obj.data.repr;
            Object.assign(pending, {original, repr, body, ref:reprCell.ref, signature, geometryVersion:original.geometryVersion, data:component.obj.data, annotation});
            next.push(pending); geometryRebuilds++; check();
          }
        }
        for (const r of next.filter(r => r.original === original)) if (r.repr !== original) {
          r.repr.setState({ overpaint: Overpaint.remap(original.state.overpaint, r.data),
            transparency: unmaskTransparency(Transparency.remap(original.state.transparency, r.data), staticMask, r.data),
            alphaFactor: original.state.alphaFactor, pickable: original.state.pickable });
        }
      }
      if (beforeReveal) {
        const builtAt = performance.now();
        record('animation-phase', { phase: 'geometry-build', elapsedMs: builtAt - began });
        await beforeReveal;
        record('animation-phase', { phase: 'caption-wait', elapsedMs: performance.now() - builtAt });
      }
      check();
    } catch (error) {
      const builder = plugin.build();
      for (const r of staged) builder.delete(r.root);
      if (staged.length) await builder.commit();
      throw error;
    }
    // No await between the reveal and retirement: both eyes see one posed set.
    for (const [repr, state] of incomingOriginals) originals.set(repr, state);
    const retired = records.filter(r => !next.includes(r) && r.root);
    for (const repr of reusedTransparency.keys())
      if (!next.some(r => r.repr === repr && !r.root)) restoreTransparency(repr);
    for (const r of next) if (r.repr === r.original) {
      const saved = reusedTransparency.get(r.repr), current = r.repr.state.transparency;
      const original = saved && current === saved.applied ? saved.original : current;
      const applied = unmaskTransparency(original, staticMask, r.data);
      reusedTransparency.set(r.repr, {original, applied});
      r.repr.setState({transparency: applied});
    }
    records = next;
    owned.clear();
    for (const r of records) owned.set(r.repr, r.body);
    check();
    attachments = getAnnotations().map(({repr, loci, chains, gate}) => {
      const body = loci ? ownerOfLoci(loci) : definition.tracks.find(t => !t.selector && chains?.length && chains.every(c => t.chains.includes(c)))?.id;
      return {repr, body, gate};
    });
    drawRecords = [...records, ...attachments];
    const molecular = records.filter(r => !r.annotation);
    representationCounts = { molecular:molecular.length, moving:molecular.filter(r => r.body).length,
      added:Math.max(0, molecular.length - new Set(molecular.map(r => r.original)).size),
      annotations:records.length - molecular.length + attachments.length, tethers:tetherReprs.length };
    record('animation-representations', representationCounts);
    if (published) published = {...published, playback:snapshot()};
    for (const a of attachments) owned.set(a.repr, a.body);
    for (const repr of tetherRepresentations()) owned.set(repr, undefined);
    // Cache endpoint coverage/masks at scene boundaries, outside the frame loop.
    for (const tether of tethers) for (const endpoint of [tether.from, tether.to]) {
      endpoint.representations = records.filter(r => {
        const loci = StructureElement.Loci.remap(endpoint.loci, r.data);
        if (StructureElement.Loci.isEmpty(loci)) return false;
        return !(r.repr.state.transparency?.layers ?? []).some(layer => layer.value === 1
          && !StructureElement.Loci.isEmpty(StructureElement.Loci.intersect(loci, layer.loci)));
      }).map(r => r.repr);
    }
    for (const r of records) { updatePlacementBounds(r.repr); canvas.update(r.repr, false); }
    apply({visibility:false, presentation:getTransform()});
    for (const [repr, {ref}] of originals) {
      plugin.state.data.updateCellState(ref, {isHidden:true});
      repr.setState({visible:false});
    }
    for (const r of records) if (staged.includes(r) || !r.root)
      plugin.state.data.updateCellState(r.ref, {isHidden:false});
    // Figure annotations can arrive staged offscreen with their bodies. Lift
    // the state-tree hide at the same synchronous handoff, then apply the
    // track masks before an XR frame can expose an alternate-state duplicate.
    for (const {repr} of attachments) {
      const cell = cells.find(cell => cell.obj?.data?.repr === repr);
      if (cell?.state.isHidden) plugin.state.data.updateCellState(cell.transform.ref, {isHidden:false});
    }
    apply();
    for (const r of retired) r.repr.setState({visible:false});
    canvas.syncVisibility();
    if (retired.length) {
      const builder = plugin.build();
      for (const r of retired) if (plugin.state.data.cells.has(r.root)) builder.delete(r.root);
      await builder.commit();
    }
  };
  const apply = (options) => {
    if (!clock || frameError) return;
    const visibility = options?.visibility !== false;
    const started = performance.now(), time = clock.snapshot(clockSample).timeSeconds;
    if (options?.presentation || !cachePresentation || !presentationValid) {
      Mat4.copy(presentationMatrix, options?.presentation ?? getTransform()); presentationValid = true;
    }
    const presentation = presentationMatrix;
    for (const track of definition.tracks) {
      const pose = poses.get(track.id);
      pose.visible = evaluateTrackVisibility(track, time);
      if (!pose.visible) continue;
      evaluateTrack(track, time, pose);
      poseMatrix(pose, bodyMatrices.get(track.id));
    }
    changedRepresentations.length = 0;
    let visibilityChanged = false;
    if (visibility) for (const repr of originals.keys()) if (repr.state.visible) { visibilityState.visible = false; repr.setState(visibilityState); visibilityChanged = true; }
    for (const r of drawRecords) {
      // A figure plate also needs its part drawn by the scene.
      const visible = (poses.get(r.body)?.visible ?? true) && (r.gate?.shown ?? true);
      if (visibility && r.repr.state.visible !== visible) { visibilityState.visible = visible; r.repr.setState(visibilityState); visibilityChanged = true; }
      if (visible) place(r.repr, bodyMatrices.get(r.body) ?? identity, presentation);
    }
    for (const tether of tethers) {
      let visible = endpointVisible(tether.from) && endpointVisible(tether.to);
      if (visible) {
        Vec3.transformMat4(tether.fromPoint, tether.from.position, bodyMatrices.get(tether.from.body) ?? identity);
        Vec3.transformMat4(tether.toPoint, tether.to.position, bodyMatrices.get(tether.to.body) ?? identity);
        visible = Vec3.distance(tether.fromPoint, tether.toPoint) > 1e-10;
      }
      for (const repr of tether.representations) {
        if (visibility && repr.state.visible !== visible) { visibilityState.visible = visible; repr.setState(visibilityState); visibilityChanged = true; }
      }
      if (!visible) continue;
      place(tether.line, tetherMatrix(tether.fromPoint, tether.toPoint, tether.matrix), presentation);
      if (tether.label) {
        Vec3.lerp(tether.midpoint, tether.fromPoint, tether.toPoint, .5);
        updateTetherCaption(tether.label, tether.fromPoint, tether.toPoint, presentation);
        place(tether.label, Mat4.fromTranslation(tether.labelMatrix, tether.midpoint), presentation);
      }
    }
    if (changedRepresentations.length) {
      if (canvas.updateRepresentations) canvas.updateRepresentations(changedRepresentations, false);
      else for (const repr of changedRepresentations) canvas.update(repr, false);
    }
    if (visibilityChanged) canvas.syncVisibility();
    if (!recording) return;
    const ms = performance.now() - started; samples[ticks % 240] = ms; ticks++;
    if (ticks === 1 || ticks % 60 === 0) {
      const count = Math.min(ticks, 240);
      sortedSamples.fill(Infinity); for (let i = 0; i < count; i++) sortedSamples[i] = samples[i]; sortedSamples.sort();
      costSample.id = id; costSample.poseUpdateMs = ms; costSample.p50Ms = sortedSamples[Math.floor(count * .5)];
      costSample.p95Ms = sortedSamples[Math.min(count - 1, Math.floor(count * .95))];
      costSample.samples = count; costSample.geometryRebuilds = geometryRebuilds;
      costSample.representationCounts = representationCounts;
      record('animation-cost', costSample);
    }
  };
  // Input runs while state-tree promises yield. Never sample half an install or
  // keep throwing the same fault every XR frame; fail waiting draws immediately.
  const sampleFrame = timestamp => {
    if (!ready || frameError || !clock) return;
    frameSamples++; lastFrameTimestampMs = timestamp;
    try {
      if (!suspended && !halted && canTick()) { clock.sample(timestamp, clockSample); apply(); } else clock.reanchor();
    } catch (error) {
      frameError = error; ready = false; stop(); onError(error);
    }
  };
  const start = () => {
    stop(); if (!ready || halted || frameError || !clock || clock.snapshot(clockSample).state !== 'playing' || !schedule || isImmersive()) return;
    const token = epoch;
    const tick = timestamp => {
      if (token !== epoch) return;
      frame = undefined;
      if (!clock || isImmersive()) return;
      sampleFrame(timestamp);
      if (token === epoch && ready && !frameError && clock?.snapshot(clockSample).state === 'playing') frame = schedule(tick);
    };
    frame = schedule(tick);
  };
  const api = {
    prepare,
    install(value, chapter, { beforeReveal } = {}) { const token = ++generation; return enqueue(async () => {
      if (token !== generation) return;
      const expectedSource = getStructure()?.obj?.data;
      const began = performance.now();
      const cached = value ? await prepare(value) : undefined;
      if (token !== generation || expectedSource !== getStructure()?.obj?.data) return;
      // Representation budgets depend on the current chapter's live layers.
      if (value) checkSplitBudget(value, expectedSource);
      let reuse = Boolean(value && !beforeReveal && cached.tethers.length === 0 && ready && !halted && !frameError && clock
        && source === expectedSource && id === cached.id && chapterId === (chapter ?? 'animation'));
      if (reuse) {
        const templates = new Set(getRepresentations()), annotations = new Set(getAnnotations().map(a => a.repr));
        // A cached chapter restore can be followed by an identical install.
        // Retain only intact geometry with the same live owners. Layer or
        // annotation replacement needs removal's full release/restoration;
        // caption barriers and manual tether geometry keep that path too.
        reuse = templates.size === new Set(records.map(r => r.original)).size
          && records.every(r => templates.has(r.original) && plugin.state.data.cells.get(r.ref)?.obj?.data?.repr === r.repr)
          && annotations.size === attachments.length && attachments.every(a => annotations.has(a.repr));
      }
      if (reuse) { ready = false; stop(); presentationValid = false; }
      else await remove();
      definition = undefined; clock = undefined; frameError = undefined;
      if (token !== generation || expectedSource !== getStructure()?.obj?.data) return;
      if (!value) return;
      definition = cached.definition; chapterId = chapter ?? 'animation'; source = getStructure().obj.data;
      atomOwners = new Map(cached.owners);
      // Stable content identity, independent of clock and page performance-time origin.
      id = cached.id;
      if (token !== generation || expectedSource !== getStructure()?.obj?.data) { definition = undefined; return; }
      clock = createPlaybackClock(value.durationSeconds, value.playback);
      controlRevision++;
      for (const track of definition.tracks) { poses.set(track.id, evaluateTrack(track, 0)); bodyMatrices.set(track.id, Mat4()); }
      published = {definition, playback:snapshot()};
      envelope = cached.envelope; movingEnvelope = cached.movingEnvelope; movingBodies = cached.bodies;
      samples.fill(0); ticks = 0; geometryRebuilds = 0; recording = false;
      try {
        for (const tether of cached.tethers) {
          const representations = await createTetherRepresentations(tether);
          tethers.push({...tether, from:{...tether.from, representations:[]}, to:{...tether.to, representations:[]}, ...representations, representations:[representations.line, representations.label].filter(Boolean),
            fromPoint:Vec3(), toPoint:Vec3(), midpoint:Vec3(), matrix:Mat4(), labelMatrix:Mat4()});
          // Own the entire pair before canvas.add or a later tether can fail.
          tetherReprs.push(representations.line);
          if (representations.label) tetherReprs.push(representations.label);
          for (const repr of [representations.line, representations.label].filter(Boolean)) {
            repr.setState({visible:false, pickable:false}); canvas.add(repr);
          }
        }
        if (token !== generation || source !== getStructure()?.obj?.data) {
          await remove(); definition = undefined; clock = undefined; frameError = undefined; return;
        }
        const geometryAt = performance.now();
        // Even a repeated definition must reapply current paint, masks,
        // annotation gates and placement, rebuilding edited templates.
        await refresh(beforeReveal);
        record('animation-phase', { phase: 'geometry', elapsedMs: performance.now() - geometryAt });
        const reusedGeometry = reuse && geometryRebuilds === 0;
        geometryRebuilds = 0; frameSamples = 0; lastFrameTimestampMs = undefined;
        recording = true; apply(); ready = true; start();
        record('animation-phase', { phase: 'install', elapsedMs: performance.now() - began, reusedGeometry });
      }
      catch (error) { await remove(); definition = undefined; clock = undefined; throw error; }
    }); },
    refresh: () => enqueue(refresh),
    control(patch) {
      if (frameError) throw frameError;
      if (!clock) return null;
      // A halted chapter is being replaced: keep the new clock, but leave its
      // bodies alone until the next install, refresh or resume.
      controlRevision++; clock.patch(patch, suspended || halted ? undefined : performance.now()); if (!halted) apply(); start();
      const playback = snapshot(); published = {definition, playback}; return playback;
    },
    revision: () => controlRevision,
    publish(playback) { published = playback ? {definition, playback} : undefined; },
    capture: () => published ? structuredClone(published) : undefined,
    // Internal, synchronous scene composition only. The formatter borrows the
    // publication while JSON encodes it; callers receive a string, never the
    // live definition. Public captures above remain fully detached.
    serializeCapture: format => JSON.stringify(format(published)),
    checkpoint: () => clock ? {definition:structuredClone(definition), playback:snapshot(), published:structuredClone(published)} : undefined,
    async restore(value, force = false) {
      if (!value) { if (!clock) return false; await api.install(undefined); return true; }
      const digest = await animationIdentity(value.definition);
      if (digest !== value.playback.id || value.definition.durationSeconds !== value.playback.durationSeconds)
        throw Error('The saved animation identity does not match its definition.');
      if (!force && !frameError && JSON.stringify(published) === JSON.stringify(value)) return false;
      if (frameError || !clock || id !== value.playback.id || chapterId !== value.playback.chapterId)
        await api.install(value.definition, value.playback.chapterId);
      if (id !== value.playback.id || definition.durationSeconds !== value.playback.durationSeconds)
        throw Error('The saved animation identity does not match its definition.');
      api.control({state:value.playback.state === 'playing' ? 'play' : 'pause', seekSeconds:value.playback.timeSeconds,
        speed:value.playback.speed, loop:value.playback.loop});
      published = structuredClone(value.published ?? {definition:value.definition, playback:value.playback});
      return true;
    },
    suspend(value) { suspended = value; clock?.reanchor(); start(); },
    // A chapter change retires the figure layers and labels these bodies pose.
    // Stop posing them first; the next install or removal clears the halt,
    // and a failed change resumes it. Geometry and the clock stay as they are.
    halt() { halted = true; stop(); },
    resume() { if (!halted) return; halted = false; clock?.reanchor(); start(); },
    // Install, refresh and removal replace body cells and queue canvas work
    // across awaits. A figure about to snapshot its surroundings waits for
    // that work, then lands the queued canvas changes in the scene.
    async settled() { await serial; canvas.commit?.(true); },
    faulted: () => Boolean(frameError),
    /** Whether restoring this saved animation would tear down the running one. */
    supersededBy: value => Boolean(clock) && (!value || Boolean(frameError)
      || id !== value.playback?.id || chapterId !== value.playback?.chapterId),
    tick(timestamp) {
      if (!ready || frameError || !clock || clock.snapshot(clockSample).state !== 'playing') return;
      sampleFrame(timestamp);
    },
    envelope: () => source === getStructure()?.obj?.data ? envelope : undefined,
    framingEnvelope(focus) {
      if (!definition || source !== getStructure()?.obj?.data) return undefined;
      const bounds = focus ? animationEnvelope(source, definition, { movingOnly: true, focus }) : movingEnvelope;
      return bounds && { center: bounds.center, radius: bounds.radius * 1.1 };
    },
    /**
     * The moving bodies as the chapter opens (t=0), posed. A hidden state copy
     * and every later pose are left out. It never follows the clock, so every
     * menu draw in a chapter measures the same field.
     */
    fieldEnvelope() {
      if (!definition || !movingBodies || source !== getStructure()?.obj?.data) return undefined;
      return enclose(movingBodies.flatMap(({body, sphere}) => {
        const track = definition.tracks.find(track => track.id === body);
        return track && evaluateTrackVisibility(track, 0) ? [transformSphere(sphere, poseMatrix(evaluateTrack(track, 0)))] : [];
      }));
    },
    /** The drawn representations of moving bodies, which `fieldEnvelope` measures instead of their drawn pose. */
    movingRepresentations() {
      if (!definition || !movingBodies || source !== getStructure()?.obj?.data) return [];
      const moving = new Set(movingBodies.map(({body}) => body));
      return drawRecords.filter(record => moving.has(record.body)).map(record => record.repr);
    },
    /**
     * A plate anchor's travel over its body's track. Null when that body never
     * shows in this chapter: its plate is never drawn, so neither the plate
     * nor its travel counts. A body that shows at any time counts its whole
     * travel, whatever the clock reads now, so every menu draw in a chapter
     * measures the same field.
     */
    annotationEnvelope(repr, posedPoint) {
      if (!definition || source !== getStructure()?.obj?.data) return undefined;
      const body = drawRecords.find(record => record.repr === repr)?.body;
      const track = definition?.tracks.find(track => track.id === body);
      if (!track) return undefined;
      const events = track.visibility ?? [];
      if (events.length && events[0].t <= 0 && !events.some(event => event.visible)) return null;
      // Undo the plate's own drawn matrix, not the body's. A body hidden at
      // t=0 has no pose yet, and a hidden plate keeps the placement it last
      // showed with, so the body matrix would misplace its anchor.
      const drawn = repr.state?.transform;
      const point = drawn ? Vec3.transformMat4(Vec3(), Vec3.transformMat4(Vec3(), posedPoint, getTransform()),
        Mat4.invert(Mat4(), drawn)) : posedPoint;
      return trackPointEnvelope(track, point);
    },
    selectionSphere(loci) {
      if (!definition || source !== getStructure()?.obj?.data) return StructureElement.Loci.getBoundingSphere(loci);
      if (!selectionBounds.has(loci)) selectionBounds.set(loci, bodyBounds(loci, definition));
      return enclose(selectionBounds.get(loci).map(({body, sphere}) => {
        const track = definition.tracks.find(track => track.id === body);
        const pose = track ? evaluateTrack(track, clock.snapshot(clockSample).timeSeconds) : undefined;
        return pose ? transformSphere(sphere, poseMatrix(pose)) : sphere;
      }));
    },
    /** `selectionSphere` less the bodies their tracks hide now: the part of
     * `loci` on screen at this instant, from the same per-loci body bounds, so
     * a caller that keeps its loci measures atoms once and only poses after.
     * Undefined with no animation on this structure, or with nothing drawn. */
    drawnSphere(loci) {
      if (!definition || !clock || source !== getStructure()?.obj?.data) return undefined;
      if (!selectionBounds.has(loci)) selectionBounds.set(loci, bodyBounds(loci, definition));
      const time = clock.snapshot(clockSample).timeSeconds, spheres = [];
      for (const {body, sphere} of selectionBounds.get(loci)) {
        const track = body === undefined ? undefined : definition.tracks.find(track => track.id === body);
        if (!track) { spheres.push(sphere); continue; }
        if (evaluateTrackVisibility(track, time)) spheres.push(transformSphere(sphere, poseMatrix(evaluateTrack(track, time))));
      }
      return enclose(spheres);
    },
    apply, snapshot,
    // Public diagnostic only: distinguish a missing frame from an intentional
    // suspension without publishing either into the saved scientific scene.
    activity: () => ({ ready, suspended, halted, canTick: canTick(), immersive: isImmersive(),
      scheduled: frame !== undefined, frameSamples, lastFrameTimestampMs: lastFrameTimestampMs ?? null,
      faulted: Boolean(frameError) }),
    poseSample: () => clock ? {definition, timeSeconds:clock.snapshot(clockSample).timeSeconds} : undefined,
    reanchor() { clock?.reanchor(); start(); },
    owns: repr => owned.has(repr),
    replaces: repr => originals.has(repr),
    tetherRepresentations,
    representations: () => [...records.filter(r => r.root).map(r => r.repr), ...tetherRepresentations()],
    drawn(objects) {
      if (frameError) throw frameError;
      if (clock && !ready) return false;
      if (tethers.some(tether => [tether.from, tether.to].some(endpoint => !Array.isArray(endpoint?.representations))))
        throw Error('Molecular animation tether coverage is unavailable.');
      return [...records, ...tetherRepresentations().map(repr => ({repr}))].every(r => r.repr.renderObjects.every(o => objects.has(o))
      && (!r.repr.state.visible || r.repr.renderObjects.some(o => o.values.drawCount.ref.value > 0))); },
    extraCount: () => records.filter(r => r.root).length + tetherRepresentations().length,
    forget() { prepared = undefined; frameError = undefined; generation++; controlRevision++; stop(); clock = undefined; definition = undefined; return enqueue(remove); },
  };
  return api;
}
