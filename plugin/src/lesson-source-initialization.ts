import type { Tour } from './tour-player.js';

/** Source-load intent only: never synthesize a partial saved molecular scene. */
export function lessonSourceInitialization(tour: Tour | undefined, options: {
  density?: boolean; chapterId?: string;
} = {}) {
  // The load adapter gives a compatible saved scene priority over this intent.
  // A density reference panel must never inherit the map's isosurface look.
  if (!tour || options.density) return undefined;
  const chapter = tour.steps.find(step => step.id === options.chapterId) ?? tour.steps[0];
  if (!chapter) return undefined;
  const authored = Object.assign({}, chapter.appearance, ...(chapter.appearances ?? []));
  const { componentLabels: _labels, ...appearance } = authored;
  if (!Object.keys(appearance).length && !chapter.visibility && !tour.presentation?.coordinateFrame) return undefined;
  return {
    ...(tour.presentation?.coordinateFrame ? { coordinateFrame: tour.presentation.coordinateFrame } : {}),
    ...(Object.keys(appearance).length ? { appearance } : {}),
    ...(chapter.visibility ? { visibilityPatch: structuredClone(chapter.visibility) } : {}),
    // A hidden-base composite presents interchangeable figures in one source
    // frame. Fit its first visible subject once; subsequent swaps keep that
    // view, including when the wearer has not moved it themselves yet.
    ...(appearance.opacity === 0 && chapter.figure && !chapter.figure.focus && chapter.visibility?.op === 'only'
      && !chapter.animation && !chapter.placement && !chapter.view && !chapter.emphasis?.framing
      ? { frameVisibleFigureOnce: true } : {}),
  };
}

/**
 * Whether a source loaded for this lesson draws nothing until a chapter runs.
 *
 * The source loads already wearing its opening chapter's look. When that look
 * hides the base structure, the chapter's figure is the only thing on screen,
 * so every route that loads the source must also open that chapter, including
 * a tier grown after the wearer put the lesson away.
 */
export function lessonSourceLoadsHidden(tour: Tour | undefined, options: { density?: boolean; chapterId?: string } = {}) {
  return lessonSourceInitialization(tour, options)?.appearance?.opacity === 0;
}
