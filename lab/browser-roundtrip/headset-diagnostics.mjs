/**
 * What the headset can tell the Mac about itself.
 *
 * A real Quest wearing this page reports nothing. Voice fails with no audio
 * chunk, the menu seats itself too low, the toolbar refuses a press, and the agent on
 * the Mac sees an empty screen either way: the headset has no console anyone
 * can read, and the companion connection carries scene state only.
 *
 * This module is that missing return channel. It holds a small ring buffer of
 * `{seq, at, kind, detail}` entries, drains the ones the desktop has not
 * acknowledged onto the `poll_inspection` heartbeat the companion page already
 * runs, and installs itself on `globalThis.__stereofoldDiagnostics` so any
 * other module can record an event with one optional-chained call and no
 * import:
 *
 *     globalThis.__stereofoldDiagnostics?.record('voice-press', { phase });
 *
 * Everything here is defensive. A recorder that throws, a detail that cannot
 * be serialised, a session that has already ended, a browser with no
 * `MediaRecorder` — none of them may break immersion, so every entry point
 * swallows its own failure and the buffer keeps running.
 *
 * Nothing recorded here is a secret. Details are shallow, JSON-safe, and
 * string-capped; no pairing code, bearer token, device key or companion URL
 * ever reaches an entry, and callers must not put one in a detail.
 */

import { deviceClass as classifyDevice, describeInputSources as describeSources } from './input-capabilities.mjs';
import { readSessionFrameRates, renderBudget, structureAtomSites } from './xr-render-budget.mjs';

/** How many entries the page keeps. Older entries are dropped, not queued. */
export const MAX_DIAGNOSTIC_ENTRIES = 200;
/** Longest string any detail field may carry. */
export const MAX_DETAIL_STRING = 200;
/**
 * Bounded headroom for the layout record, which carries up to twenty-five
 * output fields plus its anchors, obstacles, inputs and search summary.
 * The Mac's `MAX_DIAGNOSTIC_FIELDS` in
 * plugin/src/headset-diagnostics.ts must equal this: a record the page keeps
 * but the Mac refuses is salvaged there as `unreadable`, which is how the
 * 26-field page cap over a 24-field Mac cap would have lost every layout
 * record that named both a reason and a menu reason.
 */
export const MAX_DETAIL_KEYS = 40;
/** Keeps all ten plates and the longer toolbar/input inventories, still bounded. */
export const MAX_DETAIL_ITEMS = 32;
/** Most entries one heartbeat carries, so a burst drains over several beats. */
export const MAX_HEARTBEAT_ENTRIES = 24;
/** How often the frame-rate estimate is recorded while presenting. */
export const FRAME_RATE_SAMPLE_MS = 5_000;
/** Bound the sampling cost; retention below also protects rare evidence. */
export const DIAGNOSTIC_RATE_LIMIT_MS = Object.freeze({
  'frame-cost': 5_000,
  'frame-rate': 5_000,
  'plate-update': 5_000,
});

// These can recur on every sampled frame or toolbar redraw. Seat and status
// transitions share the toolbar kind, but belong with the rare evidence.
const FREQUENT_DIAGNOSTIC_KINDS = new Set([
  'frame-cost', 'frame-rate', 'component-labels-drawn',
]);
function frequentEntry(entry, rateLimitMs) {
  // Sampling exemptions must also survive eviction by later frame/redraw traffic.
  if (entry.kind === 'plate-update') return !(entry.detail.changed > 0 || entry.detail.ms >= 50);
  // The frame loop retries a refused grab once per second; its start/end
  // transitions remain rare. Label measurement also repeats the visible count.
  if (entry.kind === 'xr-grab' && entry.detail.event === 'rejected') return true;
  if (entry.kind === 'component-labels' && Number.isFinite(entry.detail.visible)) return true;
  // Governor steps are rare evidence; its thirty-second summaries are samples.
  if (entry.kind === 'frame-governor') return entry.detail.event === 'summary' && entry.detail.final !== true;
  if (entry.kind === 'toolbar') return entry.detail.event !== 'seat'
    && !['status', 'selectstart', 'select', 'selectend', 'hidden', 'blur', 'dim'].includes(entry.detail.phase);
  return FREQUENT_DIAGNOSTIC_KINDS.has(entry.kind)
    || (typeof rateLimitMs === 'object' && Number.isFinite(rateLimitMs?.[entry.kind]) && rateLimitMs[entry.kind] > 0);
}

/** Audio container/codec pairs a headset recorder might accept. */
export const AUDIO_MIME_CANDIDATES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]);

const KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/u;

function clampString(value) {
  const text = String(value);
  return text.length > MAX_DETAIL_STRING ? `${text.slice(0, MAX_DETAIL_STRING - 1)}…` : text;
}

function sanitizeValue(value, depth) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') return clampString(value);
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'bigint') return clampString(value.toString());
  if (type !== 'object') return undefined;
  if (Array.isArray(value)) {
    if (depth >= 2) return undefined;
    const items = [];
    for (const item of value.slice(0, MAX_DETAIL_ITEMS)) {
      // An array holds scalars or one flat object, never
      // another array. That is exactly what `headsetDiagnosticsBatchSchema` on
      // the Mac accepts, and a shape this page can record but that contract
      // cannot carry is not a lost log line — the Mac refuses the whole
      // heartbeat, the entry is never acknowledged, and the page re-sends it
      // every second until the agent has no panel to talk to at all. Keep the
      // two in step: nothing below may emit a shape the schema rejects.
      if (Array.isArray(item)) continue;
      const kept = sanitizeValue(item, depth + 1);
      if (kept !== undefined) items.push(kept);
    }
    return items;
  }
  // `detail.frame.menu.rect.left` is one object deeper than
  // `detail.frame.subject.left`. Depth three is scalars inside that extra
  // object; depth four is dropped, same as before.
  if (depth >= 3) return undefined;
  return sanitizeDetail(value, depth + 1);
}

/**
 * One small JSON-safe object. Functions, symbols, cyclic references and deep
 * nesting are dropped rather than throwing, so a caller can pass whatever it
 * has to hand.
 */
export function sanitizeDetail(detail, depth = 0) {
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    const single = sanitizeValue(detail, depth);
    return single === undefined ? {} : { value: single };
  }
  const kept = {};
  let count = 0;
  let entries;
  try { entries = Object.entries(detail); }
  catch { return {}; }
  for (const [key, value] of entries) {
    if (count >= MAX_DETAIL_KEYS) break;
    if (typeof key !== 'string' || !key) continue;
    let sanitized;
    try { sanitized = sanitizeValue(value, depth); }
    catch { sanitized = undefined; }
    if (sanitized === undefined) continue;
    kept[clampString(key)] = sanitized;
    count += 1;
  }
  return kept;
}

/** A recordable event kind, or null when the caller passed something unusable. */
export function normalizeKind(kind) {
  if (typeof kind !== 'string') return null;
  const slug = kind.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  return KIND_PATTERN.test(slug) ? slug : null;
}

/**
 * A bounded ring of diagnostic entries with a monotonic sequence.
 *
 * `since` is the whole transport contract: the page sends only what the
 * desktop has not acknowledged, and an acknowledgement is a sequence number,
 * so a dropped heartbeat re-sends rather than losing the entry.
 */
export function createDiagnosticsBuffer({ now = () => Date.now(), limit = MAX_DIAGNOSTIC_ENTRIES,
  rateLimitMs = DIAGNOSTIC_RATE_LIMIT_MS } = {}) {
  const capacity = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_DIAGNOSTIC_ENTRIES;
  let entries = [];
  let sequence = 0;
  let dropped = 0;
  let acknowledged = 0;
  const lastRecordedAt = new Map();
  return {
    record(kind, detail) {
      const slug = normalizeKind(kind);
      if (!slug) return null;
      let at;
      try { at = now(); } catch { at = Date.now(); }
      const interval = typeof rateLimitMs === 'number' ? rateLimitMs : rateLimitMs?.[slug];
      const previous = lastRecordedAt.get(slug);
      // Always retain changed plates and costly no-ops, even within a burst.
      const importantPlate = slug === 'plate-update' && (detail?.changed > 0 || detail?.ms >= 50);
      if (!importantPlate && Number.isFinite(interval) && interval > 0 && Number.isFinite(previous)
        && Number.isFinite(at) && at - previous < interval) return null;
      if (Number.isFinite(at)) lastRecordedAt.set(slug, at);
      const entry = Object.freeze({
        seq: ++sequence,
        at: Number.isFinite(at) ? Math.round(at) : Date.now(),
        kind: slug,
        detail: Object.freeze(sanitizeDetail(detail)),
      });
      entries.push(entry);
      while (entries.length > capacity) {
        // Acknowledged entries have already crossed the wire, so discard one
        // of those before applying the retention rule below. `acknowledge`
        // advances a cursor but deliberately keeps the entries for a late
        // reader; without this first pass, an all-rare acknowledged window
        // makes the newly appended frame sample the only frequent victim, and
        // frame-rate/frame-cost telemetry is starved forever until reset.
        // Within unacknowledged entries, a sampled frame may replace only
        // sampled telemetry, never a tour, error, voice, layout or seat
        // record. If rare evidence fills the buffer, this removes the incoming
        // sample itself. Rare arrivals also replace samples first; only an
        // all-rare buffer uses bounded FIFO.
        // Do not reorder retained sequences:
        // the Mac acknowledges the last sequence in each heartbeat batch.
        let index = entries.findIndex(value => value.seq <= acknowledged && frequentEntry(value, rateLimitMs));
        if (index < 0) index = entries.findIndex(value => value.seq <= acknowledged);
        if (index < 0) index = entries.findIndex(value => frequentEntry(value, rateLimitMs));
        if (index < 0) index = 0;
        entries.splice(index, 1); dropped += 1;
      }
      return entry;
    },
    /** Entries newer than `sequence`, oldest first, capped by `max`. */
    since(seq = 0, max = MAX_HEARTBEAT_ENTRIES) {
      const after = Number.isFinite(seq) ? seq : 0;
      const cap = Number.isSafeInteger(max) && max > 0 ? max : MAX_HEARTBEAT_ENTRIES;
      return entries.filter(entry => entry.seq > after).slice(0, cap);
    },
    /**
     * Mark everything up to `seq` as delivered. A lower or repeated
     * acknowledgement is ignored, so an out-of-order reply cannot rewind.
     */
    acknowledge(seq) {
      if (!Number.isFinite(seq) || seq <= acknowledged) return acknowledged;
      acknowledged = Math.min(Math.floor(seq), sequence);
      return acknowledged;
    },
    /** The entries this page still owes the desktop. */
    pending(max = MAX_HEARTBEAT_ENTRIES) { return this.since(acknowledged, max); },
    acknowledged() { return acknowledged; },
    sequence() { return sequence; },
    dropped() { return dropped; },
    size() { return entries.length; },
    all() { return [...entries]; },
    clear() { entries = []; dropped = 0; acknowledged = sequence; },
  };
}

/** The buffer this page records into. One per document. */
let buffer = createDiagnosticsBuffer();

/** Record one event. Safe to call before `installHeadsetDiagnostics`. */
export function recordHeadsetEvent(kind, detail) {
  try { return buffer.record(kind, detail); }
  catch { return null; }
}

/** Replace the page buffer. Tests use this; the page never needs it. */
export function resetHeadsetDiagnostics(options) {
  buffer = createDiagnosticsBuffer(options);
  return buffer;
}

/** The live buffer, for tests and for the heartbeat helpers below. */
export function headsetDiagnosticsBuffer() { return buffer; }

/**
 * What a `poll_inspection` heartbeat should carry, or `{}` when the page owes
 * the desktop nothing. Shaped to spread straight into the poll arguments.
 */
export function diagnosticsHeartbeat(max = MAX_HEARTBEAT_ENTRIES) {
  let pending;
  try { pending = buffer.pending(max); }
  catch { return {}; }
  if (!pending.length) return {};
  return { diagnostics: { entries: pending.map(entry => ({ ...entry, detail: { ...entry.detail } })) } };
}

/** Advance the delivered cursor from a heartbeat reply. */
export function acknowledgeDiagnostics(seq) {
  try { return buffer.acknowledge(seq); }
  catch { return 0; }
}

/** Which audio containers this browser's `MediaRecorder` claims to accept. */
export function describeMediaRecorderSupport(scope = globalThis) {
  let recorder;
  try { recorder = scope?.MediaRecorder; } catch { recorder = undefined; }
  if (typeof recorder !== 'function') return { present: false, supported: [], unsupported: [...AUDIO_MIME_CANDIDATES] };
  const supported = [], unsupported = [];
  for (const mime of AUDIO_MIME_CANDIDATES) {
    let ok = false;
    try { ok = typeof recorder.isTypeSupported === 'function' ? recorder.isTypeSupported(mime) === true : false; }
    catch { ok = false; }
    (ok ? supported : unsupported).push(mime);
  }
  return { present: true, checkable: typeof recorder.isTypeSupported === 'function', supported, unsupported };
}

function sessionModeOf(session) {
  try {
    if (typeof session?.mode === 'string') return session.mode;
    if (session?.environmentBlendMode === 'opaque') return 'immersive-vr';
    return session?.environmentBlendMode ? 'immersive-ar' : 'unknown';
  } catch { return 'unknown'; }
}

function enabledFeaturesOf(session) {
  try {
    const features = session?.enabledFeatures;
    if (!features || typeof features[Symbol.iterator] !== 'function') return [];
    return [...features].filter(name => typeof name === 'string').slice(0, MAX_DETAIL_ITEMS);
  } catch { return []; }
}

/**
 * Everything worth knowing about the device the moment presentation starts.
 *
 * The describe/classify helpers are passed in rather than imported so this
 * module stays loadable on its own and a test can supply plain fakes.
 *
 * @param {{session?:object, navigator?:object, budget?:object,
 *   describeInputSources?:(session:object)=>Array<object>,
 *   deviceClass?:(navigator:object, sources:Array<object>)=>string, scope?:object}} options
 */
export function collectSessionFacts({ session, navigator: navigatorLike, budget, plugin,
  describeInputSources = describeSources, deviceClass = classifyDevice, scope = globalThis } = {}) {
  let agent = '';
  try { agent = typeof navigatorLike?.userAgent === 'string' ? navigatorLike.userAgent : ''; }
  catch { agent = ''; }
  let sources = [];
  try { sources = typeof describeInputSources === 'function' ? describeInputSources(session) ?? [] : []; }
  catch { sources = []; }
  let device = 'unknown';
  try { device = typeof deviceClass === 'function' ? deviceClass(navigatorLike, sources) : 'unknown'; }
  catch { device = 'unknown'; }
  // The budget is what `xr-render-budget.mjs` decided for this exact device
  // and scene, so the log carries the numbers the session actually ran with
  // rather than the defaults the runtime would otherwise have used.
  let applied = budget;
  if (!applied) {
    try { applied = renderBudget({ device, atomSites: structureAtomSites(plugin) }); }
    catch { applied = undefined; }
  }
  const { supportedFrameRates, reportedFrameRate } = readSessionFrameRates(session);
  return {
    userAgent: clampString(agent),
    mode: sessionModeOf(session),
    enabledFeatures: enabledFeaturesOf(session),
    deviceClass: device,
    inputSources: sources.slice(0, MAX_DETAIL_ITEMS).map(source => ({
      handedness: source?.handedness ?? 'none',
      targetRayMode: source?.targetRayMode ?? 'gaze',
      // Array elements must be flat objects on both halves of the wire.
      profiles: Array.isArray(source?.profiles) ? source.profiles.join(',') : '',
      hasSqueeze: source?.hasSqueeze === true,
      isHand: source?.isHand === true,
    })),
    framebufferScale: Number.isFinite(applied?.framebufferScale) ? applied.framebufferScale : null,
    targetFrameRate: Number.isFinite(applied?.targetFrameRate) ? applied.targetFrameRate : null,
    foveation: Number.isFinite(applied?.foveation) ? applied.foveation : null,
    atomSites: Number.isFinite(applied?.atomSites) ? applied.atomSites : null,
    supportedFrameRates,
    reportedFrameRate,
    mediaRecorder: describeMediaRecorderSupport(scope),
  };
}

/** Ask the permissions API for the microphone, recording the answer when it lands. */
export function recordMicrophonePermission(scope = globalThis, record = recordHeadsetEvent) {
  let permissions;
  try { permissions = scope?.navigator?.permissions; } catch { permissions = undefined; }
  if (typeof permissions?.query !== 'function') {
    record('microphone-permission', { state: 'unqueryable' });
    return Promise.resolve('unqueryable');
  }
  let query;
  // Safari and some Quest builds reject an unknown permission name rather
  // than returning it, so the rejection is the answer, not a failure.
  try { query = permissions.query({ name: 'microphone' }); }
  catch (error) { record('microphone-permission', { state: 'unqueryable', reason: errorMessage(error) }); return Promise.resolve('unqueryable'); }
  return Promise.resolve(query).then(status => {
    const state = typeof status?.state === 'string' ? status.state : 'unknown';
    record('microphone-permission', { state });
    try { if (status) status.onchange = () => record('microphone-permission', { state: status.state, changed: true }); }
    catch { /* A status without a change hook still reported its state. */ }
    return state;
  }, error => { record('microphone-permission', { state: 'unqueryable', reason: errorMessage(error) }); return 'unqueryable'; });
}

function errorMessage(error) {
  if (error instanceof Error) return clampString(error.message || error.name || 'Error');
  if (typeof error === 'string') return clampString(error);
  return 'Unknown error';
}

/**
 * Follow the page's uncaught failures. Only the message and the source name
 * are recorded: a stack can carry a companion URL fragment, so it never is.
 */
export function watchPageErrors(scope = globalThis, record = recordHeadsetEvent) {
  const onError = event => {
    record('page-error', {
      message: errorMessage(event?.error ?? event?.message ?? 'Error'),
      source: typeof event?.filename === 'string' ? clampString(event.filename.split('/').pop() ?? '') : '',
      line: Number.isFinite(event?.lineno) ? event.lineno : null,
    });
  };
  const onRejection = event => record('unhandled-rejection', { message: errorMessage(event?.reason) });
  try { scope?.addEventListener?.('error', onError); scope?.addEventListener?.('unhandledrejection', onRejection); }
  catch { return () => {}; }
  return () => {
    try { scope?.removeEventListener?.('error', onError); scope?.removeEventListener?.('unhandledrejection', onRejection); }
    catch { /* The page is going away regardless. */ }
  };
}

/**
 * A rolling frame-rate estimate.
 *
 * This registers its own `requestAnimationFrame` chain on the session. A
 * session runs every registered callback per frame, so this counts real
 * presented frames without owning or interfering with Mol*'s render loop.
 */
export function watchFrameRate(session, { record = recordHeadsetEvent, now = () => (globalThis.performance?.now?.() ?? Date.now()),
  intervalMs = FRAME_RATE_SAMPLE_MS } = {}) {
  if (typeof session?.requestAnimationFrame !== 'function') return () => {};
  let stopped = false, frames = 0, since = now(), handle;
  const tick = () => {
    if (stopped) return;
    frames += 1;
    const elapsed = now() - since;
    if (elapsed >= intervalMs) {
      record('frame-rate', { fps: Math.round((frames / elapsed) * 1000 * 10) / 10, frames, seconds: Math.round(elapsed / 100) / 10 });
      frames = 0; since = now();
    }
    try { handle = session.requestAnimationFrame(tick); }
    catch { stopped = true; }
  };
  try { handle = session.requestAnimationFrame(tick); }
  catch { return () => {}; }
  return () => {
    stopped = true;
    try { if (handle !== undefined) session.cancelAnimationFrame?.(handle); }
    catch { /* An ended session has already dropped the callback. */ }
  };
}

function handOf(event) {
  try {
    const source = event?.inputSource;
    return {
      hand: typeof source?.handedness === 'string' ? source.handedness : 'none',
      ray: typeof source?.targetRayMode === 'string' ? source.targetRayMode : 'gaze',
      handTracking: Boolean(source?.hand),
      gripSpace: Boolean(source?.gripSpace),
    };
  } catch { return { hand: 'none', ray: 'gaze', handTracking: false, gripSpace: false }; }
}

/**
 * Record every select and squeeze the session emits.
 *
 * Attached before the toolbar binds its own handlers, so a press the toolbar
 * claims with `stopImmediatePropagation` is still seen here. The
 * claim itself is reported by the one-line hooks inside those modules, so the
 * Mac can tell "no event at all" from "an event nothing wanted".
 */
export function watchSessionInput(session, record = recordHeadsetEvent) {
  if (typeof session?.addEventListener !== 'function') return () => {};
  const types = ['selectstart', 'select', 'selectend', 'squeezestart', 'squeeze', 'squeezeend'];
  const handlers = types.map(type => [type, event => record(`xr-${type}`, handOf(event))]);
  for (const [type, handler] of handlers) {
    try { session.addEventListener(type, handler); } catch { /* A runtime without this event simply never reports it. */ }
  }
  return () => {
    for (const [type, handler] of handlers) {
      try { session.removeEventListener(type, handler); } catch { /* The session may already be detached. */ }
    }
  };
}

/**
 * Turn diagnostics on for one immersive session.
 *
 * Returns a `stop` the caller runs when presentation ends. Calling it twice,
 * or on a session that has already ended, is safe.
 */
export function beginSessionDiagnostics({ session, navigator: navigatorLike = globalThis.navigator, budget, plugin,
  describeInputSources, deviceClass, scope = globalThis, record = recordHeadsetEvent } = {}) {
  const facts = collectSessionFacts({ session, navigator: navigatorLike, budget, plugin,
    ...(describeInputSources ? { describeInputSources } : {}), ...(deviceClass ? { deviceClass } : {}), scope });
  record('session-start', facts);
  void recordMicrophonePermission(scope, record);
  const stopInput = watchSessionInput(session, record);
  const stopFrames = watchFrameRate(session, { record });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopInput(); stopFrames();
    record('session-end', { mode: facts.mode });
  };
  try { session?.addEventListener?.('end', stop, { once: true }); }
  catch { /* A session without events is stopped by its caller. */ }
  return { facts, stop };
}

/**
 * The first thing the Mac learns: the page is up at all.
 *
 * A companion that never loads, loads and throws, or loads without a working
 * recorder is indistinguishable from a working one on this Mac. This entry is
 * recorded before any immersion, so the log answers "did the headset open the
 * page" without the wearer entering VR first.
 */
export function recordPageOpen(scope = globalThis, record = recordHeadsetEvent) {
  let agent = '', secure = null, xr = false;
  try { agent = typeof scope?.navigator?.userAgent === 'string' ? scope.navigator.userAgent : ''; } catch { agent = ''; }
  try { secure = typeof scope?.isSecureContext === 'boolean' ? scope.isSecureContext : null; } catch { secure = null; }
  try { xr = Boolean(scope?.navigator?.xr); } catch { xr = false; }
  return record('page-open', { userAgent: agent, secureContext: secure, hasWebXr: xr, mediaRecorder: describeMediaRecorderSupport(scope) });
}

/**
 * Publish the soft hook every other module reaches through.
 *
 * The hook is deliberately a plain object of functions rather than a module
 * import: `spatial-toolbar.mjs`, `xr-buttons.mjs` and `viewer.mjs` each carry a
 * single optional-chained line, so diagnostics can be absent, replaced or
 * torn down without any of them changing.
 */
export function installHeadsetDiagnostics(scope = globalThis) {
  const hook = {
    record: (kind, detail) => recordHeadsetEvent(kind, detail),
    heartbeat: max => diagnosticsHeartbeat(max),
    acknowledge: seq => acknowledgeDiagnostics(seq),
    beginSession: options => beginSessionDiagnostics(options),
    watchPageErrors: () => watchPageErrors(scope),
    /** Everything a page should report the moment it loads. */
    begin: () => { const stop = watchPageErrors(scope); recordPageOpen(scope); void recordMicrophonePermission(scope); return stop; },
    entries: () => buffer.all(),
    pending: max => buffer.pending(max),
  };
  try { scope.__stereofoldDiagnostics = hook; } catch { /* A frozen global still leaves the exports usable. */ }
  return hook;
}
