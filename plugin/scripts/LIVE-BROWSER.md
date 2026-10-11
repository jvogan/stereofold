# Opt-in Live browser acceptance

This is a **paid API test**, separate from the configured OAuth narration route. It starts exactly one `gpt-live-1` WebSocket session with client delegation and no backend API model. It is never run by ordinary tests or startup. Each run bills the OpenAI account whose key it reads.

From `plugin/`, with existing compiled `dist` and no competing GPU browser test:

```sh
pnpm exec tsx scripts/live-browser.ts /tmp/fresh-live-evidence /absolute/public-synthetic-speech.wav --allow-paid-live1
```

Requires Python 3 with `websockets`, Playwright Chromium, and an OpenAI API key in `OPENAI_API_KEY`. The Python transport reads it from the process environment, then from `launchctl getenv`. Only that server process reads its value. No credential enters the browser, report, command line, or repository.

The public WAV must be mono PCM16 at 24 kHz, under twelve seconds, saying “Color the selected residues orange” (optionally preceded by “The protein is ready”). It is paced in real time, with silence afterwards. The harness preselects six residues in public 1CRN. Actual client delegation plus the expected transcript permits only a fixed selection-scoped orange update. The specific command must receive a real browser `rendered` receipt, and saved state must retain the exact selected keys and orange style, before a result is sent to Live.

Output PCM plays through Chromium WebAudio (Playwright’s default mute flag is removed) after a test button unlocks audio. Acceptance requires non-silent analyser output and all audio source `ended` events. This verifies browser playback, not physical speaker audibility, native Codex/Claude embedding, or a worn headset. Reports include transcripts, timing, exact render receipt, final `session.closed` usage, screenshots, output WAV, and cleanup status. No Live API session ID is retained.

The transport stops feeding audio by thirty seconds wall time and allows five seconds for finalization; an outer watchdog kills it at forty-five seconds. At a $0.05/min voice rate, thirty-five seconds is approximately $0.0292, with zero backend model cost. Check current pricing before each paid run. There are no automatic retries. Audio arriving just after a rendered result may still contain the end of a preliminary acknowledgement; use the post-result transcript timestamps to distinguish the final confirmation, rather than treating the next audio chunk as proof of its onset. An unconfirmed close is a failure and its cost is an estimate.

Contracts: [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [WebSocket audio](https://developers.openai.com/api/docs/guides/voice-websockets), [usage and graceful close](https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close).
