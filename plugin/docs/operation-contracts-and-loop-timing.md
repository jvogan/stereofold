# Scientific operations and voice timing

Every command receipt has an additive `operation` field. Existing receipt fields keep their meanings. Only `status: rendered` confirms a draw and save.

A `visual-edit` changes the scene view. It does not change coordinate bytes. Colour, opacity, labels, camera, selection and placement belong here. A view transform is not a validated chemical change. `effects` names the change kinds. `tool` names the tool that asked.

A `coordinate-artifact` replaces the loaded source. Growth loads a checked tier from the demo index. It may select deposited chains or assembly operators. It does not simulate growth. A density tier names `artifact: density` and its map preparation. It sets `sourceChanged: true` and `coordinatesChanged: false`. `chemicallyValidated: false` makes this limit explicit.

The growth response has `operation`. Later state reads have `sourceOperation` for that source. Other source loads clear it. A value of `null` means no growth contract was recorded. It does not imply that the source has been validated. Visual edits keep that source record. Each command keeps its own visual contract.

Artifact provenance records these fields:

| Field | Meaning |
| --- | --- |
| `sourceAddress` | The download address in the demo index. |
| `derivation` | Tier, assembly, subset recipe, and map preparation when used. |
| `sha256` | Digest of the exact loaded artifact bytes. |
| `fetchedAt` | Fetch completion time in epoch milliseconds, or `null`. |
| `verifiedAt` | Time this host checked the artifact for this growth request. |
| `requestedBy` | Tool that requested the artifact. |

Old cache files have no known fetch time. Reading a file does not count as fetching it. Prepared maps also report an unknown fetch time. No timestamp is inferred from file metadata.

`get_inspection_state.operationInventory` lists renderer change kinds from the actual schema. It describes scene edits. It does not grant access to tools. Camera import still uses the existing detailed-view path. New chemistry computations are not enabled by this contract.

# Measure a voice loop

The page records `kind: voice-loop` in its diagnostics ring. Each entry has a stage and `commandId`, `utteranceId`, or both. The ring's `at` is epoch milliseconds. Text and audio are not copied into these entries.

| Stage | Recorded when |
| --- | --- |
| `microphone-release` | Capture receives its stop request, before final upload. |
| `transcript-received` | The page gets the transcript result. |
| `action-posted` | The caller dispatches the action. |
| `receipt-rendered` | The page gets a rendered receipt, or local dispatch resolves. |
| `spoken-confirmation-started` | The audio source starts on a running context, or media playback starts. |

Local actions use `utteranceId`. They have no host command receipt. Their rendered stage means local dispatch resolved. Some local actions only change menus. Host actions use `commandId`. Their receipts also carry `acceptedAt` and, only after a successful commit, `renderedAt`. These are host times. The page receipt time includes the reply trip.

Action tools accept optional `utteranceId` and `actionPostedAt`. Keep these fields fixed on retries. `actionPostedAt` is the caller's timestamp. It is not a host assertion. The voice bridge sets both fields. Its completion caption carries both IDs through `say_to_headset`. Other callers should copy the transcript's utterance ID and pass the command ID on the completion caption. Unbound speech cannot be matched by guessing from its text.

Save the page diagnostics list and the host state response. Run:

```sh
pnpm --dir plugin exec node --import tsx scripts/loop-timing.ts diagnostics.json receipts.json
```

The second file may contain one receipt, a list, or a state response. The report prints five stage times and adjacent gaps per command. Local actions appear as `utterance:<id>`. Missing stages remain missing. A failed command does not gain a rendered time. Repeated dumps do not add extra loops.

A star marks a gap across page and host clocks. Check clock sync before treating it as latency. Negative gaps stay visible. A speech start may precede receipt delivery. The report does not hide that order. Playback start does not prove that the wearer heard sound. Browser speech without an audio clip may have no timing record. Old clients may leave several stages missing.

Collect small and dense scene samples before setting a latency target. The report measures latency; it sets no target.
