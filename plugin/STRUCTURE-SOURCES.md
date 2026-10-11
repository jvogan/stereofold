# Structure sources

`src/structure-sources.ts` is the shared resolver for `open`, `inspect`,
`inspect_file` and `replace_inspection_source`. The flat `pdbId` and pasted
`structureText` inputs and the legacy depth fixture also work.

`open`, `inspect` and `replace_inspection_source` accept a nested `source` with
exactly one kind:

| Kind | Fields | Behavior |
| --- | --- | --- |
| `pdb` | `id: "1CRN"` | Four letters/digits, normalized uppercase; RCSB HTTPS mmCIF. |
| `alphafold` | `accession: "P69905"` | Canonical six/ten-character UniProt accession; `https://alphafold.ebi.ac.uk/files/AF-P69905-F1-model_v6.cif`. `ALPHAFOLD_MODEL_VERSION` pins v6. A missing file reports the accession, version and HTTP status; no version fallback. |
| `url` | `url: "https://example.org/download"` | UTF-8 mmCIF or PDB, detected from coordinate content, independent of extension. |
| `file` | `path: "/absolute/path/structure.cif"` | Existing stable local `.cif`/`.mmcif` reader: absolute regular file, no final-component symlink. |
| `pasted` | `text`, optional `format` | Coordinates remain local. Explicit formats retain legacy behavior; an omitted nested-source format is sniffed. Flat legacy pasted input still defaults to mmCIF. |

URL downloads have a 64 MiB (67,108,864-byte) cap checked both from
Content-Length and incrementally on the response stream, before parsing. A false
or absent header cannot bypass the cap. At most five redirects are followed,
with HTTPS checked before every request. HTTP, file, data and other schemes,
embedded URL credentials, non-UTF-8 bodies and non-coordinate content are refused.
The 60-second request deadline also covers redirects and streaming.
URLs are contacted only when explicitly requested; their host sees the URL and
client network address. There is no discovery, authentication or external-viewer adapter.

Inspector loads do not count residue positions or atom sites. Earlier builds
refused loads past 20,000 residue positions or 200,000 atom sites; neither limit
was measured against a viewer, and both applied to every surface, including the
desktop. An explicitly chosen assembly is expanded and verified before the load
commits. A catalog larger than the 64 MiB decode policy is refused; this is a
chosen decode bound, not a measured device capacity. The local file cap is the
same 67,108,864-byte read policy. An authored experience stage declares how much
its source holds, and the server checks that declaration for consistency, not as
a device limit. The paired Quest 2 growth workflow uses a 43,066-atom tier
tested as cartoon; that is not a universal limit for arbitrary structures.
Representation-specific admission and build deadlines apply separately.

Earlier builds also had a 6,275,072-byte encoded-source budget and a 4 MiB
compressed-catalog budget. Neither was measured against a viewer or a documented
host ceiling: both kept one JSON tool result small, and together they refused
1AON, 1XCK and 1S5L. A desktop panel pulls the coordinates and the compressed
catalog through `stereo_structure.get_inspection_bytes` in 96 KiB chunks, and
the headset takes coordinates as raw bytes on the LAN `/source` route.

PDB URL/pasted content is normalized into mmCIF using the bundled Mol* parser
and CIF writer. It preserves source MODEL numbers, author/label identity and
Mol*'s deposited assembly categories, and adds the explicit chain/entity table
required by the inspector. Normalized coordinates have their own source hash.
The inspector refuses a polymer without a declared sequence, so PDB polymers
need SEQRES. Without it, use a complete mmCIF file or `open` for the
coordinate-only stereo viewer. No missing polymer sequence is invented.

## Selection and atomic replacement

For `inspect` and `replace_inspection_source`, optional `modelNumber` names the
deposited model number (not a zero-based index); `assemblyId` names a declared
assembly or `asymmetric_unit`. Defaults are the first deposited model and the
asymmetric unit, never an assumed biological assembly 1. Missing models or
assemblies are refused before the source is committed.

For example, a new inspection can use:

```json
{"source":{"kind":"alphafold","accession":"P69905"},"modelNumber":1,"assemblyId":"asymmetric_unit"}
```

To replace an existing ready panel, pass the same source fields to
`replace_inspection_source` along with the existing sessionId, serverEpoch,
sourceToken, baseStateRevision, baseInspectionRevision and panelId binding.
The flat `pdbId` form also works. Exactly one source is allowed.
`inspect` accepts only a source-free sessionId for reopening; replacement uses
its explicit target-bound tool.

Results and private hydration expose `sourceKind` and
`sourceSelection: {modelNumber, assemblyId}`. Hydration passes that selection to
the workspace loader; it does not fabricate a scene or renderer receipt.
The source reservation starts before fetching, and replacement rechecks panel,
source and revisions after parsing. Failed preparation leaves the old source
and scene intact; a newer request supersedes an older pending load.

A successful replacement means prepared/committed, not rendered. The selected
panel then hydrates, renders and saves through the normal flow. Confirm
visibility only after the rendered receipt. A replacement does not change the
viewer's immersive camera or room-anchor policy.

## Cache design

Public database downloads are atomically written, best effort, beneath
`~/Library/Caches/Stereofold`:

- `sources/pdb-<UPPERCASE_ID>.cif`, for example `sources/pdb-1CRN.cif`.
- `sources/alphafold-<UPPERCASE_ACCESSION>-v6.cif`, for example
  `sources/alphafold-P69905-v6.cif`.

The keys identify raw public source bytes, independent of model/assembly
selection. A private temporary file is renamed to the final key only after
bounded download and format validation. Explicit database requests refresh the
entry, preserving RCSB fetch behavior; there is no offline or stale-cache
fallback after a missing response. Failed cache writes do not fail valid loads.
URL, file and pasted inputs are never written to the disk cache. Their URL,
query string and local path never become a cache key. Test fetchers use temporary
cache roots or disable cache writes.

The resolver does not handle EMDB maps, trajectories, connected live viewers,
or density conversion. Unit tests use mocked responses and local coordinate
fixtures; network and headset acceptance need a real host.
