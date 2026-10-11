/**
 * The local voice loop: a transcript the Mac returned has to move the molecule.
 *
 * Everything here runs against the real modules. The only doubles are the
 * emitter the streamer publishes onto and the dispatcher the companion page
 * supplies, which is exactly the seam `immersive-session.mjs` wires.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
// @ts-ignore Shared JavaScript voice command runner, the same one the companion bundles.
import { attachVoiceCommandRunner, spatialVoiceAction, SPATIAL_VOICE_ACTIONS, UNRECOGNIZED_REPLY, AGENT_FORWARD_CAPTION, AGENT_FORWARD_REPLY } from '../../lab/browser-roundtrip/voice-command-runner.mjs';
// @ts-ignore Shared JavaScript headset microphone streamer.
import { createPushToTalkAudioEvents } from '../../lab/browser-roundtrip/push-to-talk-audio.mjs';

type Action = { kind: string; [key: string]: unknown };

function harness({ fail = false, reason = 'Load a molecular scene first.', spinning, agentAttached, outcome, speakError, getGeometryBudget }:
  { fail?: boolean; reason?: string; spinning?: () => boolean; agentAttached?: () => boolean;
    /** What the Mac's narration route rejects with, when it refuses to speak. */
    speakError?: Error;
    // What the companion's action runner hands back. Only the render budget has
    // an answer beyond "it happened", and the confirmation is written from it.
    outcome?: unknown; getGeometryBudget?:()=>unknown } = {}) {
  const events = createPushToTalkAudioEvents();
  const actions: Action[] = [], captions: string[] = [], spoken: string[] = [];
  const records: { kind: string; detail: any }[] = [];
  const runner = attachVoiceCommandRunner({
    events, getGeometryBudget,
    dispatch: async (action: Action) => { actions.push(action); if (fail) throw Error(reason); return outcome; },
    caption: (text: string) => { captions.push(text); },
    speak: async (text: string) => { spoken.push(text); if (speakError) throw speakError; },
    record: (kind: string, detail: unknown) => { records.push({ kind, detail }); },
    ...(spinning ? { spinning } : {}),
    ...(agentAttached ? { agentAttached } : {}),
  });
  let utterance = 0;
  const say = async (text: string) => {
    events.emit({ state: 'heard', utteranceId: `u${++utterance}`, text, message: `Heard: ${text}` });
    await runner.settled();
  };
  return { events, runner, actions, captions, spoken, records, say };
}

describe('spatialVoiceAction', () => {
  it('maps the core spoken phrases onto toolbar actions', () => {
    expect(spatialVoiceAction('Start tour.')).toMatchObject({ action: { kind: 'tour-play', playing: true } });
    expect(spatialVoiceAction('Pause tour.')).toMatchObject({ action: { kind: 'tour-play', playing: false } });
    expect(spatialVoiceAction('Next')).toMatchObject({ action: { kind: 'tour-next' } });
    expect(spatialVoiceAction('back')).toMatchObject({ action: { kind: 'tour-back' } });
    expect(spatialVoiceAction('make it bigger')).toMatchObject({ action: { kind: 'scale', direction: 1 } });
    expect(spatialVoiceAction('make it smaller')).toMatchObject({ action: { kind: 'scale', direction: -1 } });
    // Recentring writes a placement now. `fit` reset a camera the headset does
    // not look through, so it confirmed a move that never happened in VR.
    expect(spatialVoiceAction('recenter')).toMatchObject({ action: { kind: 'recenter-structure' } });
  });

  // Three levels, each carried explicitly so repeating a phrase cannot cycle
  // past what the wearer asked for, and each answered in the same two words the
  // menu row and the agent's command speak.
  it.each([
    // "Max quality." is the word the menu row's own label uses.
    ['better quality', 'best', 'Max quality.'],
    ['best quality', 'best', 'Max quality.'],
    ['make it look better', 'best', 'Max quality.'],
    ['balanced quality', 'balanced', 'Balanced.'],
    ['normal quality', 'balanced', 'Balanced.'],
    ['smoother', 'fast', 'Fast.'],
    ['faster', 'fast', 'Fast.'],
  ])('“%s” sets the %s render budget', (phrase, level, say) => {
    expect(spatialVoiceAction(phrase)).toMatchObject({ action: { kind: 'render-quality', level }, say });
    // Said twice, it is still the same level: no spoken phrase cycles.
    expect(spatialVoiceAction(phrase)).toMatchObject({ action: { kind: 'render-quality', level } });
  });

  // Three routes reach one setting: a spoken phrase, the menu row, and the
  // agent's render-quality command. They have to answer in the same words, or
  // the wearer hears the setting change differently depending on how they
  // asked for it. The inspector's table is the one that can drift.
  it('answers an agent render-quality command in the same two words the wearer’s own phrase gets', async () => {
    const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    for (const [command, level] of [['quality-best', 'best'], ['quality-balanced', 'balanced'], ['quality-fast', 'fast']] as const) {
      const say = (SPATIAL_VOICE_ACTIONS as any)[command].say as string;
      expect(source).toContain(`${level}:'${say}'`);
    }
    // The pending-scale half is the one shared function, not a second copy of
    // the rule that could answer differently.
    expect(source).toContain('renderQualityConfirmation(change.patch?.level,REMOTE_QUALITY_CONFIRMATIONS[');
    // And the same answer reaches the agent, not only the wearer's ears.
    expect(source).toContain("activeDelivery.change.kind==='render-quality' && applied?.scaleAppliesOnNextEntry===true");
    expect(source).toContain('pendingScale?{scaleAppliesOnNextEntry:true}:{}');
  });

  /**
   * The framebuffer half of "max quality" lands on the next immersive entry,
   * because an XRWebGLLayer's scale is fixed when the layer is
   * built. A confirmation that does not say so promises a sharper picture the
   * wearer is looking straight at and cannot see.
   */
  it.each([
    [{ level: 'best', applied: { scaleAppliesOnNextEntry: true } }, 'Max quality. Sharper after re-entry.'],
    [{ level: 'best', applied: { scaleAppliesOnNextEntry: false } }, 'Max quality.'],
    [{ level: 'best', applied: {} }, 'Max quality.'],
    [{ level: 'best' }, 'Max quality.'],
    [undefined, 'Max quality.'],
  ])('says what the renderer actually did, not what was asked for (%j)', async (outcome, expected) => {
    const { say, spoken, captions } = harness({ outcome });
    await say('best quality');
    expect(spoken).toEqual([expected]);
    // The caption is written twice: once before the render, once after. Only
    // the second one can know, so only the second one carries the extra words.
    expect(captions).toEqual(['Max quality.', expected]);
  });

  /**
   * Going down is the same pending change in the other direction: only `best`
   * raises the framebuffer tier, so a level coming off it gets the frame rate
   * back on re-entry, not the sharpness. Promising "sharper" there would be the
   * original lie with the sign flipped.
   */
  it.each([['balanced quality', 'Balanced. Smoother after re-entry.'], ['smoother', 'Fast. Smoother after re-entry.']])
    ('tells a wearer coming down from max what is still pending (“%s”)', async (phrase, expected) => {
      const { say, spoken } = harness({ outcome: { applied: { scaleAppliesOnNextEntry: true } } });
      await say(phrase);
      expect(spoken).toEqual([expected]);
    });

  /**
   * The fourth route: the Mac panel's own Render quality select. It has a
   * status line rather than a voice, and it is read by someone who is not
   * wearing the headset, so it names where the pending half lands.
   */
  it('writes the Mac panel’s status line from the render’s answer', async () => {
    const source = await readFile(new URL('../../lab/inspection/workspace.mjs', import.meta.url), 'utf8');
    expect(source).toContain('Sharper on the next headset entry.');
    expect(source).toContain("result?.applied?.scaleAppliesOnNextEntry === true");
    // The line is written from the result, not from the select's own value.
    expect(source).toContain('ui(result => renderQualityStatus(control.value, result)');
    // And the agent's own command hands its renderer answer to the receipt.
    expect(source).toContain('await confirm(scene, applied);');
  });

  it('keeps the re-entry line off every command that cannot leave one pending', async () => {
    for (const [phrase, expected] of [['balanced quality', 'Balanced.'], ['smoother', 'Fast.'], ['best quality', 'Max quality.']] as const) {
      const { say, spoken } = harness({ outcome: { applied: { scaleAppliesOnNextEntry: false } } });
      await say(phrase);
      expect(spoken).toEqual([expected]);
    }
    // A non-quality command never reads the field, whatever its dispatcher
    // returns: only the render budget can leave half of itself pending.
    const { say, spoken } = harness({ outcome: { applied: { scaleAppliesOnNextEntry: true } } });
    await say('make it bigger');
    expect(spoken).toEqual(['Bigger.']);
  });

  /**
   * The eleven command families, in the words a wearer speaks them. Each row
   * asserts the action kind that reaches `onSpatialAction`; the viewer side of
   * each kind is asserted where it lives.
   */
  it.each([
    // 1. "recenter": the one that spoke a false confirmation.
    ['recenter', 'recenter-structure'], ['bring it back', 'recenter-structure'],
    ['put it in front of me', 'recenter-structure'], ['Where did it go?', 'recenter-structure'],
    // 2. the tour. "start the tour" was unrecognized for one missing article.
    ['start the tour', 'tour-play'], ['play the tour', 'tour-play'], ['start tour', 'tour-play'],
    ['next step', 'tour-next'], ['next', 'tour-next'], ['previous step', 'tour-back'], ['back', 'tour-back'],
    ['stop the tour', 'tour-play'], ['pause', 'tour-play'],
    // 3. the Mol* row, which had a host route behind it and no spoken way in.
    ['open in Mol*', 'open-workbench'], ['open Mol*', 'open-workbench'], ['switch to Mol*', 'open-workbench'],
    // 4. turning it to see the far side.
    ['turn it around', 'turn'], ['turn it left', 'turn'], ['turn it right', 'turn'], ['spin it', 'toggle-motion'],
    // 5. the reply the wearer missed.
    ['say that again', 'repeat-reply'], ['repeat that', 'repeat-reply'],
    // 6. scale, including the short form.
    ['zoom in', 'scale'], ['make it bigger', 'scale'], ['zoom out', 'scale'], ['bigger', 'scale'], ['smaller', 'scale'],
    // 7. moving the structure through space.
    ['move it up', 'move'], ['move it down', 'move'], ['move it left', 'move'], ['move it right', 'move'],
    ['move it closer', 'move'], ['move it away', 'move'], ['move it up a lot', 'move'],
    // 8. naming a chain or a residue range out loud.
    ['show me chain B', 'focus-selection'], ['focus on chain B', 'focus-selection'],
    ['focus on residue 840 to 860', 'focus-selection'], ['focus on residues 840 to 860 on chain A', 'focus-selection'],
    // 9. hiding part of the structure.
    ['hide the water', 'visibility'], ['show the water', 'visibility'],
    ['hide the ligands', 'visibility'], ['show the ligands', 'visibility'],
    // 11. this dispatched an action the viewer then threw on.
    ['move the menu', 'recenter-menu'],
  ])('resolves %j to a %s action', (phrase, kind) => {
    expect(spatialVoiceAction(phrase)?.action).toMatchObject({ kind });
  });

  it('carries the value a spoken command names', () => {
    expect(spatialVoiceAction('turn it around')).toMatchObject({ action: { kind: 'turn', degrees: 180 } });
    expect(spatialVoiceAction('turn it left')).toMatchObject({ action: { kind: 'turn', degrees: 90 } });
    expect(spatialVoiceAction('turn it right')).toMatchObject({ action: { kind: 'turn', degrees: -90 } });
    expect(spatialVoiceAction('move it up')).toMatchObject({ action: { kind: 'move', direction: 'up', metres: 0.3 } });
    // "a lot" is what a wearer says when one step went the right way and not
    // far enough; "a bit" is the other half of the same correction.
    expect(spatialVoiceAction('move it away a lot')).toMatchObject({ action: { direction: 'away', metres: 0.6 } });
    expect(spatialVoiceAction('move it closer a bit')).toMatchObject({ action: { direction: 'closer', metres: 0.15 } });
    expect(spatialVoiceAction('show me chain B')).toMatchObject({ action: { chain: 'B', framing: 'fill' } });
    expect(spatialVoiceAction('focus on residues 840 to 860 on chain A')).toMatchObject({ action: { chain: 'A', residues: [840, 860] } });
    expect(spatialVoiceAction('focus on residue 840')).toMatchObject({ action: { residues: [840, 840] } });
    expect(spatialVoiceAction('hide the water')).toMatchObject({ action: { group: 'water', visible: false } });
    expect(spatialVoiceAction('show the ligands')).toMatchObject({ action: { group: 'ligand', visible: true } });
  });

  it('keeps the parsed families closed', () => {
    // A parser must not turn an arbitrary sentence into a molecular edit.
    for (const phrase of ['move it sideways', 'turn it inside out', 'hide the protein',
      'show me chain', 'focus on residue', 'chain', 'delete chain B'])
      expect(spatialVoiceAction(phrase), phrase).toBeUndefined();
  });

  it('frames what is selected, and the whole thing, without a round trip to the Mac', () => {
    for (const phrase of ['focus on the selection', 'zoom to selection', 'Zoom to the selection.', 'focus the selection'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'focus-selection', framing: 'fill' } });
    for (const phrase of ['show the whole thing', 'Show me the whole thing, please.', 'show the whole structure'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'focus-selection', framing: 'context' } });
    // The framing words are not a general zoom: the bounded grammar keeps
    // "zoom in" and "zoom out" on the scale it already meant.
    expect(spatialVoiceAction('zoom in')).toMatchObject({ action: { kind: 'scale', direction: 1 } });
    expect(spatialVoiceAction('zoom to the pam')).toBeUndefined();
  });

  it('tolerates the filler a wearer actually speaks around a command', () => {
    expect(spatialVoiceAction('Ok, make it bigger please.')).toMatchObject({ action: { kind: 'scale', direction: 1 } });
    expect(spatialVoiceAction('Hey computer, next step.')).toMatchObject({ action: { kind: 'tour-next' } });
    expect(spatialVoiceAction('go back')).toMatchObject({ reply: true, say: 'Nothing to return from. You are already here.' });
    expect(spatialVoiceAction('go back one')).toMatchObject({ action: { kind: 'tour-back' } });
    // "Put it in front of me" is a natural phrasing for recentring, so
    // it seats the structure where entry did rather than nudging the placement.
    expect(spatialVoiceAction('put it in front of me')).toMatchObject({ action: { kind: 'recenter-structure' } });
    expect(spatialVoiceAction('bring it closer')).toMatchObject({ action: { kind: 'room-placement', target: 'front' } });
  });

  it('never resolves a qualifier away or invents a command', () => {
    // `don` is not filler, so the search stops before it can reach `bigger`.
    expect(spatialVoiceAction("don't make it bigger")).toBeUndefined();
    expect(spatialVoiceAction('you')).toBeUndefined();
    expect(spatialVoiceAction('delete every water molecule')).toBeUndefined();
    expect(spatialVoiceAction('x'.repeat(400))).toBeUndefined();
  });

  /**
   * Every phrase below is a real whisper-cli transcript from a 520-clip corpus
   * — 107 spoken phrases through five macOS voices, transcribed by the same
   * call the Mac makes — that the grammar used to refuse. Hit rate over the
   * corpus went from 75.2% to 92.9%.
   */
  it('answers the spoken shapes the transcribed corpus proved were missing', () => {
    for (const phrase of ['make it spin', 'make it rotate', 'get it spinning', 'have it turning', 'let it spin'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'toggle-motion', paused: false } });
    for (const phrase of ['freezes', 'hold on', 'stay there'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'toggle-motion', paused: true } });
    for (const phrase of ['take me on the tour', 'give me a tour', 'show me around'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'tour-play', playing: true } });
    for (const phrase of ['keep going', 'carry on'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'tour-next' } });
    expect(spatialVoiceAction('go back one')).toMatchObject({ action: { kind: 'tour-back' } });
    for (const phrase of ["where's the menu?", 'show me the menu', 'I can\'t find the menu'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'recenter-menu' } });
    for (const phrase of ['scale it up', 'a bit bigger'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'scale', direction: 1 } });
    expect(spatialVoiceAction('scale it down')).toMatchObject({ action: { kind: 'scale', direction: -1 } });
    // `trimFillers` drops the trailing "me", so both of these arrive shortened.
    for (const phrase of ['put it above me', 'move it overhead'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'room-placement', target: 'overhead' } });
    expect(spatialVoiceAction('move it to the left')).toMatchObject({ action: { kind: 'move', direction: 'left' } });
    expect(spatialVoiceAction('show me the other side')).toMatchObject({ action: { kind: 'turn', degrees: 180 } });
    // Whisper writes these three the same way on every voice that was tested.
    expect(spatialVoiceAction('open in Mol star')).toMatchObject({ action: { kind: 'open-workbench' } });
    expect(spatialVoiceAction('resenter')).toMatchObject({ action: { kind: 'recenter-structure' } });
    expect(spatialVoiceAction('zoom in on this election')).toMatchObject({ action: { kind: 'focus-selection', framing: 'fill' } });
  });

  it('keeps the new tolerance from reaching past a qualifier', () => {
    // The causative parser is anchored at both ends and the leading-filler
    // walk stops at the first word that means something, so none of these can
    // reach the motion verb behind them.
    for (const phrase of ["don't make it spin", 'do not spin it', 'stop making it spin', 'never spin it',
      'i dont want the menu', 'because the tour is long', "don't open it in Mol star",
      'we should not go to VR', 'the election was last year', 'he passes the ball', 'make it interesting'])
      expect(spatialVoiceAction(phrase), phrase).toBeUndefined();
  });

  it('leaves the commands that cost the wearer a session on exact phrases', () => {
    // Reset, VR mode, and the Mol* handoff each throw away where the wearer
    // is, so a homophone of one is refused even though the same leniency is
    // granted to pausing a tour. "Plane VR" is what whisper writes for "plain
    // VR" and it still does not match.
    for (const phrase of ['plane VR', 'flame VR', 'research', 'we sent it', 'open in mole store'])
      expect(spatialVoiceAction(phrase), phrase).toBeUndefined();
    expect(spatialVoiceAction('VR mode')).toMatchObject({ action: { kind: 'passthrough', on: false } });
    expect(spatialVoiceAction('reset the view')).toMatchObject({ action: { kind: 'reset' } });
  });

  it('reports a known command an immersive session cannot perform', () => {
    // Experience commands replace the coordinate source, which the page owns.
    const resolved = spatialVoiceAction('show cas9');
    expect(resolved).toMatchObject({ command: 'show-cas9' });
    expect(resolved?.action).toBeUndefined();
  });
});

describe('attachVoiceCommandRunner', () => {
  it('executes a heard transcript, captions it, and records the outcome', async () => {
    const { actions, captions, spoken, records, say } = harness();
    await say('make it bigger');
    expect(actions).toEqual([{ kind: 'scale', direction: 1 }]);
    expect(captions).toContain('Bigger.');
    expect(spoken).toEqual(['Bigger.']);
    expect(records).toEqual([{ kind: 'voice-command', detail: { phrase: 'make it bigger', action: 'scale', outcome: 'applied' } }]);
  });

  it('dispatches explicit play and pause targets so repeated speech is idempotent', async () => {
    const { actions, say } = harness();
    await say('pause tour');
    await say('start tour');
    expect(actions).toEqual([
      { kind: 'tour-play', playing: false },
      { kind: 'tour-play', playing: true },
    ]);
  });

  it('captions the command before the render is awaited', async () => {
    const events = createPushToTalkAudioEvents();
    const captions: string[] = [];
    let release: () => void = () => {};
    const runner = attachVoiceCommandRunner({ events, caption: (text: string) => { captions.push(text); },
      dispatch: () => new Promise<void>(resolve => { release = resolve; }), record: () => {} });
    events.emit({ state: 'heard', utteranceId: 'u1', text: 'next' });
    // The caption is already on the plate, synchronously, while the dispatcher
    // is still holding its promise open.
    expect(captions).toEqual(['Next step.']);
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await runner.settled();
  });

  it('runs one utterance once, even when the emitter repeats it', async () => {
    const { events, runner, actions } = harness();
    events.emit({ state: 'heard', utteranceId: 'u1', text: 'next' });
    events.emit({ state: 'heard', utteranceId: 'u1', text: 'next' });
    await runner.settled();
    expect(actions).toEqual([{ kind: 'tour-next' }]);
  });

  it('never replays the transcript the emitter was already holding', async () => {
    const events = createPushToTalkAudioEvents();
    events.emit({ state: 'heard', utteranceId: 'stale', text: 'make it bigger' });
    const actions: Action[] = [];
    const runner = attachVoiceCommandRunner({ events, dispatch: async (a: Action) => { actions.push(a); }, record: () => {} });
    await runner.settled();
    expect(actions).toEqual([]);
  });

  /**
   * The confirmation must not survive the failure, and the reason must be
   * spoken. "There is no chain B in this structure." is the answer to a
   * spoken question, and a wearer looking at the structure never sees the menu
   * line that used to carry it. The reason is said bare: a spoken sentence does
   * not need a prefix announcing that it is one.
   */
  it('speaks the reason a command failed instead of confirming it', async () => {
    const { actions, captions, spoken, records, say } = harness({ fail: true });
    await say('recenter');
    expect(actions).toEqual([{ kind: 'recenter-structure' }]);
    expect(spoken).toEqual(['Load a molecular scene first.']);
    expect(captions.at(-1)).toBe('Load a molecular scene first.');
    expect(spoken).not.toContain('Putting it back in front of you.');
    expect(records.at(-1)?.detail).toMatchObject({ action: 'recenter-structure', outcome: 'failed' });
  });

  /**
   * A refused spoken line is missing audio, not a failed command. The action
   * happened and its caption stands; the status says why the wearer heard
   * nothing, instead of the refusal vanishing or reading as a failure.
   */
  it('records why a confirmation could not be spoken and keeps the applied command', async () => {
    const { actions, captions, spoken, records, say } = harness({
      speakError: Object.assign(Error('request_failed'), { status: 409 }) });
    await say('recenter');
    expect(actions).toEqual([{ kind: 'recenter-structure' }]);
    expect(spoken).toEqual(['View reset.']);
    expect(captions.at(-1)).toBe('View reset.');
    expect(records.map(entry => entry.kind)).toContain('speech-failed');
    expect(records.find(entry => entry.kind === 'speech-failed')?.detail)
      .toMatchObject({ route: 'voice-confirmation', status: 409, reason: 'request_failed' });
    expect(records.find(entry => entry.kind === 'voice-command')?.detail).toMatchObject({ outcome: 'applied' });
  });

  /**
   * The page resolves a chain letter against the rows it has. When there is no
   * such chain, that refusal is the useful answer; the Mac transcribed the
   * sentence either way, so `listen_voice` can still hand it to the agent.
   */
  it('speaks a selection the page cannot resolve', async () => {
    const { actions, captions, spoken, say } = harness({ fail: true, reason: 'There is no chain Q in this structure.' });
    await say('show me chain Q');
    expect(actions).toEqual([{ kind: 'focus-selection', framing: 'fill', chain: 'Q' }]);
    expect(spoken.at(-1)).toBe('There is no chain Q in this structure.');
    expect(captions.at(-1)).toBe('There is no chain Q in this structure.');
  });

  /**
   * A grammar the headset knows but an immersive session cannot run is also an
   * answer the wearer has to hear.
   */
  it('speaks a command the headset cannot perform', async () => {
    const { captions, spoken, actions, say } = harness();
    await say('show cas9');
    expect(actions).toEqual([]);
    expect(spoken.at(-1)).toBe('Ask on the Mac.');
    expect(captions.at(-1)).toBe('Ask on the Mac.');
  });

  /**
   * A wearer with the menu behind them heard nothing at all when a sentence
   * missed the grammar. Saying it out loud is the difference between a system
   * that ignored you and one that did not understand you.
   *
   * It says three words, and none of them the wearer's: reading the sentence
   * back is annoying to hear. The phrase stays in the headset record, so what
   * was heard is still inspectable.
   */
  it('says unknown speech aloud without acting on it or reading it back', async () => {
    const { actions, captions, spoken, records, say } = harness();
    await say('delete every water molecule');
    expect(actions).toEqual([]);
    expect(captions).toEqual([UNRECOGNIZED_REPLY]);
    expect(spoken).toEqual([UNRECOGNIZED_REPLY]);
    expect(UNRECOGNIZED_REPLY).toBe('Not a command. Try show, tour, or smaller.');
    for (const line of [...captions, ...spoken]) {
      expect(line.toLowerCase()).not.toContain('water');
      expect(line.toLowerCase()).not.toContain('delete');
      expect(line.toLowerCase()).not.toContain('i heard');
    }
    expect(records.at(-1)?.detail).toMatchObject({ phrase: 'delete every water molecule', action: null, outcome: 'unrecognized' });
  });

  /**
   * Every recognized reply is a confirmation of what happened, not an echo. A
   * long sentence is also a wearer waiting to speak again, so they are capped.
   */
  it('confirms a recognized command in a few words', async () => {
    const { spoken, say } = harness();
    await say('make it bigger');
    expect(spoken.at(-1)).toBe('Bigger.');
    for (const entry of Object.values(SPATIAL_VOICE_ACTIONS) as any[]) {
      expect(entry.say.split(/\s+/).length).toBeLessThanOrEqual(3);
    }
  });

  it('bounds arbitrary dispatcher failures to twelve spoken words', async () => {
    const reason = 'The renderer could not complete this requested operation because the structure is no longer available to draw.';
    const { spoken, captions, say } = harness({ fail: true, reason });
    await say('make it smaller');
    expect(captions.at(-1)).toBe(reason);
    expect(spoken).toEqual(['Could not finish. Try again or ask on the Mac.']);
    expect(spoken[0].split(/\s+/).length).toBeLessThanOrEqual(12);
  });

  /**
   * The harness has no microphone, so this hook is how a caller says a
   * sentence to a running page. It must drive the real handler, not a copy of
   * the grammar, and it must not outlive the session.
   */
  it('speaks into a running page through the harness hook, and takes it away on dispose', async () => {
    const { runner, actions } = harness();
    const hook = (globalThis as any).__stereofoldVoice;
    expect(typeof hook?.say).toBe('function');
    expect(await hook.say('turn it around')).toBe('turn');
    expect(actions).toEqual([{ kind: 'turn', degrees: 180 }]);
    runner.dispose();
    expect((globalThis as any).__stereofoldVoice).toBeUndefined();
  });

  it('stops dispatching once the session disposes it', async () => {
    const { events, runner, actions } = harness();
    runner.dispose();
    events.emit({ state: 'heard', utteranceId: 'u9', text: 'next' });
    await runner.settled();
    expect(actions).toEqual([]);
  });

  it('needs a dispatcher and a stream', () => {
    expect(() => attachVoiceCommandRunner({})).toThrow(TypeError);
    expect(() => attachVoiceCommandRunner({ dispatch: async () => {}, events: {} as any })).toThrow(TypeError);
  });
});

/**
 * Two gaps found in the headset. Holding A and asking four different ways for
 * the structure to turn was answered with "Not a command" every time, and
 * nothing ever said that the agent on the Mac existed. Both are grammar and
 * wording rather than geometry, so both are asserted here against the real
 * modules.
 */
describe('turning the structure by voice', () => {
  it.each([
    // The four utterances that were refused, in the words they were spoken.
    'do a rotation', "let's have a rotate", 'rotate', 'spin it',
    // And the shapes around them a wearer reaches for next.
    'rotation', 'a rotation', 'spin', 'turn it', 'turning', 'keep turning', 'keep it spinning',
    'start spinning', 'start the rotation', 'let it spin', 'rotate the molecule', 'spin the structure',
    'Can you do a spin, please?',
  ])('starts the presentation turn for %j', phrase => {
    expect(spatialVoiceAction(phrase)?.action).toEqual({ kind: 'toggle-motion', paused: false });
  });

  it.each([
    'stop spinning', 'stop rotating', 'stop the rotation', 'hold it', 'hold still',
    'freeze', 'stop moving', "that's enough", 'stop turning',
  ])('ends it for %j', phrase => {
    expect(spatialVoiceAction(phrase)?.action).toEqual({ kind: 'toggle-motion', paused: true });
  });

  it('answers in the two-word style', () => {
    expect(spatialVoiceAction('spin')?.say).toBe('Spinning.');
    expect(spatialVoiceAction('stop spinning')?.say).toBe('Stopped.');
  });

  /**
   * "stop" is the one phrase in the grammar whose meaning depends on what is
   * moving. It has meant "pause the tour" since tours existed and must keep
   * meaning that; over a turning structure it means the turn, because that is
   * what the wearer is looking at.
   */
  it('reads a bare "stop" against what is actually moving', () => {
    expect(spatialVoiceAction('stop')?.action).toEqual({ kind: 'tour-play', playing: false });
    expect(spatialVoiceAction('stop', { spinning: true })?.action).toEqual({ kind: 'toggle-motion', paused: true });
    expect(spatialVoiceAction('stop it', { spinning: true })?.action).toEqual({ kind: 'toggle-motion', paused: true });
    // An explicit tour phrase still means the tour, spinning or not.
    expect(spatialVoiceAction('stop the tour', { spinning: true })?.action).toEqual({ kind: 'tour-play', playing: false });
  });

  it('follows the page rather than its own memory when the caller offers a reading', async () => {
    let spinning = false;
    const { actions, say } = harness({ spinning: () => spinning });
    await say('stop');
    spinning = true;
    await say('stop');
    expect(actions).toEqual([{ kind: 'tour-play', playing: false }, { kind: 'toggle-motion', paused: true }]);
  });

  /**
   * The wearer hears which of the two things stopped. A spin stopped with
   * "Tour paused." would be a confirmation for something they were not looking
   * at.
   */
  it('says which thing a bare "stop" stopped', async () => {
    let spinning = false;
    const { spoken, captions, say } = harness({ spinning: () => spinning });
    await say('stop');
    expect(spoken.at(-1)).toBe('Tour paused.');
    spinning = true;
    await say('stop');
    expect(spoken.at(-1)).toBe('Stopped.');
    expect(captions.at(-1)).toBe('Stopped.');
  });

  /**
   * Motion is in the shared fixed table as well as in the runner's own map, so
   * a phrase can arrive by either route. Both have to dispatch the same action
   * and speak the same two words.
   */
  it('dispatches a motion phrase that arrives through the shared grammar', async () => {
    const { actions, spoken, say } = harness();
    await say('do a rotation');
    await say('hold still');
    expect(actions).toEqual([{ kind: 'toggle-motion', paused: false }, { kind: 'toggle-motion', paused: true }]);
    expect(spoken).toEqual(['Spinning.', 'Stopped.']);
    expect(SPATIAL_VOICE_ACTIONS['motion-spin']).toMatchObject({ action: { kind: 'toggle-motion', paused: false }, say: 'Spinning.' });
    expect(SPATIAL_VOICE_ACTIONS['motion-stop']).toMatchObject({ action: { kind: 'toggle-motion', paused: true }, say: 'Stopped.' });
  });

  it('tracks its own spin when the caller offers no reading', async () => {
    const { actions, say } = harness();
    await say('spin it');
    await say('stop');
    expect(actions).toEqual([{ kind: 'toggle-motion', paused: false }, { kind: 'toggle-motion', paused: true }]);
  });

  it('keeps the one-shot turn a one-shot turn', () => {
    // `turn` on its own now starts the continuous spin, which must not swallow
    // the fixed yaw that names a direction.
    expect(spatialVoiceAction('turn it around')?.action).toMatchObject({ kind: 'turn', degrees: 180 });
    expect(spatialVoiceAction('turn it left')?.action).toMatchObject({ kind: 'turn', degrees: 90 });
    expect(spatialVoiceAction('spin it around')?.action).toMatchObject({ kind: 'turn', degrees: 180 });
  });

  it('does not let the new filler words strip a qualifier', () => {
    // `do`, `have` and the `s` of a split contraction are skippable, and none
    // of them may carry a negation past the search.
    for (const phrase of ['do not spin it', "don't spin it", 'do not make it bigger', 'have you seen the ligands'])
      expect(spatialVoiceAction(phrase), phrase).toBeUndefined();
  });
});


/**
 * The wearer has to be able to tell that Claude is there.
 *
 * Every sentence the wearer speaks is transcribed on the Mac and queued for
 * the agent whether or not this grammar has a command for it, so "Not a
 * command" described the page and not the system. With an agent attached the
 * headset now says where the sentence went; with nobody there it still says
 * the page could not act, which is the truth in that case.
 */
describe('telling the wearer the agent is there', () => {
  it('hands an unrecognized sentence to Claude when an agent is attached', async () => {
    const { actions, captions, spoken, records, say } = harness({ agentAttached: () => true });
    // A sentence the grammar is deliberately never going to map: it names no
    // bounded action.
    await say('do something with the molecule');
    expect(actions).toEqual([]);
    expect(captions).toEqual([AGENT_FORWARD_CAPTION]);
    expect(spoken).toEqual([AGENT_FORWARD_REPLY]);
    expect(records).toEqual([{ kind: 'voice-command',
      detail: { phrase: 'do something with the molecule', action: null, outcome: 'forwarded' } }]);
  });

  it('keeps the refusal wording when no agent is attached', async () => {
    const { captions, spoken, records, say } = harness({ agentAttached: () => false });
    await say('do something with the molecule');
    expect(captions).toEqual([UNRECOGNIZED_REPLY]);
    expect(spoken).toEqual([UNRECOGNIZED_REPLY]);
    expect(records[0].detail.outcome).toBe('unrecognized');
  });

  it('reports no agent when the page never wires a presence probe', async () => {
    // A page built before this existed, and every non-companion surface.
    const { captions, spoken, say } = harness();
    await say('do something with the molecule');
    expect(captions).toEqual([UNRECOGNIZED_REPLY]);
    expect(spoken).toEqual([UNRECOGNIZED_REPLY]);
  });

  it('falls back to the refusal wording when the presence probe throws', async () => {
    const { captions, spoken, say } = harness({ agentAttached: () => { throw Error('The heartbeat is gone.'); } });
    await say('do something with the molecule');
    expect(captions).toEqual([UNRECOGNIZED_REPLY]);
    expect(spoken).toEqual([UNRECOGNIZED_REPLY]);
  });

  it('leaves a recognized command alone whether or not an agent is listening', async () => {
    const { actions, spoken, say } = harness({ agentAttached: () => true });
    await say('make it bigger');
    expect(actions).toEqual([{ kind: 'scale', direction: 1 }]);
    expect(spoken).toEqual(['Bigger.']);
  });
});

describe('the spoken route into the full Mol* viewer', () => {
  // "open in mol star" used to answer "Opening on the Mac." while the toolbar's
  // own `Open in Mol*` row transferred the wearer to /detailed in the headset.
  // One name, two behaviours, and the one the wearer got was the one they could
  // not see. Mol* opens in the headset.
  it('sends the wearer where the toolbar row sends them, and says so', () => {
    for (const phrase of ['open in mol star', 'open in molstar', 'open mol star', 'open the workbench'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'open-workbench' },
        // The line names the way home too, because the
        // wearer hears it once and then the scene is gone.
        say: 'Opening the full viewer. Say return when done.' });
    for (const phrase of ['open in mol star', 'open in molstar'])
      expect(spatialVoiceAction(phrase)?.action).not.toHaveProperty('target');
  });

  it('keeps the Mac behind an explicit phrase', () => {
    for (const phrase of ['open it on the mac', 'open on the mac', 'show it on the mac', 'open mol star on the mac'])
      expect(spatialVoiceAction(phrase), phrase).toMatchObject({ action: { kind: 'open-workbench', target: 'mac' }, say: 'Opening on the Mac.' });
  });

  it('answers a spoken next that had to start the lesson as a start', async () => {
    const started = harness({ outcome: { started: true } });
    await started.say('next');
    expect(started.spoken).toEqual(['Tour started.']);
    const stepped = harness({ outcome: { started: false } });
    await stepped.say('next');
    expect(stepped.spoken).toEqual(['Next step.']);
  });

  it('says nothing over a transfer the page has already announced', async () => {
    const announced = harness({ outcome: { announced: true } });
    await announced.say('open in mol star');
    expect(announced.actions).toEqual([{ kind: 'open-workbench' }]);
    expect(announced.spoken).toEqual([]);
    const mac = harness({ outcome: { announced: false } });
    await mac.say('open on the mac');
    expect(mac.spoken).toEqual(['Opening on the Mac.']);
  });
});


it('does not record a rendered result until dispatch resolves',async()=>{
  const entries:any[]=[],spoken:any[]=[];
  vi.stubGlobal('__stereofoldDiagnostics',{record:(_kind:string,detail:any)=>entries.push(detail)});
  let finish!:()=>void;
  const events=createPushToTalkAudioEvents();
  const runner=attachVoiceCommandRunner({events,dispatch:()=>new Promise<void>(resolve=>{finish=resolve;}),
    speak:(_text:string,timing:any)=>spoken.push(timing)});
  try {
    events.emit({state:'heard',utteranceId:'u1',text:'make it bigger'});
    await Promise.resolve();
    expect(entries).toEqual([{stage:'action-posted',utteranceId:'u1'}]);
    expect(spoken).toEqual([]);
    finish();await runner.settled();
    expect(entries.filter(e=>e.stage).at(-1)).toEqual({stage:'receipt-rendered',utteranceId:'u1'});
    expect(spoken).toEqual([{utteranceId:'u1'}]);
  } finally {runner.dispose();vi.unstubAllGlobals();}
});

const advisory={representation:'spacefill',deviceClass:'quest3',atoms:200000,budget:260000,
  requestedLevel:'high',level:'high',estimatedVertices:10000000,message:'Showing atoms at requested detail; it may run slowly.'};
it.each(['spin it','make it bigger','best quality'])('unchanged advisory preserves normal voice confirmation: %s',async phrase=>{
  const outcome={applied:{geometryBudget:advisory}};
  const h=harness({outcome,getGeometryBudget:()=>({...advisory})});
  await h.say(phrase);
  expect(h.actions).toHaveLength(1);expect(h.spoken).toHaveLength(1);
  expect(h.spoken[0]).not.toBe(advisory.message);
  expect(outcome.applied).toEqual({geometryBudget:advisory});
  h.runner.dispose();
});
it('changed advisory speaks once, while the next voice edit retains the ordinary answer',async()=>{
  let prior:any=undefined;
  const h=harness({outcome:{applied:{geometryBudget:advisory}},getGeometryBudget:()=>prior});
  await h.say('best quality');expect(h.spoken).toEqual([advisory.message]);
  prior={...advisory};await h.say('spin it');
  expect(h.spoken).toEqual([advisory.message,'Spinning.']);h.runner.dispose();
});
