import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importDetailed, newestDownloadedSnapshot, open } from '../scripts/detailed-view-cli.js';
import { main as agentMain, parseAgentArgv } from '../scripts/inspection-agent.js';
import { fakeAgentHost, type Call } from './helpers/fake-agent-host.js';

const BINDING = {
  serverEpoch: '11111111-1111-4111-8111-111111111111',
  sourceToken: '22222222-2222-4222-8222-222222222222',
  stateRevision: 4,
  inspectionRevision: 9,
};
const PANELS = [{ panelId: 'quest-panel', surface: 'companion', availability: 'ready', current: true }];
const fakeHost = fakeAgentHost;

const stateReply = (extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text: 'Stereofold inspection state.' }],
  structuredContent: { kind: 'inspection', sessionId: 'session-1', hasScene: true, ...BINDING, panels: PANELS, ...extra },
});

let logged: string[];
let errored: string[];
beforeEach(() => {
  logged = []; errored = [];
  vi.spyOn(console, 'log').mockImplementation(line => { logged.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation(line => { errored.push(String(line)); });
});
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe('pnpm run detailed', () => {
  it('binds itself to the current state, asks this Mac to open the viewer, and hides the page key', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') return stateReply();
      return {
        content: [{ type: 'text', text: 'Full Mol* viewer for this inspection: http://127.0.0.1:5555/detailed#deadbeef' }],
        structuredContent: { detailedView: { url: 'http://127.0.0.1:5555/detailed#deadbeef', port: 5555, snapshotId: 'abc', opened: true,
          openReason: 'opened', carried: ['coordinates', 'camera'], notCarried: ['selection', 'placement'] } },
      };
    });
    try {
      await open(host.statePath);
      expect(host.calls.map(call => call.name)).toEqual(['get_inspection_state', 'open_detailed_view']);
      expect(host.calls[1].arguments).toEqual({
        open: true, serverEpoch: BINDING.serverEpoch, sourceToken: BINDING.sourceToken,
        baseStateRevision: 4, baseInspectionRevision: 9,
      });
      const output = logged.join('\n');
      expect(output).toContain('opening in your Mac browser');
      expect(output).toContain('http://127.0.0.1:5555/detailed#<page key hidden>');
      expect(output).not.toContain('deadbeef');
    } finally { await host.close(); }
  });

  it('says to wait rather than opening a viewer of nothing', async () => {
    const host = await fakeHost(() => stateReply({ hasScene: false }));
    try {
      await expect(open(host.statePath)).rejects.toThrow(/has not saved a scene yet/);
      expect(host.calls.map(call => call.name)).toEqual(['get_inspection_state']);
    } finally { await host.close(); }
  });

  it('relays the host refusal instead of inventing an address', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') return stateReply();
      throw Error('The structure changed while opening the detailed view. Try again.');
    });
    try {
      await expect(open(host.statePath)).rejects.toThrow(/The structure changed while opening/);
    } finally { await host.close(); }
  });
});

describe('pnpm run import-detailed', () => {
  it('sends both legs of the import and waits for each receipt', async () => {
    let leg = 0;
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') {
        return stateReply(call.arguments.commandId ? { command: { commandId: call.arguments.commandId, status: 'rendered' } } : {});
      }
      leg += 1;
      return { content: [{ type: 'text', text: 'Inspection command queued.' }],
        structuredContent: { detailedImport: leg === 1
          ? { applied: ['background', 'opacity'], dropped: ['one extra representation'], changed: true, cameraPending: true }
          : { applied: ['camera'], dropped: ['one extra representation'], changed: false, cameraPending: false } } };
    });
    try {
      await importDetailed('/tmp/saved.molj', host.statePath, { pollMs: 1, timeoutMs: 2_000 });
      const imports = host.calls.filter(call => call.name === 'import_detailed_view');
      expect(imports).toHaveLength(2);
      expect(imports.every(call => call.arguments.filePath === '/tmp/saved.molj')).toBe(true);
      expect(imports.every(call => call.arguments.panelId === 'quest-panel')).toBe(true);
      expect(imports[0].arguments.commandId).not.toBe(imports[1].arguments.commandId);
      expect(logged.join('\n')).toContain('Applied and drawn: background, opacity');
      expect(logged.join('\n')).toContain('Not applied: one extra representation.');
      expect(process.exitCode).toBeUndefined();
    } finally { await host.close(); }
  });

  it('stops after one leg when the panel has nothing new to draw', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') return stateReply();
      return { content: [{ type: 'text', text: 'nothing queued' }],
        structuredContent: { detailedImport: { applied: [], dropped: [], changed: false, cameraPending: false } } };
    });
    try {
      await importDetailed('/tmp/saved.molj', host.statePath, { pollMs: 1, timeoutMs: 2_000 });
      expect(host.calls.filter(call => call.name === 'import_detailed_view')).toHaveLength(1);
      expect(logged.join('\n')).toContain('already matches what the panel is showing');
    } finally { await host.close(); }
  });

  it('reports a receipt that never became a finished draw, and fails', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') {
        return stateReply(call.arguments.commandId ? { command: { commandId: call.arguments.commandId, status: 'conflict' } } : {});
      }
      return { content: [{ type: 'text', text: 'queued' }],
        structuredContent: { detailedImport: { applied: ['background'], dropped: [], changed: true, cameraPending: true } } };
    });
    try {
      await importDetailed('/tmp/saved.molj', host.statePath, { pollMs: 1, timeoutMs: 2_000 });
      expect(logged.join('\n')).toContain('the panel reported conflict');
      expect(process.exitCode).toBe(1);
    } finally { await host.close(); }
  });

  it('refuses a relative path', async () => {
    const host = await fakeHost(() => stateReply());
    try {
      await expect(importDetailed('saved.molj', host.statePath)).rejects.toThrow(/absolute path/);
    } finally { await host.close(); }
  });
});

describe('latest', () => {
  it('picks the newest .molj and ignores everything else in the folder', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-downloads-'));
    try {
      for (const [name, age] of [['old.molj', 3_000], ['new.molj', 1_000], ['newest.molx', 0], ['state.json', 0]] as const) {
        await writeFile(join(directory, name), '{}');
        const when = new Date(Date.now() - age * 1_000);
        await utimes(join(directory, name), when, when);
      }
      expect(await newestDownloadedSnapshot(directory)).toBe(join(directory, 'new.molj'));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('says what to do when nothing has been downloaded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-downloads-'));
    try {
      await expect(newestDownloadedSnapshot(directory)).rejects.toThrow(/choose Download State/);
      await expect(newestDownloadedSnapshot(join(directory, 'absent'))).rejects.toThrow(/has nothing to choose from/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('inspection-agent', () => {
  it('fills a bound command in and prints the host own words', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') return stateReply();
      return { content: [{ type: 'text', text: 'Inspection command queued.' }], structuredContent: { command: { status: 'queued' } } };
    });
    try {
      await agentMain([host.statePath, 'update_inspection', '{"change":{"kind":"appearance","patch":{"labels":true}}}']);
      const sent = host.calls[1];
      expect(sent.name).toBe('update_inspection');
      expect(sent.arguments.serverEpoch).toBe(BINDING.serverEpoch);
      expect(sent.arguments.baseStateRevision).toBe(4);
      expect(sent.arguments.baseInspectionRevision).toBe(9);
      expect(sent.arguments.panelId).toBe('quest-panel');
      expect(String(sent.arguments.commandId)).toMatch(/^cli-/);
      // The host's own sentence, then the receipt this run actually holds.
      expect(logged.join('\n')).toContain('Inspection command queued.');
      expect(logged.join('\n')).toMatch(/Not applied yet/);
      expect(errored.join(' ')).toContain('Filled in from the current inspection state');
    } finally { await host.close(); }
  });

  it('fills a spoken "zoom to the PAM" into one bound focus command', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') return stateReply();
      return { content: [{ type: 'text', text: 'Focus command queued over 3 residues, framed for fill.' }],
        structuredContent: { command: { status: 'queued' }, focus: { framing: 'fill', residueCount: 3 } } };
    });
    try {
      await agentMain([host.statePath, 'focus_selection',
        '{"residues":{"authorChain":"D","authorResidueRange":[5,7]},"framing":"fill","commandId":"pam-1"}']);
      const sent = host.calls[1];
      expect(sent.name).toBe('focus_selection');
      expect(sent.arguments.residues).toEqual({ authorChain: 'D', authorResidueRange: [5, 7] });
      expect(sent.arguments.panelId).toBe('quest-panel');
      // A caller-chosen command ID survives, so the receipt can be checked.
      expect(sent.arguments.commandId).toBe('pam-1');
      expect(sent.arguments.baseInspectionRevision).toBe(9);
      expect(logged.join('\n')).toContain('Focus command queued over 3 residues, framed for fill.');
    } finally { await host.close(); }
  });

  it('never reports a queued command as applied, blur or no blur', async () => {
    // A command that waited out a blurred panel used to print "Applied after
    // the headset view came back", which the CLI could not know. The host had
    // said `queued`.
    let reads = 0;
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') {
        reads += 1;
        // Blurred behind a system dialog once, back on the next read.
        return reads === 1
          ? stateReply({ panels: [{ panelId: 'quest-panel', surface: 'companion', availability: 'busy', current: true }] })
          : stateReply();
      }
      return { content: [{ type: 'text', text: 'Inspection command queued.' }],
        structuredContent: { command: { commandId: 'cmd-1', status: 'queued' } } };
    });
    try {
      await agentMain([host.statePath, 'update_inspection', '{"change":{"kind":"motion","patch":{"state":"spin"}}}']);
      const printed = logged.join('\n');
      expect(printed).toMatch(/Sent after the headset view came back/);
      expect(printed).not.toMatch(/Applied after/);
      expect(printed).toMatch(/Not applied yet: the panel has not drawn it yet \(queued\)/);
      expect(printed).toMatch(/commandId cmd-1/);
    } finally { await host.close(); }
  }, 20_000);

  it('says applied only once --wait has seen a rendered receipt', async () => {
    let reads = 0;
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') {
        reads += 1;
        // First read is the binding; then rendering, then rendered.
        return stateReply(reads <= 1 ? {} : { command: { commandId: 'cmd-1', status: reads === 2 ? 'rendering' : 'rendered' } });
      }
      return { content: [{ type: 'text', text: 'Inspection command queued.' }],
        structuredContent: { command: { commandId: 'cmd-1', status: 'queued' } } };
    });
    try {
      await agentMain([host.statePath, 'update_inspection', '{"change":{"kind":"appearance","patch":{"labels":true}}}', '--wait'],
        { pollMs: 1, timeoutMs: 5_000 });
      expect(logged.join('\n')).toMatch(/Applied: the panel rendered cmd-1/);
      expect(host.calls.filter(call => call.arguments.commandId === 'cmd-1' && call.name === 'get_inspection_state').length).toBeGreaterThan(1);
    } finally { await host.close(); }
  });

  it('says the wait ran out rather than claiming a change nobody saw', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') return stateReply({ command: { commandId: 'cmd-1', status: 'rendering' } });
      return { content: [{ type: 'text', text: 'Inspection command queued.' }],
        structuredContent: { command: { commandId: 'cmd-1', status: 'queued' } } };
    });
    try {
      await agentMain([host.statePath, 'update_inspection', '{"change":{"kind":"appearance","patch":{"labels":true}}}', '--wait'],
        { pollMs: 1, timeoutMs: 30 });
      const printed = logged.join('\n');
      expect(printed).toMatch(/the wait ran out/);
      expect(printed).not.toMatch(/^Applied/m);
    } finally { await host.close(); }
  });

  it('leaves a tool that returns no receipt with nothing extra to say', async () => {
    const host = await fakeHost(() => ({ content: [{ type: 'text', text: 'Said it.' }], structuredContent: {} }));
    try {
      await agentMain([host.statePath, 'say_to_headset', '{"text":"hello"}']);
      expect(logged).toEqual(['Said it.']);
    } finally { await host.close(); }
  });

  it('sends a tool that needs no binding without reading state first', async () => {
    const host = await fakeHost(() => ({ content: [{ type: 'text', text: 'Said it.' }], structuredContent: {} }));
    try {
      await agentMain([host.statePath, 'say_to_headset', '{"text":"hello"}']);
      expect(host.calls.map(call => call.name)).toEqual(['say_to_headset']);
      expect(logged).toEqual(['Said it.']);
    } finally { await host.close(); }
  });

  it('keeps caller-supplied revisions and reads no state', async () => {
    const host = await fakeHost(() => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: {} }));
    try {
      await agentMain([host.statePath, 'open_detailed_view',
        '{"serverEpoch":"e","sourceToken":"s","baseStateRevision":1,"baseInspectionRevision":1}']);
      expect(host.calls).toHaveLength(1);
      expect(host.calls[0].arguments.baseStateRevision).toBe(1);
    } finally { await host.close(); }
  });

  it('summarises inspection state in words, and prints the whole response with --json', async () => {
    const host = await fakeHost(() => stateReply());
    try {
      await agentMain([host.statePath, 'get_inspection_state', '{}']);
      expect(logged.join('\n')).toContain('Saved scene: yes. Panels: companion ready.');
      logged.length = 0;
      await agentMain([host.statePath, 'get_inspection_state', '{}', '--json']);
      expect(JSON.parse(logged[0]).structuredContent.stateRevision).toBe(4);
    } finally { await host.close(); }
  });

  it('turns a host refusal into one sentence, not a stack trace', async () => {
    const host = await fakeHost(() => { throw Error('Tool unavailable'); });
    try {
      await expect(agentMain([host.statePath, 'say_to_headset', '{}'])).rejects.toThrow('Tool unavailable');
    } finally { await host.close(); }
  });
});

describe('reading the inspection-agent command line', () => {
  it('takes a value for --panel and --utterance without eating the tool name', () => {
    expect(parseAgentArgv(['/s.json', 'update_inspection', '{}', '--panel', 'desktop', '--utterance', 'correct', '--wait']))
      .toEqual({ statePath: '/s.json', name: 'update_inspection', payload: '{}', json: false, wait: true,
        panel: 'desktop', utterance: 'correct' });
    expect(parseAgentArgv(['/s.json', 'emphasize', '--panel=companion']))
      .toMatchObject({ name: 'emphasize', payload: '{}', panel: 'companion' });
  });

  it('names what it takes rather than passing a typo to the host', () => {
    expect(() => parseAgentArgv(['/s.json', 'emphasize', '--panel', 'headset'])).toThrow(/--panel takes companion, desktop, detailed/u);
    expect(() => parseAgentArgv(['/s.json', 'emphasize', '--utterance', 'undo'])).toThrow(/--utterance takes begin, correct, cancel/u);
    expect(() => parseAgentArgv(['/s.json', 'emphasize', '--panel', '--wait'])).toThrow(/--panel needs a value/u);
    expect(() => parseAgentArgv(['/s.json', 'emphasize', '--quiet'])).toThrow(/Unknown flag --quiet/u);
    expect(() => parseAgentArgv(['/s.json'])).toThrow(/Usage/u);
  });
});

describe('--panel names the surface', () => {
  const twoPanels = [
    { panelId: 'desk-panel', surface: 'desktop', availability: 'ready', current: true },
    { panelId: 'quest-panel', surface: 'companion', availability: 'ready', current: true },
  ];

  // The default is the headset, because that is the view the person asking is
  // in. `return-to-desktop` is the case where that default is wrong: the
  // server refuses it anywhere but a desktop panel.
  it('sends to the Mac tab when asked, instead of the panel the wearer is in', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') return stateReply({ panels: twoPanels });
      return { content: [{ type: 'text', text: 'Restore named-view command queued.' }],
        structuredContent: { command: { commandId: 'view-1', status: 'queued' } } };
    });
    try {
      await agentMain([host.statePath, 'manage_inspection_view',
        '{"action":"return-to-desktop","viewId":"33333333-3333-4333-8333-333333333333"}', '--panel', 'desktop']);
      const sent = host.calls.at(-1)!;
      expect(sent.name).toBe('manage_inspection_view');
      expect(sent.arguments.panelId).toBe('desk-panel');
      expect(sent.arguments.baseInspectionRevision).toBe(9);
      expect(String(sent.arguments.commandId)).toMatch(/^cli-/u);
      expect(errored.join('\n')).toContain('--panel desktop is desk-panel.');
    } finally { await host.close(); }
  });

  it('refuses rather than falling back to another surface', async () => {
    const host = await fakeHost(() => stateReply({ panels: [twoPanels[1]] }));
    try {
      await expect(agentMain([host.statePath, 'update_inspection', '{"change":{"kind":"appearance","patch":{"labels":true}}}',
        '--panel', 'desktop'])).rejects.toThrow(/No current desktop panel/u);
    } finally { await host.close(); }
  });

  it('will not take a surface and a panelId for the same call', async () => {
    const host = await fakeHost(() => stateReply({ panels: twoPanels }));
    try {
      await expect(agentMain([host.statePath, 'update_inspection', '{"panelId":"quest-panel","change":{"kind":"motion","patch":{"state":"stop"}}}',
        '--panel', 'desktop'])).rejects.toThrow(/name the same thing/u);
    } finally { await host.close(); }
  });
});

describe('--utterance declares the correction before the command', () => {
  const lifecycle = (utteranceId: string, dropped: number) => ({
    content: [{ type: 'text', text: 'Utterance correct recorded.' }],
    structuredContent: { lifecycle: { action: 'correct', rendered: false, utterance: { utteranceId, sequence: 4 },
      commands: Array.from({ length: dropped }, (_, index) => ({ commandId: `old-${index}`, status: 'cancelled' })) } },
  });

  it('sends the utterance first and threads its ID into the command it wraps', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') return stateReply();
      if (call.name === 'update_inspection') return lifecycle('utt-4', 2);
      return { content: [{ type: 'text', text: 'Focus command queued.' }],
        structuredContent: { command: { commandId: 'focus-1', status: 'queued' } } };
    });
    try {
      await agentMain([host.statePath, 'focus_selection', '{"residues":{"authorChain":"A"}}', '--utterance', 'correct']);
      const sent = host.calls.filter(call => call.name === 'update_inspection' || call.name === 'focus_selection');
      expect(sent.map(call => call.name)).toEqual(['update_inspection', 'focus_selection']);
      expect(sent[0].arguments.change).toEqual({ kind: 'utterance', patch: { action: 'correct' } });
      expect(sent[0].arguments.panelId).toBe('quest-panel');
      expect(sent[1].arguments.utteranceId).toBe('utt-4');
      const note = errored.join('\n');
      expect(note).toContain('Utterance correct: utt-4, sequence 4.');
      expect(note).toContain('2 earlier pending commands were dropped');
      expect(note).toContain('undoes nothing that already rendered');
    } finally { await host.close(); }
  });

  it('declares the utterance the caller named rather than allocating another', async () => {
    const host = await fakeHost(call => {
      if (call.name === 'get_inspection_state') return stateReply();
      if (call.name === 'update_inspection' && (call.arguments.change as any)?.kind === 'utterance') return lifecycle('spoken-9', 0);
      return { content: [{ type: 'text', text: 'Inspection command queued.' }],
        structuredContent: { command: { commandId: 'cmd-1', status: 'queued' } } };
    });
    try {
      await agentMain([host.statePath, 'update_inspection',
        '{"utteranceId":"spoken-9","change":{"kind":"appearance","patch":{"representation":"ball-and-stick"}}}', '--utterance', 'cancel']);
      expect(host.calls.filter(call => call.name === 'update_inspection')[0].arguments.utteranceId).toBe('spoken-9');
      expect(errored.join('\n')).toContain('Utterance cancel: spoken-9');
    } finally { await host.close(); }
  });

  it('says a tool takes no utterance instead of adding a field it would refuse', async () => {
    const host = await fakeHost(() => stateReply());
    try {
      await expect(agentMain([host.statePath, 'get_inspection_state', '{}', '--utterance', 'begin']))
        .rejects.toThrow(/get_inspection_state does not take an utteranceId/u);
      expect(host.calls).toHaveLength(0);
    } finally { await host.close(); }
  });

  it('refuses when the host recorded the utterance but named none', async () => {
    const host = await fakeHost(call => (call.name === 'get_inspection_state' ? stateReply()
      : { content: [{ type: 'text', text: 'Recorded.' }], structuredContent: {} }));
    try {
      await expect(agentMain([host.statePath, 'emphasize', '{"parts":["guide RNA"]}', '--utterance', 'begin']))
        .rejects.toThrow(/returned no utterance ID/u);
    } finally { await host.close(); }
  });
});

describe('--wait on a replaced source', () => {
  const replaced = {
    content: [{ type: 'text', text: 'Stereofold session opened.' }],
    structuredContent: { kind: 'inspect', hasStructure: true, sourceTransition: { sourceChanged: true, pdbId: '9KJ6' } },
  };
  const loading = () => stateReply({ hasScene: false, sourceKind: 'pdb',
    panels: [{ panelId: 'quest-panel', surface: 'companion', availability: 'busy', current: true }] });
  // A replaced source is a new source token; a scene still on the old one is
  // the structure that was there before, however ready its panel is.
  const settled = () => stateReply({ hasScene: true, sourceKind: 'pdb', sourceToken: 'replaced-source',
    sourceSelection: { modelNumber: 1, assemblyId: 'asymmetric_unit' } });
  const stillOld = () => stateReply({ hasScene: true, sourceKind: 'pdb',
    sourceSelection: { modelNumber: 1, assemblyId: 'asymmetric_unit' } });
  /**
   * The first read binds the call and finds a ready panel, exactly as the
   * server requires; every read after it is the panel rebuilding the new
   * source, which is what the wait is for.
   */
  const rebuilding = (after: () => unknown) => {
    let reads = 0;
    return (call: Call) => {
      if (call.name !== 'get_inspection_state') return replaced;
      reads += 1;
      return reads === 1 ? stateReply() : after();
    };
  };

  // `replace_inspection_source` answers as soon as the coordinates are
  // verified and swapped, which is several seconds before any panel has drawn
  // them. Reporting the new structure from that answer is acknowledging
  // before rendering in another shape.
  it('follows the panels back to a saved scene before naming the new source', async () => {
    let reads = 0;
    const host = await fakeHost(rebuilding(() => { reads += 1; return reads <= 2 ? loading() : settled(); }));
    try {
      await agentMain([host.statePath, 'replace_inspection_source', '{"pdbId":"9KJ6"}', '--wait'],
        { pollMs: 1, timeoutMs: 5_000 });
      const printed = logged.join('\n');
      expect(printed).toContain('Now loaded: source pdb, model 1, assembly asymmetric_unit.');
      expect(printed).toMatch(/Drawn and saved after \d+\.\d s/u);
    } finally { await host.close(); }
  });

  it('says nothing drew rather than reporting a structure nobody saw', async () => {
    const host = await fakeHost(rebuilding(loading));
    try {
      await agentMain([host.statePath, 'replace_inspection_source', '{"pdbId":"9KJ6"}', '--wait'],
        { pollMs: 1, timeoutMs: 30 });
      const printed = logged.join('\n');
      expect(printed).toMatch(/Not drawn yet: the source was replaced but no panel has saved it/u);
      expect(printed).toContain('companion busy');
      expect(printed).not.toContain('Now loaded');
    } finally { await host.close(); }
  });

  it('never counts a settled scene that is still on the replaced source', async () => {
    const host = await fakeHost(rebuilding(stillOld));
    try {
      await agentMain([host.statePath, 'replace_inspection_source', '{"pdbId":"9KJ6"}', '--wait'],
        { pollMs: 1, timeoutMs: 30 });
      const printed = logged.join('\n');
      expect(printed).toMatch(/Not drawn yet/u);
      expect(printed).not.toContain('Now loaded');
    } finally { await host.close(); }
  });

  it('asks the host to wait for the selected renderer and believes only its receipt', async () => {
    const answer = (receipt: unknown) => ({
      content: [{ type: 'text', text: 'Stereofold session opened.' }],
      structuredContent: { kind: 'inspect', hasStructure: true, sourceTransition: { sourceChanged: true, pdbId: '9KJ6' },
        sourceRenderReceipt: receipt, renderWait: { timedOut: receipt === null, reason: receipt === null ? 'Timed out.' : null } },
    });
    const drew = await fakeHost(call => call.name === 'get_inspection_state' ? settled() : answer({ status: 'rendered', panelId: 'quest-panel' }));
    try {
      await agentMain([drew.statePath, 'replace_inspection_source', '{"pdbId":"9KJ6"}', '--wait'], { pollMs: 1, timeoutMs: 5_000 });
      const sent = drew.calls.find(call => call.name === 'replace_inspection_source')!;
      expect(sent.arguments.waitForRenderMs).toBe(5_000);
      expect(logged.join('\n')).toContain('Now loaded: source pdb, model 1, assembly asymmetric_unit.');
    } finally { await drew.close(); }
    logged = [];
    // The host timed out: another panel being ready on some scene is not a render of this source.
    const missed = await fakeHost(call => call.name === 'get_inspection_state' ? settled() : answer(null));
    try {
      await agentMain([missed.statePath, 'replace_inspection_source', '{"pdbId":"9KJ6"}', '--wait'], { pollMs: 1, timeoutMs: 5_000 });
      const printed = logged.join('\n');
      expect(printed).toMatch(/Not drawn yet/u);
      expect(printed).not.toContain('Now loaded');
    } finally { await missed.close(); }
  });

  it('leaves the same wait out of a run that did not ask for it', async () => {
    const host = await fakeHost(rebuilding(loading));
    try {
      await agentMain([host.statePath, 'replace_inspection_source', '{"pdbId":"9KJ6"}']);
      // One read to bind the call, and no follow-up polling.
      expect(host.calls.filter(call => call.name === 'get_inspection_state')).toHaveLength(1);
      expect(logged.join('\n')).not.toContain('Now loaded');
    } finally { await host.close(); }
  });

  it('records what the wait saw in the JSON a scripted caller reads', async () => {
    const host = await fakeHost(rebuilding(settled));
    try {
      await agentMain([host.statePath, 'replace_inspection_source', '{"pdbId":"9KJ6"}', '--wait', '--json'],
        { pollMs: 1, timeoutMs: 5_000 });
      expect(JSON.parse(logged[0]).structuredContent.sceneSettled).toMatchObject({ settled: true });
    } finally { await host.close(); }
  });
});
