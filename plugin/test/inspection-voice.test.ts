import { describe, expect, it } from 'vitest';
import { createHeadsetVoicePlaybackQueue, createInspectionVoiceIntentQueue, createVoiceCommandHandler, normalizeVoiceTranscript, registerInspectionVoiceTools, voiceCommandFromTranscript } from '../src/inspection-voice.js';

const binding = {
  sessionId: '11111111-1111-4111-8111-111111111111', serverEpoch: '22222222-2222-4222-8222-222222222222',
  sourceToken: '33333333-3333-4333-8333-333333333333', baseStateRevision: 4, baseInspectionRevision: 5,
  panelId: '44444444-4444-4444-8444-444444444444',
};
const pcm = Buffer.alloc(8_640).toString('base64');
const input = { ...binding, audio: { pcm16leBase64: pcm, sampleRate: 24_000, durationMs: 180 } };

describe('bounded OAuth voice command contract', () => {
  it('normalizes only exact named commands', () => {
    expect(normalizeVoiceTranscript('Jarvis, please, next scene now.')).toBe('next scene');
    expect(voiceCommandFromTranscript('Jarvis, please, next scene.')).toBe('tour-next');
    expect(voiceCommandFromTranscript('Move overhead.')).toBe('move-overhead');
    expect(voiceCommandFromTranscript('assemble filament')).toBe('assemble-filament');
    expect(voiceCommandFromTranscript('Add EB1 protein')).toBeUndefined();
    expect(voiceCommandFromTranscript('Add EB3 protein')).toBe('add-eb3-protein');
    expect(voiceCommandFromTranscript('Show Cas 9')).toBe('show-cas9');
    expect(voiceCommandFromTranscript('Show telomerase')).toBe('show-telomerase');
    expect(voiceCommandFromTranscript('delete every file')).toBeUndefined();
    expect(voiceCommandFromTranscript('x'.repeat(241))).toBeUndefined();
  });

  it('dispatches spoken retry instead of queueing it as an intent', async () => {
    expect(voiceCommandFromTranscript('retry')).toBe('retry');
    expect(voiceCommandFromTranscript('Try again')).toBe('retry');
    expect(voiceCommandFromTranscript('retry the highlight')).toBe('retry');
    expect(voiceCommandFromTranscript('tell me a joke')).toBeUndefined();
    for (const heard of ['retry', 'try again']) {
      const dispatched: string[] = [];
      const handle = createVoiceCommandHandler({ validate: async () => {}, transcribe: async () => heard,
        dispatch: async command => { dispatched.push(command); return { message: 'The highlight is back.' }; } });
      await expect(handle(input)).resolves.toEqual({ command: 'retry', message: 'The highlight is back.' });
      expect(dispatched).toEqual(['retry']);
    }
    const missed: string[] = [];
    const miss = createVoiceCommandHandler({ validate: async () => {}, transcribe: async () => 'tell me a joke',
      dispatch: async command => { missed.push(command); return { message: 'should not run' }; } });
    await expect(miss(input)).resolves.toEqual({ message: 'I did not recognize that command.' });
    expect(missed).toEqual([]);
  });

  it('revalidates the current source binding after transcription and before dispatch', async () => {
    const calls: string[] = [];
    const handle = createVoiceCommandHandler({
      validate: async request => { calls.push(`validate:${request.sourceToken}`); },
      transcribe: async () => { calls.push('transcribe'); return 'next scene'; },
      dispatch: async command => { calls.push(`dispatch:${command}`); return { message: 'Next scene queued.' }; },
    });
    await expect(handle(input)).resolves.toEqual({ command: 'tour-next', message: 'Next scene queued.' });
    expect(calls).toEqual(['validate:33333333-3333-4333-8333-333333333333', 'transcribe', 'validate:33333333-3333-4333-8333-333333333333', 'dispatch:tour-next']);
  });

  it('does not expose a transcript or dispatch an unknown utterance', async () => {
    const dispatched: string[] = [];
    const handle = createVoiceCommandHandler({ validate: async () => {}, transcribe: async () => 'make a new molecule',
      dispatch: async command => { dispatched.push(command); return { message: 'should not run' }; } });
    await expect(handle(input)).resolves.toEqual({ message: 'I did not recognize that command.' });
    expect(dispatched).toEqual([]);
  });

  it('queues unknown bounded text for one desktop host claim without retaining audio', () => {
    let clock = 100;
    const queue = createInspectionVoiceIntentQueue({ now: () => clock, ttlMs: 60_000 });
    const enqueued = queue.enqueue({ ...binding, transcript: 'Can you explain the lattice?' });
    const claim = queue.claim({ sessionId: binding.sessionId, sourceToken: binding.sourceToken, desktopPanelId: 'desktop-panel' });
    expect(claim).toEqual(expect.objectContaining({ intent: expect.objectContaining({ id: enqueued.id, transcript: 'Can you explain the lattice?', panelId: binding.panelId }), desktopPanelId: 'desktop-panel' }));
    expect(queue.claim({ sessionId: binding.sessionId, sourceToken: binding.sourceToken, desktopPanelId: 'desktop-panel' })).toBeUndefined();
    expect(queue.acknowledge({ intentId: claim!.intent.id, claimToken: claim!.claimToken, desktopPanelId: 'wrong-panel' })).toBe(false);
    expect(queue.acknowledge({ intentId: claim!.intent.id, claimToken: claim!.claimToken, desktopPanelId: claim!.desktopPanelId })).toBe(true);
    clock += 61_000;
    expect(queue.size()).toBe(0);
  });

  it('registers app-only recognition and acknowledgement plus model-visible headset speech', async () => {
    const tools = new Map<string, (input: unknown) => Promise<any>>();
    const configs = new Map<string, any>();
    const queue = createInspectionVoiceIntentQueue();
    const playback = createHeadsetVoicePlaybackQueue();
    const registered = registerInspectionVoiceTools((name, config, handle) => { configs.set(name, config); tools.set(name, handle); }, {
      validate: async request => { expect(request.sourceToken).toBe(binding.sourceToken); },
      transcribe: async () => 'What does this microtubule do?',
      acknowledge: async message => ({ wavBase64: Buffer.from(`RIFF${message}`).toString('base64') }),
      intentQueue: queue, playbackQueue: playback, cooldownMs: 0,
    });
    const response = await tools.get('stereo_structure.voice_command')!(input);
    expect(response.structuredContent).toEqual(expect.objectContaining({ message: 'Request queued for the connected task.' }));
    expect(JSON.stringify(response)).not.toContain('microtubule do');
    const claimed = registered.intents.claim({ sessionId: binding.sessionId, sourceToken: binding.sourceToken, desktopPanelId: 'desktop-panel' });
    expect(claimed?.intent.transcript).toBe('What does this microtubule do?');
    const speak = await tools.get('stereo_structure.speak_to_headset')!({ ...binding, message: 'The lattice is stable.' });
    expect(speak.structuredContent.queued).toBe(true);
    expect(configs.get('stereo_structure.voice_command')._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(configs.get('stereo_structure.speak_to_headset')._meta).toEqual({});
    for (const name of ['voice_command', 'voice_acknowledgement', 'speak_to_headset']) {
      expect(configs.get(`stereo_structure.${name}`).annotations).toMatchObject({
        readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
      });
    }
    const queued = registered.playbacks.next(binding);
    expect(queued?.wavBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(registered.playbacks.acknowledge(queued!.id, binding)).toBe(true);
    expect(registered.playbacks.lastAcknowledgement(binding)).toMatchObject({id: queued!.id, panelId: binding.panelId, sourceToken: binding.sourceToken});
  });
});
