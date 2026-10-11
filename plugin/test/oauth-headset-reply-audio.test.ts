import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOAuthReplyAudioSynthesizer } from '../src/oauth-headset-reply-audio.js';
import { createReplyVoiceCache, replyVoiceCacheRoot } from '../src/reply-voice-cache.js';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(40)]);
const OGG = Buffer.from('OggS oauth reply');
const exists = (path: string) => path === FFMPEG;

function spawner({ code = 0, clip = OGG }: { code?: number; clip?: Buffer } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = ((command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });
    const child: any = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    queueMicrotask(() => void (async () => {
      if (code === 0) await writeFile(args[args.length - 1], clip);
      child.emit('close', code);
    })());
    return child;
  }) as any;
  return { calls, spawn };
}

async function withRoot<T>(body: (root: string) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), 'oauth-reply-test-'));
  try { return await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe('OAuth headset reply audio', () => {
  it('renders a repeated line once and replays it from the cache the second time', async () => {
    await withRoot(async root => {
      const { calls, spawn } = spawner();
      const cache = createReplyVoiceCache({ root: join(root, 'reply-voice') });
      const rendered: string[] = [];
      const synth = createOAuthReplyAudioSynthesizer({
        ffmpegBin: FFMPEG, exists, spawn, tmpRoot: root, cache,
        synthesize: async (text: string) => { rendered.push(text); return { wavBase64: WAV.toString('base64') }; },
      });
      const line = 'Turn your head, or ask me to move the molecule.';
      const first = await synth.synthesize(line);
      const second = await synth.synthesize(line);
      expect(second).toEqual(first);
      // The helper ran once and ffmpeg ran once; the second answer came off disk.
      expect(rendered).toEqual([line]);
      expect(calls).toHaveLength(1);
      // A different sentence is a different key, so it still costs a render.
      await synth.synthesize('The binding pocket sits underneath it.');
      expect(rendered).toHaveLength(2);
    });
  });

  it.each([false, true])('shares concurrent identical renders with disk cache=%s while keeping other sentences parallel', async useCache => {
    await withRoot(async root => {
      const { calls, spawn } = spawner();
      const rendered: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const synth = createOAuthReplyAudioSynthesizer({
        ffmpegBin: FFMPEG, exists, spawn, tmpRoot: root,
        cache: useCache ? createReplyVoiceCache({ root: join(root, 'cache') }) : false,
        synthesize: async text => { rendered.push(text); await gate; return { wavBase64: WAV.toString('base64') }; },
      });
      const replies = ['Ready.', ' Ready. ', 'Ready.', 'Different sentence.'].map(line => synth.synthesize(line));
      try {
        await vi.waitFor(() => expect(rendered.sort()).toEqual(['Different sentence.', 'Ready.']));
        expect(calls).toHaveLength(0);
      } finally { release(); }
      const clips = await Promise.all(replies);
      expect(clips.every(Boolean)).toBe(true);
      expect(clips[0]).toEqual(clips[1]);
      expect(clips[0]).toEqual(clips[2]);
      expect(calls).toHaveLength(2);
      // Once complete, disk cache semantics still apply; disabling the disk
      // cache does not keep an unbounded in-memory cache of finished speech.
      await synth.synthesize('Ready.');
      expect(rendered).toHaveLength(useCache ? 2 : 3);
    });
  });

  it('releases a failed shared render so the same sentence can retry', async () => {
    await withRoot(async root => {
      const { calls, spawn } = spawner();
      let attempts = 0;
      let reject!: (error: Error) => void;
      const gate = new Promise<never>((_resolve, fail) => { reject = fail; });
      const synth = createOAuthReplyAudioSynthesizer({
        ffmpegBin: FFMPEG, exists, spawn, tmpRoot: root, cache: false, log: () => {},
        synthesize: async () => { attempts++; if (attempts === 1) await gate; return { wavBase64: WAV.toString('base64') }; },
      });
      const first = synth.synthesize('Try again.');
      const second = synth.synthesize('Try again.');
      expect(attempts).toBe(1);
      reject(Error('Injected OAuth failure'));
      expect(await Promise.all([first, second])).toEqual([undefined, undefined]);
      expect(calls).toHaveLength(0);
      expect(await synth.synthesize('Try again.')).toBeDefined();
      expect(attempts).toBe(2);
      expect(calls).toHaveLength(1);
      await expect(readdir(root)).resolves.toEqual([]);
    });
  });

  it('never reads or writes the host cache directory when a synthesiser was injected', async () => {
    await withRoot(async root => {
      const { spawn } = spawner();
      const synth = createOAuthReplyAudioSynthesizer({
        ffmpegBin: FFMPEG, exists, spawn, tmpRoot: root,
        synthesize: async () => ({ wavBase64: WAV.toString('base64') }),
      });
      const before = existsSync(replyVoiceCacheRoot());
      expect(await synth.synthesize('A line a test made up.')).toBeTruthy();
      // A test double is not paying for the round trip the cache exists to
      // skip, so it must leave the wearer's own clips alone.
      expect(existsSync(replyVoiceCacheRoot())).toBe(before);
    });
  });

  it('renders injected OAuth WAV bytes to the existing Opus clip contract and cleans up', async () => {
    await withRoot(async root => {
      const { calls, spawn } = spawner();
      const synth = createOAuthReplyAudioSynthesizer({
        ffmpegBin: FFMPEG, exists, spawn, tmpRoot: root,
        synthesize: async text => { expect(text).toBe('Scale the complex larger.'); return { wavBase64: WAV.toString('base64') }; },
      });
      const clip = await synth.synthesize('Scale the complex larger.');
      expect(clip).toMatchObject({ mimeType: 'audio/ogg; codecs=opus', format: 'ogg-opus', bytes: OGG.byteLength });
      expect(Buffer.from(clip!.base64, 'base64')).toEqual(OGG);
      expect(calls[0].command).toBe(FFMPEG);
      expect(calls[0].args.slice(calls[0].args.indexOf('-t'),calls[0].args.indexOf('-t')+2)).toEqual(['-t','15']);
      expect(calls[0].args).toEqual(expect.arrayContaining(['-c:a', 'libopus', '-ar', '24000', '-ac', '1']));
      expect(existsSync(root)).toBe(true);
      await expect(readdir(root)).resolves.toEqual([]);
    });
  });

  it('does not call OAuth when disabled or when ffmpeg is unavailable', async () => {
    let calls = 0;
    const options = { synthesize: async () => { calls += 1; return { wavBase64: WAV.toString('base64') }; } };
    const off = createOAuthReplyAudioSynthesizer({ ...options, enabled: false, exists });
    expect(off.ready).toBe(false);
    expect(await off.synthesize('hello')).toBeUndefined();
    const missing = createOAuthReplyAudioSynthesizer({ ...options, exists: () => false });
    expect(missing.ready).toBe(false);
    expect(await missing.synthesize('hello')).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('keeps the caption path alive on OAuth, WAV, ffmpeg, and size failures', async () => {
    const logged: string[] = [];
    const failedOAuth = createOAuthReplyAudioSynthesizer({ ffmpegBin: FFMPEG, exists, log: message => logged.push(message), synthesize: async () => { throw Error('OAuth unavailable'); } });
    expect(await failedOAuth.synthesize('hello')).toBeUndefined();
    const invalidWav = createOAuthReplyAudioSynthesizer({ ffmpegBin: FFMPEG, exists, log: message => logged.push(message), synthesize: async () => ({ wavBase64: Buffer.from('bad').toString('base64') }) });
    expect(await invalidWav.synthesize('hello')).toBeUndefined();
    const failedEncode = createOAuthReplyAudioSynthesizer({ ffmpegBin: FFMPEG, exists, ...spawner({ code: 1 }), log: message => logged.push(message), synthesize: async () => ({ wavBase64: WAV.toString('base64') }) });
    expect(await failedEncode.synthesize('hello')).toBeUndefined();
    const oversized = createOAuthReplyAudioSynthesizer({ ffmpegBin: FFMPEG, exists, ...spawner({ clip: Buffer.alloc(256) }), maxBase64: 8, log: message => logged.push(message), synthesize: async () => ({ wavBase64: WAV.toString('base64') }) });
    expect(await oversized.synthesize('hello')).toBeUndefined();
    expect(logged).toHaveLength(4);
    expect(logged[0]).toContain('OAuth unavailable');
    expect(logged[1]).toContain('invalid audio');
    expect(logged[2]).toContain('ffmpeg failed');
    expect(logged[3]).toContain('inline limit');
  });

  it('says which narration helper this Mac is missing, and how to leave the route', () => {
    const missing = createOAuthReplyAudioSynthesizer({ ffmpegBin: FFMPEG, exists, env: {} });
    expect(missing.ready).toBe(false);
    expect(missing.describe()).toContain('STEREOFOLD_AGENT_VOICE_BIN');
    expect(missing.describe()).toContain('STEREOFOLD_REPLY_VOICE_PROVIDER=system');
    const relative = createOAuthReplyAudioSynthesizer({ ffmpegBin: FFMPEG, exists, env: { STEREOFOLD_AGENT_VOICE_BIN: 'agent-voice' } });
    expect(relative.ready).toBe(false);
    expect(relative.describe()).toContain('must be an absolute path');
    // A Mac that keeps the helper on PATH needs no setting at all.
    const present = createOAuthReplyAudioSynthesizer({ ffmpegBin: FFMPEG, exists: () => true, env: { PATH: '/opt/homebrew/bin' } });
    expect(present.ready).toBe(true);
    expect(present.describe()).toContain('OAuth narration selected');
  });

  it('resolves the narration helper from the host environment it was given', async () => {
    const { spawn } = spawner();
    const seen: Array<Record<string, string | undefined> | undefined> = [];
    const synth = createOAuthReplyAudioSynthesizer({
      ffmpegBin: FFMPEG, exists, spawn, env: { STEREOFOLD_AGENT_VOICE_BIN: '/opt/homebrew/bin/agent-voice' },
      synthesize: async (_text, options) => { seen.push(options?.env as Record<string, string | undefined>); return { wavBase64: WAV.toString('base64') }; },
    });
    expect(await synth.synthesize('Spinning.')).toBeDefined();
    expect(seen[0]?.STEREOFOLD_AGENT_VOICE_BIN).toBe('/opt/homebrew/bin/agent-voice');
  });

  it('bounds text and never puts it in ffmpeg arguments', async () => {
    const { calls, spawn } = spawner();
    let received = '';
    const synth = createOAuthReplyAudioSynthesizer({ ffmpegBin: FFMPEG, exists, spawn, synthesize: async text => { received = text; return { wavBase64: WAV.toString('base64') }; } });
    expect(await synth.synthesize('x'.repeat(281))).toBeUndefined();
    expect(await synth.synthesize('-delete-this')).toBeDefined();
    expect(received).toBe('-delete-this');
    expect(calls[0].args.some(argument => argument.includes('delete-this'))).toBe(false);
  });
});
