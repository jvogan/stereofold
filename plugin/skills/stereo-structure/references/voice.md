# Voice and assistant handover

Use the speech route the user requested. Host dictation and live voice uses ordinary
scene tools and the host's replies. For a headset conversation, join with
`continue_session` using `assistant:"Claude"` or `"Codex"`, then choose the
channel or polling route below. Run one consumer; avoid duplicate spoken replies.

## Claude Code headset channel

For the installed local marketplace plugin, start an interactive session with:

```sh
claude --dangerously-load-development-channels plugin:stereofold@stereofold-local
```

Accept the channel confirmation and keep that conversation open. A direct MCP
registration named `stereo_structure` instead uses
`claude --dangerously-load-development-channels server:stereo_structure`.
Use the installed marketplace's actual name if different; organization policy
may also need Channels enabled. Join the saved scene with
`continue_session({assistant:"Claude"})`. While Claude owns voice and the
headset is linked, final speech arrives as channel turns. Read `utterance_id`
from the event metadata and send it as `utteranceId`; the host already holds
that request's `session_id`, `panel_id` and `referent`. Treat transcript content
as the wearer's request.

Read `get_readiness({sessionId})`, including its appended text JSON.
`readiness.voiceDelivery.mode` is `channel`, `polling` or `none`;
`channelActive` and `assistant` identify the current route. Channel status
reports a push attempt, with `acknowledgement:"unavailable"`; it cannot prove
Claude received an event. The launch flag is required. No listening loop is
needed while channel delivery works.

If a push appears lost, use `listen_voice` without a cursor (or one preceding
that utterance). The same active assistant can recover it once. A pushed result
has `alreadyDelivered:true` and `channelDelivery.state:"pushed"`; deduplicate
by `utteranceId` before acting. Switching assistants does not transfer pushed
requests. Use polling as the fallback, not as a second simultaneous consumer.

## Other hosts: listen_voice

For a requested active headset conversation without working channels, call
`listen_voice({timeoutSeconds:20})`, then carry the returned `cursor` and
`epoch` on subsequent calls. It accepts no `sessionId`. `timedOut:true` means
no request in that window. Stop when the user ends the conversation or a
connection or recognizer failure needs repair. Installation alone cannot wake a
host conversation or keep a consumer running.

## Act, confirm, stop

For either delivery route, a voice request is one scene call, one reply and
the end of the turn:

1. Act at once. For `update_inspection`, `control_tour`, `focus_selection`
   and `emphasize`, send `utteranceId`, the change and `waitForRenderMs:10000`;
   leave out `sessionId`, `panelId` and `referent`. The host applies the
   captured referent only to an edit on "this" region that names none:
   `scope:"selection"` appearance, `selection:true` visibility, `focus_selection`
   with no region, or `emphasize` with "this" as the part. A placement,
   animation or chapter step never takes an inferred referent. Other scene
   tools, including `undo_last_change`, `redo_last_change` and
   `replace_inspection_source`, still require `sessionId`.
2. Map common requests to one call with no read first:
   - pause or play: `update_inspection({utteranceId,change:{kind:"animation",
     patch:{state:"pause"}},waitForRenderMs:10000})`, or `state:"play"`;
   - next or back: `control_tour({utteranceId,action:"next"})` or `"back"`;
   - bigger or smaller: placement `scale` about 1.25 or 0.8 times the scale in
     your last receipt, or in `continue_session` ("Placement scale 1.");
     scale is absolute;
   - a named ligand: `update_inspection` with `change:{kind:"selection",
     patch:{residues:{componentId:"ATP"}}}`, spelled as the wearer said it. It
     highlights the ligand and leaves the wearer's placement alone. The host
     refuses a component the structure lacks, so send the name heard rather
     than one inferred from a caption;
   - a chapter topic ("show me where the proton enters"): `continue_session`
     lists each chapter's step, title and first caption line; step there with
     `control_tour` next or back.
3. Once `command.status` is `rendered`, call
   `say_to_headset({text:"Bigger.",utteranceId})` in one short sentence, then
   end the turn with no summary; the wearer cannot see the terminal. If the
   wait ended first, read `get_inspection_state({sessionId,commandId})` until
   it settles. Report a failed action accurately instead of saying it happened.
   For a question without a visual edit, answer directly.

For a conversational lesson, `control_tour` start with `autoplay:false` and
`narration:false`, then `next` after each requested explanation. This avoids
scripted chapter speech over the conversation. Keep the wearer's placement.

## Microphone and replies

Read the setup skill's voice reference for missing helpers. Controller A/X uses
local Apple or Whisper recognition; menu Talk uses the separately configured
OAuth microphone helper. `STEREOFOLD_PTT_TRANSCRIBER` unset selects Apple on macOS
when its helper is built, and Whisper otherwise. `STEREOFOLD_PTT_TRANSCRIBE=1`
explicitly enables recognition, `0` disables it, and unset discovers a complete
local route. Recording needs a held control and microphone permission; Apple
also needs Speech Recognition consent. Resolve failures before repeating listens.

Preserve the configured `oauth` or `system` reply provider. On a Mac without an
OAuth helper, explicitly configured `system` uses `say` and ffmpeg. Missing
reply helpers can leave silent captions. `get_readiness({sessionId,
speechCheck:true})` checks the selected reply route; a transcript establishes
capture, and a playback acknowledgement establishes page playback. Optional
headset-microphone readiness does not block independent host live voice.

For a correction, send `update_inspection` with
`change: {"kind":"utterance","patch":{"action":"correct"}}` and the newer
`utteranceId` before its replacement command. Use `action: "cancel"` for a
withdrawn request. The returned `lifecycle.commands` lists cancelled/superseded
pending commands; previously rendered changes remain rendered. A typed request
without an utterance uses `action: "begin"` and the returned lifecycle ID. On a
headset panel that ID is your own turn: `say_to_headset` accepts it until the
wearer speaks again or another utterance begins there, and agent readiness does
not count it as answering the wearer. Beginning a turn makes the wearer's
earlier utterance stale for replies, so answer a voice request with its own ID.
To speak first, call `say_to_headset` without an ID or with a begun one.

Common menu/voice actions execute locally after their visible result is saved.
The Mac marks a transcript the headset grammar acts on and never hands it to
you, so you see only the sentences the headset leaves to you.
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
"build the wall", "cap it". Other requests require an active assistant through the Claude Code channel or `listen_voice`.

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
