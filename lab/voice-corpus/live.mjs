/**
 * The runner's other host: a standalone Stereofold already running on this Mac.
 *
 * The standalone host writes a private control file holding its loopback
 * origin, an admin bearer and the current session ID, and serves `/agent` to
 * whoever can read it. This is that one hop and nothing else — the same shape
 * `plugin/scripts/local-agent.ts` uses, rewritten here because the lab is plain
 * ESM and must not import the plugin's TypeScript.
 *
 * A live host has a REAL recognizer, so this route cannot put words at the
 * transcriber seam: there is no seam to reach without a browser hop into the
 * headset page, which this runner deliberately does not take. What it does
 * instead is the documented text-request route — `update_inspection` with
 * `kind:"utterance"` and no ID allocates one — so the consumer, the target
 * resolution and every receipt are exercised against the real host while the
 * speech leg is honestly recorded as absent. Runs from here are marked
 * `route: "text-utterance"`, and nothing in them may be read as microphone
 * evidence.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const AGENT_TIMEOUT_MS = 65_000;

export function expandHome(path) {
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

export async function readControlState(statePath) {
  const path = expandHome(statePath);
  if (!isAbsolute(path)) throw Error('The control state-file path must be absolute.');
  const state = JSON.parse(await readFile(path, 'utf8'));
  const url = new URL(state.origin);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw Error('Local control requires loopback.');
  if (typeof state.token !== 'string' || typeof state.sessionId !== 'string') throw Error('The control state file is incomplete.');
  return state;
}

export async function createLiveCorpusHost(statePath) {
  const state = await readControlState(statePath);
  return {
    kind: 'live',
    /** No recognizer seam here; the corpus sentence is carried as text. */
    route: 'text-utterance',
    sessionId: state.sessionId,
    clock: null,
    arm() { /* nothing to arm: a live host hears its own microphone or nothing. */ },
    setTranscription() { throw Error('A live host owns its own recognizer. Do not switch it off from a test runner.'); },
    async call(name, args) {
      const response = await fetch(`${state.origin}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
        body: JSON.stringify({ name, arguments: args }),
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
      const body = await response.json().catch(() => undefined);
      // A refusal is an outcome the corpus wants to read, not a crash, so it
      // comes back shaped like every other refused tool result.
      if (!response.ok) {
        return { isError: true, content: [{ type: 'text', text: body?.error ?? `The local host refused ${name} with status ${response.status}.` }] };
      }
      return body;
    },
    async close() { /* nothing is held open: every call is one request. */ },
  };
}
