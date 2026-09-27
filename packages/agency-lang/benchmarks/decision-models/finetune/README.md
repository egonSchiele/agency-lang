# Fine-tune Laya for SMS classification

The exported checkpoint is for **SMS spam yes/no classification only**. Do not use it for choice questions, score questions, or unrelated tasks. Training changes a shared decision head using only SMS yes/no labels, and both export paths remove inherited temperature overrides for all question types. Serving it under the API name `english` does not make it a general-purpose English checkpoint.

These scripts use Python 3.11 and an Apple Silicon Mac with MPS. The recorded experiment used Python 3.11.9 and an Apple M3. The dependency versions are pinned in `requirements.txt`.

## Install and start the base model

From `packages/agency-lang`:

```bash
export BENCH=benchmarks/decision-models
python3.11 -m venv .venv-laya
.venv-laya/bin/python -m pip install -r "$BENCH/finetune/requirements.txt"
mkdir -p "$BENCH/outputs"
.venv-laya/bin/hf download convaiinnovations/laya \
  --revision 55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851 \
  --include 'model.safetensors' 'rl_agent_config.json' 'encoder/*' 'tokenizer/*' \
  --local-dir "$BENCH/outputs/laya-base"

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-laya/bin/python \
  "$BENCH/finetune/serve_laya_checkpoint.py" \
  --checkpoint "$BENCH/outputs/laya-base" --port 8000
```

Keep the server in its own terminal. It serves the local checkpoint as model `english` through Laya's standard API. Stop it before training to free GPU memory. The base checkpoint is about 1.6 GB; training also caches encoder outputs in memory. Downloading and installing require network access, while training and serving can run offline.

## Train

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-laya/bin/python \
  "$BENCH/finetune/finetune_laya_sms.py" \
  --data "$BENCH/data/sms/sms-unique.jsonl" \
  --baseline "$BENCH/results/sms/laya-english-sms.jsonl" \
  --base-model "$BENCH/outputs/laya-base" \
  --out "$BENCH/outputs/sms-head"
```

Use a new output directory for each experiment. The baseline header fixes the original 500 test IDs and verifies the dataset checksum. The split uses seed 20260927 and removes another 12 case/whitespace-normalized duplicates before splitting the remaining data. It produces 4,159 training messages, 500 validation messages, and 500 test messages. The test rows never enter training or validation.

The text encoder and action head stay frozen. The script trains 26,248,193 parameters in the existing decision transformer, type embedding, and scorer. It caches the frozen encoder's fp32 outputs and checks that the cached forward matches the native forward. Exported checkpoints use Laya's normal full inference path.

Training uses cross-entropy, AdamW at 1e-5, weight decay 0.01, batch size 16, gradient clipping at 1, and cosine decay to 1e-6 over five epochs. The best validation log loss selects the saved head. Training stops after two epochs without improvement. A normally completed run fits a scalar temperature on validation labels in the range [0.5, 5], then exports a full checkpoint. It removes inherited temperature overrides so they cannot mask the fit.

## The archived stopped run

The recorded experiment stopped during epoch four. Its best completed checkpoint was epoch three, with 95.4% validation accuracy. We exported that saved head with temperature 1, without additional training or calibration. Its test accuracy was 94.2%. See [the archived training history](../results/sms/finetune/training.jsonl) and [export metadata](../results/sms/finetune/export.json).

The default training command runs the original five-epoch plan to completion, so it can produce a different selected checkpoint and temperature. Setting `--epochs 3` also changes the learning-rate schedule and does not recreate the archived run. Seeds do not guarantee identical results across hardware or dependency versions. The archive records the original training-script hash; that script is included here unchanged.

If you interrupt a run after it has saved an improved epoch, export the saved head with:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-laya/bin/python \
  "$BENCH/finetune/export_stopped.py" \
  --run "$BENCH/outputs/sms-head" --base-model "$BENCH/outputs/laya-base"
```

Export requires `best-head.safetensors`, `manifest.json`, and `training.jsonl` from that run. It refuses an existing `checkpoint/` directory. The archived weights are excluded from Git, so the committed metadata alone cannot recreate their exact bytes. Keep training stopped while exporting; interrupting a checkpoint write can leave an incomplete file.

## Verify and evaluate

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-laya/bin/python \
  "$BENCH/finetune/verify_checkpoint.py" \
  --run "$BENCH/outputs/sms-head" --base-model "$BENCH/outputs/laya-base" \
  --report "$BENCH/outputs/sms-head-verification.json"

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-laya/bin/python \
  "$BENCH/finetune/serve_laya_checkpoint.py" \
  --checkpoint "$BENCH/outputs/sms-head/checkpoint" --port 8001
```

Verification checks that frozen tensors did not change, the exported head matches the selected head, and native probabilities match a direct forward on 16 validation messages. It writes a new report and refuses to overwrite one. The recorded report verified 170 unchanged encoder tensors and 31 changed head tensors.

In a second terminal:

```bash
export BENCH=benchmarks/decision-models
pnpm benchmark:decisions --data "$BENCH/data/sms/sms-unique.jsonl" \
  --backend laya --model english --base-url http://127.0.0.1:8001 \
  --checkpoint-sha256 "$(shasum -a 256 "$BENCH/outputs/sms-head/checkpoint/model.safetensors" | cut -d ' ' -f 1)" \
  --limit 500 --seed 42 --repeats 3 \
  --out "$BENCH/outputs/laya-finetuned.jsonl"
```

Keep the sampling settings unchanged when comparing with the archived baselines. Laya's API reports a generic model identity; record the served weights' SHA-256 in the run header and retain the manifest and export settings alongside each output. The CLI records the supplied hash; it cannot attest to a remote server's loaded weights.

## References

- [Laya project and fine-tuning documentation](https://github.com/NandhaKishorM/laya)
- [Upstream training and calibration notebook](https://github.com/NandhaKishorM/laya/blob/main/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb)
- [SMS dataset attribution](../data/sms/README.md)

This experiment uses supervised training of the existing decision head. It does not reproduce the upstream RLCD recipe.
