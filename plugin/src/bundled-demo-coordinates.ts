import { createHash } from 'node:crypto';
import { compositeRecipePath, readConfinedCompositeFile } from './demo-composite-files.js';

/** Indexed packaged coordinates use the same confined, bounded UTF-8 read as
 * composite ingredients, then verify their scientific identity before caching. */
export async function readBundledDemoCoordinates(path: string, sha256: string, demosRoot?: string): Promise<string> {
  const text = await readConfinedCompositeFile(compositeRecipePath(path, demosRoot), demosRoot);
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== sha256)
    throw Error(`Bundled coordinates ${path} sha256 mismatch`);
  return text;
}
