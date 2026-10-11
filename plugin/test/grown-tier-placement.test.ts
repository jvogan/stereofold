import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { grownTierIntent } from '../src/tour-player.js';
// @ts-ignore Executes the viewer's production emphasis, room framing and placement.
import { tourFocusHarness, framedTourScene } from '../../lab/browser-roundtrip/fixtures/tour-focus-harness.mjs';

const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const start = inspector.indexOf('async function openGrownTier(');
const end = inspector.indexOf('\nasync function navigateExperience(', start);
if (start < 0 || end < 0) throw Error('The inspector grown-tier entry is missing.');
const entry = transpileModule(inspector.slice(start, end), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None },
}).outputText;

function harness() {
  const viewer = tourFocusHarness();
  const startLesson = vi.fn(async () => {});
  const context = vm.createContext({
    workspace: viewer.workspace, grownTierIntent,
    tourPlayer: { start: startLesson }, recordHeadsetEvent: vi.fn(),
    thrownErrorMessage: (error: Error) => error.message,
  });
  vm.runInContext(entry, context);
  return { viewer, startLesson, open: context.openGrownTier,
    lesson: { id: 'growth-fixture', steps: [framedTourScene] } };
}

describe('inactive growth landing', () => {
  it('paints the incoming key without moving a wearer-owned room placement', async () => {
    const h = harness();
    await h.viewer.wearerMove();
    const placement = structuredClone(h.viewer.h.inspectionSnapshot().placement);
    const writes = h.viewer.writes.length;
    await h.open(h.lesson, false, false, false);
    expect(h.viewer.paints).toHaveLength(1);
    expect(h.viewer.records.filter((row: any) => row.kind === 'xr-focus')).toHaveLength(0);
    expect(h.viewer.h.inspectionSnapshot().placement).toEqual(placement);
    expect(h.viewer.writes).toHaveLength(writes);
    expect(h.startLesson).not.toHaveBeenCalled();
  });

  it('keeps the authored framing on the first open', async () => {
    const h = harness();
    await h.open(h.lesson, false, false, true);
    expect(h.viewer.paints).toHaveLength(1);
    expect(h.viewer.records.filter((row: any) => row.kind === 'xr-focus')).toHaveLength(1);
    expect(h.startLesson).not.toHaveBeenCalled();
  });

  for (const autoplay of [false, true]) {
    it(`opens the incoming chapter when a lesson is on screen (autoplay=${autoplay})`, async () => {
      const h = harness();
      await h.open(h.lesson, true, autoplay, false);
      expect(h.startLesson).toHaveBeenCalledExactlyOnceWith(autoplay);
      expect(h.viewer.paints).toHaveLength(0);
    });
  }
});
