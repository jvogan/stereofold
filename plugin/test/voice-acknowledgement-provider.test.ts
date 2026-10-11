import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemVoiceAcknowledgement, voiceAcknowledgementFromEnv } from '../src/headset-voice-provider.js';

// A page's own confirmation ("Spinning.", a tour line) follows the reply
// provider. It used to be OAuth whatever the provider said, and a Mac set to
// the system voice showed its wearer a setup sentence instead of speaking.
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

/** A stand-in for /usr/bin/say that records its arguments and writes a WAV header where -o points. */
async function fakeSay() {
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-fake-say-'));
  directories.push(directory);
  const bin = join(directory, 'say'), args = join(directory, 'args.txt');
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\nout=''\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\n`
    + `printf 'RIFF\\044\\000\\000\\000WAVEfmt ' > "$out"\nhead -c 48 /dev/zero >> "$out"\n`);
  await chmod(bin, 0o755);
  return { bin, args: async () => (await readFile(args, 'utf8')).trim().split('\n') };
}

describe('spoken confirmations on the system voice', () => {
  it('writes WAV with say, reading the line from a file so it is never an option', async () => {
    const say = await fakeSay();
    const spoken = await systemVoiceAcknowledgement('-o /tmp/elsewhere', say.bin, 'Samantha');
    expect(Buffer.from(spoken.wavBase64, 'base64').subarray(0, 4).toString('ascii')).toBe('RIFF');
    const args = await say.args();
    expect(args.slice(0, 3)).toEqual(['-v', 'Samantha', '-f']);
    expect(args).not.toContain('/tmp/elsewhere');
    expect(args).toContain('--file-format=WAVE');
  });

  it('follows STEREOFOLD_REPLY_VOICE_PROVIDER=system and its say binary', async () => {
    const say = await fakeSay();
    const acknowledge = voiceAcknowledgementFromEnv({ STEREOFOLD_REPLY_VOICE_PROVIDER: 'system', STEREOFOLD_SAY_BIN: say.bin, HOME: '/nonexistent-home' });
    const spoken = await acknowledge('Spinning.');
    expect(Buffer.from(spoken.wavBase64, 'base64').subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(await say.args()).not.toContain('Spinning.');
  });

  it('refuses anything but one short line', async () => {
    await expect(systemVoiceAcknowledgement('two\nlines', '/usr/bin/false')).rejects.toThrow(/one short line/);
    await expect(systemVoiceAcknowledgement('x'.repeat(181), '/usr/bin/false')).rejects.toThrow(/one short line/);
  });
});
