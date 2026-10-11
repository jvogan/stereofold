import { describe, expect, it } from 'vitest';
import {
  assembleCodexCsp,
  buildHostRuntimePolicy,
  deriveClaudeScienceSandbox,
  extractUiResourceMetadata,
  HOST_PROFILES,
  profileFromArg,
} from './profiles.js';
import { classifyCspViolation } from './classify.js';

const sampleUi = {
  _meta: {
    ui: {
      csp: {
        resourceDomains: ['blob:', 'data:'],
        connectDomains: ['https://api.example.test'],
      },
    },
  },
};

describe('host emulation profiles', () => {
  it('assembles Codex CSP from resource metadata, including data and blob', () => {
    const metadata = extractUiResourceMetadata(sampleUi, 'resources/read');
    const csp = assembleCodexCsp(metadata.csp);
    expect(csp).toContain("script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:");
    expect(csp).toContain('img-src blob: data:');
    expect(csp).toContain('worker-src blob:');
    expect(csp).toContain('connect-src https://api.example.test blob: data:');
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("script-src 'self'");
  });

  it('keeps the Codex profile domains runtime-derived rather than hard-coded', () => {
    const metadata = extractUiResourceMetadata(sampleUi, 'resources/read');
    const runtime = buildHostRuntimePolicy(HOST_PROFILES.codex, metadata);
    expect(runtime.cspHeader).toContain('img-src blob: data:');
    expect(runtime.cspHeader).toContain('connect-src https://api.example.test blob: data:');
  });

  it('does not call a declared data: source a plugin defect', () => {
    const verdict = classifyCspViolation(
      { effectiveDirective: 'img-src', blockedURI: 'data', sourceFile: 'viewer.html' },
      { resourceDomains: ['blob:', 'data:'] },
    );
    expect(verdict.category).not.toBe('plugin');
    expect(verdict.ruleId).toBe('csp-source-covered-but-blocked');
  });

  it('calls an undeclared data: source a plugin defect', () => {
    const verdict = classifyCspViolation(
      { effectiveDirective: 'img-src', blockedURI: 'data', sourceFile: 'viewer.html' },
      { resourceDomains: ['blob:'] },
    );
    expect(verdict.category).toBe('plugin');
    expect(verdict.ruleId).toBe('plugin-declared-csp-missing-source');
  });

  it('uses exactly allow-scripts allow-forms without a metadata request', () => {
    const decision = deriveClaudeScienceSandbox(extractUiResourceMetadata({}));
    expect(decision.appliedTokens).toEqual(['allow-scripts', 'allow-forms']);
    expect(decision.requestedTokens).toEqual([]);
    expect(decision.permissionsRequested).toEqual([]);
  });

  it('does not turn a permissions request into speculative sandbox tokens', () => {
    const metadata = extractUiResourceMetadata({
      _meta: { ui: { permissions: { camera: {} } } },
    }, 'resources/read');
    const decision = deriveClaudeScienceSandbox(metadata);
    expect(decision.appliedTokens).toEqual(['allow-scripts', 'allow-forms']);
    expect(decision.permissionsRequested).toEqual(['camera']);
    expect(decision.reason).toContain('no sandbox field');
    expect(buildHostRuntimePolicy(HOST_PROFILES['claude-science'], metadata).sandbox).toEqual(decision);
  });

  it('uses the documented Codex direct iframe contract', () => {
    expect(HOST_PROFILES.codex.iframeSandbox).toBe('allow-scripts allow-forms allow-same-origin');
  });

  it('sizes both panels from documented host evidence', () => {
    expect(HOST_PROFILES.codex.panel.heightCssPx).toBe(560);
    expect(HOST_PROFILES.codex.panel.widthCssPx).toBe(800);
    expect(HOST_PROFILES['claude-science'].panel.widthCssPx).toBe(800);
    for (const profile of Object.values(HOST_PROFILES)) {
      expect(profile.panel.widthSource.length).toBeGreaterThan(0);
      expect(profile.panel.heightSource.length).toBeGreaterThan(0);
    }
  });

  it('uses the stricter Claude Science inner sandbox', () => {
    const profile = HOST_PROFILES['claude-science'];
    const runtime = buildHostRuntimePolicy(profile, extractUiResourceMetadata({}));
    expect(runtime.sandbox.appliedTokens.join(' ')).toBe('allow-scripts allow-forms');
    expect(runtime.sandbox.appliedTokens).not.toContain('allow-same-origin');
    expect(runtime.innerCspHeader).toContain("worker-src 'self' blob:");
    expect(runtime.innerCspHeader).toContain('https://esm.sh');
  });

  it('parses the supported profile selector', () => {
    expect(profileFromArg(undefined)).toEqual(['codex', 'codex-narrow', 'codex-side-panel', 'claude-science']);
    expect(profileFromArg('all')).toEqual(['codex', 'codex-narrow', 'codex-side-panel', 'claude-science']);
    expect(profileFromArg('codex-narrow')).toEqual(['codex-narrow']);
    expect(profileFromArg('codex')).toEqual(['codex']);
    expect(profileFromArg('codex-side-panel')).toEqual(['codex-side-panel']);
    expect(profileFromArg('claude-science')).toEqual(['claude-science']);
  });

  /*
   * The side-panel profile is the only one whose numbers come from a photo of
   * a host rather than from host source, so the test pins that admission in
   * the profile itself: a later edit that quietly promotes it to measured
   * evidence has to change this assertion too.
   */
  it('marks the side-panel size as derived from the screenshot, not the host', () => {
    const profile = HOST_PROFILES['codex-side-panel'];
    expect(profile.panel.widthCssPx).toBe(1026);
    expect(profile.panel.heightCssPx).toBe(878);
    expect(profile.panel.widthSource).toContain('Not measured from Codex source');
    expect(profile.panel.heightSource).toContain('Not measured from Codex source');
    expect(profile.iframeSandbox).toBe(HOST_PROFILES.codex.iframeSandbox);
  });
});
