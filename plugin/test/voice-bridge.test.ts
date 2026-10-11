import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchTier0, normalizeBridgeTranscript } from '../scripts/voice-bridge-tier0.js';
import {
  BRIDGE_ACK_TEXT, BRIDGE_FAILURE_TEXT, callTier1Model, createRateLimiter, decideUtterance, fillBridgeBinding, handleUtterance,
  pageClaimsAction, redactForLog, shortenForSpeech, stripWakePrefix, summarizeInspectionState,
  tier1Confirmation, tier1Tools, validateTier1Call, waitForBridgeReceipt,
  type InspectionSummary,
} from '../scripts/voice-bridge.js';

const SUMMARY: InspectionSummary = {
  hasScene: true, scale: 1, selectedResidueCount: 4,
  lesson: { id: 'cas9', title: 'CRISPR Cas9', parts: [{ id: 'guide-rna', label: 'guide RNA' }, { id: 'pam', label: 'PAM' }] },
  tours: [{ id: 'fold-detective', title: 'Fold detective' }],
  readyPanels: 1,
};

const BINDING_STATE = {
  serverEpoch: '11111111-1111-4111-8111-111111111111',
  sourceToken: '22222222-2222-4222-8222-222222222222',
  stateRevision: 7,
  inspectionRevision: 3,
  panels: [
    { panelId: '33333333-3333-4333-8333-333333333333', surface: 'companion', availability: 'ready', current: true },
    { panelId: '44444444-4444-4444-8444-444444444444', surface: 'desktop', availability: 'ready', current: true },
  ],
};

type MappingRow = [phrase: string, tool: string, check: (change: any, fields: any) => void, say: string];

const placementScale = (scale: number) => ({ change: { kind: 'placement', patch: { scale } } });

/** Every Tier 0 phrase the bridge promises, with the tool call it maps to. */
const MAPPING_ROWS: MappingRow[] = [
  ['make it small', 'update_inspection', ({ kind, patch }: any) => expect({ kind, scale: patch.scale }).toEqual({ kind: 'placement', scale: 0.67 }), 'Smaller.'],
  ['small', 'update_inspection', ({ kind, patch }: any) => expect(kind).toBe('placement'), 'Smaller.'],
  ['smaller', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBeCloseTo(0.67, 2), 'Smaller.'],
  ['make it smaller', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBeCloseTo(0.67, 2), 'Smaller.'],
  ['little', 'update_inspection', ({ kind }: any) => expect(kind).toBe('placement'), 'Smaller.'],
  ['tiny', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(0.5), 'Much smaller.'],
  ['make it tiny', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(0.5), 'Much smaller.'],
  ['teeny tiny', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(0.5), 'Much smaller.'],
  ['big', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(1.5), 'Bigger.'],
  ['make it big', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(1.5), 'Bigger.'],
  ['bigger', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(1.5), 'Bigger.'],
  ['make it bigger', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(1.5), 'Bigger.'],
  ['larger', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(1.5), 'Bigger.'],
  ['make it larger', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(1.5), 'Bigger.'],
  ['enlarge', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(1.5), 'Bigger.'],
  ['huge', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(2), 'Much bigger.'],
  ['make it huge', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(2), 'Much bigger.'],
  ['enormous', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(2), 'Much bigger.'],
  ['giant', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(2), 'Much bigger.'],
  ['twice as big', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(2), 'Twice as big.'],
  ['double it', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(2), 'Twice as big.'],
  ['half', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(0.5), 'Half size.'],
  ['half the size', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(0.5), 'Half size.'],
  ['halve it', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(0.5), 'Half size.'],
  ['much bigger', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(2), 'Much bigger.'],
  ['much smaller', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(0.5), 'Much smaller.'],
  ['a lot bigger', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(2), 'Much bigger.'],
  ['slightly bigger', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBe(1.25), 'Bigger.'],
  ['a little smaller', 'update_inspection', ({ kind, patch }: any) => expect(patch.scale).toBeCloseTo(0.8, 2), 'Smaller.'],
  ['size 2', 'update_inspection', ({ kind, patch }: any) => expect(patch).toEqual({ scale: 2 }), 'Size set.'],
  ['scale to 1.5', 'update_inspection', ({ kind, patch }: any) => expect(patch).toEqual({ scale: 1.5 }), 'Size set.'],
  ['200 percent', 'update_inspection', ({ kind, patch }: any) => expect(patch).toEqual({ scale: 2 }), 'Size set.'],
  ['spin', 'update_inspection', ({ kind, patch }: any) => expect({ kind, ...patch }).toEqual({ kind: 'motion', state: 'spin' }), 'Spinning.'],
  ['halt', 'update_inspection', ({ kind, patch }: any) => expect({ kind, ...patch }).toEqual({ kind: 'motion', state: 'stop' }), 'Stopped.'],
  ['stop', 'update_inspection', ({ kind, patch }: any) => expect(patch).toEqual({ state: 'stop' }), 'Stopped.'],
  ['next', 'control_tour', ({ action }: any) => expect(action).toBe('next'), 'Next step.'],
  ['back', 'control_tour', ({ action }: any) => expect(action).toBe('back'), 'Back one step.'],
  ['previous', 'control_tour', ({ action }: any) => expect(action).toBe('back'), 'Back one step.'],
  ['pause', 'control_tour', ({ action }: any) => expect(action).toBe('pause'), 'Tour paused.'],
  ['play the tour', 'control_tour', ({ action }: any) => expect(action).toBe('play'), 'Tour started.'],
  ['resume the tour', 'control_tour', ({ action }: any) => expect(action).toBe('play'), 'Tour started.'],
  ['continue', 'control_tour', ({ action }: any) => expect(action).toBe('play'), 'Tour started.'],
  ['unpause', 'control_tour', ({ action }: any) => expect(action).toBe('play'), 'Tour started.'],
  ['skip ahead', 'control_tour', ({ action }: any) => expect(action).toBe('next'), 'Next step.'],
  ['tour menu', 'control_tour', ({ action }: any) => expect(action).toBe('menu'), 'Tour menu.'],
  ['max quality', 'update_inspection', ({ kind, patch }: any) => expect({ kind, ...patch }).toEqual({ kind: 'render-quality', level: 'best' }), 'Max quality.'],
  ['maximum quality', 'update_inspection', ({ kind, patch }: any) => expect(patch).toEqual({ level: 'best' }), 'Max quality.'],
  ['high quality', 'update_inspection', ({ kind, patch }: any) => expect(patch).toEqual({ level: 'best' }), 'Max quality.'],
  ['make it look better', 'update_inspection', ({ kind, patch }: any) => expect(patch).toEqual({ level: 'best' }), 'Max quality.'],
  ['low quality', 'update_inspection', ({ kind, patch }: any) => expect(patch).toEqual({ level: 'fast' }), 'Fast.'],
  ['medium quality', 'update_inspection', ({ kind, patch }: any) => expect(patch).toEqual({ level: 'balanced' }), 'Balanced.'],
  ['reset', 'focus_selection', (_change: any, fields: any) => expect(fields).toEqual({ framing: 'context' }), 'Whole structure.'],
  ['show everything', 'focus_selection', (_change: any, fields: any) => expect(fields).toEqual({ framing: 'context' }), 'Whole structure.'],
  ['reset view', 'focus_selection', (_change: any, fields: any) => expect(fields).toEqual({ framing: 'context' }), 'Whole structure.'],
];

void placementScale;

describe('tier 0 mapping', () => {
  it.each(MAPPING_ROWS)('maps %s', (phrase, tool, check, say) => {
    const normalized = normalizeBridgeTranscript(phrase);
    expect(normalized).toBeDefined();
    const decision = matchTier0(normalized!, { scale: 1 });
    expect(decision?.tool).toBe(tool);
    check((decision as any).change, (decision as any).fields);
    expect((decision as any).say).toBe(say);
    expect((decision as any).say.split(/\s+/).length).toBeLessThan(6);
  });

  it('tolerates filler around a command', () => {
    expect(matchTier0(normalizeBridgeTranscript('ok, make it small please')!, { scale: 1 })?.say).toBe('Smaller.');
    expect(matchTier0(normalizeBridgeTranscript('Please, twice as big!')!, { scale: 1 })?.say).toBe('Twice as big.');
  });

  it('scales relative to the saved placement beyond the old four-times ceiling', () => {
    expect(matchTier0('twice as big', { scale: 2 })?.change).toEqual({ kind: 'placement', patch: { scale: 4 } });
    expect(matchTier0('twice as big', { scale: 3 })?.change).toEqual({ kind: 'placement', patch: { scale: 6 } });
    expect(matchTier0('size 99', { scale: 1 })?.change).toEqual({ kind: 'placement', patch: { scale: 99 } });
    expect(matchTier0('half', {})?.change).toEqual({ kind: 'placement', patch: { scale: 0.5 } });
  });

  it('leaves non-tier-0 speech unmatched', () => {
    expect(matchTier0('what is the control to make it bigger', { scale: 1 })).toBeUndefined();
    expect(matchTier0('show me the guide rna', { scale: 1 })).toBeUndefined();
    expect(matchTier0('hello there', { scale: 1 })).toBeUndefined();
  });

  it('matches the whole table in well under the 50 ms budget', () => {
    const phrases = MAPPING_ROWS.map(([phrase]) => phrase);
    const started = performance.now();
    for (const phrase of phrases) matchTier0(phrase, { scale: 1 });
    const elapsed = performance.now() - started;
    console.log(`tier0-table: ${phrases.length} phrases in ${elapsed.toFixed(2)} ms (mean ${(elapsed / phrases.length * 1000).toFixed(1)} us)`);
    expect(elapsed).toBeLessThan(50);
  });
});

/**
 * The Tier 0 table split by what the page resolver claims today. Derived by
 * running the real pageClaimsAction over every mapped phrase, so a grammar
 * change that claims a synonym moves it to the yield list instead of failing
 * here: the bridge defers to the page first and never fires twice.
 */
const PAGE_OWNED_TIER0 = MAPPING_ROWS.map(([phrase]) => phrase).filter(phrase => pageClaimsAction(phrase));
const PAGE_MISSED_TIER0 = MAPPING_ROWS.map(([phrase]) => phrase).filter(phrase => !pageClaimsAction(phrase));

describe('routing: the page acts first, the bridge fills the gaps', () => {
  it('yields phrases the page already executes', () => {
    for (const phrase of new Set(['bigger', 'smaller', 'spin', 'stop', 'next', 'back', 'pause', 'play the tour', 'reset', 'spin it', 'turn it', ...PAGE_OWNED_TIER0])) {
      expect(pageClaimsAction(phrase), phrase).toBe(true);
      expect(decideUtterance({ raw: phrase, summary: SUMMARY }).route).toBe('page');
    }
  });

  it('takes the page-missed synonyms to tier 0', () => {
    // Spot-checks a reader can verify: multipliers, tour resumes, quality
    // tiers and reframes the page grammar still misses.
    expect(PAGE_MISSED_TIER0).toContain('twice as big');
    expect(PAGE_MISSED_TIER0).toContain('half');
    expect(PAGE_MISSED_TIER0).toContain('resume the tour');
    expect(PAGE_MISSED_TIER0).toContain('max quality');
    expect(PAGE_MISSED_TIER0).toContain('show everything');
    expect(PAGE_MISSED_TIER0.length).toBeGreaterThan(0);
    for (const phrase of PAGE_MISSED_TIER0) {
      expect(pageClaimsAction(phrase), phrase).toBe(false);
      const decision = decideUtterance({ raw: phrase, summary: SUMMARY });
      expect(decision.route, phrase).toBe('tier0');
    }
  });

  it('sends the rest to tier 1', () => {
    for (const phrase of ['what is the control to make it bigger', 'why is this spinning so slowly', 'show me something interesting']) {
      expect(pageClaimsAction(phrase), phrase).toBe(false);
      expect(decideUtterance({ raw: phrase, summary: SUMMARY }).route).toBe('tier1');
    }
  });

  it('gates on the wake word only when configured', () => {
    // A tier-0-only synonym: the page must not claim it, or the gate below
    // would read the page route instead of the wake gate.
    const phrase = 'twice as big';
    expect(PAGE_MISSED_TIER0).toContain(phrase);
    expect(decideUtterance({ raw: phrase, summary: SUMMARY }).route).toBe('tier0');
    expect(decideUtterance({ raw: phrase, prefix: 'claude', summary: SUMMARY })).toEqual({ route: 'ignored', reason: 'prefix-missing' });
    expect(decideUtterance({ raw: `claude, ${phrase}`, prefix: 'claude', summary: SUMMARY }).route).toBe('tier0');
    expect(stripWakePrefix('claude', 'claude')).toBeUndefined();
  });
});

describe('inspection state summary', () => {
  it('reads scale, selection, lesson and tours for the model', () => {
    const summary = summarizeInspectionState({
      hasScene: true,
      view: { selectedResidueCount: 12, inspection: { placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 2 } } },
      lesson: { id: 'cas9', title: 'CRISPR', parts: [{ id: 'pam', label: 'PAM' }] },
      tours: [{ id: 'fold-detective', title: 'Fold' }],
      panels: [{ current: true, availability: 'ready' }],
    });
    expect(summary).toEqual({
      hasScene: true, scale: 2, selectedResidueCount: 12,
      lesson: { id: 'cas9', title: 'CRISPR', parts: [{ id: 'pam', label: 'PAM' }] },
      tours: [{ id: 'fold-detective', title: 'Fold' }],
      readyPanels: 1,
    });
  });
});

describe('binding fill', () => {
  const readState = async () => ({ structuredContent: BINDING_STATE });

  it('fills the session binding, panel and command id for tier 0 tools', async () => {
    for (const tool of ['update_inspection', 'control_tour', 'focus_selection']) {
      const { args } = await fillBridgeBinding(
        { origin: 'http://127.0.0.1:1', token: 't', sessionId: 's' },
        tool, { change: { kind: 'motion', patch: { state: 'spin' } } }, readState);
      expect(args.serverEpoch).toBe(BINDING_STATE.serverEpoch);
      expect(args.sourceToken).toBe(BINDING_STATE.sourceToken);
      expect(args.baseStateRevision).toBe(7);
      expect(args.baseInspectionRevision).toBe(3);
      // The companion wins: it is the view the wearer is in.
      expect(args.panelId).toBe('33333333-3333-4333-8333-333333333333');
      expect(args.commandId).toMatch(/^vb-[a-z0-9-]+$/);
    }
  });

  it('refuses rather than guesses when no panel is ready', async () => {
    await expect(fillBridgeBinding(
      { origin: 'http://127.0.0.1:1', token: 't', sessionId: 's' },
      'update_inspection', { change: { kind: 'motion', patch: { state: 'spin' } } },
      async () => ({ structuredContent: { ...BINDING_STATE, panels: [] } }),
    )).rejects.toThrow();
  });
});

describe('tier 1 validation', () => {
  it('offers the same numerical placement range that its runtime accepts', () => {
    const tool:any=tier1Tools(SUMMARY).find(tool=>tool.name==='update_inspection');
    const placement=tool.input_schema.properties.change.oneOf.find((choice:any)=>choice.properties.kind.const==='placement');
    expect(placement.properties.patch.properties.scale).toEqual({type:'number',minimum:1e-6,maximum:1e6});
    expect(placement.properties.patch.properties.translation.items).toEqual({type:'number',minimum:-1e6,maximum:1e6});
    for(const scale of [1e-6,.01,8,100,1e6]) {
      const args={change:{kind:'placement',patch:{scale,translation:[12,-20,30]}}};
      expect(validateTier1Call('update_inspection',args,SUMMARY)).toEqual({kind:'tool',name:'update_inspection',args});
    }
    for(const patch of [{scale:0},{scale:1e-7},{scale:1e6+1},{scale:Infinity},{translation:[1e6+1,0,0]},{translation:[NaN,0,0]}])
      expect(validateTier1Call('update_inspection',{change:{kind:'placement',patch}},SUMMARY).kind).toBe('refused');
  });

  it('accepts the offered tools with sane arguments', () => {
    expect(validateTier1Call('update_inspection', { change: { kind: 'motion', patch: { state: 'spin' } } }, SUMMARY))
      .toEqual({ kind: 'tool', name: 'update_inspection', args: { change: { kind: 'motion', patch: { state: 'spin' } } } });
    expect(validateTier1Call('control_tour', { action: 'next' }, SUMMARY).kind).toBe('tool');
    expect(validateTier1Call('focus_selection', { framing: 'fill' }, SUMMARY).kind).toBe('tool');
    expect(validateTier1Call('emphasize', { parts: ['guide RNA'] }, SUMMARY)).toEqual(
      { kind: 'tool', name: 'emphasize', args: { parts: ['guide RNA'] } });
  });

  it('refuses destructive, navigating, and out-of-range calls', () => {
    for (const [name, args] of [
      ['manage_companion', { action: 'status' }],
      ['open_companion', { connection: 'lan' }],
      ['update_inspection', { change: { kind: 'placement', patch: { scale: 1000001 } } }],
      ['update_inspection', { change: { kind: 'selection', patch: { selectionKeys: ['x'] } } }],
      ['control_tour', { action: 'start', tourId: 'evil' }],
      ['focus_selection', { framing: 'fill', residues: { authorChain: 'B' } }],
      ['emphasize', { parts: ['mitochondria'] }],
      ['emphasize', { parts: [] }],
      ['say_to_headset', { text: 'hi' }],
    ] as [string, any][]) {
      expect(validateTier1Call(name, args, SUMMARY).kind, `${name} ${JSON.stringify(args)}`).toBe('refused');
    }
  });
});

describe('tier 1 over a stubbed model', () => {
  const control = { origin: 'http://127.0.0.1:1', token: 't', sessionId: 's' };
  const readState = async () => ({ structuredContent: BINDING_STATE });

  const stubFetch = (content: any[]) => async () => ({ ok: true, status: 200, json: async () => ({ content }) });

  function harness(receipt: { status: string; reason?: string } = { status: 'rendered' }, opts: { throwTool?: string } = {}) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const logs: Record<string, unknown>[] = [];
    const escalations: string[] = [];
    return {
      calls, logs, escalations,
      deps: {
        callAgent: async (_state: unknown, name: string, args: Record<string, unknown> = {}) => {
          calls.push({ name, args });
          if (name === 'get_inspection_state' && (args as any).commandId) {
            return {
              structuredContent: {
                command: {
                  commandId: (args as any).commandId, status: receipt.status,
                  ...(receipt.reason ? { reason: receipt.reason } : {}),
                },
              },
            };
          }
          if (opts.throwTool && name === opts.throwTool) throw Error(`refused ${name}`);
          if (name === 'update_inspection' || name === 'control_tour' || name === 'focus_selection' || name === 'emphasize') {
            return { structuredContent: { command: { commandId: (args as any).commandId, status: 'queued' } } };
          }
          return { structuredContent: {} };
        },
        readState,
        logLine: (entry: Record<string, unknown>) => { logs.push(entry); },
        appendEscalation: async (line: string) => { escalations.push(line); },
        receiptWait: { pollMs: 1, timeoutMs: 500 },
      },
    };
  }

  const saidTexts = (calls: { name: string; args: Record<string, unknown> }[]) =>
    calls.filter(call => call.name === 'say_to_headset').map(call => String((call.args as any).text));

  it('executes one stubbed tool call with binding and confirmation', async () => {
    const { calls, logs, escalations, deps } = harness();
    const started = performance.now();
    const outcome = await handleUtterance({
      control, raw: 'start spinning the molecule', utteranceId:'u-loop', summary: SUMMARY,
      decision: { route: 'tier1' },
      deps: {
        ...deps,
        tier1: () => callTier1Model({
          utterance: 'start spinning the molecule', summary: SUMMARY,
          environment: { ANTHROPIC_API_KEY: 'test-key' },
          fetchFn: stubFetch([{ type: 'tool_use', name: 'update_inspection', input: { change: { kind: 'motion', patch: { state: 'spin' } } } }]),
        }),
      },
    });
    const elapsed = performance.now() - started;
    console.log(`tier1-stubbed-tool: ${elapsed.toFixed(2)} ms end to end (model stubbed)`);
    expect(outcome.route).toBe('tier1');
    expect(calls.map(call => call.name)).toEqual(['update_inspection', 'say_to_headset', 'get_inspection_state', 'say_to_headset']);
    expect((calls[0].args as any).panelId).toBe('33333333-3333-4333-8333-333333333333');
    expect((calls[0].args as any).change).toEqual({ kind: 'motion', patch: { state: 'spin' } });
    expect(saidTexts(calls)).toEqual([BRIDGE_ACK_TEXT, 'Spinning.']);
    expect(calls[0].args).toMatchObject({utteranceId:'u-loop',actionPostedAt:expect.any(Number)});
    expect(calls.at(-1)?.args).toMatchObject({utteranceId:'u-loop',commandId:expect.any(String)});
    expect(escalations).toEqual([]);
    expect(elapsed).toBeLessThan(2000);
    expect(logs.length).toBe(1);
  });

  it('dispatches an explored placement from a stubbed model unchanged through the rendered receipt', async () => {
    const {calls,escalations,deps}=harness();
    const change={kind:'placement',patch:{scale:8,translation:[12,-20,30]}};
    const outcome=await handleUtterance({control,raw:'set the molecule to eight times its size and move it over there',
      summary:SUMMARY,decision:{route:'tier1'},deps:{...deps,
        tier1:()=>callTier1Model({utterance:'use this explored placement',summary:SUMMARY,
          environment:{ANTHROPIC_API_KEY:'test-key'},
          fetchFn:stubFetch([{type:'tool_use',name:'update_inspection',input:{change}}])})}});
    expect(outcome).toMatchObject({route:'tier1',tool:'update_inspection',receipt:'rendered'});
    expect(calls.find(call=>call.name==='update_inspection')?.args.change).toEqual(change);
    expect(escalations).toEqual([]);
  });

  it('speaks a short model answer and escalates it for the orchestrator', async () => {
    const { calls, escalations, deps } = harness();
    const outcome = await handleUtterance({
      control, raw: 'what is the control to make it bigger', summary: SUMMARY,
      decision: { route: 'tier1' },
      deps: {
        ...deps,
        tier1: () => callTier1Model({
          utterance: 'what is the control to make it bigger', summary: SUMMARY,
          environment: { ANTHROPIC_API_KEY: 'test-key' },
          fetchFn: stubFetch([{ type: 'text', text: 'Say bigger, or press plus.' }]),
        }),
      },
    });
    expect(outcome).toMatchObject({ route: 'tier1', escalated: true });
    expect(calls.map(call => call.name)).toEqual(['say_to_headset']);
    expect((calls[0].args as any).text).toBe('Say bigger, or press plus.');
    expect(escalations.length).toBe(1);
    expect(escalations[0]).toContain('what is the control to make it bigger');
  });

  it('truncates a long model answer for speech but escalates it whole', () => {
    expect(shortenForSpeech('one two three four five six seven eight nine ten eleven twelve thirteen'))
      .toBe('one two three four five six seven eight nine ten eleven twelve');
  });

  it('says something short and escalates when no model key is configured', async () => {
    const { calls, escalations, deps } = harness();
    const outcome = await handleUtterance({
      control, raw: 'surprise me', summary: SUMMARY, decision: { route: 'tier1' },
      deps: { ...deps, tier1: () => callTier1Model({ utterance: 'surprise me', summary: SUMMARY, environment: {} }) },
    });
    expect(outcome).toMatchObject({ route: 'tier1', say: 'No model configured.', escalated: true });
    expect((calls[0].args as any).text).toBe('No model configured.');
    expect(escalations.length).toBe(1);
  });

  it('refuses a model-proposed destructive tool and escalates', async () => {
    const { calls, escalations, deps } = harness();
    await handleUtterance({
      control, raw: 'do something drastic', summary: SUMMARY, decision: { route: 'tier1' },
      deps: {
        ...deps,
        tier1: () => callTier1Model({
          utterance: 'do something drastic', summary: SUMMARY,
          environment: { ANTHROPIC_API_KEY: 'test-key' },
          fetchFn: stubFetch([{ type: 'tool_use', name: 'manage_companion', input: { action: 'status' } }]),
        }),
      },
    });
    expect(calls.map(call => call.name)).toEqual(['say_to_headset']);
    expect(escalations.length).toBe(1);
    expect(escalations[0]).toContain('refused');
  });

  it('never sends a key to the log', async () => {
    const seen: string[] = [];
    await callTier1Model({
      utterance: 'hi', summary: SUMMARY,
      environment: { ANTHROPIC_API_KEY: 'test-value-not-a-key', STEREOFOLD_BRIDGE_MODEL: 'custom' },
      fetchFn: (async (url: string, init: Record<string, unknown>) => {
        seen.push(JSON.stringify(redactForLog({ headers: (init as any).headers, body: (init as any).body })));
        return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Hello there.' }] }) };
      }) as any,
    });
    expect(seen.join('')).not.toContain('test-value-not-a-key');
  });
});

describe('receipts gate speech', () => {
  const control = { origin: 'http://127.0.0.1:1', token: 't', sessionId: 's' };
  const readState = async () => ({ structuredContent: BINDING_STATE });

  function receiptHarness(receipt: { status: string; reason?: string } = { status: 'rendered' }, opts: { throwTool?: string } = {}) {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const logs: Record<string, unknown>[] = [];
    const escalations: string[] = [];
    return {
      calls, logs, escalations,
      deps: {
        callAgent: async (_state: unknown, name: string, args: Record<string, unknown> = {}) => {
          calls.push({ name, args });
          if (name === 'get_inspection_state' && (args as any).commandId) {
            return {
              structuredContent: {
                command: {
                  commandId: (args as any).commandId, status: receipt.status,
                  ...(receipt.reason ? { reason: receipt.reason } : {}),
                },
              },
            };
          }
          if (opts.throwTool && name === opts.throwTool) throw Error(`refused ${name}`);
          if (name === 'update_inspection' || name === 'control_tour' || name === 'focus_selection' || name === 'emphasize') {
            return { structuredContent: { command: { commandId: (args as any).commandId, status: 'queued' } } };
          }
          return { structuredContent: {} };
        },
        readState,
        logLine: (entry: Record<string, unknown>) => { logs.push(entry); },
        appendEscalation: async (line: string) => { escalations.push(line); },
        receiptWait: { pollMs: 1, timeoutMs: 500 },
      },
    };
  }

  const said = (calls: { name: string; args: Record<string, unknown> }[]) =>
    calls.filter(call => call.name === 'say_to_headset').map(call => String((call.args as any).text));

  it('tier 0 success speaks acknowledgement then completion', async () => {
    const { calls, escalations, deps } = receiptHarness();
    const outcome = await handleUtterance({
      control, raw: 'make it tiny', summary: SUMMARY,
      decision: {
        route: 'tier0',
        decision: {
          tier: 'tier0', tool: 'update_inspection',
          change: { kind: 'placement', patch: { scale: 0.5 } },
          say: 'Much smaller.', speak: true, rule: 'test-scale',
        },
      },
      deps,
    });
    expect(outcome.route).toBe('tier0');
    expect(said(calls)).toEqual([BRIDGE_ACK_TEXT, 'Much smaller.']);
    expect(escalations).toEqual([]);
    for (const line of said(calls)) expect(line.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(12);
  });

  it('a rendering failure speaks acknowledgement then failure', async () => {
    const { calls, escalations, deps } = receiptHarness({ status: 'rejected', reason: 'still rendering' });
    const outcome = await handleUtterance({
      control, raw: 'start spinning the molecule', summary: SUMMARY,
      decision: { route: 'tier1' },
      deps: { ...deps, tier1: async () => ({ kind: 'tool', name: 'update_inspection', args: { change: { kind: 'motion', patch: { state: 'spin' } } } }) },
    });
    expect(outcome.route).toBe('tier1');
    expect(said(calls)).toEqual([BRIDGE_ACK_TEXT, BRIDGE_FAILURE_TEXT]);
    expect(BRIDGE_FAILURE_TEXT.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(escalations.length).toBe(1);
    expect(outcome).toMatchObject({ say: BRIDGE_FAILURE_TEXT });
  });

  it('a thrown action speaks a failure line', async () => {
    const { calls, escalations, deps } = receiptHarness({ status: 'rendered' }, { throwTool: 'update_inspection' });
    const outcome = await handleUtterance({
      control, raw: 'make it tiny', summary: SUMMARY,
      decision: {
        route: 'tier0',
        decision: {
          tier: 'tier0', tool: 'update_inspection',
          change: { kind: 'placement', patch: { scale: 0.5 } },
          say: 'Much smaller.', speak: true, rule: 'test-scale',
        },
      },
      deps,
    });
    expect(outcome.route).toBe('tier0');
    expect(said(calls)).toEqual([BRIDGE_FAILURE_TEXT]);
    expect(escalations.length).toBe(1);
    expect(outcome).toMatchObject({ say: BRIDGE_FAILURE_TEXT });
  });
});

describe('safety rails', () => {
  it('rate limits bursts to one action per utterance pace', () => {
    let at = 1_000_000;
    const limiter = createRateLimiter({ now: () => at });
    expect(limiter.check()).toEqual({ ok: true });
    expect(limiter.check().ok).toBe(false);
    at += 800;
    expect(limiter.check()).toEqual({ ok: true });
  });

  it('redacts capabilities and keys from the bridge log', () => {
    const redacted = redactForLog({
      sourceToken: '22222222-secret', text: 'Bearer abc.def.ghi hello',
      url: 'http://127.0.0.1:8080/inspect#pagekeymaterial', say: 'Bigger.',
    }) as Record<string, unknown>;
    expect(redacted).toEqual({
      sourceToken: '<redacted>', text: 'Bearer <redacted> hello',
      url: 'http://127.0.0.1:8080/inspect#<page key hidden>', say: 'Bigger.',
    });
  });

  it('confirms tier 1 tools in the wearer’s own words', () => {
    expect(tier1Confirmation('control_tour', { action: 'next' }, SUMMARY)).toEqual({ say: 'Next step.', speak: false });
    expect(tier1Confirmation('update_inspection', { change: { kind: 'render-quality', patch: { level: 'best' } } }, SUMMARY))
      .toEqual({ say: 'Max quality.', speak: true });
  });
});

describe('bridge receipt wait follows the host budget', () => {
  const control = {} as any;

  beforeEach(() => {
    // The host's elapsed-time stub and the receipt poller must share a clock:
    // real 5 ms timers can skip enough polls under load to fail the count below.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('keeps waiting past its own bound while the host states a remaining budget, and returns the rendered receipt', async () => {
    const started = Date.now();
    let polls = 0;
    const callAgent = async (_state: unknown, name: string, args: Record<string, unknown> = {}) => {
      expect(name).toBe('get_inspection_state');
      polls += 1;
      const elapsed = Date.now() - started;
      // The host is still rendering for the first 80 ms and says so, with 200 ms of its deadline left.
      if (elapsed < 80) return { structuredContent: { command: { commandId: args.commandId, status: 'rendering', budgetMs: 200 } } };
      return { structuredContent: { command: { commandId: args.commandId, status: 'rendered' } } };
    };
    let outcome: Awaited<ReturnType<typeof waitForBridgeReceipt>> | undefined;
    const pending = waitForBridgeReceipt(control, 'cmd-1', callAgent, { pollMs: 5, timeoutMs: 30 })
      .then(result => { outcome = result; });
    await vi.advanceTimersByTimeAsync(35);
    expect(polls).toBeGreaterThan(6);
    expect(outcome).toBeUndefined(); // Still waiting beyond the bridge's 30 ms bound.
    await vi.advanceTimersByTimeAsync(44);
    expect(outcome).toBeUndefined(); // A rendering receipt cannot complete the wait.
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toEqual({ receipt: { commandId: 'cmd-1', status: 'rendered' }, timedOut: false });
    expect(Date.now() - started).toBe(80);
    expect(polls).toBeGreaterThan(6);
  });
  it('still times out on its own bound when the host states no budget', async () => {
    const callAgent = async (_state: unknown, _name: string, args: Record<string, unknown> = {}) =>
      ({ structuredContent: { command: { commandId: args.commandId, status: 'queued' } } });
    let outcome: Awaited<ReturnType<typeof waitForBridgeReceipt>> | undefined;
    const pending = waitForBridgeReceipt(control, 'cmd-2', callAgent, { pollMs: 5, timeoutMs: 40 })
      .then(result => { outcome = result; });
    await vi.advanceTimersByTimeAsync(39);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(outcome).toEqual({ receipt: { commandId: 'cmd-2', status: 'queued' }, timedOut: true });
  });
  it('carries the refusal reason through', async () => {
    const callAgent = async (_state: unknown, _name: string, args: Record<string, unknown> = {}) =>
      ({ structuredContent: { command: { commandId: args.commandId, status: 'refused', reason: 'The placement was not rendered as requested.' } } });
    const pending = waitForBridgeReceipt(control, 'cmd-3', callAgent, { pollMs: 5, timeoutMs: 40 });
    await vi.advanceTimersByTimeAsync(5);
    const outcome = await pending;
    expect(outcome).toEqual({ receipt: { commandId: 'cmd-3', status: 'refused', reason: 'The placement was not rendered as requested.' }, timedOut: false });
  });
});

/**
 * The spoken route to a numbered residue, from the Mac's side.
 *
 * On the Quest 2 "go to residue 141" and "go to 141" both
 * reached the host's conversation consumer and the residue browser did not
 * move. `focus_selection` with the
 * author residue range is the call that did work from here in the same
 * session, so that is what the sentence resolves to.
 */
describe('residue jumps from the Mac', () => {
  it('maps a bare spoken jump onto focus_selection with the author residue range', () => {
    const decision = matchTier0('go to 141');
    expect(decision).toMatchObject({ tier: 'tier0', tool: 'focus_selection', rule: 'residue-goto',
      change: { residues: { authorResidueRange: [141, 141] } }, fields: { framing: 'context' },
      say: 'Residue 141.', speak: true });
    expect(matchTier0('jump to residue 141 on chain a')).toMatchObject({ tool: 'focus_selection',
      change: { residues: { authorResidueRange: [141, 141], authorChain: 'A' } }, say: 'Residue 141 chain A.' });
    expect(matchTier0('show residue 8')).toMatchObject({ rule: 'residue-goto' });
    // Not a residue jump, and never invented from an unnumbered sentence.
    expect(matchTier0('go to sleep')).toBeUndefined();
    expect(matchTier0('go to 0')).toBeUndefined();
  });

  it('leaves every sentence the page can claim to the page, in either browser state', () => {
    // The page owns "go to residue 141" whether the residue browser is open
    // (it pages to the row) or shut (it frames the residue), so the bridge
    // must not act on it as well.
    expect(pageClaimsAction('go to residue 141')).toBe(true);
    expect(pageClaimsAction('go to 141')).toBe(true);
    expect(decideUtterance({ raw: 'go to residue 141', summary: SUMMARY }).route).toBe('page');
  });

  it('tries the Mac’s corrected reading only when the raw one resolved to nothing', () => {
    const heard = 'go to resident 141';
    expect(decideUtterance({ raw: heard, summary: SUMMARY }).route).toBe('tier1');
    // With the correction the same utterance reaches the page, which is where
    // the residue browser lives.
    expect(decideUtterance({ raw: heard, proposed: 'go to residue 141', summary: SUMMARY }).route).toBe('page');
    // A correction never overrides a reading the bridge already had.
    expect(decideUtterance({ raw: 'make it bigger', proposed: 'go to residue 141', summary: SUMMARY }).route)
      .toBe(decideUtterance({ raw: 'make it bigger', summary: SUMMARY }).route);
  });
});
