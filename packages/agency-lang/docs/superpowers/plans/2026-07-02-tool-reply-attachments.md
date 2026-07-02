# Tool Reply Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tools hand images back to the model: `attachToReply()` queues attachments during a tool invocation; the LLM tool loop harvests them per invocation, appends ID markers to tool results, and injects one labeled user message after the tool round.

**Architecture:** A new runtime module (`lib/runtime/replyAttachments.ts`) owns the queue/harvest/build logic; `prompt.ts` gets two small touch points (harvest inside `runInvokeStep`'s success path; an idempotent injection `pr.step` after `stack.popBranches()`); a `std::thread` def + TS bridge exposes the tool-side surface; `generateImageFile` is the first consumer.

**Tech Stack:** TypeScript runtime (`lib/runtime/`), Agency stdlib (`stdlib/thread.agency` + `lib/stdlib/thread.ts`), vitest for TS units, Agency execution tests driven by the deterministic client's `{toolCalls: [...]}` mocks.

**Spec:** `docs/superpowers/specs/2026-07-02-tool-reply-attachments-design.md` — read it first.
**Review applied:** `docs/superpowers/plans/2026-07-02-tool-reply-attachments.review.md` (all 17 items + anti-pattern audit dispositioned; #5/#3 resolved by verification, #7 resolved by replacing the fork e2e with a structural unit + sequential e2e).

## Global Constraints

- All paths are relative to `packages/agency-lang/`. Work on the existing branch `tool-reply-attachments` (already created off main).
- Run `make` after ANY change to `stdlib/*.agency` or `lib/agents/**` before running Agency tests (the runner uses `dist/`). TS-only changes under `lib/` need `make` too before execution tests (they import `dist/`), but vitest runs on source.
- Save every test run's output to a file (`> /tmp/x.log 2>&1`); never run the full `tests/agency` suite locally — run only the specific new files.
- Agency syntax: `def f(x: T): R { }`, `if (cond) { }`, `let`/`const` before use. Flow narrowing does NOT track `continue` guards — use positive `if` nesting. No `break`, no ternaries in initializer position, no multi-line `||` initializers. Verify new `.agency` files with `pnpm run ast <file>`.
- Each Agency test node runs in its own subprocess; `/tmp` fixture files persist across runs — recreate them per node.
- Interrupts in Agency tests are answered inline with `with approve`.
- Commit messages via file (`git commit -F`), ending with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Model-facing marker strings are API** (spec risk 4) — the exact strings are defined in Task 1 and MUST be used verbatim everywhere (implementation, tests). Do not reword. Note they contain em-dashes (U+2014 `—`), not hyphens — do not "fix" them.
- The deterministic 1×1 PNG used in tests:
  `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC`

### Grounding: how the tool loop actually works (read before Task 3)

Verified against `lib/runtime/prompt.ts` on this branch:

- Tool calls in one round run concurrently via `pr.parallel(`round.${round}.tools`, ...)` (~line 1195). Each call gets `branchKey = tool_${index}_${toolCall.id}` and `branchStack = stack.getOrCreateBranch(branchKey).stack`; the tool body runs in an ALS frame whose `stack` IS that `branchStack` (set up by `runBatch.runInBranchAlsFrame` — see the comment at ~line 912).
- `runInvokeStep` (~line 891) executes the handler and pushes the `ToolMessage` for every outcome; the success push is at ~line 1064 (`messages.push(smoltalk.toolMessage(capToolResultForLlm(toolResult, toolResultCap), ...))`). It runs inside the idempotent `b.step(`round.${round}.tool.${callSlug}.invoke`)`, so on resume it is skipped for completed branches — harvest placed here runs exactly once per tool call, including on the two-trip interrupt path (an interrupted tool's invoke step completes only after resume, and its branch state — including `branchStack.other` — is serialized in the checkpoint).
- On round success, `stack.popBranches()` runs (~line 1334), then `tools`/`toolFunctions` are filtered, then the next LLM call happens inside `pr.step(`round.${round}.nextLlmCall`)`. **The injection step goes between the filter and `nextLlmCall`.** Branch queues must therefore be drained INTO `self.runnerState` at harvest time (before branches are popped/deleted).
- `self.runnerState` is the per-`llm()`-call persistent bag ("rides along with completedSteps on the same frame" — see `toolTimings`, ~line 1215): serialized across interrupt trips, per-`runPrompt` by construction → fork-safe, and the correct round buffer per the spec's §2.
- Failure paths (`crashed`/`failed`/`rejected`) call `stack.deleteBranch(branchKey)` and return before the success push — a failed tool's queued attachments die with its branch. This is intended (a failed tool's images must not be shown) and is pinned by a test.
- `ctx.isInsideToolCall()` already exists (`lib/runtime/state/context.ts:475`) — `enterToolCall()` wraps exactly the handler invocation.
- smoltalk exports needed: `smoltalk.userMessage(content: UserContentInput)`, `smoltalk.modelSupportsInputModality(model, "image" | "pdf")` — both confirmed; `prompt.ts` already namespace-imports smoltalk.
- `AttachmentSource` kinds (from `lib/stdlib/thread.ts:96-98`): `{kind:"path", path, mimeType?}` | `{kind:"url", url, mimeType?}` | `{kind:"base64", base64, mimeType}`.
- The deterministic client supports tool-call mocks: `{ "toolCalls": [{ "name": "...", "args": {...} }] }` entries in `llmMocks` (see `lib/runtime/deterministicClient.ts:33`), so execution tests can drive full tool-loop rounds with no real LLM.

---

### Task 1: `replyAttachments.ts` — queue, harvest, build (pure logic + vitest)

**Files:**
- Create: `lib/runtime/replyAttachments.ts`
- Test: `lib/runtime/replyAttachments.test.ts`

**Interfaces:**
- Consumes: `smoltalk.modelSupportsInputModality`, `StateStack` (only its `.other: Record<string, any>` bag), node `fs`/`path`.
- Produces (used by Tasks 2 and 3 — exact signatures):
  - `export type ReplyAttachmentPart = { type: "image" | "file"; source: { kind: "path"; path: string; mimeType?: string } | { kind: "url"; url: string; mimeType?: string } | { kind: "base64"; base64: string; mimeType: string }; filename?: string }`
  - `export type HarvestedReplyAttachment = { id: string; toolName: string; part: ReplyAttachmentPart }`
  - `export function queueReplyAttachment(stackOther: Record<string, any>, part: ReplyAttachmentPart): void`
  - `export function harvestReplyAttachments(args: { branchOther: Record<string, any>; runnerState: Record<string, any>; model: unknown; toolName: string }): string` — returns the marker text to append to the tool result (`""` when nothing was queued); moves surviving entries into `runnerState.replyAttachments`.
  - `export function buildReplyUserMessage(harvested: HarvestedReplyAttachment[]): unknown[]` — the parts array for `smoltalk.userMessage`.
  - `export function appendReplyMarker(cappedResult: unknown, marker: string, stringify: (value: unknown) => string): unknown`
  - `export const MAX_REPLY_ATTACHMENTS_PER_CALL = 10` and `export const MAX_REPLY_ATTACHMENT_BYTES = 20 * 1024 * 1024`
- **Marker strings (verbatim API, used by every later task):**
  - attach: `[attached ${id} — delivered in the user message following these tool results]`
  - too large: `[attachment ${id} skipped: too large to attach (over 20 MB)]`
  - modality: `[attachment ${id} skipped: the current model has no ${"image"|"PDF"} input]`
  - over count: `[attachment ${id} skipped: too many attachments for this llm() call (limit 10)]`
  - missing file at harvest: `[attachment ${id} skipped: file not found]`
  - injected label part: `[${id} — ${"image"|"file"} output of tool ${toolName}]`
  - unreadable at injection: `[${id} could not be read: ${message}]`

- [ ] **Step 1: Write the failing tests**

Create `lib/runtime/replyAttachments.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock ONLY the modality probe; everything else in smoltalk is unused here.
vi.mock("smoltalk", () => ({
  modelSupportsInputModality: (_model: unknown, modality: string) => {
    if (String(_model) === "text-only-model") return false;
    if (String(_model) === "unknown-model") return undefined;
    return modality === "image" || modality === "pdf";
  },
}));

import {
  queueReplyAttachment,
  harvestReplyAttachments,
  buildReplyUserMessage,
  appendReplyMarker,
  MAX_REPLY_ATTACHMENTS_PER_CALL,
  type HarvestedReplyAttachment,
  type ReplyAttachmentPart,
} from "./replyAttachments.js";

function imagePart(p: string): ReplyAttachmentPart {
  return { type: "image", source: { kind: "path", path: p } };
}

describe("queueReplyAttachment + harvestReplyAttachments", () => {
  it("returns empty marker and touches nothing when the queue is empty", () => {
    const runnerState: Record<string, any> = {};
    const marker = harvestReplyAttachments({
      branchOther: {},
      runnerState,
      model: "vision-model",
      toolName: "showChart",
    });
    expect(marker).toBe("");
    expect(runnerState.replyAttachments).toBeUndefined();
  });

  it("harvests a queued attachment: id, marker, buffer entry, queue drained", () => {
    const branchOther: Record<string, any> = {};
    const runnerState: Record<string, any> = {};
    queueReplyAttachment(branchOther, imagePart("/tmp/chart.png"));

    const marker = harvestReplyAttachments({
      branchOther,
      runnerState,
      model: "vision-model",
      toolName: "showChart",
    });

    expect(marker).toBe(
      "\n\n[attached img_1 — delivered in the user message following these tool results]",
    );
    expect(branchOther.pendingReplyAttachments).toBeUndefined();
    const harvested = runnerState.replyAttachments as HarvestedReplyAttachment[];
    expect(harvested).toHaveLength(1);
    expect(harvested[0]).toMatchObject({ id: "img_1", toolName: "showChart" });
  });

  it("assigns sequential ids across harvests within one runnerState", () => {
    const runnerState: Record<string, any> = {};
    const queueA: Record<string, any> = {};
    const queueB: Record<string, any> = {};
    queueReplyAttachment(queueA, imagePart("/tmp/a.png"));
    queueReplyAttachment(queueB, imagePart("/tmp/b.png"));
    queueReplyAttachment(queueB, imagePart("/tmp/c.png"));

    const markerA = harvestReplyAttachments({ branchOther: queueA, runnerState, model: "m", toolName: "toolA" });
    const markerB = harvestReplyAttachments({ branchOther: queueB, runnerState, model: "m", toolName: "toolB" });

    expect(markerA).toContain("img_1");
    expect(markerB).toContain("img_2");
    expect(markerB).toContain("img_3");
    const ids = (runnerState.replyAttachments as HarvestedReplyAttachment[]).map((h) => h.id);
    expect(ids).toEqual(["img_1", "img_2", "img_3"]);
  });

  it("separate runnerStates (parallel llm() calls) do not share counters or buffers", () => {
    // THE fork-isolation property: each runPrompt invocation owns its
    // runnerState, so parallel llm() calls cannot cross-contaminate.
    // (No e2e fork test exists — the deterministic client's mock queue
    // is module-keyed and flat, so concurrent branches consume from one
    // queue nondeterministically; the property is structural and pinned
    // here plus by the sequential-isolation execution test.)
    const runnerStateLeft: Record<string, any> = {};
    const runnerStateRight: Record<string, any> = {};
    const queueLeft: Record<string, any> = {};
    const queueRight: Record<string, any> = {};
    queueReplyAttachment(queueLeft, imagePart("/tmp/a.png"));
    queueReplyAttachment(queueRight, imagePart("/tmp/b.png"));
    harvestReplyAttachments({ branchOther: queueLeft, runnerState: runnerStateLeft, model: "m", toolName: "t" });
    harvestReplyAttachments({ branchOther: queueRight, runnerState: runnerStateRight, model: "m", toolName: "t" });
    expect((runnerStateLeft.replyAttachments as HarvestedReplyAttachment[])[0].id).toBe("img_1");
    expect((runnerStateRight.replyAttachments as HarvestedReplyAttachment[])[0].id).toBe("img_1");
    expect(runnerStateLeft.replyAttachments).toHaveLength(1);
    expect(runnerStateRight.replyAttachments).toHaveLength(1);
  });

  it("drops attachments with a skip marker when the model has no image input", () => {
    const branchOther: Record<string, any> = {};
    const runnerState: Record<string, any> = {};
    queueReplyAttachment(branchOther, imagePart("/tmp/a.png"));
    const marker = harvestReplyAttachments({
      branchOther,
      runnerState,
      model: "text-only-model",
      toolName: "showChart",
    });
    expect(marker).toBe(
      "\n\n[attachment img_1 skipped: the current model has no image input]",
    );
    expect(runnerState.replyAttachments ?? []).toEqual([]);
  });

  it("attaches optimistically when modality support is unknown (tri-state)", () => {
    const branchOther: Record<string, any> = {};
    const runnerState: Record<string, any> = {};
    queueReplyAttachment(branchOther, imagePart("/tmp/a.png"));
    const marker = harvestReplyAttachments({
      branchOther,
      runnerState,
      model: "unknown-model",
      toolName: "t",
    });
    expect(marker).toContain("[attached img_1");
    expect(runnerState.replyAttachments).toHaveLength(1);
  });

  it("skips oversized base64 attachments at harvest", () => {
    const branchOther: Record<string, any> = {};
    const runnerState: Record<string, any> = {};
    // ~21 MB decoded → over the 20 MB cap. Base64 length ≈ bytes * 4/3.
    const big = "A".repeat(Math.ceil((21 * 1024 * 1024 * 4) / 3));
    queueReplyAttachment(branchOther, {
      type: "image",
      source: { kind: "base64", base64: big, mimeType: "image/png" },
    });
    const marker = harvestReplyAttachments({ branchOther, runnerState, model: "m", toolName: "t" });
    expect(marker).toBe("\n\n[attachment img_1 skipped: too large to attach (over 20 MB)]");
    expect(runnerState.replyAttachments ?? []).toEqual([]);
  });

  it("skips oversized path attachments at harvest (fs.stat size)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tra-"));
    const bigFile = path.join(dir, "big.png");
    // Sparse-ish quick write: 21 MB of zeros.
    fs.writeFileSync(bigFile, Buffer.alloc(21 * 1024 * 1024));
    const branchOther: Record<string, any> = {};
    const runnerState: Record<string, any> = {};
    queueReplyAttachment(branchOther, imagePart(bigFile));
    const marker = harvestReplyAttachments({ branchOther, runnerState, model: "m", toolName: "t" });
    expect(marker).toContain("skipped: too large to attach");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("caps the per-call total with a visible skip marker", () => {
    const runnerState: Record<string, any> = {};
    const branchOther: Record<string, any> = {};
    for (let i = 0; i < MAX_REPLY_ATTACHMENTS_PER_CALL + 1; i++) {
      queueReplyAttachment(branchOther, imagePart(`/tmp/f${i}.png`));
    }
    const marker = harvestReplyAttachments({ branchOther, runnerState, model: "m", toolName: "t" });
    expect(runnerState.replyAttachments).toHaveLength(MAX_REPLY_ATTACHMENTS_PER_CALL);
    expect(marker).toContain(
      "[attachment img_11 skipped: too many attachments for this llm() call (limit 10)]",
    );
  });

  it("skips a missing path file at harvest with an honest marker", () => {
    const branchOther: Record<string, any> = {};
    const runnerState: Record<string, any> = {};
    queueReplyAttachment(branchOther, imagePart("/nonexistent-tra/missing.png"));
    const marker = harvestReplyAttachments({ branchOther, runnerState, model: "m", toolName: "t" });
    expect(marker).toBe("\n\n[attachment img_1 skipped: file not found]");
    expect(runnerState.replyAttachments).toEqual([]);
  });
});

describe("appendReplyMarker", () => {
  const stringify = (value: unknown) => JSON.stringify(value);

  it("returns the capped result unchanged when there is no marker", () => {
    const structured = { rows: 3 };
    expect(appendReplyMarker(structured, "", stringify)).toBe(structured);
  });

  it("appends to string results", () => {
    expect(appendReplyMarker("done", "\n\n[attached img_1]", stringify)).toBe(
      "done\n\n[attached img_1]",
    );
  });

  it("stringifies non-string results before appending", () => {
    expect(appendReplyMarker({ rows: 3 }, "\n\n[attached img_1]", stringify)).toBe(
      '{"rows":3}\n\n[attached img_1]',
    );
  });
});

describe("buildReplyUserMessage", () => {
  it("emits a label text part before each attachment part", () => {
    const harvested: HarvestedReplyAttachment[] = [
      {
        id: "img_1",
        toolName: "showChart",
        part: { type: "image", source: { kind: "base64", base64: "AAAA", mimeType: "image/png" } },
      },
    ];
    const parts = buildReplyUserMessage(harvested) as any[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "[img_1 — image output of tool showChart]" });
    expect(parts[1]).toMatchObject({ type: "image", source: { kind: "base64" } });
  });

  it("inlines path sources to base64 with the extension MIME type", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tra-"));
    const file = path.join(dir, "pic.png");
    fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
    const parts = buildReplyUserMessage([
      { id: "img_1", toolName: "t", part: { type: "image", source: { kind: "path", path: file } } },
    ]) as any[];
    expect(parts[1].source.kind).toBe("base64");
    expect(parts[1].source.base64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(parts[1].source.mimeType).toBe("image/png");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("replaces an unreadable path with a text part instead of throwing", () => {
    const parts = buildReplyUserMessage([
      {
        id: "img_1",
        toolName: "t",
        part: { type: "image", source: { kind: "path", path: "/nonexistent-tra/x.png" } },
      },
    ]) as any[];
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("[img_1 could not be read:");
  });

  it("passes url sources through untouched and labels file parts as file output", () => {
    const parts = buildReplyUserMessage([
      {
        id: "img_1",
        toolName: "fetchDoc",
        part: { type: "file", source: { kind: "url", url: "https://example.com/r.pdf" }, filename: "r.pdf" },
      },
    ]) as any[];
    expect(parts[0].text).toBe("[img_1 — file output of tool fetchDoc]");
    expect(parts[1].source).toEqual({ kind: "url", url: "https://example.com/r.pdf" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/runtime/replyAttachments.test.ts > /tmp/tra1-fail.log 2>&1; tail -5 /tmp/tra1-fail.log`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the module**

Create `lib/runtime/replyAttachments.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import { modelSupportsInputModality } from "smoltalk";

/**
 * Reply attachments: the channel by which a TOOL hands images back to the
 * model. `attachToReply` (std::thread) queues onto the calling tool
 * invocation's branch-local `stack.other` (serialized — survives a mid-round
 * interrupt); the tool loop harvests at invocation completion into the
 * prompt's `runnerState` (per-llm()-call, serialized, fork-safe) and appends
 * a marker to that tool's result text; after the full tool round the loop
 * injects ONE labeled user message built here. See
 * docs/superpowers/specs/2026-07-02-tool-reply-attachments-design.md.
 *
 * The marker strings below are MODEL-FACING API — tests pin them; do not
 * reword casually.
 */

export type ReplyAttachmentPart = {
  type: "image" | "file";
  source:
    | { kind: "path"; path: string; mimeType?: string }
    | { kind: "url"; url: string; mimeType?: string }
    | { kind: "base64"; base64: string; mimeType: string };
  filename?: string;
};

export type HarvestedReplyAttachment = {
  id: string;
  toolName: string;
  part: ReplyAttachmentPart;
};

export const MAX_REPLY_ATTACHMENTS_PER_CALL = 10;
export const MAX_REPLY_ATTACHMENT_BYTES = 20 * 1024 * 1024; // smoltalk's cap

const QUEUE_KEY = "pendingReplyAttachments";
const BUFFER_KEY = "replyAttachments";
const COUNTER_KEY = "replyAttachmentCounter";

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Queue an attachment on a tool invocation's branch-local `stack.other`
 *  bag. Plain JSON in, so it serializes with the branch state. */
export function queueReplyAttachment(
  stackOther: Record<string, any>,
  part: ReplyAttachmentPart,
): void {
  stackOther[QUEUE_KEY] ??= [];
  (stackOther[QUEUE_KEY] as ReplyAttachmentPart[]).push(part);
}

/** Decoded size estimate. base64 length * 3/4 for inline data; fs.stat for
 *  paths; URLs are unknowable pre-fetch and pass through (documented
 *  limitation — mirrors user-supplied URL attachments). */
function estimatedBytes(part: ReplyAttachmentPart): number | null {
  if (part.source.kind === "base64") {
    return Math.floor((part.source.base64.length * 3) / 4);
  }
  if (part.source.kind === "path") {
    try {
      return fs.statSync(part.source.path).size;
    } catch {
      // Intentional swallow: a missing file is a NORMAL outcome here —
      // the file-not-found gate reports it as a skip marker; this
      // function only answers "how big, if knowable".
      return null;
    }
  }
  return null;
}

type GateResult = { ok: true } | { ok: false; reason: string };

/** Pure gate: decide whether one queued part may attach, given how many
 *  survivors this llm() call already has. Returns the skip REASON (the
 *  text after "skipped: " in the marker) so gating logic and marker
 *  wording stay separable — adding a gate never touches the harvest
 *  loop. Passing `model` straight through to smoltalk is deliberate:
 *  it is exactly what smoltalk's own send-time gate does with
 *  `config.model`, so this pre-check can never disagree with send. */
function gateReplyAttachment(
  part: ReplyAttachmentPart,
  acceptedSoFar: number,
  model: unknown,
): GateResult {
  const modality = part.type === "image" ? "image" : "pdf";
  const modalityWord = part.type === "image" ? "image" : "PDF";
  // Tri-state on purpose: only an explicit catalog `false` drops the
  // attachment — unknown models attach optimistically, matching
  // smoltalk's own send-time gate.
  if (modelSupportsInputModality(model as any, modality) === false) {
    return { ok: false, reason: `the current model has no ${modalityWord} input` };
  }
  if (part.source.kind === "path" && !fs.existsSync(part.source.path)) {
    // Catch a bad path at harvest so the tool result carries an honest
    // skip marker instead of "attached" followed by a could-not-be-read
    // part. The builder keeps its own fallback for the delete-between-
    // harvest-and-injection race.
    return { ok: false, reason: "file not found" };
  }
  const bytes = estimatedBytes(part);
  if (bytes !== null && bytes > MAX_REPLY_ATTACHMENT_BYTES) {
    return { ok: false, reason: "too large to attach (over 20 MB)" };
  }
  if (acceptedSoFar >= MAX_REPLY_ATTACHMENTS_PER_CALL) {
    return {
      ok: false,
      reason: `too many attachments for this llm() call (limit ${MAX_REPLY_ATTACHMENTS_PER_CALL})`,
    };
  }
  return { ok: true };
}

/** Drain a tool invocation's queue, gate each entry, move survivors into
 *  `runnerState[BUFFER_KEY]`, and return the marker text to append to that
 *  tool's result (empty string when nothing queued). Runs inside the
 *  idempotent per-tool invoke step of the tool loop, so it executes exactly
 *  once per tool call, including across interrupt/resume. */
export function harvestReplyAttachments(args: {
  branchOther: Record<string, any>;
  runnerState: Record<string, any>;
  model: unknown;
  toolName: string;
}): string {
  const { branchOther, runnerState, model, toolName } = args;
  const queued = branchOther[QUEUE_KEY] as ReplyAttachmentPart[] | undefined;
  if (!queued || queued.length === 0) {
    return "";
  }
  delete branchOther[QUEUE_KEY];

  runnerState[BUFFER_KEY] ??= [];
  runnerState[COUNTER_KEY] ??= 0;
  const buffer = runnerState[BUFFER_KEY] as HarvestedReplyAttachment[];

  const lines: string[] = [];
  for (const part of queued) {
    const id = `img_${++runnerState[COUNTER_KEY]}`;
    const gate = gateReplyAttachment(part, buffer.length, model);
    if (gate.ok) {
      buffer.push({ id, toolName, part });
      lines.push(
        `[attached ${id} — delivered in the user message following these tool results]`,
      );
    } else {
      lines.push(`[attachment ${id} skipped: ${gate.reason}]`);
    }
  }
  return `\n\n${lines.join("\n")}`;
}

/** Append the harvest marker to a (possibly non-string) capped tool
 *  result. Kept here so the "" no-marker sentinel never leaks decisions
 *  into prompt.ts — the caller composes unconditionally. */
export function appendReplyMarker(
  cappedResult: unknown,
  marker: string,
  stringify: (value: unknown) => string,
): unknown {
  if (marker === "") {
    return cappedResult;
  }
  if (typeof cappedResult === "string") {
    return `${cappedResult}${marker}`;
  }
  return `${stringify(cappedResult)}${marker}`;
}

/** Build the parts array for the injected user message: one label text part
 *  immediately before each attachment part. Path sources are inlined to
 *  base64 HERE (not at send) so the persistent thread never re-reads a file
 *  that may later be deleted or edited; url/base64 sources pass through.
 *  Never throws: an unreadable path becomes a text part naming the failure. */
export function buildReplyUserMessage(
  harvested: HarvestedReplyAttachment[],
): unknown[] {
  const parts: unknown[] = [];
  for (const entry of harvested) {
    const kindWord = entry.part.type === "image" ? "image" : "file";
    const label = `[${entry.id} — ${kindWord} output of tool ${entry.toolName}]`;
    if (entry.part.source.kind === "path") {
      const filePath = entry.part.source.path;
      let base64: string;
      try {
        base64 = fs.readFileSync(filePath).toString("base64");
      } catch (error: unknown) {
        // Intentional swallow: the file vanished between harvest and
        // injection (harvest already gates missing files). The text part
        // IS the report — injection must never fail the turn.
        const message = error instanceof Error ? error.message : String(error);
        parts.push({ type: "text", text: `[${entry.id} could not be read: ${message}]` });
        continue;
      }
      const mimeType =
        entry.part.source.mimeType ??
        EXT_TO_MIME[path.extname(filePath).toLowerCase()] ??
        (entry.part.type === "image" ? "image/png" : "application/pdf");
      parts.push({ type: "text", text: label });
      parts.push({
        type: entry.part.type,
        source: { kind: "base64", base64, mimeType },
        ...(entry.part.filename !== undefined ? { filename: entry.part.filename } : {}),
      });
    } else {
      parts.push({ type: "text", text: label });
      parts.push(entry.part);
    }
  }
  return parts;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/runtime/replyAttachments.test.ts > /tmp/tra1-pass.log 2>&1; grep "Tests " /tmp/tra1-pass.log`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Add replyAttachments runtime module (queue/harvest/build)

Queue rides the tool invocation's branch-local stack.other (serialized,
interrupt-safe); harvest gates modality (tri-state, drop only on
explicit false), size (20 MB), and per-call count (10), assigns
persistent img_N ids, and moves survivors into the prompt's
runnerState; the injected-user-message builder inlines path sources to
base64 and never throws. Marker strings are model-facing API, pinned
by tests.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add lib/runtime/replyAttachments.ts lib/runtime/replyAttachments.test.ts
git commit -F /tmp/commit-msg.txt
```

---

### Task 2: `std::thread.attachToReply` (Agency def + TS bridge)

**Files:**
- Modify: `lib/stdlib/thread.ts` (add `_attachToReply`)
- Modify: `stdlib/thread.agency` (import `_attachToReply`; add the def near `image()`/`file()`)
- Test: `lib/stdlib/thread.attachments.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `queueReplyAttachment`, `ReplyAttachmentPart` (Task 1); `agencyStore` from `lib/runtime/asyncContext.js` (already imported by other stdlib files — check `lib/stdlib/thread.ts`'s existing imports and reuse its pattern); `ctx.isInsideToolCall()` (`lib/runtime/state/context.ts:475`).
- Produces: `export function _attachToReply(attachment: unknown): void` (TS); `export safe def attachToReply(attachment: Attachment)` in `std::thread` — consumed by Task 4's `generateImageFile` and by test tools in Task 3.

- [ ] **Step 1: Write the failing tests**

Append to `lib/stdlib/thread.attachments.test.ts` (match its existing imports; add `_attachToReply` to the import from `./thread.js` and import `agencyStore` from `../runtime/asyncContext.js`):

```ts
describe("_attachToReply", () => {
  function frameWith(toolDepth: number) {
    const stack = { other: {} as Record<string, any> };
    const ctx = {
      isInsideToolCall: () => toolDepth > 0,
      statelogClient: { error: vi.fn() },
    };
    return { ctx, stack } as any;
  }

  it("queues onto the frame's stack.other when inside a tool call", () => {
    const frame = frameWith(1);
    agencyStore.run(frame, () => {
      _attachToReply({ type: "image", source: { kind: "path", path: "/tmp/x.png" } });
    });
    expect(frame.stack.other.pendingReplyAttachments).toHaveLength(1);
    expect(frame.stack.other.pendingReplyAttachments[0].source.path).toBe("/tmp/x.png");
  });

  it("drops with a statelog error outside a tool call (never throws)", () => {
    const frame = frameWith(0);
    agencyStore.run(frame, () => {
      _attachToReply({ type: "image", source: { kind: "path", path: "/tmp/x.png" } });
    });
    expect(frame.stack.other.pendingReplyAttachments).toBeUndefined();
    expect(frame.ctx.statelogClient.error).toHaveBeenCalledTimes(1);
  });

  it("is a no-op outside any runtime frame", () => {
    expect(() =>
      _attachToReply({ type: "image", source: { kind: "path", path: "/tmp/x.png" } }),
    ).not.toThrow();
  });
});
```

(If the file's harness lacks `vi`, add it to the vitest import line.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:run lib/stdlib/thread.attachments.test.ts > /tmp/tra2-fail.log 2>&1; tail -5 /tmp/tra2-fail.log`
Expected: FAIL — `_attachToReply` not exported.

- [ ] **Step 3: Implement the bridge**

In `lib/stdlib/thread.ts`, add imports (`agencyStore` may already be imported — check; `createLogger` follows the file's existing pattern if present, else add):

```ts
import { agencyStore } from "../runtime/asyncContext.js";
import {
  queueReplyAttachment,
  type ReplyAttachmentPart,
} from "../runtime/replyAttachments.js";
```

Add near `_imageAttachment` / `_fileAttachment`:

```ts
/** Backs `std::thread.attachToReply`. Queues an attachment on the CALLING
 *  TOOL INVOCATION's branch-local stack bag; the LLM tool loop harvests it
 *  when the invocation completes and shows it to the model as a labeled
 *  user message after the tool round (see lib/runtime/replyAttachments.ts).
 *  Outside a tool invocation there is no tool loop to harvest, so the
 *  attachment is dropped with a statelog error — never a throw (a tool
 *  must not crash because its host context changed). */
export function _attachToReply(attachment: unknown): void {
  const frame = agencyStore.getStore();
  if (!frame?.stack) {
    return;
  }
  if (!frame.ctx?.isInsideToolCall()) {
    frame.ctx?.statelogClient?.error({
      errorType: "toolError",
      message:
        "attachToReply called outside a tool invocation; attachment dropped",
      functionName: "attachToReply",
      retryable: false,
    });
    return;
  }
  queueReplyAttachment(
    frame.stack.other as Record<string, any>,
    attachment as ReplyAttachmentPart,
  );
}
```

(If `statelogClient.error`'s payload type requires more fields, match the shape used by the `toolError` call in `lib/runtime/prompt.ts` ~line 966.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:run lib/stdlib/thread.attachments.test.ts > /tmp/tra2-pass.log 2>&1; grep "Tests " /tmp/tra2-pass.log`
Expected: all pass (pre-existing tests in the file included).

- [ ] **Step 5: Add the Agency def**

In `stdlib/thread.agency`: add `_attachToReply,` to the import block from `"agency-lang/stdlib-lib/thread.js"` (the one importing `_imageAttachment` / `_fileAttachment`). Add the def after `file()`:

```
export safe def attachToReply(attachment: Attachment) {
  """
  Queue an attachment (from image() / file()) to be shown to the model
  after the current tool call completes. Only meaningful while running
  as a tool inside an llm() call: the tool's text result is delivered
  as usual with a marker naming the attachment, and the attachment
  follows as a user message the model can see. Prefer path sources
  (e.g. image("/abs/chart.png")) — the bytes are inlined when the
  message is built. Outside a tool invocation the attachment is
  dropped with a statelog error.

  @param attachment - The attachment to show the model (from image() / file())
  """
  _attachToReply(attachment)
}
```

- [ ] **Step 6: Build and parse-check**

```bash
make > /tmp/tra2-make.log 2>&1; echo "make=$?"; tail -3 /tmp/tra2-make.log
```
Expected: exit 0 (stdlib change requires `make`).

- [ ] **Step 7: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Add std::thread.attachToReply

Tools call it during an invocation to queue an attachment for the
model; the queue lands on the calling invocation's branch-local
stack.other so parallel tool calls stay isolated and a mid-round
interrupt cannot drop it. Outside a tool invocation the attachment is
dropped with a statelog error, never a throw.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add lib/stdlib/thread.ts lib/stdlib/thread.attachments.test.ts stdlib/thread.agency
git add -A docs/site/stdlib/
git commit -F /tmp/commit-msg.txt
```

(`make` regenerates `docs/site/stdlib/*.md`; the unconditional `git add -A docs/site/stdlib/` ensures the regenerated reference is never left out of the commit.)

---

### Task 3: Tool-loop wiring in `prompt.ts` + execution tests

**Files:**
- Modify: `lib/runtime/prompt.ts` (two touch points; see Grounding section)
- Test: `tests/agency/attach-to-reply.agency`
- Test: `tests/agency/attach-to-reply.test.json`

**Interfaces:**
- Consumes: `harvestReplyAttachments`, `buildReplyUserMessage`, `HarvestedReplyAttachment` (Task 1); `attachToReply` (Task 2); existing `smoltalk.userMessage`, `stringifyToolResult`, `self.runnerState`, `pr.step`.
- Produces: the end-to-end behavior — tool result markers + one injected labeled user message per round. No new exports.

- [ ] **Step 1: Write the failing execution tests**

Create `tests/agency/attach-to-reply.agency`:

```
// attachToReply: a tool queues an attachment; the tool loop appends a
// marker to the tool result and injects a labeled user message after
// the round. Asserted through getThread, whose reader renders
// attachment parts as "[image attachment]".
import { attachToReply, image, getThread } from "std::thread"

static const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

def showChart(): string {
  """
  Render the chart the user asked about.
  """
  attachToReply(image("/tmp/tra-chart.png"))
  return "chart ready"
}

def showMap(): string {
  """
  Render the map the user asked about.
  """
  attachToReply(image("/tmp/tra-map.png"))
  return "map ready"
}

def writeNote(): string {
  """
  Write a note file (raises the writeBinary interrupt).
  """
  writeBinary("tra-note.txt", "aGk=", "/tmp")
  return "note written"
}

// Collect the whole conversation as one string via the thread reader.
def conversationText(): string {
  let collected = ""
  for (tid in ["t0", "t1", "t2", "t3"]) {
    const messages = getThread(tid, 0, 200)
    if (isSuccess(messages)) {
      for (message in messages.value) {
        collected = collected + "<" + message.role + "> " + message.content + "\n"
      }
    }
  }
  return collected
}

node singleToolAttachment(): string {
  writeBinary("tra-chart.png", PNG, "/tmp") with approve
  const reply = llm("show me the chart", { tools: [showChart] })
  const convo = conversationText()
  const hasMarker = convo.includes("[attached img_1 — delivered in the user message following these tool results]")
  const hasLabel = convo.includes("[img_1 — image output of tool showChart]")
  const hasImage = convo.includes("[image attachment]")
  return "${reply}|${hasMarker}|${hasLabel}|${hasImage}"
}

node parallelToolsAttribution(): string {
  writeBinary("tra-chart.png", PNG, "/tmp") with approve
  writeBinary("tra-map.png", PNG, "/tmp") with approve
  const reply = llm("show both", { tools: [showChart, showMap] })
  const convo = conversationText()
  // Each tool result carries exactly its own marker; both labels appear
  // in the injected user message; two image parts total.
  const chartMarked = convo.includes("chart ready") && convo.includes("[attached img_")
  const chartLabel = convo.includes("image output of tool showChart]")
  const mapLabel = convo.includes("image output of tool showMap]")
  const both = convo.includes("img_1") && convo.includes("img_2")
  return "${reply}|${chartMarked}|${chartLabel}|${mapLabel}|${both}"
}

node interruptMidRoundKeepsAttachment(): string {
  // showChart queues an attachment; writeNote interrupts the round
  // (std::writeBinary). `with approve` resumes — the queued attachment
  // must survive the two-trip path and still be injected exactly once.
  writeBinary("tra-chart.png", PNG, "/tmp") with approve
  const reply = llm("chart and note", { tools: [showChart, writeNote] }) with approve
  const convo = conversationText()
  const marker = convo.includes("[attached img_1 — delivered in the user message following these tool results]")
  const image = convo.includes("[image attachment]")
  const once = convo.split("[img_1 — image output of tool showChart]").length == 2
  return "${reply}|${marker}|${image}|${once}"
}

node textOnlyModelSkips(): string {
  writeBinary("tra-chart.png", PNG, "/tmp") with approve
  const reply = llm("show me", { tools: [showChart], model: "gpt-3.5-turbo" })
  const convo = conversationText()
  const skip = convo.includes("[attachment img_1 skipped: the current model has no image input]")
  const noImage = !convo.includes("[image attachment]")
  return "${reply}|${skip}|${noImage}"
}

node outsideToolIsDropped(): string {
  attachToReply(image("/tmp/tra-chart.png"))
  return "ok"
}

node sequentialLlmCallsAreIsolated(): string {
  // Each llm() call gets its own runPrompt runnerState, so counters and
  // buffers never leak between calls: both threads carry img_1 and
  // img_2 never exists. (No e2e FORK variant: the deterministic
  // client's mock queue is flat and module-keyed — ScopedLLMMocks keys
  // by module, and both branches would share this module — so
  // concurrent branches consume mocks nondeterministically. The
  // parallel-isolation property is structural — one runnerState per
  // runPrompt — and pinned by the "separate runnerStates" vitest unit.)
  writeBinary("tra-chart.png", PNG, "/tmp") with approve
  writeBinary("tra-map.png", PNG, "/tmp") with approve
  const left = llm("show chart", { tools: [showChart] })
  const right = llm("show map", { tools: [showMap] })
  const convo = conversationText()
  const chartLabel = convo.includes("[img_1 — image output of tool showChart]")
  const mapLabel = convo.includes("[img_1 — image output of tool showMap]")
  const noCross = !convo.includes("img_2")
  return "${left}|${right}|${chartLabel}|${mapLabel}|${noCross}"
}
```

**Syntax check before proceeding** — verify per-call `model:` in `llm()` options against an existing usage (`grep -rn "llm(.*model:" tests/agency stdlib | head -3`) and correct the form if it differs. Run `pnpm run ast tests/agency/attach-to-reply.agency` and fix parse errors before writing the test.json.

Create `tests/agency/attach-to-reply.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "singleToolAttachment",
      "input": "",
      "expectedOutput": "\"done|true|true|true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "toolCalls": [{ "name": "showChart" }] },
        { "return": "done" }
      ]
    },
    {
      "nodeName": "parallelToolsAttribution",
      "input": "",
      "expectedOutput": "\"done|true|true|true|true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "toolCalls": [{ "name": "showChart" }, { "name": "showMap" }] },
        { "return": "done" }
      ]
    },
    {
      "nodeName": "interruptMidRoundKeepsAttachment",
      "input": "",
      "expectedOutput": "\"done|true|true|true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "toolCalls": [{ "name": "showChart" }, { "name": "writeNote" }] },
        { "return": "done" }
      ]
    },
    {
      "nodeName": "textOnlyModelSkips",
      "input": "",
      "expectedOutput": "\"done|true|true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "toolCalls": [{ "name": "showChart" }] },
        { "return": "done" }
      ]
    },
    {
      "nodeName": "outsideToolIsDropped",
      "input": "",
      "expectedOutput": "\"ok\"",
      "evaluationCriteria": [{ "type": "exact" }]
    },
    {
      "nodeName": "sequentialLlmCallsAreIsolated",
      "input": "",
      "expectedOutput": "\"done|done|true|true|true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "toolCalls": [{ "name": "showChart" }] },
        { "return": "done" },
        { "toolCalls": [{ "name": "showMap" }] },
        { "return": "done" }
      ]
    }
  ]
}
```

- [ ] **Step 2: Run to verify failure**

```bash
make > /tmp/tra3-make.log 2>&1; echo "make=$?"
pnpm run agency test tests/agency/attach-to-reply.agency > /tmp/tra3-fail.log 2>&1; grep "tests passed" /tmp/tra3-fail.log
```
Expected: the marker/label/image assertions fail (tool runs, nothing harvested/injected yet). `outsideToolIsDropped` may already pass (Task 2 shipped the drop path).

- [ ] **Step 3: Wire the harvest into `runInvokeStep`**

In `lib/runtime/prompt.ts`, add to the imports:

```ts
import {
  harvestReplyAttachments,
  buildReplyUserMessage,
  appendReplyMarker,
  type HarvestedReplyAttachment,
} from "./replyAttachments.js";
```

In `runInvokeStep`, replace the success push (~line 1064):

```ts
      // Success: cache the result, push tool message.
      toolResult =
        toolResult ||
        `${handler.name} ran successfully but did not return a value`;
      stack.setResultOnBranch(branchKey, toolResult);
      messages.push(
        smoltalk.toolMessage(capToolResultForLlm(toolResult, toolResultCap), {
          tool_call_id: toolCall.id,
          name: toolCall.name,
        }),
      );
      return { toolResult, invokeOutcome: "success" };
```

with:

```ts
      // Success: cache the result, push tool message.
      toolResult =
        toolResult ||
        `${handler.name} ran successfully but did not return a value`;
      stack.setResultOnBranch(branchKey, toolResult);
      // Reply attachments: drain what this invocation queued via
      // attachToReply (branch-local, so parallel tools cannot mix), gate
      // and id it, and append the model-facing marker to THIS tool's
      // result. Runs inside the idempotent invoke b.step, so it fires
      // exactly once per tool call across interrupt/resume. Survivors
      // land in self.runnerState (serialized per-llm()-call) and are
      // injected after the round completes.
      // `clientConfig.model` passes through unmodified — smoltalk's own
      // send-time gate calls modelSupportsInputModality(config.model, ...)
      // with the same value, so this pre-check is bug-for-bug identical
      // with send. Do NOT extract/stringify the model here.
      const replyMarker = harvestReplyAttachments({
        branchOther: branchStack.other as Record<string, any>,
        runnerState: self.runnerState,
        model: clientConfig.model,
        toolName: handler.name,
      });
      messages.push(
        smoltalk.toolMessage(
          appendReplyMarker(
            capToolResultForLlm(toolResult, toolResultCap),
            replyMarker,
            stringifyToolResult,
          ),
          {
            tool_call_id: toolCall.id,
            name: toolCall.name,
          },
        ),
      );
      return { toolResult, invokeOutcome: "success" };
```

Notes for the implementer: `clientConfig`, `self`, and `stringifyToolResult` are all in scope at `runInvokeStep` (verify; `stringifyToolResult` is module-level near `capToolResultForLlm`). `branchStack` is already a member of `runInvokeStep`'s args.

- [ ] **Step 4: Wire the injection after the round**

In the `while (toolCalls.length > 0)` loop, immediately after the `toolFunctions = toolFunctions.filter(...)` lines (~line 1338) and BEFORE the `nextLlmCall` step, insert:

```ts
      // Reply attachments harvested from this round's tools (and any
      // earlier round whose injection was pre-empted by an interrupt):
      // inject ONE labeled user message after ALL tool results — the
      // provider adjacency rules require the assistant's tool calls to
      // be answered by every tool result before any other message.
      // Resume-safety (verified): pr.step marks the key in
      // completedSteps and skips it on resume; PromptRunner snapshots
      // messagesJSON in beforeCheckpoint (promptRunner.ts ~line 243) so
      // a checkpoint stamped after this step completes carries the
      // injected message, and resume restores messages from
      // messagesJSON (prompt.ts ~line 775) — the same mechanism that
      // preserves sibling tool-message pushes. Clearing the buffer
      // inside the step keeps the outer guard consistent on replay.
      // The explicit messagesJSON write matches the pattern at the
      // first-LLM-call and nextLlmCall sites.
      const pendingReplies = (self.runnerState.replyAttachments ??
        []) as HarvestedReplyAttachment[];
      if (pendingReplies.length > 0) {
        await pr.step(`round.${round}.attachReplies`, async () => {
          messages.push(
            smoltalk.userMessage(
              buildReplyUserMessage(pendingReplies) as smoltalk.UserContentInput,
            ),
          );
          self.runnerState.replyAttachments = [];
          self.messagesJSON = messages.toJSON().messages;
        });
      }
```

- [ ] **Step 5: Build and run the execution tests**

```bash
make > /tmp/tra3-make2.log 2>&1; echo "make=$?"
pnpm run agency test tests/agency/attach-to-reply.agency > /tmp/tra3-pass.log 2>&1; grep "tests passed" /tmp/tra3-pass.log
```
Expected: 6/6. Debug from the log; the `conversationText()` output can be printed by temporarily returning it from a node.

- [ ] **Step 6: Regression — existing runtime + agent suites**

```bash
pnpm test:run lib/runtime > /tmp/tra3-runtime.log 2>&1; grep "Tests " /tmp/tra3-runtime.log
pnpm run agency test lib/agents/agency-agent/tests/agentTurn.agency > /tmp/tra3-agent.log 2>&1; grep "tests passed" /tmp/tra3-agent.log
```
Expected: no regressions (tools that never call `attachToReply` take the `replyMarker === ""` path — byte-identical tool messages).

- [ ] **Step 7: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Inject tool reply attachments as a labeled user message after the round

runInvokeStep drains each invocation's branch-local queue inside the
idempotent invoke step (exactly-once across interrupt/resume), appends
the model-facing marker to that tool's result, and buffers survivors in
runnerState; after stack.popBranches() the loop injects one labeled
user message before the next LLM call, satisfying every provider's
tool-call adjacency rules. Execution tests cover single/parallel
attribution, mid-round interrupt survival, text-only-model skips,
outside-tool drops, and fork isolation.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add lib/runtime/prompt.ts tests/agency/attach-to-reply.agency tests/agency/attach-to-reply.test.json
git commit -F /tmp/commit-msg.txt
```

---

### Task 4: First consumer — `generateImageFile` shows its output

**Files:**
- Modify: `lib/agents/agency-agent/agent.agency` (the `generateImageFile` def; add `attachToReply`, `image` to the `std::thread` import)
- Test: `lib/agents/agency-agent/tests/attachmentsTurn.agency` + `.test.json` (append one node)

**Interfaces:**
- Consumes: `attachToReply` (Task 2), the loop wiring (Task 3), existing `image` builder, `applyAgentCwd`.
- Produces: agent behavior only.

- [ ] **Step 1: Write the failing test**

Append to `lib/agents/agency-agent/tests/attachmentsTurn.agency`:

```
node generatedImageIsShownToModel(): string {
  // The coordinator LLM calls generateImageFile; after the tool round
  // the generated image must be injected so the model can see it.
  const reply = agentReply("draw me a bicycle") with approve
  return "${reply}|${threadHasImagePlaceholder()}"
}
```

Append to `lib/agents/agency-agent/tests/attachmentsTurn.test.json` `tests` array:

```json
    {
      "nodeName": "generatedImageIsShownToModel",
      "input": "",
      "expectedOutput": "\"made it|true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [
        { "toolCalls": [{ "name": "generateImageFile", "args": { "prompt": "a bicycle", "path": "/tmp/tra-gen-turn.png" } }] },
        { "return": "made it" }
      ]
    }
```

Run (expect FAIL — placeholder `false` because the tool doesn't attach yet):

```bash
make > /tmp/tra4-make.log 2>&1; echo "make=$?"
pnpm run agency test lib/agents/agency-agent/tests/attachmentsTurn.agency > /tmp/tra4-fail.log 2>&1; grep -E "tests passed|✗" /tmp/tra4-fail.log | head -3
```

- [ ] **Step 2: Implement**

In `lib/agents/agency-agent/agent.agency`: add `attachToReply` and `image` to the `std::thread` import line (it already imports `Attachment, getCost, getModelCosts, systemMessage`). In `generateImageFile`, between the write-failure check and the final return:

```
  if (isFailure(written)) {
    return "Generated the image, but saving to ${path} failed: ${written.error}"
  }
  // Show the model what it made (generate -> view -> refine). The loop
  // inlines the bytes when it builds the injected user message; the
  // path resolves the same way the write did.
  attachToReply(image(applyAgentCwd(path)))
  return "Saved image to ${path}"
```

Caveat: `applyAgentCwd(path)` resolves a relative `path` against the agent cwd, matching where `writeBinary(..., useAgentCwd: true)` put the file; an absolute `path` passes through. Both covered by the write-path tests from PR #395.

- [ ] **Step 3: Run to verify pass + regressions**

```bash
make > /tmp/tra4-make2.log 2>&1; echo "make=$?"
pnpm run agency test lib/agents/agency-agent/tests/attachmentsTurn.agency > /tmp/tra4-pass.log 2>&1; grep "tests passed" /tmp/tra4-pass.log
pnpm run agency test lib/agents/agency-agent/tests/imageTool.agency > /tmp/tra4-regress.log 2>&1; grep "tests passed" /tmp/tra4-regress.log
```
Expected: attachmentsTurn 5/5; imageTool 7/7 unchanged — the direct-call unit tests invoke `generateImageFile` OUTSIDE a tool loop, so `attachToReply` takes the drop path and their assertions are untouched (this is by design, not an accident — note it if a reviewer asks).

- [ ] **Step 4: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
generateImageFile shows the generated image to the model

After a successful save the tool queues the saved file via
attachToReply, so the coordinator model sees what it generated — the
missing half of generate/view/refine. Direct (non-tool-loop) calls are
unaffected: attachToReply drops outside a tool invocation.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add lib/agents/agency-agent/agent.agency lib/agents/agency-agent/tests/attachmentsTurn.agency lib/agents/agency-agent/tests/attachmentsTurn.test.json
git commit -F /tmp/commit-msg.txt
```

---

### Task 5: Docs, full verification, spec status

**Files:**
- Create: `docs/dev/reply-attachments.md`
- Modify: `docs/superpowers/specs/2026-07-02-tool-reply-attachments-design.md` (frontmatter `status: design` → `status: implemented`)
- Modify: root `CLAUDE.md`'s "Deeper docs" list (one line, alongside the other `docs/dev/` entries)

- [ ] **Step 1: Write the dev doc**

Create `docs/dev/reply-attachments.md`:

```markdown
# Tool reply attachments

How a tool hands images back to the model. A base64 string in a tool
result is text to the model — vision input must travel as image parts,
and most providers do not accept image parts in tool results. So agency
routes them through a labeled user message injected after the tool
round.

## Flow

1. A tool calls `std::thread.attachToReply(image(path))` during its
   invocation. The bridge (`lib/stdlib/thread.ts:_attachToReply`) pushes
   onto the CALLING INVOCATION's branch-local `stack.other`
   (`pendingReplyAttachments`) — each parallel tool call has its own
   branch stack, so queues cannot mix, and branch state serializes, so a
   mid-round interrupt cannot drop a queued attachment. Outside a tool
   invocation (`ctx.isInsideToolCall()` false) the attachment is dropped
   with a statelog error.
2. `runInvokeStep` (lib/runtime/prompt.ts) harvests at invocation
   completion, inside the idempotent per-tool invoke `b.step` — exactly
   once per tool call across interrupt/resume. Harvest
   (`lib/runtime/replyAttachments.ts`) gates each entry — modality
   (tri-state via smoltalk's `modelSupportsInputModality`; only an
   explicit `false` drops), size (20 MB), per-call count (10) — assigns
   a persistent `img_N` id from a counter on `self.runnerState`, appends
   the model-facing marker to that tool's result text, and moves
   survivors to `self.runnerState.replyAttachments` (per-llm()-call,
   serialized, fork-safe).
3. After `stack.popBranches()` and before the next LLM call, the loop
   injects ONE user message (`pr.step` "attachReplies", resume-
   idempotent): a label text part before each attachment part. Path
   sources are inlined to base64 at build time so the persistent thread
   never re-reads a deletable file; url/base64 sources pass through.
   Injection after the COMPLETE round satisfies every provider's
   adjacency rule (all tool results must directly follow the
   assistant's tool calls).

## Marker strings are model-facing API

Pinned by tests/agency/attach-to-reply tests and
lib/runtime/replyAttachments.test.ts — do not reword without updating
both and considering deployed prompts:

- `[attached img_N — delivered in the user message following these tool results]`
- `[attachment img_N skipped: too large to attach (over 20 MB)]`
- `[attachment img_N skipped: the current model has no image input]` (or `PDF`)
- `[attachment img_N skipped: too many attachments for this llm() call (limit 10)]`
- `[attachment img_N skipped: file not found]`
- label part: `[img_N — image output of tool <name>]` (or `file output`)

## Failure semantics

A tool that fails/crashes/gets rejected loses its queued attachments
with its branch (`stack.deleteBranch`) — intended: a failed tool's
images must not be shown. Skips never fail the turn; they become
markers. On Anthropic the injected message follows the tool_result user
message as a consecutive user message (API combines same-role
messages; smoltalk is growing a client-side merge as belt and
suspenders).

First consumer: the agent's `generateImageFile`. Future:
`viewAttachment` (attachment-store track) reuses this channel
unchanged.
```

- [ ] **Step 2: Register the doc, sync the spec, flip its status**

Add to the root `CLAUDE.md` "Deeper docs" list (alphabetical-ish placement near the other runtime docs):

```
- `docs/dev/reply-attachments.md` — How tools hand images back to the model: attachToReply, branch-local queues, harvest/inject in the tool loop, marker-string API
```

Update the spec (`docs/superpowers/specs/2026-07-02-tool-reply-attachments-design.md`) to match the implemented reality — do this now, not "later":
- §3 marker examples: skip markers say `the current model has no image input` (the model is not named — `clientConfig.model` may be a structured value, and pass-through to the modality probe is what keeps this check identical to smoltalk's send gate); add the `file not found` skip marker.
- §4: the attachment count cap is per-`llm()`-call (strictly tighter than the spec's per-round wording).
- Frontmatter: `status: design` → `status: implemented`.

- [ ] **Step 3: Full verification**

```bash
pnpm run lint:structure > /tmp/tra5-lint.log 2>&1; echo "lint=$?"
pnpm test:run lib/runtime/replyAttachments.test.ts lib/stdlib/thread.attachments.test.ts > /tmp/tra5-units.log 2>&1; grep "Tests " /tmp/tra5-units.log
make > /tmp/tra5-make.log 2>&1; echo "make=$?"
pnpm run agency test tests/agency/attach-to-reply.agency > /tmp/tra5-e2e.log 2>&1; grep "tests passed" /tmp/tra5-e2e.log
pnpm run test:agents > /tmp/tra5-agents.log 2>&1; grep -E "Test Files|Tests " /tmp/tra5-agents.log
```
Expected: all green. (Full `tests/agency` runs in CI.)

- [ ] **Step 4: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Add reply-attachments dev doc; mark spec implemented

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add docs/dev/reply-attachments.md CLAUDE.md docs/superpowers/specs/2026-07-02-tool-reply-attachments-design.md
git commit -F /tmp/commit-msg.txt
```

---

## Spec-coverage map (self-review)

- §1 `attachToReply` surface (safe def, drop-with-warning outside tools, path-source guidance) → Task 2
- §2 storage/concurrency (branch-local queue, harvest-at-join, runnerState round buffer, NOT global / NOT child-only) → Task 1 (mechanics) + Task 3 (wiring); fork isolation + parallel attribution pinned by execution tests
- §3 IDs + marker contract (harvest-time assignment, persistent with entries, marker + label shapes) → Task 1 (strings), Task 3 (both message sites); interrupt determinism handled by persisting ids WITH entries in serialized state rather than recomputing
- §4 gating (tri-state modality, 20 MB, per-call cap, inline-at-injection, path-preferred queue entries) → Task 1; URL sizes documented as unknowable pre-fetch (deviation from spec's blanket "checked before injection" — noted in module comment)
- §5 free-rider behaviors (redaction, placeholders, persistence) → asserted indirectly via `getThread` placeholder assertions in Task 3/4 tests
- §6 first consumer → Task 4
- Prerequisite (smoltalk consecutive-user merge) → owner's item, out of this plan; dev doc notes reliance on server-side same-role combining meanwhile
- Risks: 1 (grounding) → Grounding section with verified line references; 2 (queue-time size check) → implemented in `harvestReplyAttachments` (base64 length + fs.stat); 3 (Anthropic form) → dev doc; 4 (marker API) → Global Constraints + dev doc + pinned tests
- Known deviations from spec text (spec updated in Task 5 Step 2): skip markers don't name the model (pass-through keeps the check identical to smoltalk's send gate); per-call cap instead of per-round; `file not found` harvest gate added so the tool result never claims "attached" for a bad path.
- Resume-safety and model-shape claims are VERIFIED, not assumed: pr.step + PromptRunner.beforeCheckpoint messagesJSON snapshot (promptRunner.ts ~243) + fromJSON restore (prompt.ts ~775); smoltalk's send gate passes config.model unmodified to the same probe. Remaining implementer verification: per-call `llm(model:)` option syntax (grep in Task 3 Step 1).
- Fork e2e isolation is intentionally NOT an execution test: the deterministic client's mock queue is flat and module-keyed (ScopedLLMMocks cannot separate same-module branches), so any concurrent-consumption test is nondeterministic. The property is structural (one runnerState per runPrompt), pinned by the vitest unit plus the sequential execution test.
```
