# Binder gallery source credits

The short and extended galleries adapt explicitly selected coordinates from
**Anthropic, `scorpion-toxin-binder-design`**, pinned to revision
`0bac3d0286f7f83b5339f5b4f1e67fbe47a6e7c1`:

- Dataset: <https://huggingface.co/datasets/Anthropic/scorpion-toxin-binder-design/tree/0bac3d0286f7f83b5339f5b4f1e67fbe47a6e7c1>
- Copyright (c) 2026 Anthropic, PBC.
- Dataset license: **Creative Commons Attribution 4.0 International**,
  <https://creativecommons.org/licenses/by/4.0/>.
- The unmodified upstream license is preserved at `upstream/LICENSE.md`.

Upstream requested citation:

> Claude Science, Nathaniel Horwitz, James van Geelen, Kat Kajderowicz,
> Amir Shanehsazzadeh. *De novo design of protein binders against scorpion
> toxins with Claude.* October 20, 2026.
> <https://www-cdn.anthropic.com/31ac578806cffd8b3d92d8affe6edc4c04d502e1.pdf>.

These coordinates are already-published **ESMFold2 predicted complexes**.
They are not experimentally determined complex structures. Dataset metadata
reports the initial 17 designs as binders under the study's criteria; the other
194 do not meet those full criteria. A modeled pose is not experimental
validation of that pose, neutralization, safety, or clinical effectiveness.
No new prediction or assay was performed to prepare this gallery.

Changes by the Stereofold gallery preparation: sequence-declared mmCIF
normalization; neutral display labels and unique chain identifiers; one proper
rigid alignment of the complete complex into its target group's viewing frame;
and a composite of all 17 pair-specific complexes. Original coordinate files
remain unmodified in `upstream/structures/`. Full source identity, byte digests,
sequences, label mapping and exact transformation matrices are in `manifest.json`.

The extended gallery adds one representative intended-target pairing for each
of the other 194 designs, using the same pinned release and license. Their
original PDB files remain unmodified under `extended/upstream/structures/`;
`extended/source-lock.json` records their exact source URLs and byte digests.
The generated batch mmCIF files rename chains, declare sequences and apply
proper rigid target alignments for a shared reference-target overlay. Per-batch
manifests retain original pair identities, transforms and proximity metadata;
`catalog.json` retains the selection rules, measured results and predicted
scores. These changes create presentation derivatives, not new predictions
or experimental structures. The 17 qualified designs and 194 other designs
retain their distinct assay status.

## Third-party structural material

The upstream license states that toxin chains derive from Protein Data Bank
entries **25IH, 1NPI, 1AHO, 7K18** and AlphaFold Protein Structure Database entry
**AF-P01479-F1**, and keep their own terms. The short 17-slide gallery selects
no Ts1 complex. The extended gallery also displays Ts1, whose upstream design target is PDB 1NPI chain A.

The target provenance reported by upstream `toxins.csv` is:

| Display label | Original toxin | Upstream target preparation | UniProt |
| --- | --- | --- | --- |
| Target1 | Cn2 | PDB 25IH chain D | P01495, residues 17–82 |
| Target2 | AaH II | PDB 1AHO chain A | P01484, residues 20–83 |
| Target3 | AaH I | AF-P01479-F1 v6, trimmed to mature residues 1–63 | P01479, residues 20–82 |
| Target4 | LqhIII | PDB 7K18 chain B | P56678, residues 1–67 |
| Extended Ts1 | Ts1 | PDB 1NPI chain A | P15226, residues 21–81 |

- PDB entry records: <https://www.rcsb.org/structure/25IH>,
  <https://www.rcsb.org/structure/1NPI>,
  <https://www.rcsb.org/structure/1AHO>,
  <https://www.rcsb.org/structure/7K18>.
- wwPDB data policy: <https://www.wwpdb.org/about/usage-policies>.
- AlphaFold entry: <https://alphafold.ebi.ac.uk/entry/P01479>.
- AlphaFold terms: <https://alphafold.ebi.ac.uk/terms>.

This credit record does not relicense third-party material or imply endorsement.
The original predicted complex files, toxin sequences, structural lineage and
license notices remain traceable at the pinned dataset revision.
