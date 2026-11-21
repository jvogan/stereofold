export type CatalogExtractorDependencies = {
  CIF: { parse(input: string): { run(): Promise<unknown> } };
  trajectoryFromMmCIF: (...args: any[]) => { run(): Promise<unknown> };
  Symmetry: { findAssembly: (...args: any[]) => unknown };
  molstarVersion: string;
  sha256(bytes: Uint8Array): string;
  /** Called between residues; may return a promise to wait on. The catalog does not depend on it. */
  yieldToHost?: () => Promise<void> | undefined;
  /**
   * The most residue rows one catalog may hold; `refuse` builds the error raised past a maximum, before the rows are built.
   * For an assembly, `maximumDeclaredRows` (default `maximumRows`) bounds the rows declared and stored before the assembly selects its chains.
   */
  rowBudget?: { maximumRows: number; maximumDeclaredRows?: number; refuse(rows: number, maximum: number): Error };
};

export function createCatalogExtractor(dependencies: CatalogExtractorDependencies): {
  extractBytes(
    input: Uint8Array | string,
    options?: { sourceLabel?: string | null; expectedHash?: string; assemblyId?: string },
  ): Promise<unknown>;
  /** Refuse text whose declared rows pass `maximum` (default `maximumDeclaredRows`), without building a model. */
  admitDeclaredRows(input: Uint8Array | string, maximum?: number): Promise<void>;
};
