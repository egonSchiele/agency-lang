# Laya fine-tuning comparison

Training was stopped at the user’s request during epoch four. The best completed checkpoint, epoch three, was selected by validation log loss and exported. No further optimizer updates or post-training calibration were performed. Validation accuracy was 95.4%; held-out test accuracy was 94.2%.

All four runs use the same 500 test messages, repeated three times. All 1,500 fine-tuned model calls succeeded. Test IDs, dataset hash, and case/trial coverage match the original runs. The fine-tuned model’s labels were identical across all three repetitions.

| Metric | Jev | Laya base | Laya fine-tuned (4,159 SMS training messages; epoch 3) | GPT-4o-mini logprobs (A=false, B=true) |
|---|---:|---:|---:|---:|
| Accuracy | 96.47% | 86.20% | 94.20% | 91.20% |
| Macro-F1 | 0.922 | 0.777 | 0.886 | 0.833 |
| Spam precision | 84.0% | 47.7% | 69.8% | 60.1% |
| Spam recall | 88.9% | 96.8% | 95.2% | 89.4% |
| Median latency | 184 ms | 40 ms | 40 ms | 482 ms |
| p95 latency | 294 ms | 63 ms | 59 ms | 925 ms |
| Brier error, lower is better | 0.0700 | 0.2004 | 0.0921 | 0.1372 |

Always predicting ham scores 87.4%, above base Laya's 86.2%. The other three setups received no task-specific training or demonstrations in this experiment. Fine-tuned Laya used 4,159 labeled SMS training messages plus 500 validation messages.

The 94.2% result is from epoch three of an unfinished run. Its exact weights are not committed, so the model and score cannot be recreated from this repository alone; the saved responses reproduce the reported metrics. The GPT-4o-mini result depends on this specific prompt, label order, and A=false/B=true encoding. Alternative prompts were not tested.

Fine-tuning improves accuracy by 8.0 percentage points while keeping latency essentially unchanged. Per 500 messages, false spam flags fall from 67 to 26, while missed spam rises from two to three. With that additional SMS training, the fine-tuned model is more accurate than the tested GPT-4o-mini setup and remains less accurate overall than Jev; it catches a larger proportion of spam than Jev.

Paired bootstrap intervals resample the 500 cases, keeping repeated trials together. The fine-tuned accuracy advantage is 8.0 points over base Laya (95% interval 5.6–10.6 points), 3.0 points over GPT-4o-mini (0.53–5.53), and -2.27 points versus Jev (-4.2 to -0.4). These results concern this sample and task. The dataset is public and old, and baseline results were already inspected before this follow-up experiment.

The experiment trained 26,248,193 existing decision-head parameters on 4,159 messages, using another 500 for validation. The 500 benchmark messages never entered training or validation; normalized duplicate text was also excluded across splits. The text encoder and action head stayed frozen. The question, option wording, architecture, and 0.5 decision threshold were unchanged. This is supervised head-only fine-tuning, not full encoder training or the upstream RLCD recipe.

Checkpoint verification confirmed all 170 encoder tensors were unchanged, 31 head tensors changed, the selected head exactly matches the export, and native predictions matched the expected probabilities on 16 validation cases. The fine-tuned benchmark ran on local Apple M3 MPS through Laya’s standard HTTP server on port 8001. That temporary server has been stopped; restart instructions are in the fine-tuning README.

Artifacts:

- `comparison.json`: metrics, paired intervals, export and verification details.
- `finetune/manifest.json`: exact split IDs, seed, and settings.
- `finetune/training.jsonl`: training and validation history.
- `finetune/export.json`: selected epoch and stopped-run export settings.
- `finetune/checkpoint-verification.json`: frozen-weight and prediction checks.
- The four adjacent JSONL files contain the raw benchmark results.

Model weights are excluded from Git. See [fine-tuning instructions](../../finetune/README.md) to train and export a local checkpoint. The fine-tuned run header was annotated retrospectively with the checkpoint hash from its verification report. Other measured records are unchanged. The base Laya run did not record a weights hash, so its exact served weights cannot be established from its header. Historical JSON records retain their original paths; those paths describe the original run and are not required to read its results.

No paid API calls or cloud training were used for this fine-tuning experiment.
