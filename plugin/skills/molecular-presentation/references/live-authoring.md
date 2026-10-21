# Build and edit an animated scene

This example places crambin beside a hemoglobin subunit and swings ten crambin
residues about an illustrative pivot. It describes an authored motion, not a
physical interaction or measured trajectory. Use the installed
`stereo_structure` tools. Replace each `$name` below with the returned value
it names (an object stays an object, not a JSON string).

## 1. prepare_composite

```json
{
  "recipe": {
    "version": 1, "id": "crambin-pair", "title": "Two deposited bodies",
    "sources": [{"id":"1CRN"}, {"id":"4HHB"}],
    "bodies": [
      {"source":"1CRN", "authChains":["A"], "atoms":"all", "chain":"C",
       "matrix":[[1,0,0,0],[0,1,0,0],[0,0,1,0]]},
      {"source":"4HHB", "authChains":["A"], "atoms":"all", "chain":"H",
       "matrix":[[1,0,0,50],[0,1,0,0],[0,0,1,0]]}
    ]
  },
  "maximumAtomSites": 5000
}
```

From the complete preparation JSON (before the bounded summary), retain
`$source = source` including its `handle`, and `$sha256 = sha256`. The appended
summary shortens `source`; keep the complete object. Read `bodies` for output author
chains and `labelChainMapping` for visibility targets. Here C and H are assigned
by the recipe. Other molecules need their own checked targets.

## 2. inspect_lesson

```json
{
  "source": "$source",
  "lesson": {
    "version":1, "id":"crambin-pair", "title":"An illustrative hinge", "mode":"guided",
    "provenance": {
      "sourceSha256":"$sha256",
      "sourceRefs":[
        {"kind":"public","ref":"https://www.rcsb.org/structure/1CRN"},
        {"kind":"public","ref":"https://www.rcsb.org/structure/4HHB"}
      ]
    },
    "chapters":[
      {
        "id":"hinge", "title":"Move a residue range",
        "caption":"An authored hinge motion; the tether is illustrative.",
        "durationSeconds":10, "changes":[{"kind":"hold","durationSeconds":10}],
        "immersive": {
          "motion":"hold",
          "figure": {
            "layers":[
              {"id":"domain","target":{"chain":"C","residues":{"from":1,"to":10}},"representation":"cartoon","color":"#ff8800"},
              {"id":"rest","target":{"chain":"C","residues":{"from":11,"to":46}},"representation":"cartoon","color":"#58dcc9"},
              {"id":"partner","target":{"chain":"H"},"representation":"cartoon","color":"#0088ff"}
            ],
            "labels":[
              {"id":"domain-name","target":{"chain":"C","residues":{"from":1,"to":1},"atomName":"CA"},"text":"Moving residues 1–10","color":"#ffffff"},
              {"id":"partner-name","target":{"chain":"H","residues":{"from":1,"to":1},"atomName":"CA"},"text":"Hemoglobin subunit","color":"#ffffff"}
            ],
            "distances":[
              {"id":"ca-distance","a":{"chain":"C","residues":{"from":1,"to":1},"atomName":"CA"},"b":{"chain":"C","residues":{"from":2,"to":2},"atomName":"CA"},"color":"#ffffff","showText":true}
            ]
          }
        },
        "animation": {
          "version":1, "durationSeconds":4,
          "playback":{"autoplay":true,"loop":true},
          "tracks":[{
            "id":"hinge-domain", "chains":["C"],
            "selector":{"residues":[{"from":1,"to":10}]},
            "pivot":[16.967,12.784,4.338],
            "keyframes":[
              {"t":0,"rotation":[0,0,0,1],"translation":[0,0,0]},
              {"t":4,"rotation":[0,0,0.7071067811865476,0.7071067811865476],"translation":[0,0,0]}
            ]
          }],
          "tethers":[{
            "id":"connection", "from":{"chain":"C","residue":1,"atom":"CA"},
            "to":{"chain":"H","residue":1,"atom":"CA"},
            "color":"#ffffff", "label":"Illustrative connection"
          }]
        }
      },
      {
        "id":"context", "title":"Return to the deposited bodies",
        "caption":"The composite positions two deposited structures without alignment.",
        "durationSeconds":10, "changes":[{"kind":"hold","durationSeconds":10}],
        "immersive":{"motion":"hold","appearance":{"representation":"cartoon","color":"chain-id"}}
      }
    ]
  }
}
```

Retain `$sessionId = sessionId`, `$tourId = customTourId`, and the complete
submitted `lesson`. The figure's single measurement joins two CA atoms within
the same moving body. For a numeric answer use `measure` with those identities;
its annotations can also span independently moving bodies.

## 3. open_inspector

An MCP Apps host can mount the returned panel itself. Otherwise call:

```json
{"sessionId":"$sessionId","waitForSceneMs":40000}
```

Keep the panel open. A timeout preserves this session; continue reading state.

## 4. get_readiness

```json
{"sessionId":"$sessionId"}
```

In `readiness.items`, require `capability:"structure"` with `state:"ok"`
for the saved, ready scene. Optional
headset and voice failures do not block desktop lesson playback.

## 5. get_inspection_state

```json
{"sessionId":"$sessionId"}
```

Require `hasScene:true` and the intended `targetPanel` (or entry in `panels`)
with `current:true` and `availability:"ready"`. Opening coordinates alone cannot
satisfy this step. If a headset is requested, follow stereo-structure's pairing
route and verify that panel before continuing.

## 6. control_tour

```json
{"sessionId":"$sessionId","action":"start","tourId":"$tourId","autoplay":false,"narration":false,"waitForRenderMs":10000}
```

Keep its `commandId`. Confirm `command.status:"rendered"`, reading
`get_inspection_state` with that ID if pending, before describing the chapter.
Chapter autoplay is off; this chapter's animation has its own autoplay setting.

## 7. install_lesson

When the user asks to rename the moving domain and double its keyframe speed,
copy the retained manifest and make these edits. If someone else changed it,
first refresh `lesson` with `get_inspection_state` and `includeLesson:true`.

```javascript
const editedLesson = structuredClone(lesson);
editedLesson.chapters[0].immersive.figure.labels[0].text = "Hinge domain";
editedLesson.chapters[0].animation.durationSeconds = 2;
editedLesson.chapters[0].animation.tracks[0].keyframes[1].t = 2;
```

Use that complete object as `$editedLesson`:

```json
{"sessionId":"$sessionId","lesson":"$editedLesson","waitForRenderMs":10000}
```

The same quarter turn now takes two seconds instead of four. This changes the
keyframes, leaving the ten-second chapter duration intact. For temporary speed
control alone, one `update_inspection` animation patch with `speed:2` suffices.
Retain `$commandId = commandId` from installation.

## 8. get_inspection_state

```json
{"sessionId":"$sessionId","commandId":"$commandId","includeLesson":true}
```

Require `command.status:"rendered"` for this ID and compare its source and
`renderedRevision` with current state. Read `lessonManifest` for “Hinge domain”
and the two-second keyframes; `animation` reports the owning panel's latest
sample. A pending receipt means wait and read again, not reinstall. On failure,
use its reason and detail to repair the request. A saved manifest alone proves
neither a visible change nor headset playback.
