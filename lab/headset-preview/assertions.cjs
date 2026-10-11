'use strict';
const assert = require('node:assert/strict');

const framing = frame => {
    const { scale, bounds } = frame.camera, center = bounds.center.map(value => value * scale), radius = bounds.radius * scale;
    assert.ok(Number.isFinite(radius) && radius > 0 && center.every(Number.isFinite));
    return frame.sceneViews.map(view => {
      const m = view.projectionView; assert.ok(m.length === 16 && m.every(Number.isFinite));
      // Float32 projection coefficients put a sphere tangent to the far plane
      // about 2 micrometres beyond it in the pinned fixture. Retain raw values.
      const toleranceMetres = 1e-5, clearances = [];
      for (const [axis, sign, plane] of [[0, 1, 'left'], [0, -1, 'right'], [1, 1, 'bottom'], [1, -1, 'top'], [2, 1, 'near'], [2, -1, 'far']]) {
        const p = [0, 1, 2, 3].map(column => m[column * 4 + 3] + sign * m[column * 4 + axis]);
        const length = Math.hypot(p[0], p[1], p[2]); assert.ok(Number.isFinite(length) && length > 0);
        clearances.push({ plane, metres: (p[0] * center[0] + p[1] * center[1] + p[2] * center[2] + p[3]) / length - radius });
      }
      return { eye: view.eye, centerMetres: center, radiusMetres: radius, clearances, toleranceMetres, fullyInside: clearances.every(value => value.metres >= -toleranceMetres) };
    });
  };

const eyes = active => {
    assert.ok(active.frames >= 4 && active.molstarDraws > 0 && active.glDraws > 0, 'No observed Mol* XR draw');
    const views = active.lastFrame.views; assert.deepEqual(views.map(view => view.eye).sort(), ['left', 'right']);
    const [width, height] = active.lastFrame.framebuffer; assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
    for (const view of views) { const [x, y, w, h] = view.viewport;
      assert.ok(view.viewport.every(Number.isInteger) && x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= width && y + h <= height);
      assert.ok(active.viewportDraws[view.viewport.join(',')] > 0, `No ${view.eye} viewport draw`);
      for (const values of [view.projection, view.view, view.projectionView]) assert.ok(values.length === 16 && values.every(Number.isFinite)); }
    const [a, b] = views.map(view => view.viewport);
    assert.ok(a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1], 'Eye viewports overlap');
    assert.notDeepEqual(views[0].view, views[1].view); assert.notDeepEqual(views[0].projectionView, views[1].projectionView);
  };

module.exports = { framing, eyes };
