# DraftSequenceTokenPredictor never returns when a Qwen3.5 target samples (temperature > 0) with the default evaluate options, and uses no predictions on a Qwen3 pair

## Summary

With a `DraftSequenceTokenPredictor` attached to a Qwen3.5 sequence, `LlamaChat.generateResponse` never resolves when `temperature` is above 0 and the predictor keeps its default `evaluateOptions`. Giving the predictor `evaluateOptions: { temperature: 0 }` lets it resolve. With `temperature: 0` on the target it resolves, but `sequence.tokenPredictions` reports zero predictions used and the call is slower than the same call without the predictor.

A standard-attention pair (Qwen3 0.6B drafting for Qwen3 8B) does not hang at any temperature, so the hang looks specific to the Qwen3.5 architecture (hybrid attention, `qwen35` in the GGUF header). But that pair also reports zero predictions used, at temperature 0 and 0.7, and is slower with the predictor than without. So there are two findings: a hang on one architecture, and a predictor that never contributes on either.

## Environment

- node-llama-cpp 3.21.1, installed as a dependency of smoltalk-llama-cpp 0.7.0
- Node 26.9.0
- macOS 27.0.0 (Darwin 27.0.0), Apple M5 Ultra, 256 GB, Metal backend
- Hanging pair: target `unsloth/Qwen3.5-4B-GGUF` Q4_K_M, draft `unsloth/Qwen3.5-2B-GGUF` Q4_K_M (GGUF architecture `qwen35`; same family and tokenizer; `ensureDraftContextIsCompatibleForSpeculative` does not object)
- Working pair: target `unsloth/Qwen3-8B-GGUF` Q4_K_M, draft `unsloth/Qwen3-0.6B-GGUF` Q4_K_M (architecture `qwen3`)

## Reproduction

```js
import {
  getLlama, LlamaChat, DraftSequenceTokenPredictor, LlamaLogLevel, resolveChatWrapper,
} from "node-llama-cpp";

const temperature = Number(process.argv[2]); // 0 completes, 0.7 hangs
const llama = await getLlama({ logLevel: LlamaLogLevel.error });
const model = await llama.loadModel({ modelPath: "Qwen3.5-4B.Q4_K_M.gguf" });
const draftModel = await llama.loadModel({ modelPath: "Qwen3.5-2B.Q4_K_M.gguf" });
const context = await model.createContext({ contextSize: 4096 });
const draftContext = await draftModel.createContext({ contextSize: 4096 });
const sequence = context.getSequence({
  tokenPredictor: new DraftSequenceTokenPredictor(draftContext.getSequence()),
});
// Thinking off, so the reply is visible text rather than a thought block.
const chatWrapper = resolveChatWrapper(model, {
  customWrapperSettings: { qwen: { thoughts: "discourage" } },
});
const chat = new LlamaChat({ contextSequence: sequence, chatWrapper });

setTimeout(() => { console.log("HUNG after 60s"); process.exit(3); }, 60_000);
const t0 = Date.now();
const r = await chat.generateResponse(
  [{ type: "user", text: "Write three sentences about the sea." }],
  { maxTokens: 120, temperature },
);
console.log(((Date.now() - t0) / 1000).toFixed(1) + "s", JSON.stringify(r.response.slice(0, 50)), JSON.stringify(sequence.tokenPredictions));
process.exit(0);
```

## Observed

Qwen3.5 pair (4B target, 2B draft):

| call | result |
|---|---|
| `temperature: 0.7`, predictor attached | never resolves; killed after 60 s |
| `temperature: 0.7`, predictor with `evaluateOptions: { temperature: 0 }` | resolves |
| `temperature: 0.7`, predictor with `minConfidence: 0` | never resolves |
| `temperature: 0`, predictor attached | resolves in 1.0 s, `tokenPredictions` = `{"used":0,"unused":0,"validated":0,"refuted":0}` |
| `temperature: 0`, no predictor | resolves in 0.6 s |
| no `temperature` given, predictor attached | resolves, `tokenPredictions` all zero |

Qwen3 pair (8B target, 0.6B draft), a 200-word story prompt with `maxTokens: 300`:

| call | result |
|---|---|
| `temperature: 0.7`, predictor attached | resolves in 2.6 s, 109.7 tok/s, `tokenPredictions` = `{"used":0,"unused":0,"validated":0,"refuted":0}` |
| `temperature: 0`, predictor attached | resolves in 3.5 s, 86.7 tok/s, `tokenPredictions` all zero |
| `temperature: 0`, no predictor | 119.7 tok/s |
| `temperature: 0.7`, no predictor | 123.7 tok/s |

While hung (Qwen3.5 pair), both the main thread and the worker threads are idle (a `sample` of the process shows every thread in `kevent`, `uv_cond_wait`, or `semaphore_wait_trap`; no llama.cpp frames). So it looks like a promise that never settles rather than native work that never finishes.

The same happens through `LlamaChat.generateResponse` with an `AbortSignal`, with `budgets`, and without them; the temperature is the only input that decides it.

## Expected

Either the predictor works with a sampling Qwen3.5 target (the docs describe `evaluateOptions` as defaulting to the target sequence's, which suggests a sampled target is a supported case), or a sampling target is rejected up front with an error on the architectures where it cannot work. And on both pairs, some predictions used, or a note in the docs on why a same-family draft with the default `minConfidence` never contributes.

## Notes

In both pairs the draft and target share a tokenizer, vocabulary type, BOS and EOS ids, and the BOS/EOS add flags. Both models are loaded on one `Llama` instance, with `contextSize` equal on both contexts. Swapping the model paths in the script above for the Qwen3 pair is the whole difference between the two runs. I can run other variants on request; the machine and models are at hand.
