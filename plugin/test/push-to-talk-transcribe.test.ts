import { assembleReadiness, PRIVATE_INSPECTION_META_KEY } from '../src/inspection-contract.js';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpeechVocabulary, type SpeechSceneContext } from '../src/speech-vocabulary.js';
import {
  applespeechBinCandidates, assembleChunks, containerExtension, createPushToTalkTranscriber, createTranscriptQueue,
  ffmpegBinCandidates, packagedApplespeechBins,
  isSilentRecording, isWhisperSilence, localTranscriberInstalled, loudestWindowRms,
  parseAppleSpeechText, parseWhisperText,
  pollVoiceTranscriptsSchema, pushToTalkAudioSchema, readPcm16Wav, silenceThreshold,
  transcriberKind, transcriptionEnabled, trimTrailingSilence, whisperBinCandidates,
  APPLESPEECH_BIN_ENV, APPLESPEECH_HINTS, APPLESPEECH_MODEL_NAME, SILENCE_RMS_ENV, TRANSCRIBER_ENV,
  PTT_MAX_ACTIVE_UTTERANCES, PTT_SILENCE_RMS,
  PTT_MAX_CHUNK_BASE64, PTT_MAX_CHUNKS_PER_WINDOW, PTT_MAX_DURATION_MS, PTT_MAX_UTTERANCES_PER_WINDOW,
  PUSH_TO_TALK_TRANSCRIBE_ENV, WHISPER_BIN_ENV, WHISPER_INITIAL_PROMPT,
  type PushToTalkAudioInput, type TranscriptRecord,
} from '../src/push-to-talk-transcribe.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const UTTERANCE = '22222222-2222-4222-8222-222222222222';

/**
 * A spawn seam that answers like ffmpeg and whisper-cli without running either.
 * `writes` records the argument vectors so a test can assert the flags, and
 * `stdin` captures what a delivery command was fed.
 */
function fakeSpawner(options: {
  text?: string;
  ffmpegCode?: number;
  whisperCode?: number;
  appleCode?: number;
  onWav?: (path: string) => Promise<void> | void;
} = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const stdins: string[] = [];
  const spawn = ((command: string, args: readonly string[], spawnOptions: any) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter() as any;
    const isWhisper = command.includes('whisper');
    const isFfmpeg = command.includes('ffmpeg');
    // `applespeech` prints the transcript on stdout and its diagnostics on
    // stderr, so unlike whisper it writes no file to read back.
    const isApple = command.includes('applespeech');
    child.stdout = Readable.from(isApple ? [`${options.text ?? 'pause the tour'}\n`] : []);
    child.stderr = Readable.from(isApple ? ['applespeech: latency_ms=307\n'] : []);
    let captured = '';
    child.stdin = new Writable({ write(chunk, _encoding, done) { captured += String(chunk); done(); } });
    child.kill = () => true;
    void Promise.resolve().then(async () => {
      if (isApple) {
        // Let the stdout stream drain before the close that settles the run;
        // the other branches get that for free from their filesystem writes.
        await new Promise(resolve => { setImmediate(resolve); });
        await new Promise(resolve => { setImmediate(resolve); });
        child.emit('close', options.appleCode ?? 0);
        return;
      }
      if (isFfmpeg) {
        const target = args[args.length - 1]!;
        if (options.onWav) await options.onWav(target);
        else await writeFile(target, Buffer.from('RIFFfake'));
        child.emit('close', options.ffmpegCode ?? 0);
        return;
      }
      if (isWhisper) {
        const prefix = args[args.indexOf('-of') + 1]!;
        if ((options.whisperCode ?? 0) === 0) await writeFile(`${prefix}.txt`, `${options.text ?? 'open the microtubule lattice'}\n`);
        child.emit('close', options.whisperCode ?? 0);
        return;
      }
      stdins.push(captured);
      child.emit('close', 0);
    });
    return child;
  }) as any;
  return { spawn, calls, stdins };
}

function transcriber(overrides: Parameters<typeof createPushToTalkTranscriber>[0] = {}, spawner = fakeSpawner()) {
  const lines: string[] = [];
  const instance = createPushToTalkTranscriber({
    enabled: true,
    // Named, because `exists: () => true` on a Mac would otherwise auto-select
    // Apple's recognizer and every whisper assertion below would be testing
    // the wrong route. The tests that mean Apple's say so.
    transcriber: 'whisper',
    whisperBin: '/opt/homebrew/bin/whisper-cli',
    whisperModel: '/models/ggml-small.en.bin',
    ffmpegBin: '/opt/homebrew/bin/ffmpeg',
    exists: () => true,
    spawn: spawner.spawn,
    log: line => { lines.push(line); },
    ...overrides,
  });
  return { instance, lines, spawner };
}

/**
 * A 16 kHz mono PCM16 wav, the shape ffmpeg writes in this pipeline.
 *
 * `amplitude` 0 makes a silent press. Giving `atMs` puts one 400 ms burst of
 * tone at that offset and leaves the rest near the noise floor, which is the
 * wearer who holds the grip for six seconds and says one word into it.
 */
function quietWav(seconds: number, { atMs, amplitude = 0 }: { atMs?: number; amplitude?: number } = {}): Buffer {
  const rate = 16_000;
  const count = Math.round(rate * seconds);
  const body = Buffer.alloc(count * 2);
  const burstStart = atMs === undefined ? -1 : Math.round((rate * atMs) / 1000);
  const burstEnd = burstStart + Math.round(rate * 0.4);
  for (let index = 0; index < count; index++) {
    const loud = burstStart >= 0 && index >= burstStart && index < burstEnd;
    const value = loud ? Math.sin((index / rate) * 2 * Math.PI * 220) * amplitude * 32_767 : 0;
    body.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(value))), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // linear PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

function chunk(over: Partial<PushToTalkAudioInput> = {}): PushToTalkAudioInput {
  return pushToTalkAudioSchema.parse({
    sessionId: SESSION, utteranceId: UTTERANCE, seq: 0, mime: 'audio/webm;codecs=opus',
    data: Buffer.from('opus-bytes').toString('base64'), final: false, ...over,
  });
}

describe('push-to-talk audio contract', () => {
  it('accepts one chunk and rejects anything else in the body', () => {
    expect(() => chunk()).not.toThrow();
    expect(() => pushToTalkAudioSchema.parse({ ...chunk(), sourceToken: 'x' })).toThrow();
    expect(() => pushToTalkAudioSchema.parse({ ...chunk(), mime: 'video/mp4' })).toThrow();
    expect(() => pushToTalkAudioSchema.parse({ ...chunk(), data: 'not base64!' })).toThrow();
    expect(() => pushToTalkAudioSchema.parse({ ...chunk(), seq: -1 })).toThrow();
    expect(() => pushToTalkAudioSchema.parse({ ...chunk(), data: 'A'.repeat(PTT_MAX_CHUNK_BASE64 + 4) })).toThrow();
  });

  it('allows a final marker with no audio and bounds the poll wait', () => {
    expect(pushToTalkAudioSchema.parse({ sessionId: SESSION, utteranceId: UTTERANCE, seq: 3, mime: 'audio/webm', final: true }).data).toBeUndefined();
    expect(() => pollVoiceTranscriptsSchema.parse({ sessionId: SESSION, waitMs: 60_000 })).toThrow();
    expect(pollVoiceTranscriptsSchema.parse({ sessionId: SESSION, after: 7 }).after).toBe(7);
  });
});

describe('chunk assembly', () => {
  it('orders chunks by sequence, not by arrival', () => {
    const chunks = new Map([[2, Buffer.from('c')], [0, Buffer.from('a')], [1, Buffer.from('b')]]);
    expect(assembleChunks(chunks, 2).toString()).toBe('abc');
  });

  it('refuses a hole rather than transcribing a splice', () => {
    const chunks = new Map([[0, Buffer.from('a')], [2, Buffer.from('c')]]);
    expect(() => assembleChunks(chunks, 2)).toThrow(/missing chunk 1/);
  });

  it('allows the final sequence to carry no audio', () => {
    const chunks = new Map([[0, Buffer.from('a')], [1, Buffer.from('b')]]);
    expect(assembleChunks(chunks, 2).toString()).toBe('ab');
  });
});

describe('whisper output parsing', () => {
  it('strips timestamps, non-speech markers and control characters', () => {
    expect(parseWhisperText('[00:00:00.000 --> 00:00:02.240]   Open the lattice.\n')).toBe('Open the lattice.');
    expect(parseWhisperText('[BLANK_AUDIO]\n')).toBe('');
    expect(parseWhisperText('(silence)')).toBe('');
    expect(parseWhisperText('one\ntwo\r\nthree')).toBe('one two three');
    expect(parseWhisperText(undefined)).toBe('');
  });

  it('caps a runaway transcript', () => {
    expect(parseWhisperText('word '.repeat(2_000)).length).toBeLessThanOrEqual(2_000);
  });

  /**
   * The 11:08 Quest 2 pass: a press made in near silence came back as the one
   * word "you", and the headset captioned it as though the wearer had spoken.
   */
  it('drops the fillers whisper produces for silent audio', () => {
    expect(parseWhisperText('you\n')).toBe('');
    expect(parseWhisperText('You.')).toBe('');
    expect(parseWhisperText('Thanks for watching!')).toBe('');
    expect(parseWhisperText(' Bye. ')).toBe('');
    expect(isWhisperSilence('Thank you')).toBe(true);
  });

  it('keeps a real sentence that happens to contain one', () => {
    expect(parseWhisperText('thank you, now make it bigger')).toBe('thank you, now make it bigger');
    expect(parseWhisperText('Show me the guide RNA.')).toBe('Show me the guide RNA.');
    expect(isWhisperSilence('')).toBe(false);
  });

  /** Whisper says its prior twice as readily as once. */
  it('drops a repeated filler, which the exact-match set let through', () => {
    expect(parseWhisperText('Thank you. Thank you.')).toBe('');
    expect(parseWhisperText('Bye. Bye. Bye.')).toBe('');
    expect(isWhisperSilence('um uh')).toBe(true);
  });

  /**
   * Every one-word command a wearer speaks has to survive this filter, or the
   * tour stops answering the shortest thing anyone says to it.
   */
  it('never eats a spoken command', () => {
    for (const command of ['next', 'back', 'up', 'down', 'stop', 'play', 'pause', 'bigger', 'smaller',
      'recenter', 'left', 'right', 'closer', 'away', 'repeat', 'tour', 'fit', 'reset']) {
      expect(isWhisperSilence(command), command).toBe(false);
      expect(parseWhisperText(`${command}\n`), command).toBe(command);
    }
    expect(parseWhisperText('next step')).toBe('next step');
    expect(parseWhisperText('show me chain B')).toBe('show me chain B');
  });

  /** A cough in front of a command used to take the command with it. */
  it('strips a non-speech marker and keeps the word beside it', () => {
    expect(parseWhisperText('[LAUGHTER] next')).toBe('next');
    expect(parseWhisperText('*cough* stop')).toBe('stop');
    expect(parseWhisperText('[APPLAUSE]\n')).toBe('');
  });
});

describe('transcription end to end with a fake spawner', () => {
  it.each(['apple', 'whisper', 'fallback'] as const)('keeps the first-chunk vocabulary and both texts on the %s route', async route => {
    const spawner = fakeSpawner({ text: 'Hi Jane', appleCode: route === 'fallback' ? 3 : 0 });
    const { instance } = transcriber({ transcriber: route === 'whisper' ? 'whisper' : 'apple',
      applespeechBin: '/opt/homebrew/bin/applespeech' }, spawner);
    const context: SpeechSceneContext = { chains: [{ labelChain: 'A', authorChain: 'X', copyId: '1' }],
      entityNames: ['Crambin'], componentIds: ['ATP'], residueNumbers: [840], pdbId: '1CRN',
      journeyTitles: ['Fold Detective'], representations: ['cartoon'] };
    const vocabulary = buildSpeechVocabulary(context);
    try {
      await instance.accept(chunk(), context);
      context.chains = []; context.entityNames = ['Jane']; context.pdbId = '4HHB';
      const outcome = await instance.accept(chunk({ seq: 1, final: true }), context);
      expect(outcome.transcript).toMatchObject({ text: 'Hi Jane', normalizedText: 'hide chain A',
        normalizationRules: [{ rule: 'hi-jane-chain-a', sceneTerm: 'chain A' }] });
      const entries = (await instance.transcripts.since(0, { waitMs: 0 })).entries;
      expect(entries[0]).toMatchObject(outcome.transcript!);
      if (route !== 'whisper') {
        const apple = spawner.calls.find(call => call.command.includes('applespeech'))!;
        expect(apple.args[apple.args.indexOf('--hint') + 1]).toBe(vocabulary.phrases.join(', '));
      }
      if (route !== 'apple') {
        const whisper = spawner.calls.find(call => call.command.includes('whisper'))!;
        expect(whisper.args[whisper.args.indexOf('--prompt') + 1]).toBe(vocabulary.whisperPrompt);
      }
      // The next press takes a fresh snapshot, including the competing name.
      const next = await instance.accept(chunk({ utteranceId: '33333333-3333-4333-8333-333333333333', final: true }), context);
      expect(next.transcript).toMatchObject({ text: 'Hi Jane', normalizedText: 'Hi Jane', normalizationRules: [] });
    } finally { await instance.dispose(); }
  });

  it('opens the utterance before asynchronous source vocabulary is ready', async () => {
    const { instance } = transcriber({}, fakeSpawner({ text: 'Hi Jane' }));
    let resolve!: (context: SpeechSceneContext) => void;
    const context = new Promise<SpeechSceneContext>(done => { resolve = done; });
    try {
      expect((await instance.accept(chunk(), context)).reason).toBe('chunk');
      const pending = instance.accept(chunk({ seq: 1, final: true }));
      resolve({ chains: [{ labelChain: 'A', authorChain: 'A', copyId: '1' }], entityNames: [],
        componentIds: [], residueNumbers: [], journeyTitles: [], representations: ['cartoon'] });
      expect((await pending).transcript).toMatchObject({ text: 'Hi Jane', normalizedText: 'hide chain A' });
    } finally { await instance.dispose(); }
  });

  it('assembles, decodes, transcribes and returns the text on the final chunk', async () => {
    const { instance, spawner } = transcriber();
    expect((await instance.accept(chunk({ seq: 0 }))).reason).toBe('chunk');
    expect((await instance.accept(chunk({ seq: 1 }))).reason).toBe('chunk');
    const outcome = await instance.accept(chunk({ seq: 2, final: true }));
    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toBe('transcribed');
    expect(outcome.transcript?.text).toBe('open the microtubule lattice');
    expect(outcome.transcript?.model).toBe('/models/ggml-small.en.bin');
    const ffmpeg = spawner.calls.find(call => call.command.includes('ffmpeg'))!;
    expect(ffmpeg.args).toEqual(expect.arrayContaining(['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']));
    const whisper = spawner.calls.find(call => call.command.includes('whisper'))!;
    expect(whisper.args).toEqual(expect.arrayContaining(['-m', '/models/ggml-small.en.bin', '-nt', '-np', '-otxt']));
    // The headset grammar's own phrases prime the decoder, so "spin it" is not
    // heard as "spitting" and a command does not detour through the agent.
    expect(whisper.args.slice(whisper.args.indexOf('--prompt'), whisper.args.indexOf('--prompt') + 2)).toEqual(['--prompt', WHISPER_INITIAL_PROMPT]);
    for (const phrase of ['Spin it.', 'Stop', 'Start the tour.', 'VR mode.', 'Reset the view.']) expect(WHISPER_INITIAL_PROMPT).toContain(phrase);
    await instance.dispose();
  });

  it('uses Apple\'s on-device recognizer when the host opted in, and whisper otherwise', async () => {
    const spawner = fakeSpawner({ text: 'Pause the tour' });
    const { instance } = transcriber({ transcriber: 'apple', applespeechBin: '/opt/homebrew/bin/applespeech' }, spawner);
    const outcome = await instance.accept(chunk({ seq: 0, final: true }));
    expect(outcome.accepted).toBe(true);
    expect(outcome.transcript?.text).toBe('Pause the tour');
    expect(outcome.transcript?.model).toBe(APPLESPEECH_MODEL_NAME);
    // Whisper is untouched on this route: no model file, no whisper process.
    expect(spawner.calls.some(call => call.command.includes('whisper'))).toBe(false);
    const apple = spawner.calls.find(call => call.command.includes('applespeech'))!;
    expect(apple.command).toBe('/opt/homebrew/bin/applespeech');
    // The recognizer is given the decoded wav, not the WebM the headset sent.
    expect(apple.args[0]).toMatch(/decoded\.16k\.wav$/);
    // The command phrases prime it the way `--prompt` primes whisper. Without
    // them "show cas9" comes back as "Show cast nine".
    const hint = apple.args[apple.args.indexOf('--hint') + 1]!;
    expect(apple.args).toContain('--hint');
    for (const phrase of ['spin it', 'start the tour', 'show cas9', 'assemble a microtubule', 'vr mode']) {
      expect(APPLESPEECH_HINTS).toContain(phrase);
      expect(hint).toContain(phrase);
    }
    await instance.dispose();
  });

  it('refuses the press only when the Apple tool is absent and no whisper install can stand in', async () => {
    const { instance } = transcriber({ transcriber: 'apple', applespeechBin: undefined, whisperBin: undefined,
      whisperModel: undefined, ffmpegBin: undefined, exists: () => false });
    expect(instance.ready).toBe(false);
    const outcome = await instance.accept(chunk({ seq: 0, final: true }));
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('disabled');
    expect(outcome.message).toContain(APPLESPEECH_BIN_ENV);
    expect(instance.describe()).toContain('applespeech');
    await instance.dispose();
  });

  it('falls back to whisper for a press macOS refused Speech Recognition on, and records why', async () => {
    // Exit 3 is the undismissed consent dialog: the wearer has the headset on
    // and cannot click it, so the press must still come back as words.
    const spawner = fakeSpawner({ appleCode: 3, text: 'pause the tour' });
    const { instance, lines } = transcriber({ transcriber: 'apple', applespeechBin: '/opt/homebrew/bin/applespeech' }, spawner);
    const outcome = await instance.accept(chunk({ seq: 0, final: true }));
    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toBe('transcribed');
    expect(outcome.transcript?.text).toBe('pause the tour');
    expect(outcome.transcript?.model).toBe('/models/ggml-small.en.bin');
    expect(outcome.transcript?.transcriberFallback).toContain('Speech Recognition');
    expect(spawner.calls.some(call => call.command.includes('whisper'))).toBe(true);
    expect(lines.join('\n')).toContain('falling back to whisper');
    expect(lines.join('\n')).toContain('Speech Recognition');
    await instance.dispose();
  });

  it('names the right cause for every applespeech exit code it falls back from', async () => {
    for (const [code, expected] of [[4, 'on-device speech model'], [5, 'could not decode'], [6, 'recognizer failed']] as const) {
      const spawner = fakeSpawner({ appleCode: code, text: 'next step' });
      const { instance } = transcriber({ transcriber: 'apple', applespeechBin: '/opt/homebrew/bin/applespeech' }, spawner);
      const outcome = await instance.accept(chunk({ seq: 0, final: true }));
      expect(outcome.transcript?.transcriberFallback).toContain(expected);
      await instance.dispose();
    }
  });

  it('falls back when the tool itself is missing but whisper is installed', async () => {
    const spawner = fakeSpawner({ text: 'next step' });
    const { instance } = transcriber({ transcriber: 'apple', applespeechBin: undefined,
      exists: (path: string) => !path.endsWith('/applespeech') }, spawner);
    expect(instance.ready).toBe(true);
    const outcome = await instance.accept(chunk({ seq: 0, final: true }));
    expect(outcome.accepted).toBe(true);
    expect(outcome.transcript?.transcriberFallback).toContain('applespeech tool was not found');
    expect(spawner.calls.some(call => call.command.includes('applespeech'))).toBe(false);
    await instance.dispose();
  });

  it('leaves no fallback note on a press the Apple recognizer handled', async () => {
    const spawner = fakeSpawner({ text: 'spin it' });
    const { instance } = transcriber({ transcriber: 'apple', applespeechBin: '/opt/homebrew/bin/applespeech' }, spawner);
    const outcome = await instance.accept(chunk({ seq: 0, final: true }));
    expect(outcome.transcript?.text).toBe('spin it');
    expect(outcome.transcript?.transcriberFallback).toBeUndefined();
    expect(spawner.calls.some(call => call.command.includes('whisper'))).toBe(false);
    await instance.dispose();
  });

  it('reads the route and the tool path from the environment', () => {
    const noTool = (path: string) => !path.endsWith('/applespeech');
    expect(transcriberKind({ [TRANSCRIBER_ENV]: 'whisper' }, { platform: 'darwin', exists: () => true })).toBe('whisper');
    // A typo keeps the route that needs no privacy grant.
    expect(transcriberKind({ [TRANSCRIBER_ENV]: 'aple' }, { platform: 'darwin', exists: () => true })).toBe('whisper');
    expect(transcriberKind({ [TRANSCRIBER_ENV]: ' Apple ' }, { platform: 'linux', exists: noTool })).toBe('apple');
    expect(applespeechBinCandidates({ PATH: '/somewhere/bin' })).toContain('/somewhere/bin/applespeech');
    // On the Apple route a Mac with no whisper and no model still counts as installed.
    const exists = (path: string) => path.endsWith('/applespeech') || path.endsWith('/ffmpeg');
    expect(localTranscriberInstalled({ environment: { [TRANSCRIBER_ENV]: 'apple' }, exists })).toBe(true);
    expect(localTranscriberInstalled({ environment: {}, platform: 'linux', exists })).toBe(false);
  });

  it('picks Apple on a Mac that has the tool, and whisper everywhere else', () => {
    const anything = () => true;
    const noTool = (path: string) => !path.endsWith('/applespeech');
    // Unset is the new user's case: a Mac with a built binary answers Apple.
    expect(transcriberKind({}, { platform: 'darwin', exists: anything })).toBe('apple');
    // The same Mac before `pnpm run build:applespeech` keeps whisper, rather
    // than reporting a missing tool on a host that transcribes fine.
    expect(transcriberKind({}, { platform: 'darwin', exists: noTool })).toBe('whisper');
    // Off macOS the Speech framework does not exist, whatever is on PATH.
    expect(transcriberKind({}, { platform: 'linux', exists: anything })).toBe('whisper');
    expect(transcriberKind({}, { platform: 'win32', exists: anything })).toBe('whisper');
    // An explicit setting beats the platform in both directions.
    expect(transcriberKind({ [TRANSCRIBER_ENV]: 'apple' }, { platform: 'linux', exists: noTool })).toBe('apple');
    expect(transcriberKind({ [TRANSCRIBER_ENV]: 'whisper' }, { platform: 'darwin', exists: anything })).toBe('whisper');
  });

  it('resolves Apple relative to source, bundled and installed dist roots without PATH', () => {
    for (const moduleUrl of ['file:///fixture/plugin/src/push-to-talk-transcribe.ts', 'file:///fixture/plugin/dist/server.mjs']) {
      expect(packagedApplespeechBins(moduleUrl)).toContain('/fixture/plugin/native/applespeech/bin/applespeech');
    }
    expect(packagedApplespeechBins('file:///installed/stereofold/dist/server.mjs'))
      .toContain('/installed/stereofold/native/applespeech/bin/applespeech');
    const binary = applespeechBinCandidates({})[0];
    const built = createPushToTalkTranscriber({ enabled: true, env: {}, platform: 'darwin', exists: path => path === binary || path.endsWith('/ffmpeg') });
    expect(built.route).toBe('apple');
    expect(built.ready).toBe(true);
    expect(built.readinessDetail()).toBe(`Apple recognizer at ${binary}; consent not yet observed`);
    expect(built.captureObserved(SESSION)).toBe(false);
    void built.dispose();
  });

  it('uses the same explicit Apple binary for route selection and resolution', () => {
    const binary = '/fixture/custom/applespeech';
    const exists = (path: string) => path === binary || path.endsWith('/ffmpeg');
    for (const options of [{ env: { [APPLESPEECH_BIN_ENV]: binary } }, { env: {}, applespeechBin: binary }]) {
      const built = createPushToTalkTranscriber({ enabled: true, platform: 'darwin', exists, ...options });
      expect(built.route).toBe('apple');
      expect(built.ready).toBe(true);
      expect(built.applespeechBin).toBe(binary);
      expect(built.readinessDetail()).toContain(`Apple recognizer at ${binary}`);
      void built.dispose();
    }
    const whisper = createPushToTalkTranscriber({ enabled: true, platform: 'darwin', exists,
      env: { [APPLESPEECH_BIN_ENV]: binary, [TRANSCRIBER_ENV]: 'whisper' } });
    expect(whisper.route).toBe('whisper');
    expect(whisper.ready).toBe(false);
    void whisper.dispose();
  });

  it('records capture only after successful transcription, scoped to its session', async () => {
    const { instance } = transcriber();
    try {
      expect(instance.captureObserved(SESSION)).toBe(false);
      await instance.accept({ sessionId: SESSION, utteranceId: UTTERANCE, seq: 0, mime: 'audio/webm', data: 'AAAA', final: false });
      expect(instance.captureObserved(SESSION)).toBe(false);
      await instance.accept({ sessionId: SESSION, utteranceId: UTTERANCE, seq: 1, mime: 'audio/webm', final: true });
      expect(instance.captureObserved(SESSION)).toBe(true);
      expect(instance.captureObserved('other-session')).toBe(false);
    } finally { await instance.dispose(); }
    expect(instance.captureObserved(SESSION)).toBe(false);
  });

  it('reports unresolved prerequisites even when capture is disabled', async () => {
    const instance = createPushToTalkTranscriber({ enabled: false, env: {}, transcriber: 'whisper',
      whisperBin: '/fixture/whisper-cli', ffmpegBin: '/fixture/ffmpeg', exists: path => path === '/fixture/whisper-cli' || path === '/fixture/ffmpeg' });
    try {
      expect(instance.enabled).toBe(false);
      expect(instance.ready).toBe(false);
      expect(instance.missing()).toEqual(['a whisper model']);
    } finally { await instance.dispose(); }
  });

  it.each([
    ['apple', 'applespeechBin', 'STEREOFOLD_APPLESPEECH_BIN', 'the applespeech tool'],
    ['apple', 'ffmpegBin', 'STEREOFOLD_FFMPEG_BIN', 'ffmpeg'],
    ['whisper', 'whisperBin', 'STEREOFOLD_WHISPER_BIN', 'whisper-cli'],
    ['whisper', 'whisperModel', 'STEREOFOLD_WHISPER_MODEL', 'a whisper model'],
    ['whisper', 'ffmpegBin', 'STEREOFOLD_FFMPEG_BIN', 'ffmpeg'],
  ] as const)('refuses missing configured %s prerequisite %s without replacing the named path', async (route, option, setting, missing) => {
    const configured = { applespeechBin: '/chosen/applespeech', ffmpegBin: '/chosen/ffmpeg',
      whisperBin: '/chosen/whisper-cli', whisperModel: '/chosen/model.bin' };
    const absent = configured[option];
    const installed = route === 'apple' ? [configured.applespeechBin, configured.ffmpegBin] : [configured.whisperBin, configured.whisperModel, configured.ffmpegBin];
    const exists = (path: string) => installed.includes(path) && path !== absent;
    const spawner = fakeSpawner();
    const instance = createPushToTalkTranscriber({ enabled: true, transcriber: route, env: {}, ...configured, exists, spawn: spawner.spawn });
    try {
      expect(instance.ready).toBe(false); expect(instance.missing()).toContain(missing);
      expect(instance[option]).toBe(absent);
      expect(instance.readinessDetail()).toContain(absent); expect(instance.describe()).toContain(absent);
      expect(await instance.accept(chunk({ final: true }))).toMatchObject({ accepted: false, reason: 'disabled' });
      expect(spawner.calls).toHaveLength(0);
      const environment = { [TRANSCRIBER_ENV]: route, STEREOFOLD_APPLESPEECH_BIN: configured.applespeechBin,
        STEREOFOLD_FFMPEG_BIN: configured.ffmpegBin, STEREOFOLD_WHISPER_BIN: configured.whisperBin,
        STEREOFOLD_WHISPER_MODEL: configured.whisperModel, [setting]: absent };
      expect(localTranscriberInstalled({ environment, exists, platform: 'darwin' })).toBe(false);
      expect(transcriptionEnabled(environment, () => localTranscriberInstalled({ environment, exists, platform: 'darwin' }))).toBe(false);
    } finally { await instance.dispose(); }
  });

  it('requires ffmpeg for Apple headset readiness and refuses WebM before spawning', async () => {
    const binary = '/fixture/applespeech';
    const exists = (path: string) => path === binary;
    const spawner = fakeSpawner();
    const instance = createPushToTalkTranscriber({ enabled: true, env: {}, transcriber: 'apple',
      applespeechBin: binary, exists, spawn: spawner.spawn });
    try {
      expect(instance.ready).toBe(false);
      expect(instance.missing()).toEqual(['ffmpeg']);
      expect(instance.describe()).toContain('missing ffmpeg');
      expect(localTranscriberInstalled({ environment: { [APPLESPEECH_BIN_ENV]: binary }, platform: 'darwin', exists })).toBe(false);
      const readiness = assembleReadiness({ hasScene: false, panels: [], agentAttached: false, listenWindowMs: 30_000,
        transcription: { enabled: instance.enabled, ready: instance.ready, route: instance.route,
          detail: instance.readinessDetail(), missing: instance.missing() },
        replies: { enabled: true, ready: true, detail: 'ready' }, headset: { checked: false }, checkedAt: '2026-09-19T12:00:00Z' });
      expect(readiness.items.find(item => item.capability === 'transcription')).toMatchObject({ state: 'missing' });
      expect(readiness.items.find(item => item.capability === 'transcription')?.detail).toContain('prerequisites missing: ffmpeg');
      const outcome = await instance.accept(chunk({ final: true }));
      expect(outcome).toMatchObject({ accepted: false, reason: 'disabled' });
      expect(outcome.message).toContain('STEREOFOLD_FFMPEG_BIN');
      expect(spawner.calls).toHaveLength(0);
    } finally { await instance.dispose(); }
  });

  it.each(['audio/wav', 'audio/mp4'])('keeps direct %s recognition available to Apple without ffmpeg', async mime => {
    const binary = '/fixture/applespeech';
    const spawner = fakeSpawner({ text: 'Pause the tour' });
    const instance = createPushToTalkTranscriber({ enabled: true, env: {}, transcriber: 'apple',
      applespeechBin: binary, exists: path => path === binary, spawn: spawner.spawn, log: () => {} });
    try {
      expect(instance.ready).toBe(false);
      const outcome = await instance.accept(chunk({ mime, final: true }));
      expect(outcome.transcript?.text).toBe('Pause the tour');
      expect(spawner.calls.map(call => call.command)).toEqual([binary]);
      expect(spawner.calls[0].args[0]).toContain(`utterance.${containerExtension(mime)}`);
    } finally { await instance.dispose(); }
  });

  it('looks for the packaged binary before any Homebrew install', () => {
    const candidates = applespeechBinCandidates({});
    const packaged = candidates.findIndex(path => path.endsWith('native/applespeech/bin/applespeech'));
    const homebrew = candidates.indexOf('/opt/homebrew/bin/applespeech');
    expect(packaged).toBeGreaterThanOrEqual(0);
    expect(homebrew).toBeGreaterThan(packaged);
    // The staged Codex artifact runs from its own copy of the package.
    expect(candidates.some(path => path.endsWith('release/stereofold/native/applespeech/bin/applespeech'))).toBe(true);
  });

  it('tells a first-time Mac user about the consent dialog and who it belongs to', () => {
    const { instance } = transcriber({ transcriber: 'apple', applespeechBin: '/opt/homebrew/bin/applespeech' });
    const line = instance.describe();
    expect(line).toContain("Apple's on-device recognizer");
    expect(line).toContain('Speech Recognition');
    expect(line).toContain('Terminal or Claude Code');
    // A launchd host has no window for the dialog, so it is told what to set.
    expect(line).toContain(`${TRANSCRIBER_ENV}=whisper`);
    expect(instance.describe()).toContain('falls back to whisper');
    void instance.dispose();
  });

  it('drops the same filler transcripts on the Apple route as on whisper', () => {
    expect(parseAppleSpeechText('  Thank you.  ')).toBe('');
    expect(parseAppleSpeechText('Pause the tour')).toBe('Pause the tour');
    expect(parseAppleSpeechText(undefined)).toBe('');
  });

  it('refuses to transcribe a silent press, so whisper cannot continue its own prompt', async () => {
    // Three seconds of pink room noise really did come back as "Start the tour."
    // from small.en with the shipped prompt, which fires tour-play. The gate
    // has to run before the recognizer, so the recognizer must never spawn.
    const spawner = fakeSpawner({ text: 'Start the tour', onWav: async path => { await writeFile(path, quietWav(3)); } });
    const { instance, lines } = transcriber({}, spawner);
    const outcome = await instance.accept(chunk({ seq: 0, final: true }));
    expect(outcome.accepted).toBe(true);
    expect(outcome.reason).toBe('transcribed');
    expect(outcome.transcript?.text).toBe('');
    expect(outcome.message).toBe('No speech was recognized.');
    expect(spawner.calls.some(call => call.command.includes('whisper'))).toBe(false);
    expect(lines.join('\n')).toContain('silent');
    await instance.dispose();
  });

  it('gates the Apple route too, which answers pure silence with "No"', async () => {
    const spawner = fakeSpawner({ text: 'No', onWav: async path => { await writeFile(path, quietWav(3)); } });
    const { instance } = transcriber({ transcriber: 'apple', applespeechBin: '/opt/homebrew/bin/applespeech' }, spawner);
    const outcome = await instance.accept(chunk({ seq: 0, final: true }));
    expect(outcome.transcript?.text).toBe('');
    expect(spawner.calls.some(call => call.command.includes('applespeech'))).toBe(false);
    await instance.dispose();
  });

  it('still transcribes one quiet word inside a long press', async () => {
    // The case a whole-clip average would throw away: six seconds of near
    // silence with one word in the middle, from a wearer well off the mic.
    const spawner = fakeSpawner({ text: 'next', onWav: async path => { await writeFile(path, quietWav(6, { atMs: 2_500, amplitude: 0.03 })); } });
    const { instance } = transcriber({}, spawner);
    const outcome = await instance.accept(chunk({ seq: 0, final: true }));
    expect(outcome.transcript?.text).toBe('next');
    expect(spawner.calls.some(call => call.command.includes('whisper'))).toBe(true);
    await instance.dispose();
  });

  it('measures the loudest window rather than the whole press, and reads the threshold from the environment', () => {
    const spoken = quietWav(6, { atMs: 2_500, amplitude: 0.03 });
    const silent = quietWav(6);
    expect(isSilentRecording(silent).silent).toBe(true);
    expect(isSilentRecording(spoken).silent).toBe(false);
    // The same recording judged by its whole-clip average would be discarded,
    // which is the reason the window exists.
    const decoded = readPcm16Wav(spoken)!;
    expect(decoded.sampleRate).toBe(16_000);
    expect(loudestWindowRms(decoded.samples, 16_000)).toBeGreaterThan(PTT_SILENCE_RMS);
    expect(loudestWindowRms(decoded.samples, 16_000, 6_000)).toBeLessThan(PTT_SILENCE_RMS);
    // A threshold of 0 turns the gate off; junk keeps the measured default.
    expect(isSilentRecording(silent, 0).silent).toBe(false);
    expect(silenceThreshold({})).toBe(PTT_SILENCE_RMS);
    expect(silenceThreshold({ [SILENCE_RMS_ENV]: '0.05' })).toBe(0.05);
    expect(silenceThreshold({ [SILENCE_RMS_ENV]: '0' })).toBe(0);
    expect(silenceThreshold({ [SILENCE_RMS_ENV]: 'loud' })).toBe(PTT_SILENCE_RMS);
    expect(silenceThreshold({ [SILENCE_RMS_ENV]: '-1' })).toBe(PTT_SILENCE_RMS);
    // Something that is not a wav we wrote is not evidence of silence.
    expect(isSilentRecording(Buffer.from('not a wav at all')).silent).toBe(false);
  });

  it('trims the auto-stop tail for Apple, which answers a 2 s tail with silence, and leaves whisper alone', async () => {
    // The headset stops recording after 2.5 s of quiet, so every auto-stopped
    // press carries a tail that makes Apple return nothing at all.
    const tail = quietWav(6, { atMs: 200, amplitude: 0.3 });
    const trimmed = trimTrailingSilence(tail)!;
    expect(trimmed.length).toBeLessThan(tail.length);
    const before = readPcm16Wav(tail)!, after = readPcm16Wav(trimmed)!;
    expect(after.sampleRate).toBe(before.sampleRate);
    // The word ends at 600 ms and PTT_APPLE_TAIL_KEEP_MS of quiet is kept.
    expect(after.samples.length / after.sampleRate).toBeGreaterThan(0.6);
    expect(after.samples.length / after.sampleRate).toBeLessThan(1.8);
    // It still says what it said: the trim only removes the tail.
    expect(loudestWindowRms(after.samples, after.sampleRate)).toBeCloseTo(loudestWindowRms(before.samples, before.sampleRate), 3);
    // Nothing to trim, and an all-quiet clip the gate owns, both decline.
    expect(trimTrailingSilence(quietWav(1, { atMs: 200, amplitude: 0.3 }))).toBeUndefined();
    expect(trimTrailingSilence(quietWav(6))).toBeUndefined();
    expect(trimTrailingSilence(Buffer.from('not a wav'))).toBeUndefined();

    // The whisper route must not be handed a trimmed file.
    const spawner = fakeSpawner({ text: 'next step', onWav: async path => { await writeFile(path, tail); } });
    const { instance } = transcriber({}, spawner);
    await instance.accept(chunk({ seq: 0, final: true }));
    const whisper = spawner.calls.find(call => call.command.includes('whisper'))!;
    expect(whisper.args[whisper.args.indexOf('-f') + 1]).toMatch(/decoded\.16k\.wav$/);
    await instance.dispose();

    const appleSpawner = fakeSpawner({ text: 'next step', onWav: async path => { await writeFile(path, tail); } });
    const apple = transcriber({ transcriber: 'apple', applespeechBin: '/opt/homebrew/bin/applespeech' }, appleSpawner);
    const outcome = await apple.instance.accept(chunk({ seq: 0, final: true }));
    expect(outcome.transcript?.text).toBe('next step');
    expect(appleSpawner.calls.find(call => call.command.includes('applespeech'))!.args[0]).toMatch(/trimmed\.16k\.wav$/);
    await apple.instance.dispose();
  });

  it('never decodes a recording onto its own path', async () => {
    // `containerExtension` maps audio/wav to wav. When the decode target was
    // also `utterance.wav`, ffmpeg exited with "Output ... same as Input #0"
    // and voice died for any browser that records wav.
    const spawner = fakeSpawner();
    const { instance } = transcriber({}, spawner);
    await instance.accept(chunk({ seq: 0, final: true, mime: 'audio/wav' }));
    const ffmpeg = spawner.calls.find(call => call.command.includes('ffmpeg'))!;
    const input = ffmpeg.args[ffmpeg.args.indexOf('-i') + 1];
    expect(input).toMatch(/utterance\.wav$/);
    expect(ffmpeg.args[ffmpeg.args.length - 1]).not.toBe(input);
    await instance.dispose();
  });

  it('drops the musical-note run whisper writes instead of [MUSIC]', () => {
    // A breath-only press came back as "♪♪" and reached the caption as
    // "Heard: ♪♪".
    expect(parseWhisperText('♪♪')).toBe('');
    expect(parseWhisperText('♪♪♪\n')).toBe('');
    expect(parseWhisperText('next')).toBe('next');
  });

  it('deletes every temporary file once the transcript exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ptt-clean-'));
    try {
      const { instance } = transcriber({ temporaryRoot: root });
      await instance.accept(chunk({ seq: 0 }));
      await instance.accept(chunk({ seq: 1, final: true }));
      expect(await readdir(root)).toEqual([]);
      expect(instance.pending()).toBe(0);
      await instance.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('deletes the temporary files when whisper fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ptt-fail-'));
    try {
      const { instance } = transcriber({ temporaryRoot: root }, fakeSpawner({ whisperCode: 3 }));
      await instance.accept(chunk({ seq: 0 }));
      const outcome = await instance.accept(chunk({ seq: 1, final: true }));
      expect(outcome.accepted).toBe(false);
      expect(outcome.reason).toBe('failed');
      expect(await readdir(root)).toEqual([]);
      await instance.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports a decode failure without claiming speech was heard', async () => {
    const { instance } = transcriber({}, fakeSpawner({ ffmpegCode: 1 }));
    await instance.accept(chunk({ seq: 0 }));
    const outcome = await instance.accept(chunk({ seq: 1, final: true }));
    expect(outcome.reason).toBe('failed');
    expect(outcome.transcript).toBeUndefined();
    await instance.dispose();
  });

  it('answers disabled when the host was started without voice', async () => {
    const { instance } = transcriber({ enabled: false });
    expect((await instance.accept(chunk())).reason).toBe('disabled');
    expect(instance.describe()).toMatch(/Headset voice is off/);
  });

  it('answers disabled and names what is missing when no transcriber is installed', async () => {
    const { instance } = transcriber({ whisperBin: undefined, whisperModel: undefined, ffmpegBin: undefined, exists: () => false });
    expect(instance.ready).toBe(false);
    expect((await instance.accept(chunk())).reason).toBe('disabled');
    expect(instance.describe()).toMatch(/whisper-cli.*whisper model.*ffmpeg/s);
  });
});

describe('bounds', () => {
  it('rejects a duplicate sequence rather than double-counting it', async () => {
    const { instance } = transcriber();
    await instance.accept(chunk({ seq: 0 }));
    expect((await instance.accept(chunk({ seq: 0 }))).reason).toBe('duplicate');
    await instance.dispose();
  });

  it('drops an utterance that exceeds the total size cap', async () => {
    const { instance } = transcriber({ });
    const big = Buffer.alloc(200 * 1024, 7).toString('base64');
    let last = await instance.accept(chunk({ seq: 0, data: big }));
    for (let seq = 1; seq < 64 && last.reason !== 'too_large'; seq++) last = await instance.accept(chunk({ seq, data: big }));
    expect(last.reason).toBe('too_large');
    expect(instance.pending()).toBe(0);
    await instance.dispose();
  });

  it('drops an utterance that runs past the duration cap', async () => {
    let clock = 1_000;
    const { instance } = transcriber({ now: () => clock });
    await instance.accept(chunk({ seq: 0 }));
    clock += PTT_MAX_DURATION_MS + 1;
    expect((await instance.accept(chunk({ seq: 1, final: true }))).reason).toBe('too_large');
    expect(instance.pending()).toBe(0);
    await instance.dispose();
  });

  it('refuses more than four utterances being assembled at once', async () => {
    const { instance } = transcriber();
    for (let index = 0; index < PTT_MAX_ACTIVE_UTTERANCES; index++) {
      await instance.accept(chunk({ utteranceId: `3333333${index}-3333-4333-8333-333333333333` }));
    }
    expect((await instance.accept(chunk({ utteranceId: '44444444-4444-4444-8444-444444444444' }))).reason).toBe('too_many');
    await instance.dispose();
  });

  it('rate-limits one session by chunks and by utterances', async () => {
    const { instance } = transcriber();
    let outcome = await instance.accept(chunk({ seq: 0 }));
    for (let seq = 1; seq <= PTT_MAX_CHUNKS_PER_WINDOW && outcome.reason !== 'rate_limited'; seq++) {
      outcome = await instance.accept(chunk({ seq }));
    }
    expect(outcome.reason).toBe('rate_limited');
    await instance.dispose();

    const second = transcriber().instance;
    let started = 0;
    for (let index = 0; index < PTT_MAX_UTTERANCES_PER_WINDOW + 2; index++) {
      const id = `5555555${index.toString(16)}-5555-4555-8555-555555555555`;
      const result = await second.accept(chunk({ utteranceId: id }));
      if (result.reason === 'chunk') started += 1;
      if (result.reason === 'chunk') await second.accept(chunk({ utteranceId: id, seq: 1, final: true }));
    }
    expect(started).toBe(PTT_MAX_UTTERANCES_PER_WINDOW);
    await second.dispose();
  });

  it('refuses a final marker for an utterance this session never started', async () => {
    const { instance } = transcriber();
    expect((await instance.accept(chunk({ seq: 4, final: true, data: undefined }))).reason).toBe('unknown_utterance');
    await instance.dispose();
  });

  it('refuses a chunk that claims another session’s utterance', async () => {
    const { instance } = transcriber();
    await instance.accept(chunk({ seq: 0 }));
    const other = await instance.accept(chunk({ seq: 1, sessionId: '99999999-9999-4999-8999-999999999999' }));
    expect(other.reason).toBe('unknown_utterance');
    await instance.dispose();
  });
});

describe('delivery fan-out', () => {
  it('appends to the transcript log at 0600, pipes to the text command, and calls extra deliveries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ptt-deliver-'));
    try {
      const log = join(root, 'voice.jsonl');
      const seen: TranscriptRecord[] = [];
      const bridged: TranscriptRecord[] = [];
      const spawner = fakeSpawner();
      const { instance } = transcriber({
        transcriptLog: log,
        textCommand: 'cat >/dev/null',
        bridge: { voice: record => { bridged.push(record); } },
        deliver: [record => { seen.push(record); }],
      }, spawner);
      await instance.accept(chunk({ seq: 0 }));
      await instance.accept(chunk({ seq: 1, final: true }));
      const written = JSON.parse((await readFile(log, 'utf8')).trim());
      expect(written.text).toBe('open the microtubule lattice');
      expect(written.utteranceId).toBe(UTTERANCE);
      expect((await stat(log)).mode & 0o777).toBe(0o600);
      expect(seen).toHaveLength(1);
      expect(bridged).toHaveLength(1);
      expect(spawner.stdins).toEqual(['open the microtubule lattice\n']);
      await instance.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('still publishes when one delivery throws', async () => {
    const { instance, lines } = transcriber({
      bridge: { voice: () => { throw Error('bridge is gone'); } },
      deliver: [() => { throw Error('nope'); }],
    });
    await instance.accept(chunk({ seq: 0 }));
    const outcome = await instance.accept(chunk({ seq: 1, final: true }));
    expect(outcome.transcript?.text).toBe('open the microtubule lattice');
    expect(instance.transcripts.all()).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/delivery failed/);
    await instance.dispose();
  });

  it('never lets a spoken word become shell syntax', async () => {
    const spawner = fakeSpawner({ text: '; rm -rf ~ && echo pwned' });
    const { instance } = transcriber({ textCommand: 'cat' }, spawner);
    await instance.accept(chunk({ seq: 0 }));
    await instance.accept(chunk({ seq: 1, final: true }));
    const shell = spawner.calls.find(call => call.command === '/bin/sh')!;
    expect(shell.args).toEqual(['-c', 'cat']);
    expect(spawner.stdins[0]).toBe('; rm -rf ~ && echo pwned\n');
    await instance.dispose();
  });
});

describe('transcript queue', () => {
  it('returns only what is newer than the cursor', async () => {
    const queue = createTranscriptQueue();
    const record = (text: string): TranscriptRecord => ({ utteranceId: UTTERANCE, text, durationMs: 100, receivedAt: new Date(0).toISOString(), model: 'm' });
    queue.publish(record('one'));
    queue.publish(record('two'));
    const first = await queue.since(0, { waitMs: 0 });
    expect(first.entries.map(entry => entry.text)).toEqual(['one', 'two']);
    expect(await queue.since(first.cursor, { waitMs: 0 })).toMatchObject({ entries: [] });
    queue.publish(record('three'));
    expect((await queue.since(first.cursor, { waitMs: 0 })).entries.map(entry => entry.text)).toEqual(['three']);
  });

  it('wakes a waiting poll as soon as the wearer speaks', async () => {
    const queue = createTranscriptQueue();
    const waiting = queue.since(0, { waitMs: 5_000 });
    queue.publish({ utteranceId: UTTERANCE, text: 'later', durationMs: 10, receivedAt: new Date(0).toISOString(), model: 'm' });
    expect((await waiting).entries.map(entry => entry.text)).toEqual(['later']);
  });

  it('names itself, so a cursor from another queue can be told apart', () => {
    const first = createTranscriptQueue(), second = createTranscriptQueue();
    expect(first.epoch).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.epoch).not.toBe(first.epoch);
    const named = first.epoch;
    first.publish({ utteranceId: UTTERANCE, text: 'one', durationMs: 1, receivedAt: new Date(0).toISOString(), model: 'm' });
    expect(first.epoch).toBe(named);
  });

  it('keeps only the most recent history', () => {
    const queue = createTranscriptQueue({ history: 2 });
    for (const text of ['a', 'b', 'c']) queue.publish({ utteranceId: UTTERANCE, text, durationMs: 1, receivedAt: new Date(0).toISOString(), model: 'm' });
    expect(queue.all().map(entry => entry.text)).toEqual(['b', 'c']);
  });
});

describe('the tool as the MCP server exposes it', () => {
  /** The same in-memory pair `inspection-server.test.ts` uses, with a real session. */
  async function session(overrides: Parameters<typeof createPushToTalkTranscriber>[0] = {}, spawner = fakeSpawner()) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createStereoStructureServer } = await import('../src/server.js');
    const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
    const built = transcriber(overrides, spawner);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const synthesized: string[] = [];
    const server = createStereoStructureServer(undefined, { transcriber: built.instance,
      replyAudio: { enabled: true, ready: true, describe: () => 'synthetic test speech', synthesize: async text => { synthesized.push(text); return undefined; } } });
    const client = new Client({ name: 'Headset voice contract test', version: '1' });
    await server.connect(b);
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) =>
      await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    const opened = await call('inspect', { structureText: cif });
    return { call, sessionId: opened.structuredContent.sessionId as string, built, synthesized,
      close: async () => { await built.instance.dispose(); await client.close(); await server.close(); } };
  }

  it('passes real source vocabulary per press and exposes raw text and correction rules to the consumer agent', async () => {
    const live = await session({ transcriber: 'apple', applespeechBin: '/opt/homebrew/bin/applespeech' }, fakeSpawner({ text: 'Hi Jane' }));
    try {
      const result = await live.call('push_to_talk_audio', { sessionId: live.sessionId, utteranceId: UTTERANCE,
        seq: 0, mime: 'audio/webm', data: Buffer.from('opus').toString('base64'), final: true });
      expect(result.isError).not.toBe(true);
      const record = result.structuredContent.transcript;
      expect(record).toMatchObject({ text: 'Hi Jane', normalizedText: 'hide chain A',
        normalizationRules: [{ rule: 'hi-jane-chain-a', from: 'Hi Jane', to: 'hide chain A', sceneTerm: 'chain A' }] });
      const apple = live.built.spawner.calls.find(call => call.command.includes('applespeech'))!;
      const hints = apple.args[apple.args.indexOf('--hint') + 1].toLowerCase();
      for (const term of ['chain a', 'crambin', '1crn', 'fold detective', 'thr']) expect(hints).toContain(term);
      const heard = await live.call('listen_voice', { timeoutSeconds: 1 });
      expect(heard.structuredContent.transcripts[0]).toMatchObject({ text: record.text, normalizedText: record.normalizedText,
        normalizationRules: record.normalizationRules, referent: record.referent, utteranceId: UTTERANCE, sequence: 1,
        // The stamps travel unchanged to both voice routes.
        at: record.receivedAt, transcribedAt: record.transcribedAt, recognizerMs: record.recognizerMs });
      expect(record.transcribedAt).toBeGreaterThanOrEqual(Date.parse(record.receivedAt));
      const poll = await live.call('poll_voice_transcripts', { sessionId: live.sessionId, waitMs: 0 });
      expect(poll.structuredContent.transcripts[0]).toMatchObject(record);
    } finally { await live.close(); }
  });

  it('carries an utterance through the real tool and returns the transcript', async () => {
    const live = await session();
    try {
      const utteranceId = '66666666-6666-4666-8666-666666666666';
      const base = { sessionId: live.sessionId, utteranceId, mime: 'audio/webm;codecs=opus' };
      const first = await live.call('push_to_talk_audio', { ...base, seq: 0, data: Buffer.from('opus').toString('base64'), final: false });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent.reason).toBe('chunk');
      const last = await live.call('push_to_talk_audio', { ...base, seq: 1, final: true });
      expect(last.structuredContent.transcript.text).toBe('open the microtubule lattice');
      const polled = await live.call('poll_voice_transcripts', { sessionId: live.sessionId, waitMs: 0 });
      expect(polled.structuredContent.transcripts.map((entry: any) => entry.text)).toEqual(['open the microtubule lattice']);
      expect(polled.structuredContent.cursor).toBe(1);
      const again = await live.call('poll_voice_transcripts', { sessionId: live.sessionId, after: polled.structuredContent.cursor, waitMs: 0 });
      expect(again.structuredContent.transcripts).toEqual([]);
    } finally { await live.close(); }
  });

  it('lets the model listen through listen_voice without a session, then move its cursor on', async () => {
    const live = await session();
    try {
      const utteranceId = '99999999-9999-4999-8999-999999999999';
      const base = { sessionId: live.sessionId, utteranceId, mime: 'audio/webm;codecs=opus' };
      await live.call('push_to_talk_audio', { ...base, seq: 0, data: Buffer.from('opus').toString('base64'), final: false });
      await live.call('push_to_talk_audio', { ...base, seq: 1, final: true });

      const heard = await live.call('listen_voice', { timeoutSeconds: 1 });
      expect(heard.isError).not.toBe(true);
      // The words arrive with what the wearer meant by "this"
      // when the press began, so a slow answer can still act on that.
      expect(heard.structuredContent.transcripts).toEqual([
        { utteranceId: expect.any(String), sequence: 1, utteranceSequence: 1, text: 'open the microtubule lattice', at: expect.any(String), durationMs: expect.any(Number),
          // `at` is the chunk landing; these two are the words
          // existing and what recognition cost to get there.
          transcribedAt: expect.any(Number), recognizerMs: expect.any(Number),
          normalizedText: 'open the microtubule lattice', normalizationRules: [],
          referent: { sourceToken: expect.any(String), capturedAt: expect.any(Number), selectionKeys: [] } },
      ]);
      expect(heard.structuredContent.timedOut).toBe(false);
      expect(heard.structuredContent.cursor).toBe(1);

      // The same cursor never replays what the agent already acted on.
      const quiet = await live.call('listen_voice', { timeoutSeconds: 1, cursor: heard.structuredContent.cursor });
      expect(quiet.structuredContent.transcripts).toEqual([]);
      expect(quiet.structuredContent.timedOut).toBe(true);
    } finally { await live.close(); }
  });

  it('starts over from the oldest held utterance when the cursor belongs to a restarted queue', async () => {
    const live = await session();
    try {
      const speak = async (utteranceId: string) => {
        const base = { sessionId: live.sessionId, utteranceId, mime: 'audio/webm;codecs=opus' };
        await live.call('push_to_talk_audio', { ...base, seq: 0, data: Buffer.from('opus').toString('base64'), final: false });
        await live.call('push_to_talk_audio', { ...base, seq: 1, final: true });
      };
      const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const restarted = 'The voice queue restarted since that cursor, so this answer starts from the oldest utterance it holds.';
      await speak(first);
      const heard = await live.call('listen_voice', { timeoutSeconds: 1 });
      const epoch = heard.structuredContent.epoch;
      expect(epoch).toBe(live.built.instance.transcripts.epoch);
      expect(heard.structuredContent.cursor).toBe(1);

      // The same epoch and a cursor this queue issued: read exactly as before.
      await speak(second);
      const next = await live.call('listen_voice', { timeoutSeconds: 1, cursor: 1, epoch });
      expect(next.structuredContent.transcripts.map((entry: any) => entry.utteranceId)).toEqual([second]);
      expect(next.structuredContent).toMatchObject({ cursor: 2, epoch });
      expect(next.content[0].text).not.toContain(restarted);

      // Another epoch is a server that restarted: its cursor 2 would have
      // skipped this queue's first two utterances.
      const stale = await live.call('listen_voice', { timeoutSeconds: 1, cursor: 2, epoch: '33333333-3333-4333-8333-333333333333' });
      expect(stale.structuredContent.transcripts.map((entry: any) => entry.utteranceId)).toEqual([first, second]);
      expect(stale.structuredContent).toMatchObject({ cursor: 2, epoch });
      expect(stale.content[0].text).toContain(restarted);

      // A cursor past this queue's head, with no epoch at all, is the same.
      const ahead = await live.call('listen_voice', { timeoutSeconds: 1, cursor: 7 });
      expect(ahead.structuredContent.transcripts.map((entry: any) => entry.utteranceId)).toEqual([first, second]);
      expect(ahead.content[0].text).toContain(restarted);
      expect(ahead.structuredContent.share).toBeUndefined();
    } finally { await live.close(); }
  });

  it('binds replies using only public listen envelopes and refuses the older request before synthesis', async () => {
    const live = await session();
    try {
      const data = (await live.call('get_inspection', { sessionId: live.sessionId }))._meta[PRIVATE_INSPECTION_META_KEY];
      const binding = { sessionId: live.sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
        baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
      const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0],
        assemblyId: data.catalog.assemblyId, selectionKeys: [],
        camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
          radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
        inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
          opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
          placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
      const saved = await live.call('sync_inspection', { ...binding, scene });
      expect(saved.isError).not.toBe(true);
      binding.baseStateRevision = saved.structuredContent.stateRevision;
      binding.baseInspectionRevision = saved.structuredContent.inspectionRevision;
      const attached = await live.call('attach_inspection', { ...binding, surface: 'companion' });
      expect(attached.isError).not.toBe(true);
      const panelId = attached.structuredContent.panelId;
      await live.call('poll_inspection', { ...binding, panelId, availability: 'ready' });
      const record = async (id: string, cursor = 0) => {
        const audio = { sessionId: live.sessionId, panelId, utteranceId: id, mime: 'audio/webm' };
        await live.call('push_to_talk_audio', { ...audio, seq: 0, data: 'AAAA', final: false });
        await live.call('push_to_talk_audio', { ...audio, seq: 1, final: true });
        return (await live.call('listen_voice', { timeoutSeconds: 1, cursor })).structuredContent;
      };
      const first = await record('11111111-1111-4111-8111-111111111111');
      const second = await record('22222222-2222-4222-8222-222222222222', first.cursor);
      const old = first.transcripts[0], current = second.transcripts[0];
      expect(old).toMatchObject({ utteranceId: expect.any(String), sequence: 1, referent: { sourceToken: binding.sourceToken } });
      expect(current.sequence).toBe(2);
      const refused = await live.call('say_to_headset', { text: 'Obsolete answer.', utteranceId: old.utteranceId });
      expect(refused.structuredContent).toMatchObject({ queued: false, delivered: false, audible: false, stale: true,
        utteranceId: old.utteranceId, activeUtteranceId: current.utteranceId });
      expect(refused.content[0].text).toContain('not prepared, shown or spoken');
      expect(live.synthesized).toEqual([]);
      const heartbeat = await live.call('poll_inspection', { ...binding, panelId, availability: 'ready' });
      expect(heartbeat._meta[PRIVATE_INSPECTION_META_KEY].headsetCaption).toBeUndefined();
    } finally { await live.close(); }
  });

  it('exposes listen_voice to the model and keeps the transcript poll app-only', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createStereoStructureServer } = await import('../src/server.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer();
    const client = new Client({ name: 'Voice visibility test', version: '1' });
    await server.connect(b);
    await client.connect(a);
    try {
      const listed = await client.listTools();
      const listen = listed.tools.find(tool => tool.name === 'stereo_structure.listen_voice');
      const poll = listed.tools.find(tool => tool.name === 'stereo_structure.poll_voice_transcripts');
      expect((listen?._meta?.ui as any)?.visibility).toBeUndefined();
      expect((poll?._meta?.ui as any)?.visibility).toEqual(['app']);
      // No session field: the wearer speaks into a headset, not into one panel.
      expect(Object.keys((listen?.inputSchema as any)?.properties ?? {}).sort()).toEqual(['cursor', 'epoch', 'timeoutSeconds']);
    } finally { await client.close(); await server.close(); }
  });

  it('refuses an expired session before any file is written', async () => {
    const live = await session();
    try {
      const failed = await live.call('push_to_talk_audio', {
        sessionId: '77777777-7777-4777-8777-777777777777', utteranceId: '88888888-8888-4888-8888-888888888888',
        seq: 0, mime: 'audio/webm', data: 'AAAA', final: true,
      });
      expect(failed.isError).toBe(true);
      expect(live.built.instance.pending()).toBe(0);
    } finally { await live.close(); }
  });
});

describe('the container a recording arrives in', () => {
  it('names the file for the type the headset declared', () => {
    expect(containerExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(containerExtension('audio/webm')).toBe('webm');
    expect(containerExtension('audio/mp4')).toBe('mp4');
    expect(containerExtension('audio/ogg;codecs=opus')).toBe('ogg');
    expect(containerExtension('AUDIO/MP4; codecs=mp4a.40.2')).toBe('mp4');
    expect(containerExtension('audio/wav')).toBe('wav');
  });

  it('keeps WebM for a type this Mac has never been sent', () => {
    expect(containerExtension('audio/basic')).toBe('webm');
    expect(containerExtension('')).toBe('webm');
  });

  it('accepts every container a browser will actually record', () => {
    for (const mime of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4',
      'audio/ogg;codecs=opus', 'audio/webm; codecs=opus', 'audio/mp4;codecs=mp4a.40.2']) {
      const parsed = pushToTalkAudioSchema.safeParse({ sessionId: SESSION, utteranceId: UTTERANCE, seq: 0, mime, final: true });
      expect(parsed.success, mime).toBe(true);
    }
  });
});

describe('whether this host transcribes at all', () => {
  const home = '/home/tester';
  const installed = new Set([
    '/opt/homebrew/bin/whisper-cli', '/opt/homebrew/bin/ffmpeg',
    `${home}/.cache/whisper-cpp/ggml-base.en.bin`,
  ]);
  const exists = (path: string) => installed.has(path);

  it('looks at the documented paths first and PATH second', () => {
    const environment = { PATH: '/somewhere/bin:relative/bin' };
    expect(whisperBinCandidates(environment)[0]).toBe('/opt/homebrew/bin/whisper-cli');
    expect(whisperBinCandidates(environment)).toContain('/somewhere/bin/whisper-cli');
    expect(ffmpegBinCandidates(environment)).toContain('/somewhere/bin/ffmpeg');
    // A relative PATH entry is not a path this can execute.
    expect(ffmpegBinCandidates(environment).some(path => path.startsWith('relative'))).toBe(false);
  });

  it('needs whisper-cli, a model and ffmpeg together', () => {
    expect(localTranscriberInstalled({ environment: {}, home, exists })).toBe(true);
    expect(localTranscriberInstalled({ environment: {}, home, exists: () => false })).toBe(false);
    // An explicit missing path must not silently use a different installed tool or auto-enable capture.
    expect(localTranscriberInstalled({ environment: { [WHISPER_BIN_ENV]: '/nowhere/whisper-cli' }, home, exists })).toBe(false);
  });

  // The Claude Science and Codex hosts set no environment of their own, so an
  // opt-in default left the orb recording with nothing on the Mac listening.
  it('is on by default wherever this Mac can transcribe', () => {
    expect(transcriptionEnabled({}, () => true)).toBe(true);
    expect(transcriptionEnabled({}, () => false)).toBe(false);
  });

  it('lets the environment decide when it says so', () => {
    expect(transcriptionEnabled({ [PUSH_TO_TALK_TRANSCRIBE_ENV]: '0' }, () => true)).toBe(false);
    expect(transcriptionEnabled({ [PUSH_TO_TALK_TRANSCRIBE_ENV]: 'off' }, () => true)).toBe(false);
    expect(transcriptionEnabled({ [PUSH_TO_TALK_TRANSCRIBE_ENV]: '1' }, () => false)).toBe(true);
  });

  // The transcriber runs in the MCP child, and the MCP default environment
  // filter keeps only HOME, LOGNAME, PATH, SHELL, TERM and USER. Every
  // STEREOFOLD_ name the transcriber reads therefore has to be named in the
  // launcher's own allowlist or the setting reaches nothing. The silence gate
  // is the one a wearer is most likely to need to tune per room.
  it('carries the silence gate across the launcher environment filter', async () => {
    const host = await readFile(new URL('../scripts/serve-inspection.ts', import.meta.url), 'utf8');
    expect(host).toContain(SILENCE_RMS_ENV);
    expect(host).toContain(TRANSCRIBER_ENV);
    expect(host).toContain(APPLESPEECH_BIN_ENV);
  });
});

/**
 * `receivedAt` marks the last audio chunk landing, before ffmpeg
 * and before any recognizer is spawned. Read alone it makes the recognizer's
 * whole run look like delivery, which is how the timing table came to call
 * a 334 ms upload "recognition". These tests hold a clock only the fake
 * recognizer moves, so the interval between the two stamps can be nothing but
 * recognition.
 */
describe('when the words existed', () => {
  const RECOGNIZER_MS = 1_400;
  const START = 1_789_000_000_000;

  function fakeClock(start = START) {
    let value = start;
    return { now: () => value, advance: (ms: number) => { value += ms; } };
  }

  /** ffmpeg costs nothing; each recognizer process costs `RECOGNIZER_MS`. */
  function recognizerSpawner(clock: ReturnType<typeof fakeClock>,
    options: Parameters<typeof fakeSpawner>[0] = {}) {
    const inner = fakeSpawner(options);
    const spawn = ((command: string, args: readonly string[], spawnOptions: any) => {
      if (command.includes('whisper') || command.includes('applespeech')) clock.advance(RECOGNIZER_MS);
      return inner.spawn(command, args, spawnOptions);
    }) as any;
    return { ...inner, spawn };
  }

  async function press(instance: ReturnType<typeof transcriber>['instance']) {
    await instance.accept(chunk({ seq: 0 }));
    return (await instance.accept(chunk({ seq: 1, final: true }))).transcript!;
  }

  it('stamps the recognizer run between the chunk landing and the words existing', async () => {
    const clock = fakeClock();
    const { instance } = transcriber({ now: clock.now }, recognizerSpawner(clock));
    try {
      const record = await press(instance);
      expect(record.text).toBe('open the microtubule lattice');
      // `at` still means the last chunk arriving, and nothing has moved it.
      expect(Date.parse(record.receivedAt)).toBe(START);
      expect(record.transcribedAt! - Date.parse(record.receivedAt)).toBe(RECOGNIZER_MS);
      expect(record.recognizerMs).toBe(RECOGNIZER_MS);
      const queued = (await instance.transcripts.since(0, { waitMs: 0 })).entries[0]!;
      expect(queued.transcribedAt).toBe(record.transcribedAt);
      expect(queued.recognizerMs).toBe(RECOGNIZER_MS);
    } finally { await instance.dispose(); }
  });

  it('takes the stamp before the deliveries, so a slow one never moves it', async () => {
    const clock = fakeClock();
    const seen: TranscriptRecord[] = [];
    const { instance } = transcriber({
      now: clock.now,
      deliver: [async record => { seen.push(record); clock.advance(5_000); }],
    }, recognizerSpawner(clock));
    try {
      const record = await press(instance);
      expect(seen).toHaveLength(1);
      // The delivery was handed the finished stamps, and its own 5 s is not in them.
      expect(seen[0]!.transcribedAt).toBe(record.transcribedAt);
      expect(record.transcribedAt! - Date.parse(record.receivedAt)).toBe(RECOGNIZER_MS);
      expect(record.recognizerMs).toBe(RECOGNIZER_MS);
    } finally { await instance.dispose(); }
  });

  it('counts both attempts when a press falls back from Apple to whisper', async () => {
    const clock = fakeClock();
    const { instance } = transcriber({ now: clock.now, transcriber: 'apple',
      applespeechBin: '/opt/homebrew/bin/applespeech' },
    recognizerSpawner(clock, { appleCode: 3 }));
    try {
      const record = await press(instance);
      expect(record.transcriberFallback).toBeDefined();
      // Apple's failed run is time the wearer waited for these words too.
      expect(record.recognizerMs).toBe(RECOGNIZER_MS * 2);
      expect(record.transcribedAt! - Date.parse(record.receivedAt)).toBe(RECOGNIZER_MS * 2);
    } finally { await instance.dispose(); }
  });

  it('reports no recognition at all for a press the energy gate answered', async () => {
    const clock = fakeClock();
    const spawner = recognizerSpawner(clock, { onWav: async path => { await writeFile(path, quietWav(1)); } });
    const { instance } = transcriber({ now: clock.now }, spawner);
    try {
      const record = await press(instance);
      expect(record.text).toBe('');
      expect(spawner.calls.some(call => call.command.includes('whisper'))).toBe(false);
      expect(record.recognizerMs).toBe(0);
      expect(record.transcribedAt).toBe(Date.parse(record.receivedAt));
    } finally { await instance.dispose(); }
  });
});
