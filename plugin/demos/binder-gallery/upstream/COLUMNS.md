# Columns

This file lists every file of the package and explains every column. `README.md` defines a hit and a binder.

An empty cell means not measured, not computed, not applicable, or, for KD, no fit; it never means no hit. KD is in nM. Every KD, rate, and `fit_RU` from Adaptyv Bio comes from their 1:1 fit, whether or not they selected it. `<T>`: Cn2, Ts1, AaHII, AaHI, or LqhIII.

## Files

At the top: `design.csv`, `in_silico_scores.csv`, `Cn2_competition_Twist_Bioscience.csv`, `BVP_ELISA.csv`, `toxins.csv`, `controls.csv`.

`sensorgrams/`, with one folder per design, `sensorgrams/<uuid>/`, and one per control, `sensorgrams/control_<control>/` (12; file names start with `<control>`):
- `sensorgrams/INDEX.csv`: every series with a trace.
- `<uuid>_sensorgrams.png`, `<uuid>_kinetics.csv`, `<uuid>_traces.csv`: picture, fits, and traces of the main screen.
- `<uuid>_followup.png`, `<uuid>_followup_traces.csv`: picture and traces of the follow-up assays: OVA, reverse BLI, competition (Twist Bioscience: AaH I only), and the second supplier's toxin.

`structures/`, with one folder per design, `structures/<uuid>/`:
- `structures/INDEX.csv`: every file.
- `<uuid>_design-<toxin>.pdb` (fusions: `_design-domainA-<toxin>` and `_design-domainB-<toxin>`, one domain each), `<uuid>_<predictor>-<toxin>.pdb`, `<uuid>_monomer-<predictor>.pdb`: the design model, predicted complexes, and predicted monomers.

`supporting_tables/`:
- How each design was made and expressed: `origin.csv`, `expression.csv`.
- Follow-up assays: `AaHI_competition_Twist_Bioscience.csv`, `competition_Adaptyv_Bio.csv`, `reverse_BLI.csv`, `OVA.csv`, `second_supplier.csv`.
- Per-seed scores, interfaces, and thresholds: `in_silico_scores_all_seeds.csv`, `monomer_folds_per_seed.csv`, `predicted_interfaces.csv`, `ipSAE_thresholds.csv`, `controls_cofolding_scores.csv`.

## Columns that several tables share

The sections below list one of these again only to add to it.

- `uuid`, `name`: eight-character identifier (load as text); name if a binder.
- `design_set`: whole number 1 to 10; 'Set 1' to 'Set 10' in the report (Table S6). Sets 1 to 5 were made against one toxin each, Set 6 against Cn2 and Ts1, Set 7 against AaH II, AaH I, and LqhIII, and Sets 8 to 10 against all five.
- `binder_against`: the toxin against which the design is a binder.
- `lab`, `toxin`, `replicate`: of the measurement; `toxin` may be CLEC12A (replicates 1 and 2: Twist Bioscience's two SPR runs) or OVA.
- `predictor`, `seed`: ESMFold2, ESMFold2-Fast, or Protenix v2; 0 to 4.
- `fit_model`: `1:1`; `1:1, not selected` (Adaptyv Bio selected other models); `no fit selected` (Adaptyv Bio); `no fit reported` (Twist Bioscience).
- `Adaptyv_fit_quality`: `good`, `medium`, `poor`, or `not graded` (a 1:1 fit that they did not select).
- Spellings: AaH II, ESMFold2-Fast, Protenix v2 in cells; `AaHII`, `ESMFold2Fast`, `ProtenixV2` in column names; `aah2`, `esmfold2-fast`, `protenix-v2` in file names and `source` (toxins: `toxins.csv`).

## Tables at the top

### `design.csv`

One row per design. We define the main screen as each lab's SPR measurement of all designs (Twist Bioscience: all but 6a7a1c19).

- `intended_toxins`: the toxins the design was made against, joined by "; ".
- `format`: `single domain` or `fusion of two domains`.
- `length_aa`, `sequence`: the design's.
- `binder_against`: criterion 1 needs `hit` in `Adaptyv_replicate_result` of every replicate (`<uuid>_kinetics.csv`); criterion 3 is `<T>_Twist_Rmax_ratio` of 1 or less; criterion 4 is `no hit` in both CLEC12A columns.
- `<T>_Adaptyv_result`: `hit` or `no hit`. Adaptyv Bio identified hits by their own analysis, and we used their hits and KD values, apart from the upper limit for Cn2-B1.
- `<T>_Adaptyv_KD_nM`: arithmetic mean of Adaptyv Bio's 1:1 fits over the fitted replicates, SPR and BLI alike (Cn2-B1: our upper limit).
- `<T>_Twist_result`: `hit`, `no hit`, `weak or ambiguous` (3 to 5 robust SD above the median), or `not assessable (capture <50 RU)`. For Twist Bioscience's data, Claude applied a fixed rule after Adaptyv Bio's hits were known: the response at 1 µM had to exceed the run's median for that toxin by 5 robust standard deviations. Capture levels of the main screen and Twist Bioscience's concentration and SEC values are not included.
- `<T>_Twist_KD_nM`: our 1:1 fit, for `hit` and `weak or ambiguous` (Cn2-B1: our upper limit, by a method that needs no rate constant).
- `KD_note`: which KD is an upper limit or approximate (Adaptyv Bio: a 1:1 fit where they selected another model, fitted replicates more than 3-fold apart, or a fit below the lowest concentration of its series; Twist Bioscience: the three fits marked ≈ in the report).
- `CLEC12A_Twist_result_run_1`, `CLEC12A_Twist_result_run_2`: CLEC12A (human) is a protein unrelated to the toxins; as `<T>_Twist_result`, in run 1 (with Cn2, Ts1, and AaH II) and run 2 (with AaH I); run 2 also has `near background` (about 2 to 3 SD).
- `<T>_Twist_Rmax_ratio`: fitted Rmax (ours) over Twist Bioscience's theoretical Rmax.

### `in_silico_scores.csv`

`<P>`: ESMFold2, ESMFold2Fast, or ProtenixV2; complexes at the best of seeds 0 to 4 by ipSAE.

- `<T>_final_score`: mean of the six scores below; 0 to 1.
- `<T>_ipSAE_<P>`: ipSAE, the lower of the two directional values; 0 to 1.
- `<T>_scDockQ_<P>`: DockQ of the complex against the design model (other toxins superposed); 0 to 1.
- `pLDDT_monomer_<P>`, `scRMSD_monomer_<P>`: the design without a toxin; over the seeds, mean pLDDT and median RMSD to the design model (Å; fusions: the larger of the two domains' values).

### `Cn2_competition_Twist_Bioscience.csv`

BLI at Twist Bioscience, measured once per design and antibody: 16 designs and four controls. `<S>`: the run, by the antibody put on the toxin first: LR, RU1, or 9004G. The runs against Ts1 and AaH II could not be assessed and are not included.

- `kind`, `control`: `design` or `control`; LR, RU1, 9004G, or `polyclonal human IgG`.
- `Cn2_assessed`: `yes` at 0.10 nm or more without antibody, else `no`.
- `<S>_signal_without_antibody_nm`, `<S>_signal_with_antibody_nm`: the sample's response, nm.
- `<S>_percent_signal_lost`: as Twist Bioscience report it, not corrected for drift.
- `<S>_percent_signal_lost_drift_corrected`: both responses less the run's IgG control (ours; not for 9004G).

A percent is empty where the response without antibody is near zero. The run with 9004G was not assessed: about half the captured Cn2 left the sensor before the samples came.

### `BVP_ELISA.csv`

Baculovirus particle (BVP) ELISA at Twist Bioscience, without the control antibodies. The BVP ELISA was one run per design at one concentration, one well on each of two plates.

- `concentration_mg_per_mL`: as Twist Bioscience list it (negative for 3f0f990a: `not assessed`).
- `OD450_plate_1`, `OD450_plate_2`, `OD450_mean`: OD at 450 nm.
- `percent_of_cixutumumab`: `OD450_mean` against that control antibody, same plates.
- `against_reference_VHH_Fc_range`, `run`: `below`, `within`, or `above` 12 reference VHH-Fc of the same day, on another plate and scaled to that plate's cixutumumab (run 1: 28 to 94%; run 2: 16 to 102%).

### `toxins.csv`

- `toxin_in_file_names`, `family`, `receptor_site`, `organism`, `UniProt`, `UniProt_name`: as named.
- `residues_in_UniProt`, `length_aa`, `sequence`: the mature chain.
- `disulfides`, `native_C_terminus_amidated`: by residue number in that chain; `yes` or `no`.
- `structure_prepared_as_design_target`: a PDB or AlphaFold DB entry.

### `controls.csv`

One row per replicate; at Adaptyv Bio, every control antibody sample of the main screen, by SPR or BLI. Not in this table: RU1 by SPR at Twist Bioscience, and the controls' series against CLEC12A (in `sensorgrams/`).

- `control`: 9004G, LR, RU1, 4C1, 9C2, serrumab; Twist Bioscience's `anti-Ts1 antibody, spot <n>` and `polyclonal human IgG`.
- `format`: `Fab` or `scFv`, empty where not stated (serrumab scFv against AaH I: replicates 1 and 2 are two samples).
- `raised_against`: the antibody's own toxin.
- `method`: SPR, BLI, or `reverse BLI` (Twist Bioscience).
- `control_worked`: `works`, `inconclusive` (serrumab at Adaptyv Bio, with a note), `fails quality check`, or `no response`; empty for a toxin the antibody was not raised against. Against Ts1 at Adaptyv Bio, antibodies raised against other toxins also gave signals, so the control is inconclusive.
- `result`: Adaptyv Bio's own label of the replicate, `bound` or `no binding detected`; `not measured (did not express)`: the scFv of 9C2 against Ts1; empty for Twist Bioscience's SPR.
- `KD_nM`, `KD_upper_limit_nM`: the replicate's selected fit; where it lies below the lowest concentration of its series, that concentration: the report and the pictures then give the KD as below it.
- `response_at_highest_concentration_RU`: our mean over the last 10 s of association (Twist Bioscience: about 12 s).
- `response_nm`: by BLI at Adaptyv Bio, taken as the response in RU; reverse BLI at Twist Bioscience, `bound` at 0.05 nm or more (Twist Bioscience's rule).

## `sensorgrams/`

### `sensorgrams/INDEX.csv`

One row per series with a trace.

- `folder`, `uuid_or_control`, `format`: folder; design or control; `Fab` or `scFv` (Adaptyv Bio's controls; also the last column of their kinetics and trace files).
- `concentrations_nM`, `n_points`: toxin concentrations; rows of trace.
- `result`: the pair's result from `design.csv`, on every replicate (controls: `bound`, `no binding detected`, or empty).
- `assay`: `main screen`, `OVA`, `reverse BLI`, `competition`, or `second supplier` (the last four: `<uuid>_followup_traces.csv`, `<uuid>_followup.png`; result from that assay's table, if it has one, for Adaptyv Bio's competition their tier; concentrations of what was in solution; `replicate`: for Adaptyv Bio's competition the run).

### `<uuid>_kinetics.csv`

One row per `lab`, `toxin`, and `replicate` (controls: and `format`).

- `result`: as in `sensorgrams/INDEX.csv`.
- `KD_nM`, `kon_per_M_s`, `koff_per_s`: Adaptyv Bio's or Twist Bioscience's own 1:1 fit (Cn2-B1 at Adaptyv Bio: rates only). The pictures mark Twist Bioscience's own with `(lab)`. In the pictures, in the report's words, ≤ marks an upper limit where the off-rate was not resolved, as for Cn2-B1.
- `response_at_highest_concentration_RU`: the response (ours) at 1,000 nM.
- `method`: SPR, or BLI (traces in nm, drawn on a scale of their own; no response). At Adaptyv Bio, 39 of 1,713 series of designs were run by biolayer interferometry (BLI).
- `our_KD_nM`, `our_KD_qualifier`: our fit (Twist Bioscience), as `<T>_Twist_KD_nM`; `=`, or `<=` for an upper limit.
- `our_kon_per_M_s`, `our_koff_per_s`: for the 35 pairs with hits at both labs, and for e32555c5 against Cn2.
- `Adaptyv_replicate_result`: Adaptyv Bio's own result per replicate, which their panels of the pictures carry; empty for Twist Bioscience.
- `format`: controls only, as in `controls.csv`.

### `<uuid>_traces.csv`

One row per time point; `lab`, `toxin`, and `replicate` (controls: and `format`) name its series.

- `concentration_nM`, `time_s`, `response_RU`: `time_s` restarts at each concentration (at Twist Bioscience as early as -30 s); the toxin flows from 0 to about 300 s. Where `method` is BLI, `response_RU` and `fit_RU` are in nm.
- `fit_RU`: Adaptyv Bio's 1:1 fit or, for 15 binders, e32555c5, and 9C2 at Twist Bioscience, ours.
- The traces are referenced: Adaptyv Bio's are double referenced; from Twist Bioscience's, we subtracted the mean curve of each injection's negative-control spots (in run 2, each spot's adjacent reference region had already been subtracted).
- `format`: controls only, as in `controls.csv`.

### `<uuid>_followup_traces.csv`

- `assay`, `toxin`, `series`, `concentration_nM`: as in the index; `OVA`: the replicate (or blank spot), Adaptyv Bio's processed curves; `reverse BLI`: Twist Bioscience's raw sensors with and without toxin, one per concentration; `competition`: after 9C2 or after buffer. Adaptyv Bio's processed curves: `Adaptyv Bio replicate <n>` (reverse BLI), `Adaptyv Bio run <n>` (competition; toxin at 0 and 200 nM; `probe <n>`: toxin alone), `replicate <n>` (second supplier); `fit` ends the name of the 1:1 fit curve.
- `time_s`, `response`: 0 where the sample step starts; RU for `OVA` and `second supplier`, else nm.

### Pictures

`<uuid>_sensorgrams.png` and `<uuid>_followup.png` draw the traces, with the fits as thin lines. Picture labels: `Hit`, `No hit`, `Weak or ambiguous`, `Near background`, `Not assessable`, `Unresolved`, `Not measured`, `By BLI: no trace`, `Measured: no trace`, `Left out: no design on the spot`, `Run not assessed`, `Not assessed`, `no working control`, `serves as the zero`; controls: `Binding detected`, `Not detected`.

## `structures/`

### `structures/INDEX.csv`

The design model (the 243 `_design-` files) is the complex of a design and a toxin that serves as the reference pose for scDockQ. The report's main figures draw the ESMFold2 complexes (`kind` predicted complex, `predictor` ESMFold2).

- `file`, `kind`: path within `structures/`; `design`, `predicted complex`, or `predicted monomer` (the seed of highest pLDDT).

Structure files: chain A is the design, chain B the toxin. B-factor: pLDDT in complexes and monomers; ignore it in `_design-` files. In `_design-` files, the design chain has its backbone and, on about half its residues, C-beta (14 files: backbone only).

## `supporting_tables/`: how each design was made and expressed

### `supporting_tables/origin.csv`

- `rank_in_set`: rank at selection (Sets 1 to 9).
- `set_10_kind`: `from the Set 8 pool`, `point variant`, or `fusion`.
- `backbone_made_against`, `design_tool`, `backbone_family`: the backbone's toxin, tool (BoltzDesign1, BoltzGen, FreeBindCraft, Genie 3, Mosaic, Protein Hunter, Proteina-Complexa, PXDesign, RFdiffusion, RFdiffusion3), and family (designs that share a starting backbone); a point variant has its parent's; empty for fusions.
- `redesign_round`: round of sequence redesign, 1 to 25.
- `sequence_design_method`: the last sequence step: `SolubleMPNN`, `SolubleCaliby`, `SolubleMPNN, multistate`, `interface graft`, `fusion of two domains`, or `point substitutions`.
- `parent_uuid`, `substitutions_from_parent`: the design redesigned from; a point variant's substitutions.
- `substitutions_in_design_model`: residues renamed in the design model, which is an earlier design's (23 files).
- `domainA_uuid`, `domainB_uuid`, `linker`: a fusion's domains (if among the 211) and linker.

### `supporting_tables/expression.csv`

At Adaptyv Bio.

- `split_GFP_expression_ug_per_mL`: soluble yield of the main screen's cell-free reaction by split-GFP complementation (a199ee01: the reaction tested against AaH II; 261.1 in the one tested against Cn2 and Ts1).
- `purified_yield_uM`, `purified_yield_mg_per_mL`: after purification for the follow-up assays (44 designs).
- `<` and `>` in the three columns: outside the range of 2.5 to 25 µM.

## `supporting_tables/`: follow-up assays

### `supporting_tables/AaHI_competition_Twist_Bioscience.csv`

BLI at Twist Bioscience against AaH I, with the antibody 9C2 put on the toxin first; measured once per design.

- `kind`, `control`: `design` or `control`; 9C2 or `buffer`.
- `AaHI_assessed`: `yes` for a hit against AaH I in Twist Bioscience's reverse BLI, else `no`.
- `9C2_signal_without_antibody_nm`, `9C2_signal_with_antibody_nm`, `9C2_percent_signal_lost`: as the `<S>` columns of `Cn2_competition_Twist_Bioscience.csv`.
- `serves_as_zero`, `9C2_percent_signal_lost_net_of_zero`, `9C2_percent_signal_lost_net_of_zero_low`, `9C2_percent_signal_lost_net_of_zero_high`: both responses less the mean of the four designs marked `yes` (ours); range over their extremes.

A percent is empty where the response without antibody is near zero.

### `supporting_tables/competition_Adaptyv_Bio.csv`

BLI; the antibody, LR or 9C2 as scFv, on the sensor; 200 nM toxin mixed with 1 µM design, which carries C-terminal GFP11 and 8×His tags (8×His replaces the twin-Strep tag of the main screen); less toxin captured means competition; one row per design and run, and one per toxin-alone probe; the runs against Ts1 and LqhIII gave no valid result and are not included. Two or three runs per design.

- `kind`, `control`, `probe`, `antibody`: `design`, or `control` (`toxin alone`, by probe); LR for Cn2, 9C2 for AaH I.
- `run`, `run_assessed`, `association_s`: `yes`, but `no` for run 1 against Cn2: its antibody loading was 0.03 to 3.2 nm (3.5 to 7.8 nm in runs 2 and 3); 300 or 600 s. A design without a run has a tier only.
- `Adaptyv_tier`, `Adaptyv_coefficient`: per design, `Potentially competing`, `Partially competing`, `Potentially not competing`, or `Failed`; per run, 1 less the response per loading over that of toxin alone times (toxin mass + design mass) / toxin mass, so a design that changes nothing scores above 0.5. The report counts `Potentially competing` only.
- `response_nm`, `response_at_end_of_association_nm`: 99th percentile of the association; mean of its last 10 s (negative: the trace fell below the baseline, and the ratio is not quantitative).
- `antibody_loading_nm`, `response_per_loading`, `ratio_to_toxin_alone_per_loading`: first value of the raw trace; `response_nm` over it; that over the median of the run's toxin-alone probes (ours).

### `supporting_tables/reverse_BLI.csv`

Toxin on the sensor; design in solution at 31.6, 100, 316.2, and 1,000 nM; one row per measurement.

- `replicate`, `run`: the measurement's number for that pair; Adaptyv Bio's run (per toxin).
- `result`, `strength`: Adaptyv Bio's `hit`, `no hit`, or `unresolved` and, for hits, `strong`, `medium`, or `weak` (empty where they give none).
- `KD_nM`, `KD_low_nM`, `KD_high_nM`: Adaptyv Bio's 1:1 fit and its interval; empty where they fitted none. Against Cn2 they selected the 1:1 model throughout, so that values compare across designs, although other models fit some designs better.
- `concentrations_fitted_nM`: those in the fit.
- `toxin_loading`: Adaptyv Bio's grade (`low`, `medium`, `high`).
- `note`, Adaptyv Bio's rows: a KD below the lowest concentration; below 1 nM (LqhIII-B1, off-rate at the lower bound of the fit) it is an upper limit, and the report and the picture give the KD as below that concentration; their team's advice on e32555c5 and 9a8cdc7a against Cn2 (9a8cdc7a: the report and the picture give the KD with ≈).
- `response_nm`, `note`: Twist Bioscience's rows (one per pair; design at up to 400 nM) hold only their `result`, a `hit` at 0.05 nm or more, and that response; no KD. `not assessable`: the sample of 3f0f990a held no protein.

### `supporting_tables/OVA.csv`

SPR at Adaptyv Bio against ovalbumin, OVA, at 10 to 1,000 nM without regeneration. Ovalbumin (OVA) is a protein unrelated to the toxins; OVA is not among the four criteria (Cn2-B1 and AaHI-B4 were hits).

- `result`, `Adaptyv_result`: `hit` or `no hit`, as in the report, and as Adaptyv Bio list it (the same for all 52); they report hit or no hit only; the responses and the share below are ours, from their traces.
- `response_replicate_<n>_RU`, `capture_replicate_<n>_RU`: at the end of the 1,000 nM injection; design on the spot, from the loading trace (both ours).
- `percent_of_theoretical_Rmax`: response over that of one OVA (45 kDa) per captured design (sequence and 6,114.6 Da of tags); mean of the replicates.
- `series_left_out`: why a cell is empty.

### `supporting_tables/second_supplier.csv`

SPR at Adaptyv Bio as in the main screen, against Cn2 and AaH II from a second supplier (Cusabio CSB-YP355662DRB and CSB-EP355659AJZ, the catalog numbers of Twist Bioscience's preparations), at 10 to 1,000 nM; one row per replicate; Ts1 from that supplier (CSB-EP323347TON) failed Adaptyv Bio's quality check for aggregation and is not included.

- `kind`, `control`, `format`: `design`, or `control` as in `controls.csv`.
- `result`, `Adaptyv_replicate_result`: Adaptyv Bio's, per replicate.
- `method`, `KD_nM`, `kon_per_M_s`, `koff_per_s`, `response_at_highest_concentration_RU`: as in `<uuid>_kinetics.csv`. The report gives the KD of Cn2-B1 as <10 nM, the lowest concentration tested, because the fit lies far below it and the off-rate is not resolved; the pictures do so for Cn2-B1, LR, and 9004G.
- `pair_KD_nM`: arithmetic mean over the fitted replicates.

## `supporting_tables/`: per-seed scores, interfaces, and thresholds

### `supporting_tables/in_silico_scores_all_seeds.csv`

For 535 of the 1,055 pairs of a design and a toxin: Sets 1 to 7 against the toxins they were not made against (390), and 29 designs of Set 10 against all five (145).

- `ipSAE`, `ipTM`, `pTM`, `pLDDT_design`, `pLDDT_toxin`: per seed; pLDDT is each chain's mean.

### `supporting_tables/monomer_folds_per_seed.csv`

- `pLDDT`, `RMSD_to_design`, `RMSD_helices`, `TM_to_design`: against the design model; C-alpha RMSD in Å (fusions as above); the last two are empty for Protenix v2.

### `supporting_tables/predicted_interfaces.csv`

One row per design, intended toxin, and `source`.

- `source`: `esmfold2` or `protenix-v2`.
- `buried_area_A2`, `buried_area_design_A2`, `buried_area_toxin_A2`: both sides and each, Å², probe 1.4 Å.
- `apolar_share`: of the buried area.
- `n_design_residues_in_contact`, `n_toxin_residues_in_contact`, `design_residues_in_contact`, `toxin_residues_in_contact`: heavy atoms within 5 Å (the report's epitopes and footprints use 4.5 Å), numbered within each chain.
- `hotspots_in_contact`, `n_hotspots_in_contact`: of the toxin's five.
- `helix_share`, `strand_share`, `n_helices`: of the design; helices of eight or more residues.

### `supporting_tables/ipSAE_thresholds.csv`

- `ipSAE_threshold`: the ipSAE, fixed in advance, that a design had to reach.

### `supporting_tables/controls_cofolding_scores.csv`

One row per toxin, predictor, and construct; five seeds; controls with alignments for all chains.

- `role`, `kind`: `positive control` (`control_ab`: an antibody; `control_vsd`: the channel's voltage-sensor domain) or `negative` (`decoy`: natural proteins (`nat`, PDB entry), idealized helical proteins, and scrambled versions (`scr`); `neg_shuffled`: a shuffled control).
- `construct_name`, `construct`: name, ending in the PDB entry if any; the chains. The nine rows of serrumab and 9C2 (ESMFold2-Fast without alignments) have ipSAE and ipTM only.
- `ipSAE`, `ipSAE_per_seed`: the lower of the two directional values; the best seed, and the five seeds (`NaN`: no score).
- `ipTM`, `LIS`, `DockQ_to_native`: interface pTM and local interaction score; DockQ of the best seed against the PDB complex (antibodies: VH and VL merged).
- `highest_negative`, `separation`, `passed_as_control`: the highest `ipSAE` among that toxin's and predictor's negatives; `ipSAE` less it; `True` (from 0.14) or `False` (up to 0.02).
