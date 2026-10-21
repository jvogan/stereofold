#!/usr/bin/env python3
"""Independent atom/pose/contact/source-lock checks for the public extended gallery."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import numpy as np

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('extended',HERE/'prepare-binder-extended.py')
ext=importlib.util.module_from_spec(spec);spec.loader.exec_module(ext)
ROOT=ext.DEFAULT_OUT

def atoms(path):
    block=path.read_text().split('_atom_site.pdbx_PDB_model_num\n',1)[1].split('\n#',1)[0]
    return [line.split()for line in block.splitlines()if line]

def signature(rows,chain):
    return [(row[2],row[3],row[5],int(row[8]),*row[10:15])for row in rows if row[6]==chain]

class ExtendedGalleryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.summary=json.loads((ROOT/'manifest.json').read_text())
        cls.catalog=json.loads((ext.ROOT/'catalog.json').read_text())
        cls.lock=json.loads((ROOT/'source-lock.json').read_text())
        cls.batches=[(b,json.loads((ROOT/b['stage']/'manifest.json').read_text()),atoms(ROOT/b['stage']/'gallery.cif'))for b in cls.summary['batches']]

    def test_each_remaining_design_once_stable_alias_and_bounded_batches(self):
        expected={e['uuid']:e for e in self.catalog['entries'][17:]};actual=[]
        for batch,manifest,rows in self.batches:
            self.assertLessEqual(len(manifest['entries']),24);self.assertLessEqual(len(rows),30_000)
            self.assertEqual(len(rows),batch['atomCount']);self.assertEqual(ext.base.sha((ROOT/batch['stage']/'gallery.cif').read_bytes()),batch['sha256'])
            for entry in manifest['entries']:
                source=expected[entry['uuid']];actual.append(entry['uuid'])
                self.assertEqual(entry['globalOrdinal'],source['globalOrdinal']);self.assertEqual(entry['displayLabel'],source['displayLabel'])
                self.assertEqual(entry['target'],source['target']);self.assertIn(entry['target'],source['intendedTargets'])
        self.assertEqual(len(actual),194);self.assertEqual(set(actual),set(expected));self.assertEqual(len(set(actual)),194)
        self.assertEqual(sorted(e['globalOrdinal']for _,m,_ in self.batches for e in m['entries']),list(range(18,212)))

    def test_public_source_bytes_sequences_and_all_normalized_atoms_preserved(self):
        for batch,manifest,rows in self.batches:
            bychain={chain:[r for r in rows if r[6]==chain]for chain in {r[6]for r in rows}}
            for e in manifest['entries']:
                raw=(ROOT/'upstream'/e['source']['file']).read_bytes();lock=self.lock[e['source']['file']]
                self.assertEqual(ext.base.sha(raw),lock['sha256']);self.assertEqual(hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest(),lock['gitBlobSha1'])
                original=ext.base.parse_pdb(raw.decode());ext.check_atoms(original,e['binderSequence'],e['targetSequence'])
                matrix=np.array(e['alignment']['matrix']);np.testing.assert_allclose(matrix[:,:3].T@matrix[:,:3],np.eye(3),atol=1e-12)
                self.assertAlmostEqual(np.linalg.det(matrix[:,:3]),1,places=12)
                actual=bychain[e['binderChain']]+bychain[e['targetChain']]
                ordered=[a for chain in ['A','B']for a in original if a['chain']==chain]
                self.assertEqual(len(actual),len(ordered));coords=np.array([[float(x)for x in row[10:13]]for row in actual])
                expected=np.array([a['xyz']for a in ordered])@matrix[:,:3].T+matrix[:,3]
                np.testing.assert_allclose(coords,expected,rtol=0,atol=5.01e-10)
                for a,row in zip(ordered,actual):
                    self.assertEqual((row[2],row[3],row[5],int(row[8]),row[18]),(a['element'],a['name'],a['comp'],a['residue'],e['originalChainMapping'][a['chain']]))
                    self.assertEqual((float(row[13]),float(row[14])),(a['occupancy'],a['b']))
                # The complete cross-protein CA distance matrix independently
                # proves that an original pair was not docked or deformed.
                ca=[i for i,a in enumerate(ordered)if a['name']=='CA'];before=np.array([a['xyz']for a in ordered])[ca];after=coords[ca]
                np.testing.assert_allclose(np.linalg.norm(before[:,None]-before[None,:],axis=-1),np.linalg.norm(after[:,None]-after[None,:],axis=-1),rtol=0,atol=2e-9)

    def test_shared_toxin_coordinates_exact_across_batches_and_original_17(self):
        main=atoms(ext.ROOT/'gallery.cif');seen={}
        for _,manifest,rows in self.batches:
            for ref in manifest['sharedReferences']:
                actual=signature(rows,ref['chain'])
                if ref['targetId']!='ts1':self.assertEqual(actual,signature(main,ref['chain']))
                if ref['targetId']in seen:self.assertEqual(actual,seen[ref['targetId']])
                seen[ref['targetId']]=actual
        self.assertEqual(set(seen),set(ext.TARGET_ORDER))

    def test_displayed_sidechains_are_actual_overlay_proximity_not_functional_claims(self):
        def chain_atoms(rows,chain):return [dict(residue=int(r[8]),name=r[3],element=r[2],xyz=[float(x)for x in r[10:13]])for r in rows if r[6]==chain]
        for _,manifest,rows in self.batches:
            for e in manifest['entries']:
                selected=e['contacts']['referenceOverlay']['displayExamples'];self.assertLessEqual(len(selected['pairs']),4)
                binder=chain_atoms(rows,e['binderChain']);target=chain_atoms(rows,e['presentationReferenceTarget']['chain'])
                for pair in selected['pairs']:
                    def xyz(items,residue):return np.array([a['xyz']for a in items if a['residue']==residue and a['element']not in ['H','D']and a['name']not in ['N','CA','C','O','OXT']])
                    a=xyz(binder,pair['binderResidueNumber']);b=xyz(target,pair['targetResidueNumber']);distance=np.linalg.norm(a[:,None]-b[None,:],axis=-1).min()
                    self.assertLessEqual(distance,4.5+2e-9);self.assertAlmostEqual(distance,pair['minimumSidechainHeavyAtomDistanceAngstrom'],places=8)

    def test_exterior_label_opt_in_changes_only_label_placement(self):
        _,manifest,_=self.batches[0]
        entry=manifest['entries'][0]
        original=json.loads((ext.ROOT/'lesson.json').read_text())
        chapter=ext.chapter_for(entry,original['chapters'][0])
        saved=json.loads((ROOT/'batch-01/lesson.json').read_text())['chapters'][0]
        for label in saved['immersive']['figure']['labels']:label['placement']='outside-figure'
        self.assertEqual(chapter,saved)
        self.assertTrue(all(label['placement']=='outside-figure'for label in chapter['immersive']['figure']['labels']))

    def test_changed_cached_source_rejected_without_network(self):
        entry=self.catalog['entries'][17];name=entry['source']['file']
        with tempfile.TemporaryDirectory()as temp:
            out=Path(temp);path=out/'upstream'/name;path.parent.mkdir(parents=True);path.write_bytes(b'changed public structure')
            ext.write_json(out/'source-lock.json',{name:self.lock[name]})
            with self.assertRaisesRegex(ValueError,'changed cached'):ext.fetch_sources({'entries':[entry]},out)

    def test_offline_regeneration_is_byte_identical_and_does_not_write_existing_gallery(self):
        preserve={p:ext.base.sha(p.read_bytes())for p in [ext.ROOT/'lesson.json',ext.ROOT/'original-pairs.json',ext.ROOT/'gallery.cif',ext.ROOT/'manifest.json']}
        with tempfile.TemporaryDirectory()as temp:
            out=Path(temp);shutil.copytree(ROOT/'upstream',out/'upstream');shutil.copy2(ROOT/'source-lock.json',out/'source-lock.json')
            ext.prepare(out)
            expected=[p.relative_to(ROOT)for p in ROOT.rglob('*')if p.is_file()and'upstream'not in p.relative_to(ROOT).parts and p.suffix in ['.json','.cif']]
            for path in expected:self.assertEqual((out/path).read_bytes(),(ROOT/path).read_bytes(),str(path))
        for path,digest in preserve.items():self.assertEqual(ext.base.sha(path.read_bytes()),digest)

if __name__=='__main__':unittest.main()
