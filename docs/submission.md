# Distribution and directory submission

Repository marketplace installs and curated directory listings are separate
routes. A public listing has its own eligibility, review and publication steps;
exporting a package or installing from this repository does not establish
directory approval. See [release](release.md) for package creation and
verification, and [install](install.md) for repository installs.

| Package | What it contains | Distribution route |
| --- | --- | --- |
| Full Stereofold plugin | Local MCP runtime, inspector, stereo viewer, headset companion and skills | Codex and Claude Code repository marketplaces; directory review is separate |
| Molecular presentation skill | Portable lesson planner and examples | Skill upload or GitHub import; live chapters need the separate Molecular Structure Viewer, and headset playback needs Stereofold |
| Stereofold Presentations plugin | The presentation skill packaged without an MCP server | Codex skills-only listing route, subject to current platform review |

The packages are generated from this source tree. Use the release guide to
choose the artifact that matches the intended host, then inspect its manifest,
files and checksum before sharing it. Keep the runtime version and the source
repository revision aligned in any reviewer materials.

## Codex

Users can install the full local plugin from the repository marketplace:

```sh
codex plugin marketplace add https://github.com/jvogan/stereofold
codex plugin add stereofold@stereofold
```

OpenAI documents repository marketplaces separately from its public directory.
Because Stereofold's full plugin runs a local MCP server and uses local files,
browser access and headset hardware, consult OpenAI's
[local execution guidance](https://developers.openai.com/plugins/guides/submit-claude-plugin)
for the directory review route. The full runtime package retains its MCP
configuration. The separate Presentations package has no MCP server and is
limited to lesson planning and compilation; live viewing requires its separately
installed viewer.

## Claude Code

Users can install from the public repository marketplace:

```sh
claude plugin marketplace add jvogan/stereofold
claude plugin install stereofold@stereofold
```

Anthropic's [plugin submission guide](https://claude.com/docs/plugins/submit)
describes its directory route. Check that guide and the
[pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist)
for current eligibility, package limits and portal requirements. The runtime
export keeps the installed plugin focused on the files it needs; use the release
verifier to inspect that artifact before choosing its repository folder and
tracked branch or tag.

## Before publishing

- Follow [release.md](release.md) to stage and verify the selected package, and
  [install.md](install.md) to verify the matching local installation route.
- Check the current host documentation for listing fields, accepted artifacts,
  reviewer materials and any required public website or policy URLs.
- Describe the workflow the reviewer can actually run. State the required host,
  browser, headset and optional services, and identify whether evidence comes
  from a real host, an emulation harness or a physical device.
- Keep scientific scope clear: Stereofold displays and edits structures; it does
  not perform structure prediction, molecular dynamics or binding-affinity
  calculations.

Directory acceptance, host behavior and physical-device support require their
own review or validation. Package checks and emulated host tests do not establish
those results; see [host verification](host-verification.md).
