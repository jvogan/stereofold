import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEWER_BUILD_ID_LENGTH, VIEWER_BUILD_PLACEHOLDER } from '../src/viewer-build.js';
import { forkDrawPassSource } from '../src/molstar-draw-pass-fork.js';
import { forkPickHelperSource } from '../src/molstar-pick-helper-fork.js';
import { patchMolstarStereoSource } from '../src/molstar-stereo-patch.js';
import { fontAtlasCachePatch, textFontTexturePatch, labelUniformUpdatePatch } from '../src/molstar-font-atlas-patch.js';
import { patchMolstarBlendedTransparentSource, transparentMeshColorPatch } from '../src/molstar-transparent-mesh-patch.js';
import { zeroContributionLightingBuildPlugins } from '../src/molstar-zero-light-patch.js';
import { matteLightingBuildPlugins } from '../src/molstar-matte-light-patch.js';
import { patchMolstarOpaqueRendererSource, patchMolstarOpaqueDrawSource, opaqueDepthBuildPlugins } from '../src/molstar-opaque-depth-patch.js';
import { impostorScaleBuildPlugins } from '../src/molstar-impostor-scale-patch.js';
import { patchMolstarSphereFrustumSource } from '../src/molstar-sphere-frustum-patch.js';
import { patchMolstarXrCullingRendererSource } from '../src/molstar-xr-culling-patch.js';
import { stateAbortLoggingPatch } from '../src/molstar-state-abort-patch.mjs';
import { patchMolstarXrSinglePassDrawSource } from '../src/molstar-xr-single-pass-patch.js';
import { patchSphereOcclusionDrawSource } from '../src/molstar-sphere-occlusion-draw-patch.js';
import { patchSphereOcclusionRenderItemSource, patchSphereOcclusionRendererSource, patchSphereOcclusionFragmentSource,
  patchSphereOcclusionCommonFragSource } from '../src/molstar-sphere-occlusion-patch.js';
import { patchMolstarConservativeDepthSphereSource, patchMolstarShaderModuleSource } from '../src/molstar-conservative-depth-patch.js';
import { patchMolstarSphereNormalsMeshFragSource, patchMolstarSpherePrimitiveSource, patchMolstarElementSphereSource,
  patchMolstarMeshRenderableSource } from '../src/molstar-sphere-normals-patch.js';
import { patchMolstarImpostorSplitSource } from '../src/molstar-impostor-split-patch.js';
import { patchMolstarDepthPrepassRendererSource, patchMolstarDepthPrepassRenderItemSource, patchMolstarDepthPrepassMeshVertSource,
  patchMolstarDepthPrepassMeshFragSource } from '../src/molstar-depth-prepass-patch.js';
import { generateThirdPartyNotices } from './third-party-notices.js';
import { prepareScratchDist } from './scratch-dist.js';
import { replaceDistAfter } from './replace-dist.js';
import { readRenderSettings, validateRenderOutput, renderSettingsManifest } from './render-candidate-settings.js';
import { BUILD_INPUT_STAMP_FILE, BUILD_INPUT_STAMP_VERSION, hashBuildInputs } from '../src/build-inputs.js';
import { INSPECTOR_CSS_MARKER } from '../src/inline-html.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceRoot = resolve(pluginRoot, 'src');
const defaultDistRoot = resolve(pluginRoot, 'dist');

/**
 * Where this build writes its runtime.
 *
 *   pnpm --dir plugin run build                      -> plugin/dist (unchanged)
 *   ... run build -- --out /absolute/scratch/dist    -> that directory
 *   STEREOFOLD_DIST_DIR=/absolute/scratch/dist ...   -> that directory
 *
 * `plugin/dist` is what a running host serves, so rebuilding it while the
 * a headset is attached replaces the bundle under a live session. A
 * scratch dist lets a test run build the tree it is about to exercise and hand
 * the directory to `scripts/companion-browser.ts --dist <dir>`, leaving the
 * served copy untouched. A scratch build writes nothing else into the repo: it
 * skips the portable lesson skill and keeps THIRD_PARTY_NOTICES.md beside its
 * own bundles instead of overwriting the checked-in one.
 */
const distArgumentIndex = process.argv.indexOf('--out');
const requestedDist = distArgumentIndex >= 0 ? process.argv[distArgumentIndex + 1] : process.env.STEREOFOLD_DIST_DIR;
if (distArgumentIndex >= 0 && !requestedDist) throw new Error('--out needs an absolute directory.');
if (requestedDist != null && !isAbsolute(requestedDist)) throw new Error(`Build output must be an absolute directory; received ${requestedDist}.`);
const distRoot = requestedDist ? resolve(requestedDist) : defaultDistRoot;
const renderSettings = readRenderSettings();
const { scratchDist } = await validateRenderOutput({ distRoot, servedDistRoot: defaultDistRoot, settings: renderSettings });
const { opaqueDepthEnabled, impostorScaleEnabled, xrCulling, xrSinglePassEnabled, conservativeDepthEnabled, sphereNormalsEnabled, depthPrepassEnabled, sphereOcclusionEnabled, impostorSplit } = renderSettings;
const patchDraw = (source: string) => opaqueDepthEnabled ? patchMolstarOpaqueDrawSource(source) : source;
// Quest render candidates reach only the inspector, which owns immersive sessions.
const patchInspectorDraw = (source: string) => {
  const patched = xrSinglePassEnabled ? patchMolstarXrSinglePassDrawSource(patchDraw(source), renderSettings.xrSkipFinalFlushEnabled) : patchDraw(source);
  return sphereOcclusionEnabled ? patchSphereOcclusionDrawSource(patched, resolve(sourceRoot, 'sphere-occlusion-pass.ts')) : patched;
};
// Inspector-only Quest sphere gate composes after placement scale adaptation.
// Other browsers receive the exact upstream/scaled vertex shader string.
const sphereImpostorTransform = (source: string, shader: string, version: string) => {
  if (shader === 'spheres.vert') source = patchMolstarSphereFrustumSource(source, version);
  if (sphereOcclusionEnabled && shader === 'spheres.frag') source = patchSphereOcclusionFragmentSource(source, version);
  if (conservativeDepthEnabled && (shader === 'spheres.vert' || shader === 'spheres.frag')) source = patchMolstarConservativeDepthSphereSource(source, shader);
  return impostorSplit && shader === 'spheres.frag' ? patchMolstarImpostorSplitSource(source, impostorSplit) : source;
};
const meshFragTransforms = [...(sphereNormalsEnabled ? [patchMolstarSphereNormalsMeshFragSource] : []),
  ...(depthPrepassEnabled ? [patchMolstarDepthPrepassMeshFragSource] : [])];
const meshFragTransform = meshFragTransforms.length ? (source: string) => meshFragTransforms.reduce((s, t) => t(s), source) : undefined;
const inspectorOpaqueComposition = { meshFrag: meshFragTransform, renderItem: (source: string) => {
  if (depthPrepassEnabled) source = patchMolstarDepthPrepassRenderItemSource(source);
  return sphereOcclusionEnabled ? patchSphereOcclusionRenderItemSource(source) : source;
} };
const vendorTransform = (name: string, filter: RegExp, transform: (source: string) => string) => ({
  name, setup(api: any) {
    api.onLoad({ filter }, async ({ path }: { path: string }) => ({ contents: transform(await readFile(path, 'utf8')), loader: 'js' }));
  },
});
const inspectorCandidatePlugins = [
  ...(sphereOcclusionEnabled ? [vendorTransform('stereofold-sphere-occlusion-depth-precision', /molstar[/\\]lib[/\\]mol-gl[/\\]shader[/\\]chunks[/\\]common-frag-params\.glsl\.js$/, patchSphereOcclusionCommonFragSource)] : []),
  ...(conservativeDepthEnabled ? [vendorTransform('stereofold-conservative-depth-shader-source', /molstar[/\\]lib[/\\]mol-gl[/\\]webgl[/\\]shader\.js$/, patchMolstarShaderModuleSource)] : []),
  ...(sphereNormalsEnabled ? [
    vendorTransform('stereofold-sphere-normals-primitive', /molstar[/\\]lib[/\\]mol-geo[/\\]primitive[/\\]sphere\.js$/, patchMolstarSpherePrimitiveSource),
    vendorTransform('stereofold-sphere-normals-element', /molstar[/\\]lib[/\\]mol-repr[/\\]structure[/\\]visual[/\\]util[/\\]element\.js$/, patchMolstarElementSphereSource),
    vendorTransform('stereofold-sphere-normals-renderable', /molstar[/\\]lib[/\\]mol-gl[/\\]renderable[/\\]mesh\.js$/, patchMolstarMeshRenderableSource),
    ...(opaqueDepthEnabled ? [] : [vendorTransform('stereofold-sphere-normals-mesh-frag', /molstar[/\\]lib[/\\]mol-gl[/\\]shader[/\\]mesh\.frag\.js$/, patchMolstarSphereNormalsMeshFragSource)]),
  ] : []),
  ...(depthPrepassEnabled ? [vendorTransform('stereofold-depth-prepass-mesh-vert', /molstar[/\\]lib[/\\]mol-gl[/\\]shader[/\\]mesh\.vert\.js$/, patchMolstarDepthPrepassMeshVertSource)] : []),
];
if (scratchDist && (pluginRoot === distRoot || pluginRoot.startsWith(`${distRoot}/`))) {
  throw new Error(`Refusing to build into ${distRoot}: it contains the plugin itself.`);
}


const stereoViewportPatch = {
  name: 'stereo-structure-viewport-x-swap',
  setup(buildApi: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: 'js' } | undefined>): void }) {
    buildApi.onLoad({ filter: /mol-canvas3d[/\\]camera[/\\]stereo\.js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const patched = patchMolstarStereoSource(source);
      return { contents: patched, loader: 'js' };
    });
  },
};

const pickHelperPatch = {
  name: 'stereo-structure-pick-helper-eye-assignment',
  setup(buildApi: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: 'js' } | undefined>): void }) {
    buildApi.onLoad({ filter: /mol-canvas3d[/\\]helper[/\\]pick-helper\.js$/ }, async (args) => ({
      contents: forkPickHelperSource(await readFile(args.path, 'utf8')),
      loader: 'js',
    }));
  },
};

const anaglyphDrawPassFork = {
  name: 'stereo-structure-anaglyph-draw-pass-fork',
  setup(buildApi: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: 'js' } | undefined>): void }) {
    buildApi.onLoad({ filter: /mol-canvas3d[/\\]passes[/\\]draw\.js$/ }, async (args) => ({
      contents: patchDraw(forkDrawPassSource(await readFile(args.path, 'utf8'))),
      loader: 'js',
    }));
  },
};

const opaqueRendererPatch = (inspector: boolean) => ({
  name: 'stereofold-opaque-renderer-composition',
  setup(api: any) {
    api.onLoad({ filter: /mol-gl[/\\]renderer\.js$/ }, async ({ path }: { path: string }) => {
      const source = await readFile(path, 'utf8');
      let patched = patchMolstarOpaqueRendererSource(inspector ? patchMolstarBlendedTransparentSource(source) : source);
      if (xrCulling) {
        const { version } = JSON.parse(await readFile(resolve(dirname(path), '../../package.json'), 'utf8'));
        patched = patchMolstarXrCullingRendererSource(patched, version);
      }
      if (inspector && depthPrepassEnabled) patched = patchMolstarDepthPrepassRendererSource(patched);
      if (inspector && sphereOcclusionEnabled) patched = patchSphereOcclusionRendererSource(patched);
      return { contents: patched, loader: 'js' };
    });
  },
});
const opaqueInspectorDrawPatch = {
  name: 'stereofold-opaque-inspector-draw',
  setup(api: any) {
    api.onLoad({ filter: /mol-canvas3d[/\\]passes[/\\]draw\.js$/ }, async ({ path }: { path: string }) => ({ contents: patchInspectorDraw(await readFile(path, 'utf8')), loader: 'js' }));
  },
};

function inlineScript(source: string): string {
  return source.replace(/<\/script/giu, '<\\/script');
}

/**
 * Stamp the emitted document with a digest of itself.
 *
 * Fixes shipped against screenshots of a real Codex side panel leave one thing
 * impossible to rule out: that the panel was running an older bundle. Codex
 * stages a copy of `dist/`, and a restage that silently did not happen looks
 * exactly like a fix that did not work. So
 * the viewer reports its own identity in `diagnostics.viewerBuild`.
 *
 * The placeholder is exactly as long as a sha-256 hex digest, so replacing it
 * does not move a byte and the stamp can be *verified* rather than trusted:
 * put the placeholder back where the digest is and hash the result, and a
 * correctly stamped file reproduces its own stamp. `scripts/smoke.ts` does
 * exactly that, so a stamp that does not identify the file it is in fails a
 * gate instead of lying in a diagnostic.
 */
function stampBuildId(html: string): string {
  const occurrences = html.split(VIEWER_BUILD_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Stereofold viewer build placeholder appears ${occurrences} times, expected exactly 1.`);
  }
  const digest = createHash('sha256').update(html, 'utf8').digest('hex');
  if (digest.length !== VIEWER_BUILD_ID_LENGTH) {
    throw new Error(`Stereofold build id is ${digest.length} characters, expected ${VIEWER_BUILD_ID_LENGTH}.`);
  }
  return html.replace(VIEWER_BUILD_PLACEHOLDER, digest);
}

async function main(): Promise<void> {
  // A scratch dist is a directory someone named, so it is emptied only when it
  // is this build's own (see scratch-dist.ts). `plugin/dist` is ours by
  // construction, but it is also what a checkout serves, so the build writes
  // beside it and swaps the result in only after every bundle is written (see
  // replace-dist.ts). A failed build leaves the previous dist in place.
  if (scratchDist) await prepareScratchDist(distRoot);
  if (scratchDist) await emit(distRoot);
  else await replaceDistAfter(distRoot, emit);
}

/** Write the runtime into `outRoot`, an existing directory with no bundles in it. */
async function emit(outRoot: string): Promise<void> {
  if (scratchDist) {
    const manifest = renderSettingsManifest(renderSettings);
    await writeFile(resolve(outRoot, 'render-settings.json'), JSON.stringify(manifest, null, 2) + '\n');
  }

  // This portable skill can be installed independently of the Stereofold MCP
  // server. Its planner has no Mol* runtime or remote service dependency. It
  // is not part of dist, so a scratch build leaves the checked-in copy alone.
  if (!scratchDist) {
  const lessonSkill = resolve(pluginRoot, 'skills/molecular-presentation');
  await mkdir(resolve(lessonSkill, 'scripts'), { recursive: true });
  await mkdir(resolve(lessonSkill, 'assets'), { recursive: true });
  await build({ entryPoints: [resolve(pluginRoot, 'scripts/molecular-lesson-cli.ts')],
    outfile: resolve(lessonSkill, 'scripts/lesson.mjs'), bundle: true, platform: 'node',
    format: 'esm', target: ['node22'], minify: true });
  await copyFile(resolve(pluginRoot, 'LICENSE'), resolve(lessonSkill, 'assets/LICENSE'));
  await copyFile(resolve(pluginRoot, 'node_modules/zod/LICENSE'), resolve(lessonSkill, 'assets/ZOD-LICENSE'));
  for (const name of await readdir(resolve(pluginRoot, 'examples/lessons'))) {
    if (name.endsWith('.json')) await copyFile(resolve(pluginRoot, 'examples/lessons', name), resolve(lessonSkill, 'assets', name));
  }
  }

  const viewer = await build({
    absWorkingDir: pluginRoot,
    bundle: true,
    entryPoints: [resolve(sourceRoot, 'viewer.ts')],
    format: 'iife',
    loader: { '.css': 'css' },
    minify: true,
    outfile: resolve(outRoot, 'viewer.bundle.js'),
    platform: 'browser',
    sourcemap: false,
    target: ['es2022'],
    metafile: true,
    write: false,
    plugins: [...(opaqueDepthEnabled ? [opaqueRendererPatch(false)] : []), ...opaqueDepthBuildPlugins(process.env.STEREOFOLD_OPAQUE_DEPTH_PATCH), stereoViewportPatch, anaglyphDrawPassFork, pickHelperPatch, fontAtlasCachePatch, textFontTexturePatch, labelUniformUpdatePatch,
      ...zeroContributionLightingBuildPlugins(process.env.STEREOFOLD_ZERO_LIGHT_PATCH),
      ...matteLightingBuildPlugins(process.env.STEREOFOLD_MATTE_LIGHT_PATCH), ...impostorScaleBuildPlugins(impostorScaleEnabled ? '1' : '0')],
  });
  const bundle = viewer.outputFiles.find((file) => file.path.endsWith('.js'));
  const css = viewer.outputFiles.find((file) => file.path.endsWith('.css'));
  if (bundle == null || css == null) throw new Error('Stereofold viewer build did not emit JavaScript and CSS.');
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stereofold</title><style>${css.text}</style></head>
<body><div id="stereo-app"></div><script>${inlineScript(bundle.text)}</script></body>
</html>`;
  await writeFile(resolve(outRoot, 'viewer.html'), stampBuildId(html));

  // The inspector excludes desktop stereo forks. Its Mol* patches bound label
  // resources and omit proven zero-alpha meshes from the blended color pass.
  const appearanceWorker = await build({
    entryPoints: [resolve(pluginRoot, '../lab/browser-roundtrip/appearance-fit-worker.mjs')],
    bundle: true, format: 'iife', platform: 'browser', target: ['es2022'], minify: true, write: false,
  });
  const inspector = await build({
    absWorkingDir:pluginRoot, bundle:true, entryPoints:[resolve(sourceRoot,'inspector.ts')],
    nodePaths:[resolve(pluginRoot,'node_modules')], format:'iife', platform:'browser', target:['es2022'],
    loader:{'.css':'css','.ttf':'dataurl'}, minify:true, metafile:true, write:false,
    define: { __APPEARANCE_FIT_WORKER_SOURCE__: JSON.stringify(appearanceWorker.outputFiles[0]!.text),
      __STEREOFOLD_QUEST_MENU_DEPTH_RESET__: JSON.stringify(renderSettings.questMenuDepthResetEnabled) },
    outfile:resolve(outRoot,'inspector.bundle.js'), plugins:[fontAtlasCachePatch,textFontTexturePatch,labelUniformUpdatePatch,...(opaqueDepthEnabled ? [opaqueRendererPatch(true), opaqueInspectorDrawPatch] : [transparentMeshColorPatch, ...(xrSinglePassEnabled ? [opaqueInspectorDrawPatch] : [])]),
      ...opaqueDepthBuildPlugins(process.env.STEREOFOLD_OPAQUE_DEPTH_PATCH, inspectorOpaqueComposition),stateAbortLoggingPatch(),
      ...zeroContributionLightingBuildPlugins(process.env.STEREOFOLD_ZERO_LIGHT_PATCH),
      ...matteLightingBuildPlugins(process.env.STEREOFOLD_MATTE_LIGHT_PATCH), ...impostorScaleBuildPlugins(impostorScaleEnabled ? '1' : '0', sphereImpostorTransform), ...inspectorCandidatePlugins],
  });
  const inspectorJs=inspector.outputFiles.find(file=>file.path.endsWith('.js'));
  const inspectorCss=inspector.outputFiles.find(file=>file.path.endsWith('.css'));
  if(!inspectorJs || !inspectorCss) throw Error('Inspector bundle is incomplete.');
  for(const input of Object.keys(inspector.metafile.inputs)) {
    if(/molstar-(?:stereo|draw-pass|pick-helper)|stereo-controller|packages\/(?:anaglyph|motion)/.test(input)) throw Error(`Inspector contains a desktop fork: ${input}`);
  }
  // Keep each stored file below the Claude directory's 5 MiB limit. Hosts
  // reassemble the CSS before serving, so fonts and styling remain inline.
  // Stamp the complete page so its identity covers both stored files.
  const inspectorPage=stampBuildId(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stereofold Inspector</title><style>${inspectorCss.text}</style></head><body><div id="app"></div><div id="status" role="status">Connecting to Stereofold…</div><script>${inlineScript(inspectorJs.text)}</script></body></html>`);
  if (inspectorCss.text.includes(INSPECTOR_CSS_MARKER) || /<\/style/iu.test(inspectorCss.text)) throw Error('Inspector CSS cannot be safely inlined.');
  await writeFile(resolve(outRoot,'inspector.css'), inspectorCss.text);
  await writeFile(resolve(outRoot,'inspector.html'), inspectorPage.replace(`<style>${inspectorCss.text}</style>`, `<style>${INSPECTOR_CSS_MARKER}</style>`));

  // The page that hosts that inspector in a browser tab on this Mac, for the
  // loopback panel `open_inspector` serves (src/inspector-panel-host.ts). It
  // ships beside inspector.html rather than inside it, so the panel an MCP
  // Apps host mounts stays the same bytes, and the server needs no esbuild.
  const inspectorHost = await build({
    absWorkingDir: pluginRoot, bundle: true, entryPoints: [resolve(pluginRoot, 'scripts/inspector-host.ts')],
    format: 'iife', platform: 'browser', target: ['es2022'], minify: true, metafile: true, write: false,
    outfile: resolve(outRoot, 'inspector-host.js'),
  });
  const inspectorHostJs = inspectorHost.outputFiles.find(file => file.path.endsWith('.js'));
  if (!inspectorHostJs) throw Error('Inspector host bundle is incomplete.');
  await writeFile(resolve(outRoot, 'inspector-host.js'), inspectorHostJs.text);

  const server = await build({
    absWorkingDir: pluginRoot,
    bundle: true,
    entryPoints: [resolve(sourceRoot, 'server.ts')],
    format: 'esm',
    minify: true,
    outfile: resolve(outRoot, 'server.mjs'),
    platform: 'node',
    sourcemap: false,
    target: ['node22'],
    metafile: true,
    write: true,
  });

  // The Unix-socket relay for sandboxed hosts (QUICKSTART, "A host that
  // sandboxes its MCP servers"). It ships in dist so a release recipient can
  // run it with node alone; the checkout runs the same source with tsx.
  await build({
    absWorkingDir: pluginRoot, bundle: true, entryPoints: [resolve(pluginRoot, 'scripts/scene-socket-relay.ts')],
    format: 'esm', platform: 'node', target: ['node22'], minify: true, sourcemap: false,
    outfile: resolve(outRoot, 'scene-socket-relay.mjs'), write: true,
  });

  // The external headset owner runs without a package install. Its child host
  // is bundled separately because both processes must own their own lifetime.
  for (const [source, output] of [
    ['scripts/headset-host.ts', 'headset-host.mjs'],
    ['scripts/serve-inspection.ts', 'serve-inspection.mjs'],
  ]) await build({
    absWorkingDir: pluginRoot, bundle: true, entryPoints: [resolve(pluginRoot, source)],
    format: 'esm', platform: 'node', target: ['node22'], minify: true, sourcemap: false,
    outfile: resolve(outRoot, output), write: true,
    // The MCP SDK's stdio client spawns through cross-spawn, a CommonJS module
    // that calls require('child_process'). An ESM bundle has no require, so
    // esbuild's shim threw "Dynamic require ... is not supported" at startup.
    banner: { js: "import { createRequire as __stereofoldRequire } from 'node:module'; const require = __stereofoldRequire(import.meta.url);" },
  });

  // The full Mol* viewer application, served by the loopback detailed view.
  // It is the stock prebuilt bundle, copied rather than re-bundled so it stays
  // byte-identical to the upstream MIT release, and it ships beside
  // server.mjs because a packaged host has no node_modules.
  const molstarViewer = resolve(pluginRoot, 'node_modules/molstar/build/viewer');
  const molstarDist = resolve(outRoot, 'molstar');
  await mkdir(molstarDist, { recursive: true });
  for (const name of ['molstar.js', 'molstar.css']) {
    await copyFile(resolve(molstarViewer, name), resolve(molstarDist, name));
  }
  await copyFile(resolve(pluginRoot, 'node_modules/molstar/LICENSE'), resolve(molstarDist, 'LICENSE'));

  await writeFile(
    scratchDist ? resolve(outRoot, 'THIRD_PARTY_NOTICES.md') : resolve(pluginRoot, 'THIRD_PARTY_NOTICES.md'),
    await generateThirdPartyNotices(pluginRoot, [viewer.metafile, inspector.metafile, inspectorHost.metafile, server.metafile]),
  );

  // What this build read, so a reader can ask whether a dist matches a source
  // tree without trusting a modification time. `setup-doctor.ts` recomputes
  // this digest and compares; see src/build-inputs.ts for why mtimes are not
  // enough in a second checkout. It is written last, after every bundle
  // landed, so a build that failed half way leaves no stamp claiming it
  // finished. The stamp is committed with the bundles, which is what lets a
  // fresh clone read fresh, so it carries no build time: a clean build has to
  // reproduce it byte for byte, as it does the bundles.
  const inputs = await hashBuildInputs(pluginRoot);
  await writeFile(resolve(outRoot, BUILD_INPUT_STAMP_FILE),
    `${JSON.stringify({ version: BUILD_INPUT_STAMP_VERSION, hash: inputs?.hash ?? null, files: inputs?.files ?? 0 }, null, 2)}\n`);
}

void main();
