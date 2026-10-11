# Host registration


Each host registers a local server its own way. Use the current conversation
and the user’s requested host first, then the `host markers` and `host profiles`
from the setup check. Inherited terminal variables may name another host; they are
clues, not a reason to stop a known setup. Ask which host to configure only
when the current conversation and available facts leave that choice unclear.

Prefer the host’s additive plugin or MCP registration command. Preserve every
existing configuration entry. For manual server registration use absolute paths
to Node and `dist/server.mjs`; the host’s launch directory may vary. Reload or
reconnect when needed to load the registration. A host without a panel can
continue through the browser inspector or terminal headset host.

If the setup check refuses to update an invalid existing config, back up and
repair that file, or select a new absolute `STEREOFOLD_CONFIG` path. Preserve
the existing file rather than overwriting it with discovered defaults.

### Codex

For direct source use, register the shipped stdio server with absolute paths:

```sh
codex mcp add stereo_structure -- \
  /absolute/path/to/node /absolute/path/to/stereofold/dist/server.mjs
```

Here `stereofold` is the plugin root, `plugin/` in a checkout. Read the
canonical skills there, or copy needed complete skill folders into the
project's `.agents/skills/` or configured personal skill directory. A copied
setup check needs `--root` pointing to this runtime. Preserve other MCP entries
and skills, then reload the connection or start a new conversation.

For a packaged plugin, use its marketplace descriptor. From GitHub:

```sh
codex plugin marketplace add https://github.com/jvogan/stereofold
codex plugin add stereofold@stereofold
```

A delivered share is a local marketplace named `stereofold-local`. It needs the
complete extracted share, with `.agents/plugins/marketplace.json` beside
`plugins/stereofold/`; a bare plugin directory is insufficient. If the
marketplace descriptor is missing, re-extract `stereofold-marketplace.tar.gz`
and verify `SHA256SUMS`.

For a delivered share directory, verify and register its root:

```sh
cd /absolute/path/to/stereofold-share
shasum -a 256 -c SHA256SUMS          # sha256sum -c SHA256SUMS on Linux
codex plugin marketplace add /absolute/path/to/stereofold-share
codex plugin marketplace list --json
codex plugin add stereofold@stereofold-local
```

For a delivered archive, extract the complete marketplace root first, then run
the same verification and registration sequence:

```sh
mkdir /absolute/path/to/stereofold-share
tar -xzf /absolute/path/to/stereofold-marketplace.tar.gz -C /absolute/path/to/stereofold-share
cd /absolute/path/to/stereofold-share
shasum -a 256 -c SHA256SUMS          # sha256sum -c SHA256SUMS on Linux
codex plugin marketplace add /absolute/path/to/stereofold-share
codex plugin marketplace list --json
codex plugin add stereofold@stereofold-local
```

The Codex CLI and app can use the same profile. Install with the profile the
app uses; an explicit `CODEX_HOME` selects another profile. If `codex` is
unavailable in the shell, locate the installed CLI or install it through the
user's chosen distribution.
After installing, use a fresh conversation to load the updated tools. If the
Codex app still reports an older build, reload its plugin connection or restart
the app when convenient. Continue setup checks against the discovered runtime
while arranging that reload.

`codex/INSTALL.md` in the plugin root carries the Codex installation steps. Do
not copy files into a Codex plugin cache by hand. If a share's marketplace root
is missing, ask for the complete share directory or archive. The shipped open
check in the skill entrypoint can still verify a bare plugin's server.

### Claude Science

In Claude Science, use **Settings** > **Connectors** > **Add connector** >
**Local command**. Select the absolute Node executable, add the absolute
`dist/server.mjs` path as an argument, and use advanced settings for environment
variables. Add the skills through **Settings** > **Skills** > **Add skill**,
using **Upload a skill** or **Import from GitHub**. Keep each skill folder and
its bundled references, scripts, and assets together.

For versions using local connector configuration files, add one object to the
`servers` array in `~/.claude-science/mcp/local-mcp.json`, preserving existing entries. Here `/absolute/path/to/stereofold` is the plugin root: the
`plugin` directory of a clone, or `plugins/stereofold` in a share. Replace
`/absolute/path/to/home` with the user's home directory.

```json
{
  "name": "stereofold",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/stereofold/dist/server.mjs"],
  "env": {
    "STEREOFOLD_SCENE_SERVICE": "/absolute/path/to/home/.stereofold/scene-service.json",
    "STEREOFOLD_SCENE_SOCKET": "/absolute/path/to/home/.stereofold/scene-service.sock"
  }
}
```

The two scene entries let `continue_session` join the scene of a headset host
started in a terminal. Use this bridge when the connector sandbox blocks local network
access or cannot render a browser panel. Its daemon runs with a stripped
PATH and has no window of its own, so every optional helper it should reach
has to be named by absolute path in `env`. Read [Voice and helper configuration](voice.md) for optional helper overrides.

For requested Claude Science setup, grant the connector read access to the plugin root using the installed app's
permission controls. The sandbox also needs read and Unix-socket access to the
`.stereofold` folder: in `~/.claude-science/config.toml`, add its absolute path
to `[sandbox] user_read_paths` and to `[sandbox.network] allow_unix_sockets`,
keeping the paths already in both lists. Then restart Claude Science and reconnect the connector so the daemon reads
the changed configuration. For a headset, the user runs
`node /absolute/path/to/stereofold/dist/headset-host.mjs 4HHB` in a terminal
(add `--vision-pro` for Vision Pro), pairs the headset as it directs, and then
asks Claude Science to join the Stereofold scene. If Claude Science mounts an inspector card, verify its saved scene normally.
Otherwise continue through the terminal host and shared-scene bridge; missing
embedded-card behavior does not prevent the headset workflow.

For requested capture or transcript delivery into a sandbox, set
`STEREOFOLD_BRIDGE_DIR` to an absolute directory writable by the producing
headset/transcription host and readable by the consuming host. Grant access to
that directory using the requested host's permission settings, preserving
other configuration. Captures report the bridge file, media type, source and
SHA-256, or a bridge error; configured transcript delivery writes public voice
fields. The directory provides file delivery alongside the scene/socket bridge.

### Claude Code

Claude Code installs the plugin from a `.claude-plugin/marketplace.json`
descriptor. The manifest at `.claude-plugin/plugin.json` starts the shipped
`dist/server.mjs` as the `stereo_structure` server, reads `skills/`, and adds
`claude-code/skills/stereofold-quest`, the headset route for this host. From
GitHub:

```sh
claude plugin marketplace add jvogan/stereofold
claude plugin install stereofold@stereofold
```

From a delivered share, whose marketplace is named `stereofold-local`:

```sh
claude plugin marketplace add /absolute/path/to/stereofold-share
claude plugin install stereofold@stereofold-local
```

`claude plugin list` shows the install. Tell the user to start a new Claude
Code session so it loads the plugin. A source checkout or bare runtime can also
be registered directly, with absolute paths, under
the server name `stereo_structure` so its tools carry the same
`mcp__stereo_structure__` prefix that the `stereofold-quest` skill expects for
a hand registration:

```sh
claude mcp add stereo_structure --scope user -- \
  /absolute/path/to/node /absolute/path/to/stereofold/dist/server.mjs
```

`claude mcp list` shows that registration and `claude mcp remove
stereo_structure --scope user` removes it. Do not do both: the plugin and the
hand registration start two copies of one server, and no later result says
which one answered.

Read the source skill entrypoints directly, or copy their complete folders into
the project's `.claude/skills/` or configured personal skill directory. Include
stereofold-setup and stereo-structure for runtime work; molecular-presentation
adds lesson authoring. Copied setup checks need `--root` naming the runtime.

Run that command from somewhere other than the artifact directory. Claude Code
offers any `.mcp.json` in the working directory as a project server, and the
artifact ships one, for Codex, that names the same server again as
`stereo_structure` with the relative `./dist/server.mjs` Codex launches it with.
Started from inside the artifact you therefore get two entries for one server,
and no later result says which of them answered.

Tell the user how the panel gets rendered. Terminal Claude Code and the Codex
CLI mount no inspector panel, and only a rendered panel saves a scene. With no
saved scene, `open_companion` serves that panel from the server on loopback,
opens it in this Mac's browser, and waits for it to save the scene before it
shares, so `inspect` then `open_companion` puts a structure on the headset.
`open_inspector` renders the same panel without sharing it, and
`continue_session` instead joins a scene another host on this Mac has saved. In
Claude Code the `stereofold-quest` skill carries the steps; in the Codex CLI
the `stereo-structure` skill does.
