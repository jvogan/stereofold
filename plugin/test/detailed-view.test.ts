import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

/** Fixture directories live under the OS temporary directory. */
const discard = (path: string) => rm(path, {force: true, recursive: true});
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { DETAILED_VIEW_EMPHASIS_SOURCE, DETAILED_VIEW_ROUTES, detailedViewAddress, detailedViewHtml } from '../src/detailed-view-page.js';
import { QUEST_EXIT_BANNER_KEY, QUEST_EXIT_BANNER_PX } from '../src/quest-exit-banner.js';
import { detailedViewHandoff, detailedViewSnapshotId } from '../src/detailed-view-contract.js';
import { detailedViewImport } from '../src/detailed-view-import.js';
import { XR_REENTRY_KEY } from '../src/xr-reentry-hint.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, cameraPose, expectedInspection, inspectionChangeSchema, matchesInspectionChange, updateInspectionSchema } from '../src/inspection-contract.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const camera = {mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0],
  radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0};
const detailedCamera = {mode: 'orthographic', fov: 0.6, position: [12, -4, 33], up: [0, 1, 0], target: [1, 2, 3],
  radius: 31.5, radiusMax: 44, fog: 42, clipFar: false, minNear: 4, minFar: 0};

function baseScene(sourceSha256: string) {
  return {
    sourceSha256, modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: [],
    camera: structuredClone(camera),
    inspection: {
      appearance: {representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734',
        highlightColor: '#ffccee', opacity: 1, labels: false, clipping: 0, fog: 30},
      placement: {translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1},
    },
  } as any;
}

/** The shape Mol* writes when the full viewer's Download State saves a .molj. */
function molj(overrides: Record<string, any> = {}) {
  const entry = {
    timestamp: 1,
    snapshot: {
      id: 'entry-one',
      camera: {current: structuredClone(detailedCamera), transitionStyle: 'instant'},
      canvas3d: {props: {renderer: {backgroundColor: 0x0a0f14}}},
      data: {tree: {transforms: [
        {ref: 'root', parent: '', transformer: 'build-in.root', params: {}, version: '1'},
        {ref: 'repr', parent: 'structure', transformer: 'ms-plugin.structure-representation-3d', version: '1',
          params: {type: {name: 'spacefill', params: {alpha: 0.65}}, colorTheme: {name: 'uniform', params: {value: 0x11ee44}}}},
      ]}},
      ...overrides,
    },
  };
  return JSON.stringify({timestamp: 1, version: '5.11.0', current: 'entry-one', playback: {isPlaying: false, nextSnapshotDelayInMs: 1500}, entries: [entry]});
}

/** Sends a request line verbatim, without the URL normalisation fetch() applies. */
function rawStatus(port: number, path: string, token: string) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({host: '127.0.0.1', port, path, method: 'GET',
      headers: {Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}`}}, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end();
  });
}

describe('cinematic to detailed handoff artifact', () => {
  it('binds one handoff to the exact coordinates and scene it came from', () => {
    const digest = sha(cif), scene = baseScene(digest);
    const handoff = detailedViewHandoff({structureText: cif, sourceSha256: digest, scene, pdbId: '1crn'});
    expect(handoff.snapshotId).toMatch(/^[a-f0-9]{32}$/);
    expect(handoff.snapshotId).toBe(detailedViewSnapshotId(digest, scene));
    expect(handoff.structureText).toBe(cif);

    // The same saved inspection reopens the same address; a changed one does not.
    const moved = structuredClone(scene); moved.inspection.appearance.representation = 'spacefill';
    expect(detailedViewSnapshotId(digest, moved)).not.toBe(handoff.snapshotId);

    expect(() => detailedViewHandoff({structureText: cif, sourceSha256: sha('other'), scene})).toThrow(/do not match/);
    expect(() => detailedViewHandoff({structureText: cif, sourceSha256: digest, scene: baseScene(sha('other'))})).toThrow(/different structure/);
  });
});

describe('the saved tier decides the detailed handoff', () => {
  it('hands off the current atomic wall bytes even with a density asset beside them', () => {
    const wall = cif.replace('data_1CRN', 'data_wall');
    const digest = sha(wall), scene = baseScene(digest);
    const handoff = detailedViewHandoff({structureText: wall, sourceSha256: digest, scene,
      densitySha256: sha('density bytes'), tierName: 'wall'});
    expect(handoff.structureText).toBe(wall);
    expect(handoff.scene).toEqual(scene);
    expect(handoff.sourceSha256).toBe(digest);
  });

  it('names a coordinate-free density tier and explains how to open Mol*', () => {
    const mapDigest = sha('density bytes');
    const scene = baseScene(mapDigest);
    expect(() => detailedViewHandoff({structureText: cif, sourceSha256: sha(cif), scene,
      densitySha256: mapDigest, tierName: 'filament-density'}))
      .toThrow('The filament-density tier has no atom coordinates. Switch to an atomic tier, then open Mol* again.');
    expect(scene.sourceSha256).toBe(mapDigest);
  });

  it('uses the same saved-scene handoff for the companion route and open tool', async () => {
    const source = await readFile(new URL('../src/inspection-server.ts', import.meta.url), 'utf8');
    expect(source).toContain('return savedDetailedHandoff(data)');
    expect(source).toContain('const handoff=await savedDetailedHandoff(data)');
    expect(source).toContain('densitySha256:a.density.sha256');
  });
});

describe('detailed to cinematic snapshot import', () => {
  const scene = baseScene(sha(cif));

  it('carries a changed native representation back onto the visible figure while a no-op import keeps authored layers', () => {
    const layered = structuredClone(scene);
    const figure = { layers: [{ id: 'my-part', target: { chain: 'A' }, representation: 'cartoon', color: '#25859b', opacity: 1, context: false }], labels: [], distances: [] };
    layered.inspection.lessonFigure = figure;
    const imported = detailedViewImport(molj(), layered);
    expect(imported.scene.inspection.lessonFigure).toEqual({ ...figure, representationOverride: 'spacefill' });
    expect(imported.scene.sourceSha256).toBe(layered.sourceSha256);
    expect(imported.scene.inspection.placement).toEqual(layered.inspection.placement);
    const same = JSON.parse(molj());
    same.entries[0].snapshot.data.tree.transforms[1].params.type.name = 'cartoon';
    expect(detailedViewImport(JSON.stringify(same), layered).scene.inspection.lessonFigure).toEqual(figure);
    expect(layered.inspection.lessonFigure).toEqual(figure);
  });

  it('carries the camera unchanged and maps the appearance Mol* and the panel share', () => {
    const imported = detailedViewImport(molj(), scene);
    expect(imported.scene.camera).toEqual(detailedCamera);
    expect(imported.scene.inspection.appearance.representation).toBe('spacefill');
    expect(imported.scene.inspection.appearance.color).toBe('uniform');
    expect(imported.scene.inspection.appearance.uniformColor).toBe('#11ee44');
    expect(imported.scene.inspection.appearance.opacity).toBe(0.65);
    expect(imported.scene.inspection.appearance.background).toBe('#0a0f14');
    expect(imported.applied).toEqual(expect.arrayContaining(['camera', 'representation', 'color theme', 'opacity', 'background']));
    // Nothing outside the projection is invented.
    expect(imported.scene.sourceSha256).toBe(scene.sourceSha256);
    expect(imported.scene.selectionKeys).toEqual([]);
    expect(imported.scene.inspection.placement).toEqual(scene.inspection.placement);
  });

  it('reports what the panel cannot render instead of approximating it', () => {
    const exotic = JSON.parse(molj());
    exotic.entries[0].snapshot.data.tree.transforms[1].params.type.name = 'gaussian-surface';
    exotic.entries[0].snapshot.data.tree.transforms[1].params.colorTheme.name = 'hydrophobicity';
    exotic.entries[0].snapshot.structureSelection = {entries: [{}]};
    exotic.entries.push(structuredClone(exotic.entries[0]));
    const imported = detailedViewImport(JSON.stringify(exotic), scene);
    expect(imported.scene.inspection.appearance.representation).toBe('cartoon');
    expect(imported.scene.inspection.appearance.color).toBe('chain-id');
    expect(imported.dropped.join(' ')).toMatch(/gaussian-surface/);
    expect(imported.dropped.join(' ')).toMatch(/hydrophobicity/);
    expect(imported.dropped.join(' ')).toMatch(/selection/);
    expect(imported.dropped.join(' ')).toMatch(/1 further saved states/);
  });

  it('refuses archives, malformed files and empty snapshots by name', () => {
    expect(() => detailedViewImport('PKbinary', scene)).toThrow(/\.molj format/);
    expect(() => detailedViewImport('not json', scene)).toThrow(/valid JSON/);
    expect(() => detailedViewImport('{"entries":[]}', scene)).toThrow(/no entries/);
    expect(() => detailedViewImport('[]', scene)).toThrow(/not a Mol\* state snapshot/);
  });

  it('projects a returning pose onto the panel camera and leaves depth with the renderer', () => {
    const change = inspectionChangeSchema.parse({kind: 'camera', patch: {camera: structuredClone(detailedCamera)}});
    const expected = expectedInspection(scene, change);
    // The pose is the caller's; scene radius, fog and near/far bounds are the
    // renderer's, so they stay exactly where the panel had them.
    expect(cameraPose(expected.camera)).toEqual(cameraPose(detailedCamera as any));
    for (const key of ['radius', 'radiusMax', 'fog', 'clipFar', 'minNear', 'minFar'] as const) {
      expect(expected.camera[key]).toEqual((camera as any)[key]);
    }
    expect(expected.inspection).toEqual(scene.inspection);
    expect(expected.selectionKeys).toEqual(scene.selectionKeys);

    // Mol* recomputes this bound from committed geometry, so the receipt must
    // accept the renderer's value and nothing else about the pose.
    const rendered = structuredClone(expected); rendered.camera.radiusMax = 99;
    expect(matchesInspectionChange(rendered, expected, change)).toBe(true);
    const moved = structuredClone(expected); moved.camera.position = [1, 2, 3];
    expect(matchesInspectionChange(moved, expected, change)).toBe(false);
    const recolored = structuredClone(expected); recolored.inspection.appearance.background = '#000000';
    expect(matchesInspectionChange(recolored, expected, change)).toBe(false);

    // A camera command carries one complete snapshot and nothing else.
    expect(inspectionChangeSchema.safeParse({kind: 'camera', patch: {camera: {position: [0, 0, 1]}}}).success).toBe(false);
    expect(inspectionChangeSchema.safeParse({kind: 'camera', patch: {camera: structuredClone(detailedCamera), labels: true}}).success).toBe(false);
    // No tool hands the model a camera, so update_inspection does not take one.
    expect(updateInspectionSchema.safeParse({sessionId: randomUUID(), serverEpoch: randomUUID(), sourceToken: randomUUID(),
      baseStateRevision: 0, baseInspectionRevision: 0, panelId: randomUUID(), commandId: 'pose',
      change: {kind: 'camera', patch: {camera: structuredClone(detailedCamera)}}}).success).toBe(false);
  });

  it('keeps the panel camera when the state file has none', () => {
    const noCamera = JSON.parse(molj());
    delete noCamera.entries[0].snapshot.camera;
    const imported = detailedViewImport(JSON.stringify(noCamera), scene);
    expect(imported.scene.camera).toEqual(camera);
    expect(imported.dropped.join(' ')).toMatch(/camera/);
  });
});

describe('loopback routes for the full Mol* viewer', () => {
  async function host() {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-detailed-'));
    await writeFile(join(directory, 'inspector.html'), '<!doctype html><script>panel</script>');
    const sessionId = randomUUID(), sourceToken = randomUUID();
    const server = new InspectionCompanionHttp({
      htmlPath: join(directory, 'inspector.html'),
      dispatch: async () => ({structuredContent: {}}),
      source: async () => ({text: cif, sha256: sha(cif)}),
      molstarRoots: {distRoot: directory, packageRoot: directory},
      detailed: async () => detailedViewHandoff({structureText: cif, sourceSha256: sha(cif), scene: baseScene(sha(cif)), pdbId: '1crn'}),
    });
    return {directory, server, sessionId, sourceToken};
  }

  it('serves the page and library openly, gates the coordinates, and answers nothing else', async () => {
    const {directory, server, sessionId, sourceToken} = await host();
    // Lay the bundle down where a packaged host keeps it.
    const dist = join(directory, 'molstar');
    await mkdir(dist, {recursive: true});
    await writeFile(join(dist, 'molstar.js'), 'globalThis.molstar={};');
    await writeFile(join(dist, 'molstar.css'), '.msp-plugin{color:#fff}');
    try {
      const link = await server.openDetailed(sessionId, sourceToken);
      expect(link.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${link.port}${DETAILED_VIEW_ROUTES.page}#[a-f0-9]{64}$`));
      const token = link.url.slice(link.url.indexOf('#') + 1);
      const origin = `http://127.0.0.1:${link.port}`;

      const page = await fetch(`${origin}${DETAILED_VIEW_ROUTES.page}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(page.headers.get('content-security-policy')).toMatch(/worker-src 'self' blob:/);
      // The Mol* viewer bundle carries Emscripten glue that names its exports
      // with `new Function`, so this one generated document relaxes eval. The
      // relaxation must not reach the panel or the coordinates beside it.
      expect(page.headers.get('content-security-policy')).toContain("'unsafe-eval'");
      expect(page.headers.get('content-security-policy')).toContain("connect-src 'self';");
      expect((await fetch(`${origin}/`)).headers.get('content-security-policy')).toContain("connect-src 'self';");
      expect((await fetch(`${origin}/`)).headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
      const html = await page.text();
      expect(html).toContain(DETAILED_VIEW_ROUTES.script);
      expect(html).toContain(DETAILED_VIEW_ROUTES.handoff);
      // The page itself must never carry coordinates or a bearer.
      expect(html).not.toContain('ATOM');
      expect(html).not.toContain(token);
      // A headset that opened this page over the LAN listener has to be able
      // to get back to the panel; on loopback the panel is already on screen.
      expect(html).toContain('Back to headset view');
      expect(html).toMatch(/location\.protocol === 'https:'/);

      const script = await fetch(`${origin}${DETAILED_VIEW_ROUTES.script}`);
      expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(await script.text()).toBe('globalThis.molstar={};');
      const style = await fetch(`${origin}${DETAILED_VIEW_ROUTES.style}`);
      expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8');

      // Coordinates need the bearer the page reads out of its own fragment.
      expect((await fetch(`${origin}${DETAILED_VIEW_ROUTES.handoff}`)).status).toBe(401);
      const handoff = await fetch(`${origin}${DETAILED_VIEW_ROUTES.handoff}`, {headers: {Authorization: `Bearer ${token}`}});
      expect(handoff.status).toBe(200);
      const body = await handoff.json() as any;
      expect(body.sourceSha256).toBe(sha(cif));
      expect(body.structureText).toBe(cif);
      expect(body.scene.camera).toEqual(camera);

      // Routes are exact string comparisons against constants, so there is no
      // path to traverse. fetch() would normalise dot segments away before
      // they reached the server, so these go out as raw request lines.
      for (const path of ['/detailed/', '/detailed/../source', '/detailed/%2e%2e/source', '/detailed/..%2fsource',
        '/detailed/molstar.js.map', '/detailed/handoff.json/x', '/molstar/molstar.js']) {
        expect(await rawStatus(link.port, path, token), path).toBe(404);
      }
    } finally {
      await server.close();
      await discard(directory);
    }
  });

  it('reports a missing viewer bundle instead of opening a blank page', async () => {
    const {directory, server, sessionId, sourceToken} = await host();
    try {
      await expect(server.openDetailed(sessionId, sourceToken)).rejects.toThrow(/not installed beside this server/);
    } finally {
      await server.close();
      await discard(directory);
    }
  });
});

describe('detailed view page keepalive', () => {
  it('renews the LAN session on the handoff route while the tab is visible, and stops when it is refused', () => {
    const html = detailedViewHtml();
    // The panel stops polling once this page replaces it, so the page itself
    // has to make the authorized request that pushes the session expiry out.
    expect(html).toContain('const KEEPALIVE_MS = 300000;');
    expect(html).toMatch(/setInterval\([\s\S]*keepalive/);
    expect(html).toMatch(/setInterval\([\s\S]*\}, KEEPALIVE_MS\);/);
    const keepalive = html.slice(html.indexOf('const KEEPALIVE_MS'), html.indexOf('}, KEEPALIVE_MS);'));
    expect(keepalive).toContain(DETAILED_VIEW_ROUTES.handoff);
    expect(keepalive).toContain("document.visibilityState === 'hidden'");
    expect(keepalive).toContain('renewal.status === 401');
    expect(keepalive).toContain('renewal.status === 410');
    expect(keepalive).toContain('clearInterval(keepalive)');
  });
});

describe('detailed view opens on what the wearer was inspecting', () => {
  const html = detailedViewHtml();

  it('never rebuilds a filled representation on load', () => {
    // The saved scene carries whatever the headset last showed, and an
    // autoplaying demo chapter leaves molecular-surface or spacefill there.
    // Rebuilding it costs seconds of load and leaves an opaque blob: Mol* logs
    // "Created Molecular Surface in 3.245s".
    expect(html).toContain("const FILLED = {'molecular-surface': 'cartoon', 'spacefill': 'cartoon'};");
    expect(html).toContain('const representation = FILLED[look.representation] || look.representation;');
    // The representation the page builds is the mapped one, never the raw scene
    // value. The page still owns these parameters; the colour key only decides
    // which component carries them and at what strength.
    const added = html.slice(html.indexOf('const baseParams = {'));
    expect(added.slice(0, 200)).toContain('type: representation,');
    expect(added.slice(0, 200)).not.toContain('type: look.representation');
    // The colour theme, opacity and the label layer still come from the scene.
    expect(added.slice(0, 300)).toContain('color: look.color');
    expect(added.slice(0, 300)).toContain('typeParams: {alpha: look.opacity}');
    // Both are readable from a harness, so a substitution is never silent.
    expect(html).toContain("document.body.dataset.representation = representation;");
    expect(html).toContain('document.body.dataset.sceneRepresentation = look.representation;');
  });

  it('asks for no density and fits the structure to the viewport', () => {
    expect(html).toContain('volumeStreamingDisabled: true');
    expect(html).not.toContain('initVolumeStreaming');
    // A reset with no snapshot resolves to a fit of the visible bounding
    // sphere. The panel camera used to be transplanted instead, which in a
    // Quest Browser window left the structure a speck.
    expect(html).toContain('plugin.canvas3d.requestCameraReset({durationMs: 0});');
    expect(html).not.toContain('snapshot: () => wanted');
    expect(html).not.toContain('const wanted = scene.camera;');
    expect(html).toContain("document.body.dataset.cameraFit = 'structure';");
  });

  it('keeps the way back, and arms the companion page to re-enter', () => {
    expect(html).toContain('Back to headset view');
    // The way back no longer pastes the page key into the address
    // it navigates to. `fragment` is empty once this tab has its own copy, and
    // falls back to '#<key>' only where sessionStorage refused the copy.
    expect(html).toContain("back.href = '/viewer' + pageKey.fragment;");
    expect(html).not.toContain("'/viewer' + location.hash");
    expect(html).toContain(`sessionStorage.setItem('${XR_REENTRY_KEY}'`);
    // The hint is a timestamp and nothing else: it carries no capability.
    expect(html).toContain('JSON.stringify({at: Date.now(), via: leftVia})');
    const hint = html.slice(html.indexOf('const armReentry'), html.indexOf('const colorNumber'));
    expect(hint).not.toContain('bearer');
  });

  /**
   * Going to Mol* used to be one way in the headset. The only control that
   * armed the way home was 110x34 px in the top-right corner, behind Quest
   * Browser's own chrome and beside Mol*'s viewport buttons, where a wearer
   * could not find it.
   */
  it('puts the way back first, as a target a controller ray can hit', () => {
    // A row at the top of the page, above Mol*'s own UI, not a corner link.
    expect(html).toContain('<p id="bar" hidden>');
    expect(html).toMatch(/#bar\{position:absolute;left:0;right:0;top:var\(--xr-banner\);z-index:8/);
    // Both controls are 64 px tall and read at arm's length through a lens.
    expect(html).toMatch(/#back\{[^}]*min-height:64px/);
    expect(html).toMatch(/#back\{[^}]*font:700 24px/);
    expect(html).toMatch(/#return\{[^}]*min-height:64px/);
    // The plain way out is read before the one that carries work home.
    expect(html.indexOf('id="back"')).toBeLessThan(html.indexOf('id="return"'));
    expect(html).toContain('Apply changes, then back to headset');
    // The status line moves out from under the row rather than hiding it.
    expect(html).toContain('body[data-back="on"] #status{top:calc(var(--xr-banner) + 92px)}');
    // With no banner the row is still the first thing on the page.
    expect(html).toContain('body{--xr-banner:0px}');
  });

  it('arms the way back for every way out of the page, not just the link', () => {
    // Quest Browser gives the wearer the browser Back arrow, the controller B
    // button and the back gesture. None of them is a click on this link, and
    // each used to land on the companion with no hint and no one-tap re-entry.
    expect(html).toContain("window.addEventListener('pagehide', armReentry);");
    expect(html).toContain("back.addEventListener('click', () => { leftVia = 'back-link'; armReentry(); });");
    expect(html).toContain("let leftVia = 'unload';");
  });

  /**
   * Quest Browser draws
   * "The immersive web experience is still running in the background." across
   * the top of this tab after the handoff, as chrome above the page, and on
   * the Quest 2 it covered this page's whole 88 px top row. The
   * wearer could reach the way back only from a debugger.
   */
  it('lays the page out below Quest Browser\'s exit banner when the tab handed off', () => {
    // One property carries the decision, so every line pinned to the top of
    // the viewport moves together and none of them is left under the banner.
    expect(html).toContain(`body[data-xr-banner="on"]{--xr-banner:${QUEST_EXIT_BANNER_PX}px}`);
    for (const rule of [
      '#bar{position:absolute;left:0;right:0;top:var(--xr-banner);z-index:8;',
      '#status{position:absolute;left:0;right:0;top:var(--xr-banner);z-index:5;',
      '#selection-status{position:absolute;left:0;right:0;top:calc(var(--xr-banner) + 92px);',
      'body[data-back="on"] #status{top:calc(var(--xr-banner) + 92px)}',
      '#return-note{top:calc(var(--xr-banner) + 100px)}',
      '#return-path{top:calc(var(--xr-banner) + 136px);',
      'body[data-back="on"] #return-note{top:calc(var(--xr-banner) + 150px)}',
      'body[data-back="on"] #return-path{top:calc(var(--xr-banner) + 186px)}',
    ]) expect(html).toContain(rule);
    // Nothing pinned to the top is left written against a bare pixel offset.
    expect(html.match(/#(?:bar|status|selection-status|return-note|return-path)\{[^}]*top:\d/gu)).toBeNull();
    // The banner clears the row it used to cover: 88 px of row starting below
    // a band about 92 px deep in an earlier run’s capture.
    expect(QUEST_EXIT_BANNER_PX).toBeGreaterThan(92);
    // The page reads the note the handing-off tab left, and publishes which
    // way it laid out so a capture says so without a debugger.
    expect(html).toContain(JSON.stringify(QUEST_EXIT_BANNER_KEY));
    expect(html).toContain("document.body.dataset.xrBanner = exitBanner.covered ? 'on' : 'off';");
    // Read before the page paints, beside the address it draws in the same row.
    expect(html.indexOf('const exitBanner =')).toBeLessThan(html.indexOf("const back = document.getElementById('back')"));
  });

  it('lets the Mac call the wearer back out of Mol*', () => {
    // While the wearer is here no companion panel is attached, so say_to_headset
    // and every queued command have nobody to reach. This poll is the only
    // channel, and it rides the bearer the page already holds.
    expect(html).toContain('const RECALL_POLL_MS = 2000;');
    const recall = html.slice(html.indexOf('const RECALL_POLL_MS'), html.indexOf('const handoff ='));
    expect(recall).toContain("name: 'poll_detailed_view'");
    expect(recall).toContain("document.visibilityState === 'hidden'");
    expect(recall).toContain("leftVia = 'recall';");
    expect(recall).toContain('armReentry();');
    // It navigates to the same address the Back control uses, never to one
    // built here, so the page key handling has exactly one owner.
    expect(recall).toContain('back && !back.hidden ? back.href');
    expect(recall).toContain("document.body.dataset.recall = 'returning';");
  });
});

describe('detailed view tool contract', () => {
  async function setup(options: Record<string, unknown> = {}) {
    // The companion listener reads the packaged inspector page, and the
    // detailed route reads the viewer bundle beside it, so the fixture is a
    // miniature dist/.
    const dist = await mkdtemp(join(tmpdir(), 'stereofold-dist-'));
    await writeFile(join(dist, 'viewer.html'), '<html><script>void 0;</script></html>');
    await writeFile(join(dist, 'inspector.html'), '<html><script>void 0;</script></html>');
    await mkdir(join(dist, 'molstar'), {recursive: true});
    await writeFile(join(dist, 'molstar/molstar.js'), 'globalThis.molstar={};');
    await writeFile(join(dist, 'molstar/molstar.css'), '.msp-plugin{color:#fff}');
    const [a, b] = InMemoryTransport.createLinkedPair(), server = createStereoStructureServer(join(dist, 'viewer.html'), options);
    const client = new Client({name: 'Detailed view contract test', version: '1'});
    await server.connect(b); await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => await client.callTool({name: `stereo_structure.${name}`, arguments: args}) as any;
    const sessionId = (await call('inspect', {structureText: cif})).structuredContent.sessionId;
    const data = (await call('get_inspection', {sessionId}))._meta[KEY];
    const scene = {sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
      selectionKeys: [], camera: structuredClone(camera),
      inspection: baseScene(data.catalog.source.sha256).inspection};
    const args = {sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
      baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene};
    return {call, sessionId, args, close: async () => { await client.close(); await server.close(); await discard(dist); }};
  }

  it('opens the detailed view only from a saved, current inspection and prints its address', async () => {
    const t = await setup();
    const {scene, ...binding} = t.args;
    try {
      expect((await t.call('open_detailed_view', binding)).isError).toBe(true); // nothing saved yet
      const saved = (await t.call('sync_inspection', t.args)).structuredContent;
      const current = {sessionId: t.sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision};
      expect((await t.call('open_detailed_view', {...current, baseInspectionRevision: current.baseInspectionRevision + 1})).isError).toBe(true);

      const opened = await t.call('open_detailed_view', current);
      expect(opened.isError).not.toBe(true);
      const view = opened.structuredContent.detailedView;
      expect(view.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/detailed#[a-f0-9]{64}$/);
      // With no headset paired the Mac's own address is still the
      // answer, and the result says plainly whose screen it is for.
      expect(view.reachableBy).toBe('this-mac');
      expect(view.localUrl).toBe(view.url);
      expect(view.headsetUrl).toBeUndefined();
      expect(view.snapshotId).toMatch(/^[a-f0-9]{32}$/);
      expect(view.carried).toContain('selection');
      expect(view.carried).toContain('labels');
      expect(view.notCarried).toContain('placement');
      // Claude Science cannot follow a link, so the address has to be readable
      // in the result text itself.
      expect(opened.content[0].text).toContain(view.url);
      expect(JSON.stringify(opened)).not.toContain('ATOM');
    } finally { await t.close(); }
  });

  // Claude Science cannot follow a link from the panel, so the only way the
  // user sees the full viewer there is for the server to open it on this Mac.
  it('opens the detailed view on this Mac only when asked, and only the address it just returned', async () => {
    const opened: Array<{ command: string; args: string[] }> = [];
    const t = await setup({ questLaunch: { platform: 'darwin', opener: '/bin/echo',
      launch: (command: string, args: readonly string[]) => { opened.push({ command, args: [...args] }); return { reason: 'started' as const }; } } });
    try {
      const saved = (await t.call('sync_inspection', t.args)).structuredContent;
      const current = {sessionId: t.sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision};

      // The default is what every earlier release did: print, open nothing.
      const quiet = await t.call('open_detailed_view', current);
      expect(quiet.isError).not.toBe(true);
      expect(quiet.structuredContent.detailedView.opened).toBe(false);
      expect(opened).toHaveLength(0);

      const launched = await t.call('open_detailed_view', {...current, open: true});
      expect(launched.isError).not.toBe(true);
      const view = launched.structuredContent.detailedView;
      expect(view.opened).toBe(true);
      // Exactly one link reaches the desktop, and it is the address the result
      // returned rather than anything else the request could name.
      expect(opened).toEqual([{command: '/bin/echo', args: [view.url]}]);
      expect(launched.content[0].text).toContain('Browser started for the detailed view on your Mac');
      // The address is still readable once, for a second look or a paste.
      expect(launched.content[0].text.split(view.url)).toHaveLength(2);
    } finally { await t.close(); }
  });

  it('states in the result when no browser opened, without failing the call', async () => {
    const t = await setup({ questLaunch: { platform: 'darwin', opener: '/bin/echo',
      launch: () => { throw Error('spawn ENOENT'); } } });
    try {
      const saved = (await t.call('sync_inspection', t.args)).structuredContent;
      const failed = await t.call('open_detailed_view', {sessionId: t.sessionId, serverEpoch: saved.serverEpoch,
        sourceToken: saved.sourceToken, baseStateRevision: saved.stateRevision,
        baseInspectionRevision: saved.inspectionRevision, open: true});
      expect(failed.isError).not.toBe(true);
      expect(failed.structuredContent.detailedView.opened).toBe(false);
      expect(failed.content[0].text).toContain('spawn ENOENT');
      expect(failed.content[0].text).toContain(failed.structuredContent.detailedView.url);
    } finally { await t.close(); }
  });

  it('queues one appearance command from a saved Mol* state and refuses unreadable files', async () => {
    const t = await setup();
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-molj-'));
    try {
      const saved = (await t.call('sync_inspection', t.args)).structuredContent;
      const current = {sessionId: t.sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision};
      const panelId = (await t.call('attach_inspection', current)).structuredContent.panelId;

      expect((await t.call('import_detailed_view', {...current, panelId, commandId: 'relative', filePath: 'state.molj'})).isError).toBe(true);
      expect((await t.call('import_detailed_view', {...current, panelId, commandId: 'missing', filePath: join(directory, 'absent.molj')})).isError).toBe(true);
      const archive = join(directory, 'state.molx');
      await writeFile(archive, 'PK');
      expect((await t.call('import_detailed_view', {...current, panelId, commandId: 'archive', filePath: archive})).isError).toBe(true);

      const state = join(directory, 'state.molj');
      await writeFile(state, molj());
      const imported = await t.call('import_detailed_view', {...current, panelId, commandId: 'from-detail', filePath: state});
      expect(imported.isError).not.toBe(true);
      expect(imported.structuredContent.command.status).toBe('queued');
      expect(imported.structuredContent.detailedImport.applied).toEqual(expect.arrayContaining(['representation', 'color', 'opacity', 'background']));
      // A panel renders one command at a time, so the framing is named as
      // still to come rather than silently lost.
      expect(imported.structuredContent.detailedImport.cameraPending).toBe(true);
      expect(imported.content[0].text).toMatch(/detailed framing is still to come/);
    } finally {
      await discard(directory);
      await t.close();
    }
  });

  it('queues the detailed framing as its own command once the appearance already matches', async () => {
    const t = await setup();
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-molj-'));
    try {
      // The panel is already showing what the saved state describes, so the
      // framing is the only thing left to bring home.
      const matched = structuredClone(t.args.scene);
      Object.assign(matched.inspection.appearance,
        {representation: 'spacefill', color: 'uniform', uniformColor: '#11ee44', opacity: 0.65, background: '#0a0f14'});
      const saved = (await t.call('sync_inspection', {...t.args, scene: matched})).structuredContent;
      const current = {sessionId: t.sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision};
      const panelId = (await t.call('attach_inspection', current)).structuredContent.panelId;

      const state = join(directory, 'state.molj');
      await writeFile(state, molj());
      const framed = await t.call('import_detailed_view', {...current, panelId, commandId: 'framing', filePath: state});
      expect(framed.isError).not.toBe(true);
      expect(framed.structuredContent.detailedImport).toMatchObject({applied: ['camera'], changed: true, cameraPending: false});
      expect(framed.structuredContent.command.status).toBe('queued');
      expect(framed.content[0].text).not.toMatch(/still to come/);

      // Nothing left to do is said plainly rather than queued as a no-op.
      const settled = join(directory, 'settled.molj');
      await writeFile(settled, molj({camera: {current: structuredClone(camera)}}));
      const nothing = await t.call('import_detailed_view', {...current, panelId, commandId: 'settled', filePath: settled});
      expect(nothing.structuredContent.detailedImport).toMatchObject({applied: [], changed: false});
      expect(nothing.content[0].text).toMatch(/nothing was queued/);
    } finally {
      await discard(directory);
      await t.close();
    }
  });
});

// The lesson's colour key used to arrive here as a
// sentence along the bottom of the page, so the one region the wearer pressed
// through to examine was the one region they could no longer point at. It is
// rebuilt now, as Mol*'s own components, and this drives that rebuild against a
// fake plugin rather than trusting the page source to describe it.
describe('the lesson colour key, rebuilt in the detailed viewer', () => {
  const helpers = new Function(`return ${DETAILED_VIEW_EMPHASIS_SOURCE};`)() as any;

  /** A Mol* unit cut down to the fields a part's chain and residue range are read from. */
  function unit(id: number, residues: {label: string; auth: string; seq: number}[]) {
    const index = residues.map((_, position) => position);
    return {
      id, kind: 0, elements: index,
      model: {atomicHierarchy: {
        chainAtomSegments: {index}, residueAtomSegments: {index},
        chains: {label_asym_id: {value: (at: number) => residues[at].label},
          auth_asym_id: {value: (at: number) => residues[at].auth}},
        residues: {auth_seq_id: {value: (at: number) => residues[at].seq}},
      }},
    };
  }
  /** One chain the lesson calls A and the file labels B, plus a second chain. */
  const loaded = {units: [
    unit(0, [{label: 'B', auth: 'A', seq: 10}, {label: 'B', auth: 'A', seq: 11}, {label: 'B', auth: 'A', seq: 12}]),
    unit(1, [{label: 'C', auth: 'C', seq: 4}]),
  ]};
  /** Mol*'s own loci record, reduced to what the fake selection library reads. */
  const lociFor = (groups: {unit: {id: number}; local: number}[][]) => {
    const grouped = new Map<number, Set<number>>();
    for (const positions of groups) for (const position of positions) {
      if (!grouped.has(position.unit.id)) grouped.set(position.unit.id, new Set());
      grouped.get(position.unit.id)!.add(position.local);
    }
    return {kind: 'element-loci', structure: 'loaded',
      elements: [...grouped].map(([id, set]) => ({unit: {id}, indices: [...set].sort((a, b) => a - b)}))};
  };
  const structureLib = {
    StructureSelection: {Singletons: (structure: unknown, sub: unknown) => ({structure, sub})},
    StructureElement: {Loci: {toStructure: (loci: any) => loci.elements.map((e: any) => [e.unit.id, e.indices])}},
  };
  function fakePlugin({refuse = ''} = {}) {
    const components: any[] = [], representations: any[] = [];
    return {components, representations, builders: {structure: {
      async tryCreateComponentFromSelection(_structure: unknown, params: any, tag: string) {
        if (refuse && tag.endsWith(refuse)) return undefined;
        components.push({label: params.label, tag, selection: await params.getSelection()});
        return {ref: tag};
      },
      representation: {
        async addRepresentation(component: any, params: any) { representations.push({ref: component.ref, ...params}); },
      },
    }}};
  }
  const colorNumber = (hex: string) => parseInt(String(hex).slice(1), 16);
  const paint = (plugin: any, parts: any[], focus: string[], overrides: Record<string, unknown> = {}) =>
    helpers.paintParts({plugin, structure: 'structure', loaded, lociFor, structureLib, colorNumber,
      parts, focus, representation: 'cartoon', opacity: 1, contextOpacity: 0.18, ...overrides});
  /** The scene's own appearance, as the page hands it to the base. */
  const baseParams = {type: 'cartoon', color: 'uniform', typeParams: {alpha: 1}, colorParams: {value: 0x778899}};
  /** The whole-structure component the page builds before any key is read. */
  const whole = {ref: 'all'};
  const drawBase = (plugin: any, parts: any[], focus: string[], overrides: Record<string, unknown> = {}) =>
    helpers.paintBase({plugin, structure: 'structure', component: whole, loaded, lociFor, structureLib,
      params: baseParams, parts, focus, contextOpacity: 0.18, ...overrides});
  /** How many times each atom of the fixture is carried by a drawn component. */
  const coverage = (plugin: any) => {
    const drawn = new Map<string, number>();
    for (const component of plugin.components) {
      for (const [unitId, indices] of component.selection.sub as [number, number[]][]) {
        for (const local of indices) {
          const atom = unitId + ':' + local;
          drawn.set(atom, (drawn.get(atom) ?? 0) + 1);
        }
      }
    }
    return drawn;
  };
  const guide = {id: 'rna', label: 'Guide RNA', color: '#ff8800', chain: 'A'};
  const pam = {id: 'pam', label: 'PAM', color: '#ffffff', chain: 'A', residues: {from: 12, to: 12}};
  const protein = {id: 'protein', label: 'Protein', color: '#9aa5ab', chain: 'C'};

  it('matches a part’s chain against both identifiers and its range against author numbering', () => {
    // inspection-contract.ts partHoldsRow: a lesson writes the chain a paper
    // prints and a structure may only know its label chain. Two resolvers that
    // disagreed about what a part covers would paint two different molecules.
    expect(helpers.holds({chain: 'A'}, 'B', 'A', 10)).toBe(true);
    expect(helpers.holds({chain: 'B'}, 'B', 'A', 10)).toBe(true);
    expect(helpers.holds({chain: 'Z'}, 'B', 'A', 10)).toBe(false);
    expect(helpers.holds({residues: {from: 10, to: 11}}, 'B', 'A', 12)).toBe(false);
    expect(helpers.holds({chain: 'A', residues: {from: 10, to: 11}}, 'B', 'A', 11)).toBe(true);
    // A residue with no author number cannot sit inside an author range.
    expect(helpers.holds({residues: {from: 1, to: 9}}, 'B', 'A', null)).toBe(false);
  });

  it('gathers each part’s residues in one pass over the structure', () => {
    const groups = helpers.resolveParts([{id: 'rna', chain: 'A'}, {id: 'pam', chain: 'A', residues: {from: 12, to: 12}},
      {id: 'gone', chain: 'Q'}], loaded);
    expect(groups.get('rna').map((p: any) => [p.unit.id, p.local])).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(groups.get('pam').map((p: any) => [p.unit.id, p.local])).toEqual([[0, 2]]);
    expect(groups.has('gone')).toBe(false);
  });

  it('builds one component per part, in the lesson’s own colours and focus opacity', async () => {
    const plugin = fakePlugin();
    const parts = [{id: 'protein', label: 'Protein', color: '#9aa5ab', chain: 'C'},
      {id: 'rna', label: 'Guide RNA', color: '#ff8800', chain: 'A'}];
    const rebuilt = await paint(plugin, parts, ['rna']);
    expect(rebuilt).toEqual({painted: ['Protein', 'Guide RNA'], unresolved: []});
    // The label is the lesson's word for the part, and the tag is stable per
    // part so a repaint replaces rather than stacks.
    expect(plugin.components.map((c: any) => [c.label, c.tag]))
      .toEqual([['Protein', 'stereofold-emphasis-protein'], ['Guide RNA', 'stereofold-emphasis-rna']]);
    // The guide RNA's component carries exactly the residues of its chain.
    expect(plugin.components[1].selection.sub).toEqual([[0, [0, 1, 2]]]);
    expect(plugin.representations).toEqual([
      {ref: 'stereofold-emphasis-protein', type: 'cartoon', color: 'uniform',
        colorParams: {value: 0x9aa5ab}, typeParams: {alpha: 0.18}},
      {ref: 'stereofold-emphasis-rna', type: 'cartoon', color: 'uniform',
        colorParams: {value: 0xff8800}, typeParams: {alpha: 1}},
    ]);
  });

  it('shows the whole key at full strength when the lesson focuses nothing', async () => {
    const plugin = fakePlugin();
    await paint(plugin, [{id: 'protein', label: 'Protein', color: '#9aa5ab', chain: 'C'},
      {id: 'rna', label: 'Guide RNA', color: '#ff8800', chain: 'A'}], []);
    expect(plugin.representations.map((r: any) => r.typeParams.alpha)).toEqual([1, 1]);
  });

  it('draws a part the lesson lights beside its focus at full strength', async () => {
    const plugin = fakePlugin();
    await paint(plugin, [protein, guide, pam], ['pam'], {alsoLit: ['rna']});
    expect(plugin.representations.map((r: any) => r.typeParams.alpha)).toEqual([0.18, 1, 1]);
  });

  it('names a part it cannot resolve instead of painting a key it did not draw', async () => {
    const plugin = fakePlugin();
    const rebuilt = await paint(plugin, [{id: 'rna', label: 'Guide RNA', color: '#ff8800', chain: 'A'},
      // A lesson written against a different entry names a chain these
      // coordinates do not have.
      {id: 'target', label: 'Target DNA', color: '#44aaff', chain: 'Q'}], []);
    expect(rebuilt).toEqual({painted: ['Guide RNA'], unresolved: ['Target DNA']});
    expect(plugin.components).toHaveLength(1);
  });

  it('falls back to words when the viewer bundle exposes no selection library', async () => {
    const plugin = fakePlugin();
    const rebuilt = await paint(plugin, [{id: 'rna', label: 'Guide RNA', color: '#ff8800', chain: 'A'}], [],
      {structureLib: null});
    expect(rebuilt).toEqual({painted: [], unresolved: ['Guide RNA']});
    expect(plugin.components).toHaveLength(0);
  });

  it('treats a component the builder refuses as unresolved rather than as painted', async () => {
    const plugin = fakePlugin({refuse: 'rna'});
    const rebuilt = await paint(plugin, [{id: 'rna', label: 'Guide RNA', color: '#ff8800', chain: 'A'},
      {id: 'protein', label: 'Protein', color: '#9aa5ab', chain: 'C'}], []);
    expect(rebuilt).toEqual({painted: ['Protein'], unresolved: ['Guide RNA']});
  });

  it('fades the base to the lesson’s own ghost and narrows it to what the key leaves', async () => {
    // lesson-emphasis.mjs planLessonEmphasis: a chapter with a focus fades every
    // row the focus does not claim, so the lit part is the only solid thing in
    // the room. A whole-structure base at the scene's opacity reproduced neither
    // half of that — the context stayed solid and the lit part was drawn twice.
    const plugin = fakePlugin();
    const base = await drawBase(plugin, [guide, pam], ['pam']);
    expect(base.alpha).toBe(0.18);
    expect(base.complement).toBe(true);
    // One component, named in the control tree, holding only chain C: no atom
    // of chain A, which the key paints for itself.
    expect(plugin.components.map((c: any) => [c.label, c.tag]))
      .toEqual([['Rest of structure', 'stereofold-emphasis-context']]);
    expect(plugin.components[0].selection.sub).toEqual([[1, [0]]]);
    expect(plugin.representations).toEqual([
      {ref: 'stereofold-emphasis-context', type: 'cartoon', color: 'uniform',
        colorParams: {value: 0x778899}, typeParams: {alpha: 0.18}},
    ]);
  });

  it('leaves the lit part at full strength and every other atom drawn once', async () => {
    const plugin = fakePlugin();
    // The key is resolved once, by the base, and the parts are painted from it.
    const base = await drawBase(plugin, [protein, pam], ['pam']);
    await paint(plugin, [protein, pam], ['pam'], {groups: base.groups});
    expect(plugin.representations.map((r: any) => [r.ref, r.typeParams.alpha])).toEqual([
      ['stereofold-emphasis-context', 0.18],
      ['stereofold-emphasis-protein', 0.18],
      ['stereofold-emphasis-pam', 1],
    ]);
    // The whole fixture is on screen and no atom is drawn twice: the PAM is not
    // a solid copy of itself over a solid copy of the whole structure, which is
    // what the base was doing to every lit part of every key.
    //
    // Parts of the key that OVERLAP each other still stack, on purpose: a
    // lesson that lists the PAM after the strand containing it means the PAM's
    // component to sit on the strand's, exactly as its layers stack in the
    // headset. That is the key's own ordering, not the base drawing underneath.
    const drawn = coverage(plugin);
    expect(drawn.size).toBe(4);
    expect([...drawn.values()]).toEqual([1, 1, 1, 1]);
  });

  it('leaves the base alone when the lesson focuses nothing', async () => {
    // An opening or a recap chapter IS the key: the whole of it at full
    // strength, and planLessonEmphasis fades nothing behind it.
    const plugin = fakePlugin();
    expect(await drawBase(plugin, [guide, protein], [])).toEqual({alpha: 1, groups: null, complement: false});
    // ...and so is a scene carrying no key at all.
    expect(await drawBase(plugin, [], [])).toEqual({alpha: 1, groups: null, complement: false});
    expect(plugin.components).toHaveLength(0);
    expect(plugin.representations).toEqual([
      {ref: 'all', type: 'cartoon', color: 'uniform', colorParams: {value: 0x778899}, typeParams: {alpha: 1}},
      {ref: 'all', type: 'cartoon', color: 'uniform', colorParams: {value: 0x778899}, typeParams: {alpha: 1}},
    ]);
  });

  it('keeps the whole structure solid when no selection library can narrow it', async () => {
    // Without the library paintParts paints nothing, so this representation is
    // the only thing drawing the molecule and must not be a ghost.
    const plugin = fakePlugin();
    const base = await drawBase(plugin, [guide], ['rna'], {structureLib: null});
    expect(base).toEqual({alpha: 1, groups: null, complement: false});
    expect(plugin.representations.map((r: any) => [r.ref, r.typeParams.alpha])).toEqual([['all', 1]]);
  });

  it('draws no base at all when the key claims every atom', async () => {
    const plugin = fakePlugin();
    const base = await drawBase(plugin, [protein, guide], ['rna']);
    expect(base.complement).toBe(true);
    expect(plugin.representations).toEqual([]);
  });

  it('keeps a structure on screen when the context component is refused', async () => {
    // The last resort, and the only path that still draws a part twice: a
    // viewer that lost its structure is worse than one that draws some of it
    // twice, and the ghost is still the right strength for the context.
    const plugin = fakePlugin({refuse: 'context'});
    const base = await drawBase(plugin, [guide], ['rna']);
    expect(base.complement).toBe(false);
    expect(plugin.representations).toEqual([
      {ref: 'all', type: 'cartoon', color: 'uniform', colorParams: {value: 0x778899}, typeParams: {alpha: 0.18}},
    ]);
  });

  it('leaves a coarse-grained unit to the base instead of dropping it', () => {
    // resolveParts can only match atomic units, so nothing claims a coarse one.
    // Skipping it here too would take it out of the picture altogether.
    const coarse = {id: 2, kind: 1, elements: [0, 1], model: {}};
    const rest = helpers.restPositions(new Map([['rna', [{unit: loaded.units[0], local: 0}]]]),
      {units: [...loaded.units, coarse]});
    expect(rest.map((position: any) => [position.unit.id, position.local]))
      .toEqual([[0, 1], [0, 2], [1, 0], [2, 0], [2, 1]]);
  });

  it('draws the base through the key, before the selection and once', () => {
    const html = detailedViewHtml();
    expect(html).toContain('emphasisHelpers.paintBase(');
    // The old base is gone: a whole-structure representation at the scene's
    // opacity is what left the wearer's faded context solid underneath the key.
    expect(html).not.toContain('addRepresentation(component || structure');
    // Decided before the selection and the key, so the structure is added once
    // rather than added and then repainted.
    expect(html.indexOf('emphasisHelpers.paintBase(')).toBeLessThan(html.indexOf('lociSelects.selectOnly'));
    expect(html.indexOf('emphasisHelpers.paintBase(')).toBeLessThan(html.indexOf('emphasisHelpers.paintParts('));
    // One pass over the atoms: the base resolves the key and hands it on.
    expect(html).toContain('groups: drawnBase.groups');
    // A scene with no key fades nothing, so the base keeps the scene's opacity.
    expect(html).toContain('contextOpacity: emphasis ? emphasis.contextOpacity : look.opacity');
    // Readable from a harness, so a base still solid over a faded context is
    // never silent.
    expect(html).toContain('document.body.dataset.baseOpacity');
    expect(html).toContain('document.body.dataset.baseCoverage');
  });

  it('is wired into the page after the loci helper, with the sentence kept as the fallback', () => {
    const html = detailedViewHtml();
    expect(html).toContain('emphasisHelpers.paintParts(');
    // The helper needs the page's own loci builder and the loaded structure,
    // so the key is rebuilt after the selection rather than before it.
    expect(html.indexOf('const lociFor =')).toBeLessThan(html.indexOf('emphasisHelpers.paintParts('));
    expect(html.indexOf('lociSelects.selectOnly')).toBeLessThan(html.indexOf('emphasisHelpers.paintParts('));
    // ...and before the fit, so the camera frames what the key just added.
    expect(html.indexOf('emphasisHelpers.paintParts(')).toBeLessThan(html.indexOf('requestCameraReset'));
    // A harness can read what was actually drawn, so a key that did not paint
    // is never silent.
    expect(html).toContain('document.body.dataset.emphasisRepainted');
    // The old promise is gone: the text is what a part that cannot be resolved
    // falls back to, not what every key gets.
    expect(html).not.toContain('The key is not repainted here');
    expect(html).toContain('It is rebuilt here as components');
    expect(html).toContain('so it is not repainted here.');
  });

  it('leaves the page a document that parses', () => {
    // The bootstrap is assembled from interpolated source strings, and a stray
    // backtick in a comment inside one of them silently truncates the template
    // rather than failing the build. The wearer would meet a blank viewer.
    const html = detailedViewHtml();
    const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
    expect(script).toContain('emphasisHelpers.paintBase(');
    expect(script).toContain('emphasisHelpers.paintParts(');
    expect(() => new Function(script)).not.toThrow();
  });
});

/**
 * `open_detailed_view`
 * answered with `http://127.0.0.1:<port>/detailed#<key>` while a headset was
 * paired. Nothing in the headset reaches loopback on the Mac, so the one tool
 * an agent had for the handoff returned an address that could move nobody.
 */
describe('which address for the full viewer the caller is actually given', () => {
  const loopback = `http://127.0.0.1:51234${DETAILED_VIEW_ROUTES.page}#${'a1b2c3d4'.repeat(8)}`;

  it('hands back the LAN share origin once a headset is paired on it', () => {
    const chosen = detailedViewAddress({ loopbackUrl: loopback,
      share: { host: '192.0.2.7', port: 8443, clients: [{ id: 'client-1' }] } });
    expect(chosen.url).toBe('https://192.0.2.7:8443/detailed');
    expect(chosen.headsetUrl).toBe('https://192.0.2.7:8443/detailed');
    expect(chosen.reachableBy).toBe('headset');
    // The Mac's own copy is not lost; it is just no longer the answer.
    expect(chosen.localUrl).toBe(loopback);
  });

  it('never puts the page key in an address a headset renders inside the wearer\u2019s view', () => {
    const chosen = detailedViewAddress({ loopbackUrl: loopback,
      share: { host: '192.0.2.7', port: 8443, clients: [{ id: 'client-1' }] } });
    expect(chosen.url).not.toContain('#');
    expect(chosen.url).not.toContain('a1b2c3d4');
  });

  it('stays on loopback for a share nobody has paired to, and for no share at all', () => {
    expect(detailedViewAddress({ loopbackUrl: loopback })).toEqual({ url: loopback, localUrl: loopback, reachableBy: 'this-mac' });
    expect(detailedViewAddress({ loopbackUrl: loopback, share: { host: '192.0.2.7', port: 8443, clients: [] } }))
      .toEqual({ url: loopback, localUrl: loopback, reachableBy: 'this-mac' });
  });

});
