#!/usr/bin/env python3
"""Coordinate, sequence, provenance, and reproducibility checks; no network."""
import copy
import importlib.util
import json
from pathlib import Path
import shlex
import tempfile
import unittest
import numpy as np

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('gallery',HERE/'prepare-binder-gallery.py')
gallery=importlib.util.module_from_spec(spec);spec.loader.exec_module(gallery)
ROOT=gallery.DEFAULT_ROOT

class GalleryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest=json.loads((ROOT/'manifest.json').read_text())
        text=(ROOT/'gallery.cif').read_text()
        atom_block=text.split('_atom_site.pdbx_PDB_model_num\n',1)[1].split('\n#',1)[0]
        cls.cif_atoms=[shlex.split(line) for line in atom_block.splitlines() if line]

    def test_selection_and_declared_sequences(self):
        designs=gallery.rows(ROOT/'upstream/design.csv')
        index=gallery.rows(ROOT/'upstream/structures/INDEX.csv')
        selected=gallery.select_designs(designs,index)
        self.assertEqual([d['uuid'] for d,_ in selected],[e['uuid'] for e in self.manifest['entries']])
        for e in self.manifest['entries']:
            raw=(ROOT/'upstream'/e['sourceFile']).read_bytes()
            self.assertEqual(gallery.sha(raw),e['sourceSha256'])
            atoms=gallery.parse_pdb(raw.decode())
            gallery.verify_sequence(atoms,'A',e['binderSequence'])
            gallery.verify_sequence(atoms,'B',e['targetSequence'])
        corrupted=copy.deepcopy(atoms)
        corrupted[0]['comp']='UNK'
        with self.assertRaises((ValueError,KeyError)):
            gallery.verify_sequence(corrupted,'A',e['binderSequence'])

    def test_rejects_changed_upstream_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'upstream').mkdir()
            (root/'upstream/design.csv').write_bytes(b'altered source')
            with self.assertRaisesRegex(ValueError,'digest mismatch'):
                gallery.fetch_file(root,'design.csv')

    def test_every_atom_preserved_and_same_rigid_transform_applied_to_pair(self):
        self.assertEqual(len(self.cif_atoms),self.manifest['composite']['atomCount'])
        for e in self.manifest['entries']:
            atoms=gallery.parse_pdb((ROOT/'upstream'/e['sourceFile']).read_text())
            actual=[a for a in self.cif_atoms if a[6] in [e['binderChain'],e['targetChain']]]
            self.assertEqual(len(actual),len(atoms))
            matrix=np.array(e['alignment']['matrix']); rotation=matrix[:,:3]
            np.testing.assert_allclose(rotation.T@rotation,np.eye(3),atol=1e-12)
            self.assertAlmostEqual(np.linalg.det(rotation),1,places=12)
            expected=np.array([a['xyz'] for a in atoms])@rotation.T+matrix[:,3]
            coords=np.array([[float(x) for x in a[10:13]] for a in actual])
            np.testing.assert_allclose(coords,expected,rtol=0,atol=5.01e-10)
            for atom,row in zip(atoms,actual):
                self.assertEqual([row[3],row[5],int(row[8]),row[18]], [atom['name'],atom['comp'],atom['residue'],e['originalChainMapping'][atom['chain']]])
                self.assertEqual(float(row[13]),atom['occupancy']); self.assertEqual(float(row[14]),atom['b'])
            # Independent check of cross-interface geometry, not just within-chain distances.
            ca=[i for i,a in enumerate(atoms) if a['name']=='CA']
            original=np.array([a['xyz'] for a in atoms])[ca]
            moved=coords[ca]
            np.testing.assert_allclose(np.linalg.norm(original[:,None]-original[None,:],axis=-1),np.linalg.norm(moved[:,None]-moved[None,:],axis=-1),rtol=0,atol=2e-9)

    def test_alignment_frame_and_target_rmsd(self):
        entries={e['binderLabel']:e for e in self.manifest['entries']}
        def ca(e,chain):
            return np.array([[float(x) for x in a[10:13]] for a in self.cif_atoms if a[6]==e[chain+'Chain'] and a[3]=='CA'])
        for e in entries.values():
            reference=entries[e['alignment']['referenceBinder']]
            actual=np.sqrt(np.mean(np.sum((ca(e,'target')-ca(reference,'target'))**2,axis=1)))
            self.assertAlmostEqual(actual,e['alignment']['targetCaRmsdAngstrom'],places=8)
            if e==reference:
                binder,target=ca(e,'binder').mean(axis=0),ca(e,'target').mean(axis=0)
                np.testing.assert_allclose(binder+target,np.zeros(3),atol=1e-9)
                np.testing.assert_allclose((binder-target)[[0,2]],np.zeros(2),atol=1e-9)
                self.assertGreater(binder[1],target[1])

    def test_proximity_cutoff_is_inclusive_heavy_atom_only_and_noncontiguous(self):
        def atom(residue,xyz,element='C'):
            return dict(residue=residue,xyz=xyz,element=element,name='CB')
        binder=[atom(1,[0,0,0]),atom(9,[20,0,0]),atom(40,[100,0,0],'H')]
        target=[atom(3,[4.5,0,0]),atom(7,[24.50001,0,0]),atom(12,[100,0,0])]
        contact=gallery.proximity_contacts(binder,target,'B05','T01','test geometry')
        self.assertEqual(contact['binder']['residueNumbers'],[1])
        self.assertEqual(contact['target']['residueNumbers'],[3])
        binder.append(atom(9,[20.00001,0,0]))
        contact=gallery.proximity_contacts(binder,target,'B05','T01','test geometry')
        self.assertEqual(contact['binder']['residueNumbers'],[1,9])
        self.assertEqual(contact['target']['residueNumbers'],[3,7])
        self.assertEqual(contact['binder']['chain'],'B05')
        self.assertEqual(contact['target']['chain'],'T01')

    def test_both_contact_modes_match_their_actual_coordinate_sources(self):
        def participating_residues(own,other):
            # Independently evaluate each whole residue's minimum distance.
            other_xyz=np.array([a['xyz'] for a in other if a['element'] not in ('H','D')])
            result=[]
            for residue in sorted({a['residue'] for a in own}):
                coords=np.array([a['xyz'] for a in own if a['residue']==residue and a['element'] not in ('H','D')])
                minimum=min(np.linalg.norm(other_xyz-point,axis=1).min() for point in coords)
                if minimum <= 4.5:
                    result.append(residue)
            return result
        def cif_chain(chain):
            return [dict(residue=int(a[8]),element=a[2],xyz=[float(x) for x in a[10:13]]) for a in self.cif_atoms if a[6]==chain]
        by_label={e['binderLabel']:e for e in self.manifest['entries']}
        for e in self.manifest['entries']:
            original=gallery.parse_pdb((ROOT/'upstream'/e['sourceFile']).read_text())
            reference=by_label[e['alignment']['referenceBinder']]
            self.assertEqual(e['presentationReferenceTarget']['chain'],reference['targetChain'])
            self.assertEqual(e['presentationReferenceTarget']['sourceSha256'],reference['sourceSha256'])
            self.assertTrue(e['presentationReferenceTarget']['sameTargetSequenceVerified'])
            for mode in ['originalPair','referenceOverlay']:
                contact=e['contacts'][mode]
                if mode=='originalPair':
                    binder=[a for a in original if a['chain']=='A'];target=[a for a in original if a['chain']=='B']
                    self.assertEqual(contact['target']['chain'],e['targetChain'])
                else:
                    binder=cif_chain(e['binderChain']);target=cif_chain(reference['targetChain'])
                    self.assertEqual(contact['target']['chain'],reference['targetChain'])
                self.assertEqual(contact['binder']['chain'],e['binderChain'])
                self.assertEqual(contact['cutoffAngstrom'],4.5)
                self.assertEqual(contact['binder']['residueNumbers'],participating_residues(binder,target))
                self.assertEqual(contact['target']['residueNumbers'],participating_residues(target,binder))

    def test_display_examples_are_four_unique_sidechain_pairs_not_full_contacts(self):
        def atom(residue,x,name='CB'):
            return dict(residue=residue,xyz=[x,0,0],element='C',name=name)
        binder=[atom(1,0),atom(2,1),atom(3,10),atom(4,20),atom(5,30),atom(99,1.9999,'CA')]
        target=[atom(10,2),atom(11,12),atom(12,22),atom(13,32),atom(14,42)]
        examples=gallery.display_sidechain_examples(binder,target,'B04','T01')
        self.assertEqual([(p['binderResidueNumber'],p['targetResidueNumber']) for p in examples['pairs']],[(2,10),(3,11),(4,12),(5,13)])
        self.assertEqual(examples['binder']['residueNumbers'],[2,3,4,5])
        self.assertEqual(examples['target']['residueNumbers'],[10,11,12,13])
        self.assertEqual(gallery.display_sidechain_examples([atom(1,0,'CA')],target,'A','B')['pairs'],[])
        self.assertEqual(gallery.display_sidechain_examples(list(reversed(binder)),list(reversed(target)),'B04','T01'),examples)
        by_label={e['binderLabel']:e for e in self.manifest['entries']}
        for e in self.manifest['entries']:
            original=gallery.parse_pdb((ROOT/'upstream'/e['sourceFile']).read_text())
            reference=by_label[e['alignment']['referenceBinder']]
            for mode in ['originalPair','referenceOverlay']:
                contact=e['contacts'][mode];display=contact['displayExamples']
                self.assertEqual(len(display['pairs']),4)
                for side in ['binder','target']:
                    self.assertEqual(display[side]['chain'],contact[side]['chain'])
                    self.assertEqual(len(display[side]['residueNumbers']),4)
                    self.assertTrue(set(display[side]['residueNumbers']) <= set(contact[side]['residueNumbers']))
                if mode=='originalPair':
                    binder=[a for a in original if a['chain']=='A'];target=[a for a in original if a['chain']=='B']
                else:
                    binder=[a for a in gallery.moved_atoms(dict(e,_atoms=original)) if a['chain']=='A']
                    ref_original=gallery.parse_pdb((ROOT/'upstream'/reference['sourceFile']).read_text())
                    target=[a for a in gallery.moved_atoms(dict(reference,_atoms=ref_original)) if a['chain']=='B']
                for pair in display['pairs']:
                    def sidechain_xyz(atoms,residue):
                        return np.array([a['xyz'] for a in atoms if a['residue']==residue and a['name'] not in {'N','CA','C','O','OXT'} and a['element'] not in {'H','D'}])
                    bxyz=sidechain_xyz(binder,pair['binderResidueNumber']);txyz=sidechain_xyz(target,pair['targetResidueNumber'])
                    self.assertGreater(len(bxyz),0);self.assertGreater(len(txyz),0)
                    actual=min(np.linalg.norm(txyz-point,axis=1).min() for point in bxyz)
                    self.assertAlmostEqual(actual,pair['minimumSidechainHeavyAtomDistanceAngstrom'],places=12)
                    self.assertLessEqual(actual,4.5)

    def test_artifact_digests_and_deterministic_preparation(self):
        manifest=self.manifest
        self.assertEqual(gallery.sha((ROOT/'gallery.cif').read_bytes()),manifest['composite']['sha256'])
        for e in manifest['entries']:
            self.assertEqual(gallery.sha((ROOT/e['normalizedFile']).read_bytes()),e['normalizedSha256'])
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)
            (target/'upstream').symlink_to(ROOT/'upstream',target_is_directory=True)
            generated=gallery.prepare(target)
            self.assertEqual(generated,manifest)
            self.assertEqual((target/'gallery.cif').read_bytes(),(ROOT/'gallery.cif').read_bytes())

if __name__=='__main__':unittest.main()
