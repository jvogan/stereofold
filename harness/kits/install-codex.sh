#!/bin/bash
# Build and install Stereofold into one explicitly selected Codex profile.
# The normal repository marketplace install is documented in README.md.
# This installer builds a release and refreshes one explicitly selected profile.
# --marketplace-root selects its local personal marketplace; by default it uses
# <selected-profile>/stereofold-marketplace. No path needs editing in this script.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
INSTALL_ROOT=${STEREOFOLD_INSTALL_ROOT:-}
RELEASE_ARTIFACT="$REPO/plugin/release/stereofold"
CONFIG_HELPER="$REPO/plugin/scripts/safe-config-update.py"
DIRECTORY_HELPER="$REPO/plugin/scripts/safe-directory-swap.py"
CHECK_HELPER="$REPO/plugin/scripts/codex-install-check.py"

usage() {
  echo "Usage: bash harness/kits/install-codex.sh --codex-home /absolute/profile [--codex-bin /absolute/codex] [--marketplace-root /absolute/directory] [--preview] [--reuse-release /absolute/verified-stereofold-artifact]"
}

TARGET_PROFILE=
CODEX_CLI=codex
PREVIEW=false
REUSE_RELEASE=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --codex-home|--codex-bin|--marketplace-root|--reuse-release)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      if [ "$1" = --codex-home ]; then TARGET_PROFILE=$2
      elif [ "$1" = --codex-bin ]; then CODEX_CLI=$2
      elif [ "$1" = --marketplace-root ]; then INSTALL_ROOT=$2
      else REUSE_RELEASE=$2
      fi
      shift 2
      ;;
    --preview) PREVIEW=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ -n "$TARGET_PROFILE" ] || { usage >&2; exit 2; }
TARGET_PROFILE=$(python3 "$CHECK_HELPER" profile --codex-home "$TARGET_PROFILE")
CODEX_CLI=$(python3 "$CHECK_HELPER" cli --codex-bin "$CODEX_CLI")
INSTALL_ROOT=${INSTALL_ROOT:-"$TARGET_PROFILE/stereofold-marketplace"}
INSTALL_ROOT=$(python3 - "$CHECK_HELPER" "$INSTALL_ROOT" <<'PY_PATH'
import runpy, sys
module = runpy.run_path(sys.argv[1])
print(module['absolute_path'](sys.argv[2]))
PY_PATH
)
PERSONAL_PLUGIN="$INSTALL_ROOT/plugins/stereofold"
MARKETPLACE="$INSTALL_ROOT/.agents/plugins/marketplace.json"
CACHE="$TARGET_PROFILE/plugins/cache/personal/stereofold"
if [ -n "$REUSE_RELEASE" ]; then
  case "$REUSE_RELEASE" in
    /*) ;;
    *) echo "The reuse release must be an absolute verified artifact path." >&2; exit 2 ;;
  esac
  RELEASE_FINGERPRINT=$(python3 "$CHECK_HELPER" fingerprint --artifact "$REUSE_RELEASE")
  VERSION=$(printf '%s' "$RELEASE_FINGERPRINT" | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])')
  BUILD_HASH=$(printf '%s' "$RELEASE_FINGERPRINT" | python3 -c 'import json, sys; print(json.load(sys.stdin)["viewerBuild"])')
  if [ "$PREVIEW" = true ]; then
    python3 "$CHECK_HELPER" verify --artifact "$PERSONAL_PLUGIN" \
      --expected "$RELEASE_FINGERPRINT" --version "$VERSION" --viewer-stamp "$BUILD_HASH" >/dev/null
  else
    python3 "$CHECK_HELPER" verify --artifact "$PERSONAL_PLUGIN" \
      --expected "$RELEASE_FINGERPRINT" --version "$VERSION" --viewer-stamp "$BUILD_HASH"
  fi
  if [ "$PREVIEW" = true ]; then
    python3 "$CONFIG_HELPER" codex-reuse-check \
      --target "$MARKETPLACE" \
      --expected-target "$MARKETPLACE" >/dev/null
  else
    python3 "$CONFIG_HELPER" codex-reuse-check \
      --target "$MARKETPLACE" \
      --expected-target "$MARKETPLACE"
  fi
  RELEASE_ARTIFACT="$REUSE_RELEASE"
fi

# CODEX_HOME is supplied only to the selected CLI process; the caller's profile
# and environment stay unchanged. Every discovery/install call uses this route.
codex_for_profile() {
  python3 "$CHECK_HELPER" profile --codex-home "$TARGET_PROFILE" >/dev/null || return $?
  env CODEX_HOME="$TARGET_PROFILE" "$CODEX_CLI" "$@"
}

if [ "$PREVIEW" = true ]; then
  python3 "$CHECK_HELPER" preview \
    --codex-home "$TARGET_PROFILE" --codex-bin "$CODEX_CLI" \
    --artifact "$RELEASE_ARTIFACT" --staging "$PERSONAL_PLUGIN" --marketplace "$MARKETPLACE"
  exit 0
fi

# Verify any installed Structure Viewer from its discovered cache artifact
# before changing staging, the marketplace, or a plugin. Distinct MCP server
# identities may coexist; unknown or overlapping ownership fails closed.
PLUGIN_LIST=$(codex_for_profile plugin list --json)
printf '%s' "$PLUGIN_LIST" | python3 "$CHECK_HELPER" ownership \
  --codex-home "$TARGET_PROFILE" --server-id stereo_structure
PERSONAL_INSTALLED=$(printf '%s' "$PLUGIN_LIST" | python3 "$CHECK_HELPER" discovery --plugin-id stereofold@personal)

# Create only the local marketplace's parents through no-follow descriptors.
# An existing marketplace keeps all entries except the Stereofold entry.
if [ -z "$REUSE_RELEASE" ]; then
  python3 "$CONFIG_HELPER" codex-install \
    --target "$MARKETPLACE" --expected-target "$MARKETPLACE" \
    --initialize --check-only
  python3 - "$CONFIG_HELPER" "$INSTALL_ROOT/plugins" <<'PY_PARENT'
import runpy, sys
from pathlib import Path
runpy.run_path(sys.argv[1])['ensure_parent'](Path(sys.argv[2]))
PY_PARENT
fi
PERSONAL_PARENT=$(dirname "$PERSONAL_PLUGIN")
if [ "$PERSONAL_PARENT" != "$INSTALL_ROOT/plugins" ] || [ "$(basename "$PERSONAL_PLUGIN")" != stereofold ]; then
  echo "Refusing unexpected personal plugin target: $PERSONAL_PLUGIN" >&2
  exit 1
fi
if [ -L "$PERSONAL_PARENT" ] || [ ! -d "$PERSONAL_PARENT" ] || [ "$(cd "$PERSONAL_PARENT" && pwd -P)" != "$PERSONAL_PARENT" ]; then
  echo "Refusing unresolved or symlinked plugin parent: $PERSONAL_PARENT" >&2
  exit 1
fi
if [ -L "$PERSONAL_PLUGIN" ]; then
  echo "Refusing symlink staging target: $PERSONAL_PLUGIN" >&2
  exit 1
fi

python3 "$DIRECTORY_HELPER" preflight \
  --target "$PERSONAL_PLUGIN" \
  --expected-target "$PERSONAL_PLUGIN"
if [ -z "$REUSE_RELEASE" ]; then
  python3 "$CONFIG_HELPER" codex-install \
    --target "$MARKETPLACE" \
    --expected-target "$MARKETPLACE" \
    --initialize --check-only
fi

if [ -z "$REUSE_RELEASE" ]; then
  cd "$REPO"
  pnpm --filter stereo-structure release
  SMOKE_LINE=$(pnpm --filter stereo-structure smoke | tee >(cat >&2) | grep 'SMOKE PASS' | tail -1)
  BUILD_HASH=$(printf '%s\n' "$SMOKE_LINE" | grep -oE '[0-9a-f]{64}' | tail -1)
  [ -n "$BUILD_HASH" ] || { echo "smoke did not print a viewer build hash" >&2; exit 1; }
  RELEASE_FINGERPRINT=$(python3 "$CHECK_HELPER" fingerprint --artifact "$RELEASE_ARTIFACT" --viewer-stamp "$BUILD_HASH")

  python3 "$DIRECTORY_HELPER" preflight \
    --target "$PERSONAL_PLUGIN" \
    --expected-target "$PERSONAL_PLUGIN"

  # The guarded swap retains the previous install as a recovery directory.
  SWAP_OUTPUT=$(python3 "$DIRECTORY_HELPER" install \
    --source "$RELEASE_ARTIFACT" \
    --expected-source "$REPO/plugin/release/stereofold" \
    --target "$PERSONAL_PLUGIN" \
    --expected-target "$PERSONAL_PLUGIN")
  printf '%s\n' "$SWAP_OUTPUT"
  VERSION=$(printf '%s\n' "$SWAP_OUTPUT" | awk '/^STAGED VERSION / { print $3 }')
  [ -n "$VERSION" ] || { echo "safe staging did not report a plugin version" >&2; exit 1; }
  python3 "$CHECK_HELPER" verify --artifact "$PERSONAL_PLUGIN" \
    --expected "$RELEASE_FINGERPRINT" --version "$VERSION" --viewer-stamp "$BUILD_HASH"

  python3 "$CONFIG_HELPER" codex-install \
    --target "$MARKETPLACE" \
    --expected-target "$MARKETPLACE" --initialize
fi
codex_for_profile plugin marketplace add "$INSTALL_ROOT"
printf 'CODEX TARGET %s\nCODEX EXECUTABLE %s\nRELEASE FINGERPRINT %s\n' "$TARGET_PROFILE" "$CODEX_CLI" "$RELEASE_FINGERPRINT"

# Recheck immediately before registration. The cache verification below catches
# a change during the CLI copy, but this check keeps a prior stage mismatch from
# replacing an existing selected-profile registration.
if [ -n "$REUSE_RELEASE" ]; then
  python3 "$CHECK_HELPER" verify --artifact "$PERSONAL_PLUGIN" \
    --expected "$RELEASE_FINGERPRINT" --version "$VERSION" --viewer-stamp "$BUILD_HASH"
fi
if [ -n "$PERSONAL_INSTALLED" ]; then
  codex_for_profile plugin remove stereofold@personal
fi
codex_for_profile plugin add stereofold@personal
codex_for_profile plugin list --json | python3 "$CHECK_HELPER" registration \
  --codex-home "$TARGET_PROFILE" --version "$VERSION"
python3 "$CHECK_HELPER" verify --artifact "$CACHE/$VERSION" \
  --expected "$RELEASE_FINGERPRINT" --version "$VERSION" --viewer-stamp "$BUILD_HASH"

if [ -n "$REUSE_RELEASE" ]; then
  echo "CODEX REUSE INSTALL OK $BUILD_HASH"
else
  echo "CODEX INSTALL OK $BUILD_HASH"
fi
echo "Verify diagnostics.viewerBuild in the intended Codex task before qualifying the mounted viewer."
