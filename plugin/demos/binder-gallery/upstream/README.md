---
license: cc-by-4.0
pretty_name: Scorpion toxin binder design (data release)
size_categories:
- n<1K
tags:
- biology
- proteins
- protein-design
- de-novo-binders
- scorpion-toxins
- antivenom
- surface-plasmon-resonance
- biolayer-interferometry
- structure-prediction
configs:
- config_name: design
  data_files:
  - split: full
    path: design.csv
  default: true
- config_name: in_silico_scores
  data_files:
  - split: full
    path: in_silico_scores.csv
- config_name: Cn2_competition_Twist_Bioscience
  data_files:
  - split: full
    path: Cn2_competition_Twist_Bioscience.csv
- config_name: BVP_ELISA
  data_files:
  - split: full
    path: BVP_ELISA.csv
- config_name: toxins
  data_files:
  - split: full
    path: toxins.csv
- config_name: controls
  data_files:
  - split: full
    path: controls.csv
- config_name: sensorgrams_index
  data_files:
  - split: full
    path: sensorgrams/INDEX.csv
- config_name: structures_index
  data_files:
  - split: full
    path: structures/INDEX.csv
- config_name: AaHI_competition_Twist_Bioscience
  data_files:
  - split: full
    path: supporting_tables/AaHI_competition_Twist_Bioscience.csv
- config_name: OVA
  data_files:
  - split: full
    path: supporting_tables/OVA.csv
- config_name: competition_Adaptyv_Bio
  data_files:
  - split: full
    path: supporting_tables/competition_Adaptyv_Bio.csv
- config_name: controls_cofolding_scores
  data_files:
  - split: full
    path: supporting_tables/controls_cofolding_scores.csv
- config_name: expression
  data_files:
  - split: full
    path: supporting_tables/expression.csv
- config_name: in_silico_scores_all_seeds
  data_files:
  - split: full
    path: supporting_tables/in_silico_scores_all_seeds.csv
- config_name: ipSAE_thresholds
  data_files:
  - split: full
    path: supporting_tables/ipSAE_thresholds.csv
- config_name: monomer_folds_per_seed
  data_files:
  - split: full
    path: supporting_tables/monomer_folds_per_seed.csv
- config_name: origin
  data_files:
  - split: full
    path: supporting_tables/origin.csv
- config_name: predicted_interfaces
  data_files:
  - split: full
    path: supporting_tables/predicted_interfaces.csv
- config_name: reverse_BLI
  data_files:
  - split: full
    path: supporting_tables/reverse_BLI.csv
- config_name: second_supplier
  data_files:
  - split: full
    path: supporting_tables/second_supplier.csv
dataset_info:
- config_name: Cn2_competition_Twist_Bioscience
  features:
  - {name: kind, dtype: string}
  - {name: uuid, dtype: string}
  - {name: name, dtype: string}
  - {name: binder_against, dtype: string}
  - {name: control, dtype: string}
  - {name: Cn2_assessed, dtype: string}
  - {name: LR_signal_without_antibody_nm, dtype: float64}
  - {name: LR_signal_with_antibody_nm, dtype: float64}
  - {name: LR_percent_signal_lost, dtype: int64}
  - {name: LR_percent_signal_lost_drift_corrected, dtype: float64}
  - {name: RU1_signal_without_antibody_nm, dtype: float64}
  - {name: RU1_signal_with_antibody_nm, dtype: float64}
  - {name: RU1_percent_signal_lost, dtype: int64}
  - {name: RU1_percent_signal_lost_drift_corrected, dtype: float64}
  - {name: 9004G_signal_without_antibody_nm, dtype: float64}
  - {name: 9004G_signal_with_antibody_nm, dtype: float64}
  - {name: 9004G_percent_signal_lost, dtype: int64}
- config_name: competition_Adaptyv_Bio
  features:
  - {name: kind, dtype: string}
  - {name: uuid, dtype: string}
  - {name: name, dtype: string}
  - {name: binder_against, dtype: string}
  - {name: control, dtype: string}
  - {name: toxin, dtype: string}
  - {name: antibody, dtype: string}
  - {name: run, dtype: int64}
  - {name: probe, dtype: int64}
  - {name: run_assessed, dtype: string}
  - {name: association_s, dtype: int64}
  - {name: Adaptyv_tier, dtype: string}
  - {name: Adaptyv_coefficient, dtype: float64}
  - {name: response_nm, dtype: float64}
  - {name: response_at_end_of_association_nm, dtype: float64}
  - {name: antibody_loading_nm, dtype: float64}
  - {name: response_per_loading, dtype: float64}
  - {name: ratio_to_toxin_alone_per_loading, dtype: float64}
- config_name: origin
  features:
  - {name: uuid, dtype: string}
  - {name: name, dtype: string}
  - {name: design_set, dtype: int64}
  - {name: rank_in_set, dtype: int64}
  - {name: set_10_kind, dtype: string}
  - {name: backbone_made_against, dtype: string}
  - {name: design_tool, dtype: string}
  - {name: backbone_family, dtype: string}
  - {name: redesign_round, dtype: int64}
  - {name: sequence_design_method, dtype: string}
  - {name: parent_uuid, dtype: string}
  - {name: substitutions_from_parent, dtype: string}
  - {name: substitutions_in_design_model, dtype: string}
  - {name: domainA_uuid, dtype: string}
  - {name: domainB_uuid, dtype: string}
  - {name: linker, dtype: string}
- config_name: reverse_BLI
  features:
  - {name: uuid, dtype: string}
  - {name: name, dtype: string}
  - {name: design_set, dtype: int64}
  - {name: toxin, dtype: string}
  - {name: lab, dtype: string}
  - {name: replicate, dtype: int64}
  - {name: run, dtype: int64}
  - {name: result, dtype: string}
  - {name: strength, dtype: string}
  - {name: KD_nM, dtype: float64}
  - {name: KD_low_nM, dtype: float64}
  - {name: KD_high_nM, dtype: float64}
  - {name: fit_model, dtype: string}
  - {name: Adaptyv_fit_quality, dtype: string}
  - {name: concentrations_fitted_nM, dtype: string}
  - {name: toxin_loading, dtype: string}
  - {name: response_nm, dtype: float64}
  - {name: note, dtype: string}
---

# Scorpion toxin binder design: data release

Claude designed proteins *de novo* to bind five scorpion toxins: Cn2, Ts1, AaH II, AaH I, and LqhIII. Two contract research organizations measured binding by surface plasmon resonance (SPR): Adaptyv Bio and Twist Bioscience. Seventeen designs are binders: seven against Cn2, four against AaH II, four against AaH I, two against LqhIII, and none against Ts1. Report: *De novo design of protein binders against scorpion toxins with Claude* (https://www-cdn.anthropic.com/31ac578806cffd8b3d92d8affe6edc4c04d502e1.pdf). Blog post: https://www.anthropic.com/research/claude-scorpion-toxin-binder-design.

<video src="https://huggingface.co/datasets/Anthropic/scorpion-toxin-binder-design/resolve/main/assets/Scorpion_Cn2_film_60s_4K.mp4" poster="https://huggingface.co/datasets/Anthropic/scorpion-toxin-binder-design/resolve/main/assets/Scorpion_Cn2_film_60s_poster.jpg" autoplay loop muted playsinline controls width="100%"></video>

<sub>How the scorpion neurotoxin Cn2 acts on sodium channels, how the antibody LR neutralizes it, and how Cn2-B1 competed with LR for Cn2 (60 s, no sound). That Cn2-B1 should neutralize Cn2 as LR does is an expected outcome, not yet tested by patch-clamp recordings in cells.</sub>

## Start here

`design.csv` has one row per design: sequence, each lab's result and KD against each toxin, and `binder_against`. Designs go by eight-character identifiers (`uuid`), binders also by names (Cn2-B1). Load `uuid` as text: a spreadsheet turns `946282e8` into 9.46E+13.

## Dataset viewer

The default subset is `design` (one row per design, 211 rows). Every other top-level table and every table in `supporting_tables/` is a subset named after its file; the two indexes are `sensorgrams_index` and `structures_index`; each subset has one split, `full`. The per-design folders in `sensorgrams/` and `structures/` are files to browse or download, as is the film in `assets/`.

## What is in the package

File or folder | Contents
---|---
`design.csv` | All 211 designs, with both labs' results and `binder_against`.
`in_silico_scores.csv` | Predicted scores, in the order of `design.csv`.
`Cn2_competition_Twist_Bioscience.csv` | Competition with the antibodies LR, RU1, and 9004G for Cn2: 16 designs and four controls.
`BVP_ELISA.csv` | Baculovirus particle (BVP) ELISA for polyreactivity: 51 designs.
`toxins.csv` | The five toxins: sequence, family, and design target.
`controls.csv` | The control antibodies at both labs: main screen and reverse BLI.
`sensorgrams/` | One folder per design and control: picture, traces, and kinetic fits of the main screen, and the follow-up assays where run, indexed in `INDEX.csv`.
`structures/` | One folder per design: design model and predicted structures, indexed in `INDEX.csv`.
`supporting_tables/` | Twelve tables: how each design was made and expressed; follow-up assays; per-seed scores, interfaces, and thresholds (list in `COLUMNS.md`).
`COLUMNS.md` | Every file and every column, explained.
`LICENSE.md` | CC BY 4.0.

## Getting started

```python
from datasets import load_dataset
import pandas as pd

designs = load_dataset("Anthropic/scorpion-toxin-binder-design", split="full")  # the default subset, design.csv
origin = load_dataset("Anthropic/scorpion-toxin-binder-design", "origin", split="full")  # any other subset by its name
table = pd.read_csv("hf://datasets/Anthropic/scorpion-toxin-binder-design/design.csv", dtype={"uuid": str})  # uuid as text
```

```bash
# the tables only
hf download Anthropic/scorpion-toxin-binder-design --repo-type dataset --include "*.csv" --exclude "sensorgrams/*/*"
# the two folders of one design (888c8f04 is Cn2-B1)
hf download Anthropic/scorpion-toxin-binder-design --repo-type dataset --include "*/888c8f04/*"
```

## Terms, in the report's words

- We define a hit as a result at one lab indicating that a design binds a toxin or an unrelated protein (CLEC12A or OVA; off-target binding). The design, or the design-toxin pair, is then a hit at that lab.
- We define a binder of a toxin as a design with 1) a hit against the toxin at both labs, in every replicate, 2) every KD from the main screen at 1 µM or tighter, 3) a fitted maximum response (fitted Rmax) at Twist Bioscience within the theoretical Rmax (the largest response that one toxin molecule per binding site can give), and 4) no signal above background against CLEC12A in either of Twist Bioscience's two SPR runs. For LqhIII, measured only at Adaptyv Bio, a binder needed a hit there in every replicate, a KD of 1 µM or tighter, and criterion 4.

## How to cite

Claude Science, Nathaniel Horwitz, James van Geelen, Kat Kajderowicz, Amir Shanehsazzadeh. *De novo design of protein binders against scorpion toxins with Claude.* October 20, 2026. https://www-cdn.anthropic.com/31ac578806cffd8b3d92d8affe6edc4c04d502e1.pdf.

## License

CC BY 4.0 (see LICENSE.md).
