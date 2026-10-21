import type { AnimationState } from './inspection-contract.js';
import type { AnimationPatch } from '../../packages/motion/src/keyframes.mjs';

/** Host elapsed time bounds progress without comparing page performance clocks. */
export function animationReceiptMatches(patch: AnimationPatch, sample: AnimationState, elapsedSeconds: number): boolean {
  const ended = !sample.loop && sample.state === 'paused' && sample.timeSeconds === sample.durationSeconds;
  if (patch.state === 'pause' && sample.state !== 'paused') return false;
  if (patch.state === 'play' && sample.state !== 'playing' && !ended) return false;
  if (patch.speed !== undefined && patch.speed !== sample.speed) return false;
  if (patch.loop !== undefined && patch.loop !== sample.loop) return false;
  const seek = patch.restart ? 0 : patch.seekSeconds;
  if (seek === undefined) return true;
  if (patch.state === 'pause' || sample.state === 'paused' && !ended) return sample.timeSeconds === seek;
  const delta = sample.loop
    ? (sample.timeSeconds - seek + sample.durationSeconds) % sample.durationSeconds
    : sample.timeSeconds - seek;
  return delta >= -1e-6 && delta <= elapsedSeconds * sample.speed + 1e-6;
}
