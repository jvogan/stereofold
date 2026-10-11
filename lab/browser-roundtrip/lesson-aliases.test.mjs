import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { partAliases, resolveEmphasisPartIds, resolveEmphasisPartId,
  normalizeEmphasisState, createLessonKeyMemory } from './lesson-emphasis.mjs';
import { spatialVoiceAction } from './voice-command-runner.mjs';

const demos = new URL('../../plugin/demos/', import.meta.url);
const generic = 'domain copy first second one two above below chain strand middle new the'.split(' ');
const key = value => String(value).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
// An independent vocabulary oracle: no label splitting or production alias
// helper generates these names or their owners.
const extra = {
  'dyskerin-c': ['dyskerin dkc1', 'dyskerin', 'dkc1'],
  'dyskerin-g': ['dyskerin dkc1', 'dyskerin', 'dkc1'],
  'nop10-f': ['nop10'], 'nop10-j': ['nop10'],
  'nhp2-e': ['nhp2'], 'nhp2-i': ['nhp2'], 'gar1-d': ['gar1'], 'gar1-h': ['gar1'],
  'htr-b': ['telomerase rna', 'rna', 'h aca'],
  cas9: ['cas9', 'protein'], guide: ['guide rna', 'rna'],
  'alpha-tubulin': ['alpha'], 'beta-tubulin': ['beta'], 'eb3-second': ['eb3'],
};
function* lessons(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    if (entry.isDirectory()) yield* lessons(path);
    else if (entry.name.endsWith('.json')) {
      const lesson = JSON.parse(readFileSync(path, 'utf8'));
      if (lesson.chapters) yield { lesson, name: path.pathname.split('/plugin/demos/')[1] };
    }
  }
}

test('every shipped lesson alias names exactly its intended parts, never generic words', () => {
  let checked = 0;
  for (const { lesson, name } of lessons(demos)) for (const chapter of lesson.chapters) {
    const parts = normalizeEmphasisState(chapter.immersive?.emphasis).parts;
    if (!parts.length) continue;
    checked++;
    const expected = new Map();
    for (const part of parts) {
      const names = new Set([part.id, part.label, ...(extra[part.id] ?? []), ...(part.aliases ?? [])].map(key));
      for (const alias of names) {
        const owners = expected.get(alias) ?? [];
        owners.push(part.id); expected.set(alias, owners);
      }
      assert.deepEqual([...partAliases(part)].sort(), [...names].sort(), `${name}/${chapter.id}/${part.id} vocabulary`);
      assert.equal(resolveEmphasisPartId(parts, part.id), part.id, 'machine ids stay precise');
    }
    for (const word of [...generic, 'telomerase', 'aca']) {
      assert.deepEqual(resolveEmphasisPartIds(parts, word), [], `${name}/${chapter.id}: ${word}`);
      assert.notEqual(spatialVoiceAction(`show me ${word}`, { lessonParts: parts })?.action?.kind,
        'emphasize-part', `${name}: show me ${word}`);
    }
    for (const [alias, owners] of expected) {
      assert.deepEqual(resolveEmphasisPartIds(parts, alias), owners, `${name}/${chapter.id}: ${alias}`);
      const said = spatialVoiceAction(`show me ${alias}`, { lessonParts: parts });
      if (said?.action?.kind === 'emphasize-part') {
        assert.deepEqual(said.action.parts ?? [said.action.part], owners);
        assert.ok(said.say.split(/\s+/).length <= 12, said.say);
      }
    }
  }
  assert.ok(checked >= 40, `only ${checked} chapter keys checked`);
});

test('authored aliases and parenthesized identifiers survive normalization and key memory', () => {
  const original = [{ id: 'a', label: 'Named complex (ABC), first copy', aliases: ['custom complex', 'domain'] },
    { id: 'b', label: 'Named complex (ABC), second copy', aliases: ['custom complex'] }];
  const state = normalizeEmphasisState({ parts: original });
  const memory = createLessonKeyMemory(); memory.remember(state);
  original[0].aliases.push('leaked original'); state.parts[0].aliases.push('leaked state');
  const parts = memory.parts({ parts: [] }); parts[0].aliases.push('leaked read');
  const kept = memory.parts({ parts: [] });
  for (const alias of ['ABC', 'named complex', 'Named complex (ABC)', 'custom complex'])
    assert.deepEqual(resolveEmphasisPartIds(kept, alias), ['a', 'b']);
  for (const alias of ['domain', 'leaked original', 'leaked state', 'leaked read'])
    assert.deepEqual(resolveEmphasisPartIds(kept, alias), []);
  assert.deepEqual(resolveEmphasisPartIds(kept, 'second custom complex'), ['b']);
});
