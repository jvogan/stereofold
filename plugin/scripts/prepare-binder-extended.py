#!/usr/bin/env python3
"""Pinned public structures only: no prediction, design, relaxation or sequence edits.

Offline by default. --fetch retrieves at most four selected public ESMFold2
complexes concurrently and verifies the immutable revision and Git blob ETag.
Outputs are separate from the original 17-example gallery.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import urllib.request
import numpy as np

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('base_gallery', HERE/'prepare-binder-gallery.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
ROOT = base.DEFAULT_ROOT
DEFAULT_OUT = ROOT/'extended'
FRAME = 'binder-gallery-extended-aligned-v1'
TARGET_ORDER = ['cn2','aah2','aah1','lqh3','ts1']
TARGET_NUMBER = dict(zip(TARGET_ORDER,range(1,6)))
MAX_CHAPTERS = 24
MAX_ATOMS = 30_000


def write_json(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2)+'\n')


def fetch_sources(catalog, out, fetch=False):
    """Source lock rejects changed cached bytes; first fetch verifies Git blob."""
    lock_path=out/'source-lock.json'
    lock=json.loads(lock_path.read_text()) if lock_path.exists() else {}
    selected=[e for e in catalog['entries'] if e['phase']=='remaining']
    def obtain(entry):
        source=entry['source'];name=source['file'];path=out/'upstream'/name
        if source['revision']!=base.REVISION or source['predictor']!='ESMFold2' or source['url']!=base.BASE+name:
            raise ValueError('Unexpected public source identity')
        expected=lock.get(name)
        if path.exists():
            raw=path.read_bytes()
            if not expected or base.sha(raw)!=expected['sha256']:
                raise ValueError('Unpinned or changed cached structure: '+name)
            return name,expected
        if not fetch:raise FileNotFoundError(str(path)+': use --fetch for missing public structures')
        with urllib.request.urlopen(source['url'],timeout=60) as response:
            raw=response.read();etag=response.headers.get('ETag','').strip('"');revision=response.headers.get('X-Repo-Commit')
        git=hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
        if revision!=base.REVISION or etag!=git:raise ValueError('Public Git blob/revision verification failed: '+name)
        record=dict(sha256=base.sha(raw),gitBlobSha1=git,bytes=len(raw),revision=revision,url=source['url'])
        if expected and record!=expected:raise ValueError('Published source changed: '+name)
        path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
        return name,record
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(obtain,selected))
    ordered={name:record for name,record in results}
    write_json(lock_path,ordered)
    return ordered


def check_atoms(atoms, binder_sequence, target_sequence):
    base.verify_sequence(atoms,'A',binder_sequence);base.verify_sequence(atoms,'B',target_sequence)
    identities=[(a['chain'],a['residue'],a['name'],a['alt']) for a in atoms]
    if len(set(identities))!=len(identities):raise ValueError('Duplicate atom identity')


def reference_entries(catalog, parsed):
    manifest=json.loads((ROOT/'manifest.json').read_text());refs={}
    for entry in manifest['entries']:
        target_id=next(e['targetId'] for e in catalog['entries'] if e['uuid']==entry['uuid'])
        if target_id in refs:continue
        atoms=base.parse_pdb((ROOT/'upstream'/entry['sourceFile']).read_text())
        refs[target_id]=dict(entry,_atoms=atoms)
    first=next(e for e in catalog['entries'] if e['targetId']=='ts1')
    atoms=parsed[first['uuid']];rotation,translation=base.canonical_frame(atoms)
    design=next(row for row in base.rows(ROOT/'upstream/design.csv') if row['uuid']==first['uuid'])
    toxin=next(row for row in base.rows(ROOT/'upstream/toxins.csv') if row['toxin']=='Ts1')
    refs['ts1']=dict(uuid=first['uuid'],binderLabel='Ts1ReferenceDesign',targetLabel='Ts1ReferenceTarget',
        binderChain='RB05',targetChain='RT05',binderSequence=design['sequence'],targetSequence=toxin['sequence'],
        sourceFile=first['source']['file'],sourceUrl=first['source']['url'],_atoms=atoms,
        alignment=dict(matrix=np.column_stack((rotation,translation)).tolist()))
    return refs


def prepare_entries(catalog,out,lock):
    designs={r['uuid']:r for r in base.rows(ROOT/'upstream/design.csv')}
    toxins={r['toxin']:r for r in base.rows(ROOT/'upstream/toxins.csv')}
    parsed={}
    for entry in catalog['entries']:
        if entry['phase']!='remaining':continue
        atoms=base.parse_pdb((out/'upstream'/entry['source']['file']).read_text())
        check_atoms(atoms,designs[entry['uuid']]['sequence'],toxins[entry['target']]['sequence']);parsed[entry['uuid']]=atoms
    refs=reference_entries(catalog,parsed);entries=[]
    for entry in catalog['entries']:
        if entry['phase']!='remaining':continue
        atoms=parsed[entry['uuid']];reference=refs[entry['targetId']]
        r,t,rmsd=base.rigid_fit(base.target_ca(atoms),base.target_ca(reference['_atoms']))
        frame=np.array(reference['alignment']['matrix']);matrix=np.column_stack((frame[:,:3]@r,frame[:,:3]@t+frame[:,3]))
        if not np.allclose(matrix[:,:3].T@matrix[:,:3],np.eye(3),atol=1e-12) or abs(np.linalg.det(matrix[:,:3])-1)>1e-12:
            raise ValueError('Alignment is not a proper rigid transformation')
        design=designs[entry['uuid']];toxin=toxins[entry['target']];ordinal=entry['globalOrdinal']
        e=dict(id=entry['id'],uuid=entry['uuid'],globalOrdinal=ordinal,displayLabel=entry['displayLabel'],target=entry['target'],targetId=entry['targetId'],
            binderLabel=entry['displayLabel'],targetLabel='Target'+str(TARGET_NUMBER[entry['targetId']]),binderChain=f'D{ordinal:03d}',targetChain=f'P{ordinal:03d}',
            binderSequence=design['sequence'],targetSequence=toxin['sequence'],source=copy.deepcopy(entry['source']),
            originalChainMapping={'A':f'D{ordinal:03d}','B':f'P{ordinal:03d}'},atomCount=len(atoms),_atoms=atoms,
            alignment=dict(method='Equal-weight target CA Kabsch; identical proper rigid transform applied to both original chains',
                matrix=matrix.tolist(),targetCaRmsdAngstrom=rmsd,referenceUuid=reference['uuid'],coordinateFrame=FRAME),
            presentationReferenceTarget=dict(chain=reference['targetChain'],uuid=reference['uuid'],sourceFile=reference['sourceFile'],
                description='Same canonical target atoms and absolute coordinates in every batch; aligned-reference overlay differs from original predicted pair'),
            selection=entry['selection'],assay=next(x for x in entry['targets']if x['id']==entry['targetId']),
            spatial=base.spatial_summary(atoms,matrix))
        e['source'].update(lock[entry['source']['file']]);e['source']['downloaded']=True
        moved=base.moved_atoms(e);fixed=base.moved_atoms(reference)
        e['contacts']=dict(originalPair=base.proximity_contacts([a for a in atoms if a['chain']=='A'],[a for a in atoms if a['chain']=='B'],e['binderChain'],e['targetChain'],'original published predicted pair, unchanged by its common rigid transform'),
            referenceOverlay=base.proximity_contacts([a for a in moved if a['chain']=='A'],[a for a in fixed if a['chain']=='B'],e['binderChain'],reference['targetChain'],'displayed aligned-reference overlay, coordinates rounded to 9 decimals'))
        entries.append(e)
    return sorted(entries,key=lambda e:(TARGET_ORDER.index(e['targetId']),e['globalOrdinal'])),refs


def label_for(entry):
    alias=re.sub(r'^Design(\d+)$',r'Design \1',entry['displayLabel']);assay=entry['assay']['assays']['adaptyv']
    if entry['selection']['basis']=='adaptyv_hit_kd':
        kd=assay['kd'];q={'approximate':'≈','upper_limit':'≤'}.get(kd['qualifier'],'')
        label=f"{alias} · Adaptyv KD {q}{kd['reported']} nM · not selected"
    else:
        score=entry['assay']['computational']['finalScore'];result=assay['result']
        status='Adaptyv no hit' if result=='no hit' else 'Adaptyv hit; KD n/a' if result=='hit' else 'Adaptyv unreported'
        label=f'{alias} · Pred. score {score:.3f} · {status}'
    if len(label)>60:raise ValueError('Label exceeds existing figure text bound: '+label)
    return label


def chapter_for(entry,template):
    chapter=copy.deepcopy(template);chain=entry['binderChain'];target_chain=entry['presentationReferenceTarget']['chain']
    display=entry['displayLabel'].replace('Design','Design ');target=f"Target {TARGET_NUMBER[entry['targetId']]} · {entry['target']}"
    chapter.update(id=entry['id'],title=f'{display} · {target}',caption='Other tested design, not one of the 17 qualified binders. Published predicted structure aligned to a fixed toxin reference. Close residue pairs are geometric examples only.',durationSeconds=3,changes=[dict(kind='hold',durationSeconds=3)])
    immersive=chapter['immersive'];immersive['visibility']['chains']=[chain,target_chain]
    immersive['parts'][0].update(label=display,chain=chain,aliases=[entry['displayLabel'],entry['uuid'],'design protein'])
    immersive['parts'][1].update(label=target,chain=target_chain,aliases=['target','toxin',entry['target']])
    examples=entry['contacts']['referenceOverlay']['displayExamples']
    layers=[]
    for layer in immersive['figure']['layers']:
        binder=layer['id'].startswith('binder-');layer['target']={'chain':chain if binder else target_chain}
        if layer['id'].endswith('nearby-sidechains'):
            residues=examples['binder' if binder else 'target']['residueNumbers']
            if not residues:continue
            layer['target']['residueNumbers']=residues
        layers.append(layer)
    immersive['figure']['layers']=layers
    labels=immersive['figure']['labels'];labels[0]['target']={'chain':chain};labels[0]['text']=label_for(entry)
    labels[1]['target']={'chain':target_chain};labels[1]['text']=target
    for label in labels:label['placement']='outside-figure'
    chapter['details']=f"Catalog alias: {entry['displayLabel']} · UUID: {entry['uuid']}\n{label_for(entry)}\nThis design is not in the published 17 qualified binders. {entry['selection']['reason']}\nPred. score is the published final_score (0–1), not measured binding or neutralization. Adaptyv KD, where shown, measures binding only.\nDisplay: this binder is rigidly aligned to the canonical {entry['target']} target. The same transform preserves both original chains in the source composite; only the shared reference target is displayed. This overlay differs from the original predicted complex.\nFour or fewer illustrative side-chain proximity pairs within 4.5 Å; not proven interactions or key sites. Full original-pair and overlay contacts, original atom identities and the transform are in this batch manifest.\nOriginal coordinates: {entry['source']['url']}\nAnthropic, PBC (2026), CC BY 4.0. Dataset methods, assay qualifications and third-party credits are retained in the original gallery provenance."
    return chapter


def batches_for(entries,refs):
    batches=[];current=[]
    def count(items):
        targets={e['targetId']for e in items}
        return sum(e['atomCount']for e in items)+sum(len(refs[t]['_atoms'])for t in targets)
    for entry in entries:
        if current and (len(current)>=MAX_CHAPTERS or count(current+[entry])>MAX_ATOMS):batches.append(current);current=[]
        current.append(entry)
        if count(current)>MAX_ATOMS:raise ValueError('One source exceeds batch atom budget')
    if current:batches.append(current)
    return batches


def prepare(out=DEFAULT_OUT,fetch=False,update_index=False):
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    catalog_path=ROOT/'catalog.json';catalog=json.loads(catalog_path.read_text())
    if catalog['revision']!=base.REVISION or len(catalog['entries'])!=211:raise ValueError('Unexpected catalog identity')
    lock=fetch_sources(catalog,out,fetch);entries,refs=prepare_entries(catalog,out,lock);groups=batches_for(entries,refs)
    original=json.loads((ROOT/'lesson.json').read_text());stages=[]
    selected=copy.deepcopy(original);selected['id']='binder-gallery-extended-selected17';selected['title']='17 qualified binders · published results'
    selected['presentation'].update(coordinateFrame=FRAME,continueToStage='batch-01')
    for chapter in selected['chapters']:
        chapter['durationSeconds']=3;chapter['changes']=[dict(kind='hold',durationSeconds=3)]
        for label in chapter['immersive']['figure']['labels']:label['placement']='outside-figure'
    selected_path=out/'selected17/lesson.json';write_json(selected_path,selected)
    index=json.loads((ROOT.parent/'index.json').read_text());existing=next(e for e in index['demos']if e['name']=='binder-gallery')
    def stage(stage_id,title,lesson_path,coordinates,order):
        return dict(id=stage_id,order=str(order),title=title,sourceId=base.DATASET,tiers=['quest2','quest3'],lesson=lesson_path,
            coordinates=coordinates,sources=copy.deepcopy(existing['sources']))
    lesson_rel=lambda path:path.relative_to(ROOT.parent).as_posix() if path.is_relative_to(ROOT.parent) else 'binder-gallery/extended/'+path.relative_to(out).as_posix()
    stages.append(stage('selected17',selected['title'],lesson_rel(selected_path),copy.deepcopy(existing['coordinates']),0))
    summary=[]
    for number,group in enumerate(groups,1):
        stage_id=f'batch-{number:02d}';directory=out/stage_id;directory.mkdir(exist_ok=True)
        used=[t for t in TARGET_ORDER if any(e['targetId']==t for e in group)];sources=[refs[t]for t in used]+group
        cif=base.cif_text(sources,'binder_extended_'+stage_id.replace('-','_'));cif_path=directory/'gallery.cif';cif_path.write_text(cif)
        lesson=copy.deepcopy(original);lesson['id']='binder-gallery-extended-'+stage_id
        lesson['title']=f'Other tested designs · batch {number}/{len(groups)}';lesson['chapters']=[chapter_for(e,original['chapters'][0])for e in group]
        lesson['provenance']['sourceSha256']=base.sha(cif.encode());lesson['provenance']['note']='Published predicted ESMFold2 structures, one approved intended-toxin pair per remaining design. These are not the published 17 qualified binders. Assay status stays on screen; predicted score is not measured binding or neutralization. Canonical toxin atoms are identical across batches. Both original chains retain their original relative geometry under one common proper rigid transform; the displayed steady overlay substitutes the canonical target. No sequences, atoms, occupancy or B-factors were changed. Source lock, matrices, original/overlay contacts and immutable revision are in the extended manifests.'
        lesson['presentation']=dict(captionCard='hidden',end='hold',coordinateFrame=FRAME)
        if number<len(groups):lesson['presentation']['continueToStage']=f'batch-{number+1:02d}'
        lesson_path=directory/'lesson.json';write_json(lesson_path,lesson)
        atom_count=sum(len(e['_atoms'])for e in sources)
        coords=dict(file=f'binder-gallery-extended-{stage_id}.cif',sha256=base.sha(cif.encode()),bytes=len(cif.encode()),atomSites=atom_count,
            derivation=dict(kind='bundled-file',path=lesson_rel(cif_path)))
        stages.append(stage(stage_id,lesson['title'],lesson_rel(lesson_path),coords,number))
        references=[dict(targetId=t,uuid=refs[t]['uuid'],sourceFile=refs[t]['sourceFile'],chain=refs[t]['targetChain'],
            matrix=refs[t]['alignment']['matrix'],displayedTargetSha256=base.sha(json.dumps([a for a in base.moved_atoms(refs[t])if a['chain']=='B'],sort_keys=True).encode()))for t in used]
        manifest=dict(version=1,id='binder-gallery-extended-'+stage_id,dataset=base.DATASET,revision=base.REVISION,license='CC-BY-4.0',coordinateFrame=FRAME,
            composite=coords,sharedReferences=references,entries=[{k:v for k,v in e.items()if not k.startswith('_')}for e in group])
        write_json(directory/'manifest.json',manifest)
        summary.append(dict(stage=stage_id,chapterCount=len(group),atomCount=atom_count,globalOrdinals=[e['globalOrdinal']for e in group],
            targets=used,sha256=coords['sha256'],lessonSha256=base.sha(lesson_path.read_bytes())))
    demo=dict(name='binder-gallery-extended',title='Published 17 binders, then all other tested designs',sourceId=base.DATASET,
        lesson=stages[0]['lesson'],coordinates=stages[0]['coordinates'],sources=stages[0]['sources'],stageMode='sequence',defaultStage='selected17',stages=stages)
    write_json(out/'demo-index-entry.json',demo)
    result=dict(version=1,dataset=base.DATASET,revision=base.REVISION,coordinateFrame=FRAME,catalogSha256=base.sha(catalog_path.read_bytes()),
        sourceCount=len(lock),designCount=194,selectedFirstCount=17,maxChapters=MAX_CHAPTERS,maxAtoms=MAX_ATOMS,batches=summary,
        playbackOrder=['selected17']+[s['stage']for s in summary],globalOrdinalsInPlaybackOrder=[e['globalOrdinal']for group in groups for e in group])
    write_json(out/'manifest.json',result)
    if update_index:
        if out.resolve()!=DEFAULT_OUT.resolve():raise ValueError('--update-index requires canonical output directory')
        index['demos']=[e for e in index['demos']if e['name']!='binder-gallery-extended']+[demo]
        write_json(ROOT.parent/'index.json',index)
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--fetch',action='store_true');parser.add_argument('--out',type=Path,default=DEFAULT_OUT)
    parser.add_argument('--update-index',action='store_true',help='Update only the new extended demo entry, preserving every existing demo')
    args=parser.parse_args();result=prepare(args.out,args.fetch,args.update_index)
    print(json.dumps(result,indent=2))
