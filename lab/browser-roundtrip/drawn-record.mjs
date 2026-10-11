/**
 * The two questions the frame waiter asks about a record, for a scene that may
 * be atoms or may be a density map.
 *
 * A "record" here is the viewer's retained or candidate scene: a source, a Mol*
 * cell for the thing that was loaded, a representation built from it, and — for
 * an atomic scene only — a selection adapter. Until the density tier there was
 * exactly one kind, so `waitForFrame`, `capture` and the swap all reached
 * straight into `record.structure`. A density record has a `volume` and no
 * `structure` at all, and on the `filament` tier that cost the whole run: an
 * 8,389,632-byte map fetched and parsed in 1.1 s, the isosurface built at 1.3 s,
 * and then `showCandidate`'s frame wait threw
 * `Cannot read properties of undefined (reading 'checkValid')` before a single
 * frame of it reached the wearer.
 *
 * Both functions here are Mol*-free and pure, so `node --test` holds them with
 * a record whose `structure` is a getter that throws. That is the real
 * assertion: the fix must not reach for a structure on a density scene, and it
 * must not invent a fake one to reach for either — a fake structure passes a
 * shape check and then fails the moment anything asks it for atoms.
 */

/**
 * Validate the Mol* cell behind one record, and its representation.
 *
 * The volume is read FIRST and the structure is only reached for when there is
 * no volume, so a density record's `structure` is never touched.
 *
 * @param {{structure?:{checkValid:()=>unknown}, volume?:{checkValid:()=>unknown},
 *   representation?:{checkValid:()=>unknown}}|null|undefined} record
 * @param {(code:string, message:string)=>Error} failure the viewer's failure factory
 * @returns {'volume'|'structure'} which kind of scene was validated
 */
export function checkDrawnRecord(record, failure) {
  if (!record) throw failure('record_missing', 'There is no molecular record to draw.');
  const kind = record.volume ? 'volume' : 'structure';
  const cell = record.volume ?? record.structure;
  if (!cell) throw failure('record_missing', 'The molecular record has neither a structure nor a density map.');
  cell.checkValid();
  if (!record.representation) {
    throw failure('record_missing', kind === 'volume'
      ? 'The density record has no isosurface to draw.'
      : 'The molecular record has no representation to draw.');
  }
  record.representation.checkValid();
  return kind;
}

/**
 * Whether the frame that was just drawn actually shows this record.
 *
 * Unchanged in substance from what `waitForFrame` asked inline; lifted out so a
 * density record can be driven through it without a GL context. Every term is
 * geometry-agnostic — an isosurface is a representation with render objects
 * like any other — which is why the only thing the volume tier needed here was
 * to stop being asked for a structure on the way in.
 *
 * `expectedRepresentations` counts the loaded scene's own representation, the
 * lesson's residue labels and the ligand overlay, plus whatever the spatial
 * toolbar is presenting. A density tier has neither labels nor an overlay, so
 * its count is the isosurface alone and the comparison holds as it stands.
 *
 * @param {{representation?:{obj?:{data?:{repr?:unknown}}}}} record
 * @param {{renderObjects?:Iterable<unknown>, reprCount?:number,
 *   expectedRepresentations?:number, commitQueueSize?:number}} canvas what the canvas reports now
 * @returns {boolean} true when the record is fully committed, visible and drawn
 */
export function drawnRecordIsVisible(record, { renderObjects, reprCount, expectedRepresentations, commitQueueSize } = {}) {
  const repr = record?.representation?.obj?.data?.repr;
  if (!repr) return false;
  if (commitQueueSize !== 0 || reprCount !== expectedRepresentations) return false;
  if (!repr.state?.visible) return false;
  const objects = renderObjects instanceof Set ? renderObjects : new Set(renderObjects ?? []);
  const drawn = repr.renderObjects ?? [];
  if (!drawn.every(object => objects.has(object))) return false;
  return drawn.some(object => object.values.drawCount.ref.value > 0 && object.values.instanceCount.ref.value > 0);
}
