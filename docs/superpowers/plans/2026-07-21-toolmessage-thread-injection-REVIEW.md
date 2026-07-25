# Review: `toolMessage` thread-injection implementation plan

Reviewing `2026-07-21-toolmessage-thread-injection.md`. I verified every API the
plan names against the current tree. The plan is at the right altitude, reuses
the existing message-seeding machinery cleanly, and folds in all four points from
the spec review (string-only v1, the nanoid clarification, label-on-both-messages,
and args handling). One substantive finding on Task 3, plus a few minors.

## What checks out (verified, not assumed)

- **Altitude is right.** `_toolMessage` sits beside `_userMessage` /
  `_systemMessage` / `_assistantMessage` in `lib/stdlib/thread.ts` and reuses
  every existing mechanism: `getRuntimeContext()`, `getOrCreateActive()`, and
  `thread.push(msg, label || null)` (all present at `lib/stdlib/thread.ts:66-72`).
  No new registry, no new buffer, no duplicated semantics. This is exactly the
  sibling-of-userMessage shape the spec asked for.
- **The plan improves on the spec, correctly.** The spec said `args` is
  "serialized with `JSON.stringify` and stored as the tool call's `arguments`."
  That's wrong: `ToolCallJSON.arguments` is a **record**, not a string
  (`smoltalk .../classes/ToolCall.d.ts`: `arguments: z.ZodDefault<z.ZodRecord<...>>`;
  the `ToolCall` constructor takes `Record<string, any> | string`). The plan's
  Global Constraint (line 17) storing `arguments: argsRecord` as an object, while
  still round-tripping through JSON to validate serializability, is the correct
  reading. Good catch.
- **The message builders accept the exact shapes passed.**
  `smoltalk.assistantMessage(content: string | Array<TextPart> | null, { toolCalls?: Array<any> })`
  accepts `""` and a plain `{id,name,arguments}` object;
  `smoltalk.toolMessage(content, { tool_call_id, name })` matches step 4
  (verified in `smoltalk/dist/classes/message/index.d.ts`).
- **Every test-harness API exists as written.** `agency.withTestContext({ctx,stack,threads}, fn)`
  (`lib/runtime/agency.ts:427`), `ThreadStore.withDefaultActive(client)`
  (`threadStore.ts:176`), `MessageThread.getMessages()` / `labelAt()`
  (`messageThread.ts:83,132`), the `RuntimeContext` ctor shape
  (`context.ts:229-234`), `ctx.setLLMClient` (`context.ts:160`).
- **The roundtrip assertion holds.** `_getThread` coerces a tool-result message
  to `{ role: "tool", content: "Draft saved." }` (`lib/stdlib/threads.ts:93-103`,
  `_contentToString` returns a string through unchanged). Since `toolMessage`
  pushes assistant-then-tool, the tool message is last, so `"${last.role}:${last.content}"`
  is `"tool:Draft saved."`. `listThreads(false)` and `getThread(id, 0, 50)` both
  exist with those signatures (`stdlib/thread.agency:292,355`).

## Substantive: Task 3 does not prove what it claims

Task 3's header says it "proves the whole point: a real `runPrompt` sends a
thread carrying the synthetic exchange to the provider, and the provider config
carries it intact... that a provider accepts an injected, un-redeclared tool
call." It does not, because there is no provider. `RecordingClient` records the
outgoing `PromptConfig` and returns a canned success; it validates nothing. A
recording mock will happily "accept" a malformed or unmatched pair.

What the test actually proves is narrower but still worth having:

1. the seeded messages are **forwarded** into the outgoing request
   (`PromptConfig.messages`, which I confirmed is real — `llmClient.ts:25`,
   populated at `prompt.ts:642` via `messages.getMessages()`), and
2. the pair is **internally consistent** — `tool.tool_call_id === asst.toolCalls[0].id`.

That is a good wire-shape test. But "a real provider accepts an un-redeclared
historical tool call" is precisely the one claim a mock cannot substantiate, and
it's the claim the spec leaned on in its "does not require the tool to be
declared" section. Two honest options:

- **Soften the framing** to "the seeded exchange is forwarded well-formed and
  id-matched," and state plainly that real-provider acceptance is assumed per the
  general provider contract (which the spec already documents). Cheapest, and
  probably fine.
- **Add one real, cheap provider call** proving acceptance end-to-end. CLAUDE.md's
  testing guide explicitly permits a real LLM call when the test genuinely needs
  one, and this is the rare case that does — it's the only way to actually verify
  the contract. Keep it to a single tiny call.

Either is acceptable; what isn't is leaving the overclaiming header on a
mock-only test. I'd lean to option 1 plus a one-line note, and treat a live check
as a manual/CI-gated follow-up.

## Minors

- **Dead scaffolding in Task 3, Steps 2–3.** The plan hedges: "If
  `client.configs[0].messages` is not the field name... log `Object.keys` to find
  it." It is the field name — `PromptConfig.messages` is defined at
  `llmClient.ts:25` and filled at `prompt.ts:642`. The fallback is harmless but
  unnecessary; you can assert `.messages` directly. (Note the messages arrive as
  smoltalk `Message` **instances**, so the plan's `m.toJSON?.() ?? m` map is the
  right call.)
- **Circular-args test passes, but not via the friendly message.** In Task 1,
  `JSON.stringify(circular)` **throws** a `TypeError` — it does not return
  `undefined` — so the throw happens at the `stringify` line, not at the
  `json === undefined` guard. The custom "could not be serialized" message only
  fires for values that stringify to `undefined` (a bare function, `undefined`).
  The "throws immediately / pushes nothing" test still passes either way. If you
  want the friendly message for the circular case too, wrap `stringify` in a
  try/catch. Purely cosmetic — both paths "fail loudly."
- **Task 3 is not red-green TDD.** It passes as soon as Task 1 lands (Step 2 says
  as much). That's fine for a characterization/integration test; just don't let a
  reviewer expect it to fail first.

## Anti-pattern audit (`docs/dev/anti-patterns.md`)

Checked the plan's production code against every entry. It is clean, and it
lands the one the catalog cares about most — the "what vs how" split — on the
right side.

- **Imperative code everywhere / declarative encapsulation (the key one): PASS.**
  The plan exposes a declarative interface, `toolMessage(name, args, result, label)`,
  behind which the imperative "how" lives in one place (`_toolMessage`): minting
  the id, pairing the assistant tool-call with its matching tool-result, and
  finding the active thread. A caller writes pure "what" —
  `toolMessage("saveDraft", { value }, "Draft saved.")` — and never touches id
  generation or message pairing. That is exactly the encapsulation the doc asks
  for, not the anti-pattern. If message pairing ever changes (say a provider
  needs a different id scheme), only `_toolMessage` changes; every call site is
  untouched.
- **Duplicating existing code: PASS**, and notably so. `_toolMessage` reuses
  `getRuntimeContext()`, `getOrCreateActive()`, `thread.push(msg, label)`, the
  `smoltalk` builders, and `nanoid` — it invents nothing. It also correctly does
  **not** add an `__internal_toolMessage` twin. The other three message
  functions each carry an `__internal_*` twin, but those twins are dead — zero
  references anywhere outside their own definitions in `lib/stdlib/thread.ts`.
  The live path is the ALS `_*` variant imported by `stdlib/thread.agency`.
  Adding the twin would have duplicated an unused pattern; skipping it is right.
- **Order-dependent mutable state: PASS.** `_toolMessage` is all `const`, each
  value derived from its inputs (`json` → `argsRecord`, `id` from `nanoid()`,
  `thread` from the context). No `let`, no reorder hazard.
- **Leaky abstractions: PASS.** The caller needs to know nothing about tool-call
  ids, the assistant/tool message split, or thread lookup.
- **Everything else: PASS.** No nested ternaries; the one `if` (the serializability
  guard) uses a block; no one-line `if`; static `import { nanoid }` (no dynamic
  require); no `...(x ? {x} : {})`; no file deletion; the tests are non-destructive
  (the circular-args value is in-memory only). Consistency with `_userMessage`
  holds — the only shape difference is binding `const thread` and pushing twice,
  which is forced by there being two messages, not a stylistic divergence.

Two things that are *not* anti-pattern violations but worth a glance (already
noted elsewhere in this review): single-char `m` / `n` in the tests match the
existing test convention in `threads.test.ts` and `promptLabels.test.ts`, so
they read consistently; and the `if (json === undefined)` guard is a real
validation, not a useless special case, though it only catches the
stringify-returns-`undefined` case (circular args throw earlier).

## Test-plan review: do the tests actually test the behavior?

For the **core risks** — pair pushed, ids matched, `arguments` stored as an
object, `label` on both messages, fail-loud atomicity — yes. Each of those has an
assertion that would fail if the corresponding code broke:

- Drop the tool-result push, or mint two different ids → Task 1 test 1's
  `tool.tool_call_id === asst.toolCalls[0].id` fails (and destructuring `[asst,
  tool]` throws if only one message lands).
- Stringify `arguments` instead of storing the record → `toEqual({ value: "hi" })`
  fails.
- Label only one message → Task 1 test 2 fails on `labelAt(n-1)`.
- Push before validating → Task 1 test 3's `toHaveLength(0)` fails.

So the happy path and the main failure modes are genuinely covered. The gaps are
in branches the tests *claim* to cover but don't, and a few uncovered behaviors:

**1. The "no active thread → create one" branch is NOT exercised — and the
self-review says it is.** Line 447 claims this path is "exercised by every test
(they start from a fresh `ThreadStore`)." They don't: `ThreadStore.withDefaultActive`
calls `getOrCreateActive()` in its own body (`threadStore.ts:176-181`), so every
test starts with an active thread already present. `_toolMessage`'s
`getOrCreateActive()` therefore always takes the *get-existing* path; the *create*
path is never hit. Low real risk (the code is shared and tested elsewhere), but
the claim is false. Either correct it, or add one test that builds a bare
`new ThreadStore()` (no default active) and asserts `_toolMessage` still lands a
two-message thread.

**2. Omitted `label` → `null` is untested.** Every test passes `label: "budget"`
or asserts the labeled case. Nothing checks that *omitting* `label` yields
`labelAt() === null` — i.e. the `label || null` branch. If someone drops the
`|| null` and stores `""`, no test fails. This is a real behavior with a real
breakage mode; `_userMessage`'s sibling suite has exactly this test
(`promptLabels.test.ts`: "leaves messages unlabeled when no label is given").
Add the parallel case.

**3. Task 1 test 1 asserts on `slice(-2)`, not on the message count.** A bug that
pushes a *third* stray message (or duplicates one) leaves the last two correct,
so the test still passes. Add `expect(msgs).toHaveLength(2)` so "exactly the pair,
nothing else" is actually pinned.

**4. The Agency roundtrip (Task 2) is a smoke test, not a pairing test — and it
can silently pass on a broken pair.** It asserts only that the *last* message
reads back as `"tool:Draft saved."`. A bug where `_toolMessage` pushes only the
tool-result message (no assistant tool-call) produces an *unmatched, invalid*
pair, yet `getThread` still returns `[tool]`, the last message is still
`"tool:Draft saved."`, and the test passes. The read API (`getThread` → role +
stringified content only, `threads.ts:93-103`) genuinely can't see
`tool_call_id`, so pairing can't be asserted here — that's fine, but then the
Agency test shouldn't be leaned on for it. Strengthen it cheaply: have `main`
also encode the second-to-last message, e.g. return
`"${msgs[msgs.length-2].role}|${last.role}:${last.content}"` and expect
`"assistant|tool:Draft saved."`, so a dropped assistant message is caught. Leave
true pairing to the unit + provider tests.

**5. Smaller uncovered behaviors (each a cheap assertion):**
- **`args ?? {}` default** — no test passes `null`/`undefined` args to confirm it
  becomes `{}`.
- **Tool-result `name` field** — step 4 passes `{ tool_call_id, name }`, but no
  test asserts `tool.name === "saveDraft"`. Anthropic uses this field; a
  regression that dropped it would pass every current test.
- **Empty assistant content** — nothing asserts the assistant message text is
  `""`; not load-bearing, but trivial to pin.
- **Circular-args error is the raw `TypeError`**, not the friendly
  "could not be serialized" message (which only fires for the stringify-returns-
  `undefined` case). Test 3's bare `.rejects.toThrow()` passes either way, so it
  never notices. If the friendly message matters, assert on it and wrap
  `JSON.stringify` in a try/catch; otherwise drop the unreachable custom-message
  branch to avoid implying a guarantee the code doesn't give.

**Priority:** fix 1 (false self-review claim) and 2 (real untested branch) before
implementing; 3 and the `name`-field assertion in 5 are one-liners well worth
adding; 4 is a worthwhile strengthening given the roundtrip test is currently the
only end-to-end coverage.

## Bottom line

Ship it after fixing the Task 3 framing (option 1 or 2 above) and adding the
missing label/`name`/count assertions and the no-active-thread case (or
correcting the self-review claim about it). The core two tasks are correct,
well-grounded, and reuse the right seams; nothing in Tasks 1–2's *implementation*
needs to change. No anti-patterns present — the declarative/imperative split is
done correctly.
