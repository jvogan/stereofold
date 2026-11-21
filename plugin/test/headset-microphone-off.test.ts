/**
 * A share started with `--no-ptt` records the headset microphone on no route.
 *
 * `--no-ptt` used to turn off only push-to-talk transcription. The Talk row
 * records through its own OAuth route, so with that route's helper installed
 * the companion was told a voice route existed, Enter VR asked for the
 * microphone, and a Talk press was transcribed although the person had said
 * no. The explicit flag now travels from the launcher to the MCP server as
 * HEADSET_MICROPHONE_OFF_ENV, and the server then reports no voice route and
 * answers Talk audio with the existing refusal before anything reads it.
 *
 * Without the flag nothing changes: a host started with no voice flag still
 * turns transcription off by itself and keeps the Talk row working.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createPushToTalkTranscriber } from '../src/push-to-talk-transcribe.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import {
  HEADSET_MICROPHONE_OFF_ENV, headsetMicrophoneOff, headsetMicrophoneOffEnvironment, pttLaunchEnabled, pttLaunchRefused,
} from '../src/ptt-launch-options.js';
import { parseQuestArgs, questHostVoiceFlags } from '../scripts/quest-share.js';
import { microphoneRefusedAfter, refuseCaptureWhileVoiceOff, talkCaptureClosed } from '../src/xr-entry-microphone.js';
import { DETAILED_VIEW_SESSION_SOURCE } from '../src/detailed-view-session.js';
// @ts-ignore Browser module exercised directly.
import { createVoiceCapture } from '../../lab/browser-roundtrip/voice-capture.mjs';
// @ts-ignore Browser module exercised directly.
import { createVoiceInteraction } from '../../lab/browser-roundtrip/voice-interaction.mjs';

const cif = readFileSync(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const REFUSAL = 'Voice unavailable. Use the menu controls instead.';

describe('the launcher-to-server sign that the person said no to the microphone', () => {
  it('is the last voice flag on the command line, as push-to-talk reads it', () => {
    expect(pttLaunchRefused([])).toBe(false);
    expect(pttLaunchRefused(['1CRN', '--no-ptt'])).toBe(true);
    expect(pttLaunchRefused(['--ptt'])).toBe(false);
    expect(pttLaunchRefused(['--ptt', '--no-ptt'])).toBe(true);
    expect(pttLaunchRefused(['--no-ptt', '--ptt'])).toBe(false);
    // The flag and push-to-talk never disagree about which flag came last.
    for (const args of [['--no-ptt'], ['--ptt', '--no-ptt'], ['--no-ptt', '--ptt']])
      expect(pttLaunchRefused(args)).toBe(!pttLaunchEnabled(args, {}, true));
  });

  it('is read by the server from one variable: any value but blank or 0/off/no/false', () => {
    expect(headsetMicrophoneOff({})).toBe(false);
    for (const value of ['', '  ', '0', 'off', 'NO', 'false']) expect(headsetMicrophoneOff({ [HEADSET_MICROPHONE_OFF_ENV]: value }), value).toBe(false);
    for (const value of ['1', 'true', 'yes', 'on']) expect(headsetMicrophoneOff({ [HEADSET_MICROPHONE_OFF_ENV]: value }), value).toBe(true);
  });

  it('reaches the MCP server only when the person passed --no-ptt to the launcher', () => {
    const home = '/home/test';
    const cases: Array<[string, string[], NodeJS.ProcessEnv, boolean]> = [
      ['no voice flag', ['1CRN'], {}, false],
      ['--headless and no voice flag', ['1CRN', '--headless'], {}, false],
      ['STEREOFOLD_PTT_TRANSCRIBE=0 and no voice flag', ['1CRN'], { STEREOFOLD_PTT_TRANSCRIBE: '0' }, false],
      ['--ptt', ['1CRN', '--ptt'], {}, false],
      ['--no-ptt', ['1CRN', '--no-ptt'], {}, true],
      ['--headless --no-ptt', ['1CRN', '--headless', '--no-ptt'], {}, true],
      ['--no-ptt despite STEREOFOLD_PTT_TRANSCRIBE=1', ['1CRN', '--no-ptt'], { STEREOFOLD_PTT_TRANSCRIBE: '1' }, true],
      ['--ptt then --no-ptt', ['1CRN', '--ptt', '--no-ptt'], {}, true],
      ['--no-ptt then --ptt', ['1CRN', '--no-ptt', '--ptt'], {}, false],
    ];
    for (const [name, args, env, refused] of cases) {
      const options = parseQuestArgs(args, home, env);
      const hostFlags = questHostVoiceFlags(options);
      // The standalone host the launcher starts sees the same environment.
      expect(headsetMicrophoneOff(headsetMicrophoneOffEnvironment(hostFlags)), name).toBe(refused);
      // Push-to-talk on that host resolves exactly as the launcher resolved it.
      expect(pttLaunchEnabled(hostFlags, env, false), name).toBe(options.pushToTalk);
    }
    // The standalone host started by hand reads its own command line the same way.
    expect(headsetMicrophoneOffEnvironment(['1CRN', '--no-ptt'])).toEqual({ [HEADSET_MICROPHONE_OFF_ENV]: '1' });
    expect(headsetMicrophoneOffEnvironment(['1CRN'])).toEqual({});
    expect(headsetMicrophoneOffEnvironment(['1CRN', '--no-ptt', '--ptt'])).toEqual({});
  });
});

/** A saved session with a companion attached, and the calls its page makes. */
async function companion({ environment, enabled }: { environment: NodeJS.ProcessEnv; enabled: boolean }) {
  const transcribed: unknown[] = [];
  let lookups = 0;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { environment, transcriber: createPushToTalkTranscriber({ enabled }),
    voice: { talkRoute: () => { lookups++; return true; }, transcribe: async audio => { transcribed.push(audio); return 'What does this structure do?'; } } });
  const client = new Client({ name: 'Stereofold headset microphone off test', version: '1' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const close = async () => { await client.close(); await server.close(); };
  try {
    const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
    const hydration = await call('get_inspection', { sessionId });
    const data = hydration._meta[PRIVATE_KEY];
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
    const panelId = attached.panelId as string;
    const polled = (await call('poll_inspection', { ...binding, panelId, availability: 'ready' })).structuredContent;
    const talk = () => call('voice_command', { ...binding, panelId,
      audio: { pcm16leBase64: Buffer.alloc(8_640).toString('base64'), sampleRate: 24_000, durationMs: 180 } });
    const grip = () => call('push_to_talk_audio', { sessionId, panelId, utteranceId: randomUUID(), seq: 0,
      mime: 'audio/webm;codecs=opus', data: Buffer.alloc(64).toString('base64'), final: true });
    const detailed = async () => {
      const page = (await call('attach_inspection', { ...binding, surface: 'detailed' })).structuredContent;
      const beat = (await call('poll_inspection', { ...binding, panelId: page.panelId, availability: 'ready' })).structuredContent;
      return { attached: page, polled: beat };
    };
    const pollUnknown = async () => (await call('poll_inspection', { ...binding, panelId: randomUUID(), availability: 'ready' })).structuredContent;
    return { hydrated: hydration.structuredContent, attached, polled, talk, grip, detailed, pollUnknown, transcribed, lookups: () => lookups, close };
  } catch (error) { await close(); throw error; }
}

describe('a host told the person said no to the headset microphone', () => {
  it('reports no voice route and refuses Talk audio with nothing transcribed, whatever helper is installed', async () => {
    const page = await companion({ environment: { [HEADSET_MICROPHONE_OFF_ENV]: '1' }, enabled: false });
    try {
      expect(page.attached.voiceCapture).toBe(false);
      expect(page.polled.voiceCapture).toBe(false);
      // The page is also told the person said no, so it refuses Talk before any microphone opens.
      expect(page.attached.microphoneRefused).toBe(true);
      expect(page.polled.microphoneRefused).toBe(true);
      expect(page.lookups()).toBe(0);
      const talk = await page.talk();
      expect(talk.isError).not.toBe(true);
      expect(talk.structuredContent).toEqual({ message: REFUSAL });
      expect(talk.content[0].text).toBe(REFUSAL);
      expect(page.transcribed).toEqual([]);
    } finally { await page.close(); }
  });

  it('keeps push-to-talk transcription off as well, even when the transcriber was turned on', async () => {
    const page = await companion({ environment: { [HEADSET_MICROPHONE_OFF_ENV]: '1' }, enabled: true });
    try {
      expect(page.attached.voiceCapture).toBe(false);
      expect(page.polled.voiceCapture).toBe(false);
      const grip = await page.grip();
      expect(grip.structuredContent).toMatchObject({ accepted: false, reason: 'disabled' });
      expect((await page.talk()).structuredContent).toEqual({ message: REFUSAL });
      expect(page.transcribed).toEqual([]);
    } finally { await page.close(); }
  });
});

describe('a host not told so behaves as before', () => {
  it.each([
    ['no voice flag (transcription off) with a Talk helper', {}, false],
    ['--ptt (transcription on) with a Talk helper', {}, true],
    ['the variable set to 0', { [HEADSET_MICROPHONE_OFF_ENV]: '0' }, false],
  ] as Array<[string, NodeJS.ProcessEnv, boolean]>)('%s: voice capture is reported and Talk audio is transcribed', async (_name, environment, enabled) => {
    const page = await companion({ environment, enabled });
    try {
      expect(page.attached.voiceCapture).toBe(true);
      expect(page.polled.voiceCapture).toBe(true);
      expect('microphoneRefused' in page.attached).toBe(false);
      expect('microphoneRefused' in page.polled).toBe(false);
      const talk = await page.talk();
      expect(talk.isError).not.toBe(true);
      expect(talk.structuredContent.intentId).toEqual(expect.any(String));
      expect(page.transcribed).toHaveLength(1);
    } finally { await page.close(); }
  });
});

describe('a Talk press on the companion page', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** The page's Talk control as the inspector builds it, on a browser whose microphone would open. */
  function talkControl(host: { voiceCapture?: boolean; microphoneRefused?: boolean }, presenting: boolean) {
    const getUserMedia = vi.fn(() => new Promise(() => { /* A prompt still open. */ }));
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('AudioContext', class {});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const capture = refuseCaptureWhileVoiceOff(createVoiceCapture(), () => talkCaptureClosed(host, () => presenting));
    const playback = { unlock: async () => {}, play: async () => {}, close: async () => {} };
    const interaction = createVoiceInteraction({ capture, playback, begin: async () => ({}), send: async () => ({}) });
    return { interaction, getUserMedia };
  }

  it.each([[false], [true]])('in a session the person started with --no-ptt (in VR: %s) opens no microphone and shows the unavailable line', async presenting => {
    const { interaction, getUserMedia } = talkControl({ voiceCapture: false, microphoneRefused: true }, presenting);
    await expect(interaction.toggle()).rejects.toThrow(REFUSAL);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(interaction.state()).toBe('idle');
    expect(interaction.message()).toBe(REFUSAL);
  });

  it.each([
    ['no voice route, on the flat page', { voiceCapture: false }],
    ['a voice route, on the flat page', { voiceCapture: true }],
    ['a host that has not said', {}],
  ] as Array<[string, { voiceCapture?: boolean }]>)('without the flag, with %s, asks for the microphone as before', async (_name, host) => {
    const { interaction, getUserMedia } = talkControl(host, false);
    void interaction.toggle().catch(() => {});
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    await interaction.cancel();
  });

  it('without the flag, with no voice route inside VR, is still refused', async () => {
    const { interaction, getUserMedia } = talkControl({ voiceCapture: false }, true);
    await expect(interaction.toggle()).rejects.toThrow(REFUSAL);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('stays refused after a heartbeat that lacks the field, until a fresh attach without it', async () => {
    let refused = microphoneRefusedAfter(false, { structuredContent: { panelId: 'p', microphoneRefused: true } }, true);
    refused = microphoneRefusedAfter(refused, { structuredContent: { attached: false } }, false);
    refused = microphoneRefusedAfter(refused, undefined, false);
    const held = talkControl({ voiceCapture: true, microphoneRefused: refused }, false);
    await expect(held.interaction.toggle()).rejects.toThrow(REFUSAL);
    expect(held.getUserMedia).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    refused = microphoneRefusedAfter(refused, { structuredContent: { panelId: 'q', voiceCapture: true } }, true);
    expect(refused).toBe(false);
    const fresh = talkControl({ voiceCapture: true, microphoneRefused: refused }, false);
    void fresh.interaction.toggle().catch(() => {});
    await vi.waitFor(() => expect(fresh.getUserMedia).toHaveBeenCalledTimes(1));
    await fresh.interaction.cancel();
  });

  it('is the gate the inspector builds, read from its own attach answer and heartbeat', () => {
    const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    expect(inspector).toContain("if(isCompanion && (beat || name==='get_inspection')) hostMicrophoneRefused=microphoneRefusedAfter(hostMicrophoneRefused,result,name==='attach_inspection');");
    expect(inspector).toContain('capture:refuseCaptureWhileVoiceOff(createVoiceCapture(),()=>talkCaptureClosed({voiceCapture:hostVoiceCapture,microphoneRefused:hostMicrophoneRefused},()=>workspace.snapshot().xrPresenting===true))');
  });
});

describe('Hold to talk on the detailed view page', () => {
  const session = new Function(`return ${DETAILED_VIEW_SESSION_SOURCE};`)() as any;
  class Recorder {
    constructor(public stream: unknown) {}
    static isTypeSupported() { return true; }
    start() {}
    stop() {}
  }
  function press(refused?: () => boolean) {
    const getMedia = vi.fn(async () => ({}));
    const said: string[] = [];
    const talk = session.createTalk({ post: async () => ({}), uuid: () => randomUUID(), toBase64: async () => 'QUJD',
      Recorder, getMedia, mimeTypes: ['audio/webm'], say: (text: string) => said.push(text), ...(refused ? { refused } : {}) });
    return { talk, getMedia, said };
  }

  it('is told the person said no on the answers it gets before a press can happen', async () => {
    const off = await companion({ environment: { [HEADSET_MICROPHONE_OFF_ENV]: '1' }, enabled: false });
    try {
      const page = await off.detailed();
      expect(page.attached.microphoneRefused).toBe(true);
      expect(page.polled.microphoneRefused).toBe(true);
    } finally { await off.close(); }
    const on = await companion({ environment: {}, enabled: false });
    try {
      const page = await on.detailed();
      expect('microphoneRefused' in page.attached).toBe(false);
      expect('microphoneRefused' in page.polled).toBe(false);
      // A detailed page has never been told about voice capture.
      expect('voiceCapture' in page.attached).toBe(false);
      expect('voiceCapture' in page.polled).toBe(false);
    } finally { await on.close(); }
  });

  it('in a session the person started with --no-ptt opens no microphone and says the microphone is not allowed', async () => {
    const { talk, getMedia, said } = press(() => true);
    expect(await talk.start()).toBe(false);
    expect(getMedia).not.toHaveBeenCalled();
    expect(talk.recording).toBe(false);
    expect(said).toEqual(['The microphone is not allowed here.']);
  });

  it('without the flag records as before', async () => {
    for (const refused of [() => false, undefined]) {
      const { talk, getMedia, said } = press(refused);
      expect(await talk.start()).toBe(true);
      expect(getMedia).toHaveBeenCalledTimes(1);
      expect(said).toEqual(['Listening.']);
    }
  });

  it('stays refused after a heartbeat that lacks the field, until a fresh attach without it', async () => {
    let refused = session.microphoneRefusedAfter(false, { structuredContent: { panelId: 'p', microphoneRefused: true } }, true);
    // The host dropped the panel: its answer says so and carries nothing else.
    refused = session.microphoneRefusedAfter(refused, { structuredContent: { attached: false } }, false);
    refused = session.microphoneRefusedAfter(refused, {}, false);
    const held = press(() => refused);
    expect(await held.talk.start()).toBe(false);
    expect(held.getMedia).not.toHaveBeenCalled();
    // A restarted host without the flag gives a new binding with no field.
    refused = session.microphoneRefusedAfter(refused, { structuredContent: { panelId: 'q' } }, true);
    const fresh = press(() => refused);
    expect(await fresh.talk.start()).toBe(true);
    expect(fresh.getMedia).toHaveBeenCalledTimes(1);
  });

  it('is the gate the page builds, read from its own attach answer and heartbeat', async () => {
    const page = readFileSync(new URL('../src/detailed-view-page.ts', import.meta.url), 'utf8');
    expect(page).toContain('refused: () => microphoneRefused,');
    expect(page).toContain('microphoneRefused = session.microphoneRefusedAfter(microphoneRefused, attached, true);');
    expect(page).toContain('microphoneRefused = session.microphoneRefusedAfter(microphoneRefused, answer, false);');
  });
});

describe('a heartbeat for a panel the host no longer has', () => {
  it.each([
    ['with --no-ptt', { [HEADSET_MICROPHONE_OFF_ENV]: '1' }, true],
    ['without it', {}, false],
  ] as Array<[string, NodeJS.ProcessEnv, boolean]>)('%s carries the refusal exactly when the host has it', async (_name, environment, refused) => {
    const page = await companion({ environment, enabled: false });
    try {
      const beat = await page.pollUnknown();
      expect(beat.attached).toBe(false);
      if (refused) expect(beat.microphoneRefused).toBe(true);
      else expect('microphoneRefused' in beat).toBe(false);
    } finally { await page.close(); }
  });
});

describe('Enter VR before the first attach answer arrives', () => {
  const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const lines = (needle: string) => inspector.split('\n').filter(line => line.includes(needle)).map(line => line.trim());
  // What the page does with each answer, then what Enter VR and resume do.
  const learn = lines('hostMicrophoneRefused=microphoneRefusedAfter(').concat(lines('if(isCompanion && hostMicrophoneRefused) hostVoiceCapture=false;'));
  const entry = lines(' primePushToTalkMicrophone()');
  const QUEST = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 Chrome/132.0.0.0 OculusBrowser/38.0 Safari/537.36';

  it('the host tells the page in get_inspection, which the page must have before it builds Enter VR', async () => {
    const off = await companion({ environment: { [HEADSET_MICROPHONE_OFF_ENV]: '1' }, enabled: false });
    try { expect(off.hydrated.microphoneRefused).toBe(true); } finally { await off.close(); }
    const on = await companion({ environment: {}, enabled: false });
    try { expect('microphoneRefused' in on.hydrated).toBe(false); } finally { await on.close(); }
    // The companion builds its entry controls only after its own get_inspection answered.
    const start = inspector.indexOf("const response=await call('get_inspection',{}),data=response._meta?.[PRIVATE_KEY] as any;\n    if(!data?.sessionId || !data?.serverEpoch) throw Error('The companion did not receive its session.');");
    expect(start).toBeGreaterThan(0);
    expect(inspector.indexOf("const controls=document.createElement('div');controls.className='xr-controls';", start)).toBeGreaterThan(start);
  });

  it.each([
    ['with --no-ptt', { microphoneRefused: true }, 0],
    ['without it', {}, 2],
  ] as Array<[string, Record<string, unknown>, number]>)('%s, Enter VR and resume after a lost first attach ask for the microphone that many times', (_name, answer, primes) => {
    expect(learn).toHaveLength(2);
    expect(entry).toHaveLength(2);
    let asked = 0;
    const context = vm.createContext({ isCompanion: true, isAppleSafariXr: () => false, navigator: { userAgent: QUEST, xr: {} },
      hostVoiceCapture: undefined, hostMicrophoneRefused: false, microphoneRefusedAfter,
      primePushToTalkMicrophone: () => { asked++; } });
    // get_inspection answered; the attach answer never came, so no beat has.
    Object.assign(context, { name: 'get_inspection', beat: false, result: { structuredContent: { sessionId: 's', ...answer } } });
    for (const statement of learn) vm.runInContext(statement, context);
    for (const statement of entry) vm.runInContext(statement, context);
    expect(asked).toBe(primes);
    // A restarted host without the flag answers a fresh attach without the field.
    Object.assign(context, { name: 'attach_inspection', beat: true, result: { structuredContent: { panelId: 'p', voiceCapture: true } } });
    vm.runInContext(learn[0]!, context);
    expect(context.hostMicrophoneRefused).toBe(false);
  });
});
