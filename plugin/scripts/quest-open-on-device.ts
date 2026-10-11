/**
 * Open the companion address on a connected Quest from the Mac.
 *
 * The adb discovery, the intent argument rule and the single-device choice all
 * live in `../src/quest-launch.js` so the MCP server bundle can reach them; this
 * file is the terminal's name for them.
 */
export {
  adbCandidates, defaultRunner, extraAdbPaths, findAdb, hasPackage, openOnQuest, parseAdbDevices,
  QUEST_BROWSER_PACKAGE, selectDevice, viewIntentArgs,
  type AdbDevice, type OpenResult, type RunResult, type Runner,
} from '../src/quest-launch.js';
