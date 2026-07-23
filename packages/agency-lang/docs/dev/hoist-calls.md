# hoistCalls: resume-safe helper calls

## The invariant

After preprocessing, no statement re-executes a completed frame-pushing call on resume. Every helper call in an unconditionally-evaluated position becomes its own statement:

```agency
const answer = llm(msg, llmOptions(model: model, tools: tools))
```

compiles as if the user had written:

```agency
const __hoist_0 = llmOptions(model: model, tools: tools)
const answer = llm(msg, __hoist_0)
```

Each statement is a runner step, and step results live on `__stack.locals`, which serializes into checkpoints. On resume, the temp's step is skipped and its value is read back. The helper never re-runs.

## Why this exists

Resume replay hands saved frames to functions positionally: `StateStack.getNewState()` in deserialize mode shifts the next saved frame to whoever asks. The statement in progress at a pause re-runs its whole body, including helpers that already completed and were not checkpointed. Those helpers consumed frames belonging to still-live functions. The still-live function then got a blank frame, believed it never ran, and re-issued work. The visible symptom was OpenAI rejecting a request whose thread ended with an unanswered tool call: `400 No tool output found for function call`.

Design history and the full position analysis: `docs/superpowers/specs/2026-07-22-hoist-calls-resume-safety-design.md`.

## Where it runs

`TypescriptPreprocessor.preprocess()`, between `collectSkills()` and `addAwaitPendingCalls()`. Guards and parallel blocks are already desugared by then; the await pass and scope resolution see the temps like hand-written statements. The pass lives in `lib/preprocessors/hoistCalls.ts`; the rulings table at the top of that file is the source of truth for what hoists where. Summary:

| Position | Ruling | Why |
|---|---|---|
| arguments, literals, interpolations, binary operands | hoist | unconditionally evaluated |
| statement tail call | stays | it is the pending call itself; also node calls are control flow and throw in value position |
| `if` conditions, `for` iterables, `match` scrutinees | hoist before the statement | single evaluation either way |
| `while` conditions with calls | loop rewritten: `while (true) { temps; if (cond) { body } else { break } }` | conditions re-evaluate per iteration; pre-pass they re-ran once per completed iteration on resume |
| `try` operands, `catch` expressions | opaque | the whole expression compiles into a runtime thunk; moving code out moves the error boundary |
| short-circuit right sides, if-expression branches | opaque | may never execute |
| pipe stages | opaque | already memoized per step and failure-gated |
| pipe input | hoist | evaluated inline at statement level, outside the memoization |
| `with`/`static` wrapped statements | opaque | hoisting out would cross the approval region; the slot holds exactly one statement |
| handler (`with (data)`) bodies | never touched | compile to plain JS, cannot pause, safety infrastructure |
| lifted block bodies (comprehensions, fork branches, `as x { }` blocks) | hoisted within, never across | they own their frame; a temp crossing out would change per-item evaluation to once |
| module-level initializers | never touched | init-topsort owns them; they cannot pause |

Accepted behavior change: `for (x in async getItems())` used to be rejected by `validateNoAsyncInLoops`; hoisting moves the call above the loop, so it now compiles. A relaxation, not a breakage.

## Temp naming

`__hoist_N`, one counter per frame-owning scope (function, node, lifted block, fork branch), shared across every nested statement list inside it. Frame locals are flat, so per-list numbering would let a loop-body temp overwrite the temp a loop iterable re-reads on resume. Finalize bodies share their container's counter because they run on the container's frame. Seeding scans the scope for existing `__hoist_N` names and numbers above them — that seeding is the collision protection. There is deliberately no lint rule reserving the prefix: no other compiler-reserved prefix (`__block_N`, `__comprehensionItem`, `__substep_`) has one, and the seeding makes collision impossible regardless.

## The tripwire

Residual shapes the pass does not cover can still desync: calls nested inside opaque positions (short-circuit right sides, catch expressions, try operands, with-modified statements), block bodies nested inside opaque expressions, and mid-chain method calls inside a hoisted access chain (the chain BASE and every argument hoist; a later chain segment re-running an earlier method call is what remains). Those now fail loudly instead of corrupting silently: every frame is stamped with its owner's scope name at CLAIM time, and a mismatched claim throws

```
Resume desync: function "X" tried to claim the saved state of "Y".
```

plus a statelog `runtimeError` event. Seeing this error always means a toolchain bug, never a bug in the user's program — report it with the program that produced it. The statelog emit is not redundant with the throw: throws convert to Failures at def boundaries and can be laundered by fail-open code; the event survives.

**Which code claims frames, and which merely runs on one.** Claiming (pulling a frame from the stack) and running on a frame are different events, and only claims stamp:

- Claim sites: generated function and node preambles, `blockSetup.mustache`, `forkBlockSetup.mustache` (all emitted by codegen), plus two hand-written TypeScript sites — `runPrompt` and `withResumableScope`.
- Runs-but-never-claims: the `finalize` closure builds a second Runner named `foo#finalize` on its container's own frame. It must not stamp; a constructor-side check would false-positive on every aborting finalize, which is the salvage path. This is why the Runner constructor knows nothing about stamping.

Empty scope names never stamp (the Runner defaults `scopeName` to `""`; an empty stamp would collide with the real owner later).
