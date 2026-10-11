import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import * as headsetDrive from '../scripts/headset-drive.js';
import { LanCompanion } from '../src/inspection-lan.js';
import {
  HEAVY_SCENE_ATOM_SITES, MEDIUM_SCENE_ATOM_SITES, QUEST2_TARGET_FRAME_RATE, XR_RENDER_BUDGET_ENV,
  XR_RENDER_BUDGET_PARAM, applyTargetFrameRate, automaticDetailTypeParams, beginXrRenderBudget,
  framebufferScaleFor, lastLayerScale, pickFrameRate, quest2FramebufferScale, renderBudget,
  renderBudgetEnabled, renderBudgetEnabledFrom, renderBudgetOverridesFrom, parseRenderBudgetOverrides,
  representationQualityFor, sessionDeviceClass, structureAtomSites, targetFrameRateFor, watchFrameCost,
  xrRepresentationQuality, xrResolutionScale, XR_PICK_SCALE, XR_INTERACTION_MAX_FPS,
  DESKTOP_INTERACTION_MAX_FPS, LONG_FRAME_MS, XR_SURFACE_QUALITY, XR_SURFACE_MATERIAL,
  isSurfaceRepresentation, isStandaloneHmdAgent, raiseQuality, qualityRequestFor,
  xrRepresentationMaterial,
// @ts-ignore Shared immersive render-budget implementation.
} from '../../lab/browser-roundtrip/xr-render-budget.mjs';
import {
  describeXrLayer, disableXrLayerMsaa,
// @ts-ignore Shared immersive session-request implementation.
} from '../../lab/browser-roundtrip/xr-session-request.mjs';

const QUEST2_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/39.2.0.0.56.754450099';
const QUEST3_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/39.2.0.0.56.754450099';

function fakeSession(overrides: Record<string, unknown> = {}) {
  return { inputSources: [], ...overrides } as any;
}

function fakeCanvas(props: Record<string, unknown>) {
  const applied: Array<Record<string, any>> = [];
  return {
    props,
    applied,
    setProps(next: Record<string, any>) { applied.push(next); },
  };
}

const LATTICE_SITES = 177_268;
const CRISPR_SITES = 13_121;

describe('budget table', () => {
  it('carries the driver B-side scale through the real page route into evidence identity', async () => {
    // d1bf952 fails here: the driver rejects --query before it can compose or
    // navigate the B-side URL; a parser-only assertion cannot catch that bug.
    let options!: ReturnType<typeof headsetDrive.parseDriveArguments>;
    expect(() => {
      options = headsetDrive.parseDriveArguments(['share.json', '--out', 'captures', '--query', 'xrRenderBudget=scale:0.5']);
    }, 'driver accepts the B-side --query override').not.toThrow();
    const target = { id: 'paired-tab', type: 'page', title: 'Stereofold', url: 'https://192.168.77.24:8443/viewer#pair=12345678',
      webSocketDebuggerUrl: '/devtools/page/paired-tab' };
    const driver = new headsetDrive.Driver({} as any, 'unused-adb', 0, {} as any, options);
    const gate = { proximityPositive: false, presenting: false, readAt: 'test' };
    const send = vi.fn(async (_method: string, _params?: unknown) => ({}));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(driver, 'page').mockResolvedValue({ target, session: { send } as any });
    vi.spyOn(driver, 'assertProximitySafe').mockResolvedValue(gate);
    // Replace only the TLS listener and upstream socket boundaries. The
    // captured callback runs LanCompanion's real request handler and proxy.
    let handle!: (request: IncomingMessage, response: ServerResponse) => void;
    vi.spyOn(https, 'createServer').mockImplementation(((_options: unknown, handler: typeof handle) => {
      handle = handler;
      const server = new EventEmitter() as any;
      server.setTimeout = server.unref = () => server;
      server.listen = (port: number, host: string, ready: () => void) => {
        server.address = () => ({ address: host, port }); ready();
      };
      server.close = (done: () => void) => done();
      return server;
    }) as any);
    const pageHtml = '<!doctype html><title>Stereofold viewer fixture</title>';
    const upstream = vi.spyOn(http, 'request').mockImplementation(((_options: unknown, receive: (response: IncomingMessage) => void) => {
      const request = new EventEmitter() as any;
      request.end = () => receive(Object.assign(Readable.from([pageHtml]), {
        statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      }) as IncomingMessage);
      return request;
    }) as any);
    const lan = new LanCompanion({ certificateStore: tmpdir(), remember: false,
      interfaces: () => ({ en0: [{ address: '192.168.77.24', family: 'IPv4' }] }),
      createCertificate: async () => ({ key: Buffer.from('fixture'), cert: Buffer.from('fixture'), fingerprint: 'fixture' }) });
    try {
      await lan.open({ url: `http://127.0.0.1:5000/#${'d'.repeat(64)}`, host: '192.168.77.24', port: 8443 });
      await driver.applyOpenUrl(target, async () => {});
      const effectiveUrl = headsetDrive.composeDriveUrl(target.url, options);
      expect(driver.effectiveUrl).toBe(effectiveUrl);
      expect(send).toHaveBeenLastCalledWith('Page.navigate', { url: effectiveUrl });
      const { pathname, search, host } = new URL(effectiveUrl);
      expect(`${pathname}${search}`).toBe('/viewer?xrRenderBudget=scale:0.5');
      const chunks: Buffer[] = [], headers: Record<string, unknown> = {};
      let status = 0;
      const response = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), {
        setHeader: (name: string, value: unknown) => { headers[name.toLowerCase()] = value; },
        writeHead: (code: number) => { status = code; },
      });
      await new Promise<void>((resolve, reject) => {
        response.once('finish', resolve); response.once('error', reject);
        handle(Object.assign(Readable.from([]), { method: 'GET', url: `${pathname}${search}`, headers: { host },
          socket: { remoteAddress: '192.168.77.30' } }) as unknown as IncomingMessage, response as unknown as ServerResponse);
      });
      expect(status, 'LanCompanion admits the driver-composed B-side page URL').toBe(200);
      expect(headers['content-type']).toBe('text/html; charset=utf-8');
      expect(Buffer.concat(chunks).toString('utf8')).toBe(pageHtml);
      expect(upstream).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/' }), expect.any(Function));
      expect(xrResolutionScale({ session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
        atomSites: CRISPR_SITES, scope: { location: { search } } })).toBe(0.5);
      const report = headsetDrive.buildReport({ startedAt: 'start', endedAt: 'end', gate, options, steps: [], effectiveUrl: driver.effectiveUrl });
      expect(report.evidenceIdentity.effectiveUrl, 'evidence identity retains the route-admitted B-side scale')
        .toBe('https://192.168.77.24:8443/viewer?xrRenderBudget=scale:0.5#pair=<8 digits>');
    } finally { await lan.close(); vi.restoreAllMocks(); }
  });

  const docs = readFileSync(new URL('../../docs/xr-render-budget.md', import.meta.url), 'utf8');
  const knobTable = docs.split('| Knob | Values | Default when omitted | Effect | Key aliases |')[1]
    ?.split('\n\n')[0] ?? '';
  const quotedWords = (text: string) => [...text.matchAll(/`([^`]+)`/gu)].map(match => match[1]);
  const rows = knobTable.split('\n').filter(line => line.startsWith('| `')).map(line => {
    const [, knob, values, fallback, , aliases] = line.split('|').map(cell => cell.trim());
    return { knob: quotedWords(knob)[0], values, fallback, aliases: quotedWords(aliases) };
  });
  const fields: Record<string, string> = {
    scale: 'framebufferScale', foveation: 'foveation', fps: 'targetFrameRate',
    quality: 'representationQuality', surface: 'surfaceQuality', gloss: 'surfaceGloss',
    rough: 'surfaceRoughness', palette: 'surfacePalette', light: 'lighting', marking: 'marking',
    pick: 'pickScale', hover: 'interactionMaxFps', postfx: 'postprocessing', cost: 'frameCost',
    molstarPanel: 'molstarPanel', governor: 'governor', governorFloor: 'governorFloor', msaa: 'msaa',
  };
  const onValues = ['on', ...quotedWords(docs.match(/`on` also accepts ([^;]+);/u)?.[1] ?? '')];
  const offValues = ['off', ...quotedWords(docs.match(/`off` also accepts ([^.]+)\./u)?.[1] ?? '')];

  it('lists every parser knob and alias with the same spelling in the table and driver usage', () => {
    const usage = headsetDrive.DRIVE_USAGE.split('xrRenderBudget accepts')[1].split('  on aliases:')[0];
    const usageKnobs = [...usage.matchAll(/(?:^|\n|;)\s*([a-zA-Z]+(?:, [a-zA-Z]+)*):/gu)]
      .flatMap(match => match[1].split(', '));
    expect(rows.map(row => row.knob).sort()).toEqual(usageKnobs.sort());
    expect(rows.map(row => row.knob).sort()).toEqual(Object.keys(fields).sort());
    const usageAliases = headsetDrive.DRIVE_USAGE.split('Key aliases (canonical=aliases):')[1]
      .split('  Example:')[0];
    expect(Object.fromEntries([...usageAliases.matchAll(/(\w+)=([\w,]+)/gu)]
      .map(match => [match[1], match[2].split(',')]))).toEqual(
      Object.fromEntries(rows.filter(row => row.aliases.length).map(row => [row.knob, row.aliases])));
    const source = readFileSync(new URL('../../lab/browser-roundtrip/xr-render-budget.mjs', import.meta.url), 'utf8');
    const parser = source.split('function applyOverridePair(')[1].split('/** The knob list')[0];
    const parserKeys = [...parser.matchAll(/case '([^']+)':/gu)].map(match => match[1]);
    expect(rows.flatMap(row => [row.knob.toLowerCase(), ...row.aliases]).sort()).toEqual(parserKeys.sort());
    // Include the parser's entire enum vocabulary in the boundary probes, so
    // deleting a valid value from the documentation also fails the test.
    for (const [constant, documented] of [['ON_VALUES', onValues], ['OFF_VALUES', offValues]] as const) {
      const declaration = source.match(new RegExp(`const ${constant} = Object.freeze\\(\\[([^\\]]+)`))![1];
      expect(documented).toEqual([...declaration.matchAll(/'([^']+)'/gu)].map(match => match[1]));
    }
    expect(parseRenderBudgetOverrides('')).toEqual({ enabled: true, unknown: [] });
    expect(docs).toContain('every omitted knob unset (`undefined`)');
    for (const row of rows) expect(row.fallback, `${row.knob} has a default`).not.toBe('');
  });

  it.each(rows)('matches every documented $knob value and numeric boundary against the parser', row => {
    const field = fields[row.knob];
    const range = row.values.match(/^(\d+) (<|<=) number(?: <= (\d+))?/u);
    const lower = range ? Number(range[1]) : 0;
    const upper = range?.[3] ? Number(range[3]) : Infinity;
    const words = quotedWords(row.values).flatMap(value => value === 'on' ? onValues : value === 'off' ? offValues : [value]);
    expect(Boolean(range) || words.length > 0, 'documented accepted values').toBe(true);
    const probes = new Set([
      ...words, ...onValues, ...offValues,
      'auto', 'highest', 'higher', 'high', 'medium', 'low', 'lower', 'lowest', 'custom',
      '', 'banana', 'ultra', 'gpu', 'maybe', 'NaN', 'Infinity', '-Infinity',
      '0.0', '1.0', '0.5junk', '1e309', '1e-309', '-1e309',
      ...[lower - 0.01, lower, lower + 0.01, 1, 60, 60.01, Number.MAX_VALUE].map(String),
      ...(Number.isFinite(upper) ? [upper - 0.01, upper, upper + 0.01].map(String) : []),
    ]);
    for (const value of probes) {
      let expected: unknown;
      if (words.includes(value)) {
        if (row.knob === 'cost') expected = value;
        else if (onValues.includes(value)) expected = row.knob === 'hover' ? 30 : true;
        else if (offValues.includes(value)) expected = row.knob === 'hover' ? 0
          : ['fps', 'surface'].includes(row.knob) ? null : false;
        else expected = value;
      } else if (range) {
        const number = Number.parseFloat(value.toLowerCase());
        const aboveLower = range[2] === '<' ? number > lower : number >= lower;
        if (aboveLower && number <= upper) expected = number;
      }
      for (const knob of [row.knob, ...row.aliases]) {
        const parsed = parseRenderBudgetOverrides(`${knob}:${value}`);
        expect(parsed.unknown, `${knob} is recognized`).toEqual([]);
        expect(parsed[field], `${knob}:${value} matches the documented values`).toBe(expected);
      }
    }
  });

  it('steps the Quest 2 layer scale down by scene size and keeps every other class native', () => {
    expect(MEDIUM_SCENE_ATOM_SITES).toBe(8_000);
    expect(HEAVY_SCENE_ATOM_SITES).toBe(25_000);
    expect(framebufferScaleFor('quest2')).toBe(0.8);
    expect(framebufferScaleFor('quest2', 0)).toBe(0.8);
    expect(framebufferScaleFor('quest2', MEDIUM_SCENE_ATOM_SITES - 1)).toBe(0.8);
    expect(framebufferScaleFor('quest2', MEDIUM_SCENE_ATOM_SITES)).toBe(0.6);
    // 9KJ6, the CRISPR demo, at 13,121 atom sites. It held 50-67 fps at 0.7
    // on hardware against a 72 Hz request, so the middle tier stepped down.
    expect(framebufferScaleFor('quest2', CRISPR_SITES)).toBe(0.6);
    expect(framebufferScaleFor('quest2', HEAVY_SCENE_ATOM_SITES)).toBe(0.6);
    expect(framebufferScaleFor('quest2', HEAVY_SCENE_ATOM_SITES + 1)).toBe(0.5);
    expect(framebufferScaleFor('quest2', LATTICE_SITES)).toBe(0.5);
    expect(quest2FramebufferScale(-5)).toBe(0.8);
    for (const device of ['quest3', 'quest-pro', 'vision-pro', 'hand-only', 'unknown']) {
      expect(framebufferScaleFor(device, LATTICE_SITES)).toBe(1);
    }
  });

  it('asks a Quest 2 for 72 Hz on every scene, however small', () => {
    expect(QUEST2_TARGET_FRAME_RATE).toBe(72);
    expect(targetFrameRateFor('quest2')).toBe(72);
    for (const sites of [0, 1, CRISPR_SITES, HEAVY_SCENE_ATOM_SITES, LATTICE_SITES]) {
      expect(renderBudget({ device: 'quest2', atomSites: sites }).targetFrameRate).toBe(72);
    }
    expect(targetFrameRateFor('quest3')).toBeNull();
    expect(targetFrameRateFor('unknown')).toBeNull();
  });

  it('reports the foveation level the session-request module applies', () => {
    expect(renderBudget({ device: 'quest2', atomSites: LATTICE_SITES }).foveation).toBe(1);
    expect(renderBudget({ device: 'quest3', atomSites: LATTICE_SITES }).foveation).toBe(0.5);
    expect(renderBudget({ device: 'vision-pro', atomSites: 100 }).foveation).toBeNull();
  });

  it('describes the 5SYF lattice on a Quest 2 and on a Quest 3', () => {
    expect(renderBudget({ device: 'quest2', atomSites: LATTICE_SITES })).toEqual({
      device: 'quest2', atomSites: LATTICE_SITES, heavyScene: true, framebufferScale: 0.5,
      foveation: 1, targetFrameRate: 72, disablePostprocessing: true, disableIllumination: true,
      disableMultiSample: true, representationQuality: 'low', marking: false, pickScale: 0.125,
      interactionMaxFps: 0,
    });
    expect(renderBudget({ device: 'quest2', atomSites: CRISPR_SITES })).toMatchObject({
      heavyScene: false, framebufferScale: 0.6, targetFrameRate: 72, foveation: 1,
      representationQuality: 'low', marking: false, pickScale: 0.125,
    });
    expect(renderBudget({ device: 'quest3', atomSites: LATTICE_SITES })).toMatchObject({
      framebufferScale: 1, targetFrameRate: null, heavyScene: true,
    });
  });

  it('treats a missing or negative site count as an empty scene', () => {
    expect(renderBudget().atomSites).toBe(0);
    expect(renderBudget({ device: 'quest2', atomSites: -5 })).toMatchObject({ atomSites: 0, heavyScene: false });
  });

  it('keeps the Automatic Detail distances out of the shipped cartoon path', () => {
    expect(automaticDetailTypeParams().cartoon.lod).toEqual([-20, 300, 100]);
    expect(automaticDetailTypeParams().ballAndStick.lod).toEqual([-20, 40, 20]);
  });
});

describe('frame-rate negotiation', () => {
  it('prefers an exact rate, then the highest supported rate below the request', () => {
    expect(pickFrameRate([72, 80, 90], 72)).toBe(72);
    expect(pickFrameRate([60, 80, 90], 72)).toBe(60);
    expect(pickFrameRate([90, 120], 72)).toBeNull();
    expect(pickFrameRate(undefined, 72)).toBe(72);
    expect(pickFrameRate([72], undefined)).toBeNull();
  });

  it('sends the rate through updateTargetFrameRate and swallows a rejected promise', async () => {
    const sent: number[] = [];
    const session = fakeSession({
      supportedFrameRates: [72, 90],
      updateTargetFrameRate: (rate: number) => { sent.push(rate); return Promise.reject(new Error('refused')); },
    });
    expect(applyTargetFrameRate(session, 72)).toEqual({ requested: 72, sent: 72, reason: 'sent' });
    expect(sent).toEqual([72]);
    await Promise.resolve();
  });

  it('reports a runtime without the API instead of throwing', () => {
    expect(applyTargetFrameRate(fakeSession(), 72)).toEqual({ requested: 72, sent: null, reason: 'unsupported' });
    expect(applyTargetFrameRate(fakeSession({ updateTargetFrameRate: () => { throw new Error('no'); } }), 72))
      .toEqual({ requested: 72, sent: null, reason: 'refused' });
    expect(applyTargetFrameRate(fakeSession({ supportedFrameRates: [90], updateTargetFrameRate: () => {} }), 72))
      .toEqual({ requested: 72, sent: null, reason: 'no-supported-rate' });
  });

  it('does not touch the session when the budget asks for no rate', () => {
    let called = false;
    const session = fakeSession({ updateTargetFrameRate: () => { called = true; } });
    expect(applyTargetFrameRate(session, null)).toEqual({ requested: null, sent: null, reason: 'not-requested' });
    expect(called).toBe(false);
  });
});

describe('override', () => {
  it('stays on without an override and off for every documented off value', () => {
    expect(renderBudgetEnabledFrom({})).toBe(true);
    expect(renderBudgetEnabledFrom({ search: '?other=1' })).toBe(true);
    expect(renderBudgetEnabledFrom({ search: `?${XR_RENDER_BUDGET_PARAM}=on` })).toBe(true);
    for (const value of ['off', '0', 'false', 'no', 'disabled', 'OFF']) {
      expect(renderBudgetEnabledFrom({ search: `?${XR_RENDER_BUDGET_PARAM}=${value}` })).toBe(false);
      expect(renderBudgetEnabledFrom({ env: value })).toBe(false);
    }
  });

  it('lets the environment variable outrank the query parameter', () => {
    expect(renderBudgetEnabledFrom({ search: `?${XR_RENDER_BUDGET_PARAM}=off`, env: 'on' })).toBe(true);
  });

  it('reads the live page and process through one scope object', () => {
    expect(renderBudgetEnabled({ location: { search: `?${XR_RENDER_BUDGET_PARAM}=off` } })).toBe(false);
    expect(renderBudgetEnabled({ process: { env: { [XR_RENDER_BUDGET_ENV]: 'off' } } })).toBe(false);
    expect(renderBudgetEnabled({})).toBe(true);
  });
});

describe('scene size and device class', () => {
  it('sums atom sites across the loaded structures', () => {
    const plugin = { managers: { structure: { hierarchy: { current: { structures: [
      { cell: { obj: { data: { elementCount: 22_542 } } } },
      { cell: { obj: { data: { elementCount: 5_800 } } } },
      { cell: { obj: undefined } },
    ] } } } } };
    expect(structureAtomSites(plugin)).toBe(28_342);
    expect(structureAtomSites(undefined)).toBe(0);
    expect(structureAtomSites({ managers: {} })).toBe(0);
  });

  it('classifies the headset from the user agent when input sources are empty', () => {
    expect(sessionDeviceClass(fakeSession(), { userAgent: QUEST2_AGENT })).toBe('quest2');
    expect(sessionDeviceClass(fakeSession(), { userAgent: QUEST3_AGENT })).toBe('quest3');
    expect(sessionDeviceClass(fakeSession(), { userAgent: 'Mozilla/5.0' })).toBe('unknown');
  });

  it('derives the layer scale a Quest 2 session should build its layer with', () => {
    const plugin = { managers: { structure: { hierarchy: { current: { structures: [
      { cell: { obj: { data: { elementCount: LATTICE_SITES } } } },
    ] } } } } };
    expect(xrResolutionScale({ session: fakeSession(), plugin, navigator: { userAgent: QUEST2_AGENT }, scope: {} })).toBe(0.5);
    expect(lastLayerScale()).toBe(0.5);
    expect(xrResolutionScale({ session: fakeSession(), plugin, navigator: { userAgent: QUEST3_AGENT }, scope: {} })).toBe(1);
    expect(xrResolutionScale({ session: fakeSession(), plugin, navigator: { userAgent: QUEST2_AGENT },
      scope: { location: { search: `?${XR_RENDER_BUDGET_PARAM}=off` } } })).toBe(1);
    expect(lastLayerScale()).toBe(1);
  });

  it('builds the CRISPR demo layer one step down from the lightest tier', () => {
    const plugin = { managers: { structure: { hierarchy: { current: { structures: [
      { cell: { obj: { data: { elementCount: CRISPR_SITES } } } },
    ] } } } } };
    expect(xrResolutionScale({ session: fakeSession(), plugin, navigator: { userAgent: QUEST2_AGENT }, scope: {} })).toBe(0.6);
  });
});

describe('session toggling', () => {
  const baseProps = () => ({
    postprocessing: { enabled: true, antialiasing: { name: 'smaa', params: { edgeThreshold: 0.1 } },
      occlusion: { name: 'on', params: { samples: 32 } }, outline: { name: 'on', params: { scale: 1 } } },
    illumination: { enabled: true },
    multiSample: { mode: 'temporal' },
    xr: { disablePostprocessing: false },
  });

  it('turns every intermediate pass off while the session presents', () => {
    const canvas = fakeCanvas(baseProps());
    const handle = beginXrRenderBudget({ canvas, session: fakeSession({ supportedFrameRates: [72, 90],
      updateTargetFrameRate: () => {} }), navigator: { userAgent: QUEST2_AGENT }, atomSites: LATTICE_SITES, scope: {} });
    expect(handle.applied).toBe(true);
    expect(handle.frameRate).toEqual({ requested: 72, sent: 72, reason: 'sent' });
    expect(canvas.applied).toHaveLength(1);
    expect(canvas.applied[0]).toEqual({
      xr: { disablePostprocessing: true },
      postprocessing: { enabled: false, antialiasing: { name: 'off', params: {} },
        occlusion: { name: 'off', params: {} }, outline: { name: 'off', params: {} } },
      illumination: { enabled: false },
      multiSample: { mode: 'off' },
      marking: { enabled: false },
      pickScale: 0.125,
      interaction: { maxFps: 0 },
      pointer: { enabled: 'off' },
    });
  });

  it('restores the exact pass configuration it read, once', () => {
    const before = baseProps();
    const canvas = fakeCanvas(before);
    const handle = beginXrRenderBudget({ canvas, session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      atomSites: LATTICE_SITES, scope: {} });
    handle.restore();
    handle.restore();
    expect(canvas.applied).toHaveLength(2);
    // Every pass comes back as it was read, plus the Mol* interaction default
    // for the rate the canvas never reported.
    expect(canvas.applied[1]).toEqual({ ...before, interaction: { maxFps: DESKTOP_INTERACTION_MAX_FPS } });
  });

  it('restores the Mol* hover rate when the canvas never reported one', () => {
    // Mol* keeps `maxFps` on the interaction helper, so a canvas can come back
    // with no `interaction` group at all. Left undefined it would be dropped
    // from the restore and the desktop panel would keep the immersive 0,
    // which is hover off for the rest of the page's life.
    const canvas = fakeCanvas({ postprocessing: { enabled: true } });
    const handle = beginXrRenderBudget({ canvas, session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      atomSites: CRISPR_SITES, scope: {} });
    expect(canvas.applied[0].interaction).toEqual({ maxFps: 0 });
    handle.restore();
    expect(canvas.applied[1].interaction).toEqual({ maxFps: 30 });
    expect(DESKTOP_INTERACTION_MAX_FPS).toBe(30);
  });

  it('restores only the props the canvas actually reported', () => {
    const canvas = fakeCanvas({ postprocessing: { enabled: true }, multiSample: {} });
    const handle = beginXrRenderBudget({ canvas, session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      atomSites: 100, scope: {} });
    handle.restore();
    expect(canvas.applied[1]).toEqual({ postprocessing: { enabled: true },
      interaction: { maxFps: DESKTOP_INTERACTION_MAX_FPS } });
  });

  it('turns the controller-ray mesh off and puts the reported setting back', () => {
    const canvas = fakeCanvas({ pointer: { enabled: 'on' }, interaction: { maxFps: 30 } });
    const handle = beginXrRenderBudget({ canvas, session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      atomSites: CRISPR_SITES, scope: {} });
    expect(canvas.applied[0].pointer).toEqual({ enabled: 'off' });
    handle.restore();
    expect(canvas.applied[1].pointer).toEqual({ enabled: 'on' });
  });

  it('changes nothing when the override is off', () => {
    const canvas = fakeCanvas(baseProps());
    let rateCalls = 0;
    const handle = beginXrRenderBudget({ canvas,
      session: fakeSession({ supportedFrameRates: [72], updateTargetFrameRate: () => { rateCalls += 1; } }),
      navigator: { userAgent: QUEST2_AGENT }, atomSites: LATTICE_SITES,
      scope: { location: { search: `?${XR_RENDER_BUDGET_PARAM}=off` } } });
    expect(handle.applied).toBe(false);
    expect(handle.frameRate.reason).toBe('disabled');
    expect(handle.budget.targetFrameRate).toBe(72);
    handle.restore();
    expect(canvas.applied).toHaveLength(0);
    expect(rateCalls).toBe(0);
  });

  it('puts the chosen budget on the diagnostics ring for read_headset_log', () => {
    const entries: Array<{ kind: string; detail: any }> = [];
    const scope = { __stereofoldDiagnostics: { record: (kind: string, detail: any) => { entries.push({ kind, detail }); } } };
    const canvas = fakeCanvas(baseProps());
    beginXrRenderBudget({ canvas, session: fakeSession({ supportedFrameRates: [72, 90], updateTargetFrameRate: () => {} }),
      navigator: { userAgent: QUEST2_AGENT }, atomSites: CRISPR_SITES, scope });
    const rendered = entries.find(entry => entry.kind === 'render-budget');
    expect(rendered?.detail).toMatchObject({
      device: 'quest2', atomSites: CRISPR_SITES, framebufferScale: 0.6, foveation: 1,
      targetFrameRate: 72, sentFrameRate: 72, frameRateReason: 'sent', applied: true,
      quality: 'low', marking: false, pickScale: 0.125, overrides: 'none',
    });
    expect(entries.find(entry => entry.kind === 'session-frame-rate')?.detail).toMatchObject({
      event: 'granted', supportedFrameRates: [72, 90], reportedFrameRate: null,
    });
  });

  it('records the A/B run the override turned off', () => {
    const entries: Array<{ kind: string; detail: any }> = [];
    const scope = { __stereofoldDiagnostics: { record: (kind: string, detail: any) => { entries.push({ kind, detail }); } },
      location: { search: `?${XR_RENDER_BUDGET_PARAM}=off` } };
    beginXrRenderBudget({ canvas: fakeCanvas(baseProps()), session: fakeSession(),
      navigator: { userAgent: QUEST2_AGENT }, atomSites: LATTICE_SITES, scope });
    expect(entries.find(entry => entry.kind === 'render-budget')?.detail)
      .toMatchObject({ applied: false, frameRateReason: 'disabled', framebufferScale: 0.5 });
  });

  it('survives a recorder that throws and a plugin with no Canvas3D', () => {
    const scope = { __stereofoldDiagnostics: { record() { throw new Error('ring gone'); } } };
    expect(() => beginXrRenderBudget({ canvas: fakeCanvas(baseProps()), session: fakeSession(),
      navigator: { userAgent: QUEST2_AGENT }, atomSites: 100, scope })).not.toThrow();
  });

  it('survives a plugin with no Canvas3D and a canvas that throws', () => {
    expect(beginXrRenderBudget({ plugin: {}, session: fakeSession(), scope: {} }))
      .toMatchObject({ applied: false, frameRate: { reason: 'no-canvas' } });
    const throwing = { props: baseProps(), setProps() { throw new Error('context lost'); } };
    const handle = beginXrRenderBudget({ canvas: throwing, session: fakeSession(),
      navigator: { userAgent: QUEST2_AGENT }, atomSites: LATTICE_SITES, scope: {} });
    expect(handle.applied).toBe(true);
    expect(() => handle.restore()).not.toThrow();
  });
});

describe('render budget knobs', () => {
  const P = XR_RENDER_BUDGET_PARAM;

  it('keeps the boolean escape and reads a knob list beside it', () => {
    expect(parseRenderBudgetOverrides('off').enabled).toBe(false);
    expect(parseRenderBudgetOverrides('').enabled).toBe(true);
    const tuned = parseRenderBudgetOverrides('scale:0.5;quality:lowest,marking=on;pick:0.5;fps:90;foveation:0.25;postfx:on;cost:off');
    expect(tuned).toMatchObject({
      enabled: true, framebufferScale: 0.5, representationQuality: 'lowest', marking: true,
      pickScale: 0.5, targetFrameRate: 90, foveation: 0.25, postprocessing: true, frameCost: 'off',
    });
    // `cost:gpu` forced the disjoint-timer-query poll, which Chromium disables
    // on Quest. The knob went with it and is now dropped like any other value.
    expect(parseRenderBudgetOverrides('cost:gpu').frameCost).toBeUndefined();
    expect(tuned.unknown).toEqual([]);
  });

  it('drops a knob it cannot read instead of failing the session', () => {
    const tuned = parseRenderBudgetOverrides('scale:banana,quality:ultra,pick:9,nonsense:1,foveation:4');
    expect(tuned.enabled).toBe(true);
    expect(tuned.framebufferScale).toBeUndefined();
    expect(tuned.representationQuality).toBeUndefined();
    expect(tuned.pickScale).toBeUndefined();
    expect(tuned.foveation).toBeUndefined();
    expect(tuned.unknown).toEqual(['nonsense']);
  });

  it('turns the frame-rate request off with fps:off', () => {
    expect(parseRenderBudgetOverrides('fps:off').targetFrameRate).toBeNull();
    expect(renderBudget({ device: 'quest2', atomSites: CRISPR_SITES,
      overrides: parseRenderBudgetOverrides('fps:off') }).targetFrameRate).toBeNull();
  });

  it('lets each knob outrank the tier the device class chose', () => {
    const overrides = renderBudgetOverridesFrom({ search: `?${P}=scale:0.45,quality:medium,marking:on,pick:0.3` });
    expect(renderBudget({ device: 'quest2', atomSites: CRISPR_SITES, overrides })).toMatchObject({
      framebufferScale: 0.45, representationQuality: 'medium', marking: true, pickScale: 0.3,
    });
  });

  it('builds the layer at the scale the knob names', () => {
    expect(xrResolutionScale({ session: fakeSession(), navigator: { userAgent: QUEST2_AGENT }, atomSites: CRISPR_SITES,
      scope: { location: { search: `?${P}=scale:0.4` } } })).toBe(0.4);
  });

  // postfx:on used to leave every pass at whatever the
  // desktop panel had, which meant a Quest 2 silently inherited Mol*'s SMAA
  // and bloom defaults. It now states the immersive pass list instead.
  it('states the immersive pass list under postfx:on and still lowers the pick buffer', () => {
    const canvas = fakeCanvas({ postprocessing: { enabled: true }, marking: { enabled: true }, pickScale: 0.25 });
    beginXrRenderBudget({ canvas, session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      atomSites: CRISPR_SITES, scope: { location: { search: `?${P}=postfx:on` } } });
    const applied = canvas.applied[0] as any;
    expect(applied.marking).toEqual({ enabled: false });
    expect(applied.pickScale).toBe(XR_PICK_SCALE);
    expect(applied.interaction).toEqual({ maxFps: XR_INTERACTION_MAX_FPS });
    expect(applied.pointer).toEqual({ enabled: 'off' });
    expect(applied.xr).toEqual({ disablePostprocessing: false });
    expect(applied.postprocessing.enabled).toBe(true);
    expect(applied.postprocessing.occlusion.name).toBe('on');
    expect(applied.postprocessing.outline.name).toBe('on');
    for (const pass of ['antialiasing', 'bloom', 'shadow', 'dof', 'sharpening']) {
      expect(applied.postprocessing[pass].name).toBe('off');
    }
    expect(applied.illumination).toEqual({ enabled: false });
  });

  it('names the knobs the wearer turned on in the diagnostics entry', () => {
    const entries: Array<{ kind: string; detail: any }> = [];
    const scope = { __stereofoldDiagnostics: { record: (kind: string, detail: any) => { entries.push({ kind, detail }); } },
      location: { search: `?${P}=scale:0.5,marking:on` } };
    beginXrRenderBudget({ canvas: fakeCanvas({}), session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      atomSites: CRISPR_SITES, scope });
    expect(entries.find(entry => entry.kind === 'render-budget')?.detail.overrides).toBe('framebufferScale,marking');
  });
});

describe('representation quality', () => {
  it('builds Quest geometry at a lower quality than the desktop default', () => {
    expect(representationQualityFor('quest2')).toBe('low');
    expect(representationQualityFor('quest3')).toBe('medium');
    expect(representationQualityFor('vision-pro')).toBeNull();
  });

  it('leaves Mol* on auto off a headset and under the off escape', () => {
    expect(xrRepresentationQuality({ presenting: false, scope: {} })).toBeNull();
    expect(xrRepresentationQuality({ navigator: { userAgent: QUEST2_AGENT },
      scope: { location: { search: `?${XR_RENDER_BUDGET_PARAM}=off` } } })).toBeNull();
    expect(xrRepresentationQuality({ navigator: { userAgent: QUEST2_AGENT },
      scope: { location: { search: `?${XR_RENDER_BUDGET_PARAM}=quality:auto` } } })).toBeNull();
  });

  it('reads the quality knob and otherwise the device class', () => {
    expect(xrRepresentationQuality({ session: fakeSession(), navigator: { userAgent: QUEST2_AGENT }, scope: {} })).toBe('low');
    expect(xrRepresentationQuality({ session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      scope: { location: { search: `?${XR_RENDER_BUDGET_PARAM}=quality:lowest` } } })).toBe('lowest');
  });
});

describe('surface quality', () => {
  const surface = (search?: string, agent = QUEST2_AGENT) => xrRepresentationQuality({
    session: fakeSession(), navigator: { userAgent: agent }, representation: 'molecular-surface',
    scope: search ? { location: { search } } : {},
  });

  it('names every representation whose tier is a grid resolution', () => {
    expect(isSurfaceRepresentation('molecular-surface')).toBe(true);
    expect(isSurfaceRepresentation('gaussian_surface')).toBe(true);
    expect(isSurfaceRepresentation('Gaussian-Surface')).toBe(true);
    expect(isSurfaceRepresentation('cartoon')).toBe(false);
    expect(isSurfaceRepresentation('ball-and-stick')).toBe(false);
    expect(isSurfaceRepresentation(undefined)).toBe(false);
  });

  it('recognises the browsers Mol* demotes a quality tier on', () => {
    expect(isStandaloneHmdAgent(QUEST2_AGENT)).toBe(true);
    expect(isStandaloneHmdAgent({ userAgent: QUEST3_AGENT })).toBe(true);
    expect(isStandaloneHmdAgent('Mozilla/5.0 (Macintosh) Chrome/141.0.0.0')).toBe(false);
    expect(isStandaloneHmdAgent(undefined)).toBe(false);
  });

  it('steps a tier up the Mol* ladder and clamps at the top', () => {
    expect(raiseQuality('lower')).toBe('low');
    expect(raiseQuality('low')).toBe('medium');
    expect(raiseQuality('highest')).toBe('highest');
    expect(raiseQuality('custom')).toBe('custom');
  });

  // mol-repr/util.js:127-131 lowers an explicit tier by one on a Quest, so the
  // request has to be one higher there and unchanged everywhere else.
  it('asks a headset for one tier above the tier it should build', () => {
    expect(qualityRequestFor(XR_SURFACE_QUALITY, QUEST2_AGENT)).toBe('medium');
    expect(qualityRequestFor(XR_SURFACE_QUALITY, 'Mozilla/5.0 (Macintosh) Chrome/141.0.0.0')).toBe('low');
  });

  it('gives a surface its own tier and leaves every other representation alone', () => {
    expect(surface()).toBe('medium');
    expect(xrRepresentationQuality({ session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      representation: 'cartoon', scope: {} })).toBe('low');
    expect(xrRepresentationQuality({ session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      scope: {} })).toBe('low');
  });

  it('lets the hardware A/B move or drop the surface tier', () => {
    expect(surface(`?${XR_RENDER_BUDGET_PARAM}=surface:lower`)).toBe('low');
    expect(surface(`?${XR_RENDER_BUDGET_PARAM}=surface:medium`)).toBe('high');
    expect(surface(`?${XR_RENDER_BUDGET_PARAM}=surface:auto`)).toBeNull();
    expect(surface(`?${XR_RENDER_BUDGET_PARAM}=surface:off`)).toBe('low');
    // The blunt `quality:` knob still wins over the representation rule.
    expect(surface(`?${XR_RENDER_BUDGET_PARAM}=quality:lowest,surface:medium`)).toBe('lowest');
    expect(surface(`?${XR_RENDER_BUDGET_PARAM}=off`)).toBeNull();
  });

  it('parses the surface knob and reports an unreadable one', () => {
    expect(parseRenderBudgetOverrides('surface:medium').surfaceQuality).toBe('medium');
    expect(parseRenderBudgetOverrides('surfacequality:off').surfaceQuality).toBeNull();
    expect(parseRenderBudgetOverrides('surface:enormous').surfaceQuality).toBeUndefined();
    expect(parseRenderBudgetOverrides('surface:enormous').unknown).toEqual([]);
  });

  it('keeps a device with no tier of its own on Mol* auto', () => {
    expect(xrRepresentationQuality({ session: fakeSession(),
      navigator: { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/141.0.0.0' },
      representation: 'molecular-surface', scope: {} })).toBeNull();
  });

  // A tight specular lobe on a surface against Mol*'s "Matte" default. The
  // physical BRDF runs per fragment either way, so this is a depth cue that
  // costs nothing. 0.28 rather than the "Glossy" preset's 0.6 because the
  // shader adds a screen-space geometry roughness of its own on a gaussian
  // surface, which widened the lobe into a wash - see `XR_SURFACE_MATERIAL`.
  it('wears a tight specular material on a surface and nothing elsewhere', () => {
    expect(xrRepresentationMaterial({ representation: 'molecular-surface', scope: {} }))
      .toEqual({ metalness: 0, roughness: 0.28, bumpiness: 0 });
    expect(XR_SURFACE_MATERIAL.bumpiness).toBe(0);
    // The density isosurface is a marching-cubes mesh with the
    // same fill-bound shading problem, so it wears the same gloss.
    expect(xrRepresentationMaterial({ representation: 'isosurface', scope: {} }))
      .toEqual({ metalness: 0, roughness: 0.28, bumpiness: 0 });
    expect(xrRepresentationMaterial({ representation: 'cartoon', scope: {} })).toBeNull();
    expect(xrRepresentationMaterial({ representation: 'molecular-surface', presenting: false, scope: {} })).toBeNull();
    expect(xrRepresentationMaterial({ representation: 'molecular-surface',
      scope: { location: { search: `?${XR_RENDER_BUDGET_PARAM}=gloss:off` } } })).toBeNull();
    expect(xrRepresentationMaterial({ representation: 'molecular-surface',
      scope: { location: { search: `?${XR_RENDER_BUDGET_PARAM}=off` } } })).toBeNull();
  });
});

describe('frame cost', () => {
  function frameLoop() {
    const queued: Array<(time: number, frame: unknown) => void> = [];
    const session: any = { requestAnimationFrame: (cb: any) => { queued.push(cb); return queued.length; } };
    return { session, run: (time: number) => queued[queued.length - 1](time, null) };
  }

  it('records a sample once the interval elapses and separates draw from overlay', () => {
    const entries: Array<{ kind: string; detail: any }> = [];
    const { session, run } = frameLoop();
    let clock = 0;
    const cost = watchFrameCost({ session, record: (kind: string, detail: any) => { entries.push({ kind, detail }); },
      now: () => clock, intervalMs: 1_000, scope: {} });
    expect(cost.supported).toBe(true);
    // 25 frames, each 6 ms of Mol* draw plus 4 ms of overlay, 50 ms apart.
    for (let i = 0; i < 25; i += 1) {
      session.requestAnimationFrame(() => { clock += 6; cost.measure(() => { clock += 4; }); });
      run(clock);
      clock += 40;
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('frame-cost');
    expect(entries[0].detail).toMatchObject({
      callbackCount: 21, frameMs: 10, drawMs: 6, overlayMs: 4, maxFrameMs: 10, longFrames: 0,
      callbacksPerSecond: 20.8,
    });
    // The GPU timer is gone: Chromium disables the extension it needed.
    expect(entries[0].detail).not.toHaveProperty('fps');
    expect(entries[0].detail).not.toHaveProperty('frames');
    expect(entries[0].detail).not.toHaveProperty('gpu');
    expect(entries[0].detail).not.toHaveProperty('gpuMs');
  });

  it('counts a frame that missed every Quest window', () => {
    const entries: Array<{ kind: string; detail: any }> = [];
    const { session, run } = frameLoop();
    let clock = 0;
    const cost = watchFrameCost({ session, record: (kind: string, detail: any) => { entries.push({ kind, detail }); },
      now: () => clock, intervalMs: 100, scope: {} });
    session.requestAnimationFrame(() => { clock += 250; });
    run(clock);
    expect(LONG_FRAME_MS).toBe(20);
    expect(entries[0].detail).toMatchObject({ longFrames: 1, maxFrameMs: 250, callbackCount: 1 });
    cost.stop();
  });

  it('reports both subscribers together per unique XR timestamp without changing callback averages', () => {
    const entries: Array<{ kind: string; detail: any }> = [];
    const { session, run } = frameLoop();
    let clock = 0;
    const cost = watchFrameCost({ session, record: (kind: string, detail: any) => entries.push({ kind, detail }),
      now: () => clock, intervalMs: 100, scope: {} });
    for (const timestamp of [0, 90]) {
      clock = timestamp;
      session.requestAnimationFrame(() => { clock += 6; cost.measure(() => { clock += 2; }); });
      run(timestamp);
      session.requestAnimationFrame(() => cost.measure(() => { clock += 2; }));
      run(timestamp);
    }
    expect(entries).toHaveLength(1);
    expect(entries[0].detail).toMatchObject({
      callbackCount: 4, uniqueFrameCount: 2, callbackCpuMs: 20, overlayCpuMs: 8,
      cpuPerUniqueFrameMs: 10, overlayPerUniqueFrameMs: 4,
      frameMs: 5, drawMs: 3, overlayMs: 2, gpuMeasured: false,
    });
    cost.stop();
  });

  it('reports unknown per-frame CPU when callbacks have no finite XR timestamps', () => {
    const entries: Array<{ kind: string; detail: any }> = [];
    const { session, run } = frameLoop();
    let clock = 0;
    const cost = watchFrameCost({ session, record: (kind: string, detail: any) => entries.push({ kind, detail }),
      now: () => clock, intervalMs: 10, scope: {} });
    session.requestAnimationFrame(() => { clock += 6; cost.measure(() => { clock += 4; }); });
    run(Number.NaN);
    expect(entries[0].detail).toMatchObject({
      callbackCount: 1, uniqueFrameCount: 0, callbackCpuMs: 10, overlayCpuMs: 4,
      cpuPerUniqueFrameMs: null, overlayPerUniqueFrameMs: null,
      frameMs: 10, overlayMs: 4, gpuMeasured: false,
    });
    cost.stop();
  });

  it('restores the session frame hook on stop and stays inert with no recorder', () => {
    const session: any = { requestAnimationFrame: () => 1 };
    const before = session.requestAnimationFrame;
    const cost = watchFrameCost({ session, record: () => {}, scope: {} });
    expect(session.requestAnimationFrame).not.toBe(before);
    cost.stop();
    expect(session.requestAnimationFrame).toBe(before);
    const inert = watchFrameCost({ session: { requestAnimationFrame: () => 1 }, scope: {} });
    expect(inert.supported).toBe(false);
    expect(inert.measure(() => 7)).toBe(7);
  });

  it('does not sample when the cost knob is off', () => {
    const session: any = { requestAnimationFrame: () => 1 };
    const before = session.requestAnimationFrame;
    const cost = watchFrameCost({ session, record: () => {},
      scope: { location: { search: `?${XR_RENDER_BUDGET_PARAM}=cost:off` } } });
    expect(cost.supported).toBe(false);
    expect(session.requestAnimationFrame).toBe(before);
  });
});

describe('XR layer options', () => {
  it('builds a known Quest layer without MSAA so fixed foveation can run', () => {
    const built: Array<Record<string, unknown>> = [];
    class NativeLayer {
      static getNativeFramebufferScaleFactor() { return 1; }
      constructor(_session: unknown, _gl: unknown, options: Record<string, unknown>) { built.push(options); }
    }
    const scope: any = { navigator: { userAgent: QUEST2_AGENT }, XRWebGLLayer: NativeLayer };
    const session = fakeSession();
    const restore = disableXrLayerMsaa(scope, session);
    // What Mol* asks for, verbatim (`mol-gl/webgl/context.js`).
    const layer = new scope.XRWebGLLayer(session, {}, { antialias: true, alpha: true, depth: true, framebufferScaleFactor: 0.6 });
    expect(built[0]).toEqual({ antialias: false, alpha: true, depth: true, framebufferScaleFactor: 0.6 });
    expect(layer instanceof NativeLayer).toBe(true);
    expect(scope.XRWebGLLayer.getNativeFramebufferScaleFactor()).toBe(1);
    restore();
    expect(scope.XRWebGLLayer).toBe(NativeLayer);
  });

  it('never wraps a wrapper twice and never restores over a later one', () => {
    class NativeLayer { constructor(_s: unknown, _g: unknown, _o: unknown) {} }
    const scope: any = { navigator: { userAgent: QUEST2_AGENT }, XRWebGLLayer: NativeLayer };
    const session = fakeSession();
    const restore = disableXrLayerMsaa(scope, session);
    const wrapper = scope.XRWebGLLayer;
    expect(disableXrLayerMsaa(scope, session)).toBeInstanceOf(Function);
    expect(scope.XRWebGLLayer).toBe(wrapper);
    // Somebody else owns the slot now; putting the native one back would
    // silently uninstall their wrapper.
    const later = function Later() {};
    scope.XRWebGLLayer = later;
    restore();
    expect(scope.XRWebGLLayer).toBe(later);
  });

  it('is inert on a runtime with no XRWebGLLayer', () => {
    const scope: any = {};
    expect(() => disableXrLayerMsaa(scope)()).not.toThrow();
    expect(scope.XRWebGLLayer).toBeUndefined();
  });

  it.each([
    ['Apple Safari with transient-pointer input',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
      [{ targetRayMode: 'transient-pointer', profiles: ['generic-touchscreen'] }]],
    ['unidentified browser', 'Mozilla/5.0 ExampleBrowser/1.0', []],
  ])('preserves Mol* antialiasing for %s', (_name, userAgent, inputSources) => {
    const built: Array<Record<string, unknown>> = [];
    class NativeLayer {
      constructor(_session: unknown, _gl: unknown, options: Record<string, unknown>) { built.push(options); }
    }
    const scope: any = { navigator: { userAgent, xr: {} }, XRWebGLLayer: NativeLayer };
    const restore = disableXrLayerMsaa(scope, { inputSources } as any);
    expect(scope.XRWebGLLayer).toBe(NativeLayer);
    new scope.XRWebGLLayer({}, {}, { antialias: true, alpha: true });
    expect(built).toEqual([{ antialias: true, alpha: true }]);
    restore();
    expect(scope.XRWebGLLayer).toBe(NativeLayer);
  });

  it('still recognizes a Quest from its controller profiles when the browser omits the model UA', () => {
    const built: Array<Record<string, unknown>> = [];
    class NativeLayer {
      constructor(_session: unknown, _gl: unknown, options: Record<string, unknown>) { built.push(options); }
    }
    const scope: any = { navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) OculusBrowser/1.0' }, XRWebGLLayer: NativeLayer };
    const session = fakeSession({ inputSources: [{ targetRayMode: 'tracked-pointer', profiles: ['meta-quest-touch-plus'] }] });
    const restore = disableXrLayerMsaa(scope, session);
    new scope.XRWebGLLayer(session, {}, { antialias: true, alpha: true });
    expect(built).toEqual([{ antialias: false, alpha: true }]);
    restore();
    expect(scope.XRWebGLLayer).toBe(NativeLayer);
  });

  it('restores the Quest constructor after layer construction throws', () => {
    class BrokenLayer { constructor() { throw new Error('native layer rejected options'); } }
    const scope: any = { navigator: { userAgent: QUEST2_AGENT }, XRWebGLLayer: BrokenLayer };
    const restore = disableXrLayerMsaa(scope, fakeSession());
    expect(() => new scope.XRWebGLLayer({}, {}, { antialias: true })).toThrow('native layer rejected options');
    restore();
    expect(scope.XRWebGLLayer).toBe(BrokenLayer);
  });

  it('reads antialias and foveation back off the presenting layer', () => {
    // `present` is what separates "no layer yet" from "a layer that answers
    // neither attribute". Without it the two nulls read as a defeated
    // foveation request when in fact no layer existed at the moment the
    // budget was written.
    expect(describeXrLayer(undefined)).toEqual({ present: false, antialias: null, fixedFoveation: null });
    expect(describeXrLayer({ renderState: {} })).toEqual({ present: false, antialias: null, fixedFoveation: null });
    expect(describeXrLayer({ renderState: { baseLayer: { antialias: false, fixedFoveation: 1 } } }))
      .toEqual({ present: true, antialias: false, fixedFoveation: 1 });
    // A runtime that exposes neither reports unknown rather than guessing.
    expect(describeXrLayer({ renderState: { baseLayer: {} } })).toEqual({ present: true, antialias: null, fixedFoveation: null });
  });

  it('puts the layer read-back on the headset log so Fov=0 is diagnosable', () => {
    const entries: Array<{ kind: string; detail: any }> = [];
    const scope = { __stereofoldDiagnostics: { record: (kind: string, detail: any) => { entries.push({ kind, detail }); } } };
    const session = fakeSession({ renderState: { baseLayer: { antialias: false, fixedFoveation: 1 } } });
    beginXrRenderBudget({ canvas: fakeCanvas({}), session, navigator: { userAgent: QUEST2_AGENT },
      atomSites: CRISPR_SITES, scope });
    const rendered = entries.find(entry => entry.kind === 'render-budget');
    expect(rendered?.detail).toMatchObject({ layer: { antialias: false, fixedFoveation: 1 },
      interactionMaxFps: 0, applied: true });
    // The diagnostics ring keeps only the first MAX_DETAIL_KEYS fields, so
    // the entry must stay inside that budget or `applied` falls off the end.
    expect(Object.keys(rendered!.detail).length).toBeLessThanOrEqual(16);
  });
});

describe('immersive hover picking', () => {
  it('stops the per-frame hover pick and restores the desktop rate on exit', () => {
    const canvas = fakeCanvas({ marking: { enabled: true }, pickScale: 0.25, interaction: { maxFps: 30 } });
    const handle = beginXrRenderBudget({ canvas, session: fakeSession(), navigator: { userAgent: QUEST2_AGENT },
      atomSites: CRISPR_SITES, scope: {} });
    expect(canvas.applied[0].interaction).toEqual({ maxFps: XR_INTERACTION_MAX_FPS });
    expect(XR_INTERACTION_MAX_FPS).toBe(0);
    handle.restore();
    expect(canvas.applied[1].interaction).toEqual({ maxFps: 30 });
  });

  it('takes a poll rate or the desktop default from the hover knob', () => {
    expect(parseRenderBudgetOverrides('hover:on').interactionMaxFps).toBe(DESKTOP_INTERACTION_MAX_FPS);
    expect(parseRenderBudgetOverrides('hover:off').interactionMaxFps).toBe(0);
    expect(parseRenderBudgetOverrides('hover:10').interactionMaxFps).toBe(10);
    expect(parseRenderBudgetOverrides('hover:900').interactionMaxFps).toBeUndefined();
    expect(renderBudget({ device: 'quest2', atomSites: CRISPR_SITES,
      overrides: parseRenderBudgetOverrides('hover:on') }).interactionMaxFps).toBe(DESKTOP_INTERACTION_MAX_FPS);
  });

  /**
   * The in-scene Mol* panel is a prototype
   * with a measured frame cost, so the knob is the only thing that can turn it
   * on and the default has to stay silent rather than falsy-by-accident.
   */
  it('leaves the in-scene Mol* panel unasked-for unless the knob names it', () => {
    expect(parseRenderBudgetOverrides('').molstarPanel).toBeUndefined();
    expect(parseRenderBudgetOverrides('scale:0.6').molstarPanel).toBeUndefined();
    expect(parseRenderBudgetOverrides('molstarPanel:on').molstarPanel).toBe(true);
    expect(parseRenderBudgetOverrides('molstar:on').molstarPanel).toBe(true);
    expect(parseRenderBudgetOverrides('molstarPanel:off').molstarPanel).toBe(false);
    // An unreadable value is neither on nor a complaint: a typo in an address
    // typed inside a headset must not stop the demo entering immersion.
    expect(parseRenderBudgetOverrides('molstarPanel:maybe').molstarPanel).toBeUndefined();
    expect(parseRenderBudgetOverrides('molstarPanel:maybe').unknown).toEqual([]);
  });
});
