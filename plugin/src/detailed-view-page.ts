import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { XR_REENTRY_KEY } from './xr-reentry-hint.js';
import { questExitBannerCss, questExitBannerSource } from './quest-exit-banner.js';
import { describePageAddressSource, pageKeySource, settleAddressBarSource } from './inspection-page-key.js';
import { DETAILED_VIEW_RETURN_SOURCE } from './detailed-view-return.js';
import { DETAILED_VIEW_SESSION_SOURCE } from './detailed-view-session.js';
import { PRIVATE_INSPECTION_META_KEY } from './inspection-contract.js';

/**
 * The detailed view is the stock Mol* viewer application, served from
 * loopback with the panel's structure and saved scene already applied.
 *
 * Two routes carry the library and one carries the page. Every path here is a
 * fixed constant resolved against a root this process chose, so no request
 * value ever reaches the filesystem and there is nothing for a traversal to
 * traverse.
 */

export const DETAILED_VIEW_ROUTES = Object.freeze({
  page: '/detailed',
  handoff: '/detailed/handoff.json',
  script: '/detailed/molstar.js',
  style: '/detailed/molstar.css',
});

export type MolstarBundle = { scriptPath: string; stylePath: string; origin: 'dist' | 'node_modules' };

/**
 * Which address for the full viewer is worth
 * handing to whoever asked.
 *
 * `open_detailed_view` answered with the Mac's own loopback address while a
 * headset was paired. Nothing in the headset can reach loopback on the Mac, so
 * an agent asked to move the wearer had an address that could not move anyone
 * and the driver had nothing to open. The LAN share proxies the same three
 * detailed-view routes on the origin the wearer's tab is already on.
 *
 * No fragment on the LAN address, deliberately. The wearer's tab took its page
 * key into storage on `/viewer`, and Quest Browser renders the whole address
 * inside the wearer's view — putting the key back in it would undo
 * inspection-page-key.ts on the one screen it was written for.
 *
 * A share with no paired client is a share nobody is on. That is the Mac
 * operator's own session, and sending them to an HTTPS address with a
 * self-signed certificate instead of loopback would be a worse answer.
 */
export function detailedViewAddress({ loopbackUrl, share }: {
  loopbackUrl: string;
  share?: { host: string; port: number; clients: readonly unknown[] };
}): { url: string; localUrl: string; reachableBy: 'headset' | 'this-mac'; headsetUrl?: string } {
  if (!share || share.clients.length === 0) return { url: loopbackUrl, localUrl: loopbackUrl, reachableBy: 'this-mac' };
  const headsetUrl = `https://${share.host}:${share.port}${DETAILED_VIEW_ROUTES.page}`;
  return { url: headsetUrl, localUrl: loopbackUrl, reachableBy: 'headset', headsetUrl };
}

/**
 * A packaged host has only `dist/`, so the build copies the viewer bundle
 * beside `server.mjs`. Running from the repository there is no build yet, so
 * fall back to the dependency it was copied from. Nothing is fetched.
 */
export async function resolveMolstarBundle(roots: {distRoot: string; packageRoot: string}): Promise<MolstarBundle> {
  const candidates: {scriptPath: string; stylePath: string; origin: MolstarBundle['origin']}[] = [
    {origin: 'dist', scriptPath: resolve(roots.distRoot, 'molstar/molstar.js'), stylePath: resolve(roots.distRoot, 'molstar/molstar.css')},
    {origin: 'node_modules', scriptPath: resolve(roots.packageRoot, 'node_modules/molstar/build/viewer/molstar.js'),
      stylePath: resolve(roots.packageRoot, 'node_modules/molstar/build/viewer/molstar.css')},
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate.scriptPath);
      await access(candidate.stylePath);
      return candidate;
    } catch { continue; }
  }
  throw Error('The full Mol* viewer bundle is not installed beside this server. Reinstall Stereofold, or run pnpm --dir plugin run build.');
}

export async function readMolstarBundle(bundle: MolstarBundle) {
  const [script, style] = await Promise.all([readFile(bundle.scriptPath), readFile(bundle.stylePath)]);
  return {script, style};
}

/**
 * The lesson's colour key, repainted.
 *
 * The key used to arrive here as a sentence. The wearer left the headset
 * looking at an orange guide RNA inside a grey complex, pressed through to the
 * full viewer for a closer look, and met a plain chain-coloured structure with
 * a line of text along the bottom naming what had been lit. The one thing they
 * came over to examine was the one thing they could no longer point at.
 *
 * Mol* has its own answer for a named, coloured region — a component with a
 * uniform colour theme — and it is a better one than the panel's overpaint
 * layers, because the user can then recolour, hide or focus it from the control
 * tree that is already on screen. So each part of the key becomes one component
 * carrying the part's label and the part's colour, and `focus` decides opacity
 * exactly as it does in the headset: the lit parts at full strength, the rest at
 * the lesson's own `contextOpacity`.
 *
 * The matching rule is `partHoldsRow` from `inspection-contract.ts`, residue for
 * residue: a part's chain is matched against BOTH the label and the author
 * chain, because a lesson writes the chain a paper prints and a structure may
 * only know its label chain, and a residue range is matched against author
 * numbering. Two resolvers that disagreed about what a part covers would paint
 * two different molecules.
 *
 * A part that resolves to nothing is not painted and is named in the fallback
 * sentence instead, so the page never silently shows a key it did not draw.
 *
 * The base representation belongs to this file for the same reason. A component
 * draws over the structure rather than instead of it, so the whole-structure
 * base the page used to add left the wearer's faded context solid underneath
 * the key and drew every lit part twice. `paintBase` narrows it to the atoms no
 * part claims and fades it to `contextOpacity`; read its own comment for how
 * that reproduces the transparency layer `lesson-emphasis.mjs` paints.
 *
 * As source, for the same reason the return half is: the page is a generated
 * document rather than a module graph, and `detailed-view-page.test.ts`
 * evaluates this string and drives it with a fake Mol* plugin.
 */
export const DETAILED_VIEW_EMPHASIS_SOURCE = String.raw`(() => {
  // inspection-contract.ts partHoldsRow, residue for residue.
  function holds(part, labelChain, authorChain, authorResidue) {
    if (part.chain !== undefined && part.chain !== authorChain && part.chain !== labelChain) return false;
    if (part.residues && (authorResidue === null || authorResidue === undefined
      || authorResidue < part.residues.from || authorResidue > part.residues.to)) return false;
    return true;
  }
  /**
   * One pass over the loaded structure, gathering unit-local positions per part.
   *
   * One pass rather than one per part: a key may name up to 32 parts and the
   * structure the wearer handed over can be a whole assembly, so the cost has
   * to be the atoms, not the atoms times the key.
   */
  function resolveParts(parts, loaded) {
    var groups = new Map();
    for (var unit of (loaded && loaded.units) || []) {
      if (unit.kind !== 0) continue;
      var hierarchy = unit.model.atomicHierarchy;
      var chains = hierarchy.chains, residues = hierarchy.residues;
      for (var local = 0; local < unit.elements.length; local += 1) {
        var element = unit.elements[local];
        var chain = hierarchy.chainAtomSegments.index[element];
        var residue = hierarchy.residueAtomSegments.index[element];
        var labelChain = chains.label_asym_id.value(chain);
        var authorChain = chains.auth_asym_id ? chains.auth_asym_id.value(chain) : labelChain;
        var authorResidue = residues.auth_seq_id.value(residue);
        for (var part of parts) {
          if (!holds(part, labelChain, authorChain, authorResidue)) continue;
          if (!groups.has(part.id)) groups.set(part.id, []);
          groups.get(part.id).push({unit: unit, local: local});
        }
      }
    }
    return groups;
  }
  /**
   * Everything the key does not claim, in one more pass.
   *
   * Every unit is walked, not only the atomic ones 'resolveParts' can match
   * against: a coarse-grained unit is claimed by no part of any key, so it
   * belongs to the context whole, and skipping it here would drop it out of the
   * picture altogether.
   */
  function restPositions(groups, loaded) {
    var claimed = new Map();
    for (var positions of groups.values()) {
      for (var position of positions) {
        var taken = claimed.get(position.unit.id);
        if (!taken) { taken = new Set(); claimed.set(position.unit.id, taken); }
        taken.add(position.local);
      }
    }
    var rest = [];
    for (var unit of (loaded && loaded.units) || []) {
      var mine = claimed.get(unit.id);
      for (var local = 0; local < unit.elements.length; local += 1) {
        if (mine && mine.has(local)) continue;
        rest.push({unit: unit, local: local});
      }
    }
    return rest;
  }
  /**
   * The key as Mol* components, in the order the lesson wrote it.
   *
   * Later parts win in the headset, where the layers stack, so they are built
   * last here too: a key that lists the PAM after the strand containing it puts
   * the PAM's component on top of the strand's.
   */
  async function paintParts(options) {
    var parts = options.parts || [], focus = options.focus || [], lib = options.structureLib;
    var painted = [], unresolved = [];
    if (!lib || !parts.length) return {painted: painted, unresolved: parts.map(function (part) { return part.label; })};
    // The base has usually resolved these already; one pass over an assembly
    // is the cost this whole file is arranged around paying once.
    var groups = options.groups || resolveParts(parts, options.loaded);
    for (var part of parts) {
      var positions = groups.get(part.id);
      if (!positions || !positions.length) { unresolved.push(part.label); continue; }
      var loci = options.lociFor([positions]);
      // An empty focus is the whole key at full strength; see emphasisSchema.
      var lit = focus.length === 0 || focus.indexOf(part.id) >= 0;
      var component;
      try {
        component = await plugin_tryCreateComponent(options.plugin, options.structure, part, loci, lib);
      } catch (error) { component = undefined; }
      if (!component) { unresolved.push(part.label); continue; }
      await options.plugin.builders.structure.representation.addRepresentation(component, {
        type: options.representation, color: 'uniform',
        colorParams: {value: options.colorNumber(part.color)},
        typeParams: {alpha: lit ? options.opacity : options.contextOpacity},
      });
      painted.push(part.label);
    }
    return {painted: painted, unresolved: unresolved};
  }
  /**
   * The scene's own representation, carrying everything the key does not paint.
   *
   * A component draws OVER the structure rather than instead of it, so a base
   * representation of the whole structure at the scene's opacity leaves the
   * wearer's picture unreproduced twice over: the context the headset had faded
   * is still at full strength, and every lit part is drawn twice — its own
   * component over a solid copy of itself, two identical meshes in one place.
   *
   * The headset does not have that problem and so does not have this code.
   * 'planLessonEmphasis' in lesson-emphasis.mjs has ONE representation of the
   * molecule and fades it with a transparency layer over 'plan.faded', which is
   * every row the focused parts do not claim — the unlit parts of the key and
   * the unnamed remainder alike. There is no such layer to reach for here,
   * because each part of the key is its own object.
   *
   * The equivalent for components is the complement. The base carries the atoms
   * NO part of the key claims, at the lesson's own 'contextOpacity', so every
   * atom is drawn exactly once: a lit part by its own component at the scene's
   * opacity, an unlit part by its own at the ghost, the rest by this one. The
   * label layer is untouched and stays the topmost thing on the structure.
   *
   * A key with no focus is the whole key at full strength and fades nothing —
   * 'planLessonEmphasis' returns an empty 'faded' for exactly that chapter — so
   * the base stays the whole structure at the scene's opacity, as it always was.
   */
  async function paintBase(options) {
    var parts = options.parts || [], focus = options.focus || [], lib = options.structureLib;
    var whole = options.component || options.structure;
    var full = options.params && options.params.typeParams ? options.params.typeParams.alpha : 1;
    function add(target, alpha) {
      var params = Object.assign({}, options.params);
      params.typeParams = Object.assign({}, options.params.typeParams, {alpha: alpha});
      return options.plugin.builders.structure.representation.addRepresentation(target, params);
    }
    // Nothing fades: no key, no focus, or a viewer bundle with no selection
    // library, where paintParts paints nothing at all and this draws it whole.
    if (!lib || !parts.length || !focus.length) {
      await add(whole, full);
      return {alpha: full, groups: null, complement: false};
    }
    var groups, rest;
    try {
      groups = options.groups || resolveParts(parts, options.loaded);
      rest = restPositions(groups, options.loaded);
    } catch (error) {
      await add(whole, full);
      return {alpha: full, groups: null, complement: false};
    }
    // The key claims every atom there is, so there is no context to draw.
    if (!rest.length) return {alpha: options.contextOpacity, groups: groups, complement: true};
    var component;
    try {
      component = await plugin_tryCreateComponent(options.plugin, options.structure,
        {id: 'context', label: 'Rest of structure'}, options.lociFor([rest]), lib);
    } catch (error) { component = undefined; }
    // Last resort, and the only path that still draws a part twice: a viewer
    // that lost its structure is worse than one that draws some of it twice.
    await add(component || whole, options.contextOpacity);
    return {alpha: options.contextOpacity, groups: groups, complement: Boolean(component)};
  }
  // The loci is captured in its own frame: the builder may resolve the
  // selection after the loop variable has moved on to the next part.
  //
  // 'stereofold-generated' is the provenance the return collector reads. A part
  // of the key and the faded complement under it are pictures of state the
  // panel already has, not the user gathering residues into a component, and
  // the collector folds components into the selection on the way home. Without
  // the tag a visit where the wearer touched nothing came back with the lesson's
  // own named parts selected. See 'generated' in detailed-view-return.ts.
  function plugin_tryCreateComponent(plugin, structure, part, loci, lib) {
    return plugin.builders.structure.tryCreateComponentFromSelection(structure, {
      label: part.label, referencesCurrent: false,
      getSelection: async function () {
        return lib.StructureSelection.Singletons(loci.structure, lib.StructureElement.Loci.toStructure(loci));
      },
    }, 'stereofold-emphasis-' + part.id, {label: part.label, tags: ['stereofold-generated']});
  }
  return {holds: holds, resolveParts: resolveParts, restPositions: restPositions,
    paintBase: paintBase, paintParts: paintParts};
})()`;

/**
 * The structure text Mol* is given, with every '<' written as '&lt;'.
 *
 * Mol* renders its hover label, its selection history and its measurement
 * labels as HTML, and it copies the names it reads out of the file into them
 * unescaped: the entity description, the entry id, and chain, residue and atom
 * names. An mmCIF whose `_entity.pdbx_description` was `<img src=x onerror=…>`
 * ran that handler on this page when the structure was hovered. Mol* puts those
 * names only between tags, where '<' is the one character that can start
 * markup, and mmCIF gives '<' no meaning, so a label built from the rewritten
 * text shows the character instead of parsing it. Coordinates and numbers never
 * contain one, and a file without one reaches Mol* unchanged. The cost lands
 * only on a file that has one: where Mol* shows a name as plain text, as the
 * sequence panel does, it reads '&lt;', and a residue whose chain, residue name
 * or insertion code holds one no longer matches the panel's key for it, so its
 * selection does not cross between the two.
 *
 * The page's content security policy refuses inline handlers too. This keeps a
 * hostile file from adding elements at all if that policy ever loosens.
 */
export const DETAILED_VIEW_ESCAPE_SOURCE = String.raw`(text => text.replace(/</g, '&lt;'))`;

const BOOTSTRAP = String.raw`
(async () => {
  const status = document.getElementById('status');
  const say = text => { status.textContent = text; status.hidden = false; };
  // First statement of the page. Quest Browser renders the whole
  // address, fragment and all, in a URL bar that sits inside the wearer's view,
  // so the page key was legible in every device capture anyone shares. Take
  // it into this tab's storage and clear the bar before anything paints; a
  // reload of this tab still works, and so does Back. See inspection-page-key.ts.
  const pageKey = ${pageKeySource(true)};
  // Second statement: ask the URL bar to say /detailed. The wearer's tab
  // reaches this page from /viewer with no fragment, so the rewrite above never
  // runs for them and Quest Browser was left showing the address it last
  // repainted. See settleAddressBar in inspection-page-key.ts.
  //
  // 'settled' is what the rewrite did, NOT what the URL bar says. Measured on
  // the Quest 2 the rewrite ran, the tab had also really
  // navigated here, and the bar still read /viewer. The outcome is published
  // under its own name so no reader takes it for a reading of the bar, and the
  // address this page actually has is published beside it and drawn on the page
  // — this line is the only one in the headset that names the page in front of
  // the wearer.
  document.body.dataset.addressRewrite = ${settleAddressBarSource()};
  document.body.dataset.path = location.pathname;
  const shownAddress = ${describePageAddressSource()};
  document.body.dataset.address = shownAddress;
  const addressLine = document.getElementById('address');
  if (addressLine) { addressLine.textContent = shownAddress; addressLine.hidden = false; }
  // Third statement, and it has to come before anything paints. Quest Browser
  // draws "The immersive web experience is still running in the background."
  // across the top of this tab after the handoff, as chrome composited above
  // the page, and on the Quest 2 it covered this page's whole
  // 88 px top row: the way back, the Apply control, Hold to talk and the
  // address chip were all unreachable without a debugger
  // The page cannot see the banner,
  // so the tab that handed off leaves a note and this reads it. Published as a
  // dataset field as well, so a capture says which way the page laid out.
  // See quest-exit-banner.ts.
  const exitBanner = ${questExitBannerSource()};
  document.body.dataset.xrBanner = exitBanner.covered ? 'on' : 'off';
  // Only the LAN listener serves this page over https, and only it has a
  // /viewer route to return to. On loopback the panel is already on screen.
  const back = document.getElementById('back');
  const bar = document.getElementById('bar');
  // Arming the way back, however the wearer takes it.
  //
  // The hint used to be written only by a click on this link. In Quest Browser
  // the wearer also has the browser's own Back arrow, the controller's B
  // button and the back gesture, and each of those left no hint at all, so the
  // companion never armed its one-tap re-entry and the wearer arrived at a
  // flat page with a small Enter VR button somewhere on it. pagehide fires
  // for every one of them, including a bfcache freeze, so the hint is written
  // there and the click path only records which way it was.
  let leftVia = 'unload';
  const armReentry = () => {
    try { sessionStorage.setItem('${XR_REENTRY_KEY}', JSON.stringify({at: Date.now(), via: leftVia})); }
    catch (error) { /* Storage off is not a reason to block the way back. */ }
  };
  if (back && location.protocol === 'https:') {
    // Same tab, same origin, so where the key is stored this link carries none.
    back.href = '/viewer' + pageKey.fragment;
    back.hidden = false;
    if (bar) bar.hidden = false;
    document.body.dataset.back = 'on';
    // The wearer who taps Back is still in the headset looking
    // at a flat page. A navigation carries no user activation, so this tap
    // cannot itself request a session; it leaves a same-tab hint the companion
    // page consumes to put Enter VR under focus and under the next tap.
    // See xr-reentry-hint.ts, which owns both ends and the expiry.
    back.addEventListener('click', () => { leftVia = 'back-link'; armReentry(); });
    window.addEventListener('pagehide', armReentry);
  }
  const colorNumber = hex => parseInt(String(hex).slice(1), 16);
  try {
    const bearer = pageKey.key;
    if (!/^[a-f0-9]{64}$/.test(bearer)) throw Error('Open the exact address Stereofold printed, including the part after the # sign.');
    const response = await fetch('/detailed/handoff.json', {headers: {Authorization: 'Bearer ' + bearer}});
    if (!response.ok) throw Error('This detailed view has expired. Run open_detailed_view again from the panel.');
    // Only an authorized request pushes the LAN session expiry out, and the
    // panel stopped polling the moment this page replaced it. Re-request the
    // same route the page already loaded, so a wearer who studies the
    // structure past the 30-minute session lifetime still has a live listener
    // behind "Back to headset view". The route is GET-only on both listeners,
    // the body is discarded, and a hidden tab renews nothing.
    const KEEPALIVE_MS = 300000;
    const keepalive = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      fetch('/detailed/handoff.json', {headers: {Authorization: 'Bearer ' + bearer}}).then(renewal => {
        renewal.body && renewal.body.cancel && renewal.body.cancel();
        if (renewal.status === 401 || renewal.status === 410) clearInterval(keepalive);
      }, () => {});
    }, KEEPALIVE_MS);
    // The agent's own way to bring the wearer back.
    //
    // Everything else on this page needs the wearer to find a control. A
    // wearer who cannot find one — the reason this return control exists — has to
    // be reachable from the Mac, and the only channel this document has is the
    // same bearer and the same /tool route the return press uses. The Mac
    // queues one recall with a sentence; this reads it, shows the sentence
    // where the status line already is, arms the re-entry hint and navigates.
    //
    // The recall sentence is read rather than heard, because the page leaves a
    // beat later and would cut its own clip off. Ordinary spoken answers do
    // play here: read the molstarpresence block at the end of this bootstrap.
    const RECALL_POLL_MS = 2000;
    let recalling = false;
    /**
     * This same answer carries the host's revisions.
     *
     * poll_detailed_view answers with the ordinary inspection state, which is
     * the epoch, the source token and both revisions. That is exactly what
     * attaching as a panel needs, so the page registers off a poll it was
     * already making rather than asking for the whole catalog a second time.
     * Reading it here, in the one place the recall is consumed, is also what
     * keeps a second reader from taking a recall and dropping it.
     */
    let hostBinding;
    const readDetailedPoll = body => {
      const state = body && body.structuredContent;
      if (state && state.serverEpoch) {
        hostBinding = {serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
          baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision};
      }
      const recall = state && state.detailedRecall;
      if (!recall || recall.recall !== true || recalling) return hostBinding;
      recalling = true;
      clearInterval(recallPoll);
      document.body.dataset.recall = 'returning';
      say(recall.text || 'Coming back to the headset.');
      leftVia = 'recall';
      armReentry();
      // A beat to read the sentence, then the same navigation the Back
      // control performs. A page with no LAN route back, the Mac's own
      // loopback copy, shows the sentence and stays where it is.
      const target = back && !back.hidden ? back.href : '';
      if (target) setTimeout(() => { location.assign(target); }, 1200);
      else document.body.dataset.recall = 'here';
      return hostBinding;
    };
    const recallPoll = setInterval(() => {
      if (recalling || document.visibilityState === 'hidden') return;
      fetch('/tool', {method: 'POST', cache: 'no-store', credentials: 'omit',
        headers: {Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'poll_detailed_view', args: {}})})
        .then(answer => answer.ok ? answer.json() : null)
        .then(readDetailedPoll, () => {});
    }, RECALL_POLL_MS);
    window.addEventListener('pagehide', () => { clearInterval(recallPoll); clearInterval(keepalive); });
    const handoff = await response.json();
    /**
     * This page's own copy of the saved scene.
     *
     * It starts as the scene the handoff carried, which is the saved one, and
     * moves only two ways: this page renders a command and reports the result,
     * or the host tells it about a change some other panel already committed.
     * Everything this page draws is drawn from it, so what the wearer sees and
     * what the Mac has saved are one picture rather than two that drift.
     */
    let scene = handoff.scene;
    document.title = 'Mol* detail - ' + (handoff.pdbId ? handoff.pdbId.toUpperCase() : 'Stereofold structure');
    say('Building the detailed view.');
    const viewer = await molstar.Viewer.create('app', {
      layoutShowControls: true, viewportShowExpand: false, viewportShowSelectionMode: true,
      powerPreference: 'high-performance',
      // The structure was not only badly framed in the headset,
      // it had nowhere to be. Two open control panels left the 3D viewport a
      // third of a Quest Browser window wide, which is most of what "the
      // structure is tiny in the 2D window" was. The left panel is the one
      // this page has no use for — it downloads structures, and this page
      // arrives with its own — so it starts collapsed and one click reopens
      // it. The right panel stays open: Quick Styles is there, which is how
      // the wearer asks for the surface this page does not build for them.
      collapseLeftPanel: true,
      // Remote States fetches a session list from webchem.ncbr.muni.cz on
      // load. A wearer on a LAN address has no business making that request
      // and no use for the panel.
      layoutShowRemoteState: false,
      // Nothing on this page asks for density, and the wearer is on a LAN
      // address with no route to a volume server. Off, the viewer neither
      // offers it nor reaches for it. (apps/viewer/options.js:53-54.)
      volumeStreamingDisabled: true,
    });
    const plugin = viewer.plugin;
    // Read DETAILED_VIEW_ESCAPE_SOURCE for why Mol* never sees a '<' from the file.
    const escapeMarkup = ${DETAILED_VIEW_ESCAPE_SOURCE};
    const data = await plugin.builders.data.rawData({data: escapeMarkup(handoff.structureText), label: handoff.pdbId || 'Stereofold structure'});
    const trajectory = await plugin.builders.structure.parseTrajectory(data, 'mmcif');
    let model;
    const frames = trajectory.obj.data.frameCount;
    for (let index = 0; index < frames; index += 1) {
      const candidate = await plugin.builders.structure.createModel(trajectory, {modelIndex: index});
      if (candidate.obj.data.modelNum === scene.modelNumber) { model = candidate; break; }
      await plugin.build().delete(candidate.ref).commit();
    }
    if (!model) throw Error('These coordinates no longer contain the inspected model.');
    const structure = await plugin.builders.structure.createStructure(model, scene.assemblyId === 'asymmetric_unit'
      ? {name: 'model', params: {}}
      : {name: 'assembly', params: {id: scene.assemblyId}});
    const component = await plugin.builders.structure.tryCreateComponentStatic(structure, 'all');
    const loaded = structure.obj.data;
    // Mol*'s own StructureElement.Loci record; typed sorted indices are a
    // supported OrderedSet, which is what the panel's selection adapter builds.
    const lociFor = groups => {
      const grouped = new Map();
      for (const positions of groups) for (const position of positions) {
        (grouped.get(position.unit.id) || grouped.set(position.unit.id, new Set()).get(position.unit.id)).add(position.local);
      }
      return {kind: 'element-loci', structure: loaded, elements: loaded.units.filter(unit => grouped.has(unit.id))
        .map(unit => ({unit, indices: Int32Array.from([...grouped.get(unit.id)].sort((a, b) => a - b))}))};
    };
    const structureLib = typeof molstar === 'object' && molstar.lib ? molstar.lib.structure : null;
    // The lesson's colour key, rebuilt rather than
    // recited. Read DETAILED_VIEW_EMPHASIS_SOURCE above for why it is Mol*'s own
    // components and how a part's residues are matched. The helpers are declared
    // here because the base representation below is the first thing that needs
    // them: what the key paints decides what the base is left holding.
    const emphasisHelpers = ${DETAILED_VIEW_EMPHASIS_SOURCE};
    // The page's half of being a panel. Read
    // detailed-view-session.ts for what a detailed surface is and why.
    const session = ${DETAILED_VIEW_SESSION_SOURCE};
    // The saved scene carries whatever the headset was last
    // showing, and an autoplaying demo chapter leaves a filled representation
    // there (demos/crispr-cas9.json, chapter "highlight" is molecular-surface,
    // "site" is spacefill). Rebuilding that here gives
    // seconds of nothing, Mol*'s own log reading "Created
    // Molecular Surface in 3.245s", then an ugly volume fill for an opaque
    // blob of a four-chain complex. A detail view is opened to look into a
    // structure, so it opens on the cartoon the wearer was inspecting before
    // the tour filled it in. The full control tree is right there and builds a
    // surface in one click for anyone who wants one.
    const FILLED = {'molecular-surface': 'cartoon', 'spacefill': 'cartoon'};
    // The handoff carries what the wearer picked as canonical residue keys, so
    // the Mac viewer can open on the same highlight instead of a bare structure.
    // A key is ['residue-v1', sourceHash, modelNumber, copyId, entityId,
    // labelChain, authorChain, labelSequenceId, authorResidue, insertionCode,
    // componentId] and copyId is ['copy', assemblyId, generatorIndex,
    // operatorIds]. Mol*'s own atomic hierarchy carries every field the panel
    // read out of the same mmCIF, so the page rebuilds the loci from the
    // structure it just loaded rather than trusting a shipped catalog. The
    // label sequence position identifies a polymer residue and the author
    // number identifies everything else, exactly as the panel derives them.
    //
    // Built once, on the first scene that has a selection in it, because the
    // walk is every atom of an assembly and most scenes never need it.
    const unitCopy = unit => {
      const assembly = unit.conformation.operator.assembly;
      return JSON.stringify(assembly ? [assembly.id, Array.from(assembly.operList)] : ['asymmetric_unit', []]);
    };
    let residueIndex;
    const residueLookup = () => {
      if (residueIndex) return residueIndex;
      residueIndex = new Map();
      for (const unit of loaded.units) {
        if (unit.kind !== 0) continue;
        const copy = unitCopy(unit), hierarchy = unit.model.atomicHierarchy;
        for (let local = 0; local < unit.elements.length; local += 1) {
          const element = unit.elements[local];
          const chain = hierarchy.chainAtomSegments.index[element], residue = hierarchy.residueAtomSegments.index[element];
          const shared = [copy, hierarchy.chains.label_asym_id.value(chain),
            hierarchy.atoms.label_comp_id.value(element), hierarchy.residues.pdbx_PDB_ins_code.value(residue)];
          for (const tag of [['label', hierarchy.residues.label_seq_id.value(residue)],
            ['auth', hierarchy.residues.auth_seq_id.value(residue)]]) {
            const lookup = JSON.stringify([...shared, tag]);
            (residueIndex.get(lookup) || residueIndex.set(lookup, []).get(lookup)).push({unit, local});
          }
        }
      }
      return residueIndex;
    };
    const resolveKeys = keys => {
      const matched = [];
      if (!keys.length) return matched;
      const index = residueLookup();
      for (const key of keys) {
        let parsed, copyId;
        try { parsed = JSON.parse(key); copyId = JSON.parse(parsed[3]); } catch { continue; }
        if (parsed[0] !== 'residue-v1' || !Array.isArray(copyId) || copyId[0] !== 'copy') continue;
        const tag = parsed[7] === null || parsed[7] === undefined ? ['auth', parsed[8]] : ['label', parsed[7]];
        if (tag[1] === null || tag[1] === undefined) continue;
        const positions = index.get(JSON.stringify([JSON.stringify([copyId[1], copyId[3]]),
          parsed[5], parsed[10], parsed[9], tag]));
        if (positions) matched.push(positions);
      }
      return matched;
    };
    /**
     * The saved picture, drawn here, any number of times.
     *
     * This used to run once, straight down the bootstrap. It is a function now
     * because an agent can change the scene while the wearer is standing in the
     * full viewer, and a change nobody draws is a receipt that lies. Everything
     * it creates is recorded and removed at the start of the next pass, so a
     * repaint replaces this page's own picture and leaves alone every component
     * and representation the person built by hand.
     */
    const paintedRefs = [];
    let framed = false;
    const paintScene = async next => {
      const look = next.inspection.appearance;
      const emphasis = next.inspection.emphasis;
      const representation = FILLED[look.representation] || look.representation;
      await session.clearPainted(plugin, paintedRefs);
      const painter = session.recordingPlugin(plugin, paintedRefs);
      document.body.dataset.representation = representation;
      document.body.dataset.sceneRepresentation = look.representation;
      const baseParams = {
        type: representation,
        color: look.color,
        typeParams: {alpha: look.opacity},
        colorParams: look.color === 'uniform' ? {value: colorNumber(look.uniformColor)} : undefined,
      };
      // The base carries what the colour key does not.
      //
      // The key below rebuilds each of its parts as its own component, drawn OVER
      // this one, so a base of the whole structure at the scene's opacity left the
      // faded context of the wearer's picture at full strength and drew every lit
      // part twice. paintBase narrows it to the complement, and fades it to the
      // lesson's own contextOpacity; read its own comment for how. With no focus,
      // which fades nothing in the headset either, this is the whole structure at
      // look.opacity exactly as it was.
      const drawnBase = await emphasisHelpers.paintBase({
        plugin: painter, structure, component, loaded, lociFor, structureLib, params: baseParams,
        parts: emphasis ? emphasis.parts : [], focus: emphasis ? emphasis.focus : [],
        contextOpacity: emphasis ? emphasis.contextOpacity : look.opacity,
      });
      // Readable from a harness and from a device capture's page state, so a base
      // still drawing over the wearer's faded context is never silent.
      document.body.dataset.baseOpacity = String(drawnBase.alpha);
      document.body.dataset.baseCoverage = drawnBase.complement ? 'context' : 'structure';
      plugin.canvas3d.setProps({renderer: {backgroundColor: colorNumber(look.background)}});
      const matched = resolveKeys(next.selectionKeys);
      if (matched.length) {
        plugin.managers.interactivity.lociSelects.selectOnly({loci: lociFor(matched)}, false);
        // The panel draws a residue label layer over the first 32 picks whenever
        // its labels switch is on, so mirror that cap and its highlight color.
        if (look.labels && structureLib) {
          const capped = lociFor(matched.slice(0, 32));
          const label = 'Selected residues (' + Math.min(matched.length, 32)
            + (matched.length > 32 ? ' of ' + matched.length : '') + ')';
          const labelComponent = await painter.builders.structure.tryCreateComponentFromSelection(structure, {
            label, referencesCurrent: true,
            getSelection: async () => structureLib.StructureSelection.Singletons(capped.structure,
              structureLib.StructureElement.Loci.toStructure(capped)),
          }, 'stereofold-selected-labels', {label, tags: ['stereofold-generated']});
          if (labelComponent) await painter.builders.structure.representation.addRepresentation(labelComponent, {
            type: 'label', color: 'uniform', colorParams: {value: colorNumber(look.highlightColor)},
            typeParams: {level: 'residue', sizeFactor: 1.5, offsetZ: 4, background: true, backgroundOpacity: 0.85,
              backgroundMargin: 0.25, backgroundColor: 0x0c1418, borderWidth: 0.12, borderColor: 0x0c1418},
          });
        }
      } else if (framed) {
        // Only on a repaint. Clearing at load would undo nothing and would fire
        // a selection report before this page has anything to report.
        try { plugin.managers.interactivity.lociSelects.deselectAll(); } catch (error) { /* Nothing was selected. */ }
      }
      document.body.dataset.selectedResidues = String(matched.length);
      document.body.dataset.selectionKeys = String(next.selectionKeys.length);
      // The key is painted after the selection so the label layer the panel
      // mirrors stays the topmost thing on the structure, and the sentence along
      // the bottom is now the fallback: it names only what could not be resolved
      // here. The base below it was already narrowed and faded to match.
      const note = document.querySelector('[data-handoff-note]');
      if (emphasis && emphasis.parts.length) {
        const labelOf = id => (emphasis.parts.find(part => part.id === id) || {}).label || id;
        const lit = emphasis.focus.map(labelOf);
        document.body.dataset.emphasisParts = emphasis.parts.map(part => part.label).join(', ');
        document.body.dataset.emphasisFocus = lit.join(', ');
        let rebuilt = {painted: [], unresolved: emphasis.parts.map(part => part.label)};
        try {
          rebuilt = await emphasisHelpers.paintParts({
            plugin: painter, structure, loaded, lociFor, structureLib, colorNumber,
            parts: emphasis.parts, focus: emphasis.focus, representation, groups: drawnBase.groups,
            opacity: look.opacity, contextOpacity: emphasis.contextOpacity,
          });
        } catch (error) { /* A key that will not paint still leaves the wearer the sentence. */ }
        document.body.dataset.emphasisRepainted = rebuilt.painted.join(', ');
        if (note) {
          note.hidden = false;
          note.textContent = rebuilt.painted.length
            ? (lit.length ? 'The headset was showing ' + lit.join(' and ') + ' highlighted in the lesson colour key. '
              : 'The headset was showing this lesson’s colour key. ')
              + 'It is rebuilt here as components, ' + rebuilt.painted.join(', ')
              + ', so you can recolour, hide or focus each part from the controls.'
              + (rebuilt.unresolved.length ? ' Not found in these coordinates: ' + rebuilt.unresolved.join(', ') + '.' : '')
            : lit.length
              ? 'The headset was showing ' + lit.join(' and ') + ' highlighted in the lesson colour key. '
                + 'None of its parts could be rebuilt in these coordinates, so it is not repainted here.'
              : 'The headset was showing this lesson’s colour key. It could not be rebuilt in these coordinates.';
        }
      } else {
        document.body.dataset.emphasisParts = '';
        document.body.dataset.emphasisFocus = '';
        document.body.dataset.emphasisRepainted = '';
        if (note) { note.hidden = true; note.textContent = ''; }
      }
      if (framed) {
        // A repaint must not move the camera. Somebody is working in here.
        plugin.canvas3d.commit(true);
        plugin.canvas3d.requestDraw();
        return;
      }
      // The panel's camera snapshot used to travel with the handoff
      // and then be held for ninety frames against Mol*'s own reset. From the
      // headset that snapshot frames a structure seated in the wearer's room, and
      // transplanted into a Quest Browser window it left the structure a speck.
      // The detail view fits what it has just loaded instead. A reset with no
      // snapshot resolves to camera.getFocus of the visible bounding sphere
      // (canvas3d.js:681-701), which is that fit, and it is requested after every
      // representation so nothing queued behind it can undo it.
      // A queued reset resolves only when a full scene commit finishes
      // (canvas3d.js:666-680), so the commit is forced here rather than waited for.
      plugin.canvas3d.commit(true);
      plugin.canvas3d.requestCameraReset({durationMs: 0});
      plugin.canvas3d.commit(true);
      plugin.canvas3d.requestDraw();
      for (let frame = 0; frame < 3; frame += 1) await new Promise(next => requestAnimationFrame(next));
      framed = true;
      document.body.dataset.cameraFit = 'structure';
    };
    await paintScene(scene);
    // The stock Mol* app publishes its viewer the same way, and both a person
    // debugging in the console and the browser harness need the created
    // viewer. Nothing here is a capability: the page is loopback and
    // same-origin, and the handoff bearer never leaves the fragment.
    window.stereofoldDetailedView = viewer;
    status.hidden = true;
    document.body.dataset.detailed = 'ready';
    // The one press that ends this visit.
    //
    // Everything this page can send home goes in one gesture: the appearance
    // and camera out of its own state snapshot, and the residues selected or
    // gathered into components, which no saved file can describe. The host is
    // one fetch away on the origin that served this page, and the key in
    // the bearer here is the same capability the companion holds, so nothing has to
    // be downloaded, found on disk, or read out to an agent.
    //
    // A panel renders one change at a time, so the press is a short loop: the
    // host answers with what is left and this asks again until nothing is.
    const helpers = ${DETAILED_VIEW_RETURN_SOURCE};
    const returnButton = document.getElementById('return');
    const returnNote = document.getElementById('return-note');
    const returnPath = document.getElementById('return-path');
    const post = async payload => {
      const answer = await fetch('/tool', {method: 'POST', cache: 'no-store', credentials: 'omit',
        headers: {Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'return_detailed_view', args: payload})});
      if (!answer.ok) throw Error('The Mac did not accept the return (' + answer.status + ').');
      const body = await answer.json();
      const detail = body && body.structuredContent && body.structuredContent.detailedReturn;
      if (!detail) throw Error('The Mac answered without a return receipt.');
      return detail;
    };
    // The fallback is one click too: the same state as a file, with the path it
    // lands on already written out, and the reason it came to this.
    const downloadInstead = async why => {
      const blob = await plugin.managers.snapshot.serialize({type: 'molj'});
      const name = 'stereofold-detailed-' + handoff.snapshotId + '.molj';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      returnPath.textContent = '~/Downloads/' + name;
      returnPath.hidden = false;
      document.body.dataset.returned = 'downloaded';
      say(why + ' Saved the state as a file instead — give this path to Stereofold and it will import what the panel can render.');
    };
    if (returnButton) {
      returnButton.hidden = false;
      // On the Mac's own loopback copy there is no Back link, so the row is
      // still hidden at this point and this is what raises it.
      if (bar) bar.hidden = false;
      returnButton.addEventListener('click', async () => {
        if (returnButton.disabled) return;
        returnButton.disabled = true;
        document.body.dataset.returned = 'working';
        try {
          const pruned = helpers.pruneSnapshot(await plugin.managers.snapshot.getStateSnapshot());
          const gathered = helpers.collect(plugin, loaded);
          const payload = {snapshot: pruned.snapshot, prunedStrings: pruned.prunedStrings,
            residues: gathered.residues, truncated: gathered.truncated,
            ...(gathered.componentLabels.length ? {componentLabels: gathered.componentLabels} : {})};
          const outcome = await helpers.applyReturn({payload: payload, post: post, say: say,
            wait: ms => new Promise(next => setTimeout(next, ms)),
            onApplied: applied => { document.body.dataset.returnedApplied = applied.join(','); }});
          const applied = outcome.applied, stayed = outcome.stayed;
          // The bound running out is not the return finishing.
          // Anything still queued stays queued, so saying "applied" here and
          // going Back would leave the wearer looking at a panel that never got
          // their selection or their camera. The file is the honest answer.
          if (outcome.remaining.length) {
            throw outcome.error || Error('The panel is still applying ' + outcome.remaining.join(', ') + '.');
          }
          document.body.dataset.returned = 'applied';
          returnNote.textContent = applied.length ? 'Applied: ' + applied.join(', ') + '.' : 'Nothing changed here.';
          say((applied.length ? 'Sent ' + applied.join(', ') + ' back to Stereofold.' : 'Stereofold already matches this view.')
            + (stayed.length ? ' Stayed in Mol*: ' + stayed.join(' ') : ''));
          // Over Wi-Fi this page is the wearer's whole screen, so returning
          // means going back; the Back link owns the re-entry hint, so use it.
          if (back && !back.hidden) { back.click(); return; }
        } catch (error) {
          try { await downloadInstead('Stereofold could not be reached: ' + (error && error.message ? error.message : 'the return failed') + '.'); }
          catch (fallbackError) {
            document.body.dataset.returned = 'failed';
            say('The return failed and no file could be saved: ' + (fallbackError && fallbackError.message ? fallbackError.message : 'unknown error'));
          }
        } finally { returnButton.disabled = false; }
      });
    }
    /**
     * The assistant, present while the full viewer is.
     *
     * Everything below is the page joining the session it came from instead of
     * leaving it. It attaches as a panel with surface 'detailed', beats once a
     * second like every other panel, draws the changes an agent sends, plays
     * the answers an agent speaks, sends what the person picks in Mol* back to
     * the Mac so a question has a referent, and holds the microphone for them.
     *
     * None of it is a new channel. The bearer is the page key this document
     * already holds, the route is the same private /tool route the Return press
     * uses, and every tool it calls was already on both listeners' allowlists
     * except the one that reports a selection.
     *
     * All of it is optional. A page that cannot register keeps the picture, the
     * Back control and the Return press exactly as they were.
     */
    const call = async (name, args) => {
      const answer = await fetch('/tool', {method: 'POST', cache: 'no-store', credentials: 'omit',
        headers: {Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json'},
        body: JSON.stringify({name: name, args: args})});
      if (!answer.ok) throw Error('The Mac refused ' + name + ' (' + answer.status + ').');
      const body = await answer.json();
      return {structuredContent: body && body.structuredContent,
        private: body && body._meta ? body._meta['${PRIVATE_INSPECTION_META_KEY}'] : undefined};
    };
    const captionLine = document.getElementById('caption');
    let captionTimer, replyAudio, captionRun = 0, finishSegment;
    const drawCaption = (line, holdSeconds) => {
      if (!captionLine) return;
      captionLine.textContent = line;
      captionLine.hidden = false;
      document.body.dataset.caption = line;
      clearTimeout(captionTimer);
      captionTimer = setTimeout(() => { captionLine.hidden = true; }, Math.max(2, holdSeconds || 6) * 1000);
    };
    /**
     * Play one segment's clip and answer when it has finished sounding.
     *
     * Quest Browser reports no speechSynthesis voice, so the Mac renders the
     * sentence and sends the clip inline with the caption. Nothing is fetched:
     * the clip is already here. The answer is false when there was nothing to
     * play or the browser refused it, and a guard settles a clip whose end the
     * browser never reports, so one bad segment cannot hold the rest.
     */
    const playSegment = url => new Promise(resolve => {
      if (!url) { resolve(false); return; }
      let guard, settled = false;
      const done = value => {
        if (settled) return;
        settled = true;
        if (finishSegment === stop) finishSegment = undefined;
        clearTimeout(guard);
        resolve(value);
      };
      const stop = () => { try { replyAudio && replyAudio.pause(); } catch (error) { /* Already stopped. */ } done(false); };
      finishSegment = stop;
      try {
        replyAudio = replyAudio || new Audio();
        replyAudio.onended = () => done(true);
        replyAudio.onerror = () => done(false);
        replyAudio.src = url;
        guard = setTimeout(() => done(true), 30000);
        const playing = replyAudio.play();
        if (playing && playing.then) playing.then(
          () => { document.body.dataset.captionAudio = 'playing'; },
          () => { document.body.dataset.captionAudio = 'blocked'; done(false); });
        else document.body.dataset.captionAudio = 'playing';
      } catch (error) { document.body.dataset.captionAudio = 'unavailable'; done(false); }
    });
    /**
     * Draw one reply, a segment at a time, in order and never overlapping.
     *
     * A newer reply takes the line: the older answer's remaining segments are
     * dropped rather than queued behind it, which is the same rule the
     * immersive page follows.
     */
    const showCaption = async entry => {
      if (!entry || !captionLine) return;
      const segments = session.captionSegments(entry);
      if (!segments.length) return;
      const run = ++captionRun;
      if (finishSegment) { try { finishSegment(); } catch (error) { /* The waiter is gone. */ } }
      const hold = Math.max(2, entry.holdSeconds || 6);
      for (let index = 0; index < segments.length; index++) {
        if (run !== captionRun) return;
        drawCaption(segments[index].text, hold);
        if (entry.speak === false) return;
        const played = await playSegment(segments[index].url);
        if (run !== captionRun) return;
        if (!played && index < segments.length - 1) {
          const seconds = Math.min(20, segments[index].seconds || 4);
          await new Promise(resolve => setTimeout(resolve, seconds * 1000));
          if (run !== captionRun) return;
        }
      }
    };
    let panelId, binding, rendering = false, beating = false, attaching = false, beatTimer;
    const detachNow = () => {
      if (!panelId || !binding) return;
      try {
        fetch('/tool', {method: 'POST', cache: 'no-store', credentials: 'omit', keepalive: true,
          headers: {Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json'},
          body: JSON.stringify({name: 'detach_inspection', args: Object.assign({panelId: panelId}, binding)})});
      } catch (error) { /* A page already unloading cannot be helped. */ }
      panelId = undefined;
    };
    /**
     * Register this page as a panel, on the revisions the host has right now.
     *
     * The freshest reading wins: this page's own, refreshed off every
     * heartbeat, then the detailed poll's, then one poll of its own. Attaching
     * on a revision the host has moved past is refused, which is why a beat
     * that finds the panel gone calls this again rather than going quiet.
     */
    const attach = async () => {
      if (attaching) return undefined;
      attaching = true;
      try {
        binding = binding || hostBinding || await (async () => {
          const answer = await fetch('/tool', {method: 'POST', cache: 'no-store', credentials: 'omit',
            headers: {Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json'},
            body: JSON.stringify({name: 'poll_detailed_view', args: {}})});
          if (!answer.ok) throw Error('The Mac refused this page (' + answer.status + ').');
          return readDetailedPoll(await answer.json());
        })();
        if (!binding) throw Error('The Mac did not report a current inspection.');
        const attached = await call('attach_inspection', Object.assign({surface: 'detailed'}, binding));
        panelId = attached.structuredContent && attached.structuredContent.panelId;
        if (!panelId) throw Error('The Mac issued no panel for this page.');
        // A fresh panel has seen nothing yet, so the wearer's current pick is
        // sent again rather than held back as already reported.
        selectionReporter.reset();
        document.body.dataset.panel = 'detailed';
        return panelId;
      } finally { attaching = false; }
    };
    /**
     * What the person has picked in Mol*, sent whenever it changes.
     *
     * When somebody clicks a residue here and asks what it is, the Mac
     * can answer because it knows the selection. The
     * descriptors are the Return press's own, so a pick that is asked about and
     * a pick that is carried home are one thing.
     */
    const SELECTION_REPORT_CAP = 1000;
    const selectionStatus = document.getElementById('selection-status');
    const selectionReporter = session.createSelectionReporter({
      panel: () => panelId,
      collect: () => helpers.collectSelection(plugin, loaded, SELECTION_REPORT_CAP),
      post: call,
      warn: message => console.warn(message),
      status: message => { selectionStatus.textContent = message; selectionStatus.hidden = false; },
      sent: count => { document.body.dataset.reportedResidues = String(count); },
    });
    const reportSelection = () => selectionReporter.report();
    let selectionTimer;
    const noteSelectionChange = () => {
      clearTimeout(selectionTimer);
      // Mol* fires this for a highlight too, and a controller ray sweeping a
      // structure is a lot of highlights. One report per settled pick.
      selectionTimer = setTimeout(() => { reportSelection(); }, 400);
    };
    const beat = async () => {
      if (!panelId || beating || recalling) return;
      beating = true;
      const sent = binding;
      try {
        const answer = await call('poll_inspection', Object.assign({panelId: panelId,
          availability: rendering ? 'busy' : 'ready', diagnostics: selectionReporter.diagnostics()}, sent));
        if (answer.structuredContent) selectionReporter.acknowledge(answer.structuredContent.diagnosticsAck);
        const read = session.readBeat(answer, scene);
        if (read.binding) binding = read.binding;
        if (!read.attached) {
          panelId = undefined;
          document.body.dataset.panel = 'gone';
          return;
        }
        if (read.caption) showCaption(read.caption);
        // The host offers the saved scene when this page is behind a change
        // some other panel has already committed. Take it, so the next command
        // is drawn over what the Mac actually has rather than over a stale copy.
        if (read.follow) scene = read.follow;
        if (!read.delivery || rendering) return;
        const delivery = read.delivery;
        const receipt = Object.assign({panelId: panelId, commandId: delivery.commandId,
          claimToken: delivery.claimToken}, sent);
        if (!read.draws) {
          // Honest refusal beats a bad drawing. The wearer is told in one line
          // where the change can happen, and the agent gets a rejected receipt
          // with the same sentence on it.
          await call('complete_inspection', Object.assign({failure: 'render_failed',
            failureReason: read.refusal}, receipt)).catch(() => {});
          showCaption({text: read.refusal + ' Press Return to send it there.', holdSeconds: 6, speak: false});
          return;
        }
        rendering = true;
        document.body.dataset.rendering = delivery.change.kind;
        const next = session.nextScene(scene, delivery.change);
        try { await paintScene(next); }
        catch (error) {
          await call('complete_inspection', Object.assign({failure: 'render_failed',
            failureReason: 'The full viewer could not draw it.'}, receipt)).catch(() => {});
          return;
        }
        const done = await call('complete_inspection', Object.assign({scene: next}, receipt));
        const state = done.structuredContent || {};
        if (state.command && state.command.status === 'rendered') {
          scene = next;
          document.body.dataset.rendered = delivery.change.kind;
        }
        if (state.serverEpoch) {
          binding = {serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
            baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision};
        }
      } catch (error) { /* A missed beat is a missed beat. The next one carries the same work. */ }
      finally { rendering = false; beating = false; document.body.dataset.rendering = ''; }
    };
    // Hold to talk, on the page that had no microphone at all. The same route
    // the headset menu uses, so the Mac transcribes it locally and the agent
    // hears it through listen_voice without knowing which page it came from.
    const talkButton = document.getElementById('talk');
    const talk = session.createTalk({
      post: (name, args) => call(name, name === 'push_to_talk_audio' ? Object.assign({panelId: panelId}, args) : args),
      uuid: () => (globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : ''),
      toBase64: blob => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(Error('The recording could not be read.'));
        reader.onload = () => { const text = String(reader.result || ''); resolve(text.slice(text.indexOf(',') + 1)); };
        reader.readAsDataURL(blob);
      }),
      Recorder: window.MediaRecorder,
      getMedia: () => navigator.mediaDevices.getUserMedia({audio: true}),
      mimeTypes: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'],
      say: text => showCaption({text: text, holdSeconds: 4, speak: false}),
      // "Say return when done", kept by the page.
      //
      // The handoff line promises one word and this is where it is honoured.
      // The Mac's transcript comes back on the closing chunk, so a held press
      // that said nothing else runs the Return control the wearer would
      // otherwise have to find with a controller ray. Everything that is not a
      // going-home phrase is left to the assistant exactly as before.
      onTranscript: text => {
        if (!session.isReturnRequest(text)) return;
        showCaption({text: 'Going back to the headset.', holdSeconds: 4, speak: false});
        if (returnButton && !returnButton.hidden && !returnButton.disabled) { returnButton.click(); return; }
        // No Return press means nothing to carry home, but the way back is
        // still the way back.
        if (back && !back.hidden) back.click();
      },
    });
    if (talkButton) {
      talkButton.addEventListener('pointerdown', event => {
        event.preventDefault();
        talkButton.dataset.state = 'listening';
        talk.start();
      });
      const release = () => {
        // stop() latches a release that beats microphone permission and closes
        // the recorder as soon as its stream arrives.
        if (!talk.stop()) return;
        talkButton.dataset.state = 'sent';
      };
      for (const name of ['pointerup', 'pointercancel', 'pointerleave']) talkButton.addEventListener(name, release);
    }
    window.addEventListener('pagehide', () => { clearInterval(beatTimer); detachNow(); });
    try {
      await attach();
      const events = plugin.managers && plugin.managers.structure && plugin.managers.structure.selection
        && plugin.managers.structure.selection.events;
      const changed = events && events.changed;
      if (changed && typeof changed.subscribe === 'function') changed.subscribe(noteSelectionChange);
      else setInterval(() => { reportSelection(); }, 3000);
      await reportSelection();
      // One timer, two jobs: beat while this page holds a panel, and get one
      // back when the host has dropped it. A page that went quiet after a
      // dropped panel would be a wearer nobody could reach again.
      beatTimer = setInterval(() => { if (panelId) beat(); else attach().catch(() => {}); }, 1000);
      if (talkButton) talkButton.hidden = false;
      if (bar) bar.hidden = false;
      // The headset said "Say return when done" on the
      // way out. Written down once here, where it is still true, because the
      // microphone only exists on a page that joined the session.
      if (talkButton && returnNote && !returnNote.textContent) {
        returnNote.textContent = 'Hold to talk and say “return”, or press Return, to go back to the headset.';
      }
    } catch (error) {
      // A page that cannot join the session is still the full Mol* viewer with
      // a way home. Nothing above this line depends on any of it.
      document.body.dataset.panel = 'none';
    }
  } catch (error) {
    say(error && error.message ? error.message : 'The detailed view could not open.');
    document.body.dataset.detailed = 'error';
  }
})();
`;

/**
 * The page's one inline script, as a Content-Security-Policy hash source.
 *
 * The page is built from constants, so the bootstrap has one digest for the life
 * of the process, and the policy admits that script by it. `'unsafe-inline'`
 * would also run any inline event handler that reached the markup, and Mol*
 * writes text from the structure file into this page as HTML.
 */
export const DETAILED_VIEW_SCRIPT_HASH = `'sha256-${createHash('sha256').update(BOOTSTRAP, 'utf8').digest('base64')}'`;

export function detailedViewHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>Mol* detail</title>`
    + `<link rel="stylesheet" href="${DETAILED_VIEW_ROUTES.style}">`
    + `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#111b23}`
    + `#app{position:absolute;inset:0}`
    // The way out is the first thing on the page, not a
    // 110x34 px link tucked into the top-right corner where Quest Browser's own
    // window chrome and Mol*'s viewport buttons already are. The wearer aims a
    // controller ray at a moving 2D panel from across a room, and the old link
    // read as one-way with no way back.
    // A full-width row of two 64 px-tall targets at the top of the page
    // is reachable with a shaky ray and cannot be mistaken for Mol* UI.
    // Everything pinned to the top of the viewport is written
    // against one custom property, so Quest Browser's exit banner moves the
    // whole top of the page by changing one number. See quest-exit-banner.ts.
    + questExitBannerCss()
    + `#bar{position:absolute;left:0;right:0;top:var(--xr-banner);z-index:8;display:flex;flex-wrap:wrap;gap:12px;`
    + `align-items:center;margin:0;padding:12px 14px;background:#0b161d;box-shadow:0 3px 14px #000a}`
    + `#bar[hidden]{display:none}`
    + `#status{position:absolute;left:0;right:0;top:var(--xr-banner);z-index:5;margin:0;padding:10px 14px;`
    + `font:14px/1.4 system-ui,sans-serif;color:#dceaf0;background:#16232b}`
    + `#selection-status{position:absolute;left:0;right:0;top:calc(var(--xr-banner) + 92px);z-index:5;margin:0;padding:10px 14px;background:#14252e;color:#fff;font:16px system-ui}`
    + `#status[hidden],#selection-status[hidden]{display:none}`
    + `body[data-back="on"] #status{top:calc(var(--xr-banner) + 92px)}`
    + `#back{display:inline-flex;align-items:center;min-height:64px;padding:0 26px;border-radius:14px;`
    + `font:700 24px/1.1 system-ui,sans-serif;color:#071015;background:#7fe5d2;text-decoration:none}`
    + `#back[hidden]{display:none}`
    // The page's own address, in the row the wearer already reads for
    // the way out. Quest Browser's URL bar sits about 40 px above this and does
    // not repaint after the handoff, so this is the only line in the headset
    // that names the page the wearer is actually looking at. Monospace and
    // selectable, so it reads cleanly out of a capture. It is a label, not a
    // target: no min-height, no press.
    + `#address{margin-left:auto;padding:0 10px;border-radius:8px;background:#16232b;color:#9fd8ff;`
    + `font:600 18px/1.2 ui-monospace,monospace;user-select:all}`
    + `#address[hidden]{display:none}`
    // What the wearer was being shown, in words, along
    // the bottom where it cannot cover the structure.
    + `#note{position:absolute;left:0;right:0;bottom:0;z-index:5;margin:0;padding:10px 14px;`
    + `font:14px/1.4 system-ui,sans-serif;color:#dceaf0;background:#16232b}`
    + `#note[hidden]{display:none}`
    + `#return{display:inline-flex;align-items:center;min-height:64px;padding:0 22px;border:0;border-radius:14px;`
    + `font:600 20px/1.15 system-ui,sans-serif;color:#071015;background:#f0c674;cursor:pointer}`
    + `#return:disabled{opacity:.6;cursor:progress}`
    + `#return[hidden],#return-note[hidden],#return-path[hidden]{display:none}`
    + `#return-note,#return-path{position:absolute;right:14px;z-index:6;max-width:min(420px,60vw);margin:0;`
    + `padding:6px 10px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;color:#dceaf0;background:#16232bcc}`
    + `#return-note:empty{display:none}`
    + `#return-note{top:calc(var(--xr-banner) + 100px)}`
    + `#return-path{top:calc(var(--xr-banner) + 136px);font-family:ui-monospace,monospace;user-select:all}`
    + `body[data-back="on"] #return-note{top:calc(var(--xr-banner) + 150px)}`
    + `body[data-back="on"] #return-path{top:calc(var(--xr-banner) + 186px)}`
    // The two controls that keep the assistant in the
    // room. Talk is the same size as the other targets in the row, because it
    // is aimed at with the same shaky controller ray; it is held, not tapped,
    // so a wearer never leaves a microphone open by walking away from a toggle.
    // The caption sits along the bottom beside the lesson note, where an answer
    // cannot cover the structure the question was about.
    + `#talk{display:inline-flex;align-items:center;min-height:64px;padding:0 22px;border:0;border-radius:14px;`
    + `font:600 20px/1.15 system-ui,sans-serif;color:#071015;background:#9fd8ff;cursor:pointer;touch-action:none}`
    + `#talk[hidden]{display:none}`
    + `#talk[data-state="listening"]{background:#ff9f9f}`
    + `#caption{position:absolute;left:0;right:0;bottom:0;z-index:6;margin:0;padding:12px 14px;`
    + `font:600 18px/1.4 system-ui,sans-serif;color:#08151b;background:#7fe5d2}`
    + `#caption[hidden]{display:none}`
    + `#caption:not([hidden]) ~ #note{bottom:56px}`
    + `</style></head>`
    // The Back control leads the row and is read first. "Apply … and return"
    // does the same journey with the wearer's Mol* work attached, so it sits
    // beside it rather than under it, and a wearer who only wants out has the
    // plain one first.
    + `<body><p id="bar" hidden><a id="back" hidden href="#">&#8592; Back to headset view</a>`
    + `<button id="return" type="button" hidden>Apply changes, then back to headset</button>`
    + `<button id="talk" type="button" hidden>Hold to talk</button>`
    + `<span id="address" hidden></span></p>`
    + `<p id="status">Opening the detailed view.</p><p id="selection-status" role="status" hidden></p>`
    + `<p id="return-note" role="status"></p><p id="return-path" hidden></p>`
    + `<p id="caption" role="status" hidden></p>`
    + `<p id="note" data-handoff-note hidden></p><div id="app"></div>`
    + `<script src="${DETAILED_VIEW_ROUTES.script}"></script>`
    + `<script>${BOOTSTRAP}</script></body></html>`;
}
