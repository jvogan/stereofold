/**
 * The one sentence a compound change or an undo is answered with.
 *
 * A wearer who says "make this RNA orange, fade the rest and enlarge it" has
 * made one request. Sent as three commands it came back as three spoken lines
 * talking over each other, about a picture that stepped through two states
 * nobody asked for. One request now gets one line, and every line here stays
 * under twelve words so it is finished before the next thing happens.
 *
 * This file has no imports on purpose. Both ends say these words — the host
 * puts them in the tool result and the headset page speaks them — and a shared
 * file is the only way the two cannot drift apart.
 */

/** The resolved edits a compound change carries, as the receipt sees them. */
export type SpokenOperation = { kind: string; patch?: Record<string, any> };

export const UNDO_CONFIRMATION = 'Undone.';
export const NOTHING_TO_UNDO = 'Nothing to undo.';
/** Eleven words leaves room for the full stop and keeps the line under twelve. */
export const SPOKEN_WORD_LIMIT = 11;

const COUNT_WORDS: Record<number, string> = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six' };

/** What the wearer would call the field this op moved. */
function operationName(op: SpokenOperation): string {
  const patch = op.patch ?? {};
  if (op.kind === 'emphasis') {
    const focus: string[] = Array.isArray(patch.focus) ? patch.focus : [];
    if (!focus.length) return 'whole structure';
    const parts: { id?: string; label?: string }[] = Array.isArray(patch.parts) ? patch.parts : [];
    return parts.find(part => part.id === focus[0])?.label ?? 'highlight';
  }
  if (op.kind === 'styles') return 'selection style';
  if (op.kind === 'appearance') {
    if ('uniformColor' in patch || 'color' in patch) return 'colour';
    if ('opacity' in patch) return 'fade';
    if ('representation' in patch) return 'shape';
    if ('labels' in patch) return 'labels';
    return 'look';
  }
  if (op.kind === 'placement') {
    if ('scale' in patch) return 'size';
    if ('translation' in patch) return 'place';
    if ('rotation' in patch) return 'angle';
    return 'placement';
  }
  if (op.kind === 'selection') return 'selection';
  // The wearer's word for it is what is showing, not the
  // field's name. Which particular chain went is the receipt's line to say.
  if (op.kind === 'visibility') return 'what is showing';
  return op.kind;
}

const capitalize = (value: string) => value ? value[0].toUpperCase() + value.slice(1) : value;
const words = (line: string) => line.trim().split(/\s+/).filter(Boolean).length;

/**
 * One line for a whole compound change.
 *
 * A lesson part carries the name the wearer has been hearing all lesson, so it
 * is used as written. A long one can push the sentence past the limit, and
 * then the count is said instead: a line the wearer hears the end of beats a
 * complete one they do not.
 */
export function compoundConfirmation(ops: readonly SpokenOperation[]): string {
  const names = ops.map(operationName);
  if (!names.length) return 'Done.';
  const listed = names.length === 1 ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const line = `Done. ${capitalize(listed)} changed.`;
  if (words(line) <= SPOKEN_WORD_LIMIT) return line;
  return `Done. ${COUNT_WORDS[names.length] ?? names.length} changes at once.`;
}

/** Shared caption and speech, emitted only after a rendered receipt. */
export function scopedStyleConfirmation(patch: Record<string, any>): string {
  const count = patch.selectionKeys?.length;
  if (count === undefined) return 'Selection styles restored.';
  // Several region styles folded into one edit carry their keys and no single style.
  if (!patch.style) return `Styles changed on ${count} residue${count === 1 ? '' : 's'}.`;
  const style = patch.style;
  const names: Record<string, string> = { 'ball-and-stick':'Sticks', cartoon:'Cartoon', spacefill:'Atoms', 'molecular-surface':'Surface' };
  const look = style.clear ? 'Style cleared' : names[style.representation] ?? ('color' in style || 'uniformColor' in style ? 'Colour changed' : 'Opacity changed');
  return `${look} on ${count} residue${count === 1 ? '' : 's'}.`;
}
