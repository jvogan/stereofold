# Testing without a headset

This page is for contributors. It lists the checks that run without a Quest and
what each one covers. For checks in a worn headset, use the
[wearer checklist](quest-operator-runbook.md#wearer-checklist).

## Unit suites

From the repository root, `pnpm test` runs every suite the repository counts:
the workspace packages and the plugin (Vitest), the lab under
`lab/` (`node --test`, one file at a time), and the
harness (Vitest). The harness has its own lockfile, so install it once before
the first run:

```sh
pnpm install --frozen-lockfile
pnpm --dir harness install --frozen-lockfile
pnpm test
```

`pnpm run test:workspace`, `pnpm run test:lab` and `pnpm run test:harness` run
one suite each. `.github/workflows/ci.yml` runs the same three suites after the
build, the typecheck and `pnpm --dir plugin run smoke`. The browser checks below
stay manual.

## Browser checks

Run these from the repository's `plugin/` directory after installing the locked
workspace dependencies. The browser checks need Playwright's Chromium, which the
package install does not download; fetch it once with
`pnpm --dir plugin exec playwright install chromium` from the repository root.
Run `pnpm run build` before browser checks so they exercise current source. Use fresh output directories outside the repository.

```sh
pnpm test
pnpm exec tsc --noEmit
pnpm run test:scene-handoff /absolute/path/to/scene-check
pnpm run test:detailed-view --out /absolute/path/to/detailed-check
pnpm run test:lan /absolute/path/to/lan-check <this-Mac-private-IPv4>
pnpm run test:claude-science --out /absolute/path/to/claude-check
pnpm run test:voice /absolute/path/to/voice-check
pnpm run test:pixel --out /absolute/path/to/pixel-check
```

The scene handoff uses synthetic native-export fixtures through the real
renderer. The detailed-view check opens stock Mol*, exports its state and
applies appearance and camera changes back to Stereofold.

The LAN check covers pairing, source replacement, reload, remembered-device
reconnect, revocation and cleanup. It uses a separate certificate and remembered
device store and removes it on exit. Other isolated hosts can set the absolute
`STEREOFOLD_LAN_CERTIFICATE_STORE` directory without changing `HOME`.
It also records eight background-color edit-to-rendered-receipt timings on
1CRN. These observations cover the local HTTPS path, excluding model reasoning
and a physical Wi-Fi hop; they are not varied-edit or large-structure latency
qualification, and the script does not enforce a latency threshold.

The Claude Science check emulates its nested sandboxed host, including denied
popups and clipboard access. It verifies server-side browser launch, detailed
view handoff, saved state, and rendered tool commands. It is not a live Claude
application test. Run GPU browser checks sequentially, especially software XR.

The voice check uses a generated WAV as the browser microphone, a deterministic
transcript and synthetic reply audio. It disables ambient transcription and
speech providers. It verifies cancellation and playback receipts without making
an OAuth or paid-provider call.

## Software XR

For focused software XR, prepare the repository's pinned IWER runtime from the
repository root:

```sh
python3 lab/headset-preview/prepare-runtime.py --out /absolute/new-runtime
```

Provide an executable local speech fixture at `/absolute/test-voice.py` so this
test does not use the installed OAuth helper. This fixture writes silence and
does not test speech quality:

```python
#!/usr/bin/env python3
import sys, wave
args = sys.argv[1:]
with wave.open(args[args.index('--out') + 1], 'wb') as audio:
    audio.setnchannels(1)
    audio.setsampwidth(2)
    audio.setframerate(22050)
    audio.writeframes(bytes(22050))
```

Then, from `plugin/`, with the fixture executable and no competing GPU work:

```sh
STEREOFOLD_TOUR_IWER_ONLY=1 STEREOFOLD_AGENT_VOICE_BIN=/absolute/test-voice.py \
  pnpm exec tsx scripts/companion-browser.ts /absolute/new-xr-check \
  --xr-runtime /absolute/new-runtime/iwer.min.js --dist /absolute/plugin/dist
pnpm exec tsx scripts/xr-gate.ts /absolute/new-xr-check
```

Keep the compiled `dist` unchanged throughout the run. The focused check covers
the journey toolbar, paging, playback, saved camera, and attachment lifecycle.
It excludes the broad molecular-control suite. Inspect the gate's contact sheet
as well as its JSON result. A separate run with
`STEREOFOLD_XR_DEADLINE_RECOVERY_ONLY=1` added deliberately holds one renderer
continuation beyond the unchanged 45-second deadline. It checks rollback,
subsequent commands, and toolbar visibility with the molecule moved aside.
Use a new output directory and run the gate on that directory too. Software XR
does not establish physical-device frame rate or comfort.

## Native controller input acceptance

From `plugin/`, run the small local 1CRN fixture through the production
companion, IWER gamepads, native XR callbacks and saved inspection state:

```sh
pnpm exec tsx scripts/companion-browser.ts /absolute/new-controller-check \
  --xr-runtime /absolute/new-runtime/iwer.min.js --controller-input --mode vr
```

This focused run uses an isolated scene registry and a silent local speech
fixture. It checks both hands with injected tracked-position, emulated-position,
and null poses: trigger-stick depth, grip-stick growth past 4× followed by
further growth, and B/Y recovery without a controller pose. It also counts
adapter snapshots per hand and XR timestamp. Recovery requires toolbar geometry
and a subsequent draw; the report projects recorded row centres into both eyes
without pixel readback. Those bounds exclude plate and glyph edges.
The smaller simulator framebuffer
keeps this a control and persistence check; it does not qualify physical
tracking, menu legibility, comfort, or device frame rate.

## What these checks leave out

A separate [opt-in Live acceptance test](../plugin/scripts/LIVE-BROWSER.md)
can verify real GPT-Live1 client delegation, a selection-scoped rendered edit,
and browser audio playback. Each run bills the OpenAI account whose key it uses, and it
does not replace the production OAuth voice route.

These checks do not establish that Codex mounted its native panel, or verify
headset comfort, physical controls, microphone quality or real-device performance.
