import type { MolecularLessonManifest } from './molecular-lesson.js';

/** Validate authored targets against the same catalog/model the panel draws. */
export function validateLessonSource(lesson: MolecularLessonManifest, catalog: any, modelNumber: number,
  densitySha256?: string): void {
  const fail = (path: string, message: string): never => { throw Error(`Invalid molecular lesson at lesson.${path}: ${message}`); };
  if (lesson.provenance.sourceSha256 && lesson.provenance.sourceSha256.toLowerCase() !== (densitySha256 ?? catalog.source.sha256))
    fail('provenance.sourceSha256', 'does not match the current source bytes.');
  const rows = catalog.rows.filter((row: any) => row.identity.modelNumber === modelNumber);
  const targets = (target: any, path: string, single = false, authorOnly = true): any[] => {
    const sites = rows.filter((row: any) => {
      const i = row.identity;
      return (!target.chain || i.authorChain === target.chain || (!authorOnly && i.labelChain === target.chain))
        && (!target.residues || (i.authorResidue != null && Number(i.authorResidue) >= target.residues.from && Number(i.authorResidue) <= target.residues.to))
        && (!target.residueNumbers || (i.authorResidue != null && target.residueNumbers.includes(Number(i.authorResidue))))
        && (!target.componentId || i.componentId === target.componentId);
    }).flatMap((row: any) => row.atomSites).filter((site: any) => !target.atomName || site.identity.atomName === target.atomName);
    if (!sites.length || (single && sites.length !== 1)) fail(path, single
      ? 'must resolve to exactly one atom in the current model and assembly.' : 'target has no atoms in the current model and assembly.');
    return sites;
  };
  lesson.chapters.forEach((chapter, index) => {
    const path = `chapters.${index}`, intent = chapter.immersive;
    if (!intent) fail(`${path}.immersive`, 'each chapter requires an immersive intent.');
    intent?.parts?.forEach((part, i) => targets(part, `${path}.immersive.parts.${i}`, false, false));
    intent?.emphasis?.parts.forEach((part, i) => targets(part, `${path}.immersive.emphasis.parts.${i}`, false, false));
    if (intent?.selection && intent.selection !== 'clear') targets(intent.selection, `${path}.immersive.selection`, false, false);
    intent?.visibility?.chains?.forEach((chain, i) => {
      const present = rows.some((row: any) => typeof chain === 'string'
        ? [row.identity.authorChain, row.identity.labelChain, `${row.identity.labelChain}@${row.identity.copyId}`].includes(chain)
        : row.identity.labelChain === chain.labelChain && row.identity.copyId === chain.copyId);
      if (!present) fail(`${path}.immersive.visibility.chains.${i}`, 'chain is absent from the current model and assembly.');
    });
    const figure = intent?.figure;
    figure?.layers.forEach((layer, i) => {
      targets(layer.target, `${path}.immersive.figure.layers.${i}.target`);
      layer.colorOverrides?.forEach((override, j) => targets(override.target, `${path}.immersive.figure.layers.${i}.colorOverrides.${j}.target`));
    });
    figure?.labels.forEach((label, i) => targets(label.target, `${path}.immersive.figure.labels.${i}.target`));
    figure?.focus?.forEach((target, i) => targets(target, `${path}.immersive.figure.focus.${i}`));
    figure?.distances.forEach((distance, i) => {
      const field = `${path}.immersive.figure.distances.${i}`;
      const a = targets(distance.a, `${field}.a`, true)[0].assemblyCoordinatesAngstrom;
      const b = targets(distance.b, `${field}.b`, true)[0].assemblyCoordinatesAngstrom;
      const measured = Math.hypot(...a.map((v: number, j: number) => v - b[j]));
      if (distance.expectedAngstrom !== undefined && Math.abs(measured - distance.expectedAngstrom) > .02)
        fail(`${field}.expectedAngstrom`, `expected ${distance.expectedAngstrom} Å but current atoms measure ${measured.toFixed(3)} Å.`);
    });
    chapter.animation?.tracks.forEach((track, i) => track.chains.forEach((chain, j) =>
      targets({ chain }, `${path}.animation.tracks.${i}.chains.${j}`)));
    chapter.animation?.tethers?.forEach((tether, i) => {
      for (const end of ['from', 'to'] as const) {
        const atom = tether[end];
        targets({ chain: atom.chain, residues: { from: atom.residue, to: atom.residue }, atomName: atom.atom },
          `${path}.animation.tethers.${i}.${end}`, true);
      }
    });
  });
}
