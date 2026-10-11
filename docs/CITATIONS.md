# Citations

This file records the public entries the bundled demos and examples load:
atomic models from the RCSB Protein Data Bank (wwPDB) and experimental density
maps from EMDB. Stereofold also opens AlphaFold models and coordinates a user
supplies; those carry their own provenance and are not listed here. The
synthetic test fixtures are listed under Notes. For each identifier the plugin
downloads or names in code, this file records the method and resolution it
was determined at, the primary publication for the entry, and links to the
data bank. Nothing in this file appears in the headset view.

To add a demo, add its entry to `plugin/demos/index.json` with a `sources`
block that includes the primary publication DOI, as the existing entries do.
Then add one row under the same category in the following tables.

## PDB models

| ID | Used for | Method / resolution | Primary citation | DOI | Data-bank link |
| --- | --- | --- | --- | --- | --- |
| 9AX6 | `daraxonrasib` lesson: KRAS G12D, cyclophilin A and daraxonrasib, biological assembly 1 | X-ray, 1.65 Å | Jiang J et al., Translational and Therapeutic Evaluation of RAS-GTP Inhibition by RMC-6236 in RAS-Driven Cancers. Cancer Discov 2024;14:994–1017 | [10.1158/2159-8290.CD-24-0027](https://doi.org/10.1158/2159-8290.CD-24-0027) | [rcsb.org/structure/9AX6](https://www.rcsb.org/structure/9AX6) |
| 8OUE | `telomerase-haca` demo, the default demo (human telomerase H/ACA RNP lobe: two dyskerin copies, GAR1, NHP2, NOP10, TCAB1 and the hTR H/ACA RNA); the deposited map is EMD-17190 | Cryo-EM, 2.7 Å | Ghanim GE et al., 2.7 Å cryo-EM structure of human telomerase H/ACA ribonucleoprotein. Nat Commun 2024;15:746 | [10.1038/s41467-024-45002-x](https://doi.org/10.1038/s41467-024-45002-x) | [rcsb.org/structure/8OUE](https://www.rcsb.org/structure/8OUE), [ebi.ac.uk/emdb/EMD-17190](https://www.ebi.ac.uk/emdb/EMD-17190) |
| 9KJ6 | `crispr-cas9` demo | X-ray, 3.59 Å | Kim S et al., Structural and functional insights into internal domain replacement in SpCas9 for protein engineering. Sci Rep 2025;15:41528 | [10.1038/s41598-025-25367-9](https://doi.org/10.1038/s41598-025-25367-9) | [rcsb.org/structure/9KJ6](https://www.rcsb.org/structure/9KJ6) |
| 5SYF | `microtubule-lattice`, `tubulin-dimer`, and the monomer/dimer/protofilament/wall/tube tiers of `microtubule-growth` | Cryo-EM, 3.5 Å | Kellogg EH et al., Insights into the Distinct Mechanisms of Action of Taxane and Non-Taxane Microtubule Stabilizers from Cryo-EM Structures. J Mol Biol 2017;429:633-646 | [10.1016/j.jmb.2017.01.001](https://doi.org/10.1016/j.jmb.2017.01.001) | [rcsb.org/structure/5SYF](https://www.rcsb.org/structure/5SYF) |
| 3JAK | `microtubule-growth` filament and tip tiers; the EB3-bound microtubule lessons in `plugin/src/molecular-experience.ts` | Cryo-EM, 3.3 Å | Zhang R et al., Mechanistic Origin of Microtubule Dynamic Instability and Its Modulation by EB Proteins. Cell 2015;162:849-859 | [10.1016/j.cell.2015.07.012](https://doi.org/10.1016/j.cell.2015.07.012) | [rcsb.org/structure/3JAK](https://www.rcsb.org/structure/3JAK) |
| 4HHB | `hemoglobin` demo; test fixture `fixtures/4HHB.cif` | X-ray, 1.74 Å | Fermi G et al., The crystal structure of human deoxyhaemoglobin at 1.74 A resolution. J Mol Biol 1984;175:159-174 | [10.1016/0022-2836(84)90472-8](https://doi.org/10.1016/0022-2836(84)90472-8) | [rcsb.org/structure/4HHB](https://www.rcsb.org/structure/4HHB) |
| 1KX5 | `nucleosome` demo | X-ray, 1.94 Å | Davey CA et al., Solvent Mediated Interactions in the Structure of the Nucleosome Core Particle at 1.9 A Resolution. J Mol Biol 2002;319:1097-1113 | [10.1016/S0022-2836(02)00386-8](https://doi.org/10.1016/S0022-2836(02)00386-8) | [rcsb.org/structure/1KX5](https://www.rcsb.org/structure/1KX5) |
| 6VXX | `spike` demo | Cryo-EM, 2.8 Å | Walls AC et al., Structure, Function, and Antigenicity of the SARS-CoV-2 Spike Glycoprotein. Cell 2020;181(2):281–292.e6 | [10.1016/j.cell.2020.02.058](https://doi.org/10.1016/j.cell.2020.02.058) | [rcsb.org/structure/6VXX](https://www.rcsb.org/structure/6VXX) |
| 8H9V | `atp-synthase` demo | Cryo-EM, 3.02 Å | Lai Y et al., Structure of the human ATP synthase. Mol Cell 2023;83(12):2137–2147.e4 | [10.1016/j.molcel.2023.04.029](https://doi.org/10.1016/j.molcel.2023.04.029) | [rcsb.org/structure/8H9V](https://www.rcsb.org/structure/8H9V) |
| 4PYP | `glucose-transporter` demo (human GLUT1) | X-ray, 3.17 Å | Deng D et al., Crystal structure of the human glucose transporter GLUT1. Nature 2014;510:121-125 | [10.1038/nature13306](https://doi.org/10.1038/nature13306) | [rcsb.org/structure/4PYP](https://www.rcsb.org/structure/4PYP) |
| 1CRN | Crambin control: binder experience, `fold-detective` tour, smoke/handoff test scripts, test fixture `fixtures/1CRN.cif` | X-ray, 1.5 Å | Teeter MM, Water structure of a hydrophobic protein at atomic resolution: Pentagon rings of water molecules in crystals of crambin. Proc Natl Acad Sci USA 1984;81:6014-6018 | [10.1073/pnas.81.19.6014](https://doi.org/10.1073/pnas.81.19.6014) | [rcsb.org/structure/1CRN](https://www.rcsb.org/structure/1CRN) |
| 9QB3 | Telomerase H/ACA RNP lobe experience in `plugin/src/molecular-experience.ts` / `plugin/src/experience-scripts.ts` | Cryo-EM, 3.9 Å | Balch S et al., Cryo-EM structure of human telomerase dimer reveals H/ACA RNP-mediated dimerization. Science 2025;389:eadr5817 | [10.1126/science.adr5817](https://doi.org/10.1126/science.adr5817) | [rcsb.org/structure/9QB3](https://www.rcsb.org/structure/9QB3) |
| 9SI0 | Telomerase holoenzyme experience in `plugin/src/molecular-experience.ts` / `plugin/src/experience-scripts.ts` | Cryo-EM, 3.8 Å | Balch S et al., Structures of nucleotide-bound human telomerase at several steps of its telomeric DNA repeat addition cycle. Nat Commun 2026;17:1847 | [10.1038/s41467-026-68560-8](https://doi.org/10.1038/s41467-026-68560-8) | [rcsb.org/structure/9SI0](https://www.rcsb.org/structure/9SI0) |
| 1EMA | GFP `chemical-colors` tour and the binder folded-target illustration | X-ray, 1.9 Å | Ormo M et al., Crystal structure of the Aequorea victoria green fluorescent protein. Science 1996;273:1392-1395 | No DOI recorded in the PDB entry; see the RCSB link | [rcsb.org/structure/1EMA](https://www.rcsb.org/structure/1EMA) |
| 1YCR | MDM2–p53 `surface-safari` tour and the binder peptide-interface illustration | X-ray, 2.6 Å | Kussie PH et al., Structure of the MDM2 oncoprotein bound to the p53 tumor suppressor transactivation domain. Science 1996;274:948-953 | [10.1126/science.274.5289.948](https://doi.org/10.1126/science.274.5289.948) | [rcsb.org/structure/1YCR](https://www.rcsb.org/structure/1YCR) |
| 4AKE | Adenylate kinase `structure-evidence` tour | X-ray, 2.2 Å | Muller CW et al., Adenylate kinase motions during catalysis: an energetic counterweight balancing substrate binding. Structure 1996;4:147-156 | [10.1016/S0969-2126(96)00018-4](https://doi.org/10.1016/S0969-2126(96)00018-4) | [rcsb.org/structure/4AKE](https://www.rcsb.org/structure/4AKE) |
| 1AKE | `claude-binder-map` tour | X-ray, 2.0 Å | Muller CW et al., Structure of the complex between adenylate kinase from Escherichia coli and the inhibitor Ap5A refined at 1.9 A resolution. J Mol Biol 1992;224:159-177 | [10.1016/0022-2836(92)90582-5](https://doi.org/10.1016/0022-2836(92)90582-5) | [rcsb.org/structure/1AKE](https://www.rcsb.org/structure/1AKE) |
| 2LZM | T4 lysozyme `generator-gallery` tour | X-ray, 1.7 Å | Weaver LH et al., Structure of bacteriophage T4 lysozyme refined at 1.7 A resolution. J Mol Biol 1987;193:189-199 | [10.1016/0022-2836(87)90636-X](https://doi.org/10.1016/0022-2836(87)90636-X) | [rcsb.org/structure/2LZM](https://www.rcsb.org/structure/2LZM) |
| 1UBQ | Ubiquitin `sequence-story` tour | X-ray, 1.8 Å | Vijay-Kumar S et al., Structure of ubiquitin refined at 1.8 A resolution. J Mol Biol 1987;194:531-544 | [10.1016/0022-2836(87)90679-6](https://doi.org/10.1016/0022-2836(87)90679-6) | [rcsb.org/structure/1UBQ](https://www.rcsb.org/structure/1UBQ) |
| 1BNA | B-DNA dodecamer `prediction-courtroom` tour | X-ray, 1.9 Å | Drew HR et al., Structure of a B-DNA dodecamer: conformation and dynamics. Proc Natl Acad Sci USA 1981;78:2179-2183 | [10.1073/pnas.78.4.2179](https://doi.org/10.1073/pnas.78.4.2179) | [rcsb.org/structure/1BNA](https://www.rcsb.org/structure/1BNA) |
| 1MBO | Oxymyoglobin `controls-handoff` tour | X-ray, 1.6 Å | Phillips SE, Structure and refinement of oxymyoglobin at 1.6 A resolution. J Mol Biol 1980;142:531-554 | [10.1016/0022-2836(80)90262-4](https://doi.org/10.1016/0022-2836(80)90262-4) | [rcsb.org/structure/1MBO](https://www.rcsb.org/structure/1MBO) |

## EMDB maps

| ID | Used for | Method / resolution | Primary citation | DOI | Data-bank link |
| --- | --- | --- | --- | --- | --- |
| EMD-6347 | Density map for the `microtubule-growth` `filament` tier (`plugin/demos/index.json` stage `filament`; prepared by `plugin/scripts/prepare-map.ts` and `plugin/scripts/quest-demo.ts`) | Cryo-EM helical reconstruction, 3.4 Å (author-provided) | Zhang R et al., Mechanistic Origin of Microtubule Dynamic Instability and Its Modulation by EB Proteins. Cell 2015;162:849-859 | [10.1016/j.cell.2015.07.012](https://doi.org/10.1016/j.cell.2015.07.012) | [ebi.ac.uk/emdb/EMD-6347](https://www.ebi.ac.uk/emdb/EMD-6347) |

The `microtubule-arrival` demo also uses 5SYF for its build and EMD-6347 for
its density finale. These are different experimental specimens: 5SYF is
Taxol-stabilized; EMD-6347 contains GTPγS and EB3. The density session uses
3JAK as a related coordinate reference from the same publication. RCSB links
3JAK to EMD-6349, so this project does not establish an exact 3JAK/EMD-6347
fit. The displayed map is EMD-6347; residue queries refer to 3JAK.

## Notes

- The test fixtures `fixtures/identity-edge.cif`,
  `voice-ambiguity.cif`, and `voice-ligand.cif` are synthetic coordinates and
  describe no experimental molecule, so they carry no data-bank citation.
- Every PDB and EMDB ID inventoried in this repository resolved to a live
  data-bank record when this list was compiled.

## Data-bank citations

Structures are retrieved from the RCSB PDB:

- Berman HM et al., The Protein Data Bank. Nucleic Acids Res 2000;28:235-242. DOI [10.1093/nar/28.1.235](https://doi.org/10.1093/nar/28.1.235) — resolves.
- Burley SK et al., RCSB Protein Data Bank (RCSB.org): delivery of experimentally-determined PDB structures alongside one million computed structure models of proteins from artificial intelligence/machine learning. Nucleic Acids Res 2023;51:D488-D508. DOI [10.1093/nar/gkac1077](https://doi.org/10.1093/nar/gkac1077) — resolves.

Density maps are retrieved from EMDB:

- Lawson CL et al., EMDataBank unified data resource for 3DEM. Nucleic Acids Res 2016;44:D396-D403. DOI [10.1093/nar/gkv1126](https://doi.org/10.1093/nar/gkv1126) — resolves.

The viewer renders structures with Mol*:

- Sehnal D et al., Mol* Viewer: modern web app for 3D visualization and analysis of large biomolecular structures. Nucleic Acids Res 2021;49:W431-W437. DOI [10.1093/nar/gkab314](https://doi.org/10.1093/nar/gkab314) — resolves.
