import { describe, expect, it } from 'vitest';
import { assembleReadiness, formatReadiness, pairedSessionHeadset, visionProStatus, type ReadinessFacts } from '../src/inspection-contract.js';

const facts = (panels: ReadinessFacts['panels']): ReadinessFacts => ({
  hasScene: true,
  panels,
  agentAttached: true,
  listenAgeMs: 0,
  listenWindowMs: 30_000,
  transcription: { enabled: true, ready: true, detail: 'ready', missing: [] },
  replies: { enabled: true, ready: true, detail: 'ready' },
  headset: { checked: false },
  checkedAt: '2026-09-12T12:00:00.000Z',
});

const structure = (panels: ReadinessFacts['panels']) =>
  assembleReadiness(facts(panels)).items.find(item => item.capability === 'structure');

describe('the readiness structure row after a companion re-open', () => {
  it('names a ready companion once', () => {
    const item = structure([
      { surface: 'companion', availability: 'ready', current: true },
      { surface: 'companion', availability: 'ready', current: true },
    ]);
    expect(item).toMatchObject({ state: 'ok', detail: 'saved scene; companion ready' });
    expect(item?.detail).not.toContain('companion ready, companion ready');
  });

  it('takes the newest companion state instead of an older ready answer', () => {
    expect(structure([
      { surface: 'companion', availability: 'ready', current: true },
      { surface: 'companion', availability: 'unsaved', current: true },
    ])).toMatchObject({ state: 'missing', detail: 'mounted but not ready: companion unsaved' });
  });
});

it('names the actual disabled transcription configuration in readiness',()=>{
  const input=facts([]);
  input.transcription={enabled:false,ready:false,missing:[],detail:'Headset voice is off (STEREOFOLD_PTT_TRANSCRIBE=0).'};
  expect(assembleReadiness(input).items.find(item=>item.capability==='transcription')?.detail)
    .toContain('STEREOFOLD_PTT_TRANSCRIBE=0');
});

describe('the headset line for a Vision Pro share', () => {
  const share = (pairedDevices: number, headset?: 'vision-pro') => ({
    expiresAt: '2099-01-01T12:00:00.000Z', pairedDevices, headsetsPaired: pairedDevices,
    target: 'apple' as const, ...(headset ? { headset, connected: true } : {}),
  });
  const line = (input: ReadinessFacts) => formatReadiness(assembleReadiness(input))
    .split('\n').find(value => /^(?:OK|--|!!) headset\s/u.test(value));

  it('waits for Vision Pro when no Quest is attached and no page has paired', () => {
    const input = facts([]);
    input.share = share(0);
    input.headset = { checked: true, ok: false, reason: 'adb reports no authorized headset' };
    expect(line(input)).toBe('-- headset        Waiting for the Apple Vision Pro page; USB device state is Quest-only');
    expect(visionProStatus(input.share)).toBe('Waiting for the Apple Vision Pro page; USB device state is Quest-only.');
  });

  it('does not call an idle Quest the headset while the Vision Pro page is pending', () => {
    const input = facts([]);
    input.share = share(0);
    input.headset = { checked: true, ok: true, serial: 'QUEST2' };
    expect(line(input)).toBe('-- headset        Waiting for the Apple Vision Pro page; USB device state is Quest-only');
    expect(visionProStatus(input.share)).toBe('Waiting for the Apple Vision Pro page; USB device state is Quest-only.');
  });

  it('names the paired Vision Pro even when adb sees an idle Quest', () => {
    const input = facts([]);
    input.share = share(1, 'vision-pro');
    input.headset = { checked: true, ok: true, serial: 'QUEST2' };
    expect(line(input)).toBe('OK headset        Apple Vision Pro page is connected over Wi-Fi; USB device state is Quest-only');
    expect(visionProStatus(input.share)).toBe('Apple Vision Pro page is connected over Wi-Fi; USB device state is Quest-only.');
    expect(assembleReadiness(input).items.find(item => item.capability === 'headset')?.state).toBe('ok');
  });

  it('keeps a retained pairing distinct from a responding Vision Pro page',()=>{
    const input=facts([]);
    input.share={...share(1,'vision-pro'),connected:false};
    expect(line(input)).toBe('-- headset        Apple Vision Pro is paired over Wi-Fi; waiting for its page to reconnect; USB device state is Quest-only');
    expect(visionProStatus(input.share)).toBe('Apple Vision Pro is paired over Wi-Fi; waiting for its page to reconnect; USB device state is Quest-only.');
    expect(assembleReadiness(input).items.find(item=>item.capability==='share')?.state).toBe('ok');
  });

  it.each([false,true])('does not classify an unknown paired peer from Apple launch intent (connected=%s)', connected=>{
    const input=facts([]);
    input.share={...share(2),connected};
    input.headset={checked:true,ok:true,serial:'QUEST2'};
    const row=assembleReadiness(input).items.find(item=>item.capability==='headset')!;
    expect(row.detail).toBe(connected ? 'Headset page is connected over Wi-Fi; adb sees QUEST2' : 'adb sees QUEST2');
    expect(row.state).toBe('ok');
    expect(visionProStatus(input.share)).toBeUndefined();
  });

  it('keeps the Quest-only line exactly as it was', () => {
    const input = facts([]);
    input.share = { expiresAt: '2099-01-01T12:00:00.000Z', pairedDevices: 1, headsetsPaired: 1, target: 'meta' };
    input.headset = { checked: true, ok: true, serial: 'QUEST2' };
    expect(line(input)).toBe('OK headset        adb sees QUEST2');
    expect(visionProStatus(input.share)).toBeUndefined();
  });

  it('preserves readiness text for a Quest-only session without Apple evidence',()=>{
    const input=facts([{surface:'companion',availability:'ready',current:true}]);
    input.share={expiresAt:'2099-01-01T12:00:00.000Z',pairedDevices:1,headsetsPaired:1,target:'meta'};
    input.actionAgeMs=0;
    input.transcription.captureObserved=true;
    input.headset={checked:true,ok:true,serial:'QUEST2'};
    const reading=assembleReadiness(input);
    // These are the six row strings and formatter spacing for a Quest session.
    const expected=[
      'Stereofold headset readiness: READY',
      `OK ${'structure'.padEnd(13)}  saved scene; companion ready`,
      `OK ${'share'.padEnd(13)}  1 paired client (1 headset), open until 2099-01-01T12:00:00.000Z`,
      `OK ${'agent'.padEnd(13)}  listened 0 s ago; processed a request 0 s ago`,
      `OK ${'transcription'.padEnd(13)}  ready; microphone capture transcribed in this session`,
      `OK ${'replies'.padEnd(13)}  ready`,
      `OK ${'headset'.padEnd(13)}  adb sees QUEST2`,
    ].join('\n');
    expect({ready:reading.ready,blocking:reading.blocking}).toEqual({ready:true,blocking:[]});
    expect(formatReadiness(reading)).toBe(expected);
    expect(visionProStatus(input.share)).toBeUndefined();
  });

  it('uses the current XR report before the launch hint or pairing User-Agent', () => {
    const clients = [{ deviceClass: 'unknown', lastUsedAt: '2099-01-01T11:00:00.000Z' }];
    expect(pairedSessionHeadset('apple', clients)).toBeUndefined();
    expect(pairedSessionHeadset('auto', clients, 'vision-pro')).toBe('vision-pro');
    expect(pairedSessionHeadset('apple', clients, 'quest2')).toBeUndefined();
    expect(pairedSessionHeadset('apple', [])).toBeUndefined();
    expect(pairedSessionHeadset('apple', [{ ...clients[0], deviceClass: 'quest2' }])).toBeUndefined();
  });
});

describe('paired page evidence and optional debugging', () => {
  it.each([{ checked: false }, { checked: true, ok: false, reason: 'No ready debugging transport' }])
  ('keeps a current paired page connected independently of adb: %j', headset => {
    const input = facts([{ surface: 'companion', availability: 'ready', current: true }]);
    input.share = { expiresAt: '2099-01-01T12:00:00.000Z', pairedDevices: 1, headsetsPaired: 1, target: 'meta', connected: true };
    input.headset = headset;
    const readiness = assembleReadiness(input);
    expect(readiness.items.find(item => item.capability === 'headset')).toMatchObject({ state: 'ok', detail: expect.stringContaining('Headset page is connected over Wi-Fi') });
    expect(readiness.blocking).not.toContain('headset');
  });

  it('does not infer headset power or connectivity from unavailable debugging', () => {
    const input = facts([]);
    input.headset = { checked: true, ok: false, reason: 'No ready debugging transport' };
    const readiness = assembleReadiness(input);
    expect(readiness.items.find(item => item.capability === 'headset')).toMatchObject({ state: 'not-checked', detail: expect.stringContaining('This does not establish headset connectivity') });
    expect(readiness.blocking).not.toContain('headset');
  });

  it('does not infer a connected page from a retained pairing', () => {
    const input = facts([]);
    input.share = { expiresAt: '2099-01-01T12:00:00.000Z', pairedDevices: 1, headsetsPaired: 1, connected: false };
    expect(assembleReadiness(input).items.find(item => item.capability === 'headset')?.state).toBe('not-checked');
  });
});

describe('transcription opt-in and prerequisites', () => {
  it('requires a missing model to be repaired before enabling capture', () => {
    const input = facts([]);
    input.transcription = { enabled: false, ready: false, route: 'whisper', missing: ['a whisper model'],
      detail: 'Whisper recognizer at /opt/homebrew/bin/whisper-cli; model unresolved' };
    const item = assembleReadiness(input).items.find(row => row.capability === 'transcription')!;
    expect(item).toMatchObject({ state: 'missing' });
    expect(item.detail).toContain('headset voice is off');
    expect(item.detail).toContain('recognizer prerequisites missing: a whisper model');
    expect(item.nextAction).toContain('STEREOFOLD_WHISPER_MODEL to a readable model file');
    expect(item.nextAction).toContain('STEREOFOLD_APPLESPEECH_BIN');
    expect(item.nextAction).toContain('Then enable capture:');
    expect(item.nextAction).toContain('remove --no-ptt');
  });

  it('only needs opt-in when a disabled recognizer is already configured', () => {
    const input = facts([]);
    input.transcription.enabled = false;
    const item = assembleReadiness(input).items.find(row => row.capability === 'transcription')!;
    expect(item.detail).toContain('recognizer configured');
    expect(item.nextAction).toContain('STEREOFOLD_PTT_TRANSCRIBE=1');
    expect(item.nextAction).not.toContain('install');
  });

  it('names missing prerequisites and repair even when capture is already enabled', () => {
    const input = facts([]);
    input.transcription = { enabled: true, ready: false, route: 'apple', missing: ['the applespeech tool', 'a whisper model'],
      detail: 'Apple recognizer unresolved; fallback Whisper model unresolved' };
    const item = assembleReadiness(input).items.find(row => row.capability === 'transcription')!;
    expect(item.detail).toContain('voice is on but nothing can transcribe');
    expect(item.detail).toContain('the applespeech tool, a whisper model');
    expect(item.nextAction).toContain('STEREOFOLD_PTT_TRANSCRIBER=apple');
    expect(item.nextAction).not.toContain('Then enable capture:');
  });

  it('keeps recovery on the configured reply provider', () => {
    const input = facts([]);
    input.replies = { enabled: true, ready: true, dryRun: 'failed', detail: 'OAuth synthesis failed' };
    const item = assembleReadiness(input).items.find(row => row.capability === 'replies')!;
    expect(item.nextAction).toContain('agent-voice and its existing OAuth login');
    expect(item.nextAction).toContain('Keep the selected provider');
  });
});

describe('observed speech and conversation readiness', () => {
  it('distinguishes recognizer configuration from observed capture', () => {
    const input = facts([]);
    input.transcription = { enabled: true, ready: true, route: 'apple',
      detail: 'Apple recognizer at /fixture/applespeech; consent not yet observed', missing: [] };
    const before = assembleReadiness(input).items.find(i => i.capability === 'transcription')!;
    expect(before.state).toBe('not-checked');
    expect(before.detail).toContain(input.transcription.detail);
    expect(before.nextAction).toContain('app that started this host');
    input.transcription.captureObserved = true;
    const after = assembleReadiness(input).items.find(i => i.capability === 'transcription')!;
    expect(after.state).toBe('ok');
    expect(after.detail).toContain('capture transcribed in this session');
    expect(after.detail).not.toContain('consent not yet observed');
    expect(after.nextAction).not.toContain('dialog');
    expect(after.nextAction).toContain('has been transcribed');
  });

  it('asks for an observed transcript on a configured Whisper route', () => {
    const input = facts([]);
    input.transcription.route = 'whisper';
    const item = assembleReadiness(input).items.find(row => row.capability === 'transcription')!;
    expect(item.state).toBe('not-checked');
    expect(item.detail).toContain('capture/permission not yet observed');
    expect(item.nextAction).toContain('confirm its transcript');
    expect(item.nextAction).not.toContain('Nothing to do');
  });

  it('requires both recent listening and processed requests and exposes a stalled consumer', () => {
    const input = facts([]);
    const agent = () => assembleReadiness(input).items.find(i => i.capability === 'agent')!;
    expect(agent()).toMatchObject({ state: 'missing', detail: 'listener polled, but no conversation request has been processed' });
    input.actionAgeMs = 0;
    expect(agent().state).toBe('ok');
    input.actionAgeMs = input.listenWindowMs + 1;
    expect(agent()).toMatchObject({ state: 'missing' });
    expect(agent().detail).toContain('consumer unavailable');
    input.actionAgeMs = 0;
    input.listenAgeMs = input.listenWindowMs + 1;
    expect(agent().state).toBe('missing');
  });
});

it('distinguishes an active unacknowledged channel from a processed conversation',()=>{
  const input=facts([{surface:'companion',availability:'ready',current:true}]);
  input.agentAttached=false;
  input.listenAgeMs=undefined;
  input.voiceDelivery={mode:'channel',channelActive:true,acknowledgement:'unavailable',assistant:'Claude'};
  const waiting=assembleReadiness(input);
  expect(waiting.voiceDelivery).toEqual(input.voiceDelivery);
  expect(waiting.items.find(i=>i.capability==='agent')).toMatchObject({state:'not-checked'});
  expect(waiting.blocking).toContain('agent');
  expect(formatReadiness(waiting)).toContain('Claude is listening (channel)');
  input.actionAgeMs=0;
  const answered=assembleReadiness(input);
  expect(answered.items.find(i=>i.capability==='agent')).toMatchObject({state:'ok'});
  expect(answered.blocking).not.toContain('agent');
});
