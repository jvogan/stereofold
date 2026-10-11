/**
 * Which application this panel is mounted in, as the host itself reported it.
 *
 * The panel used to offer a button called "Open in Codex"
 * to every host, in a dialog whose other buttons open unrelated viewers. In
 * Claude Code, in Claude Science, in any host that is not Codex, that button
 * sends a sentence asking for a plugin the host does not have, and the panel had
 * named an application it never established it was talking to.
 *
 * The MCP Apps handshake answers this: `ui/initialize` returns `hostInfo`
 * (`getHostVersion()`) and `hostContext.userAgent`, which the specification
 * defines as the host application identifier. Neither is a capability and
 * neither is trusted with anything: they decide one label and one button's
 * visibility.
 *
 * Three answers, not two. A host that says nothing is `unknown`, and the panel
 * hides the request behind an explicit opt-in rather than guessing, because a
 * wrong guess here is a button that cannot work and a name that is not true.
 */
export type HostIdentity = 'codex' | 'other' | 'unknown';

/** Set by the user to reveal the Codex request on a host that did not identify itself. */
export const CODEX_HANDOFF_OPT_IN_KEY = 'stereofold.handoff.codex';

const CODEX = /\bcodex\b/i;

export function hostIdentity(info?: { name?: unknown } | undefined, context?: { userAgent?: unknown } | undefined): HostIdentity {
  const names = [info?.name, context?.userAgent].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!names.length) return 'unknown';
  return names.some(name => CODEX.test(name)) ? 'codex' : 'other';
}

/**
 * Whether the panel may offer the Codex Molecular Structure Viewer request.
 *
 * A Codex host always may. A host that identified itself as something else
 * never may: the request would ask that assistant for a viewer it does not
 * have. An unidentified host may only after the user has said so, which is the
 * opt-in the dialog writes to storage.
 */
export function offerCodexHandoff(identity: HostIdentity, optedIn: boolean): boolean {
  if (identity === 'codex') return true;
  if (identity === 'other') return false;
  return optedIn === true;
}

/** Read the opt-in without letting a storage-less browser break the dialog. */
export function readCodexOptIn(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try { return storage?.getItem(CODEX_HANDOFF_OPT_IN_KEY) === 'true'; } catch { return false; }
}

export function writeCodexOptIn(storage: Pick<Storage, 'setItem'> | null | undefined, value: boolean): void {
  try { storage?.setItem(CODEX_HANDOFF_OPT_IN_KEY, value ? 'true' : 'false'); } catch { /* A refused write is not a reason to fail the click. */ }
}
