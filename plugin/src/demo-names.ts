/**
 * Which bundled demo a name asks for.
 *
 * People ask for a demo the way they would say it: "the telomerase demo",
 * "CRISPR", "kinesin walk". The agent passes some form of those words, and an
 * index lookup that wanted the exact id refused "telomerase" while the only
 * telomerase demo is `telomerase-haca`. Every entry point that takes a demo
 * name (the `demo` argument of `replace_inspection_source`, `pnpm demo` and
 * the browser runners) resolves it here, so all of them accept and refuse the
 * same names.
 *
 * The order, first rule that settles it wins:
 * 1. An exact id.
 * 2. The id with case, spaces, hyphens, underscores and other punctuation
 *    ignored ("Kinesin walk" is `kinesin-walk`).
 * 3. Any demo the name fits by the start of its id, by a whole word of its id,
 *    or by a whole word (or run of whole words) of its title. Exactly one such
 *    demo opens; several are refused with only those candidates named.
 * Rule 3 needs at least three letters or digits, so a stray "a" opens nothing.
 *
 * Nothing here reads a path: a name only ever selects an entry the index
 * already lists.
 */
export type DemoNamed = { readonly name: string; readonly title?: string };

/** The fewest letters and digits a name needs before rule 3 applies. */
export const DEMO_NAME_MIN_PARTIAL = 3;

/** Lowercase letters and digits only: what two spellings of one name share. */
export function foldDemoName(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The name as it is echoed back in a refusal: no quotes, no control
 * characters, at most 64 characters. The refusal is shown to whoever asked,
 * so it repeats what they asked without letting it break the sentence.
 */
export function demoNameForMessage(asked: string): string {
  // Folded first: the headset caption is NFKC-normalized, which would turn a
  // full-width quote back into the quote this removes.
  const clean = asked.normalize('NFKC').replace(/[\p{Cc}"“”]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const points = Array.from(clean);
  return points.length > 64 ? `${points.slice(0, 63).join('')}…` : clean;
}

function words(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function fits(demo: DemoNamed, want: string): boolean {
  if (foldDemoName(demo.name).startsWith(want)) return true;
  if (words(demo.name).includes(want)) return true;
  const title = words(demo.title ?? '');
  for (let start = 0; start < title.length; start++) {
    let run = '';
    for (let end = start; end < title.length && run.length < want.length; end++) {
      run += title[end];
      if (run === want) return true;
    }
  }
  return false;
}

/** One candidate as a refusal names it: the id, then its title. */
function candidate(demo: DemoNamed): string {
  return demo.title ? `${demo.name} (${demo.title})` : demo.name;
}

/**
 * The demo a name opens, and whether the name was its exact id.
 *
 * Throws when no demo or more than one demo fits. The unknown-name refusal
 * keeps its long-standing first words and lists every id; the ambiguous one
 * names only the candidates. Both are for the agent; a wearer sees the short
 * forms `inspectionRefusalCaption` makes of them.
 */
export function resolveDemoName<T extends DemoNamed>(demos: readonly T[], asked: string): { demo: T; exact: boolean } {
  const exact = demos.find(demo => demo.name === asked);
  if (exact) return { demo: exact, exact: true };
  const want = foldDemoName(asked);
  const same = want ? demos.filter(demo => foldDemoName(demo.name) === want) : [];
  if (same.length === 1) return { demo: same[0], exact: false };
  const fitting = same.length > 1 ? same
    : want.length >= DEMO_NAME_MIN_PARTIAL ? demos.filter(demo => fits(demo, want)) : [];
  if (fitting.length === 1) return { demo: fitting[0], exact: false };
  const shown = demoNameForMessage(asked);
  if (fitting.length > 1)
    throw Error(`"${shown}" matches more than one bundled demo: ${fitting.map(candidate).join('; ')}. Name one of them.`);
  throw Error(`Unknown bundled demo "${shown}". Available: ${demos.map(demo => demo.name).join(', ')}.`);
}
