// The lab and Mac pins exercise identical rows. Opening the lesson chooser
// clears the active chapter in the player, so these are separate states.
export const MID_CHAPTER_TOUR = {
  selectedId: 'g', active: true, autoplay: false, canBack: true, canNext: true,
  bodyPageCount: 3, bodyPageIndex: 0,
};
export const FINAL_CHAPTER_TOUR = { ...MID_CHAPTER_TOUR, canNext: false };
export const COMPACT_TOUR_CASES = [
  { tour: undefined, labels: ['Talk', 'Tour', 'Reset', 'Room', 'Mol*', 'Menu'] },
  { tour: { menuOpen: true }, labels: ['Talk', 'Tour', 'Reset', 'Next one', 'Room', 'Mol*', 'Menu'] },
  { tour: { selectedId: 'g', bodyPageCount: 3, bodyPageIndex: 0 },
    labels: ['Talk', 'Tour', 'Reset', 'Pg 1/3', 'Room', 'Mol*', 'Menu'] },
  { tour: { ...MID_CHAPTER_TOUR, canBack: false },
    labels: ['Talk', 'Play', 'Reset', 'Next', 'Pg 1/3', 'Room', 'Mol*', 'Menu'] },
  { tour: MID_CHAPTER_TOUR,
    labels: ['Talk', 'Play', 'Reset', 'Back', 'Next', 'Pg 1/3', 'Room', 'Menu'] },
  { tour: FINAL_CHAPTER_TOUR,
    labels: ['Talk', 'Play', 'Reset', 'Back', 'Done', 'Pg 1/3', 'Room', 'Menu'] },
  { tour: { ...FINAL_CHAPTER_TOUR, canBack: false },
    labels: ['Talk', 'Play', 'Reset', 'Done', 'Pg 1/3', 'Room', 'Mol*', 'Menu'] },
];

export function* compactTourVariants() {
  for (const { tour } of COMPACT_TOUR_CASES)
    for (const voice of [undefined, { state: 'idle' }, { state: 'listening' }, { state: 'sending' }])
      for (const quiet of [false, true])
        for (const autoplay of [false, true])
          for (const navigating of [false, true])
            for (const captionCard of ['shown', 'hidden'])
              yield { collapsed: true, voice, quiet,
                tour: tour ? { ...tour, autoplay, navigating, captionCard } : undefined };
}
