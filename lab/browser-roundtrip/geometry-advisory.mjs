// Advisory state remains on receipts; only a changed advisory interrupts a confirmation.
const fields = ['representation', 'deviceClass', 'atoms', 'budget', 'requestedLevel', 'level', 'estimatedVertices', 'message'];
export function geometryBudgetChanged(previous, next) {
  return Boolean(next) && (!previous || fields.some(key => previous[key] !== next[key]));
}
// Match the host's optional receipt shape before negotiating it with older pages.
export function sourceGeometryBudget(receipt) {
  if (!receipt || !['cartoon', 'ball-and-stick', 'spacefill', 'molecular-surface'].includes(receipt.representation)
    || typeof receipt.deviceClass !== 'string' || receipt.deviceClass.length < 1 || receipt.deviceClass.length > 32
    || !Number.isSafeInteger(receipt.atoms) || receipt.atoms < 0
    || !Number.isFinite(receipt.budget) || receipt.budget <= 0
    || !['lowest', 'lower', 'low', 'medium', 'high', 'higher', 'highest'].includes(receipt.requestedLevel)
    || !['lowest', 'lower', 'low', 'medium', 'high', 'higher', 'highest'].includes(receipt.level)
    || !Number.isSafeInteger(receipt.estimatedVertices) || receipt.estimatedVertices < 0
    || typeof receipt.message !== 'string' || receipt.message.length < 1 || receipt.message.length > 120) return undefined;
  return Object.fromEntries(fields.map(key => [key, receipt[key]]));
}
