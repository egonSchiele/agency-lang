---
name: agency-llm-docs
description: Developer docs for Agency's LLM plumbing: the smoltalk library every model call goes through, the LLMClient interface for swapping it out, local model support and its integration tests, and speech-to-text and text-to-speech. Use when changing how Agency talks to a model provider.
---

# Llm developer docs

Paths are relative to `packages/agency-lang/`. Read the one that matches the task; each doc records the key decisions, the architecture, the relevant files, and the subtleties that are easy to miss.

- `docs/dev/llm/smoltalk.md` — The external library Agency routes every LLM call through.
- `docs/dev/llm/llm-clients.md` — The `LLMClient` interface, for swapping smoltalk out for something else.
- `docs/dev/llm/local-models.md` — How local-model support is wired, from the provider to model download and verification.
- `docs/dev/llm/local-model-integration.md` — The integration suite that downloads and runs a real local model.
- `docs/dev/llm/speech-via-smoltalk.md` — Speech-to-text and text-to-speech, routed through the LLM client so they inherit cost accounting and tracing.
