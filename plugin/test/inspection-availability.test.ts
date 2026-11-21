import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as contract from '../src/inspection-contract.js';
import { choosePanel, COMPANION_CATCH_UP_WAIT_MS, COMPANION_LOADING_MESSAGE, fillAgentArguments, PANEL_BLUR_POLL_MS, PANEL_BLUR_WAIT_MS, sentAfterBlurNote } from '../scripts/agent-arguments.js';
import { bindArguments } from '../scripts/inspection-agent.js';
import { detectHiddenSession, HIDDEN_SESSION_ADVICE } from '../scripts/headset-drive.js';
import { panelAvailability } from '../src/inspection-panel-recovery.js';
import { sameEntryScene } from '../src/inspection-render-settle.js';

const hiddenAdvice = 'The headset\'s own dialog or guardian has suspended the immersive session. '
  + 'A person must clear it on the headset (press Confirm or reset the boundary). Retrying will not help while the session stays hidden.';
const blurredAdvice = 'A headset system overlay has focus. Dismiss it on the headset to return focus to the immersive session.';
const busyAdvice = 'Let the panel finish, then try again.';
const cases = [
  ['hidden', 'hidden-session', hiddenAdvice],
  ['visible-blurred', 'blurred', blurredAdvice],
  ['visible', 'busy', busyAdvice],
] as const;
const panel = (sessionVisibility: string | null, overrides = {}) => ({
  panelId: 'quest', surface: 'companion', availability: 'busy', current: true,
  xrStartup: { presenting: true, sessionVisibility }, ...overrides,
});
const state = (panels: ReturnType<typeof panel>[]) => ({
  serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1,
  panels, pendingCommand: [], commands: [],
});
const control = { origin: 'http://127.0.0.1:12345', token: 'synthetic', sessionId: 'session' };
afterEach(() => vi.useRealTimers());

describe('panel availability cause', () => {
  it.each(cases)('classifies a presenting %s session as %s', (sessionVisibility, cause) => {
    expect(contract.classifyPanelAvailability({ presenting: true, sessionVisibility })).toBe(cause);
  });

  it.each([undefined, null, {}, { presenting: false, sessionVisibility: 'hidden' },
    { presenting: false, sessionVisibility: 'visible-blurred' }, { sessionVisibility: 'hidden' },
    { presenting: true }, { presenting: true, sessionVisibility: null },
    { presenting: true, sessionVisibility: 'unknown' }])('keeps missing or nonpresenting telemetry busy: %j', startup => {
    expect(contract.classifyPanelAvailability(startup)).toBe('busy');
  });

  it('validates the bounded state field, including no busy cause for a ready or unsaved panel', () => {
    for (const value of ['hidden-session', 'blurred', 'busy', null])
      expect(contract.availabilityCauseSchema.safeParse(value).success).toBe(true);
    for (const value of ['hidden', 'rendering', '', undefined, {}, 1])
      expect(contract.availabilityCauseSchema.safeParse(value).success).toBe(false);
  });
});

describe('a headset page drawing its structure again', () => {
  const desk = { panelId: 'desk', surface: 'desktop', availability: 'ready', current: true };
  const loading = (panels: any[]) => ({ ...state(panels as any), companionLoading: true, companionRegistered: true });

  it('waits for the page to register again and sends the command to it, not to the Mac', async () => {
    vi.useFakeTimers();
    const reads = [loading([desk]), loading([desk]), loading([desk]),
      state([desk, { panelId: 'quest', surface: 'companion', availability: 'ready', current: true }] as any)];
    const request = vi.fn(async () => ({ structuredContent: reads.shift() ?? reads.at(-1) }));
    const outcome = bindArguments(control, 'update_inspection', {}, request);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ arguments: { panelId: 'quest' }, waitedMs: 3 * PANEL_BLUR_POLL_MS, reloaded: true });
    expect(sentAfterBlurNote(3 * PANEL_BLUR_POLL_MS, true)).toBe('Sent after the headset page came back from drawing its structure again (waited 1.2 s).');
  });

  it('waits for a page catching up with the saved view, listed behind and unsaved', async () => {
    vi.useFakeTimers();
    const behind = { panelId: 'quest', surface: 'companion', availability: 'unsaved', current: false };
    const reads = [state([desk, behind] as any), state([desk, behind] as any),
      state([desk, { panelId: 'quest-2', surface: 'companion', availability: 'ready', current: true }] as any)];
    const request = vi.fn(async () => ({ structuredContent: reads.shift() ?? reads.at(-1) }));
    const outcome = bindArguments(control, 'control_tour', { action: 'next' }, request);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ arguments: { panelId: 'quest-2' }, waitedMs: 2 * PANEL_BLUR_POLL_MS });
  });

  it('still refuses with the loading sentence when the page does not come back', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ structuredContent: loading([desk]) }));
    const outcome = bindArguments(control, 'update_inspection', {}, request).catch(error => error);
    await vi.runAllTimersAsync();
    expect((await outcome).message).toBe(COMPANION_LOADING_MESSAGE);
    expect(request).toHaveBeenCalledTimes(Math.ceil(COMPANION_CATCH_UP_WAIT_MS / PANEL_BLUR_POLL_MS) + 1);
  });

  it('refuses rather than sending to the Mac when the awaited headset page drops out', async () => {
    vi.useFakeTimers();
    const behind = { panelId: 'quest', surface: 'companion', availability: 'unsaved', current: false };
    const reads = [state([desk, behind] as any), state([desk] as any)];
    const request = vi.fn(async () => ({ structuredContent: reads.shift() ?? reads.at(-1) }));
    const outcome = bindArguments(control, 'update_inspection', {}, request).catch(error => error);
    await vi.runAllTimersAsync();
    expect((await outcome).message).toMatch(/^No panel is ready for a command right now \(.*companion unsaved/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps waiting while the page being replaced beats unsaved at the revision it has just installed', async () => {
    vi.useFakeTimers();
    const retiring = { panelId: 'quest', surface: 'companion', availability: 'unsaved', current: true };
    const reads = [state([desk, { ...retiring, current: false }] as any), state([desk, retiring] as any),
      state([desk, { panelId: 'quest-2', surface: 'companion', availability: 'ready', current: true }] as any)];
    const request = vi.fn(async () => ({ structuredContent: reads.shift() ?? reads.at(-1) }));
    const outcome = bindArguments(control, 'update_inspection', {}, request);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ arguments: { panelId: 'quest-2' } });
  });

  it('sends a source replacement to the host\u2019s recovery owner even after waiting for the headset page', async () => {
    vi.useFakeTimers();
    const behind = { panelId: 'quest', surface: 'companion', availability: 'unsaved', current: false };
    const reads = [state([desk, behind] as any), { ...state([desk, behind] as any), sourceRecovery: { panelId: 'desk', ready: true } }];
    const request = vi.fn(async () => ({ structuredContent: reads.shift() ?? reads.at(-1) }));
    const outcome = bindArguments(control, 'replace_inspection_source', { source: { kind: 'pdb', id: '1CRN' } }, request);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ arguments: { panelId: 'desk' } });
  });

  it('does not wait out a refusal that is not about the panel', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ structuredContent: loading([desk]) }));
    const outcome = bindArguments(control, 'replace_inspection_source', { source: { kind: 'url', url: 'http://example.test/x.cif' } }, request).catch(error => error);
    await vi.runAllTimersAsync();
    expect(request.mock.calls.length).toBeLessThanOrEqual(1);
    expect(String((await outcome)?.message ?? '')).not.toBe(COMPANION_LOADING_MESSAGE);
  });
});

describe('busy refusal diagnosis', () => {
  it.each(cases)('keeps the CLI wait and names %s at the existing refusal', async (visibility, _cause, advice) => {
    vi.useFakeTimers();
    const request = vi.fn(async (_control: unknown, _name: string) => ({ structuredContent: state([panel(visibility)]) }));
    const outcome = bindArguments(control, 'update_inspection', {}, request).catch(error => error);
    await vi.advanceTimersByTimeAsync(PANEL_BLUR_WAIT_MS - PANEL_BLUR_POLL_MS);
    expect(request).toHaveBeenCalledTimes(PANEL_BLUR_WAIT_MS / PANEL_BLUR_POLL_MS);
    await vi.advanceTimersByTimeAsync(PANEL_BLUR_POLL_MS);
    expect((await outcome).message).toBe(`No panel is ready for a command right now (companion busy for 8.0 s). ${advice}`);
    expect(request).toHaveBeenCalledTimes(PANEL_BLUR_WAIT_MS / PANEL_BLUR_POLL_MS + 1);
    expect(request.mock.calls.every(call => call[1] === 'get_inspection_state')).toBe(true);
  });

  it.each(cases)('names %s in both agent-arguments refusal branches', (visibility, _cause, advice) => {
    for (const surface of ['companion', 'desktop']) {
      const panels = [panel(visibility, { surface }), panel(visibility, { surface, panelId: 'second' })];
      const message = `No panel is ready for a command right now (${surface} busy, ${surface} busy). ${advice}`;
      expect(choosePanel(panels)).toEqual({ error: message });
      expect(() => fillAgentArguments('update_inspection', {}, state(panels))).toThrow(message);
    }
  });

  it('reads the published cause even when the client has no XR telemetry', async () => {
    vi.useFakeTimers();
    const panels = [panel(null, { xrStartup: null, availabilityCause: 'hidden-session' })];
    const outcome = bindArguments(control, 'update_inspection', {}, async () => ({ structuredContent: state(panels) }))
      .catch(error => error);
    await vi.runAllTimersAsync();
    expect((await outcome).message).toBe(`No panel is ready for a command right now (companion busy for 8.0 s). ${hiddenAdvice}`);
  });

  it('uses the last state when a system overlay becomes a hidden session during the wait', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => ({ structuredContent: state([panel(Date.now() < 400 ? 'visible-blurred' : 'hidden')]) }));
    vi.setSystemTime(0);
    const outcome = bindArguments(control, 'update_inspection', {}, request).catch(error => error);
    await vi.runAllTimersAsync();
    expect((await outcome).message).toContain(hiddenAdvice);
  });

  it('allows a hidden session to recover during the same wait without inventing a rendered receipt', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce({ structuredContent: state([panel('hidden')]) })
      .mockResolvedValue({ structuredContent: state([panel('visible', { availability: 'ready' })]) });
    const outcome = bindArguments(control, 'update_inspection', {}, request);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ arguments: { panelId: 'quest' }, waitedMs: PANEL_BLUR_POLL_MS });
    expect(await outcome).not.toHaveProperty('receipt');
  });

  it('ignores stale hidden telemetry and keeps the existing unsaved refusal', () => {
    expect(choosePanel([panel('hidden', { current: false }), panel('visible', { panelId: 'desk', surface: 'desktop' })]))
      .toEqual({ error: `No panel is ready for a command right now (desktop busy). ${busyAdvice}` });
    expect(choosePanel([panel('hidden', { availability: 'unsaved' })]))
      .toEqual({ error: `No panel is ready for a command right now (companion unsaved). ${busyAdvice}` });
  });

  it('keeps correction routing to the render owner even when that session becomes hidden', () => {
    expect(choosePanel([panel('hidden')], { interrupting: true,
      pendingCommand: [{ panelId: 'quest', status: 'rendering', renderFence: true }] })).toEqual({ panelId: 'quest' });
  });

  it('keeps the driver hidden-session advice and detection semantics', () => {
    expect(HIDDEN_SESSION_ADVICE).toBe('The session is presenting but hidden behind a Quest system dialog (usually "Confirm boundary" after the '
      + 'headset was moved), which sits outside the browser and takes a controller press. '
      + 'Put the headset on, press Confirm, set it back down, then run again with --resume-session.');
    for (const [sessionVisibility, cause] of cases)
      expect(detectHiddenSession({ presenting: true, sessionVisibility })).toBe(cause === 'hidden-session');
    expect(detectHiddenSession({ presenting: false, sessionVisibility: 'hidden' })).toBe(false);
    expect(detectHiddenSession(null)).toBe(false);
  });
});

/**
 * Unsaved work that only moved the structure or the camera.
 *
 * Reported as `unsaved`, it turned a queued `control_tour start` into
 * "The target panel has newer or unsaved local work." each time the wearer
 * scaled the molecule or the page seated it on VR entry. It is a save in
 * flight that the waiting command follows, which is what `busy` says.
 */
describe('a panel whose only unsaved work is placement', () => {
  const idle = { blocked: false, dirty: true, ready: true, interactionActive: false, navigating: false };

  it('is busy, while scientific unsaved work and a blocked panel stay unsaved', () => {
    expect(panelAvailability({ ...idle, placementOnly: true })).toBe('busy');
    expect(panelAvailability({ ...idle, placementOnly: false })).toBe('unsaved');
    expect(panelAvailability({ ...idle, blocked: true, placementOnly: true })).toBe('unsaved');
    expect(panelAvailability({ ...idle, dirty: false, placementOnly: true })).toBe('ready');
  });

  const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('inspector.ts', inspector, ts.ScriptTarget.Latest, true);
  const source = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['liveAvailability', 'placementOnlyWork'].includes(node.name?.text ?? '')).map(node => node.getText(ast)).join('\n');
  /** The page's own availability beat, over a synthetic workspace. */
  function page(captured: (scene: any) => any, flags: { dirty?: boolean; blocked?: boolean; refuses?: boolean } = {}) {
    const saved = { sourceSha256: 'a'.repeat(64), selectionKeys: ['one'], camera: { position: [0, 0, 10] },
      inspection: { appearance: { opacity: 1 }, placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
    const h: any = vm.createContext({ followRecovery: false, recoveryPanel: undefined, panelAvailability, sameEntryScene, savedScene: saved, dirty: flags.dirty ?? true,
      blocked: flags.blocked ?? false, isCompanion: true, panelTour: undefined, tourPlayer: undefined,
      workspace: { snapshot: () => ({ ready: true, interactionActive: false }), viewer: { xr: { blind: () => false } },
        capture: () => { if (flags.refuses) throw Error('Unidentified scene.'); return captured(structuredClone(saved)); } } });
    vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, h);
    return h.liveAvailability();
  }
  const placed = (scene: any) => { scene.inspection.placement = { translation: [.4, -.2, -1.6], rotation: [0, 30, 0], scale: 1.9 };
    scene.camera.position = [0, 1.6, 0]; return scene; };

  it('reports a grab, a stick nudge or the entry seat as busy from the page itself', () => {
    expect(page(placed)).toBe('busy');
    // Key order is transport syntax, not a change.
    expect(page(scene => placed({ inspection: { placement: scene.inspection.placement, appearance: scene.inspection.appearance },
      camera: scene.camera, selectionKeys: scene.selectionKeys, sourceSha256: scene.sourceSha256 }))).toBe('busy');
  });

  it('reports a colour, a selection, a blocked save or an unreadable capture as unsaved', () => {
    expect(page(scene => { scene.inspection.appearance.opacity = .4; return placed(scene); })).toBe('unsaved');
    expect(page(scene => { scene.selectionKeys = []; return scene; })).toBe('unsaved');
    expect(page(placed, { blocked: true })).toBe('unsaved');
    expect(page(placed, { refuses: true })).toBe('unsaved');
    expect(page(placed, { dirty: false })).toBe('ready');
  });
});
