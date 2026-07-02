# Agent Image Generation + Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the merged multimodal capability into the built-in agent: a `generateImageFile` tool that generates/edits images and saves them to disk, and auto-detection of image/PDF paths in user messages that inlines them as base64 attachments on the coordinator LLM turn.

**Architecture:** Two prerequisite stdlib changes (attachment-placeholder rendering in the thread reader/summarizer; a tri-state `std::llm.modelSupportsInput` bridge), then a pure detection helper module (`attachments.agency`), the image tool, and the `agentReplyVia`/`mainAgent` wiring. Attachments are inlined as base64 at attach time (never stored as paths in the persistent thread). Detection returns `DetectedAttachment[]` records (attachment + label together) — no index-coupled parallel arrays.

**Tech Stack:** Agency language (agent + stdlib), TypeScript stdlib bridges (`lib/stdlib/`), vitest for TS units, the Agency execution-test runner (`.agency` + `.test.json`) with the deterministic LLM/image provider for agent tests.

**Spec:** `docs/superpowers/specs/2026-07-02-agent-images-and-attachments-design.md` — read it first.
**Review applied:** `docs/superpowers/plans/2026-07-02-agent-images-and-attachments-review.md` (B1/B3, N1/N3, AP1–AP5/AP7, T-B1–T-B4, T-C1/C2/C4–C6/C8/C10–C12 addressed; B2/N2/T-F1/T-F3 rejected — each test node runs in its own subprocess via `executeNode`'s `execFileSync`, so no state leaks between nodes; AP6 rejected — see Task 5 Step 3 comment).

## Global Constraints

- All paths below are relative to `packages/agency-lang/` unless they start with `docs/superpowers`.
- Agency syntax: `def name(params): Type { ... }`, `if (cond) { ... }`, `let`/`const` before use, `for (x in items) { ... }`. NO Python-style blocks, NO bare assignment. Verify new `.agency` files parse with `pnpm run ast <file>` before running tests.
- Agency has `null`, never `undefined`. Tri-state values are `boolean | null`.
- `break` is NOT used anywhere in the Agency codebase — use `continue` with a guard instead. `continue`, ternary `cond ? a : b` (no nesting), `.includes()`, `.slice()`, `.split()`, `.startsWith()`, `.endsWith()`, `.toLowerCase()`, `.push()`, string interpolation `"${x}"`, and array spread `[a, ...b]` are all proven in existing code.
- Follow `docs/dev/anti-patterns.md`: braces on every `if` (no one-liners), descriptive variable names (no single-char), no order-dependent mutable flags, prefer `const`-derived conditions.
- `writeBinary`/`readBinary`/`write` REJECT an absolute filename whenever `dir` is set (which is always — `dir` defaults to `"."`). Always pass `(basename, dir)` pairs: `readBinary("x.png", "/tmp")`, never `readBinary("/tmp/x.png")`. `_writeBytes` does NOT create missing directories (verified) — a write into a nonexistent dir returns a Failure.
- Each Agency test node runs in its OWN subprocess (`executeNode` → `execFileSync("node", [evaluateFile])`), serially within a file. Nodes cannot leak `applyResolved`/`setEnv`/`setAgentCwd` state into each other. `/tmp` fixture files DO persist across runs — clean or overwrite them at the top of the node that uses them.
- Run `make` after ANY change to `stdlib/*.agency` or `lib/agents/**` before running Agency tests (the test runner uses `dist/`).
- Save every test run's output to a file (e.g. `> /tmp/t1.log 2>&1`) so failures can be inspected without rerunning. Never run the full `tests/agency` suite locally — CI does that.
- Agency execution tests need no LLM calls: the deterministic provider (`"useTestLLMProvider": true` in the `.test.json`) serves both `llm()` (via `llmMocks`) and `generateImage()` (fixed 1×1 PNG, $0.04 cost, `images:` argument ignored).
- Interrupts in tests are answered inline with `with approve` / `with reject` on the call.
- Commit messages contain apostrophes → always write the message to a file and use `git commit -F <file>`. End every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Work on a branch: before Task 1, run `git checkout -b agent-images-attachments`.
- The deterministic 1×1 PNG used throughout (89 bytes decoded, valid base64):
  `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC`

### Known coverage gaps (named, accepted)

1. `generateImageFile`'s generation-failure branch — the deterministic image client never fails; the write-failure test proves the "never report success on failure" contract instead.
2. `detectAttachments`' read-failure branch (`could not read` skip) — building a stat-succeeds/read-fails file portably needs `chmod 000` machinery; the branch is two lines.
3. The `📎 attached` / `📎 skipped` `pushMessage` lines — `std::ui` exposes no message-buffer reader (only `clearMessages`), so the "never silent" invariant has no assertion. Do not build capture machinery for it in this plan.
4. That `generateImageFile` actually CALLS `resolveEditInputs` (the composition seam) — the resolution logic itself is unit-tested (Task 4), but the deterministic client ignores `images:`, so wiring-level removal would only be caught by review.

---

### Task 1: Attachment placeholders in the thread reader/summarizer (`_contentToString`)

The summarizer transcript and the `getThread` reader currently `JSON.stringify` non-string message content (`lib/stdlib/threads.ts:40`), which would dump base64 attachment payloads into the summarize prompt. Render parts as placeholders instead. This is a prerequisite: Task 5's turn-integration test asserts on the `[image attachment]` placeholder.

**Files:**
- Modify: `lib/stdlib/threads.ts:40-44` (`_contentToString` — also export it)
- Test: `lib/stdlib/threads.test.ts` (append a new top-level `describe`, matching the existing top-level `describe("_eagerSummarizeIfNeeded", ...)` at line 41)

**Interfaces:**
- Produces: `export function _contentToString(content: smoltalk.MessageJSON["content"]): string` — text parts pass through, image parts → `"[image attachment]"`, file parts → `"[file attachment: <filename>]"` (or `"[file attachment]"` with no filename), parts joined with a single space. Task 5's test relies on the exact string `[image attachment]` appearing in `getThread` content.

- [ ] **Step 1: Write the failing test**

Append to `lib/stdlib/threads.test.ts` (add `_contentToString` to its import from `./threads.js`):

```ts
describe("_contentToString", () => {
  it("passes plain strings through", () => {
    expect(_contentToString("hello")).toBe("hello");
  });

  it("renders text parts and attachment placeholders", () => {
    const content = [
      { type: "text", text: "look at this" },
      { type: "image", source: { kind: "base64", base64: "AAAA", mimeType: "image/png" } },
      { type: "file", filename: "report.pdf", source: { kind: "base64", base64: "BBBB", mimeType: "application/pdf" } },
    ];
    expect(_contentToString(content as any)).toBe(
      "look at this [image attachment] [file attachment: report.pdf]",
    );
  });

  it("never leaks base64 payloads into the transcript", () => {
    const content = [
      { type: "image", source: { kind: "base64", base64: "SECRETPAYLOAD", mimeType: "image/png" } },
    ];
    expect(_contentToString(content as any)).not.toContain("SECRETPAYLOAD");
  });

  it("handles null content and empty part arrays", () => {
    expect(_contentToString(null as any)).toBe("");
    expect(_contentToString([] as any)).toBe("");
  });

  it("renders a file part without filename generically", () => {
    const content = [{ type: "file", source: { kind: "base64", base64: "CCCC", mimeType: "application/pdf" } }];
    expect(_contentToString(content as any)).toBe("[file attachment]");
  });

  it("renders a text part with a missing text field as empty", () => {
    expect(_contentToString([{ type: "text" }] as any)).toBe("");
  });

  it("falls back to JSON for unknown part types", () => {
    expect(_contentToString([{ type: "mystery", x: 1 }] as any)).toBe('{"type":"mystery","x":1}');
  });

  it("keeps JSON fallback for unknown non-string content", () => {
    expect(_contentToString({ weird: true } as any)).toBe('{"weird":true}');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/stdlib/threads.test.ts > /tmp/task1-fail.log 2>&1; tail -30 /tmp/task1-fail.log`
Expected: FAIL — `_contentToString` is not exported (import error), or once exported, the placeholder assertions fail against the `JSON.stringify` behavior.

- [ ] **Step 3: Implement placeholder rendering**

Replace `_contentToString` in `lib/stdlib/threads.ts` (keep the doc comment above it, extend it with one line about attachment placeholders) and add `export`. Braces on every branch per `docs/dev/anti-patterns.md` "One-line if statements":

```ts
export function _contentToString(content: smoltalk.MessageJSON["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (content == null) {
    return "";
  }
  if (Array.isArray(content)) {
    const rendered = content.map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        const typedPart = part as { type?: string; text?: unknown; filename?: string };
        if (typedPart.type === "text") {
          return String(typedPart.text ?? "");
        }
        if (typedPart.type === "image") {
          return "[image attachment]";
        }
        if (typedPart.type === "file") {
          return typedPart.filename ? `[file attachment: ${typedPart.filename}]` : "[file attachment]";
        }
      }
      return JSON.stringify(part);
    });
    return rendered.join(" ");
  }
  return JSON.stringify(content);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/stdlib/threads.test.ts > /tmp/task1-pass.log 2>&1; tail -10 /tmp/task1-pass.log`
Expected: PASS (all pre-existing `_eagerSummarizeIfNeeded` tests in the file must also still pass).

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Render attachment parts as placeholders in thread transcripts

_contentToString backs both the summarizer transcript and the getThread
reader; it used to JSON.stringify multimodal content, which would dump
base64 attachment payloads into the summarize prompt. Attachment parts
now render as "[image attachment]" / "[file attachment: name]".

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add lib/stdlib/threads.ts lib/stdlib/threads.test.ts
git commit -F /tmp/commit-msg.txt
```

---

### Task 2: `std::llm.modelSupportsInput` tri-state modality probe

Expose smoltalk's `modelSupportsInputModality` so the agent can check ahead of send whether the resolved model accepts image/PDF input. It is the exact predicate smoltalk's send-time gate uses.

**Files:**
- Modify: `lib/stdlib/llm.ts` (add `modelSupportsInputModality` to the existing `from "smoltalk"` import at the top; add `_modelSupportsInput`)
- Modify: `stdlib/llm.agency` (add `_modelSupportsInput` to the existing `from "agency-lang/stdlib-lib/llm.js"` import block at line 1; add the `modelSupportsInput` def)
- Test: `lib/stdlib/llm.test.ts` (append a `describe`)

**Interfaces:**
- Produces (TS): `export function _modelSupportsInput(model: string, modality: string): boolean | null`
- Produces (Agency): `export safe def modelSupportsInput(model: string, modality: string): boolean | null` in `std::llm` — `true`/`false` from the catalog, `null` = unknown ("don't gate"). Task 5's `modalityFilter` consumes this with BOTH `"image"` and `"pdf"`.

- [ ] **Step 1: Verify the catalog fixtures the tests depend on**

CAUTION: iterating `getAllModels()` and calling `modelSupportsInputModality(m.name, ...)` returns `undefined` for every entry (name-form mismatch) — do NOT probe that way. Probe direct names (run from `packages/agency-lang`):

```bash
node --input-type=module -e "
const s = await import('smoltalk');
for (const name of ['gpt-4o', 'gpt-3.5-turbo', 'claude-opus-4-8']) {
  console.log(name, 'image:', s.modelSupportsInputModality(name, 'image'), 'pdf:', s.modelSupportsInputModality(name, 'pdf'));
}"
```

Expected (verified 2026-07-02): `gpt-4o` → image `true`, pdf `true`; `gpt-3.5-turbo` → image `false`, pdf `false`. If the catalog has drifted, substitute models with the same true/false shape **everywhere this plan uses `gpt-4o` / `gpt-3.5-turbo` in modality tests** (Task 2 and Task 5).

- [ ] **Step 2: Write the failing test**

Append to `lib/stdlib/llm.test.ts` (add `_modelSupportsInput` to its import from `./llm.js`):

```ts
describe("_modelSupportsInput", () => {
  it("returns true for a vision model", () => {
    expect(_modelSupportsInput("gpt-4o", "image")).toBe(true);
  });

  it("returns false for a text-only model", () => {
    expect(_modelSupportsInput("gpt-3.5-turbo", "image")).toBe(false);
  });

  it("returns true for a pdf-capable model", () => {
    expect(_modelSupportsInput("gpt-4o", "pdf")).toBe(true);
  });

  it("returns false for a model without pdf input", () => {
    expect(_modelSupportsInput("gpt-3.5-turbo", "pdf")).toBe(false);
  });

  it("returns null for an unknown model", () => {
    expect(_modelSupportsInput("no-such-model-xyz", "image")).toBe(null);
  });

  it("returns null for an unsupported modality string", () => {
    expect(_modelSupportsInput("gpt-4o", "audio")).toBe(null);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:run lib/stdlib/llm.test.ts > /tmp/task2-fail.log 2>&1; tail -20 /tmp/task2-fail.log`
Expected: FAIL — `_modelSupportsInput` is not exported.

- [ ] **Step 4: Implement the TS bridge**

In `lib/stdlib/llm.ts`, add `modelSupportsInputModality` to the existing smoltalk import list, then add near `_hostedModelInfo`:

```ts
/** Tri-state modality probe backing `std::llm.modelSupportsInput`. Returns
 *  null (not undefined — Agency has no undefined) when the model is unknown
 *  or carries no modality data; that matches smoltalk's send-time gate,
 *  which only blocks on an explicit false. */
export function _modelSupportsInput(model: string, modality: string): boolean | null {
  if (modality !== "image" && modality !== "pdf") {
    return null;
  }
  return modelSupportsInputModality(model, modality) ?? null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test:run lib/stdlib/llm.test.ts > /tmp/task2-pass.log 2>&1; tail -10 /tmp/task2-pass.log`
Expected: PASS.

- [ ] **Step 6: Add the Agency-level def**

In `stdlib/llm.agency`: add `_modelSupportsInput,` to the import block from `"agency-lang/stdlib-lib/llm.js"` (lines 1–7). Then add after the `hostedModelInfo` def:

```
export safe def modelSupportsInput(model: string, modality: string): boolean | null {
  """
  Whether a model accepts a given input modality ("image" or "pdf").
  Tri-state: true / false when the model catalog says so, null when the
  model or its modality data is unknown. Treat null as "do not gate" —
  that is the same rule llm() applies at send time.

  @param model - The model name (e.g. "gpt-4o-mini")
  @param modality - "image" or "pdf"
  """
  return _modelSupportsInput(model, modality)
}
```

- [ ] **Step 7: Build and smoke-test the Agency surface**

```bash
make > /tmp/task2-make.log 2>&1; tail -5 /tmp/task2-make.log
```
Expected: build succeeds. (`make` is REQUIRED after stdlib changes.)

`.agency` files cannot run from `/tmp` (missing node_modules) — smoke-test from the repo instead. Create a throwaway file `smoke-modality.agency` in the repo root of `packages/agency-lang`:

```
import { modelSupportsInput } from "std::llm"

node main() {
  print("${modelSupportsInput("gpt-4o", "image")}|${modelSupportsInput("nope-xyz", "image")}")
}
```

Run: `pnpm run agency smoke-modality.agency > /tmp/task2-smoke.log 2>&1; cat /tmp/task2-smoke.log`
Expected output contains: `true|null`
Then delete the file: `rm smoke-modality.agency`

- [ ] **Step 8: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Add std::llm.modelSupportsInput tri-state modality probe

Exposes smoltalk modelSupportsInputModality — the exact predicate the
send-time modality gate uses — so callers can check ahead of a call
whether a model accepts image/pdf input. null = unknown = do not gate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add lib/stdlib/llm.ts lib/stdlib/llm.test.ts stdlib/llm.agency
git commit -F /tmp/commit-msg.txt
```

---

### Task 3: `detectAttachments` helper module

A pure, unit-testable helper that scans a user message for image/PDF paths (drag-dropped or typed), and returns inline-base64 attachments with display labels. Spec section "Part B — Attachment detection" defines the algorithm; follow it exactly. Structure per the anti-patterns doc: candidate extraction (pure) is separated from the I/O stage (stat/read), and attachments carry their labels in one record — no index-coupled parallel arrays.

**Files:**
- Create: `lib/agents/agency-agent/lib/attachments.agency`
- Test: `lib/agents/agency-agent/tests/attachments.agency`
- Test: `lib/agents/agency-agent/tests/attachments.test.json`

**Interfaces:**
- Consumes: `stat` (`std::shell`), `env`/`setEnv` (`std::system`), `basename`/`dirname`/`extname`/`isAbsolute` (`std::path`), `Attachment`/`image`/`file` (`std::thread`), auto-imported `readBinary`/`applyAgentCwd`.
- Produces:
  - `export type DetectedAttachment = { attachment: Attachment, label: string }`
  - `export type SkippedFile = { label: string, reason: string }`
  - `export type DetectedContent = { text: string, attached: DetectedAttachment[], skipped: SkippedFile[] }`
  - `export def detectAttachments(msg: string, maxBytes: number = 20971520): DetectedContent` — raises `std::readBinary` interrupts (one per attached file); callers must have a read-approving handler or use `with approve`.
  - Task 5 adds `modalityFilter` to this same file.

- [ ] **Step 1: Write the module**

Create `lib/agents/agency-agent/lib/attachments.agency`:

```
import { stat } from "std::shell"
import { env } from "std::system"
import { basename, extname, dirname, isAbsolute } from "std::path"
import { Attachment, image, file } from "std::thread"

// Detects image/PDF file paths in a user message (terminal drag-drop
// inserts a quoted/escaped path; typed mentions are plain tokens) and
// returns them as inline-base64 attachments for the coordinator turn.
// Media-only by design: code/text paths stay with the read tool.

export type DetectedAttachment = { attachment: Attachment, label: string }
export type SkippedFile = { label: string, reason: string }

export type DetectedContent = {
  text: string,
  attached: DetectedAttachment[],
  skipped: SkippedFile[]
}

// A token that survived the pure (no-I/O) gates: normalized, media
// extension, resolved to an absolute path.
type Candidate = { abs: string, mime: string }

// extension (lowercase, with dot) -> MIME type. Media-only by design.
static const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf"
}

static const MAX_ATTACHMENTS = 10

// Split msg into candidate tokens. Shell-quoted spans ('…' / "…")
// become single tokens (drag-drop quotes paths with spaces), and a
// backslash-escaped space is unescaped into the current token.
// Hand-written scanner — order-dependent state is fine here (parsers
// are exempt per docs/dev/anti-patterns.md).
def tokenize(msg: string): string[] {
  let tokens: string[] = []
  let current = ""
  let quote = ""
  let index = 0
  while (index < msg.length) {
    const ch = msg.slice(index, index + 1)
    if (quote != "") {
      if (ch == quote) {
        quote = ""
      } else {
        current = current + ch
      }
    } else if (ch == "'" || ch == "\"") {
      quote = ch
    } else if (ch == "\\" && index + 1 < msg.length && msg.slice(index + 1, index + 2) == " ") {
      current = current + " "
      index = index + 1
    } else if (ch == " " || ch == "\t" || ch == "\n") {
      if (current != "") {
        tokens.push(current)
        current = ""
      }
    } else {
      current = current + ch
    }
    index = index + 1
  }
  if (current != "") {
    tokens.push(current)
  }
  return tokens
}

// Trim trailing punctuation typed after a path, and expand a leading ~/
// (drag-drop inserts absolute paths, but typed mentions are often ~/…).
def normalizeToken(token: string): string {
  let normalized = token
  while (normalized.length > 0 && (normalized.endsWith(",") || normalized.endsWith(".") || normalized.endsWith("?") || normalized.endsWith(":"))) {
    normalized = normalized.slice(0, normalized.length - 1)
  }
  if (normalized.startsWith("~/")) {
    const home = env("HOME")
    if (home != null && home != "") {
      normalized = home + normalized.slice(1)
    }
  }
  return normalized
}

// Pure stage (spec steps 2-3 + extension gate): normalize, keep only
// media extensions, resolve to an absolute path. Returns null for
// tokens that are not candidate media paths. No filesystem access.
def tokenToCandidate(token: string): Candidate | null {
  const normalized = normalizeToken(token)
  const ext = extname(normalized).toLowerCase()
  const mime = MIME_TYPES[ext]
  if (mime == null) {
    return null
  }
  if (isAbsolute(normalized)) {
    return { abs: normalized, mime: mime }
  }
  return { abs: applyAgentCwd(normalized), mime: mime }
}

export def detectAttachments(msg: string, maxBytes: number = 20971520): DetectedContent {
  """
  Scan a user message for image/PDF file paths and return them as
  inline-base64 attachments with display labels. Non-existent paths,
  directories, non-media extensions, unreadable files, and files over
  maxBytes (default 20971520 = smoltalk's 20 MB per-file cap) are not
  attached; size/read skips are reported in `skipped`. Caps at 10
  attachments per message.
  """
  let attached: DetectedAttachment[] = []
  let skipped: SkippedFile[] = []
  let seen: string[] = []
  for (token in tokenize(msg)) {
    if (attached.length >= MAX_ATTACHMENTS) {
      continue
    }
    const candidate = tokenToCandidate(token)
    if (candidate == null) {
      continue
    }
    if (seen.includes(candidate.abs)) {
      continue
    }
    seen.push(candidate.abs)
    const info = stat(candidate.abs)
    if (info.type != "file") {
      continue
    }
    const label = basename(candidate.abs)
    if (info.size > maxBytes) {
      skipped.push({ label: label, reason: "too large to attach" })
      continue
    }
    // readBinary rejects an absolute filename when dir is set, so pass
    // the (basename, dirname) split. Inlining the bytes here (instead of
    // letting smoltalk read the path at every send) keeps the persistent
    // thread immune to later file deletion/edits and keeps the read
    // inside the std::readBinary policy gate.
    const bytes = readBinary(label, dirname(candidate.abs))
    if (isFailure(bytes)) {
      skipped.push({ label: label, reason: "could not read" })
      continue
    }
    if (candidate.mime == "application/pdf") {
      attached.push({ attachment: file(bytes.value, filename: label, mimeType: candidate.mime, base64: true), label: label })
    } else {
      attached.push({ attachment: image(bytes.value, candidate.mime, base64: true), label: label })
    }
  }
  return { text: msg, attached: attached, skipped: skipped }
}
```

- [ ] **Step 2: Verify it parses**

Run: `pnpm run ast lib/agents/agency-agent/lib/attachments.agency > /tmp/task3-ast.log 2>&1; echo "exit=$?"`
Expected: `exit=0`. If it fails, debug with `DEBUG=1 pnpm run ast lib/agents/agency-agent/lib/attachments.agency > /tmp/task3-ast-debug.log 2>&1` and inspect the log. Likely culprit: the `"\\"` / `"\""` escapes (backslash codegen was fixed in PR #315 and should work) — if an escape form fails to parse, check how `stdlib/skills.agency` writes escaped literals and mirror it.

- [ ] **Step 3: Write the failing tests**

Create `lib/agents/agency-agent/tests/attachments.agency`. Reminder: every node is its own subprocess — no state leaks between nodes, so no env/slot restore is needed; but `/tmp` files persist across RUNS, so nodes (re)create their own fixtures.

```
import { detectAttachments } from "../lib/attachments.agency"
import { setAgentCwd } from "std::index"
import { exec } from "std::shell"
import { setEnv } from "std::system"

// 1x1 PNG, 89 bytes decoded. Content is irrelevant to detection (the
// gate is extension + stat), but a real PNG keeps fixtures honest.
static const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

node detectsPngPath(): string {
  writeBinary("da-a.png", PNG, "/tmp") with approve
  const detected = detectAttachments("look at /tmp/da-a.png please") with approve
  if (detected.attached.length != 1) {
    return "count=${detected.attached.length}"
  }
  const item = detected.attached[0]
  return "1|${item.label}|${item.attachment.type}|${item.attachment.source.kind}"
}

node detectsPdfPath(): string {
  writeBinary("da-doc.pdf", "JVBERi0xLjQK", "/tmp") with approve
  const detected = detectAttachments("summarize /tmp/da-doc.pdf") with approve
  if (detected.attached.length != 1) {
    return "count=${detected.attached.length}"
  }
  return "1|${detected.attached[0].label}|${detected.attached[0].attachment.type}"
}

node quotedPathWithSpaces(): string {
  writeBinary("da b.png", PNG, "/tmp") with approve
  const detected = detectAttachments("see '/tmp/da b.png' now") with approve
  return "${detected.attached.length}|${detected.attached[0].label}"
}

node doubleQuotedPath(): string {
  writeBinary("da b.png", PNG, "/tmp") with approve
  const detected = detectAttachments("see \"/tmp/da b.png\" now") with approve
  return "${detected.attached.length}|${detected.attached[0].label}"
}

node escapedSpacePath(): string {
  writeBinary("da b.png", PNG, "/tmp") with approve
  const detected = detectAttachments("see /tmp/da\\ b.png now") with approve
  return "${detected.attached.length}|${detected.attached[0].label}"
}

node tildeExpansion(): string {
  writeBinary("da-tilde.png", PNG, "/tmp") with approve
  setEnv("HOME", "/tmp")
  const detected = detectAttachments("see ~/da-tilde.png") with approve
  return "${detected.attached.length}"
}

node trailingPunctuation(): string {
  writeBinary("da-p.png", PNG, "/tmp") with approve
  const detected = detectAttachments("is it /tmp/da-p.png?") with approve
  return "${detected.attached.length}"
}

node nonexistentIgnored(): string {
  const detected = detectAttachments("see /tmp/da-not-there-xyz.png") with approve
  return "${detected.attached.length}"
}

node codePathIgnored(): string {
  writeBinary("da-code.ts", "AQID", "/tmp") with approve
  const detected = detectAttachments("read /tmp/da-code.ts") with approve
  return "${detected.attached.length}"
}

node directoryIgnored(): string {
  exec("rm", ["-rf", "/tmp/da-dir.png"]) with approve
  exec("mkdir", ["-p", "/tmp/da-dir.png"]) with approve
  const detected = detectAttachments("see /tmp/da-dir.png") with approve
  return "${detected.attached.length}"
}

node overLimitSkipped(): string {
  writeBinary("da-big.png", PNG, "/tmp") with approve
  const detected = detectAttachments("see /tmp/da-big.png", maxBytes: 4) with approve
  return "${detected.attached.length}|${detected.skipped[0].label}|${detected.skipped[0].reason}"
}

node dedupes(): string {
  writeBinary("da-dup.png", PNG, "/tmp") with approve
  const detected = detectAttachments("/tmp/da-dup.png and again /tmp/da-dup.png") with approve
  return "${detected.attached.length}"
}

node capsAtTen(): number {
  let msg = "look at"
  for (i in range(11)) {
    writeBinary("da-cap-${i}.png", PNG, "/tmp") with approve
    msg = msg + " /tmp/da-cap-${i}.png"
  }
  const detected = detectAttachments(msg) with approve
  return detected.attached.length
}

node allImageExtensions(): number {
  writeBinary("da-e1.jpg", PNG, "/tmp") with approve
  writeBinary("da-e2.jpeg", PNG, "/tmp") with approve
  writeBinary("da-e3.gif", PNG, "/tmp") with approve
  writeBinary("da-e4.webp", PNG, "/tmp") with approve
  writeBinary("da-e5.PNG", PNG, "/tmp") with approve
  const detected = detectAttachments("/tmp/da-e1.jpg /tmp/da-e2.jpeg /tmp/da-e3.gif /tmp/da-e4.webp /tmp/da-e5.PNG") with approve
  return detected.attached.length
}

node mixedTypesPreserveOrder(): string {
  writeBinary("da-m1.png", PNG, "/tmp") with approve
  writeBinary("da-m2.pdf", "JVBERi0xLjQK", "/tmp") with approve
  const detected = detectAttachments("see /tmp/da-m1.png then /tmp/da-m2.pdf") with approve
  if (detected.attached.length != 2) {
    return "count=${detected.attached.length}"
  }
  return "2|${detected.attached[0].label}|${detected.attached[0].attachment.type}|${detected.attached[1].label}|${detected.attached[1].attachment.type}"
}

node relativeResolvesAgainstAgentCwd(): string {
  writeBinary("da-rel.png", PNG, "/tmp") with approve
  setAgentCwd("/tmp")
  const detected = detectAttachments("see da-rel.png") with approve
  return "${detected.attached.length}|${detected.attached[0].label}"
}

node bareTextNoAttachments(): string {
  const detected = detectAttachments("please draw me a diagram") with approve
  return "${detected.attached.length}|${detected.text}"
}

node emptyMessage(): string {
  const detected = detectAttachments("") with approve
  return "${detected.attached.length}|${detected.skipped.length}|${detected.text}"
}
```

Create `lib/agents/agency-agent/tests/attachments.test.json`:

```json
{
  "tests": [
    { "nodeName": "detectsPngPath", "input": "", "expectedOutput": "\"1|da-a.png|image|base64\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "detectsPdfPath", "input": "", "expectedOutput": "\"1|da-doc.pdf|file\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "quotedPathWithSpaces", "input": "", "expectedOutput": "\"1|da b.png\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "doubleQuotedPath", "input": "", "expectedOutput": "\"1|da b.png\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "escapedSpacePath", "input": "", "expectedOutput": "\"1|da b.png\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "tildeExpansion", "input": "", "expectedOutput": "\"1\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "trailingPunctuation", "input": "", "expectedOutput": "\"1\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "nonexistentIgnored", "input": "", "expectedOutput": "\"0\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "codePathIgnored", "input": "", "expectedOutput": "\"0\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "directoryIgnored", "input": "", "expectedOutput": "\"0\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "overLimitSkipped", "input": "", "expectedOutput": "\"0|da-big.png|too large to attach\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "dedupes", "input": "", "expectedOutput": "\"1\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "capsAtTen", "input": "", "expectedOutput": "10", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "allImageExtensions", "input": "", "expectedOutput": "5", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "mixedTypesPreserveOrder", "input": "", "expectedOutput": "\"2|da-m1.png|image|da-m2.pdf|file\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "relativeResolvesAgainstAgentCwd", "input": "", "expectedOutput": "\"1|da-rel.png\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "bareTextNoAttachments", "input": "", "expectedOutput": "\"0|please draw me a diagram\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "emptyMessage", "input": "", "expectedOutput": "\"0|0|\"", "evaluationCriteria": [{ "type": "exact" }] }
  ]
}
```

- [ ] **Step 4: Build and run the tests**

```bash
make > /tmp/task3-make.log 2>&1; tail -3 /tmp/task3-make.log
pnpm run agency test lib/agents/agency-agent/tests/attachments.agency > /tmp/task3-test.log 2>&1; tail -30 /tmp/task3-test.log
```
Expected: all 18 tests pass. If a node fails, read `/tmp/task3-test.log` — do NOT rerun blindly. Common failure: `expectedOutput` quoting (string returns are JSON-encoded — `"\"1\""` not `"1"`; number returns are bare — `"10"`).

- [ ] **Step 5: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Add detectAttachments helper for the built-in agent

Scans a user message for image/PDF paths (drag-drop quoting, escaped
spaces, tilde, trailing punctuation), resolves them against the agent
cwd, and inlines the bytes as base64 attachments carried in
DetectedAttachment records (attachment + label together). Media-only,
deduped, capped at 10; over-limit files are skipped with a visible
reason so an oversized mention can never fail the turn at the smoltalk
gate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add lib/agents/agency-agent/lib/attachments.agency lib/agents/agency-agent/tests/attachments.agency lib/agents/agency-agent/tests/attachments.test.json
git commit -F /tmp/commit-msg.txt
```

---

### Task 4: `generateImageFile` agent tool

The coordinator gets a direct tool to generate (or edit — non-empty `images`) an image and save it to disk, returning the path. Never returns base64 to the LLM.

**Files:**
- Modify: `lib/agents/agency-agent/agent.agency` — imports (top of file), new defs placed immediately ABOVE `static const mainAgentTools` (~line 802), the tools list, and `mainAgentSystemPrompt` (~line 638)
- Test: `lib/agents/agency-agent/tests/imageTool.agency`
- Test: `lib/agents/agency-agent/tests/imageTool.test.json`

**Interfaces:**
- Consumes: `generateImage` (`std::image`, returns `Result` of `{ base64, mimeType }`), auto-imported `writeBinary`/`applyAgentCwd`, `map` (`std::array`), `basename`/`dirname`/`isAbsolute` (`std::path`), `getCost` (`std::thread`, already imported).
- Produces: `export def resolveEditInputs(images: string[]): string[]` and `export def generateImageFile(prompt: string, path: string, size: string = "", images: string[] = []): string` — the latter registered in `mainAgentTools`. Its docstring is the LLM-facing tool description.

- [ ] **Step 1: Write the failing tests**

Create `lib/agents/agency-agent/tests/imageTool.agency`:

```
import { generateImageFile, resolveEditInputs } from "../agent.agency"
import { setAgentCwd } from "std::index"
import { cwd } from "std::system"
import { getCost } from "std::thread"

node savesToAgentCwd(): string {
  setAgentCwd("/tmp")
  const msg = generateImageFile("a red bicycle", "it-gencwd.png") with approve
  const inAgentCwd = readBinary("it-gencwd.png", "/tmp") with approve
  const inProcessCwd = readBinary("it-gencwd.png", cwd()) with approve
  return "${msg}|${isSuccess(inAgentCwd)}|${isFailure(inProcessCwd)}"
}

node savesToAbsolutePath(): string {
  const msg = generateImageFile("a red bicycle", "/tmp/it-abs.png") with approve
  const back = readBinary("it-abs.png", "/tmp") with approve
  return "${msg}|${isSuccess(back)}"
}

node reportsWriteFailure(): boolean {
  const msg = generateImageFile("x", "/nonexistent-dir-e51b/x.png") with approve
  return msg.startsWith("Generated the image, but saving to /nonexistent-dir-e51b/x.png failed")
}

node editInputsResolveAgainstAgentCwd(): string {
  setAgentCwd("/tmp")
  const resolved = resolveEditInputs(["a.png", "/abs/b.png"])
  return "${resolved[0]}|${resolved[1]}"
}

node editInputsPassThrough(): string {
  setAgentCwd("/tmp")
  generateImageFile("seed", "it-seed.png") with approve
  return generateImageFile("restyle it", "it-edit.png", images: ["it-seed.png"]) with approve
}

node costRecordedForGeneration(): string {
  setAgentCwd("/tmp")
  const before = getCost()
  generateImageFile("a red bicycle", "it-cost.png") with approve
  const after = getCost()
  return "${(after - before).toFixed(2)}"
}
```

Create `lib/agents/agency-agent/tests/imageTool.test.json`:

```json
{
  "tests": [
    { "nodeName": "savesToAgentCwd", "input": "", "expectedOutput": "\"Saved image to it-gencwd.png|true|true\"", "evaluationCriteria": [{ "type": "exact" }], "useTestLLMProvider": true },
    { "nodeName": "savesToAbsolutePath", "input": "", "expectedOutput": "\"Saved image to /tmp/it-abs.png|true\"", "evaluationCriteria": [{ "type": "exact" }], "useTestLLMProvider": true },
    { "nodeName": "reportsWriteFailure", "input": "", "expectedOutput": "true", "evaluationCriteria": [{ "type": "exact" }], "useTestLLMProvider": true },
    { "nodeName": "editInputsResolveAgainstAgentCwd", "input": "", "expectedOutput": "\"/tmp/a.png|/abs/b.png\"", "evaluationCriteria": [{ "type": "exact" }], "useTestLLMProvider": true },
    { "nodeName": "editInputsPassThrough", "input": "", "expectedOutput": "\"Saved image to it-edit.png\"", "evaluationCriteria": [{ "type": "exact" }], "useTestLLMProvider": true },
    { "nodeName": "costRecordedForGeneration", "input": "", "expectedOutput": "\"0.04\"", "evaluationCriteria": [{ "type": "exact" }], "useTestLLMProvider": true }
  ]
}
```

Test-design notes:
- `savesToAgentCwd` asserts BOTH that the file landed under the agent cwd AND that it did NOT land under the process cwd — distinguishing agent-cwd from process-cwd resolution.
- `editInputsResolveAgainstAgentCwd` unit-tests the edit-input resolution invariant directly, because the deterministic image client ignores its `images:` argument (`editInputsPassThrough` only proves plumb-through doesn't crash — see Known coverage gaps #4).
- `costRecordedForGeneration` pins the deterministic client's fixed $0.04 per generation flowing into `getCost()` (the spec's cost/`guard(cost:)` claim).
- The generation-failure branch is not exercisable — Known coverage gaps #1.

- [ ] **Step 2: Run to verify failure**

```bash
make > /tmp/task4-make.log 2>&1; tail -3 /tmp/task4-make.log
pnpm run agency test lib/agents/agency-agent/tests/imageTool.agency > /tmp/task4-fail.log 2>&1; tail -10 /tmp/task4-fail.log
```
Expected: FAIL — `generateImageFile` is not exported from `../agent.agency`.

- [ ] **Step 3: Implement the tool**

In `lib/agents/agency-agent/agent.agency`:

(a) Add imports near the other stdlib imports (keep the existing grouping style):

```
import { map } from "std::array"
import { generateImage } from "std::image"
import { basename, dirname, isAbsolute } from "std::path"
```

(b) Immediately ABOVE `static const mainAgentTools` add:

```
// Exported for tests: agent-cwd resolution of edit inputs is a spec
// invariant with no other observable (the deterministic image client
// ignores its images argument).
export def resolveEditInputs(images: string[]): string[] {
  return map(images) as inputPath {
    return applyAgentCwd(inputPath)
  }
}

// Direct image generation for the coordinator. Saves to disk and
// returns the path — never base64, which would flood the LLM context.
// The write rides the std::writeBinary interrupt gate (writes are not
// auto-approved by policy) and generation cost accrues to the agent's
// cost tracking like any llm() call.
export def generateImageFile(
  prompt: string,
  path: string,
  size: string = "",
  images: string[] = [],
): string {
  """
  Generate an image from a text prompt and save it to `path`. To MODIFY
  existing images (edit / variation), pass their paths in `images`.
  Returns the saved path on success. Use this when the user asks to
  create, draw, edit, or restyle an image.

  @param prompt - What to generate, or how to modify the input images.
  @param path - Where to save the resulting image (e.g. "diagram.png").
  @param size - Optional size like "1024x1024".
  @param images - Optional input image paths to edit / vary.
  """
  // LLM-supplied paths resolve against the agent cwd, like every other
  // agent file tool.
  const inputs = resolveEditInputs(images)
  const generated = generateImage(prompt, size: size, images: inputs)
  if (isFailure(generated)) {
    return "Image generation failed: ${generated.error}"
  }
  // writeBinary rejects an absolute filename when dir is set, so split
  // path into (dir, name) and resolve the dir against the agent cwd.
  let dir = dirname(path)
  if (!isAbsolute(dir)) {
    dir = applyAgentCwd(dir)
  }
  const written = writeBinary(basename(path), generated.value.base64, dir)
  if (isFailure(written)) {
    return "Generated the image, but saving to ${path} failed: ${written.error}"
  }
  return "Saved image to ${path}"
}
```

(c) Register it — `mainAgentTools` becomes:

```
static const mainAgentTools = [
  researchAgent.partial(allowHandoff: false),
  codeAgent.partial(allowHandoff: false),
  reviewAgent.partial(allowHandoff: false),
  oracleAgent.partial(allowHandoff: false),
  explorerAgent.partial(allowHandoff: false),
  generateImageFile,
]
```

(d) In `mainAgentSystemPrompt`, after the `explorerAgent` bullet, add:

```
- `generateImageFile(prompt, path, size, images)` — generate an image
  from a text prompt (or modify existing images by passing their paths
  in `images`) and save it to `path`. Call it directly whenever the
  user asks you to create, draw, edit, or restyle an image — do NOT
  route image generation to `codeAgent`.
```

Also update the sentence `You have five subagent tools, each running in its own isolated context:` to `You have five subagent tools (each running in its own isolated context) and one direct tool:`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
make > /tmp/task4-make2.log 2>&1; tail -3 /tmp/task4-make2.log
pnpm run agency test lib/agents/agency-agent/tests/imageTool.agency > /tmp/task4-pass.log 2>&1; tail -12 /tmp/task4-pass.log
```
Expected: 6/6 pass.

- [ ] **Step 5: Regression — existing agent turn tests still pass**

Run: `pnpm run agency test lib/agents/agency-agent/tests/agentTurn.agency > /tmp/task4-regress.log 2>&1; tail -10 /tmp/task4-regress.log`
Expected: all pass (the tools-list change must not break the seed turn).

- [ ] **Step 6: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Add generateImageFile tool to the agent coordinator

Generates (or, with input images, edits) an image via std::image and
saves it to disk through the writeBinary interrupt gate, resolving
paths against the agent cwd. Returns the saved path to the LLM, and a
failure message when generation or the write fails — never a false
success. Registered in mainAgentTools with a system-prompt bullet so
the coordinator does not route image requests to codeAgent.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add lib/agents/agency-agent/agent.agency lib/agents/agency-agent/tests/imageTool.agency lib/agents/agency-agent/tests/imageTool.test.json
git commit -F /tmp/commit-msg.txt
```

---

### Task 5: Wire attachments into the coordinator turn

`agentReplyVia` detects attachments (modality-filtered), prints visible `📎` lines, and passes a multimodal array to a widened `mainAgent`. Subagent routes stay text-only (spec decision 3) — and now have a regression test.

**Files:**
- Modify: `lib/agents/agency-agent/lib/attachments.agency` (add `modalityFilter`)
- Modify: `lib/agents/agency-agent/agent.agency` (imports; `mainAgent` ~line 810; `agentReplyVia` ~line 833)
- Test: `lib/agents/agency-agent/tests/attachmentsTurn.agency`
- Test: `lib/agents/agency-agent/tests/attachmentsTurn.test.json`
- Test (extend): `lib/agents/agency-agent/tests/attachments.agency` + `.test.json` (modalityFilter units)

**Interfaces:**
- Consumes: `detectAttachments`/`DetectedContent`/`DetectedAttachment`/`SkippedFile` (Task 3), `modelSupportsInput` (`std::llm`, Task 2), `getResolvedSlots`/`applyResolved` (`../shared.agency`, existing), `_contentToString` placeholders (Task 1, asserted via `getThread`).
- Produces: `export def modalityFilter(detected: DetectedContent): DetectedContent` in `attachments.agency`; `mainAgent` widened to `prompt: string | (string | Attachment)[]`.

- [ ] **Step 1: Add `modalityFilter` to `attachments.agency`**

Add imports at the top of `lib/agents/agency-agent/lib/attachments.agency`:

```
import { modelSupportsInput } from "std::llm"
import { getResolvedSlots } from "../shared.agency"
```

Append the def. Note the `const drop` derivation (no mutable `ok` flag — anti-patterns "Order-dependent mutable state") and the spread copy of `skipped` (never mutate the caller's array):

```
// Drop attachments the resolved main model explicitly cannot accept.
// Tri-state on purpose: only a catalog `false` drops a part. Unknown
// models (null) attach optimistically — smoltalk's send-time gate does
// not fire for them either, so this can never be stricter than send.
export def modalityFilter(detected: DetectedContent): DetectedContent {
  const slots = getResolvedSlots()
  const main = slots["main"]
  if (main == null) {
    return detected
  }
  const imageOk = modelSupportsInput(main.model, "image")
  const pdfOk = modelSupportsInput(main.model, "pdf")
  let attached: DetectedAttachment[] = []
  let skipped: SkippedFile[] = [...detected.skipped]
  for (item in detected.attached) {
    const drop =
      (item.attachment.type == "image" && imageOk == false) ||
      (item.attachment.type == "file" && pdfOk == false)
    if (drop) {
      const modality = item.attachment.type == "image" ? "image" : "PDF"
      skipped.push({ label: item.label, reason: "model ${main.model} has no ${modality} input" })
    } else {
      attached.push(item)
    }
  }
  return { text: detected.text, attached: attached, skipped: skipped }
}
```

- [ ] **Step 2: Write failing modalityFilter units**

Append to `lib/agents/agency-agent/tests/attachments.agency` (add `modalityFilter` to the import from `../lib/attachments.agency`, and add `import { applyResolved } from "../shared.agency"`). Each node is a fresh subprocess, so `getResolvedSlots()` starts empty unless the node itself calls `applyResolved` — the passthrough test is deterministic without any reset:

```
node modalityFilterPassthroughWhenNoSlots(): string {
  writeBinary("da-mf.png", PNG, "/tmp") with approve
  const detected = detectAttachments("see /tmp/da-mf.png") with approve
  const filtered = modalityFilter(detected)
  return "${filtered.attached.length}"
}

node modalityFilterDropsForTextOnlyModel(): string {
  applyResolved({ main: { model: "gpt-3.5-turbo", provider: "openai", via: "test" } })
  writeBinary("da-mf2.png", PNG, "/tmp") with approve
  const detected = detectAttachments("see /tmp/da-mf2.png") with approve
  const filtered = modalityFilter(detected)
  return "${filtered.attached.length}|${filtered.skipped[0].label}|${filtered.skipped[0].reason}"
}

node modalityFilterDropsPdfForNoPdfModel(): string {
  applyResolved({ main: { model: "gpt-3.5-turbo", provider: "openai", via: "test" } })
  writeBinary("da-mfp.pdf", "JVBERi0xLjQK", "/tmp") with approve
  const detected = detectAttachments("see /tmp/da-mfp.pdf") with approve
  const filtered = modalityFilter(detected)
  return "${filtered.attached.length}|${filtered.skipped[0].label}|${filtered.skipped[0].reason}"
}

node modalityFilterKeepsForVisionModel(): string {
  applyResolved({ main: { model: "gpt-4o", provider: "openai", via: "test" } })
  writeBinary("da-mf3.png", PNG, "/tmp") with approve
  const detected = detectAttachments("see /tmp/da-mf3.png") with approve
  const filtered = modalityFilter(detected)
  return "${filtered.attached.length}"
}
```

(`gpt-3.5-turbo` is `false` for BOTH image and pdf; `gpt-4o` is `true` for both — verified in Task 2 Step 1. Substitute consistently if the catalog drifted.)

Append to `lib/agents/agency-agent/tests/attachments.test.json` `tests` array:

```json
    { "nodeName": "modalityFilterPassthroughWhenNoSlots", "input": "", "expectedOutput": "\"1\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "modalityFilterDropsForTextOnlyModel", "input": "", "expectedOutput": "\"0|da-mf2.png|model gpt-3.5-turbo has no image input\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "modalityFilterDropsPdfForNoPdfModel", "input": "", "expectedOutput": "\"0|da-mfp.pdf|model gpt-3.5-turbo has no PDF input\"", "evaluationCriteria": [{ "type": "exact" }] },
    { "nodeName": "modalityFilterKeepsForVisionModel", "input": "", "expectedOutput": "\"1\"", "evaluationCriteria": [{ "type": "exact" }] }
```

Run (expect the new nodes to FAIL until Step 1 is implemented + `make`):

```bash
make > /tmp/task5-make.log 2>&1; tail -3 /tmp/task5-make.log
pnpm run agency test lib/agents/agency-agent/tests/attachments.agency > /tmp/task5-units.log 2>&1; tail -12 /tmp/task5-units.log
```
Expected after implementing Step 1 + `make`: all 22 nodes pass.

- [ ] **Step 3: Wire `agent.agency`**

(a) Imports: add `Attachment` to the existing `std::thread` import (line ~30: `import { getCost, getModelCosts, systemMessage } from "std::thread"` → add `Attachment`). Add with the other `./lib/` imports:

```
import { detectAttachments, modalityFilter } from "./lib/attachments.agency"
```

(b) Widen `mainAgent` (body unchanged):

```
def mainAgent(prompt: string | (string | Attachment)[]): string {
```

(c) Replace the tail of `agentReplyVia` — the line `return mainAgent(expanded)` becomes:

```
  // Auto-attach image/PDF files the user referenced (drag-drop or typed
  // path), filtered to what the resolved model accepts. Never silent:
  // every attach and every skip prints a visible line.
  const detected = modalityFilter(detectAttachments(expanded))
  for (skippedFile in detected.skipped) {
    pushMessage(color.yellow("📎 skipped ${skippedFile.label} (${skippedFile.reason})"))
  }
  if (detected.attached.length == 0) {
    // Deliberate special case: a text-only turn stays a bare string. A
    // one-element array is API-equivalent, but the stored thread message
    // shape (string vs parts array) — and with it every serialized
    // session and message fixture — would change for EVERY turn.
    return mainAgent(expanded)
  }
  for (item in detected.attached) {
    pushMessage(color.dim("📎 attached ${item.label}"))
  }
  const attachments = map(detected.attached) as item {
    return item.attachment
  }
  const parts: (string | Attachment)[] = [expanded, ...attachments]
  return mainAgent(parts)
```

(`pushMessage` is already imported in `agent.agency`; `color` is available there without an import — it is used throughout the file, e.g. line 135. `map` was imported in Task 4.)

- [ ] **Step 4: Write the turn-integration tests**

Create `lib/agents/agency-agent/tests/attachmentsTurn.agency`:

```
import { agentReply, agentReplyVia } from "../agent.agency"
import { applyResolved } from "../shared.agency"
import { getThread, listThreads } from "std::thread"

static const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"

// The thread reader renders attachment parts as "[image attachment]"
// (see _contentToString), so finding that placeholder in a user message
// proves the multimodal array reached the llm() turn. listThreads with
// lazySummarize: false enumerates real thread ids without triggering
// the on-demand LLM summarization of closed threads (which would burn
// mocks). currentThreadId() would NOT work here: after agentReply
// returns, the active thread is the node root, not the main thread.
def threadHasImagePlaceholder(): boolean {
  const threads = listThreads(lazySummarize: false)
  if (isFailure(threads)) {
    return false
  }
  for (info in threads.value) {
    const messages = getThread(info.id, 0, 200)
    if (isFailure(messages)) {
      continue
    }
    for (message in messages.value) {
      if (message.role == "user" && message.content.includes("[image attachment]")) {
        return true
      }
    }
  }
  return false
}

node attachesImageToTurn(): string {
  writeBinary("at-x.png", PNG, "/tmp") with approve
  const reply = agentReply("look at /tmp/at-x.png") with approve
  return "${reply}|${threadHasImagePlaceholder()}"
}

node plainMessageStaysString(): string {
  const reply = agentReply("hello there") with approve
  return "${reply}|${threadHasImagePlaceholder()}"
}

node modalitySkipsTextOnlyModel(): string {
  applyResolved({ main: { model: "gpt-3.5-turbo", provider: "openai", via: "test" } })
  writeBinary("at-y.png", PNG, "/tmp") with approve
  const reply = agentReply("look at /tmp/at-y.png") with approve
  return "${reply}|${threadHasImagePlaceholder()}"
}

node subagentRouteIgnoresImagePath(): string {
  writeBinary("at-z.png", PNG, "/tmp") with approve
  const reply = agentReplyVia("code", "look at /tmp/at-z.png") with approve
  return "${reply}|${threadHasImagePlaceholder()}"
}
```

Create `lib/agents/agency-agent/tests/attachmentsTurn.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "attachesImageToTurn",
      "input": "",
      "expectedOutput": "\"I see it!|true\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [{ "return": "I see it!" }]
    },
    {
      "nodeName": "plainMessageStaysString",
      "input": "",
      "expectedOutput": "\"Hi!|false\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [{ "return": "Hi!" }]
    },
    {
      "nodeName": "modalitySkipsTextOnlyModel",
      "input": "",
      "expectedOutput": "\"ok|false\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [{ "return": "ok" }]
    },
    {
      "nodeName": "subagentRouteIgnoresImagePath",
      "input": "",
      "expectedOutput": "\"code reply|false\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [{ "return": "code reply" }]
    }
  ]
}
```

Test-design notes:
- `subagentRouteIgnoresImagePath` pins spec decision 3 (direct-to-subagent routes stay text-only) — a refactor that runs detection on subagent routes now fails a test.
- `modalitySkipsTextOnlyModel` proves the skip path end-to-end: the turn still succeeds AND no image part reached the thread.
- The `📎` print lines themselves are unasserted — Known coverage gaps #3.

- [ ] **Step 5: Build and run all touched agent tests**

```bash
make > /tmp/task5-make2.log 2>&1; tail -3 /tmp/task5-make2.log
pnpm run agency test lib/agents/agency-agent/tests/attachmentsTurn.agency > /tmp/task5-turn.log 2>&1; tail -12 /tmp/task5-turn.log
pnpm run agency test lib/agents/agency-agent/tests/attachments.agency > /tmp/task5-units2.log 2>&1; tail -6 /tmp/task5-units2.log
pnpm run agency test lib/agents/agency-agent/tests/agentTurn.agency > /tmp/task5-regress.log 2>&1; tail -6 /tmp/task5-regress.log
```
Expected: all pass. `agentTurn.agency` is the regression gate for the `mainAgent` widening (its `respondsToAMessage` sends a plain string). If `attachesImageToTurn` returns `…|false`, read `/tmp/task5-turn.log` and inspect what `listThreads`/`getThread` actually returned before changing anything.

- [ ] **Step 6: Commit**

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Auto-attach referenced image/PDF files to the agent coordinator turn

agentReplyVia now runs detectAttachments (modality-filtered via
std::llm.modelSupportsInput against the resolved main slot) on the
expanded user message, prints a visible line per attached or skipped
file, and passes a multimodal array to mainAgent, whose prompt widened
to string | (string | Attachment)[]. Direct-to-subagent routes stay
text-only by design and are pinned by a regression test.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add lib/agents/agency-agent/agent.agency lib/agents/agency-agent/lib/attachments.agency lib/agents/agency-agent/tests/attachments.agency lib/agents/agency-agent/tests/attachments.test.json lib/agents/agency-agent/tests/attachmentsTurn.agency lib/agents/agency-agent/tests/attachmentsTurn.test.json
git commit -F /tmp/commit-msg.txt
```

---

### Task 6: Full verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-07-02-agent-images-and-attachments-design.md` (frontmatter `status: design` → `status: implemented`)

- [ ] **Step 1: Structural linter + TS unit suite**

```bash
pnpm run lint:structure > /tmp/task6-lint.log 2>&1; tail -5 /tmp/task6-lint.log
pnpm test:run lib/stdlib/threads.test.ts lib/stdlib/llm.test.ts > /tmp/task6-units.log 2>&1; tail -5 /tmp/task6-units.log
```
Expected: linter clean; both unit files pass.

- [ ] **Step 2: Full agent test suite (no LLM, local-safe)**

```bash
make > /tmp/task6-make.log 2>&1; tail -3 /tmp/task6-make.log
pnpm run test:agents > /tmp/task6-agents.log 2>&1; tail -15 /tmp/task6-agents.log
```
Expected: all agent tests pass (this runs `lib/agents` execution tests in parallel; it does NOT hit real LLMs). Do NOT run the full `tests/agency` suite — CI covers it.

- [ ] **Step 3: Flip the spec status and commit**

Edit the spec frontmatter `status: design` → `status: implemented`.

```bash
cat > /tmp/commit-msg.txt <<'EOF'
Mark agent images-and-attachments spec implemented

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
git add docs/superpowers/specs/2026-07-02-agent-images-and-attachments-design.md
git commit -F /tmp/commit-msg.txt
```

---

## Spec-coverage map (self-review)

- Part A tool (generate+edit, Result-checked write, agent-cwd, dirname split) → Task 4 (incl. negative process-cwd assertion + cost-accrual test)
- Part A registration + system-prompt bullet → Task 4 (c)/(d)
- Part B algorithm steps 1–9 (tokenize, normalize+tilde, resolve, dedupe, stat gate, size-skip, inline base64, cap, unchanged text) → Task 3 (all six MIME extensions + case-insensitivity + both quote styles + mixed types/order covered)
- Attachment lifetime decision (inline at attach) → Task 3 Step 1 (readBinary inlining)
- Wiring (`agentReplyVia`, visible 📎 lines, `mainAgent` widening) → Task 5
- Spec decision 3 (subagent routes text-only) → Task 5 `subagentRouteIgnoresImagePath`
- Risk 4 modality plan (`modelSupportsInput`, tri-state, skip-on-false, image AND pdf) → Tasks 2 + 5
- Risk 5 prerequisite (`_contentToString` placeholders) → Task 1 (incl. corner cases: null, empty array, missing text, unknown part type)
- Testing section: detectAttachments units → Task 3; generateImageFile tests → Task 4; turn integration → Task 5 (asserted via the `getThread` placeholder, which also end-to-end-tests Task 1)
- Non-goals (subagent attachments, view-back loop, eviction tools, non-media) → intentionally absent
- Known limitations → "Known coverage gaps" in Global Constraints (4 items, each with rationale)
