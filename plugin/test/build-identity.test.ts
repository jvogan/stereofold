import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { formatBuildIdentities, stampedBuildId } from '../src/build-identity.js';
import { VIEWER_BUILD_PLACEHOLDER } from '../src/viewer-build.js';

/** What `scripts/build.ts` does: hash the file with the placeholder in place. */
function stamp(html: string): string {
  const digest = createHash('sha256').update(html, 'utf8').digest('hex');
  return html.replace(VIEWER_BUILD_PLACEHOLDER, digest);
}

describe('build identity', () => {
  it('recovers the stamp a built bundle carries', () => {
    const shipped = stamp(`<!doctype html><script>const build='${VIEWER_BUILD_PLACEHOLDER}';</script>`);
    const identity = stampedBuildId(shipped);
    expect(identity).toMatch(/^[0-9a-f]{64}$/u);
    expect(shipped).toContain(identity!);
  });

  it('answers null for a bundle that never went through the build', () => {
    expect(stampedBuildId(`<!doctype html><script>const build='${VIEWER_BUILD_PLACEHOLDER}';</script>`)).toBeNull();
    expect(stampedBuildId('<!doctype html><p>nothing stamped</p>')).toBeNull();
  });

  it('answers null once the bytes no longer match their own stamp', () => {
    // The case this exists for: a half-finished copy, or an edited bundle
    // still claiming the identity of the file it was made from.
    const tampered = `${stamp(`<!doctype html><script>const build='${VIEWER_BUILD_PLACEHOLDER}';</script>`)}<!-- one byte later -->`;
    expect(stampedBuildId(tampered)).toBeNull();
  });

  it('ignores a sha-256 that happens to appear in the content', () => {
    const decoy = createHash('sha256').update('some other file', 'utf8').digest('hex');
    const shipped = stamp(`<!doctype html><p>${decoy}</p><script>const build='${VIEWER_BUILD_PLACEHOLDER}';</script>`);
    expect(stampedBuildId(shipped)).not.toBe(decoy);
    expect(stampedBuildId(shipped)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('names an unstamped half rather than printing nothing', () => {
    expect(formatBuildIdentities({ viewer: 'a'.repeat(64), inspector: null }))
      .toBe(`viewer ${'a'.repeat(64)} · inspector unstamped`);
  });
});
