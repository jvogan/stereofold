# Try Stereofold with your own computer and Quest

The repository includes a standalone local host for the packaged Stereofold
inspector, so you can use it without an agent host. It uses the same viewer,
session server, tours and command receipts as the plugin.

Install Node.js 22.13 or newer and pnpm 11.19.0. OpenSSL creates the local HTTPS certificate.

Clone the repository and build it:

```sh
git clone https://github.com/jvogan/stereofold.git
cd stereofold
pnpm install --frozen-lockfile
pnpm run build
pnpm --dir plugin start 1CRN
```

For local coordinates, replace `1CRN` with an absolute `.cif` or `.mmcif` path.
With a local file, nothing is downloaded from the PDB.

Open the printed localhost address on the computer. Wait for the structure to
save and choose **Open on Quest** under **More** in the header. On the same
reachable Wi-Fi, open the shown
private HTTPS address in Quest Browser, accept the development certificate for
that exact address, and bookmark the pairing page before entering the code
shown on the Mac. Save the base address, without `/viewer` or a `#` fragment,
so the bookmark still opens pairing next time. After pairing, tap **Enter VR**
for passthrough. **More options** offers **Enter plain VR**, the opaque room.
In the floating menu, press `Tour` to play the tour, or `Menu` then `Tours` to
choose one. XR starts only when the wearer taps **Enter VR**.

Keep the process running. Ctrl-C closes the session and private listener.
Sharing expires after thirty minutes; the code expires after ten minutes and
can be used once. **Quest connection** lets you disconnect paired devices,
restart sharing with a new code, or stop sharing. The bookmark remains useful
while the Mac's IP address and port remain the same. Developer Mode, a
developer organization, sideloading, USB debugging and a public tunnel are
unnecessary. No certificate authority is installed on either device.

Under **More options**, the companion's **Connection diagnostics** reports secure-context status,
AR/VR availability, Mol* version and rendered scene revision. Desktop browser
acceptance with an isolated certificate exception does not prove that Quest
accepts the certificate or enters XR; confirm those in the headset.

If the saved session expires, reloading the desktop page opens a fresh
inspection from the original PDB ID or local file. This starts a new view;
expired appearance edits are not recovered. Live sessions are reused. The
private control file is updated atomically when a new session is created.
Restart the standalone process after rebuilding to load the updated runtime.

## Check setup before a session

From the repository root, run:

```sh
pnpm --dir plugin run doctor
```

This read-only check reports runtime prerequisites, missing or older build
files, assigned private LAN addresses, and whether the sharing port is already
listening. It does not open a connection or change network settings. Follow the
reported action, then start the inspector. An occupied port can belong to an
existing session; use that session or choose a different port in **Open on Quest**.

For a machine-readable report, add `--json`. To check an explicitly chosen
standalone control file, add `--control-file /absolute/private-state.json`.
The report omits its credentials and contents. These checks do not establish
that the Quest can reach the Mac, trust the certificate, or enter XR.

When returning later, keep the desktop inspection open, choose **Quest
connection**, and use **Restart sharing / new code** if sharing or pairing has
expired. Reopen the bookmarked address and pair again. A bookmark remembers
the address; it does not renew an expired session. If the Mac changed Wi-Fi,
use the newly displayed address.

## Agent control

An MCP host uses `stereo_structure.get_inspection_state` to locate the intended
current, ready companion panel. `stereo_structure.control_tour` accepts start
(with a catalog tour ID), next, back, play, pause and menu. Supply fresh binding
revisions and a unique command ID, then check the receipt: only `rendered`
confirms the scene was drawn and saved. Tour progress belongs to the targeted
panel; a newly opened headset does not automatically start the desktop's tour.

For a standalone host, optionally supply an absolute private state-file path
after the PDB ID. The host writes a mode-0600 loopback control capability there.
`scripts/inspection-agent.ts` can use it for the same session-bound commands.
Never share this file or commit it to a repository.

### One command at a time

```sh
pnpm --dir plugin run agent /absolute/private-state.json update_inspection \
  '{"change":{"kind":"appearance","patch":{"representation":"ball-and-stick"}}}' --wait
```

`serverEpoch`, `sourceToken`, the two base revisions, the target panel and a
fresh `commandId` are read from `get_inspection_state` and filled in, for every
tool that needs them. For `manage_inspection_view`, the required fields depend on
`action`: `save` and `restore` need a panel and a command ID, `delete` needs the listed `viewRevision` and no panel, `list` needs
neither. A value you supply is used unchanged, so a deliberately stale revision
still fails the way it should.

- `--wait` follows the command receipt to a terminal status and prints
  `Applied` only for `rendered`. A call that replaced the source returns no
  receipt, so there it follows the panels instead and names the new source,
  model and assembly once one of them has drawn and saved it. Past sixty
  seconds it says no panel has saved it and names what each panel is doing.
- `--panel desktop|companion|detailed` targets a surface rather than a panel
  ID. Without it, the command targets the panel the wearer is looking through. Use it for
  `manage_inspection_view` with `action: "return-to-desktop"`, which the server
  refuses on anything but a desktop panel.
- `--utterance begin|correct|cancel` records the utterance before the call it
  wraps and threads the returned `utteranceId` into it, so a correction reaches
  the queue ahead of its replacement. It prints how many pending commands the
  correction dropped; none of them is a change that already rendered.
- `--json` prints the whole response instead of the host's own sentences.

### A whole conversation

```sh
pnpm --dir plugin run converse /absolute/private-state.json
```

This is the loop to run with someone in the headset. It long-polls
`listen_voice` and prints one JSON line per utterance, carrying `utteranceId`,
`sequence`, the words, the `referent` the host captured, and the scene as it
stood when they spoke:

```json
{"type":"voice","utteranceId":"…","sequence":4,"text":"show me the guide RNA","referent":{…},"scene":{…}}
```

Commands go back on stdin, one JSON object per line. `tool` and `args` are the
call; `panel`, `utterance` and `wait` are the flags above under other names;
`id` is echoed back so an answer can be matched to what was sent.

```json
{"tool":"emphasize","args":{"parts":["guide RNA"]},"utterance":"correct"}
```

Each command answers with one `result` line, and `rendered: true` on it is the
only field in the stream that means the wearer saw the change. A refusal
arrives as an `error` line carrying the host's own sentence, and the loop keeps
listening. The loop contains no language model: you or your agent read a
`voice` line, act, then answer with `say_to_headset` passing that `utteranceId`. Ctrl-C prints
`{"type":"stopped"}` and ends it.

Keep the same `utteranceId` when one request needs several edits. After each
rendered receipt, use the current revisions for its next command. A source
replacement accepts that ID too: wait for the selected panel's source render
receipt, then use its new panel and source binding for styling or selection.
Cancellation and correction discard unfinished replace/compare loads, including
loads already fetching coordinates. If the source has committed while the panel
is still loading it, cancellation prevents follow-up edits without undoing the
source; a correction takes over after that panel renders and attaches.
An unrelated manual change still invalidates
the request; it is never silently rebound to a different scene.

Desktop HTTPS rendering and command receipts can be tested without a headset.
They do not establish physical Quest performance, controller usability or
immersive readability; those require a wearer acceptance test.
