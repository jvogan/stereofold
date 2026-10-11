import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInteraction } from './voice-interaction.mjs';
import { outcomeCopy } from './outcome-copy.mjs';

/**
 * The other half of the stuck plate, held by the real modules rather than by a
 * description of them.
 *
 * `outcome-copy.test.mjs` pins what the copy does with a voice sentence. This
 * pins that a voice sentence was being produced at all, on the beat that made
 * the bug look like the agent's commands were never landing: every agent
 * command that the wearer hears a confirmation for plays that confirmation
 * through this same voice interaction (`inspector.ts` registers
 * `setVoiceCommandSpeaker` as `voiceInteraction.play`), and `play` announces
 * two state transitions of its own after the command's own outcome has
 * already been drawn.
 *
 * So the old one-line handler in `inspector.ts` -- which sent every one of
 * those transitions to the wearer's plate with a hard-coded `waiting` -- wrote
 * the plate twice per command, last, and in orange.
 */
function fakePlayback() {
  return { unlock: async () => {}, play: async () => {}, close: async () => {} };
}
function fakeCapture() {
  return { start: async () => {}, stop: async () => undefined, active: () => false };
}

test('speaking an agent confirmation drives the voice state machine after the command', async () => {
  const states = [];
  const voice = createVoiceInteraction({ capture: fakeCapture(), playback: fakePlayback(),
    onState: (state, message) => states.push([state, message]) });
  // Exactly what inspector.ts does for `update_inspection {kind:'motion'}`:
  // the host returns the spoken wav for "Spinning." and the page plays it.
  await voice.play('d2F2', 'Spinning.');
  await voice.dispose();
  assert.deepEqual(states, [['playing', 'Spinning.'], ['idle', 'Spinning.']]);
});

test('routing those transitions to the plate is what overwrote the applied outcome', async () => {
  // The plate as the command left it: teal, named, revisioned.
  const applied = outcomeCopy('Applied · motion · revision 24', 'applied');
  assert.equal(applied.text, 'Applied · motion · r24');

  const states = [];
  const voice = createVoiceInteraction({ capture: fakeCapture(), playback: fakePlayback(),
    onState: (state, message) => states.push([state, message]) });
  await voice.play('d2F2', 'Spinning.');
  await voice.dispose();

  // The removed handler's own rule: anything that is not `error` is `waiting`.
  const plate = states.map(([state, message]) =>
    outcomeCopy(message, state === 'error' ? 'error' : 'waiting').text);
  assert.deepEqual(plate, ['Waiting · change', 'Waiting · change']);
  // And the last writer wins, which is the orange plate the wearer read
  // through a tour, a spin, a stop and two render-quality commands.
  assert.notEqual(plate.at(-1), applied.text);
});
