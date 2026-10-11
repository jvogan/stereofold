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
  check that they match before you continue.
- **Meta and Cloudflare, when you use them.** Meta's Web Launch page receives
  the one-time link it sends to your headset. The optional HTTPS relay runs
  through Cloudflare, which carries the structure and your edits, and anyone
  holding a relay link can open the share while it is valid. Use the private
  Wi-Fi route for unpublished structures.
- **Your agent host.** The server opens any local `.cif` or `.mmcif` file and
  fetches any HTTPS address the agent names, including addresses on your own
  network. Your host's approval prompts are the boundary; review requests you
  did not make.

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
