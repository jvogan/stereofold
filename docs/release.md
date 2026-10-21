# Release artifact

Create and verify the distributable plugin directory from the workspace root:

```sh
pnpm --filter stereo-structure release
```

Building and staging requires Node.js 22.13 or newer, pnpm 11.19.0, and Python 3.
Install the workspace dependencies first with `pnpm install --frozen-lockfile`
from the repository root. The
bundled MCP server itself requires only Node.js 22 or newer and has no installed
npm dependencies at runtime. The staging helper uses macOS `renameatx_np` or
Linux `renameat2` for an exclusive descriptor-relative rename and fails closed
on other build platforms; the already-staged artifact has no Python dependency.

The command first refreshes the Git-eligible runtime bundles and companions,
`plugin/dist/server.mjs`, `plugin/dist/viewer.html`, `plugin/dist/inspector.html`,
`plugin/dist/inspector.css`, `plugin/dist/inspector-script-1.js`,
`plugin/dist/inspector-script-2.js`, and `plugin/dist/inspector-host.js`, the stock Mol* viewer assets under
`plugin/dist/molstar/`, and generated `plugin/THIRD_PARTY_NOTICES.md`. Then
`plugin/scripts/release.ts` stages the distribution directory:

```text
plugin/release/stereofold/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── .mcp.json
├── LICENSE
├── README.md
├── QUICKSTART.md
├── INSPECTOR.md
├── THIRD_PARTY_NOTICES.md
├── assets/
├── claude-code/skills/stereofold-quest/SKILL.md
├── codex/INSTALL.md
├── demos/
├── dist/server.mjs
├── dist/viewer.html
├── dist/inspector.html
├── dist/inspector.css
├── dist/inspector-script-1.js
├── dist/inspector-script-2.js
├── dist/inspector-host.js
├── dist/scene-socket-relay.mjs
├── dist/headset-host.mjs
├── dist/serve-inspection.mjs
├── dist/molstar/molstar.js
├── dist/molstar/molstar.css
├── dist/molstar/LICENSE
├── native/applespeech/
├── skills/stereo-structure/SKILL.md
├── skills/molecular-presentation/
└── skills/stereofold-setup/
```

## Git eligibility and release layout

Relative to `plugin/`, keep `dist/server.mjs`, `dist/viewer.html`,
`dist/inspector.html`, `dist/inspector.css`, `dist/inspector-script-1.js`,
`dist/inspector-script-2.js`, and `dist/inspector-host.js` eligible for Git; check that
none is hidden by a parent ignore rule before release.

The runtime bundles and companions are intentionally Git-eligible even though the
workspace ignores other `dist/` directories. That makes the repository's
`plugin/` path directly runnable after a fresh clone. `stereo_structure.open_inspector`
requires `dist/inspector-host.js` to host the inspector panel in a local browser.
`dist/build-inputs.json` is Git-eligible too. It records the hash of the sources
the bundles were built from. A clone writes `plugin/src` after `plugin/dist`,
so without it the doctor would judge by modification time and call a fresh
clone's bundles stale.
The stock Mol* JavaScript, stylesheet, and license under `dist/molstar/` ship
with the complete `dist/` tree for the detailed viewer. Setup and presentation
skills carry their scripts and assets within their respective directories.
The repository ignores the release directory because it is deterministic
generated output. To distribute it, archive or copy the complete
`plugin/release/stereofold/` directory; do not select individual files.
When replacing an existing staged artifact, the release helper renames the old
directory to a hidden `.stereofold-backup-*` sibling. It deliberately retains
that recovery copy instead of recursively deleting through a mutable pathname;
the hidden sibling is ignored and is not part of the artifact to distribute.
Descriptor-relative copying, no-follow opens, source/target identity checks,
and exclusive renames prevent path redirection and reject ordinary concurrent
changes. They do not stop a malicious process that runs as the same user, so
the repository and its `plugin/release` parent must be trusted.
The helper hashes and records the complete selected source tree before copying,
then requires an identical source re-snapshot and an exact staged
path/type/mode/file-size/content-hash match before the swap. A concurrent build
therefore fails without replacing the current release instead of publishing a
mixture of build generations.

## Repository fresh-install requirements

For a source delivery:

Every delivery must name
an accessible repository URL and the exact tested tag or commit.
Always use the pinned package-manager version with a frozen
lockfile. Read the version from the root `package.json` and preserve
`pnpm-lock.yaml` when installing the workspace dependencies.

These are repository reproduction requirements. Recipients install the
complete share, verify its `SHA256SUMS`, and run the checks shipped inside
`skills/stereofold-setup/`; they do not need workspace dependencies.

## Compare the repository build with the mounted panel

The repository launcher and setup doctor print
`build · viewer <hash> · inspector <hash>` for the bundles they will serve.
To check the stereo viewer, call `stereo_structure.open`, then compare the
viewer hash with `diagnostics.viewerBuild` from `stereo_structure.get_state`
after that panel has mounted. `get_inspection_state` reports the inspector's
saved scene and panel readiness; it does not return this build diagnostic. A
successful copy or server launch alone does not prove that the panel is
current.
If the values differ, refresh the host's complete installation and open a
fresh panel before continuing. The same check is recorded in
[the Claude Code kit](../harness/kits/claude-code.md).

The recipient equivalent compares `diagnostics.viewerBuild` with the
`viewer:` identity in the delivered `SHARE.md`, as the shipped Claude Code
skill describes. Repository launcher commands are not part of the share.

## Automated gate

The release command performs these checks after staging:

- every manifest path resolves inside the artifact;
- the selected source tree stays identical throughout staging and the staged
  bytes match its initial snapshot;
- the MIT project license, generated third-party notices, icon, logo, skills,
  all runtime bundles and companions and the stock Mol* viewer assets are present;
- notices identify the MCP SDKs, Mol*, Zod, and every transitive package that
  esbuild reports in the JavaScript runtime bundles, using their installed package
  metadata and full license/notice files;
- development sources, tests, `package.json`, `node_modules` and symlinks are
  absent;
- `.mcp.json` launches `node ./dist/server.mjs` from the artifact root;
- the artifact is copied into a new operating-system temp directory;
- the copied server launches over stdio with `NODE_PATH` and `NODE_OPTIONS`
  cleared, lists the public opener and viewer resource, and serves the inline
  viewer without remote scripts or styles;
- a prospective fresh checkout is reconstructed from Git-eligible files and
  its Git-eligible `plugin/dist/server.mjs` is launched without `node_modules`.

To rerun only the gate on an already staged artifact:

```sh
pnpm --filter stereo-structure release:verify
```

The gate establishes self-contained packaging and MCP startup. It does not certify
installation in a real Codex or Claude Science host, host iframe policy,
WebGL2, glasses/display behavior, or human stereo perception. Follow
[host-verification.md](host-verification.md) for those checks.

The packages include the Stereofold icon and logo. The Claude directory icon
uses its default `.claude-plugin/icon.png` location. Both manifests carry the
MIT license and include the project homepage
(`https://jvogan.github.io/stereofold/`) and repository URLs. The Codex listing
also includes the public HTTPS support, privacy, and terms pages. Verify these
destinations before submitting a release.

## Export submission packages

After [creating the checksummed marketplace share](install.md#make-and-install-a-local-share),
export the four submission layouts from the repository root. Choose an output
directory that does not exist; its parent must already exist.

```sh
python3 plugin/scripts/package-submissions.py \
  --share /absolute/path/to/marketplace \
  --out /absolute/path/to/submission-packages
```

The command verifies the share's complete checksum inventory and any adjacent
marketplace archive checksum, rejects symlinks and development files, and
derives the package version and publisher metadata from the supplied manifests.
It writes `codex-plugin/`, `claude-plugin/`, `molecular-presentation/`, and
`codex-presentations-plugin/`, their four deterministic ZIP archives,
`ARTIFACTS.json`, and `SHA256SUMS`. Verify the exported files with
`shasum -a 256 -c SHA256SUMS` from the new output directory.

`codex-plugin/` and `stereofold-codex-plugin.zip` contain the complete verified
runtime unchanged: the local MCP server, all three Codex skills, both host
manifests, `.mcp.json`, viewer assets and licenses. The ZIP places the supported
`.codex-plugin/plugin.json` compatibility manifest at its root. The exporter
checks local manifest references and final listing text limits. This full
local plugin remains subject to the documented OpenAI review route for local
MCP and hardware access; creating its ZIP does not establish directory eligibility.

### Separate Codex submission candidate

To include the Codex-specific listing and installed-plugin onboarding, add
`--codex-submission` to the export command:

```sh
python3 plugin/scripts/package-submissions.py \
  --share /absolute/path/to/marketplace \
  --out /absolute/path/to/submission-packages \
  --codex-submission
```

This adds `codex-submission-plugin/` and `stereofold-codex-submission.zip`.
The original four exports stay unchanged. The candidate uses the same plugin
identity, version, all three skills, and complete local runtime. Exactly two
files differ from `codex-plugin/`: the Codex manifest's description fields and
the setup skill's `SKILL.md`. All helpers, references, and other skills remain
identical. The canonical repository skills keep their full cross-host setup.

The [profile](../plugin/distributions/README.md) is versioned separately from
the canonical skills. `ARTIFACTS.json` records its input hashes and the before
and after hashes for both changed files. These profile inputs come from the
checkout running the exporter; the runtime comes from the verified share.
Use one tested source commit for both when preparing a release. The candidate
still requires the applicable local MCP review and a new portal scan.

The Claude export keeps its Claude manifest and `.mcp.json`, and omits the
Codex listing manifest. Setup discovers either host's manifest. Both exports
retain the complete runtime and skills. The Claude directory README introduces installation and data handling;
the original runtime README is retained as `RUNTIME.md`. The portable skill
includes its planner, examples and licenses. The Codex presentation plugin
contains that skill without an MCP server and documents the separate viewer
needed for live rendering.

`ARTIFACTS.json` identifies the input checksum manifest and records the source
commit declared by the share. Exporting verifies the supplied bytes; it does
not independently establish that commit's Git contents. See
[submission.md](submission.md) for publication and directory submission steps.
