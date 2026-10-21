# Preparation provenance

Source dataset: `Anthropic/scorpion-toxin-binder-design` revision
`0bac3d0286f7f83b5339f5b4f1e67fbe47a6e7c1`. See `CREDITS.md` for attribution
and upstream terms. The source selection and every input/output SHA-256 are in
`manifest.json`; the original PDB byte streams are retained unmodified.

## Sequence and atom identity

All 17 complexes have original chain A = binder and original chain B = toxin.
For every complex, the complete coordinate residue sequence of A exactly
matches `design.csv`'s `sequence`, and B exactly matches `toxins.csv`'s
`sequence`. Residues run contiguously from 1 through the declared length, with
one CA per residue and no insertion codes or alternate locations. Preparation
fails on a mismatch. No sequence was inferred from missing metadata.

The source files omit PDB SEQRES. The generated mmCIF explicitly declares the
matching sequences in `entity_poly`, `entity_poly_seq`, `struct_asym`, and
`pdbx_poly_seq_scheme`. Standard amino-acid component types are declared in
`chem_comp`. Every original ATOM site is retained with its atom name, element,
residue identity, occupancy and numeric B field. Original serials are replaced
with contiguous mmCIF site IDs; original atom order is retained. Chains are
renamed uniquely to support preloaded slide visibility. The source atom
identity is recoverable from UUID, original chain, residue number and atom name.
Native target amidation and disulfide annotations are retained in provenance;
preparation does not synthesize missing chemical groups or add inferred bonds.

## Exact rigid transformations

Targets are grouped by the original `binder_against` value. The first complex
in each group is the reference. Mobile target CA atoms correspond by identical
sequence and residue number; all participate with equal weight in a Kabsch fit,
with a determinant +1 rotation. This is a fit of the target only; the resulting
transform is applied to **every atom of both chains** of that complex.
The target fit does not alter binder–target geometry or force the target copies
to become identical. Each pair retains its own predicted target conformation.

Each reference receives an additional canonical viewing frame: Y points from
target CA centroid to binder CA centroid; X is the reference target's principal
axis projected perpendicular to Y, with sign chosen toward its first CA; Z is
X cross Y. Their CA-centroid midpoint moves to the origin. This places the
reference binder above its target in XY projection and gives all four groups
similar orientation for a Z-axis camera. It is a presentation frame, not a
biophysical preferred orientation.

`alignment.fitToReferenceMatrix` and `alignment.canonicalReferenceMatrix`
retain the component transforms. `alignment.matrix` is their composed final
3×4 row-major matrix: for column-vector coordinates in Angstrom,
`new_xyz = matrix[:,0:3] @ original_xyz + matrix[:,3]`. Exact matrix values are
serialized as double-precision JSON numbers. The same final matrix writes both
the individual CIF and its composite pair. Transformed coordinates use nine
decimal places; rounding error is at most 0.5e-9 Angstrom per component.

`targetCaRmsdAngstrom` is the CA RMSD to the group's reference after fitting,
before coordinate rounding. `pairedAtomCount` is the full target length.
`spatial` records all-atom bounds, bounding-box midpoint and per-chain CA
centroids in the final frame for each pair. Coordinates are not offset between
slides: their preloaded copies overlap and slide visibility chooses the pair.

No prediction, relaxation, minimization, sequence redesign or experimental
interpretation was performed. All complexes remain published computational
poses and preserve their original scientific source identity.


## Original-pair and fixed-reference proximity metadata

`presentationReferenceTarget` explicitly names the first target model in the
group (`T01`, `T08`, `T12`, or `T16`), its UUID and pinned source digest, and the
original pair's own target chain. This supports a fixed-reference comparison
without changing or deleting any original coordinates. The fixed-reference
view combines an aligned binder from its original model with the group's
reference target, so it is an **aligned 3D comparison**, rather than a claim
that those two displayed chains form the original published predicted complex.
The original-pair model remains available through its own unchanged chains.

`contacts.originalPair` marks proximity in the original published binder and
target coordinates. `contacts.referenceOverlay` separately marks proximity
between the aligned binder and the exact displayed reference target coordinates
from the nine-decimal-place composite mmCIF. The distinction matters: target
backbone CA RMSDs are below 0.9 Angstrom, while side-chain atom conformations
can differ by several Angstrom. Alignment metadata also reports matched-target
heavy-atom RMSD and maximum displacement after alignment, including side chains.

Both modes use the same simple geometric rule: include an author-numbered
residue if **any heavy atom** in that residue lies **at or below 4.5 Angstrom**
from any heavy atom in the opposite displayed chain. Heavy atoms are ATOM sites
whose element is neither H nor D; backbone and side-chain atoms participate.
The sorted `binder.residueNumbers` and `target.residueNumbers` lists retain
noncontiguous residue selections and name the actual displayed chain IDs.
This is minimum-distance proximity only. It does not assign a chemical bond,
functional interface, affinity, efficacy or a binder ranking. A stick display
may show all atoms of each marked residue; its backbone atoms can have been the
atoms that met the proximity rule.


## Small illustrative display subset

The complete proximity residue lists above are preserved. Each mode additionally
records `displayExamples`: four residue pairs with no repeated residue on either
side, for a small, readable stick display. Candidate pairs require a side-chain
heavy-atom minimum distance at or below 4.5 Angstrom. H/D atoms and backbone
atom names N, CA, C, O and OXT are excluded for this candidate selection; a
residue without any remaining atom, such as glycine, supplies no candidate.
Candidates are ordered by minimum distance, then binder author residue number,
then target author residue number. A single pass accepts the first four pairs
that reuse neither residue. There is no spatial spread optimization, energy
calculation, affinity estimate or functional ranking. Each pair's exact minimum
side-chain distance and the displayed chain/residue lists are retained.

These are geometric examples, **not key sites or proven interactions**. The
renderer shows each selected whole residue using bond cylinders only, without
atom spheres (`representation: sticks`, size factor 0.14), so a residue's
backbone bonds can also appear. Other atoms and all original coordinates remain
unchanged. The target surface uses opacity 0.72 in both authored gallery views.
