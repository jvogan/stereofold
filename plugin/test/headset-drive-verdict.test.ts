import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Driver, buildReport, executeDriveStep, formatDriveStep, formatDriveSummary, parseDriveArguments,
  type DiagnosticRecord, type DriveStep, type MenuObservation,
} from '../scripts/headset-drive.js';

const black = 'The device could not take a still: The headset is Awake but the panel drew nothing, so the frame is black. The session may have dropped out of immersion.';
const reason = 'Chapter 2 refused: 8535 atoms in ball-and-stick exceed the 260000-vertex headset limit at lowest detail. Staying on the current chapter.';
const panelId = 'headset-panel';
const tour = { selectedId: 'tubulin-eb3-lattice', step: 0, active: true, navigating: false };
const before = { rows: [{ id: 'next', label: 'Next', active: true }], state: { tour } };
const options = parseDriveArguments(['/tmp/share.json', '--out', '/tmp/drive-verdict', '--settle', '0']);

function harness({ note, entries = [], state = {}, initialState = {}, observation = before, pagePanelId = panelId }: {
  note?: string; entries?: DiagnosticRecord[]; state?: Record<string, unknown>; initialState?: Record<string, unknown>;
  observation?: MenuObservation; pagePanelId?: string;
} = {}) {
  const driver = new Driver({} as never, 'unused-adb', 0, {} as never, options);
  vi.spyOn(driver, 'agent').mockRejectedValue(Error('Unexpected agent call in a unit test'));
  vi.spyOn(driver, 'assertProximitySafe').mockResolvedValue({ proximityPositive: false, presenting: true, readAt: 'fixture' });
  vi.spyOn(driver, 'evaluate').mockResolvedValue(pagePanelId);
  let pressed = false;
  vi.spyOn(driver, 'inspectionState').mockImplementation(async () => ({
    panels: [{ panelId, surface: 'companion', current: true, tour }], ...(pressed ? state : initialState),
  }));
  vi.spyOn(driver, 'companionPanel').mockResolvedValue({ xrStartup: { presenting: false } });
  vi.spyOn(driver, 'observeMenu').mockResolvedValue(observation);
  vi.spyOn(driver, 'capture').mockResolvedValue({ path: '/tmp/fixture.png', via: 'fixture', ...(note ? { note } : {}) });
  let pending: DiagnosticRecord[] = [];
  vi.spyOn(driver, 'drainDiagnostics').mockImplementation(async () => pending.splice(0));
  vi.spyOn(driver, 'pressMenu').mockImplementation(async () => {
    pressed = true;
    pending.push(...entries);
    return { id: 'next', captureName: 'menu-next', expanded: null, rows: [...observation.rows], before: observation };
  });
  vi.spyOn(driver, 'aimMenu').mockImplementation(async step => {
    pressed = true;
    pending.push(...entries);
    const id = step.slice(4);
    return { id, captureName: 'aim-next', expanded: null, rows: observation.rows, before: observation,
      result: { fired: id !== 'miss', hitId: id === 'miss' ? null : id } };
  });
  return driver;
}

async function run(driver: Driver, step: DriveStep, startedAt?: string) {
  vi.useFakeTimers();
  if (startedAt) vi.setSystemTime(new Date(startedAt));
  const pending = executeDriveStep(driver, step);
  await vi.runAllTimersAsync();
  return pending;
}

function report(step: Awaited<ReturnType<typeof run>>) {
  return buildReport({ startedAt: 'fixture', endedAt: 'fixture',
    gate: { proximityPositive: false, presenting: true, readAt: 'fixture' }, options, steps: [step] });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('capture verdicts at the shared step boundary', () => {
  it.each(['aim:miss', 'exit'] as const)('fails %s with the black capture note in JSON and console', async step => {
    const result = await run(harness({ note: black }), step);
    expect(result).toMatchObject({ ok: false, failure: expect.stringContaining(black), evidence: { captureNote: black } });
    expect(formatDriveStep(result)).toMatch(/^FAIL\s/);
    expect(formatDriveStep(result)).toContain(black);
    expect(report(result)).toMatchObject({ ok: false, failures: [expect.stringContaining(black)] });
    if (step === 'aim:miss') {
      expect(report(result).drive).toMatchObject({ verified: 0, dispatchedOnly: 0, failed: 1 });
      expect(formatDriveSummary(report(result).drive).join(' ')).toContain('0 verified, 0 dispatched-only, 1 failed');
    }
  });

  it.each([undefined, 'The host has no adb configured; used the direct capture.'])('keeps a usable fallback capture passing (%s)', async note => {
    expect((await run(harness({ note }), 'aim:miss')).ok).toBe(true);
  });

  it('retains an earlier black capture when the final capture succeeds', async () => {
    const driver = harness();
    vi.mocked(driver.capture).mockRestore();
    vi.mocked(driver.agent).mockResolvedValueOnce({ content: [{ type: 'text', text: black }] } as never)
      .mockResolvedValueOnce({ structuredContent: { savedPath: '/tmp/final.png' } } as never);
    vi.spyOn(driver as any, 'screencap').mockResolvedValue({ path: '/tmp/earlier.png', via: 'fixture' });
    vi.mocked(driver.aimMenu).mockImplementation(async () => {
      await driver.capture('earlier');
      return { id: 'miss', captureName: 'final', expanded: null, rows: before.rows, before, result: { fired: false, hitId: null } };
    });
    const result = await run(driver, 'aim:miss');
    expect(result).toMatchObject({ ok: false, failure: expect.stringContaining(black.slice(0, 160)),
      evidence: { capture: '/tmp/final.png', failedCapture: '/tmp/earlier.png' } });
    expect(report(result).drive).toMatchObject({ verified: 0, failed: 1 });
  });

  it('keeps the original action failure beside the black capture note', async () => {
    const driver = harness({ note: black });
    vi.mocked(driver.aimMenu).mockRejectedValue(Error('The hit test failed.'));
    const result = await run(driver, 'aim:miss');
    expect(result).toMatchObject({ ok: false, failure: `The hit test failed. Capture failed: ${black}` });
  });

  it('does not attribute a previous step capture note to a later step', async () => {
    const driver = harness();
    driver.captureNotes.push({ path: '/tmp/previous.png', via: 'fixture', note: black });
    expect((await run(driver, 'aim:miss')).ok).toBe(true);
  });
});

const recorded = JSON.parse(readFileSync(new URL('./fixtures/headset-drive-refused-press.json', import.meta.url), 'utf8')) as {
  step: { startedAt: string; endedAt: string };
  before: Record<string, any>; after: Record<string, any>; entries: DiagnosticRecord[];
};

function recordedHarness(entries = recorded.entries, state = recorded.after, note?: string) {
  const driver = harness({ entries, state, initialState: recorded.before, note,
    pagePanelId: recorded.before.panels[0].panelId,
    observation: { rows: before.rows, state: { tour: recorded.before.panels[0].tour } },
  });
  // Replay records as their device timestamps arrive, including across polls.
  const drain = vi.mocked(driver.drainDiagnostics).getMockImplementation()!;
  const queued: DiagnosticRecord[] = [];
  vi.mocked(driver.drainDiagnostics).mockImplementation(async () => {
    queued.push(...await drain());
    const ready = queued.filter(entry => entry.at === undefined || entry.at <= Date.now());
    queued.splice(0, queued.length, ...queued.filter(entry => entry.at !== undefined && entry.at > Date.now()));
    return ready;
  });
  return driver;
}

describe('Row 7 recorded page refusal', () => {
  it.each(['menu:next', 'aim:next'] as const)('verifies %s from the real refusal and paged draw without a refused command', async step => {
    expect(recorded.after.commands).toEqual(recorded.before.commands);
    expect(recorded.after.commands.some((command: { status: string }) => command.status === 'refused')).toBe(false);
    expect(recorded.after.experience).toEqual(recorded.before.experience);
    const result = await run(recordedHarness(), step, recorded.step.startedAt);
    expect(result).toMatchObject({ ok: true, verified: true, outcome: 'refused',
      evidence: { outcome: 'refused', reason } });
    expect(formatDriveStep(result)).toContain(`[${step === 'menu:next' ? 'hook-press' : 'synthetic-ray'} verified]  refused: ${reason}`);
    expect(Date.parse(result.endedAt)).toBeGreaterThanOrEqual(recorded.entries.at(-1)!.at!);
    expect(report(result).drive).toMatchObject({ verified: 1, failed: 0 });
  });

  it('uses the page refusal reason when the host catalog is absent', async () => {
    const result = await run(recordedHarness(recorded.entries, { ...recorded.after, experienceCatalog: [] }), 'menu:next', recorded.step.startedAt);
    expect(result).toMatchObject({ ok: true, verified: true, evidence: { outcome: 'refused', reason } });
  });

  it('matches a paged draw to the refused chapter when the tool-refused entry is missing', async () => {
    const result = await run(recordedHarness(recorded.entries.filter(entry => entry.kind !== 'tool-refused')), 'menu:next', recorded.step.startedAt);
    expect(result).toMatchObject({ ok: true, verified: true, evidence: { outcome: 'refused', reason } });
  });

  it.each([
    'neither signal', 'forecast only', 'no draw', 'uncaptioned refusal', 'partial seat', 'unmeasured seat',
    'another caption', 'ambiguous prefix', 'wrong tool', 'stale binding', 'wrong action', 'wrong panel',
    'wrong chapter', 'wrong journey', 'pre-press records', 'post-window records', 'another preparation',
    'no preparation', 'empty reason', 'another refusal reason', 'chapter changed', 'journey changed', 'still navigating',
  ])('keeps the recorded press UNVERIFIED with %s', async problem => {
    let entries = structuredClone(recorded.entries);
    const state = structuredClone(recorded.after);
    const detail = (kind: string) => entries.find(entry => entry.kind === kind)!.detail!;
    if (problem === 'neither signal') { entries = []; state.experienceCatalog = []; }
    if (problem === 'forecast only') entries = [];
    if (problem === 'no draw') entries = entries.filter(entry => entry.kind !== 'talk-caption-seat');
    if (problem === 'uncaptioned refusal') detail('tool-refused').captioned = false;
    if (problem === 'partial seat') detail('talk-caption-seat').outcome = 'partial';
    if (problem === 'unmeasured seat') detail('talk-caption-seat').measured = false;
    if (problem === 'another caption') detail('talk-caption').text = 'Another answer.';
    if (problem === 'ambiguous prefix') detail('talk-caption').text = 'Chapter';
    if (problem === 'wrong tool') detail('tool-refused').tool = 'voice_acknowledgement';
    if (problem === 'stale binding') detail('tool-refused').staleBinding = true;
    if (problem === 'wrong action') detail('toolbar-action').kind = 'tour-back';
    if (problem === 'wrong panel') detail('journey').panelId = 'other';
    if (problem === 'wrong chapter') detail('journey').stepIndex = 2;
    if (problem === 'wrong journey') detail('journey').experienceId = 'other';
    if (problem === 'no preparation') entries = entries.filter(entry => entry.kind !== 'journey');
    if (problem === 'empty reason') detail('tool-refused').reason = '';
    if (problem === 'another refusal reason') detail('tool-refused').reason = reason.replace('Chapter 2', 'Chapter 3');
    if (problem === 'chapter changed') state.panels[0].tour.step = 1;
    if (problem === 'journey changed') state.panels[0].tour.selectedId = 'other';
    if (problem === 'still navigating') state.panels[0].tour.navigating = true;
    if (problem === 'pre-press records') entries.forEach(entry => { entry.at = Date.parse(recorded.step.startedAt) - 1; });
    if (problem === 'post-window records') entries.forEach(entry => { entry.at = Date.parse(recorded.step.endedAt) + 1; });
    if (problem === 'another preparation') entries.splice(2, 0, { kind: 'journey', at: entries[1].at,
      detail: { ...detail('journey'), stepIndex: 2 } });
    const result = await run(recordedHarness(entries, state), 'menu:next', recorded.step.startedAt);
    expect(result).toMatchObject({ ok: false, verified: false });
    expect(result.evidence).not.toHaveProperty('outcome');
    expect(formatDriveStep(result)).toContain('UNVERIFIED');
  });

  it('does not reuse the recorded refusal drained before this press', async () => {
    const driver = recordedHarness([]);
    vi.mocked(driver.drainDiagnostics).mockResolvedValueOnce(recorded.entries).mockResolvedValue([]);
    expect(await run(driver, 'menu:next', recorded.step.startedAt)).toMatchObject({ ok: false, verified: false });
  });

  it('rejects future-dated records even when the ring delivers them immediately', async () => {
    const entries = recorded.entries.map(entry => ({ ...entry, at: Date.parse(recorded.step.endedAt) + 1 }));
    const driver = recordedHarness([]);
    vi.mocked(driver.drainDiagnostics).mockResolvedValueOnce([]).mockResolvedValueOnce(entries).mockResolvedValue([]);
    expect(await run(driver, 'menu:next', recorded.step.startedAt)).toMatchObject({ ok: false, verified: false });
  });

  it('keeps the recorded refusal failed when the capture is black', async () => {
    const result = await run(recordedHarness(recorded.entries, recorded.after, black), 'menu:next', recorded.step.startedAt);
    expect(result).toMatchObject({ ok: false, verified: true, failure: expect.stringContaining(black),
      evidence: { outcome: 'refused', reason } });
    expect(formatDriveStep(result)).toContain(black);
    expect(report(result).drive).toMatchObject({ verified: 0, failed: 1 });
  });
});

const preparation: DiagnosticRecord = { kind: 'journey', detail: {
  phase: 'preparing', experienceId: tour.selectedId, stepIndex: 1, owner: panelId, panelId, finish: false,
} };
const caption: DiagnosticRecord = { kind: 'talk-caption', detail: { text: reason } };
const seat: DiagnosticRecord = { kind: 'talk-caption-seat', detail: { outcome: 'shown' } };
const catalog = [{ id: tour.selectedId, deviceBudget: { chapters: [{ stepIndex: 1, status: 'refused', message: reason }] } }];

describe('rendered press refusals', () => {
  it.each(['menu:next', 'aim:next'] as const)('verifies %s as refused when its catalog refusal was drawn', async step => {
    const driver = harness({ entries: [preparation, caption, seat], state: { experienceCatalog: catalog } });
    const result = await run(driver, step);
    expect(driver.inspectionState).toHaveBeenCalledWith({ includeExperienceCatalog: true });
    expect(result).toMatchObject({ ok: true, verified: true, evidence: { outcome: 'refused', reason } });
    expect(formatDriveStep(result)).toContain('verified');
    expect(formatDriveStep(result)).toContain(`refused: ${reason}`);
    expect(formatDriveStep(result)).not.toContain('UNVERIFIED');
    expect(report(result).drive).toMatchObject({ verified: 1, failed: 0 });
  });

  it('verifies a fresh drawn catalog refusal from the last command for this panel', async () => {
    const command = { commandId: 'press-next', panelId, status: 'refused', reason };
    const result = await run(harness({
      state: { commands: [command] },
      entries: [{ kind: 'outcome', detail: { ...command, drawn: true, seatOutcome: 'shown' } }],
    }), 'menu:next');
    expect(result).toMatchObject({ ok: true, verified: true, evidence: { outcome: 'refused', reason } });
  });

  it.each(['old command', 'wrong panel', 'queued', 'no draw', 'unmeasured', 'not a budget refusal', 'not the last command'])
    ('keeps a command refusal UNVERIFIED: %s', async problem => {
      const command = { commandId: 'press-next', panelId: problem === 'wrong panel' ? 'other' : panelId,
        status: problem === 'queued' ? 'queued' : 'refused', reason: problem === 'not a budget refusal' ? 'The page crashed.' : reason };
      const state = { commands: [command, ...(problem === 'not the last command' ? [{ ...command, commandId: 'newer', status: 'queued' }] : [])] };
      const driver = harness({ state, entries: [{ kind: 'outcome', detail: { ...command,
        drawn: problem !== 'no draw', seatOutcome: problem === 'unmeasured' ? 'unmeasured' : 'shown' } }] });
      if (problem === 'old command') vi.mocked(driver.inspectionState).mockResolvedValue({
        panels: [{ panelId, surface: 'companion', current: true, tour }], ...state,
      });
      const result = await run(driver, 'menu:next');
      expect(result).toMatchObject({ ok: false, verified: false });
      expect(formatDriveStep(result)).toContain('UNVERIFIED');
    });

  it.each([
    ['forecast only', []],
    ['no draw', [preparation, caption]],
    ['partial draw', [preparation, caption, { ...seat, detail: { outcome: 'partial' } }]],
    ['another caption', [preparation, { ...caption, detail: { text: 'Another answer.' } }, seat]],
    ['another panel', [{ ...preparation, detail: { ...preparation.detail, owner: 'other', panelId: 'other' } }, caption, seat]],
    ['another chapter', [{ ...preparation, detail: { ...preparation.detail, stepIndex: 2 } }, caption, seat]],
    ['another journey', [{ ...preparation, detail: { ...preparation.detail, experienceId: 'other' } }, caption, seat]],
    ['unmeasured draw', [preparation, caption, { ...seat, detail: { outcome: 'shown', measured: false } }]],
  ] as const)('keeps a press UNVERIFIED with %s', async (_name, entries) => {
    const result = await run(harness({ entries: [...entries], state: { experienceCatalog: catalog } }), 'menu:next');
    expect(result).toMatchObject({ ok: false, verified: false });
    expect(formatDriveStep(result)).toContain('UNVERIFIED');
  });

  it('does not reuse refusal diagnostics drained before the press', async () => {
    const driver = harness({ state: { experienceCatalog: catalog } });
    vi.mocked(driver.drainDiagnostics).mockResolvedValueOnce([preparation, caption, seat]).mockResolvedValue([]);
    expect(await run(driver, 'menu:next')).toMatchObject({ ok: false, verified: false });
  });

  it('does not accept a refusal after the menu stops answering', async () => {
    const driver = harness({ state: { experienceCatalog: catalog }, entries: [preparation, caption, seat] });
    vi.mocked(driver.observeMenu).mockRejectedValue(Error('The page stopped answering.'));
    expect(await run(driver, 'menu:next')).toMatchObject({ ok: false, verified: false });
  });

  it('fails a verified refusal when its capture is black', async () => {
    const result = await run(harness({ note: black, entries: [preparation, caption, seat], state: { experienceCatalog: catalog } }), 'menu:next');
    expect(result).toMatchObject({ ok: false, failure: expect.stringContaining(black), evidence: { outcome: 'refused', reason } });
    expect(report(result).drive).toMatchObject({ verified: 0, failed: 1 });
  });
});
