# Scene commands

Use session-bound tools with the live inspection `sessionId`. The common implicit
binding fills `serverEpoch`, `sourceToken`, `baseStateRevision`,
`baseInspectionRevision`, `panelId`, and `commandId` when omitted. It targets
the companion when attached. Pass explicit fields to protect a particular
revision or select a different ready panel. Use `waitForRenderMs` and inspect
receipts as described in the skill entrypoint.

## Tool examples

The table shows only the action-specific arguments. Add `sessionId` to calls
that accept it and `waitForRenderMs: 10000` to supported edits. `listen_voice`
and `say_to_headset` accept no top-level `sessionId`; `continue_session` discovers
the session itself. Common edit tools fill
omitted bindings; detailed-view tools require full current bindings, and
`import_detailed_view` also requires the intended `panelId` and a new `commandId`.
All named chains, residues, and components are examples to resolve against the
actual source. Read the handoff reference before using its tools.

| Group | What the wearer wants | Call | Arguments |
| --- | --- | --- | --- |
| Talk | An answer to what they just said | `say_to_headset` | `{"text":"Spinning it now."}` |
| Motion | "spin it" | `update_inspection` | `{"change":{"kind":"motion","patch":{"state":"spin"}}}` |
| Motion | "stop" | `update_inspection` | `{"change":{"kind":"motion","patch":{"state":"stop"}}}` |
| Tour | "start the tour" | `control_tour` | `{"action":"play"}` |
| Tour | "pause" | `control_tour` | `{"action":"pause"}` |
| Tour | "next" (with no tour running this starts the lesson at scene 1) | `control_tour` | `{"action":"next"}` |
| Tour | "back" (with no tour running this starts it at the last scene) | `control_tour` | `{"action":"back"}` |
| Tour | A named tour from `get_inspection_state` | `control_tour` | `{"action":"start","tourId":"fold-detective"}` |
| Tour | The tour chooser | `control_tour` | `{"action":"menu"}` |
| Look | "color chain A orange" | `update_inspection` | `{"change":{"kind":"appearance","residues":{"labelChain":"A"},"patch":{"color":"uniform","uniformColor":"#ff8800"}}}` |
| Look | "show the hemes as sticks" | `update_inspection` | `{"change":{"kind":"appearance","residues":{"componentId":"HEM"},"patch":{"representation":"ball-and-stick"}}}` |
| Look | "label residue 248" (every chain with it) | `update_inspection` | `{"change":{"kind":"compound","patch":{"ops":[{"kind":"selection","patch":{"residues":{"authorResidueRange":[248,248]}}},{"kind":"appearance","patch":{"labels":true}}]}}}` |
| Look | "label the heme" | `update_inspection` | `{"change":{"kind":"compound","patch":{"ops":[{"kind":"selection","patch":{"residues":{"componentId":"HEM"}}},{"kind":"appearance","patch":{"labels":true}}]}}}` |
| Look | "chain A orange and chain B blue" | `update_inspection` | `{"change":{"kind":"compound","patch":{"ops":[{"kind":"appearance","residues":{"labelChain":"A"},"patch":{"color":"uniform","uniformColor":"#ff8800"}},{"kind":"appearance","residues":{"labelChain":"B"},"patch":{"color":"uniform","uniformColor":"#0088ff"}}]}}}` |
| Look | "hide the water" | `update_inspection` | `{"change":{"kind":"visibility","patch":{"op":"hide","classes":["water"]}}}` |
| Look | Ribbons, atoms, surface or spheres | `update_inspection` | `{"change":{"kind":"appearance","patch":{"representation":"molecular-surface"}}}` |
| Look | A different color scheme | `update_inspection` | `{"change":{"kind":"appearance","patch":{"color":"chain-id"}}}` |
| Look | "see through it" | `update_inspection` | `{"change":{"kind":"appearance","patch":{"opacity":0.55}}}` |
| Look | "cut it open" | `update_inspection` | `{"change":{"kind":"appearance","patch":{"clipping":40}}}` |
| Look | "make it look better" | `update_inspection` | `{"change":{"kind":"render-quality","patch":{"level":"best"}}}` |
| Move | "bigger" | `update_inspection` | `{"change":{"kind":"placement","patch":{"scale":2}}}` |
| Move | "put it above me" | `update_inspection` | `{"change":{"kind":"placement","patch":{"translation":[0,1.4,0]}}}` |
| Move | "I can't see it" or "it's behind me" | `update_inspection` | `{"change":{"kind":"placement","patch":{"recenter":true}}}` |
| Move | Frame a known author residue range | `focus_selection` | `{"residues":{"authorChain":"B","authorResidueRange":[1,20]},"framing":"fill"}` |
| Source | "show me 1CRN instead" | `replace_inspection_source` | `{"pdbId":"1CRN","waitForRenderMs":10000}` |
| Move | Frame what is already selected | `focus_selection` | `{"framing":"context"}` |
| Room | "show my room" or "hide my room" | none | Room switching is a wearer menu or voice action in this renderer. The wearer says it, or presses the menu row, which reads `Room` before passthrough is reported, `Room on` when the room is showing and `Room off` when it is not. With passthrough off, `No room` means unavailable in this browser session and `Room?` means support is still unknown; both are disabled status readings. Tell them which. |
| Mol* | "open it on the Mac" — in the headset the wearer says "open in Mol*" to the page and stays there | `open_detailed_view` | `{"open":true}` |
| Mol* | Bring back what they saved there | `import_detailed_view` | `{"filePath":"/absolute/path/to/state.molj"}` |
| Session | Show the structure on this Mac only, with no headset | `open_inspector` | `{"sessionId":"<sessionId>","waitForSceneMs":40000}` using the ID that `inspect` returned |
| Session | Put the page on Meta Quest, right after `inspect` | `open_companion` | `{"connection":"lan","headset":"meta","launch":"web"}` |
| Session | Put the page on Apple Vision Pro, right after `inspect` | `open_companion` | `{"connection":"lan","headset":"apple","launch":"auto"}` |
| Session | Put it there again | `manage_companion` | `{"action":"launch","launch":"web"}` |
| Session | Revisions, panels and one receipt | `get_inspection_state` | `{"commandId":"spin-1"}` |
| Session | The share, the clients, the browser | `manage_companion` | `{"action":"status"}` |
| Session | "Stop sharing" | `manage_companion` | `{"action":"close"}`; confirm `lan: null` and `wearer.shareOpen: false` in the returned state |
| Session | Clear a stuck Quest Browser | `manage_companion` | `{"action":"recover-browser"}` |
| Session | Enter VR for a wearer on the flat page | `manage_companion` | `{"action":"enter-vr"}` |
| Eyes | Both eyes as the wearer sees them | `capture_headset_view` | `{"source":"device","maxWidth":1600}` |
| Eyes | The rendered scene, from the page | `capture_headset_view` | `{"source":"page","maxWidth":480}` |
| Eyes | Why a control did nothing | `read_headset_browser` | `{"consoleMs":1200}` |
| Eyes | What the page logged on its heartbeat | `read_headset_log` | `{"limit":40}` |
| Voice | Wait for the wearer to speak into the headset microphone | `listen_voice` | `{"timeoutSeconds":20,"cursor":0}` |
| Session | Join the scene this Mac already has | `continue_session` | In Codex: `{"assistant":"Codex"}`; in Claude Code or Claude Science: `{"assistant":"Claude"}` |
| Voice | Hand the wearer's voice to another assistant | `switch_assistant` | `{"to":"Codex"}` |
| Look | Take back the last change, whoever made it | `undo_last_change` | `{}` |
| Look | Reapply the last undone change | `redo_last_change` | `{}` |

## Appearance, selection, placement, and quality

`update_inspection` takes a `change` with `kind` and `patch`:

| Kind | Patch |
| --- | --- |
| `appearance` | `representation`, `color`, `uniformColor`, `opacity`; whole-scene patches also accept `background`, `highlightColor`, `labels`, `clipping`, and `fog` |
| `selection` | `residues: {...}` replaces selection; `selectionKeys: []` clears it |
| `visibility` | `op: "hide" | "show" | "only" | "reset"`, with `chains` or `classes` |
| `placement` | Absolute `translation` in molecular radii, `rotation` in degrees, positive `scale`, or `recenter: true`. Exploration supports scale 0.000001–1000000 and translation ±1000000 per axis as numerical guardrails; Fit and Reset choose a readable starting view. |
| `motion` | `state: "spin" | "stop"` |
| `render-quality` | `level: "fast" | "balanced" | "best"` |
| `compound` | `ops` containing two through seven edits; one render and one undo |

## Label residues, ligands and regions

`labels` is a boolean for automatic residue-identity labels, not custom text.
It labels the selected residues, at most 32, with residue names and ligand
codes such as `MOV 303`. Do not claim a larger selection is completely labeled.

For one residue, one contiguous range or one ligand, select and label in one
compound with no state read first; the host refuses a selector that matches
nothing:

```json
{"change":{"kind":"compound","patch":{"ops":[{"kind":"selection","patch":{"residues":{"authorResidueRange":[248,248]}}},{"kind":"appearance","patch":{"labels":true}}]}},"waitForRenderMs":10000}
```

Without a chain, the range labels that residue on every chain that has it.
One selection names one region, so "label R248 and R273" or "Cys12 and the
drug" need `selectionKeys`: send their `get_inspection_state` residue reads
together in one turn, then one compound with all the keys and `labels:true`.
A `{"classes":["ligand"]}` read lists ligand codes when the code is unknown.

The page highlights selected atoms, and the highlight can replace a color set
on them. A selected ligand or a selected cartoon stretch is painted with the
selection mark, magenta (`#ff2dd4`) unless the background or highlight color is
close to it. Selected residues drawn as sticks keep their own color inside an
outline in the highlight color. Call selected atoms highlighted and name no
color for them. Clearing the selection also removes their labels. To show a
region in a chosen color, color it with a scoped appearance and leave it
unselected.

Labels show codes, so name a ligand in your reply and headset caption
("sotorasib, labeled MOV"). Confirm a rendered label edit in one short
sentence; report receipt details only when something failed or is pending.

For a text name on a region, such as “receptor-binding domain”, install a
one-chapter lesson with one figure label into the current scene. It keeps the
scene's colors and selection, draws no scene card, and adds lesson controls to
the headset menu; replacing the source removes it:

```json
{"lesson":{"version":1,"id":"rbd-name","title":"Receptor-binding domain","mode":"explore","presentation":{"captionCard":"hidden"},"provenance":{"sourceRefs":[{"kind":"public","ref":"https://www.rcsb.org/structure/6VXX"}]},"chapters":[{"id":"named","title":"Receptor-binding domain","caption":"Receptor-binding domain","durationSeconds":20,"changes":[{"kind":"hold","durationSeconds":20}],"immersive":{"figure":{"layers":[{"id":"rbd","target":{"chain":"A","residues":{"from":319,"to":541}},"representation":"cartoon","color":"#ff8800"}],"labels":[{"id":"rbd-name","target":{"chain":"A","residues":{"from":440,"to":440},"atomName":"CA"},"text":"Receptor-binding domain","color":"#ffffff"}]}}}]},"start":{"chapterId":"named","autoplay":false,"narration":false},"waitForRenderMs":10000}
```

Figure targets use author chains. Give the layer the region's current color.
A figure allows 16 labels of at most 60 characters. If installation fails,
keep the region colored and name it in the reply and caption. For longer
lessons, read the [molecular-presentation skill](../../molecular-presentation/SKILL.md)
and use `inspect_lesson` for a new scene. Generic lesson part plates use dark
text on a white backing; figure labels retain their authored colors.

Representations include `cartoon`, `ball-and-stick`, `molecular-surface`, and
`spacefill`; `sticks`, `surface`, and `spheres` are accepted aliases. A scoped
appearance patch names `residues` beside `patch`, rather than inside it:

```json
{"kind":"appearance","residues":{"labelChain":"A"},"patch":{"color":"uniform","uniformColor":"#ff8800"}}
```

For different region colors in one request, use a compound of scoped appearance
patches. Other kinds occur once in a compound. Selectors can combine
`labelChain`, `authorChain`, `componentId`, `classes`, `authorResidueRange`, or
`labelSequenceRange`. Learn identities from the current source and state. An
unresolved sequence residue can be selected but has no 3D highlight.

Appearance and placement preserve selection and viewpoint. Selection preserves
appearance and placement. `focus_selection` frames a selected or named region
with `framing: "context"` or `"fill"`. `emphasize` can highlight a named part
from a lesson's color key. Placement moves the molecular object. Recenter runs
the headset's Reset, restoring entry size and placing the molecule and menu in
front of the wearer; it requires an active immersive companion. Its receipt
reports a partial result if the molecule resets but the menu fails to move.

`balanced` is the default quality. `best` increases detail, framebuffer scale,
and immersive postprocessing; `fast` reduces the rendering cost. Quality does
not change the saved scientific scene. Check frame times on the actual device.
If the receipt says `scaleAppliesOnNextEntry: true`, report that resolution
changes after re-entry. Quest 2 measurements do not define other devices' limits.

`undo_last_change` reverses the last operation on the shared scene, including
agent, desktop and headset edits. `redo_last_change` reapplies the most recently
undone operation. A compound counts as one operation, and both tools preserve
the viewer's viewpoint. A new scientific edit clears redo; camera-only saves
preserve it. Add `sessionId` and `waitForRenderMs: 10000`; omitted bindings use
the current scene. `undone: false` or `redone: false` means no step is available.
Only a `rendered` receipt confirms a draw; `saved` retains the change for a
paused headset. History entries move only after those confirmations.

## Context relative to the molecule

An immersive panel can report transient `spatialContext`: head position and
view direction relative to the molecule's center, in original `molecule-local`
axes and molecular radii. Use it only for a current, ready panel with
`spatialContext.stale: false`, and refresh state immediately before a contextual
command. It carries no anatomical front/back, continuous gaze, eye tracking,
or room/world coordinates. XR exit clears it; it never enters saved scenes
or the shared camera.

## Tours, experiences, and growth

For a requested generic tour, choose a `tourId` from `get_inspection_state` and
call `control_tour` with `action: "start"`. Other actions include `play`,
`pause`, `next`, `back`, and `menu`. With no tour running, `next` starts the
lesson at its first scene and `back` starts at its last scene. Generic tours
illustrate concepts using the loaded molecule; they calculate no binding
scores and establish no binding-site identities.

For agent-paced narration, add `autoplay: false` to `start`. It selects the
named lesson and holds the first rendered chapter in one command. Advance
with `next`, or use `play` to begin timed playback. Omitted `autoplay` preserves
timed playback. Add `narration: false` when the host's live voice provides the
explanation; it disables scripted chapter speech for this lesson and leaves
ordinary replies available. Both fields are only accepted with `start`.
Next, Back, Play, and Rejoin retain that narration choice. A fresh `start`
with no narration field restores scripted speech.

For authored source-aware journeys, call `list_experiences`, then
`inspect_experience` with the chosen ID. `tubulin-eb3-lattice` is an available
assembly example. Use `navigate_experience` with its live experience revision
for source and assembly transitions. Generic `replace_inspection_source`
clears the active experience, so use it when the user requests a new public
structure outside that journey. Source replacement keeps the connection and
resets scientific scene state; wait for hydration, saving, and its receipt.

The headset's **Tour** row starts the journey matching the loaded source. If
none matches, it retains the scene and reports that. **Tours** opens the chooser;
**Next one** cycles it. A failed stage reports its reason and restores the
previous source and saved view unless a newer correction supersedes recovery.

`grow_structure` requires a staged lesson. `stage` accepts `next`, `back`,
`first`, `last`, or a tier ID. Read `deviceClass` from `manage_companion` status
and supply it as `device`. The microtubule lesson has monomer, dimer,
protofilament, wall, filament, tube, and tip tiers. Uncached coordinates are
fetched from the demo index and checked against its digest. The filament tier
requires a separately prepared EMD-6347 density map; the live player refuses
to prepare that asset. Use `tip` directly from `wall` when the map is absent.

For incremental assembly at fixed coordinates, open `microtubule-arrival`
at its `build` stage. Its seven reveal chapters add cumulative tubulin chains
without replacing the wall source. Use `control_tour` Next/Back for these
chapters; `grow_structure {"stage":"density"}` changes to its final EMDB
source. Supply the companion's reported `device` class. Prepare that map
before the session, verify the rendered source change, then let the wearer
choose **Above us** for a large overhead view. These are two indexed stages;
the atomic `tube` stage belongs to the separate `microtubule-growth` demo.

The staged Quest 2 growth workflow refuses tiers above 43,066 atom sites; the
tip tier at that count was exercised. This threshold belongs to this staged
path and does not establish an arbitrary-structure rendering ceiling. The tube
tier is refused without changing the scene. Other or unknown device classes
have no assigned Quest 2 threshold. For other structures or devices, check
actual rendering behavior instead of inferring a capacity from this workflow.
The authored growth color key is alpha tubulin blue, beta tubulin amber, EB3
green, and remaining context gray.
