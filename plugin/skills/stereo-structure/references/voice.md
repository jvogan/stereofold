# Voice and assistant handover

Host dictation and live voice arrive in this conversation and need no headset
listener. When the host already carries speech both ways, use ordinary scene
tools and let that host speak the response. Do not start `listen_voice` or add
headset speech unless the user chooses that route. `get_readiness` fields
`agent` and `transcription` describe the separate headset microphone route;
their absence does not block host live voice. For visual actions, check the
current panel, wearer state, and rendered receipt.

During a live demonstration, make one requested change, confirm its receipt,
then explain what to look at in a short sentence. Leave room for interruption
before advancing. Keep the same session and preserve the wearer's placement.
Start a named lesson with `control_tour` using `action: "start"`, its returned
`tourId`, `autoplay: false`, and `narration: false` for guidance through host
live voice. This holds the first chapter and disables scripted chapter speech
for that lesson. Advance with `next` after the explanation or the wearer's
request. `play` enables timed advancement while keeping the narration choice.
Without `narration: false`, chapter speech still plays when advancement is paused.

For headset microphone requests, configure transcription and replies separately.
Read the installed setup skill's voice reference when prerequisites are missing.

Controller **A** or **X** push-to-talk uses local Apple or Whisper transcription.
The menu's **Talk** row uses OAuth microphone transcription, which requires an
OAuth-only Python helper exporting `create_realtime_oauth_client_secret()`.
That helper is not bundled. Configure `STEREOFOLD_OAUTH_AUTH_HELPER`,
`oauthAuthHelper` in local config, or an installed `stereofold-oauth-auth.py`
module on PATH. Keep credentials in the user's existing credential store.

`STEREOFOLD_PTT_TRANSCRIBE=1` explicitly enables local transcription; `0`
disables it. Unset, the runtime discovers a complete local recognizer route.
Unset `STEREOFOLD_PTT_TRANSCRIBER` selects Apple on macOS when its helper is
built, and Whisper otherwise. Set `apple` or `whisper` to choose explicitly.
Apple needs a built helper, ffmpeg, and Speech Recognition consent. Whisper
needs `whisper-cli`, ffmpeg, and a readable model. Recording also requires a
held control and microphone permission. Resolve a missing recognizer before
repeating listen calls.

Replies use the configured `oauth` or `system` provider. Preserve an existing
OAuth route. For a Mac without that helper, explicitly selected `system` uses
macOS `say` and ffmpeg. An unset reply provider selects OAuth; missing reply
helpers return silent captions. Avoid silently switching providers after failure.

## Consume requests

Use this loop only while the user requests an active headset conversation:

1. Call `listen_voice` with `timeoutSeconds: 20`, and the previous answer's
   `cursor` and `epoch` after the first call. This tool accepts no `sessionId`.
   `timedOut: true` is an empty window.
2. Resolve the request against the same scene. Pass a returned `referent`
   unchanged to `update_inspection`, `focus_selection`, or `emphasize` instead
   of fabricating residue selectors. Carry its `utteranceId` on the action.
3. Wait for the rendered action receipt, then answer with `say_to_headset`,
   `text`, and that `utteranceId`; omit top-level `sessionId`, which this tool
   does not accept. Keep replies brief and describe the outcome.
4. Stop when the wearer finishes, the user stops the conversation, or a reported
   connection or recognizer failure needs repair.

Each `listen_voice` call occupies a model turn; run no unattended listening
loop after the requested conversation ends. A standalone preview host cannot
wake a Codex chat. A host that advertises text-message support can receive broad
requests privately; a queued message does not establish an executed action.

For a correction, send `update_inspection` with
`change: {"kind":"utterance","patch":{"action":"correct"}}` and the newer
`utteranceId` before its replacement command. Use `action: "cancel"` for a
withdrawn request. The returned `lifecycle.commands` lists cancelled/superseded
pending commands; previously rendered changes remain rendered. A typed request
without an utterance uses `action: "begin"` and the returned lifecycle ID.

Common menu/voice actions execute locally after their visible result is saved.
A bare "stop" pauses the tour, or stops an active spin. "Open in Mol*" uses the
headset's Mol* row; "open it on the Mac" keeps immersion and opens the host view.
Tour/growth phrases need the appropriate lesson. A failed highlight can offer
one wearer-requested retry; retain the reported refusal after another failure.
An explicit "Stop sharing" request needs `manage_companion` with the current
`sessionId` and `action: "close"`. Check `lan: null` and
`wearer.shareOpen: false` in the returned state before confirming sharing ended.
The desktop scene remains available.

## Local phrase examples

These fixed phrases work without you, matched exactly after filler is stripped:
"show molecule", "show crispr cas 9", "show tubulin", "assemble microtubule",
"add eb protein", "move overhead", "bigger", "smaller", "next", "keep going",
"back", "start the tour", "give me a tour", "stop", "pause the tour",
"zoom to selection", "show the whole thing", "show my room", "hide my room",
"vr mode", "better quality", "balanced quality", "smoother", "spin it",
"do a rotation", "rotate the molecule", "stop spinning", "hold still",
"freeze", "grow it", "add tubulin", "keep growing", "shrink it",
"build the wall", "cap it". Other requests require an active assistant consumer through `listen_voice`.

## Confirm speech and hand over

`say_to_headset` takes `text`, up to 1,200 characters. `delivered` confirms a
page accepted the caption; `audible` confirms the host rendered and sent audio.
Neither proves that the wearer heard it. For a playback claim, inspect
`voice.lastPlaybackAcknowledgement`. `speak_to_headset` also queues speech with
an explicit current companion binding; check its playback receipt.

`continue_session` uses `assistant: "Codex"` or `"Claude"` for the assistant
actually calling. Shared hosts read the same scientific scene. Only one owns
voice requests; `switch_assistant` or "switch to Codex" / "switch to Claude"
transfers ownership. Treat a handover phrase as a handover. Quiet time leaves
the active assistant unchanged.
