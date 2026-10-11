---
name: stereofold-setup
description: Install or repair Stereofold for Codex, Claude Code, Claude Science, or another MCP host. Discover runtime paths and helpers, register the shipped server, verify a saved inspection, and configure requested headset or voice features.
---

# Set up Stereofold

Install the shipped runtime for the user's chosen host and verify the requested
workflow. Resolve paths from the installation and host environment; preserve
existing server entries, skills, and voice providers. Configure helpers needed
for the task. Optional voice, launch, and debugging helpers affect their own
features rather than general structure inspection.

## 1. Discover

Find the plugin root: `plugin/` in a repository clone, `plugins/stereofold/` in
a generated share, or the installed plugin directory reported by the host.
From that root, run:

```sh
node skills/stereofold-setup/scripts/setup-check.mjs --no-write
```

For a delivered share, an absolute script path also works from another directory.
Replace both placeholders with the extracted share location:

```sh
node "/absolute/path/to/stereofold-share/plugins/stereofold/skills/stereofold-setup/scripts/setup-check.mjs" --root "/absolute/path/to/stereofold-share/plugins/stereofold" --no-write
```

The check uses bare Node and reports the OS, Node executable and version, runtime
files, host clues, helper programs, and private LAN addresses. It marks missing
items as `required` or `optional`, with recovery commands. Node.js 22 or newer
is required. A missing optional helper affects the corresponding feature.
If Node is absent, install the user's chosen Node distribution first.

Use `--json` for structured results and `--root /absolute/path/to/stereofold` for
an explicit installation. Omit `--no-write` when storing discovered paths in
`~/.stereofold/config.json` is part of setup; the script preserves other keys.
`STEREOFOLD_CONFIG` selects another absolute writable config path.

## 2. Obtain the runtime or standalone skill

For the full runtime, clone the
[Stereofold repository](https://github.com/jvogan/stereofold) and use its `plugin/`
directory directly, install through the repository marketplace, or use a complete
share supplied by the user. The source route includes the same three canonical
skills and committed runtime bundles. It needs Node 22 or newer and no build step
or plugin directory approval. Register the server with the user's host as
described in [Host registration](references/hosts.md).

A generated share uses marketplace name
`stereofold-local`. Extract its archive into a new directory and verify
`SHA256SUMS` from the share root:

```sh
shasum -a 256 -c SHA256SUMS
```

Use `sha256sum -c SHA256SUMS` on Linux. Reinstall or obtain a complete artifact
when checksums or required files fail; keep all runtime companions from one build.

For desktop lesson planning alone, copy the entire
`skills/molecular-presentation/` folder into the host's discovered skill
location. A common Codex location is `~/.codex/skills/`;
Claude Code uses `.claude/skills/` in the project or `~/.claude/skills/` for
personal skills. Claude Science offers skill upload and GitHub import in its
settings. Preserve the folder's scripts and assets. The standalone planner
uses Node 22 and the separately installed Molecular Structure Viewer for live
`structure.*` interaction. It does not require the Stereofold MCP server.
The `stereo-structure` skill additionally needs the runtime tools it describes.
Those tools can come from the source runtime or a plugin installation. Copying
skills alone does not register the server for live inspection or headset use.

## 3. Check dependencies

Run the setup check against the obtained plugin. Fix required gaps and the
helpers needed for the requested feature. For private headset sharing, check
OpenSSL and a reachable RFC1918 IPv4 address. Voice, Cloudflare relay, and Quest
debugging over USB or authorized Wi-Fi are optional routes described in
[Voice and helper configuration](references/voice.md).

## 4. Check the runtime

Keep `dist/server.mjs`, `dist/viewer.html`, `dist/inspector.html`,
`dist/inspector.css`, and `dist/inspector-host.js` from the same build.
`stereo_structure.open_inspector` requires `dist/inspector-host.js` to serve
its browser panel. The shipped inspector HTML marker is reconstructed with its
CSS companion at runtime; preserve both files. A headset-host installation
also includes `dist/headset-host.mjs`, `dist/serve-inspection.mjs`, and
`dist/scene-socket-relay.mjs`. Use a complete release rather than mixing bundles.

## 5. Register the host

Read [Host registration](references/hosts.md) for the current host's route:

| Host | Primary route |
| --- | --- |
| Codex CLI / app | Register the runtime with `codex mcp add`, or install the packaged plugin through its marketplace. |
| Claude Code | Register the runtime with `claude mcp add`, or install the packaged plugin through its marketplace. |
| Claude Science | **Settings** > **Connectors** > **Add connector** > **Local command**, with absolute Node and server paths |
| Other MCP host | Add an stdio server using absolute Node and `dist/server.mjs` paths in that host's configuration |

Use the host's additive registration command or UI. Preserve unrelated entries
and avoid duplicate plugin plus manual registrations for one server. Reload the
connection or start a new conversation to expose newly installed tools.
For generated shares, register the complete marketplace root using
`stereofold@stereofold-local`.

## 6. Verify the requested workflow

From the plugin root, check that the runtime starts and opens the bundled
fixture without a network request:

```sh
node skills/stereofold-setup/scripts/open-check.mjs
```

`OPEN PASS` establishes server startup and fixture loading. It does not
establish an embedded card, headset connection, or voice readiness. Check the
host's actual tool list for the Stereofold namespace; avoid relying on a
hardcoded tool count.

For focused inspection or a headset:

1. Unless the user requests a separate session, call `continue_session` with
   the actual assistant label (`Codex` or `Claude`).
   Reuse an existing session and companion.
   If `role: "none"` includes `retry: true`, retry after 5 seconds and keep the
   existing scene. After 60 seconds without recovery, inspect `recordPath` and
   its process. Preserve a live Stereofold host; create a new scene only if its
   owner is confirmed closed or stale, or the user requests one.
   Follow `external-owner-unavailable` recovery
   instructions before opening anything new.
   If its paired headset page is current, `open_companion` retains it and returns
   `headsetPage.reused` with its actual state, without another launch. Resume a
   paused page; read `in-vr` before reporting an immersive view.
2. If none exists or the user requests a new session, open the requested `.cif` or `.mmcif` with `inspect_file`,
   or a public PDB with `inspect`. Use 1CRN for an unspecified small test.
   Keep that inspection's `sessionId`; the legacy fixture ID belongs to a
   different viewer. For a native scene snapshot, read `stereo-structure`.
3. For desktop inspection, verify the MCP Apps panel or call `open_inspector`
   with `waitForSceneMs: 40000` and keep its tab open. The scene-readiness wait
   is capped at 40 seconds; if needed, poll `get_inspection_state`
   until `hasScene: true`
   and the intended panel's `current: true`, `availability: "ready"`.
4. For a headset, call `open_companion` directly. It creates a browser renderer
   when needed. Use `connection: "lan"` with `headset: "meta", launch: "auto"`,
   `headset: "apple", launch: "auto"`, or `headset: "auto", launch: "none"`.
   Continue a `sharePending` operation with the same arguments. Follow the
   returned pairing instructions and verify the current companion's rendered
   receipt and immersive state.
   For Web Launch or a Safari handoff, check every 5–10 seconds until pairing
   or `pairingExpiresAt`; let the person complete the prompts without a competing
   pairing. Recover after a reported failure or expiry. After pairing or an adb
   dispatch, allow 60 seconds for page progress, then read `manage_companion`
   with `action: "status"` and follow recovery steps. A share alone is not delivery.
   Use `manage_companion` with `action: "launch"` for a fresh launch or expired
   pairing code; do not repeatedly resend a completed setup operation.

A browser fallback verifies that browser's panel, rather than an embedded
host card. A simulator verifies its simulated runtime, rather than physical
headset behavior. Explore the user's device capabilities, supported modes, and
rendering performance; apply Quest 2 measurements only to an identified Quest 2.
A missing convenience launcher or adb connection leaves manual pairing
available. Read the `stereo-structure` skill for current connection controls.

## Optional voice

Read [Voice and helper configuration](references/voice.md) when the task needs
headset microphone transcription or spoken replies. Preserve existing voice
providers. After opening a saved scene, call `get_readiness` with
`speechCheck: true`, test microphone capture, and confirm a transcript and
playback acknowledgement. An installed helper alone does not establish consent
or an active assistant consumer.

## Repair a failure

Use the reported error to choose the next action:

| Failure | Recovery |
| --- | --- |
| Incomplete runtime files | Reinstall the complete plugin or verify a supplied share. |
| No Stereofold tools in the host | Check server paths, duplicate registrations, and connection status; reload or reconnect. |
| Public PDB lookup fails | Check RCSB reachability or use the requested local mmCIF source. |
| No panel saved the scene | Open the same session's browser inspector, or join a separately rendered headset host. |
| Stale binding or viewer build | Refresh state; reopen an outdated panel with the installed build. |
| Unsaved-work conflict | Preserve the visible work and resolve the panel's saved-view notice. |
| Headset cannot reach the host | Inspect the reported address, certificate, network reachability, and firewall permission. |
| Voice prerequisites missing | Repair the selected recognizer and reply routes and repeat readiness. |

For an unfamiliar failure, inspect the failing command and its relevant host
configuration, then make a supported repair within the requested setup scope.
Retry after the cause changes. Report an unresolved dependency with the exact
next action, preserving completed setup and usable routes.
