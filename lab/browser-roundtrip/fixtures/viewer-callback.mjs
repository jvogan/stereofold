import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../plugin/package.json', import.meta.url));
const { createSourceFile, forEachChild, isPropertyAssignment, ScriptTarget } = require('typescript');
const callbacksBySource = new Map();

// Evaluate one production callback, without pulling sibling callback bindings
// into a fixture that does not exercise them.
export function viewerCallback(source, name) {
  let callbacks = callbacksBySource.get(source);
  if (!callbacks) {
    callbacks = new Map();
    const ast = createSourceFile('viewer.mjs', source, ScriptTarget.Latest, true);
    const visit = node => {
      if (isPropertyAssignment(node)) {
        const key = node.name.getText(ast);
        if (key === 'onSpatialAction' || key === 'onHeadFrame' || key === 'onInputFrame') callbacks.set(key, node.initializer.getText(ast));
      }
      forEachChild(node, visit);
    };
    visit(ast);
    callbacksBySource.set(source, callbacks);
  }
  assert.ok(callbacks.has(name), `missing viewer callback: ${name}`);
  return `(${callbacks.get(name)})`;
}
