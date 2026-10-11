import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { attachVoiceCommandRunner } from './voice-command-runner.mjs';
import { createDiagnosticsBuffer } from './headset-diagnostics.mjs';
import { workbenchFailureCaption, WORKBENCH_OPENED_CAPTION } from './xr-manipulate.mjs';
import { announceWorkbenchTransfer, beginWorkbenchHandoff, WORKBENCH_TRANSFER_CAPTION as HEADSET_WORKBENCH_CAPTION } from './workbench-handoff.mjs';
import { QUEST_EXIT_BANNER_KEY, noteQuestExitBanner } from './quest-exit-banner.mjs';

// Acceptance 3, sequence 7: #803 host refusal, #804 status, #806 false applied,
// #808 caption. Execute the page branch, not a stub of its return contract.
const reason = 'The filament tier has no atom coordinates. Switch to an atomic tier, then open Mol* again.';
const line = 'Filament tier has no atoms. Switch to an atomic tier.';
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const start = source.indexOf("        if (action.kind === 'open-workbench')");
const end = source.indexOf('        // Spatial edits share', start);
const hostStart = source.indexOf('  async function openDetailedViewOnHost(');
const hostEnd = source.indexOf('\n  }', hostStart) + 4;

function harness(result) {
  const records = createDiagnosticsBuffer();
  const status = [], captions = [], spoken = [], navigations = [];
  const sequence = [], timers = [];
  // The tab's own note that Quest Browser's background-session banner
  // is about to be up. The page slice writes it on the way out, so the harness
  // supplies the storage the same way it supplies the location it navigates.
  const stored = new Map();
  const sessionStorage = { getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, String(value)); } };
  let handoff;
  const show = text => { status.push(text); sequence.push(['status', text]); };
  const speak = text => { spoken.push(text); sequence.push(['spoken', text]); };
  const canvas = { xr: { isPresenting: { value: true } } };
  const context = vm.createContext({
    onOpenWorkbench: async () => {
      sequence.push(['host-request']);
      const answer = await result;
      sequence.push(['host-answer']);
      return answer;
    },
    canvas,
    immersiveSession: { end: async () => {
      sequence.push(['end-session']);
      canvas.xr.isPresenting.value = false;
    } },
    location: { assign: address => sequence.push(['navigate', address]) },
    showHeadsetCaption: show,
    speakOutcome: text => { captions.push(text); speak(text); },
    voiceCommandSpeaker: () => speak,
    recordManipulation: (kind, detail) => records.record(kind, detail),
    workbenchFailureCaption, HEADSET_WORKBENCH_CAPTION, WORKBENCH_OPENED_CAPTION,
    announceWorkbenchTransfer, workbenchHandoff: undefined, noteQuestExitBanner, sessionStorage,
    beginWorkbenchHandoff: options => {
      navigations.push(options);
      handoff = beginWorkbenchHandoff({ ...options,
        setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
      return handoff;
    },
  });
  const dispatch = vm.runInContext(`${source.slice(hostStart, hostEnd)}\n(async action => {${source.slice(start, end)}})`, context);
  const runner = attachVoiceCommandRunner({ events: { on: () => () => {} }, dispatch,
    caption: show, speak,
    record: (kind, detail) => records.record(kind, detail) });
  return { runner, dispatch, records, status, captions, spoken, navigations, sequence, stored,
    finishHandoff: async () => { timers.shift()(); return handoff.settled; } };
}

for (const phrase of ['open Mol*', 'open it on the Mac']) {
  test(`refused ${phrase} records refused with the host reason and preserves its ten-word answer`, async () => {
    const h = harness({ opened: false, reason });
    try {
      await globalThis.__stereofoldVoice.say(phrase);
      const receipt = h.records.all().find(entry => entry.kind === 'voice-command');
      assert.equal(receipt.detail.outcome, 'refused', 'a refused Mol* request must not be applied or failed');
      assert.equal(receipt.detail.reason, reason);
      assert.deepEqual(h.status, [line]);
      assert.deepEqual(h.captions, [line]);
      assert.deepEqual(h.spoken, [line]);
      assert.ok(h.spoken.every(text => text.trim().split(/\s+/).length <= 12));
      assert.equal(h.navigations.length, 0);
    } finally { h.runner.dispose(); }
  });
}

test('a successful Mol* handoff still records applied and schedules navigation', async () => {
  const h = harness({ opened: true, headsetUrl: '/detailed' });
  try {
    await globalThis.__stereofoldVoice.say('open Mol*');
    assert.equal(h.records.all().find(entry => entry.kind === 'voice-command').detail.outcome, 'applied');
    assert.equal(h.navigations.length, 1);
  } finally { h.runner.dispose(); }
});

// Acceptance 5, sequence 7: #57/#59 status and #61 speech promised an
// opening before #68 refused it. Keep the host pending to expose both routes.
for (const route of ['voice', 'toolbar']) {
  for (const opened of [false, true]) {
    test(`${route} waits for the host before the exact ${opened ? 'opening' : 'refusal'} sequence`, async () => {
      let answer;
      const h = harness(new Promise(resolve => { answer = resolve; }));
      try {
        const pending = route === 'voice'
          ? globalThis.__stereofoldVoice.say('open Mol*')
          : h.dispatch({ kind: 'open-workbench' });
        await Promise.resolve();
        assert.deepEqual(h.sequence, [['host-request']], 'no promise or speech while the host is pending');
        answer(opened ? { opened: true, headsetUrl: '/detailed' } : { opened: false, reason });
        await pending;
        const response = opened ? HEADSET_WORKBENCH_CAPTION : line;
        const expected = [['host-request'], ['host-answer'], ['status', response], ['spoken', response]];
        // The real handoff refreshes its caption while holding before teardown.
        if (opened) expected.push(['status', response]);
        assert.deepEqual(h.sequence, expected);
        assert.deepEqual(h.spoken, [response], 'exactly one spoken outcome');
        assert.deepEqual(h.status, opened ? [response, response] : [response]);
        assert.ok([...h.spoken, ...h.status].every(text => text.trim().split(/\s+/).length <= 12));
        if (opened) {
          assert.equal(await h.finishHandoff(), 'navigated');
          assert.deepEqual(h.sequence, [...expected, ['end-session'], ['navigate', '/detailed']]);
          // The Mol* page cannot see Quest Browser's exit banner, so
          // the tab that leaves says it was in a session a moment ago
          assert.equal(typeof JSON.parse(h.stored.get(QUEST_EXIT_BANNER_KEY)).at, 'number');
        } else {
          assert.equal(h.navigations.length, 0);
          assert.equal(h.stored.has(QUEST_EXIT_BANNER_KEY), false, 'a refusal claims no banner');
        }
      } finally { h.runner.dispose(); }
    });
  }
}
