import unittest
import json
from pathlib import Path
import torch
from torch import nn
from laya.common import DecisionModel
from finetune_laya_sms import split_rows, head_logits


class Encoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.config = type('Config', (), {'hidden_size': 64})()
        self.embedding = nn.Embedding(20, 64)

    def forward(self, input_ids, attention_mask):
        return type('Output', (), {'last_hidden_state': self.embedding(input_ids)})()


class FineTuneTests(unittest.TestCase):
    def test_archived_splits_match_the_recorded_selection(self):
        root = Path(__file__).parent.parent
        folder = root / 'results/sms/finetune'
        manifest = json.loads((folder / 'manifest.json').read_text())
        rows = [json.loads(line) for line in (root / 'data/sms/sms-unique.jsonl').read_text().splitlines()]
        train, validation, test, excluded = split_rows(rows, manifest['testIds'])
        self.assertEqual([len(train), len(validation), len(test)], [4159, 500, 500])
        for name, split in [('train', train), ('validation', validation), ('test', test)]:
            archived = [json.loads(line) for line in (folder / f'{name}.jsonl').read_text().splitlines()]
            self.assertEqual(split, archived)
            self.assertEqual([row['id'] for row in split], manifest[f'{name}Ids'])
        self.assertEqual(excluded, manifest['excludedNormalizedDuplicates'])
        normalized = lambda split: [' '.join(row['state'].casefold().split()) for row in split]
        for left, right in [(train, validation), (train, test), (validation, test)]:
            right_texts = dict.fromkeys(normalized(right))
            self.assertFalse(any(text in right_texts for text in normalized(left)))

    def test_partition_excludes_test_and_normalized_duplicates(self):
        rows = [{'id': str(i), 'state': f'message {i}', 'gold': {'spam': {'label': str(i % 2 == 0).lower()}}} for i in range(30)]
        rows.append({'id': 'duplicate', 'state': ' MESSAGE 0 ', 'gold': {'spam': {'label': 'true'}}})
        train, validation, test, excluded = split_rows(rows, ['0', '1'], validation_size=6)
        self.assertEqual([r['id'] for r in test], ['0', '1'])
        self.assertEqual(len(validation), 6)
        self.assertEqual(len(train), 22)
        self.assertEqual(excluded, ['duplicate'])
        self.assertEqual(len({r['id']: True for r in train + validation + test}), 30)
        self.assertEqual(split_rows(rows, ['0', '1'], validation_size=6), (train, validation, test, excluded))

    def test_missing_test_id_is_refused(self):
        with self.assertRaises(ValueError):
            split_rows([], ['missing'], validation_size=1)

    def test_cached_head_matches_original_forward_and_learns(self):
        torch.manual_seed(42)
        model = DecisionModel(Encoder(), head_layers=1, dropout=0)
        model.eval()
        ids = torch.tensor([[1, 2, 3, 0], [4, 5, 6, 7]])
        mask = ids != 0
        markers = torch.tensor([[0, 1], [0, 1]])
        qtype = torch.tensor([2, 2])
        expected, _ = model(ids, mask, markers, torch.ones_like(markers, dtype=torch.bool), qtype)
        with torch.no_grad():
            hidden = model.encoder(ids, mask).last_hidden_state
        actual = head_logits(model, hidden, mask, markers, qtype)
        torch.testing.assert_close(actual, expected)
        torch.nn.functional.cross_entropy(actual, torch.tensor([0, 1])).backward()
        self.assertIsNotNone(model.scorer[1].weight.grad)
        self.assertIsNone(model.encoder.embedding.weight.grad)


if __name__ == '__main__':
    unittest.main()
