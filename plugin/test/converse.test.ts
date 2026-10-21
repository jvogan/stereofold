/**
 * `pnpm --dir plugin run converse` is what an operator runs with a wearer in the
 * headset: it hears the wearer, prints what they said with the scene it was
 * said against, and sends back what the terminal agent decides. Everything
 * here drives it against a synthetic loopback host, because the two failures
 * that matter are both protocol failures — an utterance read twice or skipped,
 * and a queued command reported as a change the wearer saw.
 */
import { describe, expect, it } from 'vitest';
import { converse, parseCommandLine, sceneSummary, voiceLines, LISTEN_CEILING_SECONDS, LISTEN_WINDOW_SECONDS } from '../scripts/converse.js';
import { LISTEN_VOICE_DEFAULT_SECONDS, LISTEN_VOICE_MAX_SECONDS } from '../src/push-to-talk-transcribe.js';
import { fakeAgentHost, type Call } from './helpers/fake-agent-host.js';

const BINDING = {
  serverEpoch: '11111111-1111-4111-8111-111111111111',
  sourceToken: '22222222-2222-4222-8222-222222222222',
  stateRevision: 4,
  inspectionRevision: 9,
};
const PANELS = [{ panelId: 'quest-panel', surface: 'companion', availability: 'ready', current: true }];
const stateReply = (extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text: 'Stereofold inspection state.' }],
  structuredContent: {
    kind: 'inspection', sessionId: 'session-1', hasScene: true, ...BINDING, panels: PANELS,
    sourceKind: 'pdb', sourceSelection: { modelNumber: 1, assemblyId: 'asymmetric_unit' },
    lesson: { id: 'crispr', title: 'CRISPR', parts: ['guide RNA'] },
    view: { modelNumber: 1, assemblyId: 'asymmetric_unit', selectedResidueCount: 3, appearance: { representation: 'cartoon' } },
    ...extra,
  },
});

const heard = (text: string, cursor: number, extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text }],
  structuredContent: { cursor, listening: true, timedOut: false,
    transcripts: [{ utteranceId: `u-${cursor}`, utteranceSequence: cursor, text, at: '2026-09-13T20:00:00.000Z', durationMs: 900, ...extra }] },
});
const silence = (cursor: number) => ({
  content: [{ type: 'text', text: 'The wearer said nothing in that window.' }],
  structuredContent: { transcripts: [], cursor, timedOut: true, listening: true },
});

/** Run the loop until it has written `expected` lines, then stop it. */
async function run(options: {
  reply: (call: Call) => unknown;
  input?: string[];
  expected: number;
  timeoutMs?: number;
}) {
  const host = await fakeAgentHost(options.reply);
  const lines: any[] = [];
  const stopping = new AbortController();
  let settle: () => void = () => {};
  const enough = new Promise<void>(done => { settle = done; });
  const write = (line: string) => {
    lines.push(JSON.parse(line));
    if (lines.length >= options.expected) settle();
  };
  // stdin stays open in a real session, so the input iterator only ends when
  // the loop is stopped; here it hands over its lines and then waits.
  async function* input() {
    for (const line of options.input ?? []) yield line;
    await enough;
  }
  const loop = converse({ statePath: host.statePath, input: input(), write, note: () => {},
    wait: { pollMs: 1, timeoutMs: options.timeoutMs ?? 2_000 }, idleFloorMs: 1,
    retry: { minMs: 1, maxMs: 2 }, stop: stopping.signal });
  const guard = setTimeout(settle, 10_000);
  try {
    await enough;
    stopping.abort();
    await loop;
  } finally { clearTimeout(guard); await host.close(); }
  return { lines, calls: host.calls };
}

describe('the listening window', () => {
  it('keeps the ceiling and the default the contract sets', () => {
    expect(LISTEN_CEILING_SECONDS).toBe(LISTEN_VOICE_MAX_SECONDS);
    expect(LISTEN_WINDOW_SECONDS).toBe(LISTEN_VOICE_DEFAULT_SECONDS);
  });

  it('never asks the host to block for longer than it will', async () => {
    let asked: number | undefined;
    const { calls } = await run({
      expected: 1,
      reply: call => {
        if (call.name === 'listen_voice') {
          asked = call.arguments.timeoutSeconds;
          return heard('open the ribosome', 1);
        }
        return stateReply();
      },
    });
    expect(asked).toBe(LISTEN_WINDOW_SECONDS);
    expect(calls[0].name).toBe('listen_voice');
  });
});

describe('hearing the wearer', () => {
  it('prints one line per utterance, with the ID, sequence, referent and the scene it was said against', async () => {
    const referent = { kind: 'part', name: 'guide RNA' };
    const { lines } = await run({
      expected: 1,
      reply: call => (call.name === 'listen_voice' ? heard('make this one orange', 7, { referent }) : stateReply()),
    });
    expect(lines[0]).toMatchObject({
      type: 'voice', utteranceId: 'u-7', sequence: 7, text: 'make this one orange', referent,
    });
    expect(lines[0].scene).toMatchObject({
      hasScene: true, selectedResidueCount: 3, representation: 'cartoon',
      source: { kind: 'pdb', modelNumber: 1, assemblyId: 'asymmetric_unit' },
      lesson: { id: 'crispr', title: 'CRISPR' },
    });
  });

  /**
   * The probe found `listen-voice.ts` swallowing the first thing
   * the wearer said after it attached, because it threw a whole first answer
   * away to establish a cursor. This loop carries the host's cursor forward
   * instead, and the host hands each utterance out once, so the first request
   * is printed and the second is not a repeat of it.
   */
  it('prints the first request as well as the second, and reads neither twice', async () => {
    let polls = 0;
    const { lines, calls } = await run({
      expected: 2,
      reply: call => {
        if (call.name !== 'listen_voice') return stateReply();
        polls += 1;
        if (polls === 1) return heard('FIRST_NEW_REQUEST', 1);
        if (polls === 2) return heard('SECOND_NEW_REQUEST', 2);
        return silence(2);
      },
    });
    expect(lines.map(line => line.text)).toEqual(['FIRST_NEW_REQUEST', 'SECOND_NEW_REQUEST']);
    const cursors = calls.filter(call => call.name === 'listen_voice').map(call => call.arguments.cursor);
    expect(cursors[0]).toBeUndefined();
    expect(cursors[1]).toBe(1);
    expect(cursors[2]).toBe(2);
  });

  /**
   * The scene read used to start when the transcript arrived, so
   * every utterance paid a whole state round trip before the wearer's words
   * were printed. This host answers its second poll only once a state read has
   * come in during that poll, so a loop that still read after the transcript
   * would wait for a poll that waits for it and print nothing at all.
   */
  it('reads the scene beside the poll rather than after the words', async () => {
    let reads = 0;
    let releaseSecondPoll = () => {};
    const readDuringPoll = new Promise<void>(done => { releaseSecondPoll = done; });
    let polls = 0;
    const { lines } = await run({
      expected: 2,
      reply: async call => {
        if (call.name !== 'listen_voice') { reads += 1; if (reads >= 2) releaseSecondPoll(); return stateReply(); }
        polls += 1;
        if (polls === 1) return heard('FIRST_REQUEST', 1);
        if (polls === 2) { await readDuringPoll; return heard('SECOND_REQUEST', 2); }
        return silence(2);
      },
    });
    expect(lines.map(line => line.text)).toEqual(['FIRST_REQUEST', 'SECOND_REQUEST']);
    expect(lines[1].scene).toMatchObject({ hasScene: true, representation: 'cartoon' });
  });

  it('prints when the words were heard, and how old the scene beside them is', async () => {
    const transcribedAt = Date.parse('2026-09-13T20:00:01.334Z');
    const { lines } = await run({
      expected: 1,
      reply: call => (call.name === 'listen_voice'
        ? heard('make this one blue', 3, { transcribedAt, recognizerMs: 334 })
        : stateReply()),
    });
    // `at` is the audio landing and is unchanged; the recognizer's run is the
    // interval between the two, and everything after it is this loop's.
    expect(lines[0]).toMatchObject({ at: '2026-09-13T20:00:00.000Z', transcribedAt, recognizerMs: 334 });
    expect(lines[0].transcribedAt - Date.parse(lines[0].at)).toBe(1_334);
    expect(lines[0].emittedAt).toBeGreaterThanOrEqual(lines[0].sceneAt);
    expect(lines[0].sceneAgeMs).toBe(lines[0].emittedAt - lines[0].sceneAt);
  });

  it('says nothing at all for an empty window and keeps listening', async () => {
    let polls = 0;
    const { lines } = await run({
      expected: 1,
      reply: call => {
        if (call.name !== 'listen_voice') return stateReply();
        polls += 1;
        return polls < 3 ? silence(polls) : heard('now show the sticks', 3);
      },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'voice', text: 'now show the sticks' });
  });

  it('reports a failed poll and retries rather than stopping', async () => {
    let polls = 0;
    const { lines } = await run({
      expected: 2,
      reply: call => {
        if (call.name !== 'listen_voice') return stateReply();
        polls += 1;
        if (polls === 1) throw Error('Stereofold session was not found or has expired.');
        return heard('are you still there', 1);
      },
    });
    expect(lines[0]).toMatchObject({ type: 'error', scope: 'voice' });
    expect(lines[0].message).toContain('expired');
    expect(lines[1]).toMatchObject({ type: 'voice', text: 'are you still there' });
  });

  it('re-reads the control file every call, so a rotated token is picked up', async () => {
    const host = await fakeAgentHost(call => (call.name === 'listen_voice' ? silence(1) : stateReply()));
    try {
      await host.rotate({ token: 'b'.repeat(64) });
      const lines: string[] = [];
      const stopping = new AbortController();
      const loop = converse({ statePath: host.statePath, write: line => lines.push(line), note: () => {},
        idleFloorMs: 1, retry: { minMs: 1, maxMs: 2 }, stop: stopping.signal });
      await new Promise(done => setTimeout(done, 60));
      stopping.abort();
      await loop;
      // A stale token would have been refused with 403 on every call.
      expect(host.calls.length).toBeGreaterThan(0);
      expect(lines.filter(line => line.includes('"scope":"voice"'))).toEqual([]);
    } finally { await host.close(); }
  });
});

describe('sending what the agent decided', () => {
  it('fills the binding in, waits for the rendered receipt, and only then says rendered', async () => {
    let reads = 0;
    const { lines, calls } = await run({
      expected: 1,
      input: ['{"id":"orange","tool":"update_inspection","args":{"change":{"kind":"appearance","patch":{"uniformColor":"#ff8800"}}}}'],
      reply: call => {
        if (call.name === 'get_inspection_state') {
          reads += 1;
          return stateReply(call.arguments.commandId ? { command: { commandId: call.arguments.commandId, status: reads < 3 ? 'rendering' : 'rendered' } } : {});
        }
        if (call.name === 'listen_voice') return silence(0);
        return { content: [{ type: 'text', text: 'Inspection command queued.' }],
          structuredContent: { command: { commandId: 'cmd-1', status: 'queued' } } };
      },
    });
    const result = lines.find(line => line.type === 'result');
    expect(result).toMatchObject({ id: 'orange', tool: 'update_inspection', rendered: true });
    expect(result.receipt.status).toBe('rendered');
    const sent = calls.find(call => call.name === 'update_inspection')!;
    expect(sent.arguments.serverEpoch).toBe(BINDING.serverEpoch);
    // Left for the host to fill on arrival, so a placement save cannot strand it.
    expect(sent.arguments).not.toHaveProperty('baseInspectionRevision');
    expect(sent.arguments.panelId).toBe('quest-panel');
    expect(String(sent.arguments.commandId)).toMatch(/^cli-/u);
  });

  it('never reports rendered for a command the panel is still drawing', async () => {
    const { lines } = await run({
      expected: 1,
      timeoutMs: 30,
      input: ['{"tool":"update_inspection","args":{"change":{"kind":"motion","patch":{"state":"spin"}}}}'],
      reply: call => {
        if (call.name === 'get_inspection_state') return stateReply(call.arguments.commandId ? { command: { commandId: 'cmd-1', status: 'rendering' } } : {});
        if (call.name === 'listen_voice') return silence(0);
        return { content: [{ type: 'text', text: 'Inspection command queued.' }],
          structuredContent: { command: { commandId: 'cmd-1', status: 'queued' } } };
      },
    });
    const result = lines.find(line => line.type === 'result');
    expect(result.rendered).toBe(false);
    expect(result.receipt.status).toBe('rendering');
    expect(result.timedOut).toBe(true);
  });

  it('declares a correction before the command it corrects, and threads its ID in', async () => {
    const { lines, calls } = await run({
      expected: 1,
      input: ['{"tool":"emphasize","utterance":"correct","args":{"parts":["guide RNA"]}}'],
      reply: call => {
        if (call.name === 'get_inspection_state') return stateReply(call.arguments.commandId ? { command: { commandId: call.arguments.commandId, status: 'rendered' } } : {});
        if (call.name === 'listen_voice') return silence(0);
        if (call.name === 'update_inspection') {
          return { content: [{ type: 'text', text: 'Utterance correct recorded.' }],
            structuredContent: { lifecycle: { utterance: { utteranceId: 'utt-9', sequence: 9 },
              commands: [{ commandId: 'older', status: 'cancelled' }], action: 'correct', rendered: false } } };
        }
        return { content: [{ type: 'text', text: 'Emphasis command queued.' }],
          structuredContent: { command: { commandId: 'cmd-2', status: 'queued' } } };
      },
    });
    const order = calls.map(call => call.name).filter(name => name === 'update_inspection' || name === 'emphasize');
    expect(order).toEqual(['update_inspection', 'emphasize']);
    const declared = calls.find(call => call.name === 'update_inspection')!;
    expect(declared.arguments.change).toEqual({ kind: 'utterance', patch: { action: 'correct' } });
    expect(calls.find(call => call.name === 'emphasize')!.arguments.utteranceId).toBe('utt-9');
    const result = lines.find(line => line.type === 'result');
    expect(result.utterance).toMatchObject({ action: 'correct', utteranceId: 'utt-9', sequence: 9, superseded: 1 });
  });

  it('hands back the host refusal and goes on listening', async () => {
    const { lines } = await run({
      expected: 2,
      input: ['{"tool":"update_inspection","args":{"change":{"kind":"appearance","patch":{"labels":true}}}}'],
      reply: call => {
        if (call.name === 'get_inspection_state') return stateReply();
        if (call.name === 'listen_voice') return heard('what happened', 1);
        throw Error('The inspection changed. Read get_inspection_state and try again.');
      },
    });
    const failure = lines.find(line => line.type === 'error' && line.scope === 'command');
    expect(failure.message).toContain('The inspection changed');
    expect(lines.some(line => line.type === 'voice')).toBe(true);
  });

  it('refuses a malformed command line by name without dropping the session', async () => {
    const { lines } = await run({
      expected: 3,
      input: ['not json', '{"args":{}}', '{"tool":"emphasize","panel":"headset"}'],
      reply: call => (call.name === 'listen_voice' ? silence(0) : stateReply()),
    });
    expect(lines[0].message).toContain('not JSON');
    expect(lines[1].message).toContain('needs "tool"');
    expect(lines[2].message).toContain('companion, desktop, detailed');
  });
});

describe('reading one command line', () => {
  it('waits for a rendered receipt unless the caller turned it off', () => {
    expect(parseCommandLine('{"tool":"emphasize"}')).toMatchObject({ tool: 'emphasize', args: {}, wait: true });
    expect(parseCommandLine('{"tool":"emphasize","wait":false}')).toMatchObject({ wait: false });
  });

  it('carries a named surface and an utterance through', () => {
    expect(parseCommandLine('{"tool":"manage_inspection_view","panel":"desktop","args":{"action":"list"}}'))
      .toMatchObject({ panel: 'desktop', args: { action: 'list' } });
    expect(parseCommandLine('{"tool":"update_inspection","utterance":"cancel"}')).toMatchObject({ utterance: 'cancel' });
    expect(parseCommandLine('{"tool":"update_inspection","utterance":"maybe"}'))
      .toEqual({ error: expect.stringContaining('begin, correct, cancel') });
  });
});

describe('the scene summary beside a transcript', () => {
  it('keeps active commands and superseded renders that still own a rollback fence', async () => {
    const pendingCommand = [
      { commandId: 'surface', panelId: 'quest-panel', status: 'superseded', renderFence: true },
      { commandId: 'cartoon', panelId: 'quest-panel', status: 'queued', renderFence: false },
    ];
    const { lines } = await run({ expected: 1,
      reply: call => call.name === 'listen_voice' ? heard('actually make it cartoon', 8)
        : stateReply({ pendingCommand }),
    });
    expect(lines[0].scene.pendingCommand).toEqual(pendingCommand[0]);
    expect(lines[0].scene.pendingCommands).toEqual(pendingCommand);
    expect(sceneSummary(stateReply({ pendingCommand: [], command: { status: 'rendered' } }).structuredContent))
      .toMatchObject({ pendingCommand: null, pendingCommands: [] });
  });

  it('says what is loaded, what is selected and what the panels are doing', () => {
    const summary = sceneSummary(stateReply().structuredContent);
    expect(summary).toMatchObject({ hasScene: true, selectedResidueCount: 3, representation: 'cartoon' });
    expect(summary.panels).toEqual([{ surface: 'companion', availability: 'ready', current: true }]);
  });

  it('carries no coordinates and no camera', () => {
    const printed = JSON.stringify(sceneSummary({
      ...stateReply().structuredContent,
      view: { selectedResidueCount: 1, camera: { position: [1, 2, 3] } },
    }));
    expect(printed).not.toContain('position');
    expect(printed).not.toContain('camera');
  });

  // The loop prints a voice line only when there are words in it, so an
  // utterance that transcribed to whitespace has to normalise to empty here
  // rather than to a line of spaces the agent would try to answer.
  it('normalises the words, and leaves an empty utterance empty', () => {
    expect(voiceLines({ transcripts: [{ utteranceId: 'a', text: '  show\n the\tsticks ' }] }, {})[0].text).toBe('show the sticks');
    expect(voiceLines({ transcripts: [{ utteranceId: 'a', text: '   ' }] }, {})[0].text).toBe('');
    expect(voiceLines(undefined, {})).toEqual([]);
  });
});
