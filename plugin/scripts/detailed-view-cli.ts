/**
 * The one-word switch between the cinematic panel and the full Mol* viewer.
 *
 *     pnpm --dir plugin run detailed [state.json]
 *     pnpm --dir plugin run import-detailed <path.molj|latest> [state.json]
 *
 * `detailed` opens the structure and saved scene now in the panel in the stock
 * Mol* application, served from this Mac on loopback, and asks this Mac to open
 * it in the default browser. `import-detailed` reads a state file saved there
 * with Download State and applies the part the panel can render, in the two
 * calls the command queue needs: appearance first, then the camera.
 *
 * Neither command needs a revision typed by hand. Both read the host's current
 * inspection state and bind themselves to it.
 *
 * Coordinates never reach this process. The one secret in sight is the page
 * key in the detailed-view address, which is redacted before printing because
 * the browser is being opened with it anyway.
 */
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fillAgentArguments } from './agent-arguments.js';
import { agentText, callLocalAgent, readControlState, redactFragment, resolveStatePath, type ControlState } from './local-agent.js';

/** How long to wait for a queued command to finish drawing before saying so. */
const RECEIPT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_MS = 750;
const DOWNLOADS = resolve(homedir(), 'Downloads');

/** Receipt polling, loosened only so a test does not have to wait in real time. */
export type Wait = { pollMs: number; timeoutMs: number };
const DEFAULT_WAIT: Wait = { pollMs: RECEIPT_POLL_MS, timeoutMs: RECEIPT_TIMEOUT_MS };

const usage = 'Usage: detailed-view-cli.ts open [state.json] | detailed-view-cli.ts import <absolute .molj path|latest> [state.json]';

/** The newest Mol* state file the user downloaded, which is what `latest` means. */
export async function newestDownloadedSnapshot(directory = DOWNLOADS): Promise<string> {
  let entries: string[];
  try { entries = await readdir(directory); }
  catch { throw Error(`Could not read ${directory}, so "latest" has nothing to choose from. Give the absolute path of the .molj file instead.`); }
  const found: { path: string; modified: number }[] = [];
  for (const entry of entries) {
    if (extname(entry).toLowerCase() !== '.molj') continue;
    const path = join(directory, entry);
    try {
      const info = await stat(path);
      if (info.isFile()) found.push({ path, modified: info.mtimeMs });
    } catch { /* a file that vanished between listing and stat is not a candidate */ }
  }
  const newest = found.sort((a, b) => b.modified - a.modified)[0];
  if (!newest) throw Error(`No .molj file is in ${directory}. In the full Mol* viewer choose Download State with the .molj format, then run this again.`);
  return newest.path;
}

async function inspectionState(state: ControlState, commandId?: string) {
  const result = await callLocalAgent(state, 'get_inspection_state', commandId ? { commandId } : {});
  return result.structuredContent ?? {};
}

/** Wait for one queued command to stop being pending, and say how it ended. */
async function awaitReceipt(state: ControlState, commandId: string, wait: Wait): Promise<string> {
  const deadline = Date.now() + wait.timeoutMs;
  let status = 'queued';
  while (Date.now() < deadline) {
    await new Promise(done => setTimeout(done, wait.pollMs));
    status = (await inspectionState(state, commandId)).command?.status ?? 'unknown';
    if (status !== 'queued' && status !== 'rendering') return status;
  }
  return status;
}

export async function open(statePathArgument?: string) {
  const statePath = await resolveStatePath(statePathArgument);
  const state = await readControlState(statePath);
  const current = await inspectionState(state);
  if (current.hasScene !== true) throw Error('The panel has not saved a scene yet. Let the structure finish rendering in the browser tab, then run this again.');
  const { arguments: args } = fillAgentArguments('open_detailed_view', { open: true }, current);
  const result = await callLocalAgent(state, 'open_detailed_view', args);
  const view = result.structuredContent?.detailedView;
  if (!view?.url) throw Error(agentText(result) || 'The host did not return a detailed-view address.');
  console.log(view.opened === true
    ? 'The full Mol* viewer is opening in your Mac browser.'
    : `This Mac did not open a browser (${view.openReason ?? 'unknown'}${view.openDetail ? `: ${view.openDetail}` : ''}). The host printed the whole address; open that.`);
  console.log(`Address: ${redactFragment(view.url)}`);
  console.log(`Carried across: ${(view.carried ?? []).join(', ')}.`);
  console.log(`Left in the panel: ${(view.notCarried ?? []).join(', ')}.`);
  console.log('When you are done there, choose Download State with the .molj format, then run: pnpm --dir plugin run import-detailed latest');
}

export async function importDetailed(fileArgument: string | undefined, statePathArgument?: string, wait: Wait = DEFAULT_WAIT) {
  if (!fileArgument) throw Error(usage);
  const filePath = fileArgument === 'latest' ? await newestDownloadedSnapshot() : fileArgument;
  if (!isAbsolute(filePath)) throw Error('Give the absolute path of the .molj file, or "latest" for the newest one in your Downloads folder.');
  const statePath = await resolveStatePath(statePathArgument);
  const state = await readControlState(statePath);
  if (fileArgument === 'latest') console.log(`Reading ${filePath}.`);

  const applied: string[] = [];
  let dropped: string[] = [];
  // Appearance and framing cannot ride together: a panel renders one command
  // at a time. Each leg is idempotent, so this sends, waits for the receipt,
  // and sends again until the host says nothing was queued.
  for (let leg = 0; leg < 2; leg += 1) {
    const current = await inspectionState(state);
    if (current.hasScene !== true) throw Error('The panel has not saved a scene yet, so there is nothing to import into.');
    const { arguments: args } = fillAgentArguments('import_detailed_view', { filePath }, current, () => `import-${randomUUID()}`);
    const result = await callLocalAgent(state, 'import_detailed_view', args);
    const report = result.structuredContent?.detailedImport;
    dropped = report?.dropped ?? dropped;
    if (report?.changed !== true) {
      if (leg === 0) console.log('That saved state already matches what the panel is showing, so nothing was queued.');
      break;
    }
    applied.push(...(report.applied ?? []));
    const status = await awaitReceipt(state, String(args.commandId), wait);
    if (status !== 'rendered') {
      console.log(`Applied ${(report.applied ?? []).join(', ')}, but the panel reported ${status} rather than a finished draw.`);
      process.exitCode = 1;
      return;
    }
    if (report.cameraPending !== true) break;
  }
  if (applied.length > 0) console.log(`Applied and drawn: ${applied.join(', ')}.`);
  console.log(dropped.length > 0 ? `Not applied: ${dropped.join('; ')}.` : 'Nothing in that state was dropped.');
}

export async function main(argv: string[]) {
  const [mode, ...rest] = argv;
  if (mode === 'open') await open(rest[0]);
  else if (mode === 'import') await importDetailed(rest[0], rest[1]);
  else throw Error(usage);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
