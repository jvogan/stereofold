#!/bin/bash
# Stereofold: verify and register the release server with Claude Science.
# Run from any working directory; paths are derived from this checkout.
# Run by hand:  bash harness/kits/install-claude-science.sh
# Then quit and relaunch Claude Science. Prints "CLAUDE SCIENCE INSTALL OK <viewer build hash>".
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
NODE_BIN=$(command -v node)
case "$NODE_BIN" in /*) ;; *) echo "node must resolve to an absolute executable path" >&2; exit 1 ;; esac
BRIDGE_DIR="$(dirname "$REPO")/stereofold-bridge"
EXPECTED_CONFIG=~/.claude-science/mcp/local-mcp.json
CONFIG="$EXPECTED_CONFIG"
CONFIG_HELPER="$REPO/plugin/scripts/safe-config-update.py"
RELEASE_SERVER="$REPO/plugin/release/stereofold/dist/server.mjs"

# Validate the exact config path and every existing parent before building or
# changing host state. The helper repeats this check immediately before its
# atomic replacement.
python3 "$CONFIG_HELPER" claude-install \
  --target "$CONFIG" \
  --expected-target "$EXPECTED_CONFIG" \
  --check-only

cd "$REPO"
pnpm --filter stereo-structure release
BUILD_HASH=$(pnpm --filter stereo-structure smoke | tee >(cat >&2) | grep 'SMOKE PASS' | tail -1 | grep -oE '[0-9a-f]{64}' | tail -1)
[ -n "$BUILD_HASH" ] || { echo "smoke did not print a viewer build hash" >&2; exit 1; }

# Two settings this host needs that a terminal host does not.
#
# STEREOFOLD_PTT_TRANSCRIBER=whisper: the release now stages the `applespeech`
# binary, and an unset transcriber picks Apple whenever that binary is present.
# Apple's recognizer needs a macOS Speech Recognition grant, raised as a dialog
# against the application that started the host, and this daemon has no window
# to show one in. Every press would spend a refused applespeech run before
# falling back to whisper. Naming whisper here skips that round trip.
#
# STEREOFOLD_ADB_BIN: capture_headset_view reads the headset panel over adb,
# and the daemon's PATH has no Homebrew, so an adb that every other host finds
# is invisible here. It is written only when it is really there, so a Mac
# without platform-tools keeps the tool's own "no adb was found" sentence.
ENV_ARGS=(
  --env "STEREOFOLD_PTT_TRANSCRIBE=1"
  --env "STEREOFOLD_PTT_TRANSCRIBER=whisper"
  --env "STEREOFOLD_BRIDGE_DIR=$BRIDGE_DIR"
  --env "STEREOFOLD_SCENE_SERVICE=$HOME/.stereofold/scene-service.json"
  --env "STEREOFOLD_SCENE_SOCKET=$HOME/.stereofold/scene-service.sock"
)
CLOUDFLARED_BIN=$(command -v cloudflared || true)
if [ -n "$CLOUDFLARED_BIN" ] && [ -x "$CLOUDFLARED_BIN" ]; then
  ENV_ARGS+=(--env "STEREOFOLD_CLOUDFLARED=$CLOUDFLARED_BIN")
fi
for candidate in /opt/homebrew/bin/adb /usr/local/bin/adb "$HOME/Library/Android/sdk/platform-tools/adb"; do
  if [ -x "$candidate" ]; then
    ENV_ARGS+=(--env "STEREOFOLD_ADB_BIN=$candidate")
    break
  fi
done

python3 "$CONFIG_HELPER" claude-install \
  --target "$CONFIG" \
  --expected-target "$EXPECTED_CONFIG" \
  --server "$RELEASE_SERVER" --node "$NODE_BIN" \
  "${ENV_ARGS[@]}"

# The bridge is how a sandboxed assistant reads what the wearer said and saw.
# The server creates it on demand at 0700, but making it here means the read
# grant can be given before the first session. It holds no tokens: every
# capability-shaped key and value is stripped before anything is written.
mkdir -p "$BRIDGE_DIR"
chmod 700 "$BRIDGE_DIR"

echo "CLAUDE SCIENCE INSTALL OK $BUILD_HASH"
echo "Next: quit Claude Science completely (the daemon only reads local-mcp.json at startup, so a running daemon started before this entry existed never loads it), relaunch, then reconnect stereofold under Customize -> Connectors."
echo "Confirm the sandbox read grant for plugin/release/stereofold under Customize -> Permissions, then start a NEW conversation."
echo "Verify stereo_structure tools against plugin/scripts/tool-inventory.ts."
echo "Also grant the sandbox read access to $BRIDGE_DIR under Customize -> Permissions, or the wearer's transcribed speech and captures stay unreadable to the assistant."
echo "For continue_session, add $HOME/.stereofold to [sandbox] user_read_paths and [sandbox.network] allow_unix_sockets in Claude Science config.toml, then restart the daemon."
echo "inspect, inspect_file, inspect_scene, and inspect_lesson mount ui://stereo-structure/inspector; open mounts ui://stereo-structure/viewer and is the sole automatic native-file binding (it opens the legacy viewer, not the rich inspector). The other rich-inspection tools act on an already-open panel and mount nothing themselves."
echo "For a headset, start node plugin/dist/headset-host.mjs 4HHB in a Mac terminal (add --vision-pro for Vision Pro), pair as the terminal directs, then ask Claude Science to join the scene with continue_session. Keep the terminal open. See docs/install.md#claude-science-local-mcp-server for setup and sandbox permissions."
