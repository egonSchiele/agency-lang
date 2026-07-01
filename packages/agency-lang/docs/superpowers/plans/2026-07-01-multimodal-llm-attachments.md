# Multimodal LLM Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (the user's standing preference is to do implementation directly in the main session, not via dispatched subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Agency's `llm()` and `std::thread.userMessage()` accept image/file attachments alongside text, via two smart builders (`image`, `file`), backed by smoltalk 0.7.1's multimodal user-message content — with statelog kept attachment-safe.

**Architecture:** Two Agency `def`s in `std::thread` wrap `_`-prefixed TS helpers that classify a source string (path / URL / `data:` URI / raw base64) into a plain attachment object matching smoltalk's `UserContentPart`. Those objects flow — unchanged — through the existing `llm()` codegen and the single `smoltalk.userMessage(prompt)` runtime push site (smoltalk does all file I/O). The `llm()` first-param type is tightened from `any` to `string | (string | Attachment)[]`, the runtime is audited for string-only `prompt` consumers, and every statelog site that carries messages/prompt is wrapped in smoltalk's `redactAttachments`.

**Tech Stack:** TypeScript (runtime + typechecker + codegen), Agency stdlib (`.agency`), smoltalk `0.7.1`, vitest, the agency-js fixture-diff test harness.

**Spec:** `docs/superpowers/specs/2026-07-01-multimodal-llm-attachments-design.md`

## Global Constraints

- **smoltalk `>= 0.7.1`** — already installed. `redactAttachments` and `UserContentInput` are imported from the top-level `"smoltalk"` package (both are re-exported there).
- **Run `make`** after editing any `stdlib/*.agency` file (rebuilds stdlib artifacts the compiler/typechecker read). Do NOT rely on `pnpm run build` for stdlib.
- **TS unit tests:** `pnpm test:run <path>`. **Agency-js tests:** `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js <dir>`; **save the output to a file** (agency tests are slow/expensive to rerun). Do NOT run the full agency suite locally — CI runs it.
- **Coding standards:** no dynamic imports; objects not maps; arrays not sets; `type` not `interface`.
- **Git:** branch off `main` before the first commit; never force-push or amend. Commit messages / PR bodies go in a file (apostrophes on the CLI break). End commit messages with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- **Agency syntax:** `def name(params): Ret { ... }`, union types with `|`, array types with `T[]`, docstrings in `"""..."""`.

## File Structure

- `lib/stdlib/thread.ts` — **modify.** Add `AttachmentSource` / `ImageAttachment` / `FileAttachment` TS types, `classifySource` (private), and exported `_imageAttachment` / `_fileAttachment`. Widen `_userMessage` param to `smoltalk.UserContentInput`.
- `lib/stdlib/thread.attachments.test.ts` — **create.** Unit tests for the two helpers.
- `stdlib/thread.agency` — **modify.** Add `AttachmentSource` / `Attachment` Agency types; add `image` / `file` builder defs (with docstrings); widen `userMessage` param; import the two new TS helpers.
- `lib/typeChecker/builtins.ts` — **modify.** Add the structural `attachment` mirror; tighten `llm` first param to `string | (string | Attachment)[]`.
- `lib/typeChecker/attachments.test.ts` — **create.** Accept/reject + inference tests (doubles as the mirror-drift guard).
- `lib/backends/llmAttachmentCodegen.test.ts` — **create.** Assert `llm([...])` compiles to an array argument.
- `lib/runtime/prompt.ts` — **modify.** Add `promptText` + `redactMessagesForLog`; widen `prompt: string` types; route the memory-recall call through `promptText`; wrap the three message statelog sites in redaction.
- `lib/runtime/streaming.ts` — **modify.** Widen `prompt: string`; redact `prompt` in the `debug` statelog call.
- `lib/runtime/agencyLlm.ts` — **modify.** Widen the TS-facade `llm` prompt param (3 signatures) + JSDoc.
- `lib/runtime/prompt.attachments.test.ts` — **create.** Unit tests for `promptText` and `redactMessagesForLog`.
- `tests/agency-js/multimodal-attachments/` — **create.** End-to-end integration fixture (`agent.agency`, `test.js`, `llmMocks.json`, `useTestLLMProvider`, generated `fixture.json`).
- `docs/site/guide/llm.md` — **modify.** Add a "Attachments (images & files)" section.

---

### Task 1: TS attachment builders (`lib/stdlib/thread.ts`)

Pure, dependency-free classification + construction. This is the foundation; nothing else needs to exist yet.

**Files:**
- Modify: `lib/stdlib/thread.ts`
- Test: `lib/stdlib/thread.attachments.test.ts` (create)

**Interfaces:**
- Produces:
  - `type AttachmentSource = { kind: "path"; path: string; mimeType?: string } | { kind: "url"; url: string; mimeType?: string } | { kind: "base64"; base64: string; mimeType: string }`
  - `type ImageAttachment = { type: "image"; source: AttachmentSource }`
  - `type FileAttachment = { type: "file"; source: AttachmentSource; filename?: string }`
  - `_imageAttachment(source: string, mimeType: string, base64: boolean): ImageAttachment`
  - `_fileAttachment(source: string, filename: string, mimeType: string, base64: boolean): FileAttachment`

- [ ] **Step 1: Write the failing test** — create `lib/stdlib/thread.attachments.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { _imageAttachment, _fileAttachment } from "./thread.js";

describe("_imageAttachment", () => {
  it("classifies a plain path", () => {
    expect(_imageAttachment("./cat.png", "", false)).toEqual({
      type: "image",
      source: { kind: "path", path: "./cat.png" },
    });
  });

  it("auto-detects an http(s) URL", () => {
    expect(_imageAttachment("https://x.com/a.jpg", "", false)).toEqual({
      type: "image",
      source: { kind: "url", url: "https://x.com/a.jpg" },
    });
  });

  it("parses a data: URI into a base64 source (mime from the URI)", () => {
    expect(_imageAttachment("data:image/png;base64,AAAB", "", false)).toEqual({
      type: "image",
      source: { kind: "base64", base64: "AAAB", mimeType: "image/png" },
    });
  });

  it("treats a data: URI as base64 even when base64:true is passed", () => {
    expect(_imageAttachment("data:image/png;base64,AAAB", "", true)).toEqual({
      type: "image",
      source: { kind: "base64", base64: "AAAB", mimeType: "image/png" },
    });
  });

  it("uses base64:true with an explicit mimeType", () => {
    expect(_imageAttachment("AAAB", "image/png", true)).toEqual({
      type: "image",
      source: { kind: "base64", base64: "AAAB", mimeType: "image/png" },
    });
  });

  it("lets mimeType override inference on a path", () => {
    expect(_imageAttachment("./blob", "image/webp", false)).toEqual({
      type: "image",
      source: { kind: "path", path: "./blob", mimeType: "image/webp" },
    });
  });

  it("throws on base64 with no mimeType", () => {
    expect(() => _imageAttachment("AAAB", "", true)).toThrow(/mimeType/i);
  });
});

describe("_fileAttachment", () => {
  it("derives filename from a path basename", () => {
    expect(_fileAttachment("./docs/report.pdf", "", "", false)).toEqual({
      type: "file",
      source: { kind: "path", path: "./docs/report.pdf" },
      filename: "report.pdf",
    });
  });

  it("derives filename from a URL, stripping query/hash", () => {
    expect(_fileAttachment("https://x.com/a/report.pdf?v=2", "", "", false)).toEqual({
      type: "file",
      source: { kind: "url", url: "https://x.com/a/report.pdf?v=2" },
      filename: "report.pdf",
    });
  });

  it("respects an explicit filename", () => {
    expect(_fileAttachment("./r.pdf", "custom.pdf", "", false)).toEqual({
      type: "file",
      source: { kind: "path", path: "./r.pdf" },
      filename: "custom.pdf",
    });
  });

  it("does NOT derive a filename from a base64 source", () => {
    expect(_fileAttachment("AAAB", "", "application/pdf", true)).toEqual({
      type: "file",
      source: { kind: "base64", base64: "AAAB", mimeType: "application/pdf" },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:run lib/stdlib/thread.attachments.test.ts`
Expected: FAIL — `_imageAttachment` / `_fileAttachment` are not exported.

- [ ] **Step 3: Implement the helpers** — add to `lib/stdlib/thread.ts` (near the message helpers). `classifySource` is module-private; the three `type` aliases are exported:

```ts
export type AttachmentSource =
  | { kind: "path"; path: string; mimeType?: string }
  | { kind: "url"; url: string; mimeType?: string }
  | { kind: "base64"; base64: string; mimeType: string };

export type ImageAttachment = { type: "image"; source: AttachmentSource };
export type FileAttachment = {
  type: "file";
  source: AttachmentSource;
  filename?: string;
};

function classifySource(
  source: string,
  mimeType: string,
  base64: boolean,
): AttachmentSource {
  // A data: URI is authoritative regardless of the base64 flag.
  if (source.startsWith("data:")) {
    const marker = ";base64,";
    const idx = source.indexOf(marker);
    if (idx === -1) {
      throw new Error(
        "image()/file(): a data: URI must be base64-encoded (data:<mime>;base64,<data>)",
      );
    }
    const uriMime = source.slice("data:".length, idx);
    const data = source.slice(idx + marker.length);
    return { kind: "base64", base64: data, mimeType: mimeType || uriMime };
  }
  if (base64) {
    if (!mimeType) {
      throw new Error(
        "image()/file(): base64 sources require an explicit mimeType",
      );
    }
    return { kind: "base64", base64: source, mimeType };
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return mimeType
      ? { kind: "url", url: source, mimeType }
      : { kind: "url", url: source };
  }
  return mimeType
    ? { kind: "path", path: source, mimeType }
    : { kind: "path", path: source };
}

export function _imageAttachment(
  source: string,
  mimeType: string,
  base64: boolean,
): ImageAttachment {
  return { type: "image", source: classifySource(source, mimeType, base64) };
}

function basename(source: string): string {
  const clean = source.split(/[?#]/)[0];
  const segments = clean.split("/");
  return segments[segments.length - 1] || "";
}

export function _fileAttachment(
  source: string,
  filename: string,
  mimeType: string,
  base64: boolean,
): FileAttachment {
  const src = classifySource(source, mimeType, base64);
  let name = filename;
  if (!name && (src.kind === "path" || src.kind === "url")) {
    name = basename(source);
  }
  return name
    ? { type: "file", source: src, filename: name }
    : { type: "file", source: src };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:run lib/stdlib/thread.attachments.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/thread.ts lib/stdlib/thread.attachments.test.ts
git commit -F .git/COMMIT_EDITMSG_multimodal_1
```
(Write the message to a file first, e.g. `feat(stdlib): attachment source classifiers for multimodal messages`, ending with the Co-Authored-By trailer.)

---

### Task 2: Agency builders, types, and `userMessage` widening (`stdlib/thread.agency`)

Expose the TS helpers as Agency `image`/`file`, declare the Agency `Attachment` types, and widen `userMessage` (plus its `_userMessage` runtime helper) to accept attachments.

**Files:**
- Modify: `lib/stdlib/thread.ts` (widen `_userMessage`)
- Modify: `stdlib/thread.agency`
- Test: covered by Task 7 (integration) + a parse check here.

**Interfaces:**
- Consumes: `_imageAttachment`, `_fileAttachment` (Task 1).
- Produces (Agency): `type Attachment`, `type AttachmentSource`, `def image(source, mimeType?, base64?): Attachment`, `def file(source, filename?, mimeType?, base64?): Attachment`, widened `def userMessage(msg: string | (string | Attachment)[])`.

- [ ] **Step 1: Widen `_userMessage` in `lib/stdlib/thread.ts`** — change its signature from `string` to smoltalk's input union (add `UserContentInput` to the existing `import * as smoltalk`):

```ts
// was: export async function _userMessage(msg: string): Promise<void> {
export async function _userMessage(
  msg: smoltalk.UserContentInput,
): Promise<void> {
  const threads = getRuntimeContext().threads;
  threads.getOrCreateActive().push(smoltalk.userMessage(msg));
}
```

Also widen `__internal_userMessage` the same way for consistency (the migration-window twin at ~line 48).

- [ ] **Step 2: Add types + builders to `stdlib/thread.agency`** — add the new import symbols and, after the `assistantMessage` def, the types and builders:

Import (extend the existing `from "agency-lang/stdlib-lib/thread.js"` block):

```ts
import {
  _systemMessage,
  _userMessage,
  _assistantMessage,
  _imageAttachment,
  _fileAttachment,
  _getCost,
  _getTokens,
  _getModelCosts,
  _pushGuard,
  _popGuard,
  _runGuarded,
 } from "agency-lang/stdlib-lib/thread.js"
```

Types + builders:

```ts
// KEEP IN SYNC with the structural `attachment` mirror in
// lib/typeChecker/builtins.ts (the `llm()` first-param type). A drift is
// caught by lib/typeChecker/attachments.test.ts.
export type AttachmentSource =
  | { kind: "path", path: string, mimeType?: string }
  | { kind: "url", url: string, mimeType?: string }
  | { kind: "base64", base64: string, mimeType: string }

export type Attachment =
  | { type: "image", source: AttachmentSource }
  | { type: "file", source: AttachmentSource, filename?: string }

export safe def image(
  source: string,
  mimeType: string = "",
  base64: boolean = false,
): Attachment {
  """
  Build an image attachment for a multimodal llm() call or userMessage().
  `source` is a local path, an http(s) URL, or a data: URI. Pass base64: true
  to treat `source` as raw base64 data (a mimeType is then required).
  smoltalk reads/fetches and MIME-infers the source at send time.

  @param source - Path, http(s) URL, data: URI, or raw base64 (with base64: true)
  @param mimeType - Explicit MIME type; overrides inference. Required for raw base64.
  @param base64 - When true, treat `source` as raw base64 data.
  """
  return _imageAttachment(source, mimeType, base64)
}

export safe def file(
  source: string,
  filename: string = "",
  mimeType: string = "",
  base64: boolean = false,
): Attachment {
  """
  Build a file (e.g. PDF) attachment for a multimodal llm() call or
  userMessage(). `source` is a local path, an http(s) URL, or a data: URI.
  Pass base64: true to treat `source` as raw base64 data (mimeType required).
  `filename` defaults to the source's basename.

  @param source - Path, http(s) URL, data: URI, or raw base64 (with base64: true)
  @param filename - Name shown to the model; defaults to the source basename.
  @param mimeType - Explicit MIME type; overrides inference. Required for raw base64.
  @param base64 - When true, treat `source` as raw base64 data.
  """
  return _fileAttachment(source, filename, mimeType, base64)
}
```

- [ ] **Step 3: Widen `userMessage` in `stdlib/thread.agency`**:

```ts
export def userMessage(msg: string | (string | Attachment)[]) {
  """
  Add a user message to the current thread's message history. Accepts a plain
  string, or an array mixing text strings and image()/file() attachments.
  Use this when you want to seed the conversation with prior user context that
  wasn't actually typed by the user this turn.

  @param msg - The user message content: a string, or an array of strings and attachments.
  """
  _userMessage(msg)
}
```

- [ ] **Step 4: Rebuild stdlib and verify it parses**

Run: `make 2>&1 | tee /private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/ad319109-1b8d-4e42-8e2a-b10ad1b47931/scratchpad/make-task2.log`
Then: `pnpm run ast stdlib/thread.agency > /private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/ad319109-1b8d-4e42-8e2a-b10ad1b47931/scratchpad/thread-ast.json`
Expected: `make` succeeds; `ast` emits JSON with no parse error.

**If `(string | Attachment)[]` fails to parse** (parenthesized union array), fall back to a named alias declared above the builders and use it in both `userMessage` and (later) the doc:

```ts
export type AttachmentContent = string | (string | Attachment)[]
```

If even the alias body fails, use `string | Attachment[]` and document that mixing bare text strings and attachments in one array still works at runtime (smoltalk normalizes bare strings) — but prefer the parenthesized union; confirm which parses before moving on.

- [ ] **Step 5: Commit**

```bash
git add lib/stdlib/thread.ts stdlib/thread.agency
git commit -F <message-file>
```
Message: `feat(stdlib): std::thread image()/file() builders + multimodal userMessage`.

---

### Task 3: Tighten `llm()` first param (`lib/typeChecker/builtins.ts`)

Replace the `"any"` prompt param with the structural union, and lock it with accept/reject/inference tests that double as the mirror-drift guard.

**Files:**
- Modify: `lib/typeChecker/builtins.ts`
- Test: `lib/typeChecker/attachments.test.ts` (create)

**Interfaces:**
- Consumes: `image`/`file` from `std::thread` (Task 2), `optional()` + `string` primitives already in `builtins.ts`.
- Produces: `BUILTIN_FUNCTION_TYPES.llm.params[0]` is now `string | (string | Attachment)[]`.

- [ ] **Step 1: Write the failing tests** — create `lib/typeChecker/attachments.test.ts` (reuse the `errorsFrom` harness from `lib/typeChecker/builtinNamedArgs.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";
import os from "os";
import { parseAgency } from "../parser.js";
import { SymbolTable } from "../symbolTable.js";
import { buildCompilationUnit } from "../compilationUnit.js";
import { typeCheck } from "./index.js";
import type { TypeCheckError } from "./types.js";

function errorsFrom(source: string): TypeCheckError[] {
  const file = path.join(
    os.tmpdir(),
    `tc-attach-${Date.now()}-${Math.random().toString(36).slice(2)}.agency`,
  );
  writeFileSync(file, source);
  try {
    const absPath = path.resolve(file);
    const symbolTable = SymbolTable.build(absPath, {});
    const parseResult = parseAgency(source, {});
    if (!parseResult.success) throw new Error("Parse failed");
    const info = buildCompilationUnit(parseResult.result, symbolTable, absPath, source);
    return typeCheck(parseResult.result, {}, info).errors;
  } finally {
    unlinkSync(file);
  }
}

const IMPORT = `import { image, file } from "std::thread"\n`;

describe("llm() multimodal first-arg typing", () => {
  it("accepts a plain string", () => {
    expect(errorsFrom(`node main() { let r: string = llm("hi")\n print(r) }`)).toHaveLength(0);
  });

  it("accepts a mixed text + attachment array", () => {
    expect(
      errorsFrom(`${IMPORT}node main() { let r: string = llm(["hi", image("x"), file("y")])\n print(r) }`),
    ).toHaveLength(0);
  });

  it("accepts an array bound to a local first (inference path)", () => {
    expect(
      errorsFrom(`${IMPORT}node main() { let arr = ["hi", image("x")]\n let r: string = llm(arr)\n print(r) }`),
    ).toHaveLength(0);
  });

  it("rejects a number element in the array", () => {
    expect(
      errorsFrom(`node main() { let r: string = llm([42])\n print(r) }`).length,
    ).toBeGreaterThan(0);
  });

  it("accepts a mixed array on userMessage()", () => {
    expect(
      errorsFrom(`import { userMessage, image } from "std::thread"\nnode main() { userMessage(["hi", image("x")]) }`),
    ).toHaveLength(0);
  });

  it("rejects a number element on userMessage()", () => {
    expect(
      errorsFrom(`import { userMessage } from "std::thread"\nnode main() { userMessage([42]) }`).length,
    ).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:run lib/typeChecker/attachments.test.ts`
Expected: the two "rejects" tests FAIL (param is still `"any"`, so `[42]` is accepted). The "accepts" tests may already pass.

- [ ] **Step 3: Add the structural mirror and tighten the param** — in `lib/typeChecker/builtins.ts`, above `BUILTIN_FUNCTION_TYPES`, after `llmNamedOptions`:

```ts
// KEEP IN SYNC with the `Attachment` / `AttachmentSource` types in
// stdlib/thread.agency. This is the structural mirror the `llm()` signature
// needs (builtin types live in TS, not the .agency universe). Drift is caught
// by lib/typeChecker/attachments.test.ts.
const attachmentSource: VariableType = {
  type: "unionType",
  types: [
    { type: "objectType", properties: [
      { key: "kind", value: { type: "stringLiteralType", value: "path" } },
      { key: "path", value: string },
      { key: "mimeType", value: optional(string) },
    ] },
    { type: "objectType", properties: [
      { key: "kind", value: { type: "stringLiteralType", value: "url" } },
      { key: "url", value: string },
      { key: "mimeType", value: optional(string) },
    ] },
    { type: "objectType", properties: [
      { key: "kind", value: { type: "stringLiteralType", value: "base64" } },
      { key: "base64", value: string },
      { key: "mimeType", value: string },
    ] },
  ],
};

const attachment: VariableType = {
  type: "unionType",
  types: [
    { type: "objectType", properties: [
      { key: "type", value: { type: "stringLiteralType", value: "image" } },
      { key: "source", value: attachmentSource },
    ] },
    { type: "objectType", properties: [
      { key: "type", value: { type: "stringLiteralType", value: "file" } },
      { key: "source", value: attachmentSource },
      { key: "filename", value: optional(string) },
    ] },
  ],
};

const llmContent: VariableType = {
  type: "unionType",
  types: [
    string,
    { type: "arrayType", elementType: { type: "unionType", types: [string, attachment] } },
  ],
};
```

Then change the `llm` signature:

```ts
  llm: {
    params: [llmContent, llmOptions],   // was: ["any", llmOptions]
    minParams: 1,
    returnType: string,
    acceptsNamedArgs: llmNamedOptions,
    description:
      "Send a prompt to an LLM and return its response. The prompt is a string, or an array of text strings and image()/file() attachments. The return type is inferred from the call-site annotation and compiled to a JSON schema for structured output.",
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:run lib/typeChecker/attachments.test.ts`
Expected: PASS.

**If an "accepts" test fails** (heterogeneous-array inference weaker than assumed), that is the feasibility finding from the spec: loosen `llmContent`'s array arm to `{ type: "arrayType", elementType: ANY_T }` while keeping the `string` arm, so misuse of a *non-array* first arg is still typed but element checking relaxes. Note the outcome in the commit body.

- [ ] **Step 5: Run the existing builtin/typechecker tests for regressions**

Run: `pnpm test:run lib/typeChecker/ 2>&1 | tee /private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/ad319109-1b8d-4e42-8e2a-b10ad1b47931/scratchpad/tc-suite.log`
Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add lib/typeChecker/builtins.ts lib/typeChecker/attachments.test.ts
git commit -F <message-file>
```
Message: `feat(typechecker): type llm()/userMessage() first arg as string | (string | Attachment)[]`.

---

### Task 4: Codegen array-argument test (`lib/backends`)

Confirm (and lock) that `llm([...])` compiles the array through to `runPrompt`'s `prompt` field. Expected: no production change — this is a guard test.

**Files:**
- Test: `lib/backends/llmAttachmentCodegen.test.ts` (create)

- [ ] **Step 1: Write the test** — mirror the structure of `lib/backends/llmNamedArgsCodegen.test.ts` (open it to copy the exact compile-helper imports). Assert the generated TS contains a `runPrompt` call whose `prompt` is an array literal including an `_imageAttachment`/`image(` call:

```ts
import { describe, it, expect } from "vitest";
import { compileAgencyToTs } from "./testHelpers.js"; // use the same helper llmNamedArgsCodegen.test.ts uses

describe("llm() multimodal codegen", () => {
  it("passes an array first-arg through to runPrompt as an array", () => {
    const ts = compileAgencyToTs(
      `import { image } from "std::thread"\n` +
      `node main() { let r: string = llm(["hi", image("x")])\n print(r) }`,
    );
    expect(ts).toContain("runPrompt");
    // the prompt arg is an array literal, not a bare string
    expect(ts).toMatch(/prompt:\s*\[/);
    expect(ts).toContain("image");
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test:run lib/backends/llmAttachmentCodegen.test.ts`
Expected: PASS with no `processLlmCall` change. **If it fails**, inspect the emitted TS (log `ts`) and adjust `processLlmCall` only as needed so `arguments[0]`'s array literal reaches `prompt`; add the fix as its own step here.

- [ ] **Step 3: Commit**

```bash
git add lib/backends/llmAttachmentCodegen.test.ts
git commit -F <message-file>
```
Message: `test(codegen): lock llm([...]) array-argument compilation`.

---

### Task 5: Runtime `prompt` audit — flatten helper + type widening (`prompt.ts`, `streaming.ts`, `agencyLlm.ts`)

Make the runtime accept an array `prompt` end-to-end and route every string-only consumer through one text-flattening helper.

**Files:**
- Modify: `lib/runtime/prompt.ts`, `lib/runtime/streaming.ts`, `lib/runtime/agencyLlm.ts`
- Test: `lib/runtime/prompt.attachments.test.ts` (create — `promptText` portion)

**Interfaces:**
- Produces: `export function promptText(p: string | UserContentInput): string`.

- [ ] **Step 1: Write the failing test** — create `lib/runtime/prompt.attachments.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { promptText } from "./prompt.js";

describe("promptText", () => {
  it("returns a plain string unchanged", () => {
    expect(promptText("hello")).toBe("hello");
  });

  it("joins text parts and bare strings, dropping attachments", () => {
    const p = [
      "describe this",
      { type: "image", source: { kind: "path", path: "./cat.png" } },
      { type: "text", text: "and this" },
    ] as any;
    expect(promptText(p)).toBe("describe this and this");
  });
});
```

- [ ] **Step 2: Run it** — Run: `pnpm test:run lib/runtime/prompt.attachments.test.ts` — Expected: FAIL (`promptText` not exported).

- [ ] **Step 3: Implement + widen types in `lib/runtime/prompt.ts`.**

  (a) Extend the smoltalk import (line ~2) to bring in the content-input type:
  ```ts
  import { PromptResult, ToolCallJSON, UserContentInput } from "smoltalk";
  ```

  (b) Add the helper (top-level, exported):
  ```ts
  /** Flatten a prompt (string, or array of text/attachment parts) to plain
   *  text for consumers that require a string (memory recall, previews).
   *  Logging does NOT use this — it keeps the structured prompt (redacted). */
  export function promptText(p: string | UserContentInput): string {
    if (typeof p === "string") return p;
    return p
      .map((x) => (typeof x === "string" ? x : x.type === "text" ? x.text : ""))
      .join(" ");
  }
  ```

  (c) Widen every `prompt: string;` arg-type declaration to `prompt: string | UserContentInput;` at lines ~60, ~301, ~369, ~583.

  (d) Route the memory-recall consumer (line ~801):
  ```ts
  const facts = await recallManager.recallForInjection(promptText(prompt));
  ```

- [ ] **Step 4: Widen `lib/runtime/streaming.ts`** — extend its `"smoltalk"` import with `UserContentInput` and change `prompt: string;` (line ~17) to `prompt: string | UserContentInput;`.

- [ ] **Step 5: Widen `lib/runtime/agencyLlm.ts`** — import `UserContentInput` from smoltalk and change all three `prompt: string` occurrences (lines ~69, ~72, ~73) to `prompt: string | UserContentInput`. Update the JSDoc above the overloads to note "prompt is a string, or an array of text strings and image()/file() attachments."

- [ ] **Step 6: Run the unit test + a typecheck of the runtime**

Run: `pnpm test:run lib/runtime/prompt.attachments.test.ts`
Expected: PASS.
Run: `pnpm exec tsc --noEmit 2>&1 | tee /private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/ad319109-1b8d-4e42-8e2a-b10ad1b47931/scratchpad/tsc-task5.log`
Expected: no new type errors from the widened signatures.

- [ ] **Step 7: Commit**

```bash
git add lib/runtime/prompt.ts lib/runtime/streaming.ts lib/runtime/agencyLlm.ts lib/runtime/prompt.attachments.test.ts
git commit -F <message-file>
```
Message: `feat(runtime): accept array prompts; flatten to text for string-only consumers`.

---

### Task 6: Statelog redaction (`prompt.ts`, `streaming.ts`)

Wrap every message/prompt statelog payload in smoltalk's `redactAttachments` so base64 blobs never reach the log. DRY: one shared `redactMessagesForLog` for the three message sites.

**Files:**
- Modify: `lib/runtime/prompt.ts`, `lib/runtime/streaming.ts`
- Test: `lib/runtime/prompt.attachments.test.ts` (extend — redaction portion)

**Interfaces:**
- Produces: `export function redactMessagesForLog(messages: MessageThread): unknown`.

- [ ] **Step 1: Extend the test** — append to `lib/runtime/prompt.attachments.test.ts`:

```ts
import { redactMessagesForLog } from "./prompt.js";
import { MessageThread } from "./state/messageThread.js";
import * as smoltalk from "smoltalk";

describe("redactMessagesForLog", () => {
  it("redacts base64 attachment payloads but keeps structure", () => {
    const thread = new MessageThread();
    thread.push(
      smoltalk.userMessage([
        "look",
        { type: "image", source: { kind: "base64", base64: "A".repeat(5000), mimeType: "image/png" } } as any,
      ]),
    );
    const redacted = JSON.stringify(redactMessagesForLog(thread));
    expect(redacted).not.toContain("A".repeat(5000)); // blob gone
    expect(redacted).toContain("image/png");           // structure kept
  });

  it("leaves a plain string message intact", () => {
    const thread = new MessageThread();
    thread.push(smoltalk.userMessage("just text"));
    expect(JSON.stringify(redactMessagesForLog(thread))).toContain("just text");
  });
});
```

Confirm the `MessageThread` constructor/`push` API against `lib/runtime/state/messageThread.ts` before running; adjust the construction line to match (e.g. a factory) if the bare constructor differs.

- [ ] **Step 2: Run it** — Run: `pnpm test:run lib/runtime/prompt.attachments.test.ts` — Expected: FAIL (`redactMessagesForLog` not exported).

- [ ] **Step 3: Implement in `lib/runtime/prompt.ts`.**

  (a) Add `redactAttachments` to the smoltalk import:
  ```ts
  import { PromptResult, ToolCallJSON, UserContentInput, redactAttachments } from "smoltalk";
  ```

  (b) Add the helper near `promptText`:
  ```ts
  /** Deep-copy of a thread's messages with attachment payloads redacted, for
   *  statelog. Uses toJSON() (the same plain shape JSON.stringify would emit)
   *  so wire consumers like wireAccessors.userMessageOf keep working. */
  export function redactMessagesForLog(messages: MessageThread): unknown {
    return redactAttachments(messages.toJSON().messages);
  }
  ```

  (c) Redact the three message sites and the `onLLMCallStart` prompt field:
  - Line ~406 (`onLLMCallStart` hook `data`): `prompt: redactAttachments(prompt),` and `messages: redactMessagesForLog(messages),`.
  - Line ~485 (`promptCompletion`): `messages: redactMessagesForLog(messages),` (this replaces `messages.getMessages()`).
  - Line ~574 (`onLLMCallEnd` hook `data`): `messages: redactMessagesForLog(messages),`.

- [ ] **Step 4: Redact the streaming site in `lib/runtime/streaming.ts`** — add `redactAttachments` to its smoltalk import and wrap the `debug` payload's prompt (line ~31):
```ts
      {
        prompt: redactAttachments(prompt),
        callbacks: Object.keys(ctx.callbacks),
      },
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:run lib/runtime/prompt.attachments.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/runtime/prompt.ts lib/runtime/streaming.ts lib/runtime/prompt.attachments.test.ts
git commit -F <message-file>
```
Message: `fix(statelog): redact attachment payloads from logged messages/prompt`.

---

### Task 7: End-to-end integration test (agency-js)

Prove the whole path: `image`/`file` builders → array `llm(...)` and `userMessage(...)` → the smoltalk user message lands on the thread with the right parts, under the deterministic LLM provider (no real call).

**Files:**
- Create: `tests/agency-js/multimodal-attachments/agent.agency`
- Create: `tests/agency-js/multimodal-attachments/test.js`
- Create: `tests/agency-js/multimodal-attachments/llmMocks.json`
- Create: `tests/agency-js/multimodal-attachments/useTestLLMProvider` (empty)
- Generate: `tests/agency-js/multimodal-attachments/fixture.json`

- [ ] **Step 1: Write `agent.agency`** (path-based attachments only — deterministic, fully serializable, no file I/O since we never actually send to a provider):

```ts
import { image, file, userMessage } from "std::thread"

node main() {
  // A multimodal user turn seeded directly into history.
  userMessage(["seed-user", image("./cat.png")])

  // A multimodal llm() call. Under the deterministic provider the content is
  // still pushed onto the thread verbatim before the mock reply.
  let _r: string = llm(["describe", image("./cat.png"), file("./report.pdf")])

  return "done"
}
```

- [ ] **Step 2: Write `test.js`** (copy the stdlib-thread-messages driver):

```js
import { main } from "./agent.js";
import { writeFileSync } from "fs";

const result = await main();
writeFileSync(
  "__result.json",
  JSON.stringify({ data: result.data, messages: result.messages }, null, 2),
);
```

- [ ] **Step 3: Write `llmMocks.json`** (one entry for the single `llm()` call):

```json
[
  { "return": "described" }
]
```

- [ ] **Step 4: Create the marker file**

Run: `touch tests/agency-js/multimodal-attachments/useTestLLMProvider`

- [ ] **Step 5: Generate the fixture and inspect it**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/multimodal-attachments 2>&1 | tee /private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/ad319109-1b8d-4e42-8e2a-b10ad1b47931/scratchpad/agencyjs-multimodal.log`
Expected: first run has no `fixture.json`, so it writes `__result.json` and offers to save it as the fixture. **Read `__result.json`** and verify thread 0's messages include:
- a `user` message whose `content` is an array with a `text` part `"seed-user"` and an `image` part with `source.kind === "path"`, `path === "./cat.png"`;
- a `user` message with `text` `"describe"`, an `image` path part, and a `file` part with `source.path === "./report.pdf"` and `filename === "report.pdf"`.

If correct, save it as `fixture.json` (accept the prompt, or copy `__result.json` → `fixture.json`).

- [ ] **Step 6: Re-run to confirm the fixture matches**

Run: `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test js tests/agency-js/multimodal-attachments 2>&1 | tee /private/tmp/claude-501/-Users-adityabhargava-agency-lang-packages-agency-lang/ad319109-1b8d-4e42-8e2a-b10ad1b47931/scratchpad/agencyjs-multimodal-2.log`
Expected: PASS (diff clean).

- [ ] **Step 7: Commit**

```bash
git add tests/agency-js/multimodal-attachments/
git commit -F <message-file>
```
Message: `test(agency-js): end-to-end multimodal llm()/userMessage() attachments`.

---

### Task 8: Documentation (`docs/site/guide/llm.md`)

**Files:**
- Modify: `docs/site/guide/llm.md`

- [ ] **Step 1: Add an "Attachments (images & files)" section** after the intro `llm()` examples (around line 24), documenting: importing `image`/`file` from `std::thread`; the array form of `llm(...)`; path/URL/data-URI/base64 sources; the optional `mimeType` / `base64` / `filename` args; that smoltalk reads/fetches/sizes attachments; and that `userMessage(...)` accepts the same array form. Use only verified syntax:

```ts
import { image, file } from "std::thread"

node main() {
  const answer = llm([
    "What's in this image, and how does it relate to the report?",
    image("./diagram.png"),          // local path
    image("https://example.com/a.jpg"),  // remote URL
    file("./report.pdf"),            // local PDF
  ])
  print(answer)
}
```

Do NOT hand-edit generated stdlib reference pages — the `image`/`file`/`userMessage` docstrings from Task 2 feed `agency doc`.

- [ ] **Step 2: Commit**

```bash
git add docs/site/guide/llm.md
git commit -F <message-file>
```
Message: `docs(guide): document multimodal llm() attachments`.

---

## Final verification (before opening a PR)

- [ ] Targeted TS suites green: `pnpm test:run lib/stdlib/thread.attachments.test.ts lib/typeChecker/attachments.test.ts lib/backends/llmAttachmentCodegen.test.ts lib/runtime/prompt.attachments.test.ts` — save to a log file.
- [ ] `pnpm exec tsc --noEmit` clean.
- [ ] `pnpm run lint:structure` clean.
- [ ] The agency-js multimodal test passes (Task 7, Step 6).
- [ ] Do NOT run the full agency suite locally — let CI run it. Open the PR with the spec + this plan linked in the description (write the body to a file).

## Self-Review notes (traceability to the spec)

- Builders + optional args + normalization rules → Task 1 (TS) + Task 2 (Agency surface + docstrings).
- `Attachment`/`AttachmentSource` Agency types + subset-of-smoltalk documentation → Task 2.
- `llm()` param tightening + mirror-drift guard + inference feasibility check → Task 3.
- Codegen "no change" verification → Task 4.
- `prompt` string-assumption audit + `promptText` + memory-recall routing + type widening (incl. `streaming.ts`, `agencyLlm.ts`) → Task 5.
- Four statelog redaction sites + `toJSON` swap → Task 6.
- End-to-end + parts-on-thread assertion → Task 7. `promptText`/redaction units → Tasks 5/6.
- Guide + stdlib docstrings → Tasks 8 + 2.
- Prerequisite (smoltalk 0.7.1 + `redactAttachments` export) → Global Constraints (already satisfied).

### Lighter coverage than the spec's test list — deliberate tradeoffs

- **Memory-injection with an array prompt** (spec's "highest-value regression"). The
  actual defect is `recallForInjection` receiving a non-string; that fix is guarded
  directly by the `promptText` unit test (Task 5) plus the routed call site. A full
  `llm([...], memory: true)` agency-js test additionally needs the memory manager +
  embedding path wired under the deterministic provider, which may pull in real embed
  calls. **If** the memory harness runs offline (check an existing `memory` agency /
  agency-js test), add a `memory: true` array-prompt variant to Task 7; otherwise the
  unit-level guard stands as the honest coverage. Do not claim the integration test
  exists unless it was actually added.
- **Fork/race statelog under attachments** (spec item). Redaction sits on shared log
  helpers (`redactMessagesForLog`), unit-tested in Task 6; the fork/race interaction is
  not separately exercised. Add a `fork([...]) as _ { llm([..., image(...)]) }` case to
  Task 7's `agent.agency` only if it can assert something the single-branch test
  cannot; otherwise leave it out rather than add a test that asserts nothing new.
