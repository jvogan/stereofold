export type HostProfileId = 'codex' | 'codex-narrow' | 'codex-side-panel' | 'claude-science';

/**
 * The part of `_meta.ui` that controls host security policy. These are kept
 * optional because the MCP Apps metadata schema permits omitted fields.
 */
export type ResourceCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export type UiResourceMetadata = {
  /** True when an `_meta.ui` object was found in a resource/tool result. */
  found: boolean;
  csp: ResourceCsp;
  permissions: Record<string, unknown>;
  sources: string[];
};

export type SandboxDecision = {
  target: 'direct-app-iframe' | 'claude-science-inner-iframe';
  requestedTokens: string[];
  permissionsRequested: string[];
  appliedTokens: string[];
  reason: string;
};

export type HostRuntimePolicy = {
  cspHeader: string;
  innerCspHeader: string;
  sandbox: SandboxDecision;
};

/**
 * CSS-pixel size of the host surface the MCP App is mounted into.
 * `source` records the on-disk evidence for each number so the harness never
 * silently invents a host dimension.
 */
export type PanelSize = {
  widthCssPx: number;
  heightCssPx: number;
  widthSource: string;
  heightSource: string;
};

export type HostProfile = {
  id: HostProfileId;
  label: string;
  panel: PanelSize;
  iframeSandbox: string;
  /** The Codex profile applies this to the direct app iframe; Claude applies it to the proxy. */
  buildCsp: (declared: ResourceCsp) => string;
  /** Claude's inner srcdoc receives the same documented CSP as the proxy. */
  buildInnerCsp: (declared: ResourceCsp) => string;
};

const EMPTY_METADATA: UiResourceMetadata = {
  found: false,
  csp: {},
  permissions: {},
  sources: [],
};

const DEFAULT_CLAUDE_SANDBOX_TOKENS = ['allow-scripts', 'allow-forms'] as const;

// Claude Science's documented built-in resource origins. These are host
// defaults, not plugin-declared domains. The plugin's own origins are added
// at runtime from `_meta.ui.csp`.
const CLAUDE_SCIENCE_BUILTIN_RESOURCE_DOMAINS = [
  'https://esm.sh',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://3dmol.org',
  'https://3dmol.csb.pitt.edu',
];

function uniqueStrings(...values: Array<readonly string[] | undefined>): string[] {
  return [...new Set(values.flatMap((value) => value ?? []).filter((item) => item.length > 0))];
}

function sourceList(domains: readonly string[]): string {
  return domains.length > 0 ? domains.join(' ') : "'none'";
}

/**
 * Assemble the Codex sandbox CSP from the app's declaration.
 *
 * This follows the rule observed in the Codex desktop app: no default-domain expansion, no
 * `'self'`, `resourceDomains` are included in `connect-src`, and Codex adds
 * its three script-src keywords. The only domains in the resulting policy
 * come from the resource's `_meta.ui.csp`.
 */
export function assembleCodexCsp(declared: ResourceCsp = {}): string {
  const resourceDomains = uniqueStrings(declared.resourceDomains);
  const connectDomains = uniqueStrings(declared.connectDomains, resourceDomains);
  const frameDomains = uniqueStrings(declared.frameDomains);
  const baseUriDomains = uniqueStrings(declared.baseUriDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${sourceList(resourceDomains)}`,
    `style-src 'unsafe-inline' ${sourceList(resourceDomains)}`,
    `img-src ${sourceList(resourceDomains)}`,
    `font-src ${sourceList(resourceDomains)}`,
    `media-src ${sourceList(resourceDomains)}`,
    // Codex's template always permits blob-backed workers for MCP Apps.
    'worker-src blob:',
    `connect-src ${sourceList(connectDomains)}`,
    `frame-src ${sourceList(frameDomains)}`,
    "object-src 'none'",
    `base-uri ${sourceList(baseUriDomains)}`,
    "form-action 'none'",
  ].join('; ');
}

/**
 * Assemble the documented Claude Science proxy/inner-frame CSP. The host's
 * built-in CDN list remains static host evidence; plugin resource/connect
 * domains are read from `_meta.ui.csp` for each run.
 */
export function assembleClaudeScienceCsp(declared: ResourceCsp = {}): string {
  const resourceDomains = uniqueStrings(
    CLAUDE_SCIENCE_BUILTIN_RESOURCE_DOMAINS,
    declared.resourceDomains,
  );
  const connectDomains = uniqueStrings(declared.connectDomains);
  const frameDomains = uniqueStrings(declared.frameDomains);
  const baseUriDomains = uniqueStrings(declared.baseUriDomains);
  const baseUri = baseUriDomains.length > 0
    ? sourceList(["'self'", ...baseUriDomains])
    : "'self'";
  return [
    "default-src 'none'",
    `base-uri ${baseUri}`,
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${sourceList(resourceDomains)}`,
    `style-src 'self' 'unsafe-inline' ${sourceList(resourceDomains)}`,
    `img-src 'self' data: blob: ${sourceList(resourceDomains)}`,
    `font-src 'self' data: blob: ${sourceList(resourceDomains)}`,
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    `connect-src 'self'${connectDomains.length > 0 ? ` ${connectDomains.join(' ')}` : ''}`,
    `frame-src ${sourceList(frameDomains)}`,
  ].join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function parseCsp(value: unknown): ResourceCsp | undefined {
  if (!isRecord(value)) return undefined;
  const csp: ResourceCsp = {};
  const connectDomains = stringArray(value.connectDomains);
  const resourceDomains = stringArray(value.resourceDomains);
  const frameDomains = stringArray(value.frameDomains);
  const baseUriDomains = stringArray(value.baseUriDomains);
  if (connectDomains != null) csp.connectDomains = connectDomains;
  if (resourceDomains != null) csp.resourceDomains = resourceDomains;
  if (frameDomains != null) csp.frameDomains = frameDomains;
  if (baseUriDomains != null) csp.baseUriDomains = baseUriDomains;
  return csp;
}

function parseUi(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.ui)) return value.ui;
  if (isRecord(value._meta) && isRecord(value._meta.ui)) return value._meta.ui;
  return undefined;
}

/**
 * Read `_meta.ui` from either a resource content item, a tool result, or the
 * metadata object itself. This deliberately ignores untyped/custom sandbox
 * fields: ext-apps 1.7.5 defines `permissions` on resource metadata, not a
 * resource-metadata `sandbox` field.
 */
export function extractUiResourceMetadata(value: unknown, source = 'unknown'): UiResourceMetadata {
  const ui = parseUi(value);
  if (ui == null) return { ...EMPTY_METADATA };
  const permissions = isRecord(ui.permissions) ? { ...ui.permissions } : {};
  return {
    found: true,
    csp: parseCsp(ui.csp) ?? {},
    permissions,
    sources: [source],
  };
}

/** Merge resource metadata first, with later sources filling omitted fields. */
export function mergeUiResourceMetadata(...items: UiResourceMetadata[]): UiResourceMetadata {
  const merged: UiResourceMetadata = { ...EMPTY_METADATA, csp: {}, permissions: {}, sources: [] };
  for (const item of items) {
    if (!item.found) continue;
    merged.found = true;
    merged.csp = { ...item.csp, ...merged.csp };
    merged.permissions = { ...item.permissions, ...merged.permissions };
    for (const source of item.sources) if (!merged.sources.includes(source)) merged.sources.push(source);
  }
  return merged;
}

function tokens(value: string): string[] {
  return value.split(/\s+/u).filter((token) => token.length > 0);
}

/**
 * Claude Science's inner iframe starts with exactly scripts/forms. In
 * ext-apps 1.7.5, resource metadata has `permissions` (camera, microphone,
 * geolocation, clipboardWrite), not `sandbox`; permissions affect the iframe
 * `allow` attribute and do not justify adding sandbox tokens.
 */
export function deriveClaudeScienceSandbox(metadata: UiResourceMetadata = EMPTY_METADATA): SandboxDecision {
  const permissionsRequested = Object.keys(metadata.permissions).sort();
  const permissionNote = permissionsRequested.length > 0
    ? ` Metadata requests permissions (${permissionsRequested.join(', ')}); those are handled by iframe allow policy, not sandbox tokens.`
    : ' No resource-metadata sandbox field or permissions request was found.';
  return {
    target: 'claude-science-inner-iframe',
    requestedTokens: [],
    permissionsRequested,
    appliedTokens: [...DEFAULT_CLAUDE_SANDBOX_TOKENS],
    reason: `Applied the documented Claude Science default allow-scripts allow-forms.${permissionNote} ext-apps@1.7.5 defines permissions on _meta.ui but no sandbox field, so no further sandbox token is added.`,
  };
}

export function deriveSandboxDecision(profile: HostProfile, metadata: UiResourceMetadata): SandboxDecision {
  if (profile.id === 'claude-science') return deriveClaudeScienceSandbox(metadata);
  const appliedTokens = tokens(profile.iframeSandbox);
  return {
    target: 'direct-app-iframe',
    requestedTokens: [],
    permissionsRequested: Object.keys(metadata.permissions).sort(),
    appliedTokens,
    reason: 'Codex uses the direct app iframe sandbox documented by the host profile; no plugin sandbox metadata is applied to this profile.',
  };
}

export function buildHostRuntimePolicy(profile: HostProfile, metadata: UiResourceMetadata): HostRuntimePolicy {
  return {
    cspHeader: profile.buildCsp(metadata.csp),
    innerCspHeader: profile.buildInnerCsp(metadata.csp),
    sandbox: deriveSandboxDecision(profile, metadata),
  };
}

export const HOST_PROFILES: Record<HostProfileId, HostProfile> = {
  codex: {
    id: 'codex',
    label: 'Codex desktop direct MCP App iframe',
    panel: {
      widthCssPx: 800,
      heightCssPx: 560,
      widthSource: 'Codex inline card observed at about 600-800 CSS px; upper bound taken. Not documented by the host.',
      heightSource: 'openai/widgetHeightHint = 560 CSS px, as declared by OpenAI\'s structure-viewer plugin.',
    },
    iframeSandbox: 'allow-scripts allow-forms allow-same-origin',
    buildCsp: assembleCodexCsp,
    buildInnerCsp: assembleCodexCsp,
  },
  'codex-narrow': {
    id: 'codex-narrow',
    label: 'Codex desktop direct MCP App iframe, compressed window',
    panel: {
      widthCssPx: 440,
      heightCssPx: 720,
      widthSource: 'A live Codex screenshot: the inline card shrank to about 440 CSS px when the app window was compressed. Measured from the screenshot, not from host source.',
      heightSource: 'Same screenshot: the host let the card grow tall (about 720 CSS px including the stage) rather than clipping. Measured, not documented.',
    },
    iframeSandbox: 'allow-scripts allow-forms allow-same-origin',
    buildCsp: assembleCodexCsp,
    buildInnerCsp: assembleCodexCsp,
  },
  /*
   * Codex's right-hand side panel, the surface `requestDisplayMode({ mode:
   * 'fullscreen' })` moves this webview into. It is the shape
   * that broke the fit: far taller than it is wide once the 63 mm interocular
   * cap has taken the eye window down to 238 CSS px, so a fit that measures
   * anything but the capped eye window overshoots by more than 2x.
   *
   * The size is DERIVED FROM THE SCREENSHOT RATIO, not measured from the host.
   * The screenshot of a clipped side-panel pair was
   * downscaled by the screenshot pipeline, so its absolute scale is unknown.
   * The one length in it whose CSS value is known is the eye window: the
   * caption reads "one eye 63.0 mm", so the cap is in force and each eye is
   * 238 CSS px. The eye windows measure 418 image px, giving 1.756 image px
   * per CSS px, and the stage's 1800 x 1542 image px is then about
   * 1025 x 878 CSS px. This profile takes that as the PANEL box, so the
   * modelled stage is about 79 CSS px shorter than the photographed one, the height of the
   * toolbar. Nothing here is measured from Codex source.
   */
  'codex-side-panel': {
    id: 'codex-side-panel',
    label: 'Codex desktop side-panel tab (requestDisplayMode fullscreen)',
    panel: {
      widthCssPx: 1026,
      heightCssPx: 878,
      widthSource: "Derived from a screenshot of a clipped Codex side-panel pair: stage 1800 image px wide at 1.756 image px per CSS px, the scale fixed by the 418 image px eye window being the 238 CSS px interocular cap. Not measured from Codex source.",
      heightSource: 'Same screenshot: stage 1542 image px tall at the same scale. Taken as the panel height, so the modelled stage is shorter than the photographed one by the toolbar. Not measured from Codex source.',
    },
    iframeSandbox: 'allow-scripts allow-forms allow-same-origin',
    buildCsp: assembleCodexCsp,
    buildInnerCsp: assembleCodexCsp,
  },
  'claude-science': {
    id: 'claude-science',
    label: 'Claude Science local proxy and inner srcdoc iframe',
    panel: {
      widthCssPx: 800,
      heightCssPx: 640,
      widthSource: 'Claude Science inline card observed at about 600-800 CSS px; upper bound taken. Not documented by the host.',
      heightSource: 'No host height is documented for Claude Science. Uses a fallback of 640 CSS px.',
    },
    // The host clamps the inner frame; there is no separate outer-host sandbox.
    // The runtime derives the inner sandbox from the metadata decision above.
    iframeSandbox: '',
    buildCsp: assembleClaudeScienceCsp,
    buildInnerCsp: assembleClaudeScienceCsp,
  },
};

export function profileFromArg(value: string | undefined): HostProfileId[] {
  if (value == null || value === 'all') return ['codex', 'codex-narrow', 'codex-side-panel', 'claude-science'];
  if (value === 'codex' || value === 'codex-narrow' || value === 'codex-side-panel' || value === 'claude-science') return [value];
  throw new Error(`Unknown profile '${value}'. Use codex, codex-narrow, codex-side-panel, claude-science, or all.`);
}
