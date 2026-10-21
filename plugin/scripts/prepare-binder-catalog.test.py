#!/usr/bin/env python3
"""Offline selection, provenance, and deterministic catalog regression tests."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('binder_catalog', Path(__file__).with_name('prepare-binder-catalog.py'))
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


def fixture(intended='Cn2; Ts1; AaH II'):
    design = {'uuid': '946282e8', 'intended_toxins': intended, 'binder_against': '', 'KD_note': ''}
    scores = {}
    for prefix, _ in catalog.TARGETS.values():
        for lab in ['Adaptyv', 'Twist']:
            design[f'{prefix}_{lab}_result'] = 'no hit'
            design[f'{prefix}_{lab}_KD_nM'] = ''
        scores[f'{prefix}_final_score'] = '0.2'
    return design, scores


class SelectionTests(unittest.TestCase):
    def test_smallest_kd_requires_intended_adaptyv_hit(self):
        design, scores = fixture()
        design.update(Cn2_Adaptyv_result='hit', Cn2_Adaptyv_KD_nM='12',
                      Ts1_Adaptyv_result='hit', Ts1_Adaptyv_KD_nM='6',
                      AaHII_Adaptyv_KD_nM='0.1', LqhIII_Adaptyv_result='hit', LqhIII_Adaptyv_KD_nM='0.01')
        scores['Cn2_final_score'] = '0.99'
        chosen, reason = catalog.select_target(design, scores)
        self.assertEqual(chosen, 'Ts1')
        self.assertEqual(reason['basis'], 'adaptyv_hit_kd')
        self.assertEqual(reason['rankingValue'], 6)
        self.assertFalse(catalog.target_evidence(design, scores, chosen)['publishedBinder'])

    def test_no_hit_and_hit_without_kd_use_intended_score_only(self):
        for hit in ['no hit', 'hit', '']:
            with self.subTest(result=hit):
                design, scores = fixture()
                design['Cn2_Adaptyv_result'] = hit
                scores.update(Cn2_final_score='0.21', Ts1_final_score='0.91', LqhIII_final_score='1.0')
                chosen, reason = catalog.select_target(design, scores)
                self.assertEqual(chosen, 'Ts1')
                self.assertEqual(reason['evidenceKind'], 'computational-score')
                self.assertIn('not measured binding', reason['reason'])

    def test_qualifiers_are_target_and_lab_specific(self):
        design, scores = fixture()
        design.update(Cn2_Adaptyv_result='hit', Cn2_Adaptyv_KD_nM='0.5', Cn2_Twist_KD_nM='0.7',
                      Ts1_Adaptyv_result='hit', Ts1_Adaptyv_KD_nM='2', Ts1_Twist_KD_nM='3',
                      KD_note="Cn2: both KD are upper limits; Ts1: Adaptyv Bio's KD is approximate")
        chosen, reason = catalog.select_target(design, scores)
        self.assertEqual(chosen, 'Cn2')
        self.assertEqual(reason['qualifier'], 'upper_limit')
        for lab in ['Adaptyv', 'Twist']:
            self.assertEqual(catalog.assay(design, 'Cn2', lab)['kd']['qualifier'], 'upper_limit')
        self.assertEqual(catalog.assay(design, 'Ts1', 'Adaptyv')['kd']['qualifier'], 'approximate')
        self.assertEqual(catalog.assay(design, 'Ts1', 'Twist')['kd']['qualifier'], 'point_estimate')
        self.assertEqual(catalog.assay(design, 'Cn2', 'Adaptyv')['kd']['reported'], '0.5')

    def test_missing_is_not_no_hit_and_twist_ambiguity_is_not_a_hit(self):
        design, scores = fixture()
        design.update(Cn2_Adaptyv_result='', Cn2_Twist_result='weak or ambiguous', Cn2_Twist_KD_nM='350')
        evidence = catalog.target_evidence(design, scores, 'Cn2')
        self.assertEqual(evidence['assays']['adaptyv']['result'], '')
        self.assertIsNone(evidence['assays']['adaptyv']['kd']['value'])
        self.assertEqual(evidence['assays']['adaptyv']['kd']['qualifier'], 'not_reported')
        self.assertEqual(evidence['assays']['twist']['result'], 'weak or ambiguous')
        self.assertEqual(evidence['assays']['twist']['kd']['value'], 350)

    def test_ties_follow_original_intended_target_order(self):
        design, scores = fixture('Ts1; Cn2')
        self.assertEqual(catalog.select_target(design, scores)[0], 'Ts1')
        design.update(Cn2_Adaptyv_result='hit', Cn2_Adaptyv_KD_nM='1.00',
                      Ts1_Adaptyv_result='hit', Ts1_Adaptyv_KD_nM='1')
        self.assertEqual(catalog.select_target(design, scores)[0], 'Ts1')

    def test_existing_gallery_target_is_preserved_and_validated(self):
        design, scores = fixture()
        design.update(binder_against='Cn2', Cn2_Adaptyv_result='hit', Cn2_Adaptyv_KD_nM='10',
                      Ts1_Adaptyv_result='hit', Ts1_Adaptyv_KD_nM='1')
        self.assertEqual(catalog.select_target(design, scores, fixed_target='Cn2')[0], 'Cn2')
        with self.assertRaisesRegex(ValueError, 'published binder target'):
            catalog.select_target(design, scores, fixed_target='Ts1')

    def test_missing_scores_fail_instead_of_inventing_evidence(self):
        design, scores = fixture('Cn2; Ts1')
        scores.update(Cn2_final_score='', Ts1_final_score='')
        with self.assertRaisesRegex(ValueError, 'No reported intended-target score'):
            catalog.select_target(design, scores)
        for invalid in ['nan', 'inf', '-1', '1.01']:
            with self.assertRaises(ValueError):
                catalog.number(invalid, maximum=1)

    def test_uuid_is_text_and_duplicates_fail(self):
        design, _ = fixture()
        self.assertIn('946282e8', catalog.indexed([design]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            catalog.indexed([design, design])


class PinnedCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with mock.patch.object(catalog.urllib.request, 'urlopen', side_effect=AssertionError('offline test')):
            cls.data = catalog.build_catalog(catalog.DEFAULT_ROOT)

    def test_all_211_once_existing_17_then_original_remaining_order(self):
        design = catalog.read_rows(catalog.DEFAULT_ROOT / 'upstream/design.csv')
        existing = json.loads((catalog.DEFAULT_ROOT / 'manifest.json').read_text())['entries']
        entries = self.data['entries']
        wanted = [e['uuid'] for e in existing]
        self.assertEqual(len(entries), 211)
        self.assertEqual(len({e['uuid'] for e in entries}), 211)
        self.assertEqual([e['uuid'] for e in entries], wanted + [d['uuid'] for d in design if d['uuid'] not in wanted])
        self.assertEqual([e['target'] for e in entries[:17]], [e['target'] for e in existing])
        self.assertEqual([e['globalOrdinal'] for e in entries], list(range(1, 212)))
        self.assertEqual(entries[17]['displayLabel'], 'Design018')
        self.assertEqual(entries[-1]['displayLabel'], 'Design211')
        self.assertTrue(all(e['source']['sha256'] and e['source']['downloaded'] for e in entries[:17]))
        self.assertTrue(all(e['source']['sha256'] is None and not e['source']['downloaded'] for e in entries[17:]))
        self.assertTrue(all(isinstance(e['uuid'], str) for e in entries))
        self.assertIn('946282e8', [e['uuid'] for e in entries])

    def test_each_representative_is_intended_and_keeps_all_alternatives(self):
        for entry in self.data['entries']:
            self.assertIn(entry['target'], entry['intendedTargets'])
            self.assertEqual(set(entry['alternativeTargets']) | {entry['targetId']},
                             {catalog.TARGETS[t][1] for t in entry['intendedTargets']})
            self.assertEqual(len(entry['targets']), 5)
            self.assertIn(f"/{catalog.REVISION}/structures/{entry['uuid']}/", entry['source']['url'])
            reference = next(e for e in self.data['entries'] if e['id'] == entry['referenceEntryId'])
            self.assertEqual(reference['targetId'], entry['targetId'])
        self.assertEqual(sum(bool(e['publishedBinderAgainst']) for e in self.data['entries']), 17)

    def test_reproducible_bytes_and_new_structure_cache_does_not_change_catalog(self):
        expected = catalog.serialized(self.data)
        self.assertEqual((catalog.DEFAULT_ROOT / 'catalog.json').read_bytes(), expected)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'manifest.json').symlink_to(catalog.DEFAULT_ROOT / 'manifest.json')
            for name in catalog.PINNED_SHA256:
                path = root / 'upstream' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(catalog.DEFAULT_ROOT / 'upstream' / name)
            for entry in self.data['entries'][:17]:
                path = root / 'upstream' / entry['source']['file']
                path.parent.mkdir(parents=True, exist_ok=True)
                path.symlink_to(catalog.DEFAULT_ROOT / 'upstream' / entry['source']['file'])
            new_source = root / 'upstream' / self.data['entries'][17]['source']['file']
            new_source.parent.mkdir(parents=True, exist_ok=True)
            new_source.write_text('later structure cache must not affect the metadata artifact')
            self.assertEqual(catalog.serialized(catalog.build_catalog(root)), expected)

    def test_corrupted_pinned_metadata_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'upstream').mkdir()
            (root / 'upstream/design.csv').write_text('modified metadata')
            with self.assertRaisesRegex(ValueError, 'Pinned upstream digest mismatch: design.csv'):
                catalog.build_catalog(root)


if __name__ == '__main__':
    unittest.main()
