### Limitation: structured output inside block bodies

Any `return llm(...)` inside a block body — anywhere in the block,
not just at the end — falls back to a `string` structured-output
schema. This applies to `fork(...) as item { ... }` branches,
`guard(cost: $X) as { ... }` bodies, and any user-defined function
that takes a block parameter. Agency currently has no way to know
the block's declared return type at codegen time, so the LLM is
asked for a plain string. The block still runs and returns the
LLM's text reply, but you cannot get a typed object out of it.

```ts
type Response = { capital: string }

// ❌ The annotation on `result` is NOT propagated into the block.
// Each branch returns a plain string from the LLM.
const result: Response[] = fork(["France", "Spain"]) as country {
  return llm(`What is the capital of ${country}?`)
}
```

The workaround is to assign the LLM call to a typed local first, then
return it:

```ts
// ✅ The annotation on `reply` controls the LLM's structured output.
const result: Response[] = fork(["France", "Spain"]) as country {
  const reply: Response = llm(`What is the capital of ${country}?`)
  return reply
}
```

Any function defined in Agency can automatically be used as a tool for the LLM. Pass the function in the `tools` option:

```ts
def add(a: number, b: number): number {
  return a + b
}

const result = llm("What is 4 + 5?", { tools: [add] })
print(result)
```



---

how to write a custom llm client


---

## Writing TS helpers that participate in the run

TypeScript helpers called from Agency code can do more than return plain values: they can read the active runtime context, push thread messages, install interrupt handlers, take checkpoints, issue LLM calls, and wrap their bodies in resumable scopes. The full surface is exposed through one namespace:

```ts
import { agency } from "agency-lang/runtime";

export function summarize(text: string): Promise<string> {
  return agency.llm("Summarize in one sentence: " + text);
}
```

Every method on `agency.*` reads its dependencies from an AsyncLocalStorage frame the runtime installs around each step. When you call a TS helper from Agency code, the frame is already in place — your helper sees the same context the surrounding Agency function saw. (Most methods throw with a clear error if called outside an Agency frame; the `*Maybe` variants return `undefined` instead.)

Common patterns:

```ts
// Read context
const cost = agency.ctx().stateStack.localCost;
const apiKey = agency.global<string>("API_KEY", "config");

// Push thread messages
agency.thread.system("You are a careful editor.");
agency.thread.user("Please proofread the following.");

// Install a scoped handler
await agency.withHandler(
  (intr) => intr.effect === "std::read" ? approve("auto-y") : undefined,
  () => doWork(),
);

// Take a checkpoint
const cpId = await agency.checkpoint();

// Issue an LLM call with structured output
const { name, age } = await agency.llm("Extract", { schema: PersonSchema });
```

### Resumability boundary

```diagram
╭──────────────╮   call    ╭───────────────────╮   call   ╭──────────────╮
│  Agent run   │──────────▶│  Agency function  │─────────▶│  TS helper   │
│   (Node)     │           │     body          │          │              │
╰──────────────╯           ╰───────────────────╯          ╰──────────────╯
                            resumable                      NOT automatically
                            automatically                  resumable

                                                          ╭──────────────────────╮
                            wrap with                     │ withResumableScope   │
                            ─────────────────────────────▶│ inside the helper to │
                                                          │  get resumability    │
                                                          ╰──────────────────────╯
```

Agency function bodies are resumable automatically: an interrupt in the middle of one re-enters at the same statement on resume. A plain TS helper called from Agency code is **not** resumable — on resume after an interrupt, the entire helper re-runs from the top. To get per-step resumability inside a TS helper, wrap the body in `agency.withResumableScope`:

```ts
return agency.withResumableScope({ name: "processOrder" }, async (s) => {
  const order     = await s.step(() => loadOrder(orderId));
  const validated = await s.step(() => validate(order));
  const stored    = await s.step(() => persist(validated));
  return stored;
});
```

Each `s.step(...)` is journaled against a serialized frame; on resume completed steps are skipped, the in-flight step re-runs from scratch. **Read the [determinism contract](/guide/ts-helpers#determinism-contract) before using this** — step bodies must be pure, and step ordering must be stable across resumes.

For the full reference of every `agency.*` method, the `LlmOpts` shape, the `ResumableScope` API, testing patterns, and anti-patterns, see [TypeScript helpers — the `agency.*` namespace](/guide/ts-helpers).

## Cancelling an in-progress agent

When you run an Agency agent from TypeScript, you can cancel it mid-execution. This tears down any in-flight LLM requests and throws an `AgencyCancelledError`. Here's how to abort an agent run.

The `onAgentStart` callback receives a `cancel` function you can call at any time:

```ts
import { main } from "./main.js";

let cancelAgent: (reason?: string) => void;

const result = await main({
  callbacks: {
    onAgentStart: ({ cancel }) => {
      cancelAgent = cancel;
    },
  },
});

// later, from a button handler, timeout, etc:
cancelAgent("user clicked stop");
```


### What happens when you cancel

When `cancel()` is called

1. Any in-flight LLM request is aborted immediately.
2. Any remaining tool calls in the current round are skipped.
3. Any remaining interrupt handlers are skipped.
4. An `AgencyCancelledError` is thrown, which propagates up to the caller.

Cancellation is permanent for that execution. Once cancelled, no further LLM calls can be made on that particular agent run. However, you can start a new agent run. You can read more about Agency's [execution model](/guide/execution-model).

To catch the abort in TypeScript, you can catch `AgencyCancelledError` (exported from `agency-lang/runtime`) or use the `isAbortError` helper:

```ts
import { AgencyCancelledError, isAbortError } from "agency-lang/runtime";

try {
  await main();
} catch (error) {
  if (isAbortError(error)) {
    // handle cancellation
  }
}
```

Now let's talk about Agency's execution model.

---

## Files
guide/agency-packages.md

