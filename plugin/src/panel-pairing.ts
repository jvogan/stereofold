/** A client paired over this Mac's private Wi-Fi share, as the LAN listener lists it. */
export type PairedClient = { id: string; deviceId?: string };

/**
 * Which private Wi-Fi pairing each headset panel belongs to.
 *
 * The host retires the panels of a pairing that ends, so these maps decide
 * which pages a revoke takes away. `holders` names the pairing a panel is on
 * now. `openers` names the paired client whose attach the Mac answered with
 * that panel, with its remembered headset, and outlasts that client's
 * pairing, so the same headset can take its panel back after pairing again.
 * `moves` holds a move made for beats the Mac has not answered yet, with the
 * holder it replaced and how many of those beats are still unanswered.
 */
export type PanelMove = { client: string; previous?: string; unanswered: number };
export type PanelPairings = { holders: Map<string, string>; openers: Map<string, PairedClient>; moves: Map<string, PanelMove> };

export const createPanelPairings = (): PanelPairings => ({ holders: new Map(), openers: new Map(), moves: new Map() });

/** Whether `client` may hold a panel opened over the LAN: its opener, or a later pairing of the opener's remembered headset. */
export function mayHoldPanel(pairings: PanelPairings, client: PairedClient, panelId: string): boolean {
  const opener = pairings.openers.get(panelId);
  return opener !== undefined && (opener.id === client.id || (opener.deviceId !== undefined && opener.deviceId === client.deviceId));
}

export function forgetPanelPairing(pairings: PanelPairings, panelId: string) {
  pairings.holders.delete(panelId); pairings.openers.delete(panelId); pairings.moves.delete(panelId);
}

/** Entries for panels the session no longer knows go, so the maps stay as small as its registry. */
function prune(pairings: PanelPairings, remembers: (panelId: string) => boolean) {
  for (const id of new Set([...pairings.openers.keys(), ...pairings.holders.keys(), ...pairings.moves.keys()]))
    if (!remembers(id)) forgetPanelPairing(pairings, id);
}

/**
 * Tie a panel the Mac has just issued to the paired client whose attach it
 * answered.
 *
 * This is the only way a panel gets a pairing. The id is the Mac's own, new
 * for this attach, so no page can name another page's panel here, and a
 * panel registered over loopback (a cable headset, a desktop tab) never gets
 * one. `remembers` says whether the session lists the panel, or remembers it
 * as its silent wearer. True when bound.
 */
export function bindOpenedPanel(pairings: PanelPairings, client: PairedClient, panelId: string, remembers: (panelId: string) => boolean): boolean {
  if (!remembers(panelId)) return false;
  pairings.openers.set(panelId, { id: client.id, ...(client.deviceId !== undefined ? { deviceId: client.deviceId } : {}) });
  pairings.holders.set(panelId, client.id); pairings.moves.delete(panelId);
  prune(pairings, remembers);
  return true;
}

/**
 * Move a panel opened over the LAN to the paired client beating with it.
 *
 * A heartbeat never creates a pairing, so naming a panel the beating client
 * did not open does nothing: not another page's panel, not a loopback page,
 * not a made-up id. It may only move a panel back to its opener, or to a
 * later pairing of the opener's remembered headset: the headset is the unit
 * a wearer pairs, as in `retireDuplicatePanels`.
 *
 * The move stands until the Mac answers. The returned function settles one
 * beat with its answer: the first accepted beat of the moving client keeps
 * the move; when every one of its beats is refused, the previous holder is
 * put back and returned. Settling does nothing once a later move, attach or
 * ending has replaced the move. Undefined when the beat has nothing to settle.
 */
export function movePanelPairing(pairings: PanelPairings, client: PairedClient, panelId: string,
  remembers: (panelId: string) => boolean): ((accepted: boolean) => string | undefined) | undefined {
  if (!remembers(panelId) || !mayHoldPanel(pairings, client, panelId)) return undefined;
  const previous = pairings.holders.get(panelId);
  let move = pairings.moves.get(panelId);
  if (previous === client.id) {
    if (move?.client !== client.id) return undefined;
    move.unanswered++;
  } else {
    move = { client: client.id, ...(previous !== undefined ? { previous } : {}), unanswered: 1 };
    pairings.holders.set(panelId, client.id); pairings.moves.set(panelId, move);
    prune(pairings, remembers);
  }
  const settling = move;
  return accepted => {
    if (pairings.moves.get(panelId) !== settling) return undefined;
    if (!accepted && --settling.unanswered > 0) return undefined;
    pairings.moves.delete(panelId);
    if (accepted) return undefined;
    if (settling.previous === undefined) pairings.holders.delete(panelId);
    else pairings.holders.set(panelId, settling.previous);
    return settling.previous;
  };
}

/**
 * The panels whose pairing ended: those held by a client in `before` and not
 * in `after`. Their entries go. A panel moved to an ended client by a beat
 * the Mac has not answered goes back to the holder it had before, when that
 * one is still paired, rather than being counted: the move was never
 * confirmed, and the panel may be that live pairing's page.
 */
export function endPanelPairings(pairings: PanelPairings, before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  const ended: string[] = [];
  for (const [panelId, holder] of [...pairings.holders]) {
    if (!before.has(holder) || after.has(holder)) continue;
    const move = pairings.moves.get(panelId);
    if (move?.client === holder && move.previous !== undefined && after.has(move.previous)) {
      pairings.holders.set(panelId, move.previous); pairings.moves.delete(panelId); continue;
    }
    forgetPanelPairing(pairings, panelId); ended.push(panelId);
  }
  return ended;
}
