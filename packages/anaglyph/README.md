# `@stereo/anaglyph`

Anaglyph compositor for the stereoscopic Mol* viewer. Two variants share the same pipeline: CPU reference on RGBA buffers, matching WebGL2 fragment shader, luminance-led CPK palette.

Nothing in this package has been seen through glasses. The tests certify numbers, not a percept.

## Variants

| `variant` | Role | Luma residual on L = R |
| --- | --- | --- |
| `'balanced'` (default) | Luminance projector. Each filter receives only Rec.709 luma, scaled so both eyes match. | ≤ 0.25 % |
| `'dubois'` | Dubois 2001 least-squares colour projector. Optional. | ~115 % by design |

This package keeps a strict coupling criterion: the literal Rec.709 luma emitted into the left filter and the right filter must match to within 0.25 % on a zero-disparity (L = R) field (`eyeChannelLuma`). Dubois fails that gate because each matrix writes into both filter groups. Balanced is therefore the default. Pass `{ variant: 'dubois' }` for the colour variant.

`compositeLinear`, `compositeSrgb`, `compositeRgba`, `createAnaglyphPass`, and `anaglyphFragmentShader` all accept `{ variant }` and default to `'balanced'`.

## Pipeline

1. Decode each eye from sRGB to linear RGB (IEC 61966-2-1).
2. `C = clamp(M_L · C_L + M_R · C_R, 0, 1)`.
3. Encode back to sRGB.

## Balanced matrices

Rec.709 weights `w = [0.2126, 0.7152, 0.0722]`. The single-channel eye writes luma `Y = w · C` into its filter channel. The two-channel eye writes `k Y` into each of its channels, with `k` equal to (single-channel weight) / (sum of the two-channel weights), so both eyes emit the same Rec.709 luma.

### Red-cyan (default glasses)

`k = wR / (wG + wB) = 0.27000254`. This is the matrix form of the ideal red/cyan pair `(255, 0, 0)` / `(0, 142, 142)`.

```
M_L = [[ w0, w1, w2],
       [  0,  0,  0],
       [  0,  0,  0]]

M_R = [[     0,     0,     0],
       [ k w0, k w1, k w2],
       [ k w0, k w1, k w2]]
```

For L = R the composite is `[Y, k Y, k Y]`. Left-filter luma `wR · Y` equals right-filter luma `(wG + wB) · k Y`. Every in-gamut input stays in `[0, 1]` because `Y ≤ 1` and `k < 1`, and left/right write disjoint channels.

### Green-magenta

`k' = wG / (wR + wB) ≈ 2.511236`. The literal pair with single-channel weight 1 would write up to 2.511 into R and B. Both matrices are multiplied by `1/k'` so the output stays in `[0, 1]` and the luma ratio is unchanged.

```
M_L = [[ 0, 0, 0],
       [ w / k', … ],
       [ 0, 0, 0]]

M_R = [[ w, … ],
       [ 0, 0, 0],
       [ w, … ]]
```

### Amber-blue

`k' = wB / (wR + wG) ≈ 0.0778185`. Single-channel (blue) weight 1; amber (R and G) takes `k'`.

```
M_L = [[ k' w ],
       [ k' w ],
       [ 0, 0, 0]]

M_R = [[ 0, 0, 0],
       [ 0, 0, 0],
       [ w ]]
```

Left and right write disjoint channels in every pair, so the sum of two in-gamut eyes stays in `[0, 1]` without relying on clamp. Clamp remains in the compositor because Dubois needs it.

## Dubois matrices

Optional colour variant. Dubois 2001 states the XYZ projection; these 3×3 RGB matrices are later reconstructions.

### Red-cyan

Sanders and McAllister reconstruction of the 2001 projector; six decimals. Rounded to three decimals they match the "Dubois Anaglyph" example in Dubois's StereoPhoto Maker dialogs.

```
M_L = [[ 0.456100,  0.500484,  0.176381],
       [-0.040082, -0.037825, -0.015759],
       [-0.015216, -0.020597, -0.005469]]

M_R = [[-0.043471, -0.087939, -0.001555],
       [ 0.378476,  0.733640, -0.018450],
       [-0.072153, -0.112961,  1.226400]]
```

A second red-cyan set, three decimals, is printed in Dubois's March 2009 Photoshop note (`RED_CYAN_PHOTOSHOP_2009_*`). The compositor uses the six-decimal pair and clamps the sum.

### Green-magenta (TrioScopics)

From Dubois's screenshot [SPM_GM_matrix](https://www.flickr.com/photos/e_dubois/5132528166/) (2010).

### Amber-blue (ColorCode 3-D)

From Dubois's screenshot [SPM_YB_matrix](https://www.flickr.com/photos/e_dubois/5230654930/) (2010). Dolphin's GLSL disagrees on two signs and writes 0.991 for 0.911; this package follows the screenshot.

## Luminance-led palette

`luminancePalette(elementColorRGB, { glasses, variant }) → RGB`

Anaglyph glasses destroy CPK: oxygen red is gone through the cyan filter, nitrogen blue is gone through the red filter.

The mapper keeps Rec.709 luma of the input (H, S, C, O, N stay in that brightness order). Under `'balanced'` the projector discards isoluminant chroma, so the tint search is a near no-op on the emitted pair; the function still returns the largest in-gamut isoluminant tint for unaided preview. Under `'dubois'` it searches the largest isoluminant tint that keeps an internal white-normalised residual ≤ 0.20 % on L = R. That search is a palette heuristic, not the acceptance metric.

The acceptance metric is literal: unnormalised linear Rec.709 luma of the emitted filter-channel contributions (`eyeChannelLuma`). Balanced L = R fields pass ≤ 0.25 %. A Dubois composite of identical linear gray `[0.4, 0.4, 0.4]` measures 114.9600 %.

Forced dark ground: `#020506` (`ANAGLYPH_GROUND_HEX`), chosen so neither filter group lifts off black.

## Mol* DrawPass hook

`createAnaglyphPass(gl, { variant })` owns two colour+depth FBOs and a fullscreen quad. `render(leftTex, rightTex, target)` is the composite. Default variant is `'balanced'`. Set `pass.variant = 'dubois'` to switch without recompiling; the shader selects the matrix pair with `uVariant` (0 balanced, 1 Dubois) and `uGlasses` (0 red-cyan, 1 green-magenta, 2 amber-blue).

`docs/molstar-stereo-patch.md` pins the hook to Mol* 5.11.0 `mol-canvas3d/passes/draw.js:469`. Stock `_render` binds its own colour/depth targets at `draw.js:372-391`.

## Tests

`pnpm test` (vitest, node only; no GPU).

| Check | Criterion |
| --- | --- |
| Matrix 3dp | Each Dubois pair rounds to the published table |
| Balanced k | red-cyan `k = 0.27000254`; GM and AB follow the same weight-ratio rule |
| Luma metric | Direct ideal red/cyan `(255,0,0)` vs `(0,142,142)` residual ≤ 0.25 %. Balanced L = R sweep (grays and saturated colours, every glasses kind) residual ≤ 0.25 %. Dubois gray `[0.4,0.4,0.4]` remains 114.9600 % under `variant: 'dubois'` |
| Gamut | Balanced output ∈ [0, 1] for in-gamut L and R, including L ≠ R |
| Identical-input control | Identical inputs: `swapEyes` is a no-op (pixel delta 0) |
| Shader | Balanced string contains the balanced coefficients; Dubois coefficients remain under `variant: 'dubois'` |

On success the suite prints: `ALL CHECKS PASS — software geometry verified; human perception untested`.

## Citations

- E. Dubois, "A projection method to generate anaglyph stereo images," *Proc. IEEE ICASSP*, vol. 3, pp. 1661–1664, 2001. doi:10.1109/ICASSP.2001.941256
- E. Dubois, "Conversion of a Stereo Pair to Anaglyph with the Least-Squares Projection Method," March 2009
- W. R. Sanders and D. F. McAllister, "Producing Anaglyphs from Synthetic Images," *Proc. SPIE* 5006, 2003
- Green-magenta and amber-blue RGB matrices: Dubois, StereoPhoto Maker screenshots, 2010, URLs above
