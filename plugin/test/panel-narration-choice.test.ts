import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { expect, it, vi } from 'vitest';
import { createPanelNarrator } from '../src/panel-narration.js';

it('drops queued chapter audio when a new visit disables narration', async () => {
  const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const start = source.indexOf('let narrationGeneration=0;');
  const closure = source.slice(start, source.indexOf('async function receive(', start));
  let narration = true, release!: () => void, began!: () => void;
  const preparing = new Promise<void>(resolve => { began = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const played = vi.fn(async () => {});
  const narrator = createPanelNarrator({ prepare: async () => { began(); await gate; return played; } });
  const context = vm.createContext({
    panelTour: { getState: () => ({ active: true, stopped: false, narration }),
      current: () => ({ narratingLine: () => undefined }) },
    voiceCommandSpeaker: () => narrator, speechWasInterrupted: () => false,
    recordHeadsetEvent: vi.fn(), callStatus: () => undefined, thrownErrorMessage: String,
  });
  vm.runInContext(transpileModule(closure, { compilerOptions: {
    target: ScriptTarget.ES2022, module: ModuleKind.None,
  } }).outputText, context);
  const pending = context.speakNarration('The old chapter is still preparing.');
  await preparing;
  narration = false;
  release(); await pending;
  expect(played).not.toHaveBeenCalled();
  narration = true;
  await context.speakNarration('A fresh narrated visit.');
  expect(played).toHaveBeenCalledTimes(1);
});
