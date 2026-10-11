# Stereo Structure host-emulation harness

This package mounts the built `plugin/dist/viewer.html` as a synthetic MCP App host using Node, the official MCP client SDK, `@modelcontextprotocol/ext-apps` host helpers, and Playwright. It is a protocol and browser-capability harness; it is not a substitute for installing the plugin into Codex Desktop or Claude Science.

## Profiles

Each profile models one host surface: its panel size, its iframe sandbox flags, and the Content Security Policy the host applies to the app document. CSP domains are read from the mounted resource's `_meta.ui.csp` at runtime; the harness does not copy plugin domains into a profile.

### Panel size

The harness sizes the host iframe explicitly. Without that the iframe falls back to the HTML default of 300x150 CSS px, and every screenshot is a 304x155 thumbnail of a viewer that never had room to lay out.

| Profile | Panel (CSS px) | Width evidence | Height evidence |
| --- | --- | --- | --- |
| `codex` | 800 x 560 | Codex inline card observed at about 600-800 px; upper bound taken. Not documented by the host. | The `openai/widgetHeightHint` of 560 that OpenAI's structure-viewer plugin declares. |
| `claude-science` | 800 x 640 | Claude Science inline card observed at about 600-800 px; upper bound taken. Not documented by the host. | No host height is documented. Uses a fallback of 640 px. |

Every run is repeated at `deviceScaleFactor` 1 and 2. Screenshots from the second pass carry an `@2x` suffix.

### Codex

A direct app iframe with `allow-scripts allow-forms allow-same-origin`. The harness reads the plugin's `_meta.ui.csp` from `resources/read` (falling back to tool metadata if necessary) before it starts the local host page.

The CSP the harness applies is assembled from that declaration using the rule observed in the Codex desktop app:

- Codex builds the sandbox descriptor as `{ baseUriDomains: [], connectDomains: [...connect, ...resource], frameDomains: [], includeDefaultDomains: false, isTrusted: true, resourceDomains }`. `includeDefaultDomains: false` means the built-in CDN list is not added, and `connectDomains` absorbs `resourceDomains`.
- Codex assembles this CSP template from that domain list: `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' <domains>; style-src 'unsafe-inline' <domains>; img-src <domains>; font-src <domains>; media-src <domains>; worker-src blob:; connect-src <connect domains>; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. There is no `'self'`: the sandbox document is injected HTML on an opaque origin, so every script it runs is inline. `connect-src` receives the union of declared `connectDomains` and `resourceDomains`; default domains are not added.

Use a real Codex connection to check its current iframe and CSP behavior.

### Claude Science

The documented local-proxy path: host page, `/proxy`, inner `srcdoc` iframe. The inner frame receives exactly `allow-scripts allow-forms`, deliberately omitting `allow-same-origin`. The harness reads `_meta.ui.permissions` and passes those requests to the iframe `allow` attribute; ext-apps 1.7.5 defines no resource-metadata `sandbox` field, so permissions do not add speculative sandbox tokens. Evidence: observations of the host and the installed `@modelcontextprotocol/ext-apps@1.7.5` `McpUiResourceMeta` type.

Both the proxy document and the inner frame carry the single policy the host applies. An `srcdoc` child inherits its parent's CSP and enforces the intersection, so a separate, stricter proxy policy would silently clamp the app frame.

Check the current Claude Science connection separately; host versions may change its sandbox.

No camera permission is requested. The fixture is synthetic PDB text, so the harness does not call RCSB and does not write credentials or private data.

## Run

The harness is a pnpm workspace of its own, with its own lockfile, outside the repository's workspace. Run pnpm from this directory without `--ignore-workspace`: that flag skips `harness/pnpm-workspace.yaml`, which approves esbuild's install script, and `pnpm install` then stops with `ERR_PNPM_IGNORED_BUILDS`.

```sh
pnpm install
pnpm test
pnpm exec tsc --noEmit
pnpm build
STEREO_PLAYWRIGHT_BROWSER=/absolute/path/to/chrome pnpm run harness
```

If a Playwright browser is needed, keep its download outside user application state:

```sh
export PLAYWRIGHT_BROWSERS_PATH="$(mktemp -d "${TMPDIR:-/tmp}/stereo-harness-playwright-browsers.XXXXXX")"
pnpm exec playwright install chromium --no-shell
stereo_browser_path="$(pnpm exec node --input-type=module -e 'import { chromium } from "playwright"; process.stdout.write(chromium.executablePath())')"
STEREO_PLAYWRIGHT_BROWSER="$stereo_browser_path" pnpm run harness
```

Use `pnpm run harness:codex` or `pnpm run harness:claude-science` to select one profile, `--dpr 1` (or `pnpm run harness:dpr1`) to run a single device pixel ratio, and `pnpm run harness:json` to print one machine-readable object instead of the human lines. The default runs both profiles at both pixel ratios. The harness starts a loopback HTTP server on an ephemeral port and always closes it in `finally`; it does not leave a server running.

Screenshots are written to `harness/out/<profile>-<mode>.png` (and `-<mode>@2x.png`) and are ignored by `harness/.gitignore`. They are artifacts for inspection only. Their existence does not prove human stereoscopic perception.

## Output and exit code

Each profile writes `harness/out/<profile>.json` holding one entry per device pixel ratio: panel size and its evidence, the merged `_meta.ui` fields and their sources, the applied sandbox tokens plus the reason for each decision, mount, WebGL2 and mode-switch results, every distinct console error with an occurrence count and first source location, every CSP violation with directive, blocked URI, source file and line, the relayed tool-call log with per-call duration, per-phase timings, and per-mode screenshot measurements. The file also has same-shaped `pluginDefects` and `harnessDefects` arrays.

Every console error and CSP violation is classified in `src/classify.ts`:

- **harness** — the harness itself is wrong. Fails the run; fix it rather than carry it as a known defect.
- **profile-contract** — the emulated CSP or sandbox is stricter or looser than the host evidence. Fails unless the rule records an explicit cited decision.
- **plugin** — a defect in `plugin/`. A CSP violation reaches this category only when the plugin's own declared `_meta.ui.csp` does not cover the blocked scheme/origin. It does not fail the run and is printed under a `PLUGIN DEFECTS` heading with the `plugin/src` file and line.
- **unclassified** — nothing matched. Fails deliberately, so an unrecognized browser error is never a passing result.

Human output always has `SUMMARY`, `HARNESS DEFECTS`, and `PLUGIN DEFECTS` sections. Exit is 1 on mount, WebGL2, mode-switch or tool-relay failure, and on any failing classification. It is 0 when the only remaining problems are plugin defects.

Screenshot measurement (`src/png.ts`) decodes the PNG in Node and reports ink fraction, mean luma, the Pearson correlation between the left and right halves, and the horizontal shift at which the red channel best matches the green channel. These are numeric signatures of a split pair and of a channel-separated frame. They are not a claim about fusion, comfort, or chirality.

The harness stays outside the repository's workspace, so root `pnpm -r test` does not reach it. The root `pnpm test` runs this suite last, through `pnpm run test:harness`, after the workspace and lab suites. Install the harness first with `pnpm --dir harness install`.

## Checks and limits

- MCP `initialize`, `tools/list`, `resources/list`, and `resources/read` prove that the built server exposes the expected registration surface and returns the `text/html;profile=mcp-app` resource. They do not prove a desktop host mounts it.
- The `AppBridge`/`PostMessageTransport` path proves an emulated `ui/initialize` handshake, `ui/notifications/initialized`, host delivery of a `stereo_structure.open` result, and view-to-server `stereo_structure.set_mode` calls. It does not prove either real host forwards those messages identically.
- `mounted yes` means the resource executed in a frame, the bridge reached `CONNECTED`, and Mol* created a canvas. It is not a visual-quality or human-fusion assertion.
- `WebGL2 available yes` is a canvas context probe in the Playwright browser. It does not establish WebGL2 availability in Claude Science or Codex Desktop.
- `mode switch succeeded yes` means all four mode buttons became active in turn and the server received the corresponding calls. It does not certify pixel disparity, anaglyph luma, eye order, or perception.
- Console/CSP counts cover the Playwright page, proxy, and app frames for a completed run. A browser-start failure reports `unknown` for checks that could not execute. CSP violations are collected from both the parent relay and a direct read of every frame, then deduplicated, so one block is counted once.

Check panel mounting, file preview, tool visibility, WebGL2 and input in the host and device you use. [Host verification](../docs/host-verification.md) lists the steps. A wearer evaluates perceived depth and comfort.

## Registration kits

`kits/claude-science-local-mcp.json` is a copy/edit configuration example. The Markdown kits cover normal marketplace installs and optional source installs. The emulation harness writes only its output directory.

The `kits/install-*.sh` scripts derive this checkout from their own paths. Claude Code uses marketplace commands; Codex requires an explicit profile and can select a local marketplace root; the Claude Science script backs up and updates the local MCP file for versions that use it. For a normal install, follow the [root README](../README.md).
