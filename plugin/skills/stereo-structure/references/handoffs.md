# Handoffs, lessons, and saved views

## Molecular Structure Viewer snapshot

Use `inspect_scene` for local `scene-json` and `selection-mmcif` exports from
the separate standard Molecular Structure Viewer:

1. Read `structure.get_state` for revision `R` and the intended `objectId`.
2. Export both artifacts from that same session with `expectedRevision: R`.
   For coordinates, explicitly pass `selection: { kind: "all", objectId }`;
   omitting it can export only the current selection.
3. Resolve returned artifacts through the host's admitted local export
   destination. Call `inspect_scene` with `scenePath`, `coordinatePath`, and
   `nativeExports: { expectedRevision: R, exportSelection: { kind: "all", objectId } }`.
   Native sidecars are checked automatically. Relocated sidecars can use
   `sceneProvenancePath` and `coordinateProvenancePath` in `nativeExports`.
4. Read the default `mode: "check"` report, which opens no session. Use
   `mode: "matching-scene"` for supported scene preservation. For an unsupported
   scene, explain the omitted features and use `mode: "structure-only"` if the
   user chooses coordinates alone or already requested that handoff.
5. Keep the newly returned `sessionId` and wait for its panel to render, save,
   and acknowledge the imported scene before connecting a headset.

Preserve the real sidecars; authored replacement provenance cannot establish
an upstream export. Native receipts check local digests, revision, and identity
metadata, including source hashes when both receipts contain them. Provenance
remains `declared-local`: receipts do not authenticate a live session, object,
or full-object scope. The export request supplies that scope.

Matching accepts one supported object and camera/style subset, including the
standard polymer-cartoon and ligand-sticks layer pair. Stereofold renders the
ligands as ball-and-stick. Hidden water, ligand, and ion classes transfer when
the layer target contains only those exclusions. An assembled single-copy
export already contains transformed coordinates and reports `asymmetric_unit`
in the local catalog.

Matching requires an empty upstream selection and identity object matrices.
Nonempty or truncated selection, active clipping through coordinates,
`colorOverrides`, measurements, maps, annotations, and extra layers can refuse
matching. Camera clipping is dropped only when parsed coordinates prove it
cannot cut the molecule. Exports already bake object transforms into coordinates;
reapplying placement would apply the transform twice. Explicit structure-only
preserves those baked coordinates. Native `object|instance|element` selection
IDs have no proven exported atom-site mapping. The legacy declared-source
adapter supports selected raw atom IDs at residue granularity.

Exact atom IDs use canonical signed 32-bit integer spelling; model numbers are
positive signed 32-bit integers. Unsupported identities are refused rather
than renumbered. Coordinate exports omit explicit bonds and bond order.
This is a snapshot, with no live synchronization. Each import creates a new
Stereofold session. Preserve an existing wearer connection; use
`replace_inspection_source` for a source-only public replacement in that session.
For a richer requested scene, author an explicit immersive adaptation after
explaining which native features need a separate representation.

## Send a source to the standard viewer

The inspector's **Open in Molecular Structure Viewer** action sends a source
request to its host. For a public load it carries a server-proven PDB ID; for
`inspect_file` it carries the exact desktop-private file path and cached SHA-256.
Verify that file before calling `structure.open_from_chat`. This action carries
no scene styling, camera, selection, placement, or live session. It is unavailable
for pasted coordinates, fixtures, and imported snapshots. Confirm the standard
viewer's own mounted/rendered state before reporting success.

## Bundled full Mol* view and return

For the requested full Mol* interface on the host, first read
`get_inspection_state`, then call `open_detailed_view` with `open: true` and:

- `sessionId`, `serverEpoch`, and `sourceToken` from that state.
- `baseStateRevision` from `stateRevision`.
- `baseInspectionRevision` from `inspectionRevision`.

Automatic browser opening is macOS-specific. On another host, use the returned
loopback link in a local browser. Keep its page key in the original result.
This bundled view includes Mol* measurements, components, sequence, and exports;
it requires no separate viewer plugin.

It carries coordinates, model, assembly, color, opacity, background, selection,
and labels. It fits the camera to the structure and draws surface/spacefill as
cartoon. Placement, tours, and immersive state stay with Stereofold; later edits
do not synchronize. The headset's **Mol*** row opens this viewer in the headset
and ends XR. The model-side `open_detailed_view` opens it on the host.

The full viewer's **Apply changes, then back to headset** sends appearance,
selection, and camera back. **Back to headset view** arms a tap to re-enter XR
for 120 seconds. If the return cannot finish, the page saves a `.molj` file.
`import_detailed_view` takes that absolute `filePath`, the full current binding,
a target `panelId`, and a new `commandId`. Wait for the appearance command's
receipt. If `cameraPending` is true, call again with the same file, refreshed
binding, and a new command ID until nothing remains queued. Only camera pose
transfers; scene radius, fog, and near/far bounds stay with the panel. Report
listed omissions. `.molx` archives are refused; use `.molj`.

If the wearer asks to return or cannot find the return control, call
`recall_headset` with the current `sessionId` and optional `text` of 1–160
characters. It needs no revision or panel binding. The detailed page polls for
that request and returns to the same paired companion scene, with one-tap XR
re-entry armed. Use `companionInDetailedView` from `get_inspection_state` to
identify this situation. The call queues the return; follow
`detailedRecallReceipt` in that state until `status: "returned"` confirms the
companion attached again. `read` means the detailed page took the request;
`queued` means it has not completed, and an unread request expires after ten
minutes. The message appears on the detailed page without speech. Once the
companion returns, use `say_to_headset` if an audible reply is wanted.

## Lessons and illustrated scenes

`inspect_lesson` takes absolute `filePath` and `lessonPath`, optional
`densityPath`, and optional `assemblyId` declared by the source. Every chapter
needs explicit supported `immersive` intentions. An optional
`provenance.sourceSha256` must match the exact coordinates, or density bytes
for a density lesson. Source metadata is authored provenance, rather than a
live viewer binding. Read the installed `molecular-presentation` skill to author
and compile lessons, or to use native desktop `structure.apply_scene` plans.

Use the named demo index to choose source, digest, and assembly. The
`daraxonrasib` demo uses PDB 9AX6, biological assembly `"1"`, and
`demos/daraxonrasib.json`. Open it with `inspect_lesson`; plain PDB inspection
loads the molecule with generic tours. Its figure layers, labels, contact dots,
and measured dashed contacts are authored scene intentions. Contacts establish
distances, rather than chemical bond assignments. Move/rotate/scale carries
the complete figure. Edit its lesson definition for individual figure changes.
Saved inspection scenes and named views include the figure graph. Native
snapshot import does not. A fresh desktop or headset page also restores a saved
lesson’s chapter, narration choice and starting view. It resumes paused without
replaying the chapter or moving the molecule; Next continues the lesson and
Done restores the starting view.

In the headset, the wearer can move, turn and scale the structure while a
lesson plays. This keeps the chapter and its labels active. Automatic motion
waits during a molecular drag; a chapter change due during that drag follows
on release. Next and Back preserve the placement the wearer chose. Pause and
Stop remain explicit playback controls, and a source change ends the old
lesson. If a tool reports a chapter waiting for the drag, check the current
chapter after release before sending another navigation command.

## Named views

`manage_inspection_view` manages up to sixteen views in the live server session:

| Action | Required target fields, in addition to its current binding |
| --- | --- |
| `list` | `sessionId`; no panel or command |
| `save` | Explicit ready `panelId`, new `commandId`, `name`; `replaceViewId` for replacement |
| `restore` | Explicit ready `panelId`, new `commandId`, listed `viewId` |
| `delete` | Listed `viewId` and `viewRevision`; no panel |
| `return-to-desktop` | Explicit ready desktop `panelId`, new `commandId`, `viewId` with an object-relative angle |

Save and restore are queued operations; check their command receipts.
Restore preserves captured appearance, scoped styles, placement, selection,
emphasis, and hidden components. Label foreign-source entries and let the user
choose another source; cross-source restore is refused. Views end with the
server session. The inspector session expires after thirty minutes without
calls or when the server restarts; companion polling and `listen_voice` keep
it active. Preserve unsaved work when a panel offers **Load saved view**.
