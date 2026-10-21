# Voice and helper configuration


`setup-check` writes `~/.stereofold/config.json` during setup, with
mode 0600, keeping every setting already in the file. It records:

| Key | What it holds |
| --- | --- |
| `stereofoldRoot` | The absolute plugin root that was discovered |
| `serverEntry` | The absolute `dist/server.mjs` a host should launch |
| `python3Bin` | The Python 3 the transcriber runs, when one was found |
| `agentVoiceBin` | The OAuth narration helper, when one was found |

`python3Bin` and `agentVoiceBin` are helper keys the running server reads. It
looks for each helper in three places in order: the environment variable, this
file, then PATH. So a user with a helper in an unusual place has three ways to
name it, and a user with it on PATH needs no setting at all.

`STEREOFOLD_CONFIG` moves the whole file; it must be an absolute path.
`STEREOFOLD_PYTHON3_BIN` and `STEREOFOLD_AGENT_VOICE_BIN` override the two keys
for one process. A relative value in any of the three is refused rather than
resolved against whatever directory the host started in.

Three further optional settings can be supplied by the user:

| Config key | Environment override | Purpose |
| --- | --- | --- |
| `replyVoiceProvider` | `STEREOFOLD_REPLY_VOICE_PROVIDER` | `oauth` or `system` for spoken replies; `system` when the OAuth narration helper is not installed. With neither set the provider is `oauth` |
| `oauthAuthHelper` | `STEREOFOLD_OAUTH_AUTH_HELPER` | Absolute path to an OAuth-only Python module exporting `create_realtime_oauth_client_secret()`; otherwise a readable `stereofold-oauth-auth.py` module is searched for on PATH |
| `questSerial` | `STEREOFOLD_QUEST_SERIAL` | Attached headset for adb launches; otherwise exactly one ready device is selected |

The auth module is not bundled. Without it OAuth microphone transcription
stays off and names these settings. Setup preserves these keys but does not
guess their values. Store only documented settings, never a credential.

The menu's **Talk** route also needs `websockets` in the exact Python interpreter
selected by `STEREOFOLD_PYTHON3_BIN`, `python3Bin`, or the runtime's lookup.
Python discovery alone does not check that dependency. The bundled
`assets/oauth-transcribe.py` uses `websockets.connect(..., additional_headers=...)`;
verify both import and that argument before testing Talk. Replace the placeholder
below with the selected interpreter's absolute path:

```sh
/absolute/path/to/python3 -c 'import inspect, websockets; assert "additional_headers" in inspect.signature(websockets.connect).parameters, "This websockets version does not support additional_headers"; print("websockets ready")'
```

If it fails, install a compatible `websockets` release in that interpreter's
environment, or configure an existing interpreter that passes the check. Use
that same absolute interpreter with `-m pip`, rather than an unrelated `pip`.
For a managed Python installation, use its virtual environment and set
`STEREOFOLD_PYTHON3_BIN` or `python3Bin` to that environment's interpreter.
Restart the host after changing the configured interpreter, then make one
Talk test and confirm its returned transcript. This route sends audio to
OpenAI Realtime through the configured OAuth helper; controller A/X uses the
separate local recognizer.

## Optional features

Unset `STEREOFOLD_PTT_TRANSCRIBER` selects Apple on macOS when its helper is
built, and Whisper otherwise. Set `apple` or `whisper` to choose explicitly.

Setting `STEREOFOLD_PTT_TRANSCRIBE=1` is recommended to make transcription explicit.
Unset, the runtime auto-detects a local transcriber: an Apple helper with `ffmpeg` or a complete Whisper route enables transcription, and readiness reports the
local recognizer resolved (Apple still needs Speech Recognition consent).
With none detected, voice stays off and readiness names the missing prerequisites;
no headset speech is transcribed. With `=1` and no transcriber, readiness
instead reports the missing prerequisites. `0` explicitly turns transcription
off. Recording still requires a held talk control and microphone permission.

Keep an already configured spoken-reply provider. On a Mac without an OAuth narration helper, set `STEREOFOLD_REPLY_VOICE_PROVIDER=system`; it uses local `say` and
`ffmpeg`. Do not change a working OAuth setup during transcription setup or silently switch providers after a failed reply. The runtime's unset reply provider is OAuth, whose narration
helper Stereofold does not ship; without it, replies are captions with no sound.
Set these values in the MCP server environment and restart the host after changes.
Terminal exports affect only a host launched from that terminal; a desktop host
needs these in its server environment. For a recipient without an existing
OAuth setup, persist local replies with `replyVoiceProvider: "system"` in the
local config, preserving other keys and any existing `oauth` choice.

Configure the helpers needed for the requested feature. Read readiness to
identify missing prerequisites; keep unrelated optional features off.

| Feature | Needs | Off means |
| --- | --- | --- |
| Headset over private Wi-Fi | `openssl` at a fixed location below, and an assigned RFC1918 IPv4 address | The LAN host cannot create its LAN certificate |
| Meta public relay | `cloudflared` installed, or `STEREOFOLD_CLOUDFLARED` naming it | `connection: "https"` fails; the LAN route is unaffected |
| Controller A/X transcription | `ffmpeg`, plus `whisper-cli` with a model, or the Apple helper. Setting `STEREOFOLD_PTT_TRANSCRIBE=1` is recommended to make transcription explicit. | A held A/X button records nothing readable |
| Menu Talk transcription | The configured Python interpreter with compatible `websockets`, plus the OAuth auth module above | Talk cannot return a transcript; A/X readiness is separate |
| Apple on-device recognizer | macOS, `ffmpeg`, Xcode command line tools, `sh native/applespeech/build.sh` | Transcription falls back to `whisper-cli` |
| Spoken replies | `ffmpeg` and the configured reply helper: existing OAuth narration, or `STEREOFOLD_REPLY_VOICE_PROVIDER=system` with macOS `say` for a recipient without it | Captions still appear; nothing is spoken |
| Headset browser debugging | `adb`, developer mode on the headset, `STEREOFOLD_ADB_BIN` on a stripped-PATH host | `capture_headset_view` and `read_headset_browser` report the missing piece |

Tool lookup uses the MCP server's environment. OpenSSL searches only
`/usr/bin/openssl`, `/opt/homebrew/bin/openssl`, `/usr/local/bin/openssl`, then
`/bin/openssl`, in that order; it has no PATH fallback or environment override.

Whisper runs on the CPU. `STEREOFOLD_WHISPER_GPU=1` runs it on the GPU instead.

Transcription searches for `ffmpeg` and `whisper-cli` in `/opt/homebrew/bin`,
`/usr/local/bin`, then `/usr/bin`, followed by absolute directories on PATH.
The Apple helper searches `native/applespeech/bin/applespeech` under the plugin
root, then the same path under its `release/stereofold` subdirectory, then
`/opt/homebrew/bin/applespeech`, `/usr/local/bin/applespeech`, then absolute
PATH directories. Spoken replies search only the three fixed ffmpeg locations;
use an override for an ffmpeg installed elsewhere.

Supported absolute overrides are `STEREOFOLD_FFMPEG_BIN`,
`STEREOFOLD_WHISPER_BIN`, `STEREOFOLD_APPLESPEECH_BIN`, and
`STEREOFOLD_WHISPER_MODEL` (a readable model file; otherwise the default is
`~/.cache/whisper-cpp/ggml-base.en.bin`). These replace the corresponding
search, so a missing or invalid override must be corrected, not ignored.
`STEREOFOLD_SAY_BIN` replaces the system reply default `/usr/bin/say`.
Set these in the host's MCP server environment and restart it after changes.

Apple's recognizer asks for consent once, through a macOS dialog raised against
the application that started the host. If a sandboxed daemon cannot show the consent dialog, use a separately
permissioned render host or an explicitly configured Whisper route.

One compile is not voice readiness. Before the headset goes on, open and save a
scene, then call `stereo_structure.get_readiness` with that `sessionId` and
`speechCheck: true`. Its `transcription` line must say that either the Apple
binary and `ffmpeg` resolved or that `whisper-cli`, `ffmpeg`, and a readable model named by
`STEREOFOLD_WHISPER_MODEL` resolved. Its `replies` line must say that the
installed reply helper produced one-word audio. On the Apple route, make one
test press and require its channel event or `listen_voice` result to contain
text; that is the consent check, because compiling cannot grant Speech
Recognition permission.

Each failure has one recovery command:

```sh
sh native/applespeech/build.sh
open "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
brew install whisper-cpp ffmpeg
export STEREOFOLD_WHISPER_MODEL=/absolute/path/to/readable/ggml-model.bin
export STEREOFOLD_PTT_TRANSCRIBE=1
```

Use the first two for a missing Apple binary or refused consent, and the next
two for Whisper prerequisites. The transcription setting is optional. Preserve
the configured reply provider. Only for a recipient without an OAuth narration
helper, set `STEREOFOLD_REPLY_VOICE_PROVIDER=system`. Restart the host after changes.
OAuth replies are optional and need a narration helper that Stereofold does
not ship. Use that route only when such a helper is installed; name its
executable with `STEREOFOLD_AGENT_VOICE_BIN` or `agentVoiceBin`. Repeat
`get_readiness` after every recovery.

### Optional completed-audio handoff

Stereofold supplies `STEREOFOLD_AGENT_VOICE_READY_FILE` to the narration helper
as a new absolute receipt path in its private temporary directory. Existing
helpers can ignore it: Stereofold still accepts their WAV after successful exit.
An implementing helper can make complete audio available while its connection
closes. After a successful, completed speech response, finish the requested WAV
and any metadata, then atomically publish this receipt as the last output write:

```json
{"version":1,"status":"completed","bytes":123456,"sha256":"<SHA-256 of the complete requested WAV>"}
```

The adapter checks the size and digest against that WAV before encoding it,
including when the helper exits before the first receipt check. A valid
completion remains usable if subsequent connection cleanup fails.
Do not publish for partial audio, failed responses or unfinished output writes;
only connection cleanup may remain. The helper keeps its 45-second process
deadline, and Stereofold removes its private input/output directory after exit.
This handoff needs no new provider, credentials, persistent service or model
request. It changes when a completed clip is available, not what it says.

Stereofold itself does not install `cloudflared`, `ffmpeg`, `whisper-cli`, or
a model. Install needed helpers within the user's authorized setup scope,
using the chosen package manager and preserving existing working routes.


## Claude Code channel protocol

This package pins MCP SDK 1.29.0, whose latest supported protocol is `2025-11-25`;
it does not negotiate `2026-07-28`. No legacy override is needed here. If a future
v2 runtime negotiates `2026-07-28` and Claude fails to register the channel, set
`MCP_PROTOCOL_NEGOTIATION=legacy` in that MCP server's environment and restart.

