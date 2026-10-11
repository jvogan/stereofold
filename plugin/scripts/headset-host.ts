/** Bundled Node entry point for a terminal outside the Claude Science sandbox. */
import { runBundledHeadsetHost } from './quest-share.js';

try { await runBundledHeadsetHost(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
