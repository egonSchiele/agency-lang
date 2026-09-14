# `std::embedding`

`embed` and `embedMany` turn text into vectors through the active LLM
client. `cosineSimilarity` compares two vectors. The module lives in
`stdlib/embedding.agency` and its helpers in `lib/stdlib/embedding.ts`.

## Accounting order

`_embedTexts` does the same steps as `_generateImage` in
`lib/stdlib/image.ts`, in the same order:

1. Refuse an empty list or a blank entry before dispatch, so it is never billed.
2. Dispatch through `meteredDispatch` with the `embedding` kind.
3. On a failure result, return it. Nothing is billed.
4. On success, record usage, add tokens, emit `embedCompletion`, then call `stack.enforceGuards()`.
5. After guards, check that the vector count matches the input count.

Guards run last so a cost guard trip wins over the count-mismatch
failure.

## Tokens

The branch token counter uses `projectProviderTokenUsage`, which sums
input and output tokens when a provider sends no total. Some embedding
providers only report input tokens. Reading `totalTokens` directly would
add zero for them.

## API key and base URL

smoltalk keeps one API key slot per provider and resolves the provider
from the model name after it receives the config. The helper does not
know which slot smoltalk will read, so it copies the caller's key into
every slot. The base URL is handled the same way.

## No interrupt

An embedding call is a paid model call with no side effect on the
machine, the same as `llm()` and `generateImage`. Cost guards are the
control.

## Tests

`lib/stdlib/embedding.test.ts` covers the accounting with a fake client.
`DeterministicClient.embed` returns a failure on purpose so that memory
tests skip vector recall, which rules out an Agency execution test for
`embed`. `tests/agency/cosineSimilarity.agency` covers the pure half.
