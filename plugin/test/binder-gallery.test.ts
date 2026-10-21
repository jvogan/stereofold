import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMolecularLesson } from '../src/molecular-lesson.js';
import { CIF } from '../src/compatible-cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/commonjs/mol-model-formats/structure/mmcif.js';

const directory = new URL('../demos/binder-gallery/', import.meta.url);
describe('published binder gallery mmCIF', () => {
  it('pairs every neutral target number with its published toxin identity in both lesson variants', async () => {
    const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
    const toxins = new Set((await readFile(new URL('upstream/toxins.csv', directory), 'utf8')).trim().split('\n').slice(1).map(line=>line.split(',')[0]));
    for (const filename of ['lesson.json','original-pairs.json']) {
      const lesson = parseMolecularLesson(JSON.parse(await readFile(new URL(filename,directory),'utf8')));
      expect(lesson.chapters.map(chapter=>chapter.id)).toEqual(manifest.entries.map((entry:any)=>entry.id));
      for (const entry of manifest.entries) {
        expect(toxins.has(entry.target)).toBe(true);
        const chapter = lesson.chapters.find(chapter=>chapter.id===entry.id)!;
        const neutral = entry.targetLabel.replace('Target','Target '), label = `${neutral} · ${entry.target}`;
        expect(chapter.title).toBe(`Binder ${String(entry.slide).padStart(2,'0')} · ${label}`);
        expect(chapter.immersive!.parts!.find(part=>part.id==='target')).toMatchObject({label,aliases:expect.arrayContaining([neutral,entry.target])});
        expect(chapter.immersive!.figure!.labels!.find(item=>item.id==='target-label')!.text).toBe(label);
        expect(chapter.details).toContain(`Display labels: Binder ${String(entry.slide).padStart(2,'0')} · ${label}\n`);
      }
    }
  });

  it('displays the published target-specific Adaptyv KD with its bounds and approximate markers', async () => {
    const manifest = JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
    const csv = await readFile(new URL('upstream/design.csv',directory),'utf8');
    // This pinned table is unquoted. Keep UUID cells as text, including
    // all-numeric-looking identifiers and leading zeroes.
    expect(csv).not.toContain('"');
    const [header,...lines] = csv.trim().split(/\r?\n/u), columns=header.split(',');
    const rows=lines.map(line=>Object.fromEntries(line.split(',').map((value,index)=>[columns[index],value])));
    expect(rows).toHaveLength(211);
    const targetColumns:Record<string,string> = {Cn2:'Cn2','AaH II':'AaHII','AaH I':'AaHI',LqhIII:'LqhIII'};
    for (const filename of ['lesson.json','original-pairs.json']) {
      const lesson = parseMolecularLesson(JSON.parse(await readFile(new URL(filename,directory),'utf8')));
      for (const entry of manifest.entries) {
        const matches=rows.filter(row=>row.uuid===entry.uuid);
        expect(matches).toHaveLength(1);
        const row=matches[0],column=`${targetColumns[entry.target]}_Adaptyv_KD_nM`;
        expect(row.binder_against).toBe(entry.target);
        const value=row[column];expect(Number(value)).toBeGreaterThan(0);
        const qualifier=entry.slide===2?'≤':entry.slide>=12&&entry.slide<=15?'≈':'';
        const chapter=lesson.chapters.find(chapter=>chapter.id===entry.id)!;
        const label=chapter.immersive!.figure!.labels!.find(label=>label.id==='binder-label')!;
        expect(label.text).toBe(`Binder ${String(entry.slide).padStart(2,'0')} · Adaptyv KD ${qualifier}${value} nM`);
        expect(label.text.length).toBeLessThanOrEqual(60);
        expect(chapter.details).toContain(column);expect(chapter.details).toContain(entry.uuid);
        expect(chapter.details).toContain('binding, not toxin neutralization');
        expect(chapter.details).toContain('not a ranked top 17');
      }
      const qualifierCounts=lesson.chapters.map(chapter=>chapter.immersive!.figure!.labels!.find(label=>label.id==='binder-label')!.text);
      expect(qualifierCounts.filter(text=>text.includes('≤'))).toHaveLength(1);
      expect(qualifierCounts.filter(text=>text.includes('≈'))).toHaveLength(4);
    }
  });

  it('anchors the long Binder 15 name near its complete stage-specific contact region without authoring a new view', async () => {
    const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
    const entry = manifest.entries.find((item: any) => item.id === 'binder-15');
    for (const [filename, mode] of [['lesson.json', 'referenceOverlay'], ['original-pairs.json', 'originalPair']]) {
      const lesson = JSON.parse(await readFile(new URL(filename, directory), 'utf8'));
      const chapter = lesson.chapters.find((item: any) => item.id === 'binder-15');
      const label = chapter.immersive.figure.labels.find((item: any) => item.id === 'binder-label');
      expect(label.target).toEqual({ chain: entry.binderChain, residueNumbers: entry.contacts[mode].binder.residueNumbers });
      expect(label.text).toBe('Binder 15 · Adaptyv KD ≈59.3 nM');
      expect(chapter.caption).toContain('Use Fit molecule or zoom out to see its full length.');
      expect(lesson.chapters.filter((item: any) => item.caption.includes('Use Fit molecule'))).toHaveLength(1);
      expect(chapter.immersive).not.toHaveProperty('placement');
      expect(chapter.immersive).not.toHaveProperty('view');
      expect(chapter.immersive.figure).not.toHaveProperty('focus');
    }
  });
  it('loads the composite as 34 declared polymer chains with every source atom', async () => {
    const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
    const source = await readFile(new URL(manifest.composite.file, directory), 'utf8');
    expect(createHash('sha256').update(source).digest('hex')).toBe(manifest.composite.sha256);
    const parsed = await CIF.parse(source).run();
    if (parsed.isError) throw Error(String(parsed));
    const frame = parsed.result.blocks[0];
    const trajectory = await trajectoryFromMmCIF(frame).run();
    expect(trajectory.frameCount).toBe(1);
    const model = trajectory.representative;
    expect(model.atomicHierarchy.atoms._rowCount).toBe(manifest.composite.atomCount);
    expect(model.atomicHierarchy.chains._rowCount).toBe(34);
    const chains = model.atomicHierarchy.chains;
    expect(Array.from({length: chains._rowCount}, (_, i) => chains.auth_asym_id.value(i)))
      .toEqual(manifest.entries.flatMap((e: any) => [e.binderChain,e.targetChain]));
    expect(model.entities.data._rowCount).toBe(34);
    expect(Array.from({length: model.entities.data._rowCount}, (_, i) => model.entities.data.type.value(i)))
      .toEqual(Array(34).fill('polymer'));
    expect(frame.categories.entity_poly_seq.rowCount).toBe(manifest.entries.reduce((n: number,e: any) => n+e.binderSequence.length+e.targetSequence.length,0));
    expect(frame.categories.pdbx_poly_seq_scheme.rowCount).toBe(frame.categories.entity_poly_seq.rowCount);
  });
});
