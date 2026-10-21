/** Existing closure fixtures own no lesson figure; all new renderer hooks stay empty. */
export function emptyLessonFigureBinding() {
  return { hostLoadDepth: 0, roomEntry: undefined, spatialTour: undefined, ...emptyMolecularAnimationBinding(), lessonPlayback: undefined, lessonSelection: undefined, frozenTurn: undefined, lessonFigure: {
    snapshot: () => null, molecular: () => [], annotations: () => [], placement: () => [], count: () => 0,
    drawn: () => true, definition: () => undefined, refresh: async () => {}, install: async () => {}, forget: async () => {},
  } };
}

/** Closure fixtures without an animated chapter retain the production API boundary. */
export function emptyMolecularAnimationBinding() {
  return {molecularAnimation:{capture:()=>undefined, checkpoint:()=>undefined, snapshot:()=>null,
    restore:async()=>false, suspend(){}, replaces:()=>false, owns:()=>false, drawn:()=>true,
    envelope:()=>undefined, extraCount:()=>0, representations:()=>[], refresh:async()=>{}, forget:async()=>{},
    install:async()=>{}, apply(){}, reanchor(){}, tick(){},
    halt(){}, resume(){}, settled:async()=>{}, faulted:()=>false, supersededBy:()=>false}};
}
