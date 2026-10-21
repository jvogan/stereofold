# Install Stereofold in a Codex profile

For a normal installation, add the repository marketplace and install the
plugin, then start a fresh conversation in the Codex desktop app:

```sh
codex plugin marketplace add https://github.com/jvogan/stereofold
codex plugin add stereofold@stereofold
```

`harness/kits/install-codex.sh` builds a local release for one selected profile.
It requires `--codex-home` and creates a `personal` local marketplace under
`<selected-profile>/stereofold-marketplace`. Use `--marketplace-root` to select
an existing personal marketplace or share the same source across profiles.
The root contains `plugins/stereofold/` and `.agents/plugins/marketplace.json`.
Its paths are derived from arguments; no script editing is needed.

The installer builds Stereofold, stages the verified release, and installs it in
one explicitly selected Codex profile. Start with a preview of the target paths
and prepared bundles.

## Preview the installation

Choose the existing Codex profile that the intended desktop task uses. These
examples name `.codex-personal`; use the intended profile's absolute path.

```sh
bash harness/kits/install-codex.sh \
  --codex-home "$HOME/.codex-personal" \
  --preview
```

The preview reports the executable, profile, cache location, shared staging and
marketplace paths, and SHA-256 hashes for `viewer.html`, `inspector.html`, `inspector-host.js`, and `server.mjs`. It also
reports both viewers' verified build stamps when present. Preview reads files;
it does not invoke Codex, build the release, or modify a profile.

If the prepared release is missing, create it from the repository root:

```sh
pnpm --filter stereo-structure release
```

The installer requires `--codex-home` and rejects a missing or symlinked profile
or an existing symlink in its cache path. Every CLI operation receives that
profile through the CLI's `CODEX_HOME` environment setting. The parent shell's
environment remains unchanged.

By default, the installer resolves `codex` on `PATH` once. To select its
executable explicitly, add `--codex-bin /absolute/path/to/codex`. Pass an
executable path, without shell syntax or inline flags. The selected executable
must honor `CODEX_HOME`; account wrappers that replace it are unsuitable.

## Install the prepared source

After reviewing the target, run the installer with the same profile and
executable selection:

```sh
bash harness/kits/install-codex.sh \
  --codex-home "$HOME/.codex-personal"
```

The installer performs these checks and changes:

1. Discover installed plugins in the selected profile. An installed
   `structure-viewer` may remain side by side when its discovery identity,
   cache manifest/version, and `.mcp.json` prove it owns only distinct server
   IDs. Missing, malformed, or overlapping ownership stops the installer
   before any write; it never removes the other plugin.
2. Check the shared staging directory and marketplace with the existing
   no-follow path guards.
3. Build and verify the release, run its smoke check, and print the final bundle
   fingerprints. These identify the rebuilt artifact used for installation.
4. Stage only the release artifact in `<marketplace-root>/plugins/stereofold/`.
   Give its manifest a new cache version and retain the previous directory as a
   `.stereofold-backup-*` sibling.
5. Verify all five staged bundles and both viewer stamps, then update only Stereofold's
   entry in `<marketplace-root>/.agents/plugins/marketplace.json`.
6. Remove the existing `stereofold@personal` registration when present, then add
   the staged plugin in the selected profile. A failed CLI operation stops the
   installer.
7. Require the CLI to report the expected version installed and enabled. Compare
   all five cached bundles and both viewer stamps with the verified release.

Success prints `CODEX INSTALL OK <viewer build hash>`. The staged artifact runs
without `node_modules`. The shared staging directory and personal marketplace
serve every profile that uses them; the preview identifies both paths.

## Reuse one verified release in another profile

After a first profile installs successfully, its installed cache directory can
be the immutable contract for another profile. `--reuse-release` does not run
`pnpm`, read the development release directory, replace shared staging, or
update the shared marketplace. It requires every staged runtime file and the
viewer build stamp to match that contract before it calls Codex, checks again
immediately before registration, requires the existing marketplace entry to
name local shared staging, and verifies the new profile's registration and
cached files after the official CLI copy.

Preview first, replacing the version with the one reported by the first
installation:

```sh
bash harness/kits/install-codex.sh \
  --codex-home "$HOME/.codex-secondary" \
  --marketplace-root "$HOME/.codex/stereofold-marketplace" \
  --reuse-release "$HOME/.codex/plugins/cache/personal/stereofold/0.1.0+codex.RELEASE_VERSION" \
  --preview
```

Then use the same command without `--preview`:

```sh
bash harness/kits/install-codex.sh \
  --codex-home "$HOME/.codex-secondary" \
  --marketplace-root "$HOME/.codex/stereofold-marketplace" \
  --reuse-release "$HOME/.codex/plugins/cache/personal/stereofold/0.1.0+codex.RELEASE_VERSION"
```

The contract path must be absolute. A contract/staging mismatch fails before a
profile registration changes. Success prints `CODEX REUSE INSTALL OK <viewer
build hash>`.

On failure, retain the printed recovery directory and inspect the selected
profile before retrying. A failed CLI operation can leave its registration
incomplete even when the staged release passed verification. The installer
preserves the recovery copy and leaves recovery decisions to the operator.

The guarded directory swap verifies the complete source and staged artifact,
rejects concurrent source changes, and retains the previous install. Do not
copy files directly into Codex's managed cache.

## Update a local build

Rebuild and rerun the installer with the same profile and marketplace root.
It installs the complete artifact and verifies its cached bytes. Keep these
runtime bundles together when preparing the artifact:

```text
dist/server.mjs
dist/viewer.html
dist/inspector.html
dist/inspector.css
dist/inspector-script-1.js
dist/inspector-script-2.js
dist/inspector-host.js
```

Use the host's plugin commands to refresh an installation. If server identity
checks fail, inspect the named plugin's manifest and resolve the conflict before
retrying. Distinct MCP server names can coexist.

After installation, open a fresh conversation and compare
`diagnostics.viewerBuild` with the viewer build hash printed by
`pnpm --filter stereo-structure smoke`. A running conversation may retain an
older cached panel.

## Verify the mounted viewer

The full plugin registers 68 `stereo_structure.*` tools, 41 model-visible and
27 app-only, counted from the lists `plugin/scripts/smoke.ts` asserts;
[plugin/README.md](../../plugin/README.md) has the canonical list. In the
intended Codex task, confirm the legacy stereo viewer's five model-facing
tools:

```text
stereo_structure.open
stereo_structure.control
stereo_structure.get_state
stereo_structure.set_mode
stereo_structure.set_motion
```

Host tool names can include an MCP prefix. The stereo viewer's own app-only
tools are `get_structure`, `sync_view`, `report_diagnostics`,
`claim_action`, and `complete_action`.

Open the public test scene and compare `diagnostics.viewerBuild` from
`stereo_structure.get_state` with the installer's build hash. Follow
[the live host check](../../docs/host-verification.md#live-check-inside-a-host)
and [the headset walkthrough](../../docs/headset-walkthrough.md).
A matching cached artifact and a mounted viewer are separate checks. If an
existing task retains the earlier plugin, start a fresh task in the selected
profile and repeat the mounted-build check.

## Headset voice

`listen_voice` returns what the wearer said only when this Mac can turn the
recording into text. The server checks that itself: with `whisper-cli`, a
whisper model and `ffmpeg` installed, headset voice is on and nothing has to be
configured here. Codex launches the plugin through `codex plugin add`, which
carries no environment block of its own, so this host relies on that
automatic check.

To check what the running server decided, call `manage_companion` with
`action: "status"` after pairing and read the voice line, or hold **A** or **X**
in the headset and call `listen_voice`. A host that answers "no local
transcriber installed" is missing one of the three pieces:

```sh
brew install whisper-cpp ffmpeg
```

The default model location is `~/.cache/whisper-cpp/ggml-base.en.bin`;
`STEREOFOLD_WHISPER_MODEL` names another readable model by absolute path. Set
`STEREOFOLD_PTT_TRANSCRIBE=0` in the environment Codex itself was started in to
keep the microphone off. Audio recorded with **A** or **X** stays on the Mac:
`whisper-cli` is a local process against a local model file.

macOS on-device speech through the `applespeech` helper is the other route, and
it needs neither the Homebrew formula nor the model download. It is also the
default on this host: the release artifact Codex installs stages
`native/applespeech/bin/applespeech` when the binary was built before staging,
and an unset
`STEREOFOLD_PTT_TRANSCRIBER` picks Apple on any Mac where that binary is
present. The staged copy is found first; `STEREOFOLD_APPLESPEECH_BIN` names one
somewhere else. Its first run raises a Speech Recognition permission dialog
against the application that launched the host, so grant it in Codex before the
wearer is in the headset. A press the recognizer refuses falls back to whisper,
so a Mac with both installed keeps working either way. Set
`STEREOFOLD_PTT_TRANSCRIBER=whisper` to stay on whisper.

An artifact staged on a machine that never ran `pnpm --dir plugin run
build:applespeech` carries the Swift source without a built binary, and that
host falls back to whisper with no message saying so. Two Codex installs of the same
source can therefore differ in whether the binary existed at staging time; `ls
native/applespeech/bin` in the installed plugin answers which one you have.

The reply half runs the other way. `STEREOFOLD_REPLY_VOICE_PROVIDER` is unset
on this host, which means `oauth`: `say_to_headset` renders the sentence with
the `agent-voice` helper at `~/.local/bin/agent-voice`, or
wherever `STEREOFOLD_AGENT_VOICE_BIN` names, and that request leaves the Mac.
Set `STEREOFOLD_REPLY_VOICE_PROVIDER=system` to render replies with
`/usr/bin/say` instead. The host refuses any other value rather than choosing
one.

## Uninstall

Remove the registration from the selected profile first. Replace the profile
path and executable with the choices used for installation:

```sh
set -euo pipefail
STEREOFOLD_PROFILE="$HOME/.codex-personal"
STEREOFOLD_CLI=~/.local/bin/codex
STEREOFOLD_CHECK=plugin/scripts/codex-install-check.py
STEREOFOLD_PROFILE=$(python3 "$STEREOFOLD_CHECK" profile --codex-home "$STEREOFOLD_PROFILE")
STEREOFOLD_CLI=$(python3 "$STEREOFOLD_CHECK" cli --codex-bin "$STEREOFOLD_CLI")
env CODEX_HOME="$STEREOFOLD_PROFILE" "$STEREOFOLD_CLI" plugin remove stereofold@personal
```

The personal marketplace and staged directory are shared. Remove them only
when the other profiles no longer use this Stereofold source. From the
repository root, use the guarded cleanup. Set `INSTALL_ROOT` to the same
marketplace root used during installation:

```sh
set -euo pipefail
INSTALL_ROOT="$STEREOFOLD_PROFILE/stereofold-marketplace"
PERSONAL_PLUGIN="$INSTALL_ROOT/plugins/stereofold"
MARKETPLACE="$INSTALL_ROOT/.agents/plugins/marketplace.json"
CONFIG_HELPER=plugin/scripts/safe-config-update.py
DIRECTORY_HELPER=plugin/scripts/safe-directory-swap.py

python3 "$CONFIG_HELPER" codex-remove \
  --target "$MARKETPLACE" \
  --expected-target "$MARKETPLACE" \
  --check-only
python3 "$DIRECTORY_HELPER" preflight \
  --target "$PERSONAL_PLUGIN" \
  --expected-target "$PERSONAL_PLUGIN"
python3 "$CONFIG_HELPER" codex-remove \
  --target "$MARKETPLACE" \
  --expected-target "$MARKETPLACE"
python3 "$DIRECTORY_HELPER" remove \
  --target "$PERSONAL_PLUGIN" \
  --expected-target "$PERSONAL_PLUGIN"
```

The directory helper moves the staged copy to a `.stereofold-remove-*` sibling.
The source repository and unrelated plugins remain available.
