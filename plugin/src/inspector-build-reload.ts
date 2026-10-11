export type CompanionReloadState = {dirty:boolean;presenting:boolean;enteringXr:boolean;voice:boolean;loading:boolean;rendering:boolean;
  navigating:boolean;interacting:boolean;pendingReceipt:boolean};

export function reloadOutdatedCompanion(hostBuild:unknown, state:CompanionReloadState,
  storage:Pick<Storage,'getItem'|'setItem'>, reload:()=>void):boolean {
  if(typeof hostBuild!=='string' || !/^[0-9a-f]{64}$/u.test(hostBuild)) return false;
  if(Object.values(state).some(Boolean)) return false;
  const key=`stereofold-inspector-reload:${hostBuild}`;
  try {
    if(storage.getItem(key)) return false;
    storage.setItem(key,'1');
  } catch { return false; }
  reload();
  return true;
}

/**
 * Whether a host refused the call because it does not know `pageBuild`.
 *
 * Hosts from before build checks validate attach and poll strictly, so the
 * field alone fails the call: "Unrecognized key: \"pageBuild\"".
 */
export function rejectsPageBuild(message:unknown):boolean {
  return typeof message==='string' && message.includes('pageBuild') && /unrecognized|unknown/iu.test(message);
}
