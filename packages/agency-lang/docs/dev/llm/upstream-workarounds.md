# Workarounds for upstream bugs

Agency's local model servers are Python scripts built on other projects:
`mlx_lm`, `mlx-audio`, and `mlx-vlm`. Where one of those has a bug that
Agency's users hit, the script works around it, usually by replacing one of
the library's functions with a fixed copy. Each workaround should come out
once a release fixes the bug and the version pin moves past it, because a
patch over a library's internals can break quietly when that library changes.

This page lists every workaround, so that whoever moves a pin knows what to
check and what to remove. Add a row when you add a workaround, and delete
it when you remove one.

The pins are in `lib/cli/localServe.ts` (`MLX_LM_VERSION`,
`MLX_AUDIO_VERSION`, `LLGUIDANCE_VERSION`) and `lib/cli/vlmChat.ts`
(`MLX_VLM_VERSION`). The CI workflow `.github/workflows/mlx-server-tests.yml`
installs the same versions.

## How to check a new release

1. Read each row below for the library you are moving. For the ones whose
   last column names a test, run the script's tests against the new
   version, with the workaround removed. If the test passes, the release
   fixed the bug.
2. For a memory workaround, also run the server under load and watch its
   memory: unit tests show that an array is freed, not that a long reply on
   a real model stays flat.
3. Check the seams too, not only the workarounds: `mlxChatServer.py`
   subclasses `mlx_lm.server`'s handler and generator and overrides some of
   their methods. mlx_lm 0.32.2, for example, adds a `stream` argument to
   `_serve_single`, which the override in this script does not take.

## `mlx_lm` (pinned at 0.31.3), in `lib/cli/mlxChatServer.py`

| Workaround | The bug | Upstream | In 0.32.2 | How to tell it can come out |
|---|---|---|---|---|
| `settled_step`, which wraps `GenerationBatch._step` | `ArraysCache.advance` subtracts from its padding and length counters lazily, so each step's counters keep the graph of every earlier step. After about 10,000 tokens the process passes Metal's 499,000-buffer limit, the generation thread dies, and every later request gets a 404. | Fixed by mlx-lm #1632, merged 2026-08-22, after 0.31.3 (reports #1641, #1332, #1672; #1642 was closed in favor of #1632) | `ArraysCache.state` now includes the padding and length counters, so evaluating a cache's state evaluates them too, but `advance` still subtracts lazily. Not checked at runtime | A long reply (10,000+ tokens) on a Qwen3.5-family model, with the wrapper removed, does not fail with `Resource limit (499000) exceeded` |
| `copying_extract`, which replaces `ArraysCache.extract` | A finished request's rows are taken out of the batch with a slice, `c[idx : idx + 1]`, which shares the whole batch's buffer. Each finished request kept a full copy of the batch's recurrent state in the prompt cache: about 3 GB at 16 requests, 1.5 GB at 8. | Not reported | Same code | `FinishedRequestCache.test_a_finished_request_keeps_only_its_own_rows` passes with the replacement removed |
| `settled_extract`, which wraps `GenerationBatch.extract_cache` and `PromptProcessingBatch.extract_cache` | Nothing evaluates a finished request's extracted rows, and an array not yet computed keeps its inputs, so even the copies `BatchKVCache.extract` makes hold the batch's keys and values. | Not reported | Same code | The same test passes with the wrapper removed |
| `releasing_filter`, which wraps `GenerationBatch.filter` | When a request finishes, the batch's arrays are rebuilt one row smaller, and the old ones go to MLX's cache of freed buffers. mlx_lm clears that cache while it processes prompts and every 512 generation steps (0.31.3 too). Requests finish far more often than that, and the new sizes never reuse the old buffers, so the cache grew to 19 GB on 16 requests between clears. | Not reported | Same: clears every 512 generation steps | A release releases the old batch's buffers and clears the cache each time the batch shrinks, and `FinishedRequestCache.test_after_the_batch_shrinks_its_old_arrays_are_returned` passes with the wrapper removed. The 512-step clear alone is not enough |
| `make_logits_processors`, which replaces `server._make_logits_processors` and gives every request at least one processor | When no request in the batch had a processor, `GenerationBatch.filter` left the list of processors untrimmed, so the next request's reply watcher sat at the wrong index and never ran. | Fixed in mlx-lm #1772, after 0.31.3 | Fixed: `filter` trims the list every time | Remove `keep_logits` and the line that adds it |
| `lenient_param_value`, which wraps `qwen3_coder._convert_param_value` | A tool-call parameter that does not read as its declared type raises out of the parser (`int("abc")`, `int(float("1e400"))`), and the server answers 502 to the whole request. | Not reported; facts in `packages/examples/benchmark/upstream-bug-reports.md` | Still raises for numbers | `LenientToolParameters` passes with the wrapper removed |
| `union_param_value`, which wraps the same function | The parser reads only a single `type` on a parameter's schema. A union such as `number \| null`, written as `anyOf`, has none, so a number arrives as text. | Not reported | Still reads only `type` | `UnionToolParameters` passes with the wrapper removed |
| `Generator._serve_single` trims the prompt cache | mlx_lm holds the prompt cache to `--prompt-cache-bytes` only for batched requests. A request it cannot batch (any request with a seed, or every request when a draft model is loaded) can grow the cache past the limit. | Not reported | Still trims only on the batched path | A seeded request no longer grows the cache past `--prompt-cache-bytes` with the override removed |
| `Generator.check_generating` | When the generation thread dies, mlx_lm keeps queueing requests for it, and each one waits for ever. | Not reported | 0.32.2 records the failure (`generation_available()`), so check whether its handler now refuses requests | A request sent after the thread has died fails at once with the override removed |
| `ChatHTTPServer`, which sets `request_queue_size = 128` | `mlx_lm.server` uses Python's `ThreadingHTTPServer`, whose listen queue holds 5 connections. A burst of 16 requests, which the server would batch, mostly failed with a connection reset, and `agency local serve` answered 502. | Not reported | Same server class | 16 requests sent at once all succeed with the class removed |

The first four rows are memory problems, and they are worst on
Qwen3.5-family models, whose linear-attention layers keep about 157 MB of
state per request in an `ArraysCache`. They cost one evaluation per step and
one evaluation and one cache clear per finished request, on every model.

### Additions, not workarounds

The script also adds things `mlx_lm.server` does not do. They are not bugs,
but a release that adds them makes the copy here redundant:

- Structured output (`response_format`), enforced with llguidance. Open
  upstream as mlx-lm issue #1007.
- gpt-oss's Harmony format: `teach_harmony` gives the tokenizer its thinking
  and tool-call markers, and `parse_harmony_tool_call` reads its tool calls.
- `one_system_message` and `fold_reasoning_effort`, which reshape a request
  for chat templates that take one system message or read
  `reasoning_effort` only from template kwargs.
- The reply limits (`Watcher`) and stopping a reply whose client has gone.

## `mlx-audio` (pinned at 0.5.4), in `lib/cli/mlxSpeechServer.py`

`patch_mlx_audio_for_orpheus` applies three patches before the Orpheus
module loads. `docs/dev/llm/local-speech.md` has the details under
"Orpheus". None are reported upstream.

| Workaround | The bug |
|---|---|
| `fetch_from_models_dir` replaces `snac.fetch_from_hub` | The SNAC decoder is loaded by repo id at import time, through `huggingface_hub`, which cannot run offline on an empty cache. |
| `eos_ids` replaces `lm_generate._eos_ids` | It calls `set()` on the tokenizer's `eos_token_ids`, which is one int for the Orpheus tokenizer, and raises. |
| `from_dict_with_local_tokenizer` replaces `ModelConfig.from_dict` | The tokenizer is loaded from the full-size repo by id, not from the model's own directory. |

## `mlx-vlm` (pinned at 0.7.0)

No workarounds. `docs/dev/llm/mlx-local-models.md`, under "Chat with
pictures", lists its limits, such as a non-streaming reply that keeps
running after its client has gone.

## Elsewhere

`packages/examples/benchmark/upstream-bug-reports.md` records the bugs found
while adding structured output, including three in node-llama-cpp that
smoltalk-llama-cpp works around, outside this repository. mlx-lm's
contributing rules forbid bug reports written with AI, so that file holds
the facts for a person to file, not drafts.
