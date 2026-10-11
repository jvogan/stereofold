export type CatalogExtractorDependencies = {
  CIF: { parse(input: string): { run(): Promise<unknown> } };
  trajectoryFromMmCIF: (...args: any[]) => { run(): Promise<unknown> };
  Symmetry: { findAssembly: (...args: any[]) => unknown };
  molstarVersion: string;
  sha256(bytes: Uint8Array): string;
  /** Called between residues; may return a promise to wait on. The catalog does not depend on it. */
  yieldToHost?: () => Promise<void> | undefined;
};

export function createCatalogExtractor(dependencies: CatalogExtractorDependencies): {
  extractBytes(
    input: Uint8Array | string,
    options?: { sourceLabel?: string | null; expectedHash?: string; assemblyId?: string },
  ): Promise<unknown>;
};
