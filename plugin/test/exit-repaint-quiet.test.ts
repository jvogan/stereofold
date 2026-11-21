import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

// A headset page that left immersion while its viewer was busy still owes the
// flat page a rebuild (viewer.mjs `repaintAfterExit`). Started by the viewer
// the moment it went idle, that rebuild could land between a command's draw
// and its receipt, or between two steps of a chapter, and refuse the rest as
// busy. The page asks for it only once no command, hydration, chapter step or
// receipt is in hand, and runs it on the same chain as its commands.
const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('inspector.ts', source, ts.ScriptTarget.Latest, true);
const fn = (name: string) => ast.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(ast);

function page() {
  let owed = true;
  const repaints: string[] = [];
  const p: any = vm.createContext({
    isCompanion: true, closed: false, remote: false, loading: false, reloading: false, attaching: undefined,
    experiencePreparing: false, pendingReceipt: undefined, rendering: Promise.resolve(), setTimeout, Promise,
    tourPlayer: { getState: () => ({ navigating: p.chapterTurning }) }, chapterTurning: false,
    experiencePlayer: { getState: () => ({ navigating: false }) },
    workspace: { viewer: { xr: { exitRepaintOwed: () => owed,
      repaintAfterExit: async () => { repaints.push(p.remote ? 'during a command' : 'quiet'); owed = false; } } } },
    recordHeadsetEvent: () => {}, thrownErrorMessage: (error: Error) => error.message,
  });
  vm.runInContext(ts.transpileModule(fn('renderingSettled') + '\n' + fn('repaintAfterExitWhenQuiet'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, p);
  return { p, repaints, tick: async () => { await p.repaintAfterExitWhenQuiet(); await p.rendering; } };
}

it('waits for the command, chapter step and receipt in hand before the owed flat repaint, then runs it once', async () => {
  const t = page();
  t.p.remote = true;
  await t.tick();
  t.p.remote = false; t.p.pendingReceipt = { commandId: 'next' };
  await t.tick();
  t.p.pendingReceipt = undefined; t.p.chapterTurning = true;
  await t.tick();
  expect(t.repaints).toEqual([]);
  t.p.chapterTurning = false;
  await t.tick(); await t.tick();
  expect(t.repaints).toEqual(['quiet']);
});

it('waits for work already queued on the rendering chain, and is not owed twice', async () => {
  const t = page();
  let finishQueued!: () => void;
  t.p.rendering = new Promise<void>(resolve => { finishQueued = resolve; });
  await t.p.repaintAfterExitWhenQuiet();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(t.repaints).toEqual([]);
  finishQueued();
  await t.tick();
  expect(t.repaints).toEqual(['quiet']);
  await t.tick();
  expect(t.repaints).toEqual(['quiet']);
});
