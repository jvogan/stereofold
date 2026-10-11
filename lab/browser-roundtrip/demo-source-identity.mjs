/** Display provenance for exact shipped derived coordinates. No runtime source
 * or assembly IDs are changed. The regression test checks these records against
 * plugin/demos/index.json and each matching lesson's coordinate digest. */
export const DEMO_DERIVED_SOURCES = Object.freeze({
  f78a56284d959324ae35bc58a9efa69bec4e99f861c5dbc6f4d09d521f8367ec: Object.freeze({
    pdbId: '5SYF', title: 'Microtubule wall', scope: 'assembly 1 subset', kind: 'assembly-operator-subset',
    assemblyId: '1', operators: Object.freeze(['2', '3', '4', '5', '6', '7']), ofOperators: 26,
  }),
  '35a45abbc5f671c159707946a1190dd42ee2846a46cbbe65335418b89046df4d': Object.freeze({
    pdbId: '5SYF', title: 'Tubulin protofilament', scope: 'assembly 1 subset', kind: 'assembly-operator-subset',
    assemblyId: '1', operators: Object.freeze(['1', '14']), ofOperators: 26,
  }),
  ffe500b8f9efe3c2a15b1db5cb87ecc73c7879ca6eb15412d39f70b52ee51f46: Object.freeze({
    pdbId: '5SYF', title: 'Alpha tubulin', scope: 'deposited chain subset', kind: 'deposited-chain-subset',
    chains: Object.freeze(['A']), entityIds: Object.freeze(['1']),
  }),
});

export function demoSourceIdentity(sha256) {
  return typeof sha256 === 'string' && Object.hasOwn(DEMO_DERIVED_SOURCES, sha256)
    ? DEMO_DERIVED_SOURCES[sha256] : undefined;
}
