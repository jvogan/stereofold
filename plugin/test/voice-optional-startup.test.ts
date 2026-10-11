/**
 * Starting on a Mac that has only Node.
 *
 * Voice is the one part of Stereofold that needs programs this repository does
 * not ship: a Python 3 for recognition, and an `agent-voice` helper for
 * replies. Neither is a reason a molecular viewer should fail to start, and
 * before this both were read while the MCP server registered its tools: a host
 * with no Python threw during registration and every tool went with it,
 * including the ones that only draw molecules.
 *
 * These tests stand in for that machine. `node:fs` is stubbed so nothing named
 * python3 or agent-voice is executable anywhere, PATH is emptied, and the
 * config file is one this Mac does not have. The server must still come up and
 * answer tools/list, and the voice tools must say they are off and name the
 * setting that turns them back on.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const HELPERS = /(?:^|\/)(?:python3|python3\.\d+|agent-voice)$/;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const accessSync: typeof actual.accessSync = (path, mode) => {
    if (HELPERS.test(String(path))) { const error = Error(`ENOENT: ${String(path)}`); throw error; }
    return actual.accessSync(path, mode);
  };
  return { ...actual, accessSync, default: { ...actual, accessSync } };
});

const { createStereoStructureServer } = await import('../src/server.js');
const { registerInspectionVoiceTools } = await import('../src/inspection-voice.js');
const { PYTHON3_BIN_ENV, PYTHON3_CONFIG_KEY, findPython3, missingPython3Message, oauthTranscriptionState }
  = await import('../src/oauth-voice-transcription.js');
const { AGENT_VOICE_BIN_ENV, AGENT_VOICE_CONFIG_KEY, agentVoiceBin, missingAgentVoiceMessage }
  = await import('../src/oauth-voice-acknowledgement.js');
const { forgetLocalConfig } = await import('../src/local-helper-config.js');

const pluginRoot = new URL('..', import.meta.url);
const binding = {
  sessionId: '11111111-1111-4111-8111-111111111111', serverEpoch: '22222222-2222-4222-8222-222222222222',
  sourceToken: '33333333-3333-4333-8333-333333333333', baseStateRevision: 4, baseInspectionRevision: 5,
  panelId: '44444444-4444-4444-8444-444444444444',
};
const audio = { pcm16leBase64: Buffer.alloc(8_640).toString('base64'), sampleRate: 24_000, durationMs: 180 };

/** A Mac with node and nothing else on PATH, and no Stereofold config file. */
const bareEnvironment = { PATH: '', HOME: '/nonexistent-home', STEREOFOLD_CONFIG: '/nonexistent-home/config.json' };

beforeEach(() => {
  forgetLocalConfig();
  vi.stubEnv('PATH', '');
  vi.stubEnv('HOME', '/nonexistent-home');
  vi.stubEnv('STEREOFOLD_CONFIG', '/nonexistent-home/config.json');
  vi.stubEnv('STEREOFOLD_AGENT_VOICE_BIN', '');
  vi.stubEnv('STEREOFOLD_PYTHON3_BIN', '');
  return () => { vi.unstubAllEnvs(); forgetLocalConfig(); };
});

describe('a host with only Node', () => {
  it('registers every tool and answers tools/list with no Python on the machine', async () => {
    expect(findPython3({ env: bareEnvironment })).toBeUndefined();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', pluginRoot).pathname, {});
    const client = new Client({ name: 'Stereofold python-free startup test', version: '0.1.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain('stereo_structure.open');
      expect(names).toContain('stereo_structure.inspect');
      // The voice tools are registered too. They are off, not absent: a host
      // that hides them cannot explain why speaking does nothing.
      expect(names).toContain('stereo_structure.voice_command');
      expect(names).toContain('stereo_structure.voice_acknowledgement');
      expect(names).toContain('stereo_structure.speak_to_headset');

      // The viewer itself works, which is the whole point of not failing.
      const opened = await client.callTool({
        name: 'stereo_structure.open',
        arguments: { structureText: 'ATOM      1  N   GLY A   1       1.000   2.000   3.000  1.00 10.00           N\nEND\n', format: 'pdb' },
      }) as { isError?: boolean };
      expect(opened.isError).not.toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it('reports recognition as off and names the setting, at the moment it is asked', async () => {
    const tools = new Map<string, (input: unknown) => Promise<unknown>>();
    // Registration must not touch the helpers at all. If it did, this call
    // would throw here rather than inside the tool.
    registerInspectionVoiceTools((name, _config, handle) => { tools.set(name, handle); }, {
      validate: async () => undefined,
      cooldownMs: 0,
    });

    const recognized = tools.get('stereo_structure.voice_command')!({ ...binding, audio })
      .catch((error: Error) => error);
    const failure = await recognized as Error;
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('Voice recognition is off');
    expect(failure.message).toContain(PYTHON3_BIN_ENV);
    expect(failure.message).toContain(PYTHON3_CONFIG_KEY);
    expect(failure.message).not.toContain('/Users/');

    // A page's spoken confirmation keeps its caption and goes silent. The
    // setup sentence names this Mac's settings, so it goes to this Mac's log
    // rather than onto the wearer's screen.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const spoken = await tools.get('stereo_structure.voice_acknowledgement')!({ ...binding, message: 'Grown to the wall.' });
      expect(spoken).toEqual({ structuredContent: { speechDropped: true } });
      const line = logged.mock.calls.map(call => String(call[0])).find(text => text.includes('Voice replies are off'));
      expect(line).toBeDefined();
      expect(line).toContain(AGENT_VOICE_BIN_ENV);
    } finally { logged.mockRestore(); }
  });

  it('says the same thing through the readiness state, without spawning anything', () => {
    const state = oauthTranscriptionState({ env: bareEnvironment, config: {}, home: '/nonexistent-home' });
    expect(state.ready).toBe(false);
    expect(state.reason).toBe(missingPython3Message(bareEnvironment, '/nonexistent-home'));
    expect(state.reason).toContain(PYTHON3_BIN_ENV);

    expect(agentVoiceBin(bareEnvironment, { config: {}, home: '/nonexistent-home' })).toBeUndefined();
    const off = missingAgentVoiceMessage(undefined, bareEnvironment, '/nonexistent-home');
    expect(off).toContain(AGENT_VOICE_BIN_ENV);
    expect(off).toContain(AGENT_VOICE_CONFIG_KEY);
  });
});
