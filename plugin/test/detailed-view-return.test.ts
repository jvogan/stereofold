import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { DETAILED_VIEW_RETURN_SOURCE, detailedViewReturn, returnedSelectionKeys, stayedInMolstar } from '../src/detailed-view-return.js';
import { detailedViewHtml } from '../src/detailed-view-page.js';
import { TOOLS } from '../src/inspection-companion-http.js';
import { ALLOWED_TOOLS as LAN_TOOLS } from '../src/inspection-lan.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, expectedInspection } from '../src/inspection-contract.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const discard = (path: string) => rm(path, {force: true, recursive: true});
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const camera = {mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0],
  radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0};
const detailedCamera = {mode: 'orthographic', fov: 0.6, position: [12, -4, 33], up: [0, 1, 0], target: [1, 2, 3],
  radius: 31.5, radiusMax: 44, fog: 42, clipFar: false, minNear: 4, minFar: 0};

const appearance = {representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734',
  highlightColor: '#ffccee', opacity: 1, labels: false, clipping: 0, fog: 30};

/** What the detailed page posts: the same shape Download State writes, pruned. */
function snapshot(overrides: Record<string, any> = {}) {
  return {
    timestamp: 1, version: '5.11.0', current: 'entry-one',
    entries: [{timestamp: 1, snapshot: {
      id: 'entry-one',
      camera: {current: structuredClone(detailedCamera), transitionStyle: 'instant'},
      canvas3d: {props: {renderer: {backgroundColor: 0x0a0f14}}},
      data: {tree: {transforms: [
        {ref: 'root', parent: '', transformer: 'build-in.root', params: {}, version: '1'},
        {ref: 'repr', parent: 'structure', transformer: 'ms-plugin.structure-representation-3d', version: '1',
          params: {type: {name: 'spacefill', params: {alpha: 0.65}}, colorTheme: {name: 'uniform', params: {value: 0x11ee44}}}},
      ]}},
      ...overrides,
    }}],
  } as Record<string, unknown>;
}

function baseScene(sourceSha256: string, modelNumber = 1, assemblyId = 'asymmetric_unit') {
  return {sourceSha256, modelNumber, assemblyId, selectionKeys: [] as string[], camera: structuredClone(camera),
    inspection: {appearance: structuredClone(appearance), placement: {translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1}}} as any;
}

/** One catalog the mapper can be driven against without loading a structure. */
function catalogFor(rows: any[]) { return {rows}; }
function row(key: string, identity: Record<string, unknown>) {
  return {key, identity: {modelNumber: 1, copyId: JSON.stringify(['copy', 'asymmetric_unit', 0, []]),
    labelChain: 'A', componentId: 'THR', insertionCode: '', labelSequenceId: 1, authorResidue: 1, ...identity}};
}
function descriptor(overrides: Record<string, unknown> = {}) {
  return {assemblyId: 'asymmetric_unit', operatorIds: [] as string[], labelChain: 'A', componentId: 'THR',
    insertionCode: '', labelSequenceId: 1, authorResidue: 1, ...overrides} as any;
}

describe('returned residue identities', () => {
  it('maps browser residue descriptors onto canonical catalog keys and counts what it cannot place', () => {
    const catalog = catalogFor([
      row('key-thr-1', {}),
      row('key-ile-7', {componentId: 'ILE', labelSequenceId: 7, authorResidue: 7}),
      // A ligand has no polymer sequence position, so the author number is its identity.
      row('key-hoh-66', {componentId: 'HOH', labelSequenceId: null, authorResidue: 66}),
      // A second copy of the same chain is a different residue.
      row('key-thr-1-copy', {copyId: JSON.stringify(['copy', 'assembly-1', 1, ['P1']])}),
    ]);
    const mapped = returnedSelectionKeys(catalog, 1, [
      descriptor(),
      descriptor({componentId: 'ILE', labelSequenceId: 7, authorResidue: 7}),
      descriptor({componentId: 'HOH', labelSequenceId: null, authorResidue: 66}),
      descriptor({assemblyId: 'assembly-1', operatorIds: ['P1']}),
      descriptor(), // the same residue twice is still one key
      descriptor({labelChain: 'Z'}), // nothing in this model
    ]);
    expect(mapped.keys).toEqual(['key-thr-1', 'key-ile-7', 'key-hoh-66', 'key-thr-1-copy']);
    expect(mapped.unmatched).toBe(1);
  });

  it('never reaches into another model', () => {
    const catalog = catalogFor([row('model-two', {modelNumber: 2})]);
    expect(returnedSelectionKeys(catalog, 1, [descriptor()])).toEqual({keys: [], unmatched: 1});
  });
});

describe('detailed view return projection', () => {
  const digest = sha(cif);
  const catalog = catalogFor([row('key-thr-1', {}), row('key-ile-7', {componentId: 'ILE', labelSequenceId: 7, authorResidue: 7})]);

  it('brings appearance, camera and the selection back in one projection', () => {
    const projected = detailedViewReturn({snapshot: snapshot(), residues: [descriptor()]}, baseScene(digest), catalog);
    expect(projected.applied).toEqual(expect.arrayContaining(['camera', 'representation', 'color theme', 'opacity', 'selection']));
    expect(projected.scene.selectionKeys).toEqual(['key-thr-1']);
    expect(projected.scene.inspection.appearance.representation).toBe('spacefill');
    expect(projected.scene.inspection.appearance.background).toBe('#0a0f14');
    // The file route's standing note about a selection with no portable form
    // is exactly what this route answers, so it must not be repeated here.
    expect(projected.dropped.join(' ')).not.toMatch(/no portable form/);
  });

  it('says in plain words what stayed in Mol*', () => {
    const projected = detailedViewReturn({snapshot: snapshot(), residues: [descriptor(), descriptor({labelChain: 'Q'})],
      componentLabels: ['Binding site'], prunedStrings: 2}, baseScene(digest), catalog);
    const stayed = stayedInMolstar(projected.dropped).join(' ');
    expect(stayed).toMatch(/1 selected residue the panel's catalog for this model does not list/);
    expect(stayed).toMatch(/component grouping \(Binding site\)/);
    expect(stayed).toMatch(/measurements, volumes/);
    expect(stayed.endsWith('.')).toBe(true);
  });

  it('leaves the panel’s own selection alone when the page sends no residues', () => {
    const scene = baseScene(digest);
    scene.selectionKeys = ['key-ile-7'];
    const projected = detailedViewReturn({snapshot: snapshot()}, scene, catalog);
    expect(projected.scene.selectionKeys).toEqual(['key-ile-7']);
    expect(projected.applied).not.toContain('selection');
  });
});

describe('the detailed page half of the return', () => {
  const helpers = new Function(`return ${DETAILED_VIEW_RETURN_SOURCE};`)() as any;

  it('drops the coordinates a state tree carries before anything is posted', () => {
    const coordinates = 'ATOM'.repeat(4000);
    const tree = snapshot();
    (tree.entries as any[])[0].snapshot.data.tree.transforms.push({ref: 'raw', transformer: 'ms-plugin.raw-data', params: {data: coordinates}});
    const pruned = helpers.pruneSnapshot(tree);
    expect(pruned.prunedStrings).toBe(1);
    const transforms = (pruned.snapshot.entries[0].snapshot.data.tree.transforms as any[]);
    expect(transforms.at(-1).params.data).toBe('');
    // Everything the projection actually reads survives untouched.
    expect(transforms[1].params.type.name).toBe('spacefill');
    expect(pruned.snapshot.entries[0].snapshot.camera.current.position).toEqual(detailedCamera.position);
    expect(JSON.stringify(pruned.snapshot)).not.toContain('ATOMATOM');
  });

  /** A Mol* unit, cut down to the fields a residue identity is read from. */
  function unit(id: number, residues: {comp: string; label: number; auth: number; chain: string}[]) {
    const perAtom = residues.flatMap((residue, index) => [index, index]);
    return {
      id,
      elements: perAtom.map((_, atom) => atom),
      conformation: {operator: {assembly: undefined}},
      model: {atomicHierarchy: {
        chainAtomSegments: {index: perAtom},
        residueAtomSegments: {index: perAtom},
        chains: {label_asym_id: {value: (index: number) => residues[index].chain}},
        atoms: {label_comp_id: {value: (atom: number) => residues[perAtom[atom]].comp}},
        residues: {label_seq_id: {value: (index: number) => residues[index].label},
          auth_seq_id: {value: (index: number) => residues[index].auth},
          pdbx_PDB_ins_code: {value: () => ''}},
      }},
    };
  }

  it('collapses selected atoms onto residues and folds a user component into the same list', () => {
    const residues = [{comp: 'THR', label: 1, auth: 1, chain: 'A'}, {comp: 'ILE', label: 7, auth: 7, chain: 'A'}];
    const whole = unit(0, residues);
    const component = unit(1, [residues[1]]);
    const loaded = {units: [whole], elementCount: 4};
    const plugin = {managers: {
      structure: {
        selection: {getLoci: () => ({kind: 'element-loci', elements: [{unit: whole, indices: [0, 1]}]})},
        hierarchy: {current: {structures: [{components: [
          // The page's own "everything" component is never folded in.
          {cell: {obj: {data: {units: [whole], elementCount: 4}, label: 'All'}, transform: {tags: ''}}},
          {cell: {obj: {data: {units: [component], elementCount: 2}, label: 'Binding site'}, transform: {tags: ''}}},
          // Nor is the label layer this page builds over the arriving selection.
          {cell: {obj: {data: {units: [component], elementCount: 2}, label: 'Labels'}, transform: {tags: ['stereofold-selected-labels']}}},
        ]}]}},
      },
    }};
    const gathered = helpers.collect(plugin, loaded);
    expect(gathered.residues).toEqual([
      {assemblyId: 'asymmetric_unit', operatorIds: [], labelChain: 'A', componentId: 'THR', insertionCode: '', labelSequenceId: 1, authorResidue: 1},
      {assemblyId: 'asymmetric_unit', operatorIds: [], labelChain: 'A', componentId: 'ILE', insertionCode: '', labelSequenceId: 7, authorResidue: 7},
    ]);
    expect(gathered.componentLabels).toEqual(['Binding site']);
    expect(gathered.truncated).toBe(false);
  });

  /**
   * The key this page draws is not the user's selection.
   *
   * The collector folds components into the selection because gathering
   * residues into one is exactly how a user says "these". But the page builds
   * components of its own now — one per part of the lesson's colour key, and
   * the faded complement underneath them — and a round trip where the wearer
   * touched nothing was coming home with the named parts selected.
   */
  it('never folds the components the page generated itself into the selection', () => {
    const residues = [{comp: 'THR', label: 1, auth: 1, chain: 'A'}, {comp: 'ILE', label: 7, auth: 7, chain: 'A'}];
    const whole = unit(0, residues);
    const part = unit(1, [residues[1]]), rest = unit(2, [residues[0]]);
    const loaded = {units: [whole], elementCount: 4};
    const generated = (label: string, unitOf: any, key: string) => ({cell: {
      obj: {data: {units: [unitOf], elementCount: 2}, label},
      transform: {tags: ['stereofold-generated', 'structure-component-' + key]}}});
    const plugin = {managers: {structure: {
      // Nothing is selected over there: the wearer opened the viewer, looked,
      // and pressed Return.
      selection: {getLoci: () => ({kind: 'empty-loci'})},
      hierarchy: {current: {structures: [{components: [
        {cell: {obj: {data: {units: [whole], elementCount: 4}, label: 'All'}, transform: {tags: ['structure-component-all']}}},
        generated('PAM', part, 'stereofold-emphasis-pam'),
        generated('Rest of structure', rest, 'stereofold-emphasis-context'),
      ]}]}},
    }}};
    const gathered = helpers.collect(plugin, loaded);
    expect(gathered.residues).toEqual([]);
    expect(gathered.componentLabels).toEqual([]);
    // And the projection built from that payload leaves the panel's own
    // selection exactly where it was.
    const projected = detailedViewReturn({snapshot: snapshot(), residues: gathered.residues,
      ...(gathered.componentLabels.length ? {componentLabels: gathered.componentLabels} : {})},
    baseScene(sha(cif)), catalogFor([row('key-thr-1', {})]));
    expect(projected.scene.selectionKeys).toEqual([]);
    expect(projected.applied).not.toContain('selection');
  });

  it('still folds a component the user gathered, alongside the page’s own', () => {
    const residues = [{comp: 'THR', label: 1, auth: 1, chain: 'A'}, {comp: 'ILE', label: 7, auth: 7, chain: 'A'}];
    const whole = unit(0, residues);
    const mine = unit(1, [residues[1]]), key = unit(2, [residues[0]]);
    const loaded = {units: [whole], elementCount: 4};
    const plugin = {managers: {structure: {
      selection: {getLoci: () => ({kind: 'empty-loci'})},
      hierarchy: {current: {structures: [{components: [
        {cell: {obj: {data: {units: [key], elementCount: 2}, label: 'PAM'},
          transform: {tags: ['stereofold-generated', 'structure-component-stereofold-emphasis-pam']}}},
        {cell: {obj: {data: {units: [mine], elementCount: 2}, label: 'Binding site'},
          transform: {tags: ['structure-component-query-1']}}},
      ]}]}},
    }}};
    const gathered = helpers.collect(plugin, loaded);
    expect(gathered.componentLabels).toEqual(['Binding site']);
    expect(gathered.residues).toEqual([{assemblyId: 'asymmetric_unit', operatorIds: [], labelChain: 'A',
      componentId: 'ILE', insertionCode: '', labelSequenceId: 7, authorResidue: 7}]);
  });

  it('describes a residue with no polymer position by its author number', () => {
    const water = unit(2, [{comp: 'HOH', label: 0, auth: 66, chain: 'B'}]);
    expect(helpers.describe(water, 0)).toMatchObject({componentId: 'HOH', labelSequenceId: null, authorResidue: 66, labelChain: 'B'});
  });

  // The press is a loop because a panel renders one leg at a
  // time, and the loop is bounded because a panel can also stop answering. The
  // bound running out is not the same event as the work finishing, and the page
  // used to report both as "applied" and navigate away.
  describe('the Return loop', () => {
    /** A host that hands back one leg per POST, as an attached panel does. */
    function legs(order: string[], {stall = 0} = {}) {
      const left = [...order];
      const calls: number[] = [];
      return {
        calls,
        async post() {
          calls.push(left.length);
          if (calls.length <= stall) throw Error('The panel is still rendering.');
          const change = left.shift();
          return {applied: change ? [change] : [], stayed: [], remaining: [...left]};
        },
      };
    }
    const silent = {say: () => {}, wait: async () => {}, onApplied: () => {}};

    it('applies every leg the host names, one POST at a time', async () => {
      const host = legs(['appearance', 'selection', 'camera']);
      const outcome = await helpers.applyReturn({...silent, payload: {}, post: host.post, limit: 12});
      expect(outcome.applied).toEqual(['appearance', 'selection', 'camera']);
      expect(outcome.remaining).toEqual([]);
      expect(outcome.attempts).toBe(3);
      expect(outcome.error).toBeUndefined();
    });

    it('waits out a panel that is still rendering rather than failing on it', async () => {
      const host = legs(['appearance', 'selection'], {stall: 3});
      const waits: unknown[] = [];
      const outcome = await helpers.applyReturn({...silent, payload: {}, post: host.post, limit: 12,
        wait: async (ms: number) => { waits.push(ms); }});
      expect(outcome.applied).toEqual(['appearance', 'selection']);
      expect(outcome.remaining).toEqual([]);
      // Three refusals waited on, then the two legs; the second names its own
      // pause because work was still to come.
      expect(waits).toEqual([1500, 1500, 1500, 1200]);
    });

    it('reports the work still queued when the bound runs out, and never calls it applied', async () => {
      // A desktop panel saving a representation is slower than the bound: the
      // legs after the first never get their turn. The wearer must not be told
      // the selection and the camera came back when they are still in Mol*.
      const host = legs(['appearance', 'selection', 'camera'], {stall: 99});
      const outcome = await helpers.applyReturn({...silent, payload: {}, post: host.post, limit: 4});
      expect(outcome.attempts).toBe(4);
      expect(outcome.applied).toEqual([]);
      expect(outcome.remaining.length).toBeGreaterThan(0);
      expect(outcome.error).toBeInstanceOf(Error);
    });

    // The host now names the leg it has handed to the panel
    // in `remaining` until the panel's receipt lands, so an empty `remaining`
    // is a rendered frame. The loop must turn once more rather than read the
    // enqueue as the end of the return.
    it('keeps pressing while the host still names the last leg, and stops on its receipt', async () => {
      const answers = [
        {applied: [], stayed: [], remaining: ['camera']},
        {applied: [], stayed: [], remaining: ['camera']},
        {applied: ['camera'], stayed: ['The measurements.'], remaining: []},
      ];
      let post = 0;
      const outcome = await helpers.applyReturn({...silent, payload: {}, limit: 12,
        post: async () => answers[post++]});
      expect(post).toBe(3);
      expect(outcome.applied).toEqual(['camera']);
      expect(outcome.remaining).toEqual([]);
      expect(outcome.stayed).toEqual(['The measurements.']);
      expect(outcome.error).toBeUndefined();
    });

    it('counts the leg in flight once rather than twice', async () => {
      // `remaining` now includes the leg the host just took, so adding one for
      // the enqueue would have announced "Applying 2 of 4" for three legs.
      const host = legs(['appearance', 'selection', 'camera']);
      const said: string[] = [];
      await helpers.applyReturn({...silent, payload: {}, post: host.post, limit: 12, say: (text: string) => said.push(text)});
      expect(said[0]).toBe('Applying 2 of 3 — selection, camera to come.');
      expect(said[1]).toBe('Applying 3 of 3 — camera to come.');
    });

    it('has room in its own default bound for every leg to be held for its receipt', async () => {
      // Every leg is now two turns of this loop at best — the one that hands it
      // over and the one that reads its receipt — and the presses are 1.2 s
      // apart, so a panel saving a spacefill representation holds each leg for
      // several of them. Three legs, three beats each, is thirteen turns, which
      // is past the bound this loop used to carry. Giving up early is the wearer
      // being sent home over work that is still queued.
      const rendering = (left: string[]) => ({applied: [], stayed: [], remaining: left});
      const rendered = (leg: string, left: string[]) => ({applied: [leg], stayed: [], remaining: left});
      const all = ['appearance', 'selection', 'camera'];
      const answers = [
        rendering(all), rendering(all), rendering(all), rendering(all),
        rendered('appearance', ['selection', 'camera']),
        rendering(['selection', 'camera']), rendering(['selection', 'camera']), rendering(['selection', 'camera']),
        rendered('selection', ['camera']),
        rendering(['camera']), rendering(['camera']), rendering(['camera']),
        rendered('camera', []),
      ];
      expect(answers).toHaveLength(13);
      let post = 0;
      const outcome = await helpers.applyReturn({...silent, payload: {}, post: async () => answers[post++]});
      expect(post).toBe(answers.length);
      expect(outcome.applied).toEqual(['appearance', 'selection', 'camera']);
      expect(outcome.remaining).toEqual([]);
    });

    it('leaves legs outstanding when the host keeps naming more of them than the bound allows', async () => {
      const host = legs(['appearance', 'selection', 'camera']);
      const outcome = await helpers.applyReturn({...silent, payload: {}, post: host.post, limit: 2});
      expect(outcome.applied).toEqual(['appearance', 'selection']);
      expect(outcome.remaining).toEqual(['camera']);
      // Nothing threw: the loop simply stopped, and the caller is the one that
      // has to notice the leftovers rather than press Back over them.
      expect(outcome.error).toBeUndefined();
    });
  });
});

// The press itself. The loop above can report leftovers; this is
// the page agreeing not to lie about them.
describe('the Return press', () => {
  it('only claims the return applied, and only goes Back, once nothing is left', () => {
    const source = detailedViewHtml();
    // The page owns no loop of its own any more: one bounded loop, tested.
    // The only `while` left in the document is the helper's own, inlined here.
    expect(source).toContain('helpers.applyReturn(');
    expect(source.match(/while \(remaining\.length/g)).toHaveLength(1);
    expect(source).not.toMatch(/say\('Applying your changes[\s\S]{0,400}back\.click/);
    // The guard running out with work outstanding is a failure, and the
    // failure path is the file the user can hand back instead.
    expect(source).toMatch(/if \(outcome\.remaining\.length\)[\s\S]{0,200}throw/);
    // 'applied' and the Back click both sit after that check.
    const settled = source.indexOf('if (outcome.remaining.length)');
    expect(settled).toBeGreaterThan(0);
    expect(source.indexOf("dataset.returned = 'applied'")).toBeGreaterThan(settled);
    expect(source.indexOf('back.click()')).toBeGreaterThan(settled);
  });
});

describe('return_detailed_view over the host', () => {
  async function setup() {
    const dist = await mkdtemp(join(tmpdir(), 'stereofold-dist-'));
    await writeFile(join(dist, 'viewer.html'), '<html><script>void 0;</script></html>');
    await mkdir(join(dist, 'molstar'), {recursive: true});
    await writeFile(join(dist, 'molstar/molstar.js'), 'globalThis.molstar={};');
    await writeFile(join(dist, 'molstar/molstar.css'), '.msp-plugin{color:#fff}');
    const [a, b] = InMemoryTransport.createLinkedPair(), server = createStereoStructureServer(join(dist, 'viewer.html'), {});
    const client = new Client({name: 'Detailed view return test', version: '1'});
    await server.connect(b); await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => await client.callTool({name: `stereo_structure.${name}`, arguments: args}) as any;
    const sessionId = (await call('inspect', {structureText: cif})).structuredContent.sessionId;
    const data = (await call('get_inspection', {sessionId}))._meta[KEY];
    const scene = baseScene(data.catalog.source.sha256, data.catalog.modelNumbers[0], data.catalog.assemblyId);
    const args = {sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
      baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene};
    return {call, sessionId, args, catalog: data.catalog,
      close: async () => { await client.close(); await server.close(); await discard(dist); }};
  }

  /** Descriptors for real catalog rows, built the way the loaded structure would. */
  function describeRows(catalog: any, count: number) {
    return catalog.rows.slice(0, count).map((entry: any) => {
      const copyId = JSON.parse(entry.identity.copyId);
      return {assemblyId: copyId[1], operatorIds: copyId[3].map(String), labelChain: entry.identity.labelChain,
        componentId: entry.identity.componentId, insertionCode: entry.identity.insertionCode ?? '',
        labelSequenceId: entry.identity.labelSequenceId, authorResidue: entry.identity.authorResidue};
    });
  }

  it('is reachable from the detailed page over the companion tool route', () => {
    expect(TOOLS.has('return_detailed_view')).toBe(true);
    // The recall poll rides the same route and the same
    // bearer, on both listeners — the wearer's page is on the LAN one.
    expect(TOOLS.has('poll_detailed_view')).toBe(true);
    expect(LAN_TOOLS.has('poll_detailed_view')).toBe(true);
    // Leaving a recall is the agent's, never the page's: a headset that could
    // write the mailbox it also reads is a page that can recall itself.
    expect(TOOLS.has('recall_headset')).toBe(false);
    expect(LAN_TOOLS.has('recall_headset')).toBe(false);
  });

  it('saves the whole projection when the wearer’s own panel has left for the viewer', async () => {
    const t = await setup();
    try {
      await t.call('sync_inspection', t.args);
      const residues = describeRows(t.catalog, 2);
      const returned = await t.call('return_detailed_view', {sessionId: t.sessionId, snapshot: snapshot(), residues});
      expect(returned.isError).not.toBe(true);
      expect(returned.structuredContent.detailedReturn).toMatchObject({mode: 'saved', remaining: [], selectedResidues: 2,operation:{kind:'visual-edit',coordinatesChanged:false,tool:'return_detailed_view'}});
      expect(returned.structuredContent.detailedReturn.applied).toEqual(expect.arrayContaining(['appearance', 'selection', 'camera']));
      expect(returned.content[0].text).toMatch(/Returned appearance, selection, camera/);

      // One press, and the page the wearer comes back to loads all of it.
      const after = (await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY];
      expect(after.scene.inspection.appearance.representation).toBe('spacefill');
      expect(after.scene.inspection.appearance.background).toBe('#0a0f14');
      expect(after.scene.selectionKeys).toEqual(t.catalog.rows.slice(0, 2).map((entry: any) => entry.key));
      expect(after.scene.camera.position).toEqual(detailedCamera.position);
      expect(after.inspectionRevision).toBeGreaterThan(t.args.baseInspectionRevision);
    } finally { await t.close(); }
  });

  it('queues one leg at a time on an attached panel and names what is still to come', async () => {
    const t = await setup();
    try {
      const saved = (await t.call('sync_inspection', t.args)).structuredContent;
      const current = {sessionId: t.sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision};
      await t.call('attach_inspection', current);
      const returned = await t.call('return_detailed_view', {sessionId: t.sessionId, snapshot: snapshot(), residues: describeRows(t.catalog, 1)});
      expect(returned.isError).not.toBe(true);
      const detail = returned.structuredContent.detailedReturn;
      // The leg handed over is named among the work still to come, not among
      // the work that landed: it is a queued command until its receipt says
      // otherwise, exactly like the leg after it.
      expect(detail).toMatchObject({mode: 'panel', applied: []});
      expect(detail.remaining).toEqual(['appearance', 'selection', 'camera']);
      expect(returned.structuredContent.detailedReturn.command.status).toBe('queued');
      expect(returned.content[0].text).toMatch(/Still to come: appearance, selection, camera; press Return again/);
      // The saved scene is untouched until the panel renders that command.
      const after = (await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY];
      expect(after.scene.inspection.appearance.representation).toBe('cartoon');
    } finally { await t.close(); }
  });

  it('reports a matching viewer as nothing to do rather than queueing a no-op', async () => {
    const t = await setup();
    try {
      const matched = structuredClone(t.args.scene);
      Object.assign(matched.inspection.appearance,
        {representation: 'spacefill', color: 'uniform', uniformColor: '#11ee44', opacity: 0.65, background: '#0a0f14'});
      matched.camera = structuredClone(detailedCamera);
      await t.call('sync_inspection', {...t.args, scene: matched});
      const returned = await t.call('return_detailed_view', {sessionId: t.sessionId, snapshot: snapshot(), residues: []});
      expect(returned.structuredContent.detailedReturn).toMatchObject({applied: [], remaining: []});
      expect(returned.content[0].text).toMatch(/already matches the panel/);
    } finally { await t.close(); }
  });

  // A queued command is not a rendered one, and the last
  // leg is the only one whose answer the page acts on by navigating away.
  describe('the last leg', () => {
    /** A saved scene the posted snapshot already matches except for the framing. */
    async function oneLegLeft(t: any) {
      const matched = structuredClone(t.args.scene);
      Object.assign(matched.inspection.appearance,
        {representation: 'spacefill', color: 'uniform', uniformColor: '#11ee44', opacity: 0.65, background: '#0a0f14'});
      const saved = (await t.call('sync_inspection', {...t.args, scene: matched})).structuredContent;
      const current = {sessionId: t.sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision};
      const panelId = (await t.call('attach_inspection', current)).structuredContent.panelId;
      return {current, panelId};
    }
    const press = (t: any) => t.call('return_detailed_view', {sessionId: t.sessionId, snapshot: snapshot(), residues: []});
    /** The panel's own render: claim the queued command and post its receipt. */
    async function claim(t: any, current: Record<string, unknown>, panelId: string) {
      return (await t.call('poll_inspection', {...current, panelId, availability: 'ready'}))._meta[KEY].delivery;
    }

    it('stays remaining while it is queued, and is applied only once the receipt lands', async () => {
      const t = await setup();
      try {
        const {current, panelId} = await oneLegLeft(t);
        const first = await press(t);
        expect(first.isError).not.toBe(true);
        // The command exists, so the leg is on its way — and that is exactly
        // what "remaining" means. Calling it applied here is what let the page
        // announce the return and click Back over an unrendered frame.
        expect(first.structuredContent.detailedReturn).toMatchObject({mode: 'panel', applied: [], remaining: ['camera']});
        expect(first.structuredContent.detailedReturn.command.status).toBe('queued');
        expect(first.content[0].text).toMatch(/has not rendered it yet/);
        expect(first.content[0].text).toMatch(/Still to come: camera; press Return again/);

        // Pressing again while it is still queued repeats the same answer and
        // never stacks a second command on the one the panel is holding.
        const again = await press(t);
        expect(again.isError).not.toBe(true);
        expect(again.structuredContent.detailedReturn).toMatchObject({applied: [], remaining: ['camera']});
        expect(again.structuredContent.detailedReturn.command).toBeUndefined();
        // Nothing is committed yet either.
        expect((await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY].scene.camera.position).toEqual(camera.position);

        const delivery = await claim(t, current, panelId);
        expect(delivery.change.kind).toBe('camera');
        // What the panel paints: the saved scene with only the pose the command
        // named, which is what the receipt is judged against.
        const saved = (await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY].scene;
        const rendered = expectedInspection(structuredClone(saved), delivery.change);
        const receipt = await t.call('complete_inspection', {...current, panelId,
          commandId: delivery.commandId, claimToken: delivery.claimToken, scene: rendered});
        expect(receipt.structuredContent.command.status).toBe('rendered');
        // The panel's next heartbeat, at the revision the render committed —
        // the page waits between presses, so a live panel has always sent one.
        const committed = (await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY];
        await t.call('poll_inspection', {sessionId: t.sessionId, serverEpoch: committed.serverEpoch,
          sourceToken: committed.sourceToken, baseStateRevision: committed.stateRevision,
          baseInspectionRevision: committed.inspectionRevision, panelId, availability: 'ready'});

        const settled = await press(t);
        expect(settled.structuredContent.detailedReturn).toMatchObject({applied: ['camera'], remaining: []});
        expect(settled.content[0].text).toMatch(/Returned camera from the full Mol\* viewer to the panel/);
        expect((await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY].scene.camera.position)
          .toEqual(detailedCamera.position);
      } finally { await t.close(); }
    });

    it('comes back as work to do when the panel refuses it, rather than being lost', async () => {
      const t = await setup();
      try {
        const {current, panelId} = await oneLegLeft(t);
        expect((await press(t)).structuredContent.detailedReturn.remaining).toEqual(['camera']);
        const delivery = await claim(t, current, panelId);
        const refused = await t.call('complete_inspection', {...current, panelId, commandId: delivery.commandId,
          claimToken: delivery.claimToken, failure: 'render_failed', failureReason: 'The renderer lost its context.'});
        expect(refused.structuredContent.command.status).toBe('rejected');
        // The saved scene never moved, so the leg is derived again and re-sent
        // instead of being remembered as something that landed.
        const retry = await press(t);
        expect(retry.structuredContent.detailedReturn).toMatchObject({applied: [], remaining: ['camera']});
        expect(retry.structuredContent.detailedReturn.command.status).toBe('queued');
      } finally { await t.close(); }
    });

    it('still applies the whole projection in one press when no panel is attached', async () => {
      const t = await setup();
      try {
        await t.call('sync_inspection', t.args);
        // Nothing to wait for without a panel: the projection is committed on
        // the session synchronously, so holding a leg back would be a lie in
        // the other direction.
        const returned = await t.call('return_detailed_view', {sessionId: t.sessionId, snapshot: snapshot(), residues: []});
        expect(returned.structuredContent.detailedReturn).toMatchObject({mode: 'saved', remaining: []});
        expect(returned.structuredContent.detailedReturn.applied).toEqual(expect.arrayContaining(['appearance', 'camera']));
      } finally { await t.close(); }
    });
  });

  /**
   * The last one is not the only one a panel has
   * to draw.
   *
   * Only the final leg used to be remembered against a receipt, and the search
   * for a destination took ready panels only. So the press after an earlier leg
   * was claimed found no target at all — the panel was busy drawing that very
   * leg — and fell through to the no-panel path, which saves the whole
   * projection on the session and answers `remaining: []`. The page read that
   * as the end of the return and clicked Back, over a command the panel had not
   * rendered and a saved revision that had just aged it out.
   */
  describe('a return with more than one leg', () => {
    /** A saved scene the posted snapshot differs from in appearance AND framing. */
    async function attached(t: any) {
      const saved = (await t.call('sync_inspection', t.args)).structuredContent;
      const current = {sessionId: t.sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision};
      const panelId = (await t.call('attach_inspection', current)).structuredContent.panelId;
      return {saved, current, panelId};
    }
    const press = (t: any) => t.call('return_detailed_view', {sessionId: t.sessionId, snapshot: snapshot(), residues: []});
    /** The panel's whole turn: claim what it is holding, paint it, receipt, heartbeat. */
    async function render(t: any, current: Record<string, unknown>, panelId: string) {
      const delivery = (await t.call('poll_inspection', {...current, panelId, availability: 'ready'}))._meta[KEY].delivery;
      const saved = (await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY].scene;
      const receipt = await t.call('complete_inspection', {...current, panelId, commandId: delivery.commandId,
        claimToken: delivery.claimToken, scene: expectedInspection(structuredClone(saved), delivery.change)});
      const committed = (await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY];
      const next = {sessionId: t.sessionId, serverEpoch: committed.serverEpoch, sourceToken: committed.sourceToken,
        baseStateRevision: committed.stateRevision, baseInspectionRevision: committed.inspectionRevision};
      await t.call('poll_inspection', {...next, panelId, availability: 'ready'});
      return {delivery, receipt, current: next};
    }

    it('never answers nothing-left while the panel is still holding an earlier leg', async () => {
      const t = await setup();
      try {
        const {saved, current, panelId} = await attached(t);
        const first = await press(t);
        expect(first.isError).not.toBe(true);
        expect(first.structuredContent.detailedReturn.remaining).toContain('camera');
        expect(first.structuredContent.detailedReturn.command.status).toBe('queued');
        // The panel takes the appearance and goes busy drawing it, which is the
        // only thing it can report between the claim and the receipt.
        const delivery = (await t.call('poll_inspection', {...current, panelId, availability: 'ready'}))._meta[KEY].delivery;
        expect(delivery.change.kind).toBe('appearance');
        await t.call('poll_inspection', {...current, panelId, availability: 'busy'});

        const second = await press(t);
        expect(second.isError).not.toBe(true);
        const detail = second.structuredContent.detailedReturn;
        expect(detail.mode).toBe('panel');
        expect(detail.remaining.length).toBeGreaterThan(0);
        // Nothing was committed behind the panel's back either: the command it
        // is holding is still the only thing that can move the saved scene.
        const after = (await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY];
        expect(after.scene.inspection.appearance.representation).toBe('cartoon');
        expect(after.scene.camera.position).toEqual(camera.position);
        expect(after.inspectionRevision).toBe(saved.inspectionRevision);
      } finally { await t.close(); }
    });

    it('keeps naming work until both legs have their own rendered receipt', async () => {
      const t = await setup();
      try {
        const {current, panelId} = await attached(t);
        const first = await press(t);
        expect(first.structuredContent.detailedReturn).toMatchObject({mode: 'panel', applied: []});
        expect(first.structuredContent.detailedReturn.remaining).toEqual(['appearance', 'camera']);

        const appearance = await render(t, current, panelId);
        expect(appearance.delivery.change.kind).toBe('appearance');
        expect(appearance.receipt.structuredContent.command.status).toBe('rendered');
        const second = await press(t);
        expect(second.structuredContent.detailedReturn).toMatchObject({applied: ['appearance'], remaining: ['camera']});
        expect((await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY].scene.camera.position)
          .toEqual(camera.position);

        const framing = await render(t, appearance.current, panelId);
        expect(framing.delivery.change.kind).toBe('camera');
        const third = await press(t);
        expect(third.structuredContent.detailedReturn).toMatchObject({applied: ['camera'], remaining: []});
        const after = (await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY];
        expect(after.scene.inspection.appearance.representation).toBe('spacefill');
        expect(after.scene.camera.position).toEqual(detailedCamera.position);
      } finally { await t.close(); }
    });

    it('holds a busy panel’s work for it rather than saving the projection behind it', async () => {
      const t = await setup();
      try {
        const {saved, current, panelId} = await attached(t);
        // A Quest panel goes busy for two to five seconds every
        // time the system puts a dialog in front of the wearer. Nothing has been
        // queued yet, and that panel is still where this return belongs.
        await t.call('poll_inspection', {...current, panelId, availability: 'busy'});
        const pressed = await press(t);
        expect(pressed.isError).not.toBe(true);
        const detail = pressed.structuredContent.detailedReturn;
        expect(detail.mode).toBe('panel');
        expect(detail.applied).toEqual([]);
        expect(detail.remaining).toEqual(['appearance', 'camera']);
        expect(detail.command).toMatchObject({status: 'queued', heldForPanel: true});
        const after = (await t.call('get_inspection', {sessionId: t.sessionId}))._meta[KEY];
        expect(after.inspectionRevision).toBe(saved.inspectionRevision);
        expect(after.scene.inspection.appearance.representation).toBe('cartoon');
        // And the moment the dialog goes away the panel is handed that same leg.
        const delivery = (await t.call('poll_inspection', {...current, panelId, availability: 'ready'}))._meta[KEY].delivery;
        expect(delivery.change.kind).toBe('appearance');
      } finally { await t.close(); }
    });
  });

  it('refuses a payload that is not a state snapshot, and one with no saved inspection', async () => {
    const t = await setup();
    try {
      expect((await t.call('return_detailed_view', {sessionId: t.sessionId, snapshot: snapshot()})).isError).toBe(true);
      await t.call('sync_inspection', t.args);
      expect((await t.call('return_detailed_view', {sessionId: t.sessionId, snapshot: {entries: []}})).isError).toBe(true);
      expect((await t.call('return_detailed_view', {sessionId: t.sessionId, snapshot: snapshot(), residues: [descriptor({labelChain: ''})]})).isError).toBe(true);
    } finally { await t.close(); }
  });
});
