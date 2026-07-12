# Models and settings

The agent picks a model provider automatically from the API keys in your
environment. Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or an
OpenRouter key, and the agent uses that provider's default models. You can
override the choice per role, switch models mid-session, run a local model, and
tune per-model behavior.

## Model slots

The agent uses different models for different jobs. Each job is a **slot**:

- **main** — ordinary work: the coordinator and the code and research agents.
- **reasoning** — deep thinking: the oracle and explorer.
- **embedding** — the vectors behind [memory](/agent/memory).

Splitting the slots lets you run everyday turns on a fast, cheap model while the
oracle reasons on a stronger one.

## Choosing models at launch

Set the model for every slot at once with `--model`, or set the fast and slow
slots separately:

```bash
# one model for everything
agency agent --model claude-opus-4-8

# a fast model for ordinary work, a stronger one for deep reasoning
agency agent --fastmodel claude-haiku-4-5 --slowmodel claude-opus-4-8
```

`--fastmodel` sets the main slot; `--slowmodel` sets the reasoning slot. You can
also target a slot through `--model` with `slot=model`:

```bash
agency agent --model reasoning=claude-opus-4-8
```

### Forcing a provider

`--provider` forces the provider instead of auto-detecting it. Alone, it selects
that provider's default models:

```bash
agency agent --provider anthropic
```

Pair it with `--model` to reach any other provider, such as a LiteLLM proxy, an
OpenAI-compatible endpoint, or a custom model.

## Switching models mid-session

`/model` switches models without restarting. Run it bare to see the current slots
and pick from the catalog, or pass a spec directly:

```
/model                                    # show current, then pick
/model claude-opus-4-8                    # set every slot
/model reasoning=claude-opus-4-8          # set one slot
```

A model change takes effect on your next turn. It never disturbs a call already
in flight.

`/models` lists the hosted catalog with prices and context sizes. Pass a provider
to narrow it: `/models anthropic`.

## Local models

The agent can run a local model through
[`smoltalk-llama-cpp`](https://www.npmjs.com/package/smoltalk-llama-cpp). Install
it first:

```bash
npm i -g smoltalk-llama-cpp
```

Then launch with `--local`, or switch mid-session with `/local`:

```bash
agency agent --local                 # guided setup: pick from a catalog
agency agent --local qwen3.5-2b      # a curated short name
agency agent --local ./model.gguf    # a local .gguf file
```

`--local` pins every slot to the local model and downloads it on first use. It is
mutually exclusive with `--model`, `--fastmodel`, and `--slowmodel`. Local models
have no embedding endpoint, so memory falls back to its default behavior.

## Per-model settings

`/settings` shows the current model's capability profile and lets you change it.
The profile has four fields:

- **prompt** — `large` (the full coordinator prompt) or `small` (a compact prompt
  for small-context models).
- **summarize** — whether closed threads are summarized. See
  [cross-thread context](/guide/cross-thread-context).
- **memory** — whether [memory](/agent/memory) is on.
- **maxTokens** — the default output-token cap for a reply.

When you change a setting, the agent asks which **scope** it applies to: this
model, this provider, or all models. A more specific scope wins. This lets you,
for example, shrink the prompt only for one small local model while everything
else keeps the full prompt.

Some changes apply immediately, and some take effect at the next launch. The
agent tells you which when you save.
