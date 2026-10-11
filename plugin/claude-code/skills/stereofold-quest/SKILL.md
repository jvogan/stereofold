---
name: stereofold-quest
description: Open and control Stereofold molecular scenes in a WebXR headset browser from Claude Code. Use for a public PDB, local mmCIF, illustrated lesson, or an existing shared scene; supports Meta Quest launch, Vision Pro Safari handoff, and generic browser pairing.
---

# Stereofold from Claude Code

Use the shipped `stereo_structure` MCP server for headset scenes. Terminal
Claude Code has no embedded inspector; `open_companion` opens a local browser
renderer when needed, waits for its saved scene, then shares it. Keep the host
and renderer tab open. Missing browser rendering calls for an available render
host; it does not determine the headset's capabilities.

The plugin also installs `skills/stereo-structure/SKILL.md`. Resolve that path
from the installed plugin root, rather than the project's working directory.
Read its relevant references for detailed scene commands, voice, handoffs,
and device recovery. Installation is covered by `stereofold-setup`.

## Find tools and open the scene

Discover the actual advertised tool names. Plugin installs commonly use
`mcp__plugin_stereofold_stereo_structure__stereo_structure_<verb>`; manual MCP
registration commonly uses `mcp__stereo_structure__stereo_structure_<verb>`.
Load the tools needed for the request together when tool search is available.
Ordinary opening and editing uses `continue_session`, `inspect` or `inspect_file`,
`open_companion`, `update_inspection`, and `get_inspection_state`. Add
`control_tour`, `focus_selection`, or another tool when the task needs it.

1. Unless the user requests a separate session, call `continue_session` with
   `assistant: "Claude"`. Keep an `owner` or `attached` session and any existing
   companion; replace its public source with `replace_inspection_source` if
   requested. The assistant label controls voice handover.
   If `role: "none"` includes `retry: true`, its existing host is still running:
   retry after 5 seconds and preserve that scene. After 60 seconds without
   recovery, inspect `recordPath` and its process; preserve a live Stereofold
   host. Create a new scene only if its owner is confirmed closed or stale,
   or the user requests one. Follow
   `external-owner-unavailable` recovery instructions before opening a new one.
2. If no session exists or the user requests a new one, call `inspect` with
   the requested `pdbId`, `inspect_file` with an absolute mmCIF `filePath`, or
   `inspect_lesson` with source `filePath` and `lessonPath`. Keep its `sessionId`.
3. Call `open_companion` using the route the user needs:

   | Route | Arguments in addition to `sessionId` |
   | --- | --- |
   | Meta Quest automatic | `{"connection":"lan","headset":"meta","launch":"auto","waitForHeadsetMs":20000}` |
   | Meta Quest Web Launch | `{"connection":"lan","headset":"meta","launch":"web"}` |
   | Vision Pro Safari | `{"connection":"lan","headset":"apple","launch":"auto"}` |
   | Other browser / manual opening | `{"connection":"lan","headset":"auto","launch":"none"}` |
   | Authorized Quest USB or Wi-Fi debugging | `{"connection":"lan","headset":"meta","launch":"adb","waitForHeadsetMs":20000}` |

4. If `sharePending` returns, repeat the same arguments to continue its draw
   and share. Relay the returned pairing, certificate, and XR-entry instructions.
   Keep complete credential-bearing links and codes in the tool result or
   local dialog. For Web Launch or a Safari handoff, check `get_inspection_state`
   every 5–10 seconds until pairing or `pairingExpiresAt`; let the person finish
   the prompts without a competing pairing. Recover after reported failure or
   expiry. After pairing or an adb dispatch, allow 60 seconds for page progress,
   then read `manage_companion` with `action: "status"` for recovery. Only a linked
   companion with `wearer.state: "in-vr"` establishes immersive delivery.
   An open share alone does not mean a launch was sent. Use
   `manage_companion` with `action: "launch"` for a fresh launch or an expired
   pairing code; do not repeatedly resend a completed setup operation.

For desktop inspection alone, use `open_inspector` with that session and
`waitForSceneMs: 40000`. An opening result proves a session exists; a current
ready panel and rendered receipt prove the scene drew and saved.

## Choose the browser route

Private LAN sharing needs a reachable private IPv4 address and OpenSSL on the
host. Meta Web Launch needs a host browser signed into the headset's Meta
account. `STEREOFOLD_BROWSER` names another installed browser if needed.
Press **Open** once and follow the returned headset instructions. Repeated
Web Launch can hang Quest Browser; respect its duplicate-launch refusal.

For generic pairing, open the private address from the local dialog in the
headset browser. USB debugging, a Meta account, and Universal Clipboard are
conveniences for particular launch routes. Probe the current secure context,
WebGL2, WebXR modes, enabled features, blend mode, and input sources. The
companion prefers supported passthrough and falls back to opaque VR. If the
requested feature is absent, name that API or permission and try a supported
mode or runtime, or an explicitly authored adaptation.

Quest 2 physical observations and Vision Pro simulator checks have different
scopes. Verify the user's current connection; simulator results cannot establish
physical passthrough, comfort, or perceived scale. Apply the measured Quest 2
geometry ceiling only to an identified Quest 2. Inspect actual frame times on
other devices.

## Act and confirm

Make the requested edit against the same live session. Gather state when needed
to resolve targets or verify a receipt. Common edit tools fill omitted bindings
and target the companion when attached. For a simple appearance request, pass
`sessionId`, `waitForRenderMs: 10000`, and a change such as:

```json
{"kind":"appearance","residues":{"labelChain":"A"},"patch":{"color":"uniform","uniformColor":"#ff8800"}}
```

Use selectors from the actual source. A `compound` combines two through seven
compatible changes into one render and undo. `rendered` means drawn and saved;
`queued` needs a later state read with its `commandId`. `saved` keeps a change
for a paused page. `unconfirmed` can have drawn without saving. Compare the
receipt's revision to the current scene before describing what is visible.

`replace_inspection_source` keeps the connection and replaces the public source.
`control_tour` drives a requested tour; `navigate_experience` performs authored
journey transitions. `grow_structure` needs a staged lesson and the reported
`deviceClass`. `undo_last_change` reverses the last shared operation. Read the
standard skill's command reference for those schemas and limits.

The model-side `open_detailed_view` opens the bundled full Mol* view on the
host; the headset's **Mol*** row opens it in the headset and ends XR. Its return
control sends supported work back; `.molj` import is the fallback.
`open_detailed_view`, `import_detailed_view`, and named view commands require
explicit current bindings. Read the handoff reference before calling them.

For the named `daraxonrasib` illustration, use the demo index's checked PDB
9AX6 download and `demos/daraxonrasib.json`, then `inspect_lesson` with
`assemblyId: "1"`. Plain PDB inspection opens generic tours. Use Next/Back
for conversation and edit the lesson definition for individual figure layers.

## Headset voice

Host dictation arrives as ordinary messages. Headset microphone requests need
an installed recognizer, consent, and an active conversation consumer.
Controller **A**/**X** push-to-talk uses local Apple or Whisper transcription;
the menu's **Talk** row uses a separately configured OAuth helper. Read the
standard skill's voice reference and the setup skill's helper reference before
starting this route.

Preserve the configured spoken-reply provider. For a Mac without an OAuth
helper, explicitly configured `STEREOFOLD_REPLY_VOICE_PROVIDER=system` uses
local `say` and ffmpeg. Check `get_readiness` with `speechCheck: true`, capture
one test utterance, and confirm its transcript. Then, while the requested
conversation remains active:

1. Call `listen_voice` with `timeoutSeconds: 20` and the previous `cursor`.
2. Pass its `referent` unchanged and carry `utteranceId` on the requested action.
3. Verify its rendered receipt and reply with `say_to_headset`, `text`, and
   the same `utteranceId`.
4. Stop when the user finishes or a reported prerequisite needs repair.

Handle corrections with the utterance lifecycle command before the replacement
edit. `delivered` confirms caption delivery and `audible` confirms sent audio;
verify playback acknowledgement before claiming speech played. Shared assistants
use `switch_assistant` or the wearer's handover phrase to transfer voice ownership.

## Diagnose a missing scene

Compare a panel's `diagnostics.viewerBuild` with the `viewer:` line in the share's `SHARE.md` when diagnosing mismatched installations. Reinstall the complete build and reopen an outdated panel.

Call `get_readiness` when sharing fails, a panel does not draw, or voice needs
setup. Repair the reported prerequisite. Keep the same session and renderer.
If an automatic browser launch fails, open its link from the original result
in an available local browser. A sandboxed host can join a separately rendered
`dist/headset-host.mjs` scene through the scene-service bridge. For server startup
checks, run `skills/stereofold-setup/scripts/open-check.mjs` and
`skills/stereofold-setup/scripts/setup-check.mjs` from the plugin root.
Those checks establish runtime readiness, rather than physical headset entry.
