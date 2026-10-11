# Separate stereo viewer

Use this route for side-by-side, cross-eyed, or anaglyph requests. Its tools do
not control the focused inspector or its tours.

Call `stereo_structure.open` with exactly one of `pdbId`, `structureText`, or
`fixture`. Pasted text accepts `format: "pdb" | "mmcif"`. The built-in
`fixture: "three-depth-markers"` has marker spheres at 45, 65, and 85 Å camera
depth and makes no network request. Public PDB lookup fetches mmCIF from RCSB.
Save the returned `sessionId` for later calls. Reopen the current card with
`open` and only that `sessionId`; keep coordinate text out of messages.

Stereo starts off. `set_mode` accepts `off`, `parallel`, `cross`, and
`anaglyph`. Depth strength uses arcminutes; `swapEyes` deliberately reverses eye
order. The `balanced` anaglyph variant sends both filters the same Rec.709 luma.
`dubois` preserves more hue with unequal eye brightness; describe that tradeoff
when requested.

Motion defaults to a slow rock. Reduced-motion preference disables it with a
visible notice. `set_motion` accepts `mode: "none" | "rock" | "spin" |
"parallax"`, optional `amplitudeDeg`, `periodS`, and `axis: "y" | "x"`.
Parallax follows mouse position and requests no camera access.

`control` supports `load_pdb`, `reset_camera`, and `fit`; its older motion
commands remain for compatibility. After `reset_camera` or `fit`, reopen the
same session with `open` so the camera action applies after hydration.
`get_state` reads the stereo viewer's state.

Confirm comfortable depth and eye alignment with the intended display and
viewer. Projected geometry alone cannot establish perceived binocular depth.
