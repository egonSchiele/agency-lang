# Structured output on local models: findings

Written 2026-09-23, while benchmarking local models with `benchmark/run-model.agency`.

## The symptom

On local models, every benchmark case that asks for a typed reply broke. These are
`extract`, `actionItems`, `math`, `logic`, and `classify`. The same cases pass on
hosted models. Cases that return plain text or call tools mostly worked.

| Model | Route | Typed cases |
|---|---|---|
| qwen3.5-2b | GGUF, llama.cpp | all error or fail |
| qwen3.5-4b | GGUF, llama.cpp | all error or fail |
| qwen3-coder-next-mlx | MLX | all error or fail |

The log showed errors like `Cannot read properties of undefined (reading 'toLowerCase')`.
That message came from a bug in the benchmark script, not from the model. See
"A bug in the benchmark script" below.

The models can produce the JSON. There are two separate bugs, one for each way a
local model runs.

## Background: how a server forces JSON

A model writes one token at a time. At each step it gives a score (a "logit") to
every token it knows, about 150,000 of them, and a sampler picks one.

A **logits processor** is a small function that runs between those two steps and
can change the scores. A **JSON logits processor** knows the schema and how much of
the JSON has been written so far. It sets the score of every token that would break
the schema to minus infinity, so the sampler cannot pick it. For example:

- After `{"vendor": `, only a token that opens a string (`"`) is allowed.
- Once the object is complete, only "end of reply" is allowed.

The reply cannot come out as anything but valid JSON. llama.cpp calls the same idea
a **grammar**. `outlines` and `llguidance` are Python libraries that build one from
a JSON schema.

## Bug 1: GGUF models file the JSON as thinking

**Route:** Agency → smoltalk → `smoltalk-llama-cpp` 0.5.0 → node-llama-cpp 3.21.1 → llama.cpp.

- **What `smoltalk-llama-cpp` does:** it turns the schema into a grammar
  (`createGrammarForJsonSchema`) and passes it to node-llama-cpp.
- **What goes wrong:** Qwen3.5 is a "thinking" model. node-llama-cpp's Qwen chat
  format starts every reply inside an open `<think>` block. Its settings say
  `openOnResponseStart: true` for the thought segment.
- **The result:** the grammar forces JSON from the first token. The model writes the
  correct JSON, but the `<think>` block is still open, so node-llama-cpp counts that
  JSON as thinking. The reply part, `result.response`, is what smoltalk returns, and
  it comes back empty.

**Evidence.** I called node-llama-cpp directly with Qwen3.5-2B and a two-field schema:

| Setup | Reply | Thinking |
|---|---|---|
| Grammar, default settings | `""` | `{"vendor": "Bluefin Logistics", "total": 1371.50}` |
| Grammar, `budgets: { thoughtTokens: 0 }` | the JSON without its opening `{` | `{` |
| Grammar, `QwenChatWrapper({ thoughts: "discourage" })` | the correct JSON | nothing |

Through Agency, the same failure sometimes shows up as prose instead of `""`. In one
run the reply was a markdown list. That fits the same cause: once the grammar-bound
JSON has been filed as thinking, whatever the model writes afterwards is not
constrained.

**Where it is in node-llama-cpp:**
- When a grammar is set, `LlamaChat` skips its thinking-detection step and applies the
  grammar from the first token (`dist/evaluator/LlamaChat/LlamaChat.js`, around
  line 1358).
- The release notes for v3.20.0 (2026-08-11) include "Qwen chat wrapper auto thought
  segment opening". That is probably when this started.
- 3.21.1 is the latest version (2026-09-12) and still behaves this way. I found no
  open issue about thinking and a grammar together.

**Side effect for timing:** `smoltalk-llama-cpp` calls `clearHistory()` after every
call, so llama.cpp never reuses work from one call to the next. Benchmark trials on
GGUF models are not sped up by any cache.

## Bug 2: MLX models never see the schema

**Route:** Agency → smoltalk (OpenAI-style request with `response_format`) →
`agency local serve` front door → `mlx_lm.server` 0.31.3.

- **`mlx_lm.server` ignores it:** the server reads about 30 fields from each request,
  such as temperature, stop words, tools, and `logit_bias`. `response_format` is not
  one of them, and nothing in the `mlx_lm` package mentions it. The server does have
  the slot for logits processors (`server.py:414`), but nothing builds one from a
  schema.
- **Agency's front door passes it through:** it forwards each request body to
  `mlx_lm.server` unchanged (`lib/cli/mlxServer.ts:75`).
- **So the schema is dropped with no warning.** The model answers in prose, and the
  typed call fails. This affects every typed `llm()` call on an MLX model, not just the
  benchmark.

**Live check:** I served Qwen3.8-27B-4bit with `agency local serve` and sent a strict
`json_schema` request, with thinking off, asking it to extract an invoice's vendor
and total. It replied in markdown prose: `Here are the extracted details... *
**Vendor:** Bluefin Logistics...`. The response had only `role` and `content`.

## How other tools handle this

### LM Studio's MLX engine

LM Studio's `mlx-engine` (github.com/lmstudio-ai/mlx-engine, MIT license, checked at
commit `08f0c07`) is about 13,000 lines of Python on top of `mlx-lm` and `mlx-vlm`. It
reuses Apple's model code and generation loop, and adds structured output, tool-call
parsing, prompt caching, image input, and its own OpenAI-style server
(`python -m mlx_engine.server`, route `/v1/chat/completions`).

- **Structured output:** it reads `response_format` (`mlx_engine/server/chat.py:261`)
  and adds an `outlines` JSON logits processor (`mlx_engine/generate.py:569`).
- **Thinking, for JSON:** nothing special. The schema is enforced from the first
  token. I did not test whether a thinking model hits the same problem as Bug 1 there.
- **Thinking, for tool calls:** `mlx_engine/tool_runtime.py` has a "reasoning guard".
  It watches for the `<think>` and `</think>` tokens, lets the model write freely while
  thinking, and switches the tool-call grammar on only after thinking closes.

### llama.cpp's own server

The upstream llama.cpp server handles thinking and a schema together
(`common/chat-auto-parser-generator.cpp`, last changed 2026-09-12). When a schema is
set, it builds one grammar:

```
optional(<think> ...any text up to </think>... </think>)  then  JSON matching the schema
```

The model thinks freely, and only the part after `</think>` has to match. This is in
llama.cpp's server layer. node-llama-cpp calls llama.cpp's lower-level core and builds
its own grammar, so `smoltalk-llama-cpp` does not get it.

LM Studio's own llama.cpp engine is closed source, so I could not check what it does.

## Options

Two facts change the picture from the sections above.

- llguidance, the grammar library llama.cpp and vLLM use, ships an MLX
  integration inside its wheel: `llguidance.mlx` is a Metal kernel that masks
  logits, `llguidance.hf.from_tokenizer` wraps a Hugging Face tokenizer, and its
  grammar syntax can say "an optional think block, then JSON" in one line:

  ```
  start: (<think> /(.|\n)*/ </think>)? %json { ...schema... }
  ```

  Its 1.8.0 wheel installs on the Python 3.14 venv Agency uses.
- The GGUF bug is specific to node-llama-cpp 3.20 and later. In 3.19 a grammar
  simply stops any thought segment from opening, so the JSON lands in the reply.
  The smoltalk checkout pins 3.19.0; the globally installed `smoltalk-llama-cpp`
  resolves to 3.21.1, whose Qwen wrapper auto-opens `<think>`.

### For MLX models

| # | Solution | Where the code goes | Effort | Complexity added | JSON guaranteed? | Keeps thinking? |
|---|---|---|---|---|---|---|
| M1 | Ship a small Python script that starts mlx_lm's own server with a handler that reads `response_format` and adds an llguidance logits processor | Agency: new `lib/cli/mlxChatServer.py` next to the embed and speech scripts, plus a few lines in `localServe.ts` | Small to medium: about 150 lines of Python, 20 of TypeScript, tests | Low to medium. One more shipped script, one more pip package, and it reaches into mlx_lm internals, so mlx-lm needs a version pin like mlx-audio has | Yes | Yes, via the grammar above |
| M2 | M1 with xgrammar instead of llguidance | Same | Small to medium | As M1, plus the "switch the grammar on after `</think>`" logic is written by hand, which is where Ollama's stray-period bug came from | Yes | Yes |
| M3 | Upstream the feature to mlx-lm | mlx-lm repo | Medium: their style, continuous batching, review cycle. Issue #1007 has had no reply since March 2026 | None once released | Yes | Depends on what they accept |
| M4 | Launch a third-party MLX server instead: LM Studio mlx-engine, mlx-omni-server, vllm-mlx, or mlx-openai-server | Agency `localServe.ts`, install docs | Medium | Medium. A second Python package tree with its own quirks. mlx-engine is 13k lines and has the same JSON-in-reasoning bug on Qwen3.5 (lmstudio-bug-tracker #1971); vllm-mlx turns thinking off when a schema is set | Yes | Mostly no |
| M5 | Use Ollama for MLX (and GGUF) | Replaces the local catalog, download, and serve code | Large | Removes Agency code but adds an external daemon. Ollama 0.34 does thinking-aware structured output on MLX with xgrammar, but the Homebrew build ships without the xgrammar library | Yes | Yes |
| M6 | Prompt-side fallback: strip `response_format`, put the schema in a system message, strip `<think>`, rely on Agency's validation retries | The front door (`mlxServer.ts`) or smoltalk's `SmolMlx` | Small | Low | No | Yes |
| M7 | Fail with a clear error on typed calls to MLX | Agency | Tiny | None | n/a | n/a |

M1 is small because mlx_lm's server already exposes `_run_http_server` with a
`handler_class` argument, already carries a `logits_processors` list per
request, and already tracks the think-start and think-end tokens for its own
state machine.

### For GGUF models

| # | Solution | Where the code goes | Effort | Complexity added | JSON guaranteed? | Keeps thinking? |
|---|---|---|---|---|---|---|
| G1 | Prepend a "free text up to `</think>`" rule to the JSON-schema GBNF, using token ids for `</think>` | `smoltalk-llama-cpp` `llamaCpp.ts`, sync and stream paths | Small: about 40 lines plus a test | Low | Yes | Yes |
| G2 | Two passes: generate freely with a stop trigger on `</think>`, then a grammar pass with the thought as `responsePrefix` | Same file | Medium, untested | Medium. A two-call flow duplicated in sync and stream, plus a second prompt evaluation | Yes | Yes |
| G3 | Drop to `sequence.evaluate` and switch the grammar state on at `</think>` | Same file | Medium to large | High. Reimplements the template rendering, segments, stop handling, and tool calls that `LlamaChat` does today | Yes | Yes |
| G4 | Pass a chat wrapper with `thoughts: "discourage"` when a grammar is set | Same file | Small | Low, but only the Qwen wrapper has that option | Yes | No |
| G5 | Pin node-llama-cpp below 3.20 | package.json | Tiny | None, but it is a freeze rather than a fix | Probably | No |
| G6 | Run llama.cpp's own `llama-server` binary behind the front door, like mlx_lm today | Agency serve code, binary download and versioning; smoltalk talks to it as OpenAI-compatible | Large | Removes the native addon and `smoltalk-llama-cpp` from the path, adds binary management. Its grammar generator does wrap the schema in an optional reasoning block, but llama.cpp issue #20345 (open, March 2026) reports it not enforced with thinking on | Yes, verify first | Yes |
| G7 | Report to node-llama-cpp | Issue tracker | Tiny | None | Eventually | Yes |

G1 has one risk. node-llama-cpp checks grammars with a null vocabulary before
use, so the named form `</think>` is likely rejected. The numeric form
`<[id]>` should pass, and the ids come from the model's tokenizer.

### Cross-cutting, worth doing regardless

Agency's lenient parser never strips `<think>` blocks, the validation retry
message deliberately omits the schema, and validation retries default to zero.
A small change in the runtime, about 30 lines, would make the benchmark
measure the model rather than the plumbing while the constrained-decoding work
lands.

### Recommendations

- **MLX:** build M1 with llguidance, and add M7's clear error until it lands.
- **GGUF:** try G1 first, since it is a small experiment. Fall back to G2 if the
  grammar parser rejects token references. File G7 either way.
- Skip M4, M5, and G3: they trade one set of quirks for another and add the
  most surface area.

## What was built (2026-09-23)

Both M1 and G1 were built and run. Each fixed its bug, and each turned up a
second bug underneath.

### M1: `agency local serve` honours `response_format`

`lib/cli/mlxChatServer.py` in the Agency package is `mlx_lm.server` with a
request handler that reads `response_format`, a response generator that
builds an llguidance constraint per request, and that constraint appended to
the request's logits processors. `agency local serve` now starts the script
instead of `python -m mlx_lm.server`, checks that `llguidance` imports, and
pins `mlx-lm==0.31.3` and `llguidance==1.8.0` in the venv instructions.

A thinking model goes through three phases: at the start it may open
`<think>` or begin the JSON; inside the block anything goes except ending
the reply; after `</think>` every token has to fit the schema. When the chat
template opened the block itself, the reply starts in the second phase.
mlx_lm already works out which of those applies, in `_tokenize`, and the
script reads its answer.

Checked by hand against Qwen3.5-2B-4bit, one request each:

| Request | Reply |
|---|---|
| Schema, thinking off | `{"vendor": "Bluefin Logistics", "total": 1371.50}` |
| Schema, thinking on, temperature 0.7 | 500 to 1200 tokens of thinking, then the same JSON |
| Schema, thinking on, temperature 0 | thinking loops ("Okay, final output. Wait, I should check…") until the token limit. The same happens with no schema at all, so this is the model at greedy decoding, not the constraint |
| No schema | prose, as before |

**Second bug, in mlx_lm 0.31.3.** After any request with no logits
processors, the next request's constraint was ignored. `GenerationBatch.remove`
trims its list of processors only when some entry is truthy, so a finished
request with an empty list left a stale entry behind, and the next request's
constraint sat at the wrong index. The script gives every request at least
one processor, one that changes nothing, so the list is never all-empty.

Through the benchmark (`--cases extract,actionItems,classify --trials 2`,
served at temperature 0.7), every reply that finished was JSON that fit the
type. `extract` failed on content both times (the model wrote "Bluefin
Logistics LLC" and once the wrong total), `classify` passed once and hit the
token limit once, and `actionItems` hit the token limit both times. Those are
the model thinking too long, which the typed cases can now measure.

### G1: a grammar that lets the model think first

`smoltalk-llama-cpp` 0.6.0 builds the grammar in `lib/thinkingGrammar.ts`.
When the model's chat wrapper has a thought segment, the JSON-schema GBNF
is renamed to a `thinking-json` rule and put behind a rule that accepts any
token but `</think>`, then `</think>` itself, written as its token id:

```
root ::= thinking-body <[248069]> thinking-gap thinking-json
thinking-body ::= !<[248069]>*
```

When the wrapper does not open the block itself, the block is optional and
starts with the `<think>` token id. The ids come from the wrapper's own
prefix and suffix, so another wrapper's spelling works too. The named form
`</think>` is rejected by node-llama-cpp's grammar check, as predicted; the
numeric form parses. The dependency moved to `node-llama-cpp ^3.21.1`, the
first release where both the auto-opened block and token matching exist.

Called directly with Qwen3.5-2B at temperature 0, the model thought, closed
the block, and `result.response` was the JSON; 2.8 seconds in all.

**Second bug, in the plugin.** Through Agency, the grammar was never
applied at all. Agency sends `tools: []` on a call with no tools, the plugin
took an empty list as "has tools", and since node-llama-cpp cannot apply a
grammar and functions together, it dropped the grammar. Every typed call
from Agency was unconstrained; the "JSON filed as thinking" failure only
shows up when the grammar is applied, which Agency never did. An empty list
is now no tools. Tests cover both the grammar choice and the empty list.

Through the benchmark, with the plugin built from the checkout
(`AGENCY_LLAMA_PROVIDER_MODULE` pointing at its `dist`), at Agency's default
temperature, which is greedy: `extract` came back as JSON that fit the type
in every trial, in about 6 seconds, failing on content the same way as on
MLX. `actionItems` thought until the token limit, as on MLX. `classify` came
back as JSON both times, with an empty `labels` list, after about 1,900
tokens of thinking; on MLX at temperature 0.7 the same model filled the
list. Whether a grammar forced onto a small model at greedy decoding costs
answer quality is a question for the full benchmark, now that it measures
the model.

**Third finding, in the first grammar.** The rule between `</think>` and the
JSON allowed any amount of whitespace. In the `classify` case, the model at
greedy decoding wrote tabs until the token limit, since every token it
wanted was masked and a tab was the best of what remained. The gap is now
at most four whitespace characters, after which the JSON has to start.

### Still open

- The MLX shim reaches into three names inside `mlx_lm.server`, and one of
  its workarounds is for a bug in mlx_lm 0.31.3's batch generator. Both
  deserve an upstream report: the missing `response_format` (issue #1007),
  and the stale processor list.
- node-llama-cpp deserves a report too (G7): a grammar plus an
  auto-opened thought block files the JSON as thinking.
- Sampling. Agency sends no temperature, so both local backends decode
  greedily, and Qwen3.5-2B loops in its thinking at greedy decoding on the
  longer cases. That is independent of structured output, but it decides
  whether the typed cases finish. Whether Agency should pass a temperature
  for local thinking models is a separate decision.
- Tools plus a schema. Both backends leave the schema unenforced when the
  call carries tools. Google's smoltalk client makes two requests in that
  situation; the same could be done here.

## A bug in the benchmark script (fixed)

The typed cases used `const invoice: Invoice = llm(...)` and read fields straight off
the result. When the reply didn't fit the type, `llm()` returned a failure. Reading
`.vendor` from a failure gave `undefined`, and the next method call crashed. That
crash hid the real error.

The five typed cases now use `T!` and check for a failure. The case is recorded as an
error that quotes the model's reply, for example:

```
extract (trial 1): ERR  reply did not fit the type. The model sent: "**Invoice Details:** * **Invoice Number:** INV-20931 ...
```

Until one of the fixes above lands, the typed cases on local models measure the
plumbing, not the model.

## Not yet verified

- Whether the two-pass approach (G2) works in node-llama-cpp. It was not
  needed, since G1 worked.
- Whether LM Studio's `mlx-engine` handles thinking models correctly on the
  JSON path. Its bug tracker (#1971) says it does not, for Qwen3.5.
- Whether node-llama-cpp 3.19.x behaves differently. Its source says a
  grammar stops the thought block from opening at all, so the JSON would
  land in the reply, with no thinking.
- How much turning thinking off lowers scores on the reasoning cases.
