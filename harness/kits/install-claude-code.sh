#!/usr/bin/env bash
# Install the complete plugin from this checkout with Claude Code's marketplace
# commands. --preview reports actions; --build refreshes stale runtime bundles.
# --uninstall removes this plugin through Claude Code and retains plugin data.
# Usage: bash harness/kits/install-claude-code.sh [--preview] [--build] [--uninstall]

set -euo pipefail

PREVIEW=0
BUILD=0
UNINSTALL=0
for argument in "$@"; do
  case "$argument" in
    --preview) PREVIEW=1 ;;
    --build) BUILD=1 ;;
    --uninstall) UNINSTALL=1 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PLUGIN_DIR="$REPO/plugin"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -f "$PLUGIN_DIR/.claude-plugin/plugin.json" ] || fail "missing $PLUGIN_DIR/.claude-plugin/plugin.json"
[ -f "$PLUGIN_DIR/claude-code/skills/stereofold-quest/SKILL.md" ] || fail "missing $PLUGIN_DIR/claude-code/skills/stereofold-quest/SKILL.md"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$PREVIEW" -eq 1 ]; then
    say "would uninstall stereofold@stereofold and retain its data"
  else
    claude plugin uninstall stereofold@stereofold --keep-data
  fi
  exit 0
fi

# Prerequisites, reported rather than assumed.
command -v node >/dev/null 2>&1 || fail "node is not on PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "node 22 or newer is required; found $(node --version)"
command -v claude >/dev/null 2>&1 || fail "claude is not on PATH"

if ! claude plugin validate "$PLUGIN_DIR" --strict >/dev/null 2>&1; then
  say "warning: claude plugin validate --strict did not pass for $PLUGIN_DIR"
fi

# Marketplace installation copies these runtime assets from plugin/dist.
DIST_SERVER="$REPO/plugin/dist/server.mjs"
DIST_INSPECTOR="$REPO/plugin/dist/inspector.html"
DIST_INSPECTOR_CSS="$REPO/plugin/dist/inspector.css"
DIST_INSPECTOR_HOST="$REPO/plugin/dist/inspector-host.js"
NEEDS_BUILD=0
if [ ! -f "$DIST_SERVER" ] || [ ! -f "$DIST_INSPECTOR" ] || [ ! -f "$DIST_INSPECTOR_HOST" ] || [ ! -f "$DIST_INSPECTOR_CSS" ]; then
  NEEDS_BUILD=1
elif [ -n "$(find "$REPO/plugin/src" -type f -newer "$DIST_SERVER" -print -quit 2>/dev/null)" ]; then
  NEEDS_BUILD=1
elif [ -n "$(find "$REPO/plugin/src" "$REPO/plugin/scripts" -type f -newer "$DIST_INSPECTOR_HOST" -print -quit 2>/dev/null)" ]; then
  NEEDS_BUILD=1
fi

if [ "$NEEDS_BUILD" -eq 1 ]; then
  if [ "$BUILD" -eq 1 ] && [ "$PREVIEW" -eq 0 ]; then
    command -v pnpm >/dev/null 2>&1 || fail "pnpm is required for --build"
    say "building plugin/dist"
    (cd "$REPO" && pnpm install --frozen-lockfile && pnpm run build)
  else
    say "note: plugin/dist is missing or older than plugin/src"
    say "      run: cd $REPO && pnpm install --frozen-lockfile && pnpm run build"
    say "      or re-run this script with --build"
  fi
fi

if [ "$PREVIEW" -eq 1 ]; then
  say "would add local marketplace: $REPO"
  say "would install complete plugin: stereofold@stereofold"
  exit 0
fi

claude plugin marketplace add "$REPO"
claude plugin install stereofold@stereofold
say "Start a fresh Claude Code session to load Stereofold."
