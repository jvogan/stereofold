interface DemoIndexEntry {
  lesson?: unknown;
  coordinates?: { derivation?: { kind?: unknown; recipe?: unknown } };
}

export interface DemoIndexLike {
  version?: unknown;
  demos?: Array<DemoIndexEntry & { stages?: DemoIndexEntry[] }>;
}

/**
 * The lesson files a demo index lists, relative to the demos directory.
 *
 * Growth reads the index beside the bundle and then each tier's lesson from
 * beside the index, so the required set is derived from the index itself
 * rather than a second list that can drift from it.
 */
export function demoLessonPaths(indexJson: unknown): string[] {
  const index = indexJson as DemoIndexLike;
  if (index.version !== 1 || !Array.isArray(index.demos) || index.demos.length === 0) {
    throw new Error('demo index is not a demo index.');
  }
  const lessons = new Set<string>();
  for (const demo of index.demos) {
    if (typeof demo?.lesson === 'string' && demo.lesson.length > 0) lessons.add(demo.lesson);
    for (const stage of demo?.stages ?? []) {
      if (typeof stage?.lesson === 'string' && stage.lesson.length > 0) lessons.add(stage.lesson);
    }
  }
  if (lessons.size === 0) throw new Error('demo index names no lessons.');
  return [...lessons].sort();
}
