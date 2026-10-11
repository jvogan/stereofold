# Voice corpus runner

Plays the forty cases in [`../../fixtures/voice-cases.json`](../../fixtures/voice-cases.json)
against a Stereofold host and records what the host actually did.

## Read this before reading any output

**These runs are injected transcripts.** The words are read out of the corpus file and
handed to the host at the seam where a recognizer would hand over a string. Nothing here
uses a microphone, a wearer, or a headset.

A clean run shows only that the command path, given these exact sentences, resolves the
right residues, asks instead of guessing where the corpus marks a request as ambiguous,
refuses what it should refuse, and never reports a change it did not render. It does not
show whether a Quest 2 microphone would have produced those sentences, or whether the
wearer heard the reply.

Voice qualification needs real speech from a wearer. Every case
keeps `status: "not_run"` in the corpus file until that test runs, and `--update-corpus` writes its result into a separate
`injectedTranscriptRun` field that never touches `status`.

## Running it

In process, the route the regression test uses:

```sh
pnpm --dir plugin exec tsx scripts/voice-corpus.ts [--only V01,V02] [--update-corpus]
```

Against a standalone host that is already running:

```sh
node lab/voice-corpus/runner.mjs --state ~/.stereofold/quest-share.json
```

A live host has a real recognizer, and the runner could inject a transcript there only
through the headset page in a browser, which it does not open. On that route the runner
allocates the utterance the way a typed request does and records
`route: "text-utterance"`, meaning no speech step ran. Cases that need a controllable clock (V19) or that switch the
recognizer off (V30) are reported as environment-blocked there rather than faked.

The runner writes `results.json` and `SUMMARY.md` to `runs/<timestamp>/`.

## The pieces

| File | What it is |
| --- | --- |
| `runner.mjs` | The engine: injection, dispatch, outcome classification, the run record. |
| `consumer.mjs` | The scripted consumer: a pattern table plus target resolution against the host's loaded structure. It uses no language model. |
| `cases.mjs` | Per-case staging and, for the fault cases, how the fault is created. |
| `session.mjs` | One inspection session driven the way a panel drives one, including the renderer that answers a delivery. |
| `live.mjs` | The loopback hop to a running standalone host. |
| `../../plugin/scripts/voice-corpus-host.ts` | The in-process host: the shipped server with the recognizer replaced. |
| `../../plugin/scripts/voice-corpus.ts` | The synthetic entry point. |
| `../../plugin/test/voice-corpus.test.ts` | The regression over V01–V10 and V21–V29. |

## Outcome classes

`intended`, `clarification` and `refusal` are the three the corpus allows. `wrong-target`,
`duplicate` and `false-completion` are the three it fixes at zero, and the runner derives
each from the host's own receipts and saved revisions rather than from anything the
consumer claims. Three more classes record cases outside those six:

- `needs-model` — no pattern in the consumer claims the utterance. A table not covering a
  sentence says nothing about the host, so this is not a failure and is not counted in the bar.
- `unsupported` — the consumer knew what was meant and the host has no command that
  expresses it. The host's own refusal is recorded verbatim.
- `environment-blocked` — nothing ran, because the case needs a condition only the real
  host and a real room can create.

The bar is computed over scripted cases only, and the summary prints the corpus's own
38/40 bar beside it with a note that this run does not supply it.
