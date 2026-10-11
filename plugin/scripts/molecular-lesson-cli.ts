import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileMolecularLesson, createGenericMolecularLesson } from '../src/molecular-lesson.js';

const help = `Molecular presentation planner (local files; no viewer control)
  node lesson.mjs create --source <path-or-source-reference> --out <lesson.json> [--title <title>]
  node lesson.mjs compile --input <lesson.json> --out <plan.json>
Output files are created exclusively. Plans require live viewer validation before execution.
`;

async function readJson(path: string): Promise<unknown> {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 256 * 1024) throw Error('Lesson must be a regular JSON file of at most 256 KiB.');
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const next = await file.read(buffer, size, buffer.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    const after = await file.stat();
    if (size > 256 * 1024 || size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw Error('Lesson changed while reading or exceeds 256 KiB.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
  } finally { await file.close(); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { process.stdout.write(help); return; }
  if (!['create', 'compile'].includes(command)) throw Error(help);
  const options = new Map<string, string>();
  const allowed = command === 'create' ? ['--source', '--out', '--title'] : ['--input', '--out'];
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || options.has(args[i])) throw Error(help);
    options.set(args[i], args[i + 1]);
  }
  const out = options.get('--out');
  if (!out) throw Error('Supply --out; existing files will not be replaced.');
  let result: unknown;
  if (command === 'create') {
    const sourceRef = options.get('--source');
    if (!sourceRef) throw Error('Supply the molecule source reference with --source.');
    result = createGenericMolecularLesson({ sourceRef, title: options.get('--title') });
  } else {
    const input = options.get('--input');
    if (!input) throw Error('Supply --input.');
    const compiled = compileMolecularLesson(await readJson(input));
    result = { executionStatus: 'plan-only', binding: 'Resolve the exact live molecule, object IDs, targets and current revision before applying.', ...compiled };
  }
  await writeFile(resolve(out), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  process.stdout.write(`Wrote ${resolve(out)}\n`);
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
