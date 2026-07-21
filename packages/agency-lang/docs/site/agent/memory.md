# Memory

*This feature is still a work in progress. It may not work or this documentation may be out of date.*

The agent can remember facts across runs. Tell it your name, a project
convention, or a decision you made, and it can recall that later, even in a new
session days from now. Memory means you do not have to re-explain the same
context every time.

This page covers memory in the agent. For the underlying language feature, see
the [Memory guide](/guide/memory).

## What it does

When memory is on, the code and research agents can save a fact with a `remember`
tool and look one up with a `recall` tool. Recall also happens automatically: the
agent pulls in relevant remembered facts as it works, without keeping them all in
the conversation history.

Saving a fact is itself an action that goes through your approval policy, so the agent cannot quietly record something you did not want written down.

## Per-agent scopes

Each specialist keeps its own memory scope. The coordinator and code work write
under one scope; research writes under another. This keeps unrelated facts from
bleeding together, so a note about a web source does not surface in the middle of
a coding task.

## Turning it on and off

Memory is controlled by the current model's capability profile, and whether it
starts on depends on the model. Toggle it with `/settings`, then choose the
**memory** field. The change is saved for the scope you pick (this model, this
provider, or all models). See [Models and settings](/agent/models).

Turning memory **off** takes effect immediately. Turning it **on** takes effect
at the next launch, because enabling it mid-session would raise a burst of
approval prompts for its storage directory.

## Semantic recall and the embedding slot

Memory can find facts by meaning, not just exact words. That richer recall needs
an embedding model, which the agent runs in its **embedding** slot.

By default the embedding slot follows your chat provider. If that provider has no
embedding endpoint, point the slot somewhere that does:

```
/model embedding=openai/text-embedding-3-small
```

That form needs both a provider and a model, because the embedding slot exists to
point away from the chat provider. Set it at launch too, with
`--model embedding=...`. The embedding slot needs its provider's API key in the
environment; without it, memory falls back to simpler recall and tells you so.

Changing your chat provider mid-session shifts the embedding space behind recall,
so the agent pauses memory until the next launch and warns you when that happens.
