## MUST READ: How interrupts, handlers, policies, and effects work

Interrupts are the most important feature of this language. Every task that touches them — code, review, spec, or plan — starts here. Do not reason about interrupts from grepped code fragments; an earlier review got the whole resume model wrong that way and proposed a security fix for a hole that did not exist. Read this section, then the guide pages (`docs/site/guide/interrupts.md`, `handlers.md`, `effects.md`, `policies.md`), then the dev doc for the mechanism you are changing.

### The four words

- **Effect**: the name of a kind of permission, declared with `effect std::env { name: string }` (`stdlib/system.agency:33`). Effects are what handlers and policies match on.
- **Interrupt**: one raise of an effect, with a message and data: `interrupt std::env("Are you sure…?", { name: name })`. It pauses the program until someone answers approve or reject.
- **Handler**: code that answers a raise. `handle { … } with approve`, `handle { … } with (intr) { … }`, or `someCall() with approve`. Handlers nest; the chain is consulted from the raise outward.
- **Policy**: a JSON rule set (`lib/runtime/policy.ts`) matching interrupts by effect and data globs; a data-driven responder usable inside any handler, or saved to a file and applied with `agency run --policy <file>`.

### The lifecycle of one raise

Follow `env("FOO")` through `stdlib/system.agency:109-113`:

```
def requestEnvRead(name: string): string | null {
  return interrupt std::env("Are you sure…?", { name: name })   // 1. the raise
  return _env(name)                                               // 5. the effect
}
```

1. **Raise.** The generated interrupt site (`lib/runtime/agencyInterrupt.ts`) builds the interrupt with the live value of `name`.
2. **Decide.** `interruptWithHandlers` (`agencyInterrupt.ts:166`) runs every handler in the chain, not just the first. Merge: any reject → rejected; else ≥1 approve → approved; else, or on an explicit propagate, → surface (`mergeChainOutcomes`, `lib/runtime/interrupts.ts:411`). **This is the only place a decision is made.** A root policy `reject` therefore beats an inner `handle { … } with approve`.
3. **Surface.** If nothing answered, the runtime persists the interrupt id in the frame's locals, takes a checkpoint of the whole program state, attaches that checkpoint to the interrupt object (`agencyInterrupt.ts:194`), and hands the batch to whoever is running the program (the CLI via `--interactive` or per-effect `--approve`/`--reject`, a TypeScript caller, or an HTTP/MCP caller of a served agent, which answers on `/resume`).
4. **Resume.** The caller sends back the interrupt objects and one response each. `respondToInterruptsCore` restores the checkpoint (`interrupts.ts:774`), stores the responses in a map keyed by interrupt id, and re-runs the program. The step counters skip everything that already ran. When execution reaches the interrupt site again, it finds its persisted id and returns the stored response (`agencyInterrupt.ts:156-158`). **It does not look at the interrupt's `effect` or `data`, and it does not consult handlers again.** A reject makes the enclosing function return a failure; a rejected tool call tells the LLM it was rejected.
5. **Effect.** The code after the raise runs — `_env(name)` — using `name` from the *restored frame*, not from anything the caller sent.

### Three consequences you must not get wrong

- **Enforcement happens at the raise, never on resume.** Anything a policy or handler would refuse is refused in step 2 and never surfaces. There is no second decision point on `/resume` to guard, and "re-checking the policy against the caller's answers" is checking data the program never reads.
- **The interrupt object the caller echoes back is display data.** Its `effect` and `data` are the raise-time copy, used by prompts and policies at step 2. On resume they are never read: the response is looked up by `interruptId`, and the checkpoint the object carries is what gets restored. Editing `data` changes nothing the program does. Even `let x = raise std::getEnvName("…")`, where the caller supplies a value, uses only that value; the interrupt's own data stays unused after resume.
- **The checkpoint *is* the program.** A served resume is stateless: the caller holds the checkpoint and sends it back (`interrupts.ts:774`). Whoever holds the checkpoint controls every local, including the `name` that step 5 reads. That is a checkpoint-integrity problem, not something a handler or policy can fix.

Where the mechanics live: how a program resumes mid-block is `docs/dev/runtime/interrupts.md`; several interrupts at once is `docs/dev/runtime/concurrent-interrupts.md`; the checkpoint format is `docs/dev/runtime/checkpointing.md`; policies as the agent uses them is `docs/dev/agents/approval-policies.md`; the HTTP round trip is `docs/dev/hosting/how-hosted-serving-works.md`; the `with approve` shorthand is `docs/dev/language/with-approve.md`; how effects propagate through function signatures is `docs/dev/compiler/effect-propagation.md`.
