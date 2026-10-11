/**
 * When a Mac renderer tab the host opened should go away.
 *
 * Every standalone host start hands Chrome a loopback inspector URL
 * (`quest-launch.openLocalInBrowser`). `open -a` does not return a handle and
 * does not set `window.opener`, so a killed host used to leave that tab sitting
 * in Chrome. A day of restarts then left dozens of Mol* renderers running, and
 * the next host's wait for a saved scene stretched from seconds to minutes.
 *
 * Two close paths, because SIGKILL never runs host cleanup:
 *
 *   The page closes itself when its heartbeat to this origin fails, but only
 *   when the tab was host-opened (a `hostOpened=1` query, `window.name`, or a
 *   real `window.opener`). Chrome ignores `window.close()` on a tab the wearer
 *   pasted themselves. A companion page never closes: that is the headset.
 *
 *   The host also tells Chrome to close matching tabs on SIGTERM/SIGINT, and
 *   a new start sweeps renderer tabs whose origin no longer answers. Both
 *   host paths only touch URLs carrying `hostOpened=1` (the stamp
 *   `markHostOpenedUrl` adds), so a tab the wearer pasted is left alone. That
 *   uses Chrome's AppleScript dictionary through `/usr/bin/osascript` — the
 *   same class of absolute macOS helper as `/usr/bin/open`, no new dependency.
 *
 * Everything here is pure. Spawning osascript lives next to the opener in
 * `quest-launch.ts`.
 */

export const RENDERER_TAB_NAME = 'stereofold-renderer';
export const HOST_OPENED_PARAM = 'hostOpened';
/** Polls are once a second; three misses is long enough that a blip is not a close. */
export const FAILED_HEARTBEATS_BEFORE_CLOSE = 3;
export const STEREOFOLD_RENDERER_TITLE = 'Stereofold';

export type RendererTabCloseReason =
  | 'companion'
  | 'embedded'
  | 'not-host-opened'
  | 'host-alive'
  | 'too-few-failures'
  | 'host-asked'
  | 'host-gone';

export type RendererTabCloseDecision =
  | { action: 'close'; reason: 'host-asked' | 'host-gone' }
  | { action: 'stay'; reason: Exclude<RendererTabCloseReason, 'host-asked' | 'host-gone'> };

/**
 * Whether this document may close the tab it is in.
 *
 * `companion` is the headset page: a Mac host dying must not take Quest
 * Browser with it. `sameOriginTop` is false inside a cross-origin host iframe
 * (Claude Code / Codex MCP Apps), where `window.close()` would be aimed at
 * the chat, not a Chrome tab. `hostOpened` is the script-opened / host-opened
 * bit Chrome requires before it honours `window.close()`.
 */
export function decideRendererTabClose(input: {
  companion: boolean;
  sameOriginTop: boolean;
  hostOpened: boolean;
  hostAskedClose: boolean;
  consecutiveFailedHeartbeats: number;
}): RendererTabCloseDecision {
  if (input.companion) return { action: 'stay', reason: 'companion' };
  if (!input.sameOriginTop) return { action: 'stay', reason: 'embedded' };
  if (!input.hostOpened) return { action: 'stay', reason: 'not-host-opened' };
  if (input.hostAskedClose) return { action: 'close', reason: 'host-asked' };
  const misses = Number.isFinite(input.consecutiveFailedHeartbeats)
    ? Math.max(0, input.consecutiveFailedHeartbeats) : 0;
  if (misses <= 0) return { action: 'stay', reason: 'host-alive' };
  if (misses < FAILED_HEARTBEATS_BEFORE_CLOSE) return { action: 'stay', reason: 'too-few-failures' };
  return { action: 'close', reason: 'host-gone' };
}

/** `window.opener`, the name we stamp, or the query the opener puts on the address. */
export function tabIsHostOpened(input: { opener: unknown; name?: string; search?: string }): boolean {
  if (input.opener != null) return true;
  if (input.name === RENDERER_TAB_NAME) return true;
  const search = input.search ?? '';
  const query = search.startsWith('?') ? search.slice(1) : search;
  try { return new URLSearchParams(query).get(HOST_OPENED_PARAM) === '1'; }
  catch { return false; }
}

/**
 * Stamp the loopback panel address so the page can tell a host-opened tab from
 * one the wearer pasted. The fragment is the page key and must not move.
 */
export function markHostOpenedUrl(link: string): string {
  const parsed = new URL(link);
  parsed.searchParams.set(HOST_OPENED_PARAM, '1');
  return parsed.href;
}

/**
 * A loopback inspector this Mac is serving: `http://127.0.0.1:<port>/` (query
 * and fragment allowed). Not the LAN companion, not Meta Web Launch, not a
 * page with credentials.
 */
export function isMacRendererTabUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
  if (parsed.port === '' || parsed.username || parsed.password) return false;
  return parsed.pathname === '/' || parsed.pathname === '';
}

/**
 * A loopback inspector this host opened. `isMacRendererTabUrl` stays origin-
 * only so `closeChromeRendererTabs` can still validate `${origin}/`; the
 * hostOpened query is what separates a tab the opener stamped from one the
 * wearer pasted.
 */
export function isHostOpenedRendererTabUrl(url: string): boolean {
  if (!isMacRendererTabUrl(url)) return false;
  try { return new URL(url).searchParams.get(HOST_OPENED_PARAM) === '1'; }
  catch { return false; }
}

/** Origins of renderer tabs that are still ours to close. */
export function rendererTabOrigin(url: string): string | undefined {
  if (!isMacRendererTabUrl(url)) return undefined;
  return new URL(url).origin;
}

/**
 * Renderer tabs whose origin is not in the live set. A live origin is a host
 * that still answers; everything else is a leftover from a killed process.
 */
export function selectStaleRendererTabs(input: {
  urls: readonly string[];
  liveOrigins?: ReadonlySet<string>;
  liveOrigin?: string;
}): string[] {
  const keep = new Set(input.liveOrigins ?? []);
  if (input.liveOrigin) keep.add(input.liveOrigin);
  const stale: string[] = [];
  for (const url of input.urls) {
    if (!isHostOpenedRendererTabUrl(url)) continue;
    const origin = rendererTabOrigin(url);
    if (!origin || keep.has(origin)) continue;
    stale.push(url);
  }
  return stale;
}

export function parseChromeTabList(stdout: string): string[] {
  return String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('http://'));
}

/**
 * A dropped `/rpc` or companion poll, as opposed to a tool refusal the panel
 * should keep showing. Desktop fetch failures have no `companion_connection`
 * code — they arrive as "Failed to fetch" / "Local host request failed".
 */
export function isRendererHeartbeatFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'companion_connection') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Failed to fetch|Local host request failed|NetworkError|Load failed|connection was lost|connection was interrupted|ECONNREFUSED/i.test(message);
}

export function applyRendererTabClose(decision: RendererTabCloseDecision, close: () => void): boolean {
  if (decision.action !== 'close') return false;
  close();
  return true;
}

function appleString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * List loopback Chrome tabs whose title is ours. The title fence is the same
 * one `headset-devtools.ts` uses: this product's Mac renderer is titled
 * `Stereofold · …`. A 127.0.0.1 tab that is not ours is left alone.
 */
export function chromeListRendererTabUrlsScript(): string {
  const title = appleString(STEREOFOLD_RENDERER_TITLE);
  return [
    'tell application "Google Chrome"',
    '  set out to ""',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      set u to URL of t as string',
    '      set n to title of t as string',
    `      if n contains ${title} then`,
    '        if (u contains "?hostOpened=1" or u contains "&hostOpened=1") and (u starts with "http://127.0.0.1:" or u starts with "http://localhost:") then set out to out & u & linefeed',
    '      end if',
    '    end repeat',
    '  end repeat',
    '  return out',
    'end tell',
  ].join('\n');
}

export function chromeCloseTabsByUrlScript(urls: readonly string[]): string {
  const unique = [...new Set(urls.filter(url => isHostOpenedRendererTabUrl(url)))];
  if (unique.length === 0) return 'return';
  const matches = unique.map(url => `u is ${appleString(url)}`).join(' or ');
  return [
    'tell application "Google Chrome"',
    '  repeat with w in windows',
    '    repeat with t in (tabs of w)',
    '      set u to URL of t as string',
    `      if ${matches} then close t`,
    '    end repeat',
    '  end repeat',
    'end tell',
  ].join('\n');
}
