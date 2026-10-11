/**
 * The receipt that says the menu column was seated where it is now.
 *
 * The Move row re-seats the column on the pose the wearer has at that moment.
 * When the wearer has not moved, the column comes to rest exactly where it
 * was, so nothing in the drawn state changes and nothing in a capture does
 * either. The only honest proof that the row did its work is a record written
 * by the redraw that committed the seat.
 *
 * Until this module there was no such record. The re-seat was visible only
 * through `component-label-layout`, which `viewer.mjs` writes from
 * `onMenuPlaced` — and `onMenuPlaced` does nothing at all unless component
 * name plates are wanted or already drawn. A plain scene has no name plates,
 * so on the Quest 2 both `aim:move` and `menu:move` took the
 * input, re-seated the column, and left no trace the driver could read; both
 * reported "the outcome never arrived" after 12.4 s
 *
 * The receipt is written by the toolbar's own commit, beside the panel it
 * just drew, so it does not depend on labels, on the plate solver, or on the
 * wearer having moved between the press and the draw.
 */

/** The motion reasons that mean the column took a seat rather than followed one. */
const SEATING_MOTIONS = Object.freeze(['seat', 'reseat']);

/**
 * The receipt for one committed redraw, or `undefined` when it seated nothing.
 *
 * @param {object} commit
 * @param {string[]} [commit.motion] the redraw's own motion reasons, in order
 * @param {string} [commit.reason] why the seat was unlatched (`menu`, `reset`, `sequence`, `entry`)
 * @param {string|null} [commit.seat] the committed seat signature, to the millimetre
 * @param {boolean} [commit.hidden] whether the panel is hidden behind a grab
 * @returns {{phase:'seat-commit',reason:string|null,motion:string,reseated:boolean,seat:string|null,hidden:boolean}|undefined}
 */
export function menuSeatReceipt({ motion = [], reason, seat, hidden = false } = {}) {
  const reasons = (Array.isArray(motion) ? motion : [motion])
    .filter(name => typeof name === 'string' && name);
  if (!reasons.some(name => SEATING_MOTIONS.includes(name))) return undefined;
  return {
    phase: 'seat-commit',
    reason: typeof reason === 'string' && reason ? reason : null,
    motion: reasons.join(','),
    // `reseat` is the wearer asking for the column; `seat` alone is the first
    // draw or a lesson putting it back. Both are a seat the driver can verify,
    // and the flag says which one it was without reading the motion string.
    reseated: reasons.includes('reseat'),
    seat: typeof seat === 'string' && seat ? seat : null,
    hidden: hidden === true,
  };
}
