/**
 * A small, host-independent controller for a sequence of real inspection
 * scenes. The catalog stays declarative; this module is the only place that
 * turns a scene intent into calls on the Mol* workspace.
 */
// @ts-ignore Pure geometry exports are shared by the browser XR toolbar.
import { READOUT_PAGE_LINE_WIDTH, READOUT_PAGE_LINES, pageCaptionText } from '../../lab/browser-roundtrip/spatial-toolbar-geometry.mjs';
// @ts-ignore Shared JavaScript voice narration slot. the
// page's own aside channel, the one a chapter's narration gate does not govern.
import { voiceCommandSpeaker } from '../../lab/browser-roundtrip/voice-command-speaker.mjs';
import type { ChapterMotion, ChapterMotionObject, LessonVisibility, LessonStart } from './molecular-lesson.js';
import type { MolecularAnimation } from './molecular-animation.js';
import type { AnimationPatch } from '@stereo/motion';
import type { LessonFigure } from './lesson-figure.js';
// @ts-ignore Shared inspection visibility resolution, including absent chains.
import { availableChains, componentClassesPresent, emptyVisibility, resolveVisibility, visibilityHidesEverything } from '../../lab/browser-roundtrip/inspection-visibility.mjs';
// @ts-ignore Shared saved selection ownership identity.
import { selectionSignature } from '../../lab/browser-roundtrip/selection-paint.mjs';

/** Chapter dwell constant for autoplay (holds for narration length plus dwell). */
export const TOUR_AUTOPLAY_DWELL_MS = 2_500;
/** Between chapters the framing travels over 0.8-1.2 s (1.0 s default). */
export const TOUR_FRAMING_TRAVEL_MS = 1_000;

/** Cubic ease-in-out matching focusSelection / focusTravel */
export const easeInOut = (u: number): number =>
  u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;

export type NormalizedChapterMotion =
  | { kind: 'hold' }
  | { kind: 'turntable'; continuous: true }
  | { kind: 'turntable'; continuous: false; degrees: number; seconds: number }
  | { kind: 'orbit'; axis: 'x' | 'y' | 'z' | readonly [number, number, number]; degrees: number; seconds: number;
      delaySeconds?: number; easing?: TourCameraSpin['easing'] }
  | { kind: 'dolly'; metres: number; seconds: number };

export function normalizeChapterMotion(motion?: ChapterMotion): NormalizedChapterMotion | undefined {
  if (!motion) return undefined;
  if (motion === 'hold') return { kind: 'hold' };
  if (motion === 'spin') return { kind: 'turntable', continuous: true };
  if (typeof motion === 'object') {
    if (motion.kind === 'hold') return { kind: 'hold' };
    if (motion.kind === 'orbit') {
      return {
        kind: 'orbit',
        axis: motion.axis ?? 'y',
        degrees: motion.degrees,
        seconds: motion.seconds,
      };
    }
    if (motion.kind === 'dolly') {
      return {
        kind: 'dolly',
        metres: motion.metres,
        seconds: motion.seconds,
      };
    }
    if (motion.kind === 'turntable') {
      if (motion.degrees === undefined && motion.seconds === undefined) {
        return { kind: 'turntable', continuous: true };
      }
      return {
        kind: 'turntable',
        continuous: false,
        degrees: motion.degrees ?? 360,
        seconds: motion.seconds ?? 10,
      };
    }
  }
  return undefined;
}

/**
 * The chapter motion this presentation plays.
 *
 * The authored immersive motion always wins. A headset chapter that authors
 * none plays its desktop camera spin instead, as the same in-place orbit an
 * authored one ticks. The flat page plays only what it always played.
 */
export function presentedChapterMotion(step: TourStep | undefined, xr: boolean): NormalizedChapterMotion | undefined {
  const authored = normalizeChapterMotion(step?.motion);
  if (authored || !xr || !step?.cameraSpin) return authored;
  const { axis, degrees, seconds, delaySeconds, easing } = step.cameraSpin;
  return { kind: 'orbit', axis, degrees, seconds, delaySeconds, easing };
}

/** A chapter's turn in the headset, as the viewer solves its seat for it. */
export type ChapterTurnSweep = { axis: [number, number, number]; degrees: number; continuous: boolean };

/**
 * What a chapter's own turn sweeps in the headset, or nothing for a still one.
 *
 * `axis` is in render space and `degrees` is how far the drawn molecule turns
 * about it. A spin is the presentation turn about render up, without end. An
 * orbit or a timed turntable turns the camera about the drawn centre, so the
 * molecule turns the other way by the same amount.
 */
export function chapterTurnSweep(step: TourStep | undefined, xr: boolean): ChapterTurnSweep | undefined {
  if (!xr) return undefined;
  const motion = presentedChapterMotion(step, xr);
  if (motion?.kind === 'turntable')
    return motion.continuous ? { axis: [0, 1, 0], degrees: 360, continuous: true }
      : { axis: [0, 1, 0], degrees: -motion.degrees, continuous: false };
  if (motion?.kind !== 'orbit' || !Number.isFinite(motion.degrees) || motion.degrees === 0) return undefined;
  const axis = typeof motion.axis === 'string'
    ? ({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const)[motion.axis] : motion.axis;
  return { axis: [axis[0], axis[1], axis[2]], degrees: -motion.degrees, continuous: false };
}

const easings: Record<TourCameraSpin['easing'], (u: number) => number> = {
  linear: u => u, ease_in: u => u * u * u, ease_out: u => 1 - Math.pow(1 - u, 3), ease_in_out: easeInOut,
};

export type TourSelection = 'clear' | {
  chain?: string;
  componentIds?: string[];
  firstChain?: boolean;
  residues?: readonly number[] | { from: number; to: number };
};

/**
 * One lesson-wide colour key, and the one part this scene is
 * about. `parts` repeats unchanged across a lesson's chapters so a wearer
 * learns a single mapping; `focus` names the part that stays opaque while the
 * rest drops to `contextOpacity` rather than disappearing, which is what keeps
 * an emphasised part locatable inside the whole complex.
 */
export type TourEmphasisPart = {
  id: string;
  label: string;
  aliases?: readonly string[];
  color: string;
  chain?: string;
  residues?: { from: number; to: number };
};
export type TourEmphasis = {
  parts: readonly TourEmphasisPart[];
  focus?: string | readonly string[];
  /** Parts drawn in their key colour beside the focus, neither framed nor explained. */
  alsoLit?: readonly string[];
  contextOpacity?: number;
  framing?: 'fill' | 'context';
  /** Whole-structure wall chapters shade one lightness step per protofilament. */
  strandShades?: boolean;
  /**
   * Who this key belongs to.
   *
   * A lesson's key is the lesson's, so a takeover that stops the lesson takes
   * it off; a key the wearer or an agent asked for by name is theirs and
   * survives. Only the player sends 'lesson', and only ever about its own
   * chapters. It is not part of the saved scene.
   */
  origin?: 'lesson';
};

export type TourView = 'fit' | 'focus' | 'reset-orientation' | {
  orbit: { axis: 'x' | 'y' | 'z'; degrees: number };
} | { dolly: number };

/**
 * One camera move of the lesson's own chapter motion.
 *
 * Deliberately not a `TourView`: a chapter tick is presentation. It never
 * lands in a saved scene, never asks a desktop camera to move, and — on the
 * viewer's dedicated `applyLessonMotion` entry — never travels as an admitted
 * inspection mutation, which is how a chapter's own turn read as the wearer
 * grabbing the structure.
 */
export type LessonCameraMove =
  | { kind: 'orbit'; axis: 'x' | 'y' | 'z' | readonly [number, number, number]; degrees: number }
  | { kind: 'dolly'; factor: number };

/**
 * A lesson chapter's desktop `camera_spin`, carried for the headset.
 *
 * A chapter's `changes` drive the desktop movie and never reached a headset,
 * so a "Slow orbit" chapter that turned only through `camera_spin` landed its
 * authored placement and stood still in front of the wearer. A chapter that
 * authors no immersive motion carries its first spin here: `degrees` about the
 * spin's own `axis`, starting `delaySeconds` into the chapter (after the
 * changes authored before it) and lasting `seconds`, with its easing. Only a
 * presenting headset plays it (`presentedChapterMotion`).
 */
export type TourCameraSpin = {
  axis: readonly [number, number, number];
  degrees: number;
  seconds: number;
  delaySeconds: number;
  easing: 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out';
};

export type TourStep = {
  id: string;
  title: string;
  body?: string;
  description?: string;
  /** Optional desktop source disclosure, excluded from captions and speech. */
  details?: string;
  appearance?: Record<string, unknown>;
  /** Several visual changes in their deliberate presentation order. */
  appearances?: readonly Record<string, unknown>[];
  placement?: Record<string, unknown>;
  /** The lesson colour key plus the one part this scene emphasises. */
  emphasis?: TourEmphasis;
  /** Authored name catalog; aliases and extra targets never become chapter plates. */
  parts?: readonly TourEmphasisPart[];
  visibility?: LessonVisibility;
  figure?: LessonFigure;
  animation?: MolecularAnimation;
  selection?: TourSelection;
  view?: TourView;
  /** The continuous presentation turn or authored cinematic motion this scene wants. */
  motion?: ChapterMotion;
  /** The desktop camera spin a headset plays when `motion` is absent. */
  cameraSpin?: TourCameraSpin;
  /** One spoken line, said at scene start. Falls back to the caption glass alone. */
  narration?: string;
  /** Minimum dwell for a lesson scene, including its caption. */
  durationMs?: number;
  sources?: readonly { title: string; url?: string }[];
};

/**
 * An authored scale this many times the inherited one is a close-up. The
 * tolerance keeps an exact 1.5× (1.1 → 1.65) one despite floating point.
 */
const CLOSE_UP_ENLARGEMENT = 1.5, CLOSE_UP_TOLERANCE = 1e-9;

/** Stable framing identity excludes colour, labels, visibility and molecular motion. */
function framingValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

/** The desktop rule: any changed authored placement, view, framing or figure. */
function desktopChapterAuthorsFraming(tour: Tour, index: number): boolean {
  const entry = tour.steps[index], previous = tour.steps[index - 1];
  if (!entry) return false;
  const changed = (value: unknown, prior: unknown) => value !== undefined && framingValue(value) !== framingValue(prior);
  // Placement is a patch: omitted axes inherit, and repeating one axis is ordinary.
  const placement = Object.assign({}, ...tour.steps.slice(0, index).map(step => step.placement));
  if (entry.placement && Object.entries(entry.placement).some(([key, value]) => changed(value, placement[key]))) return true;
  const view = (step?: TourStep) => step?.view === 'focus'
    ? { view: step.view, selection: step.selection } : step?.view;
  if (changed(view(entry), view(previous))) return true;
  const emphasis = (step?: TourStep) => {
    if (!step) return undefined;
    const authored = stepEmphasis(step, lessonRestingState(tour));
    if (!authored.framing) return undefined;
    const focus = [authored.focus ?? []].flat();
    return { framing: authored.framing, targets: focus.length ? authored.parts
      .filter(part => focus.includes(part.id))
      .map(part => ({ chain: part.chain, residues: part.residues }))
      .map(framingValue).sort() : 'whole' };
  };
  if (changed(emphasis(entry), emphasis(previous))) return true;
  // A figure without focus frames the whole source, irrespective of its layers.
  const figure = (step?: TourStep) => step?.figure
    ? (step.figure.focus?.map(framingValue).sort() ?? 'whole') : undefined;
  return changed(figure(entry), figure(previous));
}

/**
 * Whether this chapter is an authored close-up, which may take over the
 * wearer's placement. Compare with the authored predecessor, so Back uses the
 * same entry rule as Next.
 *
 * In the headset (`xr`), only a new authored seat, a marked enlargement,
 * `view: 'focus'`, a figure focus or a targeted emphasis framing is a
 * close-up. A turn or a small resize is not: the templated orbit chapters keep
 * the wearer's placement. Neither is a whole-source view, figure or framing,
 * and an opening chapter is no close-up merely because nothing precedes it.
 * The desktop keeps its rule, where every authored change applies.
 */
export function chapterAuthorsFraming(tour: Tour, index: number, { xr = true }: { xr?: boolean } = {}): boolean {
  if (!xr) return desktopChapterAuthorsFraming(tour, index);
  const entry = tour.steps[index], previous = tour.steps[index - 1];
  if (!entry) return false;
  const changed = (value: unknown, prior: unknown) => value !== undefined && framingValue(value) !== framingValue(prior);
  // Placement is a patch: omitted axes inherit, and repeating one axis is ordinary.
  const placement: Record<string, unknown> = Object.assign({ translation: [0, 0, 0], scale: 1 }, ...tour.steps.slice(0, index).map(step => step.placement));
  if (changed(entry.placement?.translation, placement.translation)) return true;
  if (Number(entry.placement?.scale) >= CLOSE_UP_ENLARGEMENT * Number(placement.scale) * (1 - CLOSE_UP_TOLERANCE)) return true;
  const view = (step?: TourStep) => step?.view === 'focus'
    ? { view: step.view, selection: step.selection } : undefined;
  if (changed(view(entry), view(previous))) return true;
  const emphasis = (step?: TourStep) => {
    if (!step) return undefined;
    const authored = stepEmphasis(step, lessonRestingState(tour));
    const focus = [authored.focus ?? []].flat();
    if (!authored.framing || !focus.length) return undefined;
    return { framing: authored.framing, targets: authored.parts
      .filter(part => focus.includes(part.id))
      .map(part => ({ chain: part.chain, residues: part.residues }))
      .map(framingValue).sort() };
  };
  if (changed(emphasis(entry), emphasis(previous))) return true;
  const figure = (step?: TourStep) => step?.figure?.focus?.length
    ? step.figure.focus.map(framingValue).sort() : undefined;
  return changed(figure(entry), figure(previous));
}

export type Tour = { id: string; title: string; summary: string; steps: readonly TourStep[]; presentation?: TourPresentation };

/**
 * How the selected lesson presents itself in immersion.
 *
 * Authored on the manifest (`molecular-lesson.ts presentation.captionCard`)
 * and carried whole on the tour so the headset can read it off the live
 * player state. `hidden` means the caption card — chapter title, scene
 * counter and narration lines — is not drawn; narration and the Talk button
 * keep working.
 */
export type TourPresentation = { captionCard: 'hidden' | 'shown'; end?: 'rest' | 'hold'; continueToStage?: string; coordinateFrame?: string };
export type StageContinuationIntent = { isCurrent(): boolean; beginTransition(): void; shouldAutoplay(): boolean };
type Scene = unknown;
export type SavedLessonPlayback = {
  tourId: string; chapterId: string; stopped: boolean; narration?: boolean; entry?: 'start'; motionProgress?: number; motionPlaying?: boolean; cameraFrame?: 'desktop' | 'xr'; startingScene: any;
};
/** Keep Done's baseline finite even when a lesson is restarted mid-chapter. */
export function withoutLessonPlayback(scene: any): any {
  const result = structuredClone(scene);
  if (result?.inspection) { delete result.inspection.lessonPlayback; delete result.inspection.animation; }
  return result;
}
/** Check the source and current catalog before hydration can change the viewer. */
export function savedLessonPlayback(scene: any, tours: readonly Tour[]): SavedLessonPlayback | undefined {
  const saved = scene?.inspection?.lessonPlayback;
  if (saved === undefined) return undefined;
  const start = saved?.startingScene;
  if (!saved || typeof saved.tourId !== 'string' || typeof saved.chapterId !== 'string'
      || typeof saved.stopped !== 'boolean' || !start?.inspection || start.inspection.lessonPlayback !== undefined
      || (saved.narration !== undefined && typeof saved.narration !== 'boolean')
      || (saved.entry !== undefined && saved.entry !== 'start')
      || (saved.cameraFrame !== undefined && saved.cameraFrame !== 'desktop' && saved.cameraFrame !== 'xr')
      || (saved.motionPlaying !== undefined && typeof saved.motionPlaying !== 'boolean')
      || (saved.motionProgress !== undefined && (!Number.isFinite(saved.motionProgress) || saved.motionProgress < 0 || saved.motionProgress > 1))
      || start.sourceSha256 !== scene.sourceSha256 || start.modelNumber !== scene.modelNumber
      || start.assemblyId !== scene.assemblyId)
    throw Error('The saved lesson does not match this source, model and assembly.');
  const chapter = savedLessonChapter(saved, tours);
  if (!chapter) throw Error('The saved lesson chapter is unavailable in this source.');
  if (playsWithoutAnimation(scene, saved, chapter))
    throw Error(`The saved lesson is playing "${chapter.title}" without its animation. Restart the chapter to draw it again.`);
  return structuredClone(saved);
}
const savedLessonChapter = (saved: any, tours: readonly Tour[]): TourStep | undefined =>
  tours.find(entry => entry.id === saved?.tourId)?.steps.find(entry => entry.id === saved?.chapterId);
/**
 * A playing chapter that moves is only whole with its clock.
 *
 * Without it the bodies sit at rest with every copy and label showing, and the
 * animation controls answer that there is nothing to play. A stopped lesson may
 * have lost it to the wearer; a paused clock is still saved.
 */
const playsWithoutAnimation = (scene: any, saved: any, chapter: TourStep): boolean =>
  saved?.stopped === false && Boolean(chapter.animation)
    && scene?.inspection?.animation?.playback?.chapterId !== chapter.id;
/**
 * Open a saved lesson that plays without its animation as stopped.
 *
 * Scenes saved before chapters were drawn whole can hold that cursor, and
 * `savedLessonPlayback` refuses it, so a page hydrating one would never open.
 * Stopped, it opens on the same chapter and Rejoin draws the chapter again.
 * Any other scene comes back as it was, for `savedLessonPlayback` to judge.
 */
export function stopUnanimatedLessonPlayback<T>(scene: T, tours: readonly Tour[]): T {
  const saved = (scene as any)?.inspection?.lessonPlayback;
  const chapter = savedLessonChapter(saved, tours);
  if (!chapter || !playsWithoutAnimation(scene, saved, chapter)) return scene;
  const result = structuredClone(scene) as any;
  result.inspection.lessonPlayback.stopped = true;
  return result;
}
type WorkspaceRow = { key: string; entityType?: string; identity: { authorChain?: string; authorResidue?: number | string | null; componentId?: string;
  labelChain?: string; copyId?: string; modelNumber?: number } };
type TourSceneVisibility = { hiddenChains: { labelChain: string; copyId: string }[]; hiddenClasses: string[]; showOnlySelection: boolean };
export type Workspace = {
  snapshot(): { ready?: boolean; status?: string; sourceSha256?: string; xrPresenting?: boolean; interactionActive?: boolean; selectionKeys?: string[]; modelNumber?: number; assemblyId?: string;
    animation?: { timeSeconds: number; durationSeconds: number; loop: boolean } | null;
    /** The tier's size, which is what a scene's bounds scale with. */
    atomCount?: number;
    /**
     * The density tier's size, in the unit it is measured in. A
     * map carries zero atom sites, so `atomCount` alone reads a 178,236-triangle
     * mesh as an empty scene; the pair tells a density scene from nothing.
     */
    triangleCount?: number;
    /**
     * What the density tier is actually painted with, read back
     * out of Mol*'s colour data rather than out of the params it was asked
     * for. Null off a density tier. `themed` false with `colorType:'uniform'`
     * is the cream map the filament run 7 capture shows.
     */
    volumeTheme?: { themed?: boolean; colorType?: string | null; vertices?: number;
      wall?: number; crown?: number; other?: number; uniform?: string | null } | null;
    inspection?: { appearance?: Record<string, unknown>; placement?: Record<string, unknown> } };
  rows(): WorkspaceRow[];
  /** Residue metadata without the expensive atom-coordinate clone. */
  identityRows?(): WorkspaceRow[];
  capture(): Scene;
  runTour(action: () => Promise<void>): Promise<unknown>;
  setStatus(message: string, error?: boolean): void;
  viewer: {
    xr?: { refreshToolbar?(): Promise<unknown>; toolbarReadout?(): { cardHoldMs?: number } | null };
    /** `lesson` marks a selection the lesson made: its colour key marks those rows, not the selection mark. */
    select(keys: string[], action?: string, options?: { lesson?: boolean }): Promise<unknown>;
    focus(keys: string[]): Promise<unknown>;
    focusSelection?(options: { wholeStructure: boolean; liftEmphasis: boolean; elevationDegrees: number }): Promise<unknown>;
    inspection: {
      /** Chapter mutations preserve live manipulation and do not require release. */
      supportsConcurrentPlayback?: boolean;
      /** Source-owned interchangeable figures keep their established view. */
      preservesFigureFrame?(): boolean;
      /** Bind verified lesson coordinate metadata to this exact loaded source. */
      setSourceCoordinateFrame?(frame: string | undefined, expectedSource: string): unknown;
      /** Page viewers settle placement, appearance and emphasis with one label solve. */
      batchComponentLabels?(operation: () => Promise<void>): Promise<void>;
      configure(patch: Record<string, unknown>): Promise<unknown>;
      place(patch: Record<string, unknown>, action?: string): Promise<unknown>;
      fit(): Promise<unknown>;
      /** Seat a new source as XR entry does, after its opening chapter paints. */
      seatForEntry?(): Promise<unknown>;
      resetOrientation(): Promise<unknown>;
      orbit(axis: 'x' | 'y' | 'z', degrees: number): Promise<unknown>;
      dolly(factor: number): Promise<unknown>;
      /**
       * The lesson's own chapter turn, on the path that never
       * bakes as a grab, never takes the placement hold, never records
       * wearer-placement and never reaches `notifyMutation` as a takeover.
       *
       * The ticks used to call `orbit`/`dolly` — admitted inspection
       * mutations — so every tick of the lesson's own cinematic move read as
       * the wearer grabbing the structure and the tour interrupted itself one
       * scene in. Optional: a workspace built before this existed answers
       * nothing and the player falls back to `orbit`/`dolly`, which keeps the
       * motion and the old false-takeover behaviour rather than losing the
       * motion entirely.
       */
      applyLessonMotion?(move: LessonCameraMove): Promise<unknown>;
      setMotion(value: { paused: boolean }): Promise<unknown>;
      /** Optional: a workspace built before lesson emphasis existed has none. */
      emphasize?(value: TourEmphasis): Promise<unknown>;
      setVisibility?(value: TourSceneVisibility): Promise<unknown>;
      visibility?(): TourSceneVisibility;
      visibilityChains?(): { labelChain: string; copyId: string }[];
      prepareMolecularAnimation?(animation: MolecularAnimation): Promise<unknown>;
      animationFramingContext?(animation?: MolecularAnimation): unknown;
      setMolecularAnimation?(animation?: MolecularAnimation, chapterId?: string,
        framing?: { frame?: boolean; context?: unknown; framing?: 'fill' | 'context' }): Promise<unknown>;
      setAnimatedChapter?(animation: MolecularAnimation, chapterId: string | undefined, figure: LessonFigure | undefined,
        framing?: { frame?: boolean; context?: unknown; framing?: 'fill' | 'context'; toolbarReady?: Promise<unknown> }): Promise<unknown>;
      controlMolecularAnimation?(patch: AnimationPatch): unknown;
      setLessonFigure?(value: LessonFigure | undefined, options?: { frame?: boolean }): Promise<unknown>;
      /** Metadata only: it must not emit a viewer mutation or replay a chapter. */
      setLessonPlayback?(value: SavedLessonPlayback | undefined): void;
      /**
       * Whether the wearer has placed the structure themselves.
       *
       * A chapter's authored placement was recorded in another room, from
       * another head. Writing it over a structure the wearer has just moved is
       * why the position keeps changing under the wearer, so a chapter
       * skips its placement while this answers true. Optional: a panel built
       * before this existed answers nothing and the placement lands as it
       * always did.
       */
      holdsWearerPlacement?(): boolean;
      /** Release local ownership once on entry to a changed authored frame. */
      beginChapterFraming?(): void;
      /**
       * The tour starts painting this chapter, or ends (undefined). Until the
       * chapter's own animation installs, the motion drawn is another's.
       */
      chapterPainting?(chapterId: string | undefined, options?: { turn?: ChapterTurnSweep }): void;
      /** Whether the chapter was framed as a close-up the wearer stands inside, so its spin holds still. */
      holdsTurnStill?(chapterId: string): boolean;
      /**
       * Take this lesson's fade off, if it is still ours.
       * A no-op when the live key was asked for by the wearer or an agent.
       */
      clearLessonEmphasis?(): Promise<unknown>;
      /**
       * Install, or drop, the loaded lesson's visual baseline.
       *
       * `undefined` says this session has no lesson. It matters as much as a
       * value does: the viewer forgets a resting key only on a source change,
       * so a hydrate that sent nothing left the previous lesson's key installed
       * and the next release repainted the structure in its colours.
       * Optional: a viewer built before the baseline existed answers nothing.
       */
      setLessonRestingState?(value: LessonRestingState | undefined, options?: { preserveEmphasis?: boolean }): Promise<unknown>;
      // Immersive presentation owns the wearer camera. A rich saved scene
      // remains complete, but XR tour playback must not replay its desktop
      // camera snapshot into a live headset view.
      restore(scene: Scene, options?: { preserveCamera?: boolean; preservePlacement?: boolean; restorePlacement?: boolean }): Promise<unknown>;
      /** Restore the XR column after the starting scene and resting state land. */
      restoreTourSeat?(options?: { restart?: boolean }): Promise<unknown>;
    };
  };
};

export type TourPlayerState = Readonly<{
  /** Scripted chapter speech for this visit; omitted by older player adapters. */
  narration?: boolean;
  tours: readonly Readonly<{ id: string; title: string; steps: number }>[];
  selectedId?: string;
  selectedTitle?: string;
  /**
   * The selected lesson's presentation, read by the headset readout. Present
   * only while a lesson is selected; absent means `shown`.
   */
  captionCard?: 'hidden' | 'shown';
  /**
   * When the live chapter's scene landed, on `performance.now()`.
   *
   * Autoplay counts the dwell already spent from it, and the headset plate
   * times its chooser-closed sentence from it, so the clock has to be the one
   * `spatial-toolbar.mjs` reads — since page load, not since the epoch — or
   * every window is closed before it opens. Absent
   * until a scene has landed, and cleared by anything that leaves the lesson:
   * no chapter, no window.
   */
  chapterStartedAt?: number;
  /** Incoming caption only; step/active and receipts still describe the rendered chapter. */
  chapterPreview?: Readonly<{ title: string; progress: string; bodyPage: string }>;
  title: string;
  body: string;
  bodyPage: string;
  feedback?: string;
  feedbackError?: boolean;
  bodyPageIndex: number;
  bodyPageCount: number;
  progress: string;
  step: number;
  total: number;
  active: boolean;
  stopped: boolean;
  autoplay: boolean;
  menuOpen: boolean;
  navigating: boolean;
  canBack: boolean;
  canNext: boolean;
  canPlay: boolean;
  motionRunning?: boolean;
  motionKind?: 'orbit' | 'dolly' | 'turntable' | 'hold';
}>;

export function tourRejoinEligibility(input: {
  ready: boolean;
  selected: boolean;
  baseline: boolean;
  step: number;
  cached: boolean;
  sourceSha256?: string;
  baselineSource?: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.ready) return { ok: false, reason: 'Wait for the structure to finish loading.' };
  if (!input.selected || !input.baseline || input.step < 0) return { ok: false, reason: 'Start a lesson before rejoining it.' };
  if (input.sourceSha256 !== input.baselineSource) return { ok: false, reason: 'The structure changed. Choose a lesson for the current structure.' };
  if (!input.cached) return { ok: false, reason: 'The current lesson scene is no longer available. Restart the lesson.' };
  return { ok: true };
}

/**
 * What Next or Back means when no lesson is running.
 *
 * An unattended driver sent `control_tour back` twice on an
 * inactive tour. Both answered "queued" and moved nothing, because the player's
 * transport paused an already-paused lesson and returned. The press appeared to
 * do nothing, and the wearer's own Next row
 * did the same thing. A transport press is a request for the lesson, so an idle
 * player starts it: at the first chapter for Next, at the last for Back. A
 * lesson a workspace takeover stopped keeps its place and is rejoined instead
 * of replayed, which is the rule `play` already follows.
 *
 * One function so the three routes to this decision — the wearer's toolbar row,
 * the agent's `control_tour`, and the player's own buttons — cannot disagree
 * about what a press does.
 */
export function tourTransportIntent(input: {
  action: 'next' | 'back';
  active: boolean;
  stopped: boolean;
  /** Whether a lesson is selected, or one can be selected from the catalog. */
  hasLesson: boolean;
  step: number;
  canNext: boolean;
  canBack: boolean;
  navigating: boolean;
}): { do: 'move' | 'rejoin' | 'start' | 'none'; startAt?: 'first' | 'last'; reason?: string } {
  if (input.navigating) return { do: 'none', reason: 'This tour is still rendering a scene.' };
  if (input.active) return (input.action === 'next' ? input.canNext : input.canBack)
    ? { do: 'move' } : { do: 'none', reason: 'This tour has no scene in that direction.' };
  if (!input.hasLesson) return { do: 'none', reason: 'No lesson is loaded in this panel.' };
  if (input.stopped && input.step >= 0) return { do: 'rejoin' };
  return { do: 'start', startAt: input.action === 'next' ? 'first' : 'last' };
}

/**
 * What a grown tier does with the lesson that arrives with it.
 *
 * THE PLACEMENT RULE, in one place, because two halves of it live in two files:
 *
 *   A source swap made while the wearer is presenting keeps the previous tier's
 *   room anchor — `viewer.mjs showCandidate` leaves the XR camera alone and
 *   `preserveSourceTransitionAnchor` re-expresses the placement in it — and then
 *   the NEW lesson's opening chapter places the tier by the lesson's own
 *   immersive framing, which is `focusPlacement`: the structure stood in front
 *   of the wearer's current head pose at the angle `emphasis.framing` asks for.
 *   That is the identical path `control_tour start` takes to chapter 1, so the
 *   wall lands where the monomer stood and fills the same share of the lens —
 *   bigger in molecules, the same size in the room.
 *
 * The anchor alone is not enough. With only the anchor, the
 * page swapped the coordinates, never opened the new lesson, and left the wearer
 * a chain-id rainbow the size of a thumbnail up by the ceiling with the menu
 * fully expanded.
 *
 * `open: 'chapter'` is the answer whenever a lesson was on screen when the swap
 * started. "Grow it" has to feel like the lesson continuing, so
 * a wearer who had merely paused still gets the new chapter painted, spoken and
 * the menu collapsed; only `autoplay` is carried over, so a paused lesson opens
 * chapter one and holds there. `open: 'key'` is the swap that found no lesson on
 * screen: the tier gets its colour key while retaining the source swap's room
 * anchor. The first open also frames the key; a later inactive grow leaves the
 * wearer's placement alone. Nothing is spoken and no chapter starts.
 * `open: 'none'` is a swap with no lesson at
 * all to speak of, or one made outside a session.
 */
export function grownTierIntent(input: {
  /** Whether the wearer is inside an immersive session; a desktop swap is left alone. */
  presenting: boolean;
  /** Whether the incoming source arrived with an authored lesson that has chapters. */
  hasChapters: boolean;
  /** Whether a lesson was on screen when the swap started (playing or paused). */
  lessonOnScreen: boolean;
  /** Whether that lesson was auto-advancing. */
  autoplay: boolean;
  /** True for the first source hydrate in a fresh host tab. */
  initialOpen?: boolean;
}): { open: 'chapter' | 'key' | 'none'; autoplay: boolean } {
  if (!input.hasChapters) return { open: 'none', autoplay: false };
  if (!input.presenting) return { open: 'none', autoplay: false };
  // Plain entry is a resting lesson, never an unsolicited guided tour. A
  // source swap after this first hydrate may continue an already-running tour;
  // the fresh tab has no such wearer intent to carry forward.
  if (input.initialOpen) return { open: 'key', autoplay: false };
  if (!input.lessonOnScreen) return { open: 'key', autoplay: false };
  return { open: 'chapter', autoplay: input.autoplay === true };
}

/**
 * The visual baseline a loaded lesson leaves on the structure.
 *
 * The first chapter's colour key and its opt-in name plates. The viewer holds
 * it as `restingLessonState` and returns to it whenever a chapter lets go, so
 * a wearer who enters without starting the tour, or who stops it, still gets
 * the lesson's colours and the parts named rather than a chain-id rainbow.
 *
 * Only the first chapter contributes: a lesson's key repeats unchanged across
 * its chapters by construction (`TourEmphasisPart`), and `focus` is the one
 * field that moves, which is a chapter's business and not the baseline's.
 */
export type LessonRestingState = { emphasis?: TourEmphasis; componentLabels: boolean };

export function lessonRestingState(tour: Tour | undefined): LessonRestingState | undefined {
  if (!tour) return undefined;
  const first = tour.steps?.[0];
  return { emphasis: first?.emphasis, componentLabels: first?.appearance?.componentLabels === true };
}

/**
 * The `placed` phase of a hydrate, as one decision.
 *
 * Two things happen in that phase and they have different rights over the
 * wearer's view.
 *
 * An experience chapter IS a scene. It rewrites the appearance and the
 * selection, so it takes `runTour` — whose first act is
 * `setMotion({ paused: true })`, because a scene cannot land on a structure
 * turning underneath it.
 *
 * A lesson's resting key is not a scene. It paints colours and builds name
 * plates; it moves no camera, sets no placement and asks nothing of the
 * structure's pose, so it has no claim on the structure's motion. Sending it
 * through `runTour` froze every custom-lesson page on open — including a
 * reload of a saved scene whose motion was running — which is the regression
 * 73bd9eb introduced over 8112535 and what keeping it out of the queue undoes.
 *
 * The resting state is sent on EVERY hydrate, `undefined` included; see
 * `setLessonRestingState` on the workspace type for why the absent case is
 * load-bearing.
 */
export async function placeLessonScene(workspace: Workspace, options: {
  /** The custom lesson this session loaded, if it loaded one. */
  tour?: Tour;
  /** The experience chapter's own placement, when there is a chapter to place. */
  placeExperienceStep?: () => Promise<void>;
  /** Fresh source only; saved scenes already carry their current hidden set. */
  applyInitialVisibility?: boolean;
  /** A saved chapter already owns its drawn key. */
  preserveEmphasis?: boolean;
}): Promise<void> {
  if (options.placeExperienceStep) await workspace.runTour(options.placeExperienceStep);
  await workspace.viewer.inspection.setLessonRestingState?.(lessonRestingState(options.tour), { preserveEmphasis: options.preserveEmphasis });
  if (options.applyInitialVisibility) await applyTourVisibility(workspace, options.tour?.steps[0]?.visibility);
}

/**
 * The desktop sidebar and the immersive toolbar use the same narrow tour
 * controller. The actions intentionally expose no scene or camera access.
 */
export type TourPlayer = Readonly<{
  /** Admission bookkeeping must leave the saved molecular playback untouched. */
  pause(reason?: string, options?: { preserveMolecularPlayback?: boolean }): void;
  /**
   * Agent edits and XR manipulation keep the chapter playing. Source changes
   * and explicit playback controls still stop it.
   */
  notifyMutation(snapshot?: { sourceSha256?: string; xrPresenting?: boolean; interactionActive?: boolean }, options?: { agent?: boolean; interaction?: boolean; origin?: 'automatic-clearance' | 'xr-entry' }): void;
  /** Frame a pending map opening only after the tracked entry seat settles. */
  frameXrEntry(): Promise<void>;
  stop(reason?: string, options?: { restoreResting?: boolean; preserveScene?: boolean; preserveContinuation?: boolean }): void;
  /**
   * What the last chapter, lesson install or Done left on screen, captured
   * inside its workspace action before anything queued behind it could land.
   * `serial` counts those actions. A page putting a failed command's scene
   * back reads the wearer's later edits against this.
   */
  drawnScene?(): { scene: Scene; serial: number } | undefined;
  getState(): TourPlayerState;
  select(id: string, options?: { preserveMolecularPlayback?: boolean; preserveContinuation?: boolean }): Promise<void>;
  cycleTour(): Promise<void>;
  /** `startAt` opens the lesson at one chapter; 'last' is its closing scene. */
  start(autoStart?: boolean, startAt?: number | 'last', options?: { narration?: boolean; waitForXrEntry?: boolean; preserveContinuation?: boolean }): Promise<void>;
  restoreStart(): Promise<void>;
  /** End the visit and restore its starting view, including an early Done. */
  finish(reason?: 'completed' | 'done'): Promise<void>;
  rejoin(autoResume?: boolean): Promise<void>;
  /**
   * Re-apply the current chapter's emphasis once, answering
   * with one short line. Resolves with the success line when the key paints
   * and with the retry-failure line when it will not; only a key that never
   * comes back rejects. The chapter is already on screen either way.
   */
  retryEmphasis(): Promise<string>;
  replaceTours(tours: readonly Tour[], options?: { preservePlayback?: boolean; preserveMolecularPlayback?: boolean; preserveContinuation?: boolean }): Promise<void>;
  installLesson(tour: Tour, start?: LessonStart, confirm?: () => Promise<void>, frame?: boolean | 'auto' | 'entry'): Promise<void>;
  /** Resume a pending installation only after its rendered receipt is confirmed. */
  confirmLessonInstallation(): void;
  /** Adopt the already-restored scene and cursor silently, with autoplay off. */
  restorePlayback(scene: Scene, options?: { frame?: boolean; waitForXrEntry?: boolean }): void | Promise<void>;
  validatePlayback(scene: Scene): void;
  back(): Promise<void>;
  next(): Promise<void>;
  togglePlay(): Promise<void>;
  openMenu(): Promise<void>;
  closeMenu?(): void;
  nextReadoutPage(): Promise<void>;
  /**
   * The line this visit has spoken, or `undefined` once the visit has ended.
   *
   * A chapter line the page had to hold back — for
   * the wearer's microphone, or for an answer they asked the agent for — asks
   * this before it is finally spoken, so a chapter that has already been
   * replaced is not narrated late. `undefined` says only that a visit ended,
   * not that the scene is gone: `pause()` clears it, and a remote command
   * pauses on its way to opening the very next chapter. Read `stopped` from
   * `getState()` for that.
   */
  narratingLine(): string | undefined;
  subscribe(listener: () => void): () => void;
}>;

function residueNumbers(value: readonly number[] | { from: number; to: number } | undefined): Set<number> | undefined {
  if (value == null) return undefined;
  if (!('from' in value)) return new Set(value.filter(Number.isSafeInteger));
  if (!Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to)) return new Set();
  const start = Math.min(value.from, value.to), end = Math.max(value.from, value.to);
  if (end - start > 5000) return new Set();
  return new Set(Array.from({ length:end - start + 1 }, (_, index) => start + index));
}

/** Resolve stable author identifiers only after the current structure loads. */
export function resolveTourSelection(rows: WorkspaceRow[], selection: TourSelection): string[] {
  if (selection === 'clear') return [];
  const wanted = residueNumbers(selection.residues);
  return rows.filter(row => {
    const chain = row.identity.authorChain;
    const residue = typeof row.identity.authorResidue === 'number'
      ? row.identity.authorResidue : Number(row.identity.authorResidue);
    return (selection.chain == null || chain === selection.chain)
      && (!selection.firstChain || chain === rows[0]?.identity.authorChain)
      && (!selection.componentIds || selection.componentIds.includes(row.identity.componentId ?? ''))
      && (wanted == null || wanted.has(residue));
  }).map(row => row.key);
}

// Fog and the highlight tint change the render without changing what a wearer
// recognises as a different scene. Every other appearance field does.
const XR_SUBTLE_APPEARANCE = new Set(['fog', 'highlightColor']);
const differing = (patch: Record<string, unknown> | undefined, live: Record<string, unknown> | undefined, skip: Set<string>, group: string) =>
  !patch ? [] : !live ? [`${group}:unknown`]
    : Object.keys(patch).filter(key => !skip.has(key) && JSON.stringify(patch[key]) !== JSON.stringify(live[key])).map(key => `${group}.${key}`);

/**
 * What an immersive step would change about what a wearer sees.
 *
 * XR presentation drops a step's desktop camera intent, because head pose owns
 * the wearer's view. A lesson's opening scene is usually a wide reveal whose
 * remaining instructions restate the appearance and placement already on
 * screen, so in a headset it is a no-op with a long representation rebuild
 * attached. An empty result names a scene the first press must not stop at.
 */
export function xrStepChanges(
  step: TourStep,
  live?: { appearance?: Record<string, unknown>; placement?: Record<string, unknown> },
): string[] {
  if (step.selection) return ['selection'];
  if (step.appearances?.length) return ['appearances'];
  // A scene that starts or stops the turn is never silent. It is
  // the one instruction whose whole point is that the wearer sees movement,
  // and skipping it as a no-op is how the opening of a lesson went missing.
  // A taught lesson holds one representation and one colour
  // key for its whole length and changes only which part is emphasised. That
  // is the most visible thing a chapter can do, but appearance and placement
  // are identical across those chapters, so without this every chapter after
  // the first reads as a silent no-op and the first press skips past them.
  return [...(step.motion || step.cameraSpin ? ['motion'] : []), ...(step.emphasis ? ['emphasis'] : []),
    ...(step.figure ? ['figure'] : []), ...(step.visibility ? ['visibility'] : []),
    ...differing(step.appearance, live?.appearance, XR_SUBTLE_APPEARANCE, 'appearance'),
    ...differing(step.placement, live?.placement, new Set(), 'placement')];
}

/** Whether an immersive step would render nothing a wearer can see. */
export const tourStepIsSilentInXr = (
  step: TourStep,
  live?: { appearance?: Record<string, unknown>; placement?: Record<string, unknown> },
): boolean => xrStepChanges(step, live).length === 0;

/** Monotonic intent tokens make a click, source change, or pause cancel stale queued work. */
export function createTourIntentGate() {
  let value = 0;
  return Object.freeze({ issue: () => ++value, invalidate: () => ++value, isCurrent: (token: number) => token === value });
}

/**
 * Autoplay is deliberately paused while a document is backgrounded, but a
 * user who started it should not have to rediscover the Play button on return.
 * The caller still clears this intent when a manual mutation, menu action, or
 * pagehide occurs, so returning to a changed workspace never resumes stale
 * scene work.
 */
export function tourVisibilityTransition(input: {
  visible: boolean;
  autoplay: boolean;
  resumeOnVisible: boolean;
  active: boolean;
}): { autoplay: boolean; resumeOnVisible: boolean; message?: string } {
  if (!input.visible) {
    return input.autoplay
      ? { autoplay: false, resumeOnVisible: true, message: 'Autoplay paused while this tab is hidden.' }
      : { autoplay: false, resumeOnVisible: false };
  }
  if (input.resumeOnVisible && input.active)
    return { autoplay: true, resumeOnVisible: false, message: 'Autoplay resumed.' };
  return { autoplay: input.autoplay, resumeOnVisible: false };
}

const text = (step?: TourStep) => step?.body ?? step?.description ?? '';
/**
 * The line one scene puts on the wearer's caption plate.
 *
 * A lesson chapter is authored twice: a desktop `caption` for the Mac screen,
 * which freely carries entry numbers, resolutions and residue ranges, and one
 * spoken line under `immersive.narration`, written for someone wearing the
 * structure. Putting the desktop text on the plate went wrong:
 * the wall lesson's closing chapter read "Operators 2 to 7, at 166.20,
 * 138.50" -- a coordinate string -- while the voice said "Three strands side
 * by side; thirteen close the tube." The plate follows the voice.
 *
 * A chapter with no spoken line keeps the desktop text: the catalog lessons
 * have no narrations, and their captions are written to be read.
 */
export const captionLine = (step?: TourStep): string => step?.narration?.trim() || text(step);
/**
 * The caption pages one scene owes the plate.
 *
 * The plate line goes whole. The chapter card wraps it at the width it draws
 * and turns its own pages of three lines (`readoutPage` in the toolbar
 * geometry). Cutting a catalog lesson's prose into 45-character pages here
 * as well put one line a page on a card three lines deep, each ending `…`.
 */
export const wearerPages = (step?: TourStep): string[] => {
  const line = captionLine(step);
  return line ? [line] : pageText(line);
};

/**
 * Silent playback respects authored duration; otherwise reserve caption/speech reading time.
 */
export function tourStepDwellMs(step?: TourStep, defaultDelayMs = 0, narration = true): number {
  if (!step) return defaultDelayMs;
  if (!narration && step.durationMs !== undefined) return Math.max(step.durationMs, defaultDelayMs);
  const line = captionLine(step);
  const words = line.trim().split(/\s+/u).filter(Boolean).length;
  const narrationDurationMs = words > 0 ? Math.ceil(words / 3 * 1_000) : 0;
  return Math.max(narrationDurationMs + TOUR_AUTOPLAY_DWELL_MS, step.durationMs ?? 0, defaultDelayMs);
}
// Paginate against the physical lines of the spatial toolbar's caption glass,
// not against a character count: word wrapping can turn a page that counted
// short into one line more than the glass holds, and the line over the budget
// is dropped on arrival. Every source word is retained and appears in order
// across the pages.
//
// The width and the line count are the glass's own, from
// `spatial-toolbar-geometry.mjs`, so the two cannot drift apart. They were 22
// by 2 and guessed. A hardware frame is what the guess cost: a
// 44-character page re-wrapped to four lines in a block that held three, and
// the wearer saw a sentence stop mid-word.
//
// The algorithm itself is `pageCaptionText` in that same geometry
// module, so the resting structure description can be paged by the same rule
// this caption is. This stays the tour's name for it.
export const pageText = (value: string, maxCharacters = READOUT_PAGE_LINE_WIDTH * READOUT_PAGE_LINES,
  lineWidth = READOUT_PAGE_LINE_WIDTH, maxLines = READOUT_PAGE_LINES): string[] =>
  pageCaptionText(value, maxCharacters, lineWidth, maxLines) as string[];
const source = (workspace: Workspace) => workspace.snapshot().sourceSha256;
const delayFromDocument = (fallback: number) => {
  const parsed = Number(document.body.dataset.tourDelayMs);
  return Number.isFinite(parsed) && parsed >= 10 ? parsed : fallback;
};

/**
 * Frames per second below which an immersive autoplay must not advance a scene.
 *
 * Twenty, not sixty. A Quest 2 holding 13,000 to 41,000 atom sites rests at 50
 * to 55 fps and drops to 25 to 35 while Mol* rebuilds a representation, so a
 * sixty-fps floor is never met on that hardware and autoplay
 * retries forever. Twenty is the rate below which the compositor is reprojecting
 * most frames and another rebuild would be felt as a stutter.
 */
export const XR_AUTOPLAY_MINIMUM_FPS = 20;
/** How stale a `frame-rate` record may be and still describe the frame on screen. */
export const XR_FRAME_COST_FRESH_MS = 6_000;
/** How long autoplay waits before testing the frame rate again. */
const XR_AUTOPLAY_RETRY_MS = 1_000;
/**
 * The longest autoplay ever waits for the frame rate before advancing anyway.
 *
 * A hold is a comfort measure, not a gate. A lesson that stops on scene two
 * because the headset is busy is the failure this prevents, so after five
 * seconds the next scene is built regardless of what the budget reports.
 */
export const XR_AUTOPLAY_MAXIMUM_HOLD_MS = 5_000;
type DiagnosticsEntry = { kind?: string; at?: number; detail?: { fps?: number; reportedFrameRate?: number | null } };
/**
 * The frame rate the headset render budget last reported.
 *
 * The dedicated diagnostics loop emits `frame-rate` every five seconds.
 * `frame-cost` counts animation subscribers and cannot measure displayed FPS,
 * including older records mislabeled as fps. Undefined means no
 * measurement applies and autoplay proceeds on its dwell alone.
 */
export function reportedFrameRate(entries: readonly DiagnosticsEntry[], now: number): number | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    // A fresh reading from an ended or previous session cannot pace this one.
    if (entries[index]?.kind === 'session-end' || entries[index]?.kind === 'session-start') return undefined;
    if (entries[index]?.kind !== 'frame-rate') continue;
    const entry = entries[index], fps = entry.detail?.fps;
    if (!Number.isFinite(now) || typeof entry.at !== 'number' || !Number.isFinite(entry.at)
      || now < entry.at || now - entry.at > XR_FRAME_COST_FRESH_MS) return undefined;
    if (typeof fps !== 'number' || !Number.isFinite(fps) || fps < 0) return undefined;
    // When supplied, the runtime rate is a ceiling, never a measured FPS or
    // a replacement for a stale sample. Requested/supported rates prove neither.
    const ceiling = entry.detail?.reportedFrameRate;
    return typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling > 0 ? Math.min(fps, ceiling) : fps;
  }
  return undefined;
}
const liveFrameRate = (): number | undefined => {
  try {
    return reportedFrameRate((globalThis as { __stereofoldDiagnostics?: { entries?: () => DiagnosticsEntry[] } })
      .__stereofoldDiagnostics?.entries?.() ?? [], Date.now());
  } catch { return undefined; /* Diagnostics are advisory; autoplay never fails because of them. */ }
};

/**
 * The clock the headset caption's reading window is measured on.
 *
 * `spatial-toolbar.mjs` reads `performance.now()` — milliseconds since the page
 * loaded — and compares a chapter's start against it. A `Date.now()` stamp is
 * an epoch number thirteen digits long, so every comparison would put the
 * chapter's start in the far future and close the window before it opened. The
 * fallback exists only for a host with no `performance`; there the window is
 * simply never open, which shows the short caption rather than a wrong one.
 */
const readoutClock = (): number => {
  try { return globalThis.performance?.now?.() ?? Date.now(); }
  catch { return Date.now(); }
};

/**
 * No single scene operation may hold the lesson open forever.
 *
 * A real Quest 2 stopped between chapter 1 and chapter 2 of the
 * CRISPR lesson and stayed there. The emphasis layers had already rendered, so
 * nothing on the wearer's face said anything was wrong, and there was no error
 * anywhere: one await inside the scene never settled (a placement travel
 * scheduled on the window frame clock a live immersive session does not run),
 * and behind it the scene, the workspace queue and the page's heartbeat to the
 * Mac all stopped. A lesson that cannot finish a chapter has to say so.
 *
 * Twenty seconds for one operation. A representation rebuild over 13,000 atom
 * sites costs a Quest 2 seconds, not tens of seconds, so this is generous
 * enough that no healthy chapter can reach it.
 */
export const TOUR_OPERATION_TIMEOUT_MS = 20_000;
/** The whole of one scene, as the outer net under the per-operation bounds. */
export const TOUR_SCENE_TIMEOUT_MS = 60_000;

/**
 * The bound is on a HANG, so it has to scale with the work.
 *
 * Twenty seconds was sized from one tier — "a representation rebuild over
 * 13,000 atom sites costs a Quest 2 seconds" — and the microtubule wall is
 * 40,908 atom sites, three times that. Every chapter of the wall tier that
 * changes representation therefore raced a bound set for a third of its work,
 * and chapter 5, the cartoon rebuild after chapter 4's spacefill, lost that
 * race: `This lesson scene's appearance did not finish within 20 seconds`, and
 * the lesson stopped one chapter from the end.
 *
 * So the free allowance stays exactly what it was for any tier up to the size
 * it was measured on, and past that each further thousand atom sites buys its
 * own share. The cap is what keeps this a hang detector rather than a shrug: no
 * tier, however large, gets to hold a lesson open for a minute.
 */
export const TOUR_FREE_ATOM_SITES = 13_000;
export const TOUR_MS_PER_1K_ATOM_SITES = 1_000;
export const TOUR_OPERATION_TIMEOUT_CAP_MS = 45_000;
export function tourOperationTimeoutMs(atomCount?: number): number {
  const sites = Number.isFinite(atomCount) ? Math.max(0, atomCount as number) : 0;
  const over = Math.max(0, sites - TOUR_FREE_ATOM_SITES);
  return Math.min(TOUR_OPERATION_TIMEOUT_CAP_MS,
    TOUR_OPERATION_TIMEOUT_MS + Math.ceil(over / 1_000) * TOUR_MS_PER_1K_ATOM_SITES);
}
/**
 * The bound on one molecular animation install: bodies, framing and figure.
 *
 * Measured on a Quest 2, the whole install never took longer than 2.4 s over
 * about fifty chapter starts and changes of the three motion demos. The
 * 32,916-site kinesin walk took 0.6 to 2.4 s, and the 34,413-site ATP synthase
 * rotor, the largest, took 0.3 to 1.3 s. The per-operation rule gives these 40
 * and 42 s, more than sixteen times the slowest, so it stays the install's
 * bound. The emulated Quest 2 on a Mac took 43 to 72 s for the same install.
 * That session draws one to three frames a second against the headset's 72,
 * and the install builds its bodies frame by frame. A longer bound would only
 * leave a wearer looking at a hung chapter for longer.
 */
export function tourAnimationInstallTimeoutMs(atomCount?: number): number {
  return tourOperationTimeoutMs(atomCount);
}
/**
 * The outer net, never tighter than the operations it has to contain.
 *
 * A failed chapter puts back the scene it found before it gives up. That can
 * add one operation bound waiting for the abandoned work to settle, and one
 * more for the restore, on top of the operation that failed.
 */
export function tourSceneTimeoutMs(atomCount?: number): number {
  return Math.max(TOUR_SCENE_TIMEOUT_MS, 3 * tourOperationTimeoutMs(atomCount));
}
/** A spoken line that never comes back is recorded, never awaited by a scene. */
export const TOUR_NARRATION_TIMEOUT_MS = 30_000;

/**
 * What the wearer hears when a chapter's colour key will not
 * paint. Every line here is spoken, so every one stays under twelve words.
 * The failure line offers the retry; the retry lines answer it.
 */
export const EMPHASIS_FAILURE_LINE = 'The highlight failed. Say retry, or we carry on.';
export const EMPHASIS_RETRY_SUCCESS_LINE = 'The highlight is back.';
export const EMPHASIS_RETRY_FAILURE_LINE = 'The retry failed too. We carry on.';

/**
 * Await `work`, but never past `timeoutMs`.
 *
 * A timeout is a real scene failure: it rejects, so `visit` records a `tour`
 * scene error and the status line says which part of the chapter stalled,
 * rather than leaving a lesson that is neither running nor stopped. Anything
 * that is not a promise passes through untouched, which keeps a workspace with
 * a synchronous or absent primitive exactly as cheap as it was.
 */
/**
 * A deadline rejection says so on the error itself.
 *
 * A chapter's colour key is allowed to fail without costing the wearer the
 * chapter — but only when it FAILED. A key that never came back means the
 * viewer's mutation queue is still holding the work, and letting the transport
 * walk on into a wedged viewer is the seven-minute half-played lesson the bound
 * exists to prevent. The two are told apart here rather than by matching the
 * message, so the copy stays free to change.
 */
const TOUR_DEADLINE = Symbol.for('stereofold.tourDeadline');
/** The work a bound stopped waiting for; it is still running in the viewer. */
const TOUR_ABANDONED = Symbol.for('stereofold.tourAbandoned');
function tourDeadlineError(message: string, abandoned?: Promise<unknown>): Error {
  const error = Object.assign(Error(message), { [TOUR_DEADLINE]: true });
  if (abandoned) Object.defineProperty(error, TOUR_ABANDONED, { value: abandoned });
  return error;
}
/** Whether this rejection is a bound firing rather than the work failing. */
export function isTourDeadlineError(error: unknown): boolean {
  return Boolean((error as Record<symbol, unknown> | null | undefined)?.[TOUR_DEADLINE]);
}

export function withTourDeadline<T>(label: string, work: Promise<T> | T | undefined,
  timeoutMs = TOUR_OPERATION_TIMEOUT_MS,
  defer: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
): Promise<T | undefined> {
  const pending = work as Promise<T> | undefined;
  if (!pending || typeof pending.then !== 'function') return Promise.resolve(work as T | undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    let settled = false;
    defer(() => {
      if (settled) return;
      settled = true;
      reject(tourDeadlineError(`This lesson scene's ${label} did not finish within ${Math.round(timeoutMs / 1_000)} seconds.`, pending));
    }, timeoutMs);
    pending.then(
      value => { if (!settled) { settled = true; resolve(value); } },
      error => { if (!settled) { settled = true; reject(error as Error); } });
  });
}

/**
 * Run one chapter operation within its bound, and again if the viewer was busy.
 *
 * The viewer refuses work with `viewer_busy` before it changes anything, so
 * the same call can go again once the viewer reports ready. On an emulated
 * Quest 2 a menu clearance held the viewer just as the kinesin lesson's second
 * chapter asked for its appearance, and that one refusal rolled the chapter
 * back and left the lesson paused on chapter 1. Every attempt shares the
 * operation's one bound, so a viewer still busy at its end fails the chapter
 * with the refusal, as it did before. `current` ends the retry once the visit
 * has been withdrawn, so a changed source never receives the old chapter's work.
 */
function withViewerRetry<T>(workspace: Workspace, label: string, start: () => Promise<T> | T | undefined,
  timeoutMs: number, current: () => boolean = () => true): Promise<T | undefined> {
  const began = Date.now(), until = began + timeoutMs;
  // Each attempt runs against the operation's deadline, not a fresh bound.
  const deadline = (callback: () => void) => setTimeout(callback, Math.max(0, until - Date.now()));
  const attempt = () => {
    try { return withTourDeadline(label, start(), timeoutMs, deadline); }
    catch (error) { return Promise.reject(error); }
  };
  const retry = async (error: unknown): Promise<T | undefined> => {
    if ((error as { code?: string } | null)?.code !== 'viewer_busy') throw error;
    do {
      if (Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, until - Date.now())));
    } while (!workspace.snapshot().ready);
    if (Date.now() >= until || !current()) throw error;
    try {
      (globalThis as { __stereofoldDiagnostics?: { record?: (kind: string, detail: unknown) => unknown } })
        .__stereofoldDiagnostics?.record?.('tour-retry', { phase: label, reason: 'viewer_busy', waitedMs: Date.now() - began });
    } catch { /* Diagnostics cannot fail a chapter. */ }
    return attempt().catch(retry);
  };
  return attempt().catch(retry);
}

/** An overview keeps the lesson key and names, with no chapter focus or fade. */
function stepEmphasis(entry: TourStep, resting?: LessonRestingState): TourEmphasis {
  const fallback = resting?.componentLabels && resting.emphasis
    ? { parts: resting.emphasis.parts, strandShades: resting.emphasis.strandShades }
    : { parts: [] };
  const emphasis: TourEmphasis = { ...(entry.emphasis ?? fallback), origin: 'lesson' };
  // Authored placement scales are not a safe XR close-up: the recorded 2.4x
  // chapter put all ten plates off-glass. Labelled chapters also request the
  // page's bounded focus framing, including when their key has no focus.
  const labelled = entry.appearance?.componentLabels ?? resting?.componentLabels;
  if (labelled && entry.placement && emphasis.parts.length && !emphasis.framing)
    emphasis.framing = 'context';
  return emphasis;
}

/** An explicitly framed focus keeps its close-up when a figure adds annotations. */
function framesEmphasisFocus(entry: TourStep): boolean {
  return Boolean(entry.emphasis?.framing && entry.emphasis.focus?.length);
}

// identityRows returns a detached metadata snapshot. Keep it private to the
// player: a chapter needs the same immutable source/model/assembly identities,
// not a fresh clone of every residue twice per step. Older adapters without a
// digest or identity reader retain their original live read on each request.
const tourIdentityCache = new WeakMap<Workspace, { source: string; model: number | undefined;
  assembly: string | undefined; reader: Workspace['identityRows']; rows: WorkspaceRow[] }>();
function tourIdentityRows(workspace: Workspace): WorkspaceRow[] {
  if (!workspace.identityRows) return workspace.rows();
  const current = workspace.snapshot();
  if (!current.sourceSha256) return workspace.identityRows();
  const cached = tourIdentityCache.get(workspace);
  if (cached?.source === current.sourceSha256 && cached.model === current.modelNumber
    && cached.assembly === current.assemblyId && cached.reader === workspace.identityRows) return cached.rows;
  const rows = workspace.identityRows();
  tourIdentityCache.set(workspace, { source: current.sourceSha256, model: current.modelNumber,
    assembly: current.assemblyId, reader: workspace.identityRows, rows });
  return rows;
}

/** Resolve the authored subset against this source before changing a chapter. */
function resolveTourVisibility(workspace: Workspace, patch: LessonVisibility): TourSceneVisibility {
  const inspection = workspace.viewer.inspection;
  if (!inspection.setVisibility) throw Error('This viewer does not support lesson visibility. Update Stereofold before opening this lesson.');
  const rows = tourIdentityRows(workspace);
  const modelNumber = workspace.snapshot().modelNumber;
  const wanted = resolveVisibility(inspection.visibility?.() ?? emptyVisibility(), patch,
    inspection.visibilityChains?.() ?? availableChains(rows, modelNumber),
    { classes: componentClassesPresent(rows, modelNumber) });
  if (visibilityHidesEverything(rows, wanted, modelNumber))
    throw Error('This lesson visibility would hide every part of the loaded structure. Check its chain and component class targets.');
  return wanted;
}

/** Visibility never frames the structure or changes the tracked viewpoint. */
export async function applyTourVisibility(workspace: Workspace, patch: LessonVisibility | undefined,
  timeoutMs = tourOperationTimeoutMs(workspace.snapshot().atomCount)): Promise<void> {
  if (!patch) return;
  try {
    const wanted = resolveTourVisibility(workspace, patch);
    await withTourDeadline('visibility', workspace.viewer.inspection.setVisibility!(wanted), timeoutMs);
  } catch (error) { throw Object.assign(error as Error, { visibilityFailure: true }); }
}

/** A subset reveal can continue where the wearer placed the molecule. */
function revealsAtLivePlacement(entry: TourStep | undefined): boolean {
  return Boolean(entry?.visibility && !entry.appearance && !entry.appearances?.length
    && !entry.placement && !entry.view && !entry.figure && !entry.selection && !entry.emphasis?.framing
    && (!entry.motion || normalizeChapterMotion(entry.motion)?.kind === 'hold'));
}

/** A released grip can still be committing its last placement frame. */
function tourViewerIsSettling(live: ReturnType<Workspace['snapshot']>): boolean {
  return !live.ready && (live.status === undefined || ['ready', 'mutating', 'recovering'].includes(live.status));
}

/**
 * Let the viewer finish work of its own while the visit still owns it.
 *
 * A chapter's paint can start a follow-up in the viewer, such as the menu
 * clearance move its new card needs, which holds the viewer for a frame or
 * two after the chapter's own operation has returned. That is the chapter
 * still drawing, not a withdrawal: only a lost owner, a failed viewer or the
 * bound ends the wait.
 */
async function untilViewerSettles(workspace: Workspace, owned: () => boolean, until: number): Promise<void> {
  while (tourViewerIsSettling(workspace.snapshot()) && owned() && Date.now() < until)
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, until - Date.now()))));
}

/** Yield the workspace queue quickly when a hand still owns the structure. */
async function waitForTourInteraction(workspace: Workspace, admitted: () => boolean): Promise<void> {
  if (workspace.viewer.inspection.supportsConcurrentPlayback) return;
  const until = Date.now() + 1_000;
  while (workspace.snapshot().interactionActive && admitted()) {
    if (Date.now() >= until) throw Object.assign(Error('The next chapter is waiting for the molecular drag to finish.'), { code: 'interaction_active' });
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Apply one scene's intent to a real workspace, in the order a wearer perceives.
 *
 * Move first, rebuild second.
 *
 * Placement and the presentation turn are a transform on geometry that is
 * already on screen, so they land in the next frame. Changing a representation
 * rebuilds the whole structure and costs seconds on a Quest 2. Running the
 * rebuild first meant a wearer pressed Play and watched a still molecule for
 * the length of that rebuild before anything moved, which is exactly what "I
 * hit tour and nothing's happening" described. In this order the scene is
 * already turning while it rebuilds.
 *
 * `admitted` is rechecked between calls so an explicit pause or a
 * source change abandons the rest of the scene instead of finishing it.
 */
const sameKeys = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && [...a].sort().every((key, i) => key === [...b].sort()[i]);

export async function applyTourStep(workspace: Workspace, entry: TourStep,
  admitted: () => boolean, includeDesktopView: boolean,
  timeoutMs = tourOperationTimeoutMs(workspace.snapshot().atomCount),
  onEmphasisFailure: (error: unknown) => void = () => {},
  resting?: LessonRestingState, labelsBatched = false, restoredContent = false, authoredTakeover = false, deferFigure = false): Promise<void> {
  if (!labelsBatched && workspace.viewer.inspection.batchComponentLabels) {
    return workspace.viewer.inspection.batchComponentLabels(() => applyTourStep(workspace, entry,
      admitted, includeDesktopView, timeoutMs, onEmphasisFailure, resting, true, restoredContent, authoredTakeover, deferFigure));
  }
  // Every await below is bounded. One of them not being bounded is what put a
  // wearer in front of a half-played lesson for seven minutes.
  const bound = async <T>(label: string, work: () => Promise<T> | T | undefined) => {
    const began = readoutClock();
    try { return await withViewerRetry(workspace, label, work, timeoutMs, admitted); }
    finally {
      try {
        (globalThis as { __stereofoldDiagnostics?: { record?: (kind: string, detail: unknown) => unknown } })
          .__stereofoldDiagnostics?.record?.('tour-phase',
            { chapter: entry.id, phase: label, elapsedMs: readoutClock() - began });
      } catch { /* Diagnostics cannot fail a chapter. */ }
    }
  };
  await waitForTourInteraction(workspace, admitted);
  if (!admitted()) return;
  // Missing or ambiguous chains must fail before appearance or placement edits.
  const visibility = entry.visibility ? resolveTourVisibility(workspace, entry.visibility) : undefined;
  // The next overview removes the preceding cutaway. Its placement must be
  // measured after that depth change: an old near plane beyond the room cap
  // makes every otherwise-visible fit impossible, even without a menu.
  if (entry.placement && entry.appearance?.clipping === 0 && workspace.snapshot().xrPresenting
    && Number(workspace.snapshot().inspection?.appearance?.clipping) > 0
    && workspace.viewer.inspection.holdsWearerPlacement?.() !== true)
    await bound('chapter depth', () => workspace.viewer.inspection.configure({ clipping: 0 }));
  // Entry may release the prior hold for a changed authored frame. Any new
  // input during this operation owns placement again; never release it here.
  if (entry.placement && workspace.viewer.inspection.holdsWearerPlacement?.() !== true)
    // This is an authored automatic seat, not a new agent/wearer room intent.
    await bound('placement', () => workspace.viewer.inspection.place(entry.placement!, 'tour-placement'));
  await waitForTourInteraction(workspace, admitted);
  if (!admitted()) return;
  const xr = workspace.snapshot().xrPresenting === true;
  if ((entry.motion || (xr && entry.cameraSpin)) && !restoredContent) {
    const norm = presentedChapterMotion(entry, xr);
    const pauseTurn = !norm || norm.kind === 'hold' || norm.kind === 'orbit' || norm.kind === 'dolly' || (norm.kind === 'turntable' && !norm.continuous);
    await bound('turn', () => workspace.viewer.inspection.setMotion({ paused: pauseTurn }));
  }
  await waitForTourInteraction(workspace, admitted);
  if (!admitted()) return;
  let rebuilt = false;
  if (entry.appearance && !restoredContent) { await bound('appearance', () => workspace.viewer.inspection.configure(entry.appearance!)); rebuilt = true; }
  for (const appearance of restoredContent ? [] : entry.appearances ?? []) {
    await waitForTourInteraction(workspace, admitted);
    if (!admitted()) return;
    await bound('appearance', () => workspace.viewer.inspection.configure(appearance)); rebuilt = true;
  }
  // Frame the focus before adding its annotations, including on cached entry.
  // Otherwise chapterFieldBounds fits the old figure's full silhouette instead
  // of retaining the emphasis close-up.
  const focusBeforeFigure = Boolean(entry.figure && framesEmphasisFocus(entry));
  if (focusBeforeFigure && workspace.viewer.inspection.holdsWearerPlacement?.() !== true) {
    try {
      await bound('molecular figure', () => workspace.viewer.inspection.setLessonFigure?.(undefined, { frame: false }));
    } catch (error) { throw Object.assign(error as Error, { figureFailure: true }); }
    await waitForTourInteraction(workspace, admitted);
    if (!admitted()) return;
  }
  if (restoredContent && !focusBeforeFigure) {
    try {
      if (entry.figure && !workspace.viewer.inspection.setLessonFigure)
        throw Error('This viewer does not support molecular figures.');
      await bound('molecular figure', () => workspace.viewer.inspection.setLessonFigure?.(entry.figure,
        { frame: !framesEmphasisFocus(entry) && workspace.viewer.inspection.holdsWearerPlacement?.() !== true && (!entry.animation || Boolean(entry.placement || entry.view === 'focus' || entry.emphasis?.framing || entry.figure?.focus)) }));
    } catch (error) { throw Object.assign(error as Error, { figureFailure: true }); }
    await waitForTourInteraction(workspace, admitted);
    if (!admitted()) return;
  }
  // Emphasis is a layer over the representation, so it has to follow the
  // rebuild that `appearance` may have just asked for; a rebuild drops it.
  //
  // Two holes, both of them the same twelve per cent ghost:
  //
  // - A chapter with no emphasis is not a chapter that leaves the emphasis
  //   alone. It is a plain chapter, and it has to say so, or an overview or a
  //   recap after a focused chapter arrives wearing the previous chapter's
  //   colours with every other chain at twelve per cent and no narration that
  //   explains any of it. The cached path already cleared; the first linear
  //   pass through a lesson — which is how a wearer sees it — did not.
  // - This is also the one operation of a scene that still has to run when the
  //   scene is abandoned. A Quest 2 rebuild takes seconds, a wearer who pauses
  //   inside one abandons the rest of the chapter, and a rebuild repaints
  //   whatever key the viewer believes it is wearing: skipping the emphasis
  //   left the NEW representation wearing the PREVIOUS chapter's key with
  //   nothing running to change it. An abandoned chapter paints the empty
  //   emphasis — the plain structure — never its own half-applied key.
  //
  // A key that cannot be painted is not a chapter
  // that cannot be shown. The wall lesson's chapter 5 threw `Could not find
  // node` inside its emphasis, and because that rejection reached `visit` the
  // wearer got no chapter 5 at all — no caption, no placement, no
  // representation, and a tour that would not advance again. The appearance and
  // the placement have already landed by the time this runs, so the chapter is
  // on screen; the failure is recorded and the transport keeps moving.
  const abandoned = !admitted();
  if (!abandoned || rebuilt) {
    // A density chapter has no colour key to paint — a map has
    // no chains — so its manifest carries no `emphasis` at all, and without
    // the line below no chapter of the tier would ever be framed: the map sat
    // wherever the entry seat left it, at eighteen per cent of the lens on
    // tonight's hardware. A density scene therefore frames its whole map at
    // the `fill` the atomic whole-structure chapters take, which is also what
    // records the frame shares for a volume chapter in the ring. An authored
    // `framing` still wins; an abandoned chapter still paints plain.
    const live = workspace.snapshot();
    const densityScene = (live.atomCount ?? 0) === 0 && (live.triangleCount ?? 0) > 0;
    const emphasis: TourEmphasis = abandoned ? { parts: [], origin: 'lesson' as const }
      : stepEmphasis(entry, resting);
    if (workspace.viewer.inspection.holdsWearerPlacement?.() === true || (!entry.emphasis?.framing && includeDesktopView && !authoredTakeover))
      emphasis.framing = undefined;
    if (!abandoned && densityScene && !entry.emphasis?.framing
        && workspace.viewer.inspection.holdsWearerPlacement?.() !== true) emphasis.framing = 'fill';
    if ((entry.figure && !framesEmphasisFocus(entry)) || (entry.animation && !entry.emphasis?.framing)) emphasis.framing = undefined;
    try {
      await bound('colour emphasis', () => workspace.viewer.inspection.emphasize?.(emphasis));
    } catch (error) {
      // A key that never came back is a different animal: the viewer is still
      // holding the work, so the scene fails as it always did.
      if (isTourDeadlineError(error) || (error as { code?: string }).code === 'interaction_active') throw error;
      onEmphasisFailure(error);
    }
  }
  // Emphasis can await a rebuild. Pause or a source change during that wait
  // must cancel the remaining chapter writes as well.
  await waitForTourInteraction(workspace, admitted);
  if (!admitted()) return;
  if ((!restoredContent || focusBeforeFigure) && !deferFigure && workspace.viewer.inspection.setLessonFigure) {
    try {
      await bound('molecular figure', () => workspace.viewer.inspection.setLessonFigure!(entry.figure, { frame: !framesEmphasisFocus(entry) && workspace.viewer.inspection.holdsWearerPlacement?.() !== true && (!entry.animation || Boolean(entry.placement || entry.view === 'focus' || entry.emphasis?.framing || entry.figure?.focus)) }));
    } catch (error) { throw Object.assign(error as Error, { figureFailure: true }); }
  } else if ((!restoredContent || focusBeforeFigure) && !deferFigure && entry.figure) {
    throw Error('This viewer does not support molecular figures. Update Stereofold before opening this lesson.');
  }
  await waitForTourInteraction(workspace, admitted);
  if (!admitted()) return;
  if (entry.selection) {
    await bound('selection', () => workspace.viewer.select(entry.selection === 'clear' ? [] : resolveTourSelection(tourIdentityRows(workspace), entry.selection!),
      'selection', { lesson: true }));
  } else {
    // Saved ownership is authoritative even when the wearer picked the same
    // keys the lesson selected. Remembering those keys cannot authorize a clear.
    const scene = workspace.capture?.() as any;
    const ours = scene?.selectionKeys;
    if (ours?.length && scene?.inspection?.lessonSelection === selectionSignature(ours)
        && sameKeys(workspace.snapshot().selectionKeys, ours)) await bound('selection', () => workspace.viewer.select([]));
  }
  await waitForTourInteraction(workspace, admitted);
  if (!admitted()) return;
  // Apply the full mask last, after colour and selection transparency updates.
  if (visibility) await bound('visibility', () => workspace.viewer.inspection.setVisibility!(visibility));
  // A placement-only or view-only takeover also needs a fresh tracked seat.
  // Emphasis and figures already solve their own subject in front of the wearer.
  if (authoredTakeover && workspace.snapshot().xrPresenting && admitted()
      && !workspace.viewer.inspection.holdsWearerPlacement?.()
      && !entry.figure && !stepEmphasis(entry, resting).framing) {
    await bound('chapter framing', () => workspace.viewer.focusSelection?.({
      wholeStructure: entry.view !== 'focus', liftEmphasis: false, elevationDegrees: 0 }));
  }
  // Head pose is a transient XR-local input. Desktop camera operations have
  // no physical interpretation there and can make a wearer feel teleported.
  if (!includeDesktopView || !admitted() || !entry.view || workspace.viewer.inspection.holdsWearerPlacement?.()) return;
  if (entry.animation && entry.view === 'fit' && !entry.placement && !entry.emphasis?.framing && !entry.figure?.focus) return;
  const view = entry.view;
  if (view === 'fit') await bound('view', () => workspace.viewer.inspection.fit());
  else if (view === 'reset-orientation') await bound('view', () => workspace.viewer.inspection.resetOrientation());
  else if (view === 'focus') await bound('view', () => workspace.viewer.focus(workspace.snapshot().selectionKeys ?? []));
  else if ('orbit' in view) await bound('view', () => workspace.viewer.inspection.orbit(view.orbit.axis, view.orbit.degrees));
  else await bound('view', () => workspace.viewer.inspection.dolly(view.dolly));
}

export function mountTourPlayer({ workspace, tours, after, autoDelayMs = 7_000, onExplore, narrate,
  continueStage, aside = (line: string) => voiceCommandSpeaker()?.(line) }: {
  workspace: Workspace;
  tours: readonly Tour[];
  after: Element;
  autoDelayMs?: number;
  continueStage?: (stage: string, intent: StageContinuationIntent) => Promise<unknown>;
  onExplore?: (kind: 'structure' | 'sequence') => void;
  /**
   * Say one scene's line out loud. Registering a narrator is the opt-in: a page
   * with none still runs every scene and still writes every caption, exactly as
   * `voice-command-speaker.mjs` treats speech as an accessory. The call is fired
   * and not awaited, because a scene must not wait on the Mac's voice route.
   */
  narrate?: (line: string) => void;
  /**
   * Say a line that is *about* the lesson rather
   * than part of it — today, only the failed-highlight line.
   *
   * It is deliberately not `narrate`. The page wires `narrate` to
   * `speakNarration`, which stamps every call with a generation counter and
   * sends a `stale()` down to the speaker with `interrupt: true`. Two lines
   * through that gate cancel each other: the aside bumps the counter, so the
   * chapter line is dropped when its audio lands, and the aside is dropped in
   * turn because `narratingLine()` still holds the chapter's. The wearer heard
   * neither, and the log carried two `speech-dropped` events. Speaking the
   * aside through the page's ordinary acknowledgement slot leaves the chapter's
   * generation and `narratingLine()` untouched, and the aside is queued rather
   * than an interrupt — so it waits for the chapter line instead of cutting it
   * off mid-sentence, and neither line can be dropped as stale.
   *
   * The default is the same registration slot every other accessory line on
   * this page uses; a page that never registers a speaker stays silent.
   */
  aside?: (line: string) => unknown;
}): TourPlayer {
  let catalog = [...tours];
  const root = document.createElement('section');
  root.className = 'tour-player'; root.dataset.tourPlayer = '';
  root.setAttribute('aria-label', 'Guided tours');
  root.innerHTML = `<div class="tour-player-heading"><div class="eyebrow">LESSON</div><label>Choose a lesson <select data-tour-menu aria-label="Tours"><option value="">Choose a tour</option></select></label></div>
    <p class="tour-player-summary" data-tour-summary></p>
    <div class="tour-player-reading"><div class="tour-player-scene" role="region" aria-label="Lesson caption and sources" tabindex="0" aria-live="polite"><div class="eyebrow" data-tour-progress>READY</div><h3 data-tour-title>Select a tour</h3><p class="tour-player-body" data-tour-body></p><p class="tour-player-sources" data-tour-sources></p><details class="tour-player-details" data-tour-details-disclosure hidden><summary>Source &amp; details</summary><p data-tour-details></p></details><p class="tour-player-status" data-tour-status role="status"></p></div><span class="tour-player-scroll-hint" data-tour-scroll-hint aria-hidden="true" hidden>Scroll for more ↓</span></div>
    <div class="tour-player-actions">
      <button type="button" class="primary tour-wide" data-tour-start>Start lesson</button><button type="button" class="primary tour-wide" data-tour-rejoin hidden>Rejoin lesson</button>
      <div class="tour-transport"><button type="button" data-tour-back aria-label="Previous scene">← Back</button><button type="button" class="primary" data-tour-play>Play</button><button type="button" data-tour-next aria-label="Next scene">Next →</button></div>
      <div class="tour-explore"><button type="button" data-tour-explore>Explore controls</button><button type="button" data-tour-sequence>Select residues</button></div>
      <details class="tour-more"><summary>Lesson options</summary><div class="tour-more-body"><label class="tour-player-pace">Pace <select data-tour-pace aria-label="Autoplay pace"><option value=".75">Slow</option><option value="1" selected>Comfortable</option><option value="1.5">Quick</option></select></label><button type="button" data-tour-restart>Restart</button><button type="button" data-tour-restore>Restore start</button><button type="button" data-tour-menu-button>Choose lesson</button></div></details>
    </div>`;
  after.after(root);
  const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
  const menu = $<HTMLSelectElement>('[data-tour-menu]');
  const summary = $<HTMLParagraphElement>('[data-tour-summary]');
  const progress = $<HTMLDivElement>('[data-tour-progress]');
  const title = $<HTMLHeadingElement>('[data-tour-title]');
  const body = $<HTMLParagraphElement>('[data-tour-body]');
  const sources = $<HTMLParagraphElement>('[data-tour-sources]');
  const detailsDisclosure = $<HTMLDetailsElement>('[data-tour-details-disclosure]');
  const details = $<HTMLParagraphElement>('[data-tour-details]');
  const status = $<HTMLParagraphElement>('[data-tour-status]');
  const captionRegion = $<HTMLDivElement>('.tour-player-scene');
  const captionHint = $<HTMLSpanElement>('[data-tour-scroll-hint]');
  const captionDocument = root.ownerDocument ?? document;
  const captionWindow = captionDocument.defaultView ?? window;
  let captionIdentity = '', captionSourcesIdentity = '';
  let captionSuspended = false, captionFrame: number | undefined, captionTimer: ReturnType<typeof setTimeout> | undefined;
  const captionVisible = () => !captionSuspended && !captionDocument.hidden && root.isConnected !== false;
  const cancelCaptionScroll = () => {
    if (captionFrame !== undefined) captionWindow.cancelAnimationFrame(captionFrame);
    if (captionTimer !== undefined) clearTimeout(captionTimer);
    captionFrame = undefined; captionTimer = undefined;
  };
  const refreshCaptionScroll = () => {
    cancelCaptionScroll();
    if (!captionVisible()) return;
    const height = captionRegion.clientHeight;
    const hidden = height <= 0 || captionRegion.scrollTop + height >= captionRegion.scrollHeight - 2;
    if (captionHint.hidden !== hidden) captionHint.hidden = hidden;
  };
  // ResizeObserver runs after layout. Scroll events and older browsers use
  // one task after a rendered frame, never a geometry read after sync's writes.
  const scheduleCaptionScroll = () => {
    if (!captionVisible() || captionFrame !== undefined || captionTimer !== undefined) return;
    const afterFrame = () => {
      captionFrame = undefined;
      if (captionVisible()) captionTimer = setTimeout(() => { captionTimer = undefined; refreshCaptionScroll(); }, 0);
    };
    if (typeof captionWindow.requestAnimationFrame === 'function') captionFrame = captionWindow.requestAnimationFrame(afterFrame);
    else afterFrame();
  };
  const captionResize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(refreshCaptionScroll);
  const captionChanged = () => { if (!captionResize) scheduleCaptionScroll(); };
  const setCaptionText = (element: HTMLElement, value: string) => {
    if (element.textContent === value) return;
    element.textContent = value; captionChanged();
  };
  const setCaptionFlag = (element: HTMLButtonElement | HTMLSelectElement, key: 'hidden' | 'disabled', value: boolean) => {
    if (element[key] === value) return;
    element[key] = value; captionChanged();
  };
  const setCaptionData = (key: string, value: string) => {
    if (root.dataset[key] === value) return;
    root.dataset[key] = value; captionChanged();
  };
  const suspendCaption = () => {
    captionSuspended = true; cancelCaptionScroll(); captionResize?.disconnect();
  };
  const observeCaption = () => {
    captionSuspended = false;
    if (!captionVisible()) return;
    if (captionResize) {
      captionResize.disconnect();
      for (const element of [captionRegion, progress, title, body, sources, detailsDisclosure, status]) captionResize.observe(element);
    } else scheduleCaptionScroll();
  };
  captionRegion.addEventListener('scroll', scheduleCaptionScroll, { passive: true });
  $<HTMLDetailsElement>('.tour-more').addEventListener('toggle', captionChanged, { passive: true });
  detailsDisclosure.addEventListener('toggle', captionChanged, { passive: true });
  captionWindow.addEventListener('resize', captionChanged);
  captionDocument.addEventListener('visibilitychange', () => {
    if (captionDocument.hidden) suspendCaption(); else observeCaption();
  });
  observeCaption();
  const start = $<HTMLButtonElement>('[data-tour-start]');
  const rejoinButton = $<HTMLButtonElement>('[data-tour-rejoin]');
  const back = $<HTMLButtonElement>('[data-tour-back]');
  const next = $<HTMLButtonElement>('[data-tour-next]');
  const play = $<HTMLButtonElement>('[data-tour-play]');
  const pace = $<HTMLSelectElement>('[data-tour-pace]');
  const restart = $<HTMLButtonElement>('[data-tour-restart]');
  const restore = $<HTMLButtonElement>('[data-tour-restore]');
  const menuButton = $<HTMLButtonElement>('[data-tour-menu-button]');
  const populateMenu = () => {
    menu.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a tour';
    menu.append(placeholder);
    for (const tour of catalog) {
      const option = document.createElement('option'); option.value = tour.id;
      option.textContent = `${tour.title} · ${tour.steps.length} scenes`; menu.append(option);
    }
  };
  populateMenu();

  let selected: Tour | undefined;
  let baseline: Scene | undefined, baselineSource: string | undefined, baselineIsLive = false;
  // The scene index the viewer is currently showing, so a Next that only has to
  // apply one step's intents does not first repaint the step before it.
  let liveStep: number | undefined;
  let step = -1, applying = false, autoplay = false, stopped = false, menuOpen = false, menuCursor = -1, readoutPage = 0;
  let narrationEnabled = true;
  let manipulationPending = false;
  let continuationEpoch = 0, continuationPending = false;
  // Reset changes the live pose while retaining the chapter's content. Play
  // resumes that exact scene; replaying chapter one would restore its old seat.
  let stoppedScene: { tour: Tour; step: number; source: string | undefined } | undefined;
  let deferredVisit: { target: number; restoreBaseline: boolean; preserveLiveScene: boolean; token: number } | undefined;
  // Whether a start or restart opened the current chapter. It travels with the
  // saved playback, so a peer's start never takes the wearer's placement here.
  let openedByStart = false;
  // The starting view of a lesson that was put down with one of its chapters
  // still drawn. A restart begins from it, not from the chapter it found.
  let retainedStart: { scene: Scene; source: string } | undefined;
  // When the live chapter landed, on the readout's clock.
  let chapterStartedAt: number | undefined;
  let resumeOnVisible = false;
  let resumeMotionOnVisible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let serial: Promise<void> = Promise.resolve(), navigating = false;
  let chapterPreview: TourPlayerState['chapterPreview'];
  const listeners = new Set<() => void>();
  const intents = createTourIntentGate();
  const scenes = new Map<number, { scene: Scene; held: boolean }>();
  // A held capture proves chapter content, not its authored pose. It can be
  // restored while a live hold preserves camera/placement, but after Reset it
  // must not suppress the authored framing that was skipped during that hold.
  const cacheScene = (index: number, scene: Scene) => scenes.set(index,
    { scene, held: workspace.viewer.inspection.holdsWearerPlacement?.() === true });
  const cachedScene = (index: number): Scene | undefined => {
    const cached = scenes.get(index);
    return cached && (!cached.held || workspace.viewer.inspection.holdsWearerPlacement?.() === true)
      ? cached.scene : undefined;
  };
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const active = () => selected != null && baseline != null && step >= 0 && !stopped;
  // One diagnostics line per tour decision. A headset log carried
  // toolbar, workbench and render-budget records but nothing from the tour, so
  // a press that changed nothing visible left nothing to read afterwards.
  const record = (action: string, detail: Record<string, unknown> = {}) => {
    try {
      (globalThis as { __stereofoldDiagnostics?: { record?: (kind: string, detail: unknown) => unknown } })
        .__stereofoldDiagnostics?.record?.('tour', {
          action, step, total: selected?.steps.length ?? 0, active: active(), autoplay,
          xr: Boolean(workspace.snapshot().xrPresenting), ...detail,
        });
    } catch { /* Diagnostics are advisory; a tour never fails because of them. */ }
  };
  const setStatus = (message = '') => { setCaptionText(status, message); };
  /**
   * The line this visit has already spoken, so one scene is never narrated
   * twice while it is on screen.
   *
   * It is a per-visit memory, not a per-line one.
   * Left standing, it silenced the chapter a wearer came back to — pause, grab
   * the structure, then Rejoin lesson, and the scene was restored without a
   * word, because the line it wanted to say was the line it had said before the
   * wearer left. Every edge that ends a visit forgets it; a repeat inside one
   * visit still dedupes.
   */
  let spokenLine: string | undefined;
  const forgetSpokenLine = () => { spokenLine = undefined; };
  let motionTimer: ReturnType<typeof setTimeout> | undefined;
  let motionActive = false, waitingForXrEntry = false;
  let pendingMapStart: { tour: Tour; source?: string; autoplay: boolean; narration: boolean } | undefined;
  let cameraFrame: SavedLessonPlayback['cameraFrame'];
  // capture() pins the pre-turn camera until a bake. Persist its baked
  // fraction, so handoff resumes unfinished moves without replaying saved ones.
  let motionProgress = 1, pendingMotionProgress: (() => number) | undefined;
  // Manual chapter advancement still runs authored motion. Only an explicit
  // pause withdraws its permission to resume after a grip.
  let continuousMotionPaused = false;
  let activeMotionKind: 'orbit' | 'dolly' | 'turntable' | 'hold' | undefined;
  let suspendChapterMotion: (() => void) | undefined;
  let resumeChapterMotion: (() => void) | undefined;

  /**
   * Let the chapter's turn become the saved camera, once.
   *
   * A tick is a transient — the viewer pins the camera the scene was saved
   * with and reports that pin from `capture()` — so the panel stays `ready`
   * and an agent command mid-chapter is admitted rather than refused as
   * `unsaved`. Nothing would ever save the turn without this, so it is called
   * at exactly the two moments a grab's `bakeGrab` is: the move finishing, and
   * the lesson letting go. It is not awaited and never fails a chapter: an
   * older viewer without the entry keeps the old behaviour.
   */
  const bakeChapterMotion = () => {
    const inspection = workspace.viewer.inspection as typeof workspace.viewer.inspection
      & { bakeLessonMotion?: () => unknown };
    if (pendingMotionProgress) motionProgress = pendingMotionProgress();
    try { inspection.bakeLessonMotion?.(); } catch { /* A presentation bake is advisory. */ }
  };
  const stopChapterMotion = (reason?: string, resumable = false, preserveMolecularPlayback = false) => {
    if (!preserveMolecularPlayback && reason !== 'restart' && reason !== 'hidden' && reason !== 'restored') workspace.viewer.inspection.controlMolecularAnimation?.({ state: 'pause' });
    if (resumable && motionActive) suspendChapterMotion?.();
    else if (!resumable) { suspendChapterMotion = undefined; resumeChapterMotion = undefined; resumeMotionOnVisible = false; }
    if (motionTimer) {
      clearTimeout(motionTimer);
      motionTimer = undefined;
    }
    if (motionActive) {
      motionActive = false;
      activeMotionKind = undefined;
      bakeChapterMotion();
      record('motion', { outcome: 'stopped', reason: reason ?? 'manual' });
      sync();
    }
  };

  const resumeContinuousAfterInteraction = () => {
    const motion = active() ? normalizeChapterMotion(selected?.steps[step]?.motion) : undefined;
    if (motion?.kind !== 'turntable' || !motion.continuous || applying || continuousMotionPaused || motionTimer) return;
    if (workspace.viewer.inspection.holdsTurnStill?.(selected!.steps[step]!.id) === true) return;
    const chapter = step, tour = selected;
    const resume = () => {
      motionTimer = undefined;
      if (!active() || continuousMotionPaused || applying || step !== chapter || selected !== tour) return;
      const live = workspace.snapshot();
      if (document.hidden || live.interactionActive || !live.ready) { motionTimer = setTimeout(resume, 50); return; }
      void workspace.viewer.inspection.setMotion({ paused: false }).catch(() => {});
    };
    motionTimer = setTimeout(resume, 50);
  };

  const pause = (reason = 'Paused.', options?: { preserveMolecularPlayback?: boolean }) => {
    continuationEpoch++;
    const wasAutoplay = autoplay;
    pendingMapStart = undefined;
    continuousMotionPaused = true;
    stopChapterMotion('paused', true, options?.preserveMolecularPlayback);
    intents.invalidate();
    autoplay = false; clearTimer();
    resumeOnVisible = false; resumeMotionOnVisible = false; forgetSpokenLine();
    if (active()) setStatus(reason);
    record('pause', { reason, wasAutoplay, preserveMolecularPlayback: options?.preserveMolecularPlayback === true });
    sync();
  };
  const state = (): TourPlayerState => {
    const available = selected != null && selected.steps.length > 0;
    const current = available && step >= 0 ? selected!.steps[step] : undefined;
    // The plate carries the spoken line whole; only a chapter without one is
    // paginated. `body` stays the desktop text for the Mac sidebar.
    const narration = current ? captionLine(current) : (selected?.summary ?? (workspace.snapshot().xrPresenting && catalog[0]
      ? `Start tour begins ${catalog[0].title}. Use Tour menu to choose another lesson.`
      : 'Choose a tour, then use Start tour.'));
    const pages = current ? wearerPages(current) : pageText(narration);
    const pageIndex = Math.min(readoutPage, pages.length - 1);
    return Object.freeze({
      tours: catalog.map(tour => Object.freeze({ id: tour.id, title: tour.title, steps: tour.steps.length })),
      ...(selected ? { selectedId: selected.id, selectedTitle: selected.title } : {}),
      // The lesson's own presentation rides the state the
      // toolbar readout reads every frame.
      // An explicitly clean molecular presentation stays clean during playback.
      ...(selected?.presentation ? { captionCard: selected.presentation.captionCard } : {}),
      ...(chapterStartedAt !== undefined ? { chapterStartedAt } : {}),
      ...(chapterPreview ? { chapterPreview } : {}),
      title: current?.title ?? (selected?.title ?? (menuOpen ? 'Choose a tour' : 'Tours')), body: narration,
      bodyPage: pages[pageIndex], bodyPageIndex: pageIndex, bodyPageCount: pages.length, feedback: status.textContent ?? '',
      progress: current ? `Scene ${step + 1} / ${selected!.steps.length}` : available ? `${selected!.steps.length} scenes ready` : 'Tours',
      step, total: selected?.steps.length ?? 0, active: active(), stopped, autoplay, narration: narrationEnabled, menuOpen, navigating,
      canBack: active() && step > 0 && !navigating,
      canNext: active() && step < selected!.steps.length - 1 && !navigating,
      // In XR Play starts a selected tour; when active it toggles autoplay.
      canPlay: available && !navigating && (step < 0 || active()),
      motionRunning: motionActive,
      ...(activeMotionKind ? { motionKind: activeMotionKind } : {}),
    });
  };
  const playbackCursor = (stoppedNow = stopped): SavedLessonPlayback | undefined =>
    selected && baseline && step >= 0 && baselineSource === source(workspace)
      ? { tourId: selected.id, chapterId: selected.steps[step].id, stopped: stoppedNow, narration: narrationEnabled,
        ...(openedByStart ? { entry: 'start' as const } : {}), motionProgress, motionPlaying: motionActive, cameraFrame, startingScene: withoutLessonPlayback(baseline) } : undefined;
  /**
   * Mark the saved cursor stopped while a chapter is being drawn.
   *
   * A save can land between a scene's operations. Until the new chapter is
   * whole, the old cursor would claim a chapter whose animation has already
   * been taken down, which is the state a saved lesson is refused for.
   */
  const holdPlaybackCursor = () => workspace.viewer.inspection.setLessonPlayback?.(playbackCursor(true));
  const sync = () => {
    // Never publish the old cursor over an in-flight chapter's new geometry.
    if (!applying && !navigating) workspace.viewer.inspection.setLessonPlayback?.(playbackCursor());
    const currentState = state();
    const available = currentState.total > 0;
    const current = available && step >= 0 ? selected!.steps[step] : undefined;
    const nextTitle = current?.title ?? (selected ? selected.title : 'Select a tour');
    const nextBody = current ? text(current) : (selected?.summary ?? '');
    const nextCaptionIdentity = JSON.stringify([selected?.id, current?.id, nextTitle,
      nextBody, current?.sources, current?.details, currentState.bodyPageIndex]);
    if (nextCaptionIdentity !== captionIdentity) {
      captionIdentity = nextCaptionIdentity;
      // Reset before changing content, retaining the same identity semantics
      // without forcing a read of the newly dirtied caption layout.
      captionRegion.scrollTop = 0;
    }
    setCaptionText(summary, selected?.summary ?? 'Choose a tour to see its scenes. Tours change the real molecular workspace and pause when you take over.');
    setCaptionText(progress, current ? `SCENE ${step + 1} / ${selected!.steps.length}${autoplay ? ' · AUTOPLAY' : ''}` : available ? `${selected!.steps.length} SCENES READY` : 'READY');
    setCaptionText(title, nextTitle);
    // Choosing a lesson is itself a readable tour state. Keep its overview in
    // the desktop panel too, matching the full summary already sent to the
    // in-headset readout before the first scene starts.
    setCaptionText(body, nextBody);
    const nextDetails = current?.details?.trim() ?? '';
    setCaptionText(details, nextDetails);
    // Keep the same disclosure node and its native open state across chapters,
    // including chapters with no details. Only its text and visibility change.
    if (detailsDisclosure.hidden !== !nextDetails) {
      detailsDisclosure.hidden = !nextDetails; captionChanged();
    }
    const nextSourcesIdentity = JSON.stringify(current?.sources ?? []);
    if (nextSourcesIdentity !== captionSourcesIdentity) {
      captionSourcesIdentity = nextSourcesIdentity;
      sources.replaceChildren();
      if (current?.sources?.length) {
        sources.append('Sources: ');
        current.sources.forEach((item, index) => {
          if (index) sources.append(' · ');
          if (!item.url) { sources.append(item.title); return; }
          const link = document.createElement('a'); link.href = item.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.textContent = item.title; sources.append(link);
        });
      }
      captionChanged();
    }
    setCaptionFlag(start, 'disabled', !available || navigating);
    setCaptionFlag(start, 'hidden', step >= 0);
    setCaptionFlag(rejoinButton, 'hidden', !selected || !baseline || step < 0 || !stopped);
    setCaptionFlag(rejoinButton, 'disabled', navigating);
    setCaptionFlag(back, 'disabled', !active() || step === 0 || navigating);
    setCaptionFlag(next, 'disabled', !active() || step >= selected!.steps.length - 1 || navigating);
    setCaptionFlag(play, 'disabled', !active() || navigating);
    setCaptionFlag(pace, 'disabled', !active() || navigating);
    setCaptionText(play, autoplay ? 'Pause' : 'Play');
    setCaptionFlag(restart, 'disabled', !active() || navigating);
    setCaptionFlag(restore, 'disabled', !baseline || navigating);
    setCaptionData('active', String(active())); setCaptionData('autoplay', String(autoplay));
    setCaptionData('selected', String(available)); setCaptionData('menuOpen', String(menuOpen));
    if (active()) setCaptionData('exploring', 'false');
    setCaptionData('tourReadoutPage', `${currentState.bodyPageIndex + 1}/${currentState.bodyPageCount}`);
    for (const listener of listeners) { try { listener(); } catch { /* A presentation redraw is advisory. */ } }
  };
  /**
   * The chapter line's own turn at the speaker, as far as this player can see
   * it. A narrator that reports back — a promise — settles this when its line
   * is done; the page's own narrator answers `undefined`, and then the turn is
   * already over as far as we can tell. Either way the failed-highlight aside
   * chains on it rather than racing it.
   */
  let narrationTurn: Promise<unknown> = Promise.resolve();
  /** Bound and record a fired-and-forgotten spoken line; never reaches the tour. */
  const spokenTurn = (spoken: unknown, detail: Record<string, unknown> = {}): Promise<unknown> =>
    spoken && typeof (spoken as Promise<unknown>).then === 'function'
      ? withTourDeadline('narration', spoken as Promise<unknown>, TOUR_NARRATION_TIMEOUT_MS)
        .catch(error => record('narration', { ...detail, outcome: 'error', error: String((error as Error)?.message ?? error).slice(0, 200) }))
      : Promise.resolve();
  /** Say this scene's line, once, without letting speech failures reach the tour. */
  const speakScene = (entry: TourStep | undefined) => {
    const line = (entry?.narration ?? entry?.body)?.trim();
    if (!narrationEnabled || !narrate || !line || line === spokenLine) return;
    spokenLine = line;
    record('narration', { chars: line.length });
    // A spoken line is an accessory to the scene, so it is never awaited. It is
    // also never silent: on the Quest the Mac voice route is a fetch that can
    // stall, and a narration that never came back used to leave nothing in the
    // headset log at all. Bounded and recorded here, the scene is unaffected.
    try {
      narrationTurn = spokenTurn(narrate(line) as unknown);
    } catch (error) {
      narrationTurn = Promise.resolve();
      record('narration', { outcome: 'error', error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
  };
  /**
   * The chapters whose failed colour key the wearer has
   * already been told about, so the failure line is spoken at most once per
   * chapter. Keyed by chapter, not by visit: toggling Back and Next over two
   * broken chapters must not nag. A fresh lesson run forgets them; a retry
   * that paints again forgets its chapter too. The linear walk applies one
   * chapter per `applyIntent` call and names each before it runs; the cached
   * restore names its chapter before it repaints.
   */
  let pendingEmphasisEntry: TourStep | undefined;
  const emphasisFailuresSpoken = new Set<TourStep>();
  const forgetEmphasisFailures = () => { emphasisFailuresSpoken.clear(); };
  /**
   * Say the failure line once per chapter, as an aside rather than as narration.
   *
   * This used to go out through `narrate`, which is
   * the page's `speakNarration` — a gate built to let one chapter line replace
   * the previous one. Sending a second line through it within the same chapter
   * made the two cancel each other out: the chapter line's generation stamp
   * went stale the moment this one asked, and this one was itself dropped
   * because the player was still holding the chapter's line as the one it was
   * narrating. Both were fetched, both were thrown away, and the wearer whose
   * colour key had just failed heard nothing at all about it — or about the
   * chapter. See the `aside` option above for why that is the channel now.
   *
   * The wearer is still told at most once per chapter, and the bookkeeping is
   * done before the wait so two failures landing together cannot both speak.
   */
  const speakEmphasisFailure = (entry: TourStep | undefined) => {
    if (!narrationEnabled || !narrate || !entry || emphasisFailuresSpoken.has(entry)) return;
    emphasisFailuresSpoken.add(entry);
    record('narration', { chars: EMPHASIS_FAILURE_LINE.length, emphasisFailure: true });
    // The chapter line goes first. A narrator that reports back is waited out,
    // so the aside lands between sentences; the page's own narrator reports
    // nothing, and then this is a microtask and the speaker's own queue keeps
    // the order — the aside is queued, never an interrupt.
    void narrationTurn
      .then(() => narrationEnabled ? spokenTurn(aside(EMPHASIS_FAILURE_LINE) as unknown, { emphasisFailure: true }) : undefined)
      .catch(error => record('narration', { emphasisFailure: true, outcome: 'error', error: String((error as Error)?.message ?? error).slice(0, 200) }));
  };
  /**
   * One place that says a lost colour key is not a lost chapter.
   *
   * Recorded rather than thrown, at both the sites a chapter's emphasis is
   * painted — the linear walk through `applyTourStep` and the cached restore
   * below. The wearer keeps the chapter; the log keeps the reason. The wearer
   * is also told, once per chapter: narrating a highlight that never appeared
   * is what this undoes.
   */
  const recordEmphasisFailure = (error: unknown, entry: TourStep | undefined = pendingEmphasisEntry) => {
    record('emphasis', { outcome: 'error', error: String((error as Error)?.message ?? error).slice(0, 200) });
    speakEmphasisFailure(entry);
  };
  const applyIntent = (entry: TourStep, admitted: () => boolean, includeDesktopView: boolean, authoredTakeover = false, deferFigure = false) =>
    applyTourStep(workspace, entry, admitted, includeDesktopView, operationBound(), recordEmphasisFailure, lessonRestingState(selected), false, false, authoredTakeover, deferFigure);
  // Restored content carries no local framing: solve authored placement and
  // focus here without replaying appearance or restarting molecular motion.
  const frameRestoredStep = (entry: TourStep, admitted: () => boolean, authoredTakeover = false) =>
    applyTourStep(workspace, entry, admitted, !workspace.snapshot().xrPresenting,
      operationBound(), recordEmphasisFailure, lessonRestingState(selected), false, true, authoredTakeover);
  /**
   * Put the emphasis layers where a restored snapshot cannot.
   *
   * An overview restores the baseline key so its names survive. The starting
   * view releases the lesson emphasis through the viewer's baseline owner. A
   * workspace built before the primitive existed has no `emphasize`, and then
   * this is a no-op exactly as it was.
   */
  /** Every bound in this player scales with the loaded tier. */
  const operationBound = () => tourOperationTimeoutMs(workspace.snapshot().atomCount);
  const applyStepEmphasis = async (entry: TourStep | undefined, admitted: () => boolean = () => true): Promise<unknown> => {
    await waitForTourInteraction(workspace, admitted);
    if (!admitted()) return;
    // Validate before repainting a restored chapter, just as on its first visit.
    let visibility: TourSceneVisibility | undefined;
    try { visibility = entry?.visibility ? resolveTourVisibility(workspace, entry.visibility) : undefined; }
    catch (error) { throw Object.assign(error as Error, { visibilityFailure: true }); }
    try {
      if (entry?.figure && !workspace.viewer.inspection.setLessonFigure) throw Error('This viewer does not support molecular figures.');
      await withViewerRetry(workspace, 'molecular figure', () => workspace.viewer.inspection.setLessonFigure?.(entry?.figure, { frame: (!entry || !framesEmphasisFocus(entry)) && workspace.viewer.inspection.holdsWearerPlacement?.() !== true }), operationBound(), admitted);
    } catch (error) { throw Object.assign(error as Error, { figureFailure: true }); }
    await waitForTourInteraction(workspace, admitted);
    if (!admitted()) return;
    try {
      return await withViewerRetry(workspace, 'colour emphasis', () => entry
        ? workspace.viewer.inspection.emphasize?.({ ...stepEmphasis(entry, lessonRestingState(selected)), framing: undefined })
        : (workspace.viewer.inspection.clearLessonEmphasis?.()
          ?? workspace.viewer.inspection.emphasize?.({ parts: [], origin: 'lesson' })), operationBound(), admitted);
    } finally {
      if (visibility && admitted()) {
        try { await withViewerRetry(workspace, 'visibility', () => workspace.viewer.inspection.setVisibility!(visibility), operationBound(), admitted); }
        catch (error) { throw Object.assign(error as Error, { visibilityFailure: true }); }
      }
    }
  };
  /**
   * The wearer's answer to the failure line. Re-applies the
   * current chapter's emphasis exactly once and says what happened in one
   * short line either way, so the voice action that calls this only has to
   * return the message. A key that never comes back still fails: the viewer
   * is wedged and the chapter must not pretend otherwise.
   */
  const retryEmphasis = async (): Promise<string> => {
    const lesson = selected;
    const entry = lesson && step >= 0 ? lesson.steps[step] : undefined;
    if (!lesson || !entry) throw Error('There is no active lesson chapter to retry.');
    try {
      await applyStepEmphasis(entry);
    } catch (error) {
      if (isTourDeadlineError(error) || (error as { visibilityFailure?: boolean }).visibilityFailure) throw error;
      record('emphasis', { outcome: 'error', retry: true, error: String((error as Error)?.message ?? error).slice(0, 200) });
      return EMPHASIS_RETRY_FAILURE_LINE;
    }
    emphasisFailuresSpoken.delete(entry);
    return EMPHASIS_RETRY_SUCCESS_LINE;
  };
  /**
   * A lesson that has stopped takes its active fade with it.
   *
   * The wearer grabs the structure, an agent sends a focus or a quality change,
   * or the Mol* workbench syncs. Every one of those stops the lesson here — and
   * every one of them used to leave a chapter's colour key and its twelve per
   * cent fade painted on the molecule, with no lesson running to explain them
   * and no chapter coming that would clear them. The wearer was then handed a
   * ghost: "show me the guide RNA" framed a part they could barely see.
   *
   * Rejoin re-applies the chapter's emphasis, so nothing is lost by clearing.
   * The viewer refuses this call when the live key was asked for by name rather
   * than painted by a chapter, which is why nothing here inspects the key: a
   * takeover is not an answer to a request the wearer or the agent made.
   *
   * This is not awaited. `notifyMutation` is a synchronous notification from a
   * mutation that has already happened, and the lesson is already stopped
   * whether or not the repaint lands.
   */
  const dropLessonEmphasis = () => {
    try {
      const cleared = workspace.viewer.inspection.clearLessonEmphasis?.();
      if (cleared && typeof cleared.catch === 'function') {
        cleared.catch((error: unknown) => record('interrupted',
          { outcome: 'emphasis-retained', error: String((error as Error)?.message ?? error).slice(0, 200) }));
      }
    } catch (error) {
      record('interrupted', { outcome: 'emphasis-retained', error: String((error as Error)?.message ?? error).slice(0, 200) });
    }
  };
  /** Resume only the part of a chapter move not baked into its saved camera. */
  const startChapterMotion = (tour: Tour, target: number, token: ReturnType<typeof intents.issue>, progress = 0) => {
    const startSource = source(workspace);
    motionProgress = progress; pendingMotionProgress = undefined;
    const normMotion = presentedChapterMotion(tour.steps[target], workspace.snapshot().xrPresenting === true);
    // The chapter's own scene work stops the viewer's presentation turn:
    // a rebuild or an emphasis is a mutation, and an XR framing travel
    // pauses it outright. The turn started before that work, so a headset
    // spin chapter stood still once it was shown. Start it again now,
    // unless the viewer framed it as a close-up the wearer stands inside:
    // that spin would carry the subject away and the structure through them.
    if (normMotion?.kind === 'turntable' && normMotion.continuous && workspace.snapshot().xrPresenting
        && workspace.viewer.inspection.holdsTurnStill?.(tour.steps[target].id) !== true)
      void Promise.resolve(workspace.viewer.inspection.setMotion({ paused: false })).catch(() => {});
    if (progress < 1 && normMotion && normMotion.kind !== 'hold' && !(normMotion.kind === 'turntable' && normMotion.continuous)) {
      stopChapterMotion('restart');
      motionProgress = progress;
      motionActive = true;
      activeMotionKind = normMotion.kind;
      sync();
      const motionKind = normMotion.kind;
      const durationMs = Math.max(200, (normMotion.seconds ?? 8) * 1_000 * (1 - progress));
      // A carried camera spin keeps its authored start and easing.
      const delayMs = normMotion.kind === 'orbit' ? (normMotion.delaySeconds ?? 0) * 1_000 : 0;
      const ease = normMotion.kind === 'orbit' && normMotion.easing ? easings[normMotion.easing] : easeInOut;
      let startTime = Date.now(), elapsedBeforePause = 0;
      let lastFraction = 0, lastTickAt = Date.now();
      pendingMotionProgress = () => progress + (1 - progress) * lastFraction;
      let currentToken = token;
      // Pause retains only this visit's remaining motion. Other stop paths
      // discard this closure, so a new chapter or wearer takeover cannot
      // inherit an old animation. Resuming does not restore a scene.
      suspendChapterMotion = () => {
        elapsedBeforePause += Date.now() - startTime;
        resumeChapterMotion = () => {
          if (document.hidden) return;
          resumeChapterMotion = undefined;
          if (!active() || navigating || selected !== tour
              || step !== target || source(workspace) !== startSource || !workspace.snapshot().ready) return;
          currentToken = intents.issue(); startTime = lastTickAt = Date.now();
          motionActive = true; activeMotionKind = motionKind;
          motionTimer = setTimeout(tickMotion, 50);
        };
      };
      const tickMotion = async () => {
        if (!motionActive || !active() || intents.isCurrent(currentToken) === false) {
          stopChapterMotion('interrupted');
          return;
        }
        const tickAt = Date.now();
        const live = workspace.snapshot();
        if (waitingForXrEntry || live.interactionActive || !live.ready) {
          // Chapter dwell continues, but its automatic move cannot fight a hand
          // or accumulate a jump to apply when the hand lets go.
          startTime += tickAt - lastTickAt; lastTickAt = tickAt;
          motionTimer = setTimeout(tickMotion, 50); return;
        }
        const tickElapsed = tickAt - lastTickAt;
        lastTickAt = tickAt;
        const elapsed = elapsedBeforePause + tickAt - startTime;
        const u = Math.min(1, Math.max(0, (elapsed - delayMs) / durationMs));
        const currentFraction = ease(u);
        const deltaFraction = currentFraction - lastFraction;
        if (deltaFraction > 0) {
          // The tick goes out through the lesson's own
          // path. A refused or no-op tick cannot spend the saved turn.
          // Only accepted camera movement advances its baked fraction.
          const move: LessonCameraMove = motionKind === 'orbit'
            ? { kind: 'orbit', axis: normMotion.axis, degrees: normMotion.degrees * (1 - progress) * deltaFraction }
            : motionKind === 'turntable'
              ? { kind: 'orbit', axis: 'y', degrees: normMotion.degrees * (1 - progress) * deltaFraction }
              : { kind: 'dolly', factor: Math.pow(Math.max(0.1, 1 - normMotion.metres * 0.2), (1 - progress) * deltaFraction) };
          try {
            const result = await applyMotionTick(move) as { lessonMotionApplied?: boolean } | undefined;
            if (result?.lessonMotionApplied === false) startTime += tickElapsed;
            else lastFraction = currentFraction;
          } catch {
            // Entry can take admission between the ready sample and the tick.
            // Keep that interval for the next tracked, admitted frame.
            startTime += tickElapsed;
          }
        }
        if (!motionActive || !intents.isCurrent(currentToken)) return;
        if (u < 1 || lastFraction < 1) {
          motionTimer = setTimeout(tickMotion, 50);
        } else {
          motionActive = false;
          activeMotionKind = undefined;
          suspendChapterMotion = undefined; resumeChapterMotion = undefined;
          // The chapter's turn is over, so its last pose becomes the saved
          // camera in one save rather than 160 ticks of unsaved drift.
          bakeChapterMotion();
          sync();
        }
      };
      motionTimer = setTimeout(tickMotion, 50);
    }
  };

  /**
   * One chapter-motion tick, on the path tagged as the
   * lesson's.
   *
   * The tick must never arrive as a workspace mutation: `orbit`/`dolly` are
   * the admitted edits a wearer's own toolbar rows and the agent's commands
   * use, and every one of them commits a revision and emits `onMutation`,
   * which `notifyMutation` reads as the wearer grabbing the structure. On a
   * Quest 2 the wall lesson's first orbit tick interrupted its
   * own chapter with `workspace-takeover` 0.2 s in and the lesson never
   * advanced again. A viewer with the dedicated entry gets the silent camera
   * path; an older viewer keeps the old calls and the old behaviour.
   */
  const applyMotionTick = (move: LessonCameraMove): Promise<unknown> => {
    const inspection = workspace.viewer.inspection as typeof workspace.viewer.inspection
      & { applyLessonMotion?: (move: LessonCameraMove) => Promise<unknown> };
    if (typeof inspection.applyLessonMotion === 'function') return inspection.applyLessonMotion(move);
    // An older viewer has no spin-axis orbit, so a carried camera spin stays
    // still there, as it always did.
    if (move.kind === 'orbit') return typeof move.axis === 'string'
      ? workspace.viewer.inspection.orbit(move.axis, move.degrees) : Promise.resolve(undefined);
    return workspace.viewer.inspection.dolly(move.factor);
  };
  type VisitCheckpoint = { scene: Scene; liveStep: number | undefined; baselineIsLive: boolean };
  type Rollback = 'restored' | 'failed' | 'skipped' | 'pending';
  /**
   * Put back the scene that failed work found.
   *
   * This runs inside the failed work's own workspace action, so nothing queued
   * behind it can land between the failure and the restore. A bound that fired
   * left its work running, and the viewer refuses a restore while it is busy,
   * so that work gets one more operation bound to settle first. Work that
   * outlasts it still holds the workspace queue: `answer` tells the caller now,
   * with `rollback: 'pending'`, and the found scene goes back once the late
   * work lands. Otherwise a late install would start a clock behind a player
   * that has already stopped. A restore that outlasts its own bound is waited
   * for the same way. The outcome rides on the error as `rollback` and is never
   * thrown in its place: the caller keeps the sentence that names the part
   * that stalled.
   */
  const putBackFound = async (scene: Scene, error: unknown, foundSource: string | undefined, answer: () => void,
    options: () => { preserveCamera: boolean; preservePlacement: boolean }): Promise<Rollback> => {
    // Anything thrown is rolled back; only an object can carry the outcome.
    const failure = (error && typeof error === 'object' ? error : {}) as { rollback?: Rollback };
    const skipped = (): Rollback => { failure.rollback = 'skipped'; record('scene', { outcome: 'rollback-skipped' }); return 'skipped'; };
    // The scene belongs to a structure that is no longer loaded.
    if (source(workspace) !== foundSource) return skipped();
    let late = false;
    const outlast = async (label: string, work: Promise<unknown>): Promise<unknown> => {
      try { return await withTourDeadline(label, work, operationBound()); }
      catch (bound) {
        if (!isTourDeadlineError(bound)) throw bound;
        if (!late) { late = true; failure.rollback = 'pending'; record('scene', { outcome: 'rollback-pending', phase: label }); answer(); }
        return work;
      }
    };
    try {
      const abandoned = (failure as Record<symbol, unknown>)[TOUR_ABANDONED] as Promise<unknown> | undefined;
      if (abandoned) await outlast('abandoned work', abandoned.then(() => undefined, () => undefined));
      const until = Date.now() + operationBound();
      for (;;) {
        if (source(workspace) !== foundSource) return skipped();
        if (workspace.snapshot().ready) {
          try {
            await outlast('rollback', Promise.resolve().then(() => workspace.viewer.inspection.restore(scene, options())));
            break;
          } catch (restoreError) {
            if ((restoreError as { code?: string }).code !== 'viewer_busy' || Date.now() >= until) throw restoreError;
          }
        } else if (Date.now() >= until) throw Error('The viewer was still busy with the abandoned chapter.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      failure.rollback = 'restored';
      record('scene', { outcome: 'rolled-back', ...(late ? { late: true } : {}) });
      return 'restored';
    } catch (rollbackError) {
      failure.rollback = 'failed';
      record('scene', { outcome: 'rollback-failed', error: String((rollbackError as Error)?.message ?? rollbackError).slice(0, 200) });
      return 'failed';
    }
  };
  /** Put back the scene a failed chapter found, and the cursor it was captured with. */
  const rollBackVisit = async (checkpoint: VisitCheckpoint, error: unknown, visitSource: string | undefined, answer: () => void): Promise<void> => {
    const outcome = await putBackFound(checkpoint.scene, error, visitSource, answer, () => ({
      preserveCamera: Boolean(workspace.snapshot().xrPresenting || workspace.viewer.inspection.holdsWearerPlacement?.()),
      preservePlacement: false }));
    if (outcome === 'skipped') return;
    if (outcome === 'restored') { liveStep = checkpoint.liveStep; baselineIsLive = checkpoint.baselineIsLive; }
    else { liveStep = undefined; baselineIsLive = false; }
    // The found scene brings back the cursor it was captured with. A visit
    // still drawing republishes its own as it ends; one whose outer bound has
    // already given up republishes it here.
    sync();
  };
  /**
   * A failure the workspace action has to outlast reaches its caller here.
   *
   * The action itself keeps the workspace queue until the scene it found is
   * back, so nothing queued behind it can draw over late work.
   */
  let lastDrawn: { scene: Scene; serial: number } | undefined, drawSerial = 0;
  /** Run a lesson action, then record what it left while the queue is still its own. */
  const noteDrawn = (action: () => Promise<void>) => async (): Promise<void> => {
    try { await action(); }
    finally {
      drawSerial++;
      try { lastDrawn = { scene: workspace.capture(), serial: drawSerial }; } catch { lastDrawn = undefined; }
    }
  };
  const lateAnswer = () => {
    let answer: (error: unknown) => void = () => {};
    const answered = new Promise<never>((_resolve, reject) => { answer = reject; });
    answered.catch(() => {});
    return { answered, answer };
  };
  const visit = (target: number, restoreBaseline = false, queuedAfter?: Promise<unknown>, preserveLiveScene = false, startRequestedAt?: number): Promise<void> => {
    const boundaryAt = readoutClock();
    const token = intents.issue(); navigating = true; sync();
    const queue = queuedAfter ?? serial;
    const operation = queue.then(async () => {
      record('timing', { phase: 'queue', target, elapsedMs: readoutClock() - boundaryAt });
      stopChapterMotion('scene-transition');
      const tour = selected, startScene = baseline, startSource = baselineSource;
      if (!tour || !startScene || target < 0 || target >= tour.steps.length || !intents.isCurrent(token)) {
        navigating = false; sync();
        throw Error('The tour scene was interrupted before rendering.');
      }
      const live = workspace.snapshot();
      if (source(workspace) === startSource && ((live.interactionActive && !workspace.viewer.inspection.supportsConcurrentPlayback) || tourViewerIsSettling(live))) {
        deferredVisit = { target, restoreBaseline, preserveLiveScene, token };
        navigating = false;
        const message = live.interactionActive
          ? 'The next chapter is waiting for the molecular drag to finish.'
          : 'The next chapter is waiting for the current scene change to finish.';
        setStatus(message);
        sync(); schedule();
        throw Object.assign(Error(message), { code: live.interactionActive ? 'interaction_active' : 'viewer_not_ready' });
      }
      if (!workspace.snapshot().ready || source(workspace) !== startSource) {
        stopped = true; autoplay = false; clearTimer();
        navigating = false; sync();
        throw Error('The structure changed. Choose a tour after the workspace is ready.');
      }
      // Whose visit this is. The viewer's readiness is not part of it: the
      // chapter's own follow-ups hold the viewer for a moment, and the
      // operations below wait out a busy viewer themselves.
      const owned = () => source(workspace) === startSource
        && intents.isCurrent(token) && selected === tour && baseline === startScene && baselineSource === startSource;
      const admitted = () => Boolean(workspace.snapshot().ready) && owned();
      // Judge the visit once the viewer has drawn what this chapter asked of
      // it. Each follow-up gets its own operation bound, within the scene
      // deadline: replaying earlier chapters must not spend its waiting time.
      const settleDeadline = Date.now() + tourSceneTimeoutMs(workspace.snapshot().atomCount);
      const admittedOnceSettled = async () => {
        await untilViewerSettles(workspace, owned, Math.min(settleDeadline, Date.now() + operationBound()));
        return admitted();
      };
      applying = true;
      // The scene this visit found, from the moment it starts to change it.
      let checkpoint: VisitCheckpoint | undefined;
      const fromStep = step;
      const { answered, answer } = lateAnswer();
      try {
        await waitForTourInteraction(workspace, admitted);
        let rendered = false;
        // A chapter is drawn whole or not at all. Any failure after drawing
        // began puts the found scene back before the workspace queue moves
        // on. A held drag only defers the chapter, which is drawn again later.
        const drawWhole = async (draw: () => Promise<void>) => {
          try { await draw(); }
          catch (error) {
            const deferred = (error as { code?: string }).code === 'interaction_active'
              && intents.isCurrent(token) && source(workspace) === startSource;
            if (checkpoint && !deferred) await rollBackVisit(checkpoint, error, startSource, () => answer(error));
            throw error;
          }
        };
        // The outer net under the per-operation bounds inside. It also covers
        // the wait for the workspace queue itself, so a chapter whose queue is
        // held by something else still ends in a sentence rather than silence.
        await withTourDeadline('scene', Promise.race([answered, workspace.runTour(noteDrawn(() => drawWhole(async () => {
          // Recheck after waiting for the workspace queue: hydration or a
          // remote command may have changed the source while we waited.
          if (!workspace.snapshot().ready || source(workspace) !== startSource
              || !intents.isCurrent(token) || selected !== tour || baseline !== startScene)
            throw Error('The tour scene was interrupted before rendering.');
          checkpoint = { scene: workspace.capture(), liveStep, baselineIsLive };
          holdPlaybackCursor();
          const animationFrame = workspace.viewer.inspection.animationFramingContext?.(tour.steps[target].animation);
          // The outgoing chapter's motion stays drawn while this one paints,
          // but it is not this chapter's field: a still chapter must not walk
          // out, or fold its menu, for motion it no longer has.
          workspace.viewer.inspection.chapterPainting?.(tour.steps[target].id,
            { turn: chapterTurnSweep(tour.steps[target], workspace.snapshot().xrPresenting === true) });
          // The opening chapter has no preceding dwell for lookahead. Resolve
          // source-only animation data while the chapter and toolbar paint;
          // installation still validates the final live representation layers.
          const openingAnimation = tour.steps[target].animation;
          const authoredFraming = Boolean(tour.steps[target].placement || tour.steps[target].view === 'focus'
            || tour.steps[target].emphasis?.framing || tour.steps[target].figure?.focus);
          if (openingAnimation && workspace.viewer.inspection.prepareMolecularAnimation) {
            const prepareAt = readoutClock();
            void Promise.resolve().then(() => workspace.viewer.inspection.prepareMolecularAnimation!(openingAnimation)).then(
              () => record('timing', { phase: 'animation-prepare', target, elapsedMs: readoutClock() - prepareAt }),
              () => record('timing', { phase: 'animation-prepare', target, outcome: 'deferred-to-install' }));
          }
          // A start or restart opens where the wearer put the molecule; only a
          // later close-up chapter may take that placement over. Chapter one,
          // however it is reached, stands where a start puts it: on the
          // starting view's seat, or on the wearer's own.
          const opening = restoreBaseline || target === 0;
          const reseat = opening && workspace.viewer.inspection.holdsWearerPlacement?.() !== true;
          const takeover = !opening && target !== step
            && chapterAuthorsFraming(tour, target, { xr: workspace.snapshot().xrPresenting === true })
            && workspace.viewer.inspection.holdsWearerPlacement?.() === true;
          if (takeover) workspace.viewer.inspection.beginChapterFraming?.();
          // The menu and card go back to the seat they had when the lesson
          // started, as Done puts them back. A seat a later chapter moved them
          // to is not the opening chapter's, and the chapter frames against it.
          const restoreStartingSeat = () => withViewerRetry(workspace, 'tour seat',
            () => workspace.viewer.inspection.restoreTourSeat?.({ restart: true }), operationBound(), admitted);
          const preserveCamera = Boolean(workspace.snapshot().xrPresenting || workspace.viewer.inspection.holdsWearerPlacement?.());
          const retainLivePlacement = preserveLiveScene || (!restoreBaseline && target === step + 1
            && (takeover || workspace.viewer.inspection.holdsWearerPlacement?.() === true));
          const cached = restoreBaseline || retainLivePlacement ? undefined : cachedScene(target);
          const prior = restoreBaseline || retainLivePlacement ? undefined : cachedScene(target - 1);
          const atomicFigure = Boolean(!cached && openingAnimation && !authoredFraming && workspace.viewer.inspection.setAnimatedChapter);
          // The animated installer retires the old figure before replacing
          // its bodies. Clearing here first would draw unposed variant plates
          // and add a separate teardown/draw to an edited walk's restart.
          if (!atomicFigure) await withViewerRetry(workspace, 'animation reset', () => workspace.viewer.inspection.setMolecularAnimation?.(undefined), operationBound(), admitted);
          // Speak before the scene is built, not after.
          //
          // Rendering a scene can take seconds; the Mac's voice route takes its
          // own. Starting both here means the wearer hears the line while the
          // structure turns into it, which is the whole difference between a
          // tour and a slideshow. A narrator that throws never fails a scene.
          let previewPaint: Promise<unknown> | undefined;
          const preview = async (index: number) => {
            chapterPreview = { title: tour.steps[index].title, progress: `Scene ${index + 1} / ${tour.steps.length}`,
              bodyPage: wearerPages(tour.steps[index])[0] };
            sync();
            const paint = workspace.viewer.xr?.refreshToolbar?.();
            if (index === target && openingAnimation && !authoredFraming) {
              // Caption geometry can build alongside molecular paint. Join it
              // before framing, which reads the toolbar's actual plate bounds.
              previewPaint = paint;
              void previewPaint?.catch(() => {});
            } else await paint;
            if (!intents.isCurrent(token) || selected !== tour || baseline !== startScene || source(workspace) !== startSource)
              throw Error('The tour scene was interrupted before rendering.');
          };
          // The uncached path previews each chapter as it applies it.
          speakScene(tour.steps[target]);
          const paintAt = readoutClock();
          if (cached) {
            await preview(target);
            await withViewerRetry(workspace, 'scene restore', () => workspace.viewer.inspection.restore(cached,
              reseat ? { preserveCamera, preservePlacement: false, restorePlacement: true } : { preserveCamera, preservePlacement: preserveCamera }), operationBound(), admitted);
            if (opening) await restoreStartingSeat();
            // A capture carries appearance, placement,
            // selection and camera — it has no notion of the emphasis layers.
            // So a scene reached a second time (Back, or a second play of the
            // lesson) came back wearing the colour emphasis of the chapter the
            // wearer had just left. The first emulator capture of the rewritten
            // lesson showed chapters 1 and 2 both lit as chapter 3, because
            // both were restored from cache while chapter 3's layers were live.
            // Desktop captures include their local authored camera. XR kept
            // its room anchor, so it must solve this chapter's framing again.
            // The restored scene is already on screen, so a key
            // that will not paint is recorded and the chapter still counts.
            pendingEmphasisEntry = tour.steps[target];
            try {
              if (workspace.snapshot().xrPresenting) await frameRestoredStep(tour.steps[target], owned, takeover);
              else await applyStepEmphasis(tour.steps[target], owned);
            }
            catch (error) { if (isTourDeadlineError(error) || (error as { code?: string }).code === 'interaction_active' || (error as { figureFailure?: boolean; visibilityFailure?: boolean }).figureFailure
              || (error as { visibilityFailure?: boolean }).visibilityFailure) throw error; recordEmphasisFailure(error); }
            if (!(await admittedOnceSettled()))
              throw Error('The tour scene was interrupted while restoring.');
            liveStep = target;
          } else {
            const from = retainLivePlacement || prior ? target : 0;
            // Next cost two full representation rebuilds: restoring the
            // previous scene, then applying this one over it. When the viewer
            // already shows what the restore would paint, the first rebuild
            // repaints the frame in front of the wearer. The baseline captured
            // moments ago is the same case before the first scene.
            const showingAlready = retainLivePlacement || (prior ? liveStep === target - 1 : baselineIsLive);
            // The starting view brings its own seat back, and its own camera.
            // A headset's camera maps the structure into the room, and a spin
            // chapter turns it. Left before its turn came round, that turn
            // stayed, and chapter one came back seen from another side.
            const startingView = reseat && !prior;
            if (!showingAlready) {
              await withViewerRetry(workspace, 'scene restore', () => workspace.viewer.inspection.restore(prior ?? startScene, { preserveCamera: preserveCamera && !startingView, preservePlacement: preserveCamera && !startingView }), operationBound(), admitted);
              if (opening && !prior) await restoreStartingSeat();
            }
            baselineIsLive = false; liveStep = undefined;
            if (!intents.isCurrent(token) || selected !== tour || baseline !== startScene || baselineSource !== startSource)
              throw Error('The tour scene was interrupted while restoring.');
            for (let index = from; index <= target; index++) {
              await preview(index);
              pendingEmphasisEntry = tour.steps[index];
              await applyIntent(tour.steps[index], () => intents.isCurrent(token) && source(workspace) === startSource, !preserveCamera, takeover && index === target, atomicFigure && index === target);
              if (!(await admittedOnceSettled()))
                throw Error('The tour scene was interrupted while applying.');
              // Keep held chapter content without claiming its local pose is
              // authored. cachedScene excludes it after the hold is released.
              if (atomicFigure && index === target) scenes.delete(index);
              else cacheScene(index, workspace.capture());
              liveStep = index;
            }
          }
          if (!atomicFigure) await previewPaint;
          record('timing', { phase: 'chapter-paint', target, elapsedMs: readoutClock() - paintAt });
          const animationAt = readoutClock();
          if (tour.steps[target].animation && !workspace.viewer.inspection.setMolecularAnimation)
            throw Error('This viewer does not support molecular animation. Update Stereofold before opening this lesson.');
          // A chapter is whole only with its clock. A visit withdrawn before or
          // during the install fails here, inside this action, so the scene it
          // found is put back instead of a chapter left standing without one.
          if (!(await admittedOnceSettled())) throw Error('The tour scene was interrupted before installing molecular animation.');
          const install = () => atomicFigure
            ? workspace.viewer.inspection.setAnimatedChapter!(openingAnimation!, tour.steps[target].id, tour.steps[target].figure, {context:animationFrame, frame:!tour.steps[target].placement, framing:tour.steps[target].emphasis?.framing, toolbarReady:previewPaint})
            : workspace.viewer.inspection.setMolecularAnimation?.(tour.steps[target].animation, tour.steps[target].id, {
            context: animationFrame,
            // An authored room placement is the author's pose; never refit it.
            frame: !tour.steps[target].placement,
            framing: tour.steps[target].emphasis?.framing,
          });
          await withViewerRetry(workspace, 'molecular animation', install, tourAnimationInstallTimeoutMs(workspace.snapshot().atomCount), admitted);
          if (!(await admittedOnceSettled())) {
            // The withdrawn clock never runs, even if the found scene cannot come back.
            await workspace.viewer.inspection.setMolecularAnimation?.(undefined);
            throw Error('The tour scene was interrupted while installing molecular animation.');
          }
          // Cache the complete new figure and clock, not the previous
          // animation retained while this chapter was being painted.
          if (atomicFigure) cacheScene(target, workspace.capture());
          record('timing', { phase: 'animation-install-frame', target, elapsedMs: readoutClock() - animationAt });
          rendered = true;
        }).finally(() => workspace.viewer.inspection.chapterPainting?.(undefined))))]), tourSceneTimeoutMs(workspace.snapshot().atomCount));
        // The chapter is whole here; only something between the action's end
        // and this line can have withdrawn it. It stays drawn, and stopped.
        if (!rendered || !(await admittedOnceSettled()))
          throw Error('The tour scene was interrupted before completion.');
        chapterPreview = undefined;
        step = target; stopped = false; stoppedScene = undefined; openedByStart = restoreBaseline;
        continuousMotionPaused = false;
        // The caption's reading window opens here, on the clock
        // the headset readout measures it against. See `TourPlayerState`.
        chapterStartedAt = readoutClock();
        readoutPage = 0;
        // The final scene owns a full dwell too; schedule releases it afterwards.
        workspace.setStatus(`Tour scene ${step + 1} of ${tour.steps.length} shown`);
        setStatus(autoplay ? 'Autoplay is running.' : 'Use Back, Next, or Autoplay.');
        const dwellMs = tourStepDwellMs(tour.steps[step], 0, narrationEnabled);
        record('scene', { outcome: 'shown', title: tour.steps[step]?.title ?? null, dwellMs, boundaryToShownMs: readoutClock() - boundaryAt });
        if (startRequestedAt !== undefined) record('timing', { phase: 'start-to-shown', elapsedMs: readoutClock() - startRequestedAt });
        const nextAnimation = tour.steps[step + 1]?.animation;
        if (nextAnimation && workspace.viewer.inspection.prepareMolecularAnimation) {
          const prepareAt = readoutClock();
          void workspace.viewer.inspection.prepareMolecularAnimation(nextAnimation).then(
            () => record('timing', { phase: 'animation-prepare', target: target + 1, elapsedMs: readoutClock() - prepareAt }),
            () => record('timing', { phase: 'animation-prepare', target: target + 1, outcome: 'deferred-to-install' }));
        }

        startChapterMotion(tour, target, token);
      } catch (error) {
        if ((error as { code?: string }).code === 'interaction_active' && intents.isCurrent(token) && source(workspace) === startSource) {
          deferredVisit = { target, restoreBaseline, preserveLiveScene, token };
          setStatus('The next chapter will appear when you release the structure.');
          record('scene', { outcome: 'deferred', target, reason: 'interaction' });
          throw error; // A tool caller must not be told an unrendered chapter landed.
        }
        // The work this scene gave up on is still on the
        // workspace queue. A rebuild that lands a few seconds after the bound
        // fired used to paint the chapter anyway — over a status line that said
        // the lesson had paused — and the player then read its own late paint
        // as a takeover and stripped the colours back off. Withdrawing the
        // intent is what makes the rest of that work a no-op.
        //
        // Only this visit's own intent: a visit superseded by a newer one (Next
        // pressed twice) reaches here too, and cancelling then would kill the
        // press that superseded it rather than anything of its own.
        if (intents.isCurrent(token)) intents.invalidate();
        autoplay = false; setStatus(`Tour paused: ${(error as Error).message}`);
        // A failed start leaves no lesson running. A later chapter whose found
        // scene came back stays on it, paused; any other drawn failure stops.
        const rollback = (error as { rollback?: string } | null)?.rollback;
        if (selected === tour && baseline === startScene && baselineSource === startSource
            && (fromStep < 0 || (checkpoint && rollback !== 'restored'))) stopped = true;
        record('scene', { outcome: 'error', target, error: (error as Error).message, ...(rollback ? { rollback } : {}) });
        throw error;
      } finally { chapterPreview = undefined; applying = false; navigating = false; sync(); schedule(true); }
    });
    serial = operation.catch(() => undefined);
    return operation;
  };
  const schedule = (fromPaint = false) => {
    clearTimer();
    if (deferredVisit) {
      const pending = deferredVisit;
      if (!intents.isCurrent(pending.token) || !selected || !baseline || source(workspace) !== baselineSource) deferredVisit = undefined;
      else {
        if (document.hidden) return;
        timer = setTimeout(() => {
          if (!intents.isCurrent(pending.token)) { deferredVisit = undefined; return; }
          const live = workspace.snapshot();
          if (['error', 'disposed', 'context_lost'].includes(live.status ?? '')) {
            deferredVisit = undefined; autoplay = false;
            setStatus('The lesson is waiting for the viewer to recover.'); sync(); return;
          }
          if ((live.interactionActive && !workspace.viewer.inspection.supportsConcurrentPlayback) || !live.ready) { schedule(); return; }
          deferredVisit = undefined;
          void visit(pending.target, pending.restoreBaseline, undefined, pending.preserveLiveScene).catch(reportActionError);
        }, 250);
        return;
      }
    }
    if (!autoplay || !active() || !selected || document.hidden) return;
    const scheduledTour = selected, scheduledStep = step;
    // The plate shows the spoken line whole, so its own word count sets the
    // dwell and there is never a second page to hold autoplay for.
    const chapterDwellMs = tourStepDwellMs(scheduledTour.steps[scheduledStep], 0, narrationEnabled);
    const multiplier = Number(pace.value);
    const pacedMs = Math.ceil(chapterDwellMs / (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1));
    const hasNextScene = scheduledStep < scheduledTour.steps.length - 1;
    const authoredSilent = !narrationEnabled && scheduledTour.steps[scheduledStep].durationMs !== undefined;
    // A silent timed hold with no caption card owes no reading time to the
    // toolbar's source/details readout. Keep scene admission and FPS safety.
    const captionHoldApplies = !(authoredSilent && scheduledTour.presentation?.captionCard === 'hidden'
      && normalizeChapterMotion(scheduledTour.steps[scheduledStep].motion)?.kind === 'hold');
    const pages = workspace.snapshot().xrPresenting && captionHoldApplies ? wearerPages(scheduledTour.steps[scheduledStep]) : [];
    const pageDwellMs = pages.length > 1 ? Math.max(authoredSilent ? 0 : 3_000, Math.ceil(pacedMs / pages.length)) : pacedMs;
    let holdStartedAt: number | undefined;
    const advance = () => {
      // A pause, manual navigation, or source/tour change invalidates this
      // dwell. In XR, paginate the full lesson before advancing the molecule;
      // desktop retains its original one-scene-per-dwell behavior.
      if (!autoplay || !active() || selected !== scheduledTour || step !== scheduledStep) return;
      // Turning a caption page redraws one panel, so it is never held back.
      if (pages.length > 1 && readoutPage < pages.length - 1) {
        readoutPage++; chapterStartedAt = readoutClock(); sync(); schedule(); return;
      }
      const live = workspace.snapshot();
      if ((live.interactionActive && !workspace.viewer.inspection.supportsConcurrentPlayback) || (source(workspace) === baselineSource && tourViewerIsSettling(live))) {
        setStatus(live.interactionActive ? 'The next chapter will appear when you release the structure.'
          : 'The next chapter is waiting for the current scene change to finish.');
        timer = setTimeout(advance, 250); return;
      }
      // The headset card turns its own pages every seven seconds. A chapter
      // stays until its last page has stood that long, whatever the dwell.
      const cardHoldMs = live.xrPresenting && captionHoldApplies ? Number(workspace.viewer.xr?.toolbarReadout?.()?.cardHoldMs) : 0;
      if (cardHoldMs > 0) { timer = setTimeout(advance, Math.min(cardHoldMs, 1_000)); return; }
      if (!hasNextScene) {
        const nextStage = scheduledTour.presentation?.continueToStage;
        if (nextStage && continueStage) {
          // A previous, cancelled request may still be settling. Keep the
          // newly requested Play alive until it releases the single-flight slot.
          if (continuationPending) { timer = setTimeout(advance,250); return; }
          // A source swap cannot bake a live molecular grab. Internal slides
          // keep advancing while held; only this batch boundary waits.
          if (live.interactionActive || !live.ready) {
            setStatus('The next batch will load when you release the structure.');
            sync(); timer = setTimeout(advance, 250); return;
          }
          continuationPending = true;
          const epoch = continuationEpoch;
          let transitioning = false;
          const ownsScene = () => selected === scheduledTour && step === scheduledStep && source(workspace) === baselineSource;
          const intent: StageContinuationIntent = {
            isCurrent: () => continuationEpoch === epoch && autoplay && ownsScene(),
            beginTransition: () => { transitioning = true; },
            shouldAutoplay: () => continuationEpoch === epoch && (transitioning || autoplay && ownsScene()),
          };
          setStatus('Loading the next batch…'); sync();
          record('continuation', { outcome: 'requested', stage: nextStage });
          void Promise.resolve().then(() => intent.isCurrent() ? continueStage(nextStage, intent) : undefined).then(() => {
            if (continuationEpoch === epoch && autoplay && ownsScene())
              throw Error('The next batch did not replace the current scene');
            record('continuation', {outcome:continuationEpoch===epoch?'completed':'cancelled',stage:nextStage});
          }).catch(error => {
            if (continuationEpoch !== epoch || !ownsScene()) return;
            if ((error as {code?:string})?.code === 'continuation_deferred') {
              setStatus('The next batch will load when you release the structure.'); sync();
              timer = setTimeout(advance,250); return;
            }
            autoplay = false; clearTimer();
            setStatus(`Could not load the next batch: ${(error as Error)?.message ?? String(error)}. Press Play to retry.`);
            record('continuation', { outcome: 'failed', stage: nextStage, error: String((error as Error)?.message ?? error).slice(0,200) }); sync();
          }).finally(() => { continuationPending = false; });
          return;
        }
        if (scheduledTour.presentation?.end === 'hold') {
          autoplay = false; setStatus('Tour complete. Press Done when ready.'); sync();
        } else void finish('completed').catch(reportActionError);
        return;
      }
      // Building the next scene costs a long frame, so a session that is
      // already stuttering gets a moment to recover first. The hold is capped:
      // a scene the wearer is waiting for always arrives within five seconds of
      // its dwell, even if the budget never recovers.
      const fps = workspace.snapshot().xrPresenting ? liveFrameRate() : undefined;
      const busy = (fps !== undefined && fps < XR_AUTOPLAY_MINIMUM_FPS) || applying;
      if (busy) {
        const now = Date.now();
        holdStartedAt ??= now;
        if (now - holdStartedAt < XR_AUTOPLAY_MAXIMUM_HOLD_MS) {
          setStatus(fps === undefined ? 'Autoplay is waiting for the last scene to finish.'
            : `Autoplay is waiting for the frame rate (${Math.round(fps)} fps).`);
          record('autoplay-hold', { fps: fps ?? null, applying, minimumFps: XR_AUTOPLAY_MINIMUM_FPS,
            heldMs: now - holdStartedAt, maximumHoldMs: XR_AUTOPLAY_MAXIMUM_HOLD_MS });
          sync(); timer = setTimeout(advance, XR_AUTOPLAY_RETRY_MS); return;
        }
        record('autoplay-hold', { outcome: 'expired', fps: fps ?? null, applying,
          heldMs: now - holdStartedAt, maximumHoldMs: XR_AUTOPLAY_MAXIMUM_HOLD_MS });
      }
      holdStartedAt = undefined;
      if (hasNextScene) void visit(scheduledStep + 1).catch(error => {
        setStatus((error as Error)?.message || 'Autoplay was interrupted.'); sync();
      });

    };
    const elapsed = fromPaint && chapterStartedAt !== undefined ? Math.max(0, readoutClock() - chapterStartedAt) : 0;
    timer = setTimeout(advance, Math.max(0, delayFromDocument(pageDwellMs) - elapsed));
  };
  /**
   * Where a wearer's single `Start tour` press has to land. A headset press
   * that renders the view already in front of the wearer reads as a dead
   * button, so an opening scene that is silent in XR is played through and the
   * lesson starts at the scene after it. Desktop keeps its scene numbering.
   */
  const openingStep = (tour: Tour): number =>
    tour.steps.length > 1 && Boolean(workspace.snapshot().xrPresenting)
      && tourStepIsSilentInXr(tour.steps[0], workspace.snapshot().inspection) ? 1 : 0;
  const begin = (autoStart = true, startAt?: number | 'last', options?: { narration?: boolean; waitForXrEntry?: boolean; preserveContinuation?: boolean }): Promise<void> => {
    if (!options?.preserveContinuation) continuationEpoch++;
    const live = workspace.snapshot();
    if (options?.waitForXrEntry && selected && !live.xrPresenting && (live.atomCount ?? 0) === 0 && (live.triangleCount ?? 0) > 0
      && (startAt === undefined || startAt === 0)) {
      // The first map chapter needs tracked framing and a fresh chapter card.
      // Starting before entry makes the room seat adopt its unframed card.
      pendingMapStart = { tour: selected, source: source(workspace), autoplay: autoStart, narration: options?.narration !== false };
      narrationEnabled = options?.narration !== false;
      setStatus('The opening chapter will start on entering VR.'); sync();
      return serial;
    }
    pendingMapStart = undefined;
    const startAtClock = readoutClock();
    narrationEnabled = options?.narration !== false;
    setStatus('Starting tour…'); forgetSpokenLine(); forgetEmphasisFailures();
    const token = intents.issue(); navigating = true; sync();
    const baselineRun = serial.then(async () => {
      const tour = selected;
      if (!tour || !workspace.snapshot().ready) { setStatus('Wait for the structure to finish loading.'); return false; }
      try {
        applying = true;
        await workspace.runTour(async () => {
          setStatus('Capturing starting view…');
          if (!workspace.snapshot().ready || !intents.isCurrent(token) || selected !== tour) return;
          // A lesson started again over one of its own chapters starts from
          // the view that lesson found, whichever route started it.
          const retained = retainedStart && retainedStart.source === source(workspace) ? retainedStart.scene
            : baseline && baselineSource === source(workspace) && step >= 0 ? baseline : undefined;
          const current = workspace.capture() as any;
          const starting = retained ? structuredClone(retained) as any : withoutLessonPlayback(current);
          const interchangeable = workspace.viewer.inspection.preservesFigureFrame?.() === true
            && tour.steps.every(entry => !entry.placement && !entry.view && !entry.figure?.focus
              && !entry.emphasis?.framing && !entry.animation && !entry.cameraSpin && (!entry.motion || entry.motion === 'hold'));
          // This source's entry fit is spent once. Replaying its invisible
          // pre-figure baseline must not restore the earlier, unframed seat.
          if (retained && interchangeable) {
            if (current.camera) starting.camera = structuredClone(current.camera);
            if (current.inspection?.placement && starting.inspection)
              starting.inspection.placement = structuredClone(current.inspection.placement);
          }
          // Restore the lesson's starting view, keeping a later wearer selection
          // and its ownership together, including an explicit empty selection.
          if (retained && current?.selectionKeys
              && current.inspection?.lessonSelection !== selectionSignature(current.selectionKeys)) {
            starting.selectionKeys = [...current.selectionKeys];
            if (starting.inspection) delete starting.inspection.lessonSelection;
          }
          if (!retained) cameraFrame = workspace.snapshot().xrPresenting ? 'xr' : 'desktop';
          retainedStart = undefined;
          autoplay = false; stopped = false; scenes.clear(); baseline = starting; baselineIsLive = !retained; liveStep = undefined; baselineSource = source(workspace); step = -1; chapterStartedAt = undefined; readoutPage = 0;
        });
        if (!intents.isCurrent(token) || selected !== tour || !baseline) return false;
        return true;
      } catch (error) { setStatus(`Tour could not start: ${(error as Error).message}`); return false; }
      finally { applying = false; }
    });
    serial = baselineRun.then(() => undefined);
    // Queue the first scene after the baseline promise, but pass that promise
    // explicitly because visit() normally appends to the current serial. The
    // returned promise now resolves only after the first scene is rendered;
    // remote callers cannot observe a baseline-only completion receipt.
    const firstScene = baselineRun.then(admitted => {
      const tour = selected;
      if (!admitted || !intents.isCurrent(token) || !tour || !baseline) {
        navigating = false; sync();
        throw Error('The tour did not render its first scene.');
      }
      setStatus('Preparing first scene…');
      // A Back pressed with nothing playing opens the lesson at
      // its closing chapter. Clamped, so a caller's index can never leave the
      // lesson, and absent it this is the opening scene it always was.
      const opening = startAt === undefined ? openingStep(tour)
        : Math.max(0, Math.min(tour.steps.length - 1, startAt === 'last' ? tour.steps.length - 1 : startAt));
      // Arm autoplay before the first scene renders, so the row reads Pause
      // once rather than flickering through Play on the way there.
      autoplay = autoStart;
      // Name what made the opening scene visible, or that nothing did. That is
      // the one line a later diagnosis needs to explain this press.
      record('start', { opening, skippedOpening: opening > 0, autoplay,
        openingChanges: xrStepChanges(tour.steps[0], workspace.snapshot().inspection) });
      record('timing', { phase: 'start-baseline', elapsedMs: readoutClock() - startAtClock });
      return visit(opening, true, baselineRun, false, startAtClock);
    }).catch(error => {
      navigating = false;
      setStatus(`Tour could not start: ${(error as Error).message}`);
      sync();
      throw error;
    });
    serial = firstScene.catch(() => undefined);
    return firstScene;
  };
  const select = (id: string, options: { preserveMolecularPlayback?: boolean; preserveContinuation?: boolean } = {}): Promise<void> => {
    if (!options.preserveContinuation) continuationEpoch++;
    pendingMapStart = undefined;
    stopChapterMotion('lesson-selected', false, options.preserveMolecularPlayback);
    intents.invalidate();
    // A chapter left on screen is the lesson's work, not the wearer's view.
    // Whatever starts next starts from the view the lesson found.
    if (baseline && baselineSource !== undefined && baselineSource === source(workspace) && step >= 0)
      retainedStart = { scene: baseline, source: baselineSource };
    selected = catalog.find(tour => tour.id === id); autoplay = false; clearTimer(); stopped = false; forgetSpokenLine(); forgetEmphasisFailures();
    menu.value = selected?.id ?? '';
    menuCursor = catalog.findIndex(tour => tour.id === id); menuOpen = false;
    baseline = undefined; baselineSource = undefined; step = -1; chapterStartedAt = undefined; readoutPage = 0; scenes.clear(); setStatus(''); sync();
    return serial;
  };
  const replaceTours = (next: readonly Tour[], options: { preservePlayback?: boolean; preserveMolecularPlayback?: boolean; preserveContinuation?: boolean } = {}): Promise<void> => {
    if (!options.preserveContinuation) continuationEpoch++;
    pendingMapStart = undefined;
    if (!Array.isArray(next)) throw new TypeError('Tour catalog must be an array.');
    const replacement = [...next];
    const ids = new Set<string>();
    for (const tour of replacement) {
      if (!tour || typeof tour.id !== 'string' || !tour.id || typeof tour.title !== 'string'
        || !Array.isArray(tour.steps) || ids.has(tour.id)) {
        throw new TypeError('Tour catalog contains an invalid or duplicate lesson.');
      }
      ids.add(tour.id);
    }
    if (options.preservePlayback) {
      const chapterId = selected?.steps[step]?.id;
      catalog = replacement;
      selected = catalog.find(tour => tour.id === selected?.id);
      step = selected?.steps.findIndex(chapter => chapter.id === chapterId) ?? -1;
      scenes.clear(); populateMenu(); menu.value = selected?.id ?? '';
      // The caller restores saved playback next; do not publish stale metadata.
      return serial;
    }
    // A catalog swap is a new lesson session. Invalidate queued work before
    // dropping its selected tour/baseline so an old scene cannot be restored
    // into a newly hydrated source.
    stopChapterMotion('catalog-replaced', false, options.preserveMolecularPlayback);
    intents.invalidate();
    autoplay = false; clearTimer(); resumeOnVisible = false; forgetSpokenLine(); forgetEmphasisFailures();
    selected = undefined; baseline = undefined; baselineSource = undefined; retainedStart = undefined;
    step = -1; chapterStartedAt = undefined; stopped = false; menuOpen = false; menuCursor = -1; readoutPage = 0;
    scenes.clear();
    catalog = replacement;
    populateMenu();
    menu.value = '';
    setStatus(catalog.length ? 'Lesson list updated. Choose a lesson.' : 'No lessons are available.');
    sync();
    return serial;
  };
  let pendingInstallation: (() => void) | undefined;
  const confirmLessonInstallation = () => {
    const resume = pendingInstallation;
    pendingInstallation = undefined;
    resume?.();
  };
  const installLesson = (tour: Tour, start?: LessonStart, confirm?: () => Promise<void>, requested: boolean | 'auto' | 'entry' = false): Promise<void> => {
    const entering = requested === 'entry';
    let frame = requested === true, seatOnceDrawn = false;
    const old = { catalog, selected, step, baseline, baselineSource, stopped, autoplay, narrationEnabled, openedByStart, cameraFrame };
    const currentChapter = selected?.steps[step]?.id;
    const continueVisit = Boolean(selected && baseline && step >= 0 && baselineSource === source(workspace));
    const chapterId = start?.chapterId ?? (continueVisit ? currentChapter : undefined);
    const target = Math.max(0, tour.steps.findIndex(chapter => chapter.id === chapterId));
    if (start?.chapterId && !tour.steps.some(chapter => chapter.id === start.chapterId))
      return Promise.reject(Error('start.chapterId: chapter is unavailable.'));
    const live = workspace.snapshot();
    if (start && target === 0 && (requested === 'auto' || requested === 'entry') && !confirm && !live.xrPresenting
      && (live.atomCount ?? 0) === 0 && (live.triangleCount ?? 0) > 0) {
      return replaceTours([tour, ...catalog.filter(entry => !entry.id.startsWith('lesson-') && entry.id !== tour.id)])
        .then(() => select(tour.id))
        .then(() => begin(start.autoplay !== false, 0, { narration: start.narration, waitForXrEntry: true }));
    }
    const molecularState = (workspace.capture() as any)?.inspection?.animation?.playback?.state;
    clearTimer(); stopChapterMotion('lesson-installed', false, true); intents.invalidate();
    autoplay = false; resumeOnVisible = false;
    const token = intents.issue(), installedSource = source(workspace);
    const operation = serial.then(async () => {
      const admitted = () => intents.isCurrent(token) && source(workspace) === installedSource && workspace.snapshot().ready === true;
      const bound = async <T>(label: string, work: Promise<T> | T | undefined, timeoutMs = operationBound()) => {
        const result = await withTourDeadline(label, work, timeoutMs);
        if (!admitted()) throw Error('The lesson installation was interrupted.');
        return result;
      };
      const { answered, answer } = lateAnswer();
      applying = true; navigating = true;
      try {
        await withTourDeadline('lesson installation', Promise.race([answered, workspace.runTour(noteDrawn(async () => {
          if (!admitted()) throw Error('The lesson installation was interrupted.');
          // The scene this install found, from the moment it starts to change it.
          const before = workspace.capture();
          try {
            // The animation reset below takes the playing chapter's clock down.
            holdPlaybackCursor();
            catalog = [tour, ...catalog.filter(entry => !entry.id.startsWith('lesson-') && entry.id !== tour.id)];
            selected = tour; scenes.clear(); forgetSpokenLine(); forgetEmphasisFailures();
            populateMenu(); menu.value = tour.id; menuOpen = false;
            await bound('lesson key', workspace.viewer.inspection.setLessonRestingState?.(lessonRestingState(tour)));
            // The host frames a source's first lesson ('auto'). In the headset
            // that frame never takes a placement the wearer holds; an explicit
            // frame:true does. The desktop frames it as it always has.
            frame = requested === true || ((requested === 'auto' || entering) && (workspace.snapshot().xrPresenting !== true
              || workspace.viewer.inspection.holdsWearerPlacement?.() !== true));
            if (start || continueVisit || requested) {
              baseline = continueVisit ? old.baseline : withoutLessonPlayback(before);
              baselineSource = installedSource;
              if (!continueVisit) cameraFrame = workspace.snapshot().xrPresenting ? 'xr' : 'desktop';
              const entry = tour.steps[target];
              // Read the outgoing scale before the chapter paints. An install's
              // frame may grow the molecule to its fit, but never shrinks it
              // past the ordinary animated cap.
              const outgoing = workspace.viewer.inspection.animationFramingContext?.(entry.animation);
              const animationFrame = outgoing && typeof outgoing === 'object' ? { ...outgoing, growToFit: true } : outgoing;
              if (entry.figure && !workspace.viewer.inspection.setLessonFigure) throw Error('This viewer does not support molecular figures.');
              if (entry.animation && !workspace.viewer.inspection.setMolecularAnimation) throw Error('This viewer does not support molecular animation.');
              // Only a fresh source's unheld frame or an explicit request releases manual placement.
              if (frame) workspace.viewer.inspection.beginChapterFraming?.();
              if (entering && frame && entry.placement)
                await bound('placement', workspace.viewer.inspection.place(entry.placement, 'tour-placement'));
              // As applyTourStep: only a continuous spin keeps the presentation turn.
              const xr = workspace.snapshot().xrPresenting === true;
              if (entering && (entry.motion || (xr && entry.cameraSpin))) {
                const motion = presentedChapterMotion(entry, xr);
                await bound('turn', workspace.viewer.inspection.setMotion({ paused: !(motion?.kind === 'turntable' && motion.continuous) }));
              }
              await bound('animation reset', workspace.viewer.inspection.setMolecularAnimation?.(undefined));
              for (const appearance of entry.appearances ?? (entry.appearance ? [entry.appearance] : []))
                await bound('appearance', workspace.viewer.inspection.configure(appearance));
              const focusBeforeFigure = Boolean(frame && entry.figure && framesEmphasisFocus(entry));
              await bound('molecular figure', workspace.viewer.inspection.setLessonFigure?.(focusBeforeFigure ? undefined : entry.figure,
                { frame: frame && !entry.animation && !focusBeforeFigure }));
              await bound('colour emphasis', workspace.viewer.inspection.emphasize?.({ ...stepEmphasis(entry, lessonRestingState(tour)),
                framing: entering && frame ? entry.emphasis?.framing : focusBeforeFigure ? entry.emphasis!.framing : undefined }));
              if (focusBeforeFigure) await bound('molecular figure', workspace.viewer.inspection.setLessonFigure?.(entry.figure, { frame: false }));
              if (entry.visibility) await bound('visibility', workspace.viewer.inspection.setVisibility?.(resolveTourVisibility(workspace, entry.visibility)));
              await bound('molecular animation', workspace.viewer.inspection.setMolecularAnimation?.(entry.animation, entry.id, { context: animationFrame, frame: frame && !entry.placement, framing: entry.emphasis?.framing }),
                tourAnimationInstallTimeoutMs(workspace.snapshot().atomCount));
              if (entering && frame && entry.view && workspace.viewer.inspection.holdsWearerPlacement?.() !== true) {
                const view = entry.view;
                // The authored scale is in source coordinates. In the headset a
                // plain opening fit takes the room seat a fresh XR entry gives.
                if (xr) seatOnceDrawn = view === 'fit' && !entry.emphasis?.framing && !entry.figure && !entry.animation
                  && Boolean(workspace.viewer.inspection.seatForEntry);
                else if (view === 'fit') await bound('view', workspace.viewer.inspection.fit());
                else if (view === 'reset-orientation') await bound('view', workspace.viewer.inspection.resetOrientation());
                else if (view === 'focus') await bound('view', workspace.viewer.focus(workspace.snapshot().selectionKeys ?? []));
                else if ('orbit' in view) await bound('view', workspace.viewer.inspection.orbit(view.orbit.axis, view.orbit.degrees));
                else await bound('view', workspace.viewer.inspection.dolly(view.dolly));
              }
              step = target; stopped = start ? false : old.stopped;
              openedByStart = start ? true : continueVisit && old.openedByStart;
              narrationEnabled = start ? start.narration !== false : old.narrationEnabled;
              autoplay = start ? start.autoplay !== false : continueVisit && old.autoplay;
              if (continueVisit && !start && molecularState)
                workspace.viewer.inspection.controlMolecularAnimation?.({ state: molecularState === 'paused' ? 'pause' : 'play' });
              chapterStartedAt = readoutClock(); readoutPage = 0;
            } else {
              baseline = undefined; baselineSource = undefined; step = -1; stopped = false;
            }
            if (!admitted()) throw Error('The lesson installation was interrupted.');
            // Installation has already painted this chapter. Seed the same
            // scene proof as a normal visit, so the first Next inherits it
            // without restoring the baseline and replaying earlier chapters.
            // cacheScene distinguishes wearer-held content from an authored pose.
            const installed = step >= 0 ? workspace.capture() : undefined;
            baselineIsLive = false; liveStep = step >= 0 ? step : undefined;
            if (installed) cacheScene(step, installed);
          } catch (error) {
            // As a failed chapter does: the found scene goes back inside this
            // action, once any work a bound gave up on has landed.
            if (await putBackFound(before, error, installedSource, () => answer(error),
              () => ({ preserveCamera: !frame, preservePlacement: !frame })) !== 'skipped') {
              try {
                await withTourDeadline('lesson key rollback', workspace.viewer.inspection.setLessonRestingState?.(lessonRestingState(old.selected), { preserveEmphasis: true }), operationBound());
              } catch (keyError) {
                record('scene', { outcome: 'lesson-key-rollback-failed', error: String((keyError as Error)?.message ?? keyError).slice(0, 200) });
              }
            }
            throw error;
          }
        }))]), tourSceneTimeoutMs(workspace.snapshot().atomCount));
        setStatus('Lesson installed.');
      } catch (error) {
        if (intents.isCurrent(token)) intents.invalidate();
        catalog = old.catalog; selected = old.selected; step = old.step; baseline = old.baseline;
        baselineSource = old.baselineSource; stopped = old.stopped; autoplay = false; narrationEnabled = old.narrationEnabled;
        openedByStart = old.openedByStart; cameraFrame = old.cameraFrame;
        // An interrupted install (including a late rollback) cannot certify
        // either its new scene or the previously cached chapter as live.
        baselineIsLive = false; liveStep = undefined; scenes.clear();
        populateMenu(); menu.value = selected?.id ?? '';
        throw error;
      } finally { applying = false; navigating = false; sync(); }
      if (entering && step >= 0) {
        // Fresh entry seats a chapter whose compact controls are on screen.
        // Solve against those, not the taller loading menu, or the seat shrinks.
        if (seatOnceDrawn && admitted()) {
          try {
            await bound('chapter controls', workspace.viewer.xr?.refreshToolbar?.());
            await bound('entry seat', workspace.viewer.inspection.seatForEntry?.());
          } catch (error) {
            // A refused seat (no fresh tracking, a held hand) keeps the
            // chapter on screen at its authored placement.
            if (!admitted() || isTourDeadlineError(error)) throw error;
            record('scene', { outcome: 'entry-seat-refused', error: String((error as Error)?.message ?? error).slice(0, 200) });
          }
        }
        record('start', { opening: step, autoplay });
        startChapterMotion(tour, step, token);
      }
      if (start && step >= 0) speakScene(tour.steps[step]);
      // Do not advance a short chapter before its draw-and-save receipt settles.
      // Keep this continuation if the acknowledgement is lost. Receipt recovery
      // may release it later, unless a user action or source change superseded it.
      pendingInstallation = () => {
        if (intents.isCurrent(token) && source(workspace) === installedSource && selected === tour) schedule();
      };
      if (admitted() && installedSource !== undefined)
        workspace.viewer.inspection.setSourceCoordinateFrame?.(tour.presentation?.coordinateFrame, installedSource);
      await confirm?.();
      confirmLessonInstallation();
    });
    serial = operation.catch(() => undefined);
    return operation;
  };
  const cycleTour = (): Promise<void> => {
    return select(catalog[(menuCursor + 1 + catalog.length) % catalog.length]?.id ?? '');
  };
  /**
   * One press of Next or Back, from a row or from the agent.
   *
   * Both used to pause an already-paused player and return whenever no lesson
   * was running, which is a press that does nothing and says nothing.
   * `tourTransportIntent` decides instead, and every branch here either changes
   * the scene or leaves a sentence behind.
   */
  const transport = (direction: 'next' | 'back'): Promise<void> => {
    continuationEpoch++;
    const snapshot = state();
    const intent = tourTransportIntent({ action: direction, active: active(), stopped, step, navigating,
      hasLesson: Boolean(selected ?? catalog[0]), canNext: snapshot.canNext, canBack: snapshot.canBack });
    record('transport', { direction, intent: intent.do, ...(intent.startAt ? { startAt: intent.startAt } : {}) });
    if (intent.do === 'none') { if (intent.reason) setStatus(intent.reason); sync(); return serial; }
    if (intent.do === 'move') {
      const wasAutoplay = autoplay;
      pause();
      autoplay = wasAutoplay;
      return visit(direction === 'next' ? step + 1 : step - 1);
    }
    // A lesson the wearer stopped by taking the structure keeps its chapter:
    // put that chapter back, then move on from it.
    if (intent.do === 'rejoin') {
      // A forward subset reveal needs the live placement, rather than a rejoin
      // that restores the transform captured before the wearer's grip.
      if (direction === 'next' && workspace.snapshot().xrPresenting
          && workspace.viewer.inspection.holdsWearerPlacement?.() === true
          && revealsAtLivePlacement(selected?.steps[step + 1]))
        return visit(step + 1, false, undefined, true);
      const wasAutoplay = autoplay;
      return rejoin(wasAutoplay).then(() => {
        const resumed = state();
        return (direction === 'next' ? resumed.canNext : resumed.canBack) ? transport(direction) : undefined;
      });
    }
    if (!selected && catalog[0]) void select(catalog[0].id);
    if (!selected) return serial;
    return begin(true, direction === 'back' ? 'last' : undefined, { narration: narrationEnabled });
  };
  const backAction = (): Promise<void> => transport('back');
  const nextAction = (): Promise<void> => transport('next');
  const togglePlay = (): Promise<void> => {
    if (navigating) return serial;
    // The headset always exposes Start tour, including before a lesson has
    // been selected. Give that explicit wearer action a useful first lesson.
    // Desktop dropdown behavior remains unchanged.
    if (!selected && workspace.snapshot().xrPresenting && catalog[0]) void select(catalog[0].id);
    if (!selected) return serial;
    if (stopped && step >= 0) return rejoin(true);
    if (!active()) return begin(true, undefined, { narration: narrationEnabled });
    if (autoplay) pause('Autoplay paused.');
    else {
      autoplay = true; continuousMotionPaused = false;
      // Page, spoken and menu Play share this explicit resume action. A
      // completed non-looping clip replays; chapter scheduling stays intact.
      const animation = workspace.snapshot().animation;
      workspace.viewer.inspection.controlMolecularAnimation?.({ state: 'play',
        ...(animation && !animation.loop && animation.timeSeconds >= animation.durationSeconds ? { restart: true } : {}) });
      resumeChapterMotion?.(); resumeContinuousAfterInteraction();
      setStatus('Autoplay is running.');
    }
    record('autoplay', { outcome: autoplay ? 'resumed' : 'paused' }); sync(); schedule();
    return serial;
  };
  const openMenu = (): Promise<void> => {
    if (navigating) return serial;
    stopChapterMotion('menu-opened');
    pause(); selected = undefined; baseline = undefined; baselineSource = undefined; step = -1; chapterStartedAt = undefined; readoutPage = 0; menuOpen = true; scenes.clear(); menu.value = '';
    setStatus('Tour menu open. Use Next tour to choose a lesson; the current workspace scene is kept.'); sync(); menu.focus(); return serial;
  };
  const rejoin = (autoResume = false): Promise<void> => {
    if (navigating) {
      const error = Error('The tour is already rendering a scene.');
      setStatus(error.message); sync();
      return Promise.reject(error);
    }
    if (stopped && stoppedScene && stoppedScene.tour === selected && stoppedScene.step === step
      && stoppedScene.source === source(workspace)) {
      stoppedScene = undefined; stopped = false;
      if (autoResume) return togglePlay();
      setStatus('Lesson scene resumed.'); sync();
      return serial;
    }
    const eligibility = tourRejoinEligibility({ ready: Boolean(workspace.snapshot().ready), selected: Boolean(selected), baseline: baseline != null,
      step, cached: cachedScene(step) !== undefined, sourceSha256: source(workspace), baselineSource });
    if (!eligibility.ok) {
      const error = Error(eligibility.reason);
      setStatus(error.message); sync();
      return Promise.reject(error);
    }
    pause('Rejoining this lesson scene…');
    if (autoResume) autoplay = true;
    return visit(step);
  };
  const restoreStart = (): Promise<void> => {
    if (navigating) {
      const error = Error('The tour is already rendering a scene.');
      setStatus(error.message); sync();
      return Promise.reject(error);
    }
    if (!baseline) {
      const error = Error('Start a lesson before restoring its starting view.');
      setStatus(error.message); sync();
      return Promise.reject(error);
    }
    pause(); stopChapterMotion('starting-view');
    const currentBaseline = baseline, currentSource = baselineSource, token = intents.issue(); navigating = true; sync();
    const admitted = () => Boolean(workspace.snapshot().ready) && source(workspace) === currentSource
      && intents.isCurrent(token) && baseline === currentBaseline;
    const operation = serial.then(async () => {
      applying = true;
      // Done lands the starting view or puts the chapter back whole, so a
      // failed Done never leaves the lesson running without its animation.
      let checkpoint: VisitCheckpoint | undefined;
      const { answered, answer } = lateAnswer();
      try {
        let restored = false;
        // Bounded for the same reason a scene is: this runs on the workspace
        // queue every other lesson operation waits behind.
        await withTourDeadline('starting view', Promise.race([answered, workspace.runTour(noteDrawn(async () => {
          checkpoint = { scene: workspace.capture(), liveStep, baselineIsLive };
          holdPlaybackCursor();
          try {
            await workspace.viewer.inspection.setMolecularAnimation?.(undefined);
            if (!admitted())
              throw Error('Restoring the starting view was interrupted.');
            await withTourDeadline('scene restore', workspace.viewer.inspection.restore(currentBaseline, { preserveCamera: Boolean(workspace.snapshot().xrPresenting) }), operationBound());
            if (!admitted()) throw Error('Restoring the starting view was interrupted.');
            // The starting view is the structure before the lesson coloured it,
            // so the emphasis layers go with it. Without this the molecule kept
            // the last chapter's colour key after the tour was put away.
            if ((currentBaseline as any)?.inspection?.lessonFigure) {
              await withTourDeadline('colour emphasis', workspace.viewer.inspection.clearLessonEmphasis?.(), operationBound());
            } else await applyStepEmphasis(undefined, admitted);
            restored = true;
          } catch (error) { await rollBackVisit(checkpoint, error, currentSource, () => answer(error)); throw error; }
        }))]), tourSceneTimeoutMs(workspace.snapshot().atomCount));
        if (!restored || !admitted())
          throw Error('Restoring the starting view was interrupted.');
        stopped = true; step = -1; chapterStartedAt = undefined; setStatus('Starting view restored.'); workspace.setStatus('Tour starting view restored');
      }
      catch (error) {
        // A chapter that did not come back whole is not running.
        if (baseline === currentBaseline && checkpoint && (error as { rollback?: string } | null)?.rollback !== 'restored') stopped = true;
        setStatus(`Starting view could not be restored: ${(error as Error).message}`); throw error;
      }
      finally { applying = false; navigating = false; sync(); }
    });
    serial = operation.catch(() => undefined);
    return operation;
  };
  let ending: Promise<void> | undefined;
  const finish = (reason: 'completed' | 'done' = 'done'): Promise<void> => {
    if (ending) return ending;
    if (!active() || navigating) return serial;
    const endedStep = step, endedTour = selected, endedBaseline = baseline, endedSource = baselineSource;
    let completionToken: number | undefined;
    const completionAdmitted = () => completionToken !== undefined && intents.isCurrent(completionToken)
      && selected === endedTour && baseline === endedBaseline && baselineSource === endedSource
      && source(workspace) === endedSource && workspace.snapshot().ready;
    // Restore through the same guarded workspace queue as Restore start.
    // Its pause cancels motion, narration eligibility and the pending dwell.
    const restoreResting = async () => {
      await restoreStart();
      completionToken = intents.issue();
      stopped = false; menuOpen = false; readoutPage = 0;
      baselineIsLive = true; liveStep = undefined;
      sync();
      await workspace.viewer.inspection.restoreTourSeat?.();
      if (!completionAdmitted()) throw Error('The tour ending was interrupted.');
    };
    // Snapshot repaint and the final column obstacle belong to one label
    // transaction, just as placement and emphasis do during a chapter.
    const batch = workspace.viewer.inspection.batchComponentLabels;
    // The net contains Restore start's own, which may put the chapter back,
    // and one bound for the seat. A tighter one fired first: it named the
    // ending instead of the part that stalled, while the restore still ran.
    ending = withTourDeadline('tour ending', batch ? batch(restoreResting) : restoreResting(),
      tourSceneTimeoutMs(workspace.snapshot().atomCount) + operationBound()).then(() => {
      // A source/catalog change or pause while the final menu is settling
      // withdraws this ending's status, receipt and spoken completion.
      if (!completionAdmitted()) throw Error('The tour ending was interrupted.');
      const line = 'Tour complete. Explore freely.';
      setStatus('Back to your view'); workspace.setStatus(line);
      record('end', { step: endedStep, reason, outcome: 'restored' });
      sync();
      try { void spokenTurn(aside(line)); }
      catch (error) { record('narration', { outcome: 'error', error: String(error).slice(0, 200) }); }
    }).finally(() => { ending = undefined; });
    return ending;
  };
  const nextReadoutPage = (): Promise<void> => {
    if (navigating) return serial;
    const pages = active() && selected ? wearerPages(selected.steps[step]) : pageText(selected?.summary ?? '');
    if (pages.length > 1) { readoutPage = (readoutPage + 1) % pages.length; chapterStartedAt = readoutClock(); }
    sync(); return serial;
  };
  const reportActionError = (error: unknown) => { setStatus((error as Error)?.message || 'Tour action failed.'); sync(); };
  const explore = (kind: 'structure' | 'sequence') => {
    if (active()) { pause(); stopped = true; setStatus('Explore freely. Rejoin lesson returns to this chapter.'); sync(); }
    root.dataset.exploring = 'true';
    onExplore?.(kind);
  };
  $<HTMLButtonElement>('[data-tour-explore]').addEventListener('click', () => explore('structure'));
  $<HTMLButtonElement>('[data-tour-sequence]').addEventListener('click', () => explore('sequence'));
  menu.addEventListener('change', () => { void select(menu.value); });
  start.addEventListener('click', () => { void begin().catch(reportActionError); });
  rejoinButton.addEventListener('click', () => { void rejoin().catch(reportActionError); });
  back.addEventListener('click', () => { void backAction().catch(reportActionError); });
  next.addEventListener('click', () => { void nextAction().catch(reportActionError); });
  play.addEventListener('click', () => { void togglePlay().catch(reportActionError); });
  pace.addEventListener('change', () => { if (autoplay) schedule(); });
  restart.addEventListener('click', () => { pause(); if (baseline) void visit(0, true).catch(reportActionError); });
  restore.addEventListener('click', () => { void restoreStart().catch(reportActionError); });
  menuButton.addEventListener('click', () => { void openMenu(); });
  document.addEventListener('visibilitychange', () => {
    const transition=tourVisibilityTransition({visible:!document.hidden,autoplay,resumeOnVisible,active:active()});
    if(document.hidden) {
      // A manually held chapter can still have an authored camera move.
      // Suspend that move too, without changing the autoplay preference.
      if (motionActive) { stopChapterMotion('hidden', true); resumeMotionOnVisible = true; }
      if(transition.resumeOnVisible) {
        // Invalidate an in-flight scene before backgrounding. Its completion
        // must not advance the caption while the user cannot see the result.
        intents.invalidate(); clearTimer(); autoplay=false; resumeOnVisible=true;
        setStatus(transition.message); sync();
      } else resumeOnVisible=false;
      return;
    }
    resumeOnVisible=false;
    const resumeMotion = resumeMotionOnVisible; resumeMotionOnVisible = false;
    if(transition.autoplay && active()) {
      autoplay=true; resumeChapterMotion?.(); setStatus(transition.message); sync(); schedule();
    } else {
      if (resumeMotion && active()) { resumeChapterMotion?.(); sync(); }
      // A manual Next can be pending with autoplay off. Its intent remains
      // valid across visibility, but Pause/Stop/source changes still cancel it.
      if (deferredVisit) schedule();
    }
  });
  window.addEventListener('pagehide', () => pause(), { once:true });
  window.addEventListener('pagehide', suspendCaption);
  window.addEventListener('pageshow', observeCaption);
  sync();
  return Object.freeze({
    pause,
    restoreStart,
    finish,
    rejoin,
    retryEmphasis,
    getState: state,
    select,
    cycleTour,
    start: begin,
    replaceTours,
    installLesson,
    confirmLessonInstallation,
    validatePlayback(scene) {
      savedLessonPlayback(scene, catalog);
      if ((scene as any).sourceSha256 !== source(workspace)) throw Error('The saved lesson source is not loaded.');
    },
    restorePlayback(scene, { frame = false, waitForXrEntry = false } = {}) {
      continuationEpoch++;
      pendingMapStart = undefined;
      const saved = savedLessonPlayback(scene, catalog);
      if ((scene as any).sourceSha256 !== source(workspace)) throw Error('The saved lesson source is not loaded.');
      if (!frame || !baseline || baselineSource !== source(workspace)) cameraFrame = saved?.cameraFrame;
      if (waitForXrEntry && saved?.cameraFrame === 'desktop' && !workspace.snapshot().xrPresenting)
        waitingForXrEntry = true;
      const lessonChanged = selected?.id !== saved?.tourId;
      const chapterChanged = lessonChanged || selected?.steps[step]?.id !== saved?.chapterId;
      const localMotionPlaying = frame && !chapterChanged ? motionActive : undefined;
      intents.invalidate(); clearTimer(); stopChapterMotion('restored');
      const localMotionProgress = localMotionPlaying !== undefined ? motionProgress : undefined;
      if (!saved) {
        baseline = undefined; baselineSource = undefined; baselineIsLive = false; liveStep = undefined;
        step = -1; scenes.clear(); stopped = false; autoplay = false; resumeOnVisible = false; navigating = false;
        chapterStartedAt = undefined; chapterPreview = undefined; readoutPage = 0; forgetSpokenLine();
        setStatus('Shared view restored.'); sync();
        return;
      }
      // The peer's baseline supplies lesson content, but future Back/Done
      // restores must still use this panel's own starting view.
      if (frame) {
        const localStart = (baselineSource === source(workspace) ? baseline : workspace.capture()) as any;
        if (localStart?.camera) saved.startingScene.camera = structuredClone(localStart.camera);
        if (localStart?.inspection?.placement)
          saved.startingScene.inspection.placement = structuredClone(localStart.inspection.placement);
      }
      selected = catalog.find(tour => tour.id === saved.tourId)!;
      step = selected.steps.findIndex(chapter => chapter.id === saved.chapterId);
      baseline = saved.startingScene; baselineSource = (scene as any).sourceSha256;
      baselineIsLive = false; liveStep = step; scenes.clear();
      cacheScene(step, structuredClone(scene));
      stopped = saved.stopped; autoplay = false; resumeOnVisible = false; navigating = false;
      narrationEnabled = saved.narration !== false; openedByStart = saved.entry === 'start';
      // A framed peer receipt keeps the headset camera. Its motion fraction
      // must therefore stay local too, even if the peer already finished.
      motionProgress = localMotionProgress ?? saved.motionProgress ?? 1; pendingMotionProgress = undefined;
      const motionPlaying = localMotionPlaying === undefined ? saved.motionPlaying
        : saved.motionPlaying || (localMotionPlaying && saved.motionProgress === 1);
      forgetSpokenLine(); menu.value = selected.id; menuOpen = false; readoutPage = 0;
      chapterStartedAt = readoutClock(); setStatus('Saved lesson scene restored. Use Back, Next, or Play.'); sync();
      // A peer's lesson start or restart opens where the wearer put the
      // molecule here too; only a peer's step into a close-up takes it over.
      const takeover = frame && chapterChanged && !lessonChanged && !openedByStart
        && chapterAuthorsFraming(selected, step, { xr: workspace.snapshot().xrPresenting === true })
        && workspace.viewer.inspection.holdsWearerPlacement?.() === true;
      if (takeover) workspace.viewer.inspection.beginChapterFraming?.();
      // A fresh inspection can hand off while its opening turn is still
      // transient. Restoring an active caption alone must not lose that turn.
      // Legacy cursors have no motion clock and retain their saved view.
      const resumeSavedMotion = () => {
        if (!stopped && motionPlaying === true && motionProgress < 1 && !workspace.viewer.inspection.holdsWearerPlacement?.())
          startChapterMotion(selected!, step, intents.issue(), motionProgress);
      };
      if (frame && chapterChanged && !workspace.viewer.inspection.holdsWearerPlacement?.()) {
        const tour = selected, chapter = step, restoredSource = source(workspace), token = intents.issue();
        const admitted = () => intents.isCurrent(token) && selected === tour && step === chapter
          && source(workspace) === restoredSource && workspace.snapshot().ready === true;
        return frameRestoredStep(tour.steps[chapter], admitted, takeover).then(() => {
          if (admitted()) {
            cacheScene(chapter, workspace.capture());
            resumeSavedMotion();
          }
        });
      }
      if (frame) cacheScene(step, workspace.capture());
      resumeSavedMotion();
    },
    back: backAction,
    next: nextAction,
    togglePlay,
    openMenu,
    // The chooser says so when it shuts. On the Quest 2 on
    // pressing Menu closed it and the plate went straight back to
    // the resting caption with no sentence about it
    // The stamp is the window
    // `spatial-toolbar.mjs` draws that sentence for, on the same clock every
    // other caption window is measured on. A running lesson is left alone: its
    // chapter caption comes back, and that is the answer the wearer needs.
    closeMenu: () => {
      menuOpen = false;
      if (!active()) { setStatus('Tour chooser closed'); chapterStartedAt = readoutClock(); }
      sync();
    },
    nextReadoutPage,
    narratingLine: () => spokenLine,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    drawnScene: () => lastDrawn,
    async frameXrEntry() {
      const pending = pendingMapStart; pendingMapStart = undefined;
      if (!pending || pending.tour !== selected || pending.source !== source(workspace)
        || !workspace.snapshot().xrPresenting) return;
      await begin(pending.autoplay, 0, { narration: pending.narration });
      // Discard the resting/preview card only after the player publishes the
      // active chapter, so clearance draws the chapter's actual caption.
      if (pending.tour === selected && pending.source === source(workspace)
        && workspace.viewer.inspection.holdsWearerPlacement?.() !== true)
        await workspace.viewer.inspection.restoreTourSeat?.({ restart: true });
    },
    notifyMutation(snapshot, options) {
      if (options?.origin === 'xr-entry' && snapshot?.xrPresenting) { waitingForXrEntry = false; cameraFrame = 'xr'; }
      // Installation and chapter paint emit the same receipts as external edits.
      if (applying) return;
      if(snapshot?.sourceSha256 && baselineSource && snapshot.sourceSha256!==baselineSource) continuationEpoch++;
      // The agent is not the wearer.
      //
      // A command the agent renders is a committed inspection change like any
      // other, so it arrived here as a workspace takeover and stopped the
      // lesson dead — which made "make it bigger while the tour runs"
      // impossible by construction. An agent change instead lands on top of
      // the chapter: the turn keeps turning, the colour key stays, and only
      // the cached scene for this step is dropped, because the step no longer
      // looks the way the cache says it does.
      const sameSource = !snapshot?.sourceSha256 || snapshot.sourceSha256 === baselineSource;
      if (options?.interaction) { manipulationPending = true; resumeContinuousAfterInteraction(); }
      else if (options?.interaction === false) manipulationPending = false;
      const handlingGesture = options?.interaction
        || (manipulationPending || snapshot?.interactionActive || workspace.viewer.inspection.holdsWearerPlacement?.());
      // XR entry seating and menu/appearance edits keep the installed chapter.
      // Only an explicit stop/Done or a new source ends a headset lesson.
      if (sameSource && (snapshot?.xrPresenting || options?.agent || options?.origin === 'automatic-clearance' || options?.origin === 'xr-entry' || handlingGesture)) {
        // Desktop and XR have different camera-to-room frames. Keep the
        // original scientific starting view, but bind its return pose to the
        // committed entry seat so Restart/Done cannot restore desktop units.
        if (options?.origin === 'xr-entry' && baseline) {
          const local = workspace.capture() as any;
          const starting = structuredClone(baseline) as any;
          if (local.camera) starting.camera = structuredClone(local.camera);
          if (local.inspection?.placement && starting.inspection)
            starting.inspection.placement = structuredClone(local.inspection.placement);
          baseline = starting;
        }
        // A scientific edit yields the authored camera move while retaining
        // the chapter and its molecular clock. Entry and agent edits keep
        // their own automatic/concurrent motion policy.
        if (snapshot?.xrPresenting && !options?.agent && options?.origin !== 'automatic-clearance' && options?.origin !== 'xr-entry' && !handlingGesture)
          stopChapterMotion('workspace-edit', false, true);
        baselineIsLive = false; liveStep = undefined;
        if (snapshot && !snapshot.interactionActive) {
          manipulationPending = false;
        }
        sync(); return;
      }
      manipulationPending = false;
      stopChapterMotion('workspace-takeover');
      baselineIsLive = false; liveStep = undefined; forgetSpokenLine();
      if (!active() || applying) { if (!applying) sync(); return; }
      if (snapshot?.sourceSha256 && snapshot.sourceSha256 !== baselineSource) {
        intents.invalidate();
        stopped = true; autoplay = false; clearTimer(); setStatus('This tour stopped because the structure changed.');
        dropLessonEmphasis();
        record('interrupted', { outcome: 'stopped', reason: 'source-changed' }); sync(); return;
      }
      // XR entry itself does not emit onMutation; callbacks here are committed
      // load/inspection changes. Treat a headset-side takeover the same as a
      // desktop edit, while rejoin/scene playback preserves the head pose.
      intents.invalidate();
      stopped = true; autoplay = false; clearTimer();
      setStatus('Tour paused because you changed the workspace.');
      dropLessonEmphasis();
      record('interrupted', { outcome: 'stopped', reason: 'workspace-takeover' }); sync();
    },
    stop(reason = 'Tour stopped.', options = {}) {
      if (!options.preserveContinuation) continuationEpoch++;
      pendingMapStart = undefined;
      stoppedScene = options.preserveScene && selected && step >= 0
        ? { tour: selected, step, source: source(workspace) } : undefined;
      stopChapterMotion(reason, Boolean(stoppedScene));
      baselineIsLive = false; liveStep = undefined; forgetSpokenLine();
      intents.invalidate(); stopped = true; autoplay = false; clearTimer(); setStatus(reason);
      if (options.restoreResting !== false) dropLessonEmphasis();
      record('stop', { outcome: 'stopped', reason }); sync();
    },
  });
}
