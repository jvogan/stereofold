/**
 * The voice corpus, played in process, as a regression.
 *
 * This is NOT voice qualification, which needs real speech with a wearer, and
 * every case in `voice-cases.json` keeps `status: "not_run"` until that
 * happens. What this file protects is the thing a wearer cannot see failing
 * until it has already failed: that the command path, given the corpus's own
 * sentences, hits the right residues, asks instead of guessing where the corpus
 * says it is ambiguous, and never reports a change it did not render.
 *
 * The three counts the corpus fixes at zero — wrong target, unintended
 * duplicate, false completion — are asserted here over every case that runs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSyntheticCorpusHost } from '../scripts/voice-corpus-host.js';
// @ts-ignore Shared JavaScript corpus runner; the lab is plain ESM by design.
import { EVIDENCE_KIND, alternateSitesIn, runCorpus, summaryMarkdown, totals } from '../../lab/voice-corpus/runner.mjs';
// @ts-ignore Shared JavaScript scripted consumer.
import { interpret, spokenNumber } from '../../lab/voice-corpus/consumer.mjs';

const CORPUS = fileURLToPath(new URL('../../fixtures/voice-cases.json', import.meta.url));

const ROUTINE = ['V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08', 'V09', 'V10'];
const LIFECYCLE = ['V21', 'V22', 'V23', 'V24', 'V25', 'V26', 'V27', 'V28', 'V29'];

/** One host for the whole suite: forty sessions is slower than nineteen. */
async function play(only: string[]) {
  const host = await createSyntheticCorpusHost();
  try { return await runCorpus({ host, corpusPath: CORPUS, only }); }
  finally { await host.close(); }
}

const run = await play([...ROUTINE, ...LIFECYCLE]);
const byId = (id: string) => run.results.find((entry: any) => entry.id === id);

describe('voice corpus, injected transcripts', () => {
  it('plays every requested case without a runner fault', () => {
    expect(run.results.map((entry: any) => entry.id)).toEqual([...ROUTINE, ...LIFECYCLE]);
    const broken = run.results.filter((entry: any) => entry.outcome === 'runner-error');
    expect(broken.map((entry: any) => `${entry.id}: ${entry.detail}`)).toEqual([]);
  });

  it('never mutates the wrong target, never mutates twice, never claims an unrendered change', () => {
    expect(run.totals.wrongTarget).toBe(0);
    expect(run.totals.duplicate).toBe(0);
    expect(run.totals.falseCompletion).toBe(0);
    // The invariant, case by case, so a regression names itself.
    for (const entry of run.results) {
      expect(`${entry.id}:${JSON.stringify(entry.checks)}`)
        .toBe(`${entry.id}:{"wrongTarget":false,"duplicate":false,"falseCompletion":false}`);
    }
  });

  it('labels every record as injected evidence and never as microphone evidence', () => {
    expect(run.evidence).toBe(EVIDENCE_KIND);
    expect(run.banner).toMatch(/No microphone, no wearer, no headset/u);
    for (const entry of run.results) expect(entry.evidence).toBe(EVIDENCE_KIND);
    expect(summaryMarkdown(run)).toMatch(/not speech-to-picture latency/u);
  });

  it('renders the routine commands the corpus declares as rendered mutations', () => {
    for (const id of ['V01', 'V02', 'V03', 'V06', 'V07', 'V08', 'V09', 'V10']) {
      expect(`${id}:${byId(id).outcome}`).toBe(`${id}:intended`);
    }
  });

  it('reports per-part visibility as unsupported rather than inventing a command', () => {
    // V04 and V05 ask a plain structure to hide a chain and show a component.
    // This host expresses that only through a lesson colour key, so the honest
    // outcome is the host's own refusal — not a quietly substituted opacity
    // change that would look like a hidden chain and would not be one.
    for (const id of ['V04', 'V05']) {
      const entry = byId(id);
      expect(`${id}:${entry.outcome}`).toBe(`${id}:unsupported`);
      expect(entry.detail).toMatch(/no lesson colour key/u);
      expect(entry.revisionDelta).toBe(0);
    }
  });

  it('keeps a rendered change through an interruption, and a correction from being overwritten', () => {
    expect(byId('V21').record.priorReceiptStatus).toBe('rendered');
    expect(byId('V21').record.lifecycleCancelled).toBe(0);
    expect(byId('V22').record.supersededStatus).toBe('superseded');
    expect(byId('V22').record.replayRefusal).toMatch(/superseded/u);
    expect(byId('V22').outcome).toBe('intended');
  });

  it('cancels a pending command without moving the saved scene', () => {
    expect(byId('V23').record.cancelledStatus).toBe('cancelled');
    expect(byId('V23').revisionDelta).toBe(0);
  });

  it('takes back exactly the last change', () => {
    expect(byId('V24').record.representationBeforeUndo).toBe('ball-and-stick');
    expect(byId('V24').record.representationAfterUndo).toBe('cartoon');
    expect(byId('V24').record.mismatch).toBeUndefined();
  });

  it('repeats an absolute scale without compounding it', () => {
    expect(byId('V25').record.receipts).toEqual(['rendered', 'rendered']);
    expect(byId('V25').record.scale).toBe(1.25);
  });

  it('admits a duplicated non-idempotent delivery once', () => {
    expect(byId('V26').record.sameReceipt).toBe(true);
    expect(byId('V26').record.admissions).toEqual([true, false]);
    expect(byId('V26').record.revisionsAdvanced).toBe(1);
  });

  it('holds a withheld acknowledgment at rendering and reconciles without a second delivery', () => {
    expect(byId('V27').record.duringHold).toBe('rendering');
    expect(byId('V27').record.secondDelivery).toBe('none');
    expect(byId('V27').outcome).toBe('intended');
  });

  it('refuses an utterance aimed at another inspection and one aimed at a stale revision', () => {
    expect(byId('V28').outcome).toBe('refusal');
    expect(byId('V28').record.refusal).toMatch(/does not belong/u);
    expect(byId('V29').outcome).toBe('refusal');
    expect(byId('V29').record.refusal).toMatch(/changed since this utterance/u);
  });

  it('resolves insertion codes and assembly copies as distinct scientific identities', () => {
    // V07 asks for author residue 15 with no insertion code; the same author
    // number also exists as 15A. Picking either at random is the defect.
    const selected = byId('V07').record.target;
    expect(selected).toHaveLength(1);
    expect(JSON.parse(selected[0])).toEqual(expect.arrayContaining(['X', 1, 15, '']));
  });

  /**
   * The device case for that defect. It is not played here — the corpus
   * plays the routine and lifecycle groups — so what this pins is that the
   * qualification script still carries the case, and still forbids the thing
   * the pass saw: a zod issue list answering a spoken chain letter.
   */
  it('carries the bare chain letter case, and forbids schema text in its answer', () => {
    const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
    const spoken = corpus.cases.find((entry: any) => entry.id === 'V41');
    expect(spoken).toMatchObject({ utterance: 'Hide chain A.', status: 'not_run',
      expectedOutcomeType: 'rendered_mutation', classification: 'clear_command' });
    expect(spoken.forbiddenOutcomes[0]).toMatch(/schema path, type name or validation code/u);
    expect(spoken.allowedOutcome).toMatch(/label chain and copy id pair/u);
  });

  /**
   * The three device cases from the pass. Like V41 they
   * are not played here; what this pins is that the qualification script
   * carries them, and still forbids what that pass saw — a zod dump for the
   * word "surface", a misheard noun silently changing the target, and a
   * refusal that reached the terminal and nothing else.
   */
  it('carries the surface, residue and insecure-source cases with their forbidden outcomes', () => {
    const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
    const find = (id: string) => corpus.cases.find((entry: any) => entry.id === id);

    expect(find('V42')).toMatchObject({ utterance: 'Show the surface.', status: 'not_run',
      expectedOutcomeType: 'rendered_mutation', classification: 'clear_command' });
    expect(find('V42').forbiddenOutcomes[0]).toMatch(/schema path, type name or validation code/u);
    expect(find('V42').allowedOutcome).toMatch(/sticks, ball and stick, ribbon, spheres and spacefill/u);

    expect(find('V43')).toMatchObject({ utterance: 'Go to residue 141.', status: 'not_run',
      fixture: ['public_4hhb'], expectedOutcomeType: 'rendered_mutation' });
    expect(find('V43').allowedOutcome).toMatch(/rule heard-resident/u);
    expect(find('V43').forbiddenOutcomes[1]).toMatch(/raw transcript is overwritten/u);

    expect(find('V44')).toMatchObject({ status: 'not_run', expectedOutcomeType: 'refusal_without_mutation' });
    expect(find('V44').forbiddenOutcomes[0]).toMatch(/reaches only the agent terminal/u);

    // Every fixture a case names has to be defined, or the trial cannot be set up.
    for (const entry of corpus.cases) {
      for (const fixture of entry.fixture ?? []) expect(Object.keys(corpus.fixtureDefinitions)).toContain(fixture);
    }
  });

  it('counts the corpus bars over scripted cases only, and says so', () => {
    const measured = totals(run.results);
    expect(measured.scripted).toBe(run.results.length);
    expect(measured.corpusBar).toMatch(/real speech/u);
    expect(measured.appropriateOverScripted).toBeLessThanOrEqual(measured.scripted);
  });
});

describe('the scripted consumer is a table, not a model', () => {
  it('reads the spoken numbers the corpus actually says', () => {
    expect(spokenNumber('fifteen')).toBe(15);
    expect(spokenNumber('fifty')).toBe(50);
    expect(spokenNumber('one hundred twenty-five')).toBe(125);
    expect(spokenNumber('three')).toBe(3);
    expect(spokenNumber('a handful')).toBeUndefined();
  });

  it('reads a disjunction and a quotation before the selector they look like', () => {
    expect(interpret('Select residue fifteen in author chain A or eight.').kind).toBe('ambiguous');
    expect(interpret('In author chain X, select residue fifteen or fifty.').kind).toBe('ambiguous');
    expect(interpret('For my notes, the phrase is hide chain X. I am quoting it, not asking you to change the view.').kind)
      .toBe('quotation');
  });

  it('leaves an utterance no rule claims to a model rather than guessing', () => {
    expect(interpret('Make it look nicer, would you.')).toMatchObject({ rule: null, kind: 'unmatched' });
  });

  it('reads the alternate sites a fixture declares rather than asserting them', async () => {
    const { readFile } = await import('node:fs/promises');
    const cif = await readFile(fileURLToPath(new URL('../../fixtures/identity-edge.cif', import.meta.url)), 'utf8');
    expect(alternateSitesIn(cif)).toEqual(['A', 'B']);
  });
});
