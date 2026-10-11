// The page registers a comparison structure with its viewer after pulling it
// through the chunk route. A heartbeat repeats the same descriptors for as long
// as a command or a shared scene names the structure, so the page keeps what it
// assembled and fetches again only for a structure whose descriptors changed.
// These tests run the page's real `registerComparisonSources`.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

const inspectorSource = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const inspectorAst = ts.createSourceFile('inspector.ts', inspectorSource, ts.ScriptTarget.Latest, true);
const pieces = inspectorAst.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && node.name?.text === 'registerComparisonSources')
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText() === 'heldComparisons')));
expect(pieces, 'registerComparisonSources or heldComparisons moved out of the module scope').toHaveLength(2);

function page(options: { fail?: (source: any, attempt: number) => boolean; delayMs?: number } = {}) {
  const registered: any[][] = [];
  const fetched: string[] = [];
  const attempts = new Map<string, number>();
  const context: any = vm.createContext({
    Map, Promise, JSON, Error, Object,
    call: () => {}, binding: { sessionId: 's' },
    workspace: { registerComparisonSources: (sources: any[]) => { registered.push(sources); } },
    hydrateComparisonSource: async (source: any, _call: unknown, sessionId: string) => {
      const attempt = (attempts.get(source.sha256) ?? 0) + 1;
      attempts.set(source.sha256, attempt);
      fetched.push(`${sessionId}:${source.sha256}:${attempt}`);
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      if (options.fail?.(source, attempt)) throw Error('The coordinates changed during delivery. Reconnect before continuing.');
      source.cif = `cif-of-${source.sha256}`;
      source.catalogWire = { ...source.catalogWire, data: 'AAAA' };
      delete source.sourceBytes; delete source.catalogBytes;
    },
    decodeInspectionCatalog: async (wire: any) => ({ assemblyId: 'asymmetric_unit', source: { sha256: wire.sourceSha256 } }),
    verifyInspectionCatalogSource: async () => {},
  });
  vm.runInContext(ts.transpileModule(pieces.map(node => node.getText(inspectorAst)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const register = vm.runInContext('registerComparisonSources', context) as (sources: any[] | undefined, sessionId: string) => Promise<void>;
  return { register, registered, fetched };
}

/** A fresh descriptor object each time, as a new heartbeat answer carries. */
const descriptor = (digit: string, catalogDigit = 'c') => ({
  id: `S${digit}`, sha256: digit.repeat(64), assemblyId: 'asymmetric_unit',
  sourceBytes: { sha256: digit.repeat(64), bytes: 100 }, catalogBytes: { sha256: catalogDigit.repeat(64), bytes: 10 },
  catalogWire: { sourceSha256: digit.repeat(64), compressedBytes: 10 },
});

it('assembles a structure once and registers it with the viewer', async () => {
  const { register, registered, fetched } = page();
  await register([descriptor('1')], 'session-1');
  expect(fetched).toEqual([`session-1:${'1'.repeat(64)}:1`]);
  expect(registered).toHaveLength(1);
  expect(registered[0][0]).toMatchObject({ id: 'S1', cif: `cif-of-${'1'.repeat(64)}`, catalog: { assemblyId: 'asymmetric_unit' } });
});

it('reuses the assembled structure while a heartbeat repeats the same descriptors', async () => {
  const { register, registered, fetched } = page();
  await register([descriptor('1')], 's');
  await register([descriptor('1')], 's');
  await register([descriptor('1')], 's');
  expect(fetched).toHaveLength(1);
  expect(registered).toHaveLength(3);
  expect(registered[2][0].cif).toBe(registered[0][0].cif);
});

it('fetches again for a structure whose descriptors changed, and leaves an empty payload alone', async () => {
  const { register, registered, fetched } = page();
  await register([descriptor('1')], 's');
  await register(undefined, 's');
  await register([], 's');
  expect(registered).toHaveLength(1);
  await register([descriptor('1')], 's');
  expect(fetched).toHaveLength(1);
  // Same structure, different catalog digest: not the bytes the page holds.
  await register([descriptor('1', 'd')], 's');
  expect(fetched).toHaveLength(2);
  await register([descriptor('2')], 's');
  expect(fetched).toHaveLength(3);
});

it('shares one load between overlapping registrations', async () => {
  const { register, fetched } = page({ delayMs: 20 });
  await Promise.all([register([descriptor('1')], 's'), register([descriptor('1')], 's')]);
  expect(fetched).toHaveLength(1);
});

it('drops a failed load so the next registration retries, and registers nothing from the failed call', async () => {
  const { register, registered, fetched } = page({ fail: (_source, attempt) => attempt === 1 });
  await expect(register([descriptor('1')], 's')).rejects.toThrow(/changed during delivery/);
  expect(registered).toHaveLength(0);
  await register([descriptor('1')], 's');
  expect(fetched).toHaveLength(2);
  expect(registered).toHaveLength(1);
});

it('keeps a structure that loaded when another in the same payload fails', async () => {
  const { register, registered, fetched } = page({ fail: source => source.id === 'S2' });
  await expect(register([descriptor('1'), descriptor('2')], 's')).rejects.toThrow();
  expect(registered).toHaveLength(0);
  await expect(register([descriptor('1'), descriptor('2')], 's')).rejects.toThrow();
  // S1 was fetched on the first call only; S2 is retried.
  expect(fetched.filter(entry => entry.includes('1'.repeat(64)))).toHaveLength(1);
  expect(fetched.filter(entry => entry.includes('2'.repeat(64)))).toHaveLength(2);
});
