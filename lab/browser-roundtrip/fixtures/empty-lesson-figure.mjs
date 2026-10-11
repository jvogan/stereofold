/** Existing closure fixtures own no lesson figure; all new renderer hooks stay empty. */
export function emptyLessonFigureBinding() {
  return { lessonPlayback: undefined, lessonFigure: {
    snapshot: () => null, molecular: () => [], annotations: () => [], placement: () => [], count: () => 0,
    drawn: () => true, definition: () => undefined, refresh: async () => {}, install: async () => {}, forget: async () => {},
  } };
}
