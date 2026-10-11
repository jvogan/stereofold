# Stereofold — Claude Code kit

Install Stereofold in Claude Code from the repository marketplace, then start
a fresh Claude Code session:

```sh
claude plugin marketplace add jvogan/stereofold
claude plugin install stereofold@stereofold
```

The plugin registers the Stereofold MCP server and its skills, including
`stereofold-quest`. Claude Code runs in a terminal and mounts no MCP App panel,
so the server opens the inspector in a browser tab on this Mac instead. For a
new headset session the agent calls `inspect`, then `open_companion`; when no
scene is saved yet, `open_companion` opens that tab and waits for the scene to
save. For a Mac-only session it calls `inspect`, then `open_inspector`.
`continue_session` joins a scene already shared on this Mac.

Most of this kit describes the optional standalone route from a repository
checkout. The `quest` command runs a standalone desktop host, lets a browser
tab act as the panel, and drives the session over the host's loopback agent
endpoint. That route needs the checkout at `/absolute/path/to/stereofold`, its
workspace dependencies (`pnpm install --frozen-lockfile`) and `plugin/dist`,
not the release artifact.

[Host verification](../../docs/host-verification.md) lists checks for a new host or device.

## One command

With the repository built, this is the whole standalone route:

```sh
pnpm --dir plugin run quest 1CRN
```

It checks the machine, starts the standalone host, opens the desktop panel that
does the rendering, waits for the saved scene, opens private Wi-Fi sharing, and
prints the address, pairing code, certificate fingerprint and expiry for the
person wearing the headset. It stays in the foreground; Ctrl-C stops sharing and
closes the session. A paired Quest prints one status line.

The same command does two things for the wearer. It prints a Meta Web Launch
link and opens it, so the page opens on the headset with nothing typed there, and it records the headset microphone so `listen_voice`
has something to return. `--no-web-launch` and `--no-ptt` turn them off, and
`--headless` turns both off because that run renders for a test rather than for
a wearer. It renders in Playwright's Chromium, which the package install does
not download; run `pnpm --dir plugin exec playwright install chromium` once
first.

```sh
pnpm --dir plugin run quest /absolute/structure.cif      # local coordinates, no PDB download
pnpm --dir plugin run quest 1CRN --tour fold-detective   # a tour, once the headset pairs
pnpm --dir plugin run quest /abs/1crn.cif --lesson /abs/lesson.json
pnpm --dir plugin run quest 1CRN --headless              # render the panel in headless Chromium
pnpm --dir plugin run quest 1CRN --browser "Google Chrome"   # open the links in a named browser
```

`--browser` names the application `open -a` hands both links to: the desktop
panel and Meta's page. Web Launch only reaches the headset from a browser
signed in to the same Meta account, and the Mac's default browser is often not
the one holding that session. `STEREOFOLD_BROWSER` sets the same thing for
every run, including for a host with no terminal. Unset, the links go to the
Mac's default browser, and the command prints one line saying which browser it
used.

`--browser`, `--web-launch`, `--open-on-quest` and `--no-remember` are
described in the next section.
`--lan-host` picks one assigned private IPv4 address and `--lan-port` replaces
the default port, 8443. `--state` moves the control file. `--allow-stale-build` runs an existing
`plugin/dist` that only looks older than `plugin/src`, which the doctor decides
by modification time. `--help` lists them.

The desktop address the host prints carries a key after `#`:
`http://127.0.0.1:<port>/#<key>`. That fragment is the page key. Browsers
never send a fragment to the server, and opening the address without it shows
an explanation instead of mounting the inspector. `quest` passes the whole address to your
browser and never prints the key. If you start the host by hand, copy the
address whole.

## One press to the headset

Four routes put the page on the headset without anyone typing on it. Try them
in this order.

### 1. One tool call

`open_companion` opens the Web Launch link itself, so this route needs no
terminal and works from every host, including Claude Science and Codex:

```json
{"connection": "lan", "launch": "web"}
```

The server runs `/usr/bin/open` on the link and the tool result says in words
what happened, then lists the five headset steps: `Browser started for the Web
Launch link in your Mac browser. 1. On Meta’s page, click Open once; that
browser must be signed in to the headset’s Meta account. 2. If macOS asks
whether node may accept incoming network connections, click Allow. 3. Put the
headset on and select the Web Launch notification. 4. If Quest Browser says
“Your connection is not private”, select Advanced, then Proceed. 5. Tap Enter
VR.` The agent relays the steps once, then reads `get_inspection_state` until
`wearer.state` is `in-vr` instead of asking the person in the headset.

`launch: "adb"` uses the adb route (route 3) instead, and `launch: "none"` is the
default. `launch` requires `connection: "lan"` and is refused on any other
transport. To launch again for a companion that is already open, call
`manage_companion` with `action: "launch"` and `launch: "web"`; it reuses the
running listener and mints a new pairing code only if the old one expired.

`STEREOFOLD_OPENER` replaces `/usr/bin/open` with any absolute path, which is
how the test harnesses record the link instead of opening a browser.

### 2. Meta Web Launch from the terminal

```sh
pnpm --dir plugin run quest 1CRN                            # on by default
pnpm --dir plugin run quest 1CRN --browser "Google Chrome"  # in a named browser
pnpm --dir plugin run quest 1CRN --no-web-launch            # skip it
```

This prints one link and opens it, in `--browser` or `STEREOFOLD_BROWSER` when
one is named and in the Mac's default browser otherwise. Either way the command
prints one line naming the browser it used. A named browser that is not
installed falls back to the default and says so, because the launch is detached
and a failed `open -a` would otherwise show no error. Meta's page shows an **Open**
button. Press it once and the page appears on the headset.

It needs the same Meta account signed in on that browser and on the headset,
and the headset powered on and joined to this Wi-Fi. Accept the certificate
warning the first time, then tap **Enter VR**.

The link carries this run's one-time pairing code in the target's fragment, so
the code travels to Meta's servers inside the link; it expires in ten minutes,
is spent on first use, and opens nothing off this Wi-Fi. Pass
`--web-launch=no-code` to leave the code out and rely on the device key a
remembered headset already holds. Under `--headless` the link is printed but no
browser is opened.

On a repeat run the code is left out for you. Before the link is built, the
command reads `manage_companion` status; when this Mac already remembers a
headset, it uses the no-code variant so the code never reaches Meta at all, and
prints which variant it used. `--web-launch=code` pins the coded link, and
`--web-launch=no-code` pins the other; a bare `--web-launch` or no flag leaves
the choice to the remembered list.

### 3. A Quest connected over adb

```sh
pnpm --dir plugin run quest 1CRN --open-on-quest
```

`--open-on-quest` opens the address on a Quest that is already connected over
adb. It needs developer mode on the headset, wireless debugging paired to this
Mac, and adb on `PATH`, in `/opt/homebrew/bin`, or in
`~/Library/Android/sdk/platform-tools`. With exactly one device listed in state
`device`, it runs:

```sh
adb shell am start -a android.intent.action.VIEW -d https://<private IPv4>:8443/#pair=<code>
```

The fragment carries only the one-time code, and only because adb runs over a
debugging connection the headset already authorized for this Mac. No session
token and no device key ever reaches an adb command line. `--open-on-quest=no-code`
omits the code. With no adb, no device, or more than one, the run prints one
hint and continues; nothing is ever installed for you.

The same connection carries Quest Browser's debugger, so an agent can read the
headset page's console and XR state instead of guessing from a screenshot. It
needs adb reachable, developer mode on the headset, and one port forward,
`adb forward tcp:9333 localabstract:chrome_devtools_remote`. After that,
`pnpm --dir plugin exec tsx scripts/headset-devtools.ts state` reports the page, the
immersive session and the blend mode; `… console` prints the page's console
output plus the network and security failures the browser recorded for the page;
and the `read_headset_browser` tool returns both to the assistant. All three are
read-only. `STEREOFOLD_DEVTOOLS_PORT` changes the port.

### 4. The Quest home screen

After the page first opens in the headset, add it to the Quest home screen from
the browser menu. Later visits open straight into the molecule: the page presents a device
key it kept from that pairing, and the Mac issues a fresh thirty-minute session
without a code. **Enter VR** still needs one tap, because a browser starts an XR
session only from a gesture.

The key is 32 random bytes held in that browser's own storage for the address.
The Mac stores only its SHA-256 digest, in
`~/Library/Application Support/Stereofold/lan/remembered-devices.json`, mode
600, beside the LAN private key. It expires after thirty days. A remembered
headset gets the same bounded session a typed code gets: it joins the listener
that is running now, never starts one, and cannot take a listener another
session owns.

Forget a headset with `manage_companion`. `action: "status"` lists the
remembered devices with their id, label, last-seen time and expiry;
`action: "forget"` with that `deviceId`, or `"all"`, revokes the key and ends
that headset's live session. Pass `--no-remember` to `quest` to keep a run on
the pairing code alone.

Typing the code stays available. The wearer block the run prints carries the
address and the code, and the pairing form is still there when a link route
fails.

### When the headset dims every ten seconds

Send the Web Launch link once and press **Open** on it once. Two sends ten
seconds apart hung Quest Browser in a 2026-09-11 test: Android put its
"com.oculus.browser isn't responding" dialog over the wearer every ten seconds
for the rest of that session, which looks like the whole world dimming for a few
seconds at a time, pauses any running tour, and makes agent commands come back
as "companion busy". Only pressing **Close app** inside the headset ended it.
The host refuses a second Web Launch within one minute and says why.

With adb configured, the agent can read the cause instead of guessing. Both
`manage_companion` with `action: "status"` and `capture_headset_view` return a
`browser` field: `"anr"` with the headset's own log line and the time Android
declared it, `"ok"`, or `"unknown"` when this Mac has no cable.
`manage_companion` with `action: "recover-browser"` clears it without the wearer
touching anything: it runs `adb shell am force-stop com.oculus.browser`, which
takes the dialog down with the process, reopens this session's LAN companion
with the same VIEW intent as route 3 rather than another Web Launch, and says
"Restarting the headset browser." and then "Back. Tap Enter VR." in the headset.
It refuses without adb and refuses a healthy browser unless you pass
`force: true`. With no cable, the wearer presses **Close app**.

## Install the skill

The marketplace install at the top of this kit already includes the
`stereofold-quest` skill. To install the complete plugin from this checkout,
run `bash harness/kits/install-claude-code.sh --preview`, then rerun without
`--preview`. Add `--build` to rebuild stale bundles. The script uses Claude
Code's marketplace commands and supports `--uninstall`.

## Set up the standalone route (once)

1. Build the standalone runtime:

   ```sh
   cd /absolute/path/to/stereofold
   pnpm install --frozen-lockfile && pnpm run build
   ```

   This produces `plugin/dist/server.mjs` and `plugin/dist/inspector.html`.
   `pnpm --filter stereo-structure release` builds the separate release
   artifact and is not used by this route.

2. Create the private directory for session control files. If you did not
   install the plugin, also link the skill on its own; this installs guidance
   only, not the MCP server:

   ```sh
   mkdir -p -m 700 ~/.stereofold
   mkdir -p ~/.claude/skills
   ln -s /absolute/path/to/stereofold/plugin/claude-code/skills/stereofold-quest \
     ~/.claude/skills/stereofold-quest
   ```

   Claude Code loads a directory under `~/.claude/skills/` that holds
   `SKILL.md` at its top as a personal skill.

3. Restart Claude Code so it reads the skill.

4. Check the machine before the first session:

   ```sh
   pnpm --dir plugin run doctor
   ```

   This read-only check reports runtime prerequisites, missing or older build
   files, this Mac's assigned private IPv4 addresses, and whether the sharing
   port already listens. Add `--json` for a machine-readable report. It never
   opens a connection or changes network settings.

   Its last line, `build · viewer <hash> · inspector <hash>`, identifies the
   bytes this checkout serves. The standalone host prints the same line at
   startup. A mounted stereo-viewer panel, opened with `stereo_structure.open`,
   reports the viewer half back as `diagnostics.viewerBuild` in
   `stereo_structure.get_state`; `get_inspection_state` does not return it.
   Codex installs its own copy of the release. To find two hosts running
   different builds of the same plugin, compare this line with the hash
   Codex's panel reports.

## What to say to Claude Code

> Show 1CRN on my Quest.

With the plugin installed, Claude Code calls `inspect`, then `open_companion`,
as the `stereofold-quest` skill describes. On the standalone route it runs
`pnpm --dir plugin run quest 1CRN` instead. That starts the host,
opens the panel address in your browser, polls until the panel has rendered and
saved, opens private Wi-Fi sharing, and gives you the HTTPS LAN address, the
one-time pairing code, the certificate fingerprint, and the expiry.

On the standalone route, that request is one command:

```sh
pnpm --dir plugin run quest 1CRN
```

If the skill did not load, type that yourself. It works with no skill and no
plugin installed. The step-by-step form, and the `open_companion`,
`control_tour` and `update_inspection` payloads behind it, are in
`plugin/claude-code/skills/stereofold-quest/SKILL.md`.

Leave the browser tab open and in the foreground. It is the panel. A hidden
desktop panel pauses polling and stops executing commands until it is visible
again. On a machine with no display, add `--headless`.

In Quest Browser on the same Wi-Fi, open the LAN address, accept the
development certificate for that exact address, bookmark the base address
without `/viewer` or a `#` fragment, enter the code, and tap **Enter VR** for
passthrough. Opaque VR is under **More options**. You start XR; the agent
cannot.

> Teach me the fold of 1CRN as a tour.

`pnpm --dir plugin run quest 1CRN --tour fold-detective` waits for the headset
to pair, then targets the companion panel and confirms the `rendered` receipt.
By hand, Claude Code starts one of ten bundled tours with `control_tour` and
confirms the same receipt. The IDs are
`fold-detective`, `chemical-colors`, `surface-safari`, `structure-evidence`,
`claude-binder-map`, `generator-gallery`, `sequence-story`,
`prediction-courtroom`, `ranking-diversity`, and `controls-handoff`. A tour runs
on the panel it was started on, so a tour started on the desktop does not run in
the headset. Only one panel runs a tour at a time: starting one in the headset
deactivates the desktop tour.

You can also drive tours from the menu in the headset: **Tour** starts the
journey for the loaded structure, **Tours** opens the chooser, and **Next one**
cycles its choices.

> Open /absolute/path/protein.cif on my Quest.

`pnpm --dir plugin run quest /absolute/path/protein.cif`. With an absolute `.cif`
or `.mmcif` path, nothing is downloaded from the PDB.

> Build me a lesson on this structure and play it on the Quest.

An authored lesson needs a local mmCIF file plus a lesson JSON, and both must
be supplied when the host starts. `inspect_lesson` takes no PDB ID, so a PDB
entry has to be downloaded to a local file first. Claude Code creates the
starter with `scripts/molecular-lesson-cli.ts create`, writes the chapters, and
restarts the host with the lesson path. The authored tour then appears
alongside the bundled ten, with an ID of the form `lesson-<lesson id>`. The
generated starter plays unedited as a short generic tour, so you can check that
the lesson loads and plays before writing any content.

Appearance, placement, and residue-selection changes work the same way through
`update_inspection`. Each command returns queued, and only a `rendered` receipt
establishes that the scene was drawn and saved.

## Talk to Claude Code from the headset

Hold A on the right controller or X on the left for at least 150 ms, speak, and
release. The headset microphone records while the button is down, the audio
streams to the Mac, and this Mac transcribes it there. You can be anywhere on
the network; the Mac's microphone is not involved and no keystroke is sent. A
tap shorter than 150 ms is not a press: it buzzes and opens nothing
(`TALK_MIN_HOLD_MS`, `lab/browser-roundtrip/xr-buttons.mjs`).

Both grips grab and scale the structure instead. The left grip stopped starting
push-to-talk on 2026-09-10, after a wearer who squeezed it to steady a two-hand
scale opened a microphone.

With hand tracking and no controllers there is no button to hold. Point at the
**Talk** row in the in-headset menu and pull the trigger, or pinch index finger
to thumb while looking at it; a second press stops. This route uses the OAuth
transcriber, which sends the recording to OpenAI's Realtime service through the
configured helper; only **A** and **X** use the local recognizer. The row is
the microphone's state indicator either way: it reads `Talk` at rest, `Mic on…`
while the microphone is open, `Hearing…` while the recording is transcribed,
`Reply…` while a reply plays, and `No voice` after a voice error
(`lab/browser-roundtrip/spatial-toolbar-content.mjs`). With the menu hidden, a
buzz marks open and close. Either gesture opens exactly one microphone.

### Start the host

```sh
pnpm --dir plugin run quest 1CRN
```

Headset voice is on by default; `--no-ptt` turns it off. The host logs one line
naming the recognizer it will use (the Apple helper, or the whisper binary and
model), or naming what is missing. Pair the Quest, enter VR, and
grant the microphone when the browser asks. Permission is asked once per origin.

The control file defaults to `~/.stereofold/quest-share.json`; `--state` moves
it. The stream listener in [Read what the wearer said](#read-what-the-wearer-said)
needs that path.

These optional settings change the defaults:

| Variable | Default |
| --- | --- |
| `STEREOFOLD_PTT_TRANSCRIBER` | unset, which picks Apple on a Mac that has the tool built and whisper otherwise; `whisper` forces whisper |
| `STEREOFOLD_WHISPER_BIN` | `/opt/homebrew/bin/whisper-cli` |
| `STEREOFOLD_WHISPER_MODEL` | `~/.cache/whisper-cpp/ggml-base.en.bin` |
| `STEREOFOLD_APPLESPEECH_BIN` | the copy inside the package, then `/opt/homebrew/bin/applespeech` |
| `STEREOFOLD_FFMPEG_BIN` | `/opt/homebrew/bin/ffmpeg` |
| `STEREOFOLD_PTT_SILENCE_RMS` | `0.012`, the level below which a press counts as silence |
| `STEREOFOLD_BRIDGE_DIR` | unset |

The Apple route needs no model file and no Homebrew formula. After
`pnpm --filter stereo-structure build:applespeech`, the host picks it with
nothing set. Click its consent dialog before the headset goes on. The grant
belongs to the app that started the host, so granting Terminal once does
nothing for a host started from Claude Code. The dialog appears on the Mac,
where a wearer already in the headset cannot reach it. A press the recognizer refuses falls back to whisper when this Mac
has one. A host with no window of its own should set
`STEREOFOLD_PTT_TRANSCRIBER=whisper`, because it can never show that dialog.

### Answer the wearer

`stereo_structure.say_to_headset` is the reply half of the loop and the half
that works on every host. Pass `{"text": "..."}`, 1 to 1,200 characters and at
most 200 words. A reply over either limit is refused; a long reply within
the limits is spoken as consecutive segments without truncation. The text is drawn on the reply card
below the wearer's gaze, separate from the structure and chapter captions, and
unless `speak` is false it is also heard: Quest Browser has no speech-synthesis
voice of its own, so this Mac renders the sentence, encodes it to Ogg Opus with
`ffmpeg`, and sends the clip inline with the caption.

`STEREOFOLD_REPLY_VOICE_PROVIDER` chooses what renders it, and the host refuses
any value but these two:

| Setting | What renders the sentence |
| --- | --- |
| unset, or `oauth` | the `agent-voice` helper, over your own OAuth connection |
| `system` | `/usr/bin/say`, with no request off this Mac |

The default is `oauth`, which runs the helper at
`~/.local/bin/agent-voice` unless `STEREOFOLD_AGENT_VOICE_BIN`
names another absolute path. A Mac without that helper gets the caption and no
sound, and the host's startup line names both the setting that points at a
helper and the `system` value that stops asking for one. On the `system` route,
`STEREOFOLD_REPLY_VOICE` names a `say` voice and `STEREOFOLD_REPLY_RATE` its
words per minute.

`holdSeconds` (2-15, default 6) sets how long the caption stays up.
`say_to_headset` carries no session binding, for the same reason `listen_voice`
carries none, and it is absent from both network allowlists, so the headset can receive a reply but never
write one. `delivered: true` means a connected companion page took the reply
within 2.5 seconds. `delivered: false` means no page had taken it yet,
not that it was refused, and it is shown on the next heartbeat. `audible: true`
means a clip was rendered and sent with the caption; `audible: false` means
this Mac could not render one, usually a missing `ffmpeg` or a missing
`agent-voice` helper, and the wearer gets the caption without sound. Neither
field says the wearer heard anything.
`speak_to_headset` queues a short spoken line for one bound companion panel
through the same configured provider. Prefer `say_to_headset` for replies.

### Read what the wearer said

Five deliveries run independently. A failure in one never stops the others.

1. **The headset shows it.** The transcript comes back in the result of the last
   audio chunk, so the page can display `Heard: …` without a second request.

2. **Claude Code hears it directly.** The `stereo_structure.listen_voice` tool
   long-polls for speech and is the only voice route a model can call. It takes
   `timeoutSeconds` (1-25, default 20) and the `cursor` from the previous
   answer, and returns `{transcripts, cursor, timedOut}`. An agent calls it in a
   loop, acts on each utterance with the ordinary inspection tools, and replies
   with `say_to_headset`. It is deliberately absent from both network
   allowlists, so only the desktop MCP client can reach it. This needs no second
   shell and no control file.

3. **Claude Code reads it as a stream.** Run the listener against the host's
   control file, in a second shell:

   ```sh
   pnpm --dir plugin run quest 1CRN --ptt
   pnpm --dir plugin run listen ~/.stereofold/quest-share.json
   ```

   Each finished utterance prints as one line on stdout:

   ```
   VOICE 2026-09-09T21:14:08.912Z open the microtubule lattice
   ```

   A Claude Code session watches that stream and acts on what it reads. The
   listener long-polls the standalone host's loopback `/agent` route with the
   admin token from the state file. Pass `--replay` to receive utterances from
   before the listener started.

4. **A file holds the history.** Set `STEREOFOLD_PTT_TRANSCRIPTS` to an absolute
   path and every utterance is appended there as one JSON object per line, at
   mode 0600.

5. **A command receives it on stdin.** `STEREOFOLD_PTT_TEXT_COMMAND` runs once
   per utterance with the text on standard input. The text never enters the
   command string, so nothing you say can become shell syntax.

Claude Science reads the transcript from the bridge file. Set
`STEREOFOLD_BRIDGE_DIR` to the same directory the bridge harness writes, and the
latest utterance is written to `voice.json`, then in the `voice` field of the next
`state.json` the harness writes.

### Bounds

`plugin/src/push-to-talk-transcribe.ts` sets these limits. One utterance is capped at
60 seconds and at 8 MiB. One chunk carries at most 320 KiB of base64 against the
transport's 2 MiB body cap. Four utterances may be assembled at once, and one
session may send 320 chunks or start 12 utterances a minute. Chunks are
assembled in a 0700 directory under the system temp root and deleted as soon as
the transcript exists, whether or not transcription succeeded. A missing chunk
is refused rather than transcribed as a splice. Under `--no-ptt`, or with
`STEREOFOLD_PTT_TRANSCRIBE=0`, the tool is registered and answers `disabled`.

The server checks whether it can transcribe. Unset,
`STEREOFOLD_PTT_TRANSCRIBE` means on whenever this Mac has either recognizer:
the `applespeech` helper, which an unset `STEREOFOLD_PTT_TRANSCRIBER` picks on
any Mac that has it built, or `whisper-cli` with a whisper model and `ffmpeg`,
looked for at their Homebrew paths first and then on `PATH`. That check
lets headset voice work on the Claude Science and Codex hosts, which set
no environment of their own. `0` turns it off.

`poll_voice_transcripts` and `listen_voice` are both absent from the companion
and private Wi-Fi allowlists. A transcript reaches only the desktop MCP client
or a process that can read the control-state file.

### Running a command on the talk press instead

The same press can also run two shell commands you choose.
`STEREOFOLD_PTT_DOWN` runs when the wearer holds A or X; `STEREOFOLD_PTT_UP`
runs on the release. This repository ships neither, deliberately: pressing a key
in your terminal needs an Accessibility permission that only you can grant. Set
neither variable and a press writes one log line and runs nothing. The bounds
live in `plugin/src/push-to-talk.ts`: a second press while one is held is
ignored, two presses closer together than 300 ms count as one, and a command
that has not returned within 5 seconds is killed.

A release is sent when the button comes up, when the controller cancels the
press, when the controller disappears from the session, and when the session
ends, so a held press cannot outlive the headset.

## Cinematic to detailed and back

The inspector panel is a cinematic view: four representations, five color
themes, one selection, one placement. Mol* itself has far more. `open_detailed_view`
serves the complete Mol* viewer application from this Mac, with the structure
and saved scene already applied, so a user can measure a distance, build a
component or export an image and then carry the result back.

1. Save the view you want in the panel, then say "open this in the full Mol*
   viewer". On the standalone desktop host, press **Detailed view** in the bar
   above the panel instead.
2. `open_detailed_view` with `open: true` opens the address in this Mac's
   default browser, which is also the route for Claude Science, whose panel
   cannot open links. Otherwise open the whole address that comes back,
   including the part after the `#`. That fragment is the page key, and the
   browser never sends it anywhere.
3. Work in the full viewer. It runs entirely on loopback and reaches no
   network, so its own PDB and density downloads stay blocked. It opens with
   its camera fitted to the structure rather than on the panel's pose.
4. To bring work back, press **Apply changes, then back to headset** on the
   detailed page. If that return fails, choose **Download State** in that
   viewer, pick the `.molj` format, and give Claude the saved file's absolute
   path for `import_detailed_view`.

What crosses each way:

| Direction | Carried | Left behind |
| --- | --- | --- |
| Panel to detailed | Coordinates, model, assembly, representation, color theme, opacity, background, residue selection, selection labels | Placement, tour, immersive state |
| Detailed to panel, the Return press | Representation, color theme, uniform color, opacity, background, residue selection, camera pose | Extra representations, measurements, volumes; a component comes back as its selected residues |
| Detailed to panel, a `.molj` file | Representation, color theme, uniform color, opacity, background, camera pose (second call) | Selection, extra representations, components, measurements, volumes, extensions |

On the file route, the framing comes back on a second call. A panel renders one command at a
time, so `import_detailed_view` queues the appearance first and the camera
after it. When the result says the detailed framing is still to come, wait for
that command's receipt and call the tool again with the same file and a new
`commandId`; repeat until the result says nothing was queued. Only the pose
crosses. Scene radius, depth fog and the near and far bounds stay with the
panel's own depth controls, so a returning snapshot cannot change them.

A headset already connected to this inspection updates without another call.
Opening a detailed view marks the session shared, so every panel with no
unsaved work picks up the newly saved scene on its next heartbeat and redraws.
Appearance and placement cross that way. The framing does not while the headset
is presenting, because head tracking controls the view there; the desktop panel
still takes it.

A detailed view is a copy taken at one moment, not a live link. Later panel
changes do not follow it, and it expires with the companion link that carries
it. A `.molx` archive is a zip rather than JSON and is refused by name; save
`.molj` instead.

This route needs no other plugin. It is not the Codex Molecular Structure
Viewer, and it opens nothing on molstar.org.

## Session lifetime

Keep the host process running. Killing it closes the session and the private
listener. Sharing expires after thirty minutes without an authorized request,
and after eight hours by default regardless of activity; the pairing code
expires after ten minutes and works once. Reopening the same share keeps its
paired clients, and a share opened for a new capability revokes them.
Reopening the bookmark does not renew an expired session. `manage_companion` reads status, revokes one paired client, or stops
sharing.

The control file grants full loopback control of the session. `quest` writes
`~/.stereofold/quest-share.json` and deletes it on exit; the by-hand route uses
whatever absolute path you pass to `start`. It is written mode 600. Never share it or commit it.

## Update after a code change

```sh
cd /absolute/path/to/stereofold
pnpm run build
```

Restart the standalone host. A skill linked by hand is a symlink into the
checkout, so `git pull` updates it with no reinstall. Restart Claude Code only
when the SKILL.md itself changes.

## Uninstall

Remove the marketplace install:

```sh
claude plugin uninstall stereofold@stereofold
```

If you linked the skill by hand instead, delete only the
`~/.claude/skills/stereofold-quest` symlink. Then restart Claude Code. Leave
`~/.stereofold` in place while any Stereofold host on this Mac uses it; it
holds session state that other hosts share.

## Registering the MCP server by hand

The marketplace install registers the server for you. To register it by hand
instead, this command writes `~/.claude.json` under `mcpServers` at user scope:

```sh
claude mcp add stereo_structure --scope user -- \
  /opt/homebrew/bin/node \
  /absolute/path/to/stereofold/plugin/release/stereofold/dist/server.mjs
```

`claude mcp list` shows it; `claude mcp remove stereo_structure --scope user`
removes it. The name `stereo_structure` matches the plugin's server, so the
skills find its tools under `mcp__stereo_structure__*`. The server resolves `inspector.html` from its own module URL, so no working
directory is needed.

A server registered this way behaves like the plugin's: `inspect`, then
`open_companion`, opens the inspector in this Mac's browser and waits for the
saved scene. It runs as its own process, separate from a standalone `quest`
host; `continue_session` joins a scene that host already shares on this Mac.

## Check your connection

The complete plugin registers its server through `plugin/.claude-plugin/plugin.json`
and loads both skill directories. Open the inspector in a browser, verify the
saved scene and a rendered command receipt, then pair your headset.

A wearer checks certificate acceptance, headset entry, controller or hand input,
menu readability and comfort on the device in use.
