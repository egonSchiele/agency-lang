# `std::embedding`

`embed(text)` and `embedMany(texts)` turn text into vectors through the
active LLM client, and `cosineSimilarity(a, b)` compares two of them. This note records how the module is wired and the
choices that are easy to get wrong when changing it.

## Files

- `stdlib/embedding.agency` — the two exported functions and their types.
- `lib/stdlib/embedding.ts` — `_embedTexts`, the one helper both embed functions call, and `_cosineSimilarity`, which is pure arithmetic and needs no runtime context.
- `tests/agency/cosineSimilarity.agency` — the execution test for the pure half.
- `lib/stdlib/embedding.test.ts` — the accounting and validation cases.

## One helper, two wrappers

Both Agency functions call `_embedTexts(texts, ...)`. `embed` wraps one
string in a list and unwraps the first vector. That keeps the accounting
code in one place. If you add a third entry point, route it through the
same helper.

## The call is metered like an image generation

`_embedTexts` follows `_generateImage` in `lib/stdlib/image.ts` step for
step, and the order matters:

1. Validate the inputs. An empty list or a blank entry is refused before
   dispatch, so it is never billed.
2. Dispatch through `meteredDispatch(ctx, stack, "embedding", ...)`. A
   rejected promise records one unresolved attempt so `pricingComplete`
   goes false.
3. On a failure result, return the failure. Nothing is billed.
4. On success, record usage with `recordUsage(... kind: "embedding" ...)`,
   add tokens to the branch counter, emit `embedCompletion` to statelog,
   and only then call `stack.enforceGuards()`.
5. Only after guards, check that the vector count matches the input
   count.

Guards run last so a cost guard trip wins over the count-mismatch
failure. A provider that charged for the call and returned too few
vectors is still billed.

## Tokens: use the projected total

The branch token counter (`getTokens()` in `std::thread`) is fed by
`addTokens`. Embedding providers do not all report `totalTokens`; the
`smoltalk-llama-cpp` provider sends only `inputTokens`. The helper passes
the usage through `projectProviderTokenUsage(usage, "embedding")` and
adds its `totalTokens`, which sums the parts when the total is absent.
Reading `tokenUsage.totalTokens` directly would add zero for such a
provider.

## Option forwarding

`omitEmpty` drops the Agency defaults (`""` and `0`) before the config
reaches the client, so the client's own defaults apply. `apiKey` and
`baseUrl` are fanned out to every provider slot smoltalk's `EmbedConfig`
knows, because the provider name is not known until smoltalk resolves it
from the model name.

## What is not here

- No interrupt. Like `llm()` and `generateImage`, an embedding call is a
  paid model call with no side effect on the user's machine, and cost
  guards are the control.
- No local `llama-cpp` route yet. With smoltalk 0.13.2,
  `provider: "llama-cpp"` reaches smoltalk's custom-provider registry and
  fails with "does not support embeddings" until smoltalk 0.14.0 wires
  the plugin's `embed` export in. Ollama works today.
- No end-to-end Agency test. `DeterministicClient.embed` returns a
  failure on purpose so memory tests skip vector recall, so the coverage
  lives in the vitest file with a fake client.
