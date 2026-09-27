"""Fine-tune Laya's decision head on SMS labels, preserving the benchmark test set.

The encoder stays frozen. Its cached outputs are identical inputs to the existing
head; the exported model uses Laya's normal inference path with no extra layers.
"""

import argparse
import hashlib
import json
import math
import random
import time
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file
from laya.agent import Agent
from laya.common import collate_items


def split_rows(rows, test_ids, validation_size=500, seed=20260927):
    by_id = {row['id']: row for row in rows}
    if len(by_id) != len(rows) or any(key not in by_id for key in test_ids):
        raise ValueError('Duplicate dataset IDs or missing benchmark test IDs.')
    if len(dict.fromkeys(test_ids)) != len(test_ids):
        raise ValueError('Repeated test IDs.')
    test = [by_id[key] for key in test_ids]
    normalized = lambda row: ' '.join(row['state'].casefold().split())
    seen = {normalized(row): True for row in test}
    excluded = []
    pool = []
    for row in rows:
        if row['id'] in test_ids:
            continue
        key = normalized(row)
        if key in seen:
            excluded.append(row['id'])
        else:
            seen[key] = True
            pool.append(row)
    if len(pool) <= validation_size:
        raise ValueError('Insufficient examples for training and validation.')
    positives = [row for row in pool if row['gold']['spam']['label'] == 'true']
    negatives = [row for row in pool if row['gold']['spam']['label'] == 'false']
    rng = random.Random(seed)
    rng.shuffle(positives)
    rng.shuffle(negatives)
    n_positive = round(validation_size * len(positives) / len(pool))
    n_negative = validation_size - n_positive
    validation = positives[:n_positive] + negatives[:n_negative]
    train = positives[n_positive:] + negatives[n_negative:]
    rng.shuffle(train)
    rng.shuffle(validation)
    return train, validation, test, excluded


def head_logits(model, hidden, mask, markers, qtype):
    hidden = hidden + model.type_emb(qtype)[:, None, :]
    if model.head is not None:
        for layer in model.head.layers:
            hidden = layer(hidden, src_key_padding_mask=~mask.bool())
    selected = torch.gather(hidden, 1, markers[:, :, None].expand(-1, -1, hidden.size(-1)))
    return model.scorer(selected).squeeze(-1).float()


def metrics(logits, targets, temperature=1.0):
    probabilities = (logits / temperature).softmax(-1)
    labels = probabilities.argmax(-1)
    tp = int(((labels == 1) & (targets == 1)).sum())
    fp = int(((labels == 1) & (targets == 0)).sum())
    fn = int(((labels == 0) & (targets == 1)).sum())
    tn = len(targets) - tp - fp - fn
    return {
        'accuracy': float((labels == targets).float().mean()),
        'macroF1': ((2 * tp / max(1, 2 * tp + fp + fn)) + (2 * tn / max(1, 2 * tn + fp + fn))) / 2,
        'logLoss': float(torch.nn.functional.cross_entropy(logits / temperature, targets)),
        'brier': float(((probabilities - torch.nn.functional.one_hot(targets, 2)) ** 2).sum(-1).mean()),
        'falsePositives': fp, 'falseNegatives': fn,
    }


def batches(items, batch_size, rng=None):
    ordered = list(items)
    if rng:
        rng.shuffle(ordered)
    else:
        ordered.sort(key=lambda item: item['length'])
    result = []
    # Length buckets limit padding while changing batch membership each epoch.
    for start in range(0, len(ordered), 256):
        bucket = sorted(ordered[start:start + 256], key=lambda item: item['length'])
        result.extend(bucket[i:i + batch_size] for i in range(0, len(bucket), batch_size))
    if rng:
        rng.shuffle(result)
    return result


def cached_batch(items, device):
    length = max(item['length'] for item in items)
    hidden = torch.zeros(len(items), length, items[0]['hidden'].shape[-1])
    mask = torch.zeros(len(items), length, dtype=torch.bool)
    for i, item in enumerate(items):
        hidden[i, :item['length']] = item['hidden']
        mask[i, :item['length']] = True
    return (
        hidden.to(device), mask.to(device),
        torch.tensor([item['markers'] for item in items], device=device),
        torch.full((len(items),), 2, dtype=torch.long, device=device),
        torch.tensor([item['label'] for item in items], device=device),
    )


def evaluate(model, items, device, batch_size):
    model.eval()
    outputs, targets = [], []
    with torch.no_grad():
        for chunk in batches(items, batch_size):
            hidden, mask, markers, qtype, target = cached_batch(chunk, device)
            outputs.append(head_logits(model, hidden, mask, markers, qtype).cpu())
            targets.append(target.cpu())
    return torch.cat(outputs), torch.cat(targets)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', required=True)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--base-model', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--epochs', type=int, default=5)
    parser.add_argument('--batch-size', type=int, default=16)
    parser.add_argument('--learning-rate', type=float, default=1e-5)
    args = parser.parse_args()
    seed = 20260927
    random.seed(seed)
    torch.manual_seed(seed)
    if not torch.backends.mps.is_available():
        raise RuntimeError('This experiment requires the Mac GPU; MPS is unavailable.')
    torch.mps.manual_seed(seed)
    torch.set_num_threads(4)
    torch.backends.mha.set_fastpath_enabled(False)
    folder = Path(args.out)
    folder.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()

    def log(event, **fields):
        record = {'event': event, 'elapsedSeconds': round(time.perf_counter() - started, 2), **fields}
        text = json.dumps(record)
        print(text, flush=True)
        with (folder / 'training.jsonl').open('a') as stream:
            stream.write(text + '\n')

    source = Path(args.data).read_bytes()
    rows = [json.loads(line) for line in source.decode().splitlines() if line.strip()]
    header = json.loads(Path(args.baseline).read_text().splitlines()[0])['metadata']
    assert hashlib.sha256(source).hexdigest() == header['datasetSha256'], 'Dataset differs from baseline.'
    train, validation, test, excluded = split_rows(rows, header['caseIds'], seed=seed)
    for split, values in [('train', train), ('validation', validation), ('test', test)]:
        (folder / f'{split}.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in values))
    manifest = {
        'seed': seed, 'baseModel': args.base_model, 'datasetSha256': header['datasetSha256'],
        'trainIds': [row['id'] for row in train], 'validationIds': [row['id'] for row in validation],
        'testIds': header['caseIds'], 'excludedNormalizedDuplicates': excluded,
        'method': 'Frozen encoder; train native decision head, type embedding, and scorer with cross entropy.',
        'selection': 'Lowest validation log loss; stop after two epochs without improvement.',
        'calibration': 'Noul temperature chosen on validation, clamped to Laya runtime range [0.5, 5].',
        'settings': vars(args),
    }
    (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    log('split', train=len(train), validation=len(validation), test=len(test), excluded=len(excluded))
    agent = Agent(args.base_model, device='mps')
    assert agent.device.type == 'mps'
    model = agent.model
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(not name.startswith(('encoder.', 'act_head.')))
    parameters = [p for p in model.parameters() if p.requires_grad]
    log('model', totalParameters=sum(p.numel() for p in model.parameters()), trainedParameters=sum(p.numel() for p in parameters))

    items = []
    for row in train + validation:
        assert list(row['questions']) == ['spam']
        question = row['questions']['spam']
        assert question == {'type': 'noul', 'instructions': 'Is this message unsolicited spam?'}
        item = agent._encode_state(row['state'], ['spam'], {'spam': agent._to_internal(question)})[0]
        items.append({**item, 'id': row['id'], 'label': int(row['gold']['spam']['label'] == 'true'), 'length': len(item['ids'])})
    model.eval()
    with torch.no_grad():
        for index, chunk in enumerate(batches(items, args.batch_size)):
            batch = collate_items([[item] for item in chunk], agent.tok.pad_token_id)
            inputs = {key: batch[key].to(agent.device) for key in ['input_ids', 'attention_mask', 'marker_pos', 'marker_mask', 'qtype']}
            hidden = model.encoder(input_ids=inputs['input_ids'], attention_mask=inputs['attention_mask']).last_hidden_state
            if index == 0:
                original, _ = model(**inputs)
                cached = head_logits(model, hidden, inputs['attention_mask'], inputs['marker_pos'], inputs['qtype'])
                torch.testing.assert_close(cached, original, atol=1e-5, rtol=1e-5)
                log('cachedForwardParity', maximumError=float((cached - original).abs().max()))
            hidden = hidden.cpu()
            for position, item in enumerate(chunk):
                item['hidden'] = hidden[position, :item['length']].clone()
            if index % 25 == 0:
                log('encoding', batchesDone=index + 1, totalItems=len(items))
    model.encoder.to('cpu')
    torch.mps.empty_cache()
    train_ids = manifest['trainIds']
    training = [item for item in items if item['id'] in train_ids]
    validating = [item for item in items if item['id'] not in train_ids]
    log('encodingFinished')

    def save_head():
        save_file({name: tensor.detach().cpu().contiguous() for name, tensor in model.state_dict().items() if not name.startswith('encoder.')}, str(folder / 'best-head.safetensors'))

    logits, targets = evaluate(model, validating, agent.device, args.batch_size)
    baseline_metrics = metrics(logits, targets, agent.temperature_by_options.get('noul:2', agent.temperature[2]))
    best_loss = metrics(logits, targets)['logLoss']
    best_epoch = 0
    save_head()
    log('validationBaseline', metrics=baseline_metrics, uncalibratedLogLoss=best_loss)
    optimizer = torch.optim.AdamW(parameters, lr=args.learning_rate, weight_decay=0.01)
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=1e-6)
    for epoch in range(1, args.epochs + 1):
        model.train()
        model.encoder.eval()
        epoch_loss = 0.0
        count = 0
        for step, chunk in enumerate(batches(training, args.batch_size, random.Random(seed + epoch))):
            hidden, mask, markers, qtype, targets = cached_batch(chunk, agent.device)
            optimizer.zero_grad(set_to_none=True)
            logits = head_logits(model, hidden, mask, markers, qtype)
            loss = torch.nn.functional.cross_entropy(logits, targets)
            if not torch.isfinite(loss):
                raise RuntimeError('Nonfinite training loss.')
            loss.backward()
            torch.nn.utils.clip_grad_norm_(parameters, 1.0, error_if_nonfinite=True)
            optimizer.step()
            epoch_loss += float(loss.detach()) * len(chunk)
            count += len(chunk)
            if step % 25 == 0:
                log('training', epoch=epoch, step=step, examples=count, loss=epoch_loss / count)
        logits, targets = evaluate(model, validating, agent.device, args.batch_size)
        score = metrics(logits, targets)
        improved = score['logLoss'] < best_loss
        if improved:
            best_loss, best_epoch = score['logLoss'], epoch
            save_head()
        log('validation', epoch=epoch, metrics=score, improved=improved)
        schedule.step()
        if epoch - best_epoch >= 2:
            break
    model.load_state_dict(load_file(str(folder / 'best-head.safetensors')), strict=False)
    logits, targets = evaluate(model, validating, agent.device, args.batch_size)
    # Only validation labels determine calibration; the fixed test file is not evaluated here.
    temperatures = torch.linspace(math.log(0.5), math.log(5), 501).exp()
    losses = [float(torch.nn.functional.cross_entropy(logits / t, targets)) for t in temperatures]
    temperature = float(temperatures[min(range(len(losses)), key=losses.__getitem__)])
    checkpoint = folder / 'checkpoint'
    checkpoint.mkdir()
    model.to('cpu')
    save_file({name: tensor.detach().contiguous() for name, tensor in model.state_dict().items()}, str(checkpoint / 'model.safetensors'))
    model.encoder.config.save_pretrained(checkpoint / 'encoder')
    agent.tok.save_pretrained(checkpoint / 'tokenizer')
    config = dict(agent.cfg)
    config['model_name'] = 'laya-sms-head-v1'
    config['temperature'] = list(agent.temperature)
    config['temperature'][2] = temperature
    config.pop('temperature_by_options', None)
    config['training'] = {'method': manifest['method'], 'bestEpoch': best_epoch, 'seed': seed, 'trainingRows': len(train), 'validationRows': len(validation)}
    (checkpoint / 'rl_agent_config.json').write_text(json.dumps(config, indent=2) + '\n')
    log('finished', bestEpoch=best_epoch, temperature=temperature, validation=metrics(logits, targets, temperature), checkpoint=str(checkpoint))


if __name__ == '__main__':
    main()
