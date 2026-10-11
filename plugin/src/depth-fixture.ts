/**
 * The three-marker depth fixture, embedded so both the server and the viewer
 * bundle can load it without a filesystem read.
 *
 * `test/fixtures/three-depth-markers.pdb` remains the file the pixel gate
 * loads. `test/depth-fixture.test.ts` asserts the two are byte-identical, so
 * the structure a human observer fuses is the same one the numeric gate
 * measures.
 */
export const DEPTH_FIXTURE_ID = 'three-depth-markers';

/**
 * Marker radius multiplier for the pixel gate.
 *
 * Ball-and-stick draws these markers at Mol*'s default `sizeFactor` of 0.15
 * times the van der Waals radius, about 1.5 CSS px across at 65 Angstrom.
 * That is too few pixels for a sub-pixel centroid, so the acceptance render
 * enlarges them. The gate's canvas is roughly 580 CSS px tall, where this
 * factor gives a marker about 19 px across.
 */
export const DEPTH_FIXTURE_SIZE_FACTOR = 0.4;

/**
 * Marker radius multiplier for a human observer.
 *
 * The two numbers differ because the two viewers do not have the same stage.
 * A host panel leaves the canvas about 200 CSS px tall, roughly a third of the
 * gate's, so the gate's factor would put a marker at about 4 px on screen and
 * the depth-order task would be judging four pixels. This factor restores a
 * marker of roughly 11 px in the shortest panel. It stops short of the 4
 * Angstrom vertical stagger between markers, whose whole purpose is to keep
 * the near marker from occluding the other two: at this factor a marker is
 * about 3 Angstrom across, so a 1 Angstrom gap remains.
 */
export const DEPTH_FIXTURE_OBSERVER_SIZE_FACTOR = 1;

/**
 * Camera distance the human-evaluation protocol assumes. From (0, 0, this)
 * looking at the origin the three markers sit at 45, 65 and 85 Angstrom
 * camera depth, which is what the protocol's expected disparities are
 * computed from.
 */
export const DEPTH_FIXTURE_CAMERA_Z = 65;

export const DEPTH_FIXTURE_PDB = `HEADER    STEREO STRUCTURE PIXEL-ACCEPTANCE FIXTURE
TITLE     THREE MARKER SPHERES AT KNOWN DEPTHS, STAGGERED IN Y
REMARK   1 X IS ZERO FOR ALL THREE MARKERS, SO EVERY MARKER PROJECTS TO THE
REMARK   1 HORIZONTAL CENTRE OF ITS EYE VIEWPORT AND ALL MEASURED HORIZONTAL
REMARK   1 DISPARITY COMES FROM THE STEREO BASELINE ALONE. THE Y STAGGER ONLY
REMARK   1 STOPS THE NEAR MARKER OCCLUDING THE OTHER TWO; A HORIZONTAL EYE
REMARK   1 OFFSET PRODUCES NO VERTICAL DISPARITY, SO IT DOES NOT PERTURB THE
REMARK   1 MEASUREMENT. CAMERA AT (0,0,65) LOOKING AT THE ORIGIN PUTS THE
REMARK   1 MARKERS AT CAMERA DEPTHS 45, 65 AND 85 ANGSTROM.
HETATM    1  F1  FRN A   1       0.000   4.000  20.000  1.00 20.00           F  
HETATM    2  O1  CTR A   2       0.000   0.000   0.000  1.00 20.00           O  
HETATM    3  N1  REA A   3       0.000  -4.000 -20.000  1.00 20.00           N  
END
`;
