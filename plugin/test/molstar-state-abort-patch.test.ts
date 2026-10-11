import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { patchMolstarStateAbortSource, stateAbortLoggingPatch } from '../src/molstar-state-abort-patch.mjs';

const reason = 'The XR session or molecular source changed during replacement.';
let source: string, api: any;
beforeAll(async () => {
  source = await readFile(new URL('../node_modules/molstar/lib/mol-state/state.js', import.meta.url), 'utf8');
  const patches: string[] = [];
  const result = await build({
    stdin: { resolveDir: new URL('..', import.meta.url).pathname, contents: `
      export { State, StateObject, StateTransformer } from 'molstar/lib/mol-state/index.js';
      export { Task } from 'molstar/lib/mol-task/index.js';
      export { runTransitionTask } from '../lab/browser-roundtrip/scene-transition.mjs';
    ` },
    nodePaths: [new URL('../node_modules', import.meta.url).pathname],
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [stateAbortLoggingPatch(input => patches.push(input.path))],
  });
  expect(patches).toHaveLength(1);
  api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text).toString('base64'));
});
afterEach(() => vi.restoreAllMocks());

describe('pinned Mol* state abort console classification', () => {
  it('changes only the one updateSubtree console statement', () => {
    const patched = patchMolstarStateAbortSource(source, '5.11.0');
    const classification = '        if (Task.isAbort(e))\n            console.info(e);\n        else\n            console.error(e);';
    expect(patched.split(classification)).toHaveLength(2);
    expect(patched.replace(classification, '        console.error(e);')).toBe(source);
  });

  it('fails closed for other versions, changed boundaries/catch/import, or double application', () => {
    expect(() => patchMolstarStateAbortSource(source, '5.12.0')).toThrow('5.11.0');
    for (const changed of [
      source.replace('async function updateSubtree(ctx, root)', 'async function updateSubtree(ctx, ref)'),
      source.replace('function resolveParams(ctx, transform, src, cell)', 'function resolveParams(ctx, transform, src, target)'),
      source.replace('doError(ctx, root, e, false);', 'doError(ctx, root, e, true);'),
      source.replace("import { Task } from '../mol-task/index.js';", ''),
      patchMolstarStateAbortSource(source, '5.11.0'),
    ]) expect(() => patchMolstarStateAbortSource(changed, '5.11.0')).toThrow();
  });

  it('fails a bundle that never loads the reviewed state updater', async () => {
    await expect(build({ stdin: { contents: 'export const unrelated = 1;' },
      bundle: true, write: false, plugins: [stateAbortLoggingPatch()], logLevel: 'silent',
    })).rejects.toThrow('Expected exactly one pinned Mol* state updater; patched 0.');
  });

  it('keeps the lab input audit strict while recording the sole transformed input', async () => {
    // Execute the actual build audit block against the installed dependency,
    // including tampering cases; no replacement audit implementation in the test.
    const lab = await readFile(new URL('../../lab/browser-roundtrip/build.cjs', import.meta.url), 'utf8');
    const from = lab.indexOf('      const print = await fingerprint(file);');
    const to = lab.indexOf('\n    const molstarRoot =', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const block = lab.slice(from, to).replace(/\n    }\s*$/, '');
    const audit = new Function('fingerprint', 'file', 'input', 'patchedInputs', 'sha256', 'report', 'name', 'inputs', 'abortLogging',
      `return (async () => {${block}\n})();`);
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
    const contents = patchMolstarStateAbortSource(source, '5.11.0');
    const print = { path: 'molstar/lib/mol-state/state.js', bytes: Buffer.byteLength(source), sha256: sha256(source) };
    for (const scenario of ['patched', 'stock', 'changed-original', 'changed-transformed-size', 'unrecognized-transform']) {
      const inputs: any[] = [], report = { violations: [] as string[] };
      const transformed = scenario !== 'stock';
      const input = { bytes: Buffer.byteLength(transformed ? contents : source) + (scenario === 'changed-transformed-size' ? 1 : 0) };
      const patches = new Map(scenario === 'stock' || scenario === 'unrecognized-transform' ? [] : [[print.path, { source, contents }]]);
      await audit(async () => ({ ...print, sha256: scenario === 'changed-original' ? 'tampered' : print.sha256 }),
        print.path, input, patches, sha256, report, print.path, inputs, stateAbortLoggingPatch());
      if (scenario === 'patched') {
        expect(report.violations).toEqual([]);
        expect(inputs).toEqual([{ ...print, transformation: 'stereofold-molstar-state-abort-logging',
          transformedBytes: Buffer.byteLength(contents), transformedSha256: sha256(contents) }]);
      } else if (scenario === 'stock') {
        expect(report.violations).toEqual([]);
        expect(inputs).toEqual([print]);
      } else expect(report.violations).toHaveLength(1);
    }
  });

  let id = 0;
  async function graph() {
    const ObjectType = api.StateObject.create({ name: 'Scientific scene', typeClass: 'Test' });
    const scene = { source: 'custom-cif', assembly: '1', selection: ['A:12'], alpha: .4, placement: [1, 2, 3] };
    const state = api.State.create(new ObjectType(scene), { runTask: (task: any) => task.run() });
    const transform = (apply: any) => api.StateTransformer.create('abort-log-regression', {
      name: `transform-${id++}`, from: [ObjectType], to: [ObjectType], apply,
    });
    await state.updateTree(state.build().toRoot().apply(transform(() => new ObjectType(scene)), {}, { ref: 'committed' })).run();
    const snapshot = state.getSnapshot(), committed = state.cells.get('committed').obj;
    const logs: any[] = [];
    state.events.log.subscribe((event: any) => logs.push(event));
    return { state, scene, snapshot, committed, logs, transform };
  }

  function assertRestored(g: Awaited<ReturnType<typeof graph>>) {
    expect(g.state.getSnapshot()).toEqual(g.snapshot);
    expect(g.state.cells.get('committed').obj).toBe(g.committed);
    expect(g.committed.data).toBe(g.scene);
    expect(g.state.cells.has('candidate')).toBe(false);
    expect(g.state.reverted).toBe(true);
    expect(g.state.inUpdate).toBe(false);
    expect(g.state.behaviors.isUpdating.value).toBe(false);
    expect(g.logs.some(event => event.type === 'error' && event.message.includes(reason))).toBe(true);
  }

  it.each(['abort', 'error'] as const)('preserves doError and rollback for a typed %s', async kind => {
    const g = await graph();
    const thrown = kind === 'abort' ? api.Task.Aborted(reason) : new Error(reason);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const candidate = g.state.build().toRoot().apply(g.transform(() => api.Task.create('replacement', async () => {
        throw thrown;
      })), {}, { ref: 'candidate' });
      await g.state.updateTree(candidate, { revertOnError: true }).run();
      assertRestored(g);
      expect((kind === 'abort' ? info : error).mock.calls).toEqual([[thrown]]);
      expect(kind === 'abort' ? error : info).not.toHaveBeenCalled();
    } finally { g.state.dispose(); }
  });

  it('retains cooperative abort, the original session guard error, and committed scene through the production task wrapper', async () => {
    const g = await graph();
    const guardError = Object.assign(new Error(reason), { code: 'stale_transition' });
    let sessionEnded = false, reachedAfterAbort = false;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const candidate = g.state.build().toRoot().apply(g.transform(() => api.Task.create('replacement', async (ctx: any) => {
        sessionEnded = true;
        await ctx.update('geometry still computing');
        reachedAfterAbort = true;
      })), {}, { ref: 'candidate' });
      await expect(api.runTransitionTask(g.state.updateTree(candidate, { revertOnError: true }), () => {
        if (sessionEnded) throw guardError;
      })).rejects.toBe(guardError);
      assertRestored(g);
      expect(reachedAfterAbort).toBe(false);
      expect(error).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledTimes(1);
      expect(api.Task.isAbort(info.mock.calls[0]![0])).toBe(true);
      expect(info.mock.calls[0]![0].reason).toBe(reason);
    } finally { g.state.dispose(); }
  });
});
