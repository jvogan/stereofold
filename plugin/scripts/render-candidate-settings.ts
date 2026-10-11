/** Stock-shader diagnostic controls must never replace the served runtime. */
import { lstat, realpath } from 'node:fs/promises';
import { impostorSplitSetting, type ImpostorSplit } from '../src/molstar-impostor-split-patch.js';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface RenderSettings {
  readonly opaqueDepthEnabled: boolean;
  readonly zeroLightEnabled: boolean;
  readonly matteLightEnabled: boolean;
  readonly impostorScaleEnabled: boolean;
  /** Opt-in instance-grid culling in XR; scratch builds only until measured on a headset. */
  readonly xrCulling: boolean;
  /** Reviewed Quest single-pass rendering; off-Quest and offscreen paths retain stock draws. */
  readonly xrSinglePassEnabled: boolean;
  /** Unqualified render candidates remain scratch-only. */
  readonly conservativeDepthEnabled: boolean;
  readonly sphereNormalsEnabled: boolean;
  readonly depthPrepassEnabled: boolean;
  /** Opt-in menu reset can restore effective FFR and visibly change edges/text. */
  readonly questMenuDepthResetEnabled: boolean;
  /** Qualified Quest2 final flush skip; other devices retain their flush. */
  readonly xrSkipFinalFlushEnabled: boolean;
  /** Qualified Quest 2 large-sphere path; small/unsupported views retain the stock program. */
  readonly sphereOcclusionEnabled: boolean;
  /** Measurement-only impostor shader split, or null. */
  readonly impostorSplit: ImpostorSplit | null;
}

/** Candidate switches, all off in the served runtime until measured on a headset. */
export const RENDER_CANDIDATES = [
  ['STEREOFOLD_CONSERVATIVE_DEPTH', 'conservativeDepthEnabled'],
  ['STEREOFOLD_SPHERE_NORMALS', 'sphereNormalsEnabled'],
  ['STEREOFOLD_DEPTH_PREPASS', 'depthPrepassEnabled'],
  ['STEREOFOLD_QUEST_MENU_DEPTH_RESET', 'questMenuDepthResetEnabled'],
] as const;

function binaryFlag(env: Readonly<Record<string, string | undefined>>, name: string, defaultValue = false): boolean {
  const value = env[name];
  if (value === undefined) return defaultValue;
  if (value === '0') return false;
  if (value === '1') return true;
  throw new Error(`${name} must be 0 or 1.`);
}

export function readRenderSettings(env: Readonly<Record<string, string | undefined>> = process.env): RenderSettings {
  const opaqueDepthEnabled = binaryFlag(env, 'STEREOFOLD_OPAQUE_DEPTH_PATCH', true);
  const zeroLightEnabled = binaryFlag(env, 'STEREOFOLD_ZERO_LIGHT_PATCH', true);
  const matteLightEnabled = binaryFlag(env, 'STEREOFOLD_MATTE_LIGHT_PATCH', true);
  const impostorScaleEnabled = binaryFlag(env, 'STEREOFOLD_IMPOSTOR_SCALE_PATCH', true);
  const xrCulling = binaryFlag(env, 'STEREOFOLD_XR_CULLING_PATCH');
  // The build composes the renderer transforms in one loader, which exists only
  // while the opaque-depth renderer patch is on.
  if (xrCulling && !opaqueDepthEnabled) throw new Error('XR culling candidate requires the reviewed opaque-depth renderer composition.');
  if (env.STEREOFOLD_DEPTH_PREPASS === '1' && !opaqueDepthEnabled)
    throw new Error('STEREOFOLD_DEPTH_PREPASS=1 extends the opaque-depth variants; keep STEREOFOLD_OPAQUE_DEPTH_PATCH on.');
  const xrSinglePassEnabled = binaryFlag(env, 'STEREOFOLD_XR_SINGLE_PASS', true);
  const sphereComposition = opaqueDepthEnabled && impostorScaleEnabled && xrSinglePassEnabled;
  const sphereOcclusionEnabled = binaryFlag(env, 'STEREOFOLD_SPHERE_OCCLUSION', sphereComposition);
  if (sphereOcclusionEnabled && !sphereComposition)
    throw new Error('Sphere occlusion requires the opaque-depth, impostor-scale and XR single-pass compositions.');
  return { opaqueDepthEnabled, zeroLightEnabled, matteLightEnabled, impostorScaleEnabled, xrCulling,
    xrSinglePassEnabled,
    conservativeDepthEnabled: binaryFlag(env, 'STEREOFOLD_CONSERVATIVE_DEPTH'),
    sphereNormalsEnabled: binaryFlag(env, 'STEREOFOLD_SPHERE_NORMALS'),
    depthPrepassEnabled: binaryFlag(env, 'STEREOFOLD_DEPTH_PREPASS'),
    questMenuDepthResetEnabled: binaryFlag(env, 'STEREOFOLD_QUEST_MENU_DEPTH_RESET'),
    xrSkipFinalFlushEnabled: binaryFlag(env, 'STEREOFOLD_XR_SKIP_FINAL_FLUSH', true),
    sphereOcclusionEnabled,
    impostorSplit: impostorSplitSetting(env.STEREOFOLD_IMPOSTOR_SPLIT) };
}

function contains(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

/** Resolve symlinks even when a future output directory does not exist yet.
 * A dangling symlink or unreadable ancestor fails closed, rather than being
 * mistaken for an ordinary absent directory. This reads the filesystem only.
 */
export async function resolveRenderOutputPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`Build output must be an absolute directory; received ${path}.`);
  let existing = resolve(path);
  const absent: string[] = [];
  for (;;) {
    try { await lstat(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      absent.unshift(relative(parent, existing));
      existing = parent;
    }
  }
  return join(await realpath(existing), ...absent);
}

export async function validateRenderOutput(input: {
  distRoot: string;
  servedDistRoot: string;
  settings: RenderSettings;
}): Promise<{ scratchDist: boolean; resolvedDistRoot: string; resolvedServedDistRoot: string }> {
  const lexicalDist = resolve(input.distRoot);
  const lexicalServed = resolve(input.servedDistRoot);
  const [resolvedDistRoot, resolvedServedDistRoot] = await Promise.all([
    resolveRenderOutputPath(input.distRoot), resolveRenderOutputPath(input.servedDistRoot),
  ]);
  const lexicalInside = contains(lexicalServed, lexicalDist);
  const physicalInside = contains(resolvedServedDistRoot, resolvedDistRoot);
  if (lexicalDist !== lexicalServed && resolvedDistRoot === resolvedServedDistRoot) {
    // replaceDistAfter renames the requested lexical entry; accepting an alias
    // would replace the symlink instead of replacing the served directory.
    throw new Error('Refusing build output alias of the served distribution directory.');
  }
  const servedOutput = lexicalDist === lexicalServed;
  // Descendants are never an independent scratch destination, even if their
  // lexical entry happens to be a symlink pointing outside the served tree.
  if ((lexicalInside && lexicalDist !== lexicalServed) || (physicalInside && resolvedDistRoot !== resolvedServedDistRoot)) {
    throw new Error('Refusing build output inside the served distribution directory.');
  }
  if (servedOutput) {
    for (const [flag, enabled] of [
      ['STEREOFOLD_OPAQUE_DEPTH_PATCH', input.settings.opaqueDepthEnabled],
      ['STEREOFOLD_ZERO_LIGHT_PATCH', input.settings.zeroLightEnabled],
      ['STEREOFOLD_MATTE_LIGHT_PATCH', input.settings.matteLightEnabled],
      ['STEREOFOLD_IMPOSTOR_SCALE_PATCH', input.settings.impostorScaleEnabled],
      ['STEREOFOLD_XR_SINGLE_PASS', input.settings.xrSinglePassEnabled],
      ['STEREOFOLD_SPHERE_OCCLUSION', input.settings.sphereOcclusionEnabled],
      ['STEREOFOLD_XR_SKIP_FINAL_FLUSH', input.settings.xrSkipFinalFlushEnabled],
    ] as const) {
      if (!enabled) throw new Error(`${flag}=0 requires a scratch output directory (--out or STEREOFOLD_DIST_DIR).`);
    }
    if (input.settings.xrCulling) throw new Error('STEREOFOLD_XR_CULLING_PATCH=1 requires a scratch output directory (--out or STEREOFOLD_DIST_DIR).');
    for (const [flag, field] of RENDER_CANDIDATES) {
      if (input.settings[field]) throw new Error(`${flag}=1 requires a scratch output directory (--out or STEREOFOLD_DIST_DIR).`);
    }
    if (input.settings.impostorSplit) throw new Error('STEREOFOLD_IMPOSTOR_SPLIT requires a scratch output directory (--out or STEREOFOLD_DIST_DIR).');
  }
  if (!servedOutput && (contains(lexicalDist, lexicalServed) || contains(resolvedDistRoot, resolvedServedDistRoot))) {
    throw new Error('Refusing scratch output that contains the served distribution directory.');
  }
  return { scratchDist: !servedOutput, resolvedDistRoot, resolvedServedDistRoot };
}

/** Complete scratch manifest content. Callers own persistence after validation. */
export function renderSettingsManifest(settings: RenderSettings): {
  version: 1; diagnosticOnly: boolean; opaqueDepthEnabled: boolean;
} & RenderSettings {
  const candidate = RENDER_CANDIDATES.some(([, field]) => settings[field]) || settings.impostorSplit !== null;
  return { version: 1, diagnosticOnly: candidate || settings.xrCulling || !settings.opaqueDepthEnabled || !settings.zeroLightEnabled || !settings.matteLightEnabled || !settings.impostorScaleEnabled || !settings.xrSinglePassEnabled || !settings.sphereOcclusionEnabled || !settings.xrSkipFinalFlushEnabled, ...settings };
}
