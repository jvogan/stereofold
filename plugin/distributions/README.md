# Distribution profiles

The canonical skills live in `plugin/skills/`. They support the full runtime
across Codex, Claude Code, Claude Science, and other MCP hosts. Repository
marketplace installs and direct source installs use those skills.

The optional `codex-submission` profile creates a separate directory-review
candidate. It changes two files in that candidate:

- `.codex-plugin/plugin.json`: description and listing copy address Codex users.
- `skills/stereofold-setup/SKILL.md`: onboarding starts with the installed Codex
  connection and directs advanced tasks to the full shared references.

Every runtime file, setup helper, skill reference, and other skill is copied
unchanged from the verified share. The original Codex and Claude exports remain
separate. `ARTIFACTS.json` records the profile inputs and each changed file's
before/after hash.

To produce the candidate alongside the normal exports, add
`--codex-submission` to `scripts/package-submissions.py`. See
[release instructions](../../docs/release.md#export-submission-packages).
The candidate retains the local MCP server and needs the applicable OpenAI
review route. Packaging validation does not establish directory approval.
