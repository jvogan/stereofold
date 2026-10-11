# Scene replacement and renderer lifecycle

The viewer retains the current Mol* state while it builds a candidate in the
same WebGL context. It verifies source bytes, parses the requested model and
assembly, maps selections, and creates a hidden representation. The existing
scene remains intact during those steps.

Before switching representations, the viewer copies the current canvas into
one temporary 2D canvas. That image covers the candidate draw and blocks new
pointer input. The viewer removes the original representation from Canvas3D
without destroying it, shows the candidate, and requires a new frame containing
the candidate's geometry. It deletes the original state only after this check.
Removing the cover exposes the accepted scene.

A rejected candidate is removed. The viewer reattaches the original
representation, restores its camera and selection, and requires a recovery
frame before removing the cover. The load promise rejects with the original
failure. `lastLoadFailure` records the stage, error, cleanup, and recovery draw.
If restoration also fails, the promise reports both failures and the viewer
stays unavailable.

This path normally holds two scene subtrees and one image during replacement.
It creates no additional WebGL context. `candidateCount`, `stateCellCount`,
`frameCoverBytes`, and `pendingFrameWaits` expose the retained work for browser
checks. Repeated replacements should return these measurements to their
corresponding settled values.

## API and counters

`load(fixture, options)` preserves its existing source and scene contract.
Invalid preflight input leaves the current generation unchanged. An accepted
attempt advances `generation` to invalidate earlier renderer observations.
Only a successful replacement advances `loadCount`, `revision`, and
`mutationCounts.load`.

`cancelLoad()` cancels an admitted replacement and waits for its cleanup and
recovery. The pending load rejects with `load_cancelled`. The cancellation
returns `{cancelled, snapshot}`; it returns `cancelled:false` when no replacement
is active. Concurrent replacements and other mutations are refused while one
replacement owns the viewer.

`dispose()` closes admission immediately and returns a promise. Await that
promise before reporting renderer cleanup. It releases paused tests and frame
waits, lets admitted Mol* work unwind, removes the remaining state, and destroys
the owned context. `snapshot()` stays readable throughout disposal;
`cleanupPending` changes to `false` and `contextDisposed` to `true` when cleanup
finishes.

Context loss sets `ready:false` and advances `generation`. The viewer retains
the previous scene choices and rejects interrupted work. After Mol* restores
its GPU resources, the viewer removes failed candidates and redraws those
choices before becoming ready. `contextLossCount` and `contextRestorationCount`
record the actual context events and completed recovery draws. Restoration does
not turn an interrupted operation into a successful one.

## Explicit browser test hooks

Pass `enableTestHooks:true` to `createViewer` only in the lab driver. Normal
instances have no `testHooks` property.

| Hook | Behavior |
| --- | --- |
| `failNextLoadAt(point)` | Reject the next admitted load at the named checkpoint. |
| `pauseNextLoadAt(point)` | Pause the next admitted load there until release, cancellation, disposal, or the 30-second test deadline. |
| `resumeLoad()` | Release that test pause; return whether a pause was present. |
| `loseContext()` | Call the browser's `WEBGL_lose_context` extension; report whether it is available. |
| `restoreContext()` | Request restoration through the same extension. |
| `waitForContextRecovery()` | Await the recovery started by the browser's restoration event. Reject if recovery fails. |

The named checkpoints are `after_parse`, `after_representation`, and
`after_candidate_draw`. The last checkpoint follows a real candidate frame
under the cover. Failing there tests rejection after rendering; it does not
simulate a shader compiler failure. Context-loss cases exercise graphics
interruption separately. The hooks do not change Mol* code or its renderer.

The browser verifier should compare the complete prior capture after each
rejected checkpoint, then exercise another selection, camera change, and real
pick. It should also cancel a paused candidate, refuse a competing load,
dispose during a pause, and test context loss both at rest and during
replacement. Check one settled representation, no candidate or frame cover,
and no pending frame wait after recovery. Record extension unavailability
separately from a passing restoration test.

These checks exercise the isolated browser adapter. They do not qualify the
actual Codex bridge, native voice, or a headset.
