/**
 * Meta Web Launch, for the terminal.
 *
 * The link and the launch itself live in `../src/quest-launch.js` so the MCP
 * server bundle can reach them too; only the block this CLI prints is here.
 */
import type { BrowserChoice } from '../src/quest-launch.js';

export {
  BROWSER_ENV, WEB_LAUNCH_BASE, chooseBrowser, openInBrowser, openLocalInBrowser, questTargetUrl, resolveBrowser, webLaunchLink,
  type BrowserChoice,
} from '../src/quest-launch.js';

/** The lines to print. The code itself is never among them. */
export function formatWebLaunch(link: string, withCode: boolean): string {
  return [
    '',
    '  Open on the headset from this Mac (Meta Web Launch):',
    '',
    `    ${link}`,
    '',
    withCode
      ? '  This link carries the one-time pairing code to Meta, which expires in ten\n  minutes and only works on this Wi-Fi. Press Open on the page, then accept the\n  certificate warning once and tap Enter VR.'
      : '  This link carries no pairing code, so the headset must already be remembered.\n  Press Open on the page, then tap Enter VR.',
  ].join('\n');
}

/**
 * The one line that says where the link went and how to send it somewhere else.
 * Printed on every launch, because the browser holding the Meta session is the
 * single thing most likely to be wrong on a Mac that has more than one.
 */
export function formatBrowserChoice(choice: BrowserChoice): string {
  if (choice.name) return `  browser · ${choice.name}`;
  if (choice.missing) return `  browser · your Mac's default; ${choice.missing} is not installed in /Applications`;
  return '  browser · your Mac\'s default. If your Meta account is signed in elsewhere, add --browser "Google Chrome".';
}
