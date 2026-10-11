import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { confirmFailureRecovery, panelAvailability, saveFailureRecovery, staleHudWaiting, CONFIRM_RETRY_ATTEMPTS, CONFIRM_RETRY_DELAY_MS, HUD_WAIT_EXPIRY_MS,
  SAVE_BUSY_RETRY_MS, SAVE_BUSY_SLOW_RETRY_MS, SAVE_RELOAD_INTERVAL_MS } from '../src/inspection-panel-recovery.js';

/**
 * A Quest 2 panel could answer `unsaved` for minutes at a time.
 * `control_tour play` was rejected with `render_failed`, the panel set
 * `blocked`, and the only way out was the flat page's Load saved view button.
 * These cases pin the decisions that keep a headset panel reachable.
 */
describe('headset panel recovery', () => {
  it('reports unsaved only for work the panel still holds', () => {
    const base = { blocked: false, dirty: false, ready: true, interactionActive: false, navigating: false };
    expect(panelAvailability(base)).toBe('ready');
    expect(panelAvailability({ ...base, dirty: true })).toBe('unsaved');
    expect(panelAvailability({ ...base, blocked: true })).toBe('unsaved');
    // A held grip or a rendering tour scene is transient, not unsaved work:
    // the command queue may wait for it, and `enqueue` refuses only `unsaved`.
    expect(panelAvailability({ ...base, interactionActive: true })).toBe('busy');
    expect(panelAvailability({ ...base, navigating: true })).toBe('busy');
    expect(panelAvailability({ ...base, ready: false })).toBe('busy');
  });

  /**
   * While a lesson autoplays on a Quest 2, each chapter turns the camera and
   * every agent command was answered "No panel is ready for a command right
   * now (companion unsaved)". On the wall lesson the saved revision climbs
   * 1 -> 25 in 80 s with no edit of any kind, and a placement command queued
   * mid-chapter came back `conflict`.
   */
  it('queues rather than refuses while a lesson presents itself', () => {
    const base = { blocked: false, dirty: true, ready: true, interactionActive: false, navigating: false };
    // The one save per chapter that commits the turn is the lesson pushing its
    // own presentation, so the command waits for it instead of being refused.
    expect(panelAvailability({ ...base, presenting: true })).toBe('busy');
    // A paused lesson, or no lesson at all, is real unsaved work again.
    expect(panelAvailability({ ...base, presenting: false })).toBe('unsaved');
    expect(panelAvailability(base)).toBe('unsaved');
    // `blocked` is a panel that gave up on its save. It stays unsaved however
    // the lesson is doing, because nothing will push that work on its own.
    expect(panelAvailability({ ...base, blocked: true, presenting: true })).toBe('unsaved');
    // And presenting never promotes a panel past the transient reasons.
    expect(panelAvailability({ ...base, dirty: false, presenting: true })).toBe('ready');
    expect(panelAvailability({ ...base, dirty: false, presenting: true, interactionActive: true })).toBe('busy');
  });

  it('retries a busy save until the server-side rendering deadline', () => {
    const input = { kind: 'busy', companion: true, attempt: 1, msSinceReload: 0 } as const;
    expect(saveFailureRecovery(input)).toEqual({ action: 'retry', delayMs: SAVE_BUSY_RETRY_MS });
    expect(saveFailureRecovery({ ...input, attempt: 239 })).toEqual({ action: 'retry', delayMs: SAVE_BUSY_RETRY_MS });
    // Past the deadline a desktop panel blocks and shows Retry save.
    expect(saveFailureRecovery({ ...input, attempt: 240, companion: false })).toEqual({ action: 'block' });
  });

  it('never stops asking on a headset panel, however long the save stays busy', () => {
    // The wedge this whole module exists to close, reached by the busy door: a
    // blocked panel answers `unsaved` and refuses every agent command, and a
    // wearer has no Retry save button to press. It drops to a slower cadence
    // instead and keeps asking for as long as the session lasts.
    const input = { kind: 'busy', companion: true, attempt: 240, msSinceReload: 0 } as const;
    expect(saveFailureRecovery(input)).toEqual({ action: 'retry', delayMs: SAVE_BUSY_SLOW_RETRY_MS });
    expect(saveFailureRecovery({ ...input, attempt: 100_000 })).toEqual({ action: 'retry', delayMs: SAVE_BUSY_SLOW_RETRY_MS });
    expect(SAVE_BUSY_SLOW_RETRY_MS).toBeGreaterThan(SAVE_BUSY_RETRY_MS);
  });

  it('reloads a conflicted headset panel instead of waiting for a button', () => {
    const input = { kind: 'conflict', companion: true, attempt: 1, msSinceReload: SAVE_RELOAD_INTERVAL_MS } as const;
    expect(saveFailureRecovery(input)).toEqual({ action: 'reload' });
    // One reload per interval: in between, the panel re-asks rather than
    // blocking, so the rate limit cannot become a wedge of its own.
    expect(saveFailureRecovery({ ...input, msSinceReload: SAVE_RELOAD_INTERVAL_MS - 1 }))
      .toEqual({ action: 'retry', delayMs: SAVE_BUSY_SLOW_RETRY_MS });
    // A desktop panel keeps its Load saved view button.
    expect(saveFailureRecovery({ ...input, companion: false })).toEqual({ action: 'block' });
  });

  it('retries a failed headset save with backoff, then holds that cadence', () => {
    const input = { kind: 'error', companion: true, attempt: 1, msSinceReload: 0 } as const;
    expect(saveFailureRecovery(input)).toEqual({ action: 'retry', delayMs: 1000 });
    expect(saveFailureRecovery({ ...input, attempt: 2 })).toEqual({ action: 'retry', delayMs: 2000 });
    expect(saveFailureRecovery({ ...input, attempt: 4 })).toEqual({ action: 'retry', delayMs: 8000 });
    // The backoff stops doubling where a desktop panel would have blocked.
    expect(saveFailureRecovery({ ...input, attempt: 5 })).toEqual({ action: 'retry', delayMs: 8000 });
    expect(saveFailureRecovery({ ...input, companion: false })).toEqual({ action: 'block' });
  });

  it('has no path at all that blocks a headset panel', () => {
    // The invariant, stated once over every branch: a companion is a panel
    // inside an immersive session, and every button that clears `blocked` is on
    // a flat page the wearer cannot see.
    for (const kind of ['busy', 'conflict', 'error'] as const)
      for (const attempt of [1, 2, 4, 5, 239, 240, 1000])
        for (const msSinceReload of [0, SAVE_RELOAD_INTERVAL_MS - 1, SAVE_RELOAD_INTERVAL_MS, 60_000])
          expect(saveFailureRecovery({ kind, companion: true, attempt, msSinceReload }).action).not.toBe('block');
  });

  it('drops an unconfirmable command rather than wedging the headset on it', () => {
    // `complete_inspection` can fail on its own: the companion socket drops or
    // the desktop sleeps between the draw and the receipt. Blocking there is
    // the same eight-minute wedge by the other door.
    expect(confirmFailureRecovery({ companion: true, attempt: 1 }))
      .toEqual({ action: 'retry', delayMs: CONFIRM_RETRY_DELAY_MS });
    expect(confirmFailureRecovery({ companion: true, attempt: 2 }))
      .toEqual({ action: 'retry', delayMs: CONFIRM_RETRY_DELAY_MS * 2 });
    // Then it is given up on. One lost command is recoverable; a panel that
    // answers `unsaved` for the rest of the session is not.
    expect(confirmFailureRecovery({ companion: true, attempt: CONFIRM_RETRY_ATTEMPTS })).toEqual({ action: 'drop' });
    expect(confirmFailureRecovery({ companion: true, attempt: 99 })).toEqual({ action: 'drop' });
    // A desktop panel has Retry confirmation on screen and keeps it.
    expect(confirmFailureRecovery({ companion: false, attempt: 1 })).toEqual({ action: 'block' });
  });

  it('leaves the panel usable after the companion rejects a command', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const confirm = source.slice(source.indexOf('if(receipt.failure)'), source.indexOf('async function recoverConfirmation('));
    // A rejected command drew nothing and saved nothing, so no failure code may
    // reach showProblem: that sets blocked, and blocked answers `unsaved`.
    expect(confirm).not.toMatch(/showProblem/u);
    expect(confirm).toMatch(/blocked=false/u);
    // The reason the companion refused travels with the receipt.
    expect(source).toMatch(/const refusal=inspectionFailureReceipt\(error\)/u);
    expect(source).toMatch(/confirmReceipt\(\{\.\.\.base,\.\.\.refusal\}/u);
    expect(source).toMatch(/saveFailureRecovery\(/u);
    // An automatic reload is the button's work, so no new edit may be scheduled
    // against the revision it is replacing.
    expect(source).toMatch(/function scheduleSave\(\)\s*\{[^}]*reloading/u);
    expect(source).toMatch(/panelAvailability\(/u);
  });

  it('routes every failed confirmation through the retry decision', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    // `beatSuspended` and `busyBeat` now sit between `receive`
    // and `poll`, and the beat has a notice of its own. Read only `receive`.
    const receive = source.slice(source.indexOf('async function receive('), source.indexOf('function beatSuspended('));
    // Both arms of `receive`'s catch reached `showProblem` before, and a headset
    // panel has no button to clear what that sets.
    expect(receive).not.toMatch(/showProblem/u);
    // The active workspace transaction also retries a lost replacement receipt.
    expect(receive.match(/recoverConfirmation\(/gu)).toHaveLength(4);
    expect(receive).toContain('Cancellation settled locally; reconnect before continuing.');
    // The retry re-sends the receipt the panel is still holding, and drops it
    // without blocking once the decision says to.
    const recover = source.slice(source.indexOf('async function recoverConfirmation('), source.indexOf('async function receive('));
    expect(recover).toMatch(/confirmFailureRecovery\(\{companion:isCompanion/u);
    expect(recover).toMatch(/await confirmReceipt\(receipt,fields\)/u);
    expect(recover).toMatch(/pendingReceipt=undefined/u);
    expect(recover).toMatch(/blocked=false/u);
    // The wearer is told, on the readout `showOutcome` drives in the headset.
    expect(recover).toMatch(/showOutcome\(\{status:'failed'/u);
    // And only a desktop panel is left with the notice.
    expect(recover).toMatch(/recovery\.action==='block'.*showProblem/u);
  });
});

/**
 * On a Quest 2 the wearer's status plate could read an orange `Waiting ·
 * change` through a six-scene tour, a spin, a stop and two render-quality
 * commands, every one of which the host receipted `rendered`. The page had
 * drawn `Applied · …` each time; the voice
 * interaction's own state change then painted a hard-coded `waiting` back over
 * it about a second later, and the plate's copy could find no field name in a
 * voice sentence, so it read `change`.
 */
describe('the in-headset status plate', () => {
  it('keeps voice state off the inspection plate', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('voiceInteraction=createVoiceInteraction('),
      source.indexOf('setVoiceCommandSender('));
    expect(handler).toMatch(/updateVoiceUi\(\);/u);
    // The plate is the agent's channel. The Talk row, the grip binding and the
    // caption sink are where voice state is written for the wearer.
    expect(handler).not.toMatch(/xr\?\.outcome/u);
  });

  it('retires a Waiting the panel is no longer holding a command for', () => {
    const base = { waitingSince: 1_000, now: 1_000 + HUD_WAIT_EXPIRY_MS, pendingReceipt: false };
    expect(staleHudWaiting(base)).toBe(true);
    // Nothing is showing.
    expect(staleHudWaiting({ ...base, waitingSince: 0 })).toBe(false);
    // Not yet old enough: an ordinary command draws in well under a second.
    expect(staleHudWaiting({ ...base, now: 1_000 + HUD_WAIT_EXPIRY_MS - 1 })).toBe(false);
    // The panel is still trying to confirm the command the plate names.
    expect(staleHudWaiting({ ...base, pendingReceipt: true })).toBe(false);
    // The server still holds it, so the wearer is right to be waiting.
    for (const latestStatus of ['queued', 'rendering']) {
      expect(staleHudWaiting({ ...base, latestStatus })).toBe(false);
    }
    // A terminal receipt with a plate still on Waiting is exactly the stale case.
    for (const latestStatus of ['rendered', 'rejected', 'expired', 'unconfirmed']) {
      expect(staleHudWaiting({ ...base, latestStatus })).toBe(true);
    }
  });

  it('clears the plate and re-arms the signature on every heartbeat', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const retire = source.slice(source.indexOf('function retireStaleHud('), source.indexOf('const notice='));
    expect(retire).toMatch(/staleHudWaiting\(\{waitingSince:hudWaitingSince/u);
    // An empty sentence is the immersive session's clear, not an outcome.
    expect(retire).toMatch(/xr\.outcome\(''/u);
    // Otherwise a repeat of the retired outcome would be deduplicated away.
    expect(retire).toMatch(/hudSignature=''/u);
    expect(source).toMatch(/showOutcome\(data\?\.outcome\);\s*\n\s*retireStaleHud\(data\?\.outcome\);/u);
  });

  /**
   * The one path that could never retire a plate was the one
   * that most needed to. A poll that fails returns early, so a `Waiting` left
   * up by a command whose connection then dropped had nothing behind it to
   * overdraw it, and the wearer -- who cannot see the flat page's
   * `Reconnecting…` notice -- was left reading orange indefinitely.
   */
  it('retires a stale plate when the connection dropped, not only when a poll answered', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const failure = source.slice(source.indexOf('try { response=await call(\'poll_inspection\''),
      source.indexOf('// A poll sent before an explicit source transition'));
    expect(failure).toMatch(/showConnectionProblem\(error,ownGeneration\)/u);
    expect(failure).toMatch(/retireStaleHud\(undefined\);/u);
    // Out of contact, nothing is known to be pending, so the ten-second rule
    // is the whole decision.
    expect(staleHudWaiting({ waitingSince: 1_000, now: 1_000 + HUD_WAIT_EXPIRY_MS,
      pendingReceipt: false, latestStatus: undefined })).toBe(true);
  });
});

/**
 * A stuck scene must not take the heartbeat with it.
 *
 * Chapter 2 of the CRISPR lesson once never finished rendering on a
 * Quest 2. The page kept drawing at 72 fps, but it stopped talking to the Mac
 * entirely for seven minutes: `poll` awaited the command it had just delivered
 * and armed the next beat only in its own `finally`, so one command that never
 * returned ended the heartbeat for good. Twelve seconds later the host's panel
 * snapshot went stale and the host listed no companion panel at all, and the
 * page's diagnostics piled up unsent — which is why the hang left no log.
 *
 * The rule this pins: the beat outlives the command, and while one renders the
 * panel keeps saying `busy` rather than saying nothing.
 */
describe('the heartbeat and the scene it delivered', () => {
  const inspector = () => readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');

  it('starts a delivered command without waiting for it', async () => {
    const source = await inspector();
    const delivery = source.slice(source.indexOf('const delivery=privateState?.delivery;'),
      source.indexOf('} catch(error) {', source.indexOf('const delivery=privateState?.delivery;')));
    expect(delivery).toMatch(/rendering=rendering\.then\(\(\)=>receive\(delivery,sent,ownGeneration\)\)/u);
    // The await is the bug. A command that never returns must not be able to
    // stop the timer this function arms in its `finally`.
    expect(delivery).not.toMatch(/await rendering/u);
    // Unawaited is not unhandled: the command still reports its own failure.
    expect(delivery).toMatch(/\.catch\(/u);
  });

  it('keeps beating while a command owns the renderer, and says busy', async () => {
    const source = await inspector();
    const busy = source.slice(source.indexOf('async function busyBeat('), source.indexOf('function problemMessage('));
    expect(busy).toMatch(/call\('poll_inspection'/u);
    // The word is chosen rather than hard-coded now, because
    // the same beat also runs while nothing owns the renderer. A command, a
    // hydration or an unready workspace still forces `busy`.
    expect(busy).toMatch(/const busy=forceBusy \|\| remote \|\| loading \|\| !workspace\.snapshot\(\)\.ready;/u);
    expect(busy).toMatch(/const availability=busy\?'busy' as const:liveAvailability\(\);/u);
    // The headset log is only uploaded on this beat, so the queue and its
    // acknowledgement must ride it too, or a hang stays unreadable afterwards.
    expect(busy).toMatch(/__stereofoldDiagnostics\?\.heartbeat\?\.\(\)/u);
    expect(busy).toMatch(/__stereofoldDiagnostics\?\.acknowledge\?\.\(privateState\.diagnosticsAck\)/u);
    // `poll` routes into it rather than returning silently on `remote`, and a
    // hydration takes the same road: `loading` used to return sending nothing.
    const guard = source.slice(source.indexOf('async function poll('), source.indexOf('const pollGeneration=generation;'));
    expect(guard).toMatch(/if\(remote \|\| loading\) \{ await busyBeat\(generation,true\); return; \}/u);
    expect(guard).not.toMatch(/closed \|\| !binding \|\| loading \|\| remote \|\|/u);
  });

  it('takes no scene, save or attach decision from a beat sent mid-command', async () => {
    const source = await inspector();
    const busy = source.slice(source.indexOf('async function busyBeat('), source.indexOf('function problemMessage('));
    for (const forbidden of ['hydrate(', 'await attach(', 'scheduleSave(']) {
      expect(busy).not.toContain(forbidden);
    }
    // This beat may now start a command, because it is the
    // only beat a wearer gets while the slow half of `poll` is waiting. It may
    // do so only when it told the host the panel was `ready`, and a beat sent
    // mid-command or mid-hydration never says that — `busy` above forces the
    // word. It is still started rather than awaited.
    expect(busy).toMatch(/const delivery=availability==='ready'\?privateState\?\.delivery:undefined;/u);
    expect(busy).toMatch(/rendering=rendering\.then\(\(\)=>receive\(delivery,sent,ownGeneration\)\)/u);
    expect(busy).not.toMatch(/await receive\(/u);
  });

  it('still reports a panel mid-render as busy rather than ready', () => {
    expect(panelAvailability({ blocked:false, dirty:false, ready:true, interactionActive:false, navigating:true })).toBe('busy');
  });
});
