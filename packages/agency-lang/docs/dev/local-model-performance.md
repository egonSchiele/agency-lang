# Local model performance and structured output: an investigation

Written 2026-08-12. Everything below was measured on one machine (Mac Studio,
Apple M1 Max, 64 GB unified memory) against one model file
(`hf_unsloth_Qwen3.5-4B.Q4_K_M.gguf`, 2.4 GB) plus a small Gemma 3 used as a
control. Treat the numbers as indicative of that setup, not as universal.

## The original problem

A local run pinned to `qwen3.5-4b` was given a prompt of roughly 23,000 tokens.
It produced nothing for ten minutes and then timed out. An earlier smoke test
with a ~50-token prompt had worked fine.

The question was whether ten minutes is simply what a 4B model costs on this
hardware, or whether something in our code is wrong.

## Background: what the two phases of an LLM call cost

Answering a prompt happens in two phases with very different performance
characteristics, and the distinction matters for everything below.

**Prefill** (prompt processing) is the model reading what you sent. Before it
can emit a single token it computes and stores intermediate values for every
token of the prompt. Like a lawyer who must read all 200 pages of a contract
before answering a question about page 3 — the reading happens regardless of how
short the question is. This phase is compute-bound and processes many tokens in
parallel.

**Generation** is the model writing its answer, one token at a time. Each token
depends on the previous one, so there is no parallelism to exploit; for every
single token the machine streams the model's entire 2.4 GB of weights through
the chip. This phase is memory-bandwidth-bound.

The asymmetry is large and worth internalizing: on this machine 23,000 tokens
*in* costs about 45 seconds, while 500 tokens *out* costs about 12 seconds. The
50-token smoke test felt instant because it skipped the expensive phase almost
entirely.

**The KV cache** is where the prefill values are kept. The model must retain
them, because generating token 501 requires looking back at all 500 before it.
Crucially it is allocated **up front at full size**, based on the maximum
conversation length the context is configured for — not grown as it fills. Like
renting a warehouse: you pay for the whole warehouse on day one whether you
store one box in it or a million.

## What was measured

Benchmarks ran node-llama-cpp directly, configured exactly the way
`smoltalk-llama-cpp` configures it, so the results reflect the real code path.

| Measurement | Result |
|---|---|
| Model load | 1.4 s, 33/33 layers offloaded to the Metal GPU |
| Prefill, 24,016-token prompt | **47 s** (~500 tok/s); one outlier run at 120 s |
| Generation | ~40 tok/s |
| Short prompt, end to end | 5 s |

The hardware is behaving correctly. The GPU is being used, every layer is
offloaded, and ~500 tok/s prefill is a reasonable figure for an M1 Max on a 4B
Q4 model.

**A 23,000-token prompt should therefore answer in roughly one to two minutes.
Ten minutes is not expected behavior**, and none of the bugs found below
reproduce it. See "What is still unexplained" at the end.

## Finding 1: the context is created with no options

`smoltalk-llama-cpp/dist/nativeRegistry.js:56`:

```js
const context = await model.createContext();
```

node-llama-cpp's default is `contextSize: "auto"`, which inspects free memory,
sees ~51 GB available, and allocates the model's **full advertised 262,144-token
context**. Measured allocations:

```
model weights only                      2.73 GB
+ default context (262,144 tokens)     11.89 GB   ← 9.2 GB of KV cache
+ 32,768-token context                  4.41 GB   ← 1.7 GB of KV cache
```

9 GB is reserved to hold a conversation that needs under 2 GB.

This did not make prefill slower in isolation — four configurations (default
context, 32k context, flash attention forced on, batch size raised to 2048) all
prefilled the same 24k prompt in ~47 s. But it is the best available explanation
for why two otherwise identical runs measured 47 s and 120 s. That much memory
pressure on a shared 64 GB machine makes timings erratic.

**Scope.** This only bites models with a very large advertised context. Gemma 3
was checked as a control: its training context is 32,768, so `"auto"` picks
32,768 and there is nothing to fix. Qwen3.5 advertises 262,144 — 8× larger — so
the same code overshoots badly. Mistral Small (128k) would also benefit. Setting
a cap costs nothing on models that are already modest.

## Finding 2: structured output returns an empty string on Qwen

An initial reading suggested Qwen was incompatible with structured output. **That
was wrong.** The model is fully capable; a default in the layer above breaks it.
Identical request, identical model, identical schema, varying only the chat
wrapper configuration:

| Wrapper configuration | Result |
|---|---|
| Auto-detected (current behavior) | `""` — empty, 3.4 s |
| `variation: "3.5"` | `""` — empty, 3.2 s |
| `thoughts: "discourage"` | valid JSON, verbose |
| `variation: "3.5", thoughts: "modelInitiated"` | `{"answer": "Blue", "confidence": 0.95}`, 1.0 s |

`thoughts` is the operative option; `variation` alone changes nothing.

### What a chat wrapper is

A concept owned by **node-llama-cpp** (`dist/chatWrappers/`), not by smoltalk and
not by Agency. Every model family expects its conversation formatted with its own
markers. The wrapper is the translator. The same two-message conversation:

```
Qwen:   "<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n
         <|im_start|>user\nWhat color is the sky?<|im_end|>\n
         <|im_start|>assistant\n"

Gemma:  "BOS<start_of_turn>user\nYou are a helpful assistant.\n\n---\n\n
         What color is the sky?<end_of_turn>\n
         <start_of_turn>model\n"
```

Gemma has no system-message slot at all, so the wrapper folds the system text
into the user turn behind a `---`. The wrapper also does the reverse job: it is
what knows that `<tool_call>{...}` is a tool call rather than literal text, and
that anything between `<think>` and `</think>` is hidden reasoning.

`smoltalk-llama-cpp` never selects one. In `llamaCpp.js` it calls
`new LlamaChat({ contextSequence: entry.sequence })` with no `chatWrapper`
argument, so node-llama-cpp auto-detects from the GGUF metadata. The
auto-detection is correct — it picks `Qwen` for the Qwen file and `Gemma` for the
Gemma file. The problem is the default *configuration* of the correctly-chosen
wrapper.

### The mechanism

`QwenChatWrapper.js`:

```js
thought: {
    prefix: LlamaText(new SpecialTokensText("<think>\n")),
    suffix: LlamaText(new SpecialTokensText("\n</think>")),
    openOnResponseStart: thoughts === "auto"      // default is "auto", so: true
}
```

consumed at `LlamaChat.js:1011`. `openOnResponseStart: true` pushes the model
into a `<think>` block automatically at the start of every response, before the
model chooses anything.

A JSON-schema grammar is a hard constraint: the only permitted output is JSON
matching the schema. The forced `<think>` token is not valid JSON, so generation
halts immediately with `stopGenerationTrigger` and the caller receives an empty
string — after paying the full prefill cost.

Gemma's entire segments configuration is `{}`. It has no thought segment, so
nothing can be force-opened and no collision is possible. Gemma produced
structurally valid JSON on the first attempt with zero configuration. That is the
general rule: **models that think by default can collide with structured output;
models that do not, do not.** Qwen3, DeepSeek-R1 and gpt-oss are in the risky
group; Gemma, Mistral and Llama are not.

## Finding 3: tool calling is unaffected

Tool calling was tested on Qwen in all three wrapper configurations, including
the one that is broken for JSON:

```
tools, auto wrapper        | 2567ms | calls=["getWeather({"city":"Paris"})"]  ok
tools, thoughts=discourage | 1223ms | calls=["getWeather({"city":"Paris"})"]  ok
tools, 3.5+modelInitiated  | 1235ms | calls=["getWeather({"city":"Paris"})"]  ok
```

Broken structured output does **not** imply broken tool calling. The two use
separate machinery, and the reason is the most useful thing found in this
investigation. `LlamaChat.js:1966`:

```js
grammarEvaluationState: () => {
    if (this.functionEvaluationMode !== false)
        return this.functionsEvaluationState;   // tool-call grammar
    return this.grammarEvaluationState;          // user's JSON grammar
}
```

This is a callback consulted **fresh for every token**, so the active constraint
can change mid-response.

- **Tool calls:** `functionEvaluationMode` starts as `false`, so generation is
  entirely unconstrained at first. The model may think, write prose, do anything.
  Only once it emits the `<tool_call>` marker does the mode flip and the grammar
  engage, forcing the arguments to match the parameter schema. Thinking happens
  before the constraint exists, so nothing collides.
- **A user JSON schema:** the evaluation state is built once at `LlamaChat.js:910`,
  before the first token, and applies from token one — including to the `<think>`
  token the wrapper just forced.

The constraint is identical in kind. The only difference is *when it starts*.

(For background: a grammar is a hard filter over the vocabulary re-applied at
every step. The model scores all ~151,000 possible next tokens; the grammar sets
every token that would violate the schema to negative infinity before one is
picked. That is why grammar-constrained JSON cannot be malformed — a malformed
continuation is unpickable, not merely discouraged.)

## Already correct: Agency only sends a schema when asked

One proposed change turned out to be unnecessary — Agency already does it.
Compiling:

```agency
node main() {
  let a: string = llm("hi")
  let b: number = llm("how many")
}
```

produces:

```js
// a — no schema at all:
runPrompt({ prompt: `hi`, messages: ..., clientConfig: {} })

// b — schema, because the type annotation demanded it:
runPrompt({ prompt: `how many`, responseFormat: z.object({ response: z.number() }), ... })
```

A `string` result sends no `responseFormat`, so no grammar is built.

This has a consequence for the original timeout: **if the failing call returned a
string, no grammar was involved and Finding 2 was never in play.** The thinking
collision cannot explain the ten minutes.

## Proposed changes

Both live in `smoltalk-llama-cpp`, which is installed globally rather than
vendored in this repo — so they need to be made in that package's source and
released, not patched here.

### Change 1: cap the context size

In `nativeRegistry.js:56`:

```js
const context = await model.createContext({
  contextSize: { max: 32768 },
});
```

The `{max: n}` form keeps automatic sizing — it will still shrink under memory
pressure rather than failing outright — while capping the ceiling. A plain number
is also acceptable and more predictable. Low risk; measurably identical speed at
a fifth of the memory.

Raising `batchSize` from its 512 default and forcing flash attention on were both
tested and changed nothing measurable. Leave them alone.

### Change 2: do not force-open a thinking segment when a grammar is attached

`llamaCpp.js` constructs a fresh `LlamaChat` on every call, inside the same
function that already inspects `config.responseFormat`. So it can choose the
wrapper per call: when a `responseFormat` is present, build the wrapper with
`thoughts: "modelInitiated"`; otherwise leave the default untouched so ordinary
calls keep their reasoning.

Prefer `modelInitiated` over `discourage`. `discourage` invokes
`discourageThoughtsInModelResponse()`, which rewrites prior turns to strip
thinking out — changing the prompt text, invalidating the KV cache prefix, and
forcing a full re-prefill. On a 23k-token prompt that is 45 seconds discarded per
call. `modelInitiated` produces byte-identical prompt text to the default and
only flips the force-open behavior.

Two implementation caveats:

1. It must be conditional on the wrapper actually being a thinking model.
   `GemmaChatWrapper` accepts no such option and must keep working untouched.
2. The wrapper is currently auto-detected. Reconfiguring it means resolving it
   explicitly, taking over a decision node-llama-cpp makes for us today. Verify
   this does not regress detection for other model families.

**This fix should not live in Agency.** Agency's job is to say "I want a result
matching this schema." Which wrapper is used, whether the model thinks, and how a
thinking segment interacts with a grammar are llama.cpp-shaped concerns that no
other provider shares — the OpenAI path has nothing resembling them. Configuring
them from Agency would mean Agency reaching into the internals of one specific
local backend.

### The better fix, and why it is not available yet

The ideal behavior is what the tools path already does: leave generation
unconstrained until the thinking segment closes, then engage the JSON grammar.
The machinery exists and is proven.

It is not exposed. `LlamaChat.d.ts:318-325` declares one variant with
`grammar?: LlamaGrammar` and another with `grammar?: never` — node-llama-cpp
explicitly forbids passing `grammar` and `functions` together, which is exactly
why smoltalk carries the line `if (grammar && !functions)`. There is no
`startGrammarAfterThought` option and no segment-aware hook for a user grammar.
Getting this behavior requires a change **inside node-llama-cpp**, upstream.

| Approach | Effort | Result |
|---|---|---|
| `thoughts: "modelInitiated"` | one conditional in smoltalk-llama-cpp | Structured output works. Thinking is effectively suppressed on those calls. |
| Late-engaging grammar | upstream node-llama-cpp change | Structured output works *and* the model can reason first. |

Note the tradeoff in the first row: correct JSON at the cost of reasoning on
exactly the calls where reasoning may matter most. A third option, when reasoning
matters more than a guarantee, is to send no schema, let the model think and
answer freely, and parse the JSON afterward.

## What is still unexplained

**The original ten-minute timeout is not reproduced by any finding above.**
Prefill is ~45 s, and the structured-output bug fails *fast* — it returns empty in
roughly the time prefill alone takes. The two leading hypotheses, neither
confirmed:

1. **Repeated re-prefill.** All calls share one sequence and one KV cache
   (`nativeRegistry.js`). If the history prefix does not match between calls — a
   tool loop, or a changed system prompt — llama.cpp re-evaluates all 23k tokens
   each round. Twelve rounds is almost exactly ten minutes, which fits
   suspiciously well.
2. **Unbounded generation.** Agency never sets `maxTokens`
   (`lib/runtime/agencyLlm.ts:96`), so a reasoning model may generate until the
   ceiling. At 40 tok/s, ten minutes is ~24,000 tokens.

To distinguish them, re-run with debug logging and count `promptRequest` events.
Many means re-prefill, and the fix is in how the shared sequence is reused. One
means capping `maxTokens` is the answer.

One detail argues the deadline may not have fired at all:
`DEFAULT_RETRY_POLICY` sets `retries: 2` and the timeout is **per attempt**
(`lib/runtime/llmRetry.ts:139`, `lib/runtime/prompt.ts:387`). A genuine
`callTimeout` would have retried twice, so the failure would surface after
roughly thirty minutes, not ten. Stopping at ten suggests either manual
interruption or a different failure path.

## Reproducing any of this

The benchmarks were throwaway scripts placed inside
`/opt/homebrew/lib/node_modules/smoltalk-llama-cpp/` (so that
`import ... from "node-llama-cpp"` resolves) and run with `node`. They have been
deleted. The shape that matters:

```js
import { getLlama, LlamaLogLevel, LlamaChat, QwenChatWrapper } from "node-llama-cpp";
const llama = await getLlama({ logLevel: LlamaLogLevel.error });
const model = await llama.loadModel({ modelPath: MODEL });
const context = await model.createContext({ contextSize: 32768 });
const chat = new LlamaChat({ contextSequence: context.getSequence() });
const grammar = await llama.createGrammarForJsonSchema({ /* schema */ });
const res = await chat.generateResponse(history, { grammar, maxTokens: 400 });
```

Useful instrumentation: `context.contextSize` / `context.batchSize` for what
`"auto"` actually resolved to, `llama.getVramState()` for allocation,
`res.metadata.stopReason` for why generation ended, and an `onToken` callback
that timestamps the first token to separate prefill from generation.
