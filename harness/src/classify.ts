/**
 * Classification of everything the harness observes in the browser.
 *
 *  harness           — the harness itself is wrong. Must be fixed; never allowed
 *                      to remain. Fails the run.
 *  profile-contract  — the emulated CSP/sandbox is stricter or looser than the
 *                      host evidence in docs/*.md or in the shipped host
 *                      bundles. Fails the run unless the rule records an
 *                      explicit, cited decision to keep it.
 *  plugin            — a defect in plugin/ that this harness must not fix. Does not
 *                      fail the run; printed under PLUGIN DEFECTS.
 *  unclassified      — nothing matched. Fails the run, deliberately: an
 *                      unrecognised browser error is not a passing result.
 */
export type Category = 'harness' | 'profile-contract' | 'plugin' | 'unclassified';

import type { ResourceCsp } from './profiles.js';

export type Verdict = {
  ruleId: string;
  category: Category;
  fails: boolean;
  note: string;
  /** For `plugin`: the file:line in plugin/src to look at. */
  pluginSite?: string;
  /**
   * True when this record is a second view of a problem that another record
   * already reports. Kept in the JSON, omitted from the PLUGIN DEFECTS list so
   * one defect is listed once.
   */
  echo?: boolean;
};

type Rule = {
  id: string;
  category: Category;
  fails: boolean;
  match: RegExp;
  note: string;
  pluginSite?: string;
  echo?: boolean;
};

const CONSOLE_RULES: Rule[] = [
  {
    id: 'molstar-webxr-permission-probe',
    category: 'plugin',
    fails: false,
    match: /^Permissions policy violation: xr-spatial-tracking is not allowed in this document\.$/u,
    pluginSite: 'plugin/src/viewer.ts:121 (new PluginContext)',
    note: "plugin/src/viewer.ts:121 `new PluginContext(DefaultPluginSpec())` builds the Mol* context with DefaultPluginSpec(), which constructs Canvas3D's XRManager (molstar/lib/mol-canvas3d/canvas3d.js:387). The manager calls navigator.xr.isSessionSupported() unconditionally (molstar/lib/mol-canvas3d/helper/xr-manager.js:270-271). In the Claude Science profile the app frame is opaque-origin and the proxy grants only 'fullscreen *', so the probe is denied and logged. Mol* catches it and reports XR unsupported, so this is console noise rather than a functional break. The plugin decides whether to declare the permission or accept the log line.",
  },
  {
    id: 'anaglyph-fork-mat4-set',
    category: 'plugin',
    fails: false,
    match: /projection\.set is not a function/u,
    pluginSite: 'plugin/src/molstar-draw-pass-fork.ts:60',
    note: "Thrown on every anaglyph frame. Mol* Mat4 is a plain number[] (molstar/lib/mol-math/linear-algebra/3d/mat4.js:29-34 forces a double-backed Array), so eye.projection has no .set(). Lines 60-62 of the injected fork call .set() on eye.projection, eye.projectionView and eye.inverseProjectionView inside renderEye's finally block. The throw escapes renderEye, so the right eye never renders and the Dubois composite never runs: anaglyph mode does not work. Use Mat4.copy(target, source) or an index loop instead.",
  },
  {
    id: 'csp-console-echo',
    category: 'plugin',
    fails: false,
    echo: true,
    match: /^Refused to |violates the following Content Security Policy directive/u,
    note: 'Chromium logs every CSP block twice: once as a console error and once as a securitypolicyviolation event. The CSP violation record is authoritative; this line is its echo.',
  },
];

function apply(rules: Rule[], text: string): Verdict {
  for (const rule of rules) {
    if (rule.match.test(text)) {
      return {
        ruleId: rule.id,
        category: rule.category,
        fails: rule.fails,
        note: rule.note,
        ...(rule.pluginSite == null ? {} : { pluginSite: rule.pluginSite }),
        ...(rule.echo === true ? { echo: true } : {}),
      };
    }
  }
  return {
    ruleId: 'unclassified',
    category: 'unclassified',
    fails: true,
    note: 'No classification rule matched. Triaged as a failure until a rule is added.',
  };
}

export function classifyConsoleError(text: string): Verdict {
  return apply(CONSOLE_RULES, text);
}

function normalizeScheme(value: string): string {
  const lower = value.toLowerCase();
  return lower.endsWith(':') ? lower : `${lower}:`;
}

function sourceCoversBlockedUri(source: string, blockedUri: string): boolean {
  const normalizedSource = source.trim().toLowerCase();
  if (normalizedSource === '') return false;
  const normalizedBlocked = blockedUri.trim().toLowerCase();
  if (normalizedBlocked === '') return false;

  if (normalizedBlocked === 'data' || normalizedBlocked === 'data:') {
    return normalizedSource === 'data:';
  }
  if (normalizedBlocked === 'blob' || normalizedBlocked === 'blob:') {
    return normalizedSource === 'blob:';
  }
  if (/^[a-z][a-z0-9+.-]*$/u.test(normalizedBlocked)) {
    return normalizedSource === normalizeScheme(normalizedBlocked);
  }
  if (/^[a-z][a-z0-9+.-]*:/u.test(normalizedBlocked)) {
    if (normalizedSource.endsWith(':')) return normalizedBlocked.startsWith(normalizedSource);
    try {
      const blocked = new URL(normalizedBlocked);
      const sourceUrl = new URL(normalizedSource);
      if (sourceUrl.origin === blocked.origin) return true;
      if (sourceUrl.protocol !== blocked.protocol) return false;
      if (!sourceUrl.hostname.startsWith('*.')) return false;
      return blocked.hostname.endsWith(`.${sourceUrl.hostname.slice(2)}`);
    } catch {
      return normalizedSource === normalizedBlocked;
    }
  }
  return normalizedSource === normalizedBlocked;
}

function declaredSourcesForDirective(directive: string, declared: ResourceCsp): string[] {
  if (directive === 'connect-src') {
    // Codex's verified assembly deliberately absorbs resourceDomains into
    // connect-src. This also makes classification agree with the effective
    // policy assembled by the harness.
    return [...new Set([...(declared.connectDomains ?? []), ...(declared.resourceDomains ?? [])])];
  }
  if (directive === 'img-src' || directive === 'script-src' || directive === 'style-src'
    || directive === 'font-src' || directive === 'media-src' || directive === 'worker-src') {
    return declared.resourceDomains ?? [];
  }
  if (directive === 'frame-src') return declared.frameDomains ?? [];
  if (directive === 'base-uri') return declared.baseUriDomains ?? [];
  return [];
}

export function classifyCspViolation(violation: {
  effectiveDirective?: unknown;
  blockedURI?: unknown;
  sourceFile?: unknown;
}, declared?: ResourceCsp): Verdict {
  const effectiveDirective = String(violation.effectiveDirective ?? '');
  const blockedURI = String(violation.blockedURI ?? '');
  if (declared == null) {
    return {
      ruleId: 'csp-metadata-missing',
      category: 'harness',
      fails: true,
      note: 'The resource/tool result did not expose `_meta.ui.csp`; the harness cannot attribute this CSP violation to the plugin.',
    };
  }

  const declaredSources = declaredSourcesForDirective(effectiveDirective, declared);
  const covered = declaredSources.some((source) => sourceCoversBlockedUri(source, blockedURI));
  if (covered) {
    return {
      ruleId: 'csp-source-covered-but-blocked',
      category: 'harness',
      fails: true,
      note: `The blocked ${blockedURI} source is declared by the plugin for ${effectiveDirective}; the effective harness CSP is inconsistent with _meta.ui.csp and is not a plugin defect.`,
    };
  }
  return {
    ruleId: 'plugin-declared-csp-missing-source',
    category: 'plugin',
    fails: false,
    pluginSite: 'plugin/src/server.ts:57-70 (_meta.ui.csp)',
    note: `The plugin's _meta.ui.csp does not declare ${blockedURI || 'the blocked source'} for ${effectiveDirective}; this is a plugin defect. Declared sources: ${declaredSources.join(', ') || '(none)'}.`,
  };
}

export const RULE_COUNTS = { console: CONSOLE_RULES.length, csp: 0 };
