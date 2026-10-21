# Stereofold Codex install notes

This file is the Codex-specific install detail for the Codex CLI and the Codex
desktop app. To install the plugin and put a structure on a headset, start
with [QUICKSTART.md](../QUICKSTART.md). The Codex manifest,
`.codex-plugin/plugin.json`, and `.mcp.json` sit at the plugin root because
Codex reads them there.

Codex installs Stereofold from a marketplace, in one of two layouts. The
repository on GitHub is the marketplace `stereofold`, and its plugin directory
is `plugin`. A share generated for another machine is the marketplace
`stereofold-local`, and its plugin directory is `plugins/stereofold/`. Either
way the install needs Node.js 22 or newer and no build: the runtime bundles in
`dist/` ship with the plugin. Replace every `/absolute/path/to/...` example with
the actual location on your machine.

The Codex CLI and the Codex app can use the same Codex profile. Run the commands
with the profile the app uses; an explicit `CODEX_HOME` selects another profile.
If your shell has no `codex` command, install the Codex CLI or add the existing
CLI executable to your shell's path.

## Install from GitHub

```sh
codex plugin marketplace add https://github.com/jvogan/stereofold
codex plugin add stereofold@stereofold
```

The first command registers the repository as the `stereofold` marketplace. The
second installs the plugin into the Codex profile that `CODEX_HOME` selects.

## Run the source runtime directly

For a repository checkout, register its committed server without installing a
plugin package:

```sh
codex mcp add stereo_structure -- \
  /absolute/path/to/node /absolute/path/to/stereofold/dist/server.mjs
```

Use absolute paths and the profile your Codex host uses. Keep existing entries
and avoid a second registration when a plugin already provides this server.
Reload the connection or start a new conversation, then check `codex mcp list`
and the advertised tools. Here the Stereofold path is the plugin root, which is
`plugin/` in a source clone. The repository's agent instructions point to the
canonical skills. For another project, copy the needed complete skill folders from
`skills/` into `.agents/skills/`, or use your configured personal skill
directory. Preserve scripts, assets and references. A copied setup check uses
`--root /absolute/path/to/stereofold` to find the runtime.

## Install a generated share

Use this route only when you were given a share directory or its
`stereofold-marketplace.tar.gz` archive instead of the repository. The share
root contains `.agents/plugins/marketplace.json` and `plugins/stereofold/`.

1. If you have the archive, extract it into a new share directory:

   ```sh
   mkdir /absolute/path/to/stereofold-share
   tar -xzf /absolute/path/to/stereofold-marketplace.tar.gz -C /absolute/path/to/stereofold-share
   ```

2. Verify the share, register it as a local Codex marketplace, and add the
   plugin:

   ```sh
   cd /absolute/path/to/stereofold-share
   shasum -a 256 -c SHA256SUMS
   codex plugin marketplace add /absolute/path/to/stereofold-share
   codex plugin marketplace list --json
   codex plugin add stereofold@stereofold-local
   ```

   On Linux use `sha256sum -c SHA256SUMS`. Keep the complete share together,
   and do not write into a Codex cache by hand. Install the complete release so
   `dist/server.mjs`, `dist/viewer.html`, `dist/inspector.html`,
   `dist/inspector.css`, `dist/inspector-script-1.js`,
`dist/inspector-script-2.js`, and `dist/inspector-host.js` come from the same build; mixing them leaves a stale
   inspection panel behind a current server.

## After installing

`codex plugin add` enables the plugin. Start a new conversation so its tools
come from the installed build. If the app still shows old tools, reload its
plugin connection or reopen the app, then check the advertised build again.

Where the structure renders depends on the Codex surface. The inspector panel
is an MCP Apps `ui://` resource. The Codex app renders it as a card in the
conversation on hosts that support that resource. Verify the embedded card in your actual connection. Browser fallback and USB
Quest checks establish those routes separately. The
Codex CLI renders no panel in the terminal: ask for the structure "and open it
in my browser", and the agent calls `open_inspector`, which opens the inspector
in a browser tab on this Mac. For the headset, `open_companion` opens that tab
itself when no scene is saved yet. Leave the tab open, because it does the
rendering. Check the current companion panel and its rendered receipts in
your actual CLI connection before reporting that an edit is visible there.

To confirm the install, run `codex mcp list` and check that it shows
`stereo_structure` enabled. Then, in the installed plugin directory, run:

```sh
node skills/stereofold-setup/scripts/open-check.mjs
```

It starts the same `dist/server.mjs` on bare `node`, prints the advertised tool
count, confirms `stereo_structure.open`, opens the bundled fixture and prints
`OPEN PASS`.

In a new conversation, the legacy stereo-viewer tools are registered as
`stereo_structure.open`, `stereo_structure.control`,
`stereo_structure.get_state`, `stereo_structure.set_mode`, and
`stereo_structure.set_motion`. Codex session
logs name them `mcp__stereo_structure__stereo_structure_<verb>`; a Claude Code
plugin install names them
`mcp__plugin_stereofold_stereo_structure__stereo_structure_<verb>`. These are
five of the plugin's 68 registered tools, 41 of them model-visible; see
[README.md](../README.md) for the full list, including the focused inspector's
`inspect`, `inspect_file`, `inspect_scene`, and `inspect_lesson`. Discover tool availability from the live connection.

Another structure-viewer plugin, such as Codex's Molecular Structure Viewer, can
stay installed. The marketplace commands above are Codex's own installer; the
repository's check for overlapping MCP server IDs runs only in a separate
maintainer installer. In a new conversation, identify Stereofold by its
`stereo_structure` tool namespace, and do not infer which plugin owns a panel
from its title.

## Install only the lesson skill

For file-only lesson planning, copy the repository's entire
[molecular-presentation folder](../skills/molecular-presentation) to the skills directory for your
Codex profile, commonly `~/.codex/skills/`. Preserve the entire folder. Restart skill discovery or start a new conversation.
This route uses Node 22 and needs no Stereofold MCP server. Live desktop chapters
use the separate standard Molecular Structure Viewer; headset playback uses the
full Stereofold runtime, registered directly or installed as a plugin. Read the
installed skill's workflow before choosing a route.
