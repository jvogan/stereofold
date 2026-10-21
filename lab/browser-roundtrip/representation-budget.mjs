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
 * Measurement-only knobs from the live page's `?xrRenderBudget=` list, for
 * qualifying the ceilings above on a headset: `budget:draw` builds past a
 * historical threshold using the legacy detail ladder, `hydrogens:off` drops
 * hydrogens from spheres and sticks, and `sphere:<0-3>` builds spacefill as a
 * mesh at that subdivision (`sphere:impostor` as impostors). None is a wearer setting. Off a page, or with none
 * set, this is empty and every decision is unchanged.
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
  }
  return options;
}
function reducedTypeParams(representation, level) {
  return { quality: 'custom', ...GEOMETRY_DETAIL[level], tryUseImpostor: false,
    ...(representation === 'ball-and-stick' ? { sizeFactor: 0.1, sizeAspectRatio: 0.5 } : {}) };
}
/** Lay `hydrogens` and `sphere` from `geometryDebugOptions` over a decision; the estimate is unchanged. */
export function withGeometryDebug(decision, { ignoreHydrogens, sphereDetail } = geometryDebugOptions()) {
  if (!decision || typeof decision !== 'object') return decision;
  const extra = {};
  if (ignoreHydrogens === true && ['spacefill', 'ball-and-stick'].includes(decision.representation)) extra.ignoreHydrogens = true;
  if (Number.isInteger(sphereDetail) && decision.representation === 'spacefill')
    Object.assign(extra, { quality: 'custom', detail: sphereDetail, tryUseImpostor: false });
  if (sphereDetail === 'impostor' && decision.representation === 'spacefill') extra.tryUseImpostor = true;
  return Object.keys(extra).length ? { ...decision, typeParams: { ...decision.typeParams, ...extra } } : decision;
}
export function requireGeometryBudget(input) {
  return withGeometryDebug(geometryBudgetDecision(input));
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
    }, debug) : requireGeometryBudget({ ...options, ...entries[index] }));
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
      message: `Showing the scene at ${level} detail under the current geometry policy.` }, debug)
      : requireGeometryBudget({ ...options, ...entries[index] }));
  }
  return entries.map(entry => withGeometryDebug({
    representation: entry.representation, deviceClass, atoms: entry.atoms, budget: budgets[entry.representation],
    requestedLevel: GEOMETRY_LEVELS[requested], level: 'lowest', status: 'reduced',
    estimatedVertices: estimateRepresentation({ ...entry, level: 'lowest' }).vertices,
    typeParams: reducedTypeParams(entry.representation, 'lowest'),
    message: 'Showing the scene at lowest detail, past the current geometry policy.' }, debug));
}
