import { describe, it, expect, vi } from 'vitest';
import { executeInspectionVoiceAction } from '../src/inspection-voice-actions.js';

function fixture(scale = 1) {
  const state = { active: true, autoplay: false, canNext: true, canBack: false };
  const player = { getState: () => state, next: vi.fn(async () => {}), back: vi.fn(async () => {}),
    pause: vi.fn(() => { state.autoplay = false; }), start: vi.fn(async () => { state.active = true; }),
    togglePlay: vi.fn(async () => { state.autoplay = !state.autoplay; }),
    retryEmphasis: vi.fn(async () => 'The highlight is back.') };
  const place = vi.fn(async () => {}), save = vi.fn(async () => {}), navigate = vi.fn(async () => {});
  const workspace = { snapshot: () => ({ inspection: { placement: { scale } }, xrPresenting: false }),
    runTour: async (fn: () => Promise<void>) => fn(), viewer: { inspection: { place } } };
  return { state, player, place, save, navigate, hooks: { tour: () => player, experience: () => undefined, workspace: () => workspace, save, navigate } };
}
describe('verified voice actions', () => {
  it('never turns play into pause when speech is repeated', async () => {
    const f = fixture(); f.state.autoplay = true;
    await executeInspectionVoiceAction('tour-play', f.hooks);
    expect(f.player.togglePlay).not.toHaveBeenCalled(); expect(f.state.autoplay).toBe(true);
  });
  it('does not acknowledge a failed render', async () => {
    const f = fixture(); f.player.next.mockRejectedValue(Error('GPU lost'));
    await expect(executeInspectionVoiceAction('tour-next', f.hooks)).rejects.toThrow('GPU lost');
    expect(f.save).not.toHaveBeenCalled();
  });
  it('rejects unavailable previous scenes and unverified EB1 substitution', async () => {
    const f = fixture();
    await expect(executeInspectionVoiceAction('tour-back', f.hooks)).rejects.toThrow('no previous');
    await expect(executeInspectionVoiceAction('add-eb1-protein', f.hooks)).rejects.toThrow('contains EB3');
    expect(f.navigate).not.toHaveBeenCalled();
  });
  it('changes molecular size without moving the head camera', async () => {
    const f = fixture(); await executeInspectionVoiceAction('scale-larger', f.hooks);
    expect(f.place).toHaveBeenCalledWith({ scale: 1.2 }); expect(f.save).toHaveBeenCalledOnce();
  });
  it('rejects overhead placement outside an immersive session', async () => {
    const f = fixture(); await expect(executeInspectionVoiceAction('move-overhead', f.hooks)).rejects.toThrow('Enter VR');
  });
  // The wearer's one-phrase answer to a failed chapter highlight.
  it('retries the current chapter highlight and saves the spoken answer', async () => {
    const f = fixture();
    await expect(executeInspectionVoiceAction('retry', f.hooks)).resolves.toBe('The highlight is back.');
    expect(f.player.retryEmphasis).toHaveBeenCalledOnce();
    expect(f.save).toHaveBeenCalledOnce();
  });
  it('reports a failed retry as a line rather than an error, and keeps going', async () => {
    const f = fixture();
    f.player.retryEmphasis.mockResolvedValue('The retry failed too. We carry on.');
    await expect(executeInspectionVoiceAction('retry', f.hooks)).resolves.toBe('The retry failed too. We carry on.');
    expect(f.save).toHaveBeenCalledOnce();
  });
  it('rejects a retry with no active lesson or no retryable highlight', async () => {
    const f = fixture(); f.state.active = false;
    await expect(executeInspectionVoiceAction('retry', f.hooks)).rejects.toThrow('no active lesson');
    expect(f.player.retryEmphasis).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
    const g = fixture(); delete (g.player as { retryEmphasis?: unknown }).retryEmphasis;
    await expect(executeInspectionVoiceAction('retry', g.hooks)).rejects.toThrow('cannot retry');
  });
});

it.each([4, 8, .1])('voice scaling continues from explored scale %s and saves the result', async prior => {
  const f = fixture(prior);
  await executeInspectionVoiceAction('scale-larger', f.hooks);
  expect(f.place).toHaveBeenCalledWith({ scale: prior * 1.2 });
  expect(f.save).toHaveBeenCalledOnce();
});
