import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { converse } from '../scripts/converse.js';
import type { ControlState } from '../scripts/local-agent.js';
import type { Call } from './helpers/fake-agent-host.js';

afterEach(() => vi.unstubAllGlobals());

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const silence = (cursor = 0) => ({ structuredContent: { listening: true, cursor, transcripts: [] } });
const heard = (text: string, cursor: number) => ({ structuredContent: { listening: true, cursor,
  transcripts: [{ text, utteranceId: `u-${cursor}`, utteranceSequence: cursor }] } });
const stateReply = (extra: Record<string, unknown> = {}) => ({ structuredContent: {
  hasScene: true, sessionId: 'session-1', serverEpoch: 'epoch-1', sourceToken: 'source-1',
  stateRevision: 1, inspectionRevision: 1, sourceKind: 'pdb',
  lesson: { title: 'Old scene' },
  panels: [{ panelId: 'quest-panel', surface: 'companion', availability: 'ready', current: true }],
  ...extra,
} });
const receipt = (commandId: string, status: string) => ({ commandId, status });
const edit = (id: string, utteranceId?: string) => ({ id, tool: 'update_inspection', args: {
  commandId: id, ...(utteranceId ? { utteranceId } : {}),
  change: { kind: 'appearance', patch: { opacity: 0.5 } },
} });

/**
 * One actual converse loop, real control-file reads and HTTP serialization.
 * Only fetch is synthetic, so these races can also run where listen(2) is
 * prohibited. Existing converse.test.ts retains the real loopback socket tests.
 */
async function fixture(reply: (call: Call, host: ControlState) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'converse-lifecycle-'));
  const statePath = join(directory, 'state.json');
  let host: ControlState = { origin: 'http://127.0.0.1:12345', token: 'synthetic-token', sessionId: 'session-1' };
  const writeState = async () => {
    await writeFile(`${statePath}.next`, JSON.stringify(host));
    await rename(`${statePath}.next`, statePath);
  };
  await writeState();
  const calls: (Call & { host: ControlState })[] = [];
  const lines: any[] = [];
  const readIds: string[] = [];
  const changed = new Set<() => void>();
  const notify = () => { for (const callback of changed) callback(); };
  const until = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const check = () => { if (predicate()) { clearTimeout(timer); changed.delete(check); resolve(); } };
    const timer = setTimeout(() => { changed.delete(check); reject(Error('Synthetic conversation did not reach its expected event.')); }, 5_000);
    changed.add(check); check();
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe(`${host.origin}/agent`);
    if ((options.headers as Record<string, string>).Authorization !== `Bearer ${host.token}`)
      return Response.json({ error: 'Superseded synthetic host token.' }, { status: 403 });
    const call = JSON.parse(String(options.body)) as Call;
    const receivedBy = { ...host };
    calls.push({ ...call, host: receivedBy }); notify();
    try { return Response.json(await reply(call, receivedBy)); }
    catch (error) { return Response.json({ error: String(error) }, { status: 409 }); }
  }));
  const inputQueue: string[] = [];
  let waiting: ReturnType<typeof deferred<IteratorResult<string>>> | undefined;
  let closed = false;
  const deliver = (line: string) => { readIds.push(JSON.parse(line).id); notify(); return { value: line, done: false as const }; };
  const input: AsyncIterable<string> = { [Symbol.asyncIterator]: () => ({ next: async () => {
    if (inputQueue.length) return deliver(inputQueue.shift()!);
    if (closed) return { value: undefined, done: true };
    waiting = deferred<IteratorResult<string>>();
    return waiting.promise;
  } }) };
  const stop = new AbortController();
  const loop = converse({ statePath, input, stop: stop.signal, note: () => {},
    write: line => { lines.push(JSON.parse(line)); notify(); },
    wait: { pollMs: 1, timeoutMs: 2_000 }, idleFloorMs: 1, retry: { minMs: 1, maxMs: 2 } });
  return {
    calls, lines, readIds, until,
    send: (command: object) => {
      const line = JSON.stringify(command);
      if (waiting) { const next = waiting; waiting = undefined; next.resolve(deliver(line)); }
      else inputQueue.push(line);
    },
    rotate: async (next: Partial<ControlState>) => { host = { ...host, ...next }; await writeState(); },
    close: async () => {
      closed = true; stop.abort(); waiting?.resolve({ value: undefined, done: true });
      await loop;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('receipt echo ownership', () => {
  it.each(['panel', 'host'])('keeps a pending result separate from a reused command ID on another %s', async owner => {
    const host = await fixture((call, control) => {
      if (call.name === 'listen_voice') return silence();
      if (call.name === 'get_inspection_state') return stateReply({ sessionId: control.sessionId, serverEpoch: control.serverEpoch ?? 'epoch-1' });
      if (call.arguments.change.kind === 'utterance') return { structuredContent: { lifecycle: { action: 'correct',
        commands: [{ ...receipt('surface', 'superseded'), panelId: owner === 'panel' ? 'other-panel' : 'quest-panel',
          supersededBy: 'unrelated-u', fenceReleased: 'pending' }] } } };
      return { structuredContent: { command: { ...receipt('surface', 'queued'), panelId: 'quest-panel' } } };
    });
    try {
      host.send({ ...edit('surface'), wait: false });
      await host.until(() => host.lines.some(line => line.id === 'surface'));
      if (owner === 'host') await host.rotate({ sessionId: 'session-2', serverEpoch: 'epoch-2' });
      host.send({ id: 'unrelated', tool: 'update_inspection', args: {
        change: { kind: 'utterance', patch: { action: 'correct' } } } });
      await host.until(() => host.lines.some(line => line.id === 'unrelated'));
      expect(host.lines.filter(line => line.id === 'surface')).toMatchObject([{ rendered: false, receipt: { status: 'queued' } }]);
      expect(host.lines.filter(line => line.type === 'error')).toEqual([]);
    } finally { await host.close(); }
  });

  it.each([false, true])('echoes an unwaited supersession once when the queued response is delayed=%s', async delayed => {
    const response = deferred();
    let corrected = false;
    const terminal = { ...receipt('surface', 'superseded'), supersededBy: 'correction-u', fenceReleased: 'pending',
      reason: 'A newer utterance dropped this earlier request. This is not a rendered confirmation.' };
    const host = await fixture(async call => {
      if (call.name === 'listen_voice') return silence();
      if (call.name === 'get_inspection_state') return stateReply({ commands: [corrected ? terminal : receipt('surface', 'queued')] });
      if (call.arguments.change.kind === 'utterance') {
        corrected = true;
        return { structuredContent: { lifecycle: { action: 'correct', rendered: false,
          utterance: { utteranceId: 'correction-u', sequence: 2 }, commands: [terminal] } } };
      }
      if (delayed) await response.promise;
      return { structuredContent: { command: receipt('surface', 'queued') } };
    });
    try {
      host.send({ ...edit('surface'), wait: false });
      await host.until(() => host.calls.some(call => call.name === 'update_inspection' && call.arguments.commandId === 'surface'));
      if (!delayed) await host.until(() => host.lines.some(line => line.id === 'surface'));
      const correction = { id: 'correct', tool: 'update_inspection', args: { commandId: 'correct',
        change: { kind: 'utterance', patch: { action: 'correct' } } } };
      host.send(correction);
      await host.until(() => host.lines.some(line => line.id === 'correct'));
      response.resolve();
      await host.until(() => host.lines.some(line => line.id === 'surface' && line.receipt?.status === 'superseded'));
      // An exact lifecycle retry and a subsequent state read must not echo it again.
      host.send({ ...correction, id: 'retry' });
      host.send({ id: 'read', tool: 'get_inspection_state', args: {} });
      await host.until(() => host.lines.some(line => line.id === 'read'));
      const results = host.lines.filter(line => line.id === 'surface');
      expect(results).toHaveLength(delayed ? 1 : 2);
      expect(results.at(-1)).toMatchObject({ type: 'result', rendered: false, timedOut: false, text: terminal.reason, receipt: terminal });
      expect(results.at(-1).timing.commandSentAt).toBeTypeOf('number');
      expect(results.at(-1).timing.acceptedToRenderedMs).toBeUndefined();
      expect(results.at(-1).timing.transcriptToRenderedMs).toBeUndefined();
      expect(host.lines.filter(line => line.type === 'error')).toEqual([]);
    } finally { response.resolve(); await host.close(); }
  });
});

it('separates transcript delay from rendering, correlates by utterance, and forgets a retired host', async () => {
  const at = Date.now() - 46_000;
  let first = true;
  const host = await fixture((call, control) => {
    if (call.name === 'listen_voice') {
      if (!first) return silence(8);
      first = false;
      return { structuredContent: { listening: true, cursor: 8, transcripts: [
        { text: 'surface', utteranceId: 'u-7', utteranceSequence: 7, at: new Date(at).toISOString() },
        { text: 'colour', utteranceId: 'u-8', utteranceSequence: 8, at: new Date(at + 20_000).toISOString() },
      ] } };
    }
    if (call.name === 'get_inspection_state') return stateReply({ sessionId: control.sessionId,
      serverEpoch: control.serverEpoch ?? 'epoch-1' });
    return { structuredContent: { command: { commandId: call.arguments.commandId,
      status: call.arguments.commandId === 'conflict' ? 'conflict' : 'rendered',
      acceptedAt: at + 44_000, renderedAt: at + 46_000 } } };
  });
  try {
    await host.until(() => host.lines.filter(line => line.type === 'voice').length === 2);
    expect(host.lines.find(line => line.utteranceId === 'u-7').emittedAt).toBeGreaterThanOrEqual(at + 46_000);
    host.send(edit('timed', 'u-7'));
    await host.until(() => host.lines.some(line => line.id === 'timed'));
    const result = host.lines.find(line => line.id === 'timed');
    expect(result).toMatchObject({ utteranceId: 'u-7', rendered: true,
      timing: { transcriptAt: at, acceptedToRenderedMs: 2_000, transcriptToRenderedMs: 46_000 } });
    expect(result.timing.transcriptToCommandMs).toBe(result.timing.commandSentAt - at);
    expect(result.timing.commandSentAt).toBeGreaterThanOrEqual(result.timing.commandReceivedAt);
    expect(result.timing.inputQueueMs).toBeGreaterThanOrEqual(0);

    host.send(edit('unrelated', 'not-heard'));
    host.send(edit('conflict', 'u-7'));
    await host.until(() => host.lines.some(line => line.id === 'conflict'));
    expect(host.lines.find(line => line.id === 'unrelated').timing.transcriptToRenderedMs).toBeUndefined();
    expect(host.lines.find(line => line.id === 'conflict')).toMatchObject({ rendered: false });
    expect(host.lines.find(line => line.id === 'conflict').timing.transcriptToRenderedMs).toBeUndefined();
    expect(host.lines.find(line => line.id === 'conflict').timing.acceptedToRenderedMs).toBeUndefined();

    await host.rotate({ sessionId: 'session-2', serverEpoch: 'epoch-2' });
    host.send(edit('rotated', 'u-7'));
    await host.until(() => host.lines.some(line => line.id === 'rotated'));
    expect(host.lines.find(line => line.id === 'rotated')).toMatchObject({ rendered: true });
    expect(host.lines.find(line => line.id === 'rotated').timing.transcriptAt).toBeUndefined();
    expect(host.lines.find(line => line.id === 'rotated').timing.transcriptToRenderedMs).toBeUndefined();
    expect(host.lines.filter(line => line.type === 'error')).toEqual([]);
  } finally { await host.close(); }
});

describe('buffered conversational work', () => {
  it.each([
    ['cancel', false], ['cancel', true], ['correct', false], ['correct', true],
  ] as const)('drops older edits on %s (transcript-bound: %s), then orders later edits', async (action, bound) => {
    let cancelled = false;
    let revision = 1;
    let firstPoll = true;
    let replacementReads = 0;
    const host = await fixture(call => {
      if (call.name === 'listen_voice') {
        if (firstPoll && bound) { firstPoll = false; return heard('make it orange and fade it', 7); }
        return silence(bound ? 7 : 0);
      }
      if (call.name === 'get_inspection_state') {
        const id = call.arguments.commandId;
        let status = id === 'first' ? (cancelled ? 'cancelled' : 'rendering') : 'rendered';
        if (id === 'replacement' && ++replacementReads === 1) status = 'rendering';
        if (id === 'replacement' && status === 'rendered') revision = 2;
        return stateReply({ stateRevision: revision, inspectionRevision: revision,
          ...(id ? { command: receipt(id, status) } : {}) });
      }
      if (call.arguments.change.kind === 'utterance') {
        cancelled = true;
        return { structuredContent: { lifecycle: { action, rendered: false,
          utterance: { utteranceId: 'replacement-utterance', sequence: 8 }, commands: [receipt('first', 'cancelled')] } } };
      }
      return { structuredContent: { command: receipt(call.arguments.commandId, 'queued') } };
    });
    try {
      if (bound) await host.until(() => host.lines.some(line => line.utteranceId === 'u-7'));
      host.send(edit('first', bound ? 'u-7' : undefined));
      host.send(edit('buffered', bound ? 'u-7' : undefined));
      await host.until(() => host.calls.some(call => call.arguments.commandId === 'first' && call.name === 'update_inspection')
        && host.readIds.includes('buffered'));
      if (action === 'correct') host.send({ ...edit('replacement', bound ? 'u-8' : undefined), utterance: 'correct' });
      else host.send({ id: 'cancel', tool: 'update_inspection', args: {
        ...(bound ? { utteranceId: 'u-7' } : {}), change: { kind: 'utterance', patch: { action } },
      } });
      host.send(edit('later'));
      await host.until(() => host.lines.filter(line => line.type === 'result').length === 4);
      const results = host.lines.filter(line => line.type === 'result');
      expect(host.lines.filter(line => line.type === 'error')).toEqual([]);
      expect(results.find(line => line.id === 'first')).toMatchObject({ rendered: false, timedOut: false,
        receipt: { status: 'cancelled' } });
      expect(results.find(line => line.id === 'buffered')).toMatchObject({ rendered: false, sent: false, dropped: true,
        status: action === 'cancel' ? 'cancelled' : 'superseded', reason: `utterance_${action}` });
      expect(results.find(line => line.id === 'buffered').receipt).toBeUndefined();
      expect(host.calls.some(call => call.arguments.commandId === 'buffered')).toBe(false);
      const posted = host.calls.filter(call => call.name === 'update_inspection');
      expect(posted.map(call => call.arguments.change.kind)).toEqual(action === 'correct'
        ? ['appearance', 'utterance', 'appearance', 'appearance'] : ['appearance', 'utterance', 'appearance']);
      expect(posted[0].arguments.utteranceId).toBe(bound ? 'u-7' : undefined);
      expect(results.find(line => line.id === 'later')).toMatchObject({ rendered: true, receipt: { status: 'rendered' } });
      if (action === 'correct') {
        expect(posted[2].arguments.utteranceId).toBe('replacement-utterance');
        // Sent after the replacement rendered; the host binds it to that revision on arrival.
        expect(posted[3].arguments).not.toHaveProperty('baseInspectionRevision');
        expect(results.find(line => line.id === 'replacement')).toMatchObject({ rendered: true, receipt: { status: 'rendered' } });
      }
    } finally { await host.close(); }
  });

  it('invalidates a binding read still in flight before it can post an edit', async () => {
    const binding = deferred();
    let reading = false;
    let cancelled = false;
    const host = await fixture(async call => {
      if (call.name === 'listen_voice') return silence();
      if (call.name === 'get_inspection_state') {
        if (!reading) { reading = true; await binding.promise; }
        return stateReply();
      }
      cancelled = true;
      return { structuredContent: { lifecycle: { action: 'cancel', rendered: false } } };
    });
    try {
      host.send(edit('binding'));
      await host.until(() => host.calls.some(call => call.name === 'get_inspection_state'));
      host.send({ id: 'cancel', tool: 'update_inspection', args: { change: { kind: 'utterance', patch: { action: 'cancel' } } } });
      await host.until(() => host.lines.some(line => line.id === 'cancel'));
      expect(cancelled).toBe(true);
      binding.resolve();
      await host.until(() => host.lines.some(line => line.id === 'binding'));
      expect(host.lines.find(line => line.id === 'binding')).toMatchObject({ dropped: true, sent: false, status: 'cancelled', rendered: false });
      expect(host.calls.filter(call => call.name === 'update_inspection')).toHaveLength(1);
    } finally { binding.resolve(); await host.close(); }
  });

  it('lets another correction preempt a rendering replacement without releasing older buffered edits', async () => {
    let corrections = 0;
    const host = await fixture(call => {
      if (call.name === 'listen_voice') return silence();
      const id = call.arguments.commandId;
      if (call.name === 'get_inspection_state') return stateReply(id ? {
        command: receipt(id, id === 'correction-1' ? (corrections > 1 ? 'cancelled' : 'rendering') : 'rendered'),
      } : {});
      if (call.arguments.change.kind === 'utterance') {
        corrections++;
        return { structuredContent: { lifecycle: { action: 'correct', rendered: false,
          utterance: { utteranceId: `correction-utterance-${corrections}`, sequence: corrections }, commands: [] } } };
      }
      return { structuredContent: { command: receipt(id, 'queued') } };
    });
    try {
      host.send({ ...edit('correction-1'), utterance: 'correct' });
      host.send(edit('older-buffered'));
      await host.until(() => host.calls.some(call => call.name === 'update_inspection' && call.arguments.commandId === 'correction-1')
        && host.readIds.includes('older-buffered'));
      host.send({ ...edit('correction-2'), utterance: 'correct' });
      host.send(edit('later'));
      await host.until(() => host.lines.filter(line => line.type === 'result').length === 4);
      expect(corrections).toBe(2);
      expect(host.lines.find(line => line.id === 'correction-1')).toMatchObject({ rendered: false, timedOut: false, receipt: { status: 'cancelled' } });
      expect(host.lines.find(line => line.id === 'older-buffered')).toMatchObject({ dropped: true, sent: false, status: 'superseded' });
      expect(host.calls.some(call => call.arguments.commandId === 'older-buffered')).toBe(false);
      expect(host.lines.find(line => line.id === 'correction-2')).toMatchObject({ rendered: true, receipt: { status: 'rendered' } });
      expect(host.calls.filter(call => call.name === 'update_inspection' && call.arguments.change.kind === 'appearance')
        .map(call => call.arguments.commandId)).toEqual(['correction-1', 'correction-2', 'later']);
    } finally { await host.close(); }
  });
});

describe('host rotation during a live conversation', () => {
  it.each([
    ['sessionId', 'poll'], ['serverEpoch', 'poll'], ['token', 'scene'], ['responseEpoch', 'scene'], ['responseSession', 'scene'],
  ] as const)('discards the old %s response during %s and resets cursor N before delivering new speech once', async (identity, stage) => {
    const release = deferred();
    let polls = 0;
    let sceneReads = 0;
    let rotated = false;
    let waiting = false;
    const host = await fixture(async (call, owner) => {
      if (call.name === 'listen_voice') {
        polls++;
        if (polls === 1) return heard('OLD_FIRST', 7);
        if (!rotated) {
          if (stage === 'poll') { waiting = true; await release.promise; }
          return heard('STALE_PENDING', 8);
        }
        return call.arguments.cursor === undefined ? heard('NEW_FIRST', 1) : silence(1);
      }
      sceneReads++;
      if (!rotated && stage === 'scene' && sceneReads === 2) { waiting = true; await release.promise; }
      return stateReply({ sessionId: rotated && identity === 'responseSession' ? 'session-2' : owner.sessionId,
        serverEpoch: rotated && identity !== 'responseSession' ? 'epoch-2' : 'epoch-1', sourceToken: rotated ? 'source-2' : 'source-1',
        lesson: { title: rotated ? 'New scene' : 'Old scene' } });
    });
    try {
      await host.until(() => host.lines.some(line => line.text === 'OLD_FIRST'));
      // The handler reaches the deferred response after the previous cursor
      // has been consumed, so this exercises an actual in-flight rotation.
      await vi.waitFor(() => expect(waiting).toBe(true));
      rotated = true;
      if (identity === 'sessionId') await host.rotate({ sessionId: 'session-2' });
      if (identity === 'serverEpoch') await host.rotate({ serverEpoch: 'epoch-2' });
      if (identity === 'token') await host.rotate({ token: 'synthetic-new-token' });
      release.resolve();
      await host.until(() => host.calls.some(call => call.name === 'listen_voice' && call.arguments.cursor === 1));
      expect(host.lines.filter(line => line.type === 'voice').map(line => [line.text, line.scene.lesson.title]))
        .toEqual([['OLD_FIRST', 'Old scene'], ['NEW_FIRST', 'New scene']]);
      const cursors = host.calls.filter(call => call.name === 'listen_voice').map(call => call.arguments.cursor);
      expect(cursors.slice(0, 4)).toEqual([undefined, 7, undefined, 1]);
      expect(host.lines.filter(line => line.type === 'error')).toEqual([]);
    } finally { release.resolve(); await host.close(); }
  });

  it('preserves a current transcript when its scene read fails', async () => {
    const host = await fixture(call => {
      if (call.name === 'listen_voice') return call.arguments.cursor === undefined ? heard('KEEP_THIS_REQUEST', 1) : silence(1);
      throw Error('Synthetic scene read failed.');
    });
    try {
      await host.until(() => host.calls.some(call => call.name === 'listen_voice' && call.arguments.cursor === 1));
      expect(host.lines.filter(line => line.type === 'voice')).toHaveLength(1);
      expect(host.lines.find(line => line.type === 'voice')).toMatchObject({ text: 'KEEP_THIS_REQUEST', scene: { hasScene: false } });
      expect(host.lines.find(line => line.type === 'error').message).toContain('Synthetic scene read failed.');
    } finally { await host.close(); }
  });

  it('drops queued work on session rotation and binds later work only to the new scene', async () => {
    let rotated = false;
    const host = await fixture((call, owner) => {
      if (call.name === 'listen_voice') return rotated && call.arguments.cursor === undefined ? heard('NEW_REQUEST', 1) : silence(7);
      const id = call.arguments.commandId;
      if (call.name === 'get_inspection_state') return stateReply({ sessionId: owner.sessionId,
        serverEpoch: rotated ? 'epoch-2' : 'epoch-1', sourceToken: rotated ? 'source-2' : 'source-1',
        ...(id ? { command: receipt(id, id === 'first' ? 'rendering' : 'rendered') } : {}) });
      return { structuredContent: { command: receipt(id, 'queued') } };
    });
    try {
      host.send(edit('first'));
      host.send(edit('buffered'));
      await host.until(() => host.calls.some(call => call.name === 'update_inspection' && call.arguments.commandId === 'first')
        && host.readIds.includes('buffered'));
      await host.rotate({ sessionId: 'session-2', serverEpoch: 'epoch-2' });
      rotated = true;
      await host.until(() => host.lines.some(line => line.text === 'NEW_REQUEST'));
      host.send(edit('new'));
      await host.until(() => host.lines.filter(line => line.type === 'result').length === 3);
      expect(host.lines.find(line => line.id === 'buffered')).toMatchObject({ status: 'superseded', reason: 'host_rotated', sent: false, rendered: false });
      expect(host.lines.find(line => line.id === 'first')).toMatchObject({ status: 'superseded', reason: 'host_rotated', rendered: false });
      expect(host.lines.find(line => line.id === 'new')).toMatchObject({ rendered: true, receipt: { status: 'rendered' } });
      expect(host.calls.some(call => call.arguments.commandId === 'buffered')).toBe(false);
      expect(host.calls.find(call => call.name === 'update_inspection' && call.arguments.commandId === 'new')?.arguments)
        .toMatchObject({ serverEpoch: 'epoch-2', sourceToken: 'source-2' });
    } finally { await host.close(); }
  });
});

it('correction to cartoon waits for a rendered receipt, then a new utterance renders at the corrected revision', async () => {
  let surfaceSent = false, corrected = false, rollback = false, cartoonRendered = false, thirdRendered = false, deliveredNext = false;
  const host = await fixture(call => {
    const id = call.arguments.commandId;
    if (call.name === 'listen_voice') {
      if (cartoonRendered && !deliveredNext) { deliveredNext = true; return heard('colour it orange', 9); }
      return silence(deliveredNext ? 9 : 0);
    }
    if (call.name === 'get_inspection_state') {
      const status = id === 'surface' ? (corrected ? 'superseded' : 'rendering')
        : id === 'cartoon' ? (cartoonRendered ? 'rendered' : rollback ? 'rendering' : 'queued')
        : thirdRendered ? 'rendered' : 'rendering';
      return stateReply({ inspectionRevision: thirdRendered ? 3 : cartoonRendered ? 2 : 1,
        panels: [{ panelId: 'quest-panel', surface: 'companion', current: true,
          availability: surfaceSent && !cartoonRendered ? 'busy' : 'ready' }],
        ...(id ? { command: { ...receipt(id, status), ...(id === 'surface' && corrected ? { supersededBy: 'correction-u',
          ...(rollback ? { fenceReleased: 'rolled-back' } : {}) } : {}) } } : {}),
        pendingCommand: surfaceSent && !rollback ? [{ ...receipt('surface', corrected ? 'superseded' : 'rendering'),
          panelId: 'quest-panel', renderFence: corrected }] : [] });
    }
    if (call.arguments.change.kind === 'utterance') {
      corrected = true;
      return { structuredContent: { lifecycle: { action: 'correct', rendered: false,
        utterance: { utteranceId: 'correction-u', sequence: 8 }, commands: [receipt('surface', 'superseded')] } } };
    }
    if (id === 'surface') surfaceSent = true;
    return { structuredContent: { command: receipt(id, 'queued') } };
  });
  try {
    host.send(edit('surface'));
    await host.until(() => host.calls.some(call => call.name === 'update_inspection' && call.arguments.commandId === 'surface'));
    host.send({ ...edit('cartoon'), utterance: 'correct' });
    await host.until(() => host.calls.some(call => call.name === 'update_inspection' && call.arguments.commandId === 'cartoon'));
    expect(host.lines.some(line => line.id === 'cartoon' && line.rendered)).toBe(false);
    rollback = true;
    await host.until(() => host.calls.filter(call => call.name === 'get_inspection_state' && call.arguments.commandId === 'cartoon').length >= 2);
    expect(host.lines.some(line => line.id === 'cartoon' && line.rendered)).toBe(false);
    cartoonRendered = true;
    await host.until(() => host.lines.some(line => line.id === 'cartoon' && line.rendered) && host.lines.some(line => line.utteranceId === 'u-9'));
    host.send(edit('third', 'u-9'));
    await host.until(() => host.calls.some(call => call.name === 'update_inspection' && call.arguments.commandId === 'third'));
    expect(host.lines.some(line => line.id === 'third' && line.rendered)).toBe(false);
    thirdRendered = true;
    await host.until(() => host.lines.some(line => line.id === 'third' && line.rendered));
    expect(host.lines.filter(line => line.type === 'error')).toEqual([]);
    expect(host.lines.find(line => line.id === 'surface')).toMatchObject({ rendered: false, receipt: { status: 'superseded', supersededBy: 'correction-u', fenceReleased: expect.stringMatching(/^(pending|rolled-back)$/) } });
    expect(host.calls.find(call => call.name === 'update_inspection' && call.arguments.commandId === 'cartoon')?.arguments.utteranceId).toBe('correction-u');
    // The utterance carries the binding; the revision is the host's to fill on arrival.
    const third = host.calls.find(call => call.name === 'update_inspection' && call.arguments.commandId === 'third')?.arguments;
    expect(third).toMatchObject({ utteranceId: 'u-9' });
    expect(third).not.toHaveProperty('baseInspectionRevision');
    expect(host.lines.filter(line => line.type === 'result' && line.rendered).map(line => line.id)).toEqual(['cartoon', 'third']);
  } finally { await host.close(); }
});


it.each([undefined, 'rolled-back', 'deadline', 'panel-lost'])('the real converse echo carries fence release %s explicitly', async fenceReleased => {
  let corrected = false;
  const host = await fixture(call => {
    const id = call.arguments.commandId;
    if (call.name === 'listen_voice') return silence();
    if (call.name === 'get_inspection_state') return stateReply({
      ...(id ? { command: { ...receipt(id, corrected ? 'superseded' : 'rendering'),
        ...(corrected ? { supersededBy: 'correct-u', ...(fenceReleased ? { fenceReleased } : {}) } : {}) } } : {}),
    });
    if (call.arguments.change.kind === 'utterance') {
      corrected = true;
      return { structuredContent: { lifecycle: { action: 'correct', rendered: false,
        utterance: { utteranceId: 'correct-u', sequence: 2 }, commands: [receipt('surface', 'superseded')] } } };
    }
    return { structuredContent: { command: receipt(id, 'queued') } };
  });
  try {
    host.send(edit('surface'));
    await host.until(() => host.calls.some(call => call.name === 'get_inspection_state' && call.arguments.commandId === 'surface'));
    host.send({ id: 'correct', tool: 'update_inspection', args: { change: { kind: 'utterance', patch: { action: 'correct' } } } });
    await host.until(() => host.lines.some(line => line.id === 'surface'));
    expect(host.lines.find(line => line.id === 'surface')).toMatchObject({ rendered: false, timedOut: false,
      receipt: { commandId: 'surface', status: 'superseded', supersededBy: 'correct-u', fenceReleased: fenceReleased ?? 'pending' } });
    expect(host.lines.filter(line => line.type === 'error')).toEqual([]);
  } finally { await host.close(); }
});
