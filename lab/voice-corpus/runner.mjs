/**
 * The voice-corpus runner: forty cases, played as injected transcripts.
 *
 * WHAT THIS IS EVIDENCE OF, AND WHAT IT IS NOT.
 *
 * Every case here is driven through the host's real request path — the grip
 * edge that captures what the wearer meant by "this", the push-to-talk audio
 * route that opens the utterance, `listen_voice`, the target-bound command
 * queue, and a receipt that says `rendered` only after a scene came back. The
 * one thing replaced is the recognizer: the words are read out of
 * `voice-cases.json` and handed to the transcriber seam instead of being heard.
 *
 * So a green run says the command path does the right thing with these exact
 * sentences. It says NOTHING about whether a Quest 2 microphone in a room with
 * a fan would have produced those sentences, and nothing about whether the
 * wearer heard the reply. Voice qualification passes on real speech with a wearer or it does
 * not pass; every record this runner writes is stamped `injected-transcript`
 * and every case keeps `status: "not_run"` in the corpus file.
 *
 * Usage (live standalone host):
 *   node lab/voice-corpus/runner.mjs --state ~/.stereofold/quest-share.json
 * Usage (in-process synthetic host):
 *   plugin/node_modules/.bin/tsx plugin/scripts/voice-corpus.ts
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  FIXTURES, ToolRefusal, callTool, openSession, poll as pollSession, receiptFor as readReceipt,
  refresh as refreshSession, render as renderDelivery, residues, settle as settleSession,
} from './session.mjs';
import { CONSUMER_VERSION, REFERENT_FRESHNESS_MS, interpret, plan } from './consumer.mjs';
import { CASES } from './cases.mjs';

export const RUNNER_VERSION = 1;
export const EVIDENCE_KIND = 'injected-transcript';
export const BANNER = 'INJECTED TRANSCRIPTS. No microphone, no wearer, no headset. '
  + 'This run exercises the command path with the corpus sentences supplied at the transcriber seam. '
  + 'It is supporting evidence only: voice qualification needs real speech with a wearer, and every case stays not_run until then.';

/** The outcome class each declared expectation is satisfied by. */
const EXPECTED_CLASS = {
  rendered_mutation: 'intended',
  committed_state: 'intended',
  selection_with_unresolved_notice: 'intended',
  clarification: 'clarification',
  refusal: 'refusal',
  refusal_without_replay: 'refusal',
  speech_interrupted: 'intended',
  superseded_then_rendered: 'intended',
  cancelled_pending: 'intended',
  rendered_undo: 'intended',
  idempotent_result: 'intended',
  single_rendered_mutation: 'intended',
  uncertain_then_reconciled: 'intended',
  unavailable_without_mutation: 'intended',
  no_mutation: 'intended',
  read_result_and_audible_reply: 'intended',
  queued_then_rendered: 'intended',
  reconciled_without_duplicate: 'intended',
  incomplete_request_without_mutation: 'intended',
};

/**
 * The alternate-site identifiers a fixture declares for one residue.
 *
 * Read from the pinned bytes rather than asserted, because the clarification
 * V20 expects has to name the real alternatives. The catalog is residue-level
 * and carries none, which is itself the reason that case must ask.
 */
export function alternateSitesIn(cif) {
  const lines = cif.split(/\r?\n/u).map(line => line.trim());
  const header = lines.findIndex(line => line === '_atom_site.label_alt_id');
  if (header < 0) return [];
  let first = header;
  while (first > 0 && lines[first - 1].startsWith('_atom_site.')) first -= 1;
  let last = header;
  while (last + 1 < lines.length && lines[last + 1].startsWith('_atom_site.')) last += 1;
  const column = header - first;
  const found = new Set();
  for (let row = last + 1; row < lines.length; row += 1) {
    const line = lines[row];
    if (!line || line.startsWith('#') || line.startsWith('_') || line === 'loop_') break;
    const value = line.split(/\s+/u)[column];
    if (value && value !== '.' && value !== '?') found.add(value);
  }
  return [...found].sort();
}

/** Everything a case may need that is not a tool call. */
function library(ctx) {
  const nextId = (() => { let n = 0; return prefix => `${prefix}-${++n}`; })();

  const merge = (session, tool, args) => {
    if (tool === 'sync_inspection') { ctx.deliberateSaves += 1; return { ...session.binding, ...args }; }
    const { commandId, ...rest } = args;
    return { ...session.binding, panelId: session.panelId, commandId: commandId ?? nextId(ctx.spec.id.toLowerCase()), ...rest };
  };

  const lib = {
    noop: () => undefined,
    async read(session, args = {}) {
      return (await callTool(session.call, 'get_inspection_state', { sessionId: session.sessionId, ...args })).structuredContent;
    },
    async refresh(session) { return await refreshSession(session); },
    async poll(session, availability = 'ready') { return await pollSession(session, availability); },
    async receiptFor(session, commandId) { return await readReceipt(session, commandId); },
    async command(session, tool, args = {}) { return await callTool(session.call, tool, merge(session, tool, args)); },
    /** A call whose refusal is the point. Returns the host's sentence, or null. */
    async expectRefusal(session, tool, args = {}) {
      try { await callTool(session.call, tool, merge(session, tool, args)); return null; }
      catch (error) { if (error instanceof ToolRefusal) return error.message; throw error; }
    },
    async render(session, delivery, options) {
      const outcome = await renderDelivery(session, delivery, options);
      if (outcome.answer?.structuredContent?.command?.status === 'rendered') lib.noteRendered();
      return outcome;
    },
    async settle(session, options) {
      const outcome = await settleSession(session, options);
      if (outcome.receipt?.status === 'rendered') lib.noteRendered();
      return outcome;
    },
    async admit(session, delivery) {
      const answer = await callTool(session.call, 'complete_inspection', {
        ...session.binding, panelId: session.panelId, commandId: delivery.commandId,
        claimToken: delivery.claimToken, phase: 'admit',
      });
      return answer.structuredContent.admitted === true;
    },
    async detach(session) {
      await callTool(session.call, 'detach_inspection', { ...session.binding, panelId: session.panelId });
      // The panel ID is kept deliberately: a command aimed at a panel that has
      // gone must be refused by the host for being gone, not rejected by a
      // schema for being absent.
      session.detachedPanelId = session.panelId;
    },
    async reattach(session) {
      await refreshSession(session);
      const attached = await callTool(session.call, 'attach_inspection', { ...session.binding, surface: 'companion' });
      session.panelId = attached.structuredContent.panelId;
      return session.panelId;
    },
    noteRendered() {
      ctx.renderedCount += 1;
      if (ctx.injectedAt !== null && ctx.renderedAt === null) ctx.renderedAt = performance.now();
    },
    expectRendered(context, outcome, what) {
      const status = outcome?.receipt?.status;
      if (status !== 'rendered') throw Error(`The runner could not stage ${what}: the host answered "${status ?? 'no receipt'}".`);
    },
    /** One canonical key for a region, read from the host. */
    async rowKey(session, query) {
      const wanted = { ...query };
      const insertionCode = wanted.insertionCode;
      delete wanted.insertionCode;
      const q = { ...(wanted.authorChain ? { authorChain: wanted.authorChain } : {}), limit: 128 };
      if (wanted.authorResidue !== undefined) q.authorResidueRange = [wanted.authorResidue, wanted.authorResidue];
      if (wanted.labelSequenceId !== undefined) q.labelSequenceRange = [wanted.labelSequenceId, wanted.labelSequenceId];
      let rows = await residues(session, q);
      if (insertionCode !== undefined) rows = rows.filter(row => (row.identity.insertionCode ?? '') === insertionCode);
      if (rows.length !== 1) throw Error(`Staging expected one row for ${JSON.stringify(query)} and the host returned ${rows.length}.`);
      return rows[0].key;
    },
    /** Put a residue in the saved scene, rendered, before the case speaks. */
    async selectResidue(session, query) {
      const key = await lib.rowKey(session, query);
      await lib.command(session, 'update_inspection', { change: { kind: 'selection', patch: { selectionKeys: [key] } } });
      const outcome = await lib.settle(session);
      lib.expectRendered(ctx, outcome, 'the precondition selection');
      return key;
    },
    async saveView(session, name) {
      await lib.command(session, 'manage_inspection_view', { action: 'save', name });
      const outcome = await lib.settle(session);
      lib.expectRendered(ctx, outcome, `the saved view "${name}"`);
      return outcome;
    },
    /** Open an utterance and put one edit under it, without delivering it. */
    async utteranceEdit(session, commandId, change) {
      const began = await lib.command(session, 'update_inspection', {
        commandId: `${commandId}-begin`, change: { kind: 'utterance', patch: { action: 'begin' } },
      });
      const utteranceId = began.structuredContent.lifecycle.utterance.utteranceId;
      await lib.command(session, 'update_inspection', { commandId, utteranceId, change });
      return { utteranceId, commandId };
    },
    /** Declare a correction or a cancellation, the way the contract requires. */
    async lifecycle(session, action, { commandId, utteranceId } = {}) {
      const answer = await lib.command(session, 'update_inspection', {
        commandId: commandId ?? nextId('lifecycle'),
        ...(utteranceId ? { utteranceId } : {}),
        change: { kind: 'utterance', patch: { action } },
      });
      return answer.structuredContent.lifecycle;
    },
    /** Whether anything the wearer can see moved since the utterance began. */
    async mutated(context) {
      const state = await refreshSession(context.session);
      return state.inspectionRevision !== context.revisionAtInjection;
    },
    async inject(context, options = {}) { return await injectUtterance(context, options); },
    async consume(context, injected) {
      const intent = interpret(injected.transcript);
      context.record.intent = intent;
      const decided = await plan(context.session, intent, {
        referent: injected.referent,
        now: context.host.clock ? context.host.clock.now : Date.now(),
        alternateSites: context.alternateSites ?? [],
      });
      context.record.decision = { action: decided.action, ...(decided.reason ? { reason: decided.reason } : {}) };
      return decided;
    },
  };
  return lib;
}

/**
 * The press, the words and the listen, over the host's own route.
 *
 * The grip goes down (which is where the referent is captured), a chunk opens
 * the utterance, the final chunk closes it, the grip comes up, and the words
 * are collected with `listen_voice` exactly as an agent collects them.
 */
async function injectUtterance(ctx, { expectSilence = false } = {}) {
  const session = ctx.session;
  if ((ctx.host.route ?? 'transcriber-seam') === 'text-utterance') return await injectAsText(ctx);
  const utteranceId = randomUUID();
  ctx.host.arm(ctx.spec.utterance);
  await callTool(session.call, 'push_to_talk', {
    sessionId: session.sessionId, state: 'down', ...(ctx.pointing ? { pointing: ctx.pointing } : {}),
  });
  const audio = { sessionId: session.sessionId, panelId: session.panelId, utteranceId, mime: 'audio/webm;codecs=opus' };
  await callTool(session.call, 'push_to_talk_audio', { ...audio, seq: 0, data: 'AAAA', final: false });
  const closed = await callTool(session.call, 'push_to_talk_audio', { ...audio, seq: 1, final: true });
  await callTool(session.call, 'push_to_talk', { sessionId: session.sessionId, state: 'up' });
  ctx.injectedAt = performance.now();
  ctx.revisionAtInjection = (await refreshSession(session)).inspectionRevision;
  ctx.afterInjection?.();
  const audioReason = closed.structuredContent.reason;
  if (expectSilence || audioReason !== 'transcribed') {
    return { utteranceId, transcript: null, referent: undefined, audioReason, route: EVIDENCE_KIND };
  }
  const heard = await callTool(session.call, 'listen_voice', { timeoutSeconds: 1, cursor: session.voiceCursor ?? 0 });
  const structured = heard.structuredContent;
  session.voiceCursor = structured.cursor;
  const entry = structured.transcripts.find(item => item.utteranceId === utteranceId) ?? structured.transcripts.at(-1);
  return {
    utteranceId,
    transcript: entry?.text ?? null,
    referent: entry?.referent,
    utteranceSequence: entry?.utteranceSequence,
    audioReason,
    route: EVIDENCE_KIND,
  };
}

/**
 * The live-host route: an utterance allocated the way a typed request does.
 *
 * No press, no audio, no recognizer. The words are the corpus's and the ID is
 * the host's, so everything after the transcript behaves exactly as it does for
 * speech — and the record says plainly that the speech leg did not happen.
 */
async function injectAsText(ctx) {
  const session = ctx.session;
  const began = await callTool(session.call, 'update_inspection', {
    ...session.binding, panelId: session.panelId,
    commandId: `${ctx.spec.id.toLowerCase()}-utterance`,
    change: { kind: 'utterance', patch: { action: 'begin' } },
  });
  const utteranceId = began.structuredContent.lifecycle.utterance.utteranceId;
  ctx.injectedAt = performance.now();
  ctx.revisionAtInjection = (await refreshSession(session)).inspectionRevision;
  ctx.afterInjection?.();
  return {
    utteranceId, transcript: ctx.spec.utterance, referent: undefined,
    audioReason: 'no-speech-leg', route: 'text-utterance',
  };
}

/** The flow every case that is a plain sentence follows. */
async function defaultDrive(ctx, lib) {
  const injected = await lib.inject(ctx);
  if (injected.transcript === null) {
    return { injected, outcome: 'false-completion', detail: `No transcript came back (${injected.audioReason}).` };
  }
  const decided = await lib.consume(ctx, injected);
  if (decided.action === 'needs-model') return { injected, outcome: 'needs-model', detail: decided.reason };
  if (decided.action === 'none' || decided.action === 'clarification') {
    const moved = await lib.mutated(ctx);
    const base = decided.action === 'none' ? 'intended' : 'clarification';
    return {
      injected,
      outcome: moved ? 'false-completion' : base,
      detail: decided.question ?? decided.reason,
      ...(decided.candidates?.length ? { candidates: decided.candidates } : {}),
    };
  }
  if (decided.action === 'query') {
    const answer = await lib.read(ctx.session, decided.args);
    const selected = answer.residues?.rows?.map(row => row.key) ?? [];
    const reply = selected.length
      ? `Selected: ${answer.residues.rows.map(row => `${row.identity.componentId} ${row.identity.authorResidue ?? '?'}${row.identity.insertionCode ?? ''} in author chain ${row.identity.authorChain ?? row.identity.labelChain}`).join('; ')}.`
      : 'Nothing is selected right now.';
    const spoken = await callTool(ctx.session.call, 'say_to_headset', { text: reply.slice(0, 280), utteranceId: injected.utteranceId, speak: false });
    ctx.record.reply = reply;
    ctx.record.replyReceipt = { stale: spoken.structuredContent.stale, queued: spoken.structuredContent.queued, audible: spoken.structuredContent.audible };
    const moved = await lib.mutated(ctx);
    ctx.record.answered = selected;
    return { injected, outcome: moved ? 'false-completion' : 'intended', detail: reply };
  }
  if (decided.action !== 'command') return { injected, outcome: 'needs-model', detail: `Unhandled plan action "${decided.action}".` };

  let issued;
  try {
    issued = await lib.command(ctx.session, decided.tool, {
      ...decided.args, commandId: `${ctx.spec.id.toLowerCase()}-command`, utteranceId: injected.utteranceId,
    });
  } catch (error) {
    if (!(error instanceof ToolRefusal)) throw error;
    const moved = await lib.mutated(ctx);
    ctx.record.refusal = error.message;
    return {
      injected,
      outcome: moved ? 'false-completion' : (decided.expectRefusal ? 'unsupported' : 'refusal'),
      detail: error.message,
      ...(decided.expectRefusal ? { limit: decided.expectRefusal } : {}),
    };
  }
  ctx.record.queued = issued.structuredContent.command?.status ?? null;
  const rendered = await lib.settle(ctx.session);
  if (!rendered.delivered) return { injected, outcome: 'false-completion', detail: 'The command was accepted but never delivered to a panel.' };
  const receipt = rendered.receipt;
  if (decided.withhold) ctx.record.withheld = decided.withhold;
  if (decided.caveat) ctx.record.caveat = decided.caveat;
  if (decided.target) ctx.record.target = decided.target;
  return {
    injected,
    outcome: receipt.status === 'rendered' ? 'intended' : 'false-completion',
    detail: receipt.status === 'rendered'
      ? `Rendered at revision ${receipt.renderedRevision}.${decided.withhold ? ` ${decided.withhold.reason}` : ''}`
      : `The receipt came back "${receipt.status}"${receipt.reason ? `: ${receipt.reason}` : ''}.`,
    receipt,
  };
}

async function playCase(host, spec, script) {
  const started = new Date().toISOString();
  const base = {
    id: spec.id, group: spec.group, classification: spec.classification,
    expectedOutcomeType: spec.expectedOutcomeType, utterance: spec.utterance,
    evidence: EVIDENCE_KIND, startedAt: started,
  };
  if (!script) {
    return { ...base, coverage: 'environment', outcome: 'needs-model', appropriate: false, scripted: false,
      detail: 'No script exists for this case.', unproven: [] };
  }
  if (script.coverage === 'environment') {
    return { ...base, coverage: 'environment', outcome: 'environment-blocked', appropriate: false, scripted: false,
      detail: script.blocked, unproven: script.unproven ?? [] };
  }
  // A case that ages a referent needs a clock it may move. A live host's clock
  // is the wall, and waiting a real minute per case is not a test.
  if (script.requiresClock && !host.clock) {
    return { ...base, coverage: 'environment', outcome: 'environment-blocked', appropriate: false, scripted: false,
      detail: 'This case ages the pointer past the freshness limit, which needs a controllable clock. Run it on the synthetic host.',
      unproven: script.unproven ?? [] };
  }
  // Nor can a host with a real recognizer be told to stop hearing.
  if (script.requiresTranscriberSeam && (host.route ?? 'transcriber-seam') !== 'transcriber-seam') {
    return { ...base, coverage: 'environment', outcome: 'environment-blocked', appropriate: false, scripted: false,
      detail: 'This case turns the recognizer off, which only the synthetic host may do.',
      unproven: script.unproven ?? [] };
  }
  const ctx = {
    host, spec, script, record: {}, renderedCount: 0, deliberateSaves: 0, injectedAt: null, renderedAt: null,
    revisionAtInjection: null, pointing: undefined, expectTarget: undefined, alternateSites: [],
  };
  const lib = library(ctx);
  let session; let other;
  try {
    session = await openSession(host.call, script.fixture);
    ctx.session = session;
    if (script.second) { other = await openSession(host.call, script.second); ctx.other = other; }
    if (script.alternateSites) ctx.alternateSites = alternateSitesIn(await readFile(resolve(FIXTURES, script.fixture.file), 'utf8'));
    await script.stage?.(ctx, lib);
    const revisionBefore = (await refreshSession(session)).inspectionRevision;
    ctx.renderedCount = 0;
    ctx.deliberateSaves = 0;
    const outcome = script.drive ? await script.drive(ctx, lib) : await defaultDrive(ctx, lib);
    await script.after?.(ctx, lib);
    const state = await refreshSession(session);
    const revisionDelta = state.inspectionRevision - revisionBefore;
    const target = ctx.expectTarget;
    const wrongTarget = Boolean(target) && JSON.stringify([...session.scene.selectionKeys].sort()) !== JSON.stringify([...target].sort());
    // A deliberate save is the runner committing a scene, which is not a
    // second rendering of anybody's request.
    const duplicate = revisionDelta > ctx.renderedCount + ctx.deliberateSaves;
    const expected = EXPECTED_CLASS[spec.expectedOutcomeType];
    let outcomeClass = outcome.outcome;
    if (wrongTarget && outcomeClass === 'intended') outcomeClass = 'wrong-target';
    if (duplicate && outcomeClass === 'intended') outcomeClass = 'duplicate';
    return {
      ...base,
      coverage: script.coverage,
      scripted: true,
      outcome: outcomeClass,
      appropriate: outcomeClass === expected,
      expectedClass: expected,
      detail: outcome.detail,
      ...(outcome.candidates ? { candidates: outcome.candidates } : {}),
      ...(outcome.limit ? { limit: outcome.limit } : {}),
      latencyMs: ctx.injectedAt !== null && ctx.renderedAt !== null ? Math.round(ctx.renderedAt - ctx.injectedAt) : null,
      renderedCommands: ctx.renderedCount,
      revisionDelta,
      checks: { wrongTarget, duplicate, falseCompletion: outcomeClass === 'false-completion' },
      record: ctx.record,
      unproven: script.unproven ?? [],
      utteranceId: outcome.injected?.utteranceId ?? null,
      transcript: outcome.injected?.transcript ?? null,
    };
  } catch (error) {
    return {
      ...base, coverage: script.coverage, scripted: false, outcome: 'runner-error', appropriate: false,
      detail: `${error.name}: ${error.message}`, record: ctx.record, unproven: script.unproven ?? [],
      checks: { wrongTarget: false, duplicate: false, falseCompletion: false },
    };
  } finally {
    for (const open of [session, other]) {
      if (open?.panelId) { try { await callTool(open.call, 'detach_inspection', { ...open.binding, panelId: open.panelId }); } catch { /* the session is going away anyway */ } }
    }
  }
}

/**
 * Play the corpus.
 *
 * `host` is anything with `call`, `arm` and `close`; the synthetic entry point
 * supplies the in-process server and `live.mjs` supplies a standalone host.
 */
export async function runCorpus({ host, corpusPath, only }) {
  const bytes = await readFile(corpusPath);
  const corpus = JSON.parse(bytes.toString('utf8'));
  const results = [];
  for (const spec of corpus.cases) {
    if (only && !only.includes(spec.id)) continue;
    results.push(await playCase(host, spec, CASES[spec.id]));
  }
  return {
    schemaVersion: 1,
    recordType: 'injected_transcript_supporting_evidence',
    banner: BANNER,
    evidence: EVIDENCE_KIND,
    runnerVersion: RUNNER_VERSION,
    consumerVersion: CONSUMER_VERSION,
    referentFreshnessMs: REFERENT_FRESHNESS_MS,
    hostKind: host.kind,
    corpusSha256: createHash('sha256').update(bytes).digest('hex'),
    ranAt: new Date().toISOString(),
    results,
    totals: totals(results),
  };
}

export function totals(results) {
  const scripted = results.filter(entry => entry.scripted);
  const count = predicate => results.filter(predicate).length;
  return {
    cases: results.length,
    scripted: scripted.length,
    appropriateOverScripted: scripted.filter(entry => entry.appropriate).length,
    scriptedBar: `${scripted.filter(entry => entry.appropriate).length}/${scripted.length}`,
    corpusBar: '38/40 over real speech, which this run does not supply',
    wrongTarget: count(entry => entry.checks?.wrongTarget),
    duplicate: count(entry => entry.checks?.duplicate),
    falseCompletion: count(entry => entry.checks?.falseCompletion),
    needsModel: count(entry => entry.outcome === 'needs-model'),
    unsupported: count(entry => entry.outcome === 'unsupported'),
    environmentBlocked: count(entry => entry.outcome === 'environment-blocked'),
    runnerErrors: count(entry => entry.outcome === 'runner-error'),
  };
}

const cell = value => String(value ?? '').replace(/\|/gu, '\\|').replace(/\n/gu, ' ');

export function summaryMarkdown(run) {
  const t = run.totals;
  const rows = run.results.map(entry => `| ${entry.id} | ${entry.group} | ${entry.expectedOutcomeType} | ${entry.outcome} | `
    + `${entry.appropriate ? 'yes' : 'no'} | ${entry.coverage} | ${entry.latencyMs ?? '—'} | ${cell(entry.detail).slice(0, 160)} |`);
  const unproven = run.results.filter(entry => entry.unproven?.length)
    .map(entry => `- **${entry.id}** — ${entry.unproven.join('; ')}`);
  return [
    '# Voice corpus run — injected transcripts',
    '',
    `> ${run.banner}`,
    '',
    `Host: \`${run.hostKind}\`. Corpus SHA-256: \`${run.corpusSha256}\`. Ran at ${run.ranAt}.`,
    `Runner v${run.runnerVersion}, scripted consumer v${run.consumerVersion}, deictic freshness ${run.referentFreshnessMs} ms.`,
    '',
    '## Bars',
    '',
    '| Measure | Value |',
    '| --- | --- |',
    `| Appropriate outcomes over scripted cases | ${t.scriptedBar} |`,
    `| Corpus bar | ${t.corpusBar} |`,
    `| Wrong-target mutations | ${t.wrongTarget} |`,
    `| Unintended duplicate mutations | ${t.duplicate} |`,
    `| False completion claims | ${t.falseCompletion} |`,
    `| Cases needing a model | ${t.needsModel} |`,
    `| Cases the command surface cannot express | ${t.unsupported} |`,
    `| Cases blocked on the real environment | ${t.environmentBlocked} |`,
    `| Runner errors | ${t.runnerErrors} |`,
    '',
    'Latency is milliseconds from the closed utterance to the rendered receipt, in one process.',
    'It is not speech-to-picture latency and must not be reported as one.',
    '',
    '## Cases',
    '',
    '| Case | Group | Expected | Outcome | Appropriate | Coverage | Latency ms | Detail |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## What this run did not observe',
    '',
    ...(unproven.length ? unproven : ['- Nothing was listed, which would itself be a defect in the case scripts.']),
    '',
  ].join('\n');
}

/**
 * Write the run beside the corpus and, on request, record it in the corpus file
 * WITHOUT touching any case's `status`. Real speech owns that field.
 */
export async function writeRun(run, { outDir, corpusPath, updateCorpus = false }) {
  const stamp = run.ranAt.replace(/[:.]/gu, '-');
  const directory = resolve(outDir, stamp);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'results.json'), `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(resolve(directory, 'SUMMARY.md'), summaryMarkdown(run));
  if (updateCorpus) {
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
    for (const spec of corpus.cases) {
      const entry = run.results.find(result => result.id === spec.id);
      if (!entry) continue;
      // `status` stays not_run: only a worn-headset speech observation moves it.
      spec.injectedTranscriptRun = {
        evidence: EVIDENCE_KIND, ranAt: run.ranAt, host: run.hostKind,
        outcome: entry.outcome, appropriate: entry.appropriate, coverage: entry.coverage,
        ...(entry.latencyMs === null || entry.latencyMs === undefined ? {} : { latencyMs: entry.latencyMs }),
        note: 'Supporting evidence only. This field never sets status.',
      };
    }
    await writeFile(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
  }
  return directory;
}

export function parseArguments(argv) {
  const options = { state: undefined, only: undefined, updateCorpus: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--state') options.state = argv[++index];
    else if (flag === '--only') options.only = argv[++index]?.split(',').map(value => value.trim().toUpperCase());
    else if (flag === '--update-corpus') options.updateCorpus = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw Error(`Unknown option "${flag}".`);
  }
  return options;
}

export const USAGE = `Usage: node runner.mjs --state <control file> [--only V01,V02] [--update-corpus]

Plays the 40-case voice corpus against a running standalone host as INJECTED
transcripts. For the in-process synthetic host, run plugin/scripts/voice-corpus.ts with tsx.`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.state) { console.log(USAGE); process.exit(options.help ? 0 : 2); }
  const { createLiveCorpusHost } = await import('./live.mjs');
  const host = await createLiveCorpusHost(options.state);
  const corpusPath = resolve(FIXTURES, 'voice-cases.json');
  try {
    const run = await runCorpus({ host, corpusPath, only: options.only });
    const directory = await writeRun(run, { outDir: resolve(FIXTURES, '../lab/voice-corpus/runs'), corpusPath, updateCorpus: options.updateCorpus });
    console.log(BANNER);
    console.log(`Wrote ${directory}`);
    console.log(`Appropriate over scripted: ${run.totals.scriptedBar}. Wrong target ${run.totals.wrongTarget}, duplicate ${run.totals.duplicate}, false completion ${run.totals.falseCompletion}.`);
  } finally { await host.close(); }
}
