# Host verification for Stereo Structure

Use these checks when testing a new host, browser or headset. The local [`harness/`](../harness/) exercises two emulated host profiles. Check the actual connection before confirming a visible change.

## The acceptance run, per host

For a guided headset session, check opening a structure, playing a lesson, answering a question, highlighting the answer, editing in Mol\*, and returning to the headset. Use the steps that cover the features you plan to use.

One rule applies to every table on this page. A command returns `queued`; only a `rendered` receipt read back from `get_inspection_state` with the same `commandId` establishes that the panel drew and saved it. `control_tour`, `update_inspection`, `focus_selection`, `emphasize`, `undo_last_change`, `redo_last_change`, `replace_inspection_source`, `open_companion` and `manage_companion` need only `sessionId`: the server fills an omitted `serverEpoch`, `sourceToken`, `baseStateRevision`, `baseInspectionRevision`, `panelId` and `commandId` from the current session. Pass those fields from `get_inspection_state` when an edit made against a stale view must be refused. The tables name only what is specific to the step.

### The microtubule-growth demo

Open it with `pnpm --dir plugin run demo microtubule-growth`. The default stage is `wall`. Seven tiers run in authored order: `monomer` at 3,343 atom sites, `dimer` at 6,818, `protofilament` at 13,636, `wall` at 40,908, `filament` (a density map of 178,236 triangles and no atoms), `tube` at 177,268, and `tip` at 43,066. The catalog offers a Quest 2 every tier but the tube. The Quest 2 ceiling is 43,066 atom sites, the tip exactly, and 500,000 triangles for a density tier (`QUEST2_ATOM_SITE_CEILING` and `QUEST2_TRIANGLE_CEILING` in `plugin/src/molecular-growth.ts`). Other device classes have no assumed hardware ceiling.

The wearer grows the lesson by voice, with no agent in between. "Grow it" and "add tubulin" grow one tier. "Shrink it" steps one tier back. "Build the wall" jumps to the wall. "Cap it" jumps to the tip. The headset answers twice. It speaks a short line at the press: "Growing.", "Going back one.", "Building the wall.", or "Capping the tip." It speaks the host sentence when the tier renders: "Grown to" or "Back to" plus the tier name. A tier the headset cannot hold is refused out loud: "Too big for this headset. Staying here." Nothing on screen changes on a refusal.

Run the intended tiers on your device. Check a `rendered` receipt for each change and confirm that a Quest 2 preserves its current stage when the tube is refused. Other device classes use their observed rendering and frame times.

### The readiness gate

Check readiness before anyone puts the headset on. `stereo_structure.get_readiness` reports six capabilities — structure, share, agent, transcription, replies, headset — each `ok`, `missing` or `not-checked`, each carrying one sentence naming the next action (`plugin/src/inspection-contract.ts:601-607`). Codex desktop and Claude Science call the tool. Claude Code reads the same block over the running host's control file:

```sh
pnpm --dir plugin run doctor --share /absolute/host-share.json --speech-check
```

`--speech-check` is refused without `--share`, because only a running host can render a clip (`plugin/scripts/setup-doctor.ts:220`). Both routes print the same text through `formatReadiness` (`plugin/src/inspection-contract.ts:613-624`), so two hosts compare line for line.

Ready is one headline and six `OK` lines:

```text
Stereofold headset readiness: READY
```

Not ready names the blocking capabilities in the headline, marks each one `!!`, and prints its next action on an indented `->` line:

```text
Stereofold headset readiness: ATTENTION — share, agent
```

`--` marks `not-checked`; consult the report's `blocking` list rather than assuming that status is optional. The optional headset probe reads `not-checked` unless `STEREOFOLD_ADB_BIN` names an adb. Agent readiness requires both recent listening and a processed conversation request within `AGENT_PRESENCE_WINDOW_MS` (90 seconds); polling alone cannot establish that an assistant is answering. Transcription requires an enabled recognizer and an observed transcript in this session, so configured but unobserved capture blocks voice readiness. Reading readiness does not count as listening. Manual controls and text remain available while voice is not ready.

This transcription check covers local controller push-to-talk. The Talk button uses a separate OAuth capture route; the local recognizer's readiness does not verify that route. Prepared reply audio likewise does not prove headset playback: confirm its playback acknowledgement separately. See `get_readiness` in [`inspection-server.ts`](../plugin/src/inspection-server.ts).

### Claude Code (terminal)

Claude Code mounts no MCP App panel. The installed plugin (`claude plugin marketplace add jvogan/stereofold`, then `claude plugin install stereofold@stereofold`) registers the MCP server, and the server shows the inspector in a browser tab on this Mac instead. For a headset session, `inspect` then `open_companion` is the whole path: `open_companion` opens the inspector in the browser when no scene is saved yet and waits for it to save. For a Mac-only session, call `open_inspector` after `inspect`.

The following table drives the same steps through the standalone `quest` host from a repository checkout, over the host's loopback agent endpoint with `pnpm --dir plugin run agent <share.json> <tool> '<json>' [--json] [--wait]`. That host answers only the names in its own allowlist (`permitted` in `plugin/scripts/serve-inspection.ts`), which is narrower than the model-visible set. With the plugin, call the same tools directly.

| Step | Call or phrase | Evidence |
| --- | --- | --- |
| 1 Open my molecule | `pnpm --dir plugin run demo microtubule-growth` (Quest 2 keeps the default `wall` stage) | Lesson validated, coordinates cached against their digest, LAN address, pairing code, certificate fingerprint and expiry printed, Meta Web Launch opened; the Mac tab saves a scene; keep that tab open and in front |
| 2 Teach me | `agent … control_tour '{"action":"start","tourId":…}' --wait` | `--wait` returns the `rendered` receipt; captions advance in the headset |
| 3 Unscripted question | Wearer holds A or X for at least 150 ms, speaks, releases (`xr-buttons.mjs:44,104-105`) | `agent … listen_voice '{"timeoutSeconds":20}'` returns `transcripts` and a new cursor with `timedOut` false; the menu's top line shows Listening then the heard text. Pass the previous cursor on every later call |
| 4 Highlight the answer | `agent … emphasize '{"parts":["<lesson.parts id or label>"]}' --wait` | `rendered` receipt; `get_inspection_state` shows `view.emphasis`; named parts stay at full strength and the rest drops to 0.12 opacity. An empty `parts` list clears it |
| 5 Inspect in Mol\* | `agent … open_detailed_view '{"open":true}'` | Result reports whether a browser opened and prints the loopback address including the part after `#`; the Mac viewer carries the coordinates, appearance, camera, residue selection and labels |
| 6 Return and continue | Wearer or operator presses **Apply changes, then back to headset** in the detailed page; or `agent … import_detailed_view '{"filePath":"/absolute/state.molj"}'` once, again when the result reports `cameraPending` | `body[data-returned="applied"]` for the one press; two `rendered` receipts for the file route. Then `say_to_headset` and resume `control_tour` |

Growing the microtubule inside the session is `agent … grow_structure '{"stage":"next","device":"quest2"}'`; a tier above 43,066 atom sites is refused on a Quest 2 with a spoken line to read out (`plugin/src/molecular-growth.ts:114`).

### Codex desktop app

Codex desktop can mount the inspector in its MCP App card. Expand the card and wait for a saved scene. If that card is absent or cannot render, use `open_inspector` with the same session to draw it in a browser, or join a terminal headset host with `continue_session`. These fallback routes preserve useful controls while embedded-card behavior is investigated. The full model-visible tool set is callable. Prefer `say_to_headset` for replies. `speak_to_headset` queues a short spoken line for one bound companion panel through the configured reply provider; it is registered on every host, not only in Codex. Install from the repository marketplace (`codex plugin marketplace add https://github.com/jvogan/stereofold`, then `codex plugin add stereofold@stereofold`) and start a fresh conversation; an old one keeps the old cache.

| Step | Call or phrase | Evidence |
| --- | --- | --- |
| 1 Open my molecule | `inspect_lesson` on a tier of `plugin/demos/microtubule-growth/`, or `list_experiences` then `inspect_experience`; then `open_companion {"connection":"lan","launch":"web"}` | `get_inspection_state` reports `hasScene` true and a `current` `ready` panel; the server opens Web Launch on the Mac; press **Open** once. `manage_companion` `status` lists the Quest client and its `deviceClass` |
| 2 Teach me | `control_tour` `start`, then `play`, `next`, `back`, `pause` | `rendered` receipt at a new revision |
| 3 Unscripted question | Wearer holds A or X, or points at the **Talk** row and pulls the trigger, or pinches index to thumb looking at it | `listen_voice` returns `transcripts` and a new cursor, `timedOut` false. Call it in a loop for as long as the wearer is in the headset |
| 4 Highlight the answer | `emphasize` with `parts` from `lesson.parts`; `focus_selection` for an unnamed region | `rendered` receipt and `view.emphasis`. With no lesson loaded the call fails with a sentence naming `inspect_lesson`, rather than drawing nothing |
| 5 Inspect in Mol\* | `open_detailed_view {"open":true}` — the Mac route whatever the wearer said | Result says whether a browser opened. The headset's own **Mol\*** row loads the viewer inside the headset and ends the immersive session; that is a different destination |
| 6 Return and continue | **Apply changes, then back to headset** in the detailed page, or `import_detailed_view` once and again while the result reports `cameraPending` | Receipts `rendered`; then `say_to_headset` (1 to 1,200 characters and at most 200 words) and resume `control_tour` |

### Codex CLI

Codex CLI uses the same installed MCP server and skills as Codex desktop. A host without an embedded inspector can render the scene in a browser: call `continue_session` first, then `inspect` and `open_companion` when no shared scene exists. `open_companion` starts the browser inspector if a scene has not yet been saved. For a desktop-only check, use `open_inspector`. A terminal headset host and `continue_session` provide another working route when host permissions prevent direct browser startup. Verify the intended panel and rendered receipts in the actual connection; a CLI install alone does not establish that its headset is presenting.

### Claude Science

Install a local command connector as [docs/install.md](install.md#claude-science-local-mcp-server) describes. If the connector sandbox prevents a local headset host, start `node plugin/dist/headset-host.mjs 4HHB` from the clone root in a terminal; add `--vision-pro` for Vision Pro. Pair the headset and keep the terminal and browser tab open. Ask Claude Science to join with `continue_session`. Use absolute binary paths when the connector restricts PATH. For voice in a background connector, choose Whisper when it cannot show Apple's consent dialog.

| Step | Call or phrase | Evidence |
| --- | --- | --- |
| 1 Join and change the headset scene | Start the terminal host, pair the headset, then ask Claude Science to call `continue_session` and change the scene | Read `get_inspection_state` and a matching `rendered` receipt for each edit |
| 2 Teach me | `control_tour` | `rendered` receipt |
| 3 Unscripted question | Wearer holds A or X, or uses the **Talk** row | `listen_voice` returns the text. When the connector's permissions prevent local network access, use the shared-scene socket route or configure `STEREOFOLD_BRIDGE_DIR` on the local transcriber host and grant the agent read access to its transcript files. Check the current host's permissions rather than assuming all versions block loopback |
| 4 Highlight the answer | `emphasize`, or `focus_selection` | `rendered` receipt and `view.emphasis` |
| 5 Inspect in Mol\* | `open_detailed_view {"open":true}` | The result says whether a browser opened; the address is printed either way |
| 6 Return and continue | **Apply changes, then back to headset**, or `import_detailed_view` | Receipts `rendered`; `say_to_headset` reports `delivered` and `audible`. `audible: false` here usually means the daemon could not reach the `agent-voice` helper, and the wearer reads the caption instead of hearing it |

Neither `delivered` nor `audible` reports that the wearer heard anything: `delivered` means a connected companion page took the caption, `audible` means a clip was rendered and sent with it.

Close with `manage_companion` `action: "close"`. Sharing expires after thirty minutes without an authorized request, and after eight hours by default however active it is; pairing codes expire after ten minutes. Reopening the same share keeps its paired clients, a share opened for a new capability revokes them, and a remembered headset re-pairs with no code typed on it.

## Run the emulation harness

```sh
cd /absolute/path/to/stereofold/harness
pnpm install
pnpm test
pnpm exec tsc --noEmit
pnpm build
STEREO_PLAYWRIGHT_BROWSER=/absolute/path/to/chrome pnpm run harness
```

The default command runs `codex` and `claude-science`. It starts a loopback HTTP server, spawns the built `plugin/dist/server.mjs` once per profile over stdio, initializes an official MCP client, lists tools/resources, reads `ui://stereo-structure/viewer`, launches the profile wrapper, drives the ext-apps bridge, supplies a synthetic PDB fixture through `stereo_structure.open`, clicks `off`, `parallel`, `cross`, and `anaglyph`, and writes screenshots to `harness/out/`. The server and browser close in `finally` blocks.

The fit scenarios inside that run can record four FIT DEFECT reasons. `load-never-observed` means a structure was delivered and no report inside 30 s carried a load in flight or a fit event newer than the mark taken before the delivery (`harness/src/index.ts:1084-1093`). `mark-missing` means a structure was delivered but no panel mark was taken before it, so the frame that follows is not photographed (`harness/src/fit-scenarios.ts:597-621`). `identity-unavailable` means `__stereoStructureProbe.identity()` returned null or a mark with no `panelId`, so no panel can be named (`harness/src/fit-scenarios.ts:565-593,611-621`). `report-photo-mismatch` means the two reports bracketing a screenshot still disagree after three attempts, so no report describes the photographed frame (`harness/src/index.ts:1216-1218`). The first three have never fired in a run; each is proved by unit tests and by construction, not by a run that hit it.

## Claude Science host emulation harness

`plugin/scripts/claude-science-browser.ts` (run as `pnpm --dir plugin run test:claude-science`, optionally with `--out /absolute/artifact/directory`) is a second, more detailed emulation of the Claude Science MCP App host, separate from the profile above. It rebuilds the host's double-iframe architecture — an outer proxy page at `/mcp_apps` that creates an inner `<iframe sandbox="allow-scripts allow-forms">` (no `allow-same-origin`, no `allow-popups`) and only then assigns `srcdoc`, the `sandbox-proxy-ready` → `sandbox-resource-ready` handshake with the `SAFE_SANDBOX_TOKENS` clamp, bidirectional `postMessage` forwarding, the documented CSP applied to the guest document, host capabilities without `openLinks` (so `app.openLink()` rejects as it does in Claude Science), and the host's widget-call visibility guard. The MCP side is the real packaged `plugin/dist/server.mjs` over stdio, and panel HTML is read through `resources/read` on the `ui://` URI, matching the host's resource route.

It drives five scenarios against that emulated host: (1) `inspect` mounts, renders, and saves 1CRN in the inspector panel; (2) the model-side `get_inspection_state` call reports the revision the panel saved; (3) Open on Quest then Connect over Wi-Fi surfaces the LAN address, pairing code, and certificate fingerprint as selectable text, and exercises the known-inert controls (clipboard write, `app.openLink`, a `target="_blank"` anchor) under the sandbox clamp; (4) a model-side `update_inspection` call reaches a rendered receipt inside the sandboxed panel; (5) the `operon.dev/viewer` native drop-file binding mounts the stereo viewer. It also records mount-time measurements — proxy-load-to-handshake and `srcdoc`-assignment-to-`initialized` timings for both the inspector and viewer resources — plus console errors, CSP violations, external requests, and rejected widget calls. Results and screenshots land in the `--out` directory (default a fresh folder under `os.tmpdir()`) as `browser-report.json` and numbered PNGs.

**What this proves:** the panel's HTML, its MCP tool contract, and its handling of the documented sandbox clamp and CSP behave correctly against a faithful reconstruction of the host's protocol, driven by the real stdio server. Zero console errors, zero CSP violations, and zero external requests in a run are evidence about this emulated host, not about the real one.

This is a software emulation of the MCP Apps protocol and host sandbox. Test panel mounting, CSP behavior and input in your actual Claude Science version with [`harness/kits/claude-science.md`](../harness/kits/claude-science.md). Use the terminal headset host when an embedded panel is unavailable.

## Full Mol* detailed-view check

`plugin/scripts/detailed-view-browser.ts` (run as `pnpm --dir plugin run test:detailed-view`, optionally with `--out /absolute/artifact/directory`) drives the round trip between the cinematic panel and the complete Mol* viewer that `open_detailed_view` serves on loopback. Run `pnpm --dir plugin run build` first: the check reads `dist/server.mjs`, `dist/inspector.html` and the viewer bundle in `dist/molstar/`.

It runs seven scenarios in one Chromium instance against the real stdio server. The panel loads 1CRN, pauses rotation and saves a ball-and-stick scene on a slate background. `open_detailed_view` returns a loopback address, and the page at that address is opened in a second tab. The check then reads the live plugin: one structure, its atom count above zero, one representation, the background equal to the panel's, the camera fitted to the structure rather than copied from the panel, and a canvas screenshot whose foreground pixel count is above 500. It changes opacity and background in the detailed viewer, moves its camera, saves a real `.molj` through `plugin.managers.snapshot.serialize`, and calls `import_detailed_view` twice: the first call queues the appearance, the second the framing. Both are checked through to a rendered receipt and a saved scene. The sixth scenario uses the button a user presses: it changes the detailed viewer again, clicks **Apply changes, then back to headset**, and requires `body[data-returned="applied"]` and the new appearance in the panel's saved scene, with no file and no agent in between. The seventh calls `recall_headset` and requires the detailed page to show the queued sentence and arm the one-tap re-entry hint.

Adding `--demo <name>` (for example `--demo crispr-cas9`) appends the lesson leg, which is the only part that exercises named parts. It opens the demo lesson in a second panel, reads `lesson.parts`, lights one part through the agent's own `emphasize` tool, and counts pixels near that part's own color. It then hands the whole thing to the full viewer, requires the handoff to name the lit part on the page and to report `emphasis-colours` as not carried, presses the return button, and requires the returned background in the panel together with an unchanged `view.emphasis`, an unchanged `lesson.parts` and the part still drawn in its color. Artifacts land in the `--out` directory as `detailed-view-report.json`, `download-state.molj` and the PNGs. The process exits 1 if any scenario fails.

**What this proves:** the generated detailed page builds the panel's structure through the stock Mol* builder API and draws it, the handoff carries the coordinates, appearance and camera the panel had, Download State produces a state file this server accepts, both legs of the import reach rendered pixels in the panel, and the one-press return does the same over the page key with no file. With `--demo`, it also proves the lesson's named parts and the emphasis on them survive the trip out and back. Zero page errors and zero external requests in a run mean the page needs nothing but this Mac.

**What this does not prove:** it says nothing about how a host opens the address. With `open: true`, the server opens the address in this Mac's default browser itself; this separate Mol* view has not been verified in Claude Science. The verified headset route uses a terminal host and `continue_session`. Headless Chromium renders through a software rasterizer, so the run reports that geometry drew, not that it drew at a usable frame rate on real hardware.

## Headset browser rehearsal

`plugin/scripts/companion-browser.ts` drives the real companion through an IWER
headset simulation. For example, from `plugin/`:

```sh
pnpm exec tsx scripts/companion-browser.ts /absolute/path/to/new-evidence \
  --xr-runtime /absolute/path/to/iwer.min.js --mode vr \
  --demo daraxonrasib --tour chapters --browser-channel chromium
```

The default `--browser-channel shell` uses Playwright's headless shell.
`--browser-channel chromium` selects its full Chromium browser in headless mode;
install that browser with `pnpm exec playwright install chromium` if needed.
See [Playwright's browser modes](https://playwright.dev/docs/browsers#chromium-new-headless-mode).

Check `xrReviewViewport.renderer` in `browser-report.json` before interpreting
timings. Software rendering can stall long enough to miss a connection
heartbeat. The report records long tasks, capture durations and failed-request
timings to help locate those stalls. Both modes retain the same pixel, receipt,
request and restoration checks. Preserve failed reports when comparing modes.
Neither mode measures Quest frame rate or wearer comfort.

## Live check inside a host

A screenshot of a clipped stereo pair in a Codex side panel fits several different wrong values, so this check reads the numbers instead. The following steps verify or refute the fit in a real host.

Prerequisite: install the plugin as [Real-host qualification](#real-host-qualification) describes, then open a fresh conversation.

1. Load 1CRN: call `stereo_structure.open` with `pdbId` `1CRN`, then copy the server-issued `sessionId` from `structuredContent`. The render result deliberately contains no coordinate text.
2. Choose Parallel in the mounted viewer, or call `stereo_structure.set_mode` with that `sessionId` and `mode: "parallel"`, followed by `stereo_structure.open` with only the same `sessionId` to render the changed session. Reproduce the clip on screen.
3. Call `stereo_structure.get_state` with that `sessionId` and read `structuredContent.diagnostics`. If `diagnostics` is absent, no panel in that session has reported yet; wait a few seconds and call again.
4. Read `diagnostics.viewerBuild` and compare it with the hash this command prints (never hardcode a hash):

```sh
pnpm --filter stereo-structure smoke
```

```text
SMOKE PASS: stdio tools/resources/resource HTML verified; viewer build <hash>.
```

`viewerBuild` is the sha-256 of the shipped `viewer.html` with its stamp blanked (`plugin/src/viewer-build.ts:11-17`); `smoke` recomputes it from `dist/viewer.html` (`plugin/scripts/smoke.ts:312-318`). If the mounted build does not match, the restage did not take and every other field is meaningless.
5. Read `diagnostics.camera.fill`: 0.86 is a correct fit (the projected sphere diameter over the shorter eye side, `plugin/src/fit-diagnostics.ts:158-165`). About 3.0 or more means the camera is still at the mono fit distance inside a 238 px eye.
6. Check the ratio before trusting `fill`. Compute:

```text
geometry.stereoEyeViewports.left.width / host.devicePixelRatio
```

and compare it with `geometry.eyeViewportCssPx.width`. They must agree (up to rounding). `fill` is computed from the viewer's CSS eye estimate, so it can read 0.86 while the draw pass renders into a different rectangle; only this ratio catches that. If they disagree, `fill` is not trustworthy: read `camera.fillFromDrawPass` instead (it is the same projection against the draw pass's actual eye viewport, or null when no stereo frame has drawn in the last second, `plugin/src/fit-diagnostics.ts:166-183,193`). `stereoEyeViewports` is absent until a stereo mode has drawn at least once (`plugin/src/fit-diagnostics.ts:116-131`).
7. Press the on-screen toolbar Fit button (`#fit-view`, beside Swap). This checks the panel you are looking at; a model-side `control` call changes server state but is not a substitute for pressing the control in that mounted panel. The button runs a fit, records a `button` event, and flushes a report at once.
8. Call `stereo_structure.get_state` again with the same `sessionId` within a second and confirm the last entry of `diagnostics.fit.events` has `trigger` `button`. Otherwise the answer may be an older panel from the same session (see [Which panel answered](#which-panel-answered)).
9. Paste both `diagnostics` objects (before and after the press) into the conversation.

### What the fields mean

| Field | Healthy | Wrong implies |
| --- | --- | --- |
| `viewerBuild` | Equals the `smoke` hash | Stale bundle mounted; ignore everything else |
| `sequence` | Rises from 1 per panel (see the report-sequence helpers in `plugin/src/fit-diagnostics.ts` and the diagnostics sender in `plugin/src/viewer.ts`) | A gap is a dropped send; the server drops a report that goes backwards for its own panel (see report acceptance in `plugin/src/server.ts`) |
| `panelId` | Stable per mounted viewer; matches one entry of `diagnosticsPanels` | Absent means an older viewer build (`plugin/src/schemas.ts:272-274`) |
| `camera.fill` | 0.86 | Above ~0.9 is clipping; ~3.0 or more is the mono-distance camera in an eye |
| `camera.fillFromDrawPass` | Agrees with `fill` | Disagreement means the CSS eye estimate is wrong: trust this one. Null means no stereo frame in the last second |
| `camera.distanceToTargetAng` | Still after a fit | Moving with no new `fit.events` entry while `fit.lastDecision` stays `keep` means something other than the fit moved the camera |
| `camera.inTransition` | `false` at rest | `true` means the camera is mid-transition: wait and re-read |
| `fit.loadInFlight` | `false` at rest | `true` means a load the panel started has not finished: any reading now is premature |
| `fit.lastDecision` | `keep` with `current` equal to `fitted` after settling | A `refit` against a geometry that never arrives, or `keep` while `fittedGeometry` disagrees with the eye window, is the mis-fit signature |
| `fit.events` | Last entry is `button` right after the press; at most the last 12 fits travel (`plugin/src/fit-diagnostics.ts:254`) | No entry for a load or mode change that happened means that trigger never fitted |
| `state.mode` | The mode chosen (`parallel`) | Anything else means the mode never arrived at this panel |
| `state.fallback` | `tries` 1, `done` true | `tries` above 1 means the server did not answer the first `get_structure`; `done` false with a `lastError` means a retry is still pending and the panel is empty but not yet told (`plugin/src/fit-diagnostics.ts:286-295`) |
| `user.wheelEventsSinceFit` | 0 | Above 0 means someone scroll-zoomed after the fit: the framing is theirs, not a defect |
| `diagnosticsPanels` | The answering `panelId` is listed with its `viewerBuild` and `lastTrigger` | Extra entries are earlier tool cards that are still mounted and heartbeating (see [Which panel answered](#which-panel-answered)) |
| `diagnosticsPanels[].answering` | Present, always `true`, on the one entry `diagnostics` came from | Absent on every other entry, and absent from the whole list when the answering panel has been quiet longer than 30 s — which is itself the reading that the answer is stale (`plugin/src/panel-reports.ts:57-64,201`) |

### Cost

The heartbeat is 1 Hz only for 5 s after the last change and every 10 s after that (see `DIAGNOSTICS_HEARTBEAT_MS`, `DIAGNOSTICS_ACTIVE_MS`, and `DIAGNOSTICS_IDLE_HEARTBEAT_MS` in `plugin/src/viewer.ts`), so an idle mounted panel costs 6 calls a minute. Bursts are bounded separately: at most one send per second (`DIAGNOSTICS_MIN_GAP_MS`) and flushes collapse inside 250 ms (`DIAGNOSTICS_FLUSH_MIN_GAP_MS`). A coalesced send keeps the highest-priority pending trigger, `button` over `decision` over `mode` over `heartbeat` (see `REPORT_TRIGGER_PRIORITY` in `plugin/src/fit-diagnostics.ts`), so a Fit press is never reported as a heartbeat. A panel that is merely rocking reports at the idle rate: the rock moves the camera without moving the eye viewport or the scene radius, so the refit decision stays `keep` and nothing reports (see the rock/report decision logic in `plugin/src/fit-diagnostics.ts`).

### Which panel answered

Only `stereo_structure.open` renders a card. Earlier open cards created with the same `sessionId` can stay mounted and keep reporting, while cards from other sessions are isolated. Within one session the server keeps reports per panel — at most eight, with the quietest panel evicted — and rejects a report whose `sequence` moves backwards for that panel. `get_state` chooses the newest settled recent report in that session. `diagnosticsPanels` lists its recent panels as `{ panelId, at, sequence, viewerBuild, lastTrigger }`, with the answering entry first and marked `answering: true`.

A panel whose load is still in flight does not answer while an older settled card is live, so check that the entry marked `answering: true` in `diagnosticsPanels` has the `panelId` of the panel you are looking at, and call `get_state` again a second later if it does not. No entry carries the mark when the answering panel has been quiet longer than the window, which is itself the reading that the answer is stale; if several panels are listed, close or ignore the older cards and repeat the button check.

From the repository root, if a Playwright browser is not already available,
install it into temporary state rather than application or user-library directories:

```sh
cd harness
export PLAYWRIGHT_BROWSERS_PATH="$(mktemp -d "${TMPDIR:-/tmp}/stereo-harness-playwright-browsers.XXXXXX")"
pnpm exec playwright install chromium --no-shell
stereo_browser_path="$(pnpm exec node --input-type=module -e 'import { chromium } from "playwright"; process.stdout.write(chromium.executablePath())')"
STEREO_PLAYWRIGHT_BROWSER="$stereo_browser_path" pnpm run harness
```

The harness supports `--profile codex`, `--profile claude-science`, and `--profile all`.

The harness is its own pnpm workspace, outside the repository's, so it keeps package-local `test` and `build` scripts. The root `pnpm test` runs its suite through `pnpm run test:harness`, after the workspace and lab suites.

## What the numeric/browser checks prove

The one-line summary has this form:

```text
SUMMARY <profile>: mounted yes/no, console errors N, CSP violations N, WebGL2 available yes/no, mode switch succeeded yes/no
```

- `mounted yes` proves the supplied HTML executed in the profile’s synthetic frame, the app completed the `ui/initialize` handshake, reported `CONNECTED`, and created a Mol* canvas. It does not prove a real desktop host mounts the app.
- `console errors N` and `CSP violations N` are Playwright observations from that browser run. Zero is evidence that this synthetic wrapper did not report those errors; it is not proof of real-host parity.
- `WebGL2 available yes` is an independent `canvas.getContext('webgl2')` probe in the test browser. It does not prove WebGL2 is available in either desktop host.
- `mode switch succeeded yes` proves each mode button became active and the view’s app-only `stereo_structure.sync_view` call reached the real stdio server and returned. It does not prove stereo pixels, anaglyph color separation, correct eye comfort, or human fusion.
- The screenshots support software checks. A wearer evaluates depth, comfort and input reach on the actual headset.

The pre-browser MCP checks prove the server contract only: the built server exposes the namespaced tools `plugin/scripts/smoke.ts` asserts by name (64 registered tools at this checkout — 37 model-visible and 27 app-only), two `text/html;profile=mcp-app` resources at `ui://stereo-structure/viewer` and `ui://stereo-structure/inspector`, and server-issued session capabilities without model-visible coordinates. They do not prove either app mounts.

## Profile models and citations

Codex is modeled as a direct sandboxed app iframe using `allow-scripts allow-forms allow-same-origin`, with no network `connect-src` and `blob:` resource support.

Claude Science is modeled as a local-proxy handshake: proxy-ready notification, host `sandbox-resource-ready`, inner `srcdoc`, bidirectional forwarding, and the strict inner sandbox allowlist without `allow-same-origin`. Its CSP model includes the listed CDN origins, `worker-src 'self' blob:`, `media-src 'self' blob: data:`, and `frame-src 'none'`.

The harness uses `AppBridge` and `PostMessageTransport` because the installed `@modelcontextprotocol/ext-apps@1.7.5` package exports both from `app-bridge`; its server-side client is the official `@modelcontextprotocol/sdk` `Client` plus `StdioClientTransport`. No custom wire format is substituted. The custom Node callback only forwards `tools/call` into the MCP client.

## Real-host qualification

Install the plugin in the host under test:

- Codex: `codex plugin marketplace add https://github.com/jvogan/stereofold`, then `codex plugin add stereofold@stereofold`. [`harness/kits/codex-personal-plugin.md`](../harness/kits/codex-personal-plugin.md) describes `install-codex.sh`, an optional source installer with explicit profile and local marketplace selection.
- Claude Science: add a `stereofold` entry to the `servers` array in `~/.claude-science/mcp/local-mcp.json`, with the absolute path of `node` as `command` and the absolute path of your clone's `plugin/dist/server.mjs` in `args`. [`harness/kits/claude-science.md`](../harness/kits/claude-science.md) explains the optional `env` entries, and [`harness/kits/claude-science-local-mcp.json`](../harness/kits/claude-science-local-mcp.json) is a complete template that points at `plugin/dist/server.mjs` in a clone.

For Codex, start a new conversation after adding the local plugin and verify the model-visible tools, which Codex names `mcp__stereo_structure__stereo_structure_<name>`. Do not rely on a count typed into a document; `pnpm --filter stereo-structure smoke` asserts the list by name and is the copy that is kept current. At this checkout there are 37 model-visible tools: `continue_session`, `open_inspector`, `recall_headset`, `switch_assistant`, `undo_last_change`, `redo_last_change`, `inspect`, `inspect_file`, `inspect_scene`, `inspect_lesson`, `inspect_experience`, `list_experiences`, `navigate_experience`, `grow_structure`, `open_companion`, `manage_companion`, `control_tour`, `get_inspection_state`, `get_readiness`, `update_inspection`, `manage_inspection_view`, `emphasize`, `focus_selection`, `replace_inspection_source`, `open_detailed_view`, `import_detailed_view`, `say_to_headset`, `speak_to_headset`, `listen_voice`, `capture_headset_view`, `read_headset_browser`, `read_headset_log`, `open`, `control`, `get_state`, `set_mode`, and `set_motion`. `inspect`, `inspect_file`, `inspect_scene`, `inspect_lesson`, and `inspect_experience` mount `ui://stereo-structure/inspector`; `open` mounts `ui://stereo-structure/viewer`. `open_companion` returns a capability for a saved inspection; do not publish its URL. Default loopback is local browser access. With `connection: "lan"`, it returns a private HTTPS address, one-time pairing code and certificate fingerprint. `manage_companion` lists/revokes paired clients or stops sharing. Legacy `connection: "https"` explicitly uses Cloudflare; it is never the LAN fallback. Browser and IWER acceptance do not establish physical headset qualification. The remaining 27 app-only tools handle hydration, synchronization, diagnostics, and leases; they never appear in the conversation. A separately installed Molecular Structure Viewer may remain under `structure.*`; qualify Stereofold by its namespace. Native-file preview precedence with concurrent structure viewers is unknown, so test the explicit Stereofold tool routes rather than infer ownership from a panel title. Apply rollback by hand using the kit.

For Claude Science, add the JSON entry by hand, grant read access only to the
directory that holds the server in `args` if prompted (the clone's `plugin/`
directory, or `plugin/release/stereofold/` for the staged release), restart Claude
Science and reconnect the connector. `stereo_structure.open` and
`stereo_structure.inspect` declare viewer and inspector resources; check panel mounting in the current host.

The server's
`CLAUDE_SCIENCE_VIEWER_BINDING` and `stereo_structure.open` registration
declare the optional `operon.dev/viewer` file-binding metadata on `open` only:
`opensMimeTypes`, `opensExtensions`, `contentParam` (`structureText`),
`contentEncoding` (`utf8`), and `promptHint`, with `nameParam` deliberately
omitted. `inspect` has its own MCP App resource but no automatic native-file
binding. Verify automatic file preview in the host version you use, especially when
another structure connector is installed. To remove a manual registration,
remove only its server entry and restart the connector. For a connector with
restricted local networking, join a terminal headset host with `continue_session`.

## Device and host coverage

The private-LAN route has rendered structures in Quest Browser on a Quest 2.
Claude Science has joined a terminal host and changed the shared structure on
that device and in Safari in the visionOS 27 simulator. Physical Vision Pro
results remain to be collected. Connect other WebXR devices by probing their
browser's session modes and inspecting actual rendered receipts and frame times.

When checking a new installation, verify the features you use:

- embedded panel mounting or the browser inspector;
- explicit Stereofold tool names and automatic file preview when enabled;
- WebGL2, iframe policy and panel dimensions in the current host;
- headset entry, visible structure, input reach and menu readability;
- microphone transcription and reply playback when voice is enabled;
- perceived depth, eye order, comfort and audio quality with a wearer.

A missing optional capability should guide setup of that feature. Keep working
with the controls and routes that are available.
