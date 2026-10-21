#!/usr/bin/env python3
"""Prepare the pinned published binder gallery. Requires Python 3 + numpy.

Network access is explicit (--fetch); without it every upstream file must exist.
Only the six metadata files and seventeen selected complexes are requested.
No prediction, relaxation, sequence modification, or coordinate minimization occurs.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
from pathlib import Path
import urllib.request
import numpy as np

REVISION = '0bac3d0286f7f83b5339f5b4f1e67fbe47a6e7c1'
DATASET = 'Anthropic/scorpion-toxin-binder-design'
BASE = f'https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/'
TARGETS = ['Cn2', 'AaH II', 'AaH I', 'LqhIII']
METADATA = ['design.csv', 'toxins.csv', 'structures/INDEX.csv', 'LICENSE.md', 'README.md', 'COLUMNS.md']
# Independently pin the selected upstream byte streams as well as their repository revision.
PINNED_SHA256 = {'design.csv': '3eb9dc87ee7582120c6a1cf74164d0c611ba269d76a85487b846acd688bfd604',
 'toxins.csv': 'db210add8b09541ad36ab512910519216e2c9fd160ab9a0117ad1c797fd39379',
 'structures/INDEX.csv': 'c6d7e2ad30c030c26c5204a8daacf95e9ae1c84c933c27027902fc3d8c23e5ec',
 'LICENSE.md': '88292231d09bee28d11954d8cf3cbaf91532ecc8f338656ebf997ffa3508f980',
 'README.md': 'e9bec8366a27f77277a39438e034c99863c3d6843b8cd7f9ff02bc31b0c21fca',
 'COLUMNS.md': '8762d877f154009710c4d7f8cdd6703fe412a2f8c6b2296038d5f08dfb34b6a2',
 'structures/02090d8c/02090d8c_esmfold2-cn2.pdb': 'b3200ad4c2421905f5eeffbee4c46e23c0cde8ac8b3e4c3724b59cce210a66d2',
 'structures/888c8f04/888c8f04_esmfold2-cn2.pdb': '56c927034d0ec89159670eee01ff0143321cae3bbada74f6658331dc60fa79aa',
 'structures/8ac202c8/8ac202c8_esmfold2-cn2.pdb': '9be780c3ea221227981222d62fdc96d3a3424332c4ba6c139ea79a4b09380503',
 'structures/66c2cc29/66c2cc29_esmfold2-cn2.pdb': '4c79c8617ad4cb6255403e3327270b4c8c7507dac2bcf77dd8710bc94dc1f5d9',
 'structures/5f5b71ad/5f5b71ad_esmfold2-cn2.pdb': '9503b5dc481f1689ec2daeb8b9faefd1bbc04b19f60941396070a61709d2e5b8',
 'structures/9d008884/9d008884_esmfold2-cn2.pdb': 'e47d41d82fb0f6fc34aac0fedeaa846c2caec3fac315d0d5ba4564087a92fd23',
 'structures/b6d46ba0/b6d46ba0_esmfold2-cn2.pdb': 'b74494d3fe475878c1f2374dda316b0800323cdcd9a1e02c23a28fc3b3a46f36',
 'structures/a199ee01/a199ee01_esmfold2-aah2.pdb': 'd511d3df0d0361f5d477fa7eca84688394c12737929086808b153d6060672e5c',
 'structures/d2a254ba/d2a254ba_esmfold2-aah2.pdb': 'f60234ad819cddd1182c9f04e6aede0b967d6c7203173bcd39cd64763c648b68',
 'structures/96ee6417/96ee6417_esmfold2-aah2.pdb': '0694b8d6925053af776c9bdd9328af72daecbcd283be127035a42c79f95943da',
 'structures/8f156315/8f156315_esmfold2-aah2.pdb': 'f1417887802740ce4ef1bc905210f6eab88555ce699df93fac4754c9852da03d',
 'structures/30fc4a66/30fc4a66_esmfold2-aah1.pdb': 'aee28cbe4624f5788aae6c199a85a7e2be7d6df10bb0ca6c7d8952ff329c3dc5',
 'structures/03131527/03131527_esmfold2-aah1.pdb': '4d6cbbdcf49a4c706df04141b21768e2e5b4524f8c31acb4cd6a9d109087296f',
 'structures/9cad7527/9cad7527_esmfold2-aah1.pdb': '2c16e94f35af130c9040f0b42cf3cba09d0dc4569555185f9e67c976af2c3939',
 'structures/8ebe5db2/8ebe5db2_esmfold2-aah1.pdb': 'e67dfdb4e3a3a39c5fe203f0dd80bf7094bfc605abeaec080d95e0e1302ca8df',
 'structures/dceea244/dceea244_esmfold2-lqh3.pdb': '93e09b1df729f195dca14f4c74cfb83e7342db7c2aef2154223b8e64d3963fe6',
 'structures/dbb87a88/dbb87a88_esmfold2-lqh3.pdb': 'f1e1b2b97d57d725fa8f354efc02a8aefb1a589946f6c2cd68eaf3b824d43eda'}
AA3 = dict(zip('ARNDCQEGHILKMFPSTWYV', 'ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL'.split()))
AA1 = {v:k for k,v in AA3.items()}
DEFAULT_ROOT = Path(__file__).resolve().parents[1] / 'demos/binder-gallery'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def fetch_file(root, name, fetch=False):
    path = root / 'upstream' / name
    if not path.exists():
        if not fetch:
            raise FileNotFoundError(f'{path}: run with --fetch to retrieve this pinned public file')
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(BASE + name, timeout=60) as response:
            path.write_bytes(response.read())
    expected = PINNED_SHA256.get(name)
    if expected is None or sha(path.read_bytes()) != expected:
        raise ValueError(f'Pinned upstream digest mismatch: {name}')
    return path

def rows(path):
    with path.open(newline='') as handle:
        return list(csv.DictReader(handle))

def select_designs(designs, index):
    selected = []
    for target in TARGETS:
        for design in designs:
            if design['binder_against'] != target:
                continue
            matches = [r for r in index if r['uuid'] == design['uuid'] and
                       r['kind'] == 'predicted complex' and r['predictor'] == 'ESMFold2' and r['toxin'] == target]
            if len(matches) != 1:
                raise ValueError(f"Expected one ESMFold2 complex for {design['uuid']} against {target}")
            selected.append((design, matches[0]))
    if len(selected) != 17 or [sum(d['binder_against'] == t for d,_ in selected) for t in TARGETS] != [7,4,4,2]:
        raise ValueError('Pinned binder set must have target counts 7,4,4,2')
    return selected

def parse_pdb(text):
    atoms = []
    for line in text.splitlines():
        if line.startswith(('ATOM  ', 'HETATM')):
            atoms.append(dict(group=line[:6].strip(), serial=int(line[6:11]), name=line[12:16].strip(),
                alt=line[16].strip(), comp=line[17:20].strip(), chain=line[21], residue=int(line[22:26]),
                insertion=line[26].strip(), xyz=[float(line[30:38]), float(line[38:46]), float(line[46:54])],
                occupancy=float(line[54:60]), b=float(line[60:66]), element=line[76:78].strip(),
                charge=line[78:80].strip()))
    if not atoms or set(a['chain'] for a in atoms) != {'A','B'}:
        raise ValueError('Expected exactly original chains A (binder) and B (target)')
    if any(a['alt'] or a['insertion'] or a['group'] != 'ATOM' for a in atoms):
        raise ValueError('Unexpected nonstandard atom identity in pinned input')
    if not np.isfinite(np.array([a['xyz'] for a in atoms])).all():
        raise ValueError('Non-finite coordinate')
    return atoms

def verify_sequence(atoms, chain, expected):
    residues = {}
    for atom in atoms:
        if atom['chain'] == chain:
            old = residues.setdefault(atom['residue'], atom['comp'])
            if old != atom['comp']:
                raise ValueError('Conflicting residue identity')
    if list(residues) != list(range(1,len(expected)+1)) or ''.join(AA1[r] for r in residues.values()) != expected:
        raise ValueError(f'Chain {chain} does not exactly match declared sequence')
    ca = [a for a in atoms if a['chain'] == chain and a['name'] == 'CA']
    if len(ca) != len(expected) or len({a['residue'] for a in ca}) != len(expected):
        raise ValueError('Need one CA per declared residue')

def target_ca(atoms):
    return np.array([a['xyz'] for a in atoms if a['chain']=='B' and a['name']=='CA'], dtype=float)

def rigid_fit(mobile, fixed):
    """Equal-weight CA Kabsch: column-vector y = R x + t; proper rotation only."""
    mobile_center, fixed_center = mobile.mean(axis=0), fixed.mean(axis=0)
    u, _, vt = np.linalg.svd((mobile-mobile_center).T @ (fixed-fixed_center))
    correction = np.eye(3)
    correction[2,2] = np.linalg.det(vt.T @ u.T)
    rotation = vt.T @ correction @ u.T
    translation = fixed_center - rotation @ mobile_center
    transformed = mobile @ rotation.T + translation
    rmsd = float(np.sqrt(np.mean(np.sum((transformed-fixed)**2,axis=1))))
    return rotation, translation, rmsd

def canonical_frame(atoms):
    """Orient reference binder above target (+Y); center their CA centroids."""
    target = target_ca(atoms).mean(axis=0)
    binder = np.array([a['xyz'] for a in atoms if a['chain']=='A' and a['name']=='CA']).mean(axis=0)
    y = binder-target
    y /= np.linalg.norm(y)
    # Principal target axis supplies a reproducible side-to-side orientation.
    _, _, vt = np.linalg.svd(target_ca(atoms)-target)
    x = vt[0] - np.dot(vt[0],y)*y
    if np.linalg.norm(x) < 1e-8:
        x = vt[1] - np.dot(vt[1],y)*y
    x /= np.linalg.norm(x)
    # Resolve the PCA sign from the vector to the target's first CA.
    if np.dot(x,target_ca(atoms)[0]-target) < 0:
        x = -x
    z = np.cross(x,y)
    rotation = np.stack([x,y,z])
    translation = -rotation @ ((target+binder)/2)
    return rotation, translation

def spatial_summary(atoms, matrix):
    rotation,translation=matrix[:,:3],matrix[:,3]
    xyz=np.array([a['xyz'] for a in atoms]) @ rotation.T + translation
    summary=dict(boundsAngstrom=dict(min=xyz.min(axis=0).tolist(),max=xyz.max(axis=0).tolist()),
                 centerAngstrom=((xyz.min(axis=0)+xyz.max(axis=0))/2).tolist())
    for role,chain in [('binder','A'),('target','B')]:
        indices=[i for i,a in enumerate(atoms) if a['chain']==chain]
        ca=[i for i,a in enumerate(atoms) if a['chain']==chain and a['name']=='CA']
        summary[role+'BoundsAngstrom']=dict(min=xyz[indices].min(axis=0).tolist(),max=xyz[indices].max(axis=0).tolist())
        summary[role+'CaCentroidAngstrom']=xyz[ca].mean(axis=0).tolist()
    return summary

def moved_atoms(entry):
    matrix=np.array(entry['alignment']['matrix'])
    return [dict(atom,xyz=np.round(matrix[:,:3] @ np.array(atom['xyz'])+matrix[:,3],9).tolist())
            for atom in entry['_atoms']]

def display_sidechain_examples(binder_atoms,target_atoms,binder_chain,target_chain):
    """Four geometric examples, never an energy/functional selection or optimization."""
    backbone={'N','CA','C','O','OXT'}
    def sidechains(atoms):
        result={}
        for atom in atoms:
            if atom['element'].upper() not in ('H','D') and atom['name'] not in backbone:
                result.setdefault(atom['residue'],[]).append(atom['xyz'])
        return {residue:np.array(xyz) for residue,xyz in result.items()}
    binder=sidechains(binder_atoms);target=sidechains(target_atoms)
    candidates=[]
    for b,bxyz in binder.items():
        for t,txyz in target.items():
            distance=float(np.sqrt(np.min(np.sum((bxyz[:,None,:]-txyz[None,:,:])**2,axis=-1))))
            if distance <= 4.5:
                candidates.append((distance,b,t))
    selected=[];used_binder=set();used_target=set()
    for distance,b,t in sorted(candidates):
        if b in used_binder or t in used_target:
            continue
        selected.append(dict(binderResidueNumber=b,targetResidueNumber=t,minimumSidechainHeavyAtomDistanceAngstrom=distance))
        used_binder.add(b);used_target.add(t)
        if len(selected)==4:
            break
    return dict(selectionMethod='Sort side-chain heavy-atom residue pairs at or below 4.5 Angstrom by minimum distance, then binder/target author residue number; take first four with no reused residue on either side',
                atomSelection='Exclude H/D and backbone N, CA, C, O, OXT; residues without side-chain heavy atoms cannot supply an example',
                purpose='Small illustrative display subset; not key sites, proven interactions, functional importance or a binder ranking',
                maximumPairs=4,pairs=selected,
                binder=dict(chain=binder_chain,residueNumbers=sorted(used_binder)),
                target=dict(chain=target_chain,residueNumbers=sorted(used_target)))

def proximity_contacts(binder_atoms,target_atoms,binder_chain,target_chain,coordinate_mode):
    """Geometric proximity only, including all backbone and side-chain heavy atoms."""
    binder=[a for a in binder_atoms if a['element'].upper() not in ('H','D')]
    target=[a for a in target_atoms if a['element'].upper() not in ('H','D')]
    binder_xyz=np.array([a['xyz'] for a in binder]); target_xyz=np.array([a['xyz'] for a in target])
    squared=np.sum((binder_xyz[:,None,:]-target_xyz[None,:,:])**2,axis=-1)
    pairs=np.argwhere(squared <= 4.5**2)
    return dict(method='Inter-chain heavy-atom minimum-distance proximity; any atom pair at or below cutoff',
                cutoffAngstrom=4.5,coordinateMode=coordinate_mode,
                atomSelection='All ATOM sites with element other than H or D; backbone and side-chain atoms included',
                interpretation='Geometric proximity only; not a bond assignment, functional claim, affinity estimate or ranking',
                binder=dict(chain=binder_chain,originalChain='A',residueNumbers=sorted({binder[i]['residue'] for i,_ in pairs})),
                target=dict(chain=target_chain,originalChain='B',residueNumbers=sorted({target[j]['residue'] for _,j in pairs})),
                displayExamples=display_sidechain_examples(binder_atoms,target_atoms,binder_chain,target_chain))

def cif_token(value):
    value = str(value)
    if value in ('.','?'):
        return value
    if not value or any(ch.isspace() for ch in value) or value[0] in '#_$;\'"' or "'" in value or '"' in value:
        if '\n' in value or ("'" in value and '"' in value):
            raise ValueError('Unsupported multiline CIF token')
        return ('"'+value+'"') if "'" in value else ("'"+value+"'")
    return value

def cif_text(entries, data_id):
    output = [f'data_{data_id}', '#', f'_entry.id {data_id}', '#']
    def loop(category, fields, data):
        output.extend(['loop_'] + [f'_{category}.{f}' for f in fields])
        output.extend(' '.join(cif_token(x) for x in row) for row in data)
        output.append('#')
    chains = []
    for entry in entries:
        for role, source_chain, seq_key in [('binder','A','binderSequence'),('target','B','targetSequence')]:
            chains.append((entry, role, source_chain, entry[role+'Chain'], entry[seq_key]))
    entities = {chain: str(i+1) for i,(_,_,_,chain,_) in enumerate(chains)}
    loop('entity', ['id','type','pdbx_description'],
         [(entities[c], 'polymer', e[role+'Label']) for e,role,_,c,_ in chains])
    loop('entity_poly', ['entity_id','type','nstd_linkage','nstd_monomer','pdbx_seq_one_letter_code','pdbx_seq_one_letter_code_can','pdbx_strand_id'],
         [(entities[c],'polypeptide(L)','no','no',seq,seq,c) for _,_,_,c,seq in chains])
    loop('entity_poly_seq', ['entity_id','num','mon_id','hetero'],
         [(entities[c], i, AA3[a], 'n') for _,_,_,c,seq in chains for i,a in enumerate(seq,1)])
    loop('struct_asym', ['id','entity_id','details'], [(c, entities[c], f"{e[role+'Label']} from {e['uuid']}") for e,role,_,c,_ in chains])
    loop('pdbx_poly_seq_scheme', ['asym_id','entity_id','seq_id','mon_id','ndb_seq_num','pdb_seq_num','auth_seq_num','pdb_mon_id','auth_mon_id','pdb_strand_id','pdb_ins_code','hetero'],
         [(c,entities[c],i,AA3[a],i,i,i,AA3[a],AA3[a],c,'.','n') for _,_,_,c,seq in chains for i,a in enumerate(seq,1)])
    components = sorted({a['comp'] for e in entries for a in e['_atoms']})
    loop('chem_comp',['id','type','mon_nstd_flag','name'],[(a,'L-peptide linking','n',a) for a in components])
    fields = ['group_PDB','id','type_symbol','label_atom_id','label_alt_id','label_comp_id','label_asym_id','label_entity_id','label_seq_id','pdbx_PDB_ins_code','Cartn_x','Cartn_y','Cartn_z','occupancy','B_iso_or_equiv','pdbx_formal_charge','auth_seq_id','auth_comp_id','auth_asym_id','auth_atom_id','pdbx_PDB_model_num']
    atom_rows=[]
    for e in entries:
        matrix=np.array(e['alignment']['matrix'])
        for a in e['_atoms']:
            chain=e['binderChain'] if a['chain']=='A' else e['targetChain']
            xyz=matrix[:,:3]@np.array(a['xyz'])+matrix[:,3]
            atom_rows.append([a['group'],len(atom_rows)+1,a['element'],a['name'],a['alt'] or '.',a['comp'],chain,entities[chain],a['residue'],a['insertion'] or '?',*[f'{v:.9f}' for v in xyz],f"{a['occupancy']:.2f}",f"{a['b']:.2f}",a['charge'] or '?',a['residue'],a['comp'],chain,a['name'],1])
    loop('atom_site', fields, atom_rows)
    return '\n'.join(output)+'\n'

def prepare(root=DEFAULT_ROOT, fetch=False):
    root=Path(root)
    for name in METADATA:
        fetch_file(root,name,fetch)
    upstream=root/'upstream'
    designs=rows(upstream/'design.csv'); index=rows(upstream/'structures/INDEX.csv')
    toxins={r['toxin']:r for r in rows(upstream/'toxins.csv')}
    entries=[]; references={}
    for i,(design,source) in enumerate(select_designs(designs,index),1):
        target=design['binder_against']; toxin=toxins[target]
        raw_path=fetch_file(root,'structures/'+source['file'],fetch)
        raw=raw_path.read_bytes(); atoms=parse_pdb(raw.decode('utf-8'))
        if int(design['length_aa']) != len(design['sequence']) or int(toxin['length_aa']) != len(toxin['sequence']):
            raise ValueError('Declared sequence length mismatch')
        verify_sequence(atoms,'A',design['sequence']); verify_sequence(atoms,'B',toxin['sequence'])
        mobile=target_ca(atoms)
        if target not in references:
            references[target]=(f'Binder{i:02d}',mobile,canonical_frame(atoms))
        reference_label,fixed,(frame_rotation,frame_translation)=references[target]
        if reference_label == f'Binder{i:02d}':
            rotation=np.eye(3); translation=np.zeros(3); rmsd=0.0
        else:
            rotation,translation,rmsd=rigid_fit(mobile,fixed)
        fit_matrix=np.column_stack((rotation,translation))
        matrix=np.column_stack((frame_rotation @ rotation, frame_rotation @ translation + frame_translation))
        e=dict(slide=i,id=f'binder-{i:02d}',binderLabel=f'Binder{i:02d}',targetLabel=f'Target{TARGETS.index(target)+1}',
               binderChain=f'B{i:02d}',targetChain=f'T{i:02d}',uuid=design['uuid'],originalName=design['name'],target=target,
               predictor='ESMFold2',kind='published predicted complex',designSet=design['design_set'],binderFormat=design['format'],
               binderSequence=design['sequence'],targetSequence=toxin['sequence'],sourceFile='structures/'+source['file'],
               sourceUrl=BASE+'structures/'+source['file'],sourceSha256=sha(raw),sourceBytes=len(raw),
               atomCount=len(atoms),binderAtomCount=sum(a['chain']=='A' for a in atoms),targetAtomCount=sum(a['chain']=='B' for a in atoms),
               originalChainMapping={'A':f'B{i:02d}','B':f'T{i:02d}'},
               targetProvenance={k:toxin[k] for k in ['UniProt','residues_in_UniProt','structure_prepared_as_design_target','disulfides','native_C_terminus_amidated']},
               alignment=dict(method='equal-weight CA Kabsch, proper rotation',referenceBinder=reference_label,pairedAtomCount=len(mobile),
                              targetCaRmsdAngstrom=rmsd,matrix=matrix.tolist(),fitToReferenceMatrix=fit_matrix.tolist(),canonicalReferenceMatrix=np.column_stack((frame_rotation,frame_translation)).tolist(),convention='row-major 3x4; y = R x + t, column vectors, Angstrom; applied to every atom of both chains'),
               spatial=spatial_summary(atoms,matrix),_atoms=atoms)
        entries.append(e)
    by_label={e['binderLabel']:e for e in entries}
    for e in entries:
        reference=by_label[e['alignment']['referenceBinder']]
        moved=moved_atoms(e); reference_atoms=moved_atoms(reference)
        e['presentationReferenceTarget']=dict(chain=reference['targetChain'],referenceBinderLabel=reference['binderLabel'],
            referenceUuid=reference['uuid'],sourceFile=reference['sourceFile'],sourceSha256=reference['sourceSha256'],
            originalPairTargetChain=e['targetChain'],sameTargetSequenceVerified=e['targetSequence']==reference['targetSequence'],
            description='Optional fixed reference-target comparison: aligned binder from its original model with the target from the first model in this target group. Original pair remains available unchanged.')
        e['contacts']=dict(
            originalPair=proximity_contacts([a for a in e['_atoms'] if a['chain']=='A'],[a for a in e['_atoms'] if a['chain']=='B'],
                e['binderChain'],e['targetChain'],'original-pair: original published PDB coordinates before the common rigid transform'),
            referenceOverlay=proximity_contacts([a for a in moved if a['chain']=='A'],[a for a in reference_atoms if a['chain']=='B'],
                e['binderChain'],reference['targetChain'],'aligned-reference-overlay: aligned binder and fixed group reference target, using the displayed mmCIF coordinates'))
        own_target={(a['residue'],a['name']):np.array(a['xyz']) for a in moved if a['chain']=='B' and a['element'].upper() not in ('H','D')}
        ref_target={(a['residue'],a['name']):np.array(a['xyz']) for a in reference_atoms if a['chain']=='B' and a['element'].upper() not in ('H','D')}
        if own_target.keys() != ref_target.keys():
            raise ValueError('Target heavy-atom identities differ from reference')
        displacements=np.array([np.linalg.norm(own_target[k]-ref_target[k]) for k in own_target])
        e['alignment']['pairedTargetHeavyAtomCount']=len(displacements)
        e['alignment']['targetHeavyAtomRmsdAngstrom']=float(np.sqrt(np.mean(displacements**2)))
        e['alignment']['targetHeavyAtomMaximumDisplacementAngstrom']=float(displacements.max())
    (root/'structures').mkdir(parents=True,exist_ok=True)
    for e in entries:
        path=root/'structures'/f"{e['binderLabel']}.cif"
        text=cif_text([e],e['binderLabel']); path.write_text(text)
        e['normalizedFile']=path.relative_to(root).as_posix();e['normalizedSha256']=sha(text.encode()); e['normalizedBytes']=len(text.encode())
    composite=cif_text(entries,'binder_gallery')
    (root/'gallery.cif').write_text(composite)
    manifest=dict(version=1,id='binder-gallery',dataset=DATASET,revision=REVISION,license='CC-BY-4.0',
                  selection="nonempty design.csv binder_against; INDEX.csv uuid match and kind='predicted complex', predictor='ESMFold2', toxin=binder_against",
                  order='target group Cn2, AaH II, AaH I, LqhIII; original design.csv row order within group',
                  composite=dict(file='gallery.cif',sha256=sha(composite.encode()),bytes=len(composite.encode()),atomCount=sum(e['atomCount'] for e in entries),chainCount=34),
                  changes=['PDB normalized to mmCIF with exact declared full sequences from design.csv and toxins.csv; chain identity verified residue by residue.',
                           'Author/label chain IDs renamed uniquely for slide visibility; original chain mapping retained.',
                           'Reference complexes oriented with binder CA centroid above target (+Y), x from target principal axis projected perpendicular to Y with first-CA sign; their CA-centroid midpoint centered at origin. Each target aligned to the first target within its group using CA atoms; the identical rigid transform applied to both chains. No interatomic geometry changed except coordinate decimal rounding below 1e-9 Angstrom per component.',
                           'Pair-specific target copies retained. No prediction, relaxation, residue edits, inferred bonds, or geometry minimization.',
                           'Original occupancy and B-factor numeric fields retained without reinterpreting them as experimental measurements. Native amidation annotations retained as provenance only; no missing chemistry synthesized.'],
                  upstreamFiles=[dict(file='upstream/'+f,sha256=sha((upstream/f).read_bytes()),bytes=(upstream/f).stat().st_size,url=BASE+f) for f in METADATA],
                  entries=[{k:v for k,v in e.items() if not k.startswith('_')} for e in entries])
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch',action='store_true',help='Fetch only missing pinned upstream files')
    parser.add_argument('--out',type=Path,default=DEFAULT_ROOT)
    args=parser.parse_args()
    manifest=prepare(args.out,args.fetch)
    print(json.dumps(dict(manifest['composite'],file=str(args.out/'gallery.cif')),indent=2))
