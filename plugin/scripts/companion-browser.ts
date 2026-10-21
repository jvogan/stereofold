import { runAutoplayManipulationAcceptance } from './xr-autoplay-manipulation-acceptance.js';
import { runNaturalInputAcceptance } from './xr-natural-input-acceptance.js';
import { runControllerAcceptance } from './xr-controller-acceptance.js';
import { xrToolbarControllerPose } from './xr-toolbar-controller-pose.js';
import { observeToolbarRows } from './xr-toolbar-row-observer.js';
import { waitForSavedXrEntry } from './xr-entry-baseline.js';
import { readInlineHtml } from '../src/inline-html.js';
import { instrumentMolecularGeometry, molecularGeometryProbeBundle } from './molecular-geometry-probe.js';
// @ts-ignore Shared bounds used by the browser and saved placement contract.
import { PLACEMENT_MIN_SCALE, PLACEMENT_MAX_SCALE } from '../../lab/browser-roundtrip/placement-limits.mjs';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Frame, type Page } from 'playwright';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { growthStages, readGrowthIndex, type GrowthStage } from '../src/molecular-growth.js';
import { redactTokens, requestRoute } from './report-redaction.js';
import { createHeadsetBridgeWriter, summariseSelection,
  type BridgeCaptureInput, type HeadsetBridgeWriter } from '../src/headset-bridge.js';

/**
 * Emulator acceptance for the headset page: a real MCP server, the real
 * loopback companion, headless Chromium and the IWER WebXR runtime.
 *
 * Three options exist so a freshly made build can be tested end to end,
 * without touching what a live host is serving:
 *
 *   --dist /absolute/dist        serve this runtime instead of plugin/dist.
 *                                Build one with
 *                                `pnpm exec tsx scripts/build.ts --out <dir>`.
 *   --render-budget <knobs>      append `?xrRenderBudget=<knobs>` to the page
 *                                address, so one build can A/B the look knobs
 *                                (`palette:off`, `light:off`, `rough:0.3`,
 *                                `postfx:on`, `surface:medium`).
 *   --tour chapters             play every chapter; verify scene and narration receipts.
 *   --tour full                 also run the parked-RNA emphasis regression.
 *   --controller-input          run native XR snapshot / saved-placement
 *                                acceptance across tracked, emulated and null
 *                                controller poses, then stop. Requires IWER.
 *   --autoplay-manipulation     hold molecule trigger, grip and two-hand scale
 *                                across authored autoplay chapter boundaries.
 *   --natural-input             synthetic handless transient pointers on IWER;
 *                                production input/save path, not Apple simulator evidence.
 *   --allow-console-errors       record console errors without failing.
 *
 * Recorded: every console message, every response with a status of 400 or
 * more, and every failed request go into browser-report.json, and any
 * of the last two, or a console error, fails the run. Before that existed a
 * 409 on the page's narration call, or a blocked script, left no trace here at
 * all: only `pageerror` was watched.
 */
const [outArgument, ...allOptionArguments] = process.argv.slice(2);
const out = resolve(outArgument ?? '');
assert.ok(outArgument, 'Supply a fresh artifact directory.');
// Both options are optional and may appear in either order. Supplying none
// leaves this harness on exactly the path it took before the bridge existed.
const OPTION_USAGE = 'Optional usage: --xr-runtime /absolute/path/to/iwer.min.js [--bridge /absolute/bridge/directory] [--demo <demo name>] [--stage <stage id>] [--shots /absolute/step/shot/directory] [--mode vr|ar] [--browser-channel shell|chromium] [--head-yaw <degrees>] [--head-offset <x,y,z metres>] [--dist /absolute/dist/directory] [--render-budget <knob:value,...>] [--tour chapters|full] [--grow] [--grow-voice] [--controller-input] [--natural-input] [--autoplay-manipulation] [--allow-console-errors]';
// Valueless switches, removed before the pairwise scan below.
const BOOLEAN_OPTIONS = ['--allow-console-errors', '--grow', '--grow-voice', '--controller-input', '--natural-input', '--autoplay-manipulation'];
const switches = new Set(allOptionArguments.filter(argument => BOOLEAN_OPTIONS.includes(argument)));
const optionArguments = allOptionArguments.filter(argument => !BOOLEAN_OPTIONS.includes(argument));
// `--demo` and `--stage` name entries in plugin/demos/index.json, so they are
// names rather than paths and the absolute-path rule does not apply to them.
// `--mode` and `--tour` are one of two words for the same reason.
const NAMED_OPTIONS = ['--demo', '--stage', '--mode', '--tour', '--browser-channel'];
// The headset page reads `?xrRenderBudget=` off its own
// address (`xr-render-budget.mjs` `renderBudgetOverrides`), so without this
// every look A/B - palette, lighting, roughness, the occlusion pass - needs a
// separate build. The value is appended to the companion address's search
// before the page loads; the origin is unchanged, so the request filter and
// the page key are unaffected. Restricted to the budget parameter's own
// alphabet so a harness flag can never reshape the address into something
// else.
// Harness-only wearer pose. A Quest wearer rarely stands on the reference-space
// origin facing -Z, so these place the emulated head somewhere else before the
// page enters immersion. Signed decimals, so they need their own shape.
const POSE_OPTIONS = ['--head-yaw', '--head-offset'];
const NUMBER = String.raw`-?\d{1,4}(?:\.\d{1,6})?`;
const options = new Map<string, string>();
for (let index = 0; index < optionArguments.length; index += 2) {
  const flag = optionArguments[index], value = optionArguments[index + 1];
  const shape = flag === '--head-yaw' ? new RegExp(`^${NUMBER}$`, 'u')
    : flag === '--head-offset' ? new RegExp(`^${NUMBER},${NUMBER},${NUMBER}$`, 'u')
    : flag === '--render-budget' ? /^[A-Za-z0-9_.,;:=-]{1,128}$/u
    : NAMED_OPTIONS.includes(flag) ? /^[A-Za-z0-9_-]{1,64}$/u : undefined;
  assert.ok(['--xr-runtime', '--bridge', '--shots', '--dist', '--render-budget', ...NAMED_OPTIONS, ...POSE_OPTIONS].includes(flag) && !options.has(flag)
    && value !== undefined && (shape ? shape.test(value) : isAbsolute(value)), OPTION_USAGE);
  options.set(flag, value);
}
const xrRuntimePath = options.get('--xr-runtime');
// Playwright's full Chromium uses its newer headless mode. Keep the shell
// default for existing evidence; record the actual WebGL renderer in either
// mode so a software-rendered stall is not reported as headset performance.
const browserChannel = options.get('--browser-channel') ?? 'shell';
assert.ok(browserChannel === 'shell' || browserChannel === 'chromium', OPTION_USAGE);
/** The budget knobs to put on the page address, or '' to leave it alone. */
const renderBudgetKnobs = options.get('--render-budget') ?? '';
/**
 * The same address with `?xrRenderBudget=` on it. The hash carries the page
 * key, so the search has to be spliced in ahead of it rather than appended.
 */
function withRenderBudget(address: string): string {
  if (!renderBudgetKnobs) return address;
  const parsed = new URL(address);
  parsed.searchParams.set('xrRenderBudget', renderBudgetKnobs);
  return parsed.toString();
}
// The runtime under test. `plugin/dist` by default, which is also what a
// running host serves, so a run that wants to exercise its own build points
// this at a scratch dist and leaves the served copy alone.
const distDirectory = resolve(options.get('--dist') ?? 'dist');
// Both tour modes walk every chapter. Full additionally checks the parked-RNA
// emphasis regression; chapters works with lessons that use other scene styles.
const tourMode = options.get('--tour');
assert.ok(tourMode === undefined || tourMode === 'full' || tourMode === 'chapters', OPTION_USAGE);
assert.ok(!tourMode || (xrRuntimePath && options.get('--demo')),
  '--tour steps an authored lesson in immersion, so it needs --demo and --xr-runtime.');
const allowConsoleErrors = switches.has('--allow-console-errors');
// The primary Enter control asks for immersive-ar wherever the browser reports
// it and falls back to immersive-vr on the same button, so the default here is
// to press what a wearer presses and record whichever mode the page chose.
// `--mode vr` presses the plain-VR control under More options; `--mode ar`
// presses the passthrough request by name.
const entryMode = options.get('--mode');
assert.ok(entryMode === undefined || entryMode === 'vr' || entryMode === 'ar', OPTION_USAGE);
assert.ok(!entryMode || xrRuntimePath, '--mode chooses an immersive entry, so it needs --xr-runtime.');
const demoName = options.get('--demo');
assert.ok(!options.get('--stage') || demoName, '--stage names a stage of a demo, so it needs --demo.');
assert.ok(!demoName || xrRuntimePath, 'A demo run steps a lesson through immersive scenes, so --demo needs --xr-runtime.');
// `--grow` plays the opening chapter and then grows the staged
// lesson tier by tier with `grow_structure`, inside the immersive session it is
// already in, until the device tier refuses the next one. It stops the run
// there, the way the other opt-in probes do, because every case after it is
// written against the tier this one replaced.
const growDrive = switches.has('--grow');
assert.ok(!growDrive || (xrRuntimePath && demoName),
  '--grow grows a staged lesson in immersion, so it needs --demo and --xr-runtime.');
assert.ok(!growDrive || !tourMode, '--grow and --tour both take the lesson over; run them separately.');
// `--grow-voice` is the same walk up the tiers driven the way
// the wearer drives it: `__stereofoldVoice.say('grow it')`, into the page's own
// grammar, through the same dispatcher a menu press uses. `--grow` proves the
// protocol; this proves the sentence. They take the same lesson over, so only
// one of them runs in a pass.
const growVoiceDrive = switches.has('--grow-voice');
assert.ok(!growVoiceDrive || (xrRuntimePath && demoName),
  '--grow-voice grows a staged lesson by voice in immersion, so it needs --demo and --xr-runtime.');
assert.ok(!growVoiceDrive || !tourMode, '--grow-voice and --tour both take the lesson over; run them separately.');
assert.ok(!growVoiceDrive || !growDrive, '--grow and --grow-voice drive the same tiers two different ways; run them separately.');
// Where both-eye XR captures are published. Absent means this run writes
// nothing outside its artifact directory.
const bridgeDirectory = options.get('--bridge');
assert.ok(!bridgeDirectory || xrRuntimePath,
  'The bridge publishes both-eye XR captures, so --bridge needs --xr-runtime as well.');
// IWER seats metaQuest2 at (0, 1.6, 0) looking down -Z. These two options move
// the emulated head off that seat for the whole run, so a capture can show what
// a wearer standing elsewhere, or facing elsewhere, actually sees. Yaw is
// degrees about +Y, positive turning left, matching the WebXR right-handed
// frame. Absent means the previous seat, unchanged.
const headYawDegrees = Number(options.get('--head-yaw') ?? 0);
const headOffsetMetres = (options.get('--head-offset') ?? '0,1.6,0').split(',').map(Number);
assert.ok(!options.get('--head-yaw') || xrRuntimePath, '--head-yaw poses the emulated head, so it needs --xr-runtime.');
assert.ok(!options.get('--head-offset') || xrRuntimePath, '--head-offset poses the emulated head, so it needs --xr-runtime.');
const headPose = { yawDegrees: headYawDegrees,
  position: { x: headOffsetMetres[0], y: headOffsetMetres[1], z: headOffsetMetres[2] } };
// Keeps the IWER proof short when iterating on the in-headset tour itself.
// It still mounts the production companion and sends real controller events.
// A demo run implies it: the acceptance assertions between here and the tour
// are written against the 4HHB fixture's chains, residues and saved appearance.
const naturalInputOnly = switches.has('--natural-input');
assert.ok(!(naturalInputOnly && switches.has('--controller-input')), 'Choose either --natural-input or --controller-input.');
// Both focused input routes share the small fixture and isolated setup.
const controllerInputOnly = switches.has('--controller-input') || naturalInputOnly;
assert.ok(!controllerInputOnly || xrRuntimePath, 'Focused input acceptance requires --xr-runtime.');
const autoplayManipulation = switches.has('--autoplay-manipulation');
assert.ok(!autoplayManipulation || (demoName && xrRuntimePath && !controllerInputOnly && !tourMode && !growDrive && !growVoiceDrive),
  '--autoplay-manipulation needs --demo and --xr-runtime and takes the lesson over.');
const focusedTourIwer = controllerInputOnly || process.env.STEREOFOLD_TOUR_IWER_ONLY === '1' || Boolean(demoName);
// Where per-step both-eye frames go. Outside the artifact directory, because
// they are read as the steps of one demo rather than as one whole run.
const stepShotDirectory = demoName ? resolve(options.get('--shots') ?? resolve(out, 'tour-shots'), demoName) : undefined;
const require = createRequire(import.meta.url);
const xrAdapters = xrRuntimePath ? require('../../lab/headset-preview/adapters.cjs') : undefined;
const xrRuntime = xrRuntimePath ? await readFile(xrRuntimePath, 'utf8') : undefined;
await mkdir(out, { recursive: false });
if (stepShotDirectory) await mkdir(stepShotDirectory, { recursive: true });
const bridge: HeadsetBridgeWriter | undefined = bridgeDirectory ? await createHeadsetBridgeWriter(bridgeDirectory) : undefined;

/**
 * The coordinates and lesson of one shipped demo, resolved exactly the way
 * `pnpm --dir plugin run demo` resolves them.
 *
 * Reusing `quest-demo.ts` keeps this harness on the same cache, the same
 * lesson validation and the same provenance check the demo command uses, so a
 * run here cannot pass against a lesson the demo command would reject.
 */
const demo = demoName ? await (async () => {
  const { readDemoIndex, readDemoLesson, resolveDemoStage, demoCacheDirectory } =
    await import('./quest-demo.js');
  const { demoInspectionInput } = await import('./demo-inspection-input.js');
  const index = await readDemoIndex();
  const found = index.demos.find(entry => entry.name === demoName);
  assert.ok(found, `Unknown demo "${demoName}". Run \`pnpm --dir plugin run demo --list\` to see them.`);
  const { entry, stage } = resolveDemoStage(found, options.get('--stage'));
  const manifest = await readDemoLesson(entry);
  const lessonPath=resolve(dirname(fileURLToPath(import.meta.url)), '../demos', entry.lesson);
  const inspectionInput=await demoInspectionInput(entry,lessonPath,demoCacheDirectory(),message=>console.log(message));
  return { entry, stage, manifest, inspectionInput };
})() : undefined;

const report: any = {
  status: 'failed',
  browserChannel,
  scope: naturalInputOnly ? 'Synthetic handless transient-pointer input on IWER production renderer; not visionOS simulator or physical Apple Vision Pro evidence.' : controllerInputOnly ? 'Focused native XR controller acceptance: tracked, emulated and unavailable poses; saved placement and menu recovery.' : tourMode ? `IWER lesson ${tourMode} acceptance: rendered chapters and narration request path; no physical headset evidence.` : focusedTourIwer ? 'Focused IWER: current experience journey, head/camera preservation, lifecycle and reload; optional labeled injected recovery and off-molecule captures. Excludes the broad molecular-controls and rotation suite.' : 'Full companion harness',
  host: 'Controlled official MCP Apps AppBridge plus the real loopback companion and optional IWER controller input. Native Codex, Claude Science, and physical headsets are not tested.',
  cases: [], screenshots: [], errors: [], externalRequests: [], cleanup: {},
  // Evidence a page leaves that `pageerror` never carried: what it logged, what
  // the loopback companion refused, and what never left the browser at all.
  console: [], failedResponses: [], failedRequests: [],
  // Per-tool HTTP outcomes over the loopback companion, and the ordered
  // spoken-line attempts inside them.
  toolStatus: {}, speechCalls: [],
};
const passed = (name: string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
// A companion URL carries its capability in the fragment and its bearer in a
// header, and a tool body carries source tokens. Nothing recorded here keeps a
// query, a fragment or any run of 24+ token characters; both rules live in
// `report-redaction.ts`, where they are tested.
const redact = redactTokens;
const routeOf = requestRoute;
/**
 * Record what one page says and what its requests do.
 *
 * Measured: every page-originated spoken line answered 409 and the tour
 * kept playing: the page swallowed it, `pageerror` never fired, and this
 * harness reported a clean run. Console output and response status are the two
 * channels that would have shown it, so both are recorded for every page.
 */
const SPEECH_TOOLS = new Set(['voice_acknowledgement', 'speak_to_headset']);
function watchPageEvidence(page: Page, surface: string) {
  page.on('console', message => {
    const where = message.location();
    report.console.push({ surface, level: message.type(), text: redact(message.text()).slice(0, 400),
      url: where?.url ? routeOf(where.url) : null, line: where?.lineNumber ?? null });
  });
  page.on('response', response => {
    const request = response.request();
    // The tool name only. A request body carries a source token and the line
    // itself; neither is recorded, and the name is one of a fixed set.
    if (request.method() === 'POST' && routeOf(response.url()).endsWith('/tool')) {
      const tool = /"name"\s*:\s*"([A-Za-z_]{1,40})"/u.exec(request.postData() ?? '')?.[1] ?? 'unnamed';
      const statuses = (report.toolStatus[tool] ??= {});
      statuses[response.status()] = (statuses[response.status()] ?? 0) + 1;
      if (SPEECH_TOOLS.has(tool)) report.speechCalls.push({ surface, tool, status: response.status(), at: new Date().toISOString() });
    }
    if (response.status() < 400) return;
    report.failedResponses.push({ surface, method: request.method(),
      url: routeOf(response.url()), status: response.status() });
  });
  page.on('requestfailed', request => {
    const tool = request.method() === 'POST' && routeOf(request.url()).endsWith('/tool')
      ? /"name"\s*:\s*"([A-Za-z_]{1,40})"/u.exec(request.postData() ?? '')?.[1] : undefined;
    report.failedRequests.push({ surface, method: request.method(), url: routeOf(request.url()),
      failure: redact(request.failure()?.errorText ?? 'unknown'), at: new Date().toISOString(), timing: request.timing(),
      ...(tool ? { tool } : {}) });
  });
}
/** The gate those three channels exist for. Called before any run is called green. */
function assertEvidenceClean(expectedInjectedAbort = false) {
  let consoleErrors = report.console.filter((entry: any) => entry.level === 'error');
  if (expectedInjectedAbort) {
    assert.equal(process.env.STEREOFOLD_XR_DEADLINE_RECOVERY_ONLY, '1');
    assert.equal(report.emulatedXr?.injectedDeadlineRecovery?.fault?.released, true);
    const expected = consoleErrors.filter((entry: any) => entry.surface === 'companion'
      && entry.text === '{isAborted: true, reason: Growing the structure stalled: its placed step did not finish within 45 seconds in the headset., toString: }');
    assert.equal(expected.length, 1, 'The injected deadline must log exactly its one expected Mol* abort.');
    report.expectedInjectedConsoleErrors = expected;
    consoleErrors = consoleErrors.filter((entry: any) => entry !== expected[0]);
  }
  assert.deepEqual(report.failedRequests, [],
    `The page made ${report.failedRequests.length} request(s) that never completed: ${JSON.stringify(report.failedRequests)}`);
  assert.deepEqual(report.failedResponses, [],
    `The page received ${report.failedResponses.length} failing response(s): ${JSON.stringify(report.failedResponses)}`);
  if (!allowConsoleErrors) {
    assert.deepEqual(consoleErrors, [],
      `The page logged ${consoleErrors.length} console error(s); pass --allow-console-errors to record them without failing: ${JSON.stringify(consoleErrors)}`);
  }
}
const delay = (ms: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, ms));
const client = new Client({ name: 'Stereofold companion acceptance', version: '1' });
/**
 * A local voice for the page's spoken lines.
 *
 * `voice_acknowledgement` renders every page-originated line through an
 * optional external OAuth speech helper, and a host without that helper
 * answers 409 for reasons
 * that have nothing to do with the tour. This harness is not qualifying a
 * voice, it is qualifying the request path, so it renders the same WAV locally
 * with `/usr/bin/say` and leaves the tool, its revision checks, the loopback
 * transport and the page's playback exactly as they ship. An explicit
 * STEREOFOLD_AGENT_VOICE_BIN in the environment always wins.
 */
const voiceShim = tourMode && !process.env.STEREOFOLD_AGENT_VOICE_BIN
  ? resolve(out, 'local-voice-shim.sh') : undefined;
if (voiceShim) {
  await writeFile(voiceShim, `#!/bin/sh
# Harness-only stand-in for the external speech helper: renders locally, reaches no network.
set -eu
input=''; output=''
while [ $# -gt 0 ]; do
  case "$1" in
    --input-file) input=$2; shift 2 ;;
    --out) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$input" ] && [ -n "$output" ] || exit 64
exec /usr/bin/say -r 300 --data-format=LEI16@22050 --file-format=WAVE -o "$output" -f "$input"
`, { mode: 0o700 });
}
// The SDK's default child environment is a filtered allowlist, so a setting
// the caller exported never reaches the server unless it is named here. An
// explicit binary wins over the shim, which is how a run deliberately points
// the speak path at a voice that refuses.
const controllerVoiceFixture = controllerInputOnly ? resolve(out, 'controller-test-voice.py') : undefined;
if (controllerVoiceFixture) await writeFile(controllerVoiceFixture, `#!/usr/bin/env python3
import sys, wave
args = sys.argv[1:]
with wave.open(args[args.index('--out') + 1], 'wb') as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(22050)
    audio.writeframes(bytes(22050))
`, { mode: 0o700 });
const voiceBin = controllerVoiceFixture ?? process.env.STEREOFOLD_AGENT_VOICE_BIN ?? voiceShim;
/**
 * The in-browser half of the conversation loop needs the Mac's
 * own transcriber, which is off unless a host is started with `--ptt`. It is
 * turned on only for the opt-in ask probe, so an ordinary run still spawns a
 * server that transcribes nothing. The whisper and ffmpeg overrides come with
 * it because the allowlisted default environment would otherwise drop them and
 * the probe would fail on a Mac that is correctly configured.
 */
const askLoop = process.env.STEREOFOLD_ASK_LOOP === '1';
const serverEnvironment: Record<string, string> = {
  // Acceptance must not discover or forward into a wearer's live scene.
  STEREOFOLD_SCENE_SERVICE: resolve(out, 'scene-service.json'),
  ...(voiceBin ? { STEREOFOLD_AGENT_VOICE_BIN: voiceBin } : {}),
  ...(askLoop ? { STEREOFOLD_PTT_TRANSCRIBE: '1' } : {}),
  ...Object.fromEntries((askLoop
    ? ['STEREOFOLD_WHISPER_BIN', 'STEREOFOLD_WHISPER_MODEL', 'STEREOFOLD_WHISPER_GPU', 'STEREOFOLD_FFMPEG_BIN', 'STEREOFOLD_PTT_TRANSCRIBER', 'STEREOFOLD_APPLESPEECH_BIN']
    : []).flatMap(name => (process.env[name] ? [[name, process.env[name] as string]] : []))),
};
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(distDirectory, 'server.mjs')], cwd: process.cwd(), stderr: 'pipe',
  ...(Object.keys(serverEnvironment).length ? { env: { ...getDefaultEnvironment(), ...serverEnvironment } } : {}) });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += String(chunk); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let host: ReturnType<typeof createServer> | undefined;

const callRaw = (name: string, args: unknown) => client.callTool({ name: `stereo_structure.${name}`, arguments: args as Record<string, unknown> }) as Promise<any>;
const call = async (name: string, args: unknown) => {
  const result = await callRaw(name, args);
  assert.ok(!result.isError, `stereo_structure.${name} failed`);
  return result;
};
// Hydration may carry the catalog as the legacy object or as the bounded
// compressed wire form. Decoding is a gunzip plus a digest, and this runs in a
// 100 ms polling loop, so a decoded catalog is kept by its own digest.
const decodedCatalogs = new Map<string, any>();
async function hydratedCatalog(data: any) {
  if (data.catalog) return data.catalog;
  const cached = decodedCatalogs.get(data.catalogWire.catalogSha256);
  if (cached) return cached;
  const catalog = await decodeInspectionCatalog(data.catalogWire);
  decodedCatalogs.set(data.catalogWire.catalogSha256, catalog);
  return catalog;
}
const privateInspection = async (sessionId: string) => {
  const result = await call('get_inspection', { sessionId });
  const data = result._meta?.['stereo_structure/inspection'];
  assert.ok(data && typeof data.structureText === 'string' && (data.catalog || data.catalogWire),
    'Private hydration must contain the source and catalog.');
  // Present one shape to the rest of this harness, exactly as the production
  // inspector does at `plugin/src/inspector.ts:182`.
  return { ...data, history: result.structuredContent?.history,
    catalog: data.catalog ?? await hydratedCatalog(data) };
};
/**
 * A molecular surface and its residue labels are rebuilt on the CPU while the
 * emulated session is already drawing two software-rendered eyes, so the
 * commands that change representation or labels inside XR get a wider receipt
 * budget than the 120 s that suits every other command.
 */
const XR_REBUILD_TIMEOUT_MS = 420_000;
async function waitState(sessionId: string, predicate: (state: any) => boolean, commandId?: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = (await call('get_inspection_state', { sessionId, ...(commandId ? { commandId } : {}) })).structuredContent;
    report.lastObservedState = { inspectionRevision: state.inspectionRevision,
      panels: state.panels.map((panel: any) => ({ surface: panel.surface, current: panel.current, availability: panel.availability })),
      command: state.command ? { status: state.command.status, reason: state.command.reason, renderedRevision: state.command.renderedRevision } : undefined,
    };
    if (predicate(state)) {
      // Channel C: a rendered receipt is the moment the assistant is waiting
      // for, so publish the companion's current pixels and state right here.
      if (bridge && state.command?.status === 'rendered') await publishBridge();
      return state;
    }
    if (commandId && ['unconfirmed', 'rejected', 'expired', 'conflict'].includes(state.command?.status)) {
      throw Error(`Command ${commandId} ended ${state.command.status}: ${state.command.reason ?? 'no reason supplied'}`);
    }
    await delay(100);
  }
  throw Error('Timed out waiting for inspection state.');
}
async function waitPrivate(sessionId: string, predicate: (data: any) => boolean) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const data = await privateInspection(sessionId);
    if (predicate(data)) return data;
    await delay(100);
  }
  throw Error('Timed out waiting for the saved inspection.');
}

/**
 * Channel C: the producer side of the Claude Science file bridge.
 *
 * `plugin/src/headset-bridge.ts` owns the four-step atomic write; this harness
 * owns the only both-eye capture in the repo. Because both run in this Node
 * process, the writer is called directly rather than posted through
 * `serve-xr-review.ts`'s `/bridge` route: an in-process call needs no second
 * listener, no local token, and no base64 round trip, and it publishes the very
 * bytes the acceptance artifacts already assert on.
 *
 * Nothing capability-shaped is assembled here. The freshness quadruple's
 * `sourceToken` is deliberately never read, and `sourceSha256` identifies the
 * coordinates instead. `stripCapabilityFields` in the writer is the second net.
 */
const bridgeContext: { page?: Page; sessionId?: string; panelId?: string; renderToken?: number; structureId: string | null } = { structureId: null };
if (bridge) report.bridge = { enabled: true, revisions: [], skipped: [] };
const BRIDGE_OUTCOME: Record<string, 'applied' | 'queued' | 'rejected'> = {
  rendered: 'applied', queued: 'queued', rendering: 'queued',
  unconfirmed: 'rejected', conflict: 'rejected', expired: 'rejected', unknown: 'rejected',
};
// `lastCommand.detail` is bounded so no path, URL or sentence can ride along.
// A receipt whose `reason` is prose therefore publishes a null detail.
const BRIDGE_DETAIL = /^[a-z0-9_.:-]{1,64}$/;
/** The four-character PDB ID when the catalog label carries one, never a guess. */
function bridgeStructureId(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const name = label.split('/').pop()!.replace(/\.(cif|mmcif)$/i, '');
  return /^[0-9A-Za-z]{4}$/.test(name) ? name : null;
}
function bridgeCapture(captured: any, at: string): BridgeCaptureInput {
  const left = captured.eyes.find((eye: any) => eye.eye === 'left');
  assert.ok(left, 'A bridge capture needs the left eye crop.');
  return {
    at, width: captured.framebuffer.width, height: captured.framebuffer.height,
    views: captured.eyes.map((eye: any) => ({ eye: eye.eye, x: eye.viewport[0], y: eye.viewport[1],
      width: eye.viewport[2], height: eye.viewport[3] })),
    paired: dataUrlBytes(captured.paired.png), left: dataUrlBytes(left.png),
  };
}
/**
 * Write one revision. Pass the frame an assertion already captured to reuse
 * those exact pixels; pass nothing to read a fresh one from the live session.
 *
 * Reading a frame is best-effort, because a receipt can land while no XR
 * session is present and a bridge that fails the acceptance run for that would
 * be worse than a bridge that skips. A failed write is not swallowed: the
 * directory the assistant reads must never be quietly wrong.
 */
async function publishBridge(captured?: any, at?: string) {
  if (!bridge || !bridgeContext.sessionId || !bridgeContext.panelId) return;
  let frame = captured, moment = at;
  if (!frame) {
    const page = bridgeContext.page;
    if (!page) return;
    try {
      const live = await page.evaluate(() => {
        const active = (window as any).__companionXrTest?.active;
        return Boolean(active) && !active.ended;
      });
      if (!live) return;
      ({ captured: frame, at: moment } = await readXrCapture(page));
    } catch (error) {
      report.bridge.skipped.push((error as Error).message);
      return;
    }
  }
  const sessionId = bridgeContext.sessionId;
  const state = (await call('get_inspection_state', { sessionId })).structuredContent;
  const saved = await privateInspection(sessionId);
  assert.ok(saved.scene, 'The bridge publishes a saved scene, not an empty session.');
  const receipt = [...(state.commands ?? [])].at(-1);
  const written = await bridge.write({
    sessionId, serverEpoch: state.serverEpoch, panelId: bridgeContext.panelId, surface: 'companion',
    sourceSha256: saved.catalog.source.sha256, structureId: bridgeContext.structureId,
    stateRevision: state.stateRevision, inspectionRevision: state.inspectionRevision,
    renderToken: bridgeContext.renderToken ?? 0,
    representation: saved.scene.inspection.appearance.representation,
    selection: summariseSelection(saved.scene.selectionKeys),
    camera: saved.scene.camera,
    // Receipts carry no timestamp of their own, so this is the instant the
    // harness observed the outcome, not a server clock reading.
    lastCommand: receipt ? { commandId: receipt.commandId, outcome: BRIDGE_OUTCOME[receipt.status] ?? 'rejected',
      at: new Date().toISOString(), detail: BRIDGE_DETAIL.test(receipt.reason ?? '') ? receipt.reason : null } : null,
  }, bridgeCapture(frame, moment!));
  report.bridge.revisions.push(written.revision);
}

async function mountDesktop(html: string, opened: any) {
  const page = await browser!.newPage({ viewport: { width: 1120, height: 760 }, deviceScaleFactor: 1 });
  // tsx preserves function names with this helper inside serialized evaluate
  // callbacks. Supply it only in the test page, including its app iframe.
  await page.addInitScript({content:'globalThis.__name = value => value;'});
  page.setDefaultTimeout(120_000);
  page.on('pageerror', error => report.errors.push(error.message));
  watchPageEvidence(page, 'desktop');
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(desktopOrigin)) return route.continue();
    report.externalRequests.push(url); return route.abort();
  });
  await page.exposeFunction('__call', (payload: any) => callRaw(payload.name.replace(/^stereo_structure\./, ''), payload.arguments ?? {}));
  await page.goto(desktopOrigin);
  await page.evaluate(({ resource, result }) => (window as any).__host.mount(resource, result, { theme: 'dark' }), { resource: html, result: opened });
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  assert.ok(frame, 'The controlled host must create one app frame.');
  await page.waitForFunction(() => (window as any).__host.connected);
  return { page, frame };
}
/**
 * `lit` is an optional emphasis colour.
 *
 * A lesson's named part is drawn at full strength in its own colour while
 * everything else drops to context opacity, so counting pixels near that
 * colour separates "the panel still draws" from "the part the lesson named is
 * still the one lit". The tolerance is wide because the part is shaded.
 */
async function captureCanvas(owner: Page | Frame, page: Page, name: string, lit?: string) {
  const png = await owner.locator('.stage canvas').screenshot();
  assert.ok(png.length > 1_000 && png.length < 15 * 1024 * 1024, 'Expected a bounded rendered canvas image.');
  const file = `${name}.png`;
  await writeFile(resolve(out, file), png);
  const pixels = await page.evaluate(async ({ encoded, lit }) => {
    const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const values = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const background = [...values.slice(0, 3)]; let foreground = 0, litPixels = 0;
    const target = lit ? [1, 3, 5].map(offset => parseInt(lit.slice(offset, offset + 2), 16)) : undefined;
    for (let index = 0; index < values.length; index += 4) {
      if (background.some((value, channel) => Math.abs(value - values[index + channel]) > 10)) foreground++;
      if (target && target.every((value, channel) => Math.abs(value - values[index + channel]) < 72)) litPixels++;
    }
    return { width: canvas.width, height: canvas.height, background, foreground, ...(target ? { litPixels } : {}) };
  }, { encoded: png.toString('base64'), lit });
  report.screenshots.push({ file, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), ...pixels });
  return {...pixels,sha256:createHash('sha256').update(png).digest('hex')};
}

// Serialized into the isolated IWER page. It observes the production session
// and captures only when this test explicitly asks for the next completed XR
// frame. No hook or readback API is added to the production companion.
function installCompanionXrInstrumentation(installReferenceSpaceAdapter: (runtime: any) => any,
  headPose: { yawDegrees: number; position: { x: number; y: number; z: number } }) {
  const runtime = (window as any).IWER;
  const contexts = new Set<any>();
  const nativeBindFramebuffers = new WeakMap<any, any>();
  const drawStates = new WeakMap<any, { serial: number }>();
  const wrappedExtensions = new WeakSet<any>();
  let trace: any;
  const getContext: any = HTMLCanvasElement.prototype.getContext;
  (HTMLCanvasElement.prototype as any).getContext = function (kind: any, ...args: any[]) {
    const gl: any = getContext.call(this, kind, ...args);
    if (!gl || !['webgl', 'webgl2', 'experimental-webgl'].includes(kind) || contexts.has(gl)) return gl;
    contexts.add(gl);
    const nativeBindFramebuffer = gl.bindFramebuffer.bind(gl);
    nativeBindFramebuffers.set(gl, nativeBindFramebuffer);
    const drawState = { serial: 0 }; drawStates.set(gl, drawState);
    const wrapDraw = (owner: any, name: string) => {
      const native = owner?.[name];
      if (typeof native !== 'function') return;
      owner[name] = function (...drawArgs: any[]) { drawState.serial++; return native.apply(this, drawArgs); };
    };
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) wrapDraw(gl, name);
    const nativeGetExtension = gl.getExtension.bind(gl);
    gl.getExtension = function (name: string) {
      const extension = nativeGetExtension(name);
      if (extension && !wrappedExtensions.has(extension)) {
        wrappedExtensions.add(extension);
        for (const method of ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE', 'multiDrawArraysWEBGL',
          'multiDrawElementsWEBGL', 'multiDrawArraysInstancedWEBGL', 'multiDrawElementsInstancedWEBGL',
          'drawArraysInstancedBaseInstanceWEBGL', 'drawElementsInstancedBaseVertexBaseInstanceWEBGL',
          'multiDrawArraysInstancedBaseInstanceWEBGL', 'multiDrawElementsInstancedBaseVertexBaseInstanceWEBGL']) wrapDraw(extension, method);
      }
      return extension;
    };
    gl.bindFramebuffer = function (target: number, framebuffer: WebGLFramebuffer | null) {
      const active = trace?.active, layer = active?.session.renderState.baseLayer;
      if (active && framebuffer && framebuffer === layer?.framebuffer) {
        active.gl = gl; active.nativeBindFramebuffer = nativeBindFramebuffer;
      }
      return nativeBindFramebuffer(target, framebuffer);
    };
    return gl;
  };

  const crop = (rgba: Uint8Array, framebufferWidth: number, framebufferHeight: number,
    viewport: { x: number, y: number, width: number, height: number }) => {
    const { x, y, width, height } = viewport;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); if (!context) throw Error('2D canvas unavailable for XR evidence.');
    const image = context.createImageData(width, height);
    for (let destinationY = 0; destinationY < height; destinationY++) {
      const sourceY = y + height - 1 - destinationY;
      const sourceOffset = (sourceY * framebufferWidth + x) * 4;
      image.data.set(rgba.subarray(sourceOffset, sourceOffset + width * 4), destinationY * width * 4);
    }
    context.putImageData(image, 0, 0);
    const corners = [[x, y], [x + width - 1, y], [x, y + height - 1], [x + width - 1, y + height - 1]]
      .map(([sampleX, sampleY]) => Array.from(rgba.subarray((sampleY * framebufferWidth + sampleX) * 4,
        (sampleY * framebufferWidth + sampleX) * 4 + 4)));
    let foreground = 0; const colors = new Set<string>();
    // Saturated-pixel bounds include coloured UI as well as the molecule.
    // Keep this as image-content evidence. Molecular framing comes from the
    // production entry-standoff geometry and eye transforms, not this mask.
    let saturated = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    // The alpha channel is what the Quest compositor blends the
    // camera behind, so it is the only pixel signal that says whether the
    // wearer's room is showing. A transparent clear reads alpha 0 and a room
    // hidden by an opaque clear reads 255, in the same session either way.
    let transparent = 0, opaque = 0;
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) {
      const offset = (row * framebufferWidth + column) * 4;
      const pixel = [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
      if (colors.size < 256) colors.add(pixel.join(','));
      if (pixel[3] <= 8) transparent++; else if (pixel[3] >= 248) opaque++;
      if (corners.every(background => Math.max(...pixel.map((value, channel) => Math.abs(value - background[channel]))) > 10)) foreground++;
      if (pixel[3] > 8 && Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]) > 30) {
        saturated++;
        if (column - x < minX) minX = column - x;
        if (column - x > maxX) maxX = column - x;
        if (row - y < minY) minY = row - y;
        if (row - y > maxY) maxY = row - y;
      }
    }
    return { png: canvas.toDataURL('image/png'), width, height, foreground,
      colorsObservedUpTo256: colors.size, backgroundSamples: corners,
      clearAlpha: { transparent, opaque, total: width * height },
      saturatedContent: saturated > 0
        ? { pixels: saturated, minX, maxX, minY: height - 1 - maxY, maxY: height - 1 - minY,
          widthFraction: (maxX - minX + 1) / width, heightFraction: (maxY - minY + 1) / height }
        : { pixels: 0 } };
  };

  const captureFrame = (record: any, frame: any, drawCallsInCallback: number, drawSerial: number) => {
    const captureTiming = { startedAt: Date.now(), readbackMs: 0, totalMs: 0 };
    const captureStarted = performance.now();
    const layer = record.session.renderState.baseLayer;
    // IWER presents through the default framebuffer (`layer.framebuffer === null`).
    // Its layer context is therefore the authoritative rendering context; the
    // bind interceptor remains useful for runtimes that expose a non-null XR FBO.
    const gl = record.gl ?? layer?.context;
    const nativeBindFramebuffer = record.nativeBindFramebuffer ?? nativeBindFramebuffers.get(gl);
    if (!layer || !gl || !nativeBindFramebuffer || !record.space) throw Error('XR presentation framebuffer is not ready for capture.');
    const pose = frame.getViewerPose(record.space);
    if (!pose || pose.views.length !== 2) throw Error('XR capture requires two current eye views.');
    const headTransform = Array.from(pose.transform.matrix) as number[];
    if (headTransform.length !== 16 || !headTransform.every(Number.isFinite))
      throw Error('XR capture requires a current finite head transform.');
    const headYawDegrees = Math.atan2(headTransform[8], headTransform[10]) * 180 / Math.PI;
    const width = layer.framebufferWidth, height = layer.framebufferHeight;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw Error('Invalid XR framebuffer dimensions.');
    const drawingBuffer = { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
    if (layer.framebuffer === null && (drawingBuffer.width !== width || drawingBuffer.height !== height)) {
      throw Error('IWER XR layer dimensions do not match its default drawing buffer.');
    }
    const stageSize = record.stage && { width: record.stage.offsetWidth, height: record.stage.offsetHeight };
    if (!record.reviewViewport || width !== record.reviewViewport.width || height !== record.reviewViewport.height
      || stageSize?.width !== width || stageSize?.height !== height) {
      throw Error(`IWER review framebuffer changed: ${JSON.stringify({ expected: record.reviewViewport, drawingBuffer, stageSize })}`);
    }
    const webgl2 = typeof gl.readBuffer === 'function';
    const readTarget = webgl2 ? gl.READ_FRAMEBUFFER : gl.FRAMEBUFFER;
    const previousFramebuffer = gl.getParameter(webgl2 ? gl.READ_FRAMEBUFFER_BINDING : gl.FRAMEBUFFER_BINDING);
    const previousPackAlignment = gl.getParameter(gl.PACK_ALIGNMENT);
    const previousPackBuffer = webgl2 ? gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) : null;
    const previousRowLength = webgl2 ? gl.getParameter(gl.PACK_ROW_LENGTH) : null;
    const previousSkipRows = webgl2 ? gl.getParameter(gl.PACK_SKIP_ROWS) : null;
    const previousSkipPixels = webgl2 ? gl.getParameter(gl.PACK_SKIP_PIXELS) : null;
    const rgba = new Uint8Array(width * height * 4);
    try {
      nativeBindFramebuffer(readTarget, layer.framebuffer);
      if (webgl2) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      if (webgl2) {
        gl.pixelStorei(gl.PACK_ROW_LENGTH, 0); gl.pixelStorei(gl.PACK_SKIP_ROWS, 0); gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
      }
      if (gl.checkFramebufferStatus(readTarget) !== gl.FRAMEBUFFER_COMPLETE) throw Error('XR presentation framebuffer is incomplete.');
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      const error = gl.getError(); if (error !== gl.NO_ERROR) throw Error(`XR framebuffer readPixels failed with WebGL error ${error}.`);
    } finally {
      if (webgl2) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPackBuffer);
        gl.pixelStorei(gl.PACK_ROW_LENGTH, previousRowLength); gl.pixelStorei(gl.PACK_SKIP_ROWS, previousSkipRows);
        gl.pixelStorei(gl.PACK_SKIP_PIXELS, previousSkipPixels);
      }
      gl.pixelStorei(gl.PACK_ALIGNMENT, previousPackAlignment);
      nativeBindFramebuffer(readTarget, previousFramebuffer);
    }
    captureTiming.readbackMs = performance.now() - captureStarted;
    const viewports = pose.views.map((view: any) => {
      const viewport = layer.getViewport(view);
      return { eye: view.eye, x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height,
        // This eye's projection converts image-content spans into angles.
        // These simulator angles do not establish physical headset framing.
        projection: Array.from(view.projectionMatrix as Float32Array) };
    });
    for (const view of viewports) {
      const expectedX = view.eye === 'left' ? 0 : width / 2;
      if (!['left', 'right'].includes(view.eye) || view.x !== expectedX || view.y !== 0
        || view.width !== width / 2 || view.height !== height) throw Error('IWER review eye viewport changed.');
      if (view.projection.length !== 16 || !view.projection.every(Number.isFinite)
        || view.projection[0] <= 0 || view.projection[5] <= 0) throw Error('Invalid IWER eye projection.');
      // Depth fitting may change P[10]/P[14] as molecular bounds change. The
      // angular field and optical centre must stay fixed throughout a session.
      const angular = view.projection.filter((_value: number, index: number) => index !== 10 && index !== 14);
      const baseline = record.reviewProjections?.[view.eye];
      if (baseline && angular.some((value: number, index: number) => Math.abs(value - baseline[index]) > 1e-6)) {
        throw Error(`IWER ${view.eye} angular projection changed during the session.`);
      }
      record.reviewProjections ??= {};
      record.reviewProjections[view.eye] ??= angular;
    }
    const paired = crop(rgba, width, height, { x: 0, y: 0, width, height });
    const eyes = viewports.map((viewport: any) => {
      const cropped = crop(rgba, width, height, viewport);
      const bounds = cropped.saturatedContent as any;
      // clip.x = -z·(P[0]·u − P[8]) for u = x/(−z), so u = (ndc.x + P[8]) / P[0]
      // and the same in y with P[5] and P[9].
      const angle = (ndc: number, focal: number, offset: number) =>
        Math.atan((ndc + offset) / focal) * 180 / Math.PI;
      const ndcX = (pixel: number) => 2 * (pixel + .5) / viewport.width - 1;
      const ndcY = (pixel: number) => 1 - 2 * (pixel + .5) / viewport.height;
      const projection = viewport.projection;
      const degrees = bounds.pixels > 0 && Number.isFinite(projection?.[0]) && projection[0] !== 0 ? {
        width: Math.round((angle(ndcX(bounds.maxX), projection[0], projection[8])
          - angle(ndcX(bounds.minX), projection[0], projection[8])) * 10) / 10,
        height: Math.round((angle(ndcY(bounds.minY), projection[5], projection[9])
          - angle(ndcY(bounds.maxY), projection[5], projection[9])) * 10) / 10,
        fieldOfView: Math.round((angle(1, projection[0], projection[8]) - angle(-1, projection[0], projection[8])) * 10) / 10,
      } : null;
      return { eye: viewport.eye, viewport: [viewport.x, viewport.y, viewport.width, viewport.height], projection: viewport.projection,
        ...cropped, saturatedContent: { ...bounds, ...(degrees ? { degrees } : {}),
          scope: 'Saturated image pixels, including coloured UI; not isolated molecular bounds.' } };
    });
    captureTiming.totalMs = performance.now() - captureStarted;
    return { framebuffer: { width, height }, drawingBuffer, reviewViewport: record.reviewViewport, stageSize, captureTiming,
      capturedAfterProductionCallback: true,
      drawCallsInCallback, drawSerial, headTransform, headYawDegrees, paired, eyes };
  };

  const device = new runtime.XRDevice(runtime.metaQuest2);
  // Seat the emulated head before the page can request a session, so the very
  // first XRViewerPose the production code sees already carries this pose.
  device.position.set(headPose.position.x, headPose.position.y, headPose.position.z);
  const halfYaw = (headPose.yawDegrees * Math.PI) / 360;
  device.quaternion.set(0, Math.sin(halfYaw), 0, Math.cos(halfYaw));
  // The harness drives only the right controller. Keep idle fixture rays out
  // of label captures; each real press positions and releases the right hand.
  device.controllers.left.connected = false;
  device.controllers.right.position.set(4, 1.6, 0);
  device.installRuntime({ forceInstall: true }); device.stereoEnabled = true;
  const referenceAdapter = installReferenceSpaceAdapter(runtime);
  // Pin IWER's recursive display-pump callback by function identity during
  // session creation. The later window-rAF test can then allow precisely this
  // emulator callback without accidentally running a production callback.
  const nativeWindowRequestAnimationFrame = window.requestAnimationFrame.bind(window);
  const iwerPumpCallbacks = new Set<any>(); let recordingIwerPump = false;
  window.requestAnimationFrame = function (callback: FrameRequestCallback) {
    if (recordingIwerPump && callback.name === 'onDeviceFrame') iwerPumpCallbacks.add(callback);
    return nativeWindowRequestAnimationFrame(callback);
  };
  trace = (window as any).__companionXrTest = { device, referenceAdapter, active: null, sessions: [], contexts, iwerPumpCallbacks, longTasks: [],
    drawSerial: () => [...contexts].reduce((sum, gl) => sum + (drawStates.get(gl)?.serial ?? 0), 0),
    capture() {
      const active = trace.active;
      if (!active || active.ended) return Promise.reject(Error('No active production XR session to capture.'));
      if (active.captureRequest) return Promise.reject(Error('An XR capture is already pending.'));
      return new Promise((resolveCapture, rejectCapture) => {
        const timer = setTimeout(() => { active.captureRequest = null; rejectCapture(Error('Timed out waiting for a completed XR frame.')); }, 20_000);
        active.captureRequest = { resolve: resolveCapture, reject: rejectCapture, timer };
      });
    },
  };
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) trace.longTasks.push({
        startedAt: performance.timeOrigin + entry.startTime, durationMs: entry.duration,
      });
      if (trace.longTasks.length > 200) trace.longTasks.splice(0, trace.longTasks.length - 200);
    }).observe({ type: 'longtask' });
  }
  const system = (navigator as any).xr; const request = system.requestSession.bind(system);
  system.requestSession = async (mode: any, options?: any) => {
    let session: any; recordingIwerPump = true;
    try { session = await request(mode, options); } finally { recordingIwerPump = false; }
    const record: any = { mode, session, rafCount: 0, ended: false, poses: [], space: null, captureRequest: null, inputEvents: [],
      // Feature detection evidence: what the production page asked for, and
      // what this runtime granted. IWER filters unsupported optional features
      // out rather than rejecting, so the two lists differ on a real device.
      requestedFeatures: { required: [...(options?.requiredFeatures ?? [])], optional: [...(options?.optionalFeatures ?? [])] },
      enabledFeatures: [...(session.enabledFeatures ?? [])] };
    trace.active = record; trace.sessions.push(record);
    if (mode === 'immersive-vr' || mode === 'immersive-ar') {
      // IWER reparents the canvas and uses its default drawing buffer. Mol*
      // still sizes that canvas from the original stage when flat-page notices
      // change. Keep both sizing owners on the same test viewport for this
      // session; production/native headset layout is untouched.
      const stage = document.querySelector<HTMLElement>('.stage');
      if (!stage) { await session.end(); throw Error('IWER review requires the original molecular stage.'); }
      const originalStyle = stage.getAttribute('style');
      const viewport = { width: innerWidth, height: innerHeight };
      record.stage = stage; record.reviewViewport = viewport;
      for (const [property, value] of Object.entries({ position: 'fixed', inset: '0',
        width: `${viewport.width}px`, height: `${viewport.height}px`,
        'min-width': `${viewport.width}px`, 'max-width': `${viewport.width}px`,
        'min-height': `${viewport.height}px`, 'max-height': `${viewport.height}px`,
        'box-sizing': 'border-box', border: '0', padding: '0', margin: '0' })) stage.style.setProperty(property, value, 'important');
      session.addEventListener('end', () => {
        if (originalStyle === null) stage.removeAttribute('style');
        else stage.setAttribute('style', originalStyle);
        window.dispatchEvent(new Event('resize'));
      }, { once: true });
    }
    // Squeeze is the grip push-to-talk edge, so a run that never records one
    // proves the wearer's grip never reached the page.
    for (const type of ['selectstart', 'select', 'selectend',
      'squeezestart', 'squeeze', 'squeezeend', 'squeezecancel']) session.addEventListener(type, (event: any) => {
      record.inputEvents.push({ type, handedness: event.inputSource?.handedness, frame: record.rafCount });
      if (record.inputEvents.length > 64) record.inputEvents.shift();
    });
    session.requestReferenceSpace('local').then((space: any) => { record.space = space; }).catch(() => {});
    const originalRaf = session.requestAnimationFrame.bind(session);
    session.requestAnimationFrame = (callback: any) => originalRaf((time: number, frame: any) => {
      record.rafCount++;
      try {
        const pose = record.space && frame.getViewerPose(record.space);
        if (pose?.views?.length) record.poses.push({ time, views: pose.views.map((view: any) => ({ eye: view.eye,
          position: { x: view.transform.position.x, y: view.transform.position.y, z: view.transform.position.z } })) });
        if (record.poses.length > 24) record.poses.shift();
      } catch { /* Pose diagnostics must not perturb the production callback. */ }
      const layerBefore = record.session.renderState.baseLayer;
      const callbackGl = record.gl ?? layerBefore?.context;
      const drawBefore = drawStates.get(callbackGl)?.serial ?? 0;
      let result;
      try { result = callback(time, frame); }
      catch (error) {
        if (record.captureRequest) { clearTimeout(record.captureRequest.timer); record.captureRequest.reject(error); record.captureRequest = null; }
        throw error;
      }
      const layerAfter = record.session.renderState.baseLayer;
      const renderedGl = record.gl ?? layerAfter?.context;
      const drawAfter = drawStates.get(renderedGl)?.serial ?? 0;
      // Toolbar pose sampling and deferred-action callbacks share the XR rAF
      // queue with Mol* but issue no GL draws. Keep a capture pending until a
      // callback actually renders into the presentation context.
      if (record.captureRequest && drawAfter > drawBefore) {
        const pending = record.captureRequest; record.captureRequest = null; clearTimeout(pending.timer);
        try { pending.resolve(captureFrame(record, frame, drawAfter - drawBefore, drawAfter)); } catch (error) { pending.reject(error); }
      }
      return result;
    });
    session.addEventListener('end', () => {
      record.ended = true;
      if (record.captureRequest) {
        clearTimeout(record.captureRequest.timer); record.captureRequest.reject(Error('XR session ended before capture.')); record.captureRequest = null;
      }
      if (trace.active === record) trace.active = null;
    });
    return session;
  };
}

/**
 * The immersive mode the run actually entered, or null before entry.
 *
 * The review-crop bound in `captureXrFramebuffer` depends on it, and that
 * function is reached from every capture site rather than passed a session.
 */
let immersiveEntryMode: string | null = null;

const pngDimensions = (bytes: Buffer) => {
  assert.equal(bytes.readUInt32BE(0), 0x89504e47, 'XR artifact is not a PNG.');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};
const dataUrlBytes = (value: string) => {
  assert.ok(value.startsWith('data:image/png;base64,'), 'XR capture did not return a PNG data URL.');
  return Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
};
/** One both-eye read from the production XR presentation framebuffer, and when it happened. */
async function readXrCapture(page: Page): Promise<{ captured: any, at: string }> {
  const captured = await page.evaluate(() => (window as any).__companionXrTest.capture());
  return { captured, at: new Date().toISOString() };
}
/**
 * How much of one colour the wearer's own eye is showing.
 *
 * `captureCanvas` counts this on the desktop stage, which a presenting session
 * does not draw into: in immersion the only pixels a wearer sees are the XR
 * framebuffer's. A lesson holds its named part at full strength in its own
 * colour while everything else drops to context opacity, so counting pixels
 * near that colour is the difference between "the part is lit" and "the part is
 * a ghost". The tolerance matches `captureCanvas` because the part is shaded.
 */
async function litPixelsInXrEye(page: Page, colour: string, label: string) {
  const { captured } = await readXrCapture(page);
  const eye = captured.eyes.find((candidate: any) => candidate.eye === 'left');
  assert.ok(eye, `No left eye to measure ${label} in.`);
  const measured = await page.evaluate(async ({ encoded, colour }) => {
    const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const values = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const target = [1, 3, 5].map(offset => parseInt(colour.slice(offset, offset + 2), 16));
    let litPixels = 0, pixels = 0;
    for (let index = 0; index < values.length; index += 4) {
      pixels++;
      if (target.every((value, channel) => Math.abs(value - values[index + channel]) < 72)) litPixels++;
    }
    return { litPixels, pixels };
  }, { encoded: dataUrlBytes(eye.png).toString('base64'), colour });
  return { label, colour, ...measured };
}
async function captureXrFramebuffer(page: Page, name: string) {
  const { captured, at: capturedAt } = await readXrCapture(page);
  const drawnRows = await livePanelRows(page);
  if (drawnRows) {
    report.emulatedXr.toolbarFrames ??= [];
    const collapse = drawnRows.find(row => row.action?.kind === 'collapse')?.action;
    report.emulatedXr.toolbarFrames.push({ label: name, rows: drawnRows.map(row => row.label),
      collapsed: collapse?.value === false, drawnRowPoints: drawnRows.map(row => row.point) });
  }
  assert.deepEqual(captured.eyes.map((eye: any) => eye.eye).sort(), ['left', 'right']);
  assert.ok(captured.framebuffer.width > 0 && captured.framebuffer.height > 0);
  assert.deepEqual(captured.drawingBuffer, captured.framebuffer, 'Pinned IWER capture must use the actual XR drawing buffer.');
  assert.deepEqual(captured.framebuffer, captured.reviewViewport, 'The XR framebuffer must retain its configured session dimensions.');
  assert.deepEqual(captured.stageSize, captured.reviewViewport, 'Flat-page changes must not resize the IWER stage.');
  assert.equal(captured.capturedAfterProductionCallback, true);
  assert.ok(Number.isSafeInteger(captured.drawCallsInCallback) && captured.drawCallsInCallback > 0,
    'XR evidence must follow a callback that issued presentation GL draws.');
  assert.ok(Number.isSafeInteger(captured.drawSerial) && captured.drawSerial >= captured.drawCallsInCallback);
  for (const eye of captured.eyes) {
    const [x, y, width, height] = eye.viewport;
    assert.ok([x, y, width, height].every(Number.isInteger) && x >= 0 && y >= 0 && width > 0 && height > 0
      && x + width <= captured.framebuffer.width && y + height <= captured.framebuffer.height, `Invalid ${eye.eye} XR viewport.`);
    assert.ok(eye.foreground > 100 && eye.colorsObservedUpTo256 > 1, `${eye.eye} eye lacks rendered XR content.`);
  }
  const [first, second] = captured.eyes.map((eye: any) => eye.viewport);
  assert.ok(first[0] + first[2] <= second[0] || second[0] + second[2] <= first[0]
    || first[1] + first[3] <= second[1] || second[1] + second[3] <= first[1], 'XR eye viewports overlap.');

  const pairedBytes = dataUrlBytes(captured.paired.png);
  const pairDimensions = pngDimensions(pairedBytes);
  assert.deepEqual(pairDimensions, captured.framebuffer, 'Paired diagnostic was CSS-scaled or cropped.');
  assert.ok(pairedBytes.length > 1_000 && pairedBytes.length < 30 * 1024 * 1024, 'Expected a bounded paired XR image.');
  const pairedFile = `${name}.png`; await writeFile(resolve(out, pairedFile), pairedBytes);
  const eyeRecords = captured.eyes.map((eye: any) => {
    const bytes = dataUrlBytes(eye.png), dimensions = pngDimensions(bytes);
    assert.deepEqual(dimensions, { width: eye.viewport[2], height: eye.viewport[3] }, `${eye.eye} eye crop changed its aspect.`);
    return { eye: eye.eye, viewport: eye.viewport, projection: eye.projection, width: dimensions.width, height: dimensions.height,
      aspectRatio: dimensions.width / dimensions.height, foreground: eye.foreground,
      colorsObservedUpTo256: eye.colorsObservedUpTo256, bytes: bytes.length,
      // Whether this frame let the wearer's room through.
      clearAlpha: eye.clearAlpha, backgroundSamples: eye.backgroundSamples,
      // Image-content bounds may include menu buttons and captions.
      saturatedContent: eye.saturatedContent,
      sha256: createHash('sha256').update(bytes).digest('hex'), bytesValue: bytes };
  });
  const left = eyeRecords.find((eye: any) => eye.eye === 'left')!;
  // Review captures retain the configured 1120 x 630 eye in both entry modes.
  // The small controller-only viewport tests input behavior rather than optics.
  for (const eye of eyeRecords) assert.ok(controllerInputOnly || (eye.aspectRatio >= 0.8 && eye.aspectRatio <= 1.8),
    `${eye.eye} review crop must retain a headset-like aspect ratio in the configured IWER run.`);
  assert.ok(left.bytes > 1_000 && left.bytes < 15 * 1024 * 1024);
  const leftFile = `${name}-left-eye.png`; await writeFile(resolve(out, leftFile), left.bytesValue);
  const pairedSha256 = createHash('sha256').update(pairedBytes).digest('hex');
  const publicEyes = eyeRecords.map(({ bytesValue: _bytesValue, ...eye }: any) => eye);
  const pairedRecord = { file: pairedFile, bytes: pairedBytes.length, sha256: pairedSha256,
    kind: 'emulated_xr_raw_paired_framebuffer', ...pairDimensions, drawingBuffer: captured.drawingBuffer,
    reviewViewport: captured.reviewViewport, stageSize: captured.stageSize, captureTiming: captured.captureTiming,
    capturedAfterProductionCallback: true, drawCallsInCallback: captured.drawCallsInCallback,
    drawSerial: captured.drawSerial, headTransform: captured.headTransform,
    headYawDegrees: captured.headYawDegrees, eyes: publicEyes };
  const leftRecord = { file: leftFile, bytes: left.bytes, sha256: left.sha256, kind: 'emulated_xr_left_eye_review',
    eye: 'left', width: left.width, height: left.height, aspectRatio: left.aspectRatio,
    sourceViewport: left.viewport, foreground: left.foreground, colorsObservedUpTo256: left.colorsObservedUpTo256 };
  report.screenshots.push(pairedRecord, leftRecord);
  // Publish the same asserted pixels rather than reading a second frame, so
  // the bridge and the acceptance artifacts can never disagree.
  await publishBridge(captured, capturedAt);
  return { sha256: pairedSha256, paired: pairedRecord, leftEye: leftRecord, eyes: publicEyes };
}

/**
 * Write both eye crops of the frame on screen as `step-NN-left.png` and
 * `step-NN-right.png`, so a lesson can be paged through one scene at a time
 * and what a wearer sees change between them is visible.
 *
 * The left-eye artifact `captureXrFramebuffer` already writes is one frame of
 * one moment in a whole acceptance run; these are the per-scene series.
 */
async function captureTourStepEyes(page: Page, directory: string, step: number, label: string) {
  const { captured } = await readXrCapture(page);
  const prefix = `step-${String(step).padStart(2, '0')}`;
  const eyes = await Promise.all(captured.eyes.map(async (eye: any) => {
    const bytes = dataUrlBytes(eye.png), file = `${prefix}-${eye.eye}.png`;
    assert.ok(eye.foreground > 100 && eye.colorsObservedUpTo256 > 1,
      `${eye.eye} eye rendered nothing at scene ${step}.`);
    await writeFile(resolve(directory, file), bytes);
    return { eye: eye.eye, file, bytes: bytes.length, foreground: eye.foreground,
      colorsObservedUpTo256: eye.colorsObservedUpTo256,
      // Coloured content may include UI; use geometry evidence for framing.
      saturatedContent: eye.saturatedContent,
      sha256: createHash('sha256').update(bytes).digest('hex'), ...pngDimensions(bytes) };
  }));
  assert.deepEqual(eyes.map(eye => eye.eye).sort(), ['left', 'right'], `Scene ${step} did not produce both eyes.`);
  return { step, label, eyes };
}

// Toolbar targets come from the production toolbar modules, never from a row
// index pinned in this harness. Tour rows appear and disappear with live tour
// state, so every pinned index goes stale the moment a row is added or
// removed, and the controller then presses a neighbouring control instead.
const LAB_ROUNDTRIP = resolve(dirname(fileURLToPath(import.meta.url)), '../../lab/browser-roundtrip');
const { createToolbarPanel, hitToolbarPanel, SPATIAL_TOOLBAR_LAYOUT } =
  await import(pathToFileURL(resolve(LAB_ROUNDTRIP, 'spatial-toolbar-geometry.mjs')).href) as any;
const { spatialToolbarRows, spatialToolbarRowIndex } =
  await import(pathToFileURL(resolve(LAB_ROUNDTRIP, 'spatial-toolbar-content.mjs')).href) as any;
// The panel is anchored at the immersive entry pose and stays there while the
// wearer moves. That pose is the session `local` reference space's own origin --
// the viewer where the session started, facing the harness yaw -- and the page
// publishes its seats in that frame, so the fallback model below is laid out
// against the same head. `pressXrToolbar` carries the seat back into IWER
// device space through the live viewer pose before aiming; the controller sits
// 0.3 m in front of the panel along the local -Z the seat was solved for.
const XR_TOOLBAR_HEAD_YAW = (headYawDegrees * Math.PI) / 180;
const XR_TOOLBAR_HEAD = Object.freeze({ position: { x: 0, y: 0, z: 0 },
  matrix: [Math.cos(XR_TOOLBAR_HEAD_YAW), 0, -Math.sin(XR_TOOLBAR_HEAD_YAW), 0, 0, 1, 0, 0,
    Math.sin(XR_TOOLBAR_HEAD_YAW), 0, Math.cos(XR_TOOLBAR_HEAD_YAW), 0, 0, 0, 0, 1] });
const XR_CONTROLLER_Z = -0.3;
const XR_TOOLBAR_PANEL_Z = -SPATIAL_TOOLBAR_LAYOUT.forwardMeters;
type ToolbarQuery = string | Record<string, unknown>;
// The row-shaping tour state the spatial toolbar derives its rows from, read
// from the active player's public DOM and the toolbar's read-only state seam.
async function currentTour(page: Page): Promise<any> {
  const state = await page.evaluate(() => (globalThis as any).__stereofoldMenu?.state()?.tour);
  assert.ok(state, 'The immersive toolbar must expose its current tour state.');
  return state;
}
async function waitCurrentTour(page: Page, predicate: (state: any) => boolean) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await currentTour(page);
    if (predicate(state)) return state;
    await delay(100);
  }
  throw Error(`Timed out waiting for the current tour: ${JSON.stringify(await currentTour(page))}`);
}
async function readTourToolbarState(page: Page) {
  const state = await page.evaluate(() => {
    const root = document.querySelector('.tour-player:not([hidden]), .experience-player:not([hidden])') as HTMLElement | null;
    const current = (globalThis as any).__stereofoldMenu?.state()?.tour;
    const enabled = (selector: string) => {
      const button = document.querySelector(selector);
      return button instanceof HTMLButtonElement ? !button.disabled : null;
    };
    const paged = current ? [current.bodyPageIndex + 1, current.bodyPageCount] : (root?.dataset.tourReadoutPage ?? '').split('/').map(Number);
    const menu = document.querySelector('.tour-player:not([hidden]) [data-tour-menu], .experience-player:not([hidden]) [data-experience-menu]');
    // The companion's voice panel mirrors `voiceInteraction.state()`, which is
    // what `getSpatialState` hands the toolbar. Without it these rows are one
    // short of the live panel and every target below lands on its neighbour.
    const voicePanel = document.querySelector('.voice-panel') as HTMLElement | null;
    return { present: Boolean(root), active: current?.active ?? root?.dataset.active === 'true', autoplay: current?.autoplay ?? root?.dataset.autoplay === 'true',
      voiceState: voicePanel ? voicePanel.dataset.voiceState ?? 'idle' : null,
      selectedId: menu instanceof HTMLSelectElement && menu.value ? menu.value : null,
      menuOpen: current?.menuOpen ?? root?.dataset.menuOpen === 'true',
      bodyPageIndex: paged.length === 2 && Number.isSafeInteger(paged[0]) ? paged[0] - 1 : null,
      bodyPageCount: paged.length === 2 && Number.isSafeInteger(paged[1]) ? paged[1] : null,
      canBack: enabled('.tour-player:not([hidden]) [data-tour-back], .experience-player:not([hidden]) [data-experience-back]'), canNext: enabled('.tour-player:not([hidden]) [data-tour-next], .experience-player:not([hidden]) [data-experience-next]') };
  });
  assert.ok(state.present, 'The tour player is not mounted, so the live spatial toolbar rows cannot be derived.');
  assert.ok(state.canBack !== null && state.canNext !== null && state.bodyPageIndex !== null
    && state.bodyPageCount !== null && state.bodyPageCount >= 1,
    'The public tour DOM did not report the state that shapes the spatial toolbar rows.');
  return state;
}
/**
 * Physical XR-local target for one toolbar control, resolved by label or by
 * action id against the live rows the production content module produces and
 * the physical layout the production geometry module computes. `query` may be
 * a list of alternatives; the first present row wins. A control that is not on
 * the current toolbar fails here rather than pressing whatever sits nearby.
 */
interface LivePanelRow { label: string; action: Record<string, unknown> | null; targetable: boolean; point: number[] }
/**
 * The rows the drawn panel last published, in XR-local metres.
 *
 * `spatial-toolbar.mjs` records these on every committed redraw, so they are
 * the panel as the wearer has it: the rows it holds now, the labels they carry
 * now, and the seats they occupy now. Each redraw is published as chunks of
 * parallel arrays (`labels`, `actions` as JSON, `targetable`, `x`, `y`, `z`)
 * sharing one `draw` sequence number, because the diagnostics ring keeps at
 * most eight items per array and drops anything nested two deep. This takes
 * the newest COMPLETE draw and ignores a redraw still mid-publish, so a
 * reader never aims at half a panel. `undefined` means the panel has not been
 * drawn yet in this session.
 *
 * These seats are what `pressXrToolbar` aims at: they are the
 * `createToolbarPanel` button points in XR reference space, whose anchor moves
 * in x AND z with the widest label. Aiming them needs no model of the labels,
 * the row count, the entry head or the stand-off -- which is the whole point,
 * because the Node-side shadow below knows none of those exactly.
 */
async function livePanelRows(page: Page): Promise<LivePanelRow[] | undefined> {
  // The production ring may evict an unchanged draw during long native input
  // sequences. Observe its real row publications before they can be evicted;
  // never reconstruct live targets from the incomplete Node-side row model.
  const records = await page.evaluate(observeToolbarRows) as any[];
  const chunks = records.filter(record => record.phase === 'rows' && Array.isArray(record.labels));
  const draws = [...new Set(chunks.map(record => record.draw))].sort((first, second) => second - first);
  for (const draw of draws) {
    const parts = chunks.filter(record => record.draw === draw)
      .sort((first, second) => first.from - second.from);
    const total = parts[0]?.total;
    const labels = parts.flatMap(part => part.labels as unknown[]);
    // A redraw still mid-publish is half a panel and seats nothing reliably.
    // The observer retains only the newest draw, so incomplete means unavailable.
    if (!Number.isSafeInteger(total) || total === 0 || labels.length !== total) continue;
    const actions = parts.flatMap(part => Array.isArray(part.actions) ? part.actions : []);
    const targetable = parts.flatMap(part => Array.isArray(part.targetable) ? part.targetable : []);
    const xs = parts.flatMap(part => Array.isArray(part.x) ? part.x : []);
    const ys = parts.flatMap(part => Array.isArray(part.y) ? part.y : []);
    const zs = parts.flatMap(part => Array.isArray(part.z) ? part.z : []);
    if ([actions, targetable, xs, ys, zs].some(column => column.length !== total)) continue;
    const rows = labels.map((label, index) => {
      let action: Record<string, unknown> | null = null;
      try { action = actions[index] == null ? null : JSON.parse(actions[index] as string); }
      catch { action = null; }
      return { label: label as string, action,
        targetable: (targetable as unknown[])[index] === true,
        point: [xs[index] as number, ys[index] as number, zs[index] as number] };
    });
    if (rows.some(row => typeof row.label !== 'string'
      || !Array.isArray(row.point) || !row.point.every(Number.isFinite))) continue;
    return rows;
  }
  return undefined;
}

/**
 * The labels the drawn panel last published, in row order, or `undefined`.
 *
 * Read off the same reassembled redraw as `livePanelRows`, so the
 * row-identity guard compares the name the panel drew rather than the name
 * the Node-side model built. The model is handed no live passthrough state,
 * so it can name that row `Room` where the panel the wearer sees names it
 * `Room on`; comparing the drawn name keeps a correct press from failing on
 * a stale name.
 */
async function drawnPanelLabels(page: Page): Promise<string[] | undefined> {
  return (await livePanelRows(page))?.map(row => row.label);
}
/**
 * Wait for the full draw to publish the wanted row.
 *
 * The wake press is consumed — it records no `toolbar-action` — and the full
 * rows arrive with the rebuild it triggers, so poll the published draws until
 * one of them holds the row again. `undefined` on timeout; the caller then
 * fails on the same loud assertion as a row that was never there.
 */
async function waitLivePanelRows(page: Page, candidates: ToolbarQuery[], timeoutMs = 30_000): Promise<LivePanelRow[] | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const live = await livePanelRows(page);
    if (live && candidates.some(candidate => spatialToolbarRowIndex(live, candidate) >= 0)) return live;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
/**
 * Where to aim the press that wakes the full draw.
 *
 * The live panel is showing the quiet draw, so the wanted row has no live
 * seat. The Node-side model builds the FULL set from the same tour state the
 * public DOM reports — but the model knows nothing of the live stand-off, so
 * its seats can sit decimetres off the drawn plate. The published quiet seats
 * do carry the stand-off, so take the translation between the live and model
 * seats of one row both draws hold (`Menu`) and carry it onto the wanted
 * row's model seat: close enough for a plate-sized wake press, which the page
 * consumes without firing a row. `undefined` when the model lacks the row too,
 * so the caller fails loudly instead of waking at a guess.
 */
async function fullDrawWakeTarget(page: Page, collapsed: boolean, candidates: ToolbarQuery[], liveRows: LivePanelRow[]) {
  const full = await modelPanelRows(page, collapsed);
  for (const candidate of candidates) {
    const at = spatialToolbarRowIndex(full, candidate);
    if (at < 0 || !full[at].targetable) continue;
    const point = full[at].point;
    const standoff = await liveStandoffOffset(page, collapsed, liveRows);
    const target = standoff
      ? { x: point[0] + standoff.dx, y: point[1] + standoff.dy, z: point[2] + standoff.dz }
      : { x: point[0], y: point[1], z: point[2] };
    return { label: full[at].label, target };
  }
  return undefined;
}
/**
 * The live-minus-model translation both draws share.
 *
 * One row both the published quiet draw and the models hold, differenced
 * between its live seat (stand-off and all) and its model-quiet seat (same
 * content, raw constants). `undefined` when the draws share no row, and the
 * caller wakes at the uncorrected model seat.
 */
async function liveStandoffOffset(page: Page, collapsed: boolean, liveRows: LivePanelRow[]) {
  const quiet = await modelPanelRows(page, collapsed, true);
  const shared = ['Menu', ...quiet.map(row => row.label)]
    .find(label => quiet.some(row => row.label === label) && liveRows.some(row => row.label === label));
  if (!shared) return undefined;
  const modelPoint = quiet.find(row => row.label === shared)!.point;
  const livePoint = liveRows.find(row => row.label === shared)!.point;
  if (!livePoint.every(Number.isFinite)) return undefined;
  return { dx: livePoint[0] - modelPoint[0], dy: livePoint[1] - modelPoint[1], dz: livePoint[2] - modelPoint[2] };
}
/**
 * Wait until the wanted action is a pressable row again.
 *
 * A resolved row can be a state chip right now — `Loading…` while the tour
 * navigates to the scene the previous press asked for. That is transient: the
 * scene lands and the row becomes pressable, so poll the published draws for
 * one where the action resolves to a targetable row. `undefined` on timeout;
 * the caller then fails on the same loud assertion as a row that was never
 * pressable.
 */
async function waitPressablePanelRows(page: Page, candidates: ToolbarQuery[], timeoutMs = 30_000): Promise<LivePanelRow[] | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const live = await livePanelRows(page);
    if (live) {
      for (const candidate of candidates) {
        const at = spatialToolbarRowIndex(live, candidate);
        if (at >= 0 && live[at].targetable) return live;
      }
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
/**
 * The row model this harness aims with, rebuilt in Node from the tour state the
 * public DOM reports.
 *
 * Only for the frames before the panel has drawn once, and `toolbarTarget`
 * waits for that first draw rather than reaching for this. It is a shadow of
 * the page's own layout and it drifts: the seat is content-dependent now, so a
 * model whose widest label or row count differs moves the ENTIRE panel in x
 * and z and the ray misses it altogether (glass3: `Page 1/50` present seats
 * x -0.4236 z -0.8503, absent seats x -0.4467 z -0.8384). Before the seat
 * moved, the same drift only ever hit the wrong row.
 */
async function modelPanelRows(page: Page, collapsed: boolean, quiet = false): Promise<LivePanelRow[]> {
  const live = await readTourToolbarState(page);
  const rows = spatialToolbarRows({ collapsed, mode: 'move', paused: true,
    ...(quiet ? { quiet: true } : {}),
    ...(live.voiceState ? { voice: { state: live.voiceState } } : {}),
    tour: { active: live.active, autoplay: live.autoplay, menuOpen: live.menuOpen, navigating: false,
      canBack: live.canBack, canNext: live.canNext, bodyPageIndex: live.bodyPageIndex,
      bodyPageCount: live.bodyPageCount, selectedId: live.selectedId ?? undefined } });
  const panel = createToolbarPanel({ rows, head: XR_TOOLBAR_HEAD, constants: SPATIAL_TOOLBAR_LAYOUT });
  assert.equal(panel?.buttons?.length, rows.length, 'The production toolbar geometry did not lay out every live row.');
  // The production hit test, on the harness's own layout, so a modelled target
  // can never silently drift even before the page has published its rows.
  return panel.buttons.map((button: any) => {
    // A state chip is drawn recessed and the panel's own hit test refuses it,
    // so requiring a ray to land on one fails the whole model over a row
    // nobody can press. `Answering…` is exactly that: the voice row turns into
    // a chip while a reply is playing, and in this emulator no audio ever ends
    // it, so every later press in the run died building the row model rather
    // than on anything a wearer would notice. `toolbarTarget` refuses a chip
    // as a target on its own.
    const hit = button.targetable === true
      ? hitToolbarPanel(panel, { origin: [button.point[0], button.point[1], XR_CONTROLLER_Z], direction: [0, 0, -1] })
      : button;
    assert.ok(hit === button, `The controller ray for ${button.label} does not hit that toolbar row; it hits ${hit?.label ?? 'nothing'}.`);
    return { label: button.label, action: button.action ?? null, targetable: button.targetable === true, point: button.point };
  });
}
async function toolbarTarget(page: Page, collapsed: boolean, query: ToolbarQuery | ToolbarQuery[]) {
  // Prefer the panel as drawn: the seat follows the widest label, so only the
  // live geometry aims exactly. Before the first committed redraw there is
  // nothing published yet, so wait for that first draw. A missing observation
  // must fail closed rather than aim at a different row in the shadow model.
  let published = await livePanelRows(page);
  if (!published) {
    const deadline = Date.now() + 20_000;
    while (!published && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      published = await livePanelRows(page);
    }
  }
  assert.ok(published, 'No complete live toolbar draw was observed; refusing a modelled controller target.');
  const source = 'page';
  let rows = published;
  const drawnCollapsed = (list: LivePanelRow[]) => {
    const action = list.find(row => row.action?.kind === 'collapse')?.action;
    return typeof action?.value === 'boolean' ? !action.value : collapsed;
  };
  collapsed = drawnCollapsed(rows);
  const candidates = Array.isArray(query) ? query : [query];
  const resolveRow = (list: LivePanelRow[]) => {
    for (const candidate of candidates) {
      const at = spatialToolbarRowIndex(list, candidate);
      if (at >= 0) return { index: at, matched: candidate as ToolbarQuery };
    }
    return { index: -1, matched: undefined as ToolbarQuery | undefined };
  };
  let resolved = resolveRow(rows);
  let wokeFor: string | undefined;
  if (resolved.index < 0 && published) {
    // The published draw is the quiet one and the wanted row's
    // seat is vacated — resolving here would press a neighbour or nothing, and
    // a press that already missed did exactly that (selectstart hit:null). Wake
    // first with a consumed press at the model seat, then re-read the live rows
    // and re-resolve from the new draw. `pressXrToolbarWhenReady` presses again
    // on the target this returns.
    const wanted = candidates.map(candidate => typeof candidate === 'string' ? candidate : (candidate as any)?.kind ?? '?').join('|');
    await waitToolbarQuiet(page);
    wokeFor = wanted;
    const wakeTarget = await fullDrawWakeTarget(page, collapsed, candidates, published);
    if (wakeTarget) {
      await pressXrToolbar(page, `Wake menu for ${wanted}`, wakeTarget.target);
      report.emulatedXr.toolbarWakePresses ??= [];
      report.emulatedXr.toolbarWakePresses.push({ wanted, target: wakeTarget.target, modelLabel: wakeTarget.label });
      const woken = await waitLivePanelRows(page, candidates);
      if (woken) {
        rows = woken;
        resolved = resolveRow(rows);
      }
    }
  }
  if (resolved.index >= 0 && !rows[resolved.index].targetable) {
    // The action resolved to a state chip — `Loading…` while the tour lands
    // the scene the previous press asked for. Pressing a chip is refused by
    // the panel's own hit test, but the chip is transient, so wait for the
    // draw where this action is pressable again and re-resolve from it. Still
    // a chip after the wait, and the targetable assertion below fails loudly.
    const pressable = await waitPressablePanelRows(page, candidates);
    if (pressable) {
      rows = pressable;
      resolved = resolveRow(rows);
    }
  }
  const { index, matched } = resolved;
  collapsed = drawnCollapsed(rows);
  const labels = rows.map(row => row.label);
  assert.ok(index >= 0, `No spatial toolbar row matches ${JSON.stringify(candidates)}; the ${source === 'page' ? 'drawn' : 'modelled'} rows are ${JSON.stringify(labels)}.${wokeFor ? ` A wake press for ${wokeFor} did not bring the full draw back.` : ''}`);
  const row = rows[index];
  assert.ok(row.targetable, `The spatial toolbar row ${row.label} is a state chip, which the panel's own hit test refuses.`);
  assert.ok(Array.isArray(row.point) && row.point.length === 3 && row.point.every(Number.isFinite),
    `The spatial toolbar row ${row.label} reported no seat to aim at.`);
  const target = { x: row.point[0], y: row.point[1], z: row.point[2] };
  report.emulatedXr.toolbarTargets ??= [];
  report.emulatedXr.toolbarTargets.push({ query: matched ?? null, label: row.label,
    modelLabel: row.label, drawnLabel: row.label, collapsed, source, rows: labels,
    ...(source === 'page' ? { drawnRowPoints: rows.map(row => row.point) } : {}), target });
  return target;
}
/**
 * A microphone the harness can grant, refuse, and feed.
 *
 * It replaces `navigator.mediaDevices.getUserMedia` and `MediaRecorder` only.
 * Everything downstream of them — the talk binding, the chunk
 * streamer, the authenticated `/tool` route — is the production code the
 * headset runs. `window.__stereofoldMicTest.mode` switches between refusing
 * and granting; `speak()` delivers a timeslice the way Quest Browser would.
 */
function installCompanionMicrophoneStub() {
  const control: any = { mode: 'deny', calls: 0, recorders: [] as any[],
    speak(bytes = new Uint8Array([1, 2, 3])) {
      const recorder = control.recorders[control.recorders.length - 1];
      recorder?.ondataavailable?.({ data: { arrayBuffer: async () => bytes.buffer } });
    } };
  (window as any).__stereofoldMicTest = control;
  const track = () => ({ kind: 'audio', readyState: 'live', enabled: true, stop() { (this as any).readyState = 'ended'; } });
  const devices = { async getUserMedia() {
    control.calls += 1;
    if (control.mode === 'deny') throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    const tracks = [track()];
    return { getTracks: () => tracks, getAudioTracks: () => tracks };
  } };
  try { Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => devices }); }
  catch { /* A browser that refuses the override leaves the real one in place. */ }
  class StubRecorder {
    static isTypeSupported(type: string) { return type === 'audio/webm;codecs=opus'; }
    state = 'inactive';
    mimeType: string;
    ondataavailable: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(_stream: unknown, options?: { mimeType?: string }) {
      this.mimeType = options?.mimeType ?? 'audio/webm;codecs=opus';
      control.recorders.push(this);
    }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  (window as any).MediaRecorder = StubRecorder;
}
/** Diagnostics the page recorded, newest last, for one kind. */
async function diagnosticsOf(page: Page, kind: string) {
  return await page.evaluate(name => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
    .filter((entry: any) => entry.kind === name)
    .map((entry: any) => ({ ...entry.detail })), kind);
}
const assertXrVector = (actual: Record<string, number>, expected: Record<string, number>, label: string) => {
  for (const [axis, value] of Object.entries(expected)) assert.ok(Math.abs(actual[axis] - value) < 1e-6,
    `${label} ${axis} coordinate ${actual[axis]} did not match ${value} within one micrometre.`);
};
const assertToolbarPoint = (actual: { x: number, y: number, z: number }, expected: { x: number, y: number, z: number }) =>
  assertXrVector(actual, expected, 'Toolbar');
async function pressXrToolbar(page: Page, action: string, target: { x: number, y: number, z: number }) {
  const measured = await page.evaluate(() => new Promise<any>((resolveFrame, rejectFrame) => {
    const test = (window as any).__companionXrTest, active = test?.active;
    if (!active || active.ended || !active.space) { rejectFrame(Error('No active XR reference space.')); return; }
    const timer = setTimeout(() => rejectFrame(Error('Timed out measuring XR toolbar reference space.')), 20_000);
    active.session.requestAnimationFrame((_time: number, frame: any) => {
      clearTimeout(timer);
      const pose = frame.getViewerPose(active.space);
      if (!pose) { rejectFrame(Error('No viewer pose for toolbar controller placement.')); return; }
      const { position: p, quaternion: q } = test.device;
      resolveFrame({ viewerFromRoom: Array.from(pose.transform.inverse.matrix),
        viewerPose: { position: { x: p.x, y: p.y, z: p.z }, quaternion: { x: q.x, y: q.y, z: q.z, w: q.w } } });
    });
  }));
  const controllerPose = xrToolbarControllerPose(target, measured.viewerFromRoom, measured.viewerPose);
  const evidence = await page.evaluate(async ({ action, target, measured, controllerPose }) => {
    const test = (window as any).__companionXrTest, active = test?.active;
    if (!active || active.ended) throw Error('No active XR session for controller input.');
    const controller = test.device.controllers.right;
    const nextFrame = (read?: (frame: any) => void) => new Promise<void>((resolveFrame, rejectFrame) => {
      const timeout = setTimeout(() => rejectFrame(Error('Timed out waiting for an IWER XR frame.')), 20_000);
      try { active.session.requestAnimationFrame((_time: number, frame: any) => {
        clearTimeout(timeout);
        try { read?.(frame); resolveFrame(); } catch (error) { rejectFrame(error); }
      }); } catch (error) { clearTimeout(timeout); rejectFrame(error); }
    });
    const frames = async (count: number) => { for (let index = 0; index < count; index++) await nextFrame(); };
    // The pre-toolbar observer sees events before stopImmediatePropagation.
    // Its ring is capped at 64, so array length is not an append-only cursor:
    // the 22nd three-event press rolls over and slice(63) loses selectstart.
    // Retained object identities distinguish this press from previous input
    // even when the ring shifts; missing native events still fail below.
    const priorEvents = new Set(active.inputEvents);
    // Published row points already live in the toolbar's room frame. The
    // measured inverse viewer transform removes its actual translation/yaw
    // before mapping to device space; entry may retain either in local space.
    const deviceTarget = controllerPose.position, orientation = controllerPose.quaternion;
    const viewerPose = measured.viewerPose;
    const diagnosticOffset = (window as any).__stereofoldDiagnostics?.entries?.().at(-1)?.seq ?? 0;
    controller.connected = true;
    controller.position.set(deviceTarget.x, deviceTarget.y, deviceTarget.z);
    controller.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    await frames(3);
    let observedRay: { origin: number[]; direction: number[] } | null = null;
    await nextFrame(frame => {
      const source = [...active.session.inputSources].find((input: any) => input.handedness === 'right');
      const pose = source && frame.getPose(source.targetRaySpace, active.space);
      if (!pose) throw Error('No measured target-ray pose for toolbar controller.');
      const { position: p, matrix: m } = pose.transform;
      observedRay = { origin: [p.x, p.y, p.z], direction: [-m[8], -m[9], -m[10]] };
    });
    controller.updateButtonValue('trigger', 1);
    await frames(3);
    const pressedInput = [...active.session.inputSources].find((input: any) => input.handedness === 'right');
    const pressed = Boolean(pressedInput?.gamepad?.buttons?.[0]?.pressed);
    controller.updateButtonValue('trigger', 0);
    await frames(6);
    const releasedInput = [...active.session.inputSources].find((input: any) => input.handedness === 'right');
    const rayOrigin = { x: controller.position.x, y: controller.position.y, z: controller.position.z };
    const quaternion = { x: controller.quaternion.x, y: controller.quaternion.y, z: controller.quaternion.z, w: controller.quaternion.w };
    const events = active.inputEvents.filter((event: unknown) => !priorEvents.has(event));
    const selectRay = ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
      .filter((entry: any) => entry.seq > diagnosticOffset && entry.kind === 'toolbar' && entry.detail?.phase === 'selectstart')
      .at(-1)?.detail?.ray ?? null;
    // Keep controller/pointer rendering identical across all before/after
    // captures. Four metres right is outside the eye frusta but retains the
    // same connected IWER input source for the next deliberate press.
    controller.position.set(4, 1.6, 0); controller.quaternion.set(0, 0, 0, 1);
    await frames(3);
    return { action, target, deviceTarget, viewerPose, viewerFromRoom: measured.viewerFromRoom,
      targetInDevice: controllerPose.deviceTarget, observedRay, selectRay, rayOrigin, quaternion, parked: { x: controller.position.x, y: controller.position.y, z: controller.position.z },
      pressed, released: !releasedInput?.gamepad?.buttons?.[0]?.pressed,
      events, primaryInputMode: test.device.primaryInputMode };
  }, { action, target, measured, controllerPose });
  assert.equal(evidence.primaryInputMode, 'controller');
  assert.equal(evidence.pressed, true, `${action} did not hold the IWER primary trigger.`);
  assert.equal(evidence.released, true, `${action} did not release the IWER primary trigger.`);
  assertXrVector(evidence.rayOrigin, evidence.deviceTarget, `${action} ray origin`);
  // The ray carries the viewer orientation and starts behind the exact row.
  assertXrVector(evidence.quaternion, evidence.viewerPose.quaternion, `${action} ray orientation`);
  assertXrVector(evidence.parked, { x: 4, y: 1.6, z: 0 }, `${action} parked controller`);
  const targetErrors = [];
  assert.ok(evidence.observedRay, 'Toolbar controller must return an observed XR target-ray pose.');
  for (const [source, ray] of [['frame', evidence.observedRay], ['toolbar', evidence.selectRay]] as const) {
    if (!ray) continue;
    const delta = [target.x, target.y, target.z].map((value, axis) => value - ray.origin[axis]);
    const length = Math.hypot(...ray.direction), direction = ray.direction.map((value: number) => value / length);
    const distance = delta.reduce((sum, value, axis) => sum + value * direction[axis], 0);
    const miss = Math.hypot(...delta.map((value, axis) => value - distance * direction[axis]));
    targetErrors.push({ source, distance, miss });
    assert.ok(distance > 0 && miss < 1e-5, `${action} controller ray missed the published room-space target by ${miss} metres.`);
  }
  for (const type of ['selectstart', 'select', 'selectend']) {
    assert.ok(evidence.events.some((event: any) => event.type === type && event.handedness === 'right'),
      `${action} did not traverse the IWER ${type} input stream.`);
  }
  report.emulatedXr.controllerInputs ??= [];
  report.emulatedXr.controllerInputs.push({ ...evidence, targetErrors });
  console.log(`Observed XR controller ${action}: ${JSON.stringify(evidence.events)}`);
  return evidence;
}
/**
 * Wait until the spatial toolbar has finished rebuilding itself.
 *
 * `selectStart` refuses a press outright while the toolbar swaps geometry: it
 * returns early when its hit panel is undefined or input is locked, and a
 * layout change disposes an in-flight gesture. The row change caused by the
 * previous press reaches the public tour DOM before that rebuild commits, so a
 * harness that presses as soon as the DOM settles presses into the gap and the
 * press is dropped with no error anywhere.
 *
 * The toolbar records a `toolbar` diagnostic at each step of a rebuild — the
 * same kind an agent reads with `read_headset_log` — and writes nothing while
 * idle, so a quiet window on that stream is the readiness signal. Hover and
 * highlight records are edge-triggered, and `pressXrToolbar` parks the
 * controller off the panel, so an idle toolbar really does fall silent.
 */
async function waitToolbarQuiet(page: Page, settleMs = 500, timeoutMs = 30_000) {
  await page.waitForFunction(quiet => {
    const entries = ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
      .filter((entry: any) => entry.kind === 'toolbar' || entry.kind === 'toolbar-action');
    const last = entries[entries.length - 1];
    return !last || Date.now() - last.at >= quiet;
  }, settleMs, { timeout: timeoutMs, polling: 100 });
}
/** The newest diagnostic sequence, so a press can be judged by what follows it. */
const diagnosticsCursor = (page: Page) => page.evaluate(() =>
  (((window as any).__stereofoldDiagnostics?.entries?.() ?? []).at(-1)?.seq ?? 0) as number);
/**
 * Press one toolbar row once the toolbar is ready, and prove the toolbar ran
 * the action rather than swallowing the select.
 *
 * A completed gesture records `toolbar-action`; nothing else does. A press that
 * produces no such record did not dispatch before the acknowledgement deadline.
 * Preserve its evidence before retrying against a freshly resolved target;
 * the missing action alone does not establish why the gesture was lost.
 * `resolveTarget` is a callback because a rebuild can move every row,
 * so the second attempt must re-resolve rather than reuse the first point.
 * When the live draw is the quiet one — a press aimed at a vacated seat
 * (selectstart hit:null) or a resolve while quiet — `toolbarTarget` wakes the
 * full draw first and re-resolves from the new draw, and the retry presses
 * again on that target.
 */
async function pressXrToolbarWhenReady(page: Page, action: string, resolveTarget: () => Promise<{ x: number, y: number, z: number }>) {
  // Retry a missing acknowledgement with fresh targeting, preserving each
  // attempt for diagnosis. The row-identity assertion still fails a press
  // that hits the wrong row.
  for (let attempt = 1; attempt <= 4; attempt++) {
    await waitToolbarQuiet(page);
    const cursor = await diagnosticsCursor(page);
    const evidence = await pressXrToolbar(page, action, await resolveTarget());
    const ran = await page.waitForFunction(since => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
      .some((entry: any) => entry.seq > since && entry.kind === 'toolbar-action'), cursor, { timeout: 5_000, polling: 50 })
      .then(() => true, () => false);
    if (ran) {
      // The toolbar names the row its own hit test resolved. A press that runs
      // the neighbouring row is not a dropped press and would otherwise be
      // reported as a product failure many steps later.
      const hit = await page.evaluate(since => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
        .filter((entry: any) => entry.seq > since && entry.kind === 'toolbar' && entry.detail?.phase === 'selectstart')
        .map((entry: any) => entry.detail?.hit ?? null).filter(Boolean).at(-1) ?? null, cursor);
      const expected = report.emulatedXr.toolbarTargets?.at(-1)?.label ?? null;
      assert.ok(hit === null || expected === null || hit === expected,
        `The ${action} press resolved the row ${expected} but the live toolbar hit ${hit}; the harness row model is out of step with the panel.`);
      return evidence;
    }
    // Read the ring and current state together, before any retry or further
    // waits can evict redraw/cancellation events from the bounded page ring.
    const diagnosticCapture = await page.evaluate(since => {
      const retained = (window as any).__stereofoldDiagnostics?.entries?.() ?? [];
      const active = (window as any).__companionXrTest?.active;
      const notice = document.querySelector('.session-notice') as HTMLElement | null;
      return {
        capturedAt: Date.now(), cursor: since,
        retainedFirstSeq: retained[0]?.seq ?? null, retainedLastSeq: retained.at(-1)?.seq ?? null,
        diagnostics: retained.filter((entry: any) => entry.seq > since),
        current: {
          ready: document.body?.dataset.ready, visibility: document.visibilityState,
          notice: { text: notice?.textContent ?? null, hidden: notice?.hidden ?? null },
          status: document.querySelector('#status')?.textContent ?? null,
          outcome: document.querySelector('[data-session-outcome]')?.textContent ?? null,
          xr: active ? { mode: active.mode, ended: active.ended, frames: active.rafCount,
            visibility: active.session.visibilityState, latestPose: active.poses.at(-1) ?? null,
            inputEvents: active.inputEvents.slice(-20) } : null,
        },
      };
    }, cursor);
    const dropped = diagnosticCapture.diagnostics
      .filter((entry: any) => entry.kind === 'toolbar' && entry.detail?.phase === 'selectstart')
      .map((entry: any) => ({ hit: entry.detail?.hit ?? null, hasPanel: entry.detail?.hasPanel ?? null, inputLocked: entry.detail?.inputLocked ?? null }));
    report.emulatedXr.toolbarPressRetries ??= [];
    const diagnosticFile = `toolbar-press-retry-${report.emulatedXr.toolbarPressRetries.length + 1}.json`;
    const retry = { action, attempt, selectStarts: dropped, diagnosticFile, press: evidence, ...diagnosticCapture };
    report.emulatedXr.toolbarPressRetries.push(retry);
    await writeFile(resolve(out, diagnosticFile), JSON.stringify(retry, null, 2) + '\n');
    assert.ok(attempt < 4, `${action} was dropped by the spatial toolbar four times; select starts were ${JSON.stringify(dropped)}.`);
    console.log(`Retrying dropped XR toolbar press ${action}: ${JSON.stringify(dropped)}`);
  }
  throw Error('unreachable');
}
async function disconnectXrController(page: Page) {
  await page.evaluate(async () => {
    const test = (window as any).__companionXrTest, active = test?.active;
    if (!active) return;
    test.device.controllers.right.connected = false;
    await new Promise<void>(resolveFrame => active.session.requestAnimationFrame(() => resolveFrame()));
  });
}
async function contrast(owner: Page | Frame, minimumChecked = 20) {
  const result = await owner.evaluate(() => {
    const rgb = (value: string) => value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
    const luminance = (color: number[]) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const failures: any[] = []; let checked = 0;
    for (const element of document.querySelectorAll('#app *')) {
      if (!element.getClientRects().length || element.closest('button:disabled,input:disabled,select:disabled,[aria-hidden=true]')) continue;
      const text = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
      if (!text && !element.matches('input:not([type=color]):not([type=range]),select')) continue;
      const style = getComputedStyle(element as Element); if (style.visibility !== 'visible') continue;
      const foreground = rgb(style.color); let background = [255, 255, 255];
      const ancestors: Element[] = []; for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
      for (const node of ancestors) { const color = rgb(getComputedStyle(node).backgroundColor), alpha = color[3] ?? 1; background = background.map((value, index) => value * (1 - alpha) + color[index] * alpha); }
      const first = luminance(foreground), second = luminance(background), ratio = (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
      checked++; if (ratio < 4.5) failures.push({ text: text.slice(0, 64) || element.getAttribute('aria-label'), ratio });
    }
    return { checked, failures };
  });
  assert.ok(result.checked > minimumChecked, `Contrast checked only ${result.checked} rendered elements.`);
  assert.deepEqual(result.failures, [], JSON.stringify(result));
}
function binding(state: any, sessionId: string) {
  return { sessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken, baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision };
}
/**
 * Reach the VR entry button the way a wearer does.
 *
 * `inspector.ts:614` files "VR without passthrough" inside the collapsed
 * `More options` disclosure whenever passthrough is available, which the IWER
 * Meta Quest 2 profile reports. A closed `<details>` gives its children no box,
 * so the summary is opened by a real click before the entry button is used.
 */
async function openXrOptions(page: Page) {
  const options = page.locator('details.xr-options');
  if (await options.count() === 0) return;
  if (await options.evaluate((element: Element) => (element as HTMLDetailsElement).open)) return;
  // `Connection diagnostics` is a nested <details> inside this one, so the
  // summary must be matched as a direct child.
  await options.locator('> summary').click();
  await page.waitForFunction(() => document.querySelector<HTMLDetailsElement>('details.xr-options')?.open === true);
}
async function waitSelectedKeys(owner: Page | Frame, expected: string[]) {
  try {
    await owner.waitForFunction(keys => {
      const selected = [...document.querySelectorAll<HTMLElement>('.sequence button[aria-pressed="true"]')].map(button => button.dataset.key);
      return JSON.stringify(selected) === JSON.stringify(keys);
    }, expected);
  } catch (error) {
    const actual = await owner.evaluate(() => ({
      selected: [...document.querySelectorAll<HTMLElement>('.sequence button[aria-pressed="true"]')].map(button => button.dataset.key),
      mountedRows: document.querySelectorAll('.sequence button').length,
      search: document.querySelector<HTMLInputElement>('[data-control="search"]')?.value,
      chain: document.querySelector<HTMLSelectElement>('[data-control="chain"]')?.value,
      notice: document.querySelector('.session-notice:not([hidden])')?.textContent,
      outcome: document.querySelector('[data-session-outcome]')?.textContent,
      summary: document.querySelector('.selection-count')?.textContent,
    }));
    throw Error(`Shared selection did not reach the desktop sequence: ${JSON.stringify({ expected, actual })}`, { cause: error });
  }
}
/**
 * Read a companion panel's saved selection by residue identity.
 *
 * A companion has no `.sequence` residue buttons to read: `workspace.mjs:265`
 * clears that desktop-only editor whenever `enableXr` is set, and
 * `inspector.ts:445` sets it for every companion panel. The residue identities
 * are still rendered in the selection detail line, the compact selection
 * summary and the canvas selection count, so those three are matched exactly
 * against the residues the saved scene names.
 */
function residueLabel(row: any) {
  return `${row.identity.authorChain} \u00b7 ${row.identity.componentId} ${row.identity.authorResidue ?? '?'}${row.identity.insertionCode}`;
}
function expectedSelectionReadout(catalog: any, scene: any) {
  const chosen = new Set<string>(scene.selectionKeys);
  const rows = (catalog.rows as any[]).filter(row => row.identity.modelNumber === scene.modelNumber
    && row.identity.assemblyId === scene.assemblyId && chosen.has(row.key));
  assert.equal(rows.length, scene.selectionKeys.length,
    'Every saved selection key must resolve to a catalog residue of the shown model before a companion readout is checked.');
  const missing = rows.some(row => row.coordinateState !== 'resolved');
  return {
    keys: rows.map(row => row.key),
    count: rows.length ? `${rows.length} residue${rows.length === 1 ? '' : 's'} selected` : 'No residues selected',
    details: rows.length
      ? `${rows.slice(0, 4).map(residueLabel).join('   /   ')}${rows.length > 4 ? `   + ${rows.length - 4} more` : ''}${missing ? ' \u00b7 Coordinates missing for part of this selection.' : ''}`
      : 'Choose a residue to see its identity. Shift-click extends a range; \u2318/Ctrl-click adds or removes.',
    summary: rows.length
      ? `${rows.slice(0, 2).map(residueLabel).join(' / ')}${rows.length > 2 ? ` + ${rows.length - 2} more` : ''}${missing ? ' \u00b7 Coordinates missing' : ''}`
      : 'No residues selected',
  };
}
async function waitCompanionSelection(page: Page, catalog: any, scene: any) {
  const expected = expectedSelectionReadout(catalog, scene);
  await page.waitForFunction(want => document.querySelector('.selection-count')?.textContent === want.count
    && document.querySelector('.selection-details')?.textContent === want.details
    && document.querySelector('.mobile-selection-summary')?.textContent === want.summary, expected);
  assert.equal(await page.locator('.sequence button').count(), 0,
    'A companion panel must not build the desktop sequence residue editor.');
  return expected;
}
async function waitPanelReady(sessionId: string, surface: 'desktop' | 'companion', panelId?: string) {
  return waitState(sessionId, state => state.panels.some((panel: any) => panel.surface === surface && panel.current
    && panel.availability === 'ready' && (panelId === undefined || panel.panelId === panelId)));
}

const hostBundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
const hostHtml = `<!doctype html><html><body style="margin:0;background:#071015"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${hostBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
host = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(hostHtml); });
await new Promise<void>(resolveListen => host!.listen(0, '127.0.0.1', resolveListen));
const desktopOrigin = `http://127.0.0.1:${(host.address() as any).port}`;
// Labelled by their name in a dist rather than by a path, because `--dist`
// moves the directory and the label is what a reader matches to a build.
const runtimePaths = ['dist/server.mjs', 'dist/inspector.html', 'dist/inspector.css', 'dist/viewer.html'] as const;
const runtimeFile = (label: (typeof runtimePaths)[number]) => resolve(distDirectory, label.slice('dist/'.length));
const runtimeSnapshot = Object.fromEntries(await Promise.all(runtimePaths.map(async path => {
  const bytes = await readFile(runtimeFile(path));
  return [path, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
}))) as Record<(typeof runtimePaths)[number], { bytes: number, sha256: string }>;
report.distDirectory = distDirectory;
report.testedRuntime = runtimeSnapshot;
async function assertRuntimeUnchanged() {
  for (const path of runtimePaths) {
    const bytes = await readFile(runtimeFile(path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), runtimeSnapshot[path].sha256,
      `Built runtime changed during browser acceptance: ${path}`);
  }
}

try {
  await client.connect(transport);
  if (controllerInputOnly) console.log('Controller acceptance: isolated MCP connected.');
  // A demo run opens the shipped lesson through `inspect_lesson`, so the tour
  // the wearer steps through is the authored lesson rather than the built-in
  // catalog tour over a fixture. Everything below reads the opened session.
  const fixturePath = demo?.inspectionInput.filePath ?? resolve(controllerInputOnly ? '../fixtures/1CRN.cif' : '../fixtures/4HHB.cif');
  const fixtureBytes = await readFile(fixturePath);
  assert.ok(fixtureBytes.byteLength > (controllerInputOnly ? 1024 : 70 * 1024),
    `${demo ? demo.entry.name : '4HHB'} must exercise a source larger than 70 KiB.`);
  const fixtureDigest = createHash('sha256').update(fixtureBytes).digest('hex');
  const opened = demo
    ? await call('inspect_lesson', demo.inspectionInput)
    : await call('inspect_file', { filePath: fixturePath });
  if (demo) report.demo = { name: demo.entry.name, stage: demo.stage?.id ?? null, pdbId: demo.entry.pdbId,
    title: demo.entry.title, lesson: demo.entry.lesson, atomSites: demo.entry.coordinates.atomSites,
    customTourId: opened.structuredContent.customTourId ?? null, steps: demo.manifest.chapters.length };
  const sessionId = opened.structuredContent.sessionId as string;
  assert.ok(sessionId); assert.doesNotMatch(JSON.stringify(opened), /_atom_site\./i, 'Public inspect_file result must not contain coordinates.');
  bridgeContext.sessionId = sessionId;
  bridgeContext.renderToken = opened.structuredContent.renderToken;
  const inspectorResource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const inspectorHtml = (inspectorResource.contents[0] as any).text as string;
  assert.equal(createHash('sha256').update(inspectorHtml).digest('hex'), createHash('sha256').update(await readInlineHtml(runtimeFile('dist/inspector.html'))).digest('hex'),
    'The MCP inspector resource must match the pre-connect production runtime snapshot.');
  assert.ok(!inspectorHtml.includes('stereofold-viewer-build-unstamped'));

  browser = await chromium.launch({ headless: true, ...(browserChannel === 'chromium' ? { channel: 'chromium' } : {}) });
  report.browserVersion = browser.version();
  if (controllerInputOnly) console.log('Controller acceptance: mounting desktop source.');
  const desktop = await mountDesktop(inspectorHtml, opened);
  if (controllerInputOnly) console.log('Controller acceptance: desktop bridge connected.');
  await desktop.frame.locator('body[data-ready="true"]').waitFor();
  await desktop.frame.locator('.stage canvas').waitFor({ state: 'visible' });
  const initial = await waitPrivate(sessionId, data => data.scene !== null);
  assert.equal(initial.catalog.source.sha256, fixtureDigest);
  if (demo?.entry.coordinates.derivation) {
    const heading = await desktop.frame.locator('.scene-heading h1').innerText();
    const assembly = await desktop.frame.locator('[data-fact="assembly"]').innerText();
    assert.ok(heading.includes(demo.entry.pdbId ?? demo.entry.title), 'Derived coordinates must display their verified source identity.');
    assert.ok(!heading.includes('XXXX'), 'A generated coordinate placeholder must not be displayed as a PDB code.');
    assert.match(assembly, demo.entry.coordinates.derivation.kind === 'bundled-file' ? /bundled/u
      : demo.entry.coordinates.derivation.kind === 'prepared-rigid-composite' ? /prepared rigid composite/u : /subset/u,
      'Derived coordinates must display their authored scope.');
    report.derivedSourceHeading = { heading, assembly, coordinateSha256: fixtureDigest };
    passed('The derived coordinate source displays its verified PDB identity and subset scope');
  }
  bridgeContext.structureId = bridgeStructureId(initial.catalog.source.label);
  assert.equal((await call('get_inspection_state', { sessionId })).structuredContent.hasScene, true);
  // The companion, Quest and handoff buttons live under the header's More
  // menu, a closed <details>. Setting open is idempotent, unlike a summary click.
  const openMore = async () => desktop.frame.locator('[data-header-menu]').evaluate((menu: any) => { menu.open = true; });
  await openMore();
  await desktop.frame.locator('[data-companion-open]').waitFor({ state: 'visible' });
  // Named for what was loaded, not for the default fixture: a demo run opens
  // that demo's coordinates here, and a frame called 4hhb reads as --demo
  // having been ignored when it was not.
  const desktopShot = demo ? (demo.entry.pdbId ?? demo.entry.name).toLowerCase() : '4hhb';
  if (!controllerInputOnly) {
  await captureCanvas(desktop.frame, desktop.page, `01-desktop-${desktopShot}-dark`);
  await desktop.page.evaluate(() => (window as any).__host.setContext({ theme: 'light' }));
  await desktop.frame.locator('html[data-theme="light"]').waitFor(); await contrast(desktop.frame);
  await captureCanvas(desktop.frame, desktop.page, `02-desktop-${desktopShot}-light`);
  passed(`${demo ? 'inspect_lesson' : 'inspect_file'} loads the explicit >70 KiB ${demo ? demo.entry.pdbId ?? demo.entry.sourceId ?? demo.entry.name : '4HHB'} mmCIF into a rendered desktop inspector without exposing coordinates in its public result`);
  } else passed('Local 1CRN is rendered in the production desktop inspector');

  await waitPanelReady(sessionId, 'desktop');
  // Searching "1" is a 4HHB row query. A lesson opens with the scene its first
  // chapter authored, and every consumer of this selection is behind the
  // fixture-only guard below, so a demo run leaves the authored scene alone.
  if (!demo && !controllerInputOnly) {
    await desktop.frame.locator('[data-control="search"]').fill('1');
    await desktop.frame.locator('[data-control="search"]').press('Enter');
  }
  const selectedDesktop = demo || controllerInputOnly ? await waitPrivate(sessionId, data => data.scene !== null)
    : await waitPrivate(sessionId, data => data.scene.selectionKeys.length > 0);
  if (!demo && !controllerInputOnly) await desktop.frame.locator('[data-control="search"]').fill('');
  const stateBeforeCompanion = await waitState(sessionId, state => state.hasScene && state.panels.some((panel: any) => panel.surface === 'desktop' && panel.current));
  const connected = await call('open_companion', binding(stateBeforeCompanion, sessionId));
  const companionInfo = connected.structuredContent.companion;
  assert.ok(companionInfo && typeof companionInfo.url === 'string' && Number.isInteger(companionInfo.port));
  assert.equal(companionInfo.connection, 'loopback'); assert.equal(companionInfo.adbReverse, `adb reverse tcp:${companionInfo.port} tcp:${companionInfo.port}`);
  const companionUrl = companionInfo.url as string; // Private capability: never copy to report or artifacts.
  await openMore();
  await desktop.frame.locator('[data-companion-open]').click();
  const connectedBrowserLink=desktop.frame.getByText('Open connected browser',{exact:true});
  await connectedBrowserLink.waitFor({ state: 'visible' });
  assert.ok(await connectedBrowserLink.getAttribute('href') === companionUrl,
    'Open companion must expose the same source-scoped connection through its visible fallback link.');
  const companionOrigin = new URL(companionUrl).origin;
  const companion = await browser.newPage({ viewport: { width: 600, height: 800 }, deviceScaleFactor: 1 });
  await companion.addInitScript({content:'globalThis.__name = value => value;'});
  if (xrRuntime) {
    await companion.addInitScript({ content: await molecularGeometryProbeBundle() });
    report.molecularGeometryInstrumentation = 'Read-only molecular accessor in served companion HTML; distributed files unchanged. Geometry projection and lit/live-count readers bundled from production source.';
  }
  // Five minutes for a demo run, two otherwise. A lesson builds a Gaussian
  // molecular surface and a spacefill over 13,000 to 41,000 atom sites, and
  // this emulator reports `gpu: unavailable`, so those scenes are computed on
  // the CPU. The 40,908-site microtubule lattice passed two minutes on several
  // waits. A Quest 2 has a GPU; this budget is the emulator's, not the
  // product's, and a scene that is slow on hardware is a frame-budget finding
  // rather than something this timeout would catch.
  companion.setDefaultTimeout(demoName ? 300_000 : 120_000);
  if (xrRuntime && xrAdapters) {
    // Test-only session instrumentation, installed before the companion boots.
    // It observes production requestSession calls; it does not launch a second
    // viewer or add any production test hook.
    await companion.addInitScript({ content: `${xrRuntime}\n;(${installCompanionXrInstrumentation})(${xrAdapters.installReferenceSpaceAdapter}, ${JSON.stringify(headPose)});` });
    // Test-only microphone, installed before the companion boots. A headless
    // Chromium has no microphone and no way to answer a permission prompt, so
    // the production voice path cannot be pressed at all without one. It
    // starts refusing, which is what a wearer who declines the prompt gets.
    await companion.addInitScript({ content: `(${installCompanionMicrophoneStub})();` });
    report.emulatedXr = { runtime: 'IWER 2.3.0', physicalHeadset: 'not_run', nativeHost: 'not_run' };
  }
  companion.on('pageerror', error => report.errors.push(error.message));
  watchPageEvidence(companion, 'companion');
  await companion.route('**/*', async route => {
    const url = route.request().url();
    if (xrRuntime && url.startsWith(companionOrigin) && route.request().resourceType() === 'document') {
      const response = await route.fetch();
      return route.fulfill({ response, body: instrumentMolecularGeometry(await response.text()) });
    }
    if (url.startsWith(companionOrigin)) return route.continue();
    report.externalRequests.push(url); return route.abort();
  });
  await companion.goto(withRenderBudget(companionUrl));
  await companion.locator('body[data-ready="true"]').waitFor();
  await companion.locator('.stage canvas').waitFor({ state: 'visible' });
  // IWER puts its simulated display over the 2D page. Keep the test's desktop
  // controls clickable through that overlay; this does not qualify a spatial
  // toolbar or make DOM controls visible inside a physical headset.
  if (xrRuntime) await companion.addStyleTag({ content: '[data-webxr_runtime]{pointer-events:none!important}' });
  await companion.waitForFunction(()=>Boolean(document.body.dataset.panelId));
  const companionPanel = await companion.locator('body').getAttribute('data-panel-id'); assert.ok(companionPanel);
  bridgeContext.panelId = companionPanel;
  await waitPanelReady(sessionId, 'companion', companionPanel);
  if (!focusedTourIwer) {
  assert.equal(await companion.locator('[data-control="background"]').inputValue(), selectedDesktop.scene.inspection.appearance.background);
  assert.ok(selectedDesktop.scene.selectionKeys.length > 0, 'The desktop must save a non-empty selection for the companion to mirror.');
  await waitCompanionSelection(companion, initial.catalog, selectedDesktop.scene);
  await captureCanvas(companion, companion, '03-companion-initial');
  passed('The actual returned loopback URL mounts a companion panel with the same source, saved appearance, and selected residues');

  const source = await fetch(`${companionOrigin}/source`, { headers: { Authorization: `Bearer ${new URL(companionUrl).hash.slice(1)}` } });
  assert.equal(source.status, 200); const sourceBytes = Buffer.from(await source.arrayBuffer());
  assert.equal(sourceBytes.byteLength, fixtureBytes.byteLength); assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), fixtureDigest);
  assert.equal(source.headers.get('x-stereofold-source-sha256'), fixtureDigest);
  report.source = { bytes: sourceBytes.byteLength, sha256: fixtureDigest, route: 'private-loopback' };
  passed('Companion source hydration uses private loopback bytes with the expected >70 KiB digest and no external request');

  await waitPanelReady(sessionId, 'companion', companionPanel);
  // A companion renders no desktop chrome: `inspector.css:59-73` hides the
  // header, inspector, sequence panel, canvas tools and selection bars on every
  // companion panel. Its remaining local selection controls are the canvas
  // itself, so the clear and the residue pick are driven there: Escape clears,
  // and a real mouse click runs the production 3D pick handler.
  const companionCanvas = companion.locator('.stage canvas');
  await companionCanvas.focus();
  await companionCanvas.press('Escape');
  const clearedByCompanion = await waitPrivate(sessionId, data => data.scene?.selectionKeys.length === 0);
  await waitSelectedKeys(desktop.frame, []);
  await waitCompanionSelection(companion, initial.catalog, clearedByCompanion.scene);
  const canvasBox = await companionCanvas.boundingBox();
  assert.ok(canvasBox, 'The companion canvas must have a laid-out box to pick in.');
  let picked = false;
  for (const [fx, fy] of [[.5, .5], [.5, .45], [.45, .5], [.55, .5], [.5, .55], [.45, .45], [.55, .55], [.42, .58], [.58, .42]]) {
    await companionCanvas.click({ position: { x: canvasBox!.width * fx, y: canvasBox!.height * fy } });
    picked = await companion.waitForFunction(() => document.querySelector('.selection-count')?.textContent !== 'No residues selected',
      undefined, { timeout: 5_000 }).then(() => true, () => false);
    if (picked) break;
  }
  assert.ok(picked, 'A click on the companion canvas must pick a residue through the production 3D pick handler.');
  const changedByCompanion = await waitPrivate(sessionId, data => data.scene?.selectionKeys.length > 0);
  await waitSelectedKeys(desktop.frame, changedByCompanion.scene.selectionKeys);
  await waitCompanionSelection(companion, initial.catalog, changedByCompanion.scene);
  await desktop.frame.locator('[data-session-outcome]').waitFor({ state: 'visible' });
  // The companion's own outcome line is present but deliberately not painted.
  await companion.waitForFunction(() => Boolean(document.querySelector('[data-session-outcome]')?.textContent?.trim()));
  passed('A clean companion local 3D selection saves once and the clean desktop panel follows the shared saved scene');

  const commandState = await waitPanelReady(sessionId, 'companion', companionPanel);
  const commandId = 'companion-pink-half';
  const update = await call('update_inspection', {
    ...binding(commandState, sessionId), panelId: companionPanel, commandId,
    change: { kind: 'appearance', patch: { color: 'uniform', uniformColor: '#ee55bb', opacity: 0.5, background: '#10243a' } },
  });
  assert.equal(update.structuredContent.command.status, 'queued');
  const rendered = await waitState(sessionId, state => state.command?.status === 'rendered', commandId);
  assert.equal(rendered.command.panelId, companionPanel);
  await companion.locator('[data-control="uniform-color"]').waitFor({ state: 'attached' });
  assert.equal(await companion.locator('[data-control="uniform-color"]').evaluate((element: HTMLInputElement) => element.value), '#ee55bb');
  await desktop.frame.locator('[data-control="background"]').waitFor({ state: 'visible' });
  await desktop.frame.waitForFunction(() => (document.querySelector('[data-control="background"]') as HTMLInputElement)?.value === '#10243a');
  const pixels = await captureCanvas(companion, companion, '04-companion-tool-pink');
  assert.ok(pixels.foreground > 100);
  const savedAfterCommand = await waitPrivate(sessionId, data => data.inspectionRevision === rendered.inspectionRevision);
  assert.equal(savedAfterCommand.scene.inspection.appearance.opacity, 0.5);
  passed('A public appearance command targeted to the companion is rendered, receipt-confirmed, visibly nonempty, and followed by the clean desktop panel');

  await waitPanelReady(sessionId, 'desktop');
  await desktop.frame.locator('[data-control="search"]').fill('5');
  await desktop.frame.locator('[data-control="search"]').press('Enter');
  const desktopReverse = await waitPrivate(sessionId, data => data.inspectionRevision > savedAfterCommand.inspectionRevision);
  await waitCompanionSelection(companion, initial.catalog, desktopReverse.scene);
  passed('A clean desktop selection also follows into the companion without creating a second source or scene');

  // Agents commonly issue independent appearance edits in parallel. Exercise
  // the public implicit-binding queue against real rendered companion receipts.
  await waitPanelReady(sessionId, 'companion', companionPanel);
  const parallelIds = ['parallel-color', 'parallel-opacity', 'parallel-background'];
  const parallelPatches = [{ color: 'uniform', uniformColor: '#cc8844' }, { opacity: 0.6 }, { background: '#16283a' }];
  const parallelAnswers = await Promise.all(parallelPatches.map((patch, i) => call('update_inspection', {
    sessionId, panelId: companionPanel, commandId: parallelIds[i], waitForRenderMs: 10000,
    change: { kind: 'appearance', patch },
  })));
  const parallelReceipts = await Promise.all(parallelIds.map(id => waitState(sessionId, state => state.command?.status === 'rendered', id)));
  assert.ok(parallelAnswers.every(answer => ['queued', 'rendered'].includes(answer.structuredContent.command.status)));
  const parallelRevisions = parallelReceipts.map(state => state.command.renderedRevision);
  assert.equal(new Set(parallelRevisions).size, 3, 'Each queued edit must commit its own revision.');
  assert.ok(parallelRevisions[0] < parallelRevisions[1] && parallelRevisions[1] < parallelRevisions[2]);
  const afterParallel = await waitPrivate(sessionId, data => data.inspectionRevision === parallelRevisions[2]);
  assert.equal(afterParallel.scene.sourceSha256, desktopReverse.scene.sourceSha256);
  assert.equal(afterParallel.scene.inspection.appearance.uniformColor, '#cc8844');
  assert.equal(afterParallel.scene.inspection.appearance.opacity, 0.6);
  assert.equal(afterParallel.scene.inspection.appearance.background, '#16283a');
  assert.deepEqual(afterParallel.scene.selectionKeys, desktopReverse.scene.selectionKeys);
  const parallelPixels = await captureCanvas(companion, companion, '04b-companion-parallel-edits');
  assert.ok(parallelPixels.foreground > 100);
  passed('Three simultaneous implicit appearance calls render in order, preserve source and selection, and retain every independent edit');

  // A backgrounded native-app frame must not retain its panel capability. Once
  // it returns clean, it has to receive the saved companion change before it
  // obtains a replacement capability; this deliberately uses the real ten
  // second server expiry rather than a clock stub.
  await waitPanelReady(sessionId, 'desktop');
  const expiredDesktopPanel = await desktop.frame.locator('body').getAttribute('data-panel-id');
  assert.ok(expiredDesktopPanel);
  await desktop.frame.getByRole('button', { name: 'Load saved view', exact: true, includeHidden: true }).evaluate((button: HTMLButtonElement) => {
    (window as any).__hiddenRecoveryReloads = 0;
    button.addEventListener('click', () => { (window as any).__hiddenRecoveryReloads++; });
  });
  await desktop.frame.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  await delay(10_200);
  await waitState(sessionId, state => !state.panels.some((panel: any) => panel.panelId === expiredDesktopPanel), undefined, 15_000);

  const hiddenDesktopCommand = 'companion-after-desktop-expiry';
  const hiddenDesktopState = await waitPanelReady(sessionId, 'companion', companionPanel);
  await call('update_inspection', {
    ...binding(hiddenDesktopState, sessionId), panelId: companionPanel, commandId: hiddenDesktopCommand,
    change: { kind: 'appearance', patch: { background: '#25405b' } },
  });
  const hiddenDesktopReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', hiddenDesktopCommand);
  assert.equal(hiddenDesktopReceipt.command.panelId, companionPanel);
  await desktop.frame.evaluate(() => { delete (document as any).visibilityState; });
  await desktop.frame.waitForFunction(oldPanel => {
    const current = document.body.dataset.panelId;
    return Boolean(current && current !== oldPanel);
  }, expiredDesktopPanel);
  const recoveredDesktopPanel = await desktop.frame.locator('body').getAttribute('data-panel-id');
  assert.ok(recoveredDesktopPanel && recoveredDesktopPanel !== expiredDesktopPanel);
  const recoveredState = await waitPanelReady(sessionId, 'desktop', recoveredDesktopPanel);
  assert.equal(recoveredState.inspectionRevision, hiddenDesktopReceipt.inspectionRevision);
  assert.equal(recoveredState.sourceToken, hiddenDesktopReceipt.sourceToken);
  assert.equal(recoveredState.stateRevision, hiddenDesktopReceipt.stateRevision);
  await desktop.frame.waitForFunction(() => (document.querySelector('[data-control="background"]') as HTMLInputElement)?.value === '#25405b');
  assert.equal(await desktop.frame.evaluate(() => (window as any).__hiddenRecoveryReloads), 0, 'Clean expiry recovery must not require Load saved view.');
  report.hiddenPanelRecovery = { expired: true, automatic: true, manualReloads: 0, renderedRevision: hiddenDesktopReceipt.inspectionRevision };
  passed('A clean desktop panel that expires while hidden follows the newer companion scene and reattaches automatically without Load saved view');
  }

  if (xrRuntime) {
    // Every bridge revision comes from this page's XR presentation framebuffer.
    bridgeContext.page = companion;
    // A mode is either one name or the pair the primary button may resolve to.
    const waitImmersive = (mode: string | string[]) => companion.waitForFunction(expectedModes => {
      const problem = document.querySelector('.xr-controls small[data-state="error"]');
      if (problem) throw Error(`XR entry failed: ${problem.textContent}`);
      const active = (window as any).__companionXrTest?.active;
      return Boolean(active && expectedModes.includes(active.mode) && active.rafCount >= 3 && active.poses?.at(-1)?.views?.length === 2
        && document.querySelector('.xr-controls small[data-state="active"]'));
    }, typeof mode === 'string' ? [mode] : mode);
    const waitToolbarScene = async (action: string, predicate: (data: any) => boolean) => {
      try { return await waitPrivate(sessionId, predicate); }
      catch (error) {
        const latest = await privateInspection(sessionId).catch(() => undefined);
        const visible = await companion.evaluate(() => ({
          notice: document.querySelector('.session-notice:not([hidden])')?.textContent?.trim() ?? null,
          outcome: document.querySelector('[data-session-outcome]')?.textContent?.trim() ?? null,
          outcomeState: (document.querySelector('[data-session-outcome]') as HTMLElement)?.dataset.state ?? null,
          xrStatus: document.querySelector('.xr-controls small')?.textContent?.trim() ?? null,
          xrStatusState: (document.querySelector('.xr-controls small') as HTMLElement)?.dataset.state ?? null,
        })).catch(() => undefined);
        report.toolbarWaitFailure = { action, latestPublicPlacement: latest?.scene?.inspection?.placement ?? null,
          selectionCount: latest?.scene?.selectionKeys?.length ?? null, inspectionRevision: latest?.inspectionRevision ?? null, visible };
        throw error;
      }
    };
    if (!focusedTourIwer) {
    const rotationButton = companion.locator('[data-action="rotation"]');
    await rotationButton.waitFor({ state: 'attached' });
    // `inspector.css:69` hides `.canvas-tools` on a companion, so this reaches
    // the same production control by event rather than by pointer.
    if (/^Rotate structure$/i.test(((await rotationButton.textContent()) ?? '').trim())) await rotationButton.dispatchEvent('click');
    const rotationStart = await captureCanvas(companion, companion, '05-companion-before-xr');
    const rotationScene = structuredClone((await privateInspection(sessionId)).scene);
    await companion.waitForTimeout(1200);
    const rotationEnd = await captureCanvas(companion, companion, '06-companion-rotation-before-xr');
    assert.notEqual(rotationEnd.sha256, rotationStart.sha256, 'Object rotation should change normal companion pixels before XR.');
    assert.deepEqual((await privateInspection(sessionId)).scene, rotationScene, 'Normal object rotation must not churn saved inspection state.');
    }
    // Give pinned IWER a 1120 x 630 render viewport per eye. This changes only
    // the emulator browser window; native headset viewports remain runtime-owned.
    //
    // Not the square 800 x 800 it used to be. IWER derives its horizontal field
    // from the viewport aspect, so a square eye caps the half-field near 51
    // degrees, and the gate then measured the toolbar plate centred
    // 47.5 degrees off axis with its left edge at 55.7 degrees in the left eye
    // and 57.7 degrees in the right. No capture contained a whole row, so no
    // label could be checked. This eye reaches 60.5 degrees.
    //
    // Read that number as an indictment of the panel seat, not a licence. A
    // Quest 2's own horizontal half-field is about 48 degrees, so a row seated
    // past it is outside what the wearer sees without turning their head. This
    // viewport lets the artifacts show the label; it does not make the seat
    // acceptable, and the seat itself still has to be brought in.
    await companion.setViewportSize({ width: controllerInputOnly ? 400 : autoplayManipulation ? 800 : 2240, height: controllerInputOnly ? 300 : autoplayManipulation ? 500 : 630 });
    await companion.waitForFunction(size => innerWidth === size.width && innerHeight === size.height, { width: controllerInputOnly ? 400 : autoplayManipulation ? 800 : 2240, height: controllerInputOnly ? 300 : autoplayManipulation ? 500 : 630 });
    await companion.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
    // Enter the way a wearer does. The primary control is the only one on the
    // page itself; both named modes live under More options or on that same
    // control, so an explicit --mode opens the disclosure first.
    if (entryMode) {
      await openXrOptions(companion);
      await companion.locator(`[data-enter-xr="immersive-${entryMode}"]`).click();
      await waitImmersive(`immersive-${entryMode}`);
    } else {
      await companion.locator('[data-enter-xr][data-primary]').click();
      await waitImmersive(['immersive-ar', 'immersive-vr']);
    }
    const enteredMode: string = await companion.evaluate(() => (window as any).__companionXrTest.active.mode);
    immersiveEntryMode = enteredMode;
    report.xrEntry = { requestedMode: entryMode ? `immersive-${entryMode}` : 'page-primary', mode: enteredMode };
    // IWER renders into the actual stage canvas. Current connection/readiness
    // chrome takes height from that stage, so a 630 px browser window no longer
    // means a 630 px eye buffer. Grow only the test window to restore the capture
    // viewport; never relax the capture aspect or label-visibility assertions.
    for (let attempt = 0; !controllerInputOnly && !autoplayManipulation && attempt < 4; attempt++) {
      const size = await companion.evaluate(() => {
        const layer = (globalThis as any).__companionXrTest.active.session.renderState.baseLayer;
        return { windowHeight: innerHeight, canvasHeight: layer.framebufferHeight };
      });
      if (size.canvasHeight >= 628) break;
      await companion.setViewportSize({ width: 2240, height: Math.ceil(size.windowHeight + 630 - size.canvasHeight) });
      await companion.waitForTimeout(250);
    }
    report.xrReviewViewport = await companion.evaluate(() => {
      const layer = (globalThis as any).__companionXrTest.active.session.renderState.baseLayer;
      const gl = (globalThis as any).__companionXrTest.active.gl ?? layer.context;
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return { width: innerWidth, height: innerHeight, canvasWidth: layer.framebufferWidth, canvasHeight: layer.framebufferHeight,
        vendor: gl?.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR), renderer: gl?.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) };
    });
    assert.ok(controllerInputOnly || autoplayManipulation || report.xrReviewViewport.canvasHeight >= 628, 'The simulated eye buffer must retain its review height.');
    console.log(`Observed: production ${enteredMode} session is drawing two eye poses.`);
    if (naturalInputOnly) {
      report.emulatedXr.syntheticNaturalInput = {};
      await runNaturalInputAcceptance(companion, () => privateInspection(sessionId), report.emulatedXr.syntheticNaturalInput);
      await companion.setViewportSize({ width: 1400, height: 900 });
      await companion.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await companion.screenshot({ path: resolve(out, 'scene-controls-menu.png') });
      report.emulatedXr.syntheticNaturalInput.xrCallbacksObserved = await companion.evaluate(() => (globalThis as any).__companionXrTest.active.rafCount);
      await assertRuntimeUnchanged();
      assert.deepEqual(report.errors, [], 'Synthetic natural input produced browser callback errors');
      assert.deepEqual(report.externalRequests, []);
      assertEvidenceClean();
      passed('Synthetic transient pointers drive the built viewer menu and saved manipulation on IWER; Apple runtime not exercised');
      throw Object.assign(Error('Synthetic natural input acceptance complete.'), { stereofoldRunComplete: true });
    }
    if (controllerInputOnly) {
      // Exercise the shipped pixel-pack/worker/upload route while the entry
      // molecule is in view. Explicit page source never falls back to hardware.
      const captured = (await call('capture_headset_view', { sessionId, source: 'page', maxWidth: 480,
        waitMs: 10000, savePath: resolve(out, 'headset-page-capture.jpg') })).structuredContent;
      report.headsetPageCapture = captured;
      assert.equal(captured?.captured, true, `The immersive page must return its own image: ${JSON.stringify(captured)}`);
      assert.equal(captured?.source, 'page');
      const image = await readFile(resolve(out, 'headset-page-capture.jpg'));
      assert.ok(image.byteLength > 1000 && image[0] === 0xff && image[1] === 0xd8, 'Expected the encoded headset JPEG.');
      passed('The immersive page captures, encodes and uploads a drawn frame through the production tool');
      report.emulatedXr.nativeControllerInput = {};
      await runControllerAcceptance(companion, () => privateInspection(sessionId), report.emulatedXr.nativeControllerInput);
      // Buffer dimensions differ intentionally: this tests input/save behavior, not optics.
      report.emulatedXr.nativeControllerInput.xrCallbacksObserved = await companion.evaluate(() => (globalThis as any).__companionXrTest.active.rafCount);
      await assertRuntimeUnchanged();
      assertEvidenceClean();
      passed('Native controller snapshots drive the production viewer, saved placement, and missing-pose menu recovery');
      throw Object.assign(Error('Native controller input acceptance complete.'), { stereofoldRunComplete: true });
    }
    // Opt-in (STEREOFOLD_VREXIT_SWITCH=1), because it deliberately ends the
    // session this run is about to test.
    //
    // Passthrough and plain VR are separate WebXR sessions, so asking for one
    // from inside the other is an end followed by a fresh request. The question
    // this answers is whether the fresh request lands without a page gesture.
    // It is asked through the spoken phrase rather than through the viewer API,
    // so what it measures is the whole route the wearer uses.
    //
    // Read the answer narrowly. IWER implements no user-activation check at
    // all, so a success here proves the plumbing — teardown, re-request, mode
    // reported, tour state kept — and says nothing about Quest Browser, which
    // is Chromium and does check.
    if (process.env.STEREOFOLD_VREXIT_SWITCH === '1') {
      const spoken = enteredMode === 'immersive-ar' ? 'vr mode' : 'passthrough mode';
      const before = await companion.evaluate(() => (window as any).__companionXrTest.active?.mode ?? null);
      // Where the structure is sitting and which lesson step is up. Both belong
      // to the page rather than to the session, and the switch is only tolerable
      // if they are still there afterwards: a wearer who says "go dark" and
      // finds the molecule back at its default seat has lost their place.
      const seatBefore = (await privateInspection(sessionId)).scene.inspection.placement;
      const tourBefore = await readTourToolbarState(companion);
      await companion.evaluate(async (phrase: string) => { await (globalThis as any).__stereofoldVoice.say(phrase); }, spoken);
      await companion.waitForTimeout(4_000);
      const after = await companion.evaluate(() => {
        const test = (window as any).__companionXrTest;
        const entries = (window as any).__stereofoldDiagnostics?.entries?.() ?? [];
        return { mode: test.active?.mode ?? null, sessions: test.sessions.length,
          passthrough: entries.filter((entry: any) => entry.kind === 'passthrough').map((entry: any) => entry.detail) };
      });
      const seatAfter = (await privateInspection(sessionId)).scene.inspection.placement;
      const tourAfter = await readTourToolbarState(companion);
      assert.deepEqual(seatAfter, seatBefore, 'A blend-mode switch moved the structure the wearer had placed.');
      assert.equal(tourAfter.selectedId, tourBefore.selectedId, 'A blend-mode switch changed which lesson was loaded.');
      assert.equal(tourAfter.bodyPageIndex, tourBefore.bodyPageIndex, 'A blend-mode switch moved the lesson caption.');
      (report as any).blendModeSwitch = { spoken, before, after,
        keptSeat: seatAfter, keptTour: { selectedId: tourAfter.selectedId, active: tourAfter.active, bodyPageIndex: tourAfter.bodyPageIndex } };
      console.log(`Observed: spoken "${spoken}" left the page in ${after.mode ?? 'no session'} after ${after.sessions} granted session(s).`);

      // Now the case this runtime cannot produce on its own. IWER grants every
      // immersive request, so the refusal a Quest gives a page with no
      // transient activation has to be injected to be seen at all. One
      // rejection, exactly the one Chromium raises, and then the page is on its
      // own: it has to put a single press in front of a wearer who is holding a
      // controller and looking at a flat panel, and that press has to finish
      // what they asked for.
      await companion.evaluate(() => {
        const xr = (navigator as any).xr, real = xr.requestSession.bind(xr);
        let armed = true;
        xr.requestSession = async (mode: string, options: any) => {
          if (!armed) return real(mode, options);
          armed = false;
          throw Object.assign(Error('The requested session requires user activation.'), { name: 'SecurityError' });
        };
      });
      const refusedPhrase = after.mode === 'immersive-ar' ? 'vr mode' : 'passthrough mode';
      await companion.evaluate(async (phrase: string) => { await (globalThis as any).__stereofoldVoice.say(phrase); }, refusedPhrase);
      // The page reads the pending request off its own heartbeat, which runs
      // about every two seconds.
      await companion.locator('[data-resume-xr]').waitFor({ state: 'visible', timeout: 15_000 });
      const stranded = await companion.evaluate(() => {
        const button = document.querySelector<HTMLElement>('[data-resume-xr]');
        const box = button?.getBoundingClientRect();
        return { label: button?.textContent ?? null,
          note: document.querySelector<HTMLElement>('.xr-resume small')?.textContent ?? null,
          heightPx: box ? Math.round(box.height) : null,
          entryRowHidden: (document.querySelector<HTMLElement>('.xr-entry-actions') as any)?.hidden ?? null,
          optionsHidden: (document.querySelector<HTMLElement>('.xr-options') as any)?.hidden ?? null,
          session: (window as any).__companionXrTest.active?.mode ?? null };
      });
      // A real Playwright click is a real page gesture, which is the whole
      // point of the button: it carries the activation the switch could not.
      await companion.locator('[data-resume-xr]').click();
      await waitImmersive([refusedPhrase === 'vr mode' ? 'immersive-vr' : 'immersive-ar']);
      const recovered = await companion.evaluate(() => (window as any).__companionXrTest.active?.mode ?? null);
      (report as any).blendModeSwitchRefused = { spoken: refusedPhrase, stranded, recovered };
      console.log(`Observed: a refused "${refusedPhrase}" left one ${JSON.stringify(stranded.label)} button on the page, and pressing it opened ${recovered}.`);
    }
    // The production request must require nothing and still offer this device
    // hand tracking and both floor spaces. IWER's Meta Quest 2 profile
    // supports all three, so a granted set that is missing one means the
    // request stopped asking for it.
    const requestedXrFeatures = await companion.evaluate(() => {
      const active = (window as any).__companionXrTest.active;
      return { requested: active.requestedFeatures, enabled: active.enabledFeatures };
    });
    report.xrFeatures = requestedXrFeatures;
    assert.deepEqual(requestedXrFeatures.requested.required, [],
      'Entering immersion must require no optional feature.');
    for (const feature of ['hand-tracking', 'local-floor', 'bounded-floor']) {
      assert.ok(requestedXrFeatures.requested.optional.includes(feature),
        `The production session request must offer ${feature} as an optional feature.`);
      assert.ok(requestedXrFeatures.enabled.includes(feature),
        `The emulated Quest 2 runtime should have granted the optional ${feature}.`);
    }
    passed('The production headset request requires no feature and still has hand tracking and both floor spaces granted on the emulated Quest 2');
    // Entering the headset view is itself a state the assistant wants to see,
    // so publish here rather than waiting for the first command or capture.
    // This is also the only bridge write that reads its own frame.
    await publishBridge();
    const entered = await companion.evaluate(() => {
      const test = (window as any).__companionXrTest, active = test.active;
      return { mode: active.mode, rafCount: active.rafCount, head: { x: test.device.position.x, y: test.device.position.y, z: test.device.position.z }, pose: active.poses.at(-1) };
    });
    assertToolbarPoint(entered.head, headPose.position);
    // The tour is driven through the same production controller ray path as
    // molecular controls. Its XR scenes may change appearance, placement and
    // selection, but must never replay a desktop camera into the wearer pose.
    // Every row is resolved by action id immediately before its press.
    // Selecting a lesson, starting it, paginating a caption and reaching the
    // first or last scene each add or remove a row, which moves every control
    // below it; a target pinned earlier in this run would press its neighbour.
    let toolbarCollapsed = false;
    const pressToolbar = async (action: string, query: ToolbarQuery | ToolbarQuery[]) => {
      const evidence = await pressXrToolbarWhenReady(companion, action, () => toolbarTarget(companion, toolbarCollapsed, query));
      if (!Array.isArray(query) && typeof query === 'object' && query.kind === 'collapse') toolbarCollapsed = Boolean(query.value);
      return evidence;
    };
    // XR entry seats the live molecule asynchronously, then the inspector
    // saves it. A pre-save host snapshot can still contain desktop identity
    // placement even though the wearer is already looking at the seated view.
    const entryBaseline = await waitForSavedXrEntry({
      readLivePlacement: () => companion.evaluate(() => (globalThis as any).__stereofoldMenu?.state()?.placement),
      readSaved: () => privateInspection(sessionId),
      readState: async () => (await call('get_inspection_state', { sessionId })).structuredContent,
      panelId: companionPanel,
    });
    if (autoplayManipulation) {
      // Host setup selects the authored lesson paused and silent; Play itself
      // remains a real controller ray press. No scene/placement hook is used.
      await companion.evaluate(() => { document.body.dataset.tourDelayMs = '4000'; });
      const ready = await waitPanelReady(sessionId, 'companion', companionPanel);
      await call('control_tour', { ...binding(ready, sessionId), panelId: companionPanel,
        commandId: 'autoplay-manipulation-start', action: 'start',
        tourId: opened.structuredContent.customTourId, autoplay: false, narration: false });
      await waitState(sessionId, state => state.command?.commandId === 'autoplay-manipulation-start'
        && state.command?.status === 'rendered', 'autoplay-manipulation-start', 300_000);
      await waitCurrentTour(companion, state => state.active && !state.navigating && !state.autoplay);
      report.emulatedXr.autoplayManipulation = {};
      await runAutoplayManipulationAcceptance(companion, {
        readSaved: () => privateInspection(sessionId),
        play: () => pressToolbar('Play while manipulating molecule', { kind: 'tour-play' }),
        capture: name => captureXrFramebuffer(companion, name),
        chapterCount: demo!.manifest.chapters.length,
        evidence: report.emulatedXr.autoplayManipulation,
      });
      await assertRuntimeUnchanged();
      assert.deepEqual(report.errors, [], 'Autoplay molecule manipulation produced browser callback errors');
      assert.deepEqual(report.externalRequests, []);
      assertEvidenceClean();
      passed('Native molecule trigger, grip rotation and bimanual scaling hold across autoplay chapters while the untouched menu stays fixed');
      throw Object.assign(Error('Autoplay molecule manipulation acceptance complete.'), { stereofoldRunComplete: true });
    }
    const tourBefore = entryBaseline.saved;
    const densityTour = Boolean(demo?.entry.coordinates.volume);
    const measureTourGeometry = async () => {
      if (!densityTour) return companion.evaluate(() => (globalThis as any).__stereofoldMeasureMolecule());
      const geometry = await companion.evaluate(() => (globalThis as any).__stereofoldMeasureDensity());
      assert.ok(geometry.vertexCount > 0 && geometry.triangleCount > 0 && geometry.objectCount === 1,
        'The density lesson must retain one visible isosurface with live triangles.');
      assert.deepEqual(geometry.eyes.map((eye:any)=>eye.eye).sort(),['left','right']);
      for (const eye of geometry.eyes) assert.ok(eye.tangentSilhouette && eye.angularDegrees?.width > 0 && eye.angularDegrees?.height > 0,
        `${eye.eye} eye must contain projected live density geometry.`);
      return geometry;
    };
    if (tourMode && densityTour) {
      const response=await fetch(`${companionOrigin}/density`,{headers:{Authorization:`Bearer ${new URL(companionUrl).hash.slice(1)}`}});
      assert.equal(response.status,200,'Density hydration must use the authenticated map endpoint.');
      const bytes=Buffer.from(await response.arrayBuffer()),sha256=createHash('sha256').update(bytes).digest('hex');
      assert.equal(sha256,demo!.entry.coordinates.sha256);
      assert.equal(response.headers.get('x-stereofold-density-sha256'),sha256);
      assert.equal(Number(response.headers.get('x-stereofold-density-contour')),demo!.entry.coordinates.volume!.contour);
      report.densitySource={bytes:bytes.length,sha256,contour:demo!.entry.coordinates.volume!.contour,route:'private-loopback'};
    }
    if (tourMode) report.tourEntry = { placement: tourBefore.scene?.inspection?.placement,
      livePlacement: entryBaseline.livePlacement, inspectionRevision: tourBefore.inspectionRevision,
      molecularGeometry: await measureTourGeometry() };
    const poseBeforeTour = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1));
    // `inspect_lesson` hydrates one authored lesson and the player selects it,
    // so the panel offers Start tour with no chooser rows at all: the live rows
    // are Talk, Start tour, Caption n/m, Open in Mol*, Menu, Move menu. Pressing
    // a Tour menu row that the wearer never sees would fail on a real panel too.
    if (!demo) {
      // Entry starts compact. Its Tour row plays the selected lesson; the
      // chooser is under Menu, so expand the actual drawn controls first.
      const initialRows = await waitLivePanelRows(companion, [{ kind: 'collapse' }]);
      const menuToggle = initialRows?.find(row => row.action?.kind === 'collapse');
      assert.equal(typeof menuToggle?.action?.value, 'boolean',
        'The entry toolbar must publish its actual compact or expanded control before opening the chooser.');
      if (menuToggle?.action?.value === false) {
        await pressToolbar('Expand controls for tour chooser', { kind: 'collapse', value: false });
      }
      // An action record proves dispatch, not its asynchronous redraw. Read
      // the completed expanded controls before resolving the chooser seat.
      const expandedRows = await waitLivePanelRows(companion, [{ kind: 'collapse', value: true }]);
      assert.ok(expandedRows?.some(row => row.action?.kind === 'collapse' && row.action.value === true),
        'The Menu press must commit the expanded toolbar before opening the tour chooser.');
      await pressToolbar('Tour menu', [{ kind: 'tour-menu' }, { kind: 'tour-choice' }]);
      await waitCurrentTour(companion, state => state.menuOpen === true);
      // The default owner is the molecular journey player. Its chooser has no
      // legacy "Tour menu open" status sentence; verify its actual open panel
      // and drawn Next row, then retain a source-local journey for this fixture.
      await companion.waitForFunction(() => {
        const root = document.querySelector<HTMLElement>('.experience-player:not([hidden])');
        return root ? root.querySelector<HTMLElement>('.experience-library')?.hidden === false
          : document.querySelector<HTMLElement>('.tour-player:not([hidden])')?.dataset.menuOpen === 'true';
      });
      const chooserBefore = await currentTour(companion);
      await pressToolbar('Next tour', { kind: 'tour-choice' });
      await waitCurrentTour(companion, state => state.selectedId !== chooserBefore.selectedId);
      const choices = (await call('list_experiences', {})).structuredContent.experiences;
      for (let turns = 0; (await currentTour(companion)).selectedId !== 'hemoglobin-quaternary-structure'; turns++) {
        assert.ok(turns < choices.length, 'The drawn journey chooser never reached the loaded 4HHB source.');
        const before = await currentTour(companion);
        await pressToolbar('Next tour', { kind: 'tour-choice' });
        await waitCurrentTour(companion, state => state.selectedId !== before.selectedId);
      }
      assert.ok((await livePanelRows(companion))?.some(row => row.action?.kind === 'tour-play'),
        'The selected journey must draw an actionable Start row.');
    }
    await companion.waitForFunction(() => Boolean((document.querySelector('.tour-player:not([hidden]) [data-tour-menu], .experience-player:not([hidden]) [data-experience-menu]') as HTMLSelectElement)?.value));
    await companion.waitForFunction(() => {
      const title = document.querySelector('.tour-player:not([hidden]) [data-tour-title], .experience-player:not([hidden]) [data-experience-title]')?.textContent?.trim() ?? '';
      const progress = document.querySelector('.tour-player:not([hidden]) [data-tour-progress], .experience-player:not([hidden]) [data-experience-progress]')?.textContent?.trim() ?? '';
      // The selected lesson's narration is rendered by the immersive toolbar;
      // the desktop panel shows its scene body only after Start. Confirm the
      // chooser's real selection state here, then validate body text at scene 1.
      const journey = document.querySelector<HTMLElement>('.experience-player:not([hidden])');
      const menu = journey?.querySelector<HTMLSelectElement>('[data-experience-menu]');
      return journey ? Boolean(menu?.value && menu.selectedOptions[0]?.textContent?.trim()
        && journey.querySelector('[data-experience-summary]')?.textContent?.trim())
        : Boolean(title && /scenes\s+ready/i.test(progress));
    });
    const menuPixels = await captureXrFramebuffer(companion, '07-tour-menu-xr');

    // Opt-in (STEREOFOLD_PTOFF_PROBE=1). Asking for the room to go away used to
    // end the WebXR session and leave the wearer on the 2D page, where Quest
    // Browser grants no way back without a trigger press. Hiding the room is now an
    // opaque clear inside the same alpha-blend session, so this asks for it
    // both ways a wearer can — the spoken phrase and the menu row — and
    // requires the session to outlive both.
    //
    // Two things have to be true and neither is provable from the other. The
    // session identity is read from the runtime's own session list and the
    // live record, so a teardown and re-entry cannot hide behind a mode string
    // that happens to match. The room itself is read from the alpha channel of
    // the presentation framebuffer, which is the byte the Quest compositor
    // actually blends the camera behind.
    //
    // It restores the room before returning, so the rest of this file runs
    // against the state it would have had anyway.
    if (process.env.STEREOFOLD_PTOFF_PROBE === '1' && enteredMode === 'immersive-ar') {
      const sessionIdentity = async () => await companion.evaluate(() => {
        const test = (window as any).__companionXrTest, active = test.active;
        return { mode: active?.mode ?? null, ended: Boolean(active?.ended), grantedSessions: test.sessions.length,
          presenting: Boolean(active) && !active.ended };
      });
      // Transparent pixels are the room coming through; opaque ones are the
      // room hidden. Both eyes, so a single-eye clear cannot pass.
      const roomAlpha = (frame: any) => frame.eyes.map((eye: any) =>
        ({ eye: eye.eye, ...eye.clearAlpha, corners: eye.backgroundSamples }));
      const passthroughRecords = async () => await diagnosticsOf(companion, 'passthrough');
      const beforeIdentity = await sessionIdentity();
      const shownFrame = await captureXrFramebuffer(companion, '07p-ptoff-room-shown');
      const shownAlpha = roomAlpha(shownFrame);
      assert.ok(shownAlpha.every((eye: any) => eye.transparent > 0),
        `The passthrough session drew no transparent pixels at all, so nothing here can tell the room apart from an opaque clear: ${JSON.stringify(shownAlpha)}`);

      // "vr mode" is how a wearer asks for the room to go, and the
      // grammar maps it to passthrough-off. Speaking it exercises the whole
      // wearer route rather than the viewer API behind it.
      await companion.evaluate(async () => { await (globalThis as any).__stereofoldVoice.say('vr mode'); });
      await companion.waitForFunction(() => ((globalThis as any).__stereofoldDiagnostics?.entries?.() ?? [])
        .some((entry: any) => entry.kind === 'passthrough' && entry.detail?.requested === false
          && entry.detail?.outcome === 'applied'), undefined, { timeout: 20_000 });
      const hiddenIdentity = await sessionIdentity();
      const hiddenFrame = await captureXrFramebuffer(companion, '07p-ptoff-room-hidden');
      const hiddenAlpha = roomAlpha(hiddenFrame);
      const spokenRecords = await passthroughRecords();
      assert.deepEqual(hiddenIdentity, beforeIdentity,
        `Hiding the room changed the XR session the wearer was in: ${JSON.stringify({ beforeIdentity, hiddenIdentity })}`);
      assert.ok(!spokenRecords.some((entry: any) => ['switching', 'switched', 'needs-press'].includes(entry.outcome)),
        `Hiding the room still went through a blend-mode switch: ${JSON.stringify(spokenRecords)}`);
      assert.ok(hiddenAlpha.every((eye: any) => eye.transparent === 0 && eye.opaque === eye.total),
        `The room-off clear left transparent pixels, so the Quest compositor would still show the room: ${JSON.stringify(hiddenAlpha)}`);

      // The row the wearer is actually looking at, reassembled from the chunked
      // redraw the panel publishes -- the same `livePanelRows` every press aims
      // with. The press below offers the bare `passthrough` kind as its
      // fallback: that is the row the Node-side model builds when it is handed
      // no live passthrough state.
      const drawnPassthroughRow = async () => {
        const rows = await livePanelRows(companion);
        if (!rows) return null;
        const labels = rows.map(row => row.label);
        const index = rows.findIndex(row => JSON.stringify(row.action ?? '').includes('"passthrough"'));
        return index < 0 ? null : { label: labels[index], action: JSON.stringify(rows[index].action), rows: labels };
      };
      const hiddenRow = await drawnPassthroughRow();
      assert.ok(hiddenRow && hiddenRow.label === 'Room hidden' && hiddenRow.action.includes('"on":true'),
        `The drawn menu row did not follow the room off; it still reads ${JSON.stringify(hiddenRow)}`);

      // And back, through the menu row, which is the route for a wearer whose
      // hands are on the controllers rather than on the talk button. A bare
      // `passthrough` action is the same row with no state on it, and pressing
      // it toggles, so either match is the press the wearer would make.
      //
      // At a yawed head this harness's synthetic controller ray misses rows,
      // which is a known defect of the emulator rather than of the panel. Those
      // runs say the same thing out loud instead, so a yawed pass still covers
      // the round trip rather than failing on the ray.
      const restoreRoute = Math.abs(headYawDegrees) < 1 ? 'menu' : 'voice';
      if (restoreRoute === 'menu') await pressToolbar('Room hidden', [{ kind: 'passthrough', on: true }, { kind: 'passthrough' }]);
      else await companion.evaluate(async () => { await (globalThis as any).__stereofoldVoice.say('passthrough mode'); });
      await companion.waitForFunction(() => ((globalThis as any).__stereofoldDiagnostics?.entries?.() ?? [])
        .some((entry: any) => entry.kind === 'passthrough' && entry.detail?.requested === true
          && entry.detail?.outcome === 'applied'), undefined, { timeout: 20_000 });
      const restoredIdentity = await sessionIdentity();
      const restoredFrame = await captureXrFramebuffer(companion, '07p-ptoff-room-restored');
      const restoredAlpha = roomAlpha(restoredFrame);
      assert.deepEqual(restoredIdentity, beforeIdentity,
        `Showing the room again changed the XR session: ${JSON.stringify({ beforeIdentity, restoredIdentity })}`);
      assert.ok(restoredAlpha.every((eye: any) => eye.transparent > 0),
        `The room never came back: the restored clear is opaque in every pixel: ${JSON.stringify(restoredAlpha)}`);
      report.emulatedXr.passthroughOff = { mode: enteredMode, headYawDegrees, restoreRoute,
        beforeIdentity, hiddenIdentity, restoredIdentity,
        shownAlpha, hiddenAlpha, restoredAlpha, records: await passthroughRecords(),
        frames: { shown: '07p-ptoff-room-shown.png', hidden: '07p-ptoff-room-hidden.png', restored: '07p-ptoff-room-restored.png' } };
      passed(`A spoken "vr mode" hides the wearer's room with an opaque clear and the ${restoreRoute === 'menu' ? 'menu row' : 'spoken "passthrough mode"'} brings it back, both inside the one immersive-ar session the wearer entered`);
      // Leave the panel the way this probe found it. A voice state that has not
      // returned to idle renames the Talk row, and every later press in this
      // file aims with a row model that is handed the state from the DOM one
      // read earlier, so a probe that walks away mid-utterance costs a
      // neighbouring press several hundred lines from here.
      await companion.waitForFunction(() => (document.querySelector('.voice-panel') as HTMLElement | null)?.dataset.voiceState === 'idle',
        undefined, { timeout: 30_000 }).catch(() => {});
    }

    // Generic model-tool reads are not a live voice consumer. This offline
    // harness has claimed no microphone utterance or admitted response, so an
    // unknown synthetic phrase must not claim it was forwarded to an assistant.
    // The attached-consumer case is covered by agent-presence.test.ts.
    assert.ok(await companion.evaluate(() => typeof (globalThis as any).__stereofoldVoice?.say === 'function'),
      'An immersive session must install the voice test hook.');
    const beforeVoicePresence = await privateInspection(sessionId);
    const forwarded = await companion.evaluate(async () => {
      const kind = await (globalThis as any).__stereofoldVoice.say('do something with the molecule');
      const entry = (globalThis as any).__stereofoldDiagnostics?.entries?.()
        .filter((item: any) => item.kind === 'voice-command').at(-1);
      return { kind, outcome: entry?.detail?.outcome ?? null, phrase: entry?.detail?.phrase ?? null };
    });
    assert.equal(forwarded.kind, null, 'A sentence outside the grammar must dispatch no action.');
    assert.equal(forwarded.phrase, 'do something with the molecule');
    assert.equal(forwarded.outcome, 'unrecognized',
      'Generic tool traffic must not make an unknown sentence claim it was forwarded to a voice consumer.');
    assert.deepEqual((await privateInspection(sessionId)).scene, beforeVoicePresence.scene,
      'An unknown sentence changed the saved molecular scene.');
    report.emulatedXr.voice = { activeConsumer: false, unknownSentenceOutcome: forwarded.outcome };
    passed('Without a claimed voice consumer, an unknown synthetic phrase does not claim assistant forwarding and changes no molecular state');

    // Opt-in (STEREOFOLD_AGENT_MOTION=1). The agent's own "spin it" / "stop"
    // against a presenting headset panel, which is the command pair a wearer
    // asks for by voice most often. It
    // runs inside the live immersive session, so it deliberately ends the run
    // rather than leaving a baked rotation under every later case.
    if (process.env.STEREOFOLD_AGENT_MOTION === '1') {
    const sha = (frame: any, eye: string) => frame.eyes.find((value: any) => value.eye === eye)?.sha256;
    // Every confirmation record the page keeps, so the two words the wearer
    // should hear are evidence rather than an assumption.
    const spokenRecords = async () => await companion.evaluate(() => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
      .filter((entry: any) => ['reply-received', 'reply-audio-play', 'reply-audio-fetch', 'reply-audio-error',
        'voice-acknowledgement', 'voice-command'].includes(entry.kind))
      .map((entry: any) => ({ kind: entry.kind, detail: entry.detail })));
    const sendMotion = async (state: 'spin' | 'stop', commandId: string) => {
      const ready = await waitPanelReady(sessionId, 'companion', companionPanel);
      const queued = await call('update_inspection', { ...binding(ready, sessionId), panelId: companionPanel,
        commandId, change: { kind: 'motion', patch: { state } } });
      const receipt = await waitState(sessionId, current => current.command?.commandId === commandId
        && ['rendered', 'rejected', 'expired', 'conflict', 'unconfirmed'].includes(current.command?.status), commandId, 300_000);
      const observed = { state, queued: (queued.structuredContent as any)?.command?.status,
        status: receipt.command?.status, reason: receipt.command?.reason ?? null,
        failureReason: receipt.command?.failureReason ?? null,
        renderedRevision: receipt.command?.renderedRevision ?? null };
      report.emulatedXr.agentMotion.commands.push(observed);
      return { receipt, observed };
    };
    report.emulatedXr.agentMotion = { headYawDegrees, commands: [] as any[] };
    const beforeMotion = await privateInspection(sessionId);
    await captureXrFramebuffer(companion, '07m-agent-motion-before');
    const spin = await sendMotion('spin', 'emumotion-spin');
    assert.equal(spin.observed.status, 'rendered', `Agent motion spin did not render: ${JSON.stringify(spin.observed)}`);
    const spinA = await captureXrFramebuffer(companion, '07m-agent-motion-spin-a');
    await companion.waitForTimeout(3_000);
    const spinB = await captureXrFramebuffer(companion, '07m-agent-motion-spin-b');
    for (const eye of ['left', 'right']) assert.notEqual(sha(spinB, eye), sha(spinA, eye),
      `An agent spin did not turn the structure in the ${eye} eye over three seconds.`);
    // A spin is a presentation pose, exactly as the pressed row and the spoken
    // command are, so it must save nothing.
    assert.deepEqual((await privateInspection(sessionId)).scene, beforeMotion.scene,
      'An agent spin changed the saved molecular scene.');
    report.emulatedXr.agentMotion.spokenAfterSpin = await spokenRecords();
    const stop = await sendMotion('stop', 'emumotion-stop');
    assert.equal(stop.observed.status, 'rendered', `Agent motion stop did not render: ${JSON.stringify(stop.observed)}`);
    const stopped = await waitPrivate(sessionId, data => data.inspectionRevision === stop.receipt.inspectionRevision);
    report.emulatedXr.agentMotion.placement = { before: beforeMotion.scene.inspection.placement,
      afterStop: stopped.scene.inspection.placement };
    report.emulatedXr.agentMotion.spokenAfterStop = await spokenRecords();
    assert.notDeepEqual(stopped.scene.inspection.placement.rotation, beforeMotion.scene.inspection.placement.rotation,
      'An agent stop did not bake the shown angle into the saved placement.');
    assert.deepEqual(stopped.scene.inspection.appearance, beforeMotion.scene.inspection.appearance,
      'An agent stop changed appearance.');
    assert.deepEqual(stopped.scene.selectionKeys, beforeMotion.scene.selectionKeys, 'An agent stop changed selection.');
    // The wearer's own status row is drawn in the same framebuffer and settles
    // one revision behind the receipt, so wait for it to read the applied
    // revision. Without this the menu's own text change reads as motion.
    await companion.waitForFunction(revision => document.querySelector('[data-session-outcome]')?.textContent?.includes(`revision ${revision}`),
      stop.receipt.command.renderedRevision);
    await companion.waitForTimeout(1_000);
    const stopA = await captureXrFramebuffer(companion, '07m-agent-motion-stopped-a');
    await companion.waitForTimeout(1_500);
    const stopB = await captureXrFramebuffer(companion, '07m-agent-motion-stopped-b');
    for (const eye of ['left', 'right']) assert.equal(sha(stopB, eye), sha(stopA, eye),
      `The structure kept turning in the ${eye} eye after the agent stop.`);
    passed('An agent motion spin turns the structure in both eyes of a presenting headset panel without saving anything, and an agent stop renders, halts the turn, and bakes the shown angle into the saved placement alone');

    // The tour interaction a wearer hits first: a lesson playing while the
    // agent spins the molecule. `plugin/src/inspector.ts:592` pauses the tour on
    // every remote command, so this records what a wearer would actually see
    // rather than asserting a behaviour nobody has chosen yet.
    const tourProgress = async () => (await companion.locator('.tour-player:not([hidden]) [data-tour-progress], .experience-player:not([hidden]) [data-experience-progress]').textContent())?.trim() ?? '';
    // Hold the dwell open so autoplay cannot advance a scene underneath this
    // observation; the toolbar reads the same seam whenever it schedules.
    await companion.evaluate(() => { document.body.dataset.tourDelayMs = '600000'; });
    const tourReady = await waitPanelReady(sessionId, 'companion', companionPanel);
    await call('control_tour', { ...binding(tourReady, sessionId), panelId: companionPanel,
      commandId: 'emumotion-tour-play', action: 'play' });
    const playReceipt = await waitState(sessionId, current => current.command?.commandId === 'emumotion-tour-play'
      && ['rendered', 'rejected', 'expired', 'conflict', 'unconfirmed'].includes(current.command?.status), 'emumotion-tour-play', 300_000);
    // What a wearer can actually read: the tour's own status line, its progress
    // row and the panel record the agent polls.
    const tourSurface = async (panel: any) => ({
      progress: await tourProgress(),
      status: (await companion.locator('.tour-player:not([hidden]) [data-tour-status], .experience-player:not([hidden]) [data-experience-status]').textContent().catch(() => null))?.trim() ?? null,
      panel: panel.panels.find((entry: any) => entry.panelId === companionPanel),
    });
    const playingPanel = await waitPanelReady(sessionId, 'companion', companionPanel);
    const beforeSpinSurface = await tourSurface(playingPanel);
    const duringTourSpin = await sendMotion('spin', 'emumotion-tour-spin');
    const afterSpinSurface = await tourSurface(await waitPanelReady(sessionId, 'companion', companionPanel));
    const spinRecords = await diagnosticsOf(companion, 'tour');
    const duringTourStop = await sendMotion('stop', 'emumotion-tour-stop');
    const afterStopSurface = await tourSurface(await waitPanelReady(sessionId, 'companion', companionPanel));
    report.emulatedXr.agentMotion.duringTour = {
      play: { status: playReceipt.command?.status, reason: playReceipt.command?.reason ?? null },
      beforeSpin: beforeSpinSurface,
      spin: duringTourSpin.observed, afterSpin: afterSpinSurface, recordsAfterSpin: spinRecords,
      stop: duringTourStop.observed, afterStop: afterStopSurface,
      recordsAfterStop: await diagnosticsOf(companion, 'tour'),
    };
    await captureXrFramebuffer(companion, '07m-agent-motion-during-tour');

    // The third command kind the wearer's status plate can get stuck on, and
    // the one that proves the plate's field
    // words are translated rather than passed through: a render-quality change
    // names `level` on the wire and has to reach the plate as `quality`.
    const qualityReady = await waitPanelReady(sessionId, 'companion', companionPanel);
    await call('update_inspection', { ...binding(qualityReady, sessionId), panelId: companionPanel,
      commandId: 'waitplate2-quality', change: { kind: 'render-quality', patch: { level: 'best' } } });
    const qualityReceipt = await waitState(sessionId, current => current.command?.commandId === 'waitplate2-quality'
      && ['rendered', 'rejected', 'expired', 'conflict', 'unconfirmed'].includes(current.command?.status),
    'waitplate2-quality', 300_000);
    // The plate has to read the applied revision, not a `Waiting` left over
    // from the command's own queued beat. One second is the budget;
    // `waitForFunction` polls well inside it and fails the run if the sentence
    // never arrives.
    await companion.waitForFunction(revision => document.querySelector('[data-session-outcome]')?.textContent?.includes(`revision ${revision}`),
      qualityReceipt.command.renderedRevision, { timeout: 5_000 });
    // What the wearer can actually read, straight off the page's own ring:
    // every sentence handed to the plate and every line the toolbar drew.
    report.emulatedXr.agentMotion.renderQuality = {
      status: qualityReceipt.command?.status ?? null,
      renderedRevision: qualityReceipt.command?.renderedRevision ?? null,
      hudOutcomes: await diagnosticsOf(companion, 'hud-outcome'),
      plate: await diagnosticsOf(companion, 'outcome'),
      toolbar: await diagnosticsOf(companion, 'toolbar'),
    };
    await captureXrFramebuffer(companion, '07m-agent-quality-applied');
    // Stop here by throwing, so the finally block still writes browser-report.json
    // with this probe's recorded evidence and the diagnostics ring.
    throw Error('emumotion probe complete: stopping before the rest of the run.');
    }

    // One headset press is now the whole promise of `Start tour`: the lesson
    // plays. Hold its dwell open first, so autoplay cannot advance a scene
    // underneath the manual transport presses this case is about. The product
    // reads this seam whenever it schedules; the Play press below shortens it.
    await companion.evaluate(() => { document.body.dataset.tourDelayMs = '600000'; });
    // Chapter and growth walks can continue through the agent route if the
    // controller action fails. Preserve the press diagnostics and identify the
    // route that actually started playback; a fallback never proves input worked.
    let tourStartedBy = 'wearer';
    if (!tourMode && !growDrive && !growVoiceDrive) await pressToolbar('Start tour', { kind: 'tour-play' });
    else {
      try { await pressToolbar('Start tour', { kind: 'tour-play' }); }
      catch (pressError) {
        tourStartedBy = 'agent';
        report.tourStart = { pressed: false, reason: (pressError as Error).message.slice(0, 200) };
        const readyToPlay = await waitPanelReady(sessionId, 'companion', companionPanel);
        await call('control_tour', { ...binding(readyToPlay, sessionId), panelId: companionPanel,
          commandId: 'harnessfix-tour-play', action: 'play' });
        await waitState(sessionId, current => current.command?.commandId === 'harnessfix-tour-play'
          && current.command?.status === 'rendered', 'harnessfix-tour-play', 300_000);
      }
    }
    // The immersive first press plays past an opening scene that would render
    // the view already in front of the wearer, so the scene it lands on is the
    // player's decision rather than a number this harness can pin. Read that
    // decision from the tour's own diagnostics record and follow it.
    await companion.waitForFunction(() => {
      const current = (globalThis as any).__stereofoldMenu?.state()?.tour;
      const status = document.querySelector('.experience-player:not([hidden]) [data-experience-status], .tour-player:not([hidden]) [data-tour-status]')?.textContent ?? '';
      if (!current?.navigating && /Journey could not render:/i.test(status)) throw Error(`Journey stopped before its first scene: ${status}`);
      return /scene\s+\d+\s*\//i.test(document.querySelector('.tour-player:not([hidden]) [data-tour-progress], .experience-player:not([hidden]) [data-experience-progress]')?.textContent ?? '');
    });
    await companion.waitForFunction(() => Boolean(document.querySelector('.tour-player:not([hidden]) [data-tour-body], .experience-player:not([hidden]) [data-experience-body]')?.textContent?.trim()));
    const startRecord = (await diagnosticsOf(companion, 'tour')).filter((entry: any) => entry.action === 'start').at(-1);
    assert.ok(startRecord || tourStartedBy === 'agent' || (!demo && (await currentTour(companion)).active),
      'The Start tour press neither recorded a lesson start nor rendered an active journey.');
    if (startRecord) assert.equal(startRecord.autoplay, true, 'One headset press did not arm autoplay.');
    const openingScene = startRecord ? (startRecord.opening ?? 0) + 1
      : Number(/scene\s+(\d+)\s*\//iu.exec((await companion.locator('.tour-player:not([hidden]) [data-tour-progress], .experience-player:not([hidden]) [data-experience-progress]').textContent())?.trim() ?? '')?.[1] ?? 1);
    const atScene = async (scene: number) => await companion.waitForFunction(target => {
      const current = (globalThis as any).__stereofoldMenu?.state()?.tour;
      const status = document.querySelector('.experience-player:not([hidden]) [data-experience-status], .tour-player:not([hidden]) [data-tour-status]')?.textContent ?? '';
      if (!current?.navigating && /Journey could not render:/i.test(status)) throw Error(`Journey stopped before scene ${target}: ${status}`);
      return new RegExp(`scene\\s+${target}\\s*/`, 'i').test(document.querySelector('.tour-player:not([hidden]) [data-tour-progress], .experience-player:not([hidden]) [data-experience-progress]')?.textContent ?? '');
    }, scene);
    await atScene(openingScene);
    await waitCurrentTour(companion, state => state.autoplay === true);
    const tourFirst = await waitToolbarScene('Start tour', data => data.inspectionRevision > tourBefore.inspectionRevision);

    // Opt-in (`--grow`). The claim `grow_structure` makes is
    // that a wearer can watch the molecule get bigger without leaving the
    // session: the coordinates and the authored lesson are replaced together
    // and the page rebuilds in place. Nothing had ever driven it. This grows
    // the staged demo one tier at a time from whatever `--stage` opened, in
    // the immersive session the chapter above is already playing in, and
    // requires of every tier that the page really loaded it, that the session
    // survived, and that a frame came back out of both eyes.
    //
    // It ends at the device ceiling rather than at the top of the list. A
    // refusal is the product working: `molecular-growth.ts` would rather say
    // one short sentence than hand a Quest 2 a tier that ends the session with
    // the headset on, and the sentence is recorded here so what the wearer
    // would have heard can be read back.
    if (growDrive) {
      const growthOrder = growthStages(await readGrowthIndex())
        .filter((entry: GrowthStage) => entry.demo === demo!.entry.name);
      assert.ok(growthOrder.length > 1, `${demo!.entry.name} has no staged tiers, so there is nothing to grow.`);
      // A hydrate detaches and re-attaches (`inspector.ts:457` and `:521`), so
      // the panel id changes with every tier; a pinned one would address a
      // panel that no longer exists by the second grow.
      let panel = companionPanel;
      const readyCompanion = (state: any) => state.panels.find((entry: any) =>
        entry.surface === 'companion' && entry.current === true && entry.availability === 'ready');
      /** What the page is showing, read from its own private hydration. */
      const loadedTier = async () => {
        const data = await privateInspection(sessionId);
        return { lessonId: data.customTour?.id ?? null,
          atomSites: (data.catalog.rows as any[]).reduce((total, row) => total + row.atomSites.length, 0),
          sourceBytes: data.structureText.length,
          placement: data.scene?.inspection?.placement ?? null };
      };
      /**
       * The runtime's own session list rather than a mode string, so a teardown
       * and a re-entry cannot pass for a session that was never interrupted.
       */
      const xrSession = async () => await companion.evaluate(() => {
        const test = (window as any).__companionXrTest, active = test.active;
        return { mode: active?.mode ?? null, ended: Boolean(active?.ended), grantedSessions: test.sessions.length,
          presenting: Boolean(active) && !active.ended };
      });
      const opening = await loadedTier();
      const openingSession = await xrSession();
      assert.equal(openingSession.presenting, true, 'The grow drive needs a live immersive session to grow inside.');
      // Written before the first grow so a tier that fails still reports the
      // ones that landed.
      const tiers: any[] = [];
      report.emulatedXr.growth = { demo: demo!.entry.name, mode: enteredMode, from: opening.lessonId,
        order: growthOrder.map((entry: GrowthStage) => ({ stage: entry.stage.id, atomSites: entry.stage.coordinates.atomSites, tiers: entry.stage.tiers })),
        session: { atEntry: openingSession }, tiers };

      // The spoken route, first and from the page, exactly as a wearer reaches
      // it. `__stereofoldVoice.say` feeds the immersive runner's own grammar;
      // what it answers is recorded whether or not it grew anything, because a
      // phrase the shipped headset page cannot act on is the finding.
      const voiceBefore = await companion.evaluate(() => ((globalThis as any).__stereofoldDiagnostics?.entries?.() ?? []).length);
      await companion.evaluate(() => { void (globalThis as any).__stereofoldVoice?.say?.('grow it'); });
      await companion.waitForFunction(count => ((globalThis as any).__stereofoldDiagnostics?.entries?.() ?? [])
        .slice(count).some((entry: any) => entry.kind === 'voice-command'), voiceBefore, { timeout: 30_000 })
        .catch(() => undefined);
      const spokenGrow = (await diagnosticsOf(companion, 'voice-command')).at(-1);
      const afterSpoken = await loadedTier();
      report.emulatedXr.growth.spoken = { phrase: 'grow it', record: spokenGrow ?? null,
        lessonBefore: opening.lessonId, lessonAfter: afterSpoken.lessonId,
        grewATier: afterSpoken.lessonId !== opening.lessonId };

      for (;;) {
        const before = await loadedTier();
        const beforeSession = await xrSession();
        const ready = await waitState(sessionId, state => Boolean(readyCompanion(state)), undefined, XR_REBUILD_TIMEOUT_MS);
        panel = readyCompanion(ready).panelId;
        const requestedAt = Date.now();
        // Raw, so a refusal is reported in the host's own sentence. `call`
        // asserts on `isError` alone, and "grow_structure failed" says nothing
        // about which of its eight checks said no.
        const answer = await callRaw('grow_structure', { ...binding(ready, sessionId), panelId: panel, stage: 'next' });
        assert.ok(!answer.isError, `grow_structure refused: ${(answer.content ?? []).map((part: any) => part.text).filter(Boolean).join(' ')}`);
        const grow = (answer.structuredContent as any).grow;
        if (grow.refused) {
          const held = await loadedTier();
          report.emulatedXr.growth.refusal = { from: grow.from, deviceTier: grow.deviceTier, spoken: grow.spoken,
            said: (answer.content ?? []).map((part: any) => part.text).filter(Boolean).join(' ').slice(0, 400),
            lessonStillLoaded: held.lessonId, atomSitesStillLoaded: held.atomSites,
            session: await xrSession() };
          assert.equal(held.lessonId, before.lessonId, 'A refused tier changed what the page was showing.');
          assert.ok(grow.spoken.trim().split(/\s+/).length <= 11, `A refusal read out in the headset must stay short: "${grow.spoken}"`);
          await captureXrFramebuffer(companion, `07g-grow-refused-at-${grow.from}`);
          break;
        }
        // The page learns its coordinates changed on its own 1 Hz beat
        // (`inspector.ts:956`), hydrates, and rebuilds the structure in place.
        // The tier has landed when a companion panel is current and ready again
        // under the new source token and is reporting the new lesson.
        const landed = await waitState(sessionId, state => {
          const entry = readyCompanion(state);
          return Boolean(entry) && entry.tour?.selectedId === grow.lessonId;
        }, undefined, XR_REBUILD_TIMEOUT_MS);
        const loadMs = Date.now() - requestedAt;
        panel = readyCompanion(landed).panelId;
        const after = await loadedTier();
        const session = await xrSession();
        const shot = await captureXrFramebuffer(companion, `07g-grow-${grow.to}`);
        const spatial = readyCompanion(landed).spatialContext ?? null;
        tiers.push({ from: grow.from, to: grow.to, grew: grow.grew, deviceTier: grow.deviceTier,
          declaredAtomSites: grow.atomSites, renderedAtomSites: after.atomSites, sourceBytes: after.sourceBytes,
          lessonId: after.lessonId, spoken: grow.spoken, loadMs,
          placementBefore: before.placement, placementAfter: after.placement,
          headRelativeToMolecule: spatial && { distance: spatial.distance, headPosition: spatial.headPosition },
          // Retain the requested fit and measured molecular geometry. Image
          // colour bounds also include UI, so they cannot validate that fit.
          focus: (await diagnosticsOf(companion, 'xr-focus')).at(-1) ?? null,
          // Standoff records molecular bounds and menu clearance in each eye.
          standoff: (await diagnosticsOf(companion, 'plate-standoff')).at(-1) ?? null,
          session, capture: shot.eyes.map((eye: any) => ({ eye: eye.eye, foreground: eye.foreground, sha256: eye.sha256,
            saturatedContent: eye.saturatedContent })) });
        assert.equal(after.lessonId, grow.lessonId, `The page kept lesson ${after.lessonId} after growing to ${grow.to}.`);
        assert.equal(after.atomSites, grow.atomSites,
          `The ${grow.to} tier rendered ${after.atomSites} atom sites, not the ${grow.atomSites} the index records.`);
        // The whole promise of growing rather than reopening. A new granted
        // session means the wearer went through entry again.
        assert.equal(session.presenting, true, `The immersive session ended while growing to ${grow.to}.`);
        assert.equal(session.ended, false, `The immersive session was torn down while growing to ${grow.to}.`);
        assert.equal(session.grantedSessions, beforeSession.grantedSessions,
          `Growing to ${grow.to} started a second XR session instead of rebuilding inside the first.`);
        assert.equal(session.mode, beforeSession.mode, `Growing to ${grow.to} changed the immersive mode.`);
        assert.ok(after.placement && after.placement.scale >= PLACEMENT_MIN_SCALE && after.placement.scale <= PLACEMENT_MAX_SCALE,
          `The ${grow.to} tier left no supported room placement: ${JSON.stringify(after.placement)}`);
        assert.ok(shot.eyes.every((eye: any) => eye.foreground > 100),
          `The ${grow.to} tier drew nothing a wearer could see in one of the eyes.`);
        passed(`${grow.from} grew into ${grow.to} (${grow.atomSites.toLocaleString()} atom sites) inside the same immersive session, in ${(loadMs / 1000).toFixed(1)} s`);
      }
      assert.ok(tiers.length > 0, 'The grow drive replaced no tier at all.');
      assert.ok(report.emulatedXr.growth.refusal, 'The grow drive never reached a tier the device refuses.');
      passed(`grow_structure walked ${tiers.map((tier: any) => tier.to).join(' -> ')} without leaving the immersive session, and stopped at the device ceiling with "${report.emulatedXr.growth.refusal.spoken}"`);
      // Stop here by throwing, so the finally block still writes
      // browser-report.json with this drive's evidence and the diagnostics ring.
      throw Error('grow drive complete: stopping before the rest of the run.');
    }

    // Opt-in (`--grow-voice`). `--grow` above proves the
    // protocol: the Mac asks `grow_structure` and the page rebuilds in place.
    // This proves the sentence. The page's own grammar once had no growth
    // phrase at all, so a wearer saying "grow it" into the headset microphone
    // got "Sent to Claude" and the molecule did not change; the grow that
    // worked was the one nobody in the headset could ask for.
    //
    // Everything here goes through `__stereofoldVoice.say`, which feeds the same
    // handler the Mac's transcript feeds, so nothing is driven that a spoken
    // sentence could not drive. `say` resolves once the dispatched action has
    // settled, which for a grow means the host answered AND the page finished
    // hydrating, so the tier is on screen by the time it returns.
    if (growVoiceDrive) {
      const growthOrder = growthStages(await readGrowthIndex())
        .filter((entry: GrowthStage) => entry.demo === demo!.entry.name);
      assert.ok(growthOrder.length > 1, `${demo!.entry.name} has no staged tiers, so there is nothing to grow.`);
      const loadedTier = async () => {
        const data = await privateInspection(sessionId);
        return { lessonId: data.customTour?.id ?? null,
          atomSites: (data.catalog.rows as any[]).reduce((total, row) => total + row.atomSites.length, 0),
          sourceBytes: data.structureText.length,
          placement: data.scene?.inspection?.placement ?? null };
      };
      const xrSession = async () => await companion.evaluate(() => {
        const test = (window as any).__companionXrTest, active = test.active;
        return { mode: active?.mode ?? null, ended: Boolean(active?.ended), grantedSessions: test.sessions.length,
          presenting: Boolean(active) && !active.ended };
      });
      assert.ok(await companion.evaluate(() => typeof (globalThis as any).__stereofoldVoice?.say === 'function'),
        'The immersive voice hook is not installed, so nothing can be said to this page.');
      const opening = await loadedTier();
      const openingSession = await xrSession();
      assert.equal(openingSession.presenting, true, 'The spoken grow drive needs a live immersive session to grow inside.');
      const spokenTiers: any[] = [];
      report.emulatedXr.spokenGrowth = { demo: demo!.entry.name, mode: enteredMode, from: opening.lessonId,
        session: { atEntry: openingSession }, tiers: spokenTiers };

      /** One utterance, and everything it changed. */
      const speak = async (phrase: string, label: string) => {
        const before = await loadedTier();
        const beforeSession = await xrSession();
        const saidAt = Date.now();
        // `say` returns the action kind the grammar resolved, or null for a
        // sentence the page has no command for. Null is the defect this drive
        // exists to close, so it is asserted rather than recorded.
        const kind = await companion.evaluate(async (said: string) =>
          await (globalThis as any).__stereofoldVoice.say(said), phrase);
        assert.equal(kind, 'grow-structure',
          `"${phrase}" resolved to ${kind ?? 'nothing'} in the headset's own grammar, not to a grow.`);
        const after = await loadedTier();
        const session = await xrSession();
        // The page's own record of the swap, written by the viewer's grow
        // branch. It carries the sentence the wearer was read out, which is the
        // only place a refusal is legible after the fact.
        const grown = (await diagnosticsOf(companion, 'grow')).at(-1);
        const command = (await diagnosticsOf(companion, 'voice-command')).at(-1);
        const shot = await captureXrFramebuffer(companion, `07v-${label}`);
        const entry = { phrase, label, kind, spoken: grown?.spoken ?? null, stage: grown?.stage ?? null,
          outcome: command?.outcome ?? null, elapsedMs: Date.now() - saidAt,
          lessonBefore: before.lessonId, lessonAfter: after.lessonId,
          atomSitesBefore: before.atomSites, atomSitesAfter: after.atomSites,
          sourceBytesAfter: after.sourceBytes, placementAfter: after.placement, session,
          capture: shot.eyes.map((eye: any) => ({ eye: eye.eye, foreground: eye.foreground, sha256: eye.sha256 })) };
        spokenTiers.push(entry);
        assert.equal(command?.outcome, 'applied', `"${phrase}" was recorded as ${command?.outcome ?? 'nothing'}.`);
        // The rule for anything the headset reads out loud.
        assert.ok(typeof entry.spoken === 'string' && entry.spoken.trim().split(/\s+/).length <= 11,
          `The headset answered "${phrase}" with a sentence too long to read out: "${entry.spoken}"`);
        // Growing must never cost the session. A second granted session means
        // the wearer went through entry again, which is the thing being avoided.
        assert.equal(session.presenting, true, `The immersive session ended while answering "${phrase}".`);
        assert.equal(session.ended, false, `The immersive session was torn down while answering "${phrase}".`);
        assert.equal(session.grantedSessions, beforeSession.grantedSessions,
          `"${phrase}" started a second XR session instead of rebuilding inside the first.`);
        assert.equal(session.mode, beforeSession.mode, `"${phrase}" changed the immersive mode.`);
        assert.ok(shot.eyes.every((eye: any) => eye.foreground > 100),
          `After "${phrase}" one of the eyes drew nothing a wearer could see.`);
        return { before, after, entry };
      };

      // Three tiers up, said the way a wearer says it: monomer, dimer,
      // protofilament, wall. The fourth "grow it" is the tube, which a Quest 2
      // cannot hold, so the honest answer is a refusal that leaves the wall.
      for (let step = 1; step <= 3; step++) {
        const { before, after, entry } = await speak('grow it', `grow-${step}`);
        assert.notEqual(after.lessonId, before.lessonId,
          `"grow it" number ${step} answered "${entry.spoken}" and left ${before.lessonId} on screen.`);
        assert.ok(after.atomSites > before.atomSites,
          `"grow it" number ${step} landed ${after.atomSites} atom sites, no more than the ${before.atomSites} before it.`);
        assert.ok(after.placement && after.placement.scale >= PLACEMENT_MIN_SCALE && after.placement.scale <= PLACEMENT_MAX_SCALE,
          `The tier "grow it" number ${step} landed left no supported room placement: ${JSON.stringify(after.placement)}`);
        passed(`"grow it" grew ${before.lessonId} into ${after.lessonId} (${after.atomSites.toLocaleString()} atom sites) in ${(entry.elapsedMs / 1000).toFixed(1)} s, inside the same immersive session`);
      }

      const tubed = await speak('grow it', 'grow-tube');
      report.emulatedXr.spokenGrowth.tube = tubed.entry;
      assert.equal(tubed.after.lessonId, tubed.before.lessonId,
        `"grow it" past the wall answered "${tubed.entry.spoken}" and left ${tubed.before.lessonId} for ${tubed.after.lessonId}.`);
      assert.equal(tubed.after.atomSites, tubed.before.atomSites, 'A refused tube changed what the page was showing.');
      report.emulatedXr.spokenGrowth.refused = true;
      passed(`"grow it" was refused out loud with "${tubed.entry.spoken}" and left the ${tubed.before.lessonId} tier untouched`);
      passed(`the headset's own grammar grew ${spokenTiers.filter((tier: any) => tier.lessonAfter !== tier.lessonBefore).length} tiers from spoken sentences alone`);
      // Stop here by throwing, the way `--grow` does: every case after this one
      // is written against the tier this drive replaced.
      throw Object.assign(Error('spoken grow drive complete: stopping before the rest of the run.'), { stereofoldRunComplete: true });
    }

    // Opt-in (`--tour full`). Every tour defect seen on hardware was reachable
    // from this Mac, and none of them was reached: no run here ever played a
    // lesson past its opening scene, so the narration route — the one that
    // answered 409 for every spoken line in
    // the headset — was never pressed at all. This walks the rest of the
    // lesson with the agent's own `control_tour`, the way an assistant drives
    // it, and requires of every chapter that its scene is shown, that its line
    // is narrated, and that the spoken line was actually rendered and returned.
    if (tourMode) {
      // The page's diagnostics ring keeps 200 entries and a frame-cost record
      // lands every second, so a tour record is gone from it within a couple
      // of minutes. Every read merges by sequence number into one kept
      // history, and a chapter is judged by what is newer than the sequence it
      // began at rather than by how many records still survive: counting a
      // rolling buffer reports a scene that did happen as a scene that did not.
      const ringHistory = new Map<number, any>();
      const readRing = async () => {
        for (const entry of await companion.evaluate(() => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
          .map((record: any) => ({ seq: record.seq, at: record.at, kind: record.kind, ...record.detail })))) {
          if (typeof entry.seq === 'number') ringHistory.set(entry.seq, entry);
        }
        return [...ringHistory.values()].sort((first, second) => first.seq - second.seq);
      };
      const of = (entries: any[], kind: string, seq = -1) => entries.filter(entry => entry.kind === kind && entry.seq > seq);
      const shown = (entries: any[], seq = -1) => of(entries, 'tour', seq).filter(entry => entry.action === 'scene' && entry.outcome === 'shown');
      const until = async (probe: () => Promise<boolean>, message: string, timeoutMs = 180_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) { if (await probe()) return; await delay(200); }
        throw Error(message);
      };
      const totalScenes = of(await readRing(), 'tour').at(-1)?.total ?? 0;
      assert.ok(totalScenes > 1, `The lesson reported ${totalScenes} scene(s), so there is no tour to step through.`);
      const chapters: any[] = [];
      // Written before the walk so a failed chapter still reports what the
      // earlier ones did, and kept current inside the loop.
      report.fullTour = { openingScene, totalScenes, chapters };
      for (let scene = openingScene; scene < totalScenes; scene += 1) {
        const startSeq = (await readRing()).at(-1)?.seq ?? -1;
        const before = { speech: report.speechCalls.length, failedResponses: report.failedResponses.length };
        const ready = await waitPanelReady(sessionId, 'companion', companionPanel);
        const commandId = `harnessfix-tour-next-${scene}`;
        await call('control_tour', { ...binding(ready, sessionId), panelId: companionPanel, commandId, action: 'next' });
        // `waitState` throws on a rejected, expired, conflicted or unconfirmed
        // receipt, so only a rendered scene continues this walk.
        await waitState(sessionId, current => current.command?.commandId === commandId
          && current.command?.status === 'rendered', commandId, 300_000);
        await atScene(scene + 1);
        await until(async () => shown(await readRing(), startSeq).length > 0,
          `Tour scene ${scene + 1} of ${totalScenes} never recorded a shown record.`);
        const entries = await readRing();
        const narratedNow = of(entries, 'tour', startSeq).some(entry => entry.action === 'narration');
        // A chapter the lesson gave no line to is silent by design; one that
        // has a line must both record it and reach the Mac for the audio.
        if (narratedNow) {
          await until(async () => report.speechCalls.length > before.speech,
            `Tour scene ${scene + 1} narrated a line that never reached the Mac's voice route.`);
          const attempts = report.speechCalls.slice(before.speech);
          assert.deepEqual(attempts.filter((attempt: any) => attempt.status !== 200), [],
            `The spoken line for tour scene ${scene + 1} was refused: ${JSON.stringify(attempts)}`);
        }
        const failures = of(await readRing(), 'speech-failed');
        assert.deepEqual(failures, [],
          `The page recorded a failed spoken line by tour scene ${scene + 1}: ${JSON.stringify(failures)}`);
        const rejections = of(await readRing(), 'unhandled-rejection');
        assert.deepEqual(rejections, [],
          `Tour scene ${scene + 1} left an unhandled rejection: ${JSON.stringify(rejections)}`);
        assert.equal(report.failedResponses.length, before.failedResponses,
          `Tour scene ${scene + 1} produced a failing response: ${JSON.stringify(report.failedResponses.slice(before.failedResponses))}`);
        chapters.push({ scene: scene + 1, of: totalScenes, narrated: narratedNow,
          title: shown(entries, startSeq).at(-1)?.title ?? null,
          progress: (await companion.locator('.tour-player:not([hidden]) [data-tour-progress], .experience-player:not([hidden]) [data-experience-progress]').textContent().catch(() => null))?.trim() ?? null,
          speechCalls: report.speechCalls.slice(before.speech) });
        chapters.at(-1).molecularGeometry = densityTour ? await measureTourGeometry() : await companion.evaluate(() => {
          const rows = (globalThis as any).__stereofoldDiagnostics?.entries?.()
            ?.filter((entry: any) => entry.kind === 'toolbar' && entry.detail?.drawnRowPoints)?.at(-1)?.detail?.drawnRowPoints ?? [];
          return (globalThis as any).__stereofoldMeasureMolecule(rows);
        });
        report.fullTour.records = of(await readRing(), 'tour');
        await captureXrFramebuffer(companion, `07t-tour-scene-${String(scene + 1).padStart(2, '0')}`);
      }
      const finalRing = await readRing();
      Object.assign(report.fullTour, { narrations: of(finalRing, 'tour').filter(entry => entry.action === 'narration').length,
        shown: shown(finalRing).length, toolStatus: report.toolStatus,
        // The tour's own decisions, kept whole: the live ring has long since
        // evicted the first chapters by the time the last one plays.
        records: of(finalRing, 'tour') });
      assert.equal(chapters.length, totalScenes - openingScene,
        'The walk did not reach every remaining chapter of the lesson.');
      assertEvidenceClean();
      report.fullTour.startedBy = tourStartedBy;
      passed(`${tourStartedBy === 'wearer' ? 'A controller press' : 'An agent command'} starts ${demo?.entry.name ?? 'the lesson'}; all ${totalScenes} scenes render and their narration requests succeed`);
      if (tourMode === 'chapters') {
        const ready = await waitPanelReady(sessionId, 'companion', companionPanel);
        const commandId = 'harness-chapters-done';
        await call('control_tour', { ...binding(ready, sessionId), panelId: companionPanel, commandId, action: 'done' });
        await waitState(sessionId, current => current.command?.commandId === commandId
          && current.command?.status === 'rendered', commandId, 300_000);
        const done = await privateInspection(sessionId);
        const beforePlacement = tourBefore.scene.inspection.placement;
        const afterPlacement = done.scene.inspection.placement;
        report.fullTour.done = { beforePlacement, afterPlacement,
          records: await diagnosticsOf(companion, 'journey-seat'),
          molecularGeometry: await measureTourGeometry() };
        for (const key of ['scale', 'translation', 'rotation'] as const) {
          const before = typeof beforePlacement[key] === 'number' ? [beforePlacement[key]] : beforePlacement[key];
          const after = typeof afterPlacement[key] === 'number' ? [afterPlacement[key]] : afterPlacement[key];
          assert.ok(before.length === after.length && before.every((value: number, index: number) => Math.abs(value - after[index]) <= 1e-3),
            `Done changed the accepted entry ${key}: ${JSON.stringify({ before, after })}`);
        }
        await captureXrFramebuffer(companion, '07t-tour-done');
        assertEvidenceClean();
        passed('Done restores the accepted immersive entry placement after all chapters');
        if (demo?.entry.name === 'daraxonrasib') {
          // Done correctly restored the pre-tour view. Re-enter the authored
          // lesson through its real command route for independent style tests.
          const styleReady = await waitPanelReady(sessionId, 'companion', companionPanel);
          const styleStartId = 'harness-kras-figure-style-play';
          await call('control_tour', { ...binding(styleReady, sessionId), panelId: companionPanel,
            commandId: styleStartId, action: 'play' });
          await waitState(sessionId, current => current.command?.commandId === styleStartId
            && current.command?.status === 'rendered', styleStartId, 300_000);
          const baseline = await privateInspection(sessionId);
          const figure = baseline.scene.inspection.lessonFigure;
          assert.ok(figure?.layers?.length, 'KRAS playback must render its authored figure before style acceptance.');
          const authored = structuredClone(figure); delete authored.representationOverride;
          // This exact assembly's base plus authored parts exceeds the Quest 2
          // Atoms allowance even at the lowest supported detail. Read what the
          // actual menu admits, then prove every viable style really draws.
          const supported = await companion.evaluate(() => (globalThis as any).__stereofoldMenu?.state()?.representations);
          assert.deepEqual(supported, ['cartoon', 'spacefill', 'molecular-surface']);
          // Playback deliberately quiets the compact panel. Open its actual
          // published Menu row before asking for a style: the shadow wake
          // model has no appearance state and cannot locate that control.
          const menuCursor = await diagnosticsCursor(companion);
          await pressToolbar('Open KRAS appearance menu', { kind: 'collapse', value: false });
          const menuProof = await companion.evaluate(since => {
            const entries = ((globalThis as any).__stereofoldDiagnostics?.entries?.() ?? [])
              .filter((entry: any) => entry.seq > since);
            return {
              hit: entries.filter((entry: any) => entry.kind === 'toolbar' && entry.detail?.phase === 'selectstart')
                .at(-1)?.detail?.hit ?? null,
              action: entries.filter((entry: any) => entry.kind === 'toolbar-action').at(-1)?.detail ?? null,
            };
          }, menuCursor);
          assert.equal(menuProof.hit, 'Menu', 'The appearance menu must open through its published Menu row.');
          assert.equal(menuProof.action?.kind, 'collapse');
          assert.equal(menuProof.action?.locked, false);
          const expandedRows = await waitLivePanelRows(companion, [{ kind: 'appearance-cycle' }]);
          assert.ok(expandedRows?.some(row => row.targetable && row.action?.kind === 'collapse' && row.action.value === true),
            'The published appearance panel must contain the expanded Close action.');
          assert.ok(expandedRows?.some(row => row.targetable && row.action?.kind === 'appearance-cycle'),
            'The expanded panel must publish a pressable appearance control before style acceptance.');
          report.fullTour.figureStyleMenu = { ...menuProof, rows: expandedRows!.map(row => row.label) };
          const styles: any[] = [];
          for (let index = 0; index < supported.length; index++) {
            const before = await privateInspection(sessionId);
            await pressToolbar('KRAS figure style', { kind: 'appearance-cycle' });
            const after = await waitToolbarScene('KRAS figure style', data => data.inspectionRevision > before.inspectionRevision);
            const chosen = after.scene.inspection.lessonFigure?.representationOverride;
            assert.ok(['ball-and-stick', 'cartoon', 'spacefill', 'molecular-surface'].includes(chosen));
            const retained = structuredClone(after.scene.inspection.lessonFigure); delete retained.representationOverride;
            assert.deepEqual(retained, authored, 'A figure style must preserve authored source selectors and annotations.');
            assert.deepEqual(after.scene.inspection.placement, baseline.scene.inspection.placement);
            assert.deepEqual(after.scene.selectionKeys, baseline.scene.selectionKeys);
            assert.equal(after.scene.sourceSha256, baseline.scene.sourceSha256);
            const drawn = await companion.evaluate(() => {
              const objects = (globalThis as any).__stereofoldReadGeometry?.()?.objects ?? [];
              return objects.filter((object: any) => object.state?.visible).map((object: any) => ({
                type: object.type, draws: object.values?.drawCount?.ref?.value,
                instances: object.values?.instanceCount?.ref?.value,
              })).filter((object: any) => object.draws > 0 && object.instances > 0);
            });
            assert.ok(drawn.length > 0, 'The selected figure style needs actual live molecular render objects.');
            const pixels = await captureXrFramebuffer(companion, `07t-kras-style-${chosen}`);
            styles.push({ chosen, inspectionRevision: after.inspectionRevision, drawn, eyes: pixels.eyes });
          }
          assert.deepEqual([...new Set(styles.map(style => style.chosen))].sort(), [...supported].sort(),
            'Every admitted molecular style must be reachable.');
          assert.ok(new Set(styles.map(style => JSON.stringify(style.drawn))).size > 1,
            'Representation controls must change live molecular geometry, beyond changing menu text.');
          for (const eye of ['left', 'right']) assert.equal(
            new Set(styles.map(style => style.eyes.find((value: any) => value.eye === eye).sha256)).size, supported.length,
            `Each admitted figure style must change the actual ${eye}-eye pixels.`);
          const beforeRefusal = await privateInspection(sessionId);
          const refusalReady = await waitPanelReady(sessionId, 'companion', companionPanel);
          const refusalId = 'harness-kras-atoms-budget-refusal';
          await call('update_inspection', { ...binding(refusalReady, sessionId), panelId: companionPanel,
            commandId: refusalId, change: { kind: 'appearance', patch: { representation: 'ball-and-stick' } } });
          const refusal = await waitState(sessionId, current => current.command?.commandId === refusalId
            && current.command?.status === 'rejected', refusalId);
          assert.match(refusal.command?.detail ?? '', /budget|limit|too much|too large|headset|geometry/i,
            'The renderer must report its actual geometry refusal.');
          const afterRefusal = await privateInspection(sessionId);
          assert.deepEqual(afterRefusal.scene, beforeRefusal.scene, 'A refused style must preserve the complete saved scene.');
          assert.equal(afterRefusal.inspectionRevision, beforeRefusal.inspectionRevision);
          await waitPanelReady(sessionId, 'companion', companionPanel);
          report.fullTour.figureStyles = { supported, styles,
            refusedAtoms: { status: refusal.command.status, reason: refusal.command.reason, detail: refusal.command.detail,
              completeSceneAndRevisionPreserved: true }, sourceSelectionPlacementAndAuthoredAnnotationsPreserved: true };
          assertEvidenceClean();
          passed('KRAS Ribbons, Spacefill and Surface change live geometry and eye pixels; the over-budget Atoms request preserves the complete scene');
        }
        if (densityTour) {
          // Done's restoration is already proved. Now make the lesson's
          // deliberate overhead enlargement through its actual drawn control.
          const rows=await waitLivePanelRows(companion,[{kind:'collapse'}]);
          if (rows?.find(row=>row.action?.kind==='collapse')?.action?.value===false)
            await pressToolbar('Expand density placement controls',{kind:'collapse',value:false});
          const beforeOverhead=await privateInspection(sessionId);
          const press=await pressToolbar('Above us',{kind:'room-placement',target:'overhead'});
          const overhead=await waitToolbarScene('Above us',data=>data.inspectionRevision>beforeOverhead.inspectionRevision
            && data.scene?.inspection?.placement?.scale>afterPlacement.scale*2);
          assert.equal(overhead.scene.sourceSha256,done.scene.sourceSha256,'Above us must retain the density scene identity.');
          assert.notDeepEqual(overhead.scene.inspection.placement.translation,afterPlacement.translation);
          const levelGeometry=await companion.evaluate(()=>(globalThis as any).__stereofoldMeasureDensity());
          assert.equal(levelGeometry.triangleCount,report.fullTour.done.molecularGeometry.triangleCount,
            'Above us must transform the same committed isosurface mesh.');
          assert.equal(levelGeometry.triangleCount,178236,'The prepared EMD-6347 GPU mesh must retain its measured triangles.');
          const doneExtent=Math.max(...report.fullTour.done.molecularGeometry.renderCoordinateBoundsMeters.extent);
          assert.ok(Math.max(...levelGeometry.renderCoordinateBoundsMeters.extent)>doneExtent*2,
            'Above us must substantially enlarge the measured density geometry.');
          const originalHead=await companion.evaluate(()=>{
            const device=(globalThis as any).__companionXrTest.device;
            return {position:[device.position.x,device.position.y,device.position.z],
              quaternion:[device.quaternion.x,device.quaternion.y,device.quaternion.z,device.quaternion.w]};
          });
          report.densityOverhead={press,beforePlacement:afterPlacement,placement:overhead.scene.inspection.placement,
            inspectionRevision:overhead.inspectionRevision,originalHead,levelGeometry,
            levelViewScope:'Measured geometry before looking up. The deliberate overhead target may leave the level view; rendered image evidence is required after looking at it.'};
          try {
            const look=await companion.evaluate(({geometry,original})=>{
              // Aim the simulator head at the actual texture-vertex centre in
              // its current eye frame. Keep its tracked position exactly fixed.
              const centres=geometry.eyes.map((eye:any)=>eye.eyeCoordinateBoundsMeters.min.map((v:number,i:number)=>
                (v+eye.eyeCoordinateBoundsMeters.max[i])/2));
              const target=[0,1,2].map(axis=>centres.reduce((sum:number,centre:number[])=>sum+centre[axis],0)/centres.length);
              const length=Math.hypot(...target),direction=target.map(v=>v/length);
              const delta=[direction[1],-direction[0],0,1-direction[2]],norm=Math.hypot(...delta);
              const [a,b,c,d]=norm>1e-9?delta.map(v=>v/norm):[0,1,0,0];
              const [x,y,z,w]=original.quaternion;
              const quaternion=[w*a+x*d+y*c-z*b,w*b-x*c+y*d+z*a,w*c+x*b-y*a+z*d,w*d-x*a-y*b-z*c];
              const device=(globalThis as any).__companionXrTest.device;
              device.quaternion.set(...quaternion);
              return {direction,quaternion,position:[device.position.x,device.position.y,device.position.z]};
            },{geometry:levelGeometry,original:originalHead});
            assert.deepEqual(look.position,originalHead.position,'Looking up must preserve tracked head position.');
            assert.ok(look.direction[1]>0,'The committed overhead density centre must be above the level head.');
            const frame=await captureXrFramebuffer(companion,'07d-density-above-looking-up');
            const geometry=await measureTourGeometry();
            assert.equal(geometry.triangleCount,levelGeometry.triangleCount);
            for (const eye of geometry.eyes) {
              const before=report.fullTour.done.molecularGeometry.eyes.find((candidate:any)=>candidate.eye===eye.eye);
              assert.ok(eye.angularDegrees.width*eye.angularDegrees.height>before.angularDegrees.width*before.angularDegrees.height*4,
                `${eye.eye} eye must see a substantially larger density surface after Above us.`);
            }
            const map=await fetch(`${companionOrigin}/density`,{headers:{Authorization:`Bearer ${new URL(companionUrl).hash.slice(1)}`}});
            assert.equal(map.status,200);
            const mapSha256=createHash('sha256').update(Buffer.from(await map.arrayBuffer())).digest('hex');
            assert.equal(mapSha256,report.densitySource.sha256,'Above us must retain the same authenticated density map.');
            Object.assign(report.densityOverhead,{look,geometry,frame,mapSha256});
          } finally {
            await companion.evaluate(original=>{(globalThis as any).__companionXrTest.device.quaternion.set(...original.quaternion);},originalHead);
          }
          assertEvidenceClean();
          passed('Above us enlarges the same density mesh; looking upward from the fixed head position renders it in both eyes');
        }
        report.fullTour.scope = 'Chapter playback, narration request path and Done placement restoration; excludes the separate parked-RNA emphasis regression.';
        throw Object.assign(Error('Chapter playback complete.'), { stereofoldRunComplete: true });
      }

      const liveEmphasis = async () => (await call('get_inspection_state', { sessionId }))
        .structuredContent.view?.emphasis ?? { parts: [], focus: [] };

      // The `ask` step's own arrangement — a lesson PARKED on a
      // chapter, not stopped — and the two agent commands a wearer's question
      // turns into.
      //
      // On hardware this sequence failed: with the lesson backed off its last
      // chapter and paused, a question about the guide RNA followed by "show
      // me" made the agent's focus over the guide
      // RNA come back {"status":"unconfirmed","reason":"The returned scene did
      // not match the requested change."} — so the step failed with "the wearer
      // was told about something they cannot see", while the guide RNA was in
      // fact lit in front of them. The panel lifts a chapter's fade off the
      // region it frames (`liftFocusOutOfFade`), which edits the saved
      // emphasis, and the receipt compared that emphasis for exact equality.
      //
      // The emphasisgap case below never reached it: it runs after a takeover,
      // the one arrangement where the fade is already off and no lift fires.
      const tourCommand = async (action: string, label: string, timeoutMs = 300_000) => {
        const ready = await waitPanelReady(sessionId, 'companion', companionPanel);
        await call('control_tour', { ...binding(ready, sessionId), panelId: companionPanel, commandId: label, action });
        return waitState(sessionId, current => current.command?.commandId === label
          && current.command?.status === 'rendered', label, timeoutMs);
      };
      const parkedScene = totalScenes - 1;
      await tourCommand('back', 'askrender-park-back');
      await atScene(parkedScene);
      await tourCommand('pause', 'askrender-park-pause');
      const parked = await liveEmphasis();
      assert.ok(parked.parts.length > 0 && parked.focus.length > 0,
        `The lesson parked on chapter ${parkedScene} with no colour key, so no fade can be lifted: ${JSON.stringify(parked)}`);
      const guide = (await call('get_inspection_state', { sessionId })).structuredContent.lesson?.parts
        ?.find((part: any) => /rna/iu.test(part.label ?? part.id));
      assert.ok(guide, 'This lesson names no RNA part, so the hardware sequence cannot be reproduced on it.');
      assert.ok(!parked.focus.includes(guide.id),
        `The parked chapter already lights ${guide.id}, so nothing has to be lifted out of its fade.`);
      const guideColour = parked.parts.find((part: any) => part.id === guide.id)?.color;
      assert.ok(guideColour, `The parked key does not name ${guide.id}: ${JSON.stringify(parked.parts.map((p: any) => p.id))}`);
      const ghost = await litPixelsInXrEye(companion, guideColour, `${guide.id} faded under chapter ${parkedScene}`);
      await captureXrFramebuffer(companion, '07v-askrender-parked-chapter');

      // 1. The agent's emphasize, while the chapter's own key is on the
      //    molecule. It carries the whole lesson key and its own context
      //    opacity, so the saved emphasis legitimately stops being the
      //    chapter's — and it must still light the part over the ghost.
      const emphasisWhileParked = 'askrender-emphasize-parked';
      const parkedPanel = await waitPanelReady(sessionId, 'companion', companionPanel);
      await call('emphasize', { ...binding(parkedPanel, sessionId), panelId: companionPanel,
        commandId: emphasisWhileParked, parts: [guide.label ?? guide.id] });
      await waitState(sessionId, current => current.command?.commandId === emphasisWhileParked
        && current.command?.status === 'rendered', emphasisWhileParked, 300_000);
      const commandedWhileParked = await liveEmphasis();
      assert.deepEqual(commandedWhileParked.focus, [guide.id],
        `The agent's emphasize on a parked lesson did not leave ${guide.id} focused: ${JSON.stringify(commandedWhileParked)}`);
      assert.ok(commandedWhileParked.parts.some((part: any) => part.id === guide.id),
        'The agent\'s emphasize focused a part against a key that does not name it.');
      const litByAgent = await litPixelsInXrEye(companion, guideColour, `${guide.id} lit by the agent's emphasize`);
      assert.ok(litByAgent.litPixels > ghost.litPixels,
        `The agent's emphasize did not light ${guide.id} over the chapter's ghost: ${JSON.stringify({ ghost, litByAgent })}`);
      await captureXrFramebuffer(companion, '07v-askrender-emphasize-parked');

      // 2. "Continue the lesson". The chapter comes back with its OWN paint,
      //    not the key the agent left on the molecule.
      await tourCommand('play', 'askrender-resume');
      await atScene(parkedScene);
      const resumed = await liveEmphasis();
      assert.deepEqual(resumed.focus, parked.focus,
        `The resumed chapter did not come back with its own paint: ${JSON.stringify({ parked: parked.focus, resumed: resumed.focus })}`);
      assert.equal(resumed.contextOpacity, parked.contextOpacity,
        'The resumed chapter came back at a different context opacity from the one it was parked at.');
      await captureXrFramebuffer(companion, '07v-askrender-resumed-chapter');

      // 3. And the command that failed on hardware: park the chapter again and
      //    frame the guide RNA through the same tool an assistant calls.
      await tourCommand('pause', 'askrender-park-again');
      const refaded = await litPixelsInXrEye(companion, guideColour, `${guide.id} faded again under chapter ${parkedScene}`);
      const focusCommandId = 'askrender-show-me';
      const focusPanel = await waitPanelReady(sessionId, 'companion', companionPanel);
      // A lesson writes the author chain a paper prints, which this structure
      // may only carry as a label chain. Both are asked for by name rather than
      // pinned, so the case reads the same on a model numbered either way.
      const framingArgs = { ...binding(focusPanel, sessionId), panelId: companionPanel,
        commandId: focusCommandId, framing: 'fill' };
      const chain = guide.chain ?? 'B';
      let framing = await callRaw('focus_selection', { ...framingArgs, residues: { labelChain: chain } });
      if (framing.isError) framing = await callRaw('focus_selection', { ...framingArgs, residues: { authorChain: chain } });
      assert.ok(!framing.isError, `"Show me" could not name chain ${chain}: ${JSON.stringify(framing.content)}`);
      // `waitState` throws the receipt's own words, so an `unconfirmed` here
      // reports exactly what the headset reported.
      await waitState(sessionId, current => current.command?.commandId === focusCommandId
        && current.command?.status === 'rendered', focusCommandId, 300_000);
      const shownToWearer = await liveEmphasis();
      assert.ok(shownToWearer.focus.length === 0 || shownToWearer.focus.includes(guide.id),
        `The framed region was left inside the chapter's fade: ${JSON.stringify(shownToWearer)}`);
      assert.deepEqual(shownToWearer.parts.map((part: any) => part.id), parked.parts.map((part: any) => part.id),
        'Framing a region repainted the lesson key the wearer had learned.');
      assert.equal(shownToWearer.contextOpacity, parked.contextOpacity,
        'Framing a region changed how faint the rest of the lesson went.');
      const litByFocus = await litPixelsInXrEye(companion, guideColour, `${guide.id} lit by the agent's focus`);
      assert.ok(litByFocus.litPixels > refaded.litPixels,
        `"Show me" framed ${guide.id} and left it a ghost: ${JSON.stringify({ refaded, litByFocus })}`);
      await captureXrFramebuffer(companion, '07v-askrender-show-me');
      report.fullTour.askOnParkedLesson = { chapter: parkedScene, parkedFocus: parked.focus,
        part: guide.id, colour: guideColour,
        agentEmphasisFocus: commandedWhileParked.focus, resumedFocus: resumed.focus,
        shownFocus: shownToWearer.focus, litPixels: { ghost, litByAgent, refaded, litByFocus } };
      assertEvidenceClean();
      passed(`A lesson parked on chapter ${parkedScene} answers the agent's emphasize and "show me" by lighting ${guide.id} over its ghost, with both receipts rendered, and continues on its own paint`);

      // What happens to the lesson's colour key when the lesson stops. The same
      // wearer-visible failure shows up from three directions — a takeover
      // stopped the tour and left
      // the chapter's fade painted, so the wearer was handed a molecule at
      // twelve per cent with nothing running that would ever clear it, and
      // "show me the guide RNA" then framed a ghost.
      //
      // This runs here because it needs what only a played lesson has: a real
      // colour key on a real representation, in a live immersive session.
      const afterLesson = await liveEmphasis();
      assert.ok(afterLesson.parts.length > 0 && afterLesson.focus.length > 0,
        `The last chapter left no faded colour key to test: ${JSON.stringify(afterLesson)}`);

      // 1. A takeover the wearer causes takes the lesson's fade with it. A
      //    spoken scale is the cheapest real mutation in a headset: it bakes a
      //    placement, the tour reads that as a workspace takeover and stops.
      assert.equal(await companion.evaluate(() => (globalThis as any).__stereofoldVoice.say('make it bigger')),
        'scale', 'A spoken scale must reach the dispatcher to stand in for a takeover.');
      await until(async () => (await liveEmphasis()).parts.length === 0,
        'A takeover stopped the lesson and left its colour key and twelve per cent fade on the molecule.', 60_000);
      await captureXrFramebuffer(companion, '07u-emphasis-cleared-by-takeover');

      const lessonParts = (await call('get_inspection_state', { sessionId })).structuredContent.lesson?.parts ?? [];
      assert.ok(lessonParts.length > 0, 'The played lesson published no named parts for the agent to emphasise.');

      // 1b. The wearer's own words, with NOTHING in between.
      //
      // This is the order that matters: the takeover
      // above has just emptied the painted key, and the wearer asks for a part
      // by name before any agent has put a key back. The page used to read its
      // nouns off the live layers, so at this exact moment it had none and the
      // headset answered "Not a command" about a part the lesson had spent nine
      // chapters teaching. On hardware it read as "'Show me' was answered but
      // the scene never rendered the change".
      const namedPart = lessonParts.find((part: any) => /rna/iu.test(part.label ?? part.id)) ?? lessonParts.at(-1);
      assert.equal(await companion.evaluate((said: string) => (globalThis as any).__stereofoldVoice.say(said),
        `show me the ${namedPart.label ?? namedPart.id}`), 'emphasize-part',
        'After a takeover the lesson\'s own part names are no longer a command in the immersive grammar.');
      await until(async () => JSON.stringify((await liveEmphasis()).focus) === JSON.stringify([namedPart.id]),
        'The wearer asked for a named part after a takeover and the molecule did not light it.', 60_000);
      const relitKey = await liveEmphasis();
      assert.ok(relitKey.parts.length > 0,
        `The part was focused against an empty colour key, so nothing is painted: ${JSON.stringify(relitKey)}`);
      // The XR framebuffer, not `captureCanvas`: a presenting session draws into the XR
      // layer, the companion's own `.stage canvas` is not there to screenshot, and asking
      // for it here killed the run before cases 2 and 3 could follow.
      const relitFrame = await captureXrFramebuffer(companion, '07u-emphasis-spoken-after-takeover');
      report.fullTour.emphasisAfterTakeover = { part: namedPart.id,
        colour: relitKey.parts.find((part: any) => part.id === namedPart.id)?.color ?? null,
        focus: relitKey.focus, keyParts: relitKey.parts.length,
        eyes: (relitFrame as any)?.eyes?.map((eye: any) => ({ eye: eye.eye, foreground: eye.foreground,
          colorsObservedUpTo256: eye.colorsObservedUpTo256 })) ?? null };

      // 2. The agent's own emphasize puts a named part back, through the same
      //    tool an assistant on the Mac would call. It is a mutation too, so
      //    the takeover rule above fires again — and must refuse, because the
      //    key it would remove is the one that was just asked for.
      //    The binding is read HERE, after the spoken repaint above: a command
      //    enqueued against revisions the wearer's own emphasis has already
      //    moved past is refused by the panel, not by the tour.
      const emphasisPanel = await waitPanelReady(sessionId, 'companion', companionPanel);
      const emphasisCommandId = 'emphasisgap-emphasize';
      await call('emphasize', { ...binding(emphasisPanel, sessionId), panelId: companionPanel,
        commandId: emphasisCommandId, parts: [lessonParts[0].label ?? lessonParts[0].id] });
      await waitState(sessionId, current => current.command?.commandId === emphasisCommandId
        && current.command?.status === 'rendered', emphasisCommandId, 300_000);
      const commanded = await liveEmphasis();
      assert.deepEqual(commanded.focus, [lessonParts[0].id],
        `The agent's emphasize did not leave its part focused: ${JSON.stringify(commanded)}`);
      // The proof that provenance works: a full second later, after every
      // takeover the command's own mutation could have triggered, the key the
      // agent asked for is still on the molecule.
      await delay(1_000);
      assert.deepEqual((await liveEmphasis()).focus, [lessonParts[0].id],
        'A stopped lesson removed the colour key the agent had just asked for.');
      await captureXrFramebuffer(companion, '07u-emphasis-agent-command');

      // 3. And the wearer's own words reach the same place. Until this pass the
      //    grammar for it was exported, tested and called by nothing: "show me
      //    the guide RNA" matched no table and no parser, and the headset
      //    answered "Not a command" about a part the lesson had just named.
      const spokenPart = lessonParts.find((part: any) => /rna/iu.test(part.label ?? part.id)) ?? lessonParts.at(-1);
      assert.equal(await companion.evaluate((said: string) => (globalThis as any).__stereofoldVoice.say(said),
        `show me the ${spokenPart.label ?? spokenPart.id}`), 'emphasize-part',
        'A spoken lesson part is still not a command in the immersive grammar.');
      await until(async () => JSON.stringify((await liveEmphasis()).focus) === JSON.stringify([spokenPart.id]),
        'The wearer asked for a named part and the molecule did not light it.', 60_000);
      await captureXrFramebuffer(companion, '07u-emphasis-spoken-part');
      report.fullTour.emphasis = { clearedByTakeover: true, agentFocus: commanded.focus, spokenFocus: [spokenPart.id] };
      assertEvidenceClean();
      passed('A takeover clears the lesson fade, while the agent\'s emphasize and the wearer\'s "show me the part" keep the key they asked for');
      // Everything below this point belongs to other cases and would run for
      // several more minutes against a tour that has already ended.
      throw Object.assign(Error('tour full complete: stopping after the last chapter.'), { stereofoldRunComplete: true });
    }
    // Opt-in (STEREOFOLD_ASK_LOOP=1, with
    // STEREOFOLD_ASK_AUDIO=<absolute WebM/Opus file> and STEREOFOLD_ASK_SAID=<the
    // sentence spoken in it>). Make one with what macOS ships:
    //
    //   /usr/bin/say -o q.aiff "what does the guide RNA do here"
    //   /usr/bin/afconvert -f WAVE -d LEI16@16000 -c 1 q.aiff q.wav
    //   ffmpeg -i q.wav -c:a libopus -b:a 24k -ac 1 -ar 48000 q.webm
    //
    // What this covers that `headset-drive.ts --steps ask` cannot. That script
    // posts its audio straight at the host, so it skips getUserMedia, the
    // permission grant, MediaRecorder and the page's own chunk streamer -- the
    // whole in-browser half. Here the bytes go in at the microphone: the
    // production grip binding opens the recorder, the production streamer cuts
    // and posts the chunks over the page's own authenticated tool route, and
    // the page reads its own transcript back off the final marker. What it
    // still does not cover is the Quest's real Opus encoder or its timeslicing:
    // the recorder is a stub that hands on whatever it is given, in one piece,
    // so this is one already-muxed file rather than a sequence of recorder
    // clusters. It also sits after the `--tour full` early exit, so a full walk
    // does not run it.
    if (process.env.STEREOFOLD_ASK_LOOP === '1') {
    const audioPath = process.env.STEREOFOLD_ASK_AUDIO;
    const said = (process.env.STEREOFOLD_ASK_SAID ?? '').trim();
    assert.ok(audioPath && isAbsolute(audioPath), 'STEREOFOLD_ASK_LOOP=1 needs STEREOFOLD_ASK_AUDIO set to an absolute WebM/Opus file.');
    assert.ok(said, 'STEREOFOLD_ASK_LOOP=1 needs STEREOFOLD_ASK_SAID set to the sentence that file says.');
    const pressAudio = await readFile(audioPath);
    assert.ok(pressAudio.byteLength > 256, `${audioPath} is ${pressAudio.byteLength} bytes, which is not a recording.`);

    const pumpAskFrames = (count: number) => companion.evaluate(async frames => {
      const active = (window as any).__companionXrTest?.active;
      if (!active || active.ended) throw Error('No active XR session to pump.');
      for (let index = 0; index < frames; index++) {
        await new Promise<void>((resolveFrame, rejectFrame) => {
          const timer = setTimeout(() => rejectFrame(Error('Timed out waiting for an IWER XR frame.')), 20_000);
          try { active.session.requestAnimationFrame(() => { clearTimeout(timer); resolveFrame(); }); }
          catch (error) { clearTimeout(timer); rejectFrame(error); }
        });
      }
    }, count);
    const holdAskTalk = (value: number) => companion.evaluate(pressed => {
      const controller = (window as any).__companionXrTest.device.controllers.right;
      controller.connected = true;
      controller.updateButtonValue('a-button', pressed);
    }, value);

    report.emulatedXr.askLoop = { said, audioBytes: pressAudio.byteLength } as any;
    // Start at the head of the voice queue and with the reply ring read dry,
    // so neither an earlier probe's utterance nor an earlier clip can be
    // credited to this press.
    const voiceCursor = ((await callRaw('listen_voice', { timeoutSeconds: 1 })).structuredContent as any)?.cursor ?? 0;
    await companion.evaluate(() => { (window as any).__stereofoldMicTest.mode = 'grant'; });
    await holdAskTalk(1);
    await pumpAskFrames(4);
    // `recording` is the state that means a recorder exists to hand a
    // timeslice to. Waiting for the wrong name here silently cost sixty
    // seconds, and the press had already hit its twenty-second duration cap by
    // the time the audio was offered -- which reads exactly like a microphone
    // that recorded silence.
    const pressId = await companion.waitForFunction(() => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
      .filter((entry: any) => entry.kind === 'voice-state' && entry.detail?.state === 'recording')
      .map((entry: any) => entry.detail?.utteranceId).at(-1) ?? false, undefined, { timeout: 60_000 })
      .then(handle => handle.jsonValue() as Promise<string>);
    // One timeslice, the way Quest Browser hands one over. The production
    // streamer decides how to cut and post it.
    await companion.evaluate(encoded => {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      (window as any).__stereofoldMicTest.speak(bytes);
    }, pressAudio.toString('base64'));
    await companion.waitForTimeout(300);
    await holdAskTalk(0);
    await pumpAskFrames(4);

    // The page's own answer, off the final marker it posted. Not the host's:
    // this is the text the wearer's own page believes it said. Scoped to this
    // press's utterance, because an earlier probe's press leaves its own
    // `heard` record in the same ring.
    await companion.waitForFunction(id => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
      .some((entry: any) => entry.kind === 'voice-state' && entry.detail?.utteranceId === id
        && ['heard', 'error'].includes(entry.detail?.state)), pressId, { timeout: 180_000 });
    const voiceStates = (await diagnosticsOf(companion, 'voice-state')).filter((entry: any) => entry.utteranceId === pressId);
    const heard = voiceStates.filter((entry: any) => entry.state === 'heard').at(-1) as any;
    assert.ok(heard, `The press never came back as heard: ${JSON.stringify(voiceStates.at(-1))}`);
    // The page logs the sentence as `Heard: <text>`; an empty press logs why.
    const message = String(heard.message ?? '');
    const transcript = message.startsWith('Heard: ') ? message.slice('Heard: '.length) : '';

    // What an agent reads: only what is newer than the seeded cursor, so a
    // matching string already held in the sixty-four-deep history cannot stand
    // in for this press.
    const listened = await callRaw('listen_voice', { timeoutSeconds: 5, cursor: voiceCursor });
    const queued = ((listened.structuredContent as any)?.transcripts ?? []).map((entry: any) => String(entry.text ?? ''));
    // Whole words in both directions, the way the driver compares. Substring
    // matching would find "RNA" inside "granary", and unbounded extra words
    // would accept a leaked whisper prompt.
    const tokens = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s]/gu, ' ').split(/\s+/u).filter(Boolean);
    const wanted = tokens(said);
    const spoken = new Set(tokens(transcript));
    const missing = wanted.filter(word => !spoken.has(word));
    const extra = [...spoken].filter(word => !wanted.includes(word));
    // What the page itself says it did with the press, rather than an assumed
    // true: `uploading` is the streamer posting a chunk over the page's own
    // authenticated tool route.
    const pressStates = voiceStates.map((entry: any) => String(entry.state));
    report.emulatedXr.askLoop = { said, audioBytes: pressAudio.byteLength, transcript, missing, extra,
      onAgentQueue: queued.includes(transcript), pressStates } as any;
    assert.deepEqual(missing, [],
      `A press through the page's own microphone came back as ${JSON.stringify(message)} when ${JSON.stringify(said)} was spoken.`);
    assert.ok(extra.length <= 3, `The transcript came back with ${extra.length} words nobody spoke: ${JSON.stringify(extra)}`);
    assert.ok(pressStates.includes('uploading'),
      `The page never recorded posting a chunk for this press: ${JSON.stringify(pressStates)}`);
    assert.ok(transcript && queued.includes(transcript),
      `The page heard the press but it never reached the queue listen_voice serves: ${JSON.stringify(queued)}`);

    // The answer back, and whether the page drew and played it.
    const reply = 'The guide RNA finds the matching DNA and holds Cas9 on it.';
    const spoke = await callRaw('say_to_headset', { text: reply, holdSeconds: 6 });
    const said_ = (spoke.structuredContent ?? {}) as any;
    // `delivered` is recorded, never asserted: it only says whether a page took
    // the reply inside say_to_headset's own two-second wait, and false means
    // "not yet, it lands on the next heartbeat". The page's own records below
    // are stricter and are not a race.
    (report.emulatedXr.askLoop as any).replyDeliveredWithinTheHostsWait = said_.delivered === true;
    assert.equal(said_.audible, true, 'The reply was delivered as text with no clip to play.');
    await companion.waitForFunction(([chars, id]) => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
      .some((entry: any) => entry.kind === 'reply-received' && entry.detail?.chars === chars
        && entry.detail?.captionId === id
        && entry.detail?.empty !== true && entry.detail?.drawn !== false),
    [String(said_.text ?? reply).length, String(said_.captionId ?? '')] as const, { timeout: 60_000 });
    // Scoped to this reply by the caption queue's own id, which the page copies
    // onto every record it writes about the clip. Byte count and "one more
    // record than before" were the previous scoping and neither is identity: a
    // play left by an earlier reply stood in for a silent one.
    const captionId = String(said_.captionId ?? '');
    assert.ok(captionId, 'The Mac queued the reply without a caption id, so no record about it could be told from another reply\'s.');
    await companion.waitForFunction(id => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
      .some((entry: any) => (entry.kind === 'reply-audio-error' || entry.kind === 'reply-audio-play')
        && entry.detail?.captionId === id), captionId, { timeout: 60_000 });
    const clips = (await diagnosticsOf(companion, 'reply-audio-play'))
      .filter((entry: any) => entry.captionId === captionId && entry.bytes === said_.audioBytes);
    // A source started into a context the browser never resumed is a record
    // with no sound behind it.
    const played = clips.filter((entry: any) => entry.contextState === 'running' || (entry.via === 'element' && entry.started === true));
    const audioErrors = (await diagnosticsOf(companion, 'reply-audio-error')).filter((entry: any) => entry.captionId === captionId);
    (report.emulatedXr.askLoop as any).replyClipStarted = played.length;
    (report.emulatedXr.askLoop as any).replyClipContext = String((clips[0] as any)?.contextState ?? 'none');
    (report.emulatedXr.askLoop as any).replyAudioErrors = audioErrors;
    assert.deepEqual(audioErrors, [], `The reply clip failed to play: ${JSON.stringify(audioErrors)}`);
    assert.ok(clips.length > 0,
      `The reply clip of ${said_.audioBytes} bytes reached the page but the page never recorded starting it, so the wearer would have read it in silence.`);
    assert.ok(played.length > 0,
      `The reply clip was started into an audio context that was ${String((clips[0] as any)?.contextState ?? 'not running')}, so nothing would have come out of the headset: ${JSON.stringify(clips[0])}`);

    await companion.evaluate(() => { (window as any).__stereofoldMicTest.mode = 'deny'; });
    assertEvidenceClean();
    passed('A press through the page’s own microphone was transcribed on this Mac, reached the agent queue, and the answer came back as a drawn caption and a played clip');
    }

    // Opt-in (STEREOFOLD_XRVIS_PROBE=1). The page watched the
    // document's `visibilitychange` and never the session's. On Quest those are
    // different events: taking the headset off or opening the system menu makes
    // the XRSession `hidden` or `visible-blurred` while the document stays
    // visible, so nothing here noticed. A headset set down on a table kept a
    // held microphone recording the room, kept answering the agent `ready`, and
    // kept autoplay advancing scenes nobody was watching.
    //
    // IWER drives the real event rather than a synthetic one:
    // `XRDevice.updateVisibilityState` queues the state and the next emulated
    // frame dispatches `visibilitychange` on the session itself, which is the
    // same event and the same object Quest Browser uses. This block holds A,
    // blinds the session, and requires all three to stop — then gives the
    // session back and requires the tour to come with it.
    if (process.env.STEREOFOLD_XRVIS_PROBE === '1') {
    const transitions = () => diagnosticsOf(companion, 'xr-visibility');
    const companionPanelOf = (state: any) => state.panels.find((panel: any) => panel.panelId === companionPanel);
    /** Turn the emulated display over, so a queued visibility state is applied. */
    const pumpXrFrames = (count: number) => companion.evaluate(async frames => {
      const active = (window as any).__companionXrTest?.active;
      if (!active || active.ended) throw Error('No active XR session to pump.');
      for (let index = 0; index < frames; index++) {
        await new Promise<void>((resolveFrame, rejectFrame) => {
          const timer = setTimeout(() => rejectFrame(Error('Timed out waiting for an IWER XR frame.')), 20_000);
          try { active.session.requestAnimationFrame(() => { clearTimeout(timer); resolveFrame(); }); }
          catch (error) { clearTimeout(timer); rejectFrame(error); }
        });
      }
    }, count);
    /** The wearer's thumb on A, through the production gamepad the reader polls. */
    const holdTalk = (value: number) => companion.evaluate(pressed => {
      const controller = (window as any).__companionXrTest.device.controllers.right;
      controller.connected = true;
      controller.updateButtonValue('a-button', pressed);
    }, value);
    const setSessionVisibility = (state: string) => companion.evaluate(value => {
      (window as any).__companionXrTest.device.updateVisibilityState(value);
    }, state);

    const armed = await waitState(sessionId, state => companionPanelOf(state)?.tour?.autoplay === true, undefined, 60_000);
    assert.equal(companionPanelOf(armed)?.tour?.autoplay, true,
      'The probe needs autoplay running before it blinds the session, or the pause proves nothing.');

    // The harness microphone refuses by default, and a refused press gives
    // itself back (`push-to-talk-grip.mjs` press()), which would leave this
    // probe interrupting nothing. Grant it for the length of the hold.
    await companion.evaluate(() => { (window as any).__stereofoldMicTest.mode = 'grant'; });
    // Hold A past TALK_MIN_HOLD_MS (xr-buttons.mjs:44) with the display turning,
    // which is the only way the production reader opens a microphone.
    await holdTalk(1);
    await pumpXrFrames(4);
    await companion.waitForTimeout(400);
    await pumpXrFrames(4);
    const talkDown = (await diagnosticsOf(companion, 'xr-button'))
      .filter((entry: any) => entry.action === 'push-to-talk' && entry.phase === 'down');
    assert.ok(talkDown.length > 0,
      'Holding A opened no push-to-talk press, so this probe has no live microphone to interrupt.');
    const cancelsBefore = (await diagnosticsOf(companion, 'voice-cancel')).length;

    await setSessionVisibility('hidden');
    await pumpXrFrames(3);
    await companion.waitForFunction(() => ((window as any).__stereofoldDiagnostics?.entries?.() ?? [])
      .some((entry: any) => entry.kind === 'xr-visibility' && entry.detail?.to === 'hidden'));
    // Read the cancel before letting go of the button. A release after this
    // would close the microphone on its own, and then the probe would be
    // proving nothing about visibility at all.
    const blindTransition = (await transitions()).at(-1);
    const blindCancels = (await diagnosticsOf(companion, 'voice-cancel')).slice(cancelsBefore);
    await holdTalk(0);
    await pumpXrFrames(2);
    await companion.evaluate(() => { (window as any).__stereofoldMicTest.mode = 'deny'; });
    assert.deepEqual({ to: blindTransition?.to, blind: blindTransition?.blind, cancelTalk: blindTransition?.cancelTalk, tour: blindTransition?.tour },
      { to: 'hidden', blind: true, cancelTalk: true, tour: 'pause' },
      `A hidden session did not cancel the press and pause the tour: ${JSON.stringify(blindTransition)}`);
    assert.ok(blindCancels.some((entry: any) => entry.held === true && entry.reason === 'xr-hidden'),
      `The held microphone was not cancelled when the session went hidden: ${JSON.stringify(blindCancels)}`);

    const blindState = await waitState(sessionId,
      state => companionPanelOf(state)?.availability === 'busy', undefined, 60_000);
    const blindPanel = companionPanelOf(blindState);
    assert.equal(blindPanel.availability, 'busy',
      'A headset nobody is wearing kept advertising itself to the agent as ready.');
    assert.equal(blindPanel.xrStartup?.sessionVisibility, 'hidden',
      `The heartbeat did not carry the session visibility: ${JSON.stringify(blindPanel.xrStartup)}`);
    assert.equal(blindPanel.tour?.autoplay, false,
      'Autoplay kept advancing scenes into a headset that is not being worn.');

    // The whole point of `busy`: the server refuses to admit a command rather
    // than rendering one at a wearer who cannot see it.
    // `callRaw`, because the server's own sentence is what proves the refusal
    // was the availability gate rather than any other failure. `call` asserts
    // on `isError` and replaces that sentence with its own.
    const refused = await callRaw('control_tour', { ...binding(blindState, sessionId), panelId: companionPanel,
      commandId: 'xrvis-blind-tour', action: 'pause' });
    const refusal = (refused.content ?? []).map((part: any) => part?.text ?? '').join(' ');
    assert.equal(refused.isError, true, `An agent command was admitted to a blind panel: ${refusal}`);
    assert.match(refusal, /unavailable, busy, or has unsaved work/i,
      `A blind panel refused the command for the wrong reason: ${refusal}`);

    await setSessionVisibility('visible');
    await pumpXrFrames(3);
    const visibleState = await waitState(sessionId,
      state => companionPanelOf(state)?.availability === 'ready'
        && companionPanelOf(state)?.xrStartup?.sessionVisibility === 'visible', undefined, 60_000);
    const resumedTransition = (await transitions()).at(-1);
    assert.deepEqual({ to: resumedTransition?.to, blind: resumedTransition?.blind, tour: resumedTransition?.tour },
      { to: 'visible', blind: false, tour: 'resume' },
      `Putting the headset back on did not resume the tour: ${JSON.stringify(resumedTransition)}`);
    const resumedState = await waitState(sessionId,
      state => companionPanelOf(state)?.tour?.autoplay === true, undefined, 60_000);

    report.emulatedXr.xrVisibility = {
      talkDown, transitions: await transitions(), cancels: await diagnosticsOf(companion, 'voice-cancel'),
      blind: { availability: blindPanel.availability, sessionVisibility: blindPanel.xrStartup?.sessionVisibility, tour: blindPanel.tour },
      refusal,
      restored: { availability: companionPanelOf(visibleState)?.availability,
        sessionVisibility: companionPanelOf(visibleState)?.xrStartup?.sessionVisibility,
        tour: companionPanelOf(resumedState)?.tour },
    };
    await captureXrFramebuffer(companion, '07j-companion-xr-session-visibility');
    passed('A hidden XR session cancels the held microphone, answers the agent busy instead of ready, pauses tour autoplay, and gives all three back when the headset is worn again');
    // Stop here by throwing, so the finally block still writes browser-report.json
    // with this probe's recorded evidence and the diagnostics ring.
    throw Error('xrvis probe complete: stopping before the rest of the run.');
    }

    // Opt-in hardware-risk probes. `Reset view` takes the workspace over,
    // which stops the running lesson, so this block deliberately changes the
    // state every later case in this file depends on. It runs only when a
    // caller asks for it with STEREOFOLD_HWRISK_PROBE=1.
    if (process.env.STEREOFOLD_HWRISK_PROBE === '1') {
    // `Reset view` is the toolbar row behind the same `recenter-structure` that
    // the B/Y hold and the stick click dispatch. A reset re-seats the menu, and
    // nothing here pressed that row, so the re-seat was never
    // exercised anywhere but on a wearer's head. Press it and require the
    // menu's own action to have reached the toolbar's action chain. The frame
    // after it is the menu a wearer has to be able to find again.
    const toolbarActionsBeforeReset = (await diagnosticsOf(companion, 'toolbar-action')).length;
    await pressToolbar('Reset view', { kind: 'recenter-structure' });
    await companion.waitForTimeout(600);
    const resetActions = (await diagnosticsOf(companion, 'toolbar-action')).slice(toolbarActionsBeforeReset);
    report.emulatedXr.resetViewActions = resetActions;
    report.emulatedXr.headRotationHold = await diagnosticsOf(companion, 'head-rotation-hold');
    assert.ok(resetActions.some((entry: any) => entry.kind === 'recenter-menu'),
      `Reset view did not queue a recenter-menu action, so the menu was not re-seated: ${JSON.stringify(resetActions)}`);
    assert.ok(report.emulatedXr.headRotationHold.some((entry: any) => entry.held === true),
      'The presentation layer did not capture camera.headRotation, so the menu text renders mirrored off the entry yaw.');
    await captureXrFramebuffer(companion, '07h-companion-xr-reset-view');
    passed('Reset view re-seats the spatial menu and the presentation layer holds the Mol* head rotation at zero');

    // The agent's own tour controls, against a headset panel that has just had
    // its workspace taken over by the reset. That takeover stops the tour
    // (`tour-player.ts:832`), which is exactly the state that refused every
    // `control_tour play` for eight minutes on hardware. Each command has to
    // render, and the panel has to advertise `ready` again after each one, or
    // the next agent command is refused.
    const tourCommands: { action: string; commandId: string }[] = [
      { action: 'play', commandId: 'hwrisk-tour-play' },
      { action: 'next', commandId: 'hwrisk-tour-next' },
      { action: 'pause', commandId: 'hwrisk-tour-pause' },
      { action: 'play', commandId: 'hwrisk-tour-replay' },
    ];
    report.emulatedXr.agentTourCommands = [];
    for (const command of tourCommands) {
      const ready = await waitPanelReady(sessionId, 'companion', companionPanel);
      const queued = await call('control_tour', { ...binding(ready, sessionId), panelId: companionPanel,
        commandId: command.commandId, action: command.action });
      const receipt = await waitState(sessionId, state => state.command?.commandId === command.commandId
        && ['rendered', 'rejected', 'expired', 'conflict', 'unconfirmed'].includes(state.command?.status), command.commandId, 300_000);
      const after = await waitPanelReady(sessionId, 'companion', companionPanel);
      const observed = { action: command.action, queued: (queued.structuredContent as any)?.command?.status,
        status: receipt.command?.status, reason: receipt.command?.reason, detail: receipt.command?.detail,
        tour: after.panels.find((panel: any) => panel.panelId === companionPanel)?.tourState };
      report.emulatedXr.agentTourCommands.push(observed);
      assert.equal(observed.status, 'rendered',
        `Agent control_tour ${command.action} did not render: ${JSON.stringify(observed)}`);
    }
    await captureXrFramebuffer(companion, '07i-companion-xr-agent-tour');
    passed('Agent control_tour play, next, pause and a second play each render against a headset panel whose tour the wearer had stopped, and the panel returns to ready after every one');
    // Stop here by throwing, so the finally block still writes browser-report.json
    // with the probe's recorded evidence and the diagnostics ring.
    throw Error('hwrisk probe complete: stopping before the rest of the run.');
    }
    // Only the viewpoint. Mol* keeps fog and the bounding radius on the same
    // camera object, and both legitimately move in a headset: a scene sets its
    // own fog through `appearance`, and the radius follows the structure's
    // bounds whenever a representation is rebuilt. Comparing the whole object
    // failed the run on `fog: 30` versus `fog: 0` while the head pose, which is
    // the thing a replayed desktop camera would steal, had not moved at all.
    const viewpoint = (camera: any) => camera && { mode: camera.mode, fov: camera.fov,
      position: camera.position, target: camera.target, up: camera.up };
    assert.deepEqual(viewpoint(tourFirst.scene.camera), viewpoint(tourBefore.scene.camera),
      'The first XR tour scene replayed a desktop camera.');
    const firstPixels = await captureXrFramebuffer(companion, '07-tour-first-scene-xr');
    assert.ok(firstPixels.eyes.every((eye: any) => eye.foreground > 100));
    assert.notEqual(firstPixels.leftEye.sha256, menuPixels.leftEye.sha256, 'The in-headset tour menu and first scene rendered the same left-eye frame.');
    const firstBodyPage = (await currentTour(companion)).bodyPageIndex;
    await pressToolbar('More tour text', { kind: 'tour-page' });
    await waitCurrentTour(companion, state => state.bodyPageIndex !== firstBodyPage);
    await pressToolbar('Tour next', { kind: 'tour-next' });
    await atScene(openingScene + 1);
    const tourSecond = await waitToolbarScene('Tour next', data => data.inspectionRevision > tourFirst.inspectionRevision);
    assert.deepEqual(viewpoint(tourSecond.scene.camera), viewpoint(tourBefore.scene.camera), 'Next replayed a desktop camera in XR.');
    const injectDeadlineRecovery = process.env.STEREOFOLD_XR_DEADLINE_RECOVERY_ONLY === '1';
    let faultBaseline: any, faultHeadViews: any;
    if (injectDeadlineRecovery) {
      assert.ok(focusedTourIwer, 'Deadline injection requires the focused IWER harness.');
      await waitCurrentTour(companion, state => !state.navigating && state.step === openingScene);
      const beforeFaultPanel = await companion.locator('body').getAttribute('data-panel-id');
      assert.ok(beforeFaultPanel);
      await waitPanelReady(sessionId, 'companion', beforeFaultPanel);
      await waitToolbarQuiet(companion);
      await captureXrFramebuffer(companion, '08-before-injected-deadline-xr');
      faultHeadViews = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1).views);
      await waitPanelReady(sessionId, 'companion', beforeFaultPanel);
      faultBaseline = await privateInspection(sessionId);
      report.emulatedXr.faultBaseline = { inspectionRevision: faultBaseline.inspectionRevision,
        stepIndex: faultBaseline.experience.stepIndex, camera: faultBaseline.scene.camera,
        placement: faultBaseline.scene.inspection.placement,
        earlierRevision: tourSecond.inspectionRevision, earlierCamera: tourSecond.scene.camera,
        earlierPlacement: tourSecond.scene.inspection.placement };

      await companion.evaluate(() => {
        const global = window as any, native = window.postMessage;
        const startSeq = global.__stereofoldDiagnostics.entries().at(-1)?.seq ?? 0;
        const fault: any = global.__xrDeadlineFault = { startSeq, held: false, released: false, armedAt: performance.now() };
        window.postMessage = function (this: Window, ...args: any[]) {
          const placedStarted = global.__stereofoldDiagnostics.entries().some((entry: any) =>
            entry.seq > startSeq && entry.kind === 'grow' && entry.detail?.phase === 'built');
          if (!fault.held && placedStarted && typeof args[0] === 'string' && args[0].startsWith('setImmediate$')) {
            fault.held = true; fault.heldAt = performance.now();
            window.postMessage = native;
            // Browser-only single-operation fault: keep frames/timers/network
            // live while this Mol* continuation exceeds the real 45s deadline.
            setTimeout(() => { fault.released = true; fault.releasedAt = performance.now();
              Reflect.apply(native, window, args); }, 46_000);
            return;
          }
          return Reflect.apply(native, this, args);
        } as typeof window.postMessage;
      });
    }
    await pressToolbar('Tour back', { kind: 'tour-back' });
    if (injectDeadlineRecovery) {
      await companion.waitForFunction(() => /Journey could not render:.*Previous view restored\./i.test(
        document.querySelector('.experience-player:not([hidden]) [data-experience-status]')?.textContent ?? ''));
      const failed = { ...await waitCurrentTour(companion, state => !state.autoplay && !state.navigating),
        feedback: await companion.locator('.experience-player:not([hidden]) [data-experience-status]').textContent() };
      const retainedStepIndex = openingScene; // Visible Scene N is zero-based step N-1; second is openingScene.
      assert.equal(failed.step, retainedStepIndex, 'A failed Back must retain the second scene index.');
      assert.match(failed.feedback, /placed.*45|deadline|timed out/i);
      const recoveredPanel = await companion.locator('body').getAttribute('data-panel-id');
      assert.ok(recoveredPanel, 'Recovered renderer must publish its current attachment.');
      const recovered = await waitPanelReady(sessionId, 'companion', recoveredPanel);
      const retained = await privateInspection(sessionId);
      await waitToolbarQuiet(companion);
      // Capture before comparing JSON so a failed invariant still leaves
      // direct evidence of the actual retained molecule in both eyes.
      const retainedPixels = await captureXrFramebuffer(companion, '09-retained-after-deadline-xr');
      const retainedHeadViews = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1).views);
      assert.deepEqual(retainedHeadViews, faultHeadViews, 'Rollback changed the tracked eye positions.');
      // Mol* recomputes radius from the restored representation bounds. All
      // viewpoint, radiusMax, style, selection and placement fields stay exact;
      // paired-eye pixels separately prove the molecule did not move or scale.
      const withoutDerivedRadius = (scene: any) => {
        const { radius: _radius, ...camera } = scene.camera;
        return { ...scene, camera };
      };
      report.emulatedXr.recoverySceneComparison = { beforeRadius: faultBaseline.scene.camera.radius,
        afterRadius: retained.scene.camera.radius, excludedDerivedFields: ['camera.radius'],
        before: faultBaseline.scene, after: retained.scene, trackedEyeViewsUnchanged: true };
      assert.deepEqual(withoutDerivedRadius(retained.scene), withoutDerivedRadius(faultBaseline.scene),
        'Failed Back changed the settled saved molecular scene beyond its derived radius.');
      assert.equal(retained.experience.stepIndex, retainedStepIndex, 'Host experience must retain the second scene.');
      const retainedProgress = await companion.locator('.experience-player:not([hidden]) [data-experience-progress]').textContent();
      assert.match(retainedProgress ?? '', new RegExp(`scene\\s+${retainedStepIndex + 1}\\s*/`, 'i'));

      const fault = await companion.evaluate(() => (window as any).__xrDeadlineFault);
      const journey = await companion.evaluate(startSeq => (window as any).__stereofoldDiagnostics.entries()
        .filter((entry: any) => entry.seq > startSeq && entry.kind === 'journey').map((entry: any) => entry.detail), fault.startSeq);
      assert.ok(journey.some((entry: any) => entry.phase === 'rolled-back'));
      assert.ok(!journey.some((entry: any) => entry.phase === 'acknowledged'), 'Failed Back reported a rendered success.');
      assert.equal(fault.held, true); assert.equal(fault.released, true);
      assert.ok(fault.releasedAt - fault.heldAt >= 46_000);
      const notice = await companion.evaluate(() => document.querySelector('.session-notice:not([hidden])')?.textContent ?? null);
      assert.ok(!notice || !/disconnected/i.test(notice), 'Successful recovery retained a Disconnected warning.');
      assert.ok(retainedPixels.eyes.every((eye: any) => eye.foreground > 100));
      const commandId = 'xr-after-injected-deadline';
      await call('update_inspection', { ...binding(recovered, sessionId), panelId: recoveredPanel, commandId,
        change: { kind: 'appearance', patch: { uniformColor: '#7ee6ff', background: '#08131f' } } });
      const receipt = await waitState(sessionId, state => state.command?.status === 'rendered', commandId);
      assert.equal(receipt.command.panelId, recoveredPanel);
      const nextPixels = await captureXrFramebuffer(companion, '10-command-after-deadline-xr');
      assert.ok(nextPixels.eyes.every((eye: any) => eye.foreground > 100));
      assert.notEqual(nextPixels.leftEye.sha256, retainedPixels.leftEye.sha256);
      const beforeOff = await privateInspection(sessionId);
      const offState = await waitPanelReady(sessionId, 'companion', recoveredPanel);
      const offId = 'xr-recovery-off-molecule';
      await call('update_inspection', { ...binding(offState, sessionId), panelId: recoveredPanel, commandId: offId,
        change: { kind: 'placement', patch: { translation: [8, 0, 0] } } });
      const offReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', offId);
      assert.equal(offReceipt.command.panelId, recoveredPanel);
      const offScene = await privateInspection(sessionId);
      assert.deepEqual(offScene.scene.inspection.placement.translation, [8, 0, 0]);
      assert.deepEqual(offScene.scene.camera, beforeOff.scene.camera);
      await captureXrFramebuffer(companion, '11-off-molecule-toolbar-expanded');
      await pressToolbar('Collapse off-molecule controls', { kind: 'collapse', value: true });
      const collapsedPixels = await captureXrFramebuffer(companion, '12-off-molecule-toolbar-collapsed');
      assert.ok(collapsedPixels.eyes.every((eye: any) => eye.foreground > 100));
      assert.deepEqual((await privateInspection(sessionId)).scene, offScene.scene);
      await pressToolbar('Expand off-molecule controls', { kind: 'collapse', value: false });
      const restoreState = await waitPanelReady(sessionId, 'companion', recoveredPanel);
      const restoreId = 'xr-recovery-restore-molecule';
      await call('update_inspection', { ...binding(restoreState, sessionId), panelId: recoveredPanel, commandId: restoreId,
        change: { kind: 'placement', patch: beforeOff.scene.inspection.placement } });
      const restoreReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', restoreId);
      assert.equal(restoreReceipt.command.panelId, recoveredPanel);
      assert.deepEqual((await privateInspection(sessionId)).scene, beforeOff.scene);
      await captureXrFramebuffer(companion, '13-restored-molecule-xr');
      report.emulatedXr.injectedDeadlineRecovery = { fault, failed, journey, retainedHeadViews, retainedProgress, retainedExperienceStepIndex: retained.experience.stepIndex, retainedRevision: retained.inspectionRevision,
        readyPanel: { panelId: recoveredPanel, availability: 'ready', current: true }, notice,
        nextCommand: receipt.command, retainedViewDrawn: true,
        offMolecule: { expandedAndCollapsedCaptured: true, restored: true, offCommand: offReceipt.command, restoreCommand: restoreReceipt.command } };
      passed('Injected single Mol* continuation delay rejects Back, redraws the retained scene, registers ready, clears Disconnected and renders the next real tool command');
      await companion.evaluate(() => (window as any).__companionXrTest?.active?.session.end());
      await companion.waitForFunction(() => !(window as any).__companionXrTest?.active);
      await waitState(sessionId, state => state.panels.some((panel: any) => panel.panelId === recoveredPanel && panel.spatialContext === null));
      await assertRuntimeUnchanged();
      assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []); assertEvidenceClean(true);
      throw Object.assign(Error('Labeled injected-deadline recovery proof complete.'), { stereofoldRunComplete: true });
    }
    await atScene(openingScene);
    const tourBack = await waitToolbarScene('Tour back', data => data.inspectionRevision > tourSecond.inspectionRevision);
    assert.deepEqual(viewpoint(tourBack.scene.camera), viewpoint(tourBefore.scene.camera), 'Back replayed a desktop camera in XR.');
    // The experience player preserves Play across manual Next/Back. Establish
    // Pause through the real controller before testing the Play toggle.
    if ((await currentTour(companion)).autoplay) {
      await pressToolbar('Pause before autoplay test', { kind: 'tour-play' });
      await waitCurrentTour(companion, state => state.autoplay === false);
    }
    const automaticPage = (await currentTour(companion)).bodyPageIndex;
    // Keep the first timer long enough for a software-XR trigger gesture to
    // finish, then hold later pages while we exercise the real Pause control.
    await companion.evaluate(() => { document.body.dataset.tourDelayMs = '30000'; });
    await pressToolbar('Play tour', { kind: 'tour-play' });
    await companion.evaluate(() => { document.body.dataset.tourDelayMs = '600000'; });
    await waitCurrentTour(companion, state => state.autoplay === true);
    await waitCurrentTour(companion, state => state.bodyPageIndex !== automaticPage);
    await pressToolbar('Pause tour', { kind: 'tour-play' });
    await waitCurrentTour(companion, state => state.autoplay === false);
    const poseAfterTour = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1));
    assert.deepEqual(poseAfterTour.views.map((view: any) => view.position), poseBeforeTour.views.map((view: any) => view.position),
      'Tour navigation changed the emulated head position.');
    assert.deepEqual(viewpoint((await privateInspection(sessionId)).scene.camera), viewpoint(tourBefore.scene.camera),
      'Tour Play/Pause wrote a headset pose into the saved desktop camera.');
    report.emulatedXr.tour = { mode: enteredMode,
      controllerActions: [...(demo ? [] : ['next-tour']), 'start', 'more-text', 'next', 'back', 'play', 'auto-page', 'pause'],
      startRecord,
      titleBodyProgress: true, cameraPreserved: true, headPositionPreserved: true };
    passed('Real IWER controller Tour menu, Start, Next, Back and Play/Pause show readable lesson state in both eyes while preserving the saved camera and live head pose');

    if (demo && stepShotDirectory) {
      // Autoplay must not move the scene under the capture, and the toolbar
      // reads this same seam whenever it schedules.
      await companion.evaluate(() => { document.body.dataset.tourDelayMs = '600000'; });
      const sceneNow = async () => await companion.evaluate(() => {
        const match = /scene\s+(\d+)\s*\/\s*(\d+)/i.exec(document.querySelector('.tour-player:not([hidden]) [data-tour-progress], .experience-player:not([hidden]) [data-experience-progress]')?.textContent ?? '');
        return match ? { step: Number(match[1]), total: Number(match[2]) } : null;
      });
      const atSceneOne = await sceneNow();
      assert.ok(atSceneOne, 'The immersive tour reported no scene number to step through.');
      for (let back = atSceneOne.step; back > 1; back--) {
        await pressToolbar('Tour back', { kind: 'tour-back' });
        await companion.waitForFunction(target => new RegExp(`scene\\s+${target}\\s*/`, 'i')
          .test(document.querySelector('.tour-player:not([hidden]) [data-tour-progress], .experience-player:not([hidden]) [data-experience-progress]')?.textContent ?? ''), back - 1);
      }
      const total = atSceneOne.total;
      const steps: any[] = [];
      let previousInspection = await privateInspection(sessionId);
      for (let step = 1; step <= total; step++) {
        const current = await sceneNow();
        assert.deepEqual(current, { step, total }, `The tour was at ${JSON.stringify(current)} when scene ${step} was expected.`);
        await companion.waitForFunction(() => Boolean(document.querySelector('.tour-player:not([hidden]) [data-tour-body], .experience-player:not([hidden]) [data-experience-body]')?.textContent?.trim()));
        const title = (await companion.locator('.tour-player:not([hidden]) [data-tour-title], .experience-player:not([hidden]) [data-experience-title]').textContent())?.trim() ?? '';
        const body = (await companion.locator('.tour-player:not([hidden]) [data-tour-body], .experience-player:not([hidden]) [data-experience-body]').textContent())?.trim() ?? '';
        const shot = await captureTourStepEyes(companion, stepShotDirectory, step, title);
        steps.push({ ...shot, title, bodyWords: body.split(/\s+/u).filter(Boolean).length,
          readoutPage: (await currentTour(companion)).bodyPageIndex });
        if (step === total) break;
        await pressToolbar('Tour next', { kind: 'tour-next' });
        // Five minutes, not Playwright's default two. These lessons build a
        // Gaussian molecular surface over 13,000 to 41,000 atom sites, and this
        // emulator reports `gpu: unavailable`, so that scene is computed on the
        // CPU here. A Quest 2 has a GPU and does it in seconds; the wait exists
        // for the emulator's arithmetic, not for the product.
        await companion.waitForFunction(target => new RegExp(`scene\\s+${target}\\s*/`, 'i')
          .test(document.querySelector('.tour-player:not([hidden]) [data-tour-progress], .experience-player:not([hidden]) [data-experience-progress]')?.textContent ?? ''), step + 1, { timeout: 300_000 });
        const advanced = await waitToolbarScene(`Tour next to scene ${step + 1}`,
          data => data.inspectionRevision > previousInspection.inspectionRevision);
        previousInspection = advanced;
      }
      // A scene whose two neighbours render the same left eye changed nothing a
      // wearer can see, which is the failure this check exists to catch.
      const repeated = steps.filter((entry, index) => index > 0
        && entry.eyes.find((eye: any) => eye.eye === 'left').sha256
          === steps[index - 1].eyes.find((eye: any) => eye.eye === 'left').sha256)
        .map(entry => entry.step);
      report.emulatedXr.tourSteps = { demo: demo.entry.name, directory: stepShotDirectory, total, steps, repeatedLeftEye: repeated };
      assert.deepEqual(repeated, [], `Scenes ${repeated.join(', ')} of ${demo.entry.name} rendered the same left eye as the scene before them.`);
      passed(`Every scene of the ${demo.entry.name} lesson renders a distinct both-eye frame under real IWER controller presses`);
    }


    if (!focusedTourIwer) {
    const immersiveState = await waitPanelReady(sessionId, 'companion', companionPanel);
    console.log('Observed: immersive companion is current and ready for a command.');
    const immersiveCommandId = 'companion-xr-uniform';
    await call('update_inspection', {
      ...binding(immersiveState, sessionId), panelId: companionPanel, commandId: immersiveCommandId,
      change: { kind: 'appearance', patch: { uniformColor: '#7ee6ff', background: '#08131f' } },
    });
    const immersiveReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', immersiveCommandId);
    console.log('Observed: immersive command has a rendered receipt.');
    assert.equal(immersiveReceipt.command.panelId, companionPanel);
    await companion.waitForFunction(revision => document.querySelector('[data-session-outcome]')?.textContent?.includes(`revision ${revision}`),
      immersiveReceipt.command.renderedRevision);
    await companion.waitForFunction(mode => (window as any).__companionXrTest?.active?.mode === mode, enteredMode);

    const residueLookup = (await call('get_inspection_state', {sessionId,
      residues:{labelChain:'A',labelSequenceRange:[3,5],limit:16}})).structuredContent.residues;
    assert.equal(residueLookup.total,3);
    assert.ok(residueLookup.rows.every((row:any)=>row.coordinateState==='resolved' && row.identity.labelChain==='A'));
    assert.doesNotMatch(JSON.stringify(residueLookup), /atomSites|sourceCoordinates|structureText|camera/);
    const catalogSelectionKeys=residueLookup.rows.map((row:any)=>row.key);
    const requestedKeys=[...catalogSelectionKeys].reverse();
    const beforeAgentSelection=await privateInspection(sessionId);
    const selectionState=await waitPanelReady(sessionId,'companion',companionPanel);
    const selectionCommandId='companion-xr-select-region';
    const selectionQueued=await call('update_inspection',{
      ...binding(selectionState,sessionId),panelId:companionPanel,commandId:selectionCommandId,
      change:{kind:'selection',patch:{selectionKeys:requestedKeys}},
    });
    assert.equal(selectionQueued.structuredContent.command.status,'queued');
    const selectionReceipt=await waitState(sessionId,state=>state.command?.status==='rendered',selectionCommandId);
    const afterAgentSelection=await waitPrivate(sessionId,data=>data.inspectionRevision===selectionReceipt.inspectionRevision);
    assert.deepEqual(afterAgentSelection.scene,{...beforeAgentSelection.scene,selectionKeys:catalogSelectionKeys});
    await waitCompanionSelection(companion, initial.catalog, afterAgentSelection.scene);
    // The earlier desktop search is deliberately local UI state. Clear it
    // before reading the complete shared selection, rather than weakening the
    // assertion to accept its filtered subset.
    await desktop.frame.locator('[data-control="search"]').fill('');
    await waitSelectedKeys(desktop.frame,catalogSelectionKeys);
    const selectedLookup=(await call('get_inspection_state',{sessionId,residues:{selectedOnly:true}})).structuredContent.residues;
    assert.deepEqual(selectedLookup.rows.map((row:any)=>row.key),catalogSelectionKeys);
    await companion.waitForFunction(revision=>document.querySelector('[data-session-outcome]')?.textContent?.includes(`Applied · selection · revision ${revision}`),
      selectionReceipt.command.renderedRevision);
    report.agentSelection={matchedResidues:catalogSelectionKeys.length,requestedOrder:'reversed-catalog',renderedRevision:selectionReceipt.command.renderedRevision,
      desktopFollowed:true,appearancePlacementAndViewpointPreserved:true};
    passed('A reversed public residue-selection payload saves and displays the exact catalog-canonical region in the immersive companion and desktop without changing appearance, placement, or viewpoint');

    const beforeRichXr = await privateInspection(sessionId);
    const priorAppearance = structuredClone(beforeRichXr.scene.inspection.appearance);
    const richXrState = await waitPanelReady(sessionId, 'companion', companionPanel);
    const richXrCommandId = 'companion-xr-rich-surface';
    const richXrQueued = await call('update_inspection', {
      ...binding(richXrState, sessionId), panelId: companionPanel, commandId: richXrCommandId,
      change: { kind: 'appearance', patch: { representation: 'molecular-surface', opacity: 0.4, labels: true } },
    });
    assert.equal(richXrQueued.structuredContent.command.status, 'queued');
    const richXrReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', richXrCommandId, XR_REBUILD_TIMEOUT_MS);
    await companion.waitForFunction(revision => document.querySelector('[data-session-outcome]')?.textContent?.includes(`revision ${revision}`),
      richXrReceipt.command.renderedRevision);
    const richXrScene = await waitPrivate(sessionId, data => data.inspectionRevision === richXrReceipt.inspectionRevision);
    assert.equal(richXrScene.scene.inspection.appearance.representation, 'molecular-surface');
    assert.equal(richXrScene.scene.inspection.appearance.opacity, 0.4);
    assert.equal(richXrScene.scene.inspection.appearance.labels, true);
    assert.deepEqual(richXrScene.scene.inspection.placement, beforeRichXr.scene.inspection.placement);
    assert.deepEqual(richXrScene.scene.selectionKeys, beforeRichXr.scene.selectionKeys);
    assert.deepEqual({ ...richXrScene.scene.camera, radiusMax: beforeRichXr.scene.camera.radiusMax }, beforeRichXr.scene.camera,
      'A representation change may recompute molecular bounds but must retain the viewpoint.');
    const richXrPixels = await captureXrFramebuffer(companion, '07-rich-xr-surface-labels');
    assert.ok(richXrPixels.eyes.every((eye: any) => eye.foreground > 100),
      'Surface, transparency, and selected labels must render nonempty content in both XR eyes.');

    const restoreRichState = await waitPanelReady(sessionId, 'companion', companionPanel);
    const restoreRichCommandId = 'companion-xr-restore-appearance';
    const restoreRichQueued = await call('update_inspection', {
      ...binding(restoreRichState, sessionId), panelId: companionPanel, commandId: restoreRichCommandId,
      change: { kind: 'appearance', patch: priorAppearance },
    });
    assert.equal(restoreRichQueued.structuredContent.command.status, 'queued');
    const restoreRichReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', restoreRichCommandId, XR_REBUILD_TIMEOUT_MS);
    await companion.waitForFunction(revision => document.querySelector('[data-session-outcome]')?.textContent?.includes(`revision ${revision}`),
      restoreRichReceipt.command.renderedRevision);
    const restoredRichScene = await waitPrivate(sessionId, data => data.inspectionRevision === restoreRichReceipt.inspectionRevision);
    assert.deepEqual(restoredRichScene.scene.inspection.appearance, priorAppearance);
    assert.deepEqual(restoredRichScene.scene.inspection.placement, beforeRichXr.scene.inspection.placement);
    assert.deepEqual(restoredRichScene.scene.selectionKeys, beforeRichXr.scene.selectionKeys);
    for (const key of Object.keys(beforeRichXr.scene.camera).filter(key => !['radiusMax','radius','fog','clipFar'].includes(key)))
      assert.deepEqual(restoredRichScene.scene.camera[key], beforeRichXr.scene.camera[key], `Restoring appearance changed camera pose field ${key}.`);
    const initialToolbarPixels = await captureXrFramebuffer(companion, '07-initial-xr-before-controller');
    assert.ok(initialToolbarPixels.eyes.every((eye: any) => eye.foreground > 100),
      'Initial XR evidence must show rendered content in both eyes before controller input.');
    for (const eye of ['left', 'right']) {
      assert.notEqual(richXrPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        initialToolbarPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        `Rich surface, opacity, and labels did not change actual ${eye}-eye pixels.`);
    }
    passed('A rendered XR command shows a transparent molecular surface with selected labels in both eyes, then a second receipt restores exact appearance without changing placement, selection, or viewpoint');

    // Isolate labels from every other appearance dimension. The virtual head
    // remains at its configured position while both captures come from the
    // production XR presentation framebuffer.
    await companion.evaluate(async () => {
      const test = (window as any).__companionXrTest, session = test.active.session;
      test.device.position.set(0, 1.6, 0);
      for (let index = 0; index < 3; index++) await new Promise<void>(resolveFrame => session.requestAnimationFrame(() => resolveFrame()));
    });
    const labelsFixedHead = await companion.evaluate(() => {
      const position = (window as any).__companionXrTest.device.position;
      return { x: position.x, y: position.y, z: position.z };
    });
    assertToolbarPoint(labelsFixedHead, headPose.position);
    const labelsOffState = await waitPanelReady(sessionId, 'companion', companionPanel);
    const labelsOffCommandId = 'companion-xr-labels-off';
    await call('update_inspection', {
      ...binding(labelsOffState, sessionId), panelId: companionPanel, commandId: labelsOffCommandId,
      change: { kind: 'appearance', patch: { labels: false } },
    });
    const labelsOffReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', labelsOffCommandId, XR_REBUILD_TIMEOUT_MS);
    const labelsOffScene = await waitPrivate(sessionId, data => data.inspectionRevision === labelsOffReceipt.inspectionRevision);
    assert.equal(labelsOffScene.scene.inspection.appearance.labels, false);
    const labelsOffPixels = await captureXrFramebuffer(companion, '07-labels-off-xr');

    const labelsOnState = await waitPanelReady(sessionId, 'companion', companionPanel);
    const labelsOnCommandId = 'companion-xr-labels-on';
    await call('update_inspection', {
      ...binding(labelsOnState, sessionId), panelId: companionPanel, commandId: labelsOnCommandId,
      change: { kind: 'appearance', patch: { labels: true } },
    });
    const labelsOnReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', labelsOnCommandId, XR_REBUILD_TIMEOUT_MS);
    const labelsOnScene = await waitPrivate(sessionId, data => data.inspectionRevision === labelsOnReceipt.inspectionRevision);
    assert.deepEqual(labelsOnScene.scene.inspection.appearance, { ...labelsOffScene.scene.inspection.appearance, labels: true });
    assert.deepEqual(labelsOnScene.scene.camera, labelsOffScene.scene.camera);
    assert.deepEqual(labelsOnScene.scene.inspection.placement, labelsOffScene.scene.inspection.placement);
    assert.deepEqual(labelsOnScene.scene.selectionKeys, labelsOffScene.scene.selectionKeys);
    const labelsOnPixels = await captureXrFramebuffer(companion, '07-labels-on-xr');
    const labelsHeadAfter = await companion.evaluate(() => {
      const position = (window as any).__companionXrTest.device.position;
      return { x: position.x, y: position.y, z: position.z };
    });
    assertToolbarPoint(labelsHeadAfter, labelsFixedHead);
    for (const eye of ['left', 'right']) assert.notEqual(
      labelsOnPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
      labelsOffPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
      `Enabling labels did not change actual ${eye}-eye XR pixels at fixed head, representation, and opacity.`);

    const nextResidueLookup = (await call('get_inspection_state', { sessionId,
      residues: { labelChain: 'A', labelSequenceRange: [6, 8], limit: 16 } })).structuredContent.residues;
    const nextCatalogSelectionKeys = nextResidueLookup.rows.map((row: any) => row.key);
    assert.equal(nextResidueLookup.total, 3);
    assert.ok(nextCatalogSelectionKeys.every((key: string) => !catalogSelectionKeys.includes(key)), 'The labels-on selection must target a new residue region.');
    const labelsSelectionState = await waitPanelReady(sessionId, 'companion', companionPanel);
    const labelsSelectionCommandId = 'companion-xr-select-labeled-region';
    await call('update_inspection', {
      ...binding(labelsSelectionState, sessionId), panelId: companionPanel, commandId: labelsSelectionCommandId,
      change: { kind: 'selection', patch: { selectionKeys: [...nextCatalogSelectionKeys].reverse() } },
    });
    const labelsSelectionReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', labelsSelectionCommandId);
    const labelsSelectionScene = await waitPrivate(sessionId, data => data.inspectionRevision === labelsSelectionReceipt.inspectionRevision);
    assert.deepEqual(labelsSelectionScene.scene.selectionKeys, nextCatalogSelectionKeys);
    assert.deepEqual(labelsSelectionScene.scene.inspection.appearance, labelsOnScene.scene.inspection.appearance);
    assert.deepEqual(labelsSelectionScene.scene.inspection.placement, labelsOnScene.scene.inspection.placement);
    assert.deepEqual(labelsSelectionScene.scene.camera, labelsOnScene.scene.camera);
    await waitCompanionSelection(companion, initial.catalog, labelsSelectionScene.scene);
    await desktop.frame.locator('[data-control="search"]').fill('');
    await waitSelectedKeys(desktop.frame, nextCatalogSelectionKeys);
    const labelsSelectionPixels = await captureXrFramebuffer(companion, '07-labels-new-region-xr');
    for (const eye of ['left', 'right']) assert.notEqual(
      labelsSelectionPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
      labelsOnPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
      `Selecting a new labelled region did not change actual ${eye}-eye XR pixels.`);
    report.labelsXr = { fixedHead: labelsFixedHead, representation: labelsOnScene.scene.inspection.appearance.representation,
      opacity: labelsOnScene.scene.inspection.appearance.opacity, labelsChangedBothEyes: true, newRegionCount: nextCatalogSelectionKeys.length,
      cameraAppearanceAndPlacementPreserved: true };
    passed('At a fixed XR head pose, labels alone change both production eye buffers; a new reversed-payload region selection keeps labels, camera, appearance, and placement while updating the labelled residues');

    // The molecular controls live behind More controls; open them for real
    // rather than assuming the wearer already sees the expanded grid.
    const molecularRows = await waitPressablePanelRows(companion, [
      { kind: 'collapse', value: false }, { kind: 'collapse', value: true }]);
    const molecularCollapse = molecularRows?.find(row => row.action?.kind === 'collapse')?.action;
    assert.ok(molecularCollapse, 'Molecular controls need a committed menu collapse row.');
    if (molecularCollapse.value === false)
      await pressToolbar('Expand controls for molecular actions', { kind: 'collapse', value: false });
    else toolbarCollapsed = false;
    const toolbarInitial = await privateInspection(sessionId);
    const toolbarSelection = [...toolbarInitial.scene.selectionKeys];
    await pressToolbar('Scale +', { kind: 'scale', direction: 1 });
    const expectedScale = toolbarInitial.scene.inspection.placement.scale * 1.15;
    const toolbarScaled = await waitToolbarScene('Scale +', data => data.inspectionRevision > toolbarInitial.inspectionRevision
      && Math.abs(data.scene.inspection.placement.scale - expectedScale) < 1e-9);
    assert.deepEqual(toolbarScaled.scene.selectionKeys, toolbarSelection, 'Scale toolbar input picked molecular geometry behind it.');
    assert.deepEqual(toolbarScaled.scene.inspection.placement.translation, toolbarInitial.scene.inspection.placement.translation);
    await desktop.frame.waitForFunction(expected => Math.abs(Number((document.querySelector('[data-control="scale"]') as HTMLInputElement)?.value) - expected) < 1e-9,
      expectedScale);

    await pressToolbar('X +', { kind: 'nudge', axis: 'x', direction: 1 });
    const expectedTranslation = [...toolbarScaled.scene.inspection.placement.translation];
    expectedTranslation[0] += 0.2;
    const toolbarNudged = await waitToolbarScene('X +', data => data.inspectionRevision > toolbarScaled.inspectionRevision
      && Math.abs(data.scene.inspection.placement.translation[0] - expectedTranslation[0]) < 1e-9);
    assert.deepEqual(toolbarNudged.scene.selectionKeys, toolbarSelection, 'Translation toolbar input picked molecular geometry behind it.');
    assert.deepEqual(toolbarNudged.scene.inspection.placement.translation, expectedTranslation);
    assert.equal(toolbarNudged.scene.inspection.placement.scale, expectedScale);
    // The saved pose above remains full precision. Workspace numeric fields
    // deliberately display three decimals (workspace.mjs sync), so confirm
    // that displayed value rather than waiting for an unrendered precision.
    await desktop.frame.waitForFunction(expected => Math.abs(Number((document.querySelector('[data-vector="translation"][data-axis="x"]') as HTMLInputElement)?.value) - expected) < 1e-9,
      Math.round(expectedTranslation[0] * 1000) / 1000);

    const afterToolbarState = await waitPanelReady(sessionId, 'companion', companionPanel);
    const afterToolbarCommandId = 'companion-after-xr-toolbar';
    const afterToolbarUpdate = await call('update_inspection', {
      ...binding(afterToolbarState, sessionId), panelId: companionPanel, commandId: afterToolbarCommandId,
      change: { kind: 'appearance', patch: { background: '#0b1927' } },
    });
    assert.equal(afterToolbarUpdate.structuredContent.command.status, 'queued');
    const afterToolbarReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', afterToolbarCommandId);
    assert.equal(afterToolbarReceipt.command.panelId, companionPanel);
    await companion.waitForFunction(revision => document.querySelector('[data-session-outcome]')?.textContent?.includes(`revision ${revision}`),
      afterToolbarReceipt.command.renderedRevision);
    const afterToolbarAgentScene = await waitPrivate(sessionId, data => data.inspectionRevision === afterToolbarReceipt.inspectionRevision);
    assert.deepEqual(afterToolbarAgentScene.scene.selectionKeys, toolbarSelection);
    assert.deepEqual(afterToolbarAgentScene.scene.inspection.placement, toolbarNudged.scene.inspection.placement);
    await desktop.frame.waitForFunction(() => (document.querySelector('[data-control="background"]') as HTMLInputElement)?.value === '#0b1927');
    passed('Real IWER primary-trigger press and release activates Scale + and X + in the XR-local toolbar, preserves selection, saves placement, updates desktop, and leaves the current revision open to the next agent command');

    const expandedToolbarPixels = await captureXrFramebuffer(companion, '07a-companion-xr-toolbar-expanded');
    assert.ok(expandedToolbarPixels.eyes.every((eye: any) => eye.foreground > eye.width * eye.height * 0.005),
      'Expanded eye captures must visibly contain the molecule and spatial controls.');
    const sceneBeforeCollapse = structuredClone(afterToolbarAgentScene.scene);
    await pressToolbar('Collapse controls', { kind: 'collapse', value: true });
    await companion.waitForTimeout(300);
    const collapsedToolbarPixels = await captureXrFramebuffer(companion, '07b-companion-xr-toolbar-collapsed');
    assert.ok(collapsedToolbarPixels.eyes.every((eye: any) => eye.foreground > eye.width * eye.height * 0.005),
      'Collapsed eye captures must retain substantial molecular pixels behind the one-button control.');
    assert.notEqual(collapsedToolbarPixels.leftEye.sha256, expandedToolbarPixels.leftEye.sha256,
      'Collapsing the spatial toolbar did not change left-eye framebuffer pixels.');
    for (const eye of ['left', 'right']) {
      assert.notEqual(collapsedToolbarPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        expandedToolbarPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        `Collapsing the spatial toolbar did not change ${eye}-eye framebuffer pixels.`);
    }
    assert.deepEqual((await privateInspection(sessionId)).scene, sceneBeforeCollapse, 'Collapsing controls changed the saved molecular scene.');
    await pressToolbar('Expand controls', { kind: 'collapse', value: false });
    await companion.waitForTimeout(300);
    const reexpandedToolbarPixels = await captureXrFramebuffer(companion, '07c-companion-xr-toolbar-reexpanded');
    for (const eye of ['left', 'right']) {
      assert.notEqual(reexpandedToolbarPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        collapsedToolbarPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        `Expanding the spatial toolbar did not restore visible ${eye}-eye controls.`);
    }
    assert.deepEqual((await privateInspection(sessionId)).scene, sceneBeforeCollapse, 'Expanding controls changed the saved molecular scene.');
    passed('Spatial controls collapse to one XR-local button and expand again in actual two-eye IWER pixels without changing the saved scene');

    const motionStart = await privateInspection(sessionId);
    // Resolved before window rAF is held, then reused for the paired Pause:
    // the panel stays anchored at the entry pose through the head move below.
    // The press below happens with application window rAF held, so a rebuild
    // cannot finish underneath it and a retry there would be meaningless.
    // Settle the toolbar before the target is resolved instead.
    await waitToolbarQuiet(companion);
    const motionTarget = await toolbarTarget(companion, toolbarCollapsed, { kind: 'toggle-motion' });
    await companion.waitForFunction(() => /^Rotate structure$/i.test((document.querySelector('[data-action="rotation"]')?.textContent ?? '').trim()));
    await companion.evaluate(() => {
      const test = (window as any).__companionXrTest;
      const state = (window as any).__blockedWindowRaf = { request: window.requestAnimationFrame, cancel: window.cancelAnimationFrame,
        callbacks: new Map(), next: -1, iwerPumpCallbacks: new Set(test.iwerPumpCallbacks), iwerPumpCallbacksAllowed: 0 };
      if (state.iwerPumpCallbacks.size !== 1) throw Error(`Expected exactly one pinned IWER display pump, found ${state.iwerPumpCallbacks.size}.`);
      // IWER drives XRSession rAF through this pinned callback. Keep only that
      // emulator pump native while holding every application window-rAF
      // callback; otherwise the test freezes the emulated headset itself.
      window.requestAnimationFrame = callback => {
        if (state.iwerPumpCallbacks.has(callback)) { state.iwerPumpCallbacksAllowed++; return state.request.call(window, callback); }
        const id = state.next--; state.callbacks.set(id, callback); return id;
      };
      window.cancelAnimationFrame = id => { if (!state.callbacks.delete(id)) state.cancel.call(window, id); };
    });
    let pausedMotion: any;
    try {
      await pressXrToolbar(companion, 'Rotate', motionTarget);
      assert.ok(await companion.evaluate(() => (window as any).__blockedWindowRaf?.iwerPumpCallbacksAllowed > 0),
        'The test must retain IWER’s native XR frame pump while application window rAF callbacks are held.');
      await companion.waitForFunction(() => /^Pause rotation$/i.test((document.querySelector('[data-action="rotation"]')?.textContent ?? '').trim()), undefined, {polling:100});
      assert.deepEqual((await privateInspection(sessionId)).scene, motionStart.scene,
        'Starting transient XR rotation changed the shared scene.');
      const motionPixelsA = await captureXrFramebuffer(companion, '07-motion-fixed-head-a');
      await companion.waitForTimeout(850);
      const motionPixelsB = await captureXrFramebuffer(companion, '07-motion-fixed-head-b');
      for (const eye of ['left', 'right']) assert.notEqual(
        motionPixelsB.eyes.find((value: any) => value.eye === eye)?.sha256,
        motionPixelsA.eyes.find((value: any) => value.eye === eye)?.sha256,
        `XR rotation did not change ${eye}-eye pixels while window rAF callbacks were blocked.`);
      assert.deepEqual((await privateInspection(sessionId)).scene, motionStart.scene,
        'Transient XR rotation changed the shared scene before pause.');

      const poseBeforeMotionHead = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1));
      await companion.evaluate(() => {
        const device = (window as any).__companionXrTest.device;
        device.position.set(device.position.x + 0.05, device.position.y, device.position.z);
      });
      await companion.waitForFunction(before => {
        const latest = (window as any).__companionXrTest?.active?.poses?.at(-1);
        return Boolean(latest && JSON.stringify(latest.views) !== JSON.stringify(before.views));
      }, poseBeforeMotionHead, {polling:100});
      const movedMotionPose = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1));
      const motionPixelsMoved = await captureXrFramebuffer(companion, '07-motion-head-shift');
      assert.notDeepEqual(movedMotionPose.views, poseBeforeMotionHead.views);
      for (const eye of ['left', 'right']) assert.notEqual(
        motionPixelsMoved.eyes.find((value: any) => value.eye === eye)?.sha256,
        motionPixelsB.eyes.find((value: any) => value.eye === eye)?.sha256,
        `A 5 cm head move did not change ${eye}-eye pixels during XR rotation.`);
      assert.deepEqual((await privateInspection(sessionId)).scene, motionStart.scene,
        'Head movement during transient XR rotation changed the shared scene.');
      await companion.waitForTimeout(850);
      const motionPixelsContinued = await captureXrFramebuffer(companion, '07-motion-shifted-head-continued');
      for (const eye of ['left', 'right']) assert.notEqual(
        motionPixelsContinued.eyes.find((value: any) => value.eye === eye)?.sha256,
        motionPixelsMoved.eyes.find((value: any) => value.eye === eye)?.sha256,
        `XR rotation stopped in the ${eye} eye after head movement while window rAF was blocked.`);
      assert.deepEqual((await privateInspection(sessionId)).scene, motionStart.scene,
        'Continuing XR rotation changed the shared scene before pause.');

      const beforePause = await privateInspection(sessionId);
      await pressXrToolbar(companion, 'Pause rotation', motionTarget);
      await companion.waitForFunction(() => /^Rotate structure$/i.test((document.querySelector('[data-action="rotation"]')?.textContent ?? '').trim()), undefined, {polling:100});
      pausedMotion = await waitToolbarScene('Pause rotation', data => data.inspectionRevision > beforePause.inspectionRevision
        && JSON.stringify(data.scene.inspection.placement.rotation) !== JSON.stringify(beforePause.scene.inspection.placement.rotation));
      assert.deepEqual(pausedMotion.scene.selectionKeys, beforePause.scene.selectionKeys);
      assert.deepEqual(pausedMotion.scene.camera, beforePause.scene.camera);
      assert.deepEqual(pausedMotion.scene.inspection.appearance, beforePause.scene.inspection.appearance);
      assert.deepEqual(pausedMotion.scene.inspection.placement.translation, beforePause.scene.inspection.placement.translation);
      assert.equal(pausedMotion.scene.inspection.placement.scale, beforePause.scene.inspection.placement.scale);
      report.emulatedXr.motion = { windowRequestAnimationFrameCallbacksBlocked: true, fixedHeadIntervalMs: 850,
        headTranslationMeters: 0.05, sharedScenePreservedUntilPause: true, physicalHeadset: 'not_run' };
    } finally {
      await companion.evaluate(() => {
        const state = (window as any).__blockedWindowRaf;
        if (state?.request) {
          window.requestAnimationFrame = state.request;
          window.cancelAnimationFrame = state.cancel;
          for (const callback of state.callbacks.values()) state.request.call(window, callback);
        }
        delete (window as any).__blockedWindowRaf;
      });
    }
    assert.ok(pausedMotion, 'Pause rotation did not settle its visible pose into the shared scene.');
    await companion.evaluate(async () => {
      const test = (window as any).__companionXrTest, device = test.device, session = test.active.session;
      device.position.set(0, 1.6, 0);
      for (let index = 0; index < 3; index++) await new Promise<void>(resolveFrame => session.requestAnimationFrame(() => resolveFrame()));
    });
    const restoredMotionHead = await companion.evaluate(() => {
      const position = (window as any).__companionXrTest.device.position;
      return { x: position.x, y: position.y, z: position.z };
    });
    assertToolbarPoint(restoredMotionHead, headPose.position);
    passed('IWER controller Rotate continues in both eyes with window rAF blocked and through a 5 cm head move, keeps shared state transient until Pause, then saves one fixed pose');

    // The spoken half of the same two controls, and the only automated route
    // to it.
    //
    // A headset transcript is produced on the Mac and arrives over the
    // companion bridge, so nothing here can speak without a microphone and a
    // wearer. `__stereofoldVoice` is the seam the voice runner installs for
    // exactly this: it feeds one sentence to the same handler the bridge
    // feeds, through the real grammar, the real dispatcher and the real
    // render. What it proves: "do a rotation" turns the structure, and a
    // sentence the page has no command for says where it went instead of
    // refusing.
    const beforeVoiceSpin = await privateInspection(sessionId);
    const voiceSpinCursor = await diagnosticsCursor(companion);
    const spinKind = await companion.evaluate(() => (globalThis as any).__stereofoldVoice.say('do a rotation'));
    assert.equal(spinKind, 'toggle-motion', '"do a rotation" must start the presentation turn.');
    const voiceSpinUtteranceId = await companion.evaluate(since => (globalThis as any).__stereofoldDiagnostics.entries()
      .findLast((entry: any) => entry.seq > since && entry.kind === 'voice-loop'
        && entry.detail?.stage === 'receipt-rendered' && entry.detail?.utteranceId)?.detail.utteranceId, voiceSpinCursor);
    assert.equal(typeof voiceSpinUtteranceId, 'string', 'The spoken spin must have its own rendered utterance receipt.');
    const voiceSpinA = await captureXrFramebuffer(companion, '07e-voice-spin-a');
    await companion.waitForTimeout(850);
    const voiceSpinB = await captureXrFramebuffer(companion, '07e-voice-spin-b');
    for (const eye of ['left', 'right']) assert.notEqual(
      voiceSpinB.eyes.find((value: any) => value.eye === eye)?.sha256,
      voiceSpinA.eyes.find((value: any) => value.eye === eye)?.sha256,
      `A spoken rotation did not change ${eye}-eye pixels.`);
    // The transient turn is a presentation pose, not a molecular edit, exactly
    // as the pressed row above is.
    assert.deepEqual((await privateInspection(sessionId)).scene, beforeVoiceSpin.scene,
      'A spoken rotation changed the saved molecular scene.');
    const voiceStopCursor = await diagnosticsCursor(companion);
    assert.equal(await companion.evaluate(() => (globalThis as any).__stereofoldVoice.say('stop')),
      'toggle-motion', 'A bare "stop" over a turning structure must stop the turn, not the tour.');
    const voiceStopUtteranceId = await companion.evaluate(since => (globalThis as any).__stereofoldDiagnostics.entries()
      .findLast((entry: any) => entry.seq > since && entry.kind === 'voice-loop'
        && entry.detail?.stage === 'receipt-rendered' && entry.detail?.utteranceId)?.detail.utteranceId, voiceStopCursor);
    assert.equal(typeof voiceStopUtteranceId, 'string', 'The spoken stop must have its own rendered utterance receipt.');
    assert.notEqual(voiceStopUtteranceId, voiceSpinUtteranceId);

    // The voice hook acknowledges dispatch before its asynchronous pose save.
    // Settle that real save before using it as the next action's baseline.
    const beforeFit = await waitToolbarScene('Spoken stop', data => data.inspectionRevision > beforeVoiceSpin.inspectionRevision
      && JSON.stringify(data.scene.inspection.placement.rotation) !== JSON.stringify(beforeVoiceSpin.scene.inspection.placement.rotation));
    assert.equal(beforeFit.scene.sourceSha256, beforeVoiceSpin.scene.sourceSha256);
    assert.deepEqual(beforeFit.scene.camera, beforeVoiceSpin.scene.camera);
    assert.deepEqual(beforeFit.scene.selectionKeys, beforeVoiceSpin.scene.selectionKeys);
    assert.deepEqual(beforeFit.scene.inspection.appearance, beforeVoiceSpin.scene.inspection.appearance);
    // A voice receipt settles the pose before its asynchronous speech finishes.
    // Observe both actual playback starts and the public idle state, then let
    // the drawn Talk row settle before beginning an unrelated clearance fit.
    // Otherwise a delayed Reply row can correctly invalidate that fit's glass.
    const voiceUtteranceIds = [voiceSpinUtteranceId, voiceStopUtteranceId];
    await companion.waitForFunction(ids => {
      const entries = (globalThis as any).__stereofoldDiagnostics?.entries?.() ?? [];
      return ids.every(id => entries.some((entry: any) => entry.kind === 'voice-loop'
        && entry.detail?.stage === 'spoken-confirmation-started' && entry.detail?.utteranceId === id))
        && document.querySelector<HTMLElement>('.voice-panel')?.dataset.voiceState === 'idle';
    }, voiceUtteranceIds, { timeout: 60_000, polling: 100 });
    await waitToolbarQuiet(companion);
    assert.deepEqual((await privateInspection(sessionId)).scene, beforeFit.scene,
      'Finishing the spoken confirmations changed the saved stop pose or scientific scene.');
    report.emulatedXr.voice = { ...report.emulatedXr.voice, spokenRotation: true, spokenStopClaimsTheSpin: true,
      spokenStopSavedRevision: beforeFit.inspectionRevision,
      confirmationsSettledBeforeFit: { utteranceIds: voiceUtteranceIds, bothPlaybackStartsObserved: true, finalVoiceState: 'idle' } };
    passed('A spoken rotation turns the structure in both eyes without touching the saved scene, and a bare "stop" ends the turn and saves its fixed pose');

    const beforeFitPose = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1));
    await pressToolbar('Fit', { kind: 'fit' });
    // Immersive Fit seats the molecule in the room by translation and scale;
    // the tracked headset does not use the saved desktop camera for its view.
    const fitted = await waitToolbarScene('Fit', data => data.inspectionRevision > beforeFit.inspectionRevision
      && (JSON.stringify(data.scene.inspection.placement.translation) !== JSON.stringify(beforeFit.scene.inspection.placement.translation)
        || data.scene.inspection.placement.scale !== beforeFit.scene.inspection.placement.scale));
    assert.equal(fitted.scene.sourceSha256, beforeFit.scene.sourceSha256, 'Fit toolbar input changed source identity.');
    assert.deepEqual(fitted.scene.camera, beforeFit.scene.camera, 'Immersive Fit changed the saved desktop camera.');
    assert.deepEqual(fitted.scene.selectionKeys, beforeFit.scene.selectionKeys, 'Fit toolbar input changed selection.');
    assert.deepEqual(fitted.scene.inspection.placement.rotation, beforeFit.scene.inspection.placement.rotation, 'Fit toolbar input changed molecular rotation.');
    assert.deepEqual(fitted.scene.inspection.appearance, beforeFit.scene.inspection.appearance, 'Fit toolbar input changed appearance.');
    const fitPixels = await captureXrFramebuffer(companion, '07d-companion-xr-toolbar-fit');
    const afterFitPose = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1));
    assert.deepEqual(afterFitPose.views, beforeFitPose.views, 'Fit moved the tracked headset viewpoint.');
    assert.ok(fitPixels.eyes.every((eye: any) => eye.foreground > 100), 'Fit must retain rendered controls and scene pixels in both eyes.');
    report.emulatedXr.fit = { savedRevision: fitted.inspectionRevision, beforePlacement: beforeFit.scene.inspection.placement,
      afterPlacement: fitted.scene.inspection.placement, sourceCameraRotationSelectionAppearancePreserved: true,
      trackedViewpointPreserved: true, physicalHeadset: 'not_run' };
    passed('A real IWER Fit trigger saves a new room placement while preserving source, desktop camera, molecular rotation, appearance, selection, tracked viewpoint, and visible two-eye controls');

    const placementBeforeOffMolecule = structuredClone(fitted.scene.inspection.placement);
    // Ordinary agent placement deliberately refits against the held glass.
    // A named view is the supported exact scientific-scene restore contract.
    const safeViewName = 'Off-axis acceptance — fitted scene';
    const saveSafeViewCommandId = 'companion-xr-save-safe-view';
    const saveSafeViewState = await waitPanelReady(sessionId, 'companion', companionPanel);
    const saveSafeViewQueued = await call('manage_inspection_view', {
      ...binding(saveSafeViewState, sessionId), panelId: companionPanel, commandId: saveSafeViewCommandId,
      action: 'save', name: safeViewName,
    });
    assert.equal(saveSafeViewQueued.structuredContent.command.status, 'queued');
    const saveSafeViewReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', saveSafeViewCommandId);
    const safeViews = saveSafeViewReceipt.namedViews.entries.filter((view: any) => view.name === safeViewName);
    assert.equal(safeViews.length, 1, 'The rendered capture must publish exactly one named safe view.');
    const safeView = safeViews[0];
    assert.equal(safeView.sourceSha256, fitted.scene.sourceSha256);
    assert.equal(safeView.modelNumber, fitted.scene.modelNumber);
    assert.equal(safeView.assemblyId, fitted.scene.assemblyId);
    assert.equal(saveSafeViewReceipt.command.renderedRevision, fitted.inspectionRevision);
    assert.deepEqual((await privateInspection(sessionId)).scene, fitted.scene,
      'Capturing the named safe view changed the saved scientific scene.');
    const offMoleculeState = await waitPanelReady(sessionId, 'companion', companionPanel);
    const offMoleculeCommandId = 'companion-xr-off-molecule';
    const offMoleculeQueued = await call('update_inspection', {
      ...binding(offMoleculeState, sessionId), panelId: companionPanel, commandId: offMoleculeCommandId,
      change: { kind: 'placement', patch: { translation: [8, 0, 0] } },
    });
    assert.equal(offMoleculeQueued.structuredContent.command.status, 'queued');
    const offMoleculeReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', offMoleculeCommandId);
    await companion.waitForFunction(revision => document.querySelector('[data-session-outcome]')?.textContent?.includes(`revision ${revision}`),
      offMoleculeReceipt.command.renderedRevision);
    const agentFitted = await waitPrivate(sessionId, data => data.inspectionRevision === offMoleculeReceipt.inspectionRevision);
    // Agent placement is subject to the established held-menu fitting policy.
    // A rendered adjustment receipt attests the actual scene, not [8, 0, 0].
    assert.equal(offMoleculeReceipt.command.detail, 'Moved or resized the structure to clear the headset menu and reply plate.');
    assert.notDeepEqual(agentFitted.scene.inspection.placement.translation, [8, 0, 0]);
    assert.deepEqual(agentFitted.scene.inspection.placement.rotation, fitted.scene.inspection.placement.rotation);
    assert.ok(agentFitted.scene.inspection.placement.scale <= fitted.scene.inspection.placement.scale);
    assert.equal(agentFitted.scene.sourceSha256, fitted.scene.sourceSha256);
    assert.deepEqual(agentFitted.scene.camera, fitted.scene.camera);
    assert.deepEqual(agentFitted.scene.selectionKeys, fitted.scene.selectionKeys);
    assert.deepEqual(agentFitted.scene.inspection.appearance, fitted.scene.inspection.appearance);
    assert.deepEqual(await companion.evaluate(() => (globalThis as any).__stereofoldMenu.state().placement),
      agentFitted.scene.inspection.placement, 'Adjusted placement must agree between the saved scene and live XR renderer.');
    report.emulatedXr.agentPlacementAdjustment = { requestedTranslation: [8, 0, 0],
      receipt: offMoleculeReceipt.command, savedPlacement: agentFitted.scene.inspection.placement };
    passed('An off-axis agent placement receives a rendered menu-clearance adjustment with the exact saved and live pose and preserved scientific scene');

    // A wearer's unmodified thumbstick owns room placement, including outside
    // the current gaze. Drive that real IWER gamepad path until both eye
    // frusta contain no molecular vertices, keeping the menu in its room seat.
    let offMolecule = agentFitted;
    const slideSteps: any[] = [];
    let offGeometry = await companion.evaluate(() => (globalThis as any).__stereofoldMeasureMolecule());
    const outsideBothEyes = (geometry: any) => geometry.vertexCount > 0 && geometry.liveObjectCount > 0
      && geometry.sphereCount > 0 && geometry.eyes.length === 2
      && geometry.eyes.map((eye: any) => eye.eye).sort().join(',') === 'left,right'
      && geometry.eyes.every((eye: any) => eye.tangentSilhouette === null
        && eye.rightFrustumSeparation?.sphereCount === geometry.sphereCount
        && Number.isFinite(eye.rightFrustumSeparation.minimumRightPlaneMargin)
        && eye.rightFrustumSeparation.minimumRightPlaneMargin > 1e-6
        && Number.isFinite(eye.rightFrustumSeparation.nearestDepthMeters)
        && eye.rightFrustumSeparation.nearestDepthMeters > 1e-6);
    for (let attempt = 0; attempt < 10 && !outsideBothEyes(offGeometry); attempt++) {
      const beforeSlide = offMolecule;
      const input = await companion.evaluate(async () => {
        const test = (window as any).__companionXrTest, active = test.active;
        const controller = test.device.controllers.right;
        if (!active || active.ended) throw Error('No active XR session for off-axis thumbstick placement.');
        const nextFrame = () => new Promise<number>((resolveFrame, rejectFrame) => {
          const timer = setTimeout(() => rejectFrame(Error('Off-axis slide lost the native XR frame pump.')), 20_000);
          active.session.requestAnimationFrame((at: number) => { clearTimeout(timer); resolveFrame(at); });
        });
        controller.connected = true;
        controller.position.set(4, 1.6, 0); controller.quaternion.set(0, 0, 0, 1);
        controller.updateButtonValue('trigger', 0); controller.updateButtonValue('squeeze', 0);
        controller.updateAxes('thumbstick', 0, 0);
        await nextFrame(); await nextFrame();
        const cursor = (globalThis as any).__stereofoldDiagnostics.entries().at(-1)?.seq ?? 0;
        let axes: number[] = [], buttons: boolean[] = [], elapsedMs = 0, frames = 0;
        try {
          controller.updateAxes('thumbstick', 1, 0);
          const start = await nextFrame();
          const source = [...active.session.inputSources].find((source: any) => source.handedness === 'right');
          axes = Array.from(source?.gamepad?.axes ?? []);
          buttons = Array.from(source?.gamepad?.buttons ?? [], (button: any) => Boolean(button.pressed));
          while (elapsedMs < 1000) { elapsedMs = (await nextFrame()) - start; frames++; }
        } finally {
          controller.updateAxes('thumbstick', 0, 0);
          await nextFrame(); await nextFrame(); await nextFrame();
        }
        const source = [...active.session.inputSources].find((source: any) => source.handedness === 'right');
        return { axes, buttons, elapsedMs, frames, releasedAxes: Array.from(source?.gamepad?.axes ?? []),
          events: (globalThis as any).__stereofoldDiagnostics.entries().filter((entry: any) => entry.seq > cursor
            && entry.kind === 'xr-stick' && entry.detail.hand === 'right') };
      });
      assert.equal(input.axes[2], 1, 'The native right thumbstick must report its horizontal deflection.');
      assert.equal(input.axes[3], 0);
      assert.ok(input.buttons.every(pressed => !pressed), 'Off-axis slide must use the unmodified thumbstick.');
      assert.equal(input.releasedAxes[2], 0); assert.equal(input.releasedAxes[3], 0);
      for (const event of ['start', 'end']) assert.ok(input.events.some((entry: any) => entry.detail.event === event),
        `The native off-axis thumbstick slide did not traverse its ${event} lifecycle.`);
      offMolecule = await waitToolbarScene('Off-axis thumbstick slide', data => data.inspectionRevision > beforeSlide.inspectionRevision
        && data.scene.inspection.placement.translation[0] > beforeSlide.scene.inspection.placement.translation[0]);
      assert.equal(offMolecule.scene.sourceSha256, beforeSlide.scene.sourceSha256);
      assert.deepEqual(offMolecule.scene.camera, beforeSlide.scene.camera);
      assert.deepEqual(offMolecule.scene.selectionKeys, beforeSlide.scene.selectionKeys);
      assert.deepEqual(offMolecule.scene.inspection.appearance, beforeSlide.scene.inspection.appearance);
      assert.equal(offMolecule.scene.inspection.placement.scale, beforeSlide.scene.inspection.placement.scale);
      for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(offMolecule.scene.inspection.placement.rotation[axis]
        - beforeSlide.scene.inspection.placement.rotation[axis]) < 1e-8, 'A native translation changed molecular rotation.');
      assert.deepEqual(await companion.evaluate(() => (globalThis as any).__stereofoldMenu.state().placement),
        offMolecule.scene.inspection.placement, 'Native slide must agree between the saved scene and live XR renderer.');
      offGeometry = await companion.evaluate(() => (globalThis as any).__stereofoldMeasureMolecule());
      slideSteps.push({ input, savedRevision: offMolecule.inspectionRevision,
        placement: offMolecule.scene.inspection.placement, geometry: offGeometry });
    }
    assert.ok(slideSteps.length > 0 && outsideBothEyes(offGeometry),
      'Native thumbstick placement must put every primary/ligand instance sphere beyond both right frustum planes, with positive depth.');
    const offAxisPose = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1));
    assert.deepEqual(offAxisPose.views, afterFitPose.views, 'Native molecular slide moved the tracked headset viewpoint.');
    report.emulatedXr.offAxisThumbstick = { steps: slideSteps, outsideBothEyeFrusta: true,
      geometryScope: 'Full rendered primary and ligand instance spheres; excludes separate styled and comparison representations.',
      trackedViewpointPreserved: true, physicalHeadset: 'not_run' };
    const offExpandedPixels = await captureXrFramebuffer(companion, '07e-companion-xr-off-molecule-toolbar-expanded');

    await pressToolbar('Collapse off-molecule controls', { kind: 'collapse', value: true });
    await companion.waitForTimeout(300);
    const offCollapsedPixels = await captureXrFramebuffer(companion, '07f-companion-xr-off-molecule-toolbar-collapsed');
    for (const eye of ['left', 'right']) {
      assert.notEqual(offCollapsedPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        offExpandedPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        `The off-molecule toolbar did not visibly collapse in the ${eye} eye.`);
    }
    assert.deepEqual((await privateInspection(sessionId)).scene, offMolecule.scene,
      'Collapsing the off-molecule toolbar changed camera or molecular state.');
    await pressToolbar('Expand off-molecule controls', { kind: 'collapse', value: false });
    await companion.waitForTimeout(300);
    const offReexpandedPixels = await captureXrFramebuffer(companion, '07g-companion-xr-off-molecule-toolbar-reexpanded');
    for (const eye of ['left', 'right']) {
      assert.notEqual(offReexpandedPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        offCollapsedPixels.eyes.find((value: any) => value.eye === eye)?.sha256,
        `The off-molecule toolbar did not visibly re-expand in the ${eye} eye.`);
    }
    assert.deepEqual((await privateInspection(sessionId)).scene, offMolecule.scene,
      'Expanding the off-molecule toolbar changed camera or molecular state.');

    const restorePlacementState = await waitPanelReady(sessionId, 'companion', companionPanel);
    const restorePlacementCommandId = 'companion-xr-restore-placement';
    const restorePlacementQueued = await call('manage_inspection_view', {
      ...binding(restorePlacementState, sessionId), panelId: companionPanel, commandId: restorePlacementCommandId,
      action: 'restore', viewId: safeView.id,
    });
    assert.equal(restorePlacementQueued.structuredContent.command.status, 'queued');
    const restorePlacementReceipt = await waitState(sessionId, state => state.command?.status === 'rendered', restorePlacementCommandId);
    await companion.waitForFunction(revision => document.querySelector('[data-session-outcome]')?.textContent?.includes(`revision ${revision}`),
      restorePlacementReceipt.command.renderedRevision);
    const restoredPlacement = await waitPrivate(sessionId, data => data.inspectionRevision === restorePlacementReceipt.inspectionRevision);
    assert.deepEqual(restoredPlacement.scene.inspection.placement, placementBeforeOffMolecule);
    assert.deepEqual(restoredPlacement.scene, fitted.scene,
      'Named-view restore must recover the exact saved scientific scene, including camera and selection.');
    assert.deepEqual(await companion.evaluate(() => (globalThis as any).__stereofoldMenu.state().placement),
      restoredPlacement.scene.inspection.placement, 'Named-view restore must agree between the saved scene and live XR renderer.');
    const restoredSafeViewPose = await companion.evaluate(() => (window as any).__companionXrTest.active.poses.at(-1));
    assert.deepEqual(restoredSafeViewPose.views, afterFitPose.views, 'Named-view restore moved the tracked headset viewpoint.');
    report.emulatedXr.offAxisNamedViewRestore = { viewId: safeView.id, saveReceipt: saveSafeViewReceipt.command,
      restoreReceipt: restorePlacementReceipt.command, savedPlacement: restoredPlacement.scene.inspection.placement,
      exactScientificSceneRestored: true, savedAndLivePlacementAgree: true, trackedViewpointPreserved: true };
    await disconnectXrController(companion);
    passed('The XR-local toolbar remains visible and interactive after native thumbstick input moves the molecule outside both eye frusta; collapse and expand preserve the saved scene, and a rendered named-view restore recovers the exact prior scientific scene and placement without moving the tracked viewpoint');

    // XR entry may deliberately freeze a transient object pose. This is the
    // post-entry, post-command baseline whose preservation head motion proves.
    const beforeHeadSaved = await privateInspection(sessionId);
    const sceneBeforeHead = structuredClone(beforeHeadSaved.scene);
    const expectedHeadRevision = beforeHeadSaved.inspectionRevision;
    const freshHeadPanel = (panel: any) => panel.panelId === companionPanel && panel.current === true
      && panel.availability === 'ready' && panel.inspectionRevision === expectedHeadRevision
      && panel.spatialContext?.mode === enteredMode && panel.spatialContext.stale === false
      && Number.isFinite(panel.spatialContext.ageMs) && panel.spatialContext.ageMs <= 500;
    const contextBeforeState = await waitState(sessionId, state => state.inspectionRevision === expectedHeadRevision
      && state.panels.some(freshHeadPanel));
    const contextBefore = contextBeforeState.panels.find((panel: any) => panel.panelId === companionPanel).spatialContext;
    assert.equal(contextBefore.reference, 'molecule-center'); assert.equal(contextBefore.axes, 'molecule-local');
    assert.equal(contextBefore.units, 'molecular-radius');
    const pixelsBeforeHead = await captureXrFramebuffer(companion, '07-companion-xr-before-head');
    await companion.evaluate(() => {
      const device = (window as any).__companionXrTest.device;
      device.position.set(device.position.x + .08, device.position.y + .02, device.position.z - .06);
    });
    await companion.waitForFunction(before => {
      const active = (window as any).__companionXrTest?.active, latest = active?.poses?.at(-1);
      return Boolean(latest && JSON.stringify(latest.views) !== JSON.stringify(before.views));
    }, entered.pose);
    const moved = await companion.evaluate(() => {
      const test = (window as any).__companionXrTest, active = test.active;
      return { head: { x: test.device.position.x, y: test.device.position.y, z: test.device.position.z }, pose: active.poses.at(-1), rafCount: active.rafCount };
    });
    assert.notDeepEqual(moved.head, entered.head); assert.deepEqual(moved.pose.views.map((view: any) => view.eye).sort(), ['left', 'right']);
    const pixelsAfterHead = await captureXrFramebuffer(companion, '08-companion-xr-after-head');
    assert.notEqual(pixelsAfterHead.sha256, pixelsBeforeHead.sha256, 'Head pose must change actual immersive canvas pixels.');
    assert.deepEqual((await privateInspection(sessionId)).scene, sceneBeforeHead, 'Head motion must not mutate the latest saved immersive scene.');
    const contextAfterState = await waitState(sessionId, state => state.inspectionRevision === expectedHeadRevision
      && state.panels.some((panel: any) => freshHeadPanel(panel)
        && JSON.stringify(panel.spatialContext.headPosition) !== JSON.stringify(contextBefore.headPosition)));
    const contextAfter = contextAfterState.panels.find((panel: any) => panel.panelId === companionPanel).spatialContext;
    assert.deepEqual((await privateInspection(sessionId)).scene, sceneBeforeHead);
    report.spatialAwareness = { before: contextBefore, after: contextAfter,
      expectedInspectionRevision: expectedHeadRevision, savedScenePreserved: true };
    await openXrOptions(companion);
    await companion.locator('[data-leave-xr]').click();
    await companion.waitForFunction(() => !(window as any).__companionXrTest?.active);
    const stoppedAt = await companion.evaluate(() => (window as any).__companionXrTest.sessions.at(-1).rafCount);
    await companion.waitForTimeout(250);
    assert.equal(await companion.evaluate(() => (window as any).__companionXrTest.sessions.at(-1).rafCount), stoppedAt, 'The wrapped XR rAF loop must stop after end.');
    await waitState(sessionId, state => state.panels.some((panel: any) => panel.panelId === companionPanel && panel.spatialContext === null));
    passed('The public agent state tracks fresh molecule-relative head position during XR, clears it after exit, and never writes it to the saved scene');
    report.emulatedXr = { ...report.emulatedXr, mode: entered.mode, headMoved: { from: entered.head, to: moved.head }, eyes: moved.pose.views.map((view: any) => view.eye), renderedCommandRevision: immersiveReceipt.inspectionRevision, savedScenePreserved: true };
    passed('Test-only IWER VR observes the production session, renders a public command while immersive, and changes both-eye poses/pixels under head motion without changing the saved scene');

    await companion.locator('[data-enter-xr="immersive-ar"]').click();
    await waitImmersive('immersive-ar');
    await companion.evaluate(() => (window as any).__companionXrTest.active.session.end());
    await companion.waitForFunction(() => !(window as any).__companionXrTest?.active);
    await openXrOptions(companion);
    await companion.locator('[data-enter-xr="immersive-vr"]').click();
    await waitImmersive('immersive-vr');
    await companion.locator('[data-companion-open]').dispatchEvent('click');
    await companion.waitForFunction(() => !(window as any).__companionXrTest?.active);
    assert.equal(await companion.locator('.xr-controls small[data-state="error"]').count(), 0);
    passed('Production lifecycle exits VR, enters AR, handles an external session end, re-enters VR, and returns to desktop');
    } else {
      // The focused tour run intentionally keeps the 2D inspector hidden;
      // end the active session through the same WebXR lifecycle used above
      // instead of relying on the hidden desktop leave control.
      await companion.evaluate(() => (window as any).__companionXrTest?.active?.session.end());
      await companion.waitForFunction(() => !(window as any).__companionXrTest?.active);
      await waitState(sessionId, state => state.panels.some((panel: any) => panel.panelId === companionPanel && panel.spatialContext === null));
    }
    await companion.setViewportSize({ width: 600, height: 800 });
    await companion.waitForFunction(() => innerWidth === 600 && innerHeight === 800);
    await companion.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  }

  // Emphasis has to be persistent, not just commandable.
  //
  // The saved-scene field, the tool and the repaint-after-rebuild all shipped
  // without ever running a browser. This is the proof they could not run: the
  // agent lights a named part, the page is reloaded — the
  // hardest restore there is, a brand new panel hydrating the saved scene from
  // scratch — and the part must come back lit in its own colour with the rest
  // of the complex still faded behind it. The reload just below is the same
  // one the stale-panel case needs, so this costs one emphasize and two
  // captures.
  const persistParts = (await call('get_inspection_state', { sessionId })).structuredContent.lesson?.parts ?? [];
  const persisted = persistParts.length ? await (async () => {
    // The guide RNA is the part wearers name most often.
    const part = persistParts.find((candidate: any) => /rna/iu.test(candidate.label ?? candidate.id)) ?? persistParts[0];
    const ready = await waitPanelReady(sessionId, 'companion', companionPanel);
    await call('emphasize', { ...binding(ready, sessionId), panelId: companionPanel,
      commandId: 'acceptance-emphasis-persist', parts: [part.label ?? part.id] });
    await waitState(sessionId, state => state.command?.commandId === 'acceptance-emphasis-persist'
      && state.command?.status === 'rendered', 'acceptance-emphasis-persist', XR_REBUILD_TIMEOUT_MS);
    const state = (await call('get_inspection_state', { sessionId })).structuredContent;
    assert.deepEqual(state.view.emphasis?.focus, [part.id],
      `The agent's emphasize did not leave ${part.id} focused: ${JSON.stringify(state.view.emphasis)}`);
    const colour = (state.view.emphasis.parts as any[]).find(candidate => candidate.id === part.id)?.color;
    assert.match(String(colour), /^#[0-9a-f]{6}$/iu, 'A focused lesson part must carry its own colour.');
    // The saved scene is what a reload reads, so it is the thing that has to
    // carry the key — not just the live tool answer.
    const saved = (await privateInspection(sessionId)).scene;
    assert.deepEqual(saved.inspection.emphasis?.focus, [part.id],
      'The saved scene did not keep the emphasis the agent asked for.');
    const before = await captureCanvas(companion, companion, '10-emphasis-before-reload', colour);
    assert.ok((before as any).litPixels > 100,
      `The emphasised part must be drawn in its own colour, got ${(before as any).litPixels} pixels near ${colour}.`);
    return { part, colour, before, contextOpacity: state.view.emphasis.contextOpacity as number };
  })() : undefined;

  const oldPanelId = companionPanel;
  await companion.reload();
  await companion.waitForFunction(()=>Boolean(document.body.dataset.panelId));
  await companion.locator('body[data-ready="true"]').waitFor();
  const reloadedPanelId = await companion.locator('body').getAttribute('data-panel-id'); assert.ok(reloadedPanelId && reloadedPanelId !== oldPanelId);
  await waitState(sessionId, state => state.panels.some((panel: any) => panel.panelId === reloadedPanelId && panel.surface === 'companion' && panel.current));
  await waitState(sessionId, state => !state.panels.some((panel: any) => panel.panelId === oldPanelId), undefined, 10_000);
  const stale = await callRaw('update_inspection', {
    ...binding((await call('get_inspection_state', { sessionId })).structuredContent, sessionId), panelId: oldPanelId, commandId: 'stale-companion-panel',
    change: { kind: 'appearance', patch: { background: '#111111' } },
  });
  assert.equal(stale.isError, true, 'A retired companion panel ID must fail closed.');
  passed('Reloading the same private URL creates one new companion panel, retires the stale capability, and rejects a stale targeted command');

  if (persisted) {
    // The far end of the reload: a new panel, a fresh viewer, the saved scene
    // read back from the host. Nothing carried over in memory.
    const restored = (await call('get_inspection_state', { sessionId })).structuredContent;
    assert.deepEqual(restored.view.emphasis?.focus, [persisted.part.id],
      `The reload dropped the emphasis: ${JSON.stringify(restored.view.emphasis)}`);
    assert.equal(restored.lesson?.parts?.length, persistParts.length,
      'The reload dropped the lesson colour key the agent reads part names from.');
    assert.equal(restored.view.emphasis.contextOpacity, persisted.contextOpacity,
      'The reload changed how faint the rest of the complex is drawn.');
    // A restored emphasis that never reaches the renderer is the failure this
    // exists to catch, so the picture is checked, not just the wire.
    const after = await captureCanvas(companion, companion, '11-emphasis-after-reload', persisted.colour);
    assert.ok((after as any).litPixels > (persisted.before as any).litPixels * 0.5,
      `The named part came back unlit after the reload: ${(after as any).litPixels} pixels near ${persisted.colour}, was ${(persisted.before as any).litPixels}.`);
    report.emphasisPersistence = { part: persisted.part.id, colour: persisted.colour,
      focus: restored.view.emphasis.focus, lessonParts: restored.lesson.parts.length,
      contextOpacity: restored.view.emphasis.contextOpacity,
      litPixels: { before: (persisted.before as any).litPixels, after: (after as any).litPixels } };
    passed('An agent-commanded emphasis on a named lesson part survives a companion reload, in the saved scene and on the molecule');
  } else {
    report.emphasisPersistence = 'NOT RUN — this session has no lesson colour key.';
  }

  if (focusedTourIwer) {
    await companion.close();
    await waitState(sessionId, state => !state.panels.some((panel: any) => panel.surface === 'companion')
      && state.panels.some((panel: any) => panel.surface === 'desktop' && panel.current));
    passed('Closing the focused companion tab detaches its panel and returns the shared session to the current desktop');
  } else {
    // `inspector.ts:653` files Return to desktop in `.header-actions`, which
    // `inspector.css:62` hides on a companion, so it is reached by event.
    await companion.locator('[data-companion-open]').dispatchEvent('click');
    await companion.waitForFunction(() => document.querySelector('[data-session-outcome]')?.textContent?.startsWith('Saved to your desktop'));
    const returned = await privateInspection(sessionId);
    await waitState(sessionId, state => state.panels.some((panel: any) => panel.surface === 'desktop' && panel.current)
      && state.inspectionRevision === returned.inspectionRevision);
    passed('Open companion and Return to desktop controls use the shared session, preserving its saved revision');

    await companion.emulateMedia({ colorScheme: 'dark' }); await companion.locator('html[data-theme="dark"]').waitFor(); await contrast(companion, 5);
    await companion.emulateMedia({ colorScheme: 'light' }); await companion.locator('html[data-theme="light"]').waitFor(); await contrast(companion, 5);
    await companion.setViewportSize({ width: 390, height: 760 }); await companion.locator('.stage canvas').waitFor({ state: 'visible' });
    await companion.waitForFunction(() => document.documentElement.clientWidth === 390
      && document.documentElement.scrollWidth <= document.documentElement.clientWidth
      && document.body.scrollWidth <= document.body.clientWidth
      && document.querySelector('.stage canvas')!.getBoundingClientRect().right <= innerWidth);
    const narrowLayout = await companion.evaluate(() => ({ innerWidth, devicePixelRatio,
      document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
      body: { clientWidth: document.body.clientWidth, scrollWidth: document.body.scrollWidth },
      canvas: (() => { const rect = document.querySelector('.stage canvas')!.getBoundingClientRect();
        return { left: rect.left, right: rect.right, cssWidth: rect.width, backingWidth: (document.querySelector('.stage canvas') as HTMLCanvasElement).width }; })(),
    }));
    assert.equal(narrowLayout.innerWidth, 390);
    assert.ok(narrowLayout.document.scrollWidth <= narrowLayout.document.clientWidth);
    assert.ok(narrowLayout.body.scrollWidth <= narrowLayout.body.clientWidth);
    assert.ok(narrowLayout.canvas.left >= 0 && narrowLayout.canvas.right <= 390 && narrowLayout.canvas.cssWidth <= 390);
    const narrowPixels = await captureCanvas(companion, companion, '09-companion-narrow-light');
    assert.ok(narrowPixels.width <= 390, 'The narrow rendered canvas must fit the 390 px viewport.');
    report.narrowLayout = narrowLayout;
    passed('Companion light, dark, and 390 px layouts retain visible controls and readable enabled labels');
  }

  await assertRuntimeUnchanged();
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  assertEvidenceClean(); report.status = 'passed';
} catch (error) {
  // `--tour full` is a complete run of its own: it stops this file on purpose
  // once the last chapter is verified, so that stop is a pass, not a failure.
  const completed = (error as any)?.stereofoldRunComplete === true;
  report.failureViews = [];
  for (const context of completed ? [] : browser?.contexts() ?? []) for (const page of context.pages()) for (const frame of page.frames()) {
    try {
      report.failureViews.push(await frame.evaluate(() => ({
        ready: document.body?.dataset.ready,
        notice: document.querySelector('.session-notice')?.textContent,
        status: document.querySelector('#status')?.textContent,
        outcome: document.querySelector('[data-session-outcome]')?.textContent,
        sequence: { search: document.querySelector<HTMLInputElement>('[data-control="search"]')?.value,
          chain: document.querySelector<HTMLSelectElement>('[data-control="chain"]')?.value,
          mountedRows: document.querySelectorAll('.sequence button').length,
          selectedKeys: [...document.querySelectorAll<HTMLElement>('.sequence button[aria-pressed="true"]')].map(button => button.dataset.key).slice(0, 20),
          summary: document.querySelector('.selection-count')?.textContent },
        displayedPlacement: { scale: document.querySelector<HTMLInputElement>('[data-control="scale"]')?.value,
          translation: ['x', 'y', 'z'].map(axis => document.querySelector<HTMLInputElement>(`[data-vector="translation"][data-axis="${axis}"]`)?.value),
          rotation: ['x', 'y', 'z'].map(axis => document.querySelector<HTMLInputElement>(`[data-vector="rotation"][data-axis="${axis}"]`)?.value) },
        xrNote: document.querySelector('.xr-controls small')?.textContent,
        xrSessions: (window as any).__companionXrTest?.sessions.map((session: any) => ({
          mode: session.mode, ended: session.ended, frames: session.rafCount, poses: session.poses.length,
        })),
      })));
    } catch { /* A detached frame cannot supply diagnostic text. */ }
    // The headset diagnostics ring is the only record of what the toolbar, the
    // the voice path did. A failed assertion is unreadable without it.
    try {
      const ring = await frame.evaluate(() => (window as any).__stereofoldDiagnostics?.entries?.() ?? []);
      if (ring.length) (report.failureDiagnostics ??= []).push(ring);
    } catch { /* A detached frame carries no ring. */ }
  }
  report.stderr = stderr;
  if (completed) { report.status = 'passed'; report.stoppedAfter = (error as Error).message; }
  else { report.failure = (error as Error).stack; throw error; }
} finally {
  // The diagnostics ring is dumped only when an assertion fails, so a passing
  // run leaves no record of what the toolbar, the head-rotation hold or the
  // reset actually did. A hardware-risk audit needs that on the success path
  // too, and reading it costs one evaluate per frame at the end of the run.
  await disposeStep('diagnosticsCaptured', async () => {
    for (const context of browser?.contexts() ?? []) for (const page of context.pages()) for (const frame of page.frames()) {
      const ring = await frame.evaluate(() => (window as any).__stereofoldDiagnostics?.entries?.() ?? []).catch(() => []);
      if (ring.length) (report.diagnostics ??= []).push(ring);
      const longTasks = await frame.evaluate(() => (window as any).__companionXrTest?.longTasks ?? []).catch(() => []);
      if (longTasks.length) (report.longTasks ??= []).push(...longTasks);
    }
  });
  await disposeStep('browserClosed', () => browser?.close() ?? Promise.resolve());
  await disposeStep('mcpClosed', () => client.close());
  await disposeStep('listenerClosed', () => new Promise<void>(resolveClose => host ? host.close(() => resolveClose()) : resolveClose()));
  await disposeStep('reportWritten', () => writeFile(resolve(out, 'browser-report.json'), JSON.stringify(report, null, 2) + '\n'));
  console.log(JSON.stringify(report, null, 2));
}

// Each disposal step is isolated: a throwing browser.close() must not skip the
// MCP child process, the loopback listener, or the report that explains the
// failure this cleanup exists for.
async function disposeStep(step: string, work: () => Promise<unknown>) {
  try { await work(); report.cleanup[step] = true; }
  catch (cleanupError) { report.cleanup[step] = false; (report.cleanupErrors ??= []).push(`${step}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
}
