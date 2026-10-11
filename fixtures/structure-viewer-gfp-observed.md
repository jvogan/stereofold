# Native GFP coordinate-export regression fixture

Exported on 2026-09-29 from Molecular Structure Viewer 0.1.90's bundled public
GFP example (PDB 1EMA), using selection-mmcif with an explicit all-primary-object
selection. The coordinate bytes are unchanged from that export.

SHA-256: fe3e56d0f4860dfc64957fa0fe707538bee65cf25f7b289f4d39937d0c824679

The 1,866 observed atom sites include polymer, chromophore and water entities
sharing label chain A. This fixture tests retention of the exported chain,
entity, residue, atom and coordinate identities without introducing deposited
sequence declarations or rewriting source bytes. Coordinate exports omit
explicit connectivity and bond order.

Source: https://www.rcsb.org/structure/1EMA
