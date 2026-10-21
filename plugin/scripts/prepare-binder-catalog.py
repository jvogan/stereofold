#!/usr/bin/env python3
"""Catalog the 211 published designs without downloading or changing structures.

The existing 17-entry gallery defines the first block. Remaining designs keep
design.csv order and get one intended-target representative. Requires Python 3
standard library only. --fetch downloads ONLY the pinned score CSV if absent.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import re
import urllib.request

DATASET = 'Anthropic/scorpion-toxin-binder-design'
REVISION = '0bac3d0286f7f83b5339f5b4f1e67fbe47a6e7c1'
BASE = f'https://huggingface.co/datasets/{DATASET}/resolve/{REVISION}/'
DEFAULT_ROOT = Path(__file__).resolve().parents[1] / 'demos/binder-gallery'
TARGETS = {
    'Cn2': ('Cn2', 'cn2'), 'Ts1': ('Ts1', 'ts1'),
    'AaH II': ('AaHII', 'aah2'), 'AaH I': ('AaHI', 'aah1'),
    'LqhIII': ('LqhIII', 'lqh3'),
}
PINNED_SHA256 = {
    'design.csv': '3eb9dc87ee7582120c6a1cf74164d0c611ba269d76a85487b846acd688bfd604',
    'in_silico_scores.csv': 'a5e217eb5e7ec4815c12413bab27be527cbc4733fe996071bc3ddb0efd15af06',
    'structures/INDEX.csv': 'c6d7e2ad30c030c26c5204a8daacf95e9ae1c84c933c27027902fc3d8c23e5ec',
    'COLUMNS.md': '8762d877f154009710c4d7f8cdd6703fe412a2f8c6b2296038d5f08dfb34b6a2',
    'README.md': 'e9bec8366a27f77277a39438e034c99863c3d6843b8cd7f9ff02bc31b0c21fca',
    'LICENSE.md': '88292231d09bee28d11954d8cf3cbaf91532ecc8f338656ebf997ffa3508f980',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_rows(path):
    with path.open(newline='', encoding='utf-8') as handle:
        return list(csv.DictReader(handle))


def indexed(rows):
    result = {}
    for row in rows:
        uuid = row['uuid']
        if not re.fullmatch(r'[0-9a-f]{8}', uuid) or uuid in result:
            raise ValueError(f'Invalid or duplicate text UUID: {uuid!r}')
        result[uuid] = row
    return result


def number(raw, *, maximum=None):
    if raw == '':
        return None
    value = float(raw)
    if not math.isfinite(value) or value < 0 or (maximum is not None and value > maximum):
        raise ValueError(f'Invalid published numeric value: {raw!r}')
    return value


def intended_targets(design):
    targets = design['intended_toxins'].split('; ')
    if not targets or len(set(targets)) != len(targets) or any(t not in TARGETS for t in targets):
        raise ValueError(f"Invalid intended targets for {design['uuid']}")
    return targets


def assay(design, target, lab):
    prefix = TARGETS[target][0]
    raw = design.get(f'{prefix}_{lab}_KD_nM', '')
    value = number(raw)
    target_notes = [note for note in design.get('KD_note', '').split('; ') if note.startswith(target + ':')]
    lab_name = 'Adaptyv Bio' if lab == 'Adaptyv' else 'Twist Bioscience'
    notes = [note for note in target_notes if lab_name in note or 'both KD' in note]
    qualifiers = set()
    for note in notes:
        if 'upper limit' in note:
            qualifiers.add('upper_limit')
        elif 'approximate' in note:
            qualifiers.add('approximate')
        else:
            raise ValueError(f'Unrecognized KD qualification: {note}')
    if len(qualifiers) > 1:
        raise ValueError(f'Conflicting KD qualifications: {notes}')
    qualifier = next(iter(qualifiers), 'point_estimate') if value is not None else 'not_reported'
    return {'result': design.get(f'{prefix}_{lab}_result', ''),
            'kd': {'reported': raw, 'value': value, 'unit': 'nM', 'qualifier': qualifier, 'notes': notes}}


def target_evidence(design, scores, target):
    prefix, target_id = TARGETS[target]
    raw = scores[f'{prefix}_final_score']
    return {'id': target_id, 'name': target, 'intended': target in intended_targets(design),
            'publishedBinder': target in design['binder_against'].split('; '),
            'assays': {'adaptyv': assay(design, target, 'Adaptyv'), 'twist': assay(design, target, 'Twist')},
            'computational': {'finalScore': number(raw, maximum=1), 'reportedFinalScore': raw}}


def select_target(design, scores, *, fixed_target=None):
    intended = intended_targets(design)
    evidence = {target: target_evidence(design, scores, target) for target in intended}
    if fixed_target is not None:
        if fixed_target not in intended or design['binder_against'] != fixed_target:
            raise ValueError(f"Existing gallery target is not the published binder target: {design['uuid']}")
        return fixed_target, {
            'basis': 'published_binder', 'evidenceKind': 'published-binder-classification',
            'reason': 'Preserved the existing 17-entry gallery target and order; binder classification is from design.csv.',
            'rankingMetric': None, 'rankingValue': None, 'qualifier': None,
        }
    measured = [target for target in intended if evidence[target]['assays']['adaptyv']['result'] == 'hit'
                and (evidence[target]['assays']['adaptyv']['kd']['value'] or 0) > 0]
    if measured:
        chosen = min(measured, key=lambda target: evidence[target]['assays']['adaptyv']['kd']['value'])
        kd = evidence[chosen]['assays']['adaptyv']['kd']
        return chosen, {
            'basis': 'adaptyv_hit_kd', 'evidenceKind': 'measured-hit',
            'reason': 'Smallest reported positive Adaptyv KD among intended targets with a published Adaptyv hit; this alone does not establish the dataset binder criteria.',
            'rankingMetric': 'Adaptyv_KD_nM', 'rankingValue': kd['value'], 'qualifier': kd['qualifier'],
        }
    scored = [target for target in intended if evidence[target]['computational']['finalScore'] is not None]
    if not scored:
        raise ValueError(f"No reported intended-target score for {design['uuid']}")
    chosen = max(scored, key=lambda target: evidence[target]['computational']['finalScore'])
    return chosen, {
        'basis': 'published_final_score', 'evidenceKind': 'computational-score',
        'reason': 'No intended target has both a published Adaptyv hit and a positive KD; selected the highest published intended-target final_score. A score is not measured binding.',
        'rankingMetric': 'final_score', 'rankingValue': evidence[chosen]['computational']['finalScore'], 'qualifier': None,
    }


def checked_inputs(root, fetch=False):
    provenance = []
    for name, digest in PINNED_SHA256.items():
        path = root / 'upstream' / name
        if not path.exists() and fetch and name == 'in_silico_scores.csv':
            with urllib.request.urlopen(BASE + name, timeout=60) as response:
                data = response.read()
            if sha(data) != digest:
                raise ValueError(f'Pinned upstream digest mismatch: {name}')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        data = path.read_bytes()
        if sha(data) != digest:
            raise ValueError(f'Pinned upstream digest mismatch: {name}')
        provenance.append({'file': f'upstream/{name}', 'sha256': digest, 'bytes': len(data), 'url': BASE + name})
    return provenance


def build_catalog(root, *, fetch=False):
    provenance = checked_inputs(root, fetch)
    designs = read_rows(root / 'upstream/design.csv')
    by_uuid = indexed(designs)
    scores = indexed(read_rows(root / 'upstream/in_silico_scores.csv'))
    if len(by_uuid) != 211 or set(by_uuid) != set(scores):
        raise ValueError('Expected the same 211 distinct text UUIDs in design and scores')
    gallery_bytes = (root / 'manifest.json').read_bytes()
    gallery = json.loads(gallery_bytes)
    selected = gallery['entries']
    if gallery['revision'] != REVISION or len(selected) != 17 or len({e['uuid'] for e in selected}) != 17:
        raise ValueError('Expected the existing 17-entry gallery at the pinned revision')
    selected_by_uuid = {entry['uuid']: entry for entry in selected}
    if set(selected_by_uuid) != {d['uuid'] for d in designs if d['binder_against']}:
        raise ValueError('Existing gallery does not match the 17 published binder classifications')
    complex_index = {}
    for row in read_rows(root / 'upstream/structures/INDEX.csv'):
        if row['kind'] == 'predicted complex' and row['predictor'] == 'ESMFold2':
            key = (row['uuid'], row['toxin'])
            if key in complex_index:
                raise ValueError(f'Duplicate predicted-complex index entry: {key}')
            complex_index[key] = row
    ordered = [by_uuid[e['uuid']] for e in selected] + [d for d in designs if d['uuid'] not in selected_by_uuid]
    entries = []
    for ordinal, design in enumerate(ordered, 1):
        uuid = design['uuid']
        old = selected_by_uuid.get(uuid)
        target, selection = select_target(design, scores[uuid], fixed_target=old['target'] if old else None)
        target_id = TARGETS[target][1]
        indexed_source = complex_index[(uuid, target)]
        source_file = 'structures/' + indexed_source['file']
        local_source = root / 'upstream' / source_file
        # Catalog bytes must not depend on whether a later streaming job has
        # populated its structure cache. Only the original 17 have verified
        # coordinate digests in this catalog's input manifest.
        source_bytes = local_source.read_bytes() if old and local_source.exists() else None
        if old and (old['sourceFile'] != source_file or source_bytes is None
                    or sha(source_bytes) != old['sourceSha256']):
            raise ValueError(f'Original gallery source identity changed: {uuid}')
        intended = intended_targets(design)
        entries.append({
            'id': f'binder-{uuid}', 'uuid': uuid, 'globalOrdinal': ordinal,
            'phase': 'selected17' if old else 'remaining',
            'originalName': design['name'], 'legacyGalleryId': old['id'] if old else None,
            'displayLabel': old['binderLabel'] if old else f'Design{ordinal:03d}',
            'designSet': design['design_set'], 'format': design['format'], 'lengthAa': int(design['length_aa']),
            'publishedBinderAgainst': design['binder_against'],
            'target': target, 'targetId': target_id, 'intendedTargets': intended,
            'alternativeTargets': [TARGETS[t][1] for t in intended if t != target],
            'referenceTargetId': target_id, 'alignmentGroup': f'toxin-{target_id}',
            'source': {'file': source_file, 'url': BASE + source_file, 'revision': REVISION,
                       'predictor': indexed_source['predictor'], 'kind': 'published predicted complex',
                       'sha256': sha(source_bytes) if source_bytes is not None else None,
                       'bytes': len(source_bytes) if source_bytes is not None else None,
                       'downloaded': source_bytes is not None},
            'selection': selection,
            'targets': [target_evidence(design, scores[uuid], t) for t in TARGETS],
            'kdNote': design['KD_note'],
            'offTargetResults': {key: design[key] for key in ['CLEC12A_Twist_result_run_1', 'CLEC12A_Twist_result_run_2']},
        })
    references = {}
    for entry in entries:
        entry['referenceEntryId'] = references.setdefault(entry['targetId'], entry['id'])
    return {
        'version': 1, 'id': 'binder-gallery-catalog', 'dataset': DATASET, 'revision': REVISION,
        'license': 'CC BY 4.0', 'attribution': 'Anthropic, PBC (2026). Scorpion toxin binder design: data release.',
        'selectedEndOrdinal': 17, 'entryCount': 211, 'orderedIDs': [e['id'] for e in entries],
        'selectionPolicy': {
            'first17': 'Existing manifest.json order and published binder target are preserved exactly.',
            'remainingOrder': 'Original design.csv row order, excluding the first 17 UUIDs.',
            'representativeTarget': 'Smallest positive reported Adaptyv KD among intended targets with literal hit; otherwise highest published intended-target final_score.',
            'ties': 'Original intended_toxins order; no rounding before comparison.',
            'qualifiers': 'Upper limits and approximate KD values retain their qualification. Comparing their reported numeric values is a deterministic representative-selection convention, not a proof of exact affinity ordering.',
            'blankCells': 'An empty published cell is retained as an empty string and means unreported/not measured/not applicable/no fit, never no hit.',
            'scores': 'final_score is the published mean of six computational scores (ipSAE and scDockQ for three predictors), not a KD or experimental binding measurement.',
            'binderClassification': 'Only design.csv binder_against defines a dataset binder; an Adaptyv hit alone does not meet the full published criteria.',
        },
        'coordinateStatus': 'Catalog only. Source models are original published predicted complexes; alignment groups and reference entries are planning metadata, not completed coordinate transformations or shared render bounds.',
        'provenance': {'upstreamFiles': provenance,
                       'existingGallery': {'file': 'manifest.json', 'sha256': sha(gallery_bytes), 'bytes': len(gallery_bytes)}},
        'entries': entries,
    }


def serialized(catalog):
    return (json.dumps(catalog, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--fetch', action='store_true', help='Fetch only the pinned score CSV if missing')
    parser.add_argument('--check', action='store_true', help='Verify catalog.json matches deterministic generation')
    args = parser.parse_args()
    data = serialized(build_catalog(args.root, fetch=args.fetch))
    path = args.root / 'catalog.json'
    if args.check:
        if path.read_bytes() != data:
            raise SystemExit('catalog.json differs from deterministic generation')
    else:
        path.write_bytes(data)
    print(json.dumps({'file': str(path), 'entries': 211, 'bytes': len(data), 'sha256': sha(data), 'checked': args.check}))


if __name__ == '__main__':
    main()
