# Security

Stereofold runs a local MCP server. When you share a structure to a headset, it
also opens an HTTPS server on your private network. Report a problem in either
server, or in anything else in this repository, privately.

## Report a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of
this repository and choose **Report a vulnerability**. Do not open a public
issue for a security problem.

Include the version or commit, the host (Claude Code, Claude Science, the
Codex CLI, or the Codex app), and the steps that reproduce the problem.

## What the design trusts

- **Your network.** The headset share uses a self-signed certificate for
  your Mac's address, and the headset browser asks you to accept it. That
  warning cannot tell your Mac from another device on the same network, so
  pair only on a private network you trust. The terminal prints the
  certificate's fingerprint; if your headset browser shows the certificate,
  check that they match before you continue. A pairing code has eight digits
  and pairs one headset. Each address on the network gets six tries a minute,
  and 30 wrong guesses in total use the code up; launch again to get a new
  one.
- **Meta and Cloudflare, when you use them.** Meta's Web Launch page receives
  the one-time link it sends to your headset. The optional HTTPS relay runs
  through Cloudflare, which carries the structure and your edits, and anyone
  holding a relay link can open the share while it is valid. The link stops
  working when you stop sharing, when you move the share back to this Mac,
  or when its session ends. Use the private Wi-Fi route for unpublished
  structures.
- **Your agent host.** The server opens any local `.cif` or `.mmcif` file and
  fetches any HTTPS address the agent names, including addresses on your own
  network. Your host's approval prompts are the boundary; review requests you
  did not make.
- **Your account on this Mac.** Stereofold keeps its certificate key, its
  record of remembered headsets, headset pictures saved to the default
  folder, and the optional transcript file readable by your account only. It
  does not defend against software that already runs as you. While a headset
  has authorized this Mac for USB debugging, `adb` lets every account on the
  Mac drive the headset's browser, with or without Stereofold. Stereofold
  opens its own debugging connection only for the seconds a launch step or a
  browser read takes and removes it when the step ends. If adb refuses the
  removal, the result names the port and the command that closes it. The
  developer tools `plugin/scripts/headset-devtools.ts` and
  `plugin/scripts/headset-drive.ts`, and any `adb forward` you run yourself,
  leave a connection on port 9333 until you run
  `adb forward --remove tcp:9333`.
- **The files and lessons you open.** Names and text inside a structure file
  or a lesson are data. Mol\*'s own tools write names from a file into the
  page as HTML, so Stereofold rewrites every `<` before Mol\* parses a file
  in the inspector or the detailed view, and those pages refuse inline event
  handlers. A file with `<` in a chain, residue or atom name does not open
  in the inspector. The plain stereo viewer that `stereo_structure.open`
  shows mounts none of those Mol\* tools and writes no text from a file into
  its page as HTML, so it does not rewrite `<`. Your agent host sets that
  page's content security policy.

  A small file can declare far more work than its size suggests. Before
  Mol\* parses a file for the inspector, and before the server stores one for
  the stereo viewer, the server counts that work from the text and refuses a
  file past a bound:

  - mmCIF: 1,000,000 rows. The count is every declared sequence row times
    the chains of its entity times the models Mol\* will build, plus the
    other tables Mol\* reads again for each model.
  - PDB text: 1,000,000 rows (SEQRES residues times `MODEL` records),
    25,000,000 sequence-alignment cells, and 25,000,000 residue-name scan
    steps. A PDB file with one chain longer than about 5,000 residues
    exceeds the alignment bound; open its mmCIF file instead.
  - A composite recipe, inline or in a file: 25 sources.

  The inspector also bounds the copies an assembly makes. These bounds cover
  the costs measured in Mol\* 5.11; they do not prove that no file can stall
  it. A file just under a bound can still take seconds and more than a
  gigabyte of memory to convert, and a recipe's 25 sources, up to 64 MiB
  each, are held at once. Two routes are not counted: text you paste into
  the stereo viewer's own paste box goes to Mol\* in that tab as it is, and
  the stereo viewer does not bound an assembly with very many operators.
  Either can stall that tab.

  The optional voice bridge sends lesson text to its model marked as the
  author's data. A model can still be swayed by text it reads; the short
  list of scene tools it may call is what limits the effect. Open lessons
  and structure files from sources you trust.

## What a paired headset keeps

A headset that pairs is remembered. Its browser stores a device key, and
that headset joins later shares from this Mac without a new pairing code.
The key works for up to 30 days after pairing and expires after 14 days
without use (`questDeviceIdleDays` in `~/.stereofold/config.json` changes the
14 days). Stopping a share disconnects the headset; it does not forget it.

Anyone who holds a remembered headset on your network can open your next
share. To see or remove remembered headsets, ask your agent to list them or
to forget one, or all of them (`manage_companion` with `status` or
`forget`). To pair by code every time, start the server with
`STEREOFOLD_LAN_REMEMBER=0`, or run
`pnpm --dir plugin run quest --no-remember` from the repository root.

## Pictures, speech and browser reads

- **Headset pictures.** `capture_headset_view` saves a still on this Mac.
  When the page cannot supply one, the default `auto` source captures the
  headset's whole display, which shows whatever the wearer sees, including
  the room in passthrough and any other open window. Ask for
  `source: "page"` to get the Stereofold frame only. Review a picture before
  you share it.
- **Speech.** Controller push-to-talk is transcribed on this Mac, and the
  words go to your agent. The server's log records only how long each
  transcript is, unless you set `STEREOFOLD_PTT_DEBUG_TRANSCRIPTS=1`.
  `STEREOFOLD_PTT_TRANSCRIPTS` names a file that receives every transcript;
  Stereofold writes it only if it is a regular file that you own. In Quest
  Browser the headset page asks for the microphone when you press
  **Enter VR**, because Quest Browser cannot show that prompt inside VR. It
  skips the request once this Mac reports that no voice route will use the
  microphone, and asks until that report reaches the page. A voice route is
  controller push-to-talk, or the in-headset **Talk** row once its OAuth
  helper is set up. Safari on Vision Pro is not asked at Enter VR.
  `--no-ptt` turns the headset microphone off for the share: this
  Mac reports no voice route, and neither the **A** or **X** button, the
  **Talk** row nor the detailed view's **Hold to talk** records or
  transcribes speech.
- **Browser reads.** `read_headset_browser` returns the headset page's state
  and console text to your agent. With no tab named, it reads only a tab on
  an address this Mac is serving to a headset at that moment. While a Wi-Fi
  share is open it also looks at the browser's own error pages for the
  share's certificate warning, and it can mistake another site's error page
  for that warning when the page does not say which host it refused. It
  redacts pairing codes, page keys, tokens and credentials written into
  URLs; it does not remove other personal information a page may have
  logged.

[What reaches the network](docs/install.md#what-reaches-the-network) lists
every outside host Stereofold contacts and the caches it writes.

## Scope

In scope:

- the MCP server in `plugin/`
- the LAN companion server and its pairing
- the panels it serves

Out of scope:

- the Mol\* library itself (report those upstream to
  [molstar/molstar](https://github.com/molstar/molstar))
- Meta Quest Browser
- the agent hosts
