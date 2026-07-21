# Models and settings

The agent picks a model provider automatically from the API keys in your environment. Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`, and the agent will pick it up automatically. You can also set an explicit model and provider:

```bash
agency agent --provider anthropic
agency agent --model claude-opus-4-8
```

## Model slots

The agent uses different models for different jobs:

- **main** — fast and cheap model for ordinary work
- **reasoning** — slower and more capable model for deep thinking
- **embedding** — computes vector embeddings, needed for [memory](/agent/memory).

You can set models for specific slots:

```bash
# a fast model for ordinary work, a stronger one for deep reasoning
agency agent --fastmodel claude-haiku-4-5 --slowmodel claude-opus-4-8
```

If you set a provider, Agency will use its preset models for that provider:

```bash
# use google's fast and slow models
agency agent --provider google
```

If you set a model using the `--model` flag, it will use that model for everything:

```bash
# one model for everything
agency agent --model claude-opus-4-8
```

You can also target a slot through `--model` using `slot=model`:

```bash
agency agent --model reasoning=claude-opus-4-8
```

Agency will print the models its going to use at startup. You can also run `/model` to see the models it's currently using.

## Switching models mid-session

You can switch models without restarting by using `/model`. Run it bare to see the current slots
and pick from the catalog, or set a slot directly:

```
/model                                    # show current, then pick
/model claude-opus-4-8                    # set every slot
/model reasoning=claude-opus-4-8          # set one slot
```

You can use `/models` to list the hosted catalog with prices and context sizes. Pass a provider
to filter: `/models anthropic`.

## Local models

The agent can run a local model through [`smoltalk-llama-cpp`](https://www.npmjs.com/package/smoltalk-llama-cpp). Install it first:

```bash
npm i -g smoltalk-llama-cpp
```

Then launch the agent with `--local`, or switch mid-session with `/local`:

```bash
agency agent --local                 # guided setup: pick from a catalog
agency agent --local qwen3.5-2b      # a curated short name
agency agent --local ./model.gguf    # a local .gguf file
```

You can also just start to agency agent with `agency agent --local`, and it will guide you through the entire process. If you pick a model that you haven't downloaded, Agency will download it for you from hugging face.

`--local` pins every slot to the local model and downloads it on first use. It is mutually exclusive with `--model`, `--fastmodel`, and `--slowmodel`. Local models have no embedding endpoint, so memory falls back to its default behavior.

The ability to use local models is an important feature of Agency, and it's only possible because of important contributions by a few people:

- [Georgi Gerganov](https://github.com/ggerganov) (llama.cpp)
- [HuggingFace](https://huggingface.co) (hosts models for download)
- [Catai](https://github.com/withcatai) (node-llama-cpp)