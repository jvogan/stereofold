import assert from 'node:assert/strict';
import { plateLineEm, plateMarginEm } from '../label-layout.mjs';

/**
 * Solver options rebuilt from one `component-label-layout` ring record alone.
 *
 * The page records what its solver arranged (viewer.mjs `componentLabelLayout`):
 * every anchor's tangent x/y at its depth in that pass's
 * basis, its part radius, plate half extents, line count and focus, the menu
 * obstacle, the subject rectangle, the field and the scalar inputs. An
 * on-axis basis (eye at the origin, looking down -z) projects an anchor at
 * [x·z, y·z, -z] to exactly (x, y) at depth z, so the real solver run on
 * these options reproduces the recorded pass within the record's rounding
 * (six decimals on inputs; the recorded output rects are rounded to three).
 * Text widths are inverted from the recorded half extents through the same
 * plate geometry the solver uses, one identical line per recorded line.
 *
 * Pass `outlines`, the `component-label-outline` record of the same pass, to
 * replay a layout that placed plates by their parts' outlines.
 *
 * A record without `anchors` predates this field (`acceptance-5-overprint.json`, for example):
 * it cannot be replayed on real inputs, only checked at its outputs.
 */
export function replayOptionsFromLayoutRecord(record, { measureText, outlines } = {}) {
  assert.ok(Array.isArray(record?.anchors) && record?.inputs, 'a replayable layout record carries anchors and inputs');
  const { inputs } = record;
  const lineEm = plateLineEm(), margin = plateMarginEm();
  const widths = new Map(record.anchors.map(a => [a.id,
    a.w === null || a.h === null ? 1 : a.w / a.h * ((a.lines - 1) + lineEm) - 2 * margin]));
  return {
    plates: record.anchors.map(a => ({ id: a.id, text: Array.from({ length: a.lines }, () => a.id),
      anchor: a.z === null ? [0, 0, 1] : [a.x * a.z, a.y * a.z, -a.z], radius: a.r, focused: a.focused === true,
      // The `component-label-outline` record beside it: each part's padded
      // outline as tangent x, y pairs under `part:<id>`, placed at the anchor's
      // depth with no further pad.
      ...(a.z !== null && outlines?.[`part:${a.id}`]?.length ? { points: Array.from({ length: outlines[`part:${a.id}`].length / 2 },
        (_, i) => [outlines[`part:${a.id}`][2 * i] * a.z, outlines[`part:${a.id}`][2 * i + 1] * a.z, -a.z]) } : {}) })),
    eye: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0],
    characterUnits: inputs.characterUnits, minSizeScale: inputs.minSizeScale,
    contextAlpha: inputs.contextAlpha, standoff: inputs.standoff,
    clearance: inputs.clearance ?? 0,
    field: inputs.fieldHalfWidth === null ? null
      : { halfWidth: inputs.fieldHalfWidth, halfHeight: inputs.fieldHalfHeight },
    obstacles: (record.obstacles ?? []).map(o => ({ x: o.x, y: o.y, halfWidth: o.hw, halfHeight: o.hh })),
    subject: inputs.subjectX === null ? null : { x: inputs.subjectX, y: inputs.subjectY,
      halfWidth: inputs.subjectHalfWidth, halfHeight: inputs.subjectHalfHeight },
    measureText: measureText ?? (text => widths.get(text)),
  };
}
