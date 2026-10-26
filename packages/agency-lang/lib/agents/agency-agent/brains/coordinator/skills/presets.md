---
name: presets
description: Create, change, delete, list, or pick the default agent preset (saved provider, model, and tool-limit settings).
---

# Presets

A preset is a named set of settings the agent can start with: a provider,
models, two tool limits, and `llm()` options. Presets live in the agent's
settings.json. A preset does not change your prompt, your tools, or the
approval policy.

## Fields

Set only the fields the user asked for.

- `provider`: the provider, such as `anthropic`, `openai`, `google`, `openrouter`.
- `pin`: one model for normal work and deep reasoning.
- `slots`: a model per purpose. `main` is normal work, `reasoning` is deep
  reasoning, `embedding` is memory embeddings and must be written
  `provider/model`, such as `openai/text-embedding-3-small`.
- `local`: a local model name, `hf:` URI, `.gguf` path, `mlx:` URI, or
  model directory. With `local`, set nothing else except `slots.embedding`.
- `maxToolCallRounds`: the most tool-call rounds in one turn, a whole number above zero.
- `maxToolResultChars`: the most characters of one tool result you see.
  `0` means no cap.
- `llmOptions`: `llm()` options for the preset's models, the same fields
  `useLlmOptions` takes. The common one is `openRouter.provider`, which
  picks the companies OpenRouter may send calls to, such as
  `{ openRouter: { provider: { ignore: ["open-inference"] } } }`.

## Tools

- `listPresets()`: the saved presets, the default, and the active one.
- `savePreset(name, preset)`: create or replace one.
- `deletePreset(name)`: delete one.
- `setDefaultPreset(name)`: make one the default. `savePreset` cannot.
- `useLlmOptions(options)`: set `llm()` options for this session only,
  from the next turn. Nothing is saved, and no approval is asked.

Every preset change asks the user to approve reading and writing settings.json.

## Steps

1. Call `listPresets` first when the request replaces or deletes a
   preset, or names one you have not seen.
2. Before replacing a preset that exists, tell the user what it holds now
   and ask whether to replace it.
3. After a save, tell the user to run `/preset <name>` to use it now, or
   `agency agent --preset <name>` to start with it. Saving does not
   switch the current session.
4. Report what the tool replied. A reply that starts with "Not saved"
   means nothing was saved.

## Example

User: make me a preset called cheap that uses openrouter with deepseek r1 for normal work

```
savePreset("cheap", { provider: "openrouter", slots: { main: "deepseek/deepseek-r1" } })
```

User: make it my default

```
setDefaultPreset("cheap")
```

User: use fireworks only for glm, and save that as a preset called glm-fw

```
useLlmOptions({ openRouter: { provider: { only: ["fireworks"], allowFallbacks: false } } })
savePreset("glm-fw", { provider: "openrouter", pin: "z-ai/glm-5.3-flash", llmOptions: { openRouter: { provider: { only: ["fireworks"], allowFallbacks: false } } } })
```
