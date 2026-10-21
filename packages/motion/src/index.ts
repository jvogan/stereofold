/**
 * @stereo/motion — motion package for the stereoscopic Mol* viewer.
 *
 * Pure TypeScript, no DOM types: rock/spin oscillator, off-axis (head or
 * pointer) parallax frustum math, and a 1€ filter for head tracking.
 * DOM-facing adapters (pointer events, webcam capture) live in the plugin
 * layer, not here.
 */
export * from './rock.js';
export * from './parallax.js';
export * from './oneEuro.js';
export * from './keyframes.mjs';
