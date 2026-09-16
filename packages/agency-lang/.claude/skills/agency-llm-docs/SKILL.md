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
- `docs/dev/llm/local-speech.md` — `agency local serve --speech`: the speech server script and why Agency ships its own, the rules module CI can test, the model families and what each takes, sentence splitting, the mlx-audio version pin, how an audio reply is logged, and Orpheus with its companion decoder and the three mlx-audio patches it needs. Also the `speakLocal` function and its effect, and how long text is sent in pieces.
- `docs/dev/llm/local-model-integration.md` — The integration suite that downloads and runs a real local model.
- `docs/dev/llm/speech-via-smoltalk.md` — Speech-to-text and text-to-speech, routed through the LLM client so they inherit cost accounting and tracing.
