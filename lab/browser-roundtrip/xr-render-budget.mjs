/**
 * What the headset is allowed to spend on one immersive frame.
 *
 * Five levers decide whether a scene holds a frame rate: how many pixels the
 * XR layer allocates, which target frame rate the session asks for, which
 * full-screen passes run between the scene and the layer, how much geometry
 * Mol* builds for a representation, and how large the pick buffer is. This
 * module owns all five. Fixed foveation is the sixth and is owned by
 * `xr-session-request.mjs`; `renderBudget` reports the level that module will
 * apply rather than setting it a second time.
 *
 * `watchFrameCost` records callback CPU, native frame gaps and browser long
 * tasks. None of those is GPU timing; fill, geometry rebuilds, compositor
 * scheduling and recording must be distinguished with their own evidence.
 *
 * Everything here is a description or a restorable mutation. The numbers come
 * from pure functions that run under Node against plain objects, so the
 * budget table is testable without a headset, a browser, or WebGL.
 *
 * `renderQualityPreset` is the wearer's own lever over all of it: three levels,
 * `fast`, `balanced` and `best`, each one a set of the knobs `?xrRenderBudget=`
 * already spells. The level is laid UNDER whatever the address names, so a
 * typed knob still wins, and it is read from `sessionStorage` on first use so
 * the first representation is already built at the level the wearer chose.
 * `viewer.inspection.setRenderQuality` is the entry point.
 *
 * Two Mol* 5.11 behaviours shaped these choices, both read from
 * `node_modules/molstar` rather than assumed:
 *
 * - `mol-gl/renderer.js:215-237` runs its instance-grid frustum and Hi-Z
 *   occlusion cull only when `modelScale === 1`. `modelScale` is
 *   `camera.scale` (`renderer.js:344`), and the XR camera scale is
 *   `sceneRadiusInMeters / boundingSphere.radius`
 *   (`mol-canvas3d/helper/xr-manager.js:203-206`), roughly 0.006 for the
 *   lattice. Per-instance culling is therefore inactive in immersion for
 *   every geometry except spheres, which take the `cullSimple` LOD path.
 * - `mol-canvas3d/canvas3d.js:377-385` already forces postprocessing off,
 *   Hi-Z off, transparency to `blended` and the camera axes off on every XR
 *   frame, driven by `xr.disablePostprocessing` (default true). The lever
 *   that survives a frame is the `xr` prop, not `postprocessing.enabled`,
 *   which `setXRProps` overwrites each frame.
 * - `mol-repr/util.js:127-131` lowers any explicit quality by one level when
 *   `isStandaloneHmd()` is true, which is a Quest Browser user-agent test
 *   (`mol-util/browser.js:25-32`). Every tier this module names is therefore
 *   one level higher than what a Quest builds, and no emulator frame can show
 *   the difference. See `XR_SURFACE_QUALITY`.
 */

import { CHAIN_COLOR_PARAMS } from './inspection-appearance.mjs';
import { deviceClass, describeInputSources } from './input-capabilities.mjs';
import { describeXrLayer, foveationLevelFor } from './xr-session-request.mjs';

/** Atom sites at which a Quest 2 moves off its lightest framebuffer tier. */
export const MEDIUM_SCENE_ATOM_SITES = 8_000;

/** Atom sites above which a Quest 2 takes its smallest framebuffer tier. */
export const HEAVY_SCENE_ATOM_SITES = 25_000;

/**
 * The frame rate a Quest 2 asks for, on every scene.
 *
 * Meta's `webxr-frames` document states a WebXR session runs at 90 fps by
 * default on Quest 2 and 72 fps on other Quest headsets, so 72 here is a
 * deliberate request for 13.9 ms of frame budget instead of 11.1 ms. A scene
 * that misses the 90 Hz window does not fall to 72; it falls to 45 through
 * asynchronous timewarp, which reprojects and judders. 9KJ6, 13,121 atom
 * sites, measured 30 to 46 fps on a Quest 2 at the runtime default. A site
 * count therefore gates nothing here: the smallest scene that needs 72 Hz is
 * well under any threshold worth naming.
 */
export const QUEST2_TARGET_FRAME_RATE = 72;

/**
 * Quest 2 layer scale per scene tier: light, medium, heavy.
 *
 * The medium tier was 0.7. 9KJ6 at 13,121
 * atom sites held 50 to 67 fps there against a 72 Hz request, so the session
 * was missing its window by roughly a third. Fragments fall with the square of
 * the scale, and 0.6 draws 73 percent of the fragments 0.7 draws, which buys
 * back about 1.36x on a fill-bound frame. That is the size of the gap. The
 * heavy tier steps down with it to keep one quarter-of-fragments gap between
 * the tiers.
 */
export const QUEST2_SCALE_LIGHT = 0.8;
export const QUEST2_SCALE_MEDIUM = 0.6;
export const QUEST2_SCALE_HEAVY = 0.5;

/**
 * `XRWebGLLayer.framebufferScaleFactor` per device class. Mol* multiplies
 * this by `webgl.pixelScale` when it builds the layer
 * (`mol-gl/webgl/context.js:319`), so 0.8 costs 64 percent of the fragments
 * a full-scale layer costs. Quest 2 is fill-rate bound; every other class
 * keeps native scale. The Quest 2 entry is its lightest tier, read from that
 * tier rather than restated, which `quest2FramebufferScale` lowers as the
 * scene grows.
 */
export const FRAMEBUFFER_SCALE_BY_DEVICE = Object.freeze({ quest2: QUEST2_SCALE_LIGHT });

/**
 * Mol* geometry quality per device class while a session presents.
 *
 * `createStructureRepresentationParams` defaults to `'auto'`, which sizes
 * cartoon subdivisions and ball-and-stick segments from the site count for a
 * desktop GPU. A Quest 2 pays that vertex count twice per frame, once per eye,
 * and pays it again on the main thread every time a tour step rebuilds the
 * representation. `viewer.mjs` reads this through `xrRepresentationQuality`.
 */
export const REPRESENTATION_QUALITY_BY_DEVICE = Object.freeze({ quest2: 'low', quest3: 'medium', 'quest-pro': 'medium' });

/**
 * Mol*'s quality tiers, lowest first (`mol-repr/util.js:45-55`).
 *
 * Named here because two things below step along this ladder: the surface
 * tier, and the one-level demotion Mol* applies on a standalone headset.
 */
export const QUALITY_LEVELS = Object.freeze(['lowest', 'lower', 'low', 'medium', 'high', 'higher', 'highest']);

/**
 * Representation types whose geometry is a marching-cubes surface mesh.
 *
 * These are the only representations whose quality tier decides a grid
 * resolution rather than a per-element subdivision count, which is why they
 * get their own tier below. `gaussian_surface` is the underscore spelling the
 * demo files use for the same Mol* provider.
 */
export const SURFACE_REPRESENTATIONS = Object.freeze([
  'molecular-surface', 'gaussian-surface', 'gaussian_surface', 'gaussian-volume', 'gaussian_volume',
]);

/** Whether a representation name builds a surface mesh. */
export function isSurfaceRepresentation(name) {
  return typeof name === 'string' && SURFACE_REPRESENTATIONS.includes(name.trim().toLowerCase());
}

/**
 * Representation types that draw a DENSITY MAP, not a structure.
 *
 * `isosurface` is Mol*'s volume representation. It is a marching-cubes mesh
 * like the entries in `SURFACE_REPRESENTATIONS` above, and it is deliberately
 * NOT one of them, which is the single most important line in this file for the
 * `filament` tier:
 *
 * - Everything in `SURFACE_REPRESENTATIONS` is a surface OF A STRUCTURE. Its
 *   grid resolution is set by `surfaceQuality`, its cost scales with the atom
 *   count it is wrapped around, and `representationForBudget` may demote it to
 *   `cartoon` because the same atoms can be drawn a cheaper way.
 * - An `isosurface` is built from a CCP4 grid. There are no atoms behind it, its
 *   triangle count is fixed by the map and the contour before the page ever sees
 *   it, and there is no cheaper representation of the same data: a cartoon of a
 *   density map is an empty room.
 *
 * So a volume representation is exempt from the surface rules, and its own rule
 * — `isosurfaceForBudget` — keys on the triangle count. Never on atom sites: a
 * volume tier carries zero of those, so an atom-site test reads a mesh of any
 * size as free.
 */
export const VOLUME_REPRESENTATIONS = Object.freeze(['isosurface']);

/** Whether a representation name draws a density map rather than a structure. */
export function isVolumeRepresentation(name) {
  return typeof name === 'string' && VOLUME_REPRESENTATIONS.includes(name.trim().toLowerCase());
}

/**
 * The Quest 2 ceiling for one static mesh, in triangles.
 *
 * The page's copy of `QUEST2_TRIANGLE_CEILING` in
 * `plugin/src/molecular-growth.ts`, which is the Mac's copy. `volume-budget.test.mjs`
 * reads that file and asserts the two are equal, because a Mac that offers a
 * tier the page then refuses is worse than either rule alone.
 *
 * The number comes from the measured surface table in `XR_SURFACE_QUALITY`
 * above: a `medium` marching-cubes mesh is 387,612 triangles and the Quest 2
 * draws it; a `high` one is 1,006,332 and it does not. 500,000 sits in that gap
 * with the drawn tier inside it. The `filament` tier measures 178,236.
 */
export const QUEST2_STATIC_TRIANGLE_CEILING = 500_000;

/**
 * Triangle counts at which a Quest 2 steps down a framebuffer tier, the mesh
 * twin of `MEDIUM_SCENE_ATOM_SITES` / `HEAVY_SCENE_ATOM_SITES`.
 *
 * Read off the same measured table: a Quest builds the page's `low` surface ask
 * as `lower`, which is 23,680 triangles, and that is the largest static mesh
 * this project has measured a headset drawing at the light framebuffer tier.
 * 143,404 is the next tier up in that table. The `filament` tier's 178,236
 * triangles therefore land on the deepest framebuffer tier, which is the right
 * answer for the largest static mesh this product ships and the exact opposite
 * of what the atom-site ladder alone would say about a scene with no atoms.
 */
export const MEDIUM_SCENE_TRIANGLES = 25_000;
export const HEAVY_SCENE_TRIANGLES = 150_000;

/**
 * Whether a Quest-class headset may draw a static mesh of this size, keyed on
 * the triangle count and the grid it was meshed from. Pure.
 *
 * `grid` is advisory today and is checked only for sanity: a map big enough to
 * be worth refusing refuses on its triangle count first, and the triangle count
 * is MEASURED (see `mesh-proof.mjs`) rather than estimated from the grid.
 *
 * @param {{deviceClass?:string, triangles?:number, grid?:readonly number[]}} [scene]
 * @returns {'allow'|'refuse'}
 */
export function isosurfaceForBudget({ deviceClass = 'unknown', triangles = 0, grid } = {}) {
  const count = Number.isFinite(triangles) && triangles > 0 ? triangles : 0;
  // A mesh nobody measured is not a mesh anybody should promise: refuse rather
  // than wave through an unknown size on the one device that has a ceiling.
  if (count === 0) return deviceClass === 'quest2' ? 'refuse' : 'allow';
  if (Array.isArray(grid) && grid.length === 3 && grid.some(n => !Number.isFinite(n) || n <= 0)) return 'refuse';
  if (deviceClass !== 'quest2') return 'allow';
  return count <= QUEST2_STATIC_TRIANGLE_CEILING ? 'allow' : 'refuse';
}

/**
 * Representation types that draw every atom of the structure.
 *
 * A surface is not the only thing a Quest 2 cannot finish. `spacefill` builds
 * one sphere per atom site and `ball-and-stick` one sphere per atom plus one
 * cylinder per bond, so both scale with the ATOM count while a cartoon scales
 * with the residue count — roughly eight times fewer elements for a protein.
 * On the 40,908-site microtubule wall that is 40,908 spheres against 5,206
 * cartoon segments, built on the main thread, twice per eye per frame.
 *
 * `ball_and_stick` is the underscore spelling the lesson `changes` graphs use
 * for the same Mol* provider; the immersive appearance uses the hyphen.
 */
export const ATOM_REPRESENTATIONS = Object.freeze([
  'spacefill', 'ball-and-stick', 'ball_and_stick',
]);

/** Whether a representation name builds one element per atom. */
export function isAllAtomRepresentation(name) {
  return typeof name === 'string' && ATOM_REPRESENTATIONS.includes(name.trim().toLowerCase());
}

/**
 * Whether a representation's geometry grows faster than a Quest 2 can draw it.
 *
 * The two kinds have nothing in common mechanically — one is a marching-cubes
 * grid, the other is one sphere per atom — and everything in common
 * budgetally: above the heavy tier both take seconds of blocked main thread
 * that no quality knob in this module tunes away.
 */
export function isDenseRepresentation(name) {
  // `isosurface` is deliberately NOT dense here, and this early
  // return is the guard that keeps it so even if someone later adds it to
  // `SURFACE_REPRESENTATIONS` (it IS a marching-cubes surface, so someone
  // will). Dense means "has a cheaper representation of the same data"; a
  // density map has none, and the demotion below would replace the whole scene
  // with a cartoon of a structure that is not loaded.
  if (isVolumeRepresentation(name)) return false;
  return isSurfaceRepresentation(name) || isAllAtomRepresentation(name);
}

/** What a Quest 2 draws instead of a surface it cannot afford. */
export const SURFACE_FALLBACK_REPRESENTATION = 'cartoon';

/**
 * The representation the LIGANDS keep when an all-atom ask is demoted.
 *
 * A chapter that asks for every atom is usually asking about
 * something a cartoon cannot draw at all: the microtubule lesson's fourth
 * chapter is "Same cargo — every dimer carries GTP and magnesium in alpha, GDP
 * and Taxol in beta", and a cartoon is a polymer trace with no ligand in it.
 * Demoting the ask to a cartoon and stopping there would answer the frame rate
 * by deleting the subject.
 *
 * So the demotion keeps the ask for the part that is cheap enough to honour.
 * The wall's six operator copies carry 738 ligand atom sites between them —
 * 1.8 per cent of the tier — and 738 spheres is a rounding error next to the
 * 5,206-segment cartoon they sit inside.
 */
export const LIGAND_OVERLAY_REPRESENTATION = 'spacefill';

/**
 * The most ligand atom sites the overlay may draw before it is the problem
 * again. A structure whose ligands alone are a heavy scene — a lipid bilayer,
 * a solvent box promoted to `non-polymer` — gets no overlay and the plain
 * demotion, because drawing it would put back exactly what the demotion took
 * away.
 */
export const LIGAND_OVERLAY_ATOM_CEILING = 4_000;

/**
 * The representation to draw the ligands at, or `null` for no overlay.
 *
 * Pure, and stated here rather than at the call site so the demotion and its
 * compensation are one rule that can be read in one place. `built` is what
 * `representationForBudget` returned, so an ask that was NOT demoted gets no
 * overlay: the main representation already draws every ligand it has.
 *
 * @param {string} asked the representation the chapter or command asked for
 * @param {string} built what `representationForBudget` decided to draw
 * @param {{ligandAtomSites?:number}} [context]
 */
export function ligandOverlayForBudget(asked, built, { ligandAtomSites = 0 } = {}) {
  if (!isAllAtomRepresentation(asked)) return null;
  if (String(asked ?? '').trim().toLowerCase() === String(built ?? '').trim().toLowerCase()) return null;
  const sites = Number.isFinite(ligandAtomSites) && ligandAtomSites > 0 ? ligandAtomSites : 0;
  if (sites === 0 || sites > LIGAND_OVERLAY_ATOM_CEILING) return null;
  return LIGAND_OVERLAY_REPRESENTATION;
}

/** Preserve the requested scientific representation. Historical atom-count
 * thresholds do not prove that a style cannot render on a particular device.
 * Geometry advisories live in representation-budget; actual build failures and
 * deadlines still retain their normal rollback/recovery path. Keep the context
 * argument for callers and legacy measurement probes, without substituting a
 * different molecular style.
 */
export function representationForBudget(representation, _context = {}) {
  return representation;
}

/**
 * The tier a surface is BUILT at in immersion, which is not the tier asked for.
 *
 * `getQualityProps` (`mol-repr/util.js:127-131`) demotes any explicit quality
 * by one level when `isStandaloneHmd()` is true, and that check is a Quest
 * Browser user-agent test (`mol-util/browser.js:25-32`). The budget asked for
 * `low`; a Quest therefore built `lower`, which for a surface means a 3.0 A
 * marching-cubes grid and no back faces. Measured on 9KJ6, 13,121 atom sites:
 *
 *   built tier   grid       triangles   CPU build (desktop, Node)
 *   lower        3.0 A         23,680   0.55 s
 *   low          1.3 A        143,404   1.51 s
 *   medium       0.8 A        387,612   2.30 s   (also doubleSided)
 *   high         0.5 A      1,006,332   2.86 s   (the desktop `auto` tier)
 *
 * The mean triangle edge on that `lower` mesh measures 2.80 A, against a
 * carbon-carbon bond of 1.5 A and a backbone repeat of 3.8 A: a plate spans a
 * side chain, which reads as a coarse flat blob. It is also losing
 * real surface. Total mesh area rises from 66,883 to 79,532 square A between
 * `lower` and `low`, so the coarse grid is smoothing 16 percent of the surface
 * away rather than merely faceting it. `low` measures a 1.24 A mean edge, and
 * it is the last tier that keeps `doubleSided: false`, so it costs nothing in
 * fill on a fill-bound Quest 2: the silhouette is unchanged and back faces
 * stay culled.
 * Per-vertex work rises 6x, to 287,000 triangles per frame across both eyes,
 * which is around 21 million triangles a second at 72 Hz on a static mesh the
 * GPU never rebuilds.
 *
 * The cost that is real is the rebuild: a tour step that switches to a surface
 * spends roughly a second longer on the main thread. `?xrRenderBudget=surface:lower`
 * puts today's tier back, and `surface:medium` tries the next one up.
 */
export const XR_SURFACE_QUALITY = 'low';

/**
 * The material a surface wears in immersion: Mol*'s own "Glossy" preset
 * (`mol-util/material.js:44`), against a default of "Matte".
 *
 * A surface in immersion has no occlusion pass and no shadow to shape it, so
 * the only depth cue left is the shading of the key light, and a fully rough
 * material scatters that into a flat wash. The specular lobe is what makes a
 * desktop surface read as a solid body, and it is free here: `apply-light-color.glsl`
 * runs the whole physical BRDF for every fragment whatever the roughness is,
 * so lowering roughness changes the value of a term that was already computed.
 *
 * `bumpiness` is the lever NOT taken. It is the strongest of the three, but it
 * gates `perturbNormal(..., fbm(...))` in the same chunk, and that fbm is
 * several octaves of 3D noise per fragment on the one device in this project
 * that is fill-bound. `?xrRenderBudget=gloss:off` restores the Mol* default.
 *
 * A roughness of 0.6 turned out not to be glossy at all on this geometry.
 * `apply-light-color.glsl.js` ADDS a screen-space `geometryRoughness` derived
 * from `dFdx`/`dFdy` of the normal, and a gaussian surface's dimples make that
 * term large everywhere, so the effective lobe was far wider than 0.6 and
 * produced a broad milky wash rather than a highlight. 0.28 sits just above
 * Mol*'s "Plastic" (0.2); it is not lower because the geometry roughness above
 * still has to be left somewhere to add to.
 * `?xrRenderBudget=rough:<0..1>` sweeps it on hardware without a rebuild.
 */
export const XR_SURFACE_MATERIAL = Object.freeze({ metalness: 0, roughness: 0.28, bumpiness: 0 });

/**
 * The material to build a representation with in immersion, or `null` to leave
 * Mol* on its own default. Surfaces only — plus the density tier's
 * isosurface, which is a marching-cubes mesh with the same fill-bound shading
 * problem and the same free specular lobe. A cartoon already carries its shape
 * in its silhouette.
 */
export function xrRepresentationMaterial({ representation, presenting = true, scope = globalThis } = {}) {
  if (!presenting || (!isSurfaceRepresentation(representation) && !isVolumeRepresentation(representation))) return null;
  const tuned = renderBudgetOverrides(scope);
  if (!tuned.enabled || tuned.surfaceGloss === false) return null;
  if (Number.isFinite(tuned.surfaceRoughness)) {
    return { ...XR_SURFACE_MATERIAL, roughness: tuned.surfaceRoughness };
  }
  return XR_SURFACE_MATERIAL;
}

/**
 * Colour themes whose categorical colours come from a Mol* palette, so a palette can
 * be handed to them through `colorParams`.
 *
 * `getPaletteParams` (`mol-util/color/palette.js:16-33`) is mixed into exactly
 * these theme params, and each of them reads it back through `getPalette`
 * (e.g. `mol-theme/color/chain-id.js:73`). A theme not on this list either has
 * no palette at all (`element-symbol`, `uniform`) or spells its colours some
 * other way, and handing it a `palette` key would be dropped or would throw.
 */
export const PALETTE_COLOR_THEMES = Object.freeze([
  'chain-id', 'entity-id', 'entity-source', 'model-index', 'structure-index',
  'trajectory-index', 'unit-index', 'operator-name',
]);

/**
 * The optional pastel palette for non-chain surface themes in immersion.
 * Chain-id now uses CHAIN_COLOR_PARAMS, including with palette:off. The
 * measurements below describe the original surface treatment.
 *
 * WHY. `chain-id` defaults to the `many-distinct` colour list
 * (`mol-theme/color/chain-id.js:11`), whose first entries are #1b9e77,
 * #d95f02, #7570b3 and #e7298a - the fully saturated green, orange, purple and
 * magenta seen in the headset. Saturated chroma is what makes a
 * surface read as coloured plastic: at chroma 60 the diffuse term swamps the
 * specular lobe and the shading gradient that models the body disappears into
 * the hue. PyMOL and ChimeraX pictures people call pretty are pastel for that
 * reason, not by taste - a low-chroma, high-luminance body leaves headroom
 * above it for a highlight and below it for a shadow.
 *
 * `getPaletteParams` offers `generate` as the alternative to a fixed list, and
 * it samples CIE HCL space inside three intervals (`mol-util/color/distinct.js:16-24`).
 * Squeezing chroma to 22-42 and lifting luminance to 62-82 gives, for eight
 * chains: #e39bb0 rose, #75bf9e mint, #bca7df lavender, #9eb981 sage, #89b1e6
 * sky, #c4af76 sand, #5abed0 teal, #e0a382 apricot. Measured in Node against
 * this exact Mol* build; the generator is deterministic, so those are the
 * colours the headset gets.
 *
 * COST. `distinctColors` clusters 800 samples over 50 steps once per theme
 * build: 3-11 ms on a desktop CPU, measured, on the same main thread that already
 * spends about 1.5 s building the surface mesh. Zero per frame - the colours
 * land in a vertex attribute exactly as the fixed list does.
 *
 * `?xrRenderBudget=palette:off` puts `many-distinct` back for an A/B.
 *
 * The first box, chroma 22-42 and luminance 62-82, overshot. It fixed the
 * saturation - measured over the surface pixels of an emulator frame, mean HSV
 * saturation fell 0.79 to 0.32 - but it also put every chain at almost the same
 * high value, and a Lambert term can only move an albedo DOWN from where it
 * starts. Relative local contrast (the standard deviation of luminance in a 7x7
 * window over its own local mean, which is what the eye normalises to) fell from
 * 0.354 to 0.280 against the saturated list: the body got measurably CHALKIER
 * even while its absolute range widened. Lower luminance and more chroma fix
 * that, and this box still sits well inside Mol*'s own defaults of chroma 40-70,
 * luminance 15-85 (`mol-util/color/distinct.js:18-19`) - pastel relative to
 * `many-distinct`, not relative to the generator.
 *
 * The second thing it buys is chain separation. At luminance 62-82 the sand
 * and sky nucleic-acid strands on the right of the frame were isoluminant and
 * fused into one braid; a 28-point luminance interval separates them by value
 * as well as hue, which is how a ChimeraX figure keeps chains apart.
 */
export const XR_SURFACE_PALETTE = Object.freeze({
  name: 'generate',
  params: Object.freeze({
    hue: Object.freeze([1, 360]),
    chroma: Object.freeze([38, 58]),
    luminance: Object.freeze([42, 70]),
    sort: 'contrast',
    clusteringStepCount: 50,
    minSampleCount: 800,
    sampleCountFactor: 5,
    maxCount: 75,
  }),
});

/**
 * The `colorParams` to build a representation with in immersion, or `null` to
 * leave the colour theme on its own defaults.
 *
 * Chain-id always uses one root-chain palette, in and out of immersion. Other
 * palette themes retain the optional surface treatment; they do not identify
 * chains and cannot change the chain-to-colour mapping.
 */
export function xrColorParams({ representation, color, presenting = true, scope = globalThis } = {}) {
  // Chain identity is independent of the surface styling/quality switches.
  if (String(color ?? '').trim().toLowerCase() === 'chain-id') return CHAIN_COLOR_PARAMS;
  if (!presenting || !isSurfaceRepresentation(representation)) return null;
  if (!PALETTE_COLOR_THEMES.includes(String(color ?? '').trim().toLowerCase())) return null;
  const tuned = renderBudgetOverrides(scope);
  if (!tuned.enabled || tuned.surfacePalette === false) return null;
  return { palette: XR_SURFACE_PALETTE };
}

/**
 * The immersive lighting rig, as `Canvas3D.props.renderer` keys. Colours are
 * plain hex numbers; `Color()` in Mol* is a branded number, so `viewer.mjs`
 * wraps them at the call site and this module stays free of Mol* imports.
 *
 * WHAT IT IMITATES. ChimeraX's recognisable surface is ambient-dominant with
 * ambient occlusion carving the crevices (`lighting soft` is ambient 1.5, key
 * 0, multishadow 64; `lighting full` keeps that and adds a key). There is no
 * occlusion pass in immersion at `fast` or `balanced`, so an ambient-dominant
 * rig here would give a flat wash rather than the ChimeraX look. This rig goes
 * the other way: it keeps a clear key and buys back the modelling that
 * occlusion would otherwise do, with three cheap things.
 *
 *   1. A THIRD LIGHT, behind and above, at low intensity. It rims the
 *      silhouette, which is the cue an outline pass would give and the reason
 *      a ChimeraX render separates from its background. Cost is one more
 *      iteration of the `dLightCount` loop in `apply-light-color.glsl.js:88-94`
 *      - a normalize, a dot and one `BRDF_GGX` per fragment. The loop is
 *      `#pragma unroll_loop_start`, so it is unrolled at compile time and
 *      there is no branch.
 *   2. A COLOURED AMBIENT, cool rather than white. `uAmbientColor` multiplies
 *      the irradiance term (`apply-light-color.glsl.js:96`), so a cool ambient
 *      tints everything the key does not reach towards blue while the lit side
 *      stays neutral. That warm-to-cool split across a curved body is what the
 *      eye reads as depth, and it is the single strongest free cue here. It is
 *      also what a real occlusion pass approximates: sky above, less light in
 *      the crevice.
 *   3. AMBIENT LIFTED from 0.22 to 0.35 and the key softened from 0.85 to
 *      0.72. At 0.22 the unlit side of a chain went nearly black and the
 *      contrast rode entirely on the hue, which is the saturated-plastic read.
 *
 * DIRECTIONS. `mesh.frag.js:36` shades with `-normalize(vNormal)`, so the
 * working normal points AWAY from the camera and a light direction reads
 * inverted from the obvious one: negative z is a FRONT light, negative y is
 * from ABOVE, positive x is from the LEFT. `directionFromSpherical`
 * (`mol-math/linear-algebra/3d/vec3.js:531-533`) is
 * `(cos(az)sin(inc), sin(az)sin(inc), cos(inc))`. Resolving the three:
 *
 *   key   150, 320  ->  ( 0.38, -0.32, -0.87)  upper-left, front
 *   fill  142, 145  ->  (-0.50,  0.35, -0.78)  lower-right, front
 *   rim    36, 290  ->  ( 0.20, -0.55,  0.81)  above and BEHIND
 *
 * The key is Mol*'s own default direction (`mol-gl/renderer.js:46-56`), which
 * is where PyMOL and ChimeraX put theirs. The rim's positive z only reaches
 * fragments whose normal is near grazing, because the surface stays
 * `doubleSided: false` and every genuinely back-facing fragment is culled
 * before it is shaded - so it costs a dot product and paints a silhouette band,
 * which is the cheapest thing in this file that does an outline pass's job.
 *
 * The previous rig's second light (inclination 55, azimuth 135) was already a
 * weak back light at 0.15; it is replaced by a real front fill plus the rim.
 *
 * `exposure` multiplies the final fragment (`apply-light-color.glsl.js:110`).
 * It is left at 1: the clamp on the line above it already holds the output
 * inside 0.01-0.99, so exposure can only crush, not recover.
 *
 * COST. Nothing per frame beyond the one extra light. No pass, no target, no
 * texture read.
 *
 * WEIGHTS. The structure above is right; the first set of gains was not.
 * Ambient 0.35 plus a 0.20 FRONT fill opposite a 0.72 front key filled in every
 * depression the key was supposed to carve, so the body came back as an even
 * disc. Measured on an emulator frame, relative local contrast was 0.280
 * against 0.354 for the rig this replaced - the modelling got weaker, not
 * stronger, which is exactly what "washed out" means and the opposite of what
 * the rig was for. Absolute range was wider, which is why it had to be measured
 * rather than eyeballed.
 *
 *   ambient  0.35 -> 0.18
 *   key      0.72 -> 0.95
 *   fill     0.20 -> 0.10   a floor under the unlit side without erasing the key
 *   rim      0.26 -> 0.50   it was there and invisible under the old ambient
 *
 * The rim is set for the room rather than for a black void: on passthrough the
 * background is a wall or a shirt, and a bright silhouette band is the only
 * separation this build has with the outline pass off. It is also the knob most
 * likely to want a hardware sweep.
 *
 * The ambient stays COOL (0xc8d4e3) rather than warm. The warm-key/cool-shadow
 * split is what the rig is for; a cool ambient only turns pits grey-mauve when
 * it dominates, as it did at 0.35, and 0.18 is the fix for that.
 */
export const XR_RENDERER_LIGHTING = Object.freeze({
  ambientColor: 0xc8d4e3,
  ambientIntensity: 0.18,
  light: Object.freeze([
    Object.freeze({ inclination: 150, azimuth: 320, color: 0xfff6ea, intensity: 0.95 }),
    Object.freeze({ inclination: 142, azimuth: 145, color: 0xdce8ff, intensity: 0.10 }),
    Object.freeze({ inclination: 36, azimuth: 290, color: 0xffffff, intensity: 0.50 }),
  ]),
});

/**
 * The rig this replaced, kept so it can be A/B'd on the headset with
 * `?xrRenderBudget=light:off`.
 */
export const XR_LEGACY_LIGHTING = Object.freeze({
  ambientColor: 0xffffff,
  ambientIntensity: 0.22,
  light: Object.freeze([
    Object.freeze({ inclination: 145, azimuth: 315, color: 0xffffff, intensity: 0.85 }),
    Object.freeze({ inclination: 55, azimuth: 135, color: 0xffffff, intensity: 0.15 }),
  ]),
});

/** The rig to build the immersive canvas with. `light:off` picks the old one. */
export function xrRendererLighting(scope = globalThis) {
  const tuned = renderBudgetOverrides(scope);
  if (!tuned.enabled || tuned.lighting === false) return XR_LEGACY_LIGHTING;
  return XR_RENDERER_LIGHTING;
}

/**
 * Whether the page is one of the standalone-headset browsers Mol* demotes for.
 *
 * Kept as a copy of `mol-util/browser.js:25-32` rather than an import, because
 * `xrRepresentationQuality` must know what Mol* will do to the tier it asks
 * for, and the Mol* helper is not exported through the plugin bundle. The
 * emulator's headless Chromium is not one of these, which is why an emulator
 * frame cannot show this bug or its fix.
 */
export function isStandaloneHmdAgent(navigatorLike) {
  try {
    const agent = typeof navigatorLike === 'string' ? navigatorLike : navigatorLike?.userAgent;
    if (typeof agent !== 'string') return false;
    return /OculusBrowser\//.test(agent) || /PicoBrowser\//.test(agent);
  } catch { return false; }
}

/** Step a tier up the ladder, clamped at both ends. Unknown tiers pass through. */
export function raiseQuality(quality, steps = 1) {
  const at = QUALITY_LEVELS.indexOf(quality);
  if (at === -1 || !Number.isFinite(steps)) return quality;
  return QUALITY_LEVELS[Math.min(QUALITY_LEVELS.length - 1, Math.max(0, at + Math.round(steps)))];
}

/**
 * The tier to ask Mol* for so that the tier it builds is `quality`.
 *
 * One level up on a standalone headset, unchanged everywhere else. The
 * asymmetry is deliberate: the desktop panel and the emulator have no demotion
 * to cancel, so asking them for more would change a look that is already right.
 */
export function qualityRequestFor(quality, navigatorLike) {
  return isStandaloneHmdAgent(navigatorLike) ? raiseQuality(quality, 1) : quality;
}

/**
 * The three levels the wearer can pick, cheapest first.
 *
 * `spatial-toolbar-content.mjs` exports the same three for the menu row. They
 * are stated twice rather than imported, because the render budget must not
 * depend on the menu; `render-quality.test.mjs` asserts the two lists agree.
 */
export const RENDER_QUALITY_LEVELS = Object.freeze(['fast', 'balanced', 'best']);

/** The level a page runs at when nothing was stored for this session. */
export const DEFAULT_RENDER_QUALITY = 'balanced';

/** Where the wearer's choice lives for the life of the page's session. */
export const RENDER_QUALITY_STORAGE_KEY = 'stereofold.renderQuality';

/** Quest 2 layer scales, smallest first: the ladder `best` steps up by one. */
const QUEST2_SCALE_TIERS = Object.freeze([QUEST2_SCALE_HEAVY, QUEST2_SCALE_MEDIUM, QUEST2_SCALE_LIGHT]);

/**
 * One tier more framebuffer than the scene would otherwise get, or `null` to
 * keep the scale the device class already has.
 *
 * Only Quest 2 has tiers to step between; every other class already draws at
 * native scale and there is nothing above it. A heavy scene rises from 0.5 to
 * 0.6 rather than to 0.8, so the one gap the tiers were built to keep survives
 * the step: `best` buys back pixels, it does not abolish the ladder.
 */
export function raisedFramebufferScale(device, atomSites, triangles = 0) {
  if (device !== 'quest2') return null;
  const at = QUEST2_SCALE_TIERS.indexOf(quest2FramebufferScale(atomSites, triangles));
  if (at === -1) return null;
  return QUEST2_SCALE_TIERS[Math.min(QUEST2_SCALE_TIERS.length - 1, at + 1)];
}

/**
 * What one render-quality level means, spelled in the knobs `?xrRenderBudget=`
 * already carries. Pure: no storage, no navigator, no session.
 *
 * The values below are what gets BUILT, not what Mol* is asked for. A Quest
 * demotes every explicit tier by one (`XR_SURFACE_QUALITY`), and
 * `qualityRequestFor` adds that compensation at the point of use, so this table
 * reads the same on a headset and off one.
 *
 *   level      surface  gloss  quest2 scale   cartoon/b-and-s        postfx
 *   fast       lower    off    device tier    device tier, demoted   off
 *   balanced   low      on     device tier    device tier, demoted   off
 *   best       medium   on     one tier up    demotion cancelled     SSAO+outline
 *
 * The non-chain surface palette (`XR_SURFACE_PALETTE`) and the three-light rig
 * (`XR_RENDERER_LIGHTING`) are not in this table because they are not levels:
 * a palette is a vertex attribute and a light is one unrolled loop iteration,
 * so both run at `fast` too. `?xrRenderBudget=palette:off` A/Bs the first.
 *
 * `fast` is the coarse 3.0 A surface and a matte material, which is what the
 * project ran before this table. It stays reachable because a wearer who is judder-bound
 * wants frames, not grooves.
 *
 * `balanced` is the default and is exactly the module's own defaults, so a page
 * that never touches the lever behaves as it did before the lever existed.
 *
 * `best` spends on all three axes at once. The surface goes to 0.8 A, which
 * flips `doubleSided` on and so costs fill rather than only geometry. The
 * framebuffer rises one tier, which costs fill proportionally. And the demotion
 * is cancelled for the non-surface representations too, so a Quest builds
 * cartoon and ball-and-stick at `low` instead of `lower` - radialSegments 8
 * instead of 4. It may fall below 72 Hz. That is the wearer's call to make,
 * which is the whole point of a lever.
 *
 * `best` also turns the occlusion and outline passes on, because those two are
 * what produce a solid, carved look and nothing cheaper does
 * the same job. Their cost has still never been measured on the headset, and
 * Meta names an intermediate render target as one of the two things that
 * switch fixed foveation off, so they stay out of `balanced`.
 * `?xrRenderBudget=postfx:on` puts them on at any level for the A/B.
 *
 * @param {string} level
 * @param {{deviceClass?:string, representation?:string, atomSites?:number}} [context]
 */
export function renderQualityPreset(level, { deviceClass = 'unknown', representation, atomSites, triangles = 0 } = {}) {
  const chosen = RENDER_QUALITY_LEVELS.includes(level) ? level : DEFAULT_RENDER_QUALITY;
  const best = chosen === 'best';
  return Object.freeze({
    level: chosen,
    surfaceQuality: chosen === 'fast' ? 'lower' : best ? 'medium' : XR_SURFACE_QUALITY,
    surfaceGloss: chosen !== 'fast',
    // Pastel chains at every level including `fast`: the palette is a vertex
    // attribute, so it is the one look change in this table that a
    // frame-starved wearer pays nothing for.
    surfacePalette: true,
    // `null` means "leave the device and scene tier alone", which is what
    // `renderBudget` does with an override it cannot read as a number.
    framebufferScale: best ? raisedFramebufferScale(deviceClass, atomSites, triangles) : null,
    // `best` is the only level that runs the occlusion and outline passes.
    // They are what actually produce the ChimeraX look, and they are also the
    // only thing in this table that can cost the session fixed foveation.
    postprocessing: best,
    // Only the non-surface path needs this flag: a surface already asks through
    // `qualityRequestFor` at every level, because its tier is a grid resolution.
    compensateDemotion: best && !isSurfaceRepresentation(representation),
  });
}

/**
 * The level this page is running at. `null` until something resolves it, which
 * the first read does from `sessionStorage`.
 *
 * Module state rather than a parameter because every reader of the budget is
 * several calls away from whoever set the level, and the alternative is
 * threading a level through `xrRepresentationQuality`, `xrResolutionScale` and
 * `beginXrRenderBudget` from callers that have no business knowing about it.
 * `lastResolutionScale` below is module state for the same reason.
 */
let activeRenderQualityLevel = null;

/**
 * The active level, resolving it from storage on first read.
 *
 * Lazy on purpose: the first representation is built before any boot hook could
 * run, and a wearer who set `best`, left the session and came back must not see
 * one frame of `balanced` geometry first.
 */
export function activeRenderQuality(scope = globalThis) {
  if (activeRenderQualityLevel === null) {
    activeRenderQualityLevel = readStoredRenderQuality(scope) ?? DEFAULT_RENDER_QUALITY;
  }
  return activeRenderQualityLevel;
}

/** Set the active level. An unknown level falls back to the default. */
export function setActiveRenderQuality(level) {
  activeRenderQualityLevel = RENDER_QUALITY_LEVELS.includes(level) ? level : DEFAULT_RENDER_QUALITY;
  return activeRenderQualityLevel;
}

/** The stored level, or `null`. Storage can throw in a partitioned context. */
export function readStoredRenderQuality(scope = globalThis) {
  try {
    const stored = (scope ?? globalThis)?.sessionStorage?.getItem?.(RENDER_QUALITY_STORAGE_KEY);
    return RENDER_QUALITY_LEVELS.includes(stored) ? stored : null;
  } catch { return null; }
}

/** Remember the level for this session. `false` when storage refused it. */
export function storeRenderQuality(level, scope = globalThis) {
  if (!RENDER_QUALITY_LEVELS.includes(level)) return false;
  try {
    const storage = (scope ?? globalThis)?.sessionStorage;
    if (typeof storage?.setItem !== 'function') return false;
    storage.setItem(RENDER_QUALITY_STORAGE_KEY, level);
    return true;
  } catch { return false; }
}

/**
 * Lay a level's preset UNDER a parsed knob list.
 *
 * The address wins every key it names, so `?xrRenderBudget=surface:medium`
 * still A/Bs one knob against whatever level the menu is on, and `off` still
 * turns the whole module off before any of this runs. `presetKeys` records
 * which keys the preset filled, so the diagnostics record can keep reporting
 * only the knobs the address actually named.
 */
export function withRenderQualityPreset(parsed, context = {}, level) {
  if (!parsed || parsed.enabled === false) return parsed;
  const preset = renderQualityPreset(level ?? activeRenderQuality(context.scope), context);
  const merged = { ...parsed };
  const filled = [];
  const fill = (key, value) => {
    if (key in parsed || value === null || value === undefined) return;
    merged[key] = value;
    filled.push(key);
  };
  fill('surfaceQuality', preset.surfaceQuality);
  fill('surfaceGloss', preset.surfaceGloss);
  fill('surfacePalette', preset.surfacePalette);
  fill('postprocessing', preset.postprocessing);
  fill('framebufferScale', preset.framebufferScale);
  merged.renderQuality = preset.level;
  merged.compensateDemotion = preset.compensateDemotion;
  merged.presetKeys = Object.freeze(filled);
  return merged;
}

/**
 * `Canvas3D.props.pickScale` while presenting. Mol* allocates its pick
 * framebuffer at this fraction of the drawing buffer
 * (`mol-canvas3d/canvas3d.js:127`, default 0.25) and re-renders the scene into
 * it whenever a pick is dirty. Immersive picking is a controller ray against
 * one structure, so an eighth-scale buffer resolves it and costs a quarter of
 * the pick fragments.
 */
export const XR_PICK_SCALE = 0.125;

/**
 * `Canvas3D.props.interaction.maxFps` while presenting.
 *
 * Mol*'s interaction helper polls for a hover pick on a timer
 * (`mol-canvas3d/helper/interaction-events.js`, `t - prevT > 1000 / maxFps`,
 * default 30). Each poll re-renders the whole scene into the pick buffer, and
 * in an immersive session it does so for a ray that head tracking moves every
 * frame. Meta's fixed-foveation guidance names a mid-eye-buffer render-target
 * switch as one of the two things that switch foveation off, and this is one.
 *
 * Zero stops the poll outright: `1000 / 0` is `Infinity`, so the helper never
 * reaches its identify branch. Nothing the wearer uses depends on it. Menu
 * rows hit-test against the panel geometry in `spatial-toolbar.mjs`, not
 * against Mol*, and the trigger picks the structure through an explicit
 * `canvas.identify()` call in `viewer.mjs`, which renders the pick buffer on
 * demand and is unaffected. What is lost is the small hit dot Mol* draws where
 * a controller ray meets the structure. `?xrRenderBudget=hover:on` brings the
 * 30 Hz poll back for an A/B.
 */
export const XR_INTERACTION_MAX_FPS = 0;

/** The interaction poll rate `hover:on` restores, matching the Mol* default. */
export const DESKTOP_INTERACTION_MAX_FPS = 30;

/** Query parameter and environment variable that tune the budget for A/B. */
export const XR_RENDER_BUDGET_PARAM = 'xrRenderBudget';
export const XR_RENDER_BUDGET_ENV = 'STEREOFOLD_XR_RENDER_BUDGET';

const OFF_VALUES = Object.freeze(['off', '0', 'false', 'no', 'disabled']);
const ON_VALUES = Object.freeze(['on', '1', 'true', 'yes', 'enabled']);
const QUALITY_VALUES = Object.freeze(['auto', 'highest', 'higher', 'high', 'medium', 'low', 'lower', 'lowest', 'custom']);

/**
 * The Quest 2 layer scale for a scene size.
 *
 * Fragments are the Adreno 650's scarce resource, and the layer scale is the
 * only lever that cuts them proportionally. Each step removes about a third of
 * the fragments the step above draws: 0.8 draws 64 percent of a native layer,
 * 0.6 draws 36 percent, 0.5 draws 25 percent. The cost is text legibility, so
 * the lowest scale waits for a scene no other knob will hold.
 */
export function quest2FramebufferScale(atomSites, triangles = 0) {
  const sites = Number.isFinite(atomSites) && atomSites > 0 ? atomSites : 0;
  const bySites = sites < MEDIUM_SCENE_ATOM_SITES ? QUEST2_SCALE_LIGHT
    : sites <= HEAVY_SCENE_ATOM_SITES ? QUEST2_SCALE_MEDIUM
      : QUEST2_SCALE_HEAVY;
  const byMesh = quest2TriangleFramebufferScale(triangles);
  // Each ladder answers in its own unit and the scene takes the
  // DEEPER of the two answers, which is the smaller scale. A density tier has
  // no atom sites at all, so without the mesh ladder it would read as the
  // lightest possible scene and take the largest framebuffer — the opposite of
  // what a 178,236-triangle static mesh wants.
  return byMesh === null ? bySites : Math.min(bySites, byMesh);
}

/**
 * The Quest 2 layer scale a static mesh of this size asks for, or `null` when
 * the scene carries no measured mesh and the atom ladder decides alone.
 */
export function quest2TriangleFramebufferScale(triangles) {
  const count = Number.isFinite(triangles) && triangles > 0 ? triangles : 0;
  if (count === 0) return null;
  if (count < MEDIUM_SCENE_TRIANGLES) return QUEST2_SCALE_LIGHT;
  if (count <= HEAVY_SCENE_TRIANGLES) return QUEST2_SCALE_MEDIUM;
  return QUEST2_SCALE_HEAVY;
}

/**
 * The layer scale for a device class and scene size. Unknown classes keep
 * native scale, and only Quest 2 reads the site and triangle counts.
 */
export function framebufferScaleFor(device, atomSites, triangles = 0) {
  const scale = FRAMEBUFFER_SCALE_BY_DEVICE[device];
  if (!Number.isFinite(scale)) return 1;
  return device === 'quest2' ? quest2FramebufferScale(atomSites, triangles) : scale;
}

/**
 * The target frame rate to request, or `null` to keep whatever the runtime
 * chose. Only Quest 2 asks, and it asks on every scene: see
 * `QUEST2_TARGET_FRAME_RATE`.
 */
export function targetFrameRateFor(device) {
  return device === 'quest2' ? QUEST2_TARGET_FRAME_RATE : null;
}

/**
 * The rate to pass to `updateTargetFrameRate` given what the session reports
 * in `supportedFrameRates`. An exact match wins; otherwise the highest
 * supported rate at or below the request, so a runtime offering 60/80/90
 * receives 60 rather than a value it would reject. A session that reports no
 * rates gets the request unchanged, because `supportedFrameRates` is optional.
 */
export function pickFrameRate(supported, wanted) {
  if (!Number.isFinite(wanted)) return null;
  const rates = toRates(supported);
  if (rates.length === 0) return wanted;
  if (rates.includes(wanted)) return wanted;
  const below = rates.filter(rate => rate < wanted);
  return below.length > 0 ? Math.max(...below) : null;
}

function toRates(supported) {
  if (!supported || typeof supported[Symbol.iterator] !== 'function') return [];
  try { return [...supported].filter(rate => Number.isFinite(rate) && rate > 0); }
  catch { return []; }
}

/** Mol* geometry quality for a device class, or `null` to leave Mol* on `auto`. */
export function representationQualityFor(device) {
  const quality = REPRESENTATION_QUALITY_BY_DEVICE[device];
  return typeof quality === 'string' ? quality : null;
}

/**
 * The whole budget for one device class and scene size.
 *
 * `foveation` is reported, not applied: `applyFoveation` in
 * `xr-session-request.mjs` sets it once presentation starts, and two callers
 * writing `XRWebGLLayer.fixedFoveation` would race. The WebXR level is a 0-to-1
 * fraction rather than one of Meta's four native levels, so a Quest 2 at 1 is
 * already at the strongest foveation the API can ask for and there is no
 * higher setting to switch to during a tour or a grab.
 *
 * `triangles` is the measured static-mesh size of a density tier (zero for
 * every atomic scene). It is reported and tiered separately from `atomSites`
 * and the two are never added: see `quest2FramebufferScale`.
 *
 * @param {{device?:string, atomSites?:number, triangles?:number, overrides?:object}} [scene]
 */
export function renderBudget({ device = 'unknown', atomSites = 0, triangles = 0, overrides = {} } = {}) {
  const sites = Number.isFinite(atomSites) && atomSites > 0 ? atomSites : 0;
  const mesh = Number.isFinite(triangles) && triangles > 0 ? triangles : 0;
  const tuned = overrides ?? {};
  // `heavyScene` names the deepest framebuffer tier, not a frame-rate gate:
  // the 72 Hz request no longer depends on the site count.
  const heavy = sites > HEAVY_SCENE_ATOM_SITES || mesh > HEAVY_SCENE_TRIANGLES;
  const postprocessing = tuned.postprocessing === true;
  return Object.freeze({
    device,
    atomSites: sites,
    ...(mesh > 0 ? { triangles: mesh } : {}),
    heavyScene: heavy,
    framebufferScale: Number.isFinite(tuned.framebufferScale) ? tuned.framebufferScale : framebufferScaleFor(device, sites, mesh),
    foveation: Number.isFinite(tuned.foveation) ? tuned.foveation : foveationLevelFor(device),
    targetFrameRate: tuned.targetFrameRate === null || Number.isFinite(tuned.targetFrameRate)
      ? tuned.targetFrameRate : targetFrameRateFor(device),
    representationQuality: typeof tuned.representationQuality === 'string'
      ? tuned.representationQuality : representationQualityFor(device),
    // The marking pass costs two extra full-scene renders per eye whenever
    // anything is highlighted or selected (`mol-canvas3d/passes/draw.js:377`),
    // and a running tour selects on every step. The colour tint from
    // `renderer.selectColor` is drawn in the main pass and survives this;
    // only the edge outline goes.
    marking: tuned.marking === true,
    pickScale: Number.isFinite(tuned.pickScale) ? tuned.pickScale : XR_PICK_SCALE,
    // A hover pick is a second render of the whole scene into the pick buffer,
    // on a ray head tracking moves every frame. Off unless asked for.
    interactionMaxFps: Number.isFinite(tuned.interactionMaxFps) ? tuned.interactionMaxFps : XR_INTERACTION_MAX_FPS,
    // Meta's fixed-foveation guidance states an intermediate render target
    // nullifies foveation, and every pass below writes one.
    disablePostprocessing: !postprocessing,
    disableIllumination: !postprocessing,
    disableMultiSample: !postprocessing,
  });
}

/**
 * Parse the knob list carried by `?xrRenderBudget=` or the environment.
 *
 * The parameter began as a boolean escape and stays one: `off` and its
 * synonyms still turn the whole module off. Anything else is read as a list of
 * `key:value` pairs so one knob can be A/B'd on hardware without a
 * rebuild. An unreadable pair is dropped rather than raised, because a typo in
 * a URL typed on a headset must not stop a demo from entering immersion.
 *
 * Recognised keys: `scale`, `foveation`, `fps`, `quality`, `surface`, `gloss`,
 * `rough`, `palette`, `marking`, `pick`, `hover`, `postfx`, `cost`,
 * `molstarPanel`, `governor`, `governorFloor`, `msaa`. Separators are `,` or `;`, and
 * `:` or `=` inside a pair. `hover` also takes a poll rate in frames per
 * second, so `?xrRenderBudget=hover:10` is a third of the Mol* default rather
 * than none.
 *
 * `budget`, `hydrogens` and `sphere` are measurement-only and land in
 * `unknown` here: `geometryDebugOptions` in `representation-budget.mjs` reads them.
 *
 * @returns {{enabled:boolean, framebufferScale?:number, foveation?:number,
 *   targetFrameRate?:number|null, representationQuality?:string,
 *   surfaceQuality?:string|null, surfaceGloss?:boolean, surfaceRoughness?:number,
 *   surfacePalette?:boolean, marking?:boolean,
 *   pickScale?:boolean, interactionMaxFps?:number, postprocessing?:boolean,
 *   frameCost?:string, molstarPanel?:boolean, governor?:boolean|'observe',
 *   governorFloor?:number, msaa?:boolean, unknown:string[]}}
 */
export function parseRenderBudgetOverrides(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const parsed = { enabled: true, unknown: [] };
  if (text === '') return parsed;
  if (OFF_VALUES.includes(text.toLowerCase())) return { ...parsed, enabled: false };
  for (const pair of text.split(/[,;]/)) {
    const [rawKey, ...rest] = pair.split(/[:=]/);
    const key = String(rawKey ?? '').trim().toLowerCase();
    if (key === '') continue;
    const value = rest.join(':').trim().toLowerCase();
    if (!applyOverridePair(parsed, key, value)) parsed.unknown.push(key);
  }
  return parsed;
}

function applyOverridePair(into, key, value) {
  const number = Number.parseFloat(value);
  switch (key) {
    // Above 1 asks for more than the browser's default eye buffer; the
    // browser clamps the request to its native scale.
    case 'scale': case 'framebufferscale':
      if (number > 0 && number <= 2) into.framebufferScale = number;
      return true;
    // Measurement-only: keep the multisampled XR layer Mol* asks for, which
    // the Quest classes otherwise trade for fixed foveation.
    case 'msaa':
      if (ON_VALUES.includes(value)) into.msaa = true;
      else if (OFF_VALUES.includes(value)) into.msaa = false;
      return true;
    case 'foveation':
      if (number >= 0 && number <= 1) into.foveation = number;
      return true;
    case 'fps': case 'framerate': case 'targetframerate':
      if (OFF_VALUES.includes(value)) into.targetFrameRate = null;
      else if (number > 0) into.targetFrameRate = number;
      return true;
    case 'quality': case 'representationquality':
      if (QUALITY_VALUES.includes(value)) into.representationQuality = value;
      return true;
    // The tier a SURFACE is built at, stated in what the wearer sees rather
    // than in what Mol* is asked for: `surface:lower` is the coarse older
    // look, `surface:medium` the next one up, `surface:off` falls back to the
    // device tier. `qualityRequestFor` adds the headset compensation.
    case 'surface': case 'surfacequality':
      if (OFF_VALUES.includes(value)) into.surfaceQuality = null;
      else if (QUALITY_VALUES.includes(value)) into.surfaceQuality = value;
      return true;
    // The specular lobe on a surface: see `XR_SURFACE_MATERIAL`.
    case 'gloss': case 'surfacematerial':
      if (ON_VALUES.includes(value)) into.surfaceGloss = true;
      else if (OFF_VALUES.includes(value)) into.surfaceGloss = false;
      return true;
    // The width of that lobe, for sweeping it on hardware without a rebuild.
    // 0 is a mirror, 1 is fully matte; Mol*'s own "Glossy" preset is 0.6.
    case 'rough': case 'roughness':
      if (number >= 0 && number <= 1) into.surfaceRoughness = number;
      return true;
    // The optional non-chain surface palette: see `XR_SURFACE_PALETTE`.
    // `palette:off` restores Mol*'s saturated `many-distinct` list.
    case 'palette': case 'surfacepalette':
      if (ON_VALUES.includes(value)) into.surfacePalette = true;
      else if (OFF_VALUES.includes(value)) into.surfacePalette = false;
      return true;
    // The three-light rig: `light:off` is the older key-plus-back
    // pair, for a side-by-side against the rig.
    case 'light': case 'lighting':
      if (ON_VALUES.includes(value)) into.lighting = true;
      else if (OFF_VALUES.includes(value)) into.lighting = false;
      return true;
    case 'marking':
      if (ON_VALUES.includes(value)) into.marking = true;
      else if (OFF_VALUES.includes(value)) into.marking = false;
      return true;
    case 'pick': case 'pickscale':
      if (number > 0 && number <= 1) into.pickScale = number;
      return true;
    case 'hover': case 'interaction':
      if (ON_VALUES.includes(value)) into.interactionMaxFps = DESKTOP_INTERACTION_MAX_FPS;
      else if (OFF_VALUES.includes(value)) into.interactionMaxFps = 0;
      else if (number >= 0 && number <= 60) into.interactionMaxFps = number;
      return true;
    case 'postfx': case 'postprocessing':
      if (ON_VALUES.includes(value)) into.postprocessing = true;
      else if (OFF_VALUES.includes(value)) into.postprocessing = false;
      return true;
    case 'cost': case 'framecost':
      // `cost:gpu` went with the GPU timer: see `watchFrameCost`.
      if (ON_VALUES.includes(value) || OFF_VALUES.includes(value)) into.frameCost = value;
      return true;
    // The frame-time governor in `xr-frame-governor.mjs`. `observe` measures
    // and records what it would do without changing a pixel, which is the A
    // side of an A/B against `on`.
    case 'governor':
      if (ON_VALUES.includes(value)) into.governor = true;
      else if (OFF_VALUES.includes(value)) into.governor = false;
      else if (value === 'observe') into.governor = 'observe';
      return true;
    // The lowest effective linear scale the governor may reach.
    case 'governorfloor':
      if (number > 0 && number <= 1) into.governorFloor = number;
      return true;
    // The full Mol* viewer as a quad in the
    // scene rather than a page the wearer leaves immersion for. A prototype
    // with a measured cost, so it is on only where it is asked for by name and
    // only `on` turns it on -- an unreadable value leaves the wearer shipped.
    // `immersive-molstar-panel.mjs` owns everything it does.
    case 'molstarpanel': case 'molstar':
      if (ON_VALUES.includes(value)) into.molstarPanel = true;
      else if (OFF_VALUES.includes(value)) into.molstarPanel = false;
      return true;
    default:
      return false;
  }
}

/** The knob list from a search string and an environment value; env wins. */
export function renderBudgetOverridesFrom({ search = '', env } = {}) {
  const fromEnv = typeof env === 'string' ? env.trim() : '';
  if (fromEnv) return parseRenderBudgetOverrides(fromEnv);
  let value = null;
  try { value = new URLSearchParams(String(search ?? '')).get(XR_RENDER_BUDGET_PARAM); }
  catch { value = null; }
  return parseRenderBudgetOverrides(value ?? '');
}

/**
 * The same read against the live page or process, with the active render
 * quality's preset laid under it. Never throws.
 *
 * `context` is what the preset needs to size itself: the device class and the
 * scene for the framebuffer tier, the representation for whether the Mol*
 * demotion still has to be cancelled. A caller that knows none of them gets the
 * level's device-independent knobs, which is every knob but the scale.
 */
export function renderBudgetOverrides(scope = globalThis, context = {}) {
  let search = '', env;
  try { search = scope?.location?.search ?? ''; } catch { search = ''; }
  try { env = scope?.process?.env?.[XR_RENDER_BUDGET_ENV]; } catch { env = undefined; }
  return withRenderQualityPreset(renderBudgetOverridesFrom({ search, env }), { ...context, scope });
}

/**
 * The Mol* geometry quality to build representations at, or `null` for `auto`.
 *
 * Exported for the one-line hook in `viewer.mjs`, which is the only place that
 * calls `createStructureRepresentationParams`. It reads the device from the
 * navigator rather than a session, because a representation can be rebuilt
 * while a session presents and the caller does not hold one.
 *
 * `representation` is the type about to be built. A surface takes its own tier
 * (`XR_SURFACE_QUALITY`), because for a surface the tier picks a grid
 * resolution, not a subdivision count, and the tier that keeps a cartoon cheap
 * erases a surface. Everything else is unchanged, and a caller that names no
 * representation gets exactly what it got before.
 */
export function xrRepresentationQuality({ session, navigator: navigatorLike, representation,
  presenting = true, scope = globalThis } = {}) {
  if (!presenting) return null;
  const classified = sessionDeviceClass(session, navigatorLike);
  const tuned = renderBudgetOverrides(scope, { deviceClass: classified, representation });
  if (!tuned.enabled) return null;
  // `quality:` is the blunt knob and still wins over every representation rule.
  if (typeof tuned.representationQuality === 'string') {
    return tuned.representationQuality === 'auto' ? null : tuned.representationQuality;
  }
  const device = representationQualityFor(classified);
  // A device this module has no tier for stays on Mol*'s `auto` for every
  // representation, surfaces included: the surface tier exists to cancel a
  // headset's demotion, not to cap a machine that was never capped.
  if (device === null) return null;
  if (isSurfaceRepresentation(representation) && tuned.surfaceQuality !== null) {
    const wanted = typeof tuned.surfaceQuality === 'string' ? tuned.surfaceQuality : XR_SURFACE_QUALITY;
    if (wanted === 'auto') return null;
    return qualityRequestFor(wanted, navigatorLike ?? readNavigator(scope));
  }
  // `best` cancels the headset demotion for cartoon and ball-and-stick as well,
  // so a Quest builds the device tier instead of one below it. Every other
  // level leaves that alone: it adds vertex cost to every chapter of a tour,
  // not only to the one chapter that shows a surface.
  return tuned.compensateDemotion ? qualityRequestFor(device, navigatorLike ?? readNavigator(scope)) : device;
}

function readNavigator(scope) {
  try { return (scope ?? globalThis)?.navigator; } catch { return undefined; }
}

/**
 * Typed parameters matching Mol*'s "Automatic Detail" preset
 * (`mol-plugin-state/builder/structure/representation-preset.js:410-430`),
 * exported for a future mesoscale or spacefill scene.
 *
 * The single cartoon representation the lattice ships today does not use
 * them. `lod` culls a render object once the camera passes `maxDistance`
 * model units, which would erase a monumental-scale structure as the wearer
 * steps back, and `instanceGranularity: true` moves marker data from per
 * residue to per instance, which would coarsen the inspector's residue
 * highlight to a whole assembly copy.
 */
export function automaticDetailTypeParams() {
  return Object.freeze({
    gaussianSurface: Object.freeze({ lod: Object.freeze([30, 10_000_000, 100]) }),
    cartoon: Object.freeze({ lod: Object.freeze([-20, 300, 100]) }),
    ballAndStick: Object.freeze({ lod: Object.freeze([-20, 40, 20]) }),
  });
}

/** Read an override value. Absent or unrecognised means the budget is on. */
export function renderBudgetEnabledFrom({ search = '', env } = {}) {
  return renderBudgetOverridesFrom({ search, env }).enabled;
}

/** The same check against the live page or process. Never throws. */
export function renderBudgetEnabled(scope = globalThis) {
  return renderBudgetOverrides(scope).enabled;
}

/** Sum the atom sites of every structure the plugin currently holds. */
export function structureAtomSites(plugin) {
  let total = 0;
  try {
    const structures = plugin?.managers?.structure?.hierarchy?.current?.structures;
    if (!structures || typeof structures[Symbol.iterator] !== 'function') return 0;
    for (const ref of structures) {
      const count = ref?.cell?.obj?.data?.elementCount;
      if (Number.isFinite(count) && count > 0) total += count;
    }
  } catch { return 0; }
  return total;
}

/**
 * The render-object types whose `drawCount` is an index count over triangles.
 *
 * An isosurface is one of these two, chosen by Mol* from what the WebGL context
 * offers. Everything else a scene can hold — spheres, cylinders, lines, points,
 * text, a direct-volume box — counts something that is not a mesh triangle, and
 * summing those into this number would put a label's glyph quads on the same
 * ladder as the geometry the headset is fill-bound on.
 */
const TRIANGLE_RENDER_TYPES = new Set(['mesh', 'texture-mesh']);

/**
 * The measured triangle count of a built representation.
 *
 * The twin of `structureAtomSites` for a density tier, and the number every
 * rule in this module keys on — `isosurfaceForBudget` refuses on it and
 * `quest2TriangleFramebufferScale` picks a framebuffer from it. Without this,
 * `volume-build` records `triangles: 0`, which is exactly the value
 * `isosurfaceForBudget` refuses, and the demo index's 177,604 is a build-time
 * promise nothing on the page has checked.
 *
 * Mol* writes `drawCount` as the index count, which is three per triangle for
 * both mesh geometries (`mesh.js`, `texture-mesh.js`), and `instanceCount` as
 * the number of copies drawn. Never throws: a budget that cannot be measured is
 * reported as 0 and refused upstream, not guessed at.
 *
 * @param {unknown} representation a Mol* representation, or a viewer record's `representation`
 * @returns {number} triangles actually in the built geometry
 */
export function representationTriangles(representation) {
  try {
    const repr = representation?.obj?.data?.repr ?? representation?.data?.repr ?? representation?.repr ?? representation;
    const objects = repr?.renderObjects;
    if (!Array.isArray(objects)) return 0;
    let total = 0;
    for (const object of objects) {
      if (!TRIANGLE_RENDER_TYPES.has(object?.type)) continue;
      const drawCount = object?.values?.drawCount?.ref?.value;
      if (!Number.isFinite(drawCount) || drawCount < 3) continue;
      const instanceCount = object?.values?.instanceCount?.ref?.value;
      const instances = Number.isFinite(instanceCount) && instanceCount > 0 ? instanceCount : 1;
      total += Math.floor(drawCount / 3) * instances;
    }
    return total;
  } catch { return 0; }
}

/** Classify the headset from the navigator and the session's input sources. */
export function sessionDeviceClass(session, navigatorLike) {
  try { return deviceClass(navigatorLike ?? globalThis.navigator, describeInputSources(session)); }
  catch { return 'unknown'; }
}

/**
 * The `resolutionScale` to hand `webgl.xr.set`, which Mol* turns into the
 * layer's `framebufferScaleFactor`. This is a separate entry point from
 * `beginXrRenderBudget` because the layer is built before presentation
 * starts, and its scale cannot be changed afterwards.
 */
export function xrResolutionScale({ session, plugin, navigator: navigatorLike, atomSites, triangles = 0, scope = globalThis } = {}) {
  const device = sessionDeviceClass(session, navigatorLike);
  const sites = Number.isFinite(atomSites) ? atomSites : structureAtomSites(plugin);
  // The device and the scene are both known here, so this is the one reader
  // that can see the framebuffer tier `best` asks for. It is also the only
  // moment the scale can be changed at all: the layer is built immediately
  // after, and `framebufferScaleFactor` is fixed at construction.
  const overrides = renderBudgetOverrides(scope, { deviceClass: device, atomSites: sites, triangles });
  if (!overrides.enabled) return recallResolutionScale(1);
  return recallResolutionScale(renderBudget({ device, atomSites: sites, triangles, overrides }).framebufferScale);
}

/**
 * The scale the last layer was built with.
 *
 * `beginXrRenderBudget` runs after the layer exists and recomputes the budget
 * from the structures loaded by then. If a structure arrived in between, the
 * budget it reports is not the scale the layer holds, and the layer cannot be
 * rebuilt. The diagnostics entry carries both numbers so a frame-rate report
 * from the headset is read against the pixels the session actually drew.
 */
let lastResolutionScale = null;

function recallResolutionScale(scale) {
  lastResolutionScale = scale;
  return scale;
}

/** The scale `xrResolutionScale` last returned, or `null` before any session. */
export function lastLayerScale() { return lastResolutionScale; }

/**
 * Copy the optional XR frame-rate properties into JSON-safe page state.
 *
 * Both properties are absent on runtimes without the frame-rate API, and a
 * session that is ending can make even a property read throw. Keep this one
 * guarded reader as the source for the startup snapshot and diagnostics.
 */
export function readSessionFrameRates(session) {
  let supportedFrameRates = [];
  try {
    const rates = session?.supportedFrameRates;
    if (rates && typeof rates[Symbol.iterator] === 'function') {
      supportedFrameRates = [...rates].filter(rate => Number.isFinite(rate));
    }
  } catch { supportedFrameRates = []; }
  let reportedFrameRate = null;
  try {
    const rate = session?.frameRate;
    reportedFrameRate = Number.isFinite(rate) ? rate : null;
  }
  catch { reportedFrameRate = null; }
  return { supportedFrameRates, reportedFrameRate };
}

function recordSessionFrameRate(scope, event, state, requestedFrameRate, extra = {}) {
  const record = diagnosticsRecorder(scope);
  if (!record) return;
  const detail = { event, supportedFrameRates: [...state.supportedFrameRates],
    reportedFrameRate: state.reportedFrameRate, ...extra };
  if (Number.isFinite(requestedFrameRate)) {
    detail.requestedFrameRate = requestedFrameRate;
    if (Number.isFinite(state.reportedFrameRate) && state.reportedFrameRate > 0
        && state.reportedFrameRate !== requestedFrameRate) detail.mismatch = true;
  }
  try { record('session-frame-rate', detail); }
  catch { /* A diagnostics sink never owns the XR session. */ }
}

/**
 * Keep one session's granted frame-rate facts current for the desktop driver.
 * The first read and every `frameratechange` use the same guarded path.
 */
export function watchSessionFrameRates({ session, requestedFrameRate = null, scope = globalThis } = {}) {
  let requested = Number.isFinite(requestedFrameRate) ? requestedFrameRate : null;
  let current = readSessionFrameRates(session);
  let stopped = false;
  const publish = event => {
    if (stopped) return;
    current = readSessionFrameRates(session);
    recordSessionFrameRate(scope, event, current, requested);
  };
  const onFrameRateChange = () => publish('frameratechange');
  try { session?.addEventListener?.('frameratechange', onFrameRateChange); }
  catch { /* The initial facts remain useful without an event target. */ }
  publish('granted');
  return {
    state: () => ({ supportedFrameRates: [...current.supportedFrameRates], reportedFrameRate: current.reportedFrameRate }),
    setRequestedFrameRate(rate) {
      requested = Number.isFinite(rate) ? rate : null;
      current = readSessionFrameRates(session);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try { session?.removeEventListener?.('frameratechange', onFrameRateChange); }
      catch { /* An ended session may already have detached its listeners. */ }
    },
  };
}

function recordFrameRateRequest(scope, event, session, targetFrameRate, requestedFrameRate) {
  const state = readSessionFrameRates(session);
  recordSessionFrameRate(scope, event, state, requestedFrameRate, { targetFrameRate });
}

/**
 * Ask the session for the budget's target frame rate.
 *
 * `updateTargetFrameRate` returns a promise the caller must not await: a
 * runtime that rejects the rate keeps its current one, and immersion has
 * already started by the time this runs.
 *
 * @returns {{requested:number|null, sent:number|null, reason:string}}
 */
export function applyTargetFrameRate(session, wanted, scope = globalThis) {
  if (!Number.isFinite(wanted)) return { requested: null, sent: null, reason: 'not-requested' };
  if (typeof session?.updateTargetFrameRate !== 'function') {
    return { requested: wanted, sent: null, reason: 'unsupported' };
  }
  let supported;
  try { supported = session.supportedFrameRates; } catch { supported = undefined; }
  const sent = pickFrameRate(supported, wanted);
  if (sent === null) return { requested: wanted, sent: null, reason: 'no-supported-rate' };
  try {
    const result = session.updateTargetFrameRate(sent);
    const settled = () => {
      const { reportedFrameRate } = readSessionFrameRates(session);
      if (Number.isFinite(reportedFrameRate) && reportedFrameRate > 0 && reportedFrameRate !== sent) {
        recordFrameRateRequest(scope, 'request-mismatch', session, wanted, sent);
      }
    };
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(settled, () => {
        recordFrameRateRequest(scope, 'request-rejected', session, wanted, sent);
      }).catch(() => {});
    } else settled();
  } catch {
    recordFrameRateRequest(scope, 'request-rejected', session, wanted, sent);
    return { requested: wanted, sent: null, reason: 'refused' };
  }
  return { requested: wanted, sent, reason: 'sent' };
}

const PASS_OFF = Object.freeze({ name: 'off', params: {} });

/**
 * The pass profile immersion runs when postprocessing is ON, which is `best`
 * and `?xrRenderBudget=postfx:on`.
 *
 * WHY IT IS SPELLED OUT. `setXRProps` only rewrites `postprocessing.enabled`
 * (`mol-canvas3d/canvas3d.js:379`); every individual pass keeps whatever the
 * desktop panel left it at. Mol*'s own defaults are `occlusion: on`,
 * `antialiasing: smaa` and `bloom: on` (`mol-canvas3d/passes/postprocessing.js:102-134`),
 * and `BloomPass.isEnabled` is a bare name check (`bloom.js:33-35`), so simply
 * flipping the gate would hand a Quest 2 SMAA's three full-screen passes and a
 * bloom pyramid it has no emissive geometry to justify. Everything except the
 * two passes that buy the ChimeraX look is named off here.
 *
 * OCCLUSION, against Mol*'s defaults (`mol-canvas3d/passes/ssao.js:23-48`):
 *   samples          16, from 32     halves the depth taps per pixel
 *   resolutionScale  0.5, from 1     quarters the pixels those taps run on
 *   blurKernelSize   9, from 15      two separable passes, 9 taps not 15
 *   radius/bias      5 / 0.8         Mol*'s defaults; the radius is 2^5 = 32
 *                                    world units, which is the right size for
 *                                    a crevice on a 50 A protein
 *   multiScale       off             its 4 levels are 4x the sampling
 * Together that is one eighth of a desktop SSAO. This is the pass that carves
 * the crevices, and carved crevices are the whole of what makes a ChimeraX
 * surface read as a solid body rather than a coloured blob.
 *
 * OUTLINE is cheap next to it: one full-screen pass over the depth texture,
 * a handful of taps, no blur (`mol-canvas3d/passes/outline.js:21-26`).
 * `includeTransparent: false` matters - left true it pulls the transparent
 * depth target in through `isTransparentDepthRequired`
 * (`postprocessing.js:140-144`), which is a second depth prepass of the scene.
 * ChimeraX calls this `graphics silhouettes true`, and on a passthrough room a
 * dark silhouette is also what separates the molecule from a cluttered wall.
 *
 * COST, ESTIMATED, NOT MEASURED. A Quest 2 WebXR layer at scale 0.6 is roughly
 * 864x950 per eye, 1.64 Mpixel for the pair. SSAO at 0.5 resolutionScale runs
 * on 0.41 Mpixel: 16 depth taps is 6.6 M texel reads a frame, the two blur
 * passes add about 7.4 M, and the composite and outline passes add roughly one
 * full-resolution read each. Call it 20 M texel reads a frame, 1.5 G a second
 * at 72 Hz, against an Adreno 650 texture rate in the low single-digit
 * Gtexel/s - so single-digit milliseconds of a 13.9 ms frame, and plausibly
 * 3-5 ms. THAT IS ARITHMETIC FROM PARAMETER COUNTS, NOT A HARDWARE READING.
 *
 * The other cost is structural and is why this is not the default: enabling
 * postprocessing makes Mol* render each eye into an offscreen colour target
 * and blit it back, and Meta names a mid-eye-buffer render-target switch as
 * one of the two things that turn fixed foveated rendering off. Foveation is
 * the Quest 2's largest single fill saving, so `best` may lose more to losing
 * foveation than it spends on the passes themselves. Only the headset can
 * settle that, which is what `postfx:on` is for.
 */
export const XR_POSTPROCESSING = Object.freeze({
  occlusion: Object.freeze({
    name: 'on',
    params: Object.freeze({
      samples: 16,
      multiScale: PASS_OFF,
      radius: 5,
      bias: 0.8,
      blurKernelSize: 9,
      blurDepthBias: 0.5,
      resolutionScale: 0.5,
      color: 0x000000,
      transparentThreshold: 0.4,
    }),
  }),
  outline: Object.freeze({
    name: 'on',
    params: Object.freeze({ scale: 1, threshold: 0.33, color: 0x000000, includeTransparent: false }),
  }),
  shadow: PASS_OFF,
  dof: PASS_OFF,
  bloom: PASS_OFF,
  sharpening: PASS_OFF,
  antialiasing: PASS_OFF,
});

/**
 * The `Canvas3D.setProps` patch that turns the immersive pass list on or off.
 *
 * One function so that session entry and a mid-session render-quality change
 * cannot disagree: `beginXrRenderBudget` applies it once when the wearer
 * enters, and `viewer.mjs` applies it again when the wearer says "best
 * quality" without leaving, which is the case `beginXrRenderBudget` never sees.
 */
export function xrPostprocessingProps(on) {
  if (!on) {
    return {
      xr: { disablePostprocessing: true },
      postprocessing: { enabled: false, antialiasing: PASS_OFF, occlusion: PASS_OFF, outline: PASS_OFF },
      illumination: { enabled: false },
      multiSample: { mode: 'off' },
    };
  }
  return {
    xr: { disablePostprocessing: false },
    postprocessing: { enabled: true, ...XR_POSTPROCESSING },
    illumination: { enabled: false },
    multiSample: { mode: 'off' },
  };
}

function readPassState(canvas) {
  const props = canvas?.props;
  return {
    postprocessing: {
      enabled: props?.postprocessing?.enabled,
      antialiasing: props?.postprocessing?.antialiasing,
      occlusion: props?.postprocessing?.occlusion,
      outline: props?.postprocessing?.outline,
      // Also read back because `XR_POSTPROCESSING` names them off; without
      // these four the desktop panel would keep immersion's pass list after
      // the wearer left.
      shadow: props?.postprocessing?.shadow,
      dof: props?.postprocessing?.dof,
      bloom: props?.postprocessing?.bloom,
      sharpening: props?.postprocessing?.sharpening,
    },
    illumination: { enabled: props?.illumination?.enabled },
    multiSample: { mode: props?.multiSample?.mode },
    marking: { enabled: props?.marking?.enabled },
    pickScale: props?.pickScale,
    // Mol* keeps the interaction rate on the helper rather than on the canvas
    // props object on some builds, so the read can come back undefined. Left
    // undefined, `definedOnly` drops the whole `interaction` group and the
    // desktop panel keeps the immersive rate of 0 after the wearer leaves,
    // which kills hover on the desktop panel for the rest of the page's life.
    // The Mol* default is the value to fall back to.
    interaction: { maxFps: Number.isFinite(props?.interaction?.maxFps) ? props.interaction.maxFps : DESKTOP_INTERACTION_MAX_FPS },
    // The controller-ray mesh: see the `pointer` write in `beginXrRenderBudget`.
    pointer: { enabled: props?.pointer?.enabled },
    xr: { disablePostprocessing: props?.xr?.disablePostprocessing },
  };
}

function definedOnly(value) {
  const kept = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const inner = definedOnly(entry);
      if (Object.keys(inner).length > 0) kept[key] = inner;
    } else kept[key] = entry;
  }
  return kept;
}

/**
 * Turn the immersive render budget on for one session.
 *
 * The returned `restore` puts every pass back exactly as it was read, so the
 * desktop panel keeps its own look after the wearer leaves immersion. Both
 * calls are safe on a plugin without a Canvas3D and on a session that has
 * already ended.
 *
 * @param {{plugin?:object, canvas?:object, session?:object, navigator?:object,
 *   atomSites?:number, enabled?:boolean, scope?:object}} options
 * @returns {{budget:object, applied:boolean, frameRate:object,
 *   frameRateState:()=>{supportedFrameRates:number[],reportedFrameRate:number|null}, restore:()=>void}}
 */
export function beginXrRenderBudget({ plugin, canvas, session, navigator: navigatorLike,
  atomSites, triangles = 0, enabled, scope = globalThis } = {}) {
  const target = canvas ?? plugin?.canvas3d;
  const sites = Number.isFinite(atomSites) ? atomSites : structureAtomSites(plugin);
  const device = sessionDeviceClass(session, navigatorLike);
  const overrides = renderBudgetOverrides(scope, { deviceClass: device, atomSites: sites, triangles });
  const budget = renderBudget({ device, atomSites: sites, triangles, overrides });
  const sessionFrameRates = watchSessionFrameRates({ session, scope });
  const on = typeof enabled === 'boolean' ? enabled : overrides.enabled;
  if (!on || typeof target?.setProps !== 'function') {
    const frameRate = { requested: null, sent: null, reason: on ? 'no-canvas' : 'disabled' };
    recordRenderBudget(budget, frameRate, false, overrides, scope, session);
    return { budget, overrides, applied: false, frameRate, frameRateState: sessionFrameRates.state,
      restore() { sessionFrameRates.stop(); } };
  }
  let previous;
  try { previous = definedOnly(readPassState(target)); } catch { previous = {}; }
  try {
    target.setProps({
      // `xr.disablePostprocessing` is the authority: `setXRProps` rewrites
      // `postprocessing.enabled` from it on every immersive frame
      // (`mol-canvas3d/canvas3d.js:379`), so it is the one lever that survives.
      // ON, the pass list is stated rather than inherited from the desktop
      // panel: see `XR_POSTPROCESSING` for what runs and what it costs.
      // Neither branch ever switches path-traced illumination on, which no
      // Quest can afford.
      ...xrPostprocessingProps(!budget.disablePostprocessing),
      // Two extra full-scene renders per eye whenever a residue is selected,
      // which a running tour does on every step.
      marking: { enabled: budget.marking },
      pickScale: budget.pickScale,
      // A hover pick renders the scene into the pick buffer again, mid eye
      // buffer, which is one of the two render-target switches Meta names as
      // defeating fixed foveation.
      interaction: { maxFps: budget.interactionMaxFps },
      // Stock XRManager re-enables the pointer on its next update. The
      // session's xr-pointer adapter retains visible controller feedback using
      // reusable geometry; this initial off state suppresses the desktop mesh
      // while that adapter attaches (or stock Mol* resumes if it cannot).
      pointer: { enabled: 'off' },
    });
  } catch { /* A lost context owns its own recovery; immersion continues. */ }
  const frameRate = applyTargetFrameRate(session, budget.targetFrameRate, scope);
  sessionFrameRates.setRequestedFrameRate(frameRate.sent);
  recordRenderBudget(budget, frameRate, true, overrides, scope, session);
  let restored = false;
  return {
    budget,
    overrides,
    applied: true,
    frameRate,
    frameRateState: sessionFrameRates.state,
    restore() {
      if (restored) return;
      restored = true;
      sessionFrameRates.stop();
      if (Object.keys(previous).length === 0) return;
      try { target.setProps(previous); } catch { /* The desktop loop restarts regardless. */ }
    },
  };
}

/**
 * Put the chosen budget on the headset diagnostics ring.
 *
 * `read_headset_log` on the Mac is the only place these numbers are visible
 * from, and a frame-rate complaint is unreadable without them: 46 fps at
 * scale 0.8 and 46 fps at scale 0.6 are different problems. The recorder is
 * reached through the global the diagnostics module installs rather than by
 * import, because that module imports this one.
 */
function recordRenderBudget(budget, frameRate, applied, overrides, scope, session) {
  const record = diagnosticsRecorder(scope);
  if (!record) return;
  // Only the knobs the address actually named. The render-quality preset fills
  // keys underneath them on every session, and listing those here would make
  // `overrides` read as "the address was tuned" on a page nobody tuned.
  const bookkeeping = new Set([...(overrides?.presetKeys ?? []),
    'enabled', 'unknown', 'presetKeys', 'renderQuality', 'compensateDemotion']);
  const tuned = Object.keys(overrides ?? {}).filter(key => !bookkeeping.has(key));
  // Read back from the layer, not from what was asked for. `layerAntialias`
  // must be false for fixed foveation to run at all on Quest, and
  // `layerFoveation` is the level the runtime accepted, which is the one
  // number that says whether the MSAA change reached the compositor.
  let layer;
  try { layer = describeXrLayer(session); } catch { layer = { present: false, antialias: null, fixedFoveation: null }; }
  try {
    record('render-budget', {
      device: budget.device,
      atomSites: budget.atomSites,
      heavyScene: budget.heavyScene,
      framebufferScale: budget.framebufferScale,
      layerScale: lastResolutionScale,
      foveation: budget.foveation,
      targetFrameRate: budget.targetFrameRate,
      sentFrameRate: frameRate.sent,
      frameRateReason: frameRate.reason,
      // One nested key, not two: `sanitizeDetail` keeps at most
      // MAX_DETAIL_KEYS top-level fields and drops the overflow silently, and
      // `applied` is the field that must never be the one dropped.
      // `present` first: without it two nulls read as "the runtime ignored
      // both attributes" when they usually mean "there is no layer yet".
      layer: { present: layer.present ?? null, antialias: layer.antialias, fixedFoveation: layer.fixedFoveation },
      quality: budget.representationQuality,
      marking: budget.marking,
      pickScale: budget.pickScale,
      interactionMaxFps: budget.interactionMaxFps,
      applied,
      overrides: tuned.length > 0 ? tuned.join(',') : 'none',
    });
  } catch { /* A diagnostics failure never touches immersion. */ }
}

function diagnosticsRecorder(scope) {
  let record;
  try { record = (scope ?? globalThis)?.__stereofoldDiagnostics?.record; }
  catch { return null; }
  return typeof record === 'function' ? record : null;
}

/** How often `watchFrameCost` writes a sample. */
export const FRAME_COST_SAMPLE_MS = 1_000;

/**
 * A frame callback longer than this missed its window at every rate a Quest
 * offers. 72 Hz allows 13.9 ms, 90 Hz allows 11.1 ms, and asynchronous
 * timewarp halves the presented rate rather than dropping to the next one, so
 * 20 ms is already a reprojected frame.
 */
export const LONG_FRAME_MS = 20;

const sessionTransitions = new WeakMap();
let nextTransitionId = 0;

/**
 * Whether a scene transition is running on this session. The frame governor
 * reads it so a rebuild's frames are not taken for the steady scene's.
 */
export function sceneTransitionActive(session) {
  return Boolean(session) && (sessionTransitions.get(session)?.size ?? 0) > 0;
}

/** Counts and monotonic timings only; no source bytes or tracked poses. */
export function beginSceneTransition({ session, operation, record, now = () => globalThis.performance.now(), scope = globalThis } = {}) {
  const emit = record ?? diagnosticsRecorder(scope);
  const startedAtMs = now();
  const detail = { id: ++nextTransitionId, operation, startedAtMs, firstFrameAtMs: null,
    oldRemovedAtMs: null, worstFrameMs: null, maxCallbackMs: null, maxFrameGapMs: null, frames: 0 };
  const active = session && (sessionTransitions.get(session) ?? new Set());
  if (active) sessionTransitions.set(session, active);
  const sample = (callbackMs, gapMs) => {
    detail.frames++;
    detail.maxCallbackMs = Math.max(detail.maxCallbackMs ?? 0, callbackMs);
    if (gapMs !== undefined) detail.maxFrameGapMs = Math.max(detail.maxFrameGapMs ?? 0, gapMs);
    detail.worstFrameMs = Math.max(detail.maxCallbackMs, detail.maxFrameGapMs ?? 0);
  };
  active?.add(sample);
  let ended = false;
  const publish = (phase, error) => {
    const reason = error === undefined ? (phase === 'failed' ? 'The scene transition failed.' : undefined)
      : String(error?.message || error || 'The scene transition failed.');
    try { emit?.('transition', { ...detail, phase, ...(reason ? { reason } : {}), elapsedMs: round2(now() - startedAtMs),
      reportedFrameRate: readSessionFrameRates(session).reportedFrameRate }); } catch { /* advisory */ }
  };
  publish('start');
  return {
    firstFrame() { if (!ended && detail.firstFrameAtMs === null) { detail.firstFrameAtMs = now(); publish('first-frame'); } },
    oldRemoved() { if (!ended) { detail.oldRemovedAtMs = now(); publish('old-removed'); } },
    finish(outcome = 'complete', error) {
      if (ended) return;
      ended = true; active?.delete(sample); publish(outcome, error);
    },
  };
}

/**
 * CPU cost of immersive animation callbacks.
 *
 * `frame-rate` says the session is missing 72 Hz. It cannot say why, and the
 * CPU callback time, delivered XR-frame gaps and main-thread long tasks are
 * separate signals. Short callbacks with long gaps do not identify a GPU
 * bottleneck: geometry tasks between callbacks, the compositor, recording and
 * GPU waits can all delay delivery. This records each measurable signal.
 *
 * The measurement is a wrapper around `session.requestAnimationFrame`
 * installed outside the head observer, so it times Mol*'s draw together with
 * the observer's seating, input and toolbar work. Several subscribers can run in one
 * native XR frame; callbackCount and callbacksPerSecond count those subscribers,
 * not eyes or presented frames. Only the dedicated `frame-rate` sampler measures
 * frames per second. cpuPerUniqueFrameMs and overlayPerUniqueFrameMs divide
 * the sample's CPU totals by its observed distinct XR timestamps; they are
 * sample averages, not GPU duration or a distribution of complete frame costs.
 * Legacy timing fields frameMs/maxFrameMs/longFrames refer
 * to callback CPU cost/count, retained for existing diagnostic readers. `measure`
 * attributes overlay work; drawMs is the remaining callback work, including
 * Mol* rendering when the callback belongs to its render loop.
 *
 * There is no GPU timing here. An earlier draft polled
 * `EXT_disjoint_timer_query_webgl2` for per-frame GPU nanoseconds. Chromium
 * disables that extension, and Quest Browser is Chromium, so on the one device
 * this measurement exists for it never returned a sample. The wall-clock split
 * between `drawMs` and `overlayMs` attributes synchronous page work only.
 * It cannot establish GPU fill time or compositor presentation rate.
 *
 * @param {{session?:object, record?:Function, now?:Function,
 *   intervalMs?:number, longFrameMs?:number, sampling?:string,
 *   scope?:object}} options
 * @returns {{stop:()=>void, measure:(fn:Function)=>any, beginTransform:()=>number|undefined,
 *   endTransform:(started:number|undefined)=>void, supported:boolean}}
 */
export function watchFrameCost({ session, record, now = () => (globalThis.performance?.now?.() ?? Date.now()),
  intervalMs = FRAME_COST_SAMPLE_MS, longFrameMs = LONG_FRAME_MS, sampling, scope = globalThis } = {}) {
  const emit = typeof record === 'function' ? record : diagnosticsRecorder(scope);
  const overrides = renderBudgetOverrides(scope);
  const wanted = typeof sampling === 'string' ? sampling : overrides.frameCost;
  const inert = { stop() {}, measure(fn) { return fn?.(); }, beginTransform() {}, endTransform() {}, supported: false };
  if (!emit || OFF_VALUES.includes(String(wanted ?? ''))) return inert;
  const requestFrame = session?.requestAnimationFrame;
  if (typeof requestFrame !== 'function') return inert;

  let frames = 0, since = now(), totalMs = 0, maxMs = 0, overlayTotalMs = 0, longFrames = 0;
  let overlayMs = 0, stopped = false, previousFrameAt;
  let transformPassCount = 0, transformCpuMs = 0, maxTransformMs = 0;
  let maxGapMs = 0, frameGaps = 0;
  let lastXrTime, uniqueFrames = 0, maxXrGapMs = 0, xrGaps = 0;
  let longTaskCount = 0, longTaskTotalMs = 0, maxLongTaskMs = 0, longTaskObserver;
  // Geometry and caption builds often run between rAF callbacks. The browser's
  // long-task observer exposes that main-thread cost without polling the GPU.
  try {
    if (scope.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
      longTaskObserver = new scope.PerformanceObserver(list => {
        if (stopped) return;
        for (const entry of list.getEntries()) {
          if (!Number.isFinite(entry.duration) || entry.duration < 0) continue;
          longTaskCount++; longTaskTotalMs += entry.duration;
          maxLongTaskMs = Math.max(maxLongTaskMs, entry.duration);
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: false });
    }
  } catch {
    try { longTaskObserver?.disconnect(); } catch {}
    longTaskObserver = undefined;
  }

  const flush = elapsed => {
    const seconds = elapsed / 1_000;
    try { emit('frame-cost', {
      callbacksPerSecond: round1(frames / seconds),
      callbackCount: frames,
      uniqueFrameCount: uniqueFrames,
      maxXrFrameGapMs: xrGaps ? round2(maxXrGapMs) : null,
      callbackCpuMs: round2(totalMs),
      overlayCpuMs: round2(overlayTotalMs),
      transformPassCount, transformCpuMs: round2(transformCpuMs), maxTransformMs: round2(maxTransformMs),
      cpuPerUniqueFrameMs: uniqueFrames > 0 ? round2(totalMs / uniqueFrames) : null,
      overlayPerUniqueFrameMs: uniqueFrames > 0 ? round2(overlayTotalMs / uniqueFrames) : null,
      gpuMeasured: false,
      longTaskSupported: Boolean(longTaskObserver),
      ...(longTaskObserver ? { longTaskCount, longTaskTotalMs: round2(longTaskTotalMs), maxLongTaskMs: round2(maxLongTaskMs) } : {}),
      seconds: round1(seconds),
      frameMs: round2(totalMs / Math.max(1, frames)),
      maxFrameMs: round2(maxMs),
      maxFrameGapMs: frameGaps ? round2(maxGapMs) : null,
      reportedFrameRate: readSessionFrameRates(session).reportedFrameRate,
      drawMs: round2(Math.max(0, totalMs - overlayTotalMs) / Math.max(1, frames)),
      overlayMs: round2(overlayTotalMs / Math.max(1, frames)),
      longFrames,
    }); } catch { /* Advisory diagnostics must never abort a renderer callback. */ }
    frames = 0; totalMs = 0; maxMs = 0; overlayTotalMs = 0; longFrames = 0;
    transformPassCount = 0; transformCpuMs = 0; maxTransformMs = 0;
    maxGapMs = 0; frameGaps = 0;
    uniqueFrames = 0; maxXrGapMs = 0; xrGaps = 0;
    longTaskCount = 0; longTaskTotalMs = 0; maxLongTaskMs = 0;
    since = now();
  };

  function sampledRequestFrame(callback) {
    return requestFrame.call(this, (time, frame) => {
      if (stopped) return callback(time, frame);
      overlayMs = 0;
      if (Number.isFinite(time) && time !== lastXrTime) {
        uniqueFrames++;
        if (lastXrTime !== undefined && time > lastXrTime) {
          maxXrGapMs = Math.max(maxXrGapMs, time - lastXrTime); xrGaps++;
        }
        lastXrTime = time;
      }
      const started = now();
      const gap = previousFrameAt === undefined ? undefined : started - previousFrameAt;
      previousFrameAt = started;
      try {
        return callback(time, frame);
      } finally {
        const cost = now() - started;
        frames += 1;
        totalMs += cost;
        overlayTotalMs += overlayMs;
        if (cost > maxMs) maxMs = cost;
        if (cost >= longFrameMs) longFrames += 1;
        if (gap !== undefined) { maxGapMs = Math.max(maxGapMs, gap); frameGaps++; }
        for (const sample of sessionTransitions.get(session) ?? []) sample(cost, gap);
        const elapsed = now() - since;
        if (elapsed >= intervalMs) flush(elapsed);
      }
    });
  }
  session.requestAnimationFrame = sampledRequestFrame;

  return {
    supported: true,
    /** Attribute the caller's per-frame block to `overlayMs` rather than to Mol*. */
    measure(fn) {
      if (typeof fn !== 'function') return undefined;
      const started = now();
      try { return fn(); }
      finally { overlayMs += now() - started; }
    },
    // Numeric brackets avoid a callback/token allocation in the transform hot
    // path. Counts include completed or throwing passes since the last sample,
    // including placements between rAF callbacks; this is CPU wall time only.
    beginTransform() { return stopped ? undefined : now(); },
    endTransform(started) {
      if (stopped || !Number.isFinite(started)) return;
      const elapsed = Math.max(0, now() - started);
      transformPassCount++; transformCpuMs += elapsed;
      maxTransformMs = Math.max(maxTransformMs, elapsed);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (session.requestAnimationFrame === sampledRequestFrame) session.requestAnimationFrame = requestFrame;
      try { longTaskObserver?.disconnect(); } catch { /* Session cleanup still completes. */ }
    },
  };
}

function round1(value) { return Number.isFinite(value) ? Math.round(value * 10) / 10 : null; }
function round2(value) { return Number.isFinite(value) ? Math.round(value * 100) / 100 : null; }
