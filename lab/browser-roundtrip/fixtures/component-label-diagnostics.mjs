import { readFileSync } from 'node:fs';

// Execute the real viewer producer expression with every optional field,
// including the scene and menu reasons. Both suites use this same entry.
export function layoutDiagnosticEntry() {
  const source = readFileSync(new URL('../viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("recordCost('component-label-layout', { predicted: true, basis: view.basis,");
  const end = source.indexOf('\n      const placements = new Map', start);
  if (start < 0 || end < 0) throw Error('The layout diagnostic producer was not found.');
  const solved = {
    placements: Array.from({ length: 10 }, (_, i) => ({ id: `part-${i}`,
      rect: { x: i / 10, y: 0.1, halfWidth: 0.02, halfHeight: 0.03 } })),
    unresolved: 0, degraded: false, overlapArea: 0, overlaps: 0, focusOverlaps: 0, fanned: 10, shrunk: 2, dimmed: 1,
    detached: 10, yielded: 1, led: 10, offGlass: 0, menuOverlaps: 0, subjectOverlaps: 0,
    sides: { left: 5, right: 5 }, leaderEm: 2.345,
    subject: { x: 0, y: 0.1, halfWidth: 0.2, halfHeight: 0.3 },
    // The solver's inputs and its exact search summary.
    inputs: { characterUnits: 0.08, minSizeScale: 1, contextAlpha: 0.35, standoff: 0.5,
      field: { halfWidth: 0.6, halfHeight: 0.58 },
      obstacles: [{ x: -0.55, y: -0.2, halfWidth: 0.17, halfHeight: 0.35 }],
      subject: { x: 0, y: 0.1, halfWidth: 0.2, halfHeight: 0.3 },
      anchors: Array.from({ length: 10 }, (_, i) => ({ id: `part-${i}`, x: i / 10 - 0.5, y: -0.0000004,
        depth: 400 + i, radius: 5, halfWidth: 0.02, halfHeight: 0.03, lines: 1, focused: i === 0 })) },
    search: { nodes: 12, slots: 2048, complete: true, resolution: 0.03 },
  };
  let entry;
  const clean = value => (value === 0 ? 0 : value);
  new Function('recordCost', 'solved', 'toolbarRect', 'subject', 'reason', 'menuReason', 'round', 'exact', 'view', source.slice(start, end))(
    (kind, detail) => { entry = { seq: 1, at: 1000, kind, detail }; }, solved,
    {}, {}, 'scene', 'expand,reseat', value => clean(Math.round(value * 1000) / 1000),
    value => (Number.isFinite(value) ? clean(Math.round(value * 1e6) / 1e6) : null),
    { eye: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], basis: 'head',
      plateSeat: { viewDegrees: 30, band: { x: 0.5, y: 0.6 } } });
  return entry;
}

export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function syntheticViews() {
  const near = 0.01, far = 100;
  return ['left', 'right'].map((eye, i) => {
    const matrix = identity(), inverse = identity();
    matrix[12] = i === 0 ? -0.032 : 0.032; inverse[12] = -matrix[12];
    return { eye, transform: { matrix, inverse: { matrix: inverse } }, projectionMatrix: [
      1 / Math.tan(42 * Math.PI / 180), 0, 0, 0,
      0, 1 / Math.tan(45 * Math.PI / 180), 0, 0,
      0, 0, -(far + near) / (far - near), -1,
      0, 0, -2 * far * near / (far - near), 0,
    ] };
  });
}
export function plate(id, x, y, depth, hw, hh) {
  return { id, quads: [{ corners: [[x - hw, y - hh, -depth], [x + hw, y - hh, -depth],
    [x + hw, y + hh, -depth], [x - hw, y + hh, -depth]] }] };
}
