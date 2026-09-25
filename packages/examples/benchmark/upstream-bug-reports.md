# Upstream bugs: what to report, and what not to

Three problems came up while adding structured output for local models.
Checked against each project's issue tracker and contributing rules on
2026-09-23. Only one needs a new report.

| Problem | Project | Status upstream | What to do |
|---|---|---|---|
| Logits processor ignored after a request that had none | mlx-lm | Fixed on `main` by PR #1772 (merged 2026-08-25), not in any release; 0.31.3 (2026-04-22) is still the latest | Nothing to file. Keep the shim's workaround until a release lands, then drop it when the pin moves |
| `mlx_lm.server` ignores `response_format` | mlx-lm | Open as issue #1007 since 2026-03-15, no maintainer reply, no linked PR | Nothing new to file. A comment there, or a PR, if you want to push it |
| Grammar plus auto-opened `<think>` puts the JSON in the thought segment | node-llama-cpp | Not reported. Introduced by PR #636, shipped in 3.20.0; 3.21.1 still has it | File a bug. Draft below |
| Qwen tool parser raises on a parameter it cannot evaluate, and the server answers 502 | mlx-lm | Not reported. 0.31.3, `tool_parsers/qwen3_coder.py` | File a bug. Facts below |
| Gemma 4 wrapper spells the tool-result markers differently from the model's template | node-llama-cpp | Not reported. 3.21.1 | File a bug. Facts below |
| JSON-schema grammar does not read `anyOf`, so a zod union becomes "any value" | node-llama-cpp | Not reported. 3.21.1 | File a bug or a PR. Facts below |
| JSON-schema grammar's fixed indentation lets a long space token empty every array | node-llama-cpp | Not reported. 3.21.1 | File a bug. Facts below |

smoltalk-llama-cpp 0.7.2 works around the last three, so the benchmark no
longer depends on them. See "Three more node-llama-cpp findings" at the end.

## mlx-lm: the two things you cannot file

mlx-lm's CONTRIBUTING.md and its issue template say: "It is strictly
prohibited to use AI to write your posts for you (bug reports, feature
requests, pull request descriptions, ...)". So there is no draft here for
mlx-lm. If you comment on #1007, write it yourself. The facts you would
want to hand are these:

- The stale-processor bug in `GenerationBatch` was reported as PR #1225
  (2026-04-28, closed as superseded) and fixed by PR #1772. A related
  crash with mixed `None` and processor entries was fixed by PR #1826
  (2026-09-04). Every tag is behind both merges.
- The last comment on #1007 (2026-09-21) describes an out-of-tree
  Outlines patch and warns about exactly the batching trap above.
- A maintainer was asked in July which grammar library they would accept,
  outlines, xgrammar, or llguidance, and did not answer. Our shim is an
  llguidance patch over `mlx_lm.server`; the constraint class in
  `packages/agency-lang/lib/cli/mlxChatServer.py` would be the seed of a PR.

The reproduction below is still useful, as a check that a future release
has the fix. Save it as `mlx_lm_stale_processors.py` and run:

```
~/.agency-agent/mlx-env/bin/python mlx_lm_stale_processors.py /Volumes/adit-agency-models-sept-2026/hf/hub/mlx/mlx-community--Qwen3.5-2B-4bit
```

```python
"""mlx_lm 0.31.3: a logits processor is silently ignored after an earlier
request that had none. Fixed upstream in PR #1772, unreleased.

Expected: the same count both times (one call per generated token, plus
one for the last prompt token). On 0.31.3: after a first request without a
processor, the second request's processor runs once, during prompt
processing, and never again.
"""
import sys
from mlx_lm import load
from mlx_lm.generate import BatchGenerator

model, tokenizer = load(sys.argv[1])
prompt = tokenizer.encode("Say hello.")


def run(gen, uid):
    while True:
        for response in gen.next_generated():
            if response.uid == uid and response.finish_reason is not None:
                return


calls = []


def counting_processor(tokens, logits):
    calls.append(len(tokens))
    return logits


for first_has_processor in (True, False):
    gen = BatchGenerator(model, max_tokens=8, stop_tokens=[])
    first = [counting_processor] if first_has_processor else []
    (uid,) = gen.insert([prompt], max_tokens=[4], logits_processors=[first])
    run(gen, uid)
    gen.remove([uid])
    calls.clear()
    (uid,) = gen.insert([prompt], max_tokens=[4], logits_processors=[[counting_processor]])
    run(gen, uid)
    print(
        f"first request {'with' if first_has_processor else 'without'} a processor: "
        f"the second request's processor ran {len(calls)} times"
    )
    gen.close()
```

Output on this machine, 0.31.3:

```
first request with a processor: the second request's processor ran 5 times
first request without a processor: the second request's processor ran 1 times
```

## node-llama-cpp: the bug to file

**Where:** https://github.com/withcatai/node-llama-cpp/issues/new/choose,
the "Bug report" form. Blank issues are turned off. The form's fields are
filled in below, in order. Tick "Grammar" and "Metal" under features.

The form asks for a minimal example with no dependencies beyond
node-llama-cpp, a link to the model file, debug logging turned on with
`getLlama({ debug: true })`, and the output of
`npx --yes node-llama-cpp inspect gpu`. All of that is below.

### Reproduction

Save as `grammar-thinking.mjs` in a directory with node-llama-cpp
installed, and run it with the path to the model:

```
node grammar-thinking.mjs ~/.agency-agent/models/hf_unsloth_Qwen3.5-2B.Q4_K_M.gguf
```

The model is https://huggingface.co/unsloth/Qwen3.5-2B-GGUF, file
`Qwen3.5-2B-Q4_K_M.gguf`.

```js
import { getLlama, LlamaChat } from "node-llama-cpp";

const llama = await getLlama({ debug: true });
const model = await llama.loadModel({ modelPath: process.argv[2] });
const context = await model.createContext({ contextSize: 4096 });
const chat = new LlamaChat({ contextSequence: context.getSequence() });
console.log("wrapper:", chat.chatWrapper.constructor.name,
  "openOnResponseStart:", chat.chatWrapper.settings.segments?.thought?.openOnResponseStart);

const grammar = await llama.createGrammarForJsonSchema({
  type: "object",
  properties: { city: { type: "string" } },
  required: ["city"],
});
const result = await chat.generateResponse(
  [{ type: "user", text: "What is the capital of France?" }, { type: "model", response: [] }],
  { grammar, maxTokens: 200, temperature: 0 },
);
console.log("response:", JSON.stringify(result.response));
for (const item of result.fullResponse) {
  if (typeof item === "object" && item.type === "segment") {
    console.log(`segment ${item.segmentType}:`, JSON.stringify(item.text));
  }
}
await context.dispose();
await model.dispose();
```

Output on this machine, after the llama.cpp load logs:

```
wrapper: QwenChatWrapper openOnResponseStart: true
response: ""
segment thought: "{\n    \"city\": \"Paris\"\n}"
```

### The form, filled in

**Title**

`bug: with a grammar, a Qwen3.5 model writes the JSON inside the auto-opened thought segment and response is ""`

**Issue description**

A JSON schema grammar with a Qwen3.5 model returns `response: ""`; the
JSON is in the thought segment of `fullResponse`. Started in 3.20.0.

**Expected behavior**

`result.response` holds the JSON, as it did on 3.19.0. Either the grammar
starts once the thought segment closes, the way llama.cpp's server wraps a
`response_format` grammar in an optional reasoning block, or a grammar
stops the segment from being opened on response start.

**Actual behavior**

`result.response` is `""`. `fullResponse` has one segment of type
`thought` whose text is the grammar-shaped JSON:

```
wrapper: QwenChatWrapper openOnResponseStart: true
response: ""
segment thought: "{\n    \"city\": \"Paris\"\n}"
```

What I think happens: since PR #636 (3.20.0), `QwenChatWrapper` sets
`openOnResponseStart: true` on its thought segment when `thoughts` is
`"auto"`, the default, so every response starts inside an open `<think>`
block. `LlamaChat` applies a grammar from the first generated token
(`handlePrefixTriggers` returns before the segment logic when a grammar is
set, and `onModelResponseStartShouldOpenThoughtSegment` does not look at
the grammar), so the model is forced to write the schema's JSON while the
segment is open, and the segment handler files it as thinking. Nothing the
caller passes moves the JSON into `response`, short of turning thinking off
with `new QwenChatWrapper({ thoughts: "discourage" })`.

A grammar that works around it, for anyone who lands here: accept any token
up to the `</think>` token id, then the schema.

```
root ::= thinking-body <[248069]> [ \t\n]{0,4} json
thinking-body ::= !<[248069]>*
```

The named form `</think>` fails `createGrammar` with "Failed to parse
grammar", which I assume is the parse-time check running without a
vocabulary; the token id works.

**Steps to reproduce**

The script above, with `unsloth/Qwen3.5-2B-GGUF` `Q4_K_M`. Debug logging
is on in the script. The same script on 3.19.0 prints the JSON in
`response`.

**My environment**

| Dependency | Version |
|---|---|
| Operating System | macOS 27.0.0 (arm64) |
| CPU | Apple M5 Ultra |
| Node.js version | 26.9.0 |
| Typescript version | not used, plain ESM |
| `node-llama-cpp` version | 3.21.1 (prebuilt binaries v0.4.0) |

`npx --yes node-llama-cpp inspect gpu` output:

```
OS: macOS 27.0.0 (arm64)
Node: 26.9.0 (arm64)
node-llama-cpp: 3.21.1
Prebuilt binaries: v0.4.0
Metal: available
Metal device: Apple M5 Ultra
Metal used VRAM: 0% (448KB/222.72GB)
Metal free VRAM: 99.99% (222.72GB/222.72GB)
Metal unified memory: 222.72GB (100%)
CPU model: Apple M5 Ultra
Math cores: 10
Used RAM: 51.33% (131.42GB/256GB)
Free RAM: 48.66% (124.58GB/256GB)
Wired RAM: 2.92% (7.5GB/256GB)
Used swap: 0% (0B/0B)
Max swap size: dynamic
mmap: supported
```

**Additional context**

The same class of bug is open against llama.cpp's own server
(ggml-org/llama.cpp #20345), but this one is in node-llama-cpp's own
grammar and segment handling, not in the bundled llama.cpp.

**Relevant features used:** Metal, Grammar.

**Are you willing to resolve this issue by submitting a Pull Request?**
Your call. The grammar workaround above is what smoltalk-llama-cpp 0.6.0
ships; a fix inside `LlamaChat` would be to wrap the grammar the same way
when the thought segment is opened on response start.

## Three more node-llama-cpp findings (2026-09-25)

Found while chasing the benchmark's typed and tool cases on GGUF models,
each reproduced outside Agency with node-llama-cpp 3.21.1 alone. All three
are worked around in smoltalk-llama-cpp 0.7.2 (`lib/grammarSchema.ts`,
`lib/jsonWhitespace.ts`, and the Gemma 4 settings in `lib/llamaCpp.ts`), so
these are reports for their tracker, not blockers.

### Gemma 4's tool-result markers

`Gemma4ChatWrapper` writes a tool result as
`<tool_response>response:name{"…"}</tool_response>` and wraps a call's
parameters in two pairs of braces (`call:name{{"city": "Oslo"}}`). The
model's own chat template, and Google's prompt-format page, write
`<|tool_response>response:name{value:…}<tool_response|>` and one pair of
braces. Shown a result the wrapper's way, gemma-4-E4B and gemma-4-26B-A4B
ended the turn at once or wrote a stray `<tool_call|>`. With the template's
markers, both finish a three-call chain and answer. The wrapper's file cites
the same page, so the markers look like a transcription slip.

A second, separate cause: a chain of calls split across several `model`
history items (one per round, which is how a tool loop naturally records
it) breaks Gemma 4 even with the right markers. One `model` item holding
the whole chain works. That one is arguably the caller's job, and the
plugin now merges the items.

### `anyOf` in a JSON schema

`getGbnfJsonTerminalForGbnfJsonSchema` handles `oneOf`, `const`, and
`enum`, but not `anyOf`, and a schema part it does not recognise becomes
"any JSON value" with no warning. zod 4's `toJSONSchema` writes a union of
literals, the usual way to spell an enum, as
`anyOf: [{type: "string", const: "positive"}, …]`, so a field typed that
way came back as `null` from every model. Reading `anyOf` the way `oneOf`
is read fixes it.

### Fixed indentation empties arrays

The grammar for an array three levels deep is

```
rule1 ::= "[" whitespace-b-3-4-rule ( item ( comma-whitespace-b-3-4-rule item )* )? whitespace-b-2-4-rule "]"
whitespace-b-3-4-rule ::= [\n] (" "{12} | "\t"{3}) | [ ]?
whitespace-b-2-4-rule ::= [\n] (" "{8} | "\t\t") | [ ]?
```

Qwen3.5 writes a run of thirteen spaces after the line break as one token.
The grammar accepts it as the twelve spaces of indentation plus the
optional one before `]`, and then `]` is the only legal token. Every array
from Qwen3.5-4B and 9B came back empty, at temperature 0 as well; the 2B,
which happens to write twelve, filled them. Replacing each whitespace rule
with `[ \t\n]{0,64}` fixes all three models. The root rule's trailing
`"\n\n\n\n" [\n]*` has a related cost: a model that samples can write
line breaks instead of stopping for as long as they are allowed, and Gemma
4 spent ninety seconds on them; `[\n]{0,4}` ends the reply.

## mlx-lm: the Qwen tool parser fails the request (2026-09-25)

Found on the first Terminal-Bench trial against `mlx-community/Qwen3.8-27B-4bit`
through `agency local serve`. Worked around in `lib/cli/mlxChatServer.py`
(`make_tool_parsers_lenient`), so it does not block the benchmark; mlx-lm's
rules on AI-written reports apply, so this is the material, not a draft.

`mlx_lm/tool_parsers/qwen3_coder.py`, `_convert_param_value`, converts each
`<parameter=…>` by the type in the tool's schema. Two paths raise out of the
parser, and `ToolCallFormatter.__call__` in `server.py` catches only
`ValueError` and `JSONDecodeError`, so the request ends in a 502:

- A parameter whose schema type is not one it knows (anything outside its
  string, int, float, bool, and object sets, such as a type the schema
  spells `"filename"` or omits) is read with `ast.literal_eval`. A plain word
  like `regex.txt` is not a Python literal, and `literal_eval` raises
  `SyntaxError`, which nothing catches.
- An object parameter is read with `json.loads`, and when the model wrote
  anything after the closing brace (`{"a": 1} and more`, seen with a
  10,000-character value) that raises `JSONDecodeError`, which the parser
  turns into a second `ast.literal_eval` that raises again.

In the trial, every tool call the agent made after its planning step hit one
of these, the agent retried twice per call, and the task ended with nothing
written. With a fallback that hands the text through unconverted, the same
calls go through, since the agent's tools take strings and check them.
