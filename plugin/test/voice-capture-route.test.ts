/**
 * Whether the headset page's microphone has any voice route on this host.
 *
 * Enter VR asks for the microphone only so that a voice route can use it later
 * from inside VR, where Quest Browser cannot draw a prompt. A host started
 * with voice off still made every Enter VR press ask. The companion's own
 * heartbeat now says whether any route would use that microphone: the local
 * push-to-talk transcriber when it is on, or the Talk row's OAuth route when
 * it can start on this Mac.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createPushToTalkTranscriber } from '../src/push-to-talk-transcribe.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { OAUTH_AUTH_HELPER_CONFIG_KEY } from '../src/local-helper-config.js';
import { OAUTH_AUTH_HELPER_ENV, OAUTH_AUTH_HELPER_NAME, oauthTalkRouteAvailable } from '../src/oauth-voice-transcription.js';

const cif = readFileSync(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const script = fileURLToPath(new URL('../assets/oauth-transcribe.py', import.meta.url));

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'stereofold-talk-route-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

/** What the shipped transcription script itself finds, run as the route runs it. */
function scriptFindsHelper(env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync('python3', ['-B', '-c', `
import json, os, runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1])
os.environ.clear()
os.environ.update(json.loads(sys.argv[2]))
Path.home = classmethod(lambda cls: Path(sys.argv[3]))
try:
    module['auth_helper_path']()
    print('found')
except Exception:
    print('missing')
`, script, JSON.stringify(env), directory], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim() === 'found';
}

function helper(name: string) {
  const path = join(directory, name);
  writeFileSync(path, 'def create_realtime_oauth_client_secret():\n    return "unused"\n');
  return path;
}

// A separate file per case: the host reads its config file once per path.
function config(value: unknown, name: string) {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

// A Python 3 is taken as present, so these cases are about the OAuth module.
const withPython = (env: NodeJS.ProcessEnv) => oauthTalkRouteAvailable({ env, home: directory, exists: () => true });

describe('whether the Talk route can start on this Mac', () => {
  it('finds the OAuth module where the transcription script finds it, and nowhere else', () => {
    const envHelper = helper('env.py'), configured = helper('configured.py');
    helper(OAUTH_AUTH_HELPER_NAME);
    const cases: Array<[string, NodeJS.ProcessEnv, boolean]> = [
      ['environment', { [OAUTH_AUTH_HELPER_ENV]: envHelper }, true],
      ['config', { STEREOFOLD_CONFIG: config({ [OAUTH_AUTH_HELPER_CONFIG_KEY]: configured }, 'configured.json') }, true],
      ['PATH', { PATH: directory }, true],
      ['a relative environment name, despite PATH', { PATH: directory, [OAUTH_AUTH_HELPER_ENV]: 'relative.py' }, false],
      ['a missing environment name, despite PATH', { PATH: directory, [OAUTH_AUTH_HELPER_ENV]: join(directory, 'missing.py') }, false],
      ['a missing configured name, despite PATH', { PATH: directory, STEREOFOLD_CONFIG: config({ [OAUTH_AUTH_HELPER_CONFIG_KEY]: join(directory, 'missing.py') }, 'missing.json') }, false],
      ['nothing at all', {}, false],
      ['relative PATH entries only', { PATH: 'relative:.' }, false],
    ];
    for (const [name, env, expected] of cases) {
      expect(withPython(env), name).toBe(expected);
      expect(scriptFindsHelper(env), `the script, ${name}`).toBe(expected);
    }
  });

  it('cannot start without a Python 3, even with the OAuth module in place', () => {
    const envHelper = helper('env.py');
    expect(oauthTalkRouteAvailable({ env: { [OAUTH_AUTH_HELPER_ENV]: envHelper }, home: directory, config: {}, exists: () => false })).toBe(false);
  });
});

/** A saved session with a companion attached, and the calls a page makes on it. */
async function companion({ enabled, talkRoute, now }: { enabled: boolean; talkRoute: () => boolean; now?: () => number }) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { environment: {}, transcriber: createPushToTalkTranscriber({ enabled }),
    voice: { talkRoute }, ...(now ? { now } : {}) });
  const client = new Client({ name: 'Stereofold voice capture route test', version: '1' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const close = async () => { await client.close(); await server.close(); };
  try {
    const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
    const data = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
    const scene = {
      sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
      assemblyId: data.catalog.assemblyId, selectionKeys: [data.catalog.rows[0].key],
      camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
        radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
      inspection: {
        appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
          opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
        placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
      },
    };
    const initial = { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
      baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
    const saved = (await call('sync_inspection', { ...initial, scene })).structuredContent;
    const binding = { ...initial, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
    const attached = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent;
    const poll = async (panelId: string) =>
      (await call('poll_inspection', { ...binding, panelId, availability: 'ready' })).structuredContent;
    const attachDesktop = async () => (await call('attach_inspection', binding)).structuredContent;
    return { attached, poll, attachDesktop, close };
  } catch (error) { await close(); throw error; }
}

async function companionBeats({ enabled, talkRoute }: { enabled: boolean; talkRoute: boolean }) {
  const page = await companion({ enabled, talkRoute: () => talkRoute });
  try {
    const polled = await page.poll(page.attached.panelId);
    const desktop = await page.attachDesktop();
    const desktopPolled = await page.poll(desktop.panelId);
    return { attached: page.attached.voiceCapture, polled: polled.voiceCapture, desktop: desktop.voiceCapture, desktopPolled: desktopPolled.voiceCapture };
  } finally { await page.close(); }
}

describe('the voice capture a companion heartbeat reports', () => {
  it.each([
    [true, false, true],
    [false, true, true],
    [true, true, true],
    [false, false, false],
  ])('push-to-talk transcription %s and a Talk route %s report %s on attach and on every beat', async (enabled, talkRoute, expected) => {
    const beats = await companionBeats({ enabled, talkRoute });
    expect(beats.attached).toBe(expected);
    expect(beats.polled).toBe(expected);
    // Only a headset page has an Enter VR press to make.
    expect(beats.desktop).toBeUndefined();
    expect(beats.desktopPolled).toBeUndefined();
  });
});

describe('a Talk route that becomes available while the host runs', () => {
  it('is looked up again at most once every five seconds while it is unavailable, and kept once it is available', async () => {
    let clock = 1_000_000, installed = false, lookups = 0;
    const page = await companion({ enabled: false, now: () => clock, talkRoute: () => { lookups++; return installed; } });
    try {
      expect(page.attached.voiceCapture).toBe(false);
      expect(lookups).toBe(1);
      const beat = async () => (await page.poll(page.attached.panelId)).voiceCapture;
      // The helper is installed. Heartbeats inside the interval do not look again.
      installed = true;
      expect(await beat()).toBe(false);
      clock += 4_999;
      expect(await beat()).toBe(false);
      expect(lookups).toBe(1);
      // The first beat after the interval looks again and reports the route.
      clock += 1;
      expect(await beat()).toBe(true);
      expect(lookups).toBe(2);
      // An available route is not looked up again, however long the beats go on.
      for (let step = 0; step < 4; step++) {
        clock += 3_000;
        expect(await beat()).toBe(true);
      }
      expect(lookups).toBe(2);
    } finally { await page.close(); }
  });
});
