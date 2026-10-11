import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ResourceCsp } from './profiles.js';

type BrowserToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

type DisplayMode = 'inline' | 'fullscreen' | 'pip';

type BrowserHostState = {
  profile: string;
  viewerReady: boolean;
  bridgeConnected: boolean;
  appInfo?: unknown;
  toolCalls: BrowserToolCall[];
  cspViolations: Array<Record<string, unknown>>;
  /** Display modes the app asked for, in order, with what the host answered. */
  displayModeRequests: Array<{ requested: DisplayMode; granted: DisplayMode }>;
  /** Sizes the app asked its card to be, in order. */
  sizeChanges: Array<{ width?: number; height?: number }>;
  /** Current iframe box in CSS px, which the host owns. */
  panel: { width: number; height: number };
  displayMode: DisplayMode;
  error?: string;
};

declare global {
  interface Window {
    __stereoCallServer?: (params: BrowserToolCall) => Promise<CallToolResult>;
    __stereoReadResource?: () => Promise<{
      html: string;
      sandbox: string;
      csp: ResourceCsp;
      permissions?: Record<string, unknown>;
    }>;
    __stereoHostState?: BrowserHostState;
    __stereoDeliverFixture?: (result: CallToolResult) => Promise<void>;
    /** Deliver any tool result, for the scenarios that send more than one. */
    __stereoDeliverResult?: (result: CallToolResult, args?: Record<string, unknown>) => Promise<void>;
    /** Resize the modelled host card without reloading the app. */
    __stereoSetPanelSize?: (width: number, height: number) => Promise<void>;
    /** Move the card between inline and the side panel, resizing as the host would. */
    __stereoSetDisplayMode?: (mode: 'inline' | 'fullscreen') => Promise<void>;
    __stereoHostStop?: () => Promise<void>;
  }
}

const body = document.body;
const profile = body.dataset.profile ?? 'codex';
const initialFrame = document.querySelector<HTMLIFrameElement>('#app-frame');
if (initialFrame == null) throw new Error('Host emulation iframe is missing.');
const frame: HTMLIFrameElement = initialFrame;

function numberAttribute(name: string, fallback: number): number {
  const raw = Number(body.dataset[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * The card geometry this host page models.
 *
 * The browser viewport is sized to the largest box any scenario uses, and the
 * iframe is what carries the modelled panel size. That is what lets a dock or
 * a host resize happen inside one page load: the app's own `window.innerWidth`
 * is the iframe's width, so resizing the iframe is exactly the resize Codex
 * performs when it moves the webview into the side panel.
 */
const inlineSize = {
  width: numberAttribute('inlineWidth', 800),
  height: numberAttribute('inlineHeight', 560),
};
const fullscreenSize = {
  width: numberAttribute('fullscreenWidth', inlineSize.width),
  height: numberAttribute('fullscreenHeight', inlineSize.height),
};
const availableDisplayModes = (body.dataset.availableDisplayModes ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value): value is DisplayMode => value === 'inline' || value === 'fullscreen' || value === 'pip');
const initialDisplayMode: DisplayMode = body.dataset.displayMode === 'fullscreen' ? 'fullscreen' : 'inline';
const initialSize = initialDisplayMode === 'fullscreen' ? fullscreenSize : inlineSize;

function applyFrameSize(width: number, height: number): void {
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
}
applyFrameSize(initialSize.width, initialSize.height);

const state: BrowserHostState = {
  profile,
  viewerReady: false,
  bridgeConnected: false,
  toolCalls: [],
  cspViolations: [],
  displayModeRequests: [],
  sizeChanges: [],
  panel: { ...initialSize },
  displayMode: initialDisplayMode,
};
window.__stereoHostState = state;

window.addEventListener('message', (event) => {
  const violation = event.data?.__stereoCspViolation;
  if (violation != null && typeof violation === 'object') {
    state.cspViolations.push(violation as Record<string, unknown>);
  }
});

const hostCapabilities = {
  serverTools: { listChanged: false },
  serverResources: { listChanged: false },
  logging: {},
  // The app's CSP is supplied by its `_meta.ui.csp` at resource-read time.
  // Do not duplicate plugin domains in the host capability advertisement.
  sandbox: { permissions: {} },
};

/**
 * The host context this page publishes.
 *
 * `setHostContext` replaces the stored context wholesale and notifies only the
 * fields that changed, so every update has to pass the complete object. It is
 * kept here rather than read back off the bridge for that reason.
 *
 * `containerDimensions` is deliberately `maxWidth`/`maxHeight`, never
 * `height`: X1 read Codex's own builder as `{maxHeight: el.clientHeight,
 * maxWidth: el.clientWidth}`, the card's current measured size republished on
 * every layout change, and `plugin/src/panel-size.ts` must keep ignoring it.
 */
function buildHostContext(): Record<string, unknown> {
  const context: Record<string, unknown> = {
    displayMode: state.displayMode,
    containerDimensions: { maxWidth: state.panel.width, maxHeight: state.panel.height },
  };
  if (availableDisplayModes.length > 0) context.availableDisplayModes = availableDisplayModes;
  return context;
}

const bridge = new AppBridge(
  null,
  { name: `Stereo host-emulation ${profile}`, version: '0.1.0' },
  hostCapabilities,
  { hostContext: buildHostContext() },
);

bridge.oncalltool = async (params) => {
  const call: BrowserToolCall = {
    name: params.name,
    arguments: (params.arguments ?? {}) as Record<string, unknown>,
  };
  state.toolCalls.push(call);
  if (window.__stereoCallServer == null) throw new Error('Node MCP callback is not installed.');
  // Return the complete MCP envelope unchanged. In particular, app-only
  // get_structure coordinates live under result._meta, never public
  // structuredContent; destructuring this result would silently break fresh
  // panel hydration in the host exercise.
  return window.__stereoCallServer(call);
};

bridge.oninitialized = () => {
  state.viewerReady = true;
  state.appInfo = bridge.getAppVersion();
};

bridge.onsizechange = (params) => {
  state.sizeChanges.push({ width: params.width, height: params.height });
};

/**
 * Grant a display-mode request the way Codex does.
 *
 * `fullscreen` moves this webview into a right-hand side-panel
 * tab, which is a different rectangle, and the host echoes the new mode back
 * through host-context-changed. So the frame is resized before the response is
 * returned: the app's `refitForDisplayMode` waits for the stage to stop moving
 * and would otherwise measure the box it is leaving.
 *
 * Whether the real Codex resizes before or after it answers is UNVERIFIED.
 */
bridge.onrequestdisplaymode = async ({ mode }) => {
  const granted = availableDisplayModes.includes(mode) ? mode : state.displayMode;
  state.displayModeRequests.push({ requested: mode, granted });
  if (granted !== state.displayMode) {
    state.displayMode = granted;
    const size = granted === 'fullscreen' ? fullscreenSize : inlineSize;
    state.panel = { ...size };
    applyFrameSize(size.width, size.height);
    bridge.setHostContext(buildHostContext());
  }
  return { mode: granted };
};

bridge.onsandboxready = async () => {
  if (profile !== 'claude-science') return;
  if (window.__stereoReadResource == null) throw new Error('Node resource callback is not installed.');
  const resource = await window.__stereoReadResource();
  await bridge.sendSandboxResourceReady({
    html: resource.html,
    sandbox: resource.sandbox,
    csp: resource.csp,
    permissions: resource.permissions,
  });
};

window.__stereoDeliverFixture = async (result) => {
  if (!state.viewerReady) throw new Error('Cannot deliver a tool result before ui/initialize completes.');
  // This open result intentionally carries no coordinates in either public
  // input or structured content. Its server-issued renderToken stays intact
  // alongside sessionId, so the viewer can reject delayed older renders before
  // following this session with an app-only get_structure call. That complete
  // result envelope includes the private `_meta` coordinate payload.
  await bridge.sendToolInput({
    arguments: {},
  });
  await bridge.sendToolResult(result);
};

window.__stereoDeliverResult = async (result, args) => {
  if (!state.viewerReady) throw new Error('Cannot deliver a tool result before ui/initialize completes.');
  await bridge.sendToolInput({ arguments: args ?? {} });
  await bridge.sendToolResult(result);
};

window.__stereoSetPanelSize = async (width, height) => {
  state.panel = { width, height };
  applyFrameSize(width, height);
  bridge.setHostContext(buildHostContext());
};

window.__stereoSetDisplayMode = async (mode) => {
  state.displayMode = mode;
  const size = mode === 'fullscreen' ? fullscreenSize : inlineSize;
  state.panel = { ...size };
  applyFrameSize(size.width, size.height);
  bridge.setHostContext(buildHostContext());
};

window.__stereoHostStop = async () => {
  await bridge.close();
  frame.src = 'about:blank';
};

const frameWindow = frame.contentWindow;
if (frameWindow == null) throw new Error('Host emulation iframe has no contentWindow.');
const transport = new PostMessageTransport(frameWindow, frameWindow);
frame.src = profile === 'claude-science' ? '/proxy' : '/viewer';
void bridge.connect(transport)
  .then(() => { state.bridgeConnected = true; })
  .catch((error: unknown) => {
    state.error = error instanceof Error ? error.message : String(error);
  });
