/**
 * Recover the build identity a shipped bundle carries.
 *
 * `scripts/build.ts` stamps `dist/viewer.html` and `dist/inspector.html` with
 * the sha-256 of themselves, taken with the stamp blanked back to the
 * placeholder in `viewer-build.ts`. The viewer then reports that value in
 * `diagnostics.viewerBuild`, and `scripts/codex-install-check.py` compares the
 * number a mounted Codex panel reports with the number the staged file holds.
 *
 * The same recomputation is what tells a reader which bytes a host is about to
 * run *before* anything mounts, so the launcher readiness line and the setup
 * doctor can print it and a mismatch between two hosts is one line of reading
 * rather than an install audit. It lives here, and not in `viewer-build.ts`,
 * because that module is bundled into the browser and this one needs
 * `node:crypto`.
 */
import { createHash } from 'node:crypto';
import { readInlineHtml } from './inline-html.js';
import { VIEWER_BUILD_PLACEHOLDER } from './viewer-build.js';

/** A bare 64-hex run, not part of a longer identifier. */
const BUILD_ID_PATTERN = /(?<![0-9a-zA-Z])[0-9a-f]{64}(?![0-9a-zA-Z])/gu;

/**
 * The one self-consistent stamp in this HTML, or null.
 *
 * Null is the honest answer for an unstamped bundle — a `tsx` import or a
 * vitest run never goes through `scripts/build.ts` — and for a file whose
 * stamp no longer identifies its own bytes, which is exactly the tampered or
 * half-copied artifact this check exists to catch. A candidate that happens to
 * be 64 hex characters for some other reason fails the recomputation, so the
 * scan cannot mistake a digest in the page content for the stamp.
 */
export function stampedBuildId(html: string): string | null {
  const candidates = [...new Set(html.match(BUILD_ID_PATTERN) ?? [])].filter((candidate) =>
    createHash('sha256').update(html.split(candidate).join(VIEWER_BUILD_PLACEHOLDER), 'utf8').digest('hex') === candidate);
  return candidates.length === 1 ? candidates[0] : null;
}

/** The stamp in a bundle on disk; null when it is missing, unstamped or unreadable. */
export async function readStampedBuildId(path: string): Promise<string | null> {
  const html = await readInlineHtml(path).catch(() => undefined);
  return html == null ? null : stampedBuildId(html);
}

/** `viewer <id> · inspector <id>`, with `unstamped` for a bundle that carries none. */
export function formatBuildIdentities(stamps: { viewer: string | null; inspector: string | null }): string {
  return `viewer ${stamps.viewer ?? 'unstamped'} · inspector ${stamps.inspector ?? 'unstamped'}`;
}
