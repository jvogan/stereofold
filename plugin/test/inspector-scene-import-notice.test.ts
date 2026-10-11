import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const source = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('inspector.ts', source, ts.ScriptTarget.Latest, true);
const notice = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'updateSceneImportNotice')!;
let listener!: ts.BinaryExpression;
const visit = (node: ts.Node) => {
  if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'app.ontoolresult') listener = node;
  ts.forEachChild(node, visit);
};
visit(ast);

it('keeps the imported style notice for the same source and clears it after replacement', async () => {
  const scenePreflightNotice = { hidden: true, textContent: '', dataset: {} as Record<string, string>,
    replaceChildren(value: string) { this.textContent = value; } };
  const h = vm.createContext({ app: {}, scenePreflightNotice, document: { createTextNode: (value: string) => value },
    publishModelContext() {}, sceneImportPreflightView: () => undefined, retiredEpochs: new Set(),
    epoch: 'epoch', latestToken: 0, rendering: Promise.resolve(), requestedId: '',
    save: async () => {}, dirty: false, binding: {}, hydrate: async () => {}, showProblem: vi.fn() });
  vm.runInContext('let sceneImportNoticeSource;', h);
  const code = ts.transpileModule(`${notice.getText(ast)}\n${listener.getText(ast)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(code, h);
  h.updateSceneImportNotice('session', 'source-a', 'Ligands are shown as ball-and-stick.');
  expect(scenePreflightNotice.hidden).toBe(false);
  await h.app.ontoolresult({ structuredContent: { kind: 'inspect', sessionId: 'session', serverEpoch: 'epoch', renderToken: 1 } });
  expect(scenePreflightNotice.hidden).toBe(false);
  h.updateSceneImportNotice('session', 'source-a');
  expect(scenePreflightNotice.hidden).toBe(false);
  h.updateSceneImportNotice('session', 'source-b');
  expect(scenePreflightNotice.hidden).toBe(true);
  h.updateSceneImportNotice('session', 'source-b', 'Ligands are shown as ball-and-stick.');
  h.updateSceneImportNotice('other-session', 'source-b');
  expect(scenePreflightNotice.hidden).toBe(true);
});
