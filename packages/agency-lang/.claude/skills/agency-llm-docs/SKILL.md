---
name: agency-llm-docs
description: Developer docs for Agency's LLM plumbing: the smoltalk library every model call goes through, the LLMClient interface for swapping it out, local model support and its integration tests, and speech-to-text and text-to-speech. Use when changing how Agency talks to a model provider.
---

# Llm developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/llm/smoltalk.md` — The external library Agency routes every LLM call through.
- `docs/dev/llm/llm-clients.md` — The `LLMClient` interface, for swapping smoltalk out for something else.
- `docs/dev/llm/local-models.md` — How local-model support is wired, from the provider to model download and verification, and embeddings through the plugin.
- `docs/dev/llm/mlx-local-models.md` — The `mlx` backend: the `backend` field and `mlx:` prefix, how a run finds the served model name, the per-model record file, `remove -f`, why a snapshot directory of symlinks is accepted, `agency local serve` with its one-process-per-model front door, the embedding server behind `serve --embedding`, and the Hub downloader: chunks, resume, verification, and the fake hub.
- `docs/dev/llm/local-speech.md` — `agency local serve --speech`: the speech server script and why Agency ships its own, the rules module CI can test, the model families and what each takes, sentence splitting, the mlx-audio version pin, how an audio reply is logged, Orpheus with its companion decoder and the three mlx-audio patches it needs, the `speakLocal` function and its effect with how long text is sent in pieces, its formats, and how ffmpeg changes the speed after generation, and why Agency never runs `mlx_audio.server` — read that section before adding any endpoint here.
- `docs/dev/llm/local-model-integration.md` — The integration suite that downloads and runs a real local model.
- `docs/dev/llm/speech-via-smoltalk.md` — Speech-to-text and text-to-speech, routed through the LLM client so they inherit cost accounting and tracing.
- `docs/dev/llm/decision-models.md` — Decision models (Jev, Laya): the provider is the switch, how a typed `llm()` call becomes questions and the answers become the value, which calls are decision calls and why the registry outranks the provider on the call, what the state is, the `noul >= 0.5` loss, the `decision` usage kind, and how to run against OpenRouter, a local Laya server, and the default model; how the calls of a parallel block batch into one request through the collector on the async frame, when a round fires, and how tokens and cost are split.
- `docs/dev/llm/decision-models-design-options.md` — The options set aside for decision models and for returning a value plus metadata (probabilities, logprobs, thinking): wrapper types, a second return value, a side channel, fill-in-the-blanks, a `decision` block, batching in `parallel`, with what each costs. Read before reopening any of them.
