import { expect, it } from 'vitest';
import { waitForSavedXrEntry } from '../scripts/xr-entry-baseline.js';

const placement = (scale = 2.028809800196014) => ({
  translation: [.7767698954483464, .4614613636508036, -1.6781079495248052], rotation: [0, 0, 0], scale,
});
const saved = (value = placement(), inspectionRevision = 2) => ({
  serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 0, inspectionRevision,
  scene: { inspection: { placement: value } },
});
const state = (value = saved()) => ({
  ...value, panels: [{ panelId: 'wearer', surface: 'companion', current: true, availability: 'ready',
    xrStartup: { presenting: true, stale: false, sessionVisibility: 'visible' } }],
});

it('waits past the desktop snapshot until the rendered entry seat is saved', async () => {
  const stale = saved({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, 1);
  const seated = saved();
  let attempts = 0;
  const receipt = await waitForSavedXrEntry({ panelId: 'wearer', readLivePlacement: async () => placement(),
    readSaved: async () => ++attempts === 1 ? stale : seated,
    readState: async () => state(attempts === 1 ? stale : seated), pause: async () => {} });
  expect(stale.scene.inspection.placement).not.toEqual(receipt.livePlacement); // The old one-read baseline fails Done.
  expect(attempts).toBe(2);
  expect(receipt.saved).toBe(seated);
  expect(receipt.saved.scene.inspection.placement).toEqual(receipt.livePlacement);
});

it('rechecks live placement after host reads instead of accepting an edit mid-read', async () => {
  let reads = 0, attempts = 0;
  const receipt = await waitForSavedXrEntry({ panelId: 'wearer',
    readLivePlacement: async () => placement(++reads === 1 ? 2 : 3),
    readSaved: async () => saved(placement(++attempts === 1 ? 2 : 3)),
    readState: async () => state(saved(placement(attempts === 1 ? 2 : 3))), pause: async () => {} });
  expect(attempts).toBe(2);
  expect(receipt.saved.scene.inspection.placement.scale).toBe(3);
});

it.each(['serverEpoch', 'sourceToken', 'stateRevision', 'inspectionRevision'] as const)(
  'rejects a ready receipt with a different %s', async key => {
    let time = 0;
    const mismatched = { ...state(), [key]: typeof state()[key] === 'string' ? 'other' : 99 };
    await expect(waitForSavedXrEntry({ panelId: 'wearer', readLivePlacement: async () => placement(),
      readSaved: async () => saved(), readState: async () => mismatched as ReturnType<typeof state>,
      now: () => time, timeoutMs: 1, pause: async () => { time++; } })).rejects.toThrow('saved immersive entry');
  });

it.each(['unsaved', 'busy', 'stale', 'hidden', 'ended', 'other-panel', 'not-current'])(
  'rejects a %s companion even when placement is saved', async reason => {
    let time = 0;
    const observed = state(), panel = observed.panels[0];
    if (reason === 'unsaved' || reason === 'busy') panel.availability = reason;
    if (reason === 'stale') panel.xrStartup.stale = true;
    if (reason === 'hidden') panel.xrStartup.sessionVisibility = 'hidden';
    if (reason === 'ended') panel.xrStartup.presenting = false;
    if (reason === 'other-panel') panel.panelId = 'other';
    if (reason === 'not-current') panel.current = false;
    await expect(waitForSavedXrEntry({ panelId: 'wearer', readLivePlacement: async () => placement(),
      readSaved: async () => saved(), readState: async () => observed,
      now: () => time, timeoutMs: 1, pause: async () => { time++; } })).rejects.toThrow('saved immersive entry');
  });

it('accepts an already saved or unchanged seat without requiring a revision bump', async () => {
  const original = saved({ translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, 0);
  const receipt = await waitForSavedXrEntry({ panelId: 'wearer', readLivePlacement: async () => original.scene.inspection.placement,
    readSaved: async () => original, readState: async () => state(original),
    pause: async () => { throw Error('An already acknowledged seat needs no retry.'); } });
  expect(receipt.saved).toBe(original);
});
