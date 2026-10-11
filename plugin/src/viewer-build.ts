/**
 * Which bytes are mounted.
 *
 * Two fixes were shipped against screenshots of a real Codex
 * side panel, and neither changed what was on screen. One thing nobody could
 * rule out is that the panel was running an older bundle: Codex stages a copy
 * of `dist/`, and a restage that silently did not happen looks exactly like a
 * fix that did not work. So the viewer carries its own identity and reports it
 * in `diagnostics.viewerBuild`.
 *
 * The value below is a placeholder that `scripts/build.ts` overwrites in the
 * emitted `dist/viewer.html`. It is exactly 64 characters, the length of a
 * sha-256 hex digest, so the substitution is byte-for-byte length preserving
 * and the digest can be *recomputed* from the shipped file: put the
 * placeholder back where the digest is and hash the result. `scripts/smoke.ts`
 * does exactly that, so a stamp that does not identify the file it is in fails
 * a gate rather than lying in a diagnostic.
 *
 * A build that has not been through `scripts/build.ts` — the vitest suite, a
 * `tsx` import — reports the placeholder unchanged, which is the honest
 * answer: those bytes were never stamped.
 */
export const VIEWER_BUILD_PLACEHOLDER = 'stereofold-viewer-build-unstamped-000000000000000000000000000000';

/** Length the placeholder and its replacement must both have. */
export const VIEWER_BUILD_ID_LENGTH = 64;
