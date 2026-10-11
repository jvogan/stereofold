/**
 * An agent grow sent while a lesson autoplays, and the wedge it
 * left on the real Quest 2.
 *
 * A hardware run grew microtubule-growth from
 * the protofilament tier to the wall while the lesson was autoplaying. The Mac
 * moved: its title became "A wall three protofilaments wide". The page never
 * followed. It kept re-theming the protofilament's 13,636 atom sites, its panel
 * answered `unsaved` and stayed `current:false` for 112 s, and all 109 of its
 * `/tool` posts came back 409 "This action belongs to a different structure."
 * The wedge outlived the immersive session and only a host restart cleared it.
 *
 * The cycle, and it is a true deadlock:
 *
 *   1. An autoplaying chapter paints, so the page is `dirty` when the Mac
 *      retires the source token.
 *   2. `poll` saves a dirty panel before it advertises readiness, and over the
 *      companion route `sync_inspection` is refused by `dispatch` in
 *      `inspection-server.ts` BEFORE the handler that would have answered
 *      `conflict:true` ever runs. The page sees a thrown 409, not a conflict.
 *   3. `saveFailureRecovery` never answers `reload` to an `error` on a
 *      companion — deliberately, because `block` is the eight-minute wedge of
 * — so it retries a save that can never succeed.
 *   4. `dirty` therefore never clears, and the transition hydrate that would
 *      have cleared it was gated on `dirty`.
 *
 * This file drives that loop against the real command registry, the real
 * availability and save-recovery rules, and a fake workspace, under both the
 * gate the page had and the one it has now.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { InspectionCommands } from '../src/inspection-commands.js';
import { followsSourceTransition, panelAvailability, saveFailureRecovery } from '../src/inspection-panel-recovery.js';
import { retryWhileNotYet, PANEL_BUSY_MESSAGE } from '../src/command-in-flight.js';

/**
 * The sentence the companion route refuses a stale-source post with. Copied
 * from `dispatch` in `inspection-server.ts`, and the case below pins the copy,
 * so this file fails rather than drifts if that refusal is reworded.
 */
const SOURCE_CHANGED_REFUSAL = 'This action belongs to a different structure.';

/** The gate `poll` used before the fix. Kept so the wedge can be reproduced. */
const gateBeforeTheFix = (input: { sourceChanged: boolean; experienceChanged: boolean;
  dirty: boolean; blocked: boolean; interactionActive: boolean }) =>
  (input.sourceChanged || input.experienceChanged) && !input.dirty && !input.blocked && !input.interactionActive;

type Tier = { sha: string; sites: number; lessonId: string; chapters: number };
const PROTOFILAMENT: Tier = { sha: 'sha-protofilament', sites: 13_636, lessonId: 'lesson-microtubule-growth-protofilament', chapters: 5 };
const WALL: Tier = { sha: 'sha-wall', sites: 40_908, lessonId: 'lesson-microtubule-growth-wall', chapters: 5 };

/**
 * The Mac, in the three rules the page can tell apart: the companion route's
 * source-capability check, `sync_inspection`'s optimistic save, and the
 * narration binding. Panels, availability and command delivery are the real
 * `InspectionCommands`.
 */
function host(now: () => number) {
  const commands = new InspectionCommands(now);
  const state = {
    serverEpoch: randomUUID(), sourceToken: randomUUID(), tier: PROTOFILAMENT,
    scene: null as any, stateRevision: 1, revision: 0,
    transitionTarget: undefined as string | undefined,
    /** The loopback bearer, retargeted by a verified source transition. */
    bearer: '',
  };
  state.bearer = state.sourceToken;
  const binding = () => ({ serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
    stateRevision: state.stateRevision, inspectionRevision: state.revision });
  const reads = new Set(['poll_inspection', 'get_inspection']);
  const posts: { name: string; refused?: number }[] = [];

  /** `dispatch` in `inspection-server.ts`: reads tolerate a stale token, writes do not. */
  function tool(name: string, args: any) {
    const stale = reads.has(name) && (state.bearer !== args.sourceToken || state.sourceToken !== args.sourceToken);
    if (!stale && args.sourceToken !== undefined && args.sourceToken !== state.bearer) {
      posts.push({ name, refused: 409 });
      throw Object.assign(Error(SOURCE_CHANGED_REFUSAL), { status: 409 });
    }
    posts.push({ name });
    if (name === 'get_inspection') return { data: { serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
      stateRevision: state.stateRevision, inspectionRevision: state.revision, scene: state.scene, tier: state.tier } };
    if (name === 'attach_inspection')
      return { panelId: commands.attach({ ...args, surface: 'companion' }, binding()) };
    if (name === 'detach_inspection') return { detached: commands.detach(args, binding()) };
    if (name === 'poll_inspection') {
      const answer = commands.poll(args, binding());
      return { ...answer, ...binding(), hasScene: Boolean(state.scene),
        transitionTarget: state.transitionTarget === args.panelId };
    }
    if (name === 'sync_inspection') {
      // The real handler's own answer, which the companion route never reaches
      // for a retired token: a stale binding is a `conflict`, not a commit.
      if (args.serverEpoch !== state.serverEpoch || args.sourceToken !== state.sourceToken
        || args.baseStateRevision !== state.stateRevision || args.baseInspectionRevision !== state.revision)
        return { conflict: true, ...binding() };
      if (JSON.stringify(args.scene) !== JSON.stringify(state.scene)) { state.scene = args.scene; state.revision++; }
      return { saved: true, ...binding() };
    }
    if (name === 'speak_to_headset') {
      // `validateNarrationVoiceBinding`: identity still holds for a spoken line.
      if (args.serverEpoch !== state.serverEpoch || args.sourceToken !== state.sourceToken)
        throw Object.assign(Error('The spoken line belongs to a replaced source.'), { status: 409 });
      return { spoken: true };
    }
    throw Error(`Unsupported companion action: ${name}`);
  }

  /** `grow_structure` as the Mac runs it: a fresh attachment, leased to one panel. */
  function grow(panelId: string, tier: Tier) {
    if (!commands.readyPanel(panelId, binding())) throw Object.assign(Error(PANEL_BUSY_MESSAGE), { status: 409 });
    state.sourceToken = randomUUID(); state.tier = tier; state.scene = null; state.revision = 0;
    state.stateRevision++; state.transitionTarget = panelId;
    // `authorizedSourceRetarget` keeps the LAN companion, on the new token.
    state.bearer = state.sourceToken;
    return { to: tier.lessonId };
  }
  return { state, commands, tool, grow, binding, posts };
}

/**
 * The headset page's beat, in the order `inspector.ts` runs it: save a dirty
 * panel, register if it has no panel, heartbeat, then follow a transition.
 */
function page(mac: ReturnType<typeof host>, options: { follow: typeof followsSourceTransition }) {
  const viewer = { sha: '', sites: 0, lessonId: '', chapter: 0 };
  /** The fake workspace's capture: a chapter's paint is what changes it. */
  const capture = () => ({ sha: viewer.sha, chapter: viewer.chapter });
  const self = {
    binding: undefined as any, panelId: undefined as string | undefined,
    dirty: false, blocked: false, loading: false, savedScene: null as any,
    edits: 0, saveAttempts: 0, lastAutoReload: 0, hydrations: 0, retries: 0,
    viewer, tourAutoplay: true, tourActive: true,
    availability: () => panelAvailability({ blocked: self.blocked, dirty: self.dirty, ready: true,
      interactionActive: false, navigating: false,
      // `liveAvailability`: an autoplaying lesson is presenting, not editing.
      presenting: self.tourActive && self.tourAutoplay, blind: false }),
    expected: () => ({ sessionId: 'session', serverEpoch: self.binding.serverEpoch, sourceToken: self.binding.sourceToken,
      baseStateRevision: self.binding.stateRevision, baseInspectionRevision: self.binding.inspectionRevision }),
    scheduleSave() { if (self.loading) return; self.dirty = true; self.edits++; },
    /** One chapter of the autoplaying lesson paints on the tier that is loaded. */
    paintChapter() { viewer.chapter++; self.scheduleSave(); },
    recoverSave(kind: 'busy' | 'conflict' | 'error') {
      self.saveAttempts++;
      const recovery = saveFailureRecovery({ kind, companion: true, attempt: self.saveAttempts,
        msSinceReload: Date.now() - self.lastAutoReload });
      if (recovery.action === 'retry') { self.retries++; return; }
      if (recovery.action === 'reload') { self.lastAutoReload = Date.now(); self.dirty = false; self.hydrate(); return; }
      self.blocked = true;
    },
    save() {
      if (!self.dirty || self.blocked || self.loading || !self.binding) return;
      const edit = self.edits, scene = capture();
      try {
        const answer: any = mac.tool('sync_inspection', { ...self.expected(), scene });
        if (answer.conflict) { self.recoverSave('conflict'); return; }
        if (!answer.saved) throw Error('The server did not confirm the save.');
        self.saveAttempts = 0;
        self.binding = { ...self.binding, ...answer }; self.savedScene = scene;
        self.dirty = self.edits !== edit || JSON.stringify(capture()) !== JSON.stringify(scene);
      } catch { self.recoverSave('error'); }
    },
    attach() {
      const answer: any = mac.tool('attach_inspection', self.expected());
      self.panelId = answer.panelId;
    },
    hydrate() {
      self.hydrations++;
      if (self.panelId) {
        // `detach` in `inspector.ts` retires the panel whether or not the Mac
        // can still be told: a swap is exactly when it cannot.
        const retiring = self.panelId; self.panelId = undefined;
        try { mac.tool('detach_inspection', { ...self.expected(), panelId: retiring, reason: 'loading' }); } catch { /* Retired regardless. */ }
      }
      self.loading = true;
      const { data }: any = mac.tool('get_inspection', { ...(self.binding ? self.expected() : {}), sessionId: 'session' });
      viewer.sha = data.tier.sha; viewer.sites = data.tier.sites; viewer.lessonId = data.tier.lessonId; viewer.chapter = 0;
      self.binding = { serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
        stateRevision: data.stateRevision, inspectionRevision: data.inspectionRevision };
      self.savedScene = data.scene; self.dirty = false; self.blocked = false;
      self.loading = false;
      self.scheduleSave(); self.save();
      if (!self.dirty && !self.blocked) self.attach();
    },
    beat() {
      if (self.dirty && !self.blocked) self.save();
      if (!self.panelId) { if (!self.blocked) self.attach(); return; }
      let answer: any;
      try { answer = mac.tool('poll_inspection', { ...self.expected(), panelId: self.panelId, availability: self.availability() }); }
      catch { return; }
      if (answer.attached === false) { self.panelId = undefined; return; }
      const sourceChanged = answer.sourceToken !== self.binding.sourceToken || answer.serverEpoch !== self.binding.serverEpoch;
      const transitionReady = answer.transitionTarget === true || answer.hasScene === true;
      if (transitionReady && options.follow({ sourceChanged, experienceChanged: false,
        dirty: self.dirty, blocked: self.blocked, interactionActive: false })) { self.hydrate(); return; }
    },
    /** A chapter line, which is the post the wedged run saw refused 109 times. */
    narrate() {
      try { mac.tool('speak_to_headset', { ...self.expected(), panelId: self.panelId, line: 'Thirteen protofilaments.' }); return 'spoken'; }
      catch (error) { return `refused ${(error as any).status}`; }
    },
  };
  return self;
}

/** One page that has opened the protofilament, saved it and registered a panel. */
function opened(follow: typeof followsSourceTransition) {
  let clock = 1_000_000;
  const mac = host(() => clock);
  const wearer = page(mac, { follow });
  wearer.hydrate();
  return { mac, wearer, tick: (ms: number) => { clock += ms; } };
}

describe('an agent grow sent while a lesson autoplays', () => {
  it('reproduces the hardware wedge under the gate the page had', () => {
    const stand = opened(gateBeforeTheFix as typeof followsSourceTransition);
    expect(stand.wearer.panelId).toBeDefined();
    expect(stand.wearer.viewer.sites).toBe(13_636);

    // The Mac grows to the wall between two chapters, which is what the
    // unattended driver does and what the wearer's "build the wall" does.
    stand.mac.grow(stand.wearer.panelId!, WALL);
    stand.wearer.paintChapter();

    for (let beat = 0; beat < 20; beat++) { stand.tick(1_000); stand.wearer.beat(); }

    // The page never followed: the wearer is still inside the protofilament.
    expect(stand.wearer.viewer.sites).toBe(13_636);
    expect(stand.wearer.hydrations).toBe(1);
    expect(stand.wearer.dirty).toBe(true);
    // "The panel went busy then unsaved and stayed current:false": `busy` for
    // as long as the lesson was autoplaying over the stuck save, and `unsaved`
    // once it parked itself, which is the state the driver captured
    // (`tour: {active: true, autoplay: false, step: 4}`).
    expect(stand.wearer.availability()).toBe('busy');
    stand.wearer.tourAutoplay = false;
    expect(stand.wearer.availability()).toBe('unsaved');
    expect(stand.wearer.narrate()).toBe('refused 409');
    // And the save it is spinning on is the one that can never be accepted.
    expect(stand.mac.posts.filter(post => post.name === 'sync_inspection' && post.refused === 409).length)
      .toBeGreaterThan(10);
  });

  it('follows the swap on the next beat and gets its panel back', () => {
    const stand = opened(followsSourceTransition);
    stand.mac.grow(stand.wearer.panelId!, WALL);
    stand.wearer.paintChapter();
    expect(stand.wearer.dirty).toBe(true);

    stand.tick(1_000); stand.wearer.beat();

    expect(stand.wearer.viewer.sites).toBe(40_908);
    expect(stand.wearer.viewer.lessonId).toBe('lesson-microtubule-growth-wall');
    expect(stand.wearer.hydrations).toBe(2);
    expect(stand.wearer.dirty).toBe(false);
    expect(stand.wearer.blocked).toBe(false);
    // The panel is registered against the NEW source, which is the fact the
    // Mac reads as `current` and the whole reason every post was refused.
    expect(stand.wearer.panelId).toBeDefined();
    expect(stand.wearer.binding.sourceToken).toBe(stand.mac.state.sourceToken);
    expect(stand.mac.commands.readyPanel(stand.wearer.panelId!, stand.mac.binding())).toBe(true);
    expect(stand.wearer.narrate()).toBe('spoken');
  });

  it('leaves an experience revision alone until the panel is clean', () => {
    // The other half of a transition is not a deadlock: the source token is
    // still current, so the dirty scene still saves and the hydrate lands a
    // beat later with the wearer's work kept rather than discarded.
    expect(followsSourceTransition({ sourceChanged: false, experienceChanged: true,
      dirty: true, blocked: false, interactionActive: false })).toBe(false);
    expect(followsSourceTransition({ sourceChanged: false, experienceChanged: true,
      dirty: false, blocked: false, interactionActive: false })).toBe(true);
  });

  it('holds a source change behind a hand on the molecule and a blocked panel', () => {
    const held = { sourceChanged: true, experienceChanged: false, dirty: true };
    expect(followsSourceTransition({ ...held, blocked: false, interactionActive: true })).toBe(false);
    expect(followsSourceTransition({ ...held, blocked: true, interactionActive: false })).toBe(false);
    expect(followsSourceTransition({ ...held, blocked: false, interactionActive: false })).toBe(true);
    expect(followsSourceTransition({ sourceChanged: false, experienceChanged: false,
      dirty: false, blocked: false, interactionActive: false })).toBe(false);
  });

  it('reads the poll gate out of the recovery rules rather than out of `dirty`', () => {
    const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const gate = source.slice(source.indexOf('const transitionReady='), source.indexOf('voiceReadyBinding=sent.availability'));
    expect(gate).toContain('followsSourceTransition({sourceChanged,experienceChanged,dirty,blocked');
    expect(gate).not.toMatch(/transitionReady\s*&&\s*!dirty/);
  });

  it('keeps the companion refusal the page is wedged by in one sentence', () => {
    const server = readFileSync(new URL('../src/inspection-server.ts', import.meta.url), 'utf8');
    expect(server).toContain(SOURCE_CHANGED_REFUSAL);
    // The read exemption is what makes the hydrate below possible at all: the
    // page reaches the new source through a heartbeat it is too stale to send.
    expect(server).toContain("const staleRead=(name==='poll_inspection'||name==='get_inspection')");
  });
});

/**
 * A grow that has to wait, and the command that was waiting
 * for it.
 *
 * `readyPanel` refuses a grow while any command is pending, and the page's own
 * wait beat (`refreshGrowBinding`) polls as `ready`, which is exactly the beat
 * the Mac hands a queued command to. Chaining that delivery onto `rendering`
 * put it behind the grow operation, which is itself the tail of `rendering`:
 * the grow then waited out its whole budget for a receipt that could not be
 * sent until the grow finished.
 */
describe('a grow waiting on a busy panel', () => {
  function stand() {
    let clock = 1_000_000;
    const commands = new InspectionCommands(() => clock);
    const binding = { serverEpoch: randomUUID(), sourceToken: randomUUID(), stateRevision: 4, inspectionRevision: 2 };
    const expected = { serverEpoch: binding.serverEpoch, sourceToken: binding.sourceToken,
      baseStateRevision: binding.stateRevision, baseInspectionRevision: binding.inspectionRevision };
    const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
    // The panel is mid-chapter, so the command the agent sent is admitted and
    // held rather than delivered.
    commands.poll({ ...expected, panelId, availability: 'busy' }, binding);
    commands.enqueue({ ...expected, panelId, commandId: randomUUID(),
      change: { kind: 'selection', patch: { selectionKeys: [] } } } as any, binding, { selectionKeys: [] } as any);
    return { commands, binding, expected, panelId, advance: (ms: number) => { clock += ms; } };
  }

  /** `receive` in `inspector.ts`, reduced to the fact the grow depends on. */
  function receipt(t: ReturnType<typeof stand>, delivery: any) {
    t.commands.complete({ ...t.expected, panelId: t.panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, failure: 'local_changed' }, t.binding);
  }

  it('deadlocks when the claimed delivery is queued behind the grow', async () => {
    const t = stand();
    let rendering: Promise<unknown> = Promise.resolve();
    let received = false, tries = 0;
    const operation = rendering.then(() => retryWhileNotYet(async () => {
      tries++;
      if (!t.commands.readyPanel(t.panelId, t.binding)) throw Object.assign(Error(PANEL_BUSY_MESSAGE), { status: 409 });
      return 'grown';
    }, { attempts: 6, wait: async () => t.advance(2_000), refresh: () => {
      const answer: any = t.commands.poll({ ...t.expected, panelId: t.panelId, availability: 'ready' }, t.binding);
      if (answer.delivery) rendering = rendering.then(() => { receipt(t, answer.delivery); received = true; });
    } }));
    rendering = operation.then(() => undefined, () => undefined);

    let refusal = '', receivedDuringGrow: boolean | undefined;
    try { await operation; } catch (error) { refusal = (error as Error).message; receivedDuringGrow = received; }

    expect(refusal).toBe('Still busy. Try again.');
    expect(tries).toBe(6);
    expect(receivedDuringGrow).toBe(false);
    await rendering;
    expect(received).toBe(true); // Only after the grow had already failed.
  });

  it('admits the grow once the waiting beat runs the delivery it claimed', async () => {
    const t = stand();
    let received = false, tries = 0;
    const grown = await retryWhileNotYet(async () => {
      tries++;
      if (!t.commands.readyPanel(t.panelId, t.binding)) throw Object.assign(Error(PANEL_BUSY_MESSAGE), { status: 409 });
      return 'grown';
    }, { attempts: 6, wait: async () => t.advance(2_000), refresh: async () => {
      const answer: any = t.commands.poll({ ...t.expected, panelId: t.panelId, availability: 'ready' }, t.binding);
      if (answer.delivery) { receipt(t, answer.delivery); received = true; }
    } });

    expect(grown).toBe('grown');
    expect(received).toBe(true);
    expect(tries).toBe(2);
  });

  it('awaits the delivery in the wait beat instead of chaining it onto `rendering`', () => {
    const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const beat = source.slice(source.indexOf('async function refreshGrowBinding()'), source.indexOf('async function growStructure('));
    expect(beat).toContain('if(delivery) await receive(delivery,sent,ownGeneration)');
    expect(beat).not.toContain('rendering=rendering.then(()=>receive(');
  });
});
