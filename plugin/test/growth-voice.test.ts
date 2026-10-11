/**
 * The wearer's own "grow it", end to end through the runner.
 *
 * The grammar itself is held in
 * `lab/browser-roundtrip/growth-voice.test.mjs`. What
 * is checked here is the half a resolver cannot show: that a spoken growth
 * phrase reaches the dispatcher as one `grow-structure` action, that the
 * sentence the wearer ends up hearing is the host's and not the grammar's, and
 * that a refused tier is answered rather than reported as a failure.
 *
 * The parity case matters more than it looks. There are two fixed grammars —
 * this page's, and `inspection-voice.ts` on the Mac — and either of them can
 * match a sentence first depending on which microphone heard it. They have to
 * name the same four commands, or "grow it" grows different things in the same
 * headset depending on the route.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
// @ts-ignore Shared JavaScript voice command runner, the same one the companion bundles.
import { attachVoiceCommandRunner, spatialVoiceAction, GROW_NOT_YET_SPOKEN as runnerNotYet, GROW_STILL_BUSY_SPOKEN as runnerStillBusy, SPOKEN_REPLY_MAX_WORDS } from '../../lab/browser-roundtrip/voice-command-runner.mjs';
// @ts-ignore Shared JavaScript grammar, the one the headset page itself reads.
import { voiceCommandFromTranscript as pageCommand } from '../../lab/browser-roundtrip/voice-command.mjs';
// @ts-ignore Shared JavaScript headset microphone streamer.
import { createPushToTalkAudioEvents } from '../../lab/browser-roundtrip/push-to-talk-audio.mjs';
import { voiceCommandFromTranscript as macCommand } from '../src/inspection-voice.js';
import { TOOLS } from '../src/inspection-companion-http.js';
import { ALLOWED_TOOLS } from '../src/inspection-lan.js';
import { growStructureRequest, growStructureSchema } from '../src/inspection-contract.js';
import { InspectionCommands } from '../src/inspection-commands.js';
import {
  GROW_NOT_YET_SPOKEN, GROW_STILL_BUSY_SPOKEN, PANEL_BUSY_MESSAGE, isCommandInFlight,
  inFlightAttempts, retryWhileNotYet,
} from '../src/command-in-flight.js';

type Action = { kind: string; [key: string]: unknown };

/** The same seam `immersive-session.mjs` wires: an emitter and a dispatcher. */
function harness(answer: (action: Action) => unknown) {
  const events = createPushToTalkAudioEvents();
  const actions: Action[] = [], captions: string[] = [], spoken: string[] = [];
  const records: { kind: string; detail: any }[] = [];
  const runner = attachVoiceCommandRunner({
    events,
    dispatch: async (action: Action) => { actions.push(action); return answer(action); },
    caption: (text: string) => { captions.push(text); },
    speak: async (text: string) => { spoken.push(text); },
    record: (kind: string, detail: unknown) => { records.push({ kind, detail }); },
  });
  let utterance = 0;
  const say = async (text: string) => {
    events.emit({ state: 'heard', utteranceId: `u${++utterance}`, text, message: `Heard: ${text}` });
    await runner.settled();
  };
  return { actions, captions, spoken, records, say, runner };
}

describe('growing a staged lesson by voice', () => {
  it('dispatches one grow action for a spoken growth phrase', async () => {
    const stand = harness(() => ({ spoken: 'Grown to one tubulin dimer.' }));
    await stand.say('grow it');
    expect(stand.actions).toEqual([{ kind: 'grow-structure', stage: 'next' }]);
    // The short line lands at transcription latency; the rebuild takes seconds,
    // so the wearer is answered twice and the second answer names the tier.
    expect(stand.captions).toEqual(['Growing.', 'Grown to one tubulin dimer.']);
    expect(stand.spoken).toEqual(['Grown to one tubulin dimer.']);
    expect(stand.records).toEqual([{ kind: 'voice-command',
      detail: { phrase: 'grow', action: 'grow-structure', outcome: 'applied' } }]);
    stand.runner.dispose();
  });

  it.each([
    ['grow it', 'next'], ['add tubulin', 'next'], ['keep growing', 'next'],
    ['shrink it', 'back'], ['take one away', 'back'],
    ['build the wall', 'wall'], ['cap it', 'tip'],
  ])('“%s” asks the host for the %s tier', async (phrase, stage) => {
    const stand = harness(() => ({ spoken: 'Grown to a wall three protofilaments wide.' }));
    await stand.say(phrase);
    expect(stand.actions).toEqual([{ kind: 'grow-structure', stage }]);
    stand.runner.dispose();
  });

  it('reads out a refusal instead of confirming a tier that never landed', async () => {
    // A Quest 2's ceiling is the wall at 40,908 atom sites, and the tip carries
    // 43,066, so "cap it" on a Quest 2 ends here. The wearer must
    // not hear "Capping the tip." over a structure that did not change.
    const refusal = 'Too big for this headset. Staying here.';
    const stand = harness(() => ({ spoken: refusal }));
    await stand.say('cap it');
    expect(stand.actions).toEqual([{ kind: 'grow-structure', stage: 'tip' }]);
    expect(stand.captions).toEqual(['Capping the tip.', refusal]);
    expect(stand.spoken).toEqual([refusal]);
    // A refusal is an answer, not an error: the command is still `applied`, so
    // `read_headset_log` does not report a broken grow the wearer never had.
    expect(stand.records.at(-1)).toEqual({ kind: 'voice-command',
      detail: { phrase: 'cap', action: 'grow-structure', outcome: 'applied' } });
    expect(refusal.split(/\s+/).length).toBeLessThan(12);
    stand.runner.dispose();
  });

  it('speaks the reason when the panel cannot grow at all', async () => {
    // `growStructure` throws this while an edit is unsaved. It reaches the
    // wearer out loud, the way every other refused spoken command does.
    const stand = harness(() => { throw Error('Finish the current edit before growing the structure.'); });
    await stand.say('grow it');
    expect(stand.spoken).toEqual(['Finish the current edit before growing the structure.']);
    expect(stand.records.at(-1)?.detail).toMatchObject({ action: 'grow-structure', outcome: 'failed' });
    stand.runner.dispose();
  });

  it('records retrying then applied when the grow waited out a busy panel', async () => {
    const stand = harness(() => ({ spoken: 'Grown to one tubulin dimer.', retrying: true }));
    await stand.say('grow it');
    expect(stand.records.map(entry => entry.detail.outcome)).toEqual(['retrying', 'applied']);
    expect(stand.spoken).toEqual(['Grown to one tubulin dimer.']);
    stand.runner.dispose();
  });

  it('records retrying then failed after the busy-panel budget, and says so', async () => {
    const stand = harness(() => {
      throw Object.assign(Error(GROW_STILL_BUSY_SPOKEN), { retrying: true });
    });
    await stand.say('grow it');
    expect(stand.records.map(entry => entry.detail.outcome)).toEqual(['retrying', 'failed']);
    expect(stand.spoken).toEqual([GROW_STILL_BUSY_SPOKEN]);
    expect(GROW_STILL_BUSY_SPOKEN.split(/\s+/).length).toBeLessThan(12);
    stand.runner.dispose();
  });

  it('keeps the short line when a host says nothing back', async () => {
    const stand = harness(() => undefined);
    await stand.say('grow it');
    expect(stand.spoken).toEqual(['Growing.']);
    stand.runner.dispose();
  });

  it('names the same four commands as the Mac grammar', () => {
    for (const phrase of ['grow it', 'grow', 'keep growing', 'add tubulin', 'add a tubulin',
      'add another tubulin', 'add more tubulin', 'grow the microtubule', 'grow the filament', 'make it grow',
      'shrink it', 'shrink', 'go back a tier', 'take one away', 'remove a tubulin', 'shrink the microtubule',
      'build the wall', 'show the wall', 'make the wall', 'build a wall',
      'cap it', 'cap the end', 'show the tip', 'show the cap', 'add the cap']) {
      // The Mac's resolver answers with the command name itself; the page's
      // wraps it beside the normalized transcript it matched.
      expect(pageCommand(phrase)?.command, phrase).toBe(macCommand(phrase));
    }
  });

  it('carries the stage the Mac’s own voice action would have asked for', () => {
    // `inspection-voice-actions.ts` maps the same four command names onto
    // next / back / wall / tip. The page's table has to agree with that map or
    // the two routes grow different tiers from one sentence.
    const stages = { 'grow-structure': 'next', 'shrink-structure': 'back', 'grow-wall': 'wall', 'grow-tip': 'tip' };
    for (const [phrase, command] of [['grow it', 'grow-structure'], ['shrink it', 'shrink-structure'],
      ['build the wall', 'grow-wall'], ['cap it', 'grow-tip']] as const) {
      expect(spatialVoiceAction(phrase).action.stage, phrase).toBe(stages[command]);
    }
  });
});

describe('the grow_structure request the headset page posts', () => {
  const binding = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    serverEpoch: '22222222-2222-4222-8222-222222222222',
    sourceToken: '33333333-3333-4333-8333-333333333333',
    baseStateRevision: 4,
    baseInspectionRevision: 2,
  };
  const panelId = '44444444-4444-4444-8444-444444444444';

  it('carries panelId, the live binding, the stage, and the paired device class', () => {
    const posted = growStructureRequest(binding, panelId, 'next', 'quest2');
    expect(posted).toEqual({ ...binding, panelId, stage: 'next', device: 'quest2' });
    expect(growStructureSchema.parse(posted)).toEqual(posted);
  });

  it('is refused without the panel the wearer is looking through', () => {
    expect(() => growStructureSchema.parse({ ...binding, stage: 'next', device: 'quest2' })).toThrow();
  });

  it('is refused for a device class the share does not name', () => {
    expect(() => growStructureSchema.parse({ ...binding, panelId, stage: 'next', device: 'oculus' })).toThrow();
  });

  it('is on the companion /tool allowlist, so the page is not answered 400 invalid_request', () => {
    expect(TOOLS.has('grow_structure')).toBe(true);
    expect(ALLOWED_TOOLS.has('grow_structure')).toBe(true);
  });

  it('is the object inspector.ts posts, including device from this headset', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/function growStructureArgs\(stage:string\) \{\n  return \{\.\.\.expected\(\),panelId,stage,device:headsetDeviceClass\(\)\};\n\}/);
    expect(source).toContain("call('grow_structure',growStructureArgs(stage))");
  });

  it('registers grow_structure as a companion-dispatchable private tool and retargets its source swap', async () => {
    const source = await readFile(new URL('../src/inspection-server.ts', import.meta.url), 'utf8');
    expect(source).toContain("privateTool('stereo_structure.grow_structure'");
    expect(source).not.toMatch(/registerAppTool\(server,'stereo_structure\.grow_structure'/);
    expect(source).toMatch(/name==='grow_structure'/);
  });

  it('queues a host refusal onto the companion poll so the page can arm the caption plate', async () => {
    const server = await readFile(new URL('../src/inspection-server.ts', import.meta.url), 'utf8');
    expect(server).toContain('createGrowthCaptionMailbox');
    expect(server).toContain('growthCaptions.offer');
    expect(server).toContain('growthCaptions.claim');
    expect(server).toContain('growthCaption');
    const inspector = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    expect(inspector).toContain("stereofold-growth-caption");
    const viewer = await readFile(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    expect(viewer).toContain('GROWTH_CAPTION_EVENT');
    expect(viewer).toContain('armGrowthCaption');
    expect(viewer).toContain('growthOverlayFromNotice');
    expect(viewer).toContain('scheduleViewFrame');
  });

  it('retries a busy-panel 409 inside growStructure rather than failing the voice command', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    expect(source).toContain('retryWhileNotYet');
    expect(source).toContain('refreshGrowBinding');
    expect(source).toContain("call('grow_structure',growStructureArgs(stage))");
  });
});

describe('a 409 busy panel is not-yet, not a failed grow', () => {
  const busy = Object.assign(Error(PANEL_BUSY_MESSAGE), { status: 409 });
  const ceiling = 'Too big for this headset. Staying here.';

  it('matches the companion 409 sentence the driver already treated as not-yet', () => {
    expect(isCommandInFlight(busy)).toBe(true);
    expect(isCommandInFlight(PANEL_BUSY_MESSAGE)).toBe(true);
    expect(isCommandInFlight(Error('A molecular change is still rendering.'))).toBe(true);
    expect(isCommandInFlight(Error('Read the current inspection state before growing the structure.'))).toBe(true);
  });

  it('does not retry a genuine refusal or a 4xx other than that 409', () => {
    expect(isCommandInFlight(Error(ceiling))).toBe(false);
    expect(isCommandInFlight(Object.assign(Error(PANEL_BUSY_MESSAGE), { status: 400 }))).toBe(false);
    expect(isCommandInFlight(Object.assign(Error('invalid_request'), { status: 400 }))).toBe(false);
    expect(isCommandInFlight(Error('This session is not playing a staged lesson, so there is no tier to grow from.'))).toBe(false);
    expect(isCommandInFlight(Error('I do not know that one. Try grow it.'))).toBe(false);
  });

  it('says One moment once, then the host line, on a size-aware budget', async () => {
    const notices: string[] = [];
    const waits: number[] = [];
    let posts = 0;
    const grown = await retryWhileNotYet(async () => {
      posts++;
      if (posts === 1) throw busy;
      return 'Grown to one tubulin dimer.';
    }, {
      atomSites: 3_343,
      refresh: async () => { notices.push('refresh'); },
      wait: async seconds => { waits.push(seconds); },
      onNotYet: () => { notices.push(GROW_NOT_YET_SPOKEN); },
    });
    expect(grown).toBe('Grown to one tubulin dimer.');
    expect(posts).toBe(2);
    expect(notices).toEqual([GROW_NOT_YET_SPOKEN, 'refresh']);
    expect(waits).toEqual([2]);
    expect(GROW_NOT_YET_SPOKEN.split(/\s+/).length).toBeLessThan(12);
    expect(inFlightAttempts(3_343)).toBeGreaterThanOrEqual(6);
  });

  it('gives up with Still busy after the budget, and does not retry a 400', async () => {
    await expect(retryWhileNotYet(async () => { throw busy; }, {
      attempts: 2, wait: async () => {}, onNotYet: () => {},
    })).rejects.toThrow(GROW_STILL_BUSY_SPOKEN);
    let posts = 0;
    await expect(retryWhileNotYet(async () => {
      posts++;
      throw Object.assign(Error('invalid_request'), { status: 400 });
    }, { attempts: 6, wait: async () => {} })).rejects.toMatchObject({ status: 400, message: 'invalid_request' });
    expect(posts).toBe(1);
  });

  it('keeps the same spoken lines on the page and in the runner', () => {
    expect(GROW_NOT_YET_SPOKEN).toBe(runnerNotYet);
    expect(GROW_STILL_BUSY_SPOKEN).toBe(runnerStillBusy);
    expect(GROW_NOT_YET_SPOKEN.split(/\s+/).length).toBeLessThanOrEqual(SPOKEN_REPLY_MAX_WORDS);
    expect(GROW_STILL_BUSY_SPOKEN.split(/\s+/).length).toBeLessThanOrEqual(SPOKEN_REPLY_MAX_WORDS);
  });

  it('says One moment from the grow-structure branch while the page waits', async () => {
    const source = await readFile(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
    expect(source).toContain("showHeadsetCaption('One moment.')");
    expect(source).toContain('retrying: true');
  });
});

/**
 * A grow that has to wait, asked again against a host that is
 * actually watching what the panel says it is.
 *
 * The retry test above stubs the post, so it never observes the one thing that
 * decided whether a wait could end at all: what the panel reported about
 * itself while it waited. `growStructure` set the renderer-busy flag before
 * its first post, which diverted the heartbeat to `busyBeat` and reported this
 * panel `busy` for the whole wait — and `grow_structure` only ever targets a
 * `ready` panel. A first attempt could still land, so the defect read as an
 * intermittent one; in fact every grow that was refused once was refused for
 * good, and the wearer heard "Still busy. Try again." when the budget ran out.
 *
 * The host here is the real `InspectionCommands`: the same `readyPanel` gate
 * `stereo_structure.grow_structure` calls, fed by the same `poll` that records
 * a panel's availability from its beat, on an injected clock. The panel is
 * `growStructure`'s own sequence — a renderer-busy flag, a beat that reports
 * what that flag says, the real `retryWhileNotYet` around the post, and the
 * queue that serializes one grow behind another. `legacy` is that sequence
 * with the flag back where it used to be, and it is here so that a host which
 * cannot catch the defect fails this file rather than passing it quietly.
 */
describe('a grow waiting for permission against a host that watches the beat', () => {
  const SESSION = {
    serverEpoch: '22222222-2222-4222-8222-222222222222',
    sourceToken: '33333333-3333-4333-8333-333333333333',
    stateRevision: 4,
    inspectionRevision: 2,
  };
  const GROWN = 'Grown to one tubulin dimer.';

  /** The Mac: a real command registry, a clock, and a log of every beat. */
  function fakeHost(options: { refuseFirstPosts?: number } = {}) {
    const clock = { now: 1_000_000 };
    const commands = new InspectionCommands(() => clock.now);
    const binding = { ...SESSION };
    const expected = () => ({
      serverEpoch: binding.serverEpoch, sourceToken: binding.sourceToken,
      baseStateRevision: binding.stateRevision, baseInspectionRevision: binding.inspectionRevision,
    });
    const beats: { at: number; availability: string }[] = [];
    const panelId = commands.attach({ ...expected(), surface: 'companion' }, binding);
    let refusals = options.refuseFirstPosts ?? 0;
    const busy = () => Object.assign(Error(PANEL_BUSY_MESSAGE), { status: 409 });
    return {
      clock, commands, binding, panelId, beats,
      /** One heartbeat, recorded as the host saw it. */
      poll(availability: 'ready' | 'busy' | 'unsaved') {
        beats.push({ at: clock.now, availability });
        return commands.poll({ ...expected(), panelId, availability }, binding);
      },
      /** `grow_structure`: the host's own gate, and nothing else. */
      grow() {
        // The host's first tries can be refused for reasons of its own — an
        // agent command still settling — whatever this panel says it is.
        if (refusals > 0) { refusals--; throw busy(); }
        if (!commands.readyPanel(panelId, binding)) throw busy();
        return { to: 'dimer', spoken: GROWN };
      },
      availabilities() { return beats.map(beat => beat.availability); },
      lastAvailability() { return beats.at(-1)?.availability; },
    };
  }

  /**
   * The headset page: `growStructure`'s sequence, with the renderer-busy flag
   * where the fix puts it, or where the defect put it.
   */
  function fakePanel(host: ReturnType<typeof fakeHost>, options: { legacy?: boolean } = {}) {
    let remote = false;
    let rendering: Promise<unknown> = Promise.resolve();
    const beat = () => host.poll(remote ? 'busy' : 'ready');
    const tick = (seconds: number) => {
      for (let second = 0; second < seconds; second++) { host.clock.now += 1_000; beat(); }
    };
    return {
      tick,
      beat,
      /** A command that owns the renderer for a beat or two, like a stop. */
      runCommand(seconds = 2) { remote = true; tick(seconds); remote = false; },
      /** One "grow it", queued behind whatever the renderer is already doing. */
      grow(notices: string[]) {
        const operation = rendering.catch(() => {}).then(async () => {
          if (options.legacy) remote = true;
          let grown: { spoken: string };
          try {
            grown = await retryWhileNotYet(async () => {
              const result = host.grow();
              remote = true;
              return result;
            }, {
              attempts: 6,
              refresh: () => { options.legacy ? host.poll('busy') : beat(); },
              wait: async seconds => { tick(seconds); },
              onNotYet: () => { notices.push(GROW_NOT_YET_SPOKEN); },
            });
          } catch (error) { remote = false; throw error; }
          // The swap the host accepted. The renderer is genuinely busy here,
          // and the beat says so until the new tier is standing.
          tick(2);
          remote = false;
          return grown.spoken;
        });
        rendering = operation.then(() => undefined).catch(() => {});
        return operation;
      },
    };
  }

  it('refuses while the last beat said busy and accepts once a beat says ready', () => {
    // The contract this whole gate turns on, stated against the real gate.
    const host = fakeHost();
    host.poll('busy');
    expect(host.commands.readyPanel(host.panelId, host.binding)).toBe(false);
    expect(() => host.grow()).toThrow(PANEL_BUSY_MESSAGE);
    host.poll('ready');
    expect(host.commands.readyPanel(host.panelId, host.binding)).toBe(true);
    expect(host.grow()).toMatchObject({ spoken: GROWN });
  });

  it('grows after a stop, by reporting ready while it waits for permission', async () => {
    const host = fakeHost(), panel = fakePanel(host), notices: string[] = [];
    // "stop": the renderer was owned a moment ago, and the last thing the host
    // heard from this panel was `busy`. Then "grow it", with no beat between.
    panel.runCommand();
    expect(host.lastAvailability()).toBe('busy');
    expect(await panel.grow(notices)).toBe(GROWN);
    // Heard once, while it waited — not once per try, and not at the end.
    expect(notices).toEqual([GROW_NOT_YET_SPOKEN]);
    // The wait is what made it possible: the panel told the host the truth.
    expect(host.availabilities()).toContain('ready');
  });

  it('cannot recover from that same stop when the flag goes on before the post', async () => {
    // The defect, kept here so a host that stops watching the beat fails.
    const host = fakeHost(), panel = fakePanel(host, { legacy: true }), notices: string[] = [];
    panel.runCommand();
    await expect(panel.grow(notices)).rejects.toThrow(GROW_STILL_BUSY_SPOKEN);
    expect(notices).toEqual([GROW_NOT_YET_SPOKEN]);
    // Every beat it sent while waiting re-asserted the one condition it was
    // waiting to clear, so the budget could only ever expire.
    expect(host.availabilities().every(availability => availability === 'busy')).toBe(true);
  });

  it('lets a second grow queue behind the first instead of leaving a stuck budget', async () => {
    const host = fakeHost(), panel = fakePanel(host);
    const firstNotices: string[] = [], secondNotices: string[] = [];
    // Both asked before either has landed, which is what "grow it, grow it"
    // in the headset actually is.
    const first = panel.grow(firstNotices), second = panel.grow(secondNotices);
    expect(await first).toBe(GROWN);
    expect(await second).toBe(GROWN);
    // The first found a ready panel and never waited. The second arrived on
    // top of the first tier's rebuild, waited one round, and landed.
    expect(firstNotices).toEqual([]);
    expect(secondNotices).toEqual([GROW_NOT_YET_SPOKEN]);
    expect(host.availabilities()).toContain('ready');
  });

  it('waits out a host that is busy on the first try and ready on the second', async () => {
    // Nothing is wrong with this panel: the refusal is the Mac's own, and the
    // page has no way to tell the two apart. It waits either way.
    const host = fakeHost({ refuseFirstPosts: 1 }), panel = fakePanel(host), notices: string[] = [];
    panel.beat();
    expect(host.lastAvailability()).toBe('ready');
    expect(await panel.grow(notices)).toBe(GROWN);
    expect(notices).toEqual([GROW_NOT_YET_SPOKEN]);
  });

  it('keeps the renderer-busy flag out of the wait, in inspector.ts itself', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const grow = source.slice(source.indexOf('async function growStructure'), source.indexOf('function expected()'));
    // The flag goes on where the host accepts the post, and nowhere earlier.
    expect(grow).toMatch(/call\('grow_structure',growStructureArgs\(stage\)\);\n\s*remote=true;/);
    expect(grow.slice(0, grow.indexOf('retryWhileNotYet'))).not.toContain('remote=true');
    // The between-tries beat reports the panel; it no longer declares it busy.
    const refresh = source.slice(source.indexOf('async function refreshGrowBinding'), source.indexOf('async function growStructure'));
    expect(refresh).toContain('availability:liveAvailability()');
    expect(refresh).not.toContain("availability:'busy'");
    // One rule for what this panel is, read by the ordinary beat as well.
    expect(source).toContain('function liveAvailability()');
    const ordinaryBeat = source.slice(source.indexOf('const ownGeneration=generation, sent={...expected(),panelId,'), source.indexOf('let response;', source.indexOf('const ownGeneration=generation, sent={...expected(),panelId,')));
    expect(ordinaryBeat).toContain('availability:liveAvailability(),');
    expect(ordinaryBeat).toContain('tourState:tourHeartbeat(panelTour),');
  });

  it('lets go of the renderer-busy flag when the post never lands, in inspector.ts itself', async () => {
    // The other half of the rule above. `remote` is what diverts the heartbeat
    // to `busyBeat`, and `grow_structure` only ever targets a `ready` panel —
    // so a flag left standing on a grow that gave up is a panel that can never
    // grow again, for the life of the page. There is no beat between the flag
    // and the throw for the fake host above to catch it on, so this is read
    // out of the source: every exit from the post has to put the flag down.
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const grow = source.slice(source.indexOf('async function growStructure'), source.indexOf('function expected()'));
    const wait = grow.slice(grow.indexOf('retryWhileNotYet'));
    // The budget ran out, or the host refused for good: flag down, trace gone.
    expect(wait).toMatch(/catch\(error\)\s*\{\s*remote=false;\s*sourceSwapTrace=undefined;\s*throw error;\s*\}/);
    // And the accepted swap puts it down on every path out of its own block.
    expect(wait).toContain('finally {remote=false;}');
  });
});
