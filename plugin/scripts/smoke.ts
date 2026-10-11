import { readInlineHtml } from '../src/inline-html.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFallbackRetry, type FallbackStep } from '../src/fallback-retry.js';
import { decideStructureFallback, type CachedStructure } from '../src/structure-fallback.js';
import { PRIVATE_STRUCTURE_META_KEY } from '../src/structure-result.js';
import { APP_ONLY_TOOL_NAMES, REGISTERED_TOOL_NAMES } from './tool-inventory.js';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
// Optional --dist lets the same acceptance run verify a scratch runtime.
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--dist' && isAbsolute(args[1]!)),
  'Usage: smoke.ts [--dist /absolute/runtime/directory]');
const distRoot = args[1] ?? fileURLToPath(new URL('../dist', import.meta.url));
const serverPath = resolve(distRoot, 'server.mjs');
const privateState = await mkdtemp(join(tmpdir(), 'stereofold-smoke-'));

const client = new Client({ name: 'Stereofold smoke', version: '0.1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: pluginRoot, stderr: 'pipe',
  env: { ...getDefaultEnvironment(), STEREOFOLD_SCENE_SERVICE: join(privateState, 'scene-service.json') } });

try {
  await client.connect(transport);
  const listedTools = await client.listTools();
  const names = listedTools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, REGISTERED_TOOL_NAMES);
  // These app-only tools exist for the viewer and name no UI resource, so no
  // host can mount a panel from them. Their app scope is access control; the
  // private result-metadata boundary protects cached coordinates. Navigation
  // and source replacement are intentionally model-visible no-resource
  // controls, while sync_view depends on no resource URI because it is called
  // while the Depth slider is being dragged.
  for (const name of APP_ONLY_TOOL_NAMES) {
    const appTool = listedTools.tools.find((tool) => tool.name === name);
    const appUi = appTool?._meta?.ui as { visibility?: unknown; resourceUri?: unknown } | undefined;
    assert.deepEqual(appUi?.visibility, ['app'], `${name} must be app-scoped`);
    assert.equal(appUi?.resourceUri, undefined, `${name} must name no UI resource`);
    assert.equal(appTool?._meta?.['ui/resourceUri'], undefined, `${name} must set no legacy UI resource key`);
  }
  for(const name of ['stereo_structure.get_inspection_state','stereo_structure.update_inspection',
    'stereo_structure.undo_last_change','stereo_structure.redo_last_change']) {
    const tool=listedTools.tools.find(tool=>tool.name===name)!;
    assert.equal((tool._meta?.ui as any)?.visibility,undefined,`${name} must be model-visible`);
    assert.equal((tool._meta?.ui as any)?.resourceUri,undefined,`${name} must not mount a new panel`);
    assert.equal(tool.annotations?.openWorldHint,false);
  }

  const viewerResourceTools = listedTools.tools
    .filter((tool) => {
      const ui = tool._meta?.ui as { resourceUri?: unknown } | undefined;
      return ui?.resourceUri != null || tool._meta?.['ui/resourceUri'] != null;
    })
    .map((tool) => tool.name);
  assert.deepEqual(viewerResourceTools, ['stereo_structure.open', 'stereo_structure.inspect_file', 'stereo_structure.inspect_scene', 'stereo_structure.inspect_lesson', 'stereo_structure.inspect', 'stereo_structure.inspect_experience'], 'only dedicated render tools may name a viewer resource');

  // A source-bearing open starts an explicit opaque session. The server does
  // not infer a conversation from stdio transport state, and every later tool
  // call must carry this returned capability.
  const seedStructureText = 'ATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N\nEND\n';
  const opened = await client.callTool({
    name: 'stereo_structure.open',
    arguments: { structureText: seedStructureText, format: 'pdb' },
  });
  assert.equal(opened.isError, undefined, 'source open must create a session');
  const sessionId = (opened.structuredContent as { sessionId?: unknown } | undefined)?.sessionId;
  assert.equal(typeof sessionId, 'string', 'open must return a server-issued sessionId');
  if (typeof sessionId !== 'string') throw new Error('open did not return a usable sessionId');
  const serverEpoch = (opened.structuredContent as { serverEpoch?: unknown } | undefined)?.serverEpoch;
  assert.equal(typeof serverEpoch, 'string', 'open must return a server lifecycle epoch');
  if (typeof serverEpoch !== 'string') throw new Error('open did not return a usable serverEpoch');
  const renderToken = (opened.structuredContent as { renderToken?: unknown } | undefined)?.renderToken;
  assert.equal(typeof renderToken, 'number', 'open must return a server-issued render ordering token');
  if (typeof renderToken !== 'number' || !Number.isSafeInteger(renderToken) || renderToken <= 0) {
    throw new Error('open render ordering token must be a positive safe integer');
  }
  const sessionArguments = (arguments_: Record<string, unknown>): Record<string, unknown> => ({ sessionId, ...arguments_ });
  const assertModelResultPrivate = (toolResult: unknown, label: string): void => {
    const result = toolResult as { content?: unknown; structuredContent?: unknown };
    assert.ok(!JSON.stringify(result.content).includes(seedStructureText), `${label} content must not contain coordinates`);
    assert.ok(!JSON.stringify(result.structuredContent).includes(seedStructureText), `${label} structuredContent must not contain coordinates`);
    assert.equal((result.structuredContent as { structureText?: unknown } | undefined)?.structureText, undefined, `${label} must not expose structureText`);
  };
  const privateStructure = <T extends object>(toolResult: unknown, label: string): T => {
    const metadata = (toolResult as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const payload = metadata?.[PRIVATE_STRUCTURE_META_KEY];
    assert.equal(typeof payload, 'object', `${label} must preserve private structure metadata`);
    assert.ok(payload != null && !Array.isArray(payload), `${label} private structure metadata must be an object`);
    return payload as T;
  };
  assertModelResultPrivate(opened, 'open');

  // The look round-trips: sync_view writes it, get_state reports it back, and
  // get_structure hands it to a freshly mounted panel.
  const synced = await client.callTool({
    name: 'stereo_structure.sync_view',
    arguments: sessionArguments({ mode: 'cross', depthBudgetArcmin: 33, swapEyes: true, variant: 'dubois', color: 'secondary-structure', style: 'molecular-surface' }),
  });
  assert.deepEqual(synced.structuredContent, {
    kind: 'view',
    sessionId,
    hasStructure: true,
    // The open above pasted coordinates, so every later state result names
    // that provenance. sourceKind is public state, not an accident: a model
    // that never saw the paste still has to be able to tell a pasted scene
    // from a fetched PDB entry before it offers to reload or replace it.
    sourceKind: 'pasted',
    mode: 'cross',
    depthBudgetArcmin: 33,
    swapEyes: true,
    variant: 'dubois',
    color: 'secondary-structure',
    style: 'molecular-surface',
    motion: { mode: 'rock' },
    stateRevision: 1,
    serverEpoch,
  });
  assertModelResultPrivate(synced, 'sync_view');
  const afterSync = await client.callTool({ name: 'stereo_structure.get_state', arguments: sessionArguments({}) });
  assertModelResultPrivate(afterSync, 'get_state');
  const syncedState = afterSync.structuredContent as { color?: string; style?: string; depthBudgetArcmin?: number };
  assert.equal(syncedState.color, 'secondary-structure');
  assert.equal(syncedState.style, 'molecular-surface');
  assert.equal(syncedState.depthBudgetArcmin, 33);
  const freshPanel = await client.callTool({ name: 'stereo_structure.get_structure', arguments: sessionArguments({}) });
  assertModelResultPrivate(freshPanel, 'get_structure');
  assert.deepEqual(freshPanel.structuredContent, {
    kind: 'structure',
    sessionId,
    empty: false,
    stateRevision: 1,
    serverEpoch,
  });
  const freshLook = privateStructure<CachedStructure>(freshPanel, 'get_structure');
  assert.equal(freshLook.structureText, seedStructureText, 'coordinates must be present only in private metadata');
  assert.equal(freshLook.serverEpoch, serverEpoch, 'private structure state must use the public server epoch');
  assert.equal(freshLook.color, 'secondary-structure');
  assert.equal(freshLook.style, 'molecular-surface');
  // The stereo state travels with the structure, and a fresh panel applies it
  // before it loads. Without these four the panel loads in its own default
  // mono, fits the camera for the whole stage, and then renders that framing
  // into one capped eye. On Codex's side panel that is 3.7x too close.
  assert.equal(freshLook.mode, 'cross', 'get_structure must carry the stereo mode in force');
  assert.equal(freshLook.depthBudgetArcmin, 33, 'get_structure must carry the depth budget in force');
  assert.equal(freshLook.swapEyes, true, 'get_structure must carry the eye swap in force');
  assert.equal(freshLook.variant, 'dubois', 'get_structure must carry the anaglyph variant in force');
  // The model-facing route to the same state.
  const setLook = await client.callTool({ name: 'stereo_structure.control', arguments: sessionArguments({ action: 'set_look', color: 'element-symbol' }) });
  assertModelResultPrivate(setLook, 'control');
  const afterSetLook = await client.callTool({ name: 'stereo_structure.get_state', arguments: sessionArguments({}) });
  assertModelResultPrivate(afterSetLook, 'get_state after control');
  const setLookState = afterSetLook.structuredContent as { color?: string; style?: string };
  assert.equal(setLookState.color, 'element-symbol');
  assert.equal(setLookState.style, 'molecular-surface', 'set_look must merge, not replace');
  /*
   * Fit diagnostics: absent and valid before a panel reports, verbatim after.
   *
   * This is the only channel out of a live Codex webview. Two fixes have now
   * been shipped against screenshots of a real side panel and neither changed
   * what the panel showed, so the next live check reads numbers instead of a picture:
   * `structuredContent.diagnostics.camera.fill` is 0.86 when the camera is
   * framed for the window it renders into, whatever the host.
   */
  const beforeReport = await client.callTool({ name: 'stereo_structure.get_state', arguments: sessionArguments({}) });
  assert.equal(
    (beforeReport.structuredContent as { diagnostics?: unknown }).diagnostics,
    undefined,
    'get_state must omit diagnostics until a viewer panel has reported',
  );

  const sampleDiagnostics = {
    at: '2026-09-02T10:00:00.000Z',
    viewerBuild: 'smoke',
    sequence: 1,
    trigger: 'button',
    host: {
      displayMode: 'fullscreen',
      containerDimensions: { maxHeight: 878, width: 1026 },
      hostViewportWidthPx: 1026,
      hostViewportHeightPx: 878,
      hostContextAt: '2026-09-02T09:59:59.000Z',
      hostContextCount: 2,
      innerWidthPx: 1026,
      innerHeightPx: 878,
      devicePixelRatio: 2,
      visualViewportScale: 1,
      visibilityState: 'visible',
    },
    geometry: {
      stageRectCssPx: { x: 8, y: 71, width: 476, height: 799 },
      letterboxRectCssPx: { x: 8, y: 71, width: 1010, height: 799 },
      eyeViewportCssPx: { width: 238, height: 799 },
      eyeCapApplied: true,
      halfCapPx: 238,
      canvasCssPx: { width: 476, height: 799 },
      canvasBackingPx: { width: 952, height: 1598 },
      cameraViewport: { x: 0, y: 0, width: 952, height: 1598 },
      stereoEyeViewports: {
        left: { x: 0, y: 0, width: 476, height: 1598 },
        right: { x: 476, y: 0, width: 476, height: 1598 },
        parent: { x: 0, y: 0, width: 952, height: 1598 },
        ageMs: 16,
      },
    },
    camera: {
      distanceToTargetAng: 52.99,
      radiusAng: 17.782,
      fovRad: 0.7853981633974483,
      visibleSphereRadiusAng: 17.782,
      boundingSphereVisibleRadiusAng: 17.782,
      inTransition: false,
      projectedSphereDiameterPx: 204.68,
      fill: 0.86,
    },
    fit: {
      fittedGeometry: { eyeWidthPx: 238, eyeHeightPx: 799, radius: 17.782 },
      fitSuspended: false,
      fixturePinned: false,
      loadInFlight: false,
      lastDecision: {
        at: '2026-09-02T10:00:00.000Z',
        decision: 'keep',
        current: { eyeWidthPx: 238, eyeHeightPx: 799, radius: 17.782 },
        fitted: { eyeWidthPx: 238, eyeHeightPx: 799, radius: 17.782 },
        suspended: false,
        pinned: false,
        inTransition: false,
      },
      events: [{
        at: '2026-09-02T09:59:58.000Z',
        trigger: 'load',
        eyeWidthPx: 238,
        eyeHeightPx: 799,
        radius: 17.782,
        distance: 52.99,
        fill: 0.86,
      }],
    },
    state: {
      mode: 'parallel',
      depthBudgetArcmin: 20,
      swapEyes: false,
      variant: 'balanced',
      color: 'chain-id',
      style: 'polymer-and-ligand',
      motionMode: 'rock',
      motionRunning: true,
      motionBaselineDistanceAng: 52.99,
      structureLoaded: true,
      pdbId: '1CRN',
      messageCounts: { open: 1, state: 0, mode: 0 },
      structureSource: 'open',
    },
    user: { wheelEventsSinceFit: 0, wheelEventsTotal: 0 },
  };

  const reported = await client.callTool({
    name: 'stereo_structure.report_diagnostics',
    arguments: sessionArguments({ diagnostics: sampleDiagnostics }),
  });
  // A report is a read, not a write: it must not move the session's view state.
  assert.equal((reported.structuredContent as { kind?: unknown; sessionId?: unknown } | undefined)?.kind, 'diagnostics');
  assert.equal((reported.structuredContent as { sessionId?: unknown } | undefined)?.sessionId, sessionId);
  const afterReport = await client.callTool({ name: 'stereo_structure.get_state', arguments: sessionArguments({}) });
  const reportedState = afterReport.structuredContent as { diagnostics?: unknown; mode?: string; color?: string };
  assert.deepEqual(reportedState.diagnostics, sampleDiagnostics, 'get_state must return the reported diagnostics verbatim');
  assert.equal(reportedState.mode, 'cross', 'report_diagnostics must not change the stereo mode');
  assert.equal(reportedState.color, 'element-symbol', 'report_diagnostics must not change the look');
  // Strict all the way down, including inside a nested object: a field the
  // server does not know about is a rejected report, not a silently truncated
  // one. The SDK answers a schema failure with an error result rather than a
  // protocol rejection, so the check is on the result.
  const rejectedNested = await client.callTool({
    name: 'stereo_structure.report_diagnostics',
    arguments: sessionArguments({ diagnostics: { ...sampleDiagnostics, camera: { ...sampleDiagnostics.camera, unexpected: 1 } } }),
  });
  assert.equal(rejectedNested.isError, true, 'report_diagnostics must reject an unknown nested field');
  assert.match(JSON.stringify(rejectedNested.content), /unrecognized_keys/u);
  const stillVerbatim = await client.callTool({ name: 'stereo_structure.get_state', arguments: sessionArguments({}) });
  assert.deepEqual(
    (stillVerbatim.structuredContent as { diagnostics?: unknown }).diagnostics,
    sampleDiagnostics,
    'a rejected report must not replace the last good one',
  );

  /*
   * Which panel answered.
   *
   * Codex mounts an app instance per tool card and every one of them keeps
   * reporting, so the server keeps reports per panel and chooses one. The
   * choice is the live, settled panel that spoke last — not the one with the
   * newest fit, which is what the first version of this rule asked for and
   * which handed a hidden card the answer whenever the panel on screen was
   * still inside its `get_structure` fallback with an empty fit ring.
   *
   * The two panels below are exactly that pair, and both report inside the
   * presence window so the window itself is exercised rather than bypassed.
   */
  const panelClock = Date.now();
  const panelAt = (offsetMs: number) => new Date(panelClock + offsetMs).toISOString();
  const panelReport = (panelId: string, atOffsetMs: number, sequence: number, fitOffsetMs?: number) => ({
    ...sampleDiagnostics,
    panelId,
    sequence,
    at: panelAt(atOffsetMs),
    fit: {
      ...sampleDiagnostics.fit,
      events: fitOffsetMs === undefined
        ? []
        : [{ ...sampleDiagnostics.fit.events[0], at: panelAt(fitOffsetMs) }],
    },
  });
  for (const report of [
    // A hidden card six messages up: it fitted once, long ago, and heartbeats.
    panelReport('panel-hidden', -9_000, 900, -60_000),
    // The panel on screen, mounted a moment ago and still fetching: no fit yet.
    panelReport('panel-visible', -3_000, 2),
    panelReport('panel-hidden', -2_000, 901, -60_000),
    panelReport('panel-visible', -1_000, 3),
  ]) {
    const stored = await client.callTool({ name: 'stereo_structure.report_diagnostics', arguments: sessionArguments({ diagnostics: report }) });
    assert.equal(stored.isError, undefined, 'a well-formed report from any panel must be accepted');
  }
  const twoPanels = await client.callTool({ name: 'stereo_structure.get_state', arguments: sessionArguments({}) });
  const twoPanelState = twoPanels.structuredContent as {
    diagnostics?: { panelId?: string; sequence?: number };
    diagnosticsPanels?: Array<{ panelId: string; answering?: boolean }>;
  };
  assert.equal(
    twoPanelState.diagnostics?.panelId,
    'panel-visible',
    'get_state must answer with the live panel that spoke last, even before it has fitted',
  );
  assert.equal(twoPanelState.diagnostics?.sequence, 3, 'the answer must be that panel\'s newest report');
  assert.deepEqual(
    twoPanelState.diagnosticsPanels?.map((panel) => [panel.panelId, panel.answering === true]),
    [['panel-visible', true], ['panel-hidden', false]],
    'diagnosticsPanels must list the answering panel first and mark it',
  );
  // A report that goes backwards for its own panel is dropped rather than
  // stored: the channel does not order deliveries.
  await client.callTool({ name: 'stereo_structure.report_diagnostics', arguments: sessionArguments({ diagnostics: panelReport('panel-visible', 1_000, 2) }) });
  const afterStale = await client.callTool({ name: 'stereo_structure.get_state', arguments: sessionArguments({}) });
  assert.equal(
    (afterStale.structuredContent as { diagnostics?: { sequence?: number } }).diagnostics?.sequence,
    3,
    'a report with a lower sequence than the stored one for the same panel must be rejected',
  );
  // And a report taken while a load owns the camera describes a camera the
  // load is about to move, so it loses to a settled panel despite its newer
  // clock and its newer sequence.
  await client.callTool({
    name: 'stereo_structure.report_diagnostics',
    arguments: sessionArguments({
      diagnostics: {
        ...panelReport('panel-visible', 2_000, 4),
        fit: { ...sampleDiagnostics.fit, loadInFlight: true, events: [] },
      },
    }),
  });
  const whileLoading = await client.callTool({ name: 'stereo_structure.get_state', arguments: sessionArguments({}) });
  assert.equal(
    (whileLoading.structuredContent as { diagnostics?: { panelId?: string } }).diagnostics?.panelId,
    'panel-hidden',
    'a panel with a load in flight must not answer while a settled panel is present',
  );

  /*
   * A fresh panel whose first `get_structure` fails still ends up loaded.
   *
   * The viewer's retry policy is pure (`../src/fallback-retry.ts`), so it is
   * driven here against the real server with the first call forced to throw:
   * the failure this reproduces is a rejected tool call, which is what a host
   * still wiring the app up, a timeout or a rate limit looks like from inside
   * the panel. Without the retry that one failure ended the fallback with the empty
   * state up, in a conversation that had a structure on the server the whole
   * time.
   */
  await client.callTool({ name: 'stereo_structure.open', arguments: sessionArguments({ structureText: seedStructureText, format: 'pdb' }) });
  const retry = createFallbackRetry();
  let failNext = true;
  let step: FallbackStep = { action: 'retry', delayMs: 0, tries: 0 };
  const at = () => new Date().toISOString();
  while (step.action === 'retry') {
    let threw = false;
    let cached: CachedStructure | undefined;
    try {
      if (failNext) {
        failNext = false;
        throw new Error('the host has not finished wiring the app up');
      }
      const fetched = await client.callTool({ name: 'stereo_structure.get_structure', arguments: sessionArguments({}) });
      assertModelResultPrivate(fetched, 'fallback get_structure');
      cached = privateStructure<CachedStructure>(fetched, 'fallback get_structure');
    } catch {
      threw = true;
    }
    step = retry.record({ threw, cached }, at());
  }
  assert.equal(step.action, 'answer', 'a get_structure that fails once must not end the fallback');
  const answered = step.action === 'answer' ? step.cached : undefined;
  const fallbackDecision = decideStructureFallback({ hasStructure: false, cached: answered });
  assert.equal(fallbackDecision.action, 'load', 'the retried answer must be a structure the panel loads');
  assert.equal(retry.snapshot().tries, 2, 'the fallback must have asked exactly twice');
  assert.equal(retry.snapshot().lastError, 'threw', 'the first failure must be recorded as a thrown call');
  assert.equal(retry.snapshot().done, true);

  /*
   * The viewer stamp identifies the bytes that are mounted.
   *
   * `scripts/build.ts` replaces a 64-character placeholder with the sha-256 of
   * the document that still contained the placeholder, so the stamp can be
   * recomputed from the shipped file rather than believed. A restage that
   * silently did not happen is otherwise indistinguishable from a fix that did
   * not work.
   */
  const placeholder = 'stereofold-viewer-build-unstamped-000000000000000000000000000000';
  const viewerHtmlPath = resolve(distRoot, 'viewer.html');
  const shipped = await readFile(viewerHtmlPath, 'utf8');
  assert.ok(!shipped.includes(placeholder), 'dist/viewer.html must carry a stamped build id');
  const stamps = [...new Set(shipped.match(/(?<![0-9a-zA-Z])[0-9a-f]{64}(?![0-9a-zA-Z])/gu) ?? [])]
    .filter((candidate) => createHash('sha256').update(shipped.split(candidate).join(placeholder), 'utf8').digest('hex') === candidate);
  assert.equal(stamps.length, 1, 'dist/viewer.html must carry exactly one self-consistent build stamp');

  const inspectorShipped=await readInlineHtml(resolve(distRoot, 'inspector.html'));
  const inspectorStamps=[...new Set(inspectorShipped.match(/(?<![0-9a-zA-Z])[0-9a-f]{64}(?![0-9a-zA-Z])/gu)??[])]
    .filter(candidate=>createHash('sha256').update(inspectorShipped.split(candidate).join(placeholder),'utf8').digest('hex')===candidate);
  assert.equal(inspectorStamps.length,1,'Inspector must carry a verifiable self stamp');
  const inspectionResource=await client.readResource({uri:'ui://stereo-structure/inspector'});
  assert.equal((inspectionResource.contents[0] as {text:string}).text,inspectorShipped);

  const listedResources = await client.listResources();
  assert.equal(listedResources.resources.length, 2);
  assert.equal(listedResources.resources[0]?.uri, 'ui://stereo-structure/viewer');
  assert.equal(listedResources.resources[0]?.mimeType, 'text/html;profile=mcp-app');
  const fetched = await client.readResource({ uri: 'ui://stereo-structure/viewer' });
  const firstContent = fetched.contents[0];
  const html = firstContent != null && 'text' in firstContent ? firstContent.text : undefined;
  if (typeof html !== 'string') throw new Error('Stereofold resource did not return HTML text.');
  assert.ok(html.includes('Stereofold'), 'viewer HTML must carry the Stereofold identity');
  const forbiddenTitle = ['Molecular', 'Structure', 'Viewer'].join(' ');
  assert.ok(!html.includes(forbiddenTitle));
  assert.ok(!/<script[^>]+src=["']https?:\/\//iu.test(html), 'viewer bundle must not load runtime HTTP scripts');
  assert.ok(!/<link[^>]+href=["']https?:\/\//iu.test(html), 'viewer bundle must not load runtime HTTP styles');
  console.log(`SMOKE PASS: stdio tools/resources/resource HTML verified; viewer build ${stamps[0]}.`);
} finally {
  try { await client.close(); } finally { await rm(privateState, { recursive: true, force: true }); }
}
