# Measured tubulin contact faces

Chapter 3 uses geometric contacts measured from [PDB 5SYF](https://www.rcsb.org/structure/5SYF), the Taxol-stabilised microtubule cryo-EM model at 3.5 Å, described by [Kellogg et al., 2017](https://doi.org/10.1016/j.jmb.2017.01.001).

Measured deposited file SHA-256: `d5a603bcd6087e93c9f2492ba7922c9a0866358c2927ad44546d640f8c16f6db`.

Method: use model 1 ATOM records (protein only); exclude H/D, nucleotides, magnesium, Taxol and water. For each protein heavy atom, compute its minimum Euclidean distance to the partner protein heavy atoms. Select an author-numbered residue if any distance is ≤4.5 Å. Retain all deposited alternate positions (there are no alternate conformers in these selected atoms). No sequence-gap filling or surface-area cutoff is applied. These are model-dependent proximity contacts, not a measurement of binding energy or a claim that every surface point on a coloured residue is buried.

Both author and label IDs of the untransformed proteins are A (alpha) and B (beta). The monomer cut retains exactly the deposited A coordinates. The dimer uses the deposited asymmetric unit. Assembly neighbours below are used for measurement only; they are absent from these displayed cuts.

| Displayed face | Partner measured | Selected author residues |
| --- | --- | --- |
| Monomer, blue: intradimer A face (41) | B, deposited assembly operator 1 | A: 11, 15, 70–73, 76–77, 95–98, 100–101, 105, 176–183, 207, 210–211, 214, 221–224, 394, 397–398, 401–407 |
| Dimer, amber: alpha end (41) | B, deposited assembly operator 14 | A: 1–2, 130–131, 133, 163, 199, 245–249, 251, 253–254, 256–258, 260–263, 314–315, 324–327, 329, 336, 346–353, 434–435, 437 |
| Dimer, amber: alpha lateral face (7) | A, deposited assembly operator 15 | A: 279–285 |
| Dimer, amber: beta lateral face (9) | B, deposited assembly operator 15 | B: 218, 279–280, 282–285, 297, 338 |

Operator 1 is identity: A–B is the intradimer contact. Operator 14 translates the partner by +81.5 Å along z; A contacts B-14 at the exposed alpha end (the same neighbour in the protofilament cut). Operator 15 supplies the adjacent protofilament on the +x side: A contacts A-15 and B contacts B-15. Thus the dimer shows an external end interface and one external lateral face, not the buried A–B interface. The opposite side, operator 12, is deliberately not coloured; the caption says “one side.”

Blue retains the monomer alpha emphasis colour. In the dimer face chapter amber denotes measured contacts on both chains, not beta identity; other chapters retain their alpha/blue and beta/amber identity key. All unselected surface stays opaque neutral grey. Residue ranges remain exact and disjoint (15 monomer ranges; 23 dimer ranges). The contact chapters hold their pose, with rotations chosen to view the monomer beta-facing −z face and the dimer +z/+x end/side respectively. The held camera is at +25 degrees yaw after the opening turn: monomer placement yaw +205 degrees brings its −z face towards that camera; dimer yaw −20 degrees gives an oblique view of both +z and +x contact faces.

Verification: `plugin/test/microtubule-faces.test.ts` pins the lesson selections and independently recomputes all contact residues from the digest-checked cached `5SYF.cif` when `STEREOFOLD_DEMO_CACHE` is set. Its fixture records each residue’s closest atom-pair witness and the partner operator. To reproduce: from `plugin/`, run `STEREOFOLD_DEMO_CACHE=<coordinate-cache> node_modules/.bin/vitest run --maxWorkers=3 test/microtubule-faces.test.ts`.
