/**
 * Historical mesh-equivalent work estimates per eye, not FPS predictions or
 * measured safety limits. The Quest 2 thresholds were interpolated from a few
 * observations; they do not justify refusing a structure or changing its detail.
 * Default decisions only advise that a costly scene may run slowly. The chosen
 * quality, representation, impostors and material parameters remain unchanged.
 * Other headset classes, including Vision Pro, retain their unbounded policy.
 *
 * Mol* 5.11's quality table and primitives provide the estimates. Surface area
 * and cartoon cross-sections are proxies, not exact triangulation; impostors
 * also have fragment cost. Assume 1.2 bonds/atom if unavailable. Only the explicit
 * measurement knob `budget:draw` retains the legacy detail reduction algorithm
 * so earlier physical captures remain comparable. It is not a wearer default.
 */
import { HEAVY_SCENE_ATOM_SITES } from './xr-render-budget.mjs';

export const GEOMETRY_LEVELS = Object.freeze(['lowest', 'lower', 'low', 'medium', 'high', 'higher', 'highest']);
export const GEOMETRY_DETAIL = Object.freeze({
  lowest: { detail: 0, radialSegments: 2, linearSegments: 1, resolution: 8, probePositions: 12, doubleSided: false },
  lower: { detail: 0, radialSegments: 4, linearSegments: 2, resolution: 3, probePositions: 12, doubleSided: false },
  low: { detail: 0, radialSegments: 8, linearSegments: 3, resolution: 1.3, probePositions: 24, doubleSided: false },
  medium: { detail: 1, radialSegments: 12, linearSegments: 8, resolution: 0.8, probePositions: 24, doubleSided: true },
  high: { detail: 2, radialSegments: 20, linearSegments: 10, resolution: 0.5, probePositions: 36, doubleSided: true },
  higher: { detail: 3, radialSegments: 28, linearSegments: 14, resolution: 0.3, probePositions: 48, doubleSided: true },
  highest: { detail: 3, radialSegments: 36, linearSegments: 18, resolution: 0.1, probePositions: 72, doubleSided: true },
});
const ceilings = multiplier => Object.freeze({ 'ball-and-stick': 260_000 * multiplier,
  spacefill: 120_000 * multiplier, 'molecular-surface': 400_000 * multiplier, cartoon: 300_000 * multiplier });
export const REPRESENTATION_BUDGETS = Object.freeze({ quest2: ceilings(1), quest3: ceilings(Infinity),
  'quest-pro': ceilings(Infinity), 'vision-pro': ceilings(Infinity), 'hand-only': ceilings(Infinity),
  desktop: ceilings(Infinity), unknown: ceilings(Infinity) });
const names = { 'ball-and-stick': 'sticks', spacefill: 'atoms', 'molecular-surface': 'surface', cartoon: 'cartoon' };
const count = (n, name) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error(`Cannot budget geometry: invalid ${name} count.`);
  return n;
};
export function structureGeometryCounts(structure, representation) {
  // Mol* infers inter-unit bonds lazily. A composite of overlapping alternate
  // complexes can spend seconds on that graph. Nonbond geometry estimates do
  // not use it; defer the scientific computation until a bond consumer asks.
  const needsBonds = !['cartoon', 'spacefill', 'molecular-surface', 'gaussian-surface'].includes(representation);
  return { atoms: count(structure.elementCount, 'atom'),
    ...(needsBonds ? { bonds: count(structure.bondCount, 'bond') } : {}),
    residues: count(structure.atomicResidueCount, 'residue') };
}
export function effectiveGeometryLevel(quality, atoms, standalone = false) {
  const requested = GEOMETRY_LEVELS.includes(quality) ? quality
    : atoms > 1_000_000 ? 'lowest' : atoms > 500_000 ? 'lower' : atoms > 100_000 ? 'low'
      : atoms > 20_000 ? 'medium' : atoms > 2_000 ? 'high' : 'higher';
  return GEOMETRY_LEVELS[Math.max(0, GEOMETRY_LEVELS.indexOf(requested) - (standalone ? 1 : 0))];
}
export function estimateRepresentation({ representation, atoms, bonds = Math.ceil(atoms * 1.2), residues = atoms, level = 'lower' }) {
  count(atoms, 'atom'); count(bonds, 'bond'); count(residues, 'residue');
  const p = GEOMETRY_DETAIL[level];
  if (!p || !names[representation]) throw Error('Cannot budget this representation or detail level.');
  const sphereVertices = 10 * 4 ** p.detail + 2;
  // Mol* substitutes capped prisms for radialSegments <= 4 (6 vertices/side).
  const cylinderVertices = p.radialSegments <= 4 ? 6 * Math.max(3, p.radialSegments) : 6 * p.radialSegments + 4;
  // Surface: unshared sphere area at 3.2 A solvent radius / grid cell area.
  // Cartoon: two faces of a radial cross-section along each residue segment,
  // plus one sphere per residue for caps/nucleotide geometry allowance.
  const vertices = representation === 'ball-and-stick' ? atoms * sphereVertices + bonds * 2 * cylinderVertices
    : representation === 'spacefill' ? atoms * sphereVertices
      : representation === 'molecular-surface' ? Math.ceil(atoms * 4 * Math.PI * 3.2 ** 2 / p.resolution ** 2)
        : residues * (2 * (p.linearSegments + 1) * Math.max(3, p.radialSegments) + sphereVertices);
  return { representation, level, atoms, bonds, residues, sphereVertices, cylinderVertices, vertices };
}
export function geometryBudgetDecision({ representation, atoms, bonds, residues, deviceClass = 'desktop',
  presenting = false, quality, standalone = false, overBudget = geometryDebugOptions().overBudget }) {
  const level = effectiveGeometryLevel(quality, atoms, standalone);
  const estimate = estimateRepresentation({ representation, atoms, bonds, residues, level });
  const budget = (REPRESENTATION_BUDGETS[deviceClass] ?? REPRESENTATION_BUDGETS.unknown)[representation];
  const base = { representation, deviceClass, atoms, budget, requestedLevel: level, level, estimatedVertices: estimate.vertices };
  if (!presenting || deviceClass === 'desktop' || estimate.vertices <= budget) return { ...base, status: 'unchanged', typeParams: {} };
  if (overBudget !== 'draw') return { ...base, status: 'advisory', typeParams: {},
    message: `Showing ${names[representation]} at requested detail; it may run slowly.` };
  for (let i = GEOMETRY_LEVELS.indexOf(level) - 1; i >= 0; i--) {
    const next = estimateRepresentation({ representation, atoms, bonds, residues, level: GEOMETRY_LEVELS[i] });
    if (next.vertices > budget) continue;
    return { ...base, status: 'reduced', level: next.level, estimatedVertices: next.vertices,
      typeParams: reducedTypeParams(representation, next.level),
      message: `Showing ${names[representation]} at reduced detail under the current geometry policy.` };
  }
  // Explicit legacy measurement mode: retain the old lowest-detail capture.
  const lowest = estimateRepresentation({ representation, atoms, bonds, residues, level: 'lowest' });
  return { ...base, status: 'reduced', level: 'lowest', estimatedVertices: lowest.vertices,
    typeParams: reducedTypeParams(representation, 'lowest'),
    message: `Showing ${names[representation]} at lowest detail, past the ${budget}-vertex geometry policy.` };
}
/**
 * Knobs from the live page's `?xrRenderBudget=` list. Two are measurement-only,
 * for qualifying the ceilings above on a headset: `budget:draw` builds past a
 * historical threshold using the legacy detail ladder, and `hydrogens:off`
 * drops hydrogens from spheres and sticks. `sphere:` picks how spacefill draws
 * its spheres (see `sphereTypeParams`): `sphere:impostor`, `sphere:<0-3>` for a
 * mesh at that subdivision, `sphere:mesh` for the heavy-tier mesh rule as a
 * default would apply it, or `sphere:auto` for the immersive default. Off a
 * page, or with none set, this is empty and every decision is unchanged.
 */
export function geometryDebugOptions(scope = globalThis) {
  let raw;
  try { raw = new URLSearchParams(String(scope?.location?.search ?? '')).get('xrRenderBudget'); } catch { return {}; }
  const options = {};
  for (const pair of String(raw ?? '').split(/[,;]/)) {
    const [key = '', value = ''] = pair.split(/[:=]/).map(part => part.trim().toLowerCase());
    if (key === 'budget' && value === 'draw') options.overBudget = 'draw';
    else if ((key === 'hydrogens' || key === 'h') && ['off', '0', 'false', 'no'].includes(value)) options.ignoreHydrogens = true;
    else if ((key === 'sphere' || key === 'spheredetail') && /^[0-3]$/.test(value)) options.sphereDetail = Number(value);
    else if ((key === 'sphere' || key === 'spheredetail') && value === 'impostor') options.sphereDetail = 'impostor';
    else if ((key === 'sphere' || key === 'spheredetail') && value === 'mesh') options.sphereDetail = 'mesh';
    else if ((key === 'sphere' || key === 'spheredetail') && value === 'auto') delete options.sphereDetail;
  }
  return options;
}
function reducedTypeParams(representation, level) {
  return { quality: 'custom', ...GEOMETRY_DETAIL[level], tryUseImpostor: false,
    ...(representation === 'ball-and-stick' ? { sizeFactor: 0.1, sizeAspectRatio: 0.5 } : {}) };
}
/**
 * The subdivision the heavy-tier rule builds when the address asks for it
 * (`sphere:mesh`): detail 1, which looks like the impostors at the giant pose.
 * The heavy-tier default builds the same (`XR_HEAVY_SPHERE_MESH_DETAIL`).
 */
export const XR_SPHERE_MESH_DETAIL = 1;
/**
 * The mesh subdivision spacefill takes on a Quest 2 above the heavy tier
 * (`HEAVY_SCENE_ATOM_SITES`) in an immersive session, or `null` to keep
 * impostors there as everywhere else.
 *
 * Measured on a Quest 2, 1AON (58,870 atoms) at the giant pose, app GPU time
 * per frame in one session: impostors 43.9 to 46.7 ms (16 to 17 fps), detail
 * 1 24.9 ms (30 fps), detail 0 9.9 to 10.0 ms (69 to 70 fps), each built by
 * a live switch after the session had entered and placed the structure. Built
 * at session entry instead, as a default would be, detail 1 froze the page: one
 * 12.7 s frame, then no frames. The menu's clearance proofs read every vertex
 * of the mesh (2.47 M) on each menu draw while the menu showed at the entry
 * seat; they now read a spacefill mesh as they read impostors (`atomSphereMesh`
 * in component-label-measurement.mjs), so the default is detail 1
 * (`XR_SPHERE_MESH_DETAIL`). `sphere:impostor` keeps impostors, and `sphere:0`
 * remains an address setting.
 *
 * Mol*'s impostor sphere shader discards outside the silhouette and writes
 * `gl_FragDepth`, so a Quest 2 (Adreno 650; no `EXT_conservative_depth` in
 * Quest Browser) rejects none of its fragments early and shades every layer
 * of overlapping spheres. A mesh sphere is plain triangles, which the opaque
 * mesh variant on Quest draws without `discard` or a depth write, so a hidden
 * fragment fails the depth test before it shades. Detail 0 is an icosahedron
 * (12 vertices, 20 triangles a sphere), detail 1 has 42 and 80. A sphere a few
 * pixels across looks the same either way; one close to the eye shows the
 * mesh's straight edges in its outline.
 */
export const XR_HEAVY_SPHERE_MESH_DETAIL = XR_SPHERE_MESH_DETAIL;
/** Device classes the heavy-tier sphere mesh applies to: the ones measured. */
export const XR_SPHERE_MESH_DEVICES = Object.freeze(['quest2']);
/**
 * The most sphere triangles the automatic mesh may build for one
 * representation: 1AON (58,870 atoms) at detail 1 is 4,709,600, the largest
 * mesh-sphere scene measured on a Quest 2. Past it the scene keeps impostors,
 * whose geometry is 16 bytes a sphere where a mesh's is about 770 (detail 0)
 * or 2,700 (detail 1), held twice: in the page and on the GPU.
 */
export const XR_SPHERE_MESH_TRIANGLE_CEILING = 5_000_000;
/** Triangles in one Mol* mesh sphere at a subdivision detail. */
export const sphereMeshTriangles = detail => 20 * 4 ** detail;
/**
 * The mesh subdivision a heavy spacefill takes on a Quest 2 while a lesson
 * owns the scene: detail 0, an icosahedron (20 triangles a sphere).
 *
 * A lesson frames its whole structure clear of the wearer
 * (`LESSON_MIN_TARGET_FRACTION`), so every sphere is a few pixels across and
 * the icosahedron's straight edges do not show; the giant pose the detail-1
 * default was chosen for is not a lesson framing. Measured on a Quest 2, the
 * microtubule wall (40,908 atoms) framed whole in its spacefill chapter, solid
 * context, app GPU time per frame: impostors 26 to 35 ms, detail 1 81 ms,
 * detail 0 15.7 to 16.9 ms. Detail 1 is slower than impostors there because
 * the whole mesh is in view in both eyes, 3.3 M triangles drawn twice per eye
 * with the depth pre-pass.
 */
export const XR_LESSON_SPHERE_MESH_DETAIL = 0;
/**
 * The most sphere triangles the lesson mesh may build for one representation;
 * past it a lesson keeps impostors. It lies between the largest lesson mesh
 * measured faster than impostors and the smallest measured slower, both on a
 * Quest 2 in the microtubule spacefill chapters: the wall at detail 0
 * (818,160 triangles) drew in 16 ms against 26 to 35 ms with impostors, and
 * the whole tube at detail 0 (3,545,360 triangles) took 92 ms a frame against
 * 60 ms with impostors.
 */
export const XR_LESSON_SPHERE_MESH_TRIANGLE_CEILING = 1_000_000;
/**
 * The most atoms a spacefill may hold and still keep its emphasis context
 * solid: the lesson mesh's own ceiling (1,000,000 triangles at detail 0), the
 * range where a solid context was measured faster. Past it the structure keeps
 * the translucent ghost and impostors it had: the whole tube (177,268 atoms)
 * was not measured faster solid on a Quest 2, so it draws as it did.
 */
export const XR_SOLID_CONTEXT_ATOM_CEILING = XR_LESSON_SPHERE_MESH_TRIANGLE_CEILING / sphereMeshTriangles(XR_LESSON_SPHERE_MESH_DETAIL);
/**
 * Whether an emphasis keeps the rest of a structure solid instead of fading
 * it to a translucent ghost: in an immersive session on a measured device
 * class, for a spacefill of more than `HEAVY_SCENE_ATOM_SITES` atoms and at
 * most `XR_SOLID_CONTEXT_ATOM_CEILING`. The
 * focused parts keep their key colours and the rest keeps the structure's own
 * colour, so the subject still stands alone in colour.
 *
 * A ghost is drawn in Mol*'s blended pass with depth writes off, so every
 * layer of spheres behind the front one is shaded and blended, and the opaque
 * pass still runs over every sphere first. Measured on a Quest 2, the
 * microtubule wall's spacefill chapter (40,908 atoms, ligands lit, the rest at
 * the 0.35 passthrough ghost), app GPU time per frame: ghost with impostors
 * 55 to 63 ms, ghost with detail-0 mesh spheres 63 ms, solid with impostors
 * 26 to 35 ms, solid with detail-0 mesh spheres 15.7 to 16.9 ms. Pure.
 */
export function solidEmphasisContext({ representation, presenting = false, deviceClass = 'desktop', atoms = 0 } = {}) {
  return representation === 'spacefill' && presenting === true && XR_SPHERE_MESH_DEVICES.includes(deviceClass)
    && Number.isFinite(atoms) && atoms > HEAVY_SCENE_ATOM_SITES && atoms <= XR_SOLID_CONTEXT_ATOM_CEILING;
}
/**
 * Mol* type params for how one spacefill representation draws its spheres;
 * empty means Mol*'s own choice (impostors wherever WebGL supports them).
 *
 * A path typed on the address (`sphere`: `'impostor'` or a detail 0 to 3) wins
 * wherever the address carries it, flat or immersive, which is how a flat
 * render pair of the two paths is made. Without one, a mesh is chosen only in
 * an immersive session, on a measured device class, for a representation of
 * more than `HEAVY_SCENE_ATOM_SITES` atoms whose mesh stays within
 * `XR_SPHERE_MESH_TRIANGLE_CEILING`, and only once
 * `XR_HEAVY_SPHERE_MESH_DETAIL` names a detail (detail 1 as shipped);
 * `sphere: 'mesh'` applies that same rule at `XR_SPHERE_MESH_DETAIL` whatever
 * the shipped default is. Past the ceiling the scene
 * keeps impostors rather than dropping to a coarser mesh. A lesson (`lesson`:
 * a chapter playing, or a lesson figure installed) takes the same rule at
 * `XR_LESSON_SPHERE_MESH_DETAIL`, up to `XR_LESSON_SPHERE_MESH_TRIANGLE_CEILING`
 * and only while the representation is opaque (`opacity` 1). Such a scene draws its emphasis context
 * solid (`solidEmphasisContext`); with a translucent ghost the mesh gained
 * nothing (a lesson's heaviest spacefill chapter ran at 3 to 4 fps with the
 * detail-1 mesh against 10 to 12 fps with impostors). A geometry reduction
 * (`budget:draw`) already draws meshes and keeps its own detail. Pure.
 */
export function sphereTypeParams({ representation, presenting = false, deviceClass = 'desktop', atoms = 0,
  sphere, reduced = false, lesson = false, opacity = 1, heavyDetail = XR_HEAVY_SPHERE_MESH_DETAIL } = {}) {
  if (representation !== 'spacefill') return {};
  if (sphere === 'impostor') return { tryUseImpostor: true };
  const rule = lesson ? XR_LESSON_SPHERE_MESH_DETAIL : sphere === 'mesh' ? XR_SPHERE_MESH_DETAIL : heavyDetail;
  const ceiling = lesson ? XR_LESSON_SPHERE_MESH_TRIANGLE_CEILING : XR_SPHERE_MESH_TRIANGLE_CEILING;
  // A translucent lesson spacefill keeps impostors: translucent spheres are
  // shaded layer by layer whatever their geometry, and the mesh gained nothing.
  const detail = Number.isInteger(sphere) ? sphere
    : !reduced && presenting && XR_SPHERE_MESH_DEVICES.includes(deviceClass) && atoms > HEAVY_SCENE_ATOM_SITES
      && (!lesson || !(opacity < 1))
      && Number.isInteger(rule) && atoms * sphereMeshTriangles(rule) <= ceiling
      ? rule : null;
  return Number.isInteger(detail) && detail >= 0 && detail <= 3
    ? { quality: 'custom', detail, doubleSided: false, tryUseImpostor: false } : {};
}
/**
 * Lay `hydrogens` from `geometryDebugOptions` and the sphere path from
 * `sphereTypeParams` over a decision; the estimate is unchanged. `context`
 * carries what the decision does not: whether a session presents, whether a
 * lesson owns the scene, and the entry's own atom count when the decision's
 * count is a whole scene's.
 */
export function withGeometryDebug(decision, { ignoreHydrogens, sphereDetail } = geometryDebugOptions(), context = {}) {
  if (!decision || typeof decision !== 'object') return decision;
  const extra = {};
  if (ignoreHydrogens === true && ['spacefill', 'ball-and-stick'].includes(decision.representation)) extra.ignoreHydrogens = true;
  Object.assign(extra, sphereTypeParams({ representation: decision.representation, presenting: context.presenting === true,
    deviceClass: decision.deviceClass, atoms: context.atoms ?? decision.atoms, sphere: sphereDetail,
    reduced: decision.status === 'reduced', lesson: context.lesson === true, opacity: context.opacity ?? 1 }));
  return Object.keys(extra).length ? { ...decision, typeParams: { ...decision.typeParams, ...extra } } : decision;
}
export function requireGeometryBudget(input) {
  return withGeometryDebug(geometryBudgetDecision(input), geometryDebugOptions(),
    { presenting: input?.presenting === true, lesson: input?.lesson === true, opacity: input?.opacity ?? 1 });
}
export function geometryBudgetReceipt(decision) {
  if (!['advisory', 'reduced'].includes(decision?.status)) return undefined;
  const { representation, deviceClass, atoms, budget, requestedLevel, level, estimatedVertices, message } = decision;
  // The receipt travels as JSON, which writes Infinity and NaN as null, and the
  // host refuses a completion whose receipt carries a null number. A reduction
  // without finite numbers is not one a wearer can be told about.
  if (!Number.isSafeInteger(atoms) || atoms < 0 || !Number.isFinite(budget) || budget <= 0
    || !Number.isSafeInteger(estimatedVertices) || estimatedVertices < 0) return undefined;
  return { representation, deviceClass, atoms, budget, requestedLevel, level, estimatedVertices, message };
}
export function geometryBudgetConfirmation(applied, fallback) {
  if (!applied?.geometryBudget) return fallback;
  return applied.geometryBudget.message + (applied.scaleAppliesOnNextEntry ? ' Resolution changes after re-entry.' : '');
}

/** Mixed representations contribute to one scene advisory. */
export function requireComparisonGeometryBudget(primary, companion, options = {}) {
  return requireSceneGeometryBudget([primary, companion], options);
}

/** Combine work estimates without changing any requested entry detail.
 * Hidden base atoms still have geometry, so masking does not subtract their cost. */
export function requireSceneGeometryBudget(entries, options = {}) {
  const debug = geometryDebugOptions();
  const deviceClass = options.deviceClass ?? 'desktop';
  const budgets = REPRESENTATION_BUDGETS[deviceClass] ?? REPRESENTATION_BUDGETS.unknown;
  const bounded = entry => Number.isFinite(budgets[entry.representation]);
  // An unmeasured headset has no allowance to share, so its scene is judged
  // entry by entry, as on a desktop: unchanged, with no forced detail and no
  // receipt. Sharing an unbounded allowance put a zero fraction against an
  // Infinity budget, and the receipt carried Infinity and NaN. The host
  // refused three visionOS simulator completions with a 409 for it.
  if (!options.presenting || deviceClass === 'desktop' || !entries.some(bounded))
    return entries.map(entry => requireGeometryBudget({ ...options, ...entry }));
  if ((options.overBudget ?? debug.overBudget) !== 'draw') {
    const estimates = entries.map(entry => estimateRepresentation({ ...entry,
      level: effectiveGeometryLevel(entry.quality ?? options.quality, entry.atoms, entry.standalone ?? options.standalone) }));
    const fraction = estimates.reduce((sum, entry) => sum + (bounded(entry) ? entry.vertices / budgets[entry.representation] : 0), 0);
    return estimates.map((entry, index) => bounded(entry) ? withGeometryDebug({
      representation: entry.representation, deviceClass, atoms: entries.reduce((sum, item) => sum + item.atoms, 0),
      budget: budgets[entry.representation], requestedLevel: entry.level, level: entry.level,
      estimatedVertices: Math.ceil(fraction * budgets[entry.representation]),
      status: fraction > 1 ? 'advisory' : 'unchanged', typeParams: {},
      ...(fraction > 1 ? { message: 'Showing the requested scene detail; it may run slowly.' } : {}),
    }, debug, { presenting: true, atoms: entry.atoms, lesson: options.lesson === true, opacity: entries[index].opacity ?? 1 })
      : requireGeometryBudget({ ...options, ...entries[index] }));
  }
  // Legacy measurement mode alone may reduce geometry. Keep its old shared
  // detail ladder for comparisons with the original budget:draw captures.
  // Only the entries that spend the allowance set the level it starts from; a
  // large unbounded entry would otherwise lower every bounded one's detail.
  const requested = Math.min(...entries.filter(bounded).map(entry => GEOMETRY_LEVELS.indexOf(
    effectiveGeometryLevel(options.quality, entry.atoms, options.standalone))));
  for (let i = requested; i >= 0; i--) {
    const level = GEOMETRY_LEVELS[i];
    const estimates = entries.map(entry => estimateRepresentation({ ...entry, level }));
    const fraction = estimates.reduce((sum, entry) => sum + (bounded(entry) ? entry.vertices / budgets[entry.representation] : 0), 0);
    if (fraction > 1) continue;
    // A representation without a ceiling spends none of the allowance, so it
    // keeps its own detail while the bounded ones share the reduction.
    return estimates.map((entry, index) => bounded(entry) ? withGeometryDebug({ representation: entry.representation, deviceClass,
      atoms: entries.reduce((sum, item) => sum + item.atoms, 0), budget: budgets[entry.representation],
      requestedLevel: GEOMETRY_LEVELS[requested], level, estimatedVertices: Math.ceil(fraction * budgets[entry.representation]),
      status: 'reduced', typeParams: { quality: 'custom', ...GEOMETRY_DETAIL[level], tryUseImpostor: false },
      message: `Showing the scene at ${level} detail under the current geometry policy.` }, debug, { presenting: true, atoms: entry.atoms, lesson: options.lesson === true })
      : requireGeometryBudget({ ...options, ...entries[index] }));
  }
  return entries.map(entry => withGeometryDebug({
    representation: entry.representation, deviceClass, atoms: entry.atoms, budget: budgets[entry.representation],
    requestedLevel: GEOMETRY_LEVELS[requested], level: 'lowest', status: 'reduced',
    estimatedVertices: estimateRepresentation({ ...entry, level: 'lowest' }).vertices,
    typeParams: reducedTypeParams(entry.representation, 'lowest'),
    message: 'Showing the scene at lowest detail, past the current geometry policy.' }, debug, { presenting: true, atoms: entry.atoms, lesson: options.lesson === true }));
}
