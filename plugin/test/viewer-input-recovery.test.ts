import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { MotionController, MouseParallaxSource } from '../src/motion-controller.js';

// Execute the production listener registration, without starting Mol* or a
// browser. The real motion controller makes a lost release visibly freeze spin.
function harness() {
  const source = readFileSync(new URL('../src/viewer.ts', import.meta.url), 'utf8');
  const start = source.indexOf("stage.addEventListener('pointermove'");
  const end = source.indexOf('async function boot():', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const wiring = transformSync(source.slice(start, end), { loader: 'ts', target: 'es2022' }).code;
  const stage = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  });
  const document = Object.assign(new EventTarget(), { hidden: false });
  const window = new EventTarget();
  let now = 0;
  let position: readonly [number, number, number] = [0, 0, 10];
  const mouseParallax = new MouseParallaxSource();
  const motion = new MotionController({
    readCamera: () => ({ position, target: [0, 0, 0], up: [0, 1, 0], fovRad: 1, near: .1, aspect: 1 }),
    setPosition: next => { position = [...next]; },
    setViewOffset: () => {},
  }, mouseParallax);
  motion.captureBaseline();
  motion.setSettings({ mode: 'spin', periodS: 10 }, 0);
  const release = vi.spyOn(motion, 'release');
  const dragging = new Function('stage', 'document', 'window', 'motionController', 'mouseParallax', 'performance',
    `let dragging = false; ${wiring}; return () => dragging;`)(stage, document, window, motion, mouseParallax, { now: () => now }) as () => boolean;
  return {
    stage, document, window, motion, mouseParallax, release, dragging,
    position: () => [...position],
    tick(time: number) { now = time; return motion.tick(time); },
    hidden(value: boolean) { document.hidden = value; document.dispatchEvent(new Event('visibilitychange')); },
  };
}

describe('embedded viewer input recovery', () => {
  for (const event of ['pointerup', 'pointercancel', 'blur']) {
    it(`releases a held spin on window ${event} without changing its settings or camera`, () => {
      const h = harness();
      h.tick(100);
      h.stage.dispatchEvent(new Event('pointerdown'));
      const settings = h.motion.getSettings(), pose = h.position();
      h.window.dispatchEvent(new Event(event));
      expect(h.dragging()).toBe(false);
      expect(h.release).toHaveBeenCalledOnce();
      expect(h.motion.getSettings()).toEqual(settings);
      expect(h.position()).toEqual(pose);
      h.tick(1000);
      const before = h.position();
      h.tick(2000);
      expect(h.position()).not.toEqual(before);
    });
  }

  it('ends a drag when hidden, stays paused while hidden, and resumes on return', () => {
    const h = harness();
    h.tick(100);
    h.stage.dispatchEvent(new Event('pointerdown'));
    h.hidden(true);
    expect(h.dragging()).toBe(false);
    const pose = h.position();
    expect(h.tick(1000)).toBe(false);
    expect(h.position()).toEqual(pose);
    h.hidden(false);
    h.tick(1100);
    const before = h.position();
    h.tick(2100);
    expect(h.position()).not.toEqual(before);
  });

  it('releases once when a stage event bubbles and subsequent interruptions arrive', () => {
    const h = harness();
    h.stage.dispatchEvent(new Event('pointerdown'));
    h.stage.dispatchEvent(new Event('pointerup'));
    h.window.dispatchEvent(new Event('pointerup'));
    h.window.dispatchEvent(new Event('pointercancel'));
    h.window.dispatchEvent(new Event('blur'));
    h.hidden(true);
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.dragging()).toBe(false);
  });

  it('does not recapture the camera for unrelated releases and clears stale parallax on hide or blur', () => {
    const h = harness();
    for (const event of ['pointerup', 'pointercancel', 'blur']) h.window.dispatchEvent(new Event(event));
    expect(h.release).not.toHaveBeenCalled();
    const move = () => h.stage.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 80, clientY: 20 }));
    move();
    expect(h.mouseParallax.read()).toBeDefined();
    h.hidden(true);
    expect(h.mouseParallax.read()).toBeUndefined();
    h.hidden(false);
    move();
    expect(h.mouseParallax.read()).toBeDefined();
    h.window.dispatchEvent(new Event('blur'));
    expect(h.mouseParallax.read()).toBeUndefined();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('keeps ordinary stage cancellation working', () => {
    const h = harness();
    h.stage.dispatchEvent(new Event('pointerdown'));
    h.stage.dispatchEvent(new Event('pointercancel'));
    expect(h.dragging()).toBe(false);
    expect(h.release).toHaveBeenCalledOnce();
  });
});
