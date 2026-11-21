import { describe, expect, it } from 'vitest';
import { applyTourStep } from '../src/tour-player.js';
// @ts-ignore CPU harness executes the production viewer's emphasis and focus closures.
import { tourFocusHarness } from '../../lab/browser-roundtrip/fixtures/tour-focus-harness.mjs';

// A headset close-up (a figure focus) whose visibility hides chains of the
// source is framed against the chains it shows: the player applies that
// visibility before the figure and hands it to the figure's framing.

const rows = ['A', 'B'].map(chain => ({ key: chain, entityType: 'polymer', coordinateState: 'resolved', atomSites: [{}],
  identity: { labelChain: chain, authorChain: chain, copyId: '1', modelNumber: 1 } }));
const figure = { layers: [], labels: [], focus: [{ chain: 'A' }] };
const closeUp = { id: 'site', title: 'Site', figure, visibility: { op: 'only', chains: ['A'] } } as any;

function player({ xr = true, admitted = (() => true) as () => boolean, onVisibility = async (): Promise<void> => {} } = {}) {
  const { h, workspace } = tourFocusHarness();
  const calls: any[] = [];
  const snapshot = workspace.snapshot;
  workspace.snapshot = () => ({ ...snapshot(), xrPresenting: xr });
  workspace.rows = () => rows;
  Object.assign(workspace.viewer.inspection, {
    visibility: () => ({ hiddenChains: [], hiddenClasses: [], showOnlySelection: false }),
    setVisibility: async (value: any) => { calls.push(['visibility', value.hiddenChains.map((c: any) => c.labelChain)]); await onVisibility(); },
    setLessonFigure: async (value: any, options: any) => { calls.push(['figure', value ? 'figure' : 'none', options]); },
  });
  h.selection.rows = rows;
  return { workspace, calls, run: (entry: any, restored = false) => applyTourStep(workspace, entry, admitted, false, 1000, undefined, undefined, false, restored) };
}

describe('headset close-up visibility', () => {
  it('reaches the figure framing, after the visibility, for a qualifying chapter', async () => {
    const { calls, run } = player();
    await run(closeUp);
    const figureCall = calls.findIndex(c => c[0] === 'figure' && c[1] === 'figure');
    expect(calls.findIndex(c => c[0] === 'visibility')).toBeLessThan(figureCall);
    expect(calls[figureCall][2]).toEqual({ frame: true, visibility: expect.objectContaining({ hiddenChains: [{ labelChain: 'B', copyId: '1' }] }) });
  });

  for (const [name, entry, xr] of [
    ['on the desktop', closeUp, false],
    ['without a figure focus', { ...closeUp, figure: { ...figure, focus: undefined } }, true],
    ['when nothing is hidden', { ...closeUp, visibility: { op: 'only', chains: ['A', 'B'] } }, true],
  ] as const) it(`is not handed to the figure ${name}`, async () => {
    const { calls, run } = player({ xr });
    await run(entry);
    const options = calls.find(c => c[0] === 'figure' && c[1] === 'figure')?.[2];
    expect(options).toBeDefined();
    expect(options).not.toHaveProperty('visibility');
  });

  for (const restored of [false, true]) it(`installs no figure when the chapter is cancelled while its visibility lands (restored=${restored})`, async () => {
    let current = true;
    const { calls, run } = player({ admitted: () => current, onVisibility: async () => { current = false; } });
    await run(closeUp, restored).catch(() => {});
    expect(calls.filter(c => c[0] === 'visibility')).toHaveLength(1);
    expect(calls.filter(c => c[0] === 'figure' && c[1] === 'figure')).toEqual([]);
  });
});
