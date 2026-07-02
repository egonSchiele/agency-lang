# Definite-return checking — remaining work

Status of the feature shipped in **PR #386** (safe subset) and extended by the
match-aware follow-up branch (`match-aware-definite-returns`). Read alongside
the type-checker dev docs:

- [`docs/dev/typechecker/README.md`](./README.md) — bidirectional checking, the pass pipeline, `synthType`.
- [`docs/dev/typechecker/narrowing/README.md`](./narrowing/README.md) — flow-sensitive narrowing, the flow graph, `exit` nodes, `match` exhaustiveness.
- Config knobs: [`docs/misc/config.md`](../../misc/config.md) (`typechecker.definiteReturns`).

---

## 1. What shipped

**Rule:** a function that declares a non-void return type must `return` a value on every control-flow path (Agency has no implicit returns), else `Not all code paths return a value in 'f'.`

**How it works — the flow graph already computes this.** `buildFlowGraph(body, start, env)` returns the flow node *at the end of a body*; that node is `{ kind: "exit" }` iff every path diverges (a `return` produces `exit`; `if`/`else` collapses to `exit` when both branches return, via `mergeFlows`). See:

- `lib/typeChecker/flow.ts` — the `{ kind: "exit" }` flow-node variant.
- `lib/typeChecker/flow.ts` — `mergeFlows(flows)`: drops `exit` inputs; returns `exit` iff **all** inputs are `exit`.
- `lib/typeChecker/flowBuilder.ts` — `returnStatement` rule returns `{ kind: "exit" }`; `ifElse` merges then/else via `mergeFlows`; `buildFlowGraphs` records each scope's terminal into `FlowEnvironment.scopeTerminals` (null-prototype dict).
- `lib/typeChecker/definiteReturns.ts` — `checkDefiniteReturns(scopes, ctx)`: `requiresReturn(rt)` exempts absent/`null`, `void`, `never` return types; the loop skips `top-level` and nodes (`ctx.nodeDefs[info.name]`, bare-keyed); flags when `scopeTerminals[scopeKey].kind !== "exit"`.
- `lib/config.ts` — `typechecker.definiteReturns: "silent" | "warn" | "error"`. **Ships at `"warn"`** (default read-site is `?? "warn"` in `definiteReturns.ts`).
- Registered in the pipeline immediately after `checkMatchExhaustiveness` (`index.ts`).
- Tests: `lib/typeChecker/definiteReturns.test.ts`.

**Match-aware (this branch):** match-containing functions are fully checked — the #386 `containsMatch` safe-subset skip is gone (§2 below). **`while (true)` divergence (was §5b):** the flow builder's `whileLoop` rule yields `{ kind: "exit" }` for a literal-`true` loop with no reachable `break` (`hasReachableBreak` — break binds to the nearest loop; nested loops/definitions are excluded, everything else conservatively counts). Post-infinite-loop statements are dead code to all flow consumers.

**Measured clean:** #386 scanned 841 execution-test `.agency` programs at `error` level — 0 hits. The match-aware branch re-scanned **855** programs (the base plus the match-expression suite added by `7eefd7c1`) at `error` — **0 hits, 0 crashes**, and the full unit suite is at parity with base `main`.

---

## 2. HISTORY: the match problem, and how it dissolved

**The original problem (#386).** Whether a `match`-ending function returned on every path depended on match **exhaustiveness** (`match (r) { success(v) => return v  failure(e) => return 0 }` over a Result: total; `match (x) { 1 => return 1  2 => return 2 }` over a number: not), which lives in `checkMatchExhaustiveness`, not the flow graph — and a `_`-less match lowered to an if-chain whose tail had no `else`, so even an exhaustive match looked like a fall-through. #386 therefore **skipped** any match-containing function (`containsMatch`), and this doc's earlier revision designed a follow-up around a reachability walk + a tri-state exhaustiveness oracle + per-arm `bodyReturns` metadata.

**The redesign that made all of that unnecessary.** Match expressions (`7eefd7c1`, design spec `docs/superpowers/specs/2026-07-01-match-expressions-design.md`) changed `return` semantics: **`return` inside a match arm yields to the match, never returns from the enclosing function.** Concretely:

- A `return` in a **statement-position** arm is a **compile error** (fixit: hoist to `return match(...)`). Statement matches are effect-only, so they can never make the function return — the flow graph threading through them without `exit` is now *exact*, not conservative.
- An **expression-position** arm's `return` lowers to a `matchYield` node (`lib/lowering/patternLowering.ts`) — passThrough to the flow builder, so it can never fake a function `exit`. All-paths-yield and expression-position exhaustiveness are enforced by the lowering and exhaustiveness passes themselves.
- `return match(...)` lowers to the match region **plus a real trailing `returnStatement`** — a genuine `exit`.
- `const x = match(...)` lowers to the region plus a plain (tagged) assignment — a genuine non-exit.

So the flow terminal is exact for every match shape, and the entire follow-up collapsed to *deleting `containsMatch`*. No exhaustiveness oracle, no walk, no lowering metadata. The old false-positive driver (the idiomatic Result match with arm returns as a function tail) is now a compile error whose fix is precisely the form the checker handles correctly.

**Known degenerate limitation (recorded, not worth engineering around):** a statement match whose every arm ends in `while (true)` is still flagged — the `matchBlock` flow rule discards arm end-flows, so arm-internal divergence never reaches the terminal.

---

## 3. Flip the default `warn` → `error`

Same trajectory as `matchExhaustiveness` (flipped in PR #383) and now the main remaining item. The match-aware branch's sweep is the fresh measurement: **855 execution-test programs at `error` = 0 hits**, so the blast radius is currently zero.

- Change the default read-site in `definiteReturns.ts` from `?? "warn"` to `?? "error"`, and update the docstring + `docs/misc/config.md`.
- Re-measure first anyway (the discipline used for #383/#366): full typeChecker suite, fixture integration test, and the `discoverAgencyFiles` sweep over `tests/agency`, `tests/agency-js`, `tests/integration` at `error`.
- Fix any genuine offenders (missing returns) rather than weakening the check.
- Let match-aware checking bake at `warn` for a while first — it newly covers every match-containing function.

---

## 4. Edge-case refinement: trailing `raise` (documented limitation)

`def f(): number { raise e::x("m", {}) }` is flagged, because `raise`/`interrupt` are `passThrough` (non-diverging) in the flow builder, matching the `alwaysExits` convention ("a raise may resume"). Sound but noisy. To refine: treat a `raise` as diverging when it can be *proven* not to resume (no handler up the static chain resumes it). The interrupt-effects analysis already computes per-function effect sets and the handler call-graph — see `lib/typeChecker/interruptAnalysis.ts` (`analyzeInterruptsFromScopes`, `buildInterruptCallGraph`) and `docs/dev/interrupts.md`. This is a bigger analysis; only worth it if the trailing-raise false positive proves common. It matters more once the default flips to `error` (§3).

(The other refinement listed here previously — infinite loops — shipped with the match-aware branch; see §1.)

---

## 5. Adjacent: dead-code / unreachable-statement detection

The flow builder already knows a statement is unreachable — `buildFlowGraph` short-circuits when the running flow is `exit`, which now also covers code after a provably-infinite loop. Surfacing that as a warning (`code after return/infinite-loop is unreachable`) is a cheap, high-signal addition reusing the exact `exit`-node reasoning. It is a *separate* diagnostic, not part of definite-return, but it lives in the same conceptual space.

---

## 6. Test + gotcha reference

- Tests: `lib/typeChecker/definiteReturns.test.ts`. Harness note: `typecheckSource` (in `testUtils.ts`) hardcodes empty config, so the config-knob tests use a local `check(src, config)` helper that forwards `config` to `typeCheck`. Anchor assertions to the exact message with `^Not all code paths return a value in '`.
- **Gotchas:**
  - `return` in a statement-position match arm is a compile error; expression matches are legal only as an assignment RHS or a return operand (v1 grammar restriction).
  - Type-mismatch and many diagnostics carry **no explicit `severity`** (they render as errors). Assert with `(e.severity ?? "error") === "error"`, never `=== "error"`.
  - `ctx.nodeDefs` is **bare-name-keyed**, so `ctx.nodeDefs[info.name]` is the correct node-vs-function test. `ScopeInfo` carries `returnType` directly (but `functionDefs[name].loc` IS used for the diagnostic location — the signature, not the first body statement).
  - Object-literal call args widen (`{ tag: 1 }` → `{ tag: number }`), so they won't match a `tag: 1` discriminated union at a call site. Test function-body behavior via **def-only** programs (bodies are type-checked without a call), not `node main() { f({...}) }`.
  - Scope keys derive from user-controlled names → `scopeTerminals` is a **null-prototype** dict (`Object.create(null)`), mirroring the flow memo dicts in `flow.ts`.

---

## 7. Suggested order

1. **§3 flip warn → error** — after match-aware checking bakes at `warn`; re-measure first (last sweep: 855 programs, 0 hits).
2. **§5 dead-code detection** — cheap adjacent win, any time.
3. **§4 trailing-raise refinement** — only if it proves to be a common false positive.
