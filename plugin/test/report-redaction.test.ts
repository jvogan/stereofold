import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCRUBBED, findLeakedSecrets, redactLinkSecrets, redactTokens, requestRoute, scrubSecrets } from '../scripts/report-redaction.js';

const pluginDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The two live capabilities the Claude Science harness meets, in their real shapes. */
const PAIRING_CODE = '48213975';
const PAGE_KEY = 'a'.repeat(64);

describe('redactLinkSecrets', () => {
  it('keeps the address and drops the pairing code the companion link carries', () => {
    expect(redactLinkSecrets(`https://192.168.77.24:8443/#pair=${PAIRING_CODE}`))
      .toBe('https://192.168.77.24:8443/#pair=<8 digits>');
  });

  it('keeps the loopback address and drops the detailed-view page key', () => {
    expect(redactLinkSecrets(`http://127.0.0.1:52341/detailed#${PAGE_KEY}`))
      .toBe('http://127.0.0.1:52341/detailed#<page key>');
  });

  /**
   * The point of the generic label. A fragment nobody has written a rule for
   * is the most likely place for the next secret, so it loses its value too
   * rather than being passed through as "probably harmless".
   */
  it('drops a fragment it does not recognise instead of passing it through', () => {
    expect(redactLinkSecrets('https://example.invalid/page#device=Zm9vYmFy&mode=vr'))
      .toBe('https://example.invalid/page#<fragment>');
  });

  it('leaves an address with no fragment alone and reports a non-string as absent', () => {
    expect(redactLinkSecrets('https://192.168.77.24:8443/')).toBe('https://192.168.77.24:8443/');
    expect(redactLinkSecrets('https://192.168.77.24:8443/#')).toBe('https://192.168.77.24:8443/#');
    expect(redactLinkSecrets(null)).toBe(null);
    expect(redactLinkSecrets(undefined)).toBe(null);
  });
});

describe('scrubSecrets', () => {
  /**
   * The failure this exists for. A scenario can record the shape of its own
   * evidence and a live code still reaches the artifact through a sentence,
   * a console line or a stack trace that nobody thought to redact.
   */
  it('removes a live code that reached the report through prose, a nested object and an array', () => {
    const report = {
      scenarios: [{ id: 'S3', evidence: { pairingCodeShape: '<8 digits>' } }],
      consoleErrors: [{ text: `pairing failed for ${PAIRING_CODE}` }],
      failure: `Error: bad key ${PAGE_KEY}\n    at open`,
      timings: { mountWallMs: 1240 },
    };
    const scrubbed = scrubSecrets(report, [PAIRING_CODE, PAGE_KEY]);
    expect(findLeakedSecrets(scrubbed, [PAIRING_CODE, PAGE_KEY])).toEqual([]);
    expect(scrubbed.consoleErrors[0].text).toBe(`pairing failed for ${SCRUBBED}`);
    expect(scrubbed.failure).toBe(`Error: bad key ${SCRUBBED}\n    at open`);
    expect(scrubbed.timings.mountWallMs).toBe(1240);
    expect(report.consoleErrors[0].text).toBe(`pairing failed for ${PAIRING_CODE}`);
  });

  it('ignores a value too short to be a capability, so evidence is not over-redacted', () => {
    const report = { timings: { mountWallMs: 1240 }, note: 'saved 1240 ms in' };
    expect(scrubSecrets(report, ['1240'])).toEqual(report);
  });

  it('reports the path of every survivor so a harness can fail loudly', () => {
    const report = { scenarios: [{ evidence: { href: `https://h/#pair=${PAIRING_CODE}` } }] };
    expect(findLeakedSecrets(report, [PAIRING_CODE])).toEqual(['scenarios[0].evidence.href']);
  });
});

/**
 * The artifact guard. `claude-science-browser.ts` writes `browser-report.json`
 * into a directory that gets read by other people and kept, and it used to
 * write the companion link's href verbatim, pairing code and all. These
 * assertions are on the harness source because the harness itself needs a
 * browser, an emulated host and a live listener to run: they hold the shape of
 * the fix, so a later edit that reintroduces a raw capability fails here.
 */
describe('the Claude Science harness report artifact', () => {
  it('records the shape of every live capability and scrubs the report before writing it', async () => {
    const source = await readFile(resolve(pluginDirectory, 'scripts/claude-science-browser.ts'), 'utf8');

    // No raw href, pairing code or page key is assigned into scenario evidence.
    expect(source).not.toMatch(/\bs\d+\.companionLinkHref\s*=/);
    expect(source).not.toMatch(/\bs\d+\.pairingCode\s*=/);
    expect(source).toMatch(/s3\.companionLinkShape\s*=\s*redactLinkSecrets\(/);
    expect(source).toMatch(/s3\.pairingCodeShape\s*=/);

    // Both addresses that carry a fragment go through the one redactor.
    expect(source).toMatch(/s6\.targetShape\s*=\s*redactLinkSecrets\(/);
    expect(source).toMatch(/s7\.targetShape\s*=\s*redactLinkSecrets\(/);

    // Every capability the run mints is tracked, so the scrub can find it
    // wherever else it landed: the pairing code, the companion page key and
    // the detailed-view page key.
    expect(source.match(/liveSecrets\.push\(/g) ?? []).toHaveLength(4);

    // The written value is the scrubbed one, and it is checked before the write.
    expect(source).toMatch(/const artifact = scrubSecrets\(report, liveSecrets\)/);
    expect(source).toMatch(/const leaked = findLeakedSecrets\(artifact, liveSecrets\)/);
    expect(source).toMatch(/writeFile\(resolve\(out, 'browser-report\.json'\), JSON\.stringify\(artifact/);
    expect(source).not.toMatch(/writeFile\(resolve\(out, 'browser-report\.json'\), JSON\.stringify\(report/);
  });
});

describe('redactTokens and requestRoute', () => {
  it('drops a token-shaped run from recorded text and leaves ordinary prose alone', () => {
    const bearer = 'Zm9vYmFy'.repeat(4);
    expect(redactTokens(`Stereofold companion request failed with ${bearer}`))
      .toBe(`Stereofold companion request failed with ${SCRUBBED}`);
    expect(redactTokens('Tour scene 3 of 6 shown')).toBe('Tour scene 3 of 6 shown');
    expect(redactTokens(undefined)).toBe('');
  });

  /**
   * What a recorded request may keep. The route is the evidence — which
   * endpoint answered 409 — and everything below the path is refused rather
   * than described, because the companion's capability lives in the fragment.
   */
  it('keeps the route of an address and drops its query, fragment and any token', () => {
    expect(requestRoute('http://127.0.0.1:52341/tool?session=1#a'.concat('b'.repeat(64))))
      .toBe('http://127.0.0.1:52341/tool');
    expect(requestRoute(`http://127.0.0.1:52341/${'c'.repeat(30)}/source`))
      .toBe(`http://127.0.0.1:52341/${SCRUBBED}/source`);
    expect(requestRoute('not a url')).toBe('<unparsed url>');
    expect(requestRoute(null)).toBe('<no url>');
  });
});

/**
 * The emulator's evidence channels. Before these existed a run could pass with
 * every spoken line answering 409: only `pageerror` was watched, so a refused
 * request, a blocked script and a console error all left no trace. The
 * assertions are on the harness source because running it needs a browser, an
 * emulated headset and a live listener.
 */
describe('the companion emulator report artifact', () => {
  it('records console output, failing responses and failed requests, and fails the run on them', async () => {
    const source = await readFile(resolve(pluginDirectory, 'scripts/companion-browser.ts'), 'utf8');

    // All three channels are hooked, for every page the harness opens.
    expect(source).toMatch(/page\.on\('console'/);
    expect(source).toMatch(/page\.on\('response'/);
    expect(source).toMatch(/page\.on\('requestfailed'/);
    expect(source.match(/watchPageEvidence\(\w+, '(?:desktop|companion)'\)/g) ?? []).toHaveLength(2);

    // Recorded text and addresses go through the tested redactors.
    expect(source).toMatch(/const redact = redactTokens/);
    expect(source).toMatch(/const routeOf = requestRoute/);
    expect(source).not.toMatch(/url: response\.url\(\)/);

    // The gate: a failed request, a failing response, or a console error ends
    // the run unless the caller asked for console errors to be recorded only.
    expect(source).toMatch(/function assertEvidenceClean\(expectedInjectedAbort = false\)/);
    expect(source).toMatch(/assert\.deepEqual\(report\.failedRequests, \[\]/);
    expect(source).toMatch(/assert\.deepEqual\(report\.failedResponses, \[\]/);
    expect(source).toMatch(/if \(!allowConsoleErrors\) \{/);
    expect(source).toMatch(/assertEvidenceClean\(\); report\.status = 'passed'/);
  });

  it('serves the dist it was pointed at, so a build under test is never the served one', async () => {
    const source = await readFile(resolve(pluginDirectory, 'scripts/companion-browser.ts'), 'utf8');
    expect(source).toMatch(/const distDirectory = resolve\(options\.get\('--dist'\) \?\? 'dist'\)/);
    expect(source).toMatch(/args: \[resolve\(distDirectory, 'server\.mjs'\)\]/);
    expect(source).toMatch(/runtimeFile = \(label: \(typeof runtimePaths\)\[number\]\) => resolve\(distDirectory/);
    expect(source).not.toMatch(/readFile\(resolve\('dist\//);

    const build = await readFile(resolve(pluginDirectory, 'scripts/build.ts'), 'utf8');
    expect(build).toMatch(/const distRoot = requestedDist \? resolve\(requestedDist\) : defaultDistRoot/);
    // A scratch build writes nothing into the repository it built from.
    expect(build).toMatch(/if \(scratchDist\) await emit\(distRoot\);/);
    expect(build).toMatch(/scratchDist \? resolve\(outRoot, 'THIRD_PARTY_NOTICES\.md'\)/);
  });
});
