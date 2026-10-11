---
name: stereofold-setup
description: Get the installed Stereofold plugin working in Codex. Check its local runtime, open a molecular structure, and connect the user's requested headset or voice features. Diagnose and repair a failed connection while preserving the current scene and existing settings.
---

# Start using Stereofold

Use the installed plugin's local MCP server to open the user's structure and
verify the requested desktop or headset workflow. Continue authorized setup
and repairs within that task. Reuse the current scene, connection, and configured
providers whenever possible.

## Find the runtime

Resolve the plugin root from the installed skill: this file is at
`skills/stereofold-setup/SKILL.md`, two directories below that root. From the
root, run the bundled diagnostic with Node.js 22 or newer:

```sh
node skills/stereofold-setup/scripts/setup-check.mjs --no-write
```

Use `--json` for structured diagnostics or `--root /absolute/plugin/root` when
the skill was copied elsewhere. The diagnostic checks runtime files, executable
paths, host clues, and private LAN addresses. A missing optional helper affects
its feature; continue with the requested features that are ready.

The installed plugin declares its server in `.mcp.json`. Check the host's tool
list for the Stereofold namespace. If it is absent, inspect the installed
connection, Node executable, and server path, then reconnect or reload it.
Avoid creating a duplicate manual connection. For a source installation or
host-specific repair, use [Host registration](references/hosts.md).

Use the offline check to diagnose server startup separately from host loading:

```sh
node skills/stereofold-setup/scripts/open-check.mjs
```

`OPEN PASS` confirms that the server loads the bundled fixture. Verify the
visible inspector and headset separately. Keep all `dist/` companions from
the same build when repairing an incomplete installation.

## Open or continue the scene

Read [stereo-structure](../stereo-structure/SKILL.md) for tool schemas, live
editing, headset controls, capture, handoff, and device adaptation.

1. Call `continue_session` with assistant label `Codex` and reuse its session
   unless the user requests a separate one.
2. If a scene is needed, open the requested mmCIF with `inspect_file`, or a
   public PDB with `inspect`. Use 1CRN for an unspecified small test.
3. Verify the embedded inspector, or call `open_inspector` with
   `waitForSceneMs: 60000`. Keep its tab open. Check the intended panel's
   `current: true`, `availability: "ready"`, and the saved scene's `hasScene`.
4. Apply requested scene changes in the existing session. Confirm the matching
   rendered receipt before reporting the result as visible.

For lessons, read [molecular-presentation](../molecular-presentation/SKILL.md).
Keep the lesson's source identity, selections, chapters, and saved scene when
the user pauses to investigate or switches to a headset.

## Connect a requested headset

Call `open_companion` directly; it creates a browser renderer when needed.
For private Wi-Fi use `connection: "lan"` and the device's route:

| Device | Arguments |
| --- | --- |
| Meta headset | `headset: "meta", launch: "web"` |
| Apple headset | `headset: "apple", launch: "auto"` |
| Other WebXR browser or manual opening | `headset: "auto", launch: "none"` |

Continue a `sharePending` operation with the same arguments. Follow the
returned pairing instructions. The user completes browser permission,
certificate, pairing, and immersive-entry gestures. Verify the current
companion's rendered receipt and immersive state.

Probe the device's supported WebXR modes and input capabilities. Adapt quality,
controls, or launch method to that device; a missing launcher leaves manual
pairing available. Read the core skill's headset references for diagnostics
and supported adaptations. Keep the paired connection when changing molecules.

## Configure helpers for the requested task

Read [Voice and helper configuration](references/voice.md) for headset
transcription, spoken replies, recognizers, certificates, and optional launch
helpers. Keep existing voice providers and authentication methods. Check
`get_readiness` with `speechCheck: true`, microphone consent, a transcript, and
a playback acknowledgement before reporting voice as working.

Store discovered helper paths only when that is part of the requested setup;
omit `--no-write` for that operation. Preserve unrelated configuration. Inspect
only the relevant settings and helper paths, and keep credential values out of
messages and files. Use the host's supported permission flow for access the
requested task needs. Cross-host registration applies when the user requests
that host; its reference instructions remain available.

For a failure, inspect the reported cause and make the relevant repair. Retry
after the cause changes. Report the exact remaining dependency or user gesture
while keeping the completed setup and usable scene available.
