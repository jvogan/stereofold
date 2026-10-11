'use strict';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function copyKey({ assemblyId, generatorIndex, operatorIds }) {
  return JSON.stringify(['copy', assemblyId, generatorIndex, operatorIds]);
}

function residueKey(i) {
  return JSON.stringify(['residue-v1', i.sourceHash, i.modelNumber, i.copyId,
    i.entityId, i.labelChain, i.authorChain, i.labelSequenceId, i.authorResidue,
    i.insertionCode, i.componentId]);
}

function atomKey(i) {
  return JSON.stringify(['atom-v1', residueKey(i), i.atomName, i.authorAtomName,
    i.alternateSite, i.sourceAtomId]);
}

const allowedFields = new Set(['sourceHash', 'modelNumber', 'assemblyId', 'copyId', 'entityId', 'chain', 'residue', 'componentId', 'atom']);
const namespaces = new Set(['label', 'author', 'unspecified']);

function string(value) { return typeof value === 'string' && value.length > 0; }
function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function namespace(selector) { return own(selector, 'namespace') ? selector.namespace : 'unspecified'; }
function selector(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function denseStrings(value) {
  if (!Array.isArray(value) || !value.length) return false;
  for (let i = 0; i < value.length; i++) if (!own(value, i) || !string(value[i])) return false;
  return true;
}

function validateSnapshot(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return 'A query object is required.';
  if (Object.keys(q).some(k => !allowedFields.has(k))) return 'The query contains an unknown field.';
  if (typeof q.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(q.sourceHash)) return 'An explicit source SHA-256 is required.';
  if (own(q, 'modelNumber') && !Number.isSafeInteger(q.modelNumber)) return 'Model number must be an integer.';
  for (const key of ['assemblyId', 'copyId', 'entityId', 'componentId']) {
    if (own(q, key) && !string(q[key])) return `${key} must be a nonempty string.`;
  }
  if (!own(q, 'chain') && !own(q, 'componentId')) return 'A chain or component identifier is required.';
  if (!own(q, 'residue') && !own(q, 'componentId')) return 'A residue or component identifier is required.';
  if (own(q, 'chain')) {
    const c = q.chain;
    if (!selector(c) || Object.keys(c).some(k => !['namespace', 'id', 'oneOf'].includes(k))) return 'Invalid chain selector.';
    if (!namespaces.has(namespace(c))) return 'Unknown chain namespace.';
    if (own(c, 'id') === own(c, 'oneOf')) return 'Give one chain id or an explicit set of uncertain candidates.';
    if (own(c, 'id') && !string(c.id)) return 'Chain id must be a nonempty string.';
    if (own(c, 'oneOf') && !denseStrings(c.oneOf)) return 'Chain candidates must be a dense array of nonempty strings.';
  }
  if (own(q, 'residue')) {
    const r = q.residue;
    if (!selector(r) || Object.keys(r).some(k => !['namespace', 'number', 'insertionCode'].includes(k))) return 'Invalid residue selector.';
    if (!namespaces.has(namespace(r))) return 'Unknown residue namespace.';
    if (!Number.isSafeInteger(r.number)) return 'Residue number must be an integer.';
    if (r.namespace === 'label' && r.number <= 0) return 'A polymer sequence position must be positive.';
    if (own(r, 'insertionCode') && typeof r.insertionCode !== 'string') return 'Insertion code must be a string; an empty string explicitly selects no insertion.';
  }
  if (own(q, 'atom')) {
    const a = q.atom;
    if (!selector(a) || Object.keys(a).some(k => !['namespace', 'name', 'alternateSite'].includes(k))) return 'Invalid atom selector.';
    if (!namespaces.has(namespace(a))) return 'Unknown atom namespace.';
    if (!string(a.name)) return 'Atom name must be a nonempty string.';
    if (own(a, 'alternateSite') && typeof a.alternateSite !== 'string') return 'Alternate site must be a string; an empty string selects a site without an alternate id.';
  }
  return null;
}

function validateQuery(query) {
  try { return validateSnapshot(structuredClone(query)); }
  catch { return 'The query cannot be copied as structured data.'; }
}

function namespaceMatch(namespace, value, label, author) {
  return (namespace !== 'author' && label !== null && value === label)
    || (namespace !== 'label' && author !== null && value === author);
}

function matches(row, q) {
  const i = row.identity;
  if (i.sourceHash !== q.sourceHash) return false;
  for (const key of ['modelNumber', 'assemblyId', 'copyId', 'entityId', 'componentId']) {
    if (own(q, key) && q[key] !== i[key]) return false;
  }
  if (own(q, 'chain')) {
    const ids = own(q.chain, 'id') ? [q.chain.id] : q.chain.oneOf;
    if (!ids.some(id => namespaceMatch(namespace(q.chain), id, i.labelChain, i.authorChain))) return false;
  }
  if (own(q, 'residue')) {
    if (!namespaceMatch(namespace(q.residue), q.residue.number, i.labelSequenceId, i.authorResidue)) return false;
    if (own(q.residue, 'insertionCode') && q.residue.insertionCode !== i.insertionCode) return false;
  }
  return true;
}

function describe(row) {
  return { key: row.key, identity: row.identity, coordinateState: row.coordinateState, atomSiteCount: row.atomSites.length };
}

function differingFields(candidates) {
  const fields = ['modelNumber', 'assemblyId', 'copyId', 'entityId', 'labelChain', 'authorChain', 'labelSequenceId', 'authorResidue', 'insertionCode', 'componentId', 'atomName', 'authorAtomName', 'alternateSite'];
  return fields.filter(key => new Set(candidates.map(c => JSON.stringify(c.identity[key]))).size > 1);
}

// A residue has no implicit centroid or preferred alternate site.
function resolveIdentity(rows, query) {
  let snapshot;
  try { snapshot = structuredClone(query); }
  catch { return { status: 'invalid_query', reason: 'The query cannot be copied as structured data.', candidates: [], positionAngstrom: null }; }
  const invalid = validateSnapshot(snapshot);
  if (invalid) return { status: 'invalid_query', reason: invalid, candidates: [], positionAngstrom: null };
  const matching = rows.filter(row => matches(row, snapshot));
  if (!matching.length) return { status: 'not_found', reason: 'No residue matches the supplied source and selectors.', candidates: [], positionAngstrom: null };
  if (matching.length > 1) {
    const candidates = matching.map(describe);
    return { status: 'ambiguous', reason: 'Choose a residue, model, or assembly copy.', differingFields: differingFields(candidates), candidates, positionAngstrom: null };
  }
  const row = matching[0];
  if (!row.atomSites.length) {
    return { status: 'unresolved_coordinates', kind: 'residue', residue: row, candidates: [describe(row)], positionAngstrom: null };
  }
  if (!own(snapshot, 'atom')) return { status: 'resolved', kind: 'residue', residue: row, candidates: [], positionAngstrom: null };
  const a = snapshot.atom;
  const sites = row.atomSites.filter(site => namespaceMatch(namespace(a), a.name, site.identity.atomName, site.identity.authorAtomName)
    && (!own(a, 'alternateSite') || a.alternateSite === site.identity.alternateSite));
  if (!sites.length) return { status: 'not_found', reason: 'The residue has no matching atom site.', candidates: [], positionAngstrom: null };
  if (sites.length > 1) {
    const candidates = sites.map(site => ({ key: site.key, identity: site.identity, coordinateState: 'resolved' }));
    return { status: 'ambiguous', reason: 'Choose an alternate atom site.', differingFields: differingFields(candidates), candidates, positionAngstrom: null };
  }
  return { status: 'resolved', kind: 'atom', residue: row, atom: sites[0], candidates: [], positionAngstrom: [...sites[0].assemblyCoordinatesAngstrom] };
}

module.exports = { deepFreeze, copyKey, residueKey, atomKey, validateQuery, resolveIdentity };
