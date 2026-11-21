import { describe, expect, it } from 'vitest';

import { MICROPHONE_PROMPT_REFUSED_COPY, MICROPHONE_PROMPT_WAITING_COPY, microphoneNoticeCopy, microphonePromptHoldsEntry, watchMicrophonePermission } from '../src/xr-entry-microphone.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function permissionStatus(state: string) {
  const listeners = new Set<() => void>();
  return {
    state,
    listeners,
    addEventListener(type: string, listener: () => void) { if (type === 'change') listeners.add(listener); },
    removeEventListener(type: string, listener: () => void) { if (type === 'change') listeners.delete(listener); },
    change(next: string) { this.state = next; for (const listener of listeners) listener(); },
  };
}

describe('the microphone permission read before an Enter VR press', () => {
  it('is unknown until the query answers, then follows the status change event', async () => {
    const status = permissionStatus('prompt');
    const asked: unknown[] = [];
    const watch = watchMicrophonePermission({ permissions: { query: async (descriptor: unknown) => { asked.push(descriptor); return status; } } });
    expect(watch.state()).toBe('unknown');
    await flush();
    expect(asked).toEqual([{ name: 'microphone' }]);
    expect(watch.state()).toBe('prompt');
    status.change('granted');
    expect(watch.state()).toBe('granted');
    status.change('denied');
    expect(watch.state()).toBe('denied');
    watch.stop();
    expect(status.listeners.size).toBe(0);
  });

  it.each([
    ['no permissions API', {}],
    ['no navigator', undefined],
    ['a query that throws', { permissions: { query: () => { throw new TypeError('microphone is not a permission name'); } } }],
    ['a query that rejects', { permissions: { query: async () => { throw new TypeError('microphone is not a permission name'); } } }],
    ['a status with no state', { permissions: { query: async () => ({}) } }],
  ])('stays unknown with %s', async (_label, navigatorLike) => {
    const watch = watchMicrophonePermission(navigatorLike);
    await flush();
    expect(watch.state()).toBe('unknown');
  });

  it('keeps the first answer from a status that cannot report changes', async () => {
    const watch = watchMicrophonePermission({ permissions: { query: async () => ({ state: 'granted' }) } });
    await flush();
    expect(watch.state()).toBe('granted');
  });

  it('ignores an answer that arrives after it was stopped', async () => {
    const status = permissionStatus('prompt');
    const watch = watchMicrophonePermission({ permissions: { query: async () => status } });
    watch.stop();
    await flush();
    expect(watch.state()).toBe('unknown');
    expect(status.listeners.size).toBe(0);
  });
});

describe('whether the prompt a press opened is what holds its entry', () => {
  const holding = { undecidedAtPress: true, presented: false, permission: 'prompt' as const, microphone: 'requesting', reloadRequired: false };

  it('holds while the prompt is unanswered, including after the priming stopped waiting', () => {
    expect(microphonePromptHoldsEntry(holding)).toBe(true);
    expect(microphonePromptHoldsEntry({ ...holding, microphone: 'pending-prompt' })).toBe(true);
  });

  it.each([
    ['the permission was decided or unreadable at the press', { undecidedAtPress: false }],
    ['the press could not read it', { undecidedAtPress: undefined }],
    ['the wearer allowed it', { permission: 'granted' as const }],
    ['the wearer refused it', { permission: 'denied' as const }],
    ['the permission became unreadable', { permission: 'unknown' as const }],
    ['the wearer dismissed it', { microphone: 'denied' }],
    ['the microphone was granted', { microphone: 'granted' }],
    ['the browser has no microphone', { microphone: 'unavailable' }],
    ['the session had presented', { presented: true }],
    ['the page needs a reload', { reloadRequired: true }],
  ])('does not hold when %s', (_label, change) => {
    expect(microphonePromptHoldsEntry({ ...holding, ...change })).toBe(false);
  });

  it('tells the wearer what to do in one plain sentence each', () => {
    expect(MICROPHONE_PROMPT_REFUSED_COPY).toBe('Answer the microphone prompt, then press Enter VR again.');
    expect(MICROPHONE_PROMPT_WAITING_COPY).toBe('Answer the microphone prompt to continue.');
  });
});

describe('the microphone sentence, read against the permission as it is now', () => {
  it.each([
    ['refused', 'prompt', 'Answer the microphone prompt, then press Enter VR again.'],
    ['refused', 'granted', 'Press Enter VR again.'],
    ['refused', 'denied', 'Press Enter VR again.'],
    ['refused', 'unknown', 'Answer the microphone prompt, then press Enter VR again.'],
    ['refused', undefined, 'Answer the microphone prompt, then press Enter VR again.'],
    ['waiting', 'prompt', 'Answer the microphone prompt to continue.'],
    ['waiting', 'granted', ''],
    ['waiting', 'denied', ''],
    ['waiting', 'unknown', 'Answer the microphone prompt to continue.'],
    ['', 'granted', ''],
  ] as const)('a %s notice with the permission %s reads %j', (notice, permission, copy) => {
    expect(microphoneNoticeCopy(notice, permission)).toBe(copy);
  });

  // A dismissed prompt leaves the permission undecided but settles the
  // microphone request, so the request's state says the prompt has closed.
  it.each([
    ['refused', 'prompt', 'requesting', 'Answer the microphone prompt, then press Enter VR again.'],
    ['refused', 'prompt', 'pending-prompt', 'Answer the microphone prompt, then press Enter VR again.'],
    ['refused', 'prompt', 'denied', 'Press Enter VR again.'],
    ['refused', 'prompt', 'unavailable', 'Press Enter VR again.'],
    ['refused', 'prompt', 'granted', 'Press Enter VR again.'],
    ['refused', 'prompt', 'idle', 'Press Enter VR again.'],
    ['refused', 'unknown', 'denied', 'Press Enter VR again.'],
    ['refused', 'granted', 'requesting', 'Press Enter VR again.'],
    ['refused', 'prompt', undefined, 'Answer the microphone prompt, then press Enter VR again.'],
    ['waiting', 'prompt', 'requesting', 'Answer the microphone prompt to continue.'],
    ['waiting', 'prompt', 'pending-prompt', 'Answer the microphone prompt to continue.'],
    ['waiting', 'prompt', 'denied', ''],
    ['waiting', 'prompt', undefined, 'Answer the microphone prompt to continue.'],
    ['', 'prompt', 'requesting', ''],
  ] as const)('a %s notice with the permission %s and the microphone request %s reads %j', (notice, permission, microphone, copy) => {
    expect(microphoneNoticeCopy(notice, permission, microphone)).toBe(copy);
  });

  it('the watcher calls back on each permission change, after its state is current', async () => {
    const status = permissionStatus('prompt'), seen: string[] = [];
    const watch = watchMicrophonePermission({ permissions: { query: async () => status } }, () => { seen.push(watch.state()); });
    await flush();
    expect(seen).toEqual([]);
    status.change('granted');
    status.change('denied');
    expect(seen).toEqual(['granted', 'denied']);
    watch.stop();
    status.change('granted');
    expect(seen).toEqual(['granted', 'denied']);
  });

  it('a failing callback leaves the state current', async () => {
    const status = permissionStatus('prompt');
    const watch = watchMicrophonePermission({ permissions: { query: async () => status } }, () => { throw Error('listener failed'); });
    await flush();
    status.change('granted');
    expect(watch.state()).toBe('granted');
  });
});
