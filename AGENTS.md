# Stereofold source workflow

Use this checkout to run, configure or adapt Stereofold. The committed runtime
in `plugin/dist/` works with Node.js 22 or newer. Repository use does not depend
on directory approval; plugin packages are separate distribution routes.

## Primary workflow

Optimize for users bringing their own structures, questions and ongoing work
through Claude Science, Codex or another capable agent. Start from the user's
requested source and current scene; preserve source identity, selections and
supported scene state across desktop/headset handoff and subsequent edits.
Use the full tools to compose custom scenes, lessons and interactions. Keep
the user's scientific workbench in the workflow and adapt the implementation
when the requested task needs it. Bundled demos are examples and test fixtures.
Validation should cover custom local input, live agent edits, source changes,
session continuation and recovery as well as named demos. Distinguish tested
behavior from capabilities that still need verification.

Load the canonical instructions for the requested task:

- [stereofold-setup](plugin/skills/stereofold-setup/SKILL.md): discover the
  environment, register the local server and verify the requested workflow.
- [stereo-structure](plugin/skills/stereo-structure/SKILL.md): inspect and edit
  desktop/headset scenes, continue a shared scene, and operate voice or lessons.
- [molecular-presentation](plugin/skills/molecular-presentation/SKILL.md):
  author lessons, compile plans and use the chosen live presentation route.

For direct MCP registration and skill discovery, read
[the source setup guide](docs/install.md#use-the-checkout-directly). Keep
existing host configuration and avoid registering the same runtime twice.

Use the user's available headset and browser. Check their capabilities and
actual rendering. When the requested workflow needs an adapter or renderer
change, inspect the source and implement the requested adaptation; keep its
source identity and verify its behavior. Preserve the user's chosen scientific
workbench and voice provider. Report physical-device and simulator evidence
with their actual scope.
