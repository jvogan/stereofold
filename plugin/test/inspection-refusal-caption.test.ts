import { readdir, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { REGISTERED_TOOL_NAMES } from '../scripts/tool-inventory.js';
import { inspectionRefusalCaption } from '../src/inspection-refusal-caption.js';

// Audit actual source error strings, including template text and schema errors.
// Tool descriptions and successful model-only results are not display errors.
const toolNames = REGISTERED_TOOL_NAMES.map(name => name.replace('stereo_structure.', '')).filter(name => name.includes('_'));
const mentionsTool = new RegExp(`\\b(?:${toolNames.join('|')})\\b`);
const errors: { location: string; message: string }[] = [];
const root = new URL('../src/', import.meta.url);
for (const file of (await readdir(root)).filter(file => file.endsWith('.ts'))) {
  const source = ts.createSourceFile(file, await readFile(new URL(file, root), 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const message = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => 'example' + span.literal.text).join('') : node.text;
      let ancestor: ts.Node | undefined = node.parent, error = false;
      while (ancestor && !ts.isFunctionLike(ancestor)) {
        if (ts.isThrowStatement(ancestor)) error = true;
        if (file === 'headset-captions.ts' && ts.isCallExpression(ancestor)
          && ts.isPropertyAccessExpression(ancestor.expression) && ['max', 'refine'].includes(ancestor.expression.name.text)) error = true;
        ancestor = ancestor.parent;
      }
      if (error && mentionsTool.test(message)) errors.push({ location: `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, message });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

it('the error-string audit includes the post-synthesis narration refusal', () => {
  expect(errors.map(error => error.message)).toContain('The spoken line belongs to a replaced source. Read get_inspection_state.');
});
for (const { location, message } of errors) it(`wearer copy removes tool hints from the actual error at ${location}`, () => {
  const text = inspectionRefusalCaption(message);
  expect(text).not.toMatch(mentionsTool);
  expect(text.trim()).not.toBe('');
  // A descriptive first sentence remains intact; only its caller hint changes.
  if (!message.startsWith('Read ') && message.indexOf('.') < message.search(mentionsTool)) {
    expect(text).toContain(message.slice(0, message.indexOf('.') + 1));
  }
});

it('keeps source limits, unsupported transfers and ordinary refusals verbatim', () => {
  for (const message of ['This action belongs to a different structure.',
    'Journey needs model 2; this source does not contain it.',
    'Scene fidelity refused: the headset cannot reproduce this representation.',
    'Quest 2 refuses this chapter: 500,001 atom sites exceed its budget.',
    'This commandId was already used for a different request.']) {
    expect(inspectionRefusalCaption(message)).toBe(message);
  }
});
