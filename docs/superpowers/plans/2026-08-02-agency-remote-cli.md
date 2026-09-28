# `agency remote` CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agency remote` command group (link / deploy / ls / call / open) that drives a hosted statelog agent from the CLI, with the same interrupt experience as `agency run`.

**Architecture:** Four ordered PRs. (1) harden the `/resume` serve route against malformed input; (2) extract `run`'s interrupt-resolution loop into a transport-agnostic core (`resolveInterrupts` + `buildDecider`) that both `run` and `remote call` use; (3) consolidate the statelog HTTP wire and canonical serve-URL handling under `lib/cli/statelog/`; (4) build thin `remote` command recipes on top. PR 3 branches from merged PR 2; PR 4 depends on PRs 2 and 3. Everything the CLI calls uses statelog's existing API-key routes — no statelog-repo changes.

**Tech Stack:** TypeScript (ESM, `@/` path alias → `lib/`), Vitest (co-located `*.test.ts`), commander (CLI), typestache (templates), the tarsec-based agency compiler. Run compiled output via `make build` then `node ./dist/scripts/agency.js`.

**Spec:** `docs/superpowers/specs/2026-08-02-agency-remote-cli-design.md` (Revision 2).

**Spec errata:** The verified findings in `docs/superpowers/plans/2026-08-02-agency-remote-cli-review.md` supersede Revision 2 where they differ. In particular, a surfaced one-shot function interrupt currently arrives only as a generic `success:false` tool failure, so this plan does not promise a distinguishable “resuming a served function is unsupported” message. The serve client's exported API is also refined here to hide its wire union; that is an implementation-boundary correction, not a user-visible behavior change.

## Global Constraints

- **Never edit `docs/site/**`** in these PRs (user-facing docs; the deprecated `deploy` shim keeps them accurate). `docs/dev/**` is fine.
- **No dynamic imports; objects not maps; arrays not sets; `type` not `interface`.** (`docs/dev/coding-standards.md`.)
- **Interrupt gates are safety infrastructure** — a handler/interrupt must never be silently skipped. PRs 1 and 2 are the safety-critical ones; land them first, alone.
- **Reuse, don't duplicate** — `deploy()`, `resolveDeployTarget`, `serveBaseUrl`, `resolveRunPolicy`, `terminalPrompt`/`terminalValuePrompt`, `checkPolicyExplicit`, `collectServeMetadata` all exist. Wire them; do not reimplement.
- **Declarative boundaries** — commands state *what* happens. Binding owns config-file I/O; `serveUrl.ts` owns URL resolution/trust/canonicalization; `serveClient.ts` owns fetch/auth/envelope validation and exposes manifest/value/interrupt-result operations rather than wire envelopes; `decision.ts` owns CLI flags → decider; `render.ts` owns successful list/result/link formatting; `commands/util.ts` owns command errors; `confirmation.ts` owns the no-export prompt; `browser.ts` owns platform launch mechanics; command registration owns the deprecation notice. Command recipes must not parse wire unions, policy JSON, URLs, config object shapes, terminal answers, or platform process rules.
- **Anti-pattern guard** — no one-line `if` statements, dense multi-operation lines, single-character variable names, nested ternaries, or inline nested manifest item types in code copied from this plan.
- **`pnpm run agency` runs `dist/`** — after TS edits, `make build` (incremental tsc) before running the CLI.
- **Tests save output to a file** if run broadly; run only tests covering changed files. Every piped test command must start with `set -o pipefail;` so a failing Vitest process cannot be masked by `tee`. Expected-failure and expected-pass runs use different output files. Do NOT run the full agency suite locally.
- **Commit messages / PR bodies in a file** (apostrophes on the CLI break). End commits with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch first; never commit on `main`; the owner squash-merges.

Shared types used across tasks (all from `lib/runtime/interrupts.ts` unless noted):
- `Interrupt` — `{ effect: string; message: string; data: any; origin: string; interruptId: string; expectsValue?: boolean; ... }`
- `InterruptResponse` — `{ type: "approve"; value?: any } | { type: "reject"; value?: any }`; constructed via `approve(value?)` / `reject(value?)`.
- `hasInterrupts(data): data is Interrupt[]`.
- `checkPolicyExplicit(policy: Policy, intr: {effect,message,data,origin}): PolicyResult | null` (`lib/runtime/policy.ts:32`); `PolicyResult.type ∈ {"approve","reject","propagate"}`.

---

# PR 1 — Harden `/resume` against malformed responses (finding 2)

**Branch:** `remote-resume-hardening`. Pure safety, no dependencies, smallest. The defect: an unknown response `type` matches neither the approve nor reject branch of the generated resume path (`lib/templates/backends/typescriptGenerator/interruptReturn.ts:9-20`) and execution continues *past* the interrupt. The adapter validates only that the two fields are arrays (`lib/serve/http/adapter.ts:95-118`); `buildResponseMap` checks only lengths (`lib/runtime/interrupts.ts:615-619`).

## Task 1.1: One declarative resume-batch validator protects the adapter

**Files:**
- Modify: `lib/runtime/interrupts.ts` (add exported `validateResumeBatch`)
- Modify: `lib/serve/http/adapter.ts` (`resumeInterrupts`, ~`:95-118`)
- Test: `lib/serve/http/adapter.test.ts`
- Test: `lib/serve/createServeHandler.test.ts` (update its end-to-end pause/resume fixture)

**Interfaces:**
- Produces: `validateResumeBatch(interrupts: unknown, responses: unknown): string | null`. It is the single owner of non-empty arrays, equal lengths, interrupt identity, unique IDs, and approve/reject response discriminants. The adapter returns `{ status: 400 }` when it returns an error.

- [ ] **Step 1: Write failing tests** in `adapter.test.ts`. Build a handler via the existing test harness in that file (mirror the existing `/resume` test setup). Use a resolving `respondToInterrupts` spy. Add table-driven interrupt-item and response-item cases for `null`, primitives, arrays, missing required fields, malformed discriminants, and an empty identity; also cover empty batches, length mismatch, and duplicate IDs. Every malformed case returns `status: 400` and leaves the spy uncalled:

```ts
// unknown response type must be rejected, not run
const res = await handler("POST", "/resume", {
  interrupts: [firstInterrupt],
  responses: [{ type: "propagate" }], // not approve/reject
});
expect(res.status).toBe(400);
expect(respondSpy).not.toHaveBeenCalled();

// length mismatch
const mismatched = await handler("POST", "/resume", {
  interrupts: [firstInterrupt, secondInterrupt],
  responses: [approveResponse],
});
expect(mismatched.status).toBe(400);
// empty batch
const empty = await handler("POST", "/resume", {
  interrupts: [],
  responses: [],
});
expect(empty.status).toBe(400);
// interrupt missing its required identity field
const missingIdentity = await handler("POST", "/resume", {
  interrupts: [{ ...firstInterrupt, interruptId: "" }],
  responses: [approveResponse],
});
expect(missingIdentity.status).toBe(400);
// nulls/primitives must return 400 rather than throw
const nullInterrupt = await handler("POST", "/resume", {
  interrupts: [null],
  responses: [approveResponse],
});
expect(nullInterrupt.status).toBe(400);
const nullResponse = await handler("POST", "/resume", {
  interrupts: [firstInterrupt],
  responses: [null],
});
expect(nullResponse.status).toBe(400);
// duplicate IDs would overwrite in the ID-keyed response map
const duplicateIdentity = await handler("POST", "/resume", {
  interrupts: [
    firstInterrupt,
    { ...secondInterrupt, interruptId: firstInterrupt.interruptId },
  ],
  responses: [approveResponse, rejectResponse],
});
expect(duplicateIdentity.status).toBe(400);
// well-formed still resumes (regression)
const valid = await handler("POST", "/resume", {
  interrupts: [firstInterrupt],
  responses: [{ type: "approve" }],
});
expect(valid.status).toBe(200);
expect(valid.body).toEqual({ success: true, value: "resumed" });
expect(respondSpy).toHaveBeenCalledOnce();
```

Build the valid baseline with the existing `interrupt(...)` factory so it
includes all real identity fields. Update the existing successful `/resume`
fixture from `{ id: "1" }` to that baseline. Do not treat HTTP 200 alone as
success: tool failures also use HTTP 200, so assert the success envelope and
resumed value.

Update `createServeHandler.test.ts` in the same step. Its fake node must pause
with a complete factory-built interrupt (including `type`, `interruptId`,
`runId`, `origin`, and `data`), and its resume request must echo the exact
interrupt array returned by the pause response rather than reconstructing a
partial literal. This keeps the full `lib/serve` guard compatible with the
hardened wire contract.

- [ ] **Step 2: Run to verify they fail.** `set -o pipefail; pnpm exec vitest run lib/serve/http/adapter.test.ts lib/serve/createServeHandler.test.ts 2>&1 | tee /tmp/pr1-1-fail.txt`. Expect the new 400 assertions to fail (currently 200 / respond called).

- [ ] **Step 3: Implement `validateResumeBatch`** in `interrupts.ts`. Never read a property before proving the value is a non-null, non-array object:

```ts
export function validateResumeBatch(
  interrupts: unknown,
  responses: unknown,
): string | null {
  if (!Array.isArray(interrupts) || !Array.isArray(responses)) {
    return "interrupts and responses must be arrays";
  }
  if (interrupts.length === 0) {
    return "interrupts must be non-empty";
  }
  if (interrupts.length !== responses.length) {
    return "interrupts and responses length mismatch";
  }
  const interruptIds: string[] = [];
  for (const interrupt of interrupts) {
    if (
      typeof interrupt !== "object" ||
      interrupt === null ||
      Array.isArray(interrupt)
    ) {
      return "each interrupt must be an object";
    }
    const fields = interrupt as Record<string, unknown>;
    if (fields.type !== "interrupt") {
      return "each interrupt type must be interrupt";
    }
    if (
      typeof fields.interruptId !== "string" ||
      fields.interruptId.length === 0
    ) {
      return "each interrupt must carry a non-empty string interruptId";
    }
    const interruptId = fields.interruptId;
    if (interruptIds.includes(interruptId)) {
      return "interrupt IDs must be unique";
    }
    interruptIds.push(interruptId);
  }
  for (const response of responses) {
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      return "each response must be an object";
    }
    const responseType = (response as { type?: unknown }).type;
    if (responseType !== "approve" && responseType !== "reject") {
      return "each response type must be approve or reject";
    }
  }
  return null;
}
```

Call it before `respondToInterrupts`. Use a block-form `if` and return HTTP 400
without invoking runtime code when it returns an error.

- [ ] **Step 4: Run tests, verify pass.** `set -o pipefail; pnpm exec vitest run lib/serve/http/adapter.test.ts lib/serve/createServeHandler.test.ts 2>&1 | tee /tmp/pr1-1-pass.txt`. Expect PASS.

- [ ] **Step 5: Commit.** Stage `lib/runtime/interrupts.ts`, `lib/serve/http/adapter.ts`, `lib/serve/http/adapter.test.ts`, and `lib/serve/createServeHandler.test.ts`, then commit with `git commit -F <msgfile>` — "fix(serve): reject malformed /resume before running (safety)".

## Task 1.2: Runtime defense-in-depth reuses the same validator

**Files:**
- Modify: `lib/runtime/interrupts.ts` (`buildResponseMap`, `:611-627`)
- Test: `lib/runtime/interrupts.test.ts` (or the nearest existing resume test file)

**Interfaces:**
- Consumes: `validateResumeBatch`. Produces: `buildResponseMap` rejects the same invalid batches for non-HTTP callers (MCP, direct embedders).

- [ ] **Step 1: Failing test.** Test the exported `validateResumeBatch` directly for invalid discriminants and duplicates. Also call public `respondToInterrupts` with an invalid response and a minimal fake runtime context; validation occurs before the context is read, so this proves the public runtime boundary rejects it. Do not export private `buildResponseMap` merely for testing and do not use an unexplained `as any` in the test.

- [ ] **Step 2: Run, verify fail.** `set -o pipefail; pnpm exec vitest run lib/runtime/interrupts.test.ts 2>&1 | tee /tmp/pr1-2-fail.txt`.

- [ ] **Step 3: Implement.** At the start of `buildResponseMap`, reuse the validator:

```ts
const validationError = validateResumeBatch(interrupts, responses);
if (validationError) {
  throw new Error(`respondToInterrupts: ${validationError}`);
}
```

- [ ] **Step 4: Run, verify pass.** `set -o pipefail; pnpm exec vitest run lib/runtime/interrupts.test.ts 2>&1 | tee /tmp/pr1-2-pass.txt`. Expect PASS.

- [ ] **Step 5: Commit.** "fix(runtime): validate resume response discriminants (defense in depth)".

- [ ] **Step 6: Full guard.** Run the serve + interrupt test dirs once: `set -o pipefail; pnpm exec vitest run lib/serve lib/runtime/interrupts.test.ts 2>&1 | tee /tmp/pr1-guard.txt`. Expect green. Open the PR.

---

# PR 2 — Extract the transport-agnostic interrupt core (findings 1, 5)

**Branch:** `interrupt-resolution-core`. Extract `run`'s loop into `lib/runtime/interruptResolution.ts`; make `resolveCliInterrupts` a thin caller that passes **no policy** to the endpoint. `run`'s observable behavior must not change.

## Task 2.1: `resolveInterrupts` driver

**Files:**
- Create: `lib/runtime/interruptResponse.ts`
- Create: `lib/runtime/interruptResolution.ts`
- Modify: `lib/runtime/interrupts.ts` (re-export response API; generalize `reportUnhandledInterrupts` input)
- Test: `lib/runtime/interruptResolution.test.ts`
- Test: `lib/runtime/interrupts.test.ts`

**Interfaces:**
- Produces:
  - `interruptResponse.ts` becomes the cycle-free owner of `InterruptApprove`, `InterruptReject`, `InterruptResponse`, `approve`, and `reject`. `interrupts.ts` re-exports them so all existing public imports remain valid.
  - `type InterruptResult = { data: unknown }` in `interrupts.ts`; `reportUnhandledInterrupts` accepts this minimal shape so local and remote callers share the same reporting boundary.
  - `InterruptApprove` and `InterruptReject` each represent their real optional `value?: any`; remove the casts that currently hide this mismatch from `approve(value?)` and `reject(value?)`.
  - `type ResumeFn<R extends InterruptResult> = (interrupts: Interrupt[], responses: InterruptResponse[]) => Promise<R>`
  - `type DecideFn = (interrupt: Interrupt) => Promise<InterruptResponse>`
  - `resolveInterrupts<R extends InterruptResult>(result: R, respond: ResumeFn<R>, decide: DecideFn): Promise<R>` — preserves a full `RunNodeResult` locally while accepting the remote client's minimal result.

- [ ] **Step 1: Failing tests.** Fake `respond` (no network) that returns a scripted sequence; scripted `decide`. Cover: no interrupts → returns result unchanged; one interrupt approved → respond called once with `[approve]`, returns final; several interrupts in one pause → one respond call with N responses in order; pauses twice → two respond calls, second batch decided too.

```ts
const respond: ResumeFn<InterruptResult> = async (interrupts, responses) => {
  calls.push({ interrupts, responses });
  const nextResult = script.shift();
  if (!nextResult) {
    throw new Error("interrupt result script was exhausted");
  }
  return nextResult;
};
const decide: DecideFn = async () => approve();
const result = await resolveInterrupts({ data: [firstInterrupt] }, respond, decide);
expect(result).toEqual({ data: "final" });
```

- [ ] **Step 2: Run, verify fail** (module missing). `set -o pipefail; pnpm exec vitest run lib/runtime/interruptResolution.test.ts 2>&1 | tee /tmp/pr2-1-fail.txt`.

- [ ] **Step 3: Implement** — the loop body lifted from `resolveCliInterrupts` (`runPolicyHandler.ts:266-285`), decision and resume injected, no policy/prompt/env here:

```ts
export async function resolveInterrupts<R extends InterruptResult>(
  result: R,
  respond: ResumeFn<R>,
  decide: DecideFn,
): Promise<R> {
  while (hasInterrupts(result.data)) {
    const interrupts = result.data;
    const responses: InterruptResponse[] = [];
    for (const interrupt of interrupts) {
      responses.push(await decide(interrupt));
    }
    result = await respond(interrupts, responses);
  }
  return result;
}
```

Change only the input type of `reportUnhandledInterrupts` from `RunNodeResult`
to `InterruptResult`; its behavior remains unchanged. Add a focused test proving
that `{ data: Interrupt[] }` is accepted and reported, without constructing
local-run messages or token metadata. Stub `process.exit` so a failed assertion
cannot terminate the test process.

Move and align the response variant types before using them in the driver. Add
a type and runtime regression proving `approve(value)` and `reject(value)`
preserve their optional values without casts, and a public-export regression
proving imports from `interrupts.ts` still resolve.

- [ ] **Step 4: Run, verify pass.** `set -o pipefail; pnpm exec vitest run lib/runtime/interruptResolution.test.ts lib/runtime/interrupts.test.ts 2>&1 | tee /tmp/pr2-1-pass.txt`.

- [ ] **Step 5: Commit.** "feat(runtime): resolveInterrupts — transport-agnostic interrupt loop".

## Task 2.2: Extract prompt mechanics to a leaf and build the decider

**Files:**
- Create: `lib/runtime/interruptPrompts.ts`
- Modify: `lib/runtime/interruptResolution.ts`
- Modify: `lib/runtime/runPolicyHandler.ts` (consume and re-export moved prompt API; remove runtime imports of `interrupts.ts`)
- Test: `lib/runtime/interruptResolution.test.ts`
- Test: existing `lib/runtime/runPolicyHandler.test.ts`

**Interfaces:**
- Produces from the leaf module: `PromptDecision`, `PromptFn`, `ValuePromptFn`, `parsePromptAnswer`, `parseValueAnswer`, `formatInterruptPrompt`, `terminalPrompt`, `terminalValuePrompt`. `runPolicyHandler.ts` re-exports these names so existing imports do not break.
- Produces from `runPolicyHandler.ts`: `hasRunPolicyMechanism(): boolean`, the declarative environment boundary used by the CLI endpoint adapter. It reuses the existing policy loader/validation; the adapter does not read or parse policy environment variables itself.
- Consumes in `interruptResolution.ts`: prompt API from `interruptPrompts.ts`; `checkPolicyExplicit`, `Policy` (`policy.ts`); `approve`, `reject` (`interruptResponse.ts`). It must not import `runPolicyHandler.ts`.
- Produces: `type BuildDeciderOptions = { policy?: Policy; interactive: boolean; prompt?: PromptFn; valuePrompt?: ValuePromptFn }` and `buildDecider(options: BuildDeciderOptions): DecideFn` — a closure holding the per-effect remembered decisions. Callers name the desired policy and interaction mode; prompt queues, terminal parsing, policy precedence, and remembering stay hidden.

- [ ] **Step 1: Failing tests** — the finding-1 core. Inject fake `prompt`/`valuePrompt` so no TTY is needed:
  - **No policy, interactive:** first `prompt` answer `"aa"` (approve-always) for effect `X` → approve; a second `X` interrupt approves **without** prompting (remembered). `"rr"` remembers reject.
  - **No policy, not interactive:** every interrupt → `reject()`.
  - **Policy approve rule** for `X` → approve, no prompt. **Policy reject rule** → reject, no prompt.
  - **Policy `propagate` rule** for `X` → *unsettled*: interactive prompts; non-interactive rejects. The returned response is never `propagate`.
  - **Value-expecting** (`interrupt.expectsValue`), with policy evaluated first: approve rule → valueless `approve()` (the runtime resolves the assignment to `true`); reject rule → `reject()`; propagate/no-match + interactive → `valuePrompt`; propagate/no-match + non-interactive → reject.

```ts
const decide = buildDecider({
  policy: { X: [{ action: "propagate" }] },
  interactive: false,
});
expect(await decide({ effect: "X", ...base })).toEqual(reject());
```

- [ ] **Step 2: Run, verify fail.** `set -o pipefail; pnpm exec vitest run lib/runtime/interruptResolution.test.ts lib/runtime/runPolicyHandler.test.ts 2>&1 | tee /tmp/pr2-2-fail.txt`.

- [ ] **Step 3: Implement:**

```ts
export function buildDecider(options: BuildDeciderOptions): DecideFn {
  const prompt = options.prompt ?? terminalPrompt;
  const valuePrompt = options.valuePrompt ?? terminalValuePrompt;
  const remembered: Record<string, "approve" | "reject"> = Object.create(null);

  return async (interrupt) => {
    // Policy always runs first. propagate + no-match are both unsettled.
    const decision = options.policy
      ? checkPolicyExplicit(options.policy, interrupt)
      : null;
    if (decision?.type === "approve") {
      return approve();
    }
    if (decision?.type === "reject") {
      return reject();
    }
    if (interrupt.expectsValue) {
      if (options.interactive) {
        return valuePrompt(interrupt);
      }
      return reject();
    }

    let action = remembered[interrupt.effect];
    if (!action && options.interactive) {
      const answer = await prompt(interrupt);
      const approves = answer === "approve" || answer === "approve-always";
      action = approves ? "approve" : "reject";
      const remember = answer === "approve-always" || answer === "reject-always";
      if (remember) {
        remembered[interrupt.effect] = action;
      }
    }
    return action === "approve" ? approve() : reject();
  };
}
```

Move the existing prompt queue, terminal I/O, parsing, and formatting without
behavior changes, converting its one-line conditionals to block form as a
formatting-only cleanup. `interruptPrompts.ts` and `runPolicyHandler.ts` import
response types/helpers from the cycle-free `interruptResponse.ts` leaf, never
runtime values from `interrupts.ts`. This removes the existing runtime
half-cycle where `interrupts.ts` imports `installRunPolicyHandler` and
`runPolicyHandler.ts` imports back into `interrupts.ts`. The runtime dependency
graph must be one-way:

```text
interruptResponse.ts ◀── interruptPrompts.ts ◀── interruptResolution.ts
          ▲                     ▲
          └── runPolicyHandler.ts ◀── interrupts.ts
```

- [ ] **Step 4: Run, verify pass.** `set -o pipefail; pnpm exec vitest run lib/runtime/interruptResolution.test.ts lib/runtime/runPolicyHandler.test.ts 2>&1 | tee /tmp/pr2-2-pass.txt`.

- [ ] **Step 5: Commit.** "feat(runtime): buildDecider — policy + interactive interrupt decisions".

## Task 2.3: Move the CLI endpoint adapter above the core (no endpoint policy)

**Files:**
- Create: `lib/runtime/cliInterruptResolution.ts`
- Modify: `lib/runtime/runPolicyHandler.ts` (remove `resolveCliInterrupts`)
- Modify: `lib/runtime/index.ts` (export from the new module under the same public name)
- Test: move the `resolveCliInterrupts` cases from `lib/runtime/runPolicyHandler.test.ts` to `lib/runtime/cliInterruptResolution.test.ts`; run existing interrupt/policy tests too.

**Interfaces:**
- `cliInterruptResolution.ts` consumes `resolveInterrupts`, `buildDecider`, prompt types, `hasRunPolicyMechanism`, IPC detection, and `reportUnhandledInterrupts`. It is the higher-level endpoint adapter; neither `runPolicyHandler.ts` nor `interrupts.ts` imports it.
- Produces: `resolveCliInterrupts` keeps its signature; behavior unchanged.

- [ ] **Step 1: Identify the guard tests.** `grep -rln "resolveCliInterrupts\|AGENCY_RUN_POLICY_INTERACTIVE\|makeRunPolicyHandler" lib --include=*.test.ts` → note the files; run them now to capture a green baseline: `set -o pipefail; pnpm exec vitest run <those files> 2>&1 | tee /tmp/pr2-3-baseline.txt`.

- [ ] **Step 2: Rewrite `resolveCliInterrupts`** to delegate. Keep the early guard exactly; build a decider with **no policy** (interactive only); call the driver:

```ts
export type ResolveCliInterruptOptions = {
  prompt?: PromptFn;
  valuePrompt?: ValuePromptFn;
};

export async function resolveCliInterrupts(
  result: RunNodeResult<any>,
  respond: ResumeFn<RunNodeResult<any>>,
  options?: ResolveCliInterruptOptions,
): Promise<RunNodeResult<any>> {
  if (!hasInterrupts(result.data)) {
    return result;
  }
  if (isIpcMode() || !hasRunPolicyMechanism()) {
    // No endpoint mechanism: report and exit.
    reportUnhandledInterrupts(result);
    return result;
  }
  const interactive =
    process.env[AGENCY_RUN_POLICY_INTERACTIVE] === AGENCY_RUN_POLICY_INTERACTIVE_ON;
  const decide = buildDecider({
    // No policy: run's policy acts only in-chain.
    interactive,
    prompt: options?.prompt,
    valuePrompt: options?.valuePrompt,
  });
  return resolveInterrupts(result, respond, decide);
}
```

Delete the now-duplicated inline loop and `DECISIONS` if it is unused elsewhere (`grep DECISIONS lib`). Preserve public exports through `runtime/index.ts` so generated programs and existing imports do not change.

- [ ] **Step 3: Run the updated guard tests, verify still green.** Run the moved/new test paths with `set -o pipefail` and save to `/tmp/pr2-3-pass.txt`; compare behavior with the baseline. Any change in run behavior is a bug — fix before proceeding.

- [ ] **Step 4: Add the finding-1 regression.** Set `AGENCY_RUN_POLICY` to approve effect `X`, then pass `resolveCliInterrupts` an already-surfaced `X` interrupt. This simulates a program handler's propagation winning over the in-chain approval. Assert the non-interactive endpoint rejects it. In a second case, enable interactivity and assert it prompts and follows the prompt response. The environment policy must never auto-approve at the endpoint.

- [ ] **Step 5: Commit.** "refactor(runtime): resolveCliInterrupts delegates to shared core; policy stays in-chain".

- [ ] **Step 6: Dependency and behavior guard.** Run `pnpm run lint:structure`, then `set -o pipefail; pnpm exec vitest run lib/runtime 2>&1 | tee /tmp/pr2-guard.txt`. Confirm no new cycle and no runtime value import from `runPolicyHandler.ts` or `interruptPrompts.ts` back to `interrupts.ts`. Green → open PR.

## Task 2.4: Expose the resolved policy without leaking its JSON transport

**Files:**
- Modify: `lib/cli/runPolicy.ts`
- Test: `lib/cli/runPolicy.test.ts`

**Interfaces:**
- Produces: `type ResolvedRunPolicy = { policy: Policy; policyJson: string; interactive: boolean }`.
- `resolveRunPolicy(flags): ResolvedRunPolicy | null` keeps `policyJson` for the subprocess environment and exposes the parsed `policy` for in-process consumers such as `remote call`.

- [ ] **Step 1: Write a failing test.** Resolve a built-in and assert `result.policy` contains the same rules as `JSON.parse(result.policyJson)`.
- [ ] **Step 2: Run the focused test and verify it fails.** `set -o pipefail; pnpm exec vitest run lib/cli/runPolicy.test.ts 2>&1 | tee /tmp/pr2-4-fail.txt`.
- [ ] **Step 3: Return both representations from the existing single policy construction.** Do not parse `policyJson` in remote command code and do not build the policy twice.
- [ ] **Step 4: Run `set -o pipefail; pnpm exec vitest run lib/cli/runPolicy.test.ts 2>&1 | tee /tmp/pr2-4-pass.txt`, then `make build`.** Expect both to pass without caller changes because the new field is additive.
- [ ] **Step 5: Commit.** "refactor(cli): expose parsed run policy to in-process callers".

---

# PR 3 — Sealed statelog wire with URL validation (finding 4)

**Branch:** `statelog-client`, created after PR 2 merges. Move `uploadClient.ts`, add origin validation, and add `serveClient.ts`. The branch must build independently against the merged PR 2 base.

## Task 3.1: Move `uploadClient` behind one trusted serve-URL boundary

**Files:**
- Create: `lib/cli/statelog/uploadClient.ts` (moved), `lib/cli/statelog/serveUrl.ts`
- Delete: `lib/cli/deploy/uploadClient.ts`
- Modify imports in: `lib/cli/deploy/deploy.ts`, `lib/cli/deploy/render.ts`, `lib/cli/deploy/curlExamples.ts`, and the temporary prototype `lib/cli/remote/remote.ts`
- Move test: `lib/cli/deploy/uploadClient.test.ts` → `lib/cli/statelog/uploadClient.test.ts`
- Test: `lib/cli/statelog/serveUrl.test.ts`

**Interfaces:**
- Produces: `resolveTrustedEndpointUrl(rawUrl: unknown, targetHost: string): string` — resolves relative URLs against the trusted host, then rejects non-HTTP(S), embedded credentials, or a different origin.
- Produces: `type ServeAddress = { serveUrl: string; origin: string; userId: string; projectId: string; filename: string }` and `parseServeBaseUrl(rawUrl: string): ServeAddress | null` — the single canonical parser for exact `/serve/:user/:project/:file` bases. It rejects credentials, unsupported protocols, query/hash, empty or extra segments, and command routes; decodes identifiers for fields and rebuilds canonical `serveUrl` by encoding each identifier once.
- Produces: `serveRouteUrl(serveUrl: string, segments: string[]): string` — validates the base through `parseServeBaseUrl` and appends encoded path segments exactly once.
- Produces: `projectPageUrl(address: ServeAddress): string` — constructs the statelog web-app URL from an already parsed address. `open.ts` does not know the page route or query-parameter shape.
- `serveBaseUrl` and `uploadBundle` keep their public signatures but delegate URL mechanics to these helpers.
- Task 3.1 may temporarily retain upload's private best-effort manifest fetch while the move compiles. Task 3.2 must remove it; PR 3 cannot finish with two manifest models or HTTP readers.

- [ ] **Step 1: Write failing URL tests.** Cover a relative endpoint, a same-origin absolute endpoint, a cross-origin endpoint, embedded credentials, unsupported protocol, and a non-string. For `parseServeBaseUrl`, cover the exact valid base plus query, hash, trailing slash, empty identifier, prefix/extra segments, command routes, credentials, and percent-encoded identifiers. For `projectPageUrl`, assert decoded identifiers become the expected encoded web-app query parameters.

- [ ] **Step 2: Add the representative failing assertions:**

```ts
const host = "https://statelog.example.com";
expect(resolveTrustedEndpointUrl("/serve/u/p/a/list", host)).toBe(
  "https://statelog.example.com/serve/u/p/a/list",
);
expect(() => resolveTrustedEndpointUrl("https://evil.com/x", host)).toThrow();
expect(() =>
  resolveTrustedEndpointUrl("https://user:pw@statelog.example.com/x", host),
).toThrow();
expect(() => resolveTrustedEndpointUrl(42, host)).toThrow();

expect(parseServeBaseUrl("https://statelog.example.com/serve/u/p/a")).toMatchObject({
  userId: "u",
  projectId: "p",
  filename: "a",
});
expect(parseServeBaseUrl("https://statelog.example.com/serve/u/p/a/node/main")).toBeNull();
expect(parseServeBaseUrl("https://statelog.example.com/serve/u/p/a?x=1")).toBeNull();
```

- [ ] **Step 3: Run, verify fail.** `set -o pipefail; pnpm exec vitest run lib/cli/statelog/serveUrl.test.ts 2>&1 | tee /tmp/pr3-1-fail.txt`.

- [ ] **Step 4: Implement `serveUrl.ts`.** Resolve first, validate second; callers must not reproduce that order:

```ts
export function resolveTrustedEndpointUrl(
  rawUrl: unknown,
  targetHost: string,
): string {
  if (typeof rawUrl !== "string") {
    throw new Error(`endpoint URL must be a string, got ${typeof rawUrl}`);
  }
  const target = new URL(targetHost);
  const endpoint = new URL(rawUrl, target);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error(`endpoint URL must use HTTP(S): ${rawUrl}`);
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`endpoint URL must not embed credentials: ${rawUrl}`);
  }
  if (endpoint.origin !== target.origin) {
    throw new Error(
      `endpoint origin ${endpoint.origin} does not match target ${target.origin}`,
    );
  }
  return endpoint.toString();
}
```

- [ ] **Step 5: Move the client and every consumer.** Move `uploadClient.ts` and its test. Update `deploy.ts`, `render.ts`, `curlExamples.ts`, and the still-compiled prototype `remote.ts`. Search for the basename with `grep -R -n "uploadClient" lib scripts` before deleting the old path. Run `make build`; PR 3 must compile independently while the prototype still exists.

- [ ] **Step 6: Apply the trusted resolver in `uploadClient.ts`.** Type-check, resolve, and origin-check every response URL before fetching `/list` or returning a persisted candidate. On failure return `{ ok: false, error }`. Add a test proving a rejected cross-origin or non-string URL causes no manifest fetch. Preserve the existing relative-URL test.

- [ ] **Step 7: Run tests, verify pass.** `set -o pipefail; pnpm exec vitest run lib/cli/statelog 2>&1 | tee /tmp/pr3-1-pass.txt`.

- [ ] **Step 8: Commit.** "refactor(cli): seal upload and serve URL handling under statelog".

## Task 3.2: `serveClient.ts`

**Files:**
- Create: `lib/cli/statelog/serveClient.ts`, `lib/cli/statelog/serveClient.test.ts`
- Modify: `lib/cli/statelog/uploadClient.ts` (delegate manifest enrichment)
- Modify: deploy outcome/render/curl-example imports that consume the upload manifest type

**Interfaces:**
- Produces:
  - `ServeFunctionManifest`, `ServeNodeManifest`, and `ServeManifest` as named, separately declared object types. Do not inline the function/node item shapes inside `ServeManifest`.
  - Reuse the shared `InterruptResult`; do not declare an identical remote-only result type.
  - `createServeClient(address: ServeAddress, apiKey: string): ServeClient` captures the trusted address and authentication once. Consumers name the operation they want; they do not repeatedly pass transport coordinates or construct a resume adapter.

```ts
export type ServeClient = {
  fetchManifest(): Promise<ServeManifest>;
  invokeNode(
    name: string,
    args: Record<string, unknown>,
  ): Promise<InterruptResult>;
  invokeFunction(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  resume: ResumeFn<InterruptResult>;
};
```

The internal, unexported `ServeResult` wire union distinguishes done, paused,
and failed envelopes. Each exported operation validates and unwraps its own
response and throws `ServeRequestError` for network, HTTP, JSON, schema, or
`success:false` failures. Command code therefore asks for a manifest, function
value, or interrupt-driver result and never sees the transport envelope.
`ServeManifest` and `ServeClient.fetchManifest` are also the sole manifest
model and reader in `lib/cli/statelog/`: upload enrichment creates a client for
the validated address, calls this operation, and catches
`ServeRequestError` to preserve its existing best-effort “omit the manifest but
keep the successful deploy” behavior. That catch logs the existing diagnostic;
it must not silently swallow the failure. Remove uploadClient's private
`Manifest`, `fetchManifest`, and manifest-shape casts; update deploy rendering
and curl examples to consume `ServeManifest`.

- [ ] **Step 1: Failing tests.** Stub global `fetch` (Vitest `vi.stubGlobal("fetch", …)`). Cover: `/node` done; a wrapped pause with a string `state` and a non-empty valid `Interrupt[]`; `success:false`; non-JSON/HTTP error; and a node name needing encoding. A final value such as `{ interrupts: [], completed: 12 }` or `{ interrupts: ["not-an-interrupt"] }` must remain final. For `/list`, validate each manifest item's name; every element of `parameters` and `interruptEffects`; optional function description; and optional destructive/idempotent booleans. Malformed items throw `ServeRequestError` rather than reaching render code. Exercise every `ServeClient` operation, including a later failure from `client.resume`. Add upload tests proving manifest success is retained and manifest failure is omitted without changing a successful upload.

- [ ] **Step 2: Run, verify fail.** `set -o pipefail; pnpm exec vitest run lib/cli/statelog/serveClient.test.ts lib/cli/statelog/uploadClient.test.ts 2>&1 | tee /tmp/pr3-2-fail.txt`.

- [ ] **Step 3: Implement.** Use `serveRouteUrl` for every request and keep Bearer auth/fetch/envelope parsing here. Recognize a wrapped node pause only when `state` is a string and `hasInterrupts(value.interrupts)` is true; otherwise the value is final. Validate manifest items rather than casting nested arrays. Keep request and wire-unwrapping helpers private; `createServeClient` and its returned operations are the declarative client boundary.

- [ ] **Step 4: Run, verify pass.** `set -o pipefail; pnpm exec vitest run lib/cli/statelog 2>&1 | tee /tmp/pr3-2-pass.txt`.

- [ ] **Step 5: Commit.** "feat(cli): serveClient — sealed statelog serve wire". Open PR.

---

# PR 4 — The `remote` commands (findings 3, 6, 7)

**Branch:** `agency-remote`. Depends on PRs 2 and 3.

## Task 4.1: Binding in `agency.json` (finding 6)

**Files:**
- Modify: `lib/config.ts` (add named `RemoteConfig` and `remote?: RemoteConfig` to `AgencyConfig` + its schema)
- Create: `lib/cli/remote/binding.ts`, `lib/cli/remote/binding.test.ts`

**Interfaces:**
- Produces:
  - `type RemoteConfig = { serveUrl: string }` in `lib/config.ts`; do not add an inline nested object type to `AgencyConfig`.
  - `type RemoteBinding = ServeAddress` from `lib/cli/statelog/serveUrl.ts`.
  - `readBinding(configPath: string): RemoteBinding | null` — reads raw JSON, obtains `remote.serveUrl`, and delegates canonical parsing to `parseServeBaseUrl`.
  - `writeBinding(configPath: string, binding: RemoteBinding): void` — raw-JSON read-modify-write, replacing only `remote`; callers do not manipulate the stored object shape.

- [ ] **Step 1: Config field.** Add the named `RemoteConfig` type and `remote?: RemoteConfig` to `AgencyConfig` and to whatever schema/validator `lib/config.ts` uses (match how existing optional sections like `log` are declared). `make build`.

- [ ] **Step 2: Failing tests** for `binding.ts` (use a temp dir, not repo files):
  - `readBinding` delegates the valid canonical URL to the shared parser; malformed, credential-bearing, query/hash, and extra-route URLs return null.
  - `writeBinding` on a file with `{ "log": { "host": "…" }, "custom": 1 }` adds `remote.serveUrl` and **preserves `log` and `custom`**.
  - `writeBinding` on a **missing** file creates it with just `{ remote: { serveUrl } }`.
  - `writeBinding` on **invalid JSON** throws and **does not modify** the file (assert bytes unchanged).
  - `writeBinding` rejects a scalar or array root and leaves its bytes unchanged.
  - `readBinding` on a missing file or config without `remote` → null.

- [ ] **Step 3: Run, verify fail.** `set -o pipefail; pnpm exec vitest run lib/cli/remote/binding.test.ts 2>&1 | tee /tmp/pr4-1-fail.txt`.

- [ ] **Step 4: Implement.** Both operations take `configPath`, so callers use one persistence model. `writeBinding` parses before writing, rejects `null`, arrays, and scalar roots, replaces only `remote`, and writes two-space JSON plus a final newline. `readBinding` does not reproduce URL rules; it calls `parseServeBaseUrl`.

- [ ] **Step 5: Run, verify pass.** `set -o pipefail; pnpm exec vitest run lib/cli/remote/binding.test.ts 2>&1 | tee /tmp/pr4-1-pass.txt`.

- [ ] **Step 6: Commit.** "feat(cli): remote binding in agency.json".

## Task 4.2: Arg building (`args.ts`)

**Files:** Create `lib/cli/remote/args.ts`, `lib/cli/remote/args.test.ts`

**Interfaces:**
- Produces: `type RemoteArgsOptions = { arg?: string[]; data?: string }` and `buildArgs(options: RemoteArgsOptions): Record<string, unknown>` — JSON-coerced `--arg name=value` over an optional `--data` JSON-object base.

- [ ] **Step 1: Failing tests.** `buildArgs({ arg: ["count=3","flag=true","msg=hi"] })` → `{count:3, flag:true, msg:"hi"}`; `--data '{"a":1}'` base merged then `--arg a=2` overrides → `{a:2}`; `--arg noequals` throws; `--data` non-object throws.
- [ ] **Step 2: Run, verify fail.** `set -o pipefail; pnpm exec vitest run lib/cli/remote/args.test.ts 2>&1 | tee /tmp/pr4-2-fail.txt`.
- [ ] **Step 3: Implement.** Port the prototype's `buildArgs`/`tryJson` (split on first `=`, `JSON.parse` each value, fall back to string).
- [ ] **Step 4: Run, verify pass.** `set -o pipefail; pnpm exec vitest run lib/cli/remote/args.test.ts 2>&1 | tee /tmp/pr4-2-pass.txt`.
- [ ] **Step 5: Commit.** "feat(cli): remote arg parsing".

## Task 4.3: Export count + render helpers

**Files:**
- Modify: `lib/serve/metadata.ts`, `lib/serve/metadata.test.ts`
- Promote: existing prototype `lib/cli/remote/exportedEndpoints.ts` (+ test)
- Create: `lib/cli/remote/render.ts`, `lib/cli/remote/render.test.ts`

**Interfaces:**
- Extends the existing `ServeMetadata` returned by `collectServeMetadata` with exported function names alongside exported node names. Produces: `type ExportedEndpointCount = { nodes: number; functions: number }` and `countExportedEndpoints(filePath, config): ExportedEndpointCount`, derived only from that shared metadata; render helpers `renderManifest(manifest, binding)`, `renderResult(value)`, `renderLink(binding)` using `color` from `@/utils/termcolors.js`.

- [ ] **Step 1: Failing tests.** In `metadata.test.ts`, prove `collectServeMetadata` reports exported node and function names from multiline fixtures under the repository's `.agency-tmp` directory. In `exportedEndpoints.test.ts`, prove a bare node has zero exports, an exported node increments nodes, and an exported function increments functions. Use checked safe cleanup; do not place Agency fixtures in the OS temp directory.
- [ ] **Step 2: Run, verify fail.** `set -o pipefail; pnpm exec vitest run lib/serve/metadata.test.ts lib/cli/remote/exportedEndpoints.test.ts lib/cli/remote/render.test.ts 2>&1 | tee /tmp/pr4-3-fail.txt`.
- [ ] **Step 3: Implement.** Extend `collectServeMetadata` once, then make `countExportedEndpoints` count the returned names. Remove the prototype's parallel `SymbolTable.build` derivation. `render.ts` owns successful manifest/result/link formatting; command utilities must not introduce a second `printResult` or duplicate formatting.
- [ ] **Step 4: Run, verify pass.** Add focused render tests, including a manifest with both node and function entries; do not rely on unrelated command tests to prove `renderManifest`. Run `set -o pipefail; pnpm exec vitest run lib/serve/metadata.test.ts lib/cli/remote/exportedEndpoints.test.ts lib/cli/remote/render.test.ts 2>&1 | tee /tmp/pr4-3-pass.txt`.
- [ ] **Step 5: Commit.** "feat(cli): remote export-count + render helpers".

## Task 4.4: Commands + registration + deprecated `deploy` shim (findings 3, 7)

**Files:**
- Create: `lib/cli/remote/commands/{link,deploy,ls,call,open}.ts`
- Create: `lib/cli/remote/decision.ts`, `lib/cli/remote/decision.test.ts`
- Create: `lib/cli/remote/browser.ts`, `lib/cli/remote/browser.test.ts`
- Create: `lib/cli/remote/confirmation.ts`, `lib/cli/remote/confirmation.test.ts`
- Create: `lib/cli/remote/commands/util.ts`
- Modify: `scripts/agency.ts` (register `remote` group; convert top-level `deploy` to a hidden deprecated shim)
- Test: `scripts/agency.test.ts` (registration and deprecated shim)
- Test: `lib/cli/remote/commands/call.test.ts` (the interrupt wiring)
- Test: `lib/cli/remote/commands/deploy.test.ts` (binding mutation contract)
- Test: `lib/serve/http/functionFrame.integration.test.ts` (real one-shot function interrupt)

**Interfaces:**
- Consumes: `resolveInterrupts`, `buildDecider` (PR2); `createServeClient` and the declarative operations from `serveUrl` (PR3); `binding.*`, `buildArgs`, `countExportedEndpoints`, render helpers; `deploy`, `serveBaseUrl`, `resolveRunPolicy`.
- Produces: `type RemoteCommandContext = { config: AgencyConfig; configPath: string }`; `runLink`, `runDeploy`, `runLs`, `runCall`, `runOpen`; and a `RemoteCommandContext` accessor in `scripts/agency.ts`. Each command also uses a named options type rather than an inline nested type.
- Produces: `resolveRemoteDecision(flags): DecideFn | null` in `decision.ts`. It owns flags → resolved policy → `buildDecider`, using `ResolvedRunPolicy.policy` directly. Command code never parses `policyJson`.
- Produces: `openBrowser(url): Promise<void>` in `browser.ts`, which owns macOS/Linux/Windows process selection and exposes injectable spawn/platform dependencies in tests; `runOpen` only supplies `projectPageUrl(binding)`.
- Produces: `confirmDeployWithoutExports(options): Promise<boolean>` in `confirmation.ts`, which owns TTY/readline mechanics and exposes an injectable prompt in tests. Per Revision 2, dry-run and non-TTY execution bypass the interactive gate and proceed; only an interactive TTY prompts. `runDeploy` only asks whether it should proceed.
- `commands/util.ts` owns `fail(message): never` and API-key lookup/error presentation. It logs before exiting or throwing; it does not render successful values.

- [ ] **Step 1: Config-path context.** In `scripts/agency.ts`, add a helper beside `getConfig()`:

```ts
function getConfigContext(): RemoteCommandContext {
  const options = program.opts();
  const configPath =
    options.config ?? path.resolve(process.cwd(), "agency.json");
  return { config: getConfig(), configPath };
}
```

- [ ] **Step 2: Decision-boundary test first.** In `decision.test.ts`, cover no flags → null; approve/reject/policy/interactive flags → a decider with the expected behavior; invalid policy → the same clear error `agency run` reports. Mock `resolveRunPolicy` to return a valid parsed `policy` plus deliberately unusable `policyJson`; assert the resulting decider still works. This behaviorally proves the module consumes `resolved.policy` without inspecting source text.

- [ ] **Step 3: `runCall` interrupt wiring — failing tests.** Stub `createServeClient` with a fake client whose `invokeNode` returns a pause and `resume` returns done; assert the shared loop resumes. Cover no mechanism + pause → unhandled report and no resume. Cover initial invocation and first/second-resume failures, for both `success:false` and network errors, and assert one clean command error. Invalid policy must fail before `client.invokeNode`, `client.invokeFunction`, or `client.resume` is called.

```ts
// node path drives the loop
client.invokeNode.mockResolvedValueOnce({ data: [firstInterrupt] });
client.resume.mockResolvedValueOnce({ data: "ok" });
await runCall(
  "main",
  { arg: ["q=hi"], interactive: false, policy: "approve-all" },
  context,
);
expect(client.resume).toHaveBeenCalledOnce();
```

- [ ] **Step 4: Add a real served-function interrupt integration test.** Compile an exported function that raises an unhandled interrupt and invoke it through the HTTP adapter. Because `runExportedFunction` has no node checkpoint/restore path, pin the current clean `success:false` tool failure. The CLI reports that serve error normally; do not mock an unreachable `{ done: false }` function result or promise a special message the wire cannot provide.
  While this fixture is in scope, replace its raw recursive `fs.rmSync` cleanup with checked `safeDeleteDirectory(fixturesRoot, false)` and assert/report a failed cleanup result.

- [ ] **Step 5: Run the focused tests and verify they fail.** `set -o pipefail; pnpm exec vitest run lib/cli/remote scripts/agency.test.ts lib/serve/http/functionFrame.integration.test.ts 2>&1 | tee /tmp/pr4-4-fail.txt`.

- [ ] **Step 6: Implement `runCall` as declarative orchestration:**

```ts
export async function runCall(
  name: string,
  options: RemoteCallOptions,
  context: RemoteCommandContext,
): Promise<void> {
  const binding = readBinding(context.configPath);
  if (!binding) {
    fail("Not linked …");
  }
  const apiKey = apiKeyOrExit(options);
  try {
    const args = buildArgs(options);
    const decide = resolveRemoteDecision(options);
    const client = createServeClient(binding, apiKey);
    if (options.function) {
      const value = await client.invokeFunction(name, args);
      renderResult(value);
      return;
    }

    const initialResult = await client.invokeNode(name, args);
    if (!decide) {
      reportUnhandledInterrupts(initialResult);
      renderResult(initialResult.data);
      return;
    }

    const result = await resolveInterrupts(
      initialResult,
      client.resume,
      decide,
    );
    renderResult(result.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }
}
```

`serveClient.ts` owns wire-result conversion; no raw wire result or unwrapping
helper is visible here. The command's one catch converts client, policy, and
argument failures to the CLI's normal clean error path instead of leaking an
unhandled rejection.
`decision.ts` owns policy resolution. `render.ts` owns successful value output.
`commands/util.ts` owns `fail(message): never` and `apiKeyOrExit`; it must not
duplicate result rendering, URL parsing, policy parsing, or envelope logic.

- [ ] **Step 7: Implement the other four recipes.** `runLink` delegates URL parsing to `parseServeBaseUrl`, then writes/reads by `configPath`; `runDeploy` obtains the shared export count, asks `confirmDeployWithoutExports` when the count is zero, lets `deploy()` report parse/compile errors, writes a binding only for `deployed`, and never for preview/error; `runLs` asks `client.fetchManifest()` for a validated manifest and passes it directly to `renderManifest`; `runOpen` calls `openBrowser(projectPageUrl(binding))`. No command recipe contains readline, TTY, platform, spawn, URL route, search-parameter, auth-header, or wire-adapter mechanics.

- [ ] **Step 8: Add deploy/binding and boundary tests.** Assert a deployed outcome writes the exact context `configPath`; preview/error outcomes write nothing; relative and absolute global `--config` paths are honored; invalid or non-object config bytes remain unchanged; export-count failure falls through to `deploy()`'s compile validation. For zero exports: an interactive decline prevents deploy, acceptance proceeds, and dry-run/non-TTY execution proceeds without prompting. Unit-test browser platform branches through injected dependencies rather than launching a real browser.

- [ ] **Step 9: Register in `scripts/agency.ts`.** Add the hidden `remote` group with `link/deploy/ls/call/open` (port the prototype's commander block; `call` gets `--arg` repeatable, `--data`, `--function`, `-i/--interactive`, `--policy`, `--approve`, `--reject`, `--api-key-env`). Convert the existing top-level `deploy` to a hidden shim that runs the old path **and** prints `color.yellow("agency deploy is deprecated; use agency remote deploy")` — and does **not** write a binding. Add a safe command-registration test that invokes the shim with stubbed deploy dependencies and proves the notice appears and no binding is written.

- [ ] **Step 10: Run, verify pass.** `set -o pipefail; pnpm exec vitest run lib/cli/remote scripts/agency.test.ts lib/serve/metadata.test.ts lib/serve/http/functionFrame.integration.test.ts 2>&1 | tee /tmp/pr4-4-pass.txt`.

- [ ] **Step 11: Build + manual smoke.** `make build`; `node ./dist/scripts/agency.js remote --help`; `node ./dist/scripts/agency.js deploy --help` (verifies the hidden shim remains directly addressable; help does not run its action or print deprecation). Verify `remote call --help` shows the new flags; rely on the registration test for the runtime notice.

- [ ] **Step 12: Commit.** "feat(cli): agency remote commands + deprecated deploy shim".

## Task 4.5: Remove the prototype, update dev docs

**Files:**
- Delete: `lib/cli/remote/{serveClient,interruptLoop,link,remote}.ts` + `README.md` (prototype files superseded by the real modules). Keep the promoted `exportedEndpoints.ts`.
- Modify: `docs/dev/hosted-agent-execution.md` (add a short `agency remote` section + retire the "Follow-ups: agency call" note)

- [ ] **Step 1:** Search every deleted basename and both alias/relative import forms: `grep -R -nE "cli/remote/(serveClient|interruptLoop|link|remote)|\./(serveClient|interruptLoop|link|remote)\.js|agency-remote\.json" lib scripts`. Delete only the superseded tracked files with the patch tool. If execution requires programmatic deletion, call `safeDeleteFile(path, false)` and check its result; never use raw `unlinkSync`/`rm`. Keep `exportedEndpoints.ts`, `binding.ts`, `args.ts`, `render.ts`, `decision.ts`, `browser.ts`, `confirmation.ts`, and `commands/`.
- [ ] **Step 2:** Add an `agency remote` subsection to `docs/dev/hosted-agent-execution.md` (dev doc, allowed): the five commands, the binding, the shared interrupt core, and the deferred `inspect`/`pull`/`logs`.
- [ ] **Step 3:** Run `make build` and `pnpm run lint:structure`, then `set -o pipefail; pnpm exec vitest run lib/cli/remote lib/cli/statelog lib/serve/http/functionFrame.integration.test.ts 2>&1 | tee /tmp/pr4-5-pass.txt` → green. The focused test run typechecks imports from deleted modules as well as exercising the production build.
- [ ] **Step 4: Commit.** "chore(cli): remove remote prototype; document agency remote". Open PR.

---

# Self-review notes (coverage)

- **Findings 1–7** each map to a task: F1→2.2/2.3, F2→1.1/1.2, F3→4.4 Step 4, F4→3.1, F5→3.2's throwing client operations + 4.4's single catch, F6→4.1, F7→4.4 Step 9.
- **Anti-pattern review:** imperative mechanics are concentrated behind named declarative boundaries (`validateResumeBatch`, `resolveInterrupts`, `buildDecider`, `createServeClient`, `serveUrl`, binding, decision, render, confirmation, browser, and command errors). Commands compose those operations and do not interpret config shapes, URL path rules, policy JSON, serve envelopes, terminal answers, or platform launch rules. Manifest parsing and exported-symbol discovery each have one owner. Named option/config/manifest types avoid nested inline definitions; copyable snippets avoid one-line conditionals, dense statements, nested ternaries, non-null assertions, and single-character names.
- **Spec components** each map: interrupt core→PR2; statelog wire→PR3; binding/args/render/exported→4.1–4.3; commands/registration→4.4; prototype removal + dev doc→4.5.
- **Deferred (not in any task, by design):** `inspect`/`pull`/`logs`, versioning, provider keys, the whoami route — all need statelog server work.
