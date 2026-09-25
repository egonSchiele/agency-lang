# Proposal: expose and explain llama.cpp's limits

A local llama.cpp model runs under two limits, and Agency does not tell you
when you hit either. The output cap can be raised per call or per run; the
context size cannot be set from Agency at all. This note describes both
limits, shows how they fail in the benchmark, and proposes three changes.

## The two limits

### The output cap: 16,384 tokens

`smoltalk-llama-cpp` caps each call at 16,384 output tokens when the call sets
no `maxTokens`:

```js
// smoltalk-llama-cpp/dist/llamaCpp.js
const DEFAULT_MAX_TOKENS = 16384;
options.maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
```

A thinking model spends this same budget on its thinking. A model that thinks
for 16,384 tokens returns no answer at all.

You can raise this cap from Agency, in either of two ways:

```ts
llm("...", { maxTokens: 30000 })       // one call
setLlmOptions({ maxTokens: 30000 })    // every later call; from std::llm
```

### The context window: 32,768 tokens

`smoltalk-llama-cpp` also caps the context window at 32,768 tokens. The prompt,
the thinking, and the answer all have to fit inside it.

```js
// smoltalk-llama-cpp/dist/nativeRegistry.js
const MAX_CONTEXT_TOKENS = 32768;
const context = await model.createContext({
    contextSize: contextSize ?? { max: MAX_CONTEXT_TOKENS },
});
```

The `{ max }` form sets a ceiling, not a fixed size. `node-llama-cpp` still
sizes the context automatically below it:

1. A model that supports less than 32,768 tokens keeps its own limit.
2. Under memory pressure, `node-llama-cpp` picks a smaller size.
3. A model that supports more than 32,768 tokens is cut down to 32,768.

The cap exists to save memory. `node-llama-cpp` reserves the whole KV cache
when it loads the model. The code comment gives the numbers for Qwen3.5, which
supports 262,144 tokens: 9.2 GB of KV cache at full size, and 1.7 GB at 32k,
with no measurable difference in speed.

You can override the cap with `metadata.llamaCppContextSize`, which sets an
exact size. The context is created once per model and lives for the whole
process. So the first call's value wins, and a later call that asks for a
different size gets a warning and the existing context.

Agency never sets `llamaCppContextSize`. The `llm()` builtin accepts a
`metadata` option, so you can pass it on one call. `setLlmOptions` does not
accept `metadata`, so you cannot set it once for a whole run.

## How this fails today

This run of `qwen3.5-2b` used the default limits:

```
[qwen3.5-2b] throughput (trial 1): FAIL in 65.9s  0 words
[qwen3.5-2b] actionItems (trial 1): ERR in 67.3s  reply did not fit the type. The model sent: ""
[qwen3.5-2b] math (trial 1): ERR in 64.2s  reply did not fit the type. The model sent: ""
```

The statelog shows what happened in each of these calls:

| Case | Output tokens | Thinking | Answer |
|---|---|---|---|
| throughput | 16,384 | 66,368 chars | none |
| actionItems | 16,384 | 59,942 chars | none |
| math | 16,384 | 40,889 chars | none |
| logic | 16,384 | 58,084 chars | none |

Every one of these calls hit the output cap while it was still thinking. The
thinking itself differed:

1. `throughput` finished planning the story, and the cap cut it off at "Writing: The".
2. `actionItems` reached the right list of owners, then kept checking it.
3. `math` repeated "Cost of 3 boxes + 1 muffin = $48" until the cap.
4. `logic` repeated "Wait, I should check if there's any possibility that..." until the cap.

Nothing in the output says the model ran out of tokens. The structured cases
report a type error with an empty reply. The `throughput` case reports "0
words". You have to open the statelog and count tokens to find the cause.

### Why Agency's existing hint does not appear

Agency already has a message for this exact case, in
`packages/agency-lang/lib/runtime/llmRetry.ts`:

```ts
function truncatedByTokenLimitHint(stopReason?: string): string {
  if (stopReason !== "length") return "";
  return (
    ` The model stopped because it hit the token limit, so this output is cut ` +
    `short rather than malformed. Raise maxTokens for this call. ...`
  );
}
```

The hint needs a stop reason of `"length"`. The hosted providers report one,
and smoltalk maps each of them to `"length"`. The llama.cpp provider does not
report one.

`node-llama-cpp` 3.21.1 does report why generation stopped. `generateResponse`
returns a stop reason, which is `"maxTokens"` when the cap ends generation.
`smoltalk-llama-cpp` 0.6.0 drops it when it builds its result:

```js
// smoltalk-llama-cpp/dist/llamaCpp.js
return success({
    output,
    toolCalls,
    ...(thinkingBlocks.length > 0 && { thinkingBlocks }),
    usage,
    cost,
    model: this.getModelName(),
});
```

## Proposed changes

### 1. Pass the stop reason through `smoltalk-llama-cpp`

Map `node-llama-cpp`'s `"maxTokens"` stop reason to smoltalk's `"length"`, and
include it in the result. Agency's existing hint then fires for local models
with no change in Agency.

This change lives in `smoltalk-llama-cpp`, which is a separate package.
Agency loads it from the global install, not from the workspace. So a fix
only reaches the benchmark after the global copy is updated.

### 2. Let `agency.json` set the context size

Add a `llamaCpp` section to `agency.json`, next to the existing `mlx` section:

```json
{
  "llamaCpp": {
    "contextSize": 65536
  }
}
```

Also add a flag to `agency run` that overrides it for one run:

```
agency run --local qwen3.5-2b --context-size 65536 run-model.agency
```

The runtime would pass the value to the provider as
`metadata.llamaCppContextSize`. The context is created once per model, so a
setting for the whole run matches how the provider works. A per-call option
would not.

### 3. Say which context size a model loaded with

When a llama.cpp model loads, print one line:

```
qwen3.5-2b: using 32,768 of 262,144 context tokens. Set llamaCpp.contextSize in agency.json to use more.
```

The statelog already has a `localModelLoaded` event. The event could carry the
context size that was used and the size the model supports.

## Open questions

1. What stop reason does `node-llama-cpp` report when the context window fills
   before `maxTokens` does? That case would need its own message, since raising
   `maxTokens` would not help.
2. Should `setLlmOptions` accept `metadata`? With change 2 in place, this
   matters less.
3. Should the default ceiling stay at 32,768? It protects memory, but a model
   with a large context gets a small one without being told. Change 3 makes the
   trade visible, and may be enough on its own.

## Status in the benchmark

`run-all.sh` passes `--max-tokens 8192` to every model, local or hosted, so
the comparison is fair. Set `MAX_TOKENS` to change it. 8,192 output tokens
plus a short prompt fit inside the 32,768-token context with room to spare.

The `needle` case does not fit. Its default 1,000-line log is about 17,000
prompt tokens, which leaves about 15,000 for output. Lower `--haystack` through
`BENCH_ARGS` if a local model runs out of room there.
