# Inspection history and saved views

`history.mjs` records reversible inspection changes, saved views, cancellation,
and renderer outcomes for one receiver binding. `replayHistory(log)` reconstructs
the recorded state without calling a renderer or sending a command.

Run the focused checks from the repository root:

```sh
node --test --test-concurrency=1 lab/protocol/history.test.mjs
```

The unit tests supply camera snapshots and draw receipts. Actual rendering is
checked by the browser experiment when its driver connects this module.

## State and scope

Construct `InspectionHistory` with a monotonic `clock`, the allowed `actors`,
and these inputs:

```js
const history = new InspectionHistory({
  clock,
  scope: { target, serverEpoch, receiverEpoch, leaseId, sceneId },
  initial: {
    revision, sourceSha256, modelNumber, assemblyId,
    representation, color: 'chain-id', selectionKeys, camera,
  },
  selectionKeys: catalogKeysForThisModelAndAssembly,
  actors: ['browser-driver'],
  initialRenderer: { instanceId, generation, loadCount, browserRevision, drawCount },
});
```

`target` uses the existing binding, task, panel, session, and device fields.
Every request and event retains that target, both epochs, lease, and scene.
The source hash, model number, and assembly remain fixed for this history.
Start a new history after the receiver authorizes a replacement binding or scene.

The selected residues use full canonical keys from the main identity catalog.
Construction checks their source, model, and assembly copy. Selection checks
membership in that catalog. An unresolved residue retains its key and receives
no fabricated position.

`camera.mjs` contains the bounded Mol* camera schema extracted from the browser
coordinator. A saved view retains all 11 camera fields and the selected keys.
The coordinates refer to the molecular source frame. Viewport, eye projection,
room placement, and head tracking are outside this schema.

Shared `revision` and `browserRevision` count different changes. Saving a view
advances the shared revision and records metadata; it requires no draw.
`lastRendered` retains the earlier draw and its observed snapshot. A saved view
requires that the visible fields still match that confirmed snapshot.

## Applying a change

`makeRequest(operation, { operationId, actorId, expectedRevision })` supplies the
scope and defaults to the current shared revision. IDs use the receiver lease
prefix, such as `lease-a/1`. Admission validates the request and retains its
exact content. An identical retry returns the existing result. A changed
request under the same ID fails.

```js
const request = history.makeRequest(
  { kind: 'set_representation', value: 'ball-and-stick' },
  { operationId: command.commandId, actorId: command.actorId },
);
history.admit(request);
const planned = history.preview(request.operationId);
history.commit(request.operationId, planned.snapshot);
// The coordinator applies the change and verifies its actual renderer result.
history.confirmRendered(request.operationId, {
  revision: planned.snapshot.revision,
  instanceId, generation, loadCount, browserRevision, drawCount,
});
```

Commit verifies the expected snapshot, advances shared state once, and records
the prior snapshot for a possible inverse. `confirmRendered` checks the shared
revision, bound renderer instance, load generation, successful load count,
next browser revision from this operation's dispatch baseline, and a later draw. The caller supplies this receipt only
after its existing renderer proof succeeds. Receipt validation alone does not
authenticate a browser or establish pixel correctness.

| Operation | Recorded behavior |
| --- | --- |
| `set_representation` with `value` | Set Cartoon or Ball and stick. |
| `set_selection` with `selectionKeys` | Change semantic selection while preserving the camera. |
| `set_camera` with `camera` | Change the complete declared camera snapshot. |
| `save_view` with `viewId` and `name` | Store the confirmed camera and selection under a unique ID and name. |
| `restore_view` with `viewId` | Restore the saved camera and selection while preserving appearance. |
| `undo` with `operationId` | Restore the supported original change's preceding inspection snapshot. |

`prepareUndo(originalId, { operationId, actorId, expectedRevision })` constructs
the inverse request and its cause reference. The original must have rendered,
belong to the same actor, and remain the latest shared revision. The commit
checks those conditions again. A newer edit causes a conflict, including a
newer edit by the same actor. An inverse uses a new ID; retrying it applies once.
Saved-view creation, unfinished changes, and undo itself have no inverse in
this draft.

## Cancellation and failure

`cancel(id, actorId)` cancels that actor's admitted work before commit.
`reject(id, reason)` records a rejected pending operation. `supersede(id, reason,
byOperationId)` retires pending work when its intended result is overtaken.
A newer commit supersedes an older unconfirmed commit in the same atomic log
update after the caller reconciles the current renderer state. A malformed new
snapshot or baseline leaves the older operation intact.

If A renders but its acknowledgment is lost, capture and validate its actual
scene and frame before dispatching B. Supply that observation when committing B:

```js
history.commit(b.operationId, plannedB.snapshot, {
  rendererBaseline: {
    operationId: a.operationId,
    snapshot: observedA, // Complete history snapshot, with A's shared revision.
    receipt: {
      revision: observedA.revision,
      instanceId, generation, loadCount, browserRevision, drawCount,
    },
  },
});
// Apply B once, verify its complete scene, then supply B's actual frame receipt.
history.confirmRendered(b.operationId, receiptB);
```

The observation must match A's retained committed snapshot and the current
history state, including source, model, assembly, appearance, selection, and
camera. Its instance, generation, and successful load count must match the
initial receiver binding. Its browser revision must be exactly one past A's
own dispatch baseline, with a later draw. B then requires exactly one further
browser revision and draw. This allows B's real counter to be two past the last
confirmed frame without accepting unexplained jumps.

The baseline becomes part of B's commit record. It does not mark A rendered or
advance `lastRendered`. A remains superseded with no rendered revision; only
B's valid confirmation updates the last confirmed frame. Replay checks the
same baseline chain. Capture the baseline before applying B, and keep mutation
ownership exclusive until B's result is checked.

Confirmed sequential operations keep the two-argument `commit` API. A newer
commit without reconciliation fails when a preceding render remains
unconfirmed, even if the retained visible fields happen to match an older
confirmed view. Saving that unconfirmed state also fails. If an actual scene
or renderer binding cannot be reconciled, recover it and establish a new
history before dispatching another operation.

`rendererFailed(id, reason)` records a known failure after commit. The model
retains its committed state and the last confirmed draw. Retrying the same ID
returns the failure record. The consumer must choose an explicit recovery
operation or establish a fresh receiver binding; replay does neither.

The existing receiver continues to enforce lease expiry, controller ownership,
and command authorization. Feed every deliberate local edit through the same
revision owner before relying on history for undo. Recheck actual browser
state at the apply point so an unrecorded local edit cannot be overwritten.

## Retention and replay

The default bounds are 64 operations, 256 events, 16 saved views, 128 selected
keys per snapshot, and 8 MiB of encoded header/events plus reserved space.
Admission reserves room for the preceding renderer snapshot, the new snapshot,
and the remaining commit and terminal events. At capacity, new work fails while known retries and reserved outcomes
remain available. Records are retained for this history; none are evicted to
make a replayable ID appear new.

`exportLog()` returns a detached, deeply frozen JSON log. Each event records its
index, monotonic time, scope, actor, operation ID, cause, revision, and phase.
Consecutive hashes detect changed or reordered bytes. Replay also validates
phase ordering and the resulting state, so recomputing a hash cannot excuse an
invalid transition. The hashes provide consistency checks, not authentication.

`replayHistory(log)` returns the same inspection result as `inspect()`, including
saved views, pending work, terminal outcomes, and the last recorded draw.
That draw remains a historical observation.

## Browser coordinator connection

The driver can share `camera.mjs` with the coordinator through an import and
re-export of `validateCamera`, `camerasEqual`, and `CAMERA_TOLERANCE`. The history
module imports no browser coordinator, so the coordinator can later import it
without a cycle.

The first integration can mirror a representation command using its existing
command ID and actor. Record receiver admission and commit, then confirm history
after the coordinator validates its Node-held render ticket. For camera restore,
apply the planned selection and camera through a single revision owner and
collect its actual draw receipt. Keep this metadata revision separate from the
browser's own revision. Reconcile every failure before allowing a later change.
