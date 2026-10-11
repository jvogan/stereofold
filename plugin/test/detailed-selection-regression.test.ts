import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrderedSet } from 'molstar/lib/mol-data/int.js';
import { describe, it, expect } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { DETAILED_VIEW_RETURN_SOURCE } from '../src/detailed-view-return.js';
import { DETAILED_VIEW_SESSION_SOURCE } from '../src/detailed-view-session.js';
import { detailedViewHtml } from '../src/detailed-view-page.js';
import { headsetDiagnosticsBatchSchema } from '../src/headset-diagnostics.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';

const helpers = new Function(`return ${DETAILED_VIEW_RETURN_SOURCE}`)();
const session = new Function(`return ${DETAILED_VIEW_SESSION_SOURCE}`)();
const unit = {
  elements: [0, 1, 2, 3], conformation: {operator: {}},
  model: {atomicHierarchy: {
    residueAtomSegments: {index: [0, 0, 1, 1]}, chainAtomSegments: {index: [0, 0, 0, 0]},
    chains: {label_asym_id: {value: () => 'A'}}, atoms: {label_comp_id: {value: () => 'THR'}},
    residues: {label_seq_id: {value: (i: number) => i + 1}, auth_seq_id: {value: (i: number) => i + 1},
      pdbx_PDB_ins_code: {value: () => ''}},
  }},
};
const loaded = {units: [unit], elementCount: 4};
function picking(indices: unknown) {
  return {managers: {structure: {selection: {getLoci: (structure: unknown) => {
    expect(structure).toBe(loaded);
    return {kind: 'element-loci', elements: [{unit, indices}]};
  }}}}};
}
// Execute the page's actual HTTP path with an injected fetch. No listener needed.
function pageCall(fetch: (...args: any[]) => any) {
  const html = detailedViewHtml();
  const start = html.indexOf('    const call = async (name, args) =>');
  const end = html.indexOf('    const captionLine', start);
  return new Function('fetch', 'bearer', html.slice(start, end) + '; return call;')(fetch, 'test-page-key');
}

describe('Mol* selection regression from the headset', () => {
  it.each([
    ['packed interval', OrderedSet.ofBounds(2, 4)],
    ['typed sorted array', new Int32Array([2, 3])],
    ['plain sorted array', [2, 3]],
  ])('reads a %s through the page collector', (_name, indices) => {
    const gathered = helpers.collectSelection(picking(indices), loaded, 1000);
    expect(gathered).toMatchObject({truncated: false, residues: [{labelSequenceId: 2, authorResidue: 2}]});
    expect(gathered.residues).toHaveLength(1);
    expect(helpers.collect(picking(indices), loaded).residues).toEqual(gathered.residues);
  });

  it('caps packed intervals and accepts an empty selection manager', () => {
    expect(helpers.collectSelection(picking(OrderedSet.ofBounds(0, 4)), loaded, 1))
      .toMatchObject({truncated: true, residues: [{labelSequenceId: 1}]});
    expect(helpers.collectSelection({managers: {structure: {selection: {getLoci: () => ({kind: 'empty-loci'})}}}}, loaded))
      .toEqual({truncated: false, residues: []});
  });

  it.each(['collect', 'report'])('makes a %s failure visible and retries the same pick', async phase => {
    const warnings: string[] = [], statuses: string[] = [], posted: any[] = [];
    let failing = true;
    const manager = picking(OrderedSet.ofBounds(0, 2));
    const getLoci = manager.managers.structure.selection.getLoci;
    manager.managers.structure.selection.getLoci = structure => {
      if (failing && phase === 'collect') throw new TypeError('Selection manager failed');
      return getLoci(structure);
    };
    const reporter = session.createSelectionReporter({panel: () => 'panel',
      collect: () => helpers.collectSelection(manager, loaded),
      post: pageCall(async (_url: string, request: any) => {
        if (failing && phase === 'report') throw new TypeError('Failed to fetch');
        posted.push(JSON.parse(request.body));
        return {ok: true, json: async () => ({structuredContent: {}})};
      }), warn: (message: string) => warnings.push(message), status: (message: string) => statuses.push(message)});
    await reporter.report();
    expect(warnings[0]).toContain(`Selection not sent (${phase}): TypeError:`);
    expect(statuses[0]).toContain('Selection not sent. TypeError:');
    const batch = reporter.diagnostics();
    expect(headsetDiagnosticsBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch.entries[0].detail).toMatchObject({phase: `selection-${phase}`, name: 'TypeError',
      message: phase === 'collect' ? 'Selection manager failed' : 'Failed to fetch'});
    reporter.acknowledge(undefined);
    expect(reporter.diagnostics()).toEqual(batch);
    failing = false;
    await reporter.report(); await reporter.report();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({name: 'report_detailed_selection', args: {residues: [{labelSequenceId: 1}]}});
    expect(statuses.at(-1)).toBe('Selection sent: 1 residues.');
    reporter.acknowledge(batch.entries[0].seq);
    expect(reporter.diagnostics()).toBeUndefined();
  });

  it('resends after a later collection failure and bounds diagnostic batches', async () => {
    let failing = false, posts = 0;
    const reporter = session.createSelectionReporter({panel: () => 'panel',
      collect: () => {
        if (failing) throw Error('x'.repeat(300));
        return {residues: [], truncated: false};
      }, post: async () => { posts++; }, warn: () => {}, status: () => {}});
    await reporter.report(); failing = true;
    for (let i = 0; i < 26; i++) await reporter.report();
    const batch = reporter.diagnostics();
    expect(batch.entries).toHaveLength(24);
    expect(batch.entries[0].seq).toBe(3);
    expect(headsetDiagnosticsBatchSchema.safeParse(batch).success).toBe(true);
    failing = false; await reporter.report();
    expect(posts).toBe(2);
  });

  it('reports the initial empty pick and sends the same selection to a reopened panel', async () => {
    let panel = 'first'; const posts: any[] = [];
    const reporter = session.createSelectionReporter({panel: () => panel,
      collect: () => ({residues: [], truncated: false}), post: async (_name: string, args: any) => posts.push(args),
      warn: () => {}, status: () => {}});
    await reporter.report(); await reporter.report(); panel = 'reopened'; await reporter.report();
    expect(posts.map(p => p.panelId)).toEqual(['first', 'reopened']);
  });

  it('wires page warnings, wearer status and acknowledged diagnostics into its heartbeat', () => {
    const html = detailedViewHtml();
    expect(html).toContain('warn: message => console.warn(message)');
    expect(html).toContain('id="selection-status" role="status"');
    expect(html).toContain('selectionStatus.hidden = false');
    expect(html).toContain('diagnostics: selectionReporter.diagnostics()');
    expect(html).toContain('selectionReporter.acknowledge(answer.structuredContent.diagnosticsAck)');
  });

  it('accepts the collected page payload on the real server and gives the Mac a referent', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer('/tmp/detailed-selection-regression/viewer.html');
    const client = new Client({name: 'selection regression', version: '1'});
    await server.connect(b); await client.connect(a);
    const call = async (name: string, args: any) => await client.callTool({name: `stereo_structure.${name}`, arguments: args}) as any;
    try {
      const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
      const {sessionId} = (await call('inspect', {structureText: cif})).structuredContent;
      const data = (await call('get_inspection', {sessionId}))._meta[KEY];
      const binding = (state: any) => ({sessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
        baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision});
      const scene = {sourceSha256: data.catalog.source.sha256, modelNumber: 1, assemblyId: data.catalog.assemblyId,
        selectionKeys: [], camera: {mode: 'perspective', fov: 0.7, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0],
          radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0},
        inspection: {appearance: {representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734',
          highlightColor: '#ffccee', opacity: 1, labels: false, clipping: 0, fog: 30},
          placement: {translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1}}};
      const saved = (await call('sync_inspection', {...binding(data), scene})).structuredContent;
      const {panelId} = (await call('attach_inspection', {...binding(saved), surface: 'detailed'})).structuredContent;
      const reporter = session.createSelectionReporter({panel: () => panelId,
        collect: () => helpers.collectSelection(picking(OrderedSet.ofBounds(0, 2)), loaded),
        post: pageCall(async (_url: string, request: any) => {
          const payload = JSON.parse(request.body);
          // The companion injects sessionId after authenticating the page key.
          const result = await call(payload.name, {...payload.args, sessionId});
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent.detailedSelection.selectedResidues).toBe(1);
          return {ok: true, json: async () => result};
        }), warn: (message: string) => { throw Error(message); }, status: () => {}});
      await reporter.report();
      const state = (await call('get_inspection_state', {sessionId})).structuredContent;
      expect(state.detailedView.selection.selectedResidues).toBe(1);
      expect(state.modelContext.selection.count).toBe(1);
      expect(state.view.selectedResidueCount).toBe(0);
      await call('detach_inspection', {...binding(saved), panelId});
      const detached = (await call('get_inspection_state', {sessionId})).structuredContent;
      expect(detached.detailedView.selection.stale).toBe(true);
      expect(detached.modelContext.selection.count).toBe(0);
    } finally { await client.close(); await server.close(); }
  });
});
