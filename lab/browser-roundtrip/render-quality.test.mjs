import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RENDER_QUALITY, RENDER_QUALITY_LEVELS, RENDER_QUALITY_STORAGE_KEY,
  QUEST2_SCALE_HEAVY, QUEST2_SCALE_LIGHT, QUEST2_SCALE_MEDIUM,
  activeRenderQuality, framebufferScaleFor, parseRenderBudgetOverrides, raisedFramebufferScale,
  readStoredRenderQuality, renderQualityPreset, representationForBudget, setActiveRenderQuality, storeRenderQuality,
  HEAVY_SCENE_ATOM_SITES, SURFACE_FALLBACK_REPRESENTATION,
  ligandOverlayForBudget, LIGAND_OVERLAY_REPRESENTATION, LIGAND_OVERLAY_ATOM_CEILING,
  isAllAtomRepresentation, isDenseRepresentation,
  withRenderQualityPreset, xrRepresentationMaterial, xrRepresentationQuality, xrResolutionScale,
  XR_POSTPROCESSING, XR_RENDERER_LIGHTING, XR_SURFACE_MATERIAL, XR_SURFACE_PALETTE,
  xrColorParams, xrPostprocessingProps,
} from './xr-render-budget.mjs';
import { RENDER_QUALITY_LEVELS as MENU_RENDER_QUALITY_LEVELS } from './spatial-toolbar-content.mjs';

const QUEST2_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/150.1.0.24.52.1046134268';
const QUEST3_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/150.1.0.24.52.1046134268';
const DESKTOP_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36';

/** 9KJ6, the demo measured on a Quest 2. */
const CRISPR_SITES = 13_121;
/** The microtubule lattice: past the heavy threshold. */
const LATTICE_SITES = 177_268;

const session = () => ({ inputSources: [] });

/** Run `body` at `level`, then put the module back on the default. */
function atLevel(level, body) {
  setActiveRenderQuality(level);
  try { return body(); }
  finally { setActiveRenderQuality(DEFAULT_RENDER_QUALITY); }
}

/** The tier Mol* BUILDS, which on a standalone headset is one below the ask. */
function builtQuality({ agent, representation, level }) {
  return atLevel(level, () => {
    const asked = xrRepresentationQuality({
      session: session(), navigator: { userAgent: agent }, representation, scope: {},
    });
    if (asked === null) return null;
    const ladder = ['lowest', 'lower', 'low', 'medium', 'high', 'higher', 'highest'];
    const at = ladder.indexOf(asked);
    const standalone = /OculusBrowser\//.test(agent);
    return standalone && at > 0 ? ladder[at - 1] : asked;
  });
}

test('the menu and the budget name the same three levels', () => {
  assert.deepEqual(RENDER_QUALITY_LEVELS, ['fast', 'balanced', 'best']);
  assert.deepEqual([...MENU_RENDER_QUALITY_LEVELS], [...RENDER_QUALITY_LEVELS]);
  assert.equal(DEFAULT_RENDER_QUALITY, 'balanced');
});

test('the preset table is the same off a headset as on one', () => {
  for (const device of ['quest2', 'quest3', 'unknown']) {
    assert.equal(renderQualityPreset('fast', { deviceClass: device }).surfaceQuality, 'lower');
    assert.equal(renderQualityPreset('balanced', { deviceClass: device }).surfaceQuality, 'low');
    assert.equal(renderQualityPreset('best', { deviceClass: device }).surfaceQuality, 'medium');
    assert.equal(renderQualityPreset('fast', { deviceClass: device }).surfaceGloss, false);
    assert.equal(renderQualityPreset('balanced', { deviceClass: device }).surfaceGloss, true);
    assert.equal(renderQualityPreset('best', { deviceClass: device }).surfaceGloss, true);
    // `best` is the level that runs the occlusion and
    // outline passes, and it is the only one. `fast` and `balanced` must never
    // pay for an intermediate render target.
    assert.equal(renderQualityPreset('fast', { deviceClass: device }).postprocessing, false);
    assert.equal(renderQualityPreset('balanced', { deviceClass: device }).postprocessing, false);
    assert.equal(renderQualityPreset('best', { deviceClass: device }).postprocessing, true);
    // The pastel palette is a vertex attribute, so every level gets it.
    for (const level of RENDER_QUALITY_LEVELS) {
      assert.equal(renderQualityPreset(level, { deviceClass: device }).surfacePalette, true,
        `${level} on ${device} must keep the pastel surface palette`);
    }
  }
});

test('only best cancels the Mol* demotion, and only for non-surface geometry', () => {
  assert.equal(renderQualityPreset('best', { representation: 'cartoon' }).compensateDemotion, true);
  assert.equal(renderQualityPreset('best', { representation: 'ball-and-stick' }).compensateDemotion, true);
  // A surface asks through `qualityRequestFor` at every level already.
  assert.equal(renderQualityPreset('best', { representation: 'molecular-surface' }).compensateDemotion, false);
  assert.equal(renderQualityPreset('balanced', { representation: 'cartoon' }).compensateDemotion, false);
  assert.equal(renderQualityPreset('fast', { representation: 'cartoon' }).compensateDemotion, false);
});

test('an unknown level falls back to balanced rather than throwing', () => {
  for (const bad of [undefined, null, '', 'BEST', 'ultra', 7, {}]) {
    assert.equal(renderQualityPreset(bad, {}).level, 'balanced');
  }
});

test('best steps the Quest 2 framebuffer up one tier and stops at the top', () => {
  assert.equal(raisedFramebufferScale('quest2', 1_000), QUEST2_SCALE_LIGHT);
  assert.equal(raisedFramebufferScale('quest2', CRISPR_SITES), QUEST2_SCALE_LIGHT);
  // A heavy scene rises to the medium tier, not to the light one.
  assert.equal(raisedFramebufferScale('quest2', LATTICE_SITES), QUEST2_SCALE_MEDIUM);
  assert.equal(framebufferScaleFor('quest2', LATTICE_SITES), QUEST2_SCALE_HEAVY);
  // Every other class already draws at native scale; there is no tier above.
  for (const device of ['quest3', 'quest-pro', 'unknown']) {
    assert.equal(raisedFramebufferScale(device, CRISPR_SITES), null);
  }
});

/** wall (40,908) and tip (43,066) are both offered to a Quest 2. */
const WALL_SITES = 40_908;

test('large requested surfaces, spheres and sticks are preserved on every headset', () => {
  for (const representation of ['molecular-surface', 'gaussian_surface', 'spacefill', 'ball-and-stick', 'ball_and_stick', 'cartoon'])
    for (const deviceClass of ['quest2', 'quest3', 'quest-pro', 'vision-pro', 'unknown', 'hand-only'])
      for (const atomSites of [CRISPR_SITES, WALL_SITES, HEAVY_SCENE_ATOM_SITES, HEAVY_SCENE_ATOM_SITES + 1, 1_000_001]) {
        assert.equal(representationForBudget(representation, { deviceClass, atomSites }), representation);
        assert.equal(representationForBudget(representation, { deviceClass, atomSites, overBudget: 'draw' }), representation);
      }
  assert.ok(isAllAtomRepresentation('spacefill') && isDenseRepresentation('spacefill'));
  assert.ok(!isAllAtomRepresentation('molecular-surface') && isDenseRepresentation('molecular-surface'));
  assert.ok(!isAllAtomRepresentation('cartoon') && !isDenseRepresentation('cartoon'));
  for (const value of [undefined, null, 42, {}, '']) {
    assert.equal(isAllAtomRepresentation(value), false); assert.equal(isDenseRepresentation(value), false);
  }
});


// A cartoon has no ligand in it, so demoting "Same cargo" to
// a cartoon and stopping there would answer the frame rate by deleting the
// subject. The ligands keep the representation the chapter asked for.
test('a demoted all-atom chapter keeps its ligands as spheres', () => {
  // The microtubule wall: six operator copies, 738 ligand atom sites.
  assert.equal(ligandOverlayForBudget('spacefill', 'cartoon', { ligandAtomSites: 738 }),
    LIGAND_OVERLAY_REPRESENTATION);
  assert.equal(ligandOverlayForBudget('ball-and-stick', 'cartoon', { ligandAtomSites: 738 }),
    LIGAND_OVERLAY_REPRESENTATION);
  // Nothing was demoted, so the main representation already draws them.
  assert.equal(ligandOverlayForBudget('spacefill', 'spacefill', { ligandAtomSites: 738 }), null);
  assert.equal(ligandOverlayForBudget('cartoon', 'cartoon', { ligandAtomSites: 738 }), null);
  // A surface chapter is not an all-atom ask; it never gets an overlay.
  assert.equal(ligandOverlayForBudget('molecular-surface', 'cartoon', { ligandAtomSites: 738 }), null);
  // A structure with no ligands has nothing to keep.
  for (const sites of [undefined, null, 0, -1, Number.NaN]) {
    assert.equal(ligandOverlayForBudget('spacefill', 'cartoon', { ligandAtomSites: sites }), null);
  }
  // And ligands that are themselves a heavy scene get the plain demotion,
  // because drawing them would put back what the demotion took away.
  assert.equal(ligandOverlayForBudget('spacefill', 'cartoon',
    { ligandAtomSites: LIGAND_OVERLAY_ATOM_CEILING }), LIGAND_OVERLAY_REPRESENTATION);
  assert.equal(ligandOverlayForBudget('spacefill', 'cartoon',
    { ligandAtomSites: LIGAND_OVERLAY_ATOM_CEILING + 1 }), null);
  assert.ok(LIGAND_OVERLAY_ATOM_CEILING < HEAVY_SCENE_ATOM_SITES,
    'The overlay ceiling must sit well under the tier that caused the demotion.');
});

test('the framebuffer a session opens with, per level and device', () => {
  const scale = (agent, sites, level) => atLevel(level, () => xrResolutionScale({
    session: session(), navigator: { userAgent: agent }, atomSites: sites, scope: {},
  }));
  assert.equal(scale(QUEST2_AGENT, CRISPR_SITES, 'fast'), QUEST2_SCALE_MEDIUM);
  assert.equal(scale(QUEST2_AGENT, CRISPR_SITES, 'balanced'), QUEST2_SCALE_MEDIUM);
  assert.equal(scale(QUEST2_AGENT, CRISPR_SITES, 'best'), QUEST2_SCALE_LIGHT);
  assert.equal(scale(QUEST2_AGENT, LATTICE_SITES, 'balanced'), QUEST2_SCALE_HEAVY);
  assert.equal(scale(QUEST2_AGENT, LATTICE_SITES, 'best'), QUEST2_SCALE_MEDIUM);
  for (const level of RENDER_QUALITY_LEVELS) {
    assert.equal(scale(QUEST3_AGENT, CRISPR_SITES, level), 1, `quest3 stays native at ${level}`);
    assert.equal(scale(DESKTOP_AGENT, CRISPR_SITES, level), 1, `a desktop stays native at ${level}`);
  }
});

test('the surface tier a Quest 2 builds, per level', () => {
  const built = level => builtQuality({ agent: QUEST2_AGENT, representation: 'molecular-surface', level });
  // `fast` is the 3.0 Angstrom blob.
  assert.equal(built('fast'), 'lower');
  assert.equal(built('balanced'), 'low');
  assert.equal(built('best'), 'medium');
});

test('the cartoon tier a Quest 2 builds, per level', () => {
  const built = level => builtQuality({ agent: QUEST2_AGENT, representation: 'cartoon', level });
  assert.equal(built('fast'), 'lower');
  assert.equal(built('balanced'), 'lower');
  // surfacelook risk 3: best is the level that buys blocky ribbons back.
  assert.equal(built('best'), 'low');
  assert.equal(builtQuality({ agent: QUEST2_AGENT, representation: 'ball-and-stick', level: 'best' }), 'low');
});

test('a Quest 3 keeps its own device tier and rises with best', () => {
  assert.equal(builtQuality({ agent: QUEST3_AGENT, representation: 'cartoon', level: 'balanced' }), 'low');
  assert.equal(builtQuality({ agent: QUEST3_AGENT, representation: 'cartoon', level: 'best' }), 'medium');
  assert.equal(builtQuality({ agent: QUEST3_AGENT, representation: 'molecular-surface', level: 'balanced' }), 'low');
  assert.equal(builtQuality({ agent: QUEST3_AGENT, representation: 'molecular-surface', level: 'best' }), 'medium');
  assert.equal(builtQuality({ agent: QUEST3_AGENT, representation: 'molecular-surface', level: 'fast' }), 'lower');
});

test('a machine the budget never capped stays on Mol* auto at every level', () => {
  for (const level of RENDER_QUALITY_LEVELS) {
    for (const representation of ['cartoon', 'molecular-surface']) {
      assert.equal(builtQuality({ agent: DESKTOP_AGENT, representation, level }), null,
        `${representation} at ${level} off a headset`);
    }
  }
});

test('nothing is built at an immersive tier while the page is not presenting', () => {
  for (const level of RENDER_QUALITY_LEVELS) {
    atLevel(level, () => {
      assert.equal(xrRepresentationQuality({ session: session(), navigator: { userAgent: QUEST2_AGENT },
        representation: 'molecular-surface', presenting: false, scope: {} }), null);
      assert.equal(xrRepresentationMaterial({ representation: 'molecular-surface', presenting: false, scope: {} }), null);
    });
  }
});

test('the specular lobe follows the level, and only a surface wears it', () => {
  const material = (representation, level) => atLevel(level,
    () => xrRepresentationMaterial({ representation, scope: {} }));
  assert.equal(material('molecular-surface', 'fast'), null);
  assert.ok(material('molecular-surface', 'balanced'));
  assert.ok(material('molecular-surface', 'best'));
  assert.equal(material('cartoon', 'best'), null);
});

test('a knob typed into the address still wins over the level', () => {
  const scope = { location: { search: '?xrRenderBudget=surface:lower,gloss:on' } };
  atLevel('best', () => {
    assert.equal(xrRepresentationQuality({ session: session(), navigator: { userAgent: QUEST2_AGENT },
      representation: 'molecular-surface', scope }), 'low'); // asks low, a Quest builds lower
    assert.ok(xrRepresentationMaterial({ representation: 'molecular-surface', scope }));
  });
  atLevel('fast', () => {
    assert.ok(xrRepresentationMaterial({ representation: 'molecular-surface', scope }),
      'gloss:on overrides the fast preset');
  });
});

test('budget off stays off at every level', () => {
  const scope = { location: { search: '?xrRenderBudget=off' } };
  for (const level of RENDER_QUALITY_LEVELS) {
    atLevel(level, () => {
      assert.equal(xrRepresentationQuality({ session: session(), navigator: { userAgent: QUEST2_AGENT },
        representation: 'molecular-surface', scope }), null);
      assert.equal(xrResolutionScale({ session: session(), navigator: { userAgent: QUEST2_AGENT },
        atomSites: CRISPR_SITES, scope }), 1);
    });
  }
});

test('the preset fills only the keys the address left alone', () => {
  const typed = parseRenderBudgetOverrides('surface:medium');
  const merged = withRenderQualityPreset(typed, { deviceClass: 'quest2' }, 'fast');
  assert.equal(merged.surfaceQuality, 'medium');
  assert.equal(merged.surfaceGloss, false);
  assert.deepEqual([...merged.presetKeys], ['surfaceGloss', 'surfacePalette', 'postprocessing']);
  assert.equal(merged.renderQuality, 'fast');
  // `off` short-circuits before any preset is laid under it.
  assert.deepEqual(withRenderQualityPreset(parseRenderBudgetOverrides('off'), {}, 'best'),
    { enabled: false, unknown: [] });
});

test('the level survives for the session and a bad stored value does not', () => {
  const store = new Map();
  const scope = { sessionStorage: {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  } };
  assert.equal(storeRenderQuality('best', scope), true);
  assert.equal(store.get(RENDER_QUALITY_STORAGE_KEY), 'best');
  assert.equal(readStoredRenderQuality(scope), 'best');
  assert.equal(storeRenderQuality('ultra', scope), false);
  store.set(RENDER_QUALITY_STORAGE_KEY, 'ultra');
  assert.equal(readStoredRenderQuality(scope), null);
  // A storage that throws is a private window, not a failure the wearer sees.
  const hostile = { sessionStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } };
  assert.equal(readStoredRenderQuality(hostile), null);
  assert.equal(storeRenderQuality('best', hostile), false);
  assert.equal(activeRenderQuality(hostile), DEFAULT_RENDER_QUALITY);
});

// ===========================================================================
// The pastel palette, the light rig and the XR pass list.
// ===========================================================================

test('non-chain palette themes retain the optional immersive surface treatment', () => {
  const scope = {};
  // The colour theme the tour uses for a surface.
  assert.deepEqual(xrColorParams({ representation: 'molecular-surface', color: 'entity-id', scope }),
    { palette: XR_SURFACE_PALETTE });
  assert.deepEqual(xrColorParams({ representation: 'gaussian_surface', color: 'entity-id', scope }),
    { palette: XR_SURFACE_PALETTE });
  // A cartoon keeps the saturated chain colours: thin ribbons are read against
  // each other, and pastel ones lose the boundary the colour is there to show.
  assert.equal(xrColorParams({ representation: 'cartoon', color: 'entity-id', scope }), null);
  // A theme with no palette must not be handed one.
  for (const color of ['element-symbol', 'residue-name', 'sequence-id', 'uniform']) {
    assert.equal(xrColorParams({ representation: 'molecular-surface', color, scope }), null,
      `${color} has no palette param`);
  }
  // Off a headset, and with the module or the knob off.
  assert.equal(xrColorParams({ representation: 'molecular-surface', color: 'entity-id', presenting: false, scope }), null);
  assert.equal(xrColorParams({ representation: 'molecular-surface', color: 'entity-id',
    scope: { location: { search: '?xrRenderBudget=off' } } }), null);
  assert.equal(xrColorParams({ representation: 'molecular-surface', color: 'entity-id',
    scope: { location: { search: '?xrRenderBudget=palette:off' } } }), null);
});

test('the pastel palette is inside the interval Mol* samples HCL in', () => {
  const { name, params } = XR_SURFACE_PALETTE;
  assert.equal(name, 'generate');
  // Muted chroma is the whole point: saturated chroma is what made the surface
  // read as coloured plastic. But the first box overshot into chalk, so both
  // ends are pinned now. Mol*'s own defaults are chroma [40,70], luminance
  // [15,85] (`mol-util/color/distinct.js:18-19`); this box sits inside them
  // and keeps a luminance interval wide enough for two adjacent chains to
  // separate by value and not by hue alone.
  assert.ok(params.chroma[0] >= 30 && params.chroma[1] <= 70, 'muted, but a Lambert term can still move it');
  assert.ok(params.luminance[0] >= 35 && params.luminance[1] <= 78);
  assert.ok(params.luminance[1] - params.luminance[0] >= 20, 'chains separate by value too');
  assert.ok(params.hue[0] >= 0 && params.hue[1] <= 360);
  // `distinctColors` reads every one of these; a missing key falls back to the
  // Mol* default and silently undoes the palette.
  for (const key of ['hue', 'chroma', 'luminance', 'sort', 'clusteringStepCount', 'minSampleCount', 'sampleCountFactor', 'maxCount']) {
    assert.ok(key in params, `${key} must be stated, not defaulted`);
  }
});

test('the immersive light rig is a key, a front fill and a back rim', () => {
  const toDirection = ({ inclination, azimuth }) => {
    const inc = (inclination * Math.PI) / 180, az = (azimuth * Math.PI) / 180;
    return [Math.cos(az) * Math.sin(inc), Math.sin(az) * Math.sin(inc), Math.cos(inc)];
  };
  const [key, fill, rim] = XR_RENDERER_LIGHTING.light.map(toDirection);
  // `mesh.frag.js:36` shades with `-normalize(vNormal)`, so negative z is a
  // FRONT light and negative y is from above.
  assert.ok(key[2] < 0 && key[1] < 0, 'the key is in front and above');
  assert.ok(fill[2] < 0 && fill[0] < 0, 'the fill is in front and on the other side');
  assert.ok(rim[2] > 0, 'the rim is behind, which is what makes it a rim');
  // The key must dominate, or the rig is a wash rather than a three-point.
  const [k, f, r] = XR_RENDERER_LIGHTING.light.map(one => one.intensity);
  assert.ok(k > f + r, 'the key carries the modelling');
  // The fill exists to put a floor under the unlit side, not to light it. At
  // 0.20 against a 0.72 key it filled in the depressions the key was carving
  // and the body came back as an even disc.
  assert.ok(f < k / 4, 'the fill is a floor, not a second key');
  // The rim is the only silhouette cue with the outline pass off, and on
  // passthrough the background is a wall rather than black, so it has to be
  // legible rather than notional.
  assert.ok(r >= 0.3, 'the rim actually paints a silhouette band');
  // Ambient has to keep the unlit side off black without flooding the pits.
  // Measured on the emulator frame, 0.35 cost 21% of the relative local
  // contrast the saturated rig had.
  assert.ok(XR_RENDERER_LIGHTING.ambientIntensity >= 0.12 && XR_RENDERER_LIGHTING.ambientIntensity <= 0.24);
  // A cool ambient against a warm key is the free stand-in for occlusion.
  const ambient = XR_RENDERER_LIGHTING.ambientColor;
  assert.ok((ambient & 0xff) > ((ambient >> 16) & 0xff), 'the ambient is cool');
});

test('the immersive pass list states every pass rather than inheriting it', () => {
  const on = xrPostprocessingProps(true);
  assert.equal(on.xr.disablePostprocessing, false);
  assert.equal(on.postprocessing.enabled, true);
  assert.equal(on.postprocessing.occlusion.name, 'on');
  assert.equal(on.postprocessing.outline.name, 'on');
  // Mol* defaults `antialiasing: smaa` and `bloom: on`; left alone a Quest 2
  // would pay for SMAA's three passes and a bloom pyramid it has no emissive
  // geometry to justify.
  for (const pass of ['antialiasing', 'bloom', 'shadow', 'dof', 'sharpening']) {
    assert.equal(on.postprocessing[pass].name, 'off', `${pass} must be named off`);
  }
  // Path-traced illumination is never on, at either setting.
  assert.equal(on.illumination.enabled, false);
  const off = xrPostprocessingProps(false);
  assert.equal(off.xr.disablePostprocessing, true);
  assert.equal(off.postprocessing.enabled, false);
  assert.equal(off.illumination.enabled, false);
});

test('the occlusion pass is dialled below the Mol* desktop defaults', () => {
  const ssao = XR_POSTPROCESSING.occlusion.params;
  // Against `mol-canvas3d/passes/ssao.js:23-48`: samples 32, resolutionScale 1,
  // blurKernelSize 15, multiScale off.
  assert.ok(ssao.samples < 32, 'fewer depth taps per pixel than desktop');
  assert.ok(ssao.resolutionScale <= 0.5, 'a quarter of the pixels or fewer');
  assert.ok(ssao.blurKernelSize < 15, 'a shorter separable blur');
  assert.equal(ssao.multiScale.name, 'off', 'multiScale is four times the sampling');
  // The outline must not pull in a second depth prepass of the scene.
  assert.equal(XR_POSTPROCESSING.outline.params.includeTransparent, false);
});

test('roughness can be swept from the address without a rebuild', () => {
  const scope = { location: { search: '?xrRenderBudget=rough:0.2' } };
  assert.equal(xrRepresentationMaterial({ representation: 'molecular-surface', scope }).roughness, 0.2);
  // Out of range is dropped, not raised: a typo on a headset must not stop a demo.
  const bad = { location: { search: '?xrRenderBudget=rough:9' } };
  assert.equal(xrRepresentationMaterial({ representation: 'molecular-surface', scope: bad }).roughness,
    XR_SURFACE_MATERIAL.roughness);
  // `gloss:off` still wins over a roughness: no material at all.
  const offScope = { location: { search: '?xrRenderBudget=gloss:off,rough:0.2' } };
  assert.equal(xrRepresentationMaterial({ representation: 'molecular-surface', scope: offScope }), null);
});
