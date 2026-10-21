import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
function pageFunction(name: string) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  expect(start).toBeGreaterThan(0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}

it('the production chapter mutation admits held input and keeps grip movement available through its frame', async () => {
  const context = vm.createContext({
    chapterInteractionDepth: 0, appearanceWork: undefined, GRABBABLE_STATUS: new Set(['ready', 'mutating']),
    interactionActive: () => true, assertReady() {}, assertContext() {},
    failure: (code: string, message: string) => Object.assign(Error(message), { code }),
    inspectionState: {}, state: { status: 'ready', revision: 0, mutationCounts: { inspection: 0 } }, busy: false,
    motionMutationPaused: false, motionToolPaused: false, syncPresentationMotion() {},
    now: () => 0, retainCurrent: () => undefined, beginWork: () => ({ finish() {} }),
    canvas: { xr: { isPresenting: { value: false } }, webgl: { isContextLost: false }, commit() {} },
    recordRenderCost() {}, snapshot: () => ({}), emit() {}, onMutation() {},
  });
  vm.runInContext(`${pageFunction('runChapter')}\n${pageFunction('mutate')}\n${pageFunction('canManipulateNow')}`, context);
  const during: boolean[] = [];
  context.waitForFrame = async () => { during.push(context.canManipulateNow()); };
  await expect(context.mutate('inspection', async () => {})).rejects.toMatchObject({ code: 'interaction_active' });
  await context.runChapter(() => context.mutate('inspection', async () => {
    expect(context.state.status).toBe('mutating');
    during.push(context.canManipulateNow());
  }));
  expect(during).toEqual([true, true]);
  expect(context.chapterInteractionDepth).toBe(0);
  expect(context.state.status).toBe('ready');
});
