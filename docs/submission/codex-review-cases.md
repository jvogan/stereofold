# Stereofold review cases

These are reproducible review instructions for the full local plugin. They are
prepared in the schema used by OpenAI's submission materials. Run them in the
review environment agreed for local MCP support before attesting that they pass.
The existing automated tests cover the underlying rendering, selection, pairing,
source replacement and lesson behaviors; they are not a transcript of an agent
executing every prompt below on every device.

Use a Mac with Node.js 22 or newer and the full Stereofold plugin installed.
Public PDB examples need network access. Cases 3 and 4 also need a WebXR headset
on the same Wi-Fi; a desktop companion can exercise synchronization but does
not establish physical headset support. No Stereofold account is required.
Keep voice and public relay features off unless they are being reviewed.

Run positive cases 1–4 in order, then run case 5 in its lesson session. Negative
cases ask for predictions or simulations that Stereofold does not perform.
Use public examples and an isolated test profile.

## Positive 1: Open and inspect a public molecular structure.

**Prompt:** Inspect PDB 1CRN in Stereofold and open the inspector.

**Tools:** `stereo_structure.inspect; stereo_structure.open_inspector when no embedded panel is available; stereo_structure.get_inspection_state`

**Expected:** The inspector renders crambin and saves the scene. The agent confirms a rendered/saved state, identifies the public source, and keeps this session for subsequent requests.

## Positive 2: Apply a precise change to the current scene.

**Prompt:** In the current crambin scene, select chain A residues 10 through 15 and color them orange.

**Tools:** `stereo_structure.get_inspection_state; stereo_structure.update_inspection; stereo_structure.get_inspection_state`

**Expected:** The selected residues are visible in orange in the current scene. A rendered command receipt confirms completion. The source and session remain the same.

## Positive 3: Share the existing scene with a WebXR headset.

**Prompt:** Put this same structure on my headset over our Wi-Fi, then keep it connected while we work.

**Tools:** `stereo_structure.get_inspection_state; stereo_structure.open_companion; stereo_structure.get_inspection_state`

**Expected:** Stereofold supplies the private HTTPS pairing route and the appropriate device handoff. The reviewer completes browser/certificate/pairing/immersive gestures on their device. The agent distinguishes paired, rendered and in-VR states and reports the actual state.

## Positive 4: Replace the molecule while retaining the paired connection.

**Prompt:** Switch our current scene to hemoglobin, PDB 4HHB, and keep my headset connected.

**Tools:** `stereo_structure.get_inspection_state; stereo_structure.replace_inspection_source; stereo_structure.get_inspection_state`

**Expected:** The current session loads 4HHB and receives a rendered source receipt. The existing paired companion receives the new molecule without requiring another pairing code.

## Positive 5: Play a bundled molecular lesson.

**Prompt:** Open the bundled daraxonrasib lesson for PDB 9AX6 and show me both chapters, then go back to the first.

**Tools:** `stereo_structure.inspect_lesson; stereo_structure.open_inspector when needed; stereo_structure.control_tour; stereo_structure.get_inspection_state`

**Expected:** The agent resolves the bundled lesson and its declared coordinates/assembly. The two authored scenes and captions render. Back restores the first scene. Contact distances are described as geometry, without claiming they establish hydrogen bonds.

## Negative 1: Structure prediction

**Prompt:** Use Stereofold to predict the 3D structure of this protein from its amino-acid sequence.

**Expected:** Stereofold visualizes supplied coordinates and does not predict a protein structure from sequence. Do not call its inspection tools as if a sequence were a coordinate model. Offer a separate structure-prediction workflow and inspect the resulting coordinates afterward.

## Negative 2: Binding-affinity calculation

**Prompt:** Use Stereofold to calculate the exact binding affinity in nanomolar units for the ligand in this structure.

**Expected:** Stereofold does not calculate binding affinity. Do not convert visual contacts or distances into a measured or validated Kd, and do not invoke a Stereofold tool as an affinity calculation. Explain that an appropriate experimental or computational method is needed.

## Negative 3: Molecular dynamics simulation

**Prompt:** Run a 100-nanosecond molecular dynamics simulation at 310 kelvin in Stereofold and save the trajectory.

**Expected:** Stereofold is not a molecular dynamics engine. Do not run its visual spin or lesson playback as a simulation, and do not claim it produced a trajectory. Offer a separate simulation workflow and a compatible visualization of its outputs.

## Additional recovery checks

These exercise supported workflows and are separate from the three out-of-scope cases.

- Request chain Z residue 9999 in crambin: report the absent selection and preserve the scene.
- Request sharing with an unpaired headset: provide the pairing route and wait for device confirmation.
- Request immersive VR in a browser with no supported immersive mode: report the capability and continue in the desktop view or another browser.

## Walkthrough coverage

[The published desktop walkthrough](https://jvogan.github.io/stereofold/walkthrough.html)
records real local MCP operations: opening 1CRN, recoloring a residue range,
changing representation, replacing the source with 4HHB, highlighting its hemes,
and playing the bundled 9AX6 lesson. A controlled browser host renders the
inspector. Rendered receipts verify all eight scene changes.

The manifest includes this page as `review.demo_recording_url`. The recording
does not show headset pairing, the surrounding agent conversation or the three
negative cases. Use the following outline for additional coverage agreed with
the local MCP reviewer.

### Additional review recording

Record the actual Codex conversation and viewer while running these cases.
Show the installed plugin/version, the first rendered structure, a requested
selection/color edit, pairing, molecule replacement, and the lesson controls.
Show a headset capture for immersive claims; label any desktop companion or
simulator recording accurately. Demonstrate the three negative cases briefly.

Keep account details, local usernames, full filesystem paths, pairing codes,
page tokens and unrelated windows out of the recording. Use a fresh test session
and end sharing after recording. Put the finished video at a reviewer-accessible
HTTPS URL; a storyboard or screenshot montage is not a recorded run.

Record the tested date, Codex version, operating system and headset/browser
beside the video. Add the actual URL as `review.demo_recording_url` after the
recording exists. Do not use a placeholder URL or claim a headset was tested
from a desktop-only recording.

The adjacent JSON records the cases included under `extensions.com.openai` in
the full Codex manifest. Run them in the agreed local MCP review environment;
prepared cases are not a claim that these exact agent prompts have all passed.
Keep reviewer access instructions in the portal's secure review form.
