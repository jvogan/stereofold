#!/bin/sh
# Build `applespeech`, the one-file wrapper around Apple's on-device Speech
# framework that lets headset voice work on a Mac that never installed whisper.
#
# Run `sh native/applespeech/build.sh` from the installed plugin directory.
# Swift compiles only on macOS; other hosts use whisper.
#
# The binary lands in `bin/` beside this script, which is where
# `applespeechBinCandidates` looks first. `bin/` is not tracked, because a
# compiled Mach-O is not source and this one is ad-hoc signed.
#
# The Info.plist is linked into the executable rather than shipped beside it.
# macOS reads `NSSpeechRecognitionUsageDescription` out of the running image to
# write the Speech Recognition consent dialog, and a bare command-line tool has
# no bundle to read it from; without the section the request is denied with no
# dialog at all.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out="$here/bin"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "applespeech builds only on macOS. Use whisper on this host; see README.md in the plugin directory." >&2
  exit 1
fi
if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun was not found. Install the Xcode command line tools with: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$out"
xcrun swiftc -O \
  -framework Speech \
  -framework AVFoundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/Info.plist" \
  -o "$out/applespeech" \
  "$here/transcribe.swift"

echo "APPLESPEECH BUILT $out/applespeech"
