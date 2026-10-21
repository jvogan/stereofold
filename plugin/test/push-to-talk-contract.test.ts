// @ts-ignore Shared wearer status wording.
import { NOBODY_LISTENING_LINE } from '../../lab/browser-roundtrip/assistant-status.mjs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { parseQuestArgs } from '../scripts/quest-share.js';
import { TOOLS as COMPANION_TOOLS } from '../src/inspection-companion-http.js';
import { ALLOWED_TOOLS as LAN_TOOLS } from '../src/inspection-lan.js';
import { pushToTalkSchema } from '../src/inspection-contract.js';
import { PUSH_TO_TALK_ENABLED_ENV, PUSH_TO_TALK_TOOL } from '../src/push-to-talk.js';
// @ts-ignore Shared JavaScript grip module, the same one the companion bundles.
import { attachGripPushToTalk, pushToTalkBinding, setPushToTalkSender, setVoiceCommandSender } from '../../lab/browser-roundtrip/push-to-talk-grip.mjs';
// @ts-ignore Shared browser controller is bundled into the companion.
import { createVoiceInteraction } from '../../lab/browser-roundtrip/voice-interaction.mjs';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

/** Minimal XRSession stand-in: the `end` event and the source list. */
function fakeSession() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    inputSources: [] as unknown[],
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) { listeners.get(type)?.delete(handler); },
    emit(type: string, event: unknown = {}) { for (const handler of [...(listeners.get(type) ?? [])]) handler(event); },
    count(type: string) { return listeners.get(type)?.size ?? 0; },
  };
}

async function setup(enabled: boolean) {
  const previous = process.env[PUSH_TO_TALK_ENABLED_ENV];
  if (enabled) process.env[PUSH_TO_TALK_ENABLED_ENV] = '1';
  else delete process.env[PUSH_TO_TALK_ENABLED_ENV];
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer();
  const client = new Client({ name: 'Push-to-talk contract test', version: '1' });
  await server.connect(b); await client.connect(a);
  if (previous === undefined) delete process.env[PUSH_TO_TALK_ENABLED_ENV];
  else process.env[PUSH_TO_TALK_ENABLED_ENV] = previous;
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  return { call, sessionId, close: async () => { await client.close(); await server.close(); } };
}

describe('push-to-talk transport contract', () => {
  it('is allowed on the loopback companion and the LAN companion', () => {
    expect(COMPANION_TOOLS.has(PUSH_TO_TALK_TOOL)).toBe(true);
    expect(LAN_TOOLS.has(PUSH_TO_TALK_TOOL)).toBe(true);
    // The two allowlists must not drift apart; the LAN front end proxies to
    // the loopback one, so a name in either alone is unreachable or unused.
    expect([...LAN_TOOLS].sort()).toEqual([...COMPANION_TOOLS].sort());
  });

  it('accepts only a down or up edge and a session ID', () => {
    const id = randomUUID();
    expect(pushToTalkSchema.safeParse({ sessionId: id, state: 'down' }).success).toBe(true);
    expect(pushToTalkSchema.safeParse({ sessionId: id, state: 'up' }).success).toBe(true);
    expect(pushToTalkSchema.safeParse({ sessionId: id, state: 'sideways' }).success).toBe(false);
    expect(pushToTalkSchema.safeParse({ sessionId: id }).success).toBe(false);
    expect(pushToTalkSchema.safeParse({ sessionId: 'not-a-uuid', state: 'down' }).success).toBe(false);
    // No command, path, or free text can ride along with an edge.
    expect(pushToTalkSchema.safeParse({ sessionId: id, state: 'down', command: 'rm -rf /' }).success).toBe(false);
  });

  it('records a grip pair against a live session when the host ran with --ptt', async () => {
    const t = await setup(true);
    try {
      const down = await t.call(PUSH_TO_TALK_TOOL, { sessionId: t.sessionId, state: 'down' });
      expect(down.isError).not.toBe(true);
      expect(down.structuredContent).toMatchObject({ state: 'down', accepted: true, ran: false, listening: true });
      // A repeat while the grip is held changes nothing on the desktop.
      expect((await t.call(PUSH_TO_TALK_TOOL, { sessionId: t.sessionId, state: 'down' })).structuredContent)
        .toMatchObject({ accepted: false, reason: 'repeat' });
      expect((await t.call(PUSH_TO_TALK_TOOL, { sessionId: t.sessionId, state: 'up' })).structuredContent)
        .toMatchObject({ state: 'up', accepted: true, listening: false });
      expect((await t.call(PUSH_TO_TALK_TOOL, { sessionId: 'not-a-session', state: 'down' })).isError).toBe(true);
      expect((await t.call(PUSH_TO_TALK_TOOL, { sessionId: t.sessionId, state: 'squeeze' })).isError).toBe(true);
    } finally { await t.close(); }
  });

  it('is on unless the run says otherwise', () => {
    // An explicit empty environment, because this run's own shell may export
    // STEREOFOLD_PTT_TRANSCRIBE and these are the assertions about what the
    // flags alone decide.
    const parse = (...args: string[]) => parseQuestArgs(args, '/home/tester', {});
    expect(parse('1CRN').pushToTalk).toBe(true);
    expect(parse('1CRN', '--ptt').pushToTalk).toBe(true);
    expect(parse('--ptt', '1CRN').pushToTalk).toBe(true);
    expect(parse('1CRN', '--no-ptt').pushToTalk).toBe(false);
    // A headless run renders for a test rather than for a wearer.
    expect(parse('1CRN', '--headless').pushToTalk).toBe(false);
    expect(parse('1CRN', '--headless', '--ptt').pushToTalk).toBe(true);
  });

  it('is registered but inert without --ptt', async () => {
    const t = await setup(false);
    try {
      const result = await t.call(PUSH_TO_TALK_TOOL, { sessionId: t.sessionId, state: 'down' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ accepted: false, reason: 'disabled' });
    } finally { await t.close(); }
  });
});

describe('the talk binding a held A or X drives', () => {
  it('sends one down and one up for one hold and shows the indicator while held', async () => {
    const session = fakeSession();
    const sent: string[] = [], shown: string[] = [];
    const talk = attachGripPushToTalk({ session, send: async (state: string) => { sent.push(state); }, status: (text: string) => { shown.push(text); } });

    // The button reader dispatches `down` once per hold, however many frames
    // the thumb spans, but a binding that opened a second microphone on a
    // repeated start would still be a bug worth catching here.
    await talk.start();
    await talk.start();
    expect(talk.listening()).toBe(true);
    expect(shown).toEqual(['Listening…']);
    await talk.stop();
    await talk.stop();
    await talk.dispose();
    expect(sent).toEqual(['down', 'up']);
    expect(shown).toEqual(['Listening…', NOBODY_LISTENING_LINE]);
    // Push-to-talk left the grips so both grips could grab the structure. A
    // binding that registers a squeeze again re-opens the old misfire: a
    // wearer steadying a two-hand scale opened a mic.
    expect(session.count('squeezestart')).toBe(0);
    expect(session.count('squeezeend')).toBe(0);
  });

  it('publishes itself so the viewer\'s button reader can find it without holding the session', async () => {
    const session = fakeSession();
    const talk = attachGripPushToTalk({ session, send: async () => {} });
    expect(pushToTalkBinding()).toBe(talk);
    await talk.dispose();
    expect(pushToTalkBinding()).toBeUndefined();
  });

  it('closes an open hold when the session ends', async () => {
    const session = fakeSession();
    const sent: string[] = [];
    const talk = attachGripPushToTalk({ session, send: async (state: string) => { sent.push(state); } });
    await talk.start();
    session.emit('end');
    await talk.dispose();
    expect(sent).toEqual(['down', 'up']);
    expect(talk.listening()).toBe(false);
  });

  it('falls back to the sender the companion page registered, and survives its failure', async () => {
    const session = fakeSession();
    const seen: string[] = [];
    setPushToTalkSender(async (state: string) => { seen.push(state); throw new Error('offline'); });
    const talk = attachGripPushToTalk({ session });
    await talk.start();
    await talk.stop();
    await talk.dispose();
    expect(seen).toEqual(['down', 'up']);
    setPushToTalkSender(undefined);
  });

  it('does not claim listening until capture starts, then dispatches only the returned typed command', async () => {
    const session = fakeSession();
    const shown: string[] = [], applied: string[] = [], sequence: string[] = [];
    const capture = { start: async () => { sequence.push('capture'); }, stop: async () => ({ pcm16leBase64: 'AAAA', sampleRate: 24_000, durationMs: 180 }) };
    setVoiceCommandSender({ unlock: async () => { sequence.push('unlock'); }, start: async () => ({ requestId: 'voice-1' }),
      send: async () => ({ command: 'tour-next', message: 'Next scene received.' }) });
    const talk = attachGripPushToTalk({ session, capture, status: (text: string) => { shown.push(text); },
      onCommand: async (command: string) => { applied.push(command); return { message: 'Next scene queued.' }; } });
    await talk.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sequence).toEqual(['unlock', 'capture']);
    expect(shown).toEqual(['Starting microphone…', 'Listening…']);
    await talk.stop();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(applied).toEqual(['tour-next']);
    expect(shown.at(-1)).toBe('Next scene queued.');
    await talk.dispose(); setVoiceCommandSender(undefined);
  });

  it('keeps the menu Talk row and the held button on one interaction, so neither opens a second microphone', async () => {
    const session = fakeSession();
    const capture = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const playback = { unlock: vi.fn(async () => undefined), play: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
    const interaction = createVoiceInteraction({ capture, playback, begin: async () => ({ requestId: 'held' }), send: async () => ({ message: 'Queued.' }) });
    const talk = attachGripPushToTalk({ session, interaction });
    await talk.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(interaction.state()).toBe('listening');
    expect(await interaction.start()).toBe(false); // the menu's Talk row uses this same controller
    expect(capture.start).toHaveBeenCalledOnce();
    await talk.stop();
    await new Promise(resolve => setTimeout(resolve, 0));
    await talk.dispose();
  });

  it('uses the shared interaction for one hold without opening a second capture', async () => {
    const session = fakeSession();
    const shown: string[] = [], calls: string[] = [];
    const interaction = {
      start: async () => { calls.push('start'); },
      stop: async () => { calls.push('stop'); return { message: 'Reply played.' }; },
    };
    const talk = attachGripPushToTalk({ session, interaction, status: (text: string) => { shown.push(text); } });
    await talk.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    await talk.stop();
    await new Promise(resolve => setTimeout(resolve, 0));
    await talk.dispose();
    expect(calls).toEqual(['start', 'stop']);
    expect(shown).toEqual(['Starting microphone…', 'Listening…', NOBODY_LISTENING_LINE, 'Reply played.']);
  });
});
