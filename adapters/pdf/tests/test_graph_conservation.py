"""Compaction preserves note proof and every surviving link occurrence."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf2struct import AdapterReport, StructAdapter


def box(page=1, y=.2):
    return dict(page=page, x=.1, y=y, width=.7, height=.03, rotation=0)


def block(ident, kind='paragraph', page=1, text='here'):
    return dict(id=ident, kind=kind, page=page, text=text, inline=[], evidence=dict(confidence=1, pages=[page], boxes=[box(page)], sourceIds=[ident], signals=['source-text']))


def adapter(blocks, relationships=None, assets=None):
    a = StructAdapter.__new__(StructAdapter)
    a.blocks = blocks
    a.assets = assets or []
    a.relationships = relationships or []
    a.report = AdapterReport()
    return a


class GraphConservation(unittest.TestCase):
    def test_repeated_furniture_uri_and_text_keep_distinct_occurrence_anchors(self):
        first, second = block('f1', 'furniture'), block('f2', 'furniture')
        for obj in (first, second):
            obj['inline'] = [dict(start=0, end=4, href='https://example.org/')]
        a = adapter([first, second])
        a._compact_graph()
        a._prune_dangling_references()
        self.assertEqual([b['id'] for b in a.blocks], ['f1', 'f2'])
        self.assertEqual([b['text'][r['start']:r['end']] for b in a.blocks for r in b['inline']], ['here', 'here'])
        self.assertEqual(a.report.runs_pruned, 0)

    def test_furniture_mathml_relationships_targets_and_ledger_keep_identity(self):
        plain = block('plain', 'furniture')
        math = block('math', 'furniture', text='x')
        math['inline'] = [dict(start=0, end=1, mathml='<math><mi>x</mi></math>')]
        target = block('target', 'furniture')
        host = block('host')
        host['inline'] = [dict(start=0, end=4, href='#target', targetIds=['target'], relationshipId='ref')]
        rel = dict(id='ref', kind='reference', to=['target'], **{'from': 'host'})
        ledger = block('ledger', 'furniture')
        a = adapter([plain, math, target, host, ledger], [rel])
        a.report.internal_link_coverage = dict(occurrences=[dict(blockId='ledger', containerId='ledger', targetId='target', start=0, end=4)])
        before = deepcopy(a.blocks)
        a._compact_graph()
        a._prune_dangling_references()
        self.assertEqual(a.blocks, before)
        self.assertEqual(a.relationships, [rel])

    def test_plain_furniture_still_compacts_without_changing_text_content(self):
        a = adapter([block('a', 'furniture', text='first'), block('b', 'furniture', text='second')])
        a._compact_graph()
        self.assertEqual(len(a.blocks), 1)
        self.assertEqual(a.blocks[0]['text'], 'first second')
        self.assertEqual(a.report.furniture_blocks_merged, 1)
        self.assertEqual({e['id'] for e in a.report.source_provenance}, {'a', 'b'})

    def test_large_graph_retains_multipart_note_ownership_and_full_crosspage_proof(self):
        note = block('note4b2121', 'footnote', page=190)
        note['noteBodyBlockIds'] = ['b2143']
        child = block('b2143', page=191)
        child['evidence'] = dict(confidence=1, pages=[190, 191], boxes=[box(190, .85), box(191, .8), box(191, .85)], sourceIds=[f'source-{i}' for i in range(12)], signals=['source-note-continuation', 'source-text-line'])
        child['fallbackAssetIds'] = ['eq-image']
        asset = dict(id='eq-image', evidence=deepcopy(child['evidence']))
        a = adapter([note, child] + [block(f'b{i}') for i in range(1500)], assets=[asset])
        before = deepcopy((note, child, asset))
        a._compact_graph()
        self.assertEqual((note, child, asset), before)
        self.assertTrue(a.report.provenance_trimmed_for_budget)

    def test_full_source_provenance_snapshot_is_durable_after_trimming_and_reentry(self):
        rich = block('rich')
        rich['evidence'].update(pages=[1, 2], boxes=[box(1, .1), box(1, .2), box(2, .1)], sourceIds=[f's{i}' for i in range(12)])
        asset = dict(id='asset', evidence=deepcopy(rich['evidence']))
        expected = deepcopy(rich['evidence'])
        a = adapter([rich] + [block(f'b{i}') for i in range(1500)], assets=[asset])
        a._compact_graph()
        self.assertEqual(rich['evidence']['sourceIds'], ['s0', 's1'])
        self.assertEqual([b['page'] for b in rich['evidence']['boxes']], [1, 2])
        self.assertEqual([b['page'] for b in asset['evidence']['boxes']], [1, 2])
        a._compact_graph()
        for ident in ('rich', 'asset'):
            records = [e for e in a.report.source_provenance if e['id'] == ident]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]['evidence'], expected)
        rich['evidence']['boxes'][0]['x'] = .9
        self.assertEqual(next(e for e in a.report.source_provenance if e['id'] == 'rich')['evidence'], expected)

    def test_cell_pruning_preserves_valid_href_mathml_and_remaining_targets(self):
        table = block('table', 'table')
        cell = dict(id='c0-0', text='here x', evidence=deepcopy(table['evidence']), inline=[
            dict(start=0, end=4, href='https://example.org/', bold=True, relationshipId='missing'),
            dict(start=5, end=6, mathml='<math><mi>x</mi></math>', relationshipId='missing'),
            dict(start=0, end=4, targetIds=['gone', 'target'], relationshipId='valid'),
            dict(start=0, end=4, href='#gone', relationshipId='missing'),
        ])
        table['table'] = dict(cells=[cell])
        valid = dict(id='valid', to=['target'], **{'from': 'table'})
        dangling = dict(id='dangling', to=['gone'], **{'from': 'table'})
        a = adapter([table, block('target')], [valid, dangling])
        a._compact_graph()
        a._prune_dangling_references()
        self.assertEqual(a.relationships, [valid])
        self.assertEqual(len(cell['inline']), 3)
        self.assertEqual(cell['inline'][0], dict(start=0, end=4, href='https://example.org/', bold=True))
        self.assertEqual(cell['inline'][1], dict(start=5, end=6, mathml='<math><mi>x</mi></math>'))
        self.assertEqual(cell['inline'][2]['targetIds'], ['target'])
        self.assertEqual(cell['inline'][2]['relationshipId'], 'valid')
        self.assertTrue(any(e.get('parentBlockId') == 'table' and e['id'] == 'c0-0' for e in a.report.source_provenance))

    def test_cell_ids_are_scoped_not_core_relationship_targets(self):
        table = block('table', 'table')
        table['table'] = dict(cells=[dict(id='c0-0', text='here', inline=[])])
        a = adapter([table], [dict(id='bad', to=['c0-0'], **{'from': 'table'})])
        a._prune_dangling_references()
        self.assertEqual(a.relationships, [])


if __name__ == '__main__':
    unittest.main()
