/**
 * What a driven menu row has to prove before the run calls it a pass.
 *
 * Until recently a `menu:<id>` step passed the moment the page hook returned
 * `pressed`, which meant the row's action reached the toolbar chain and nothing
 * else, not that a person pressing the row would have seen it work. Two things
 * close that gap, and both are tested here without a headset:
 * every row now names the change its press must produce, and an aimed step
 * reaches the row through a simulated controller pose and the toolbar's own hit
 * test rather than through the hook's action shortcut.
 *
 * Nothing in this file touches a device, and nothing in it simulates a wearer.
 */
import { describe, expect, it } from 'vitest';
import {
  DRIVE_AIM_MISS, DRIVE_METHOD_PRESS, DRIVE_METHOD_RAY, MENU_ROW_EXPECTATIONS, OBSERVE_MENU_EXPRESSION,
  SEQUENCE_SUBROW_EXPECTATION, SYNTHETIC_INPUT_SENTENCE, VERIFY_POLL_MS, VERIFY_TIMEOUT_MS,
  aimStepArguments, buildReport, describeReading, expectationHeld, formatDriveSummary, menuStepArguments,
  rowExpectation, summarizeDrive, verifyMiss, verifyRowOutcome,
} from '../scripts/headset-drive.js';
import type { DiagnosticRecord, DriveStep, MenuObservation, StepResult } from '../scripts/headset-drive.js';
// @ts-ignore Shared JavaScript page hook; the lab is plain ESM by design.
import { menuHookState } from '../../lab/browser-roundtrip/spatial-menu-hook.mjs';
// @ts-ignore Shared JavaScript sequence browser; the lab is plain ESM by design.
import { createSequenceNavigation } from '../../lab/browser-roundtrip/sequence-navigation.mjs';
// @ts-ignore Shared JavaScript row builder; the lab is plain ESM by design.
import { spatialToolbarRows } from '../../lab/browser-roundtrip/spatial-toolbar-content.mjs';

const rows = (...ids: string[]) => ids.map(id => ({ id, label: id, active: true }));
const observation = (state: Record<string, unknown> | null, ...ids: string[]): MenuObservation =>
  ({ rows: ids.length ? rows(...ids) : rows('talk', 'menu', 'mode', 'move'), state });
const held = (id: string, before: MenuObservation, after: MenuObservation, entries: DiagnosticRecord[] = []) =>
  expectationHeld(rowExpectation(id)!, before, after, entries);

describe('the expectation table', () => {
  it('covers every row the shipped toolbar draws', () => {
    // The ids the shipped toolbar draws; a build that adds one without an
    // expectation must be caught here rather than pass unverified on a device.
    const shipped = ['talk', 'tour', 'tours', 'next', 'back', 'done', 'page', 'reset', 'room', 'molstar', 'menu',
      'mode', 'above', 'reach', 'motion', 'fit', 'quality', 'sequence', 'scale-up', 'scale-down',
      'x-up', 'x-down', 'y-up', 'y-down', 'z-up', 'z-down', 'move',
      'appearance-cartoon', 'appearance-ball-and-stick', 'appearance-molecular-surface',
      'appearance-chain-id', 'appearance-element-symbol', 'appearance-opacity-down', 'appearance-opacity-up',
      // D32's source-description paging row.
      'description-page'];
    for (const id of shipped) expect(rowExpectation(id), `no expectation for ${id}`).toBeTruthy();
    for (const [id, expectation] of Object.entries(MENU_ROW_EXPECTATIONS)) {
      expect(expectation.expected, id).toMatch(/^[a-z]/u);
      expect(Boolean(expectation.read) !== Boolean(expectation.diagnostic), id).toBe(true);
    }
  });

  it('holds the Sequence row to the browser actually opening over the menu', () => {
    // Until now this row answered "no expectation for the
    // row sequence, so its outcome was not checked" and the step passed on the
    // press alone. The page publishes `sequence.open` through the same spatial
    // state every other row is read from, and opening swaps the whole row set.
    const shut = observation({ sequence: { open: false, index: null } }, 'talk', 'menu', 'sequence');
    const open = observation({ sequence: { open: true, index: null } },
      'talk', 'sequence-detail-a12', 'sequence-previous', 'sequence-next', 'sequence-tools', 'sequence-close');
    expect(held('sequence', shut, open)).toBe(true);
    // A press that changed nothing is not an outcome.
    expect(held('sequence', shut, shut)).toBe(false);
    expect(held('sequence', open, open)).toBe(false);
    // Rows that moved while the browser stayed shut are not it either.
    expect(held('sequence', shut, observation({ sequence: { open: false, index: null } },
      'talk', 'menu', 'sequence', 'move'))).toBe(false);
    // A page with no sequence reading fails rather than passing unverified,
    // even though its row set changed.
    expect(held('sequence', observation(null, 'talk', 'sequence'),
      observation(null, 'talk', 'sequence-close'))).toBe(false);
    expect(rowExpectation('sequence')!.expected).toMatch(/sequence browser opens/u);
  });

  /**
   * needed `menu:sequence-next`
   * to be drivable and verifiable. Both halves were missing: Previous and Next
   * were BOTH id `sequence-page-`, so the step could not name Next at all, and
   * no expectation covered any row the browser draws.
   */
  it('verifies every sub-row the sequence browser draws, by prefix', () => {
    const page1 = observation({ sequence: { open: true, index: 0 } },
      'talk', 'sequence-detail-a1', 'sequence-detail-a2', 'sequence-previous', 'sequence-next', 'sequence-tools', 'sequence-close');
    const page2 = observation({ sequence: { open: true, index: 1 } },
      'talk', 'sequence-detail-a5', 'sequence-detail-a6', 'sequence-previous', 'sequence-next', 'sequence-tools', 'sequence-close');
    for (const id of ['sequence-next', 'sequence-previous', 'sequence-tools', 'sequence-close',
      'sequence-goto', 'sequence-chain-0', 'sequence-detail-a12', 'sequence-chains']) {
      expect(rowExpectation(id), `no expectation for ${id}`).toBeTruthy();
      expect(rowExpectation(id)).toBe(SEQUENCE_SUBROW_EXPECTATION);
    }
    expect(held('sequence-next', page1, page2)).toBe(true);
    // A press that turned nothing is not an outcome.
    expect(held('sequence-next', page2, page2)).toBe(false);
    // A build that publishes no sequence reading fails rather than passing.
    expect(held('sequence-next', observation(null, 'talk', 'sequence-next'),
      observation(null, 'talk', 'sequence-previous'))).toBe(false);
    // Opening a sub-page is an outcome: the rows change even at one page index.
    const tools = observation({ sequence: { open: true, index: 1 } },
      'talk', 'sequence-chains', 'sequence-find', 'sequence-browse');
    expect(held('sequence-tools', page2, tools)).toBe(true);
  });

  /**
   * A `Value +` press on the
   * Find pad moves one digit and nothing else — same sub-page, same row ids,
   * same `open` — so before the pad published its own reading this expectation
   * called a press that worked a press that changed nothing.
   */
  it('verifies a Find pad press from the value the pad publishes', () => {
    const padRows = ['talk', 'sequence-find-value', 'sequence-find-digit-left', 'sequence-find-digit-right',
      'sequence-find-up', 'sequence-find-down', 'sequence-find-sign', 'sequence-goto', 'sequence-browse'];
    const pad = (value: number) => observation(
      { sequence: { open: true, page: 0, find: { editing: true, numbering: 'author', negative: false, value } } }, ...padRows);
    for (const id of ['sequence-find-value', 'sequence-find-up', 'sequence-find-down',
      'sequence-find-digit-left', 'sequence-find-digit-right', 'sequence-find-sign']) {
      expect(rowExpectation(id), `no expectation for ${id}`).toBe(SEQUENCE_SUBROW_EXPECTATION);
    }
    expect(held('sequence-find-up', pad(0), pad(1))).toBe(true);
    // A press that moved no digit is still not an outcome.
    expect(held('sequence-find-up', pad(1), pad(1))).toBe(false);
    // A build that publishes no Find reading at all fails rather than passes.
    expect(held('sequence-find-up', observation({ sequence: { open: true } }, ...padRows),
      observation({ sequence: { open: true } }, ...padRows))).toBe(false);
    // The browser's own page number is read as well, so a page turn on a build
    // that publishes `page` rather than `index` is an outcome.
    const paged = (page: number) => observation({ sequence: { open: true, page } },
      'talk', 'sequence-detail-a1', 'sequence-previous', 'sequence-next', 'sequence-tools', 'sequence-close');
    expect(held('sequence-next', paged(0), paged(1))).toBe(true);
    expect(held('sequence-next', paged(1), paged(1))).toBe(false);
  });

  /**
   * The readings above are hand-written, and the page's own reducer is what
   * decides which of them ever reach a driver. It published `{open, index}`,
   * so every one of the ten Find-pad presses on the Quest 2 read
   * `[true, null, null, null, <row ids>]` before and after and timed out
   * UNVERIFIED at 12.5 s while the pad advanced one digit on the display. This
   * runs the shipped reducer over the shipped browser, so the driver's reading
   * and the page's publication are proved against each other and not against a
   * fixture either side could drift from.
   */
  it('verifies a Find pad press through the reading the page hook publishes', () => {
    const source = { binding: 'source:1', available: true, modelNumber: 1, assemblyId: '1', selectionKeys: [],
      rows: Array.from({ length: 40 }, (_unused, index) => ({ key: `one:${index + 1}:`, coordinateState: 'resolved',
        identity: { modelNumber: 1, assemblyId: '1', copyId: 'one', entityId: '1', labelChain: 'A', authorChain: 'X',
          operatorIds: ['one'], componentId: 'ALA', authorResidue: index + 1, labelSequenceId: index + 1, insertionCode: '' } })) };
    const navigation = createSequenceNavigation(() => source);
    const run = (op: string, extra: Record<string, unknown> = {}) =>
      navigation.act({ kind: 'sequence', ...navigation.snapshot(), op, ...extra });
    // The observation a driver actually takes: the hook's rows and the hook's
    // reduced state, both off the same live browser.
    const look = (): MenuObservation => {
      const snapshot = navigation.snapshot();
      return { rows: snapshot.rows.map((row: { id: string; label: string; state?: boolean }) =>
        ({ id: row.id, label: row.label, active: row.state !== true })),
      state: menuHookState({ sequence: snapshot }) };
    };
    run('open'); run('tools'); run('find');
    const padOpen = look();
    expect(padOpen.rows.map(row => row.id)).toContain('sequence-find-up');
    // Nine presses of one digit — the pad wraps on the tenth. Every one of
    // them must be an outcome, and each is visible only in the Find reading.
    let before = padOpen;
    for (let press = 0; press < 9; press += 1) {
      run('value', { delta: 1 });
      const after = look();
      expect(`press ${press + 1}: ${JSON.stringify(after.rows.map(row => row.id))}`)
        .toBe(`press ${press + 1}: ${JSON.stringify(before.rows.map(row => row.id))}`);
      expect(held('sequence-find-up', before, after)).toBe(true);
      before = after;
    }
    expect((before.state as { sequence: { find: { label: string } } }).sequence.find.label).toBe('A000009');
    // The rest of the pad, and the chain tab the expectation's sentence
    // promises: each row moves a field the hook publishes.
    const sign = (run('sign'), look());
    expect(held('sequence-find-sign', before, sign)).toBe(true);
    const numbering = (run('numbering'), look());
    expect(held('sequence-find-value', sign, numbering)).toBe(true);
    const digit = (run('digit', { delta: -1 }), look());
    expect(held('sequence-find-digit-left', numbering, digit)).toBe(true);
  });

  /**
   * Six presses of the `description-page` row turned the page on the display —
   * `Pg 1/6` to `Pg 6/6` and back — and every one reported "this script has no
   * expectation for the row description-page, so its outcome was not checked".
   * Same construction as the Find pad above: the shipped row builder draws the
   * label, the shipped reducer publishes the index, and the driver's reading is
   * proved against both rather than against a fixture either side could drift
   * from.
   */
  it('verifies a description-page press from the index the plate publishes', () => {
    const count = 6;
    const look = (index: number): MenuObservation => ({
      rows: spatialToolbarRows({ collapsed: false, readout: { descriptionPageCount: count, descriptionPageIndex: index } })
        .map((row: { id: string; label: string; state?: boolean }) => ({ id: row.id, label: row.label, active: row.state !== true })),
      state: menuHookState({ readout: { descriptionPageCount: count, descriptionPageIndex: index } }),
    });
    expect(look(0).rows.map(row => row.id)).toContain('description-page');
    expect(look(0).rows.find(row => row.id === 'description-page')!.label).toBe('Pg 1/6');
    // An earlier run read the row list byte-identical before and after every press, so the
    // index and the label are the only outcome there is. All six, including the
    // wrap back to page one.
    for (let press = 0; press < count; press += 1) {
      const before = look(press), after = look((press + 1) % count);
      expect(`press ${press + 1}: ${JSON.stringify(after.rows.map(row => row.id))}`)
        .toBe(`press ${press + 1}: ${JSON.stringify(before.rows.map(row => row.id))}`);
      expect(held('description-page', before, after)).toBe(true);
    }
    // A press that changed nothing is not an outcome.
    expect(held('description-page', look(2), look(2))).toBe(false);
    // A build that publishes no readout still holds on the label the wearer
    // reads, rather than passing unverified.
    const unpublished = (index: number): MenuObservation => ({ ...look(index), state: menuHookState({}) });
    expect(held('description-page', unpublished(0), unpublished(1))).toBe(true);
    expect(held('description-page', unpublished(3), unpublished(3))).toBe(false);
  });

  it('refuses to verify a row it has never heard of, instead of passing it', () => {
    expect(rowExpectation('invented-by-another-pass')).toBeUndefined();
    // Object.prototype keys must not answer as expectations.
    expect(rowExpectation('constructor')).toBeUndefined();
    expect(rowExpectation('toString')).toBeUndefined();
  });

  it('holds only when the appearance row produced the appearance it names', () => {
    const before = observation({ appearance: { representation: 'cartoon', color: 'chain-id', opacity: 1 } });
    const after = observation({ appearance: { representation: 'molecular-surface', color: 'chain-id', opacity: 1 } });
    expect(held('appearance-molecular-surface', before, after)).toBe(true);
    // A different representation is not "the row worked", even though it changed.
    expect(held('appearance-ball-and-stick', before, after)).toBe(false);
    // Already in the wanted state is a pass: the row asks for a state, not a change.
    expect(held('appearance-cartoon', before, before)).toBe(true);
  });

  it('reads the direction of the scale and opacity rows, not merely that they moved', () => {
    const at = (scale: number, opacity: number) => observation({ placement: { scale }, appearance: { opacity } });
    expect(held('scale-up', at(1, 1), at(1.15, 1))).toBe(true);
    expect(held('scale-up', at(1, 1), at(0.87, 1))).toBe(false);
    expect(held('scale-down', at(1, 1), at(0.87, 1))).toBe(true);
    expect(held('appearance-opacity-down', at(1, 1), at(1, 0.85))).toBe(true);
    expect(held('appearance-opacity-up', at(1, 1), at(1, 0.85))).toBe(false);
    // An unreadable number never counts as movement in either direction.
    expect(held('scale-up', at(1, 1), observation({ placement: {} }))).toBe(false);
  });

  it('holds for a nudge when either the translation or the rotation moved', () => {
    const before = observation({ placement: { translation: [0, 0, 0], rotation: [0, 0, 0] } });
    expect(held('x-up', before, observation({ placement: { translation: [0.2, 0, 0], rotation: [0, 0, 0] } }))).toBe(true);
    expect(held('x-up', before, observation({ placement: { translation: [0, 0, 0], rotation: [15, 0, 0] } }))).toBe(true);
    expect(held('x-up', before, before)).toBe(false);
  });

  it('reads the fold from the Menu row label and the row count together', () => {
    const compact = observation(null, 'talk', 'menu', 'move');
    const open = { rows: [{ id: 'menu', label: 'Close', active: true }, ...rows('mode', 'fit')], state: null };
    expect(held('menu', compact, open)).toBe(true);
    expect(held('menu', compact, compact)).toBe(false);
  });

  it('treats the Mol* handoff as the menu going away, not as a state change', () => {
    expect(held('molstar', observation(null, 'talk', 'molstar'), { rows: [], state: null })).toBe(true);
    expect(held('molstar', observation(null, 'talk', 'molstar'), observation(null, 'talk', 'molstar'))).toBe(false);
  });

  it('proves a re-seat from the diagnostic it writes, because the drawn state does not move', () => {
    const idle = observation({ placement: { translation: [0, 0, 0] } });
    expect(held('move', idle, idle, [])).toBe(false);
    expect(held('move', idle, idle, [{ kind: 'component-label-layout', detail: { menuReason: 'reseat' } }])).toBe(true);
    expect(held('move', idle, idle, [{ kind: 'component-label-layout', detail: { menuReason: 'follow' } }])).toBe(false);
    expect(held('reset', idle, idle, [{ kind: 'xr-button', detail: { action: 'recenter-structure' } }])).toBe(true);
    expect(held('fit', idle, idle, [{ kind: 'xr-button', detail: { action: 'grab' } }])).toBe(false);
  });

  /**
   * The Quest 2 failure this expectation caused
   * The layout record is written
   * only when component name plates are wanted or drawn, so on a plain scene the
   * Move row re-seated the menu and proved nothing, and both `aim:move` and
   * `menu:move` reported "the outcome never arrived" after 12.4 s.
   */
  it('accepts the toolbar own seat receipt, so a scene with no name plates can prove Move', () => {
    const idle = observation({ placement: { translation: [0, 0, 0] } });
    const receipt = (detail: Record<string, unknown>) => [{ kind: 'toolbar', detail }];
    expect(held('move', idle, idle, receipt({ phase: 'seat-commit', reason: 'menu', motion: 'reseat', reseated: true }))).toBe(true);
    expect(held('move', idle, idle, receipt({ phase: 'seat-commit', reason: 'menu', motion: 'collapse,reseat', reseated: true }))).toBe(true);
    // A first draw seats the column without the wearer asking, and a followed
    // scene moved nothing the wearer pressed for. Neither proves the row.
    expect(held('move', idle, idle, receipt({ phase: 'seat-commit', reason: 'entry', motion: 'seat', reseated: false }))).toBe(false);
    expect(held('move', idle, idle, receipt({ phase: 'selectstart', hit: 'Move' }))).toBe(false);
    expect(held('move', idle, idle, [{ kind: 'toolbar-action', detail: { kind: 'recenter-menu' } }])).toBe(false);
  });

  it('keeps a long reading printable on one log line', () => {
    expect(describeReading(null)).toBe('null');
    const long = describeReading(Array.from({ length: 200 }, (_, index) => index));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('...')).toBe(true);
  });
});

describe('the verification poll', () => {
  const host = (readings: MenuObservation[], entries: DiagnosticRecord[][] = []) => {
    let call = 0;
    return {
      polls: () => call,
      drainDiagnostics: async () => entries[call] ?? [],
      observeMenu: async () => readings[Math.min(call++, readings.length - 1)]!,
    };
  };
  const clock = () => { let value = 0; return { now: () => value, wait: async (seconds: number) => { value += seconds * 1000; } }; };

  it('stops as soon as the outcome arrives and reports how long it waited', async () => {
    const before = observation({ motion: { paused: true } });
    const timer = clock();
    const outcome = await verifyRowOutcome(host([before, before, observation({ motion: { paused: false } })]),
      'motion', before, { ...timer });
    expect(outcome.verified).toBe(true);
    expect(outcome.polls).toBe(3);
    expect(outcome.waitedMs).toBe(VERIFY_POLL_MS * 2);
    expect(outcome.expected).toBe('the spin starts or stops');
  });

  it('gives up at its own bound and prints both readings rather than passing', async () => {
    const before = observation({ motion: { paused: true } });
    const timer = clock();
    const outcome = await verifyRowOutcome(host([before]), 'motion', before, { ...timer });
    expect(outcome.verified).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(VERIFY_TIMEOUT_MS);
    expect(outcome.observed).toContain('before true');
    expect(outcome.observed).toContain('after true');
  });

  it('accumulates diagnostics across polls, so a late record still proves a re-seat', async () => {
    const idle = observation(null);
    const timer = clock();
    const outcome = await verifyRowOutcome(host([idle, idle, idle],
      [[], [], [{ kind: 'component-label-layout', detail: { menuReason: 'seat' } }]]), 'move', idle, { ...timer });
    expect(outcome.verified).toBe(true);
    expect(outcome.polls).toBe(3);
    expect(outcome.entries).toHaveLength(1);
  });

  it('reads a page that has stopped answering as a menu that is gone, and says so', async () => {
    const before = observation(null, 'talk', 'molstar');
    const timer = clock();
    const dead = {
      drainDiagnostics: async () => { throw Error('the debugger lists no Stereofold page'); },
      observeMenu: async () => { throw Error('the debugger lists no Stereofold page'); },
    };
    const outcome = await verifyRowOutcome(dead, 'molstar', before, { ...timer });
    expect(outcome.verified).toBe(true);
    expect(outcome.observed).toContain('the page stopped answering');
    // The same silence does not verify a row whose outcome lives in drawn state.
    const spin = await verifyRowOutcome(dead, 'motion', observation({ motion: { paused: true } }), { ...timer });
    expect(spin.verified).toBe(false);
    expect(spin.observed).toContain('the page stopped answering');
  });

  it('says plainly that an unknown row was not checked, and never calls it verified', async () => {
    const idle = observation(null, 'invented');
    const timer = clock();
    const outcome = await verifyRowOutcome(host([idle]), 'invented', idle, { ...timer });
    expect(outcome.verified).toBe(false);
    expect(outcome.expected).toContain('no expectation for the row invented');
    expect(outcome.polls).toBe(1);
  });

  it('passes a miss only when nothing fired and nothing moved', async () => {
    const idle = observation({ motion: { paused: true } }, 'talk', 'menu');
    const quiet = { drainDiagnostics: async () => [], observeMenu: async () => idle };
    await expect(verifyMiss(quiet, idle, { fired: false, hitId: null, reason: 'between the two columns' }))
      .resolves.toMatchObject({ verified: true });
    await expect(verifyMiss(quiet, idle, { fired: true, hitId: null })).resolves.toMatchObject({ verified: false });
    await expect(verifyMiss(quiet, idle, { fired: false, hitId: 'mode' })).resolves.toMatchObject({ verified: false });
    const moved = { drainDiagnostics: async () => [], observeMenu: async () => observation({ motion: { paused: false } }, 'talk', 'menu') };
    const drifted = await verifyMiss(moved, idle, { fired: false, hitId: null });
    expect(drifted.verified).toBe(false);
    expect(drifted.observed).toContain('the drawn state changed');
  });
});

describe('the page expressions', () => {
  const evaluate = (expression: string, page: unknown) => Function('globalThis', `return ${expression}`)(page);

  it('reads the rows and the drawn state without pressing anything', () => {
    const pageRows = rows('talk', 'menu');
    const page = { __stereofoldMenu: { rows: () => pageRows, state: () => ({ motion: { paused: true } }),
      press: () => { throw Error('observing must not press'); } } };
    expect(evaluate(OBSERVE_MENU_EXPRESSION, page))
      .toEqual({ status: 'ok', rows: pageRows, state: { motion: { paused: true } } });
    expect(evaluate(OBSERVE_MENU_EXPRESSION, {})).toEqual({ status: 'no-hook', rows: [], state: null });
  });

  it('captures the before reading in the same tick as the press', () => {
    let paused = true;
    const pageRows = rows('motion');
    const page = { __stereofoldMenu: { rows: () => pageRows, state: () => ({ motion: { paused } }),
      press: () => { paused = false; return true; } } };
    const result = evaluate(menuStepArguments('menu:motion').expression, page);
    expect(result).toEqual({ status: 'pressed', rows: pageRows, before: { rows: pageRows, state: { motion: { paused: true } } } });
  });

  it('aims without pressing, and reports the hit the toolbar decided on', () => {
    const action = aimStepArguments('aim:mode');
    expect(action).toMatchObject({ id: 'mode', captureName: 'aim-mode' });
    const aimed: string[] = [];
    const pageRows = rows('mode');
    const page = { __stereofoldAim: { at: (id: string) => { aimed.push(id); return { fired: true, hitId: id }; },
      miss: () => ({ fired: false, hitId: null }) },
    __stereofoldMenu: { rows: () => pageRows, state: () => null, press: () => { throw Error('aiming must not press'); } } };
    expect(evaluate(action.expression, page)).toEqual({ status: 'aimed', rows: pageRows,
      before: { rows: pageRows, state: null }, result: { fired: true, hitId: 'mode' } });
    expect(aimed).toEqual(['mode']);
    expect(evaluate(aimStepArguments(`aim:${DRIVE_AIM_MISS}`).expression, page))
      .toMatchObject({ result: { fired: false, hitId: null } });
    expect(evaluate(action.expression, {})).toEqual({ status: 'no-hook', rows: [] });
    expect(action.expression).not.toMatch(/\bawait\b/u);
  });

  it('refuses a step name that is neither an aim nor a menu press', () => {
    expect(() => aimStepArguments('menu:mode' as DriveStep)).toThrow(/aim:<id>/u);
    expect(() => menuStepArguments('aim:mode' as DriveStep)).toThrow(/menu:<id>/u);
  });
});

describe('the honest step log', () => {
  const step = (name: string, ok: boolean, method: string | null, verified: boolean | null): StepResult => ({
    step: name as DriveStep, ok, method, verified, detail: name,
    startedAt: '2026-09-13T08:00:00.000Z', endedAt: '2026-09-13T08:00:10.000Z',
    evidence: {}, consoleErrors: [], failedResponses: [],
  });

  it('counts verified, dispatched-only and failed separately', () => {
    const drive = summarizeDrive([
      step('open', true, null, null),
      step('menu:mode', true, DRIVE_METHOD_PRESS, true),
      step('aim:fit', true, DRIVE_METHOD_RAY, true),
      step('menu:quality', true, DRIVE_METHOD_PRESS, false),
      step('aim:room', false, DRIVE_METHOD_RAY, false),
    ]);
    expect(drive).toMatchObject({ driven: 4, verified: 2, dispatchedOnly: 1, failed: 1, syntheticInput: true });
    expect(drive.methods).toEqual([DRIVE_METHOD_PRESS, DRIVE_METHOD_RAY]);
  });

  it('says that the input was synthetic whenever a hook drove a step', () => {
    const lines = formatDriveSummary(summarizeDrive([step('aim:mode', true, DRIVE_METHOD_RAY, true)]));
    expect(lines.join(' ')).toContain(SYNTHETIC_INPUT_SENTENCE);
    expect(lines.join(' ')).toContain('1 verified, 0 dispatched-only, 0 failed');
    expect(formatDriveSummary(summarizeDrive([step('open', true, null, null)])))
      .toEqual(['No step drove the in-headset menu.']);
  });

  it('names a dispatched-only step for what it is', () => {
    const lines = formatDriveSummary(summarizeDrive([step('menu:quality', true, DRIVE_METHOD_PRESS, false)]));
    expect(lines.join(' ')).toContain('Dispatch is not success.');
  });

  it('carries the tally into report.json beside the steps', () => {
    const report = buildReport({ startedAt: '2026-09-13T08:00:00.000Z', endedAt: '2026-09-13T08:01:00.000Z',
      gate: { presenting: null, blind: null, visibility: null, readAt: '2026-09-13T08:00:00.000Z' } as never,
      options: { sharePath: '/tmp/share.json', steps: ['aim:mode'] as DriveStep[], outDir: '/tmp/out',
        resumeSession: false, settleSeconds: 4 },
      steps: [step('aim:mode', true, DRIVE_METHOD_RAY, true)] });
    expect(report.drive).toMatchObject({ driven: 1, verified: 1, syntheticInput: true });
    expect(report.steps[0]).toMatchObject({ method: DRIVE_METHOD_RAY, verified: true });
  });
});
